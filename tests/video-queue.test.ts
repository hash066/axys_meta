import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Credits } from "../server/credits.ts";
import { Store } from "../server/store.ts";
import {
  VideoModels,
  VideoQueue,
  type VideoExecutor,
  type VideoQueueInput,
} from "../services/video/queue.ts";

function fixture(executor: VideoExecutor) {
  const root = mkdtempSync(path.resolve("var-video-queue-"));
  const store = new Store(root);
  const previous = process.env.AXYS_STARTER_CREDITS;
  process.env.AXYS_STARTER_CREDITS = "10";
  return {
    root,
    store,
    queue: new VideoQueue(store, executor),
    credits: new Credits(store),
    close() {
      store.db.close();
      previous === undefined
        ? delete process.env.AXYS_STARTER_CREDITS
        : (process.env.AXYS_STARTER_CREDITS = previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function input(
  tenantId: string,
  prompt: string,
  overrides: Partial<VideoQueueInput> = {},
): VideoQueueInput {
  return {
    tenantId,
    image: Buffer.from("owned product image"),
    prompt,
    seed: 7,
    seconds: 4,
    maxCostUsd: 1,
    modelId: VideoModels.wan22.id,
    modelRevision: "wan-revision-123",
    purpose: "commercial-production",
    credits: 1,
    ...overrides,
  };
}

function executor(calls: string[]): VideoExecutor {
  return async (value) => {
    calls.push(value.prompt);
    const bytes = Buffer.from(`video:${value.prompt}`);
    return {
      requestId: `request-${calls.length}`,
      model: `${value.modelId}@${value.modelRevision}`,
      seed: value.seed,
      seconds: value.seconds,
      width: 704,
      height: 1280,
      provider: "fixture-gpu",
      costUsd: 0.1,
      costBasis: "provider-billed",
      gpuMilliseconds: 1000,
      gpuMeasurement: "provider-receipt",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
}

test("video queue reserves once, accounts batch warmup and reuses tenant cache", async () => {
  const calls: string[] = [];
  const f = fixture(executor(calls));
  try {
    f.credits.seed("merchant");
    const first = f.queue.enqueue(input("merchant", "slow dolly"));
    const duplicate = f.queue.enqueue(input("merchant", "slow dolly"));
    const second = f.queue.enqueue(input("merchant", "subtle orbit"));
    assert.equal(duplicate.id, first.id);
    assert.equal(f.credits.summary("merchant").balance, 8);

    const completed = await f.queue.processBatch({
      limit: 2,
      warmupMilliseconds: 101,
    });
    assert.equal(completed.length, 2);
    assert.equal(
      completed.reduce(
        (total, job) => total + (job.warmupShareMilliseconds || 0),
        0,
      ),
      101,
    );
    assert.deepEqual(
      completed.map((job) => job.gpuMilliseconds),
      [1000, 1000],
    );
    assert.deepEqual(
      completed.map((job) => job.gpuMeasurement),
      ["provider-receipt", "provider-receipt"],
    );
    assert.equal(
      f.queue.result("merchant", first.id).bytes.toString(),
      "video:slow dolly",
    );

    f.store.db
      .prepare("DELETE FROM video_jobs WHERE tenant=? AND id=?")
      .run("merchant", first.id);
    const cached = f.queue.enqueue(input("merchant", "slow dolly"));
    assert.equal(cached.state, "cached");
    assert.equal(cached.creditsReserved, 0);
    assert.equal(f.queue.result("merchant", cached.id).cacheHit, true);
    assert.equal(f.credits.summary("merchant").balance, 8);
    assert.deepEqual(calls, ["slow dolly", "subtle orbit"]);

    f.credits.seed("other");
    const isolated = f.queue.enqueue(input("other", "slow dolly"));
    assert.equal(isolated.state, "queued");
    assert.throws(() => f.queue.get("other", cached.id), /not found/);
    assert.equal(second.state, "queued");
  } finally {
    f.close();
  }
});

test("expired video lease recovers and final failure refunds atomically", async () => {
  const f = fixture(async () => {
    throw new Error("provider unavailable");
  });
  try {
    f.credits.seed("merchant");
    const queued = f.queue.enqueue(
      input("merchant", "recoverable shot", { maxAttempts: 2 }),
    );
    assert.equal(f.credits.summary("merchant").balance, 9);
    const abandoned = f.queue.leaseBatch(1, 60_000);
    assert.equal(abandoned[0].id, queued.id);
    f.store.db
      .prepare("UPDATE video_jobs SET lease=0 WHERE tenant=? AND id=?")
      .run("merchant", queued.id);

    const [failed] = await f.queue.processBatch({ limit: 1 });
    assert.equal(failed.state, "failed");
    assert.equal(failed.tries, 2);
    assert.match(failed.error || "", /provider unavailable/);
    assert.equal(f.credits.summary("merchant").balance, 10);
    assert.equal(
      f.credits
        .summary("merchant")
        .entries.filter((entry) => entry.reason === "refund").length,
      1,
    );
  } finally {
    f.close();
  }
});

test("video model policy keeps Hunyuan evaluation-only and Wan2.2 commercial", () => {
  const f = fixture(executor([]));
  try {
    f.credits.seed("merchant");
    assert.throws(
      () =>
        f.queue.enqueue(
          input("merchant", "commercial Hunyuan", {
            modelId: VideoModels.hunyuan15.id,
            modelRevision: "hunyuan-revision-123",
          }),
        ),
      /evaluation-only/,
    );
    assert.equal(f.credits.summary("merchant").balance, 10);
    assert.throws(
      () =>
        f.queue.enqueue(
          input("merchant", "untrusted zero reservation", { credits: 0 }),
        ),
      /Standalone video jobs must reserve positive credits/,
    );
    const campaignIncluded = f.queue.enqueue(
      input("merchant", "campaign included", {
        billing: "campaign-included",
        credits: 0,
      }),
    );
    assert.equal(campaignIncluded.creditsReserved, 0);
    const evaluation = f.queue.enqueue(
      input("merchant", "evaluation Hunyuan", {
        modelId: VideoModels.hunyuan15.id,
        modelRevision: "hunyuan-revision-123",
        purpose: "evaluation",
      }),
    );
    const production = f.queue.enqueue(input("merchant", "production Wan"));
    assert.equal(evaluation.state, "queued");
    assert.equal(production.state, "queued");
    assert.equal(f.credits.summary("merchant").balance, 8);
  } finally {
    f.close();
  }
});
