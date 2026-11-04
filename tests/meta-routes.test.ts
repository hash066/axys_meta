import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { MuseGateway, resetMuseStatusCache } from "../packages/meta/gateway.ts";
import { usableMedia } from "../packages/meta/enrichment.ts";
import { command } from "../packages/renderers/reel.ts";
import { startFakeGateway, type FakeOptions } from "./fake-gateway.ts";

const ORIGIN = "http://127.0.0.1:4310";
const TENANT = "local-demo";

async function harness(options: FakeOptions = {}) {
  resetMuseStatusCache();
  const root = mkdtempSync(path.resolve("var-test-"));
  const store = new Store(root);
  const fake = await startFakeGateway(options);
  const { app, engine } = createApp(store, {
    gateway: new MuseGateway({ baseUrl: fake.url }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const login = await fetch(base + "/api/v1/session", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "local-demo" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const call = (
    method: string,
    url: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(base + url, {
      method,
      headers: {
        Origin: ORIGIN,
        Cookie: cookie,
        ...(body !== undefined && !Buffer.isBuffer(body)
          ? { "Content-Type": "application/json" }
          : {}),
        ...extra,
      },
      body:
        body === undefined
          ? undefined
          : Buffer.isBuffer(body)
            ? new Uint8Array(body)
            : JSON.stringify(body),
    });
  const upload = async (color: string) => {
    const img = await sharp(
      Buffer.from(
        `<svg width="600" height="600"><rect width="600" height="600" fill="#c39159"/><circle cx="300" cy="300" r="150" fill="${color}"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const r = await call("POST", "/api/v1/assets", img, {
      "Content-Type": "image/png",
      "x-asset-rights": "confirmed",
    });
    assert.equal(r.status, 201);
    return (await r.json()).data.id as string;
  };
  const newCampaign = async (
    mode: "Website" | "Both",
    names: [string, number][] = [["Bread", 12500]],
  ) => {
    const products = [];
    for (const [i, [name, priceMinor]] of names.entries())
      products.push({
        id: crypto.randomUUID(),
        name,
        priceMinor,
        currency: "INR",
        assetId: await upload(["#263d35", "#7a2d2d", "#2d4a7a"][i]),
      });
    const input = {
      facts: {
        business: "Test bakery",
        offer: "Weekend collection",
        collection: "24 October 2026, 4-6pm IST",
        contact: "https://example.com/contact",
        confirmed: true,
        source: "merchant",
        products,
      },
      mode,
      layout: "editorial",
      reelStyle: "warm",
      brief: "",
    };
    const r = await call("POST", "/api/v1/campaigns", input);
    assert.equal(r.status, 201);
    return { input, campaign: (await r.json()).data };
  };
  return {
    root,
    store,
    engine,
    fake,
    base,
    call,
    newCampaign,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await fake.close();
      store.db.close();
      assert.equal(path.dirname(path.resolve(root)), path.resolve("."));
      rmSync(root, { recursive: true, force: true });
      resetMuseStatusCache();
    },
  };
}

test("enrich persists SAM cutouts and Muse Image shots, then the reel and site really use them", async () => {
  const h = await harness();
  try {
    const { campaign } = await h.newCampaign("Both", [
      ["Bread", 12500],
      ["Cake", 30000],
    ]);
    assert.equal(
      (await h.call("GET", `/api/v1/campaigns/${campaign.id}/enrichment`))
        .status,
      404,
    );
    assert.equal(
      (await h.call("POST", `/api/v1/campaigns/${campaign.id}/enrich?scenes=3`))
        .status,
      422,
    );
    const r = await h.call("POST", `/api/v1/campaigns/${campaign.id}/enrich`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.data, {
      campaignId: body.campaignId,
      products: body.products,
      heroes: body.heroes,
      models: body.models,
      generatedAt: body.generatedAt,
      warnings: body.warnings,
    });
    assert.equal(body.campaignId, campaign.id);
    assert.deepEqual(body.models, [
      "sam-3.1",
      "muse-image-1.0",
      "muse-spark-1.3",
    ]);
    assert.equal(body.products.length, 2);
    const [bread, cake] = body.products;
    assert.equal(bread.concept, "Bread");
    assert.equal(cake.concept, "Cake");
    assert.equal(bread.found, true);
    assert.deepEqual(bread.bbox, [100, 100, 300, 300]);
    assert.equal(body.heroes.length, 1, "one scene, first product only");
    assert.equal(body.heroes[0].productId, bread.productId);
    assert.equal(body.heroes[0].faithful, true);
    // Assets are stored in the tenant and are PNGs.
    for (const id of [
      bread.overlayAssetId,
      bread.cutoutAssetId,
      body.heroes[0].assetId,
    ]) {
      const a = await h.call("GET", `/api/v1/assets/${id}`);
      assert.equal(a.status, 200);
      assert.equal(a.headers.get("content-type"), "image/png");
    }
    assert.equal(
      h.fake.calls.filter((c) => c.route === "/v1/segment").length,
      2,
    );
    assert.equal(h.fake.calls.filter((c) => c.route === "/v1/scene").length, 1);
    const again = await (
      await h.call("GET", `/api/v1/campaigns/${campaign.id}/enrichment`)
    ).json();
    assert.equal(again.generatedAt, body.generatedAt);

    // Rendering: site hero is the faithful Muse Image shot; reel shots use cutouts.
    const c = h.engine.get(TENANT, campaign.id);
    await h.engine.generate(c, false);
    const done = h.engine.get(TENANT, campaign.id);
    assert.equal(done.site!.hero!.kind, "scene");
    assert.equal(done.site!.hero!.assetId, body.heroes[0].assetId);
    const dir = path.join(h.root, "renders", TENANT, campaign.id, "1");
    assert.ok(existsSync(path.join(dir, "cutout-0.png")));
    assert.ok(existsSync(path.join(dir, "cutout-1.png")));
    assert.equal(existsSync(path.join(dir, "photo-0.png")), false);
    const probe = h.store.get<any>("probe", TENANT, done.videoAssetId!);
    assert.equal(
      probe.streams.find((s: any) => s.codec_type === "video").height,
      1920,
    );
    // The cutout (red) is actually composited at the centre of the product area.
    const frame = path.join(dir, "check.png");
    await command(process.env.FFMPEG_PATH || "ffmpeg", [
      "-y",
      "-ss",
      "1.6",
      "-i",
      path.join(h.root, "objects", TENANT, done.videoHash!),
      "-frames:v",
      "1",
      frame,
    ]);
    const px = await sharp(frame)
      .extract({ left: 540, top: 515, width: 1, height: 1 })
      .raw()
      .toBuffer();
    assert.ok(
      px[0] > 150 && px[1] < 90 && px[2] < 90,
      `centre pixel ${[...px]}`,
    );

    // Enrichment from a different source photo is ignored (stale protection).
    const swapped = h.engine.get(TENANT, campaign.id);
    swapped.facts.products[0].assetId = swapped.facts.products[1].assetId;
    assert.equal(
      usableMedia(h.store, swapped).cutouts.has(bread.productId),
      false,
    );
    assert.equal(
      usableMedia(h.store, swapped).cutouts.has(cake.productId),
      true,
    );
  } finally {
    await h.close();
  }
});

test("without enrichment rendering is the baseline, and unfaithful scenes fall back to the cutout hero", async () => {
  const h = await harness({ faithful: false });
  try {
    const plain = (await h.newCampaign("Both")).campaign;
    await h.engine.generate(h.engine.get(TENANT, plain.id), false);
    const baseline = h.engine.get(TENANT, plain.id);
    assert.equal(baseline.site!.hero, undefined);
    assert.equal("hero" in baseline.site!, false);
    const dir = path.join(h.root, "renders", TENANT, plain.id, "1");
    assert.ok(existsSync(path.join(dir, "photo-0.png")));

    const other = (await h.newCampaign("Website")).campaign;
    const body = await (
      await h.call("POST", `/api/v1/campaigns/${other.id}/enrich`)
    ).json();
    assert.equal(body.heroes[0].faithful, false);
    assert.deepEqual(body.heroes[0].differences, ["label differs"]);
    await h.engine.generate(h.engine.get(TENANT, other.id), false);
    const hero = h.engine.get(TENANT, other.id).site!.hero!;
    assert.equal(hero.kind, "cutout");
    assert.equal(hero.assetId, body.products[0].cutoutAssetId);
  } finally {
    await h.close();
  }
});

test("a scene failure keeps SAM results and says so; no key gives a clear 503", async () => {
  const h = await harness({ failScene: true });
  try {
    const { campaign } = await h.newCampaign("Website");
    const body = await (
      await h.call("POST", `/api/v1/campaigns/${campaign.id}/enrich`)
    ).json();
    assert.equal(body.products[0].found, true);
    assert.equal(body.heroes.length, 0);
    assert.match(body.warnings[0], /Studio shot 1 unavailable/);
    h.fake.state.keyConfigured = false;
    const r = await h.call("POST", `/api/v1/campaigns/${campaign.id}/enrich`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, "muse_no_key");
  } finally {
    await h.close();
  }
});

test("published site serves the hero image and includes it in the page", async () => {
  const h = await harness();
  try {
    const { campaign } = await h.newCampaign("Website");
    const e = await (
      await h.call("POST", `/api/v1/campaigns/${campaign.id}/enrich?scenes=1`)
    ).json();
    await h.engine.generate(h.engine.get(TENANT, campaign.id), false);
    const c = h.engine.get(TENANT, campaign.id);
    const schedule = new Date().toISOString();
    const digest = await (
      await h.call("POST", `/api/v1/campaigns/${c.id}/preview-digest`, {
        revision: c.revision,
        siteHash: c.siteHash,
        videoHash: c.videoHash,
        accountId: "",
        schedule,
      })
    ).json();
    const approved = await h.call("POST", `/api/v1/campaigns/${c.id}/approve`, {
      digest: digest.data.digest,
      accountId: "",
      schedule,
    });
    assert.equal(approved.status, 200, "clean preflight allows approval");
    const approval = (await approved.json()).data.approval;
    await h.call("POST", `/api/v1/campaigns/${c.id}/publish`, {
      approvalId: approval.id,
    });
    await h.engine.tick();
    const page = await fetch(`${h.base}/sites/${c.id}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /class="site-hero-media"/);
    const img = await fetch(
      `${h.base}/sites/${c.id}/images/${e.heroes[0].assetId}`,
    );
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    // Unrelated assets (e.g. the SAM overlay) are not publicly served.
    const other = await fetch(
      `${h.base}/sites/${c.id}/images/${e.products[0].overlayAssetId}`,
    );
    assert.equal(other.status, 404);
  } finally {
    await h.close();
  }
});

test("stale price: edit after generation without regenerating is caught by preflight and blocks approval", async () => {
  const h = await harness({
    json: () => ({ issues: [] }),
  });
  try {
    const { input, campaign } = await h.newCampaign("Website");
    await h.engine.generate(h.engine.get(TENANT, campaign.id), false);
    const generated = h.engine.get(TENANT, campaign.id);

    const clean = await (
      await h.call("POST", `/api/v1/campaigns/${campaign.id}/preflight`, {})
    ).json();
    assert.equal(clean.ok, true);
    assert.equal(clean.model, "muse-wonder-1.0");
    assert.deepEqual(clean.issues, []);
    assert.equal(clean.campaignId, campaign.id);

    // Manual demo step: change the price, keep the old site/reel.
    const edited = structuredClone(input) as any;
    edited.facts.products[0].priceMinor = 12900;
    const put = await h.call(
      "PUT",
      `/api/v1/campaigns/${campaign.id}?keepGenerated=true`,
      { ...edited, revision: generated.revision },
    );
    assert.equal(put.status, 200);
    const kept = (await put.json()).data;
    assert.equal(kept.revision, generated.revision + 1);
    assert.ok(kept.site && kept.reel, "generated artifacts are kept for audit");

    const bad = await (
      await h.call("POST", `/api/v1/campaigns/${campaign.id}/preflight`, {})
    ).json();
    assert.equal(bad.ok, false);
    const price = bad.issues.find(
      (i: any) => i.severity === "block" && i.surface === "site",
    );
    assert.equal(price.expected, "INR 129.00");
    assert.equal(price.found, "INR 125.00");
    assert.ok(bad.issues.some((i: any) => i.surface === "caption"));
    assert.ok(bad.issues.some((i: any) => i.surface === "reel"));

    const refused = await h.call(
      "POST",
      `/api/v1/campaigns/${campaign.id}/approve`,
      {
        digest: "a".repeat(64),
        accountId: "",
        schedule: new Date().toISOString(),
      },
    );
    assert.equal(refused.status, 409);
    const err = (await refused.json()).error;
    assert.equal(err.code, "preflight_blocked");
    assert.ok(err.issues.length >= 3);

    // Even with no stored preflight the exact rules still guard approval.
    h.store.del("preflight", TENANT, campaign.id);
    assert.equal(
      (
        await (
          await h.call("POST", `/api/v1/campaigns/${campaign.id}/approve`, {
            digest: "a".repeat(64),
            accountId: "",
            schedule: new Date().toISOString(),
          })
        ).json()
      ).error.code,
      "preflight_blocked",
    );

    // Regenerate; preflight re-run clears the block.
    const gen = await h.call(
      "POST",
      `/api/v1/campaigns/${campaign.id}/generate`,
      {
        mode: "manual",
      },
    );
    assert.equal(gen.status, 202);
    for (let i = 0; i < 20; i++) {
      await h.engine.tick();
      if (h.engine.get(TENANT, campaign.id).state !== "Generating") break;
    }
    const fresh = await (
      await h.call("POST", `/api/v1/campaigns/${campaign.id}/preflight`, {})
    ).json();
    assert.equal(fresh.ok, true);
    const stored = await (
      await h.call("GET", `/api/v1/campaigns/${campaign.id}/preflight`)
    ).json();
    assert.equal(stored.current, true);
    assert.equal(stored.ok, true);
  } finally {
    await h.close();
  }
});

test("voice transcription: auth, size and format limits, and transcript feeds preflight", async () => {
  const h = await harness({
    transcript: "The bread is 140 rupees this weekend.",
  });
  try {
    const pcm = Buffer.alloc(32000);
    const noAuth = await fetch(h.base + "/api/v1/voice/transcribe", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(pcm),
    });
    assert.equal(noAuth.status, 401);
    const ok = await h.call("POST", "/api/v1/voice/transcribe", pcm, {
      "Content-Type": "application/octet-stream",
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.transcript, "The bread is 140 rupees this weekend.");
    assert.equal(body.data.transcript, body.transcript);
    assert.equal(h.fake.calls.at(-1)!.body.bytes, 32000);
    for (const [bad, type] of [
      [Buffer.alloc(100), "application/octet-stream"],
      [Buffer.alloc(32001), "application/octet-stream"],
      [pcm, "audio/mpeg"],
    ] as const)
      assert.equal(
        (
          await h.call("POST", "/api/v1/voice/transcribe", bad, {
            "Content-Type": type,
          })
        ).status,
        409,
      );
    const tooLong = await h.call(
      "POST",
      "/api/v1/voice/transcribe",
      Buffer.alloc(60 * 16000 * 2 + 2),
      { "Content-Type": "application/octet-stream" },
    );
    assert.equal(tooLong.status, 413);
    assert.equal(
      (
        await h.call(
          "POST",
          "/api/v1/voice/transcribe?campaignId=" + crypto.randomUUID(),
          pcm,
          { "Content-Type": "application/octet-stream" },
        )
      ).status,
      404,
    );

    const { campaign } = await h.newCampaign("Website");
    await h.engine.generate(h.engine.get(TENANT, campaign.id), false);
    await h.call(
      "POST",
      `/api/v1/voice/transcribe?campaignId=${campaign.id}`,
      pcm,
      { "Content-Type": "application/octet-stream" },
    );
    const pre = await (
      await h.call("POST", `/api/v1/campaigns/${campaign.id}/preflight`, {})
    ).json();
    const voice = pre.issues.filter((i: any) => i.surface === "voice");
    assert.equal(voice.length, 1);
    assert.equal(voice[0].severity, "block");
    assert.equal(voice[0].expected, "INR 125.00");
    assert.equal(voice[0].found, "INR 140.00");
    assert.equal(pre.ok, false);
    // Wrong body shape is rejected before any model call.
    assert.equal(
      (
        await h.call("POST", `/api/v1/campaigns/${campaign.id}/preflight`, {
          extra: 1,
        })
      ).status,
      422,
    );
  } finally {
    await h.close();
  }
});

test("capabilities and public-config report the Meta gateway; no NEBIUS_* env is needed", async () => {
  // Hermetic: the app must work with every NEBIUS_* variable absent.
  for (const name of Object.keys(process.env))
    if (name.startsWith("NEBIUS_")) delete process.env[name];
  const h = await harness({ keyConfigured: false });
  try {
    const caps = (await (await h.call("GET", "/api/v1/capabilities")).json())
      .data;
    assert.equal(caps.nebius, undefined);
    assert.equal(caps.muse.reachable, true);
    assert.equal(caps.muse.available, false);
    assert.equal(caps.muse.keyConfigured, false);
    resetMuseStatusCache();
    h.fake.state.keyConfigured = true;
    const pub = (await (await fetch(h.base + "/api/v1/public-config")).json())
      .data;
    assert.equal(pub.muse.available, true);
    assert.equal(pub.muse.models.wonder, "muse-wonder-1.0");
    await h.fake.close();
    resetMuseStatusCache();
    const down = (await (await h.call("GET", "/api/v1/capabilities")).json())
      .data;
    assert.equal(down.muse.available, false);
    assert.equal(down.muse.reachable, false);
    const t = await h.call(
      "POST",
      "/api/v1/voice/transcribe",
      Buffer.alloc(3200),
      {
        "Content-Type": "application/octet-stream",
      },
    );
    assert.equal(t.status, 503);
    assert.equal((await t.json()).error.code, "muse_unavailable");
  } finally {
    await h.close().catch(() => undefined);
  }
});

test("AI generation plans with Muse Wonder and rejects a changed offer", async () => {
  const h = await harness();
  try {
    const { campaign } = await h.newCampaign("Website");
    const c = h.engine.get(TENANT, campaign.id);
    h.fake.state.json = (body: any) => {
      assert.equal(body.model, "wonder");
      return {
        headline: c.facts.offer,
        suggestion: "Render the confirmed offer.",
        questions: [],
        tool: "render",
        layout: "catalog",
        reelStyle: "bold",
        productOrder: [c.facts.products[0].id],
      };
    };
    const gen = await h.call(
      "POST",
      `/api/v1/campaigns/${campaign.id}/generate`,
      {
        mode: "muse",
      },
    );
    assert.equal(gen.status, 202);
    for (let i = 0; i < 20; i++) {
      await h.engine.tick();
      if (h.engine.get(TENANT, campaign.id).state !== "Generating") break;
    }
    const done = h.engine.get(TENANT, campaign.id);
    assert.equal(done.state, "NeedsReview");
    assert.equal(done.layout, "catalog");
    assert.equal((done.trace as any).model, "muse-wonder-1.0");

    const second = (await h.newCampaign("Website")).campaign;
    h.fake.state.json = () => ({
      headline: "50% off everything!",
      suggestion: "x",
      questions: [],
      tool: "render",
    });
    await h.call("POST", `/api/v1/campaigns/${second.id}/generate`, {
      mode: "muse",
    });
    for (let i = 0; i < 3; i++) await h.engine.tick();
    const failed = h.engine.get(TENANT, second.id);
    assert.equal(failed.state, "NeedsReview");
    assert.match(failed.error!, /changed the confirmed offer/);
  } finally {
    await h.close();
  }
});
