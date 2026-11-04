import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import sharp from "sharp";
import { Store } from "../server/store.ts";
import { Engine } from "../server/engine.ts";
import {
  CampaignInput,
  specs,
  hash,
  digest,
  assertConsistent,
  type Campaign,
} from "../packages/campaign/index.ts";
import { encrypt, decrypt } from "../server/security.ts";
import { createApp } from "../server/app.ts";
import { command } from "../packages/renderers/reel.ts";
function fixture() {
  const root = mkdtempSync(path.resolve("var-test-"));
  const store = new Store(root);
  const engine = new Engine(store);
  const c: Campaign = {
    id: randomUUID(),
    tenantId: "one",
    revision: 1,
    state: "Draft",
    mode: "Website",
    layout: "editorial",
    reelStyle: "warm",
    brief: "",
    facts: {
      business: "Test bakery",
      offer: "Weekend collection",
      collection: "24 October 2026, 4–6pm IST",
      contact: "https://example.com/contact",
      confirmed: true,
      source: "merchant",
      products: [
        {
          id: randomUUID(),
          name: "Bread",
          priceMinor: 12500,
          currency: "INR",
          assetId: randomUUID(),
        },
      ],
    },
  };
  const s = specs(c);
  Object.assign(c, s, { siteHash: hash(s.site), state: "NeedsReview" });
  engine.save(c);
  return {
    store,
    engine,
    c,
    root,
    close() {
      store.db.close();
      assert.equal(path.dirname(path.resolve(root)), path.resolve("."));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("prices and collection propagate across typed site, reel and caption", () => {
  const f = fixture();
  try {
    f.c.facts.products[0].priceMinor = 12900;
    f.c.facts.collection = "25 October 2026, 5pm";
    const result = specs(f.c);
    assert.equal(result.site.facts.products[0].priceMinor, 12900);
    assert.match(result.reel.caption, /INR 129.00/);
    assert.match(result.reel.shots[0].text, /25 October 2026/);
  } finally {
    f.close();
  }
});
test("stale preview and changed price reject approval", () => {
  const f = fixture();
  try {
    const when = new Date().toISOString(),
      d = digest(f.c, "", when);
    f.c.revision++;
    assert.throws(() => f.engine.approval(f.c, "", when, d), /stale/);
    const damaged = structuredClone(f.c);
    damaged.site!.facts.products[0].priceMinor = 2;
    assert.throws(() => assertConsistent(damaged), /facts/);
  } finally {
    f.close();
  }
});
test("duplicate publish enqueues exactly once and persisted site survives reopen", async () => {
  const f = fixture();
  try {
    const when = new Date().toISOString();
    f.engine.approval(f.c, "", when, digest(f.c, "", when));
    f.engine.publish(f.c, f.c.approval!.id);
    f.engine.publish(f.c, f.c.approval!.id);
    assert.equal(
      (f.store.db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n,
      1,
    );
    await f.engine.tick();
    assert.equal(f.engine.get("one", f.c.id).state, "Published");
    assert.ok(f.store.get("site", "public", f.c.id));
    const other = new Store(f.root);
    assert.equal(
      other.get<Campaign>("campaign", "one", f.c.id)?.state,
      "Published",
    );
    other.db.close();
  } finally {
    f.close();
  }
});
test("tenant cannot read another tenant campaign or asset", async () => {
  const f = fixture();
  try {
    assert.throws(() => f.engine.get("two", f.c.id), /not found/);
    const a = await f.engine.asset("one", Buffer.from("private"), "text/plain");
    await assert.rejects(() => f.engine.bytes("two", a.id), /not found/);
  } finally {
    f.close();
  }
});
test("revoked account invalidates execution authority", () => {
  const f = fixture();
  try {
    f.c.mode = "Both";
    f.c.videoHash = "hash";
    f.store.put("connection", "one", "123", {
      active: false,
      expiresAt: Date.now() + 10000,
    });
    assert.throws(() =>
      f.engine.approval(f.c, "123", new Date().toISOString(), "x".repeat(64)),
    );
    assert.throws(() => f.engine.connection("one", "123"), /disconnected/);
  } finally {
    f.close();
  }
});
test("encrypted OAuth secret authenticates ciphertext", () => {
  const key = randomBytes(32).toString("base64"),
    value = encrypt("secret-token", key);
  assert.ok(!value.includes("secret-token"));
  assert.equal(decrypt(value, key), "secret-token");
  assert.throws(() => decrypt(value, randomBytes(32).toString("base64")));
});
test("unconfirmed facts, executable contact URL, excessive products are rejected", () => {
  const f = fixture();
  try {
    assert.equal(
      CampaignInput.safeParse({
        ...f.c,
        facts: { ...f.c.facts, confirmed: false },
      }).success,
      false,
    );
    assert.equal(
      CampaignInput.safeParse({
        ...f.c,
        facts: { ...f.c.facts, contact: "javascript:alert(1)" },
      }).success,
      false,
    );
    assert.equal(
      CampaignInput.safeParse({
        ...f.c,
        facts: { ...f.c.facts, products: Array(7).fill(f.c.facts.products[0]) },
      }).success,
      false,
    );
  } finally {
    f.close();
  }
});
test("real image validation and final H264 vertical render", async () => {
  const f = fixture();
  try {
    const image = await sharp(
      Buffer.from(
        `<svg width="600" height="600"><rect width="600" height="600" fill="#c39159"/><circle cx="170" cy="170" r="120" fill="#263d35"/><rect x="330" y="310" width="210" height="210" fill="#f4ecdf"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const asset = await f.engine.image("one", image);
    f.c.facts.products[0].assetId = asset.id;
    f.c.mode = "Both";
    f.engine.save(f.c);
    await f.engine.generate(f.c, false);
    const result = f.engine.get("one", f.c.id);
    assert.ok(result.videoHash);
    assert.ok(
      (await f.engine.bytes("one", result.videoAssetId!)).length > 10000,
    );
    const probe = f.store.get<any>("probe", "one", result.videoAssetId!);
    assert.equal(
      probe.streams.find((s: any) => s.codec_type === "video").width,
      1080,
    );
    const frameHashes = await command(process.env.FFMPEG_PATH || "ffmpeg", [
      "-i",
      path.join(f.root, "objects", "one", result.videoHash!),
      "-vf",
      "fps=1",
      "-f",
      "framemd5",
      "-",
    ]);
    assert.ok(
      new Set(
        frameHashes
          .split("\n")
          .filter((line) => line && !line.startsWith("#"))
          .map((line) => line.split(",").at(-1)?.trim()),
      ).size > 1,
      "rendered reel must contain real frame-to-frame motion",
    );
    await assert.rejects(() =>
      f.engine.image("one", Buffer.from("<script>bad</script>")),
    );
  } finally {
    f.close();
  }
});
test("ambiguous Instagram POST is persisted and never automatically reissued", async () => {
  const f = fixture();
  const old = { ...process.env };
  try {
    process.env.AXYS_ALLOW_PUBLIC_POSTING = "true";
    process.env.AXYS_TOKEN_KEY = randomBytes(32).toString("base64");
    let calls = 0;
    f.c.mode = "Both";
    const video = await f.engine.asset(
      "one",
      Buffer.from("test-fixture-video"),
      "video/mp4",
    );
    f.c.videoHash = video.hash;
    f.c.videoAssetId = video.id;
    const when = new Date().toISOString();
    f.store.put("connection", "one", "123", {
      active: true,
      expiresAt: Date.now() + 100000,
      accountId: "123",
      token: encrypt("test", process.env.AXYS_TOKEN_KEY),
    });
    f.engine.approval(f.c, "123", when, digest(f.c, "123", when));
    f.c.attempt = {
      id: randomUUID(),
      site: "Published",
      social: "Processing",
      containerId: "456",
    };
    f.engine.save(f.c);
    f.engine.metaFactory = () =>
      ({
        status: async () => ({ status_code: "FINISHED" }),
        publish: async () => {
          calls++;
          throw new Error("timeout");
        },
      }) as any;
    await assert.rejects(() => f.engine.publishStep(f.c), /timeout/);
    const recovered = f.engine.get("one", f.c.id);
    assert.equal(recovered.attempt!.publishSent, true);
    await f.engine.publishStep(recovered);
    assert.equal(calls, 1);
    assert.equal(f.engine.get("one", f.c.id).attempt!.social, "Unknown");
  } finally {
    process.env = old;
    f.close();
  }
});
test("HTTP authorization, origin enforcement, unknown metrics and isolation", async () => {
  const f = fixture();
  const { app } = createApp(f.store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const port = (server.address() as any).port,
    base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + "/api/v1/campaigns")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/v1/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "local-demo" }),
        })
      ).status,
      403,
    );
    const login = await fetch(base + "/api/v1/session", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:4310",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: "local-demo" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(login.status, 200);
    const result = await fetch(base + `/api/v1/campaigns/${f.c.id}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(result.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});

test("scheduled publication requires expiry and rejects expired offers", () => {
  const f = fixture();
  try {
    const future = new Date(Date.now() + 3600000).toISOString();
    assert.throws(
      () => f.engine.approval(f.c, "", future, digest(f.c, "", future)),
      /expiry/,
    );
    f.c.facts.validUntil = new Date(Date.now() - 1000).toISOString();
    const next = specs(f.c);
    Object.assign(f.c, next, { siteHash: hash(next.site) });
    const now = new Date().toISOString();
    assert.throws(
      () => f.engine.approval(f.c, "", now, digest(f.c, "", now)),
      /expires/,
    );
  } finally {
    f.close();
  }
});
test("late provider receipt never restores a disconnected approval", () => {
  const f = fixture();
  try {
    const now = new Date().toISOString();
    f.engine.approval(f.c, "", now, digest(f.c, "", now));
    const inflight = structuredClone(f.c);
    delete f.c.approval;
    f.c.state = "NeedsReview";
    f.engine.save(f.c);
    inflight.attempt = {
      id: randomUUID(),
      site: "Published",
      social: "Processing",
      containerId: "123",
    };
    f.engine.saveAttempt(inflight);
    const current = f.engine.get("one", f.c.id);
    assert.equal(current.approval, undefined);
    assert.equal(current.state, "NeedsReview");
    assert.equal(current.attempt?.containerId, "123");
  } finally {
    f.close();
  }
});
test("site success and blocked social action is PartialFailure", async () => {
  const f = fixture();
  try {
    const a = await f.engine.asset("one", Buffer.from("fixture"), "video/mp4");
    f.c.mode = "Both";
    f.c.videoHash = a.hash;
    f.c.videoAssetId = a.id;
    f.store.put("connection", "one", "123", {
      active: true,
      expiresAt: Date.now() + 100000,
      accountId: "123",
    });
    const now = new Date().toISOString();
    f.engine.approval(f.c, "123", now, digest(f.c, "123", now));
    f.engine.publish(f.c, f.c.approval!.id);
    await f.engine.tick();
    const c = f.engine.get("one", f.c.id);
    assert.equal(c.state, "PartialFailure");
    assert.equal(c.attempt?.site, "Published");
    assert.notEqual(c.attempt?.social, "Published");
  } finally {
    f.close();
  }
});
test("expired job lease recovers after worker interruption", async () => {
  const f = fixture();
  try {
    const now = new Date().toISOString();
    f.engine.approval(f.c, "", now, digest(f.c, "", now));
    f.engine.publish(f.c, f.c.approval!.id);
    f.store.db.prepare("UPDATE jobs SET state='running',lease=0").run();
    await f.engine.tick();
    assert.equal(f.engine.get("one", f.c.id).state, "Published");
    assert.equal(
      (f.store.db.prepare("SELECT COUNT(*) n FROM publications").get() as any)
        .n,
      1,
    );
  } finally {
    f.close();
  }
});

test("tenant deletion requires exact confirmation and preserves global spend totals", async () => {
  const f = fixture();
  const { app } = createApp(f.store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const headers = {
      Origin: "http://127.0.0.1:4310",
      "Content-Type": "application/json",
    };
    const login = await fetch(base + "/api/v1/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "local-demo" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const a = await f.engine.asset(
      "local-demo",
      Buffer.from("erase-test"),
      "text/plain",
    );
    f.store.db
      .prepare("INSERT INTO spend(id,tenant,campaign,reserved) VALUES(?,?,?,?)")
      .run(randomUUID(), "local-demo", "test", 0.1);
    const denied = await fetch(base + "/api/v1/tenant", {
      method: "DELETE",
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify({ confirmation: "one" }),
    });
    assert.equal(denied.status, 409);
    assert.ok(f.store.get("asset", "local-demo", a.id));
    const done = await fetch(base + "/api/v1/tenant", {
      method: "DELETE",
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify({ confirmation: "local-demo" }),
    });
    assert.equal(done.status, 200);
    assert.equal(f.store.get("asset", "local-demo", a.id), undefined);
    assert.equal(
      (f.store.db.prepare("SELECT SUM(reserved) n FROM spend").get() as any).n,
      0.1,
    );
    assert.ok(f.store.get("campaign", "one", f.c.id));
    assert.equal(
      (await fetch(base + "/api/v1/campaigns", { headers: { Cookie: cookie } }))
        .status,
      401,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
