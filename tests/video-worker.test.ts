import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { generateClip, hasVideoWorker } from "../services/video/worker.ts";
import { Store } from "../server/store.ts";
import { Engine } from "../server/engine.ts";
import { Credits } from "../server/credits.ts";
import { Wan22ProductionRevision } from "../services/video/queue.ts";
import { command } from "../packages/renderers/reel.ts";
import type { Campaign } from "../packages/campaign/index.ts";

test("online video worker is opt-in and requires strong HTTPS configuration", () => {
  const old = { ...process.env };
  try {
    delete process.env.AXYS_VIDEO_WORKER_URL;
    delete process.env.AXYS_VIDEO_WORKER_TOKEN;
    delete process.env.AXYS_VIDEO_WORKER_REQUEST_MAX_USD;
    delete process.env.AXYS_VIDEO_WORKER_CAMPAIGN_MAX_USD;
    assert.equal(hasVideoWorker(), false);
    process.env.AXYS_VIDEO_WORKER_URL = "http://127.0.0.1:8188";
    process.env.AXYS_VIDEO_WORKER_TOKEN = "x".repeat(64);
    process.env.AXYS_VIDEO_WORKER_REQUEST_MAX_USD = "0.25";
    process.env.AXYS_VIDEO_WORKER_CAMPAIGN_MAX_USD = "1";
    assert.throws(() => hasVideoWorker(), /HTTPS/);
  } finally {
    process.env = old;
  }
});

test("online video worker validates byte integrity and structured receipt", async () => {
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  try {
    process.env.AXYS_VIDEO_WORKER_URL = "https://gpu.example.test";
    process.env.AXYS_VIDEO_WORKER_TOKEN = "t".repeat(64);
    process.env.AXYS_VIDEO_WORKER_REQUEST_MAX_USD = "0.25";
    process.env.AXYS_VIDEO_WORKER_CAMPAIGN_MAX_USD = "1";
    const video = Buffer.from("fixture mp4 bytes");
    const sha = createHash("sha256").update(video).digest("hex");
    const receipt = Buffer.from(
      JSON.stringify({
        requestId: "req-1",
        model: "test-i2v",
        seed: 7,
        seconds: 4,
        width: 704,
        height: 1280,
        provider: "fixture",
        costUsd: 0.02,
        costBasis: "provider-billed",
      }),
    ).toString("base64url");
    const receiptSignature = `sha256=${createHmac(
      "sha256",
      process.env.AXYS_VIDEO_WORKER_TOKEN!,
    )
      .update(`${sha}.${receipt}`)
      .digest("hex")}`;
    globalThis.fetch = async () =>
      new Response(new Uint8Array(video), {
        headers: {
          "x-axys-video-sha256": sha,
          "x-axys-video-receipt": receipt,
          "x-axys-receipt-signature": receiptSignature,
        },
      });
    const result = await generateClip({
      image: Buffer.from("image"),
      prompt: "slow cinematic camera orbit around the unchanged product",
      seed: 7,
      seconds: 4,
    });
    assert.equal(result.sha256, sha);
    assert.equal(result.model, "test-i2v");
    globalThis.fetch = async () =>
      new Response(new Uint8Array(video), {
        headers: {
          "x-axys-video-sha256": "0".repeat(64),
          "x-axys-video-receipt": receipt,
          "x-axys-receipt-signature": `sha256=${createHmac(
            "sha256",
            process.env.AXYS_VIDEO_WORKER_TOKEN!,
          )
            .update(`${"0".repeat(64)}.${receipt}`)
            .digest("hex")}`,
        },
      });
    await assert.rejects(
      () =>
        generateClip({
          image: Buffer.from("image"),
          prompt: "slow cinematic camera orbit",
          seed: 7,
          seconds: 4,
        }),
      /integrity/,
    );
  } finally {
    globalThis.fetch = oldFetch;
    process.env = oldEnv;
  }
});

test("online clip is composed into the final approved-format reel with provenance", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "axys-online-video-"));
  const store = new Store(root);
  const engine = new Engine(store);
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  try {
    process.env.AXYS_VIDEO_WORKER_URL = "https://gpu.example.test";
    process.env.AXYS_VIDEO_WORKER_TOKEN = "t".repeat(64);
    process.env.AXYS_VIDEO_WORKER_REQUEST_MAX_USD = "0.25";
    process.env.AXYS_VIDEO_WORKER_CAMPAIGN_MAX_USD = "1";
    const fixtureDir = path.join(root, "worker-fixture");
    await mkdir(fixtureDir);
    const clipPath = path.join(fixtureDir, "clip.mp4");
    await command(process.env.FFMPEG_PATH || "ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=704x1280:rate=24",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      clipPath,
    ]);
    const video = await readFile(clipPath);
    const sha = createHash("sha256").update(video).digest("hex");
    let workerCalls = 0;
    globalThis.fetch = async (_url, init) => {
      workerCalls++;
      const request = JSON.parse(String(init?.body));
      const receipt = Buffer.from(
        JSON.stringify({
          requestId: "req-integration",
          model: `Wan-AI/Wan2.2-TI2V-5B@${Wan22ProductionRevision}`,
          seed: request.seed,
          seconds: request.seconds,
          width: 704,
          height: 1280,
          provider: "fixture-nebius",
          costUsd: 0.02,
          costBasis: "runtime-estimate",
        }),
      ).toString("base64url");
      const signature = `sha256=${createHmac(
        "sha256",
        process.env.AXYS_VIDEO_WORKER_TOKEN!,
      )
        .update(`${sha}.${receipt}`)
        .digest("hex")}`;
      return new Response(new Uint8Array(video), {
        headers: {
          "x-axys-video-sha256": sha,
          "x-axys-video-receipt": receipt,
          "x-axys-receipt-signature": signature,
        },
      });
    };
    const source = await sharp({
      create: {
        width: 600,
        height: 600,
        channels: 3,
        background: "#c39159",
      },
    })
      .png()
      .toBuffer();
    const asset = await engine.image("one", source);
    const campaign: Campaign = {
      id: randomUUID(),
      tenantId: "one",
      revision: 1,
      state: "Draft",
      mode: "Reels",
      layout: "editorial",
      reelStyle: "bold",
      brief: "",
      facts: {
        business: "Fixture shop",
        offer: "Weekend offer",
        collection: "Saturday",
        contact: "https://example.com/contact",
        confirmed: true,
        source: "merchant",
        products: [
          {
            id: randomUUID(),
            name: "Fixture product",
            priceMinor: 10000,
            currency: "INR",
            assetId: asset.id,
          },
        ],
      },
    };
    engine.save(campaign);
    const credits = new Credits(store);
    credits.seed("one");
    credits.charge("one", "Reels", `generation:${campaign.id}:1`);
    const chargedBalance = credits.summary("one").balance;
    assert.equal(await engine.generate(campaign, false), false);
    const waiting = engine.get("one", campaign.id);
    assert.equal(waiting.generation?.videoJobs.length, 1);
    assert.equal(await engine.generate(waiting, false), false);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) count FROM video_jobs").get() as any)
        .count,
      1,
    );
    assert.equal(credits.summary("one").balance, chargedBalance);
    await engine.videoQueue.processBatch({ limit: 4 });
    assert.equal(
      await engine.generate(engine.get("one", campaign.id), false),
      true,
    );
    const result = engine.get("one", campaign.id);
    assert.equal(result.state, "NeedsReview");
    assert.ok(result.videoAssetId);
    assert.equal(
      (result.trace as any).videoGeneration.receipts[0].requestId,
      "req-integration",
    );
    assert.equal((result.trace as any).videoGeneration.reportedCostUsd, 0.02);
    assert.equal(workerCalls, 1);
    assert.equal(credits.summary("one").balance, chargedBalance);

    const firstJob = result.generation!.videoJobs[0];
    store.db
      .prepare("DELETE FROM video_jobs WHERE tenant=? AND id=?")
      .run("one", firstJob.id);
    delete result.generation;
    delete result.videoAssetId;
    delete result.videoHash;
    delete result.videoPosterId;
    result.state = "Generating";
    engine.save(result);
    assert.equal(await engine.generate(result, false), true);
    const cached = engine.get("one", campaign.id);
    assert.equal(
      engine.videoQueue.get("one", cached.generation!.videoJobs[0].id).state,
      "cached",
    );
    assert.equal(workerCalls, 1);
  } finally {
    globalThis.fetch = oldFetch;
    process.env = oldEnv;
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
