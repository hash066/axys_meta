import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Credits } from "../../server/credits.ts";
import type { Store } from "../../server/store.ts";
import {
  generateClip,
  type GeneratedClip,
  type VideoGenerationInput,
} from "./worker.ts";

export const VideoModels = {
  wan22: {
    id: "Wan-AI/Wan2.2-TI2V-5B",
    allowedPurposes: ["commercial-production", "evaluation"],
  },
  hunyuan15: {
    id: "tencent/HunyuanVideo-1.5",
    allowedPurposes: ["evaluation"],
  },
} as const;
export const Wan22ProductionRevision =
  "921dbaf3f1674a56f47e83fb80a34bac8a8f203e";

export type VideoModelId = (typeof VideoModels)[keyof typeof VideoModels]["id"];
export type VideoPurpose = "commercial-production" | "evaluation";

const EnqueueInput = z
  .object({
    tenantId: z.string().min(1).max(200),
    image: z
      .instanceof(Buffer)
      .refine(
        (value) => value.length > 0 && value.length <= 12 * 1024 * 1024,
        "Image must contain between 1 byte and 12 MiB",
      ),
    prompt: z.string().trim().min(1).max(1200),
    seed: z.number().int().nonnegative(),
    seconds: z.number().int().min(2).max(8),
    maxCostUsd: z.number().positive().max(5),
    modelId: z.enum([VideoModels.wan22.id, VideoModels.hunyuan15.id]),
    modelRevision: z.string().min(7).max(200),
    purpose: z.enum(["commercial-production", "evaluation"]),
    billing: z.enum(["standalone", "campaign-included"]).default("standalone"),
    credits: z.number().int().nonnegative().max(100).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
  })
  .superRefine((input, context) => {
    if (input.billing === "campaign-included" && input.credits !== 0)
      context.addIssue({
        code: "custom",
        path: ["credits"],
        message:
          "Campaign-included video jobs must explicitly reserve 0 credits",
      });
    if (input.billing === "standalone" && input.credits === 0)
      context.addIssue({
        code: "custom",
        path: ["credits"],
        message: "Standalone video jobs must reserve positive credits",
      });
  })
  .strict();

export type VideoQueueInput = z.input<typeof EnqueueInput>;

type StoredInput = Omit<
  VideoQueueInput,
  "tenantId" | "image" | "credits" | "maxAttempts" | "billing"
> & { imageSha256: string };

type VideoJobRow = {
  id: string;
  tenant: string;
  content_hash: string;
  model_id: VideoModelId;
  model_revision: string;
  purpose: VideoPurpose;
  input_json: string;
  input_path: string;
  state: "queued" | "running" | "done" | "cached" | "failed";
  tries: number;
  max_attempts: number;
  available: number;
  lease: number;
  lease_token?: string;
  credits: number;
  charge_ref?: string;
  output_hash?: string;
  receipt_json?: string;
  gpu_ms?: number;
  warmup_share_ms?: number;
  gpu_measurement?: "provider-receipt" | "allocated-wall-clock" | "cache-reuse";
  error?: string;
  created: number;
  updated: number;
};

type CacheRow = {
  tenant: string;
  content_hash: string;
  model_id: VideoModelId;
  model_revision: string;
  output_hash: string;
  object_path: string;
  receipt_json: string;
  created: number;
};

export type VideoExecutor = (
  input: VideoGenerationInput & {
    modelId: VideoModelId;
    modelRevision: string;
  },
) => Promise<GeneratedClip>;

export type VideoQueueJob = {
  id: string;
  tenantId: string;
  contentHash: string;
  modelId: VideoModelId;
  modelRevision: string;
  purpose: VideoPurpose;
  state: VideoJobRow["state"];
  tries: number;
  creditsReserved: number;
  outputHash?: string;
  gpuMilliseconds?: number;
  warmupShareMilliseconds?: number;
  allocatedGpuMilliseconds?: number;
  gpuMeasurement?: VideoJobRow["gpu_measurement"];
  error?: string;
};

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function modelPolicy(modelId: VideoModelId) {
  return Object.values(VideoModels).find((model) => model.id === modelId)!;
}

export function assertVideoModelPolicy(
  modelId: VideoModelId,
  purpose: VideoPurpose,
) {
  const policy = modelPolicy(modelId);
  if (!(policy.allowedPurposes as readonly string[]).includes(purpose))
    throw new Error(
      "HunyuanVideo 1.5 is evaluation-only; use Wan2.2 for commercial production",
    );
}

function publicJob(row: VideoJobRow): VideoQueueJob {
  return {
    id: row.id,
    tenantId: row.tenant,
    contentHash: row.content_hash,
    modelId: row.model_id,
    modelRevision: row.model_revision,
    purpose: row.purpose,
    state: row.state,
    tries: row.tries,
    creditsReserved: row.credits,
    outputHash: row.output_hash,
    gpuMilliseconds: row.gpu_ms,
    warmupShareMilliseconds: row.warmup_share_ms,
    allocatedGpuMilliseconds:
      row.gpu_ms === undefined
        ? undefined
        : row.gpu_ms + (row.warmup_share_ms || 0),
    gpuMeasurement: row.gpu_measurement,
    error: row.error,
  };
}

export class VideoQueue {
  private credits: Credits;

  constructor(
    private store: Store,
    private executor: VideoExecutor = async (input) => generateClip(input),
  ) {
    this.credits = new Credits(store);
  }

  enqueue(raw: VideoQueueInput): VideoQueueJob {
    const input = EnqueueInput.parse(raw);
    assertVideoModelPolicy(input.modelId, input.purpose);
    const imageSha256 = sha256(input.image);
    const stored: StoredInput = {
      prompt: input.prompt,
      seed: input.seed,
      seconds: input.seconds,
      maxCostUsd: input.maxCostUsd,
      modelId: input.modelId,
      modelRevision: input.modelRevision,
      purpose: input.purpose,
      imageSha256,
    };
    const contentHash = sha256(JSON.stringify(stored));
    const tenantDirectory = sha256(input.tenantId);
    const inputDirectory = path.join(
      this.store.root,
      "video-inputs",
      tenantDirectory,
    );
    const inputPath = path.join(inputDirectory, contentHash);
    mkdirSync(inputDirectory, { recursive: true, mode: 0o700 });
    if (!existsSync(inputPath))
      writeFileSync(inputPath, input.image, { mode: 0o600, flag: "wx" });
    const now = Date.now();
    const reserved =
      input.billing === "campaign-included"
        ? 0
        : (input.credits ??
          z.coerce
            .number()
            .int()
            .positive()
            .max(100)
            .parse(process.env.AXYS_VIDEO_QUEUE_CREDITS || "1"));
    const maxAttempts = input.maxAttempts ?? 3;
    return this.store.transaction(() => {
      const existing = this.findRow(
        input.tenantId,
        contentHash,
        input.modelId,
        input.modelRevision,
      );
      if (existing) return publicJob(existing);
      const cached = this.cacheRow(
        input.tenantId,
        contentHash,
        input.modelId,
        input.modelRevision,
      );
      const id = randomUUID();
      if (cached) {
        this.store.db
          .prepare(
            `INSERT INTO video_jobs(
              id,tenant,content_hash,model_id,model_revision,purpose,input_json,input_path,
              state,max_attempts,credits,output_hash,receipt_json,gpu_ms,warmup_share_ms,
              gpu_measurement,created,updated
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.tenantId,
            contentHash,
            input.modelId,
            input.modelRevision,
            input.purpose,
            JSON.stringify(stored),
            inputPath,
            "cached",
            maxAttempts,
            0,
            cached.output_hash,
            cached.receipt_json,
            0,
            0,
            "cache-reuse",
            now,
            now,
          );
      } else {
        const chargeReference = `video:${contentHash}:${input.modelRevision}`;
        if (reserved > 0)
          this.credits.reserveInTransaction(
            input.tenantId,
            reserved,
            chargeReference,
            "video-reservation",
          );
        this.store.db
          .prepare(
            `INSERT INTO video_jobs(
              id,tenant,content_hash,model_id,model_revision,purpose,input_json,input_path,
              state,max_attempts,credits,charge_ref,created,updated
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.tenantId,
            contentHash,
            input.modelId,
            input.modelRevision,
            input.purpose,
            JSON.stringify(stored),
            inputPath,
            "queued",
            maxAttempts,
            reserved,
            reserved > 0 ? chargeReference : null,
            now,
            now,
          );
      }
      return publicJob(this.row(input.tenantId, id));
    });
  }

  get(tenantId: string, id: string) {
    return publicJob(this.row(tenantId, id));
  }

  result(tenantId: string, id: string) {
    const job = this.row(tenantId, id);
    if (!job.output_hash || !["done", "cached"].includes(job.state))
      throw new Error("Video result is not ready");
    const cached = this.cacheRow(
      tenantId,
      job.content_hash,
      job.model_id,
      job.model_revision,
    );
    if (!cached) throw new Error("Video cache entry is missing");
    const bytes = readFileSync(cached.object_path);
    if (sha256(bytes) !== cached.output_hash)
      throw new Error("Video cache integrity check failed");
    return {
      bytes,
      sha256: cached.output_hash,
      receipt: JSON.parse(cached.receipt_json),
      cacheHit: job.state === "cached",
    };
  }

  leaseBatch(limit = 4, leaseMilliseconds = 15 * 60_000) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32)
      throw new Error("Video batch limit must be between 1 and 32");
    if (!Number.isInteger(leaseMilliseconds) || leaseMilliseconds < 60_000)
      throw new Error("Video lease must be at least one minute");
    const now = Date.now();
    return this.store.transaction(() => {
      const rows = this.store.db
        .prepare(
          `SELECT * FROM video_jobs
           WHERE (state='queued' AND available<=?) OR (state='running' AND lease<?)
           ORDER BY created,id LIMIT ?`,
        )
        .all(now, now, limit) as unknown as VideoJobRow[];
      return rows.flatMap((candidate) => {
        const token = randomUUID();
        const updated = this.store.db
          .prepare(
            `UPDATE video_jobs SET state='running',tries=tries+1,lease=?,lease_token=?,updated=?
             WHERE id=? AND tenant=? AND ((state='queued' AND available<=?) OR (state='running' AND lease<?))`,
          )
          .run(
            now + leaseMilliseconds,
            token,
            now,
            candidate.id,
            candidate.tenant,
            now,
            now,
          );
        if (!updated.changes) return [];
        return [this.row(candidate.tenant, candidate.id)];
      });
    });
  }

  async processBatch(
    options: {
      limit?: number;
      leaseMilliseconds?: number;
      warmupMilliseconds?: number;
    } = {},
  ) {
    const leased = this.leaseBatch(options.limit, options.leaseMilliseconds);
    const warmup = Math.round(options.warmupMilliseconds || 0);
    if (warmup < 0 || warmup > 3_600_000)
      throw new Error("Measured warmup must be between 0 and one hour");
    const base = leased.length ? Math.floor(warmup / leased.length) : 0;
    let remainder = leased.length ? warmup % leased.length : 0;
    for (const job of leased) {
      const warmupShare = base + (remainder-- > 0 ? 1 : 0);
      try {
        await this.execute(job, warmupShare);
      } catch (error) {
        this.fail(job, error);
      }
    }
    return leased.map((job) => this.get(job.tenant, job.id));
  }

  private async execute(job: VideoJobRow, warmupShare: number) {
    assertVideoModelPolicy(job.model_id, job.purpose);
    const input = JSON.parse(job.input_json) as StoredInput;
    const image = readFileSync(job.input_path);
    if (sha256(image) !== input.imageSha256)
      throw new Error("Video queue input integrity check failed");
    const started = performance.now();
    const generated = await this.executor({
      image,
      prompt: input.prompt,
      seed: input.seed,
      seconds: input.seconds,
      maxCostUsd: input.maxCostUsd,
      modelId: job.model_id,
      modelRevision: job.model_revision,
    });
    const requestMilliseconds = Math.max(
      0,
      Math.round(performance.now() - started),
    );
    if (
      generated.model !== `${job.model_id}@${job.model_revision}` &&
      generated.model !== job.model_id
    )
      throw new Error(
        "Video worker model receipt does not match the queued policy",
      );
    const gpuMilliseconds =
      generated.gpuMilliseconds === undefined
        ? requestMilliseconds
        : generated.gpuMilliseconds;
    const measurement =
      generated.gpuMilliseconds === undefined
        ? "allocated-wall-clock"
        : "provider-receipt";
    this.complete(job, generated, gpuMilliseconds, warmupShare, measurement);
  }

  private complete(
    job: VideoJobRow,
    generated: GeneratedClip,
    gpuMilliseconds: number,
    warmupShare: number,
    measurement: "provider-receipt" | "allocated-wall-clock",
  ) {
    const leaseToken = job.lease_token;
    if (!leaseToken) throw new Error("Video job lease token is missing");
    const directory = path.join(
      this.store.root,
      "video-cache",
      sha256(job.tenant),
      job.content_hash,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const objectPath = path.join(directory, `${generated.sha256}.mp4`);
    if (!existsSync(objectPath))
      writeFileSync(objectPath, generated.bytes, { mode: 0o600, flag: "wx" });
    const { bytes: _bytes, ...receipt } = generated;
    const now = Date.now();
    const completed = this.store.transaction(() => {
      const result = this.store.db
        .prepare(
          `UPDATE video_jobs SET state='done',lease=0,lease_token=NULL,output_hash=?,receipt_json=?,
             gpu_ms=?,warmup_share_ms=?,gpu_measurement=?,error=NULL,updated=?
           WHERE id=? AND tenant=? AND state='running' AND lease_token=?`,
        )
        .run(
          generated.sha256,
          JSON.stringify(receipt),
          gpuMilliseconds,
          warmupShare,
          measurement,
          now,
          job.id,
          job.tenant,
          leaseToken,
        );
      if (!result.changes) return false;
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO video_cache(
             tenant,content_hash,model_id,model_revision,output_hash,object_path,receipt_json,created
           ) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          job.tenant,
          job.content_hash,
          job.model_id,
          job.model_revision,
          generated.sha256,
          objectPath,
          JSON.stringify(receipt),
          now,
        );
      return true;
    });
    if (completed && existsSync(job.input_path)) unlinkSync(job.input_path);
  }

  private fail(job: VideoJobRow, error: unknown) {
    const leaseToken = job.lease_token;
    if (!leaseToken) throw new Error("Video job lease token is missing");
    const message = (
      error instanceof Error ? error.message : "Video job failed"
    ).slice(0, 300);
    const now = Date.now();
    this.store.transaction(() => {
      const current = this.store.db
        .prepare(
          "SELECT * FROM video_jobs WHERE id=? AND tenant=? AND state='running' AND lease_token=?",
        )
        .get(job.id, job.tenant, leaseToken) as VideoJobRow | undefined;
      if (!current) return;
      if (current.tries < current.max_attempts) {
        this.store.db
          .prepare(
            `UPDATE video_jobs SET state='queued',available=?,lease=0,lease_token=NULL,error=?,updated=?
             WHERE id=? AND tenant=? AND lease_token=?`,
          )
          .run(
            now + Math.min(60_000, 1000 * 2 ** current.tries),
            message,
            now,
            current.id,
            current.tenant,
            leaseToken,
          );
        return;
      }
      this.store.db
        .prepare(
          `UPDATE video_jobs SET state='failed',lease=0,lease_token=NULL,error=?,updated=?
           WHERE id=? AND tenant=? AND lease_token=?`,
        )
        .run(message, now, current.id, current.tenant, leaseToken);
      if (current.charge_ref)
        this.credits.refundInTransaction(current.tenant, current.charge_ref);
    });
  }

  private row(tenantId: string, id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM video_jobs WHERE tenant=? AND id=?")
      .get(tenantId, id) as VideoJobRow | undefined;
    if (!row) throw new Error("Video job not found");
    return row;
  }

  private findRow(
    tenantId: string,
    contentHash: string,
    modelId: VideoModelId,
    modelRevision: string,
  ) {
    return this.store.db
      .prepare(
        `SELECT * FROM video_jobs
         WHERE tenant=? AND content_hash=? AND model_id=? AND model_revision=?`,
      )
      .get(tenantId, contentHash, modelId, modelRevision) as
      | VideoJobRow
      | undefined;
  }

  private cacheRow(
    tenantId: string,
    contentHash: string,
    modelId: VideoModelId,
    modelRevision: string,
  ) {
    return this.store.db
      .prepare(
        `SELECT * FROM video_cache
         WHERE tenant=? AND content_hash=? AND model_id=? AND model_revision=?`,
      )
      .get(tenantId, contentHash, modelId, modelRevision) as
      | CacheRow
      | undefined;
  }
}
