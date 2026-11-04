import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { Engine } from "../server/engine.ts";
import { createApp } from "../server/app.ts";
import { Meta } from "../services/publishing/meta.ts";
import { encrypt } from "../server/security.ts";
import { MuseGateway, resetMuseStatusCache } from "../packages/meta/gateway.ts";
import {
  specs,
  hash,
  digest,
  type Campaign,
} from "../packages/campaign/index.ts";
import { startFakeGateway } from "./fake-gateway.ts";

/**
 * The publish -> receipt -> insights -> revision loop, run through the real Instagram adapter
 * (services/publishing/meta.ts) against a LOCAL fake of the Instagram Graph API.
 * This proves our request building, state machine and feedback wiring. It does not prove that
 * Instagram accepts our app, account or media URL: that needs a real, authorised account.
 */
const ORIGIN = "https://axys.example.com"; // must equal AXYS_ORIGIN set inside the test

function fakeGraph() {
  const calls: { method: string; url: URL; body: URLSearchParams | null; auth: string | null }[] = [];
  let polls = 0;
  const realFetch = globalThis.fetch;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const patched: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "graph.instagram.com") return realFetch(input as any, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    calls.push({ method, url, body, auth: headers.get("authorization") });
    const p = url.pathname.replace(/^\/v\d+\.0\//, "");
    if (method === "POST" && p === "123/media") return json({ id: "456" });
    if (method === "GET" && p === "456")
      return json({ status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" });
    if (method === "POST" && p === "123/media_publish") return json({ id: "789" });
    if (method === "GET" && p === "789")
      return json({ id: "789", permalink: "https://www.instagram.com/reel/TESTREEL/", timestamp: "2026-11-04T10:00:00+0000" });
    if (method === "GET" && p === "789/insights")
      return json({
        data: [
          { name: "reach", values: [{ value: 420 }] },
          { name: "likes", values: [{ value: 37 }] },
        ],
      });
    return json({ error: { code: 100, message: "unexpected" } }, 400);
  };
  return {
    calls,
    install() {
      globalThis.fetch = patched;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

test("publish, receipt, insights and a grounded revision proposal run end to end against a fake Instagram", async () => {
  const old = { ...process.env };
  const root = mkdtempSync(path.resolve("var-test-"));
  const store = new Store(root);
  const graph = fakeGraph();
  const fake = await startFakeGateway({
    json: () => ({
      headline: "Weekend studio sale",
      suggestion: "Reach was 420 with 37 likes; try leading the reel with the product close-up.",
      questions: [],
      tool: "propose_revision",
    }),
  });
  try {
    Object.assign(process.env, {
      META_API_VERSION: "v23.0",
      META_INSIGHT_METRICS: "reach,likes",
      AXYS_TOKEN_KEY: randomBytes(32).toString("base64"),
      AXYS_MEDIA_KEY: randomBytes(32).toString("base64"),
      AXYS_ORIGIN: "https://axys.example.com",
      AXYS_ALLOW_PUBLIC_POSTING: "true",
    });
    resetMuseStatusCache();
    const engine = new Engine(store);
    const c: Campaign = {
      id: randomUUID(),
      tenantId: "local-demo",
      revision: 1,
      state: "Draft",
      mode: "Both",
      layout: "editorial",
      reelStyle: "warm",
      brief: "",
      facts: {
        business: "Clay & Co",
        offer: "Weekend studio sale",
        collection: "Saturday 7 November 2026, 10am-4pm",
        contact: "https://example.com/clayandco",
        validUntil: new Date(Date.now() + 5 * 86400000).toISOString(),
        confirmed: true,
        source: "merchant",
        products: [
          { id: randomUUID(), name: "Ceramic mug", priceMinor: 12900, currency: "INR", assetId: randomUUID() },
        ],
      },
    };
    const s = specs(c);
    Object.assign(c, s, { siteHash: hash(s.site), state: "NeedsReview" });
    const video = await engine.asset("local-demo", Buffer.from("fixture-video-bytes"), "video/mp4");
    c.videoHash = video.hash;
    c.videoAssetId = video.id;
    engine.save(c);

    store.put("connection", "local-demo", "123", {
      active: true,
      expiresAt: Date.now() + 1e8,
      accountId: "123",
      token: encrypt("test-token", process.env.AXYS_TOKEN_KEY!),
    });

    graph.install();
    engine.metaFactory = (token: string) => new Meta(token);
    const when = new Date().toISOString();
    engine.approval(c, "123", when, digest(c, "123", when));
    engine.publish(engine.get("local-demo", c.id), c.approval!.id);

    let state = "";
    for (let i = 0; i < 40 && state !== "Published"; i++) {
      // Production polls Instagram once a minute between steps; fast-forward that wait.
      store.db.prepare("UPDATE jobs SET available=0 WHERE state='queued'").run();
      await engine.tick();
      state = engine.get("local-demo", c.id).state;
      if (state !== "Published") await new Promise((r) => setTimeout(r, 120));
    }
    const done = engine.get("local-demo", c.id);
    assert.equal(done.state, "Published", `state was ${done.state}: ${done.attempt?.error ?? done.error ?? ""}`);
    assert.equal(done.attempt!.mediaId, "789");
    assert.equal(done.attempt!.permalink, "https://www.instagram.com/reel/TESTREEL/");

    // The adapter built the right Graph requests.
    const create = graph.calls.find((x) => x.method === "POST" && x.url.pathname.endsWith("/123/media"))!;
    assert.equal(create.auth, "Bearer test-token");
    assert.equal(create.body!.get("media_type"), "REELS");
    assert.equal(create.body!.get("caption"), c.reel!.caption);
    const videoUrl = new URL(create.body!.get("video_url")!);
    assert.equal(videoUrl.origin, "https://axys.example.com");
    assert.match(videoUrl.pathname, new RegExp(`/media/${video.id}$`));
    assert.ok(videoUrl.searchParams.get("sig") && videoUrl.searchParams.get("expires"));
    const pub = graph.calls.filter((x) => x.url.pathname.endsWith("/123/media_publish"));
    assert.equal(pub.length, 1, "exactly one media_publish call");
    assert.equal(pub[0].body!.get("creation_id"), "456");

    // Feedback loop over HTTP: pull insights, then ask for a grounded revision.
    const { app } = createApp(store, { gateway: new MuseGateway({ baseUrl: fake.url }) });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const login = await fetch(base + "/api/v1/session", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "local-demo" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const call = (method: string, url: string) =>
        fetch(base + url, { method, headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });

      const before = (await (await call("GET", `/api/v1/campaigns/${c.id}/metrics`)).json()).data;
      assert.equal(before.instagram.value, null, "no insights are claimed before they are fetched");

      const m = await call("POST", `/api/v1/campaigns/${c.id}/metrics`);
      assert.equal(m.status, 200);
      const metrics = (await m.json()).data;
      assert.equal(metrics.instagram.source, "Instagram");
      assert.equal(metrics.instagram.data.data[0].values[0].value, 420);
      const ask = graph.calls.find((x) => x.url.pathname.endsWith("/789/insights"))!;
      assert.equal(ask.url.searchParams.get("metric"), "reach,likes");

      const rev = await call("POST", `/api/v1/campaigns/${c.id}/revision`);
      assert.equal(rev.status, 200);
      const proposal = (await rev.json()).data.proposal;
      assert.equal(proposal.tool, "propose_revision");
      assert.match(proposal.suggestion, /420/);
      // A proposal is only a proposal: nothing was republished.
      assert.equal(graph.calls.filter((x) => x.url.pathname.endsWith("/123/media_publish")).length, 1);
      assert.equal(engine.get("local-demo", c.id).revision, 1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    graph.restore();
    await fake.close();
    store.db.close();
    process.env = old;
    resetMuseStatusCache();
    rmSync(root, { recursive: true, force: true });
  }
});
