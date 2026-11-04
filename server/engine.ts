import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Store } from "./store.ts";
import {
  hash,
  digest,
  assertConsistent,
  specs,
  type Campaign,
  type Attempt,
} from "../packages/campaign/index.ts";
import { readFileSync } from "node:fs";
import { command, renderReel } from "../packages/renderers/reel.ts";
import { propose } from "../packages/inference/meta.ts";
import { MuseGateway } from "../packages/meta/gateway.ts";
import { usableMedia } from "../packages/meta/enrichment.ts";
import { assertPreflightClear } from "../packages/meta/preflight.ts";
import { Meta, type Connection } from "../services/publishing/meta.ts";
import {
  hasVideoWorker,
  videoCampaignCap,
  type GeneratedClip,
} from "../services/video/worker.ts";
import {
  VideoModels,
  VideoQueue,
  Wan22ProductionRevision,
} from "../services/video/queue.ts";
import { decrypt, required, publicOrigin, sign } from "./security.ts";
import { Credits } from "./credits.ts";
export type Asset = {
  id: string;
  tenantId: string;
  hash: string;
  mime: string;
  size: number;
  rightsConfirmed: boolean;
  createdAt: string;
};
export class Engine {
  constructor(
    public store: Store,
    public metaFactory = (token: string) => new Meta(token),
    public whatsappMedia = async (tenant: string, id: string) => {
      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
      const apiVersion = process.env.WHATSAPP_API_VERSION;
      if (!accessToken || !apiVersion)
        throw new Error("WhatsApp media retrieval is not configured");
      const { fetchWhatsAppMedia } = await import("./whatsapp.ts");
      return fetchWhatsAppMedia(this.store, tenant, id, {
        accessToken,
        apiVersion,
      });
    },
    public videoQueue = new VideoQueue(store),
    public gateway: MuseGateway = new MuseGateway(),
  ) {}
  get(tenant: string, id: string) {
    const c = this.store.get<Campaign>("campaign", tenant, id);
    if (!c) throw new Error("Campaign not found");
    return c;
  }
  save(c: Campaign) {
    this.store.put("campaign", c.tenantId, c.id, c);
  }
  async asset(tenant: string, bytes: Buffer, mime: string): Promise<Asset> {
    const total = (
      this.store.db
        .prepare(
          "SELECT COALESCE(SUM(json_extract(data,'$.size')),0) AS size FROM records WHERE kind='asset' AND tenant=?",
        )
        .get(tenant) as { size: number }
    ).size;
    if (total + bytes.length > 256 * 1024 * 1024)
      throw new Error(
        "Workspace media limit reached. Apply retention before uploading more.",
      );
    const id = randomUUID(),
      h = hash(bytes);
    const dir = path.join(this.store.root, "objects", tenant);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, h), bytes, { mode: 0o600 });
    const a = {
      id,
      tenantId: tenant,
      hash: h,
      mime,
      size: bytes.length,
      rightsConfirmed: true,
      createdAt: new Date().toISOString(),
    };
    this.store.put("asset", tenant, id, a);
    return a;
  }
  async audio(tenant: string, bytes: Buffer) {
    const magic = bytes.subarray(0, 12);
    const allowed =
      magic.subarray(0, 3).toString() === "ID3" ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) ||
      (magic.subarray(0, 4).toString() === "RIFF" &&
        magic.subarray(8, 12).toString() === "WAVE") ||
      magic.subarray(4, 8).toString() === "ftyp" ||
      magic.subarray(0, 4).toString() === "OggS" ||
      magic.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!allowed) throw new Error("Unsupported audio file signature");
    const dir = path.join(this.store.root, "audio-validation");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, randomUUID());
    await writeFile(file, bytes, { mode: 0o600 });
    try {
      const probe = JSON.parse(
        await command(process.env.FFPROBE_PATH || "ffprobe", [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          file,
        ]),
      );
      if (
        !probe.streams.some((s: any) => s.codec_type === "audio") ||
        probe.streams.some((s: any) => s.codec_type === "video") ||
        !Number.isFinite(Number(probe.format.duration)) ||
        Number(probe.format.duration) > 180
      )
        throw new Error("Use an audio-only recording of at most 3 minutes");
      return await this.asset(
        tenant,
        bytes,
        "audio/" +
          (probe.format.format_name.includes("mp3")
            ? "mpeg"
            : probe.format.format_name.includes("wav")
              ? "wav"
              : probe.format.format_name.includes("ogg")
                ? "ogg"
                : probe.format.format_name.includes("webm")
                  ? "webm"
                  : "mp4"),
      );
    } finally {
      await unlink(file);
    }
  }
  async image(tenant: string, bytes: Buffer) {
    const image = sharp(bytes, { limitInputPixels: 40000000 });
    const meta = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(meta.format || ""))
      throw new Error("Upload a JPEG, PNG or WebP image");
    const clean = await image
      .rotate()
      .resize({
        width: 2000,
        height: 2000,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90 })
      .toBuffer();
    return this.asset(tenant, clean, "image/jpeg");
  }
  async bytes(tenant: string, id: string) {
    const a = this.store.get<Asset>("asset", tenant, id);
    if (!a) throw new Error("Asset not found");
    return readFile(path.join(this.store.root, "objects", tenant, a.hash));
  }
  enqueue(c: Campaign, kind: string) {
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO jobs(id,tenant,campaign,kind,revision,state,available) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        c.tenantId,
        c.id,
        kind,
        c.revision,
        "queued",
        kind === "publish" && c.approval
          ? Math.max(0, Date.parse(c.approval.schedule))
          : 0,
      );
  }
  approval(c: Campaign, accountId: string, schedule: string, expected: string) {
    if (c.site && c.reel) assertPreflightClear(this.store, c);
    assertConsistent(c);
    const due = Date.parse(schedule);
    if (!Number.isFinite(due) || due > Date.now() + 30 * 86400000)
      throw new Error("Choose a publish time within 30 days");
    if (
      c.facts.validUntil &&
      Date.parse(c.facts.validUntil) <= Math.max(Date.now(), due)
    )
      throw new Error("Offer expires before publication");
    if (due > Date.now() + 60000 && !c.facts.validUntil)
      throw new Error("Set an offer expiry before scheduling");
    if (c.state === "Generating" || c.state === "Publishing")
      throw new Error("Wait for rendering");
    if (c.mode !== "Website" && !c.videoHash)
      throw new Error("Render the final reel before approval");
    if (digest(c, accountId, schedule) !== expected)
      throw new Error("Preview is stale. Review the latest version.");
    if (c.mode !== "Website") this.connection(c.tenantId, accountId);
    c.approval = {
      id: randomUUID(),
      digest: expected,
      revision: c.revision,
      accountId,
      schedule,
      approvedAt: new Date().toISOString(),
    };
    c.state = "Approved";
    this.save(c);
    return c;
  }
  connection(tenant: string, account: string) {
    const v = this.store.get<Connection>("connection", tenant, account);
    if (!v?.active || v.expiresAt < Date.now())
      throw new Error("Instagram is disconnected or expired. Reconnect.");
    return v;
  }
  verify(c: Campaign) {
    const a = c.approval;
    if (c.facts.validUntil && Date.parse(c.facts.validUntil) <= Date.now())
      throw new Error("Offer has expired; revise and approve again");
    if (
      !a ||
      a.revision !== c.revision ||
      a.digest !== digest(c, a.accountId, a.schedule)
    )
      throw new Error("Approval is stale or missing");
    assertConsistent(c);
    if (c.mode !== "Website") {
      const asset = this.store.get<Asset>(
        "asset",
        c.tenantId,
        c.videoAssetId || "",
      );
      if (
        !asset ||
        asset.hash !== c.videoHash ||
        hash(
          readFileSync(
            path.join(this.store.root, "objects", c.tenantId, asset.hash),
          ),
        ) !== c.videoHash
      )
        throw new Error(
          "Approved video is missing or changed. Render and review again.",
        );
    }
    if (c.mode !== "Website") this.connection(c.tenantId, a.accountId);
  }
  publish(c: Campaign, approvalId: string) {
    this.verify(c);
    if (c.approval!.id !== approvalId) throw new Error("Approval is stale");
    this.store.transaction(() => {
      const row = this.store.db
        .prepare(
          "SELECT data FROM publications WHERE tenant=? AND campaign=? AND revision=?",
        )
        .get(c.tenantId, c.id, c.revision);
      if (row) return;
      const a: Attempt = {
        id: randomUUID(),
        site: c.mode === "Reels" ? "Skipped" : "Pending",
        social: c.mode === "Website" ? "Skipped" : "Pending",
      };
      this.store.db
        .prepare("INSERT INTO publications VALUES(?,?,?,?)")
        .run(c.tenantId, c.id, c.revision, JSON.stringify(a));
      c.attempt = a;
      c.state = "Publishing";
      this.save(c);
      this.enqueue(c, "publish");
    });
    return this.get(c.tenantId, c.id);
  }
  saveAttempt(c: Campaign) {
    this.store.db
      .prepare(
        "UPDATE publications SET data=? WHERE tenant=? AND campaign=? AND revision=?",
      )
      .run(JSON.stringify(c.attempt), c.tenantId, c.id, c.revision);
    const current = this.store.get<Campaign>("campaign", c.tenantId, c.id);
    if (!current || current.revision !== c.revision) return;
    if (current.approval?.id !== c.approval?.id) {
      current.attempt = c.attempt;
      current.state = "NeedsReview";
      current.error =
        "Approval changed while the provider request was in progress. Review the receipt before taking another action.";
      this.save(current);
      return;
    }
    this.save(c);
  }
  mediaUrl(c: Campaign) {
    const expires = Date.now() + 24 * 3600000;
    const data = `${c.tenantId}:${c.videoAssetId}:${expires}`;
    return `${publicOrigin()}/media/${c.videoAssetId}?tenant=${c.tenantId}&expires=${expires}&sig=${sign(data, required("AXYS_MEDIA_KEY"))}`;
  }
  async generate(c: Campaign, ai: boolean) {
    let headline = c.facts.offer;
    const alreadyPlanned = c.generation?.revision === c.revision;
    if (ai && !alreadyPlanned) {
      const result = await propose(c, this.store, [], this.gateway);
      c.trace = result.trace;
      if (
        result.proposal.questions.length ||
        result.proposal.tool === "request_facts"
      )
        throw new Error(
          result.proposal.questions.join(" ") || "Please clarify the brief",
        );
      if (result.proposal.headline !== c.facts.offer)
        throw new Error(
          "Model changed the confirmed offer. Review the proposal before using it.",
        );
      const plan = result.proposal;
      if (plan.productOrder) {
        const ids = c.facts.products.map((p) => p.id);
        if (
          plan.productOrder.length !== ids.length ||
          new Set(plan.productOrder).size !== ids.length ||
          plan.productOrder.some((id) => !ids.includes(id))
        )
          throw new Error(
            "Model storyboard contains missing or unknown products",
          );
        c.facts.products = plan.productOrder.map(
          (id) => c.facts.products.find((p) => p.id === id)!,
        );
      }
      if (plan.layout) c.layout = plan.layout;
      if (plan.reelStyle) c.reelStyle = plan.reelStyle;
      headline = result.proposal.headline;
    }
    if (!alreadyPlanned) {
      const next = specs(c, headline, usableMedia(this.store, c).hero);
      c.site = next.site;
      c.reel = next.reel;
      c.siteHash = hash(c.site);
      c.generation = {
        revision: c.revision,
        ai,
        videoJobs: [],
      };
      this.save(c);
    }
    if (!c.site || !c.reel || !c.generation)
      throw new Error("Persisted campaign generation plan is incomplete");
    if (c.mode !== "Website") {
      const generatedClips = new Map<string, Buffer>();
      const videoReceipts: Omit<GeneratedClip, "bytes">[] = [];
      const campaignCharge = this.store.get<{ reason: string; units: number }>(
        "credit-entry",
        c.tenantId,
        `generation:${c.id}:${c.revision}`,
      );
      const onlineVideo =
        campaignCharge?.reason === "generation" &&
        campaignCharge.units < 0 &&
        hasVideoWorker();
      if (onlineVideo) {
        const perShotCap = videoCampaignCap() / c.reel.shots.length;
        for (
          let i = c.generation.videoJobs.length;
          i < c.reel.shots.length;
          i++
        ) {
          const shot = c.reel.shots[i];
          const product = c.facts.products.find(
            (item) => item.id === shot.productId,
          )!;
          const queued = this.videoQueue.enqueue({
            tenantId: c.tenantId,
            image: await this.bytes(c.tenantId, product.assetId),
            prompt:
              `Create a cinematic vertical product shot using the supplied image as the exact first frame. ` +
              `Keep the product, packaging, label, colors, proportions, and quantity unchanged. ` +
              `Use a subtle slow dolly and natural environmental motion for ${product.name.slice(0, 80)}. ` +
              `Do not add claims, prices, writing, logos, products, hands, or people.`,
            seed: Number.parseInt(
              hash(`${c.id}:${c.revision}:${i}`).slice(0, 8),
              16,
            ),
            seconds: Math.max(2, Math.min(8, shot.duration)),
            maxCostUsd: perShotCap,
            modelId: VideoModels.wan22.id,
            modelRevision: Wan22ProductionRevision,
            purpose: "commercial-production",
            billing: "campaign-included",
            credits: 0,
          });
          c.generation.videoJobs.push({
            id: queued.id,
            contentHash: queued.contentHash,
            productId: product.id,
            shotIndex: i,
          });
          this.save(c);
        }
        if (c.generation.videoJobs.length !== c.reel.shots.length)
          throw new Error(
            "Persisted video job plan does not match the storyboard",
          );
        for (const reference of c.generation.videoJobs) {
          const shot = c.reel.shots[reference.shotIndex];
          if (!shot || shot.productId !== reference.productId)
            throw new Error(
              "Persisted video job no longer matches the storyboard",
            );
          const job = this.videoQueue.get(c.tenantId, reference.id);
          if (job.contentHash !== reference.contentHash)
            throw new Error("Persisted video job content hash changed");
          if (job.state === "failed")
            throw new Error(job.error || "Online video generation failed");
          if (job.state !== "done" && job.state !== "cached") return false;
          const generated = this.videoQueue.result(c.tenantId, job.id);
          generatedClips.set(reference.productId, generated.bytes);
          videoReceipts.push(generated.receipt as Omit<GeneratedClip, "bytes">);
        }
        const reportedCostUsd = videoReceipts.reduce(
          (total, item) => total + item.costUsd,
          0,
        );
        if (reportedCostUsd > videoCampaignCap())
          throw new Error("Online video generation exceeded the campaign cap");
        c.trace = {
          planning: c.trace,
          videoGeneration: {
            mode: "online-image-to-video",
            receipts: videoReceipts,
            campaignCapUsd: videoCampaignCap(),
            reportedCostUsd,
            costBasis: "worker receipts; reconcile with provider billing",
          },
        };
      }
      const cutouts = new Map<string, Buffer>();
      for (const [productId, assetId] of usableMedia(this.store, c).cutouts)
        cutouts.set(productId, await this.bytes(c.tenantId, assetId));
      const rendered = await renderReel(
        c.reel,
        path.join(
          this.store.root,
          "renders",
          c.tenantId,
          c.id,
          String(c.revision),
        ),
        (id) => this.bytes(c.tenantId, id),
        generatedClips,
        cutouts,
      );
      const a = await this.asset(c.tenantId, rendered.bytes, "video/mp4");
      c.videoPosterId = (
        await this.asset(c.tenantId, rendered.poster, "image/png")
      ).id;
      c.videoAssetId = a.id;
      c.videoHash = a.hash;
      this.store.put("probe", c.tenantId, a.id, rendered.probe);
    }
    if (this.get(c.tenantId, c.id).revision !== c.revision) return true;
    c.state = "NeedsReview";
    delete c.error;
    this.save(c);
    return true;
  }
  async publishStep(c: Campaign) {
    this.verify(c);
    if (Date.parse(c.approval!.schedule) > Date.now()) return false;
    const a = c.attempt!;
    if (a.site === "Pending") {
      this.store.put("site", "public", c.id, {
        tenantId: c.tenantId,
        campaignId: c.id,
        revision: c.revision,
        spec: c.site,
        siteHash: c.siteHash,
        publishedAt: new Date().toISOString(),
      });
      this.store.put("siteVersion", c.tenantId, `${c.id}-${c.revision}`, {
        campaignId: c.id,
        revision: c.revision,
        spec: c.site,
        hash: c.siteHash,
      });
      a.site = "Published";
      a.siteUrl = `${process.env.AXYS_ORIGIN || "http://127.0.0.1:4310"}/sites/${c.id}`;
      this.saveAttempt(c);
    }
    if (a.social === "Skipped") {
      c.state = "Published";
      this.saveAttempt(c);
      return true;
    }
    if (process.env.AXYS_ALLOW_PUBLIC_POSTING !== "true")
      throw new Error(
        "Public posting is disabled. Configure scoped account/content authorization before enabling.",
      );
    const con = this.connection(c.tenantId, c.approval!.accountId),
      meta = this.metaFactory(decrypt(con.token, required("AXYS_TOKEN_KEY")));
    if (a.mediaId) {
      const receipt = await meta.receipt(a.mediaId);
      if (!receipt.id || !receipt.permalink)
        throw new Error("Instagram receipt is incomplete");
      a.permalink = receipt.permalink;
      a.social = "Published";
      c.state = "Published";
      this.saveAttempt(c);
      return true;
    }
    if (a.publishSent) {
      a.social = "Unknown";
      c.state = a.site === "Published" ? "PartialFailure" : "NeedsAttention";
      a.error =
        "Publication outcome is uncertain. Reconcile the existing container; never create another post.";
      this.saveAttempt(c);
      if (a.containerId) {
        const status = await meta.status(a.containerId);
        this.store.put("reconciliation", c.tenantId, a.id, {
          status: status.status_code,
          checkedAt: new Date().toISOString(),
        });
      }
      return true;
    }
    if (!a.containerId) {
      if (a.social === "Creating" || a.social === "Unknown")
        throw new Error(
          "Container outcome uncertain; manual reconciliation required",
        );
      a.social = "Creating";
      this.saveAttempt(c);
      const container = await meta.create(
        con.accountId,
        this.mediaUrl(c),
        c.reel!.caption,
      );
      if (!/^\d+$/.test(container.id))
        throw new Error("Invalid container receipt");
      a.containerId = container.id;
      a.social = "Processing";
      this.saveAttempt(c);
      return false;
    }
    const status = await meta.status(a.containerId);
    if (status.status_code === "IN_PROGRESS") return false;
    if (status.status_code !== "FINISHED")
      throw new Error(
        `Instagram container state: ${String(status.status_code).slice(0, 30)}`,
      );
    this.verify(this.get(c.tenantId, c.id));
    a.publishSent = true;
    a.social = "Publishing";
    this.saveAttempt(c);
    const published = await meta.publish(con.accountId, a.containerId);
    if (!/^\d+$/.test(published.id))
      throw new Error("No confirmed media identifier");
    a.mediaId = published.id;
    this.saveAttempt(c);
    return false;
  }
  busy = false;
  async tick() {
    if (this.busy) return;
    this.busy = true;
    let job: any;
    try {
      const videoPending = this.store.db
        .prepare(
          "SELECT 1 FROM video_jobs WHERE state IN ('queued','running') LIMIT 1",
        )
        .get();
      if (videoPending && hasVideoWorker())
        await this.videoQueue.processBatch({ limit: 4 });
      job = this.store.transaction(() => {
        const row = this.store.db
          .prepare(
            "SELECT * FROM jobs WHERE (state='queued' AND available<=?) OR (state='running' AND lease<?) ORDER BY rowid LIMIT 1",
          )
          .get(Date.now(), Date.now()) as any;
        if (row)
          this.store.db
            .prepare(
              "UPDATE jobs SET state='running',tries=tries+1,lease=? WHERE id=?",
            )
            .run(Date.now() + 240000, row.id);
        return row;
      });
      if (!job) return;
      if (job.kind === "whatsapp-media") {
        await this.whatsappMedia(job.tenant, job.campaign);
        this.store.db
          .prepare(
            "UPDATE jobs SET state='done',available=?,lease=0,error=NULL WHERE id=?",
          )
          .run(Date.now(), job.id);
        return;
      }
      let c = this.get(job.tenant, job.campaign);
      if (c.revision !== job.revision) {
        this.store.db
          .prepare("UPDATE jobs SET state='cancelled' WHERE id=?")
          .run(job.id);
        return;
      }
      if (job.tries >= 10)
        throw new Error("Job retry limit reached; review before resuming");
      let done = true;
      if (job.kind === "publish") done = await this.publishStep(c);
      else done = await this.generate(c, job.kind === "generate-ai");
      this.store.db
        .prepare("UPDATE jobs SET state=?,available=?,lease=0 WHERE id=?")
        .run(done ? "done" : "queued", Date.now() + 60000, job.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Job failed";
      if (job) {
        if (job.kind === "whatsapp-media") {
          const attempts = Number(job.tries) + 1;
          const media = this.store.get<any>(
            "whatsapp-media",
            job.tenant,
            job.campaign,
          );
          if (media)
            this.store.put("whatsapp-media", job.tenant, job.campaign, {
              ...media,
              status: attempts < 5 ? "PendingFetch" : "Failed",
              error: message.slice(0, 200),
            });
          if (attempts < 5)
            this.store.db
              .prepare(
                "UPDATE jobs SET state='queued',available=?,error=?,lease=0 WHERE id=?",
              )
              .run(
                Date.now() + Math.min(60000, 1000 * 2 ** attempts),
                message.slice(0, 300),
                job.id,
              );
          else
            this.store.db
              .prepare(
                "UPDATE jobs SET state='failed',error=?,lease=0 WHERE id=?",
              )
              .run(message.slice(0, 300), job.id);
          return;
        }
        this.store.db
          .prepare("UPDATE jobs SET state='failed',error=?,lease=0 WHERE id=?")
          .run(message, job.id);
        const c = this.get(job.tenant, job.campaign);
        c.error = message;
        if (c.attempt) {
          c.attempt.error = message;
          c.attempt.social = c.attempt.publishSent ? "Unknown" : "Failed";
          c.state =
            c.attempt.site === "Published"
              ? "PartialFailure"
              : "NeedsAttention";
          this.saveAttempt(c);
        } else {
          if (job.kind === "generate" || job.kind === "generate-ai")
            new Credits(this.store).refund(
              job.tenant,
              `generation:${job.campaign}:${job.revision}`,
            );
          c.state = "NeedsReview";
          this.save(c);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
