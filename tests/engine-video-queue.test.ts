import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Store } from "../server/store.ts";
import { Engine } from "../server/engine.ts";
import { Credits } from "../server/credits.ts";
import { VideoQueue } from "../services/video/queue.ts";
import { hash, specs, type Campaign } from "../packages/campaign/index.ts";

test("failed child video fails and refunds its planned parent exactly once", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "axys-engine-video-"));
  const store = new Store(root);
  const queue = new VideoQueue(store, async () => {
    throw new Error("provider rejected the video");
  });
  const engine = new Engine(store, undefined, undefined, queue);
  const credits = new Credits(store);
  const previousEnvironment = { ...process.env };
  try {
    process.env.AXYS_VIDEO_WORKER_URL = "https://gpu.example.test";
    process.env.AXYS_VIDEO_WORKER_TOKEN = "t".repeat(64);
    process.env.AXYS_VIDEO_WORKER_REQUEST_MAX_USD = "0.25";
    process.env.AXYS_VIDEO_WORKER_CAMPAIGN_MAX_USD = "1";
    const image = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: "#623412",
      },
    })
      .jpeg()
      .toBuffer();
    const asset = await engine.image("merchant", image);
    const campaign: Campaign = {
      id: randomUUID(),
      tenantId: "merchant",
      revision: 1,
      state: "Generating",
      mode: "Reels",
      layout: "editorial",
      reelStyle: "warm",
      brief: "",
      facts: {
        business: "Failure fixture",
        offer: "Confirmed offer",
        collection: "Today",
        contact: "https://example.com/order",
        confirmed: true,
        source: "merchant",
        products: [
          {
            id: randomUUID(),
            name: "Fixture product",
            priceMinor: 1000,
            currency: "INR",
            assetId: asset.id,
          },
        ],
      },
    };
    const planned = specs(campaign);
    Object.assign(campaign, planned, {
      siteHash: hash(planned.site),
      generation: {
        revision: 1,
        ai: true,
        videoJobs: [],
      },
    });
    engine.save(campaign);
    const initialBalance = credits.seed("merchant").balance;
    credits.charge("merchant", "Reels", `generation:${campaign.id}:1`);
    engine.enqueue(campaign, "generate-ai");

    await engine.tick();
    assert.equal(
      engine.get("merchant", campaign.id).generation!.videoJobs.length,
      1,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      store.db.prepare("UPDATE video_jobs SET available=0").run();
      store.db.prepare("UPDATE jobs SET available=0").run();
      await engine.tick();
    }

    const failed = engine.get("merchant", campaign.id);
    assert.equal(failed.state, "NeedsReview");
    assert.match(failed.error || "", /provider rejected/);
    assert.equal(
      (store.db.prepare("SELECT state FROM video_jobs").get() as any).state,
      "failed",
    );
    assert.equal(
      (store.db.prepare("SELECT state FROM jobs").get() as any).state,
      "failed",
    );
    assert.equal(credits.summary("merchant").balance, initialBalance);
    await engine.tick();
    assert.equal(credits.summary("merchant").balance, initialBalance);
  } finally {
    process.env = previousEnvironment;
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
