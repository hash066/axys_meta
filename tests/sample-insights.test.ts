import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { MuseGateway, resetMuseStatusCache } from "../packages/meta/gateway.ts";
import { normalizeObservations } from "../packages/meta/feedback.ts";
import { sampleInstagramRecord, sampleWebsiteRows } from "../server/sample-insights.ts";
import { startFakeGateway, type FakeOptions } from "./fake-gateway.ts";

const ORIGIN = "http://127.0.0.1:4310";

async function harness(options: FakeOptions = {}) {
  resetMuseStatusCache();
  const root = mkdtempSync(path.resolve("var-test-"));
  const store = new Store(root);
  const fake = await startFakeGateway(options);
  const { app, engine } = createApp(store, { gateway: new MuseGateway({ baseUrl: fake.url }) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const login = await fetch(base + "/api/v1/session", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "local-demo" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const call = (method: string, url: string, body?: unknown) =>
    fetch(base + url, {
      method,
      headers: {
        Origin: ORIGIN,
        Cookie: cookie,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // A campaign record is enough for the metrics and revision routes.
  const id = crypto.randomUUID();
  const campaign = {
    id,
    tenantId: "local-demo",
    revision: 1,
    state: "Published",
    mode: "Reels",
    layout: "editorial",
    reelStyle: "warm",
    brief: "",
    facts: {
      business: "Stride Lane",
      offer: "Weekend drop",
      collection: "Saturday, Nov 7, 10am to 4pm ET",
      contact: "https://stridelane.example/order",
      confirmed: true,
      source: "merchant",
      products: [
        { id: crypto.randomUUID(), name: "White sneaker", priceMinor: 8900, currency: "USD", assetId: crypto.randomUUID() },
      ],
    },
  };
  engine.save(campaign as never);
  return {
    store,
    fake,
    id,
    call,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await fake.close();
      store.db.close();
      rmSync(root, { recursive: true, force: true });
      resetMuseStatusCache();
    },
  };
}

async function withDemo<T>(on: boolean, fn: () => Promise<T>) {
  const before = process.env.AXYS_DEMO_SAMPLES;
  if (on) process.env.AXYS_DEMO_SAMPLES = "true";
  else delete process.env.AXYS_DEMO_SAMPLES;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.AXYS_DEMO_SAMPLES;
    else process.env.AXYS_DEMO_SAMPLES = before;
  }
}

test("without AXYS_DEMO_SAMPLES=true the sample route answers 404 and capabilities says demoSamples:false", async () => {
  await withDemo(false, async () => {
    const h = await harness();
    try {
      assert.equal((await h.call("POST", `/api/v1/campaigns/${h.id}/metrics/sample`, { preset: "reel-week-1" })).status, 404);
      assert.equal((await (await h.call("GET", "/api/v1/capabilities")).json()).data.demoSamples, false);
      const m = (await (await h.call("GET", `/api/v1/campaigns/${h.id}/metrics`)).json()).data;
      assert.equal(m.sample, undefined);
      assert.equal(m.instagram.sample, undefined);
      assert.equal(m.instagram.value, null);
      // "false" or any other value is not "true"
      process.env.AXYS_DEMO_SAMPLES = "1";
      assert.equal((await h.call("POST", `/api/v1/campaigns/${h.id}/metrics/sample`, { preset: "reel-week-1" })).status, 404);
    } finally {
      await h.close();
    }
  });
});

test("sample insights: realistic, internally consistent, flagged sample:true and never labelled Instagram", async () => {
  await withDemo(true, async () => {
    const h = await harness();
    try {
      assert.equal((await (await h.call("GET", "/api/v1/capabilities")).json()).data.demoSamples, true);
      const r = await h.call("POST", `/api/v1/campaigns/${h.id}/metrics/sample`, { preset: "reel-week-1" });
      assert.equal(r.status, 200);
      const stored = (await r.json()).data;
      const got = (await (await h.call("GET", `/api/v1/campaigns/${h.id}/metrics`)).json()).data;
      assert.deepEqual(got, stored);
      assert.equal(got.sample, true);
      const ig = got.instagram;
      assert.equal(ig.sample, true);
      assert.equal(ig.source, "Sample data (not Instagram)");
      assert.equal(ig.preset, "reel-week-1");
      assert.match(ig.note, /Not retrieved from Instagram/);
      // headline numbers, in the rows the real feedback normaliser reads
      const rows = Object.fromEntries(ig.data.data.map((x: any) => [x.name, x.total_value.value]));
      assert.deepEqual(rows, {
        plays: 18420,
        reach: 12960,
        likes: 1184,
        comments: 62,
        saves: 341,
        shares: 97,
        profile_visits: 428,
        follows: 56,
        avg_watch_time: 6.4,
        retention_end_pct: 46,
      });
      for (const name of Object.keys(rows)) assert.match(name, /^[a-z][a-z_]*$/);
      // 7-day series sums to the totals; reach is cumulative and ends at the total
      const days = ig.series.days;
      assert.equal(days.length, 7);
      const sum = (k: string) => days.reduce((s: number, d: any) => s + d[k], 0);
      assert.equal(sum("plays"), 18420);
      assert.equal(sum("likes"), 1184);
      assert.equal(sum("saves"), 341);
      assert.equal(sum("shares"), 97);
      assert.equal(days[6].reach_cumulative, 12960);
      for (let i = 1; i < 7; i++) assert.ok(days[i].reach_cumulative > days[i - 1].reach_cumulative);
      assert.ok(days[0].plays > days[6].plays, "a reel's plays decay over the week");
      assert.deepEqual(days.map((d: any) => d.day), [...days.map((d: any) => d.day)].sort());
      // retention: 100% at 0 s down to about 46% at 10 s, monotone, mean watch time matches 6.4 s
      const ret = ig.series.retention;
      assert.equal(ret.length, 11);
      assert.deepEqual([ret[0], ret[10]], [{ second: 0, pct: 100 }, { second: 10, pct: 46 }]);
      for (let i = 1; i < ret.length; i++) assert.ok(ret[i].pct <= ret[i - 1].pct);
      const area = ret.slice(1).reduce((s: number, p: any, i: number) => s + (p.pct + ret[i].pct) / 2, 0) / 100;
      assert.ok(Math.abs(area - 6.4) < 0.1, `area ${area}`);
      // audience splits sum to 100
      for (const k of ["age", "country"])
        assert.equal(ig.series.audience[k].reduce((s: number, x: any) => s + x.pct, 0), 100);
      // website: 58 visits, 3 contact clicks, in the shape the real events report
      assert.deepEqual(got.website.map((w: any) => [w.kind, w.value]), [["visit", 58], ["contact", 3]]);
      // the real normaliser accepts every row and every metric name
      const obs = normalizeObservations(got);
      assert.equal(obs.filter((o) => o.source === "instagram").length, 10);
      assert.deepEqual(obs.filter((o) => o.source === "website").map((o) => [o.metric, o.value]), [["site_visit", 58], ["site_contact", 3]]);
      // route validation
      assert.equal((await h.call("POST", `/api/v1/campaigns/${h.id}/metrics/sample`, { preset: "other" })).status, 422);
      assert.equal((await h.call("POST", `/api/v1/campaigns/${h.id}/metrics/sample`, {})).status, 422);
      assert.equal((await h.call("POST", `/api/v1/campaigns/${h.id}/metrics/sample`, { preset: "reel-week-1", plays: 9 })).status, 422);
      assert.notEqual((await h.call("POST", `/api/v1/campaigns/${crypto.randomUUID()}/metrics/sample`, { preset: "reel-week-1" })).status, 200);
      // pure builders
      assert.deepEqual(sampleInstagramRecord(new Date("2026-11-14T12:00:00Z")).series.days[6].day, "2026-11-14");
      assert.equal(sampleWebsiteRows().length, 2);
    } finally {
      await h.close();
    }
  });
});

test("real Instagram metrics always win over sample data and the real storage record is never written by the sample route", async () => {
  await withDemo(true, async () => {
    const h = await harness();
    try {
      await h.call("POST", `/api/v1/campaigns/${h.id}/metrics/sample`, { preset: "reel-week-1" });
      assert.equal(h.store.get("metrics", "local-demo", h.id), undefined);
      h.store.put("metrics", "local-demo", h.id, {
        source: "Instagram",
        apiVersion: "v99.0",
        observedAt: "2026-11-01T00:00:00.000Z",
        data: { data: [{ name: "plays", period: "lifetime", total_value: { value: 5 } }] },
      });
      const m = (await (await h.call("GET", `/api/v1/campaigns/${h.id}/metrics`)).json()).data;
      assert.equal(m.sample, undefined);
      assert.equal(m.instagram.source, "Instagram");
      assert.equal(m.instagram.data.data[0].total_value.value, 5);
      // flag off again: the stored sample record is simply ignored
      h.store.del("metrics", "local-demo", h.id);
      await withDemo(false, async () => {
        const off = (await (await h.call("GET", `/api/v1/campaigns/${h.id}/metrics`)).json()).data;
        assert.equal(off.sample, undefined);
        assert.equal(off.instagram.value, null);
      });
    } finally {
      await h.close();
    }
  });
});

const GROUNDED = {
  headline: "Weekend drop",
  suggestion:
    "Plays reached 18420 but average watch time was 6.4 seconds and saves were 341, so open the reel on the product close-up and compare the next post against these sample numbers.",
  questions: [],
  tool: "propose_revision",
};

test("revision runs the REAL grounded planner on the sample numbers and the trace says sampleData:true", async () => {
  await withDemo(true, async () => {
    const h = await harness({ json: () => GROUNDED });
    try {
      await h.call("POST", `/api/v1/campaigns/${h.id}/metrics/sample`, { preset: "reel-week-1" });
      const r = await h.call("POST", `/api/v1/campaigns/${h.id}/revision`, {});
      assert.equal(r.status, 200);
      const { proposal, trace, signal } = (await r.json()).data;
      assert.equal(trace.sampleData, true);
      assert.equal(trace.grounded, true);
      assert.equal(trace.provider, "meta-muse-gateway");
      assert.equal(trace.model, "muse-wonder-1.0");
      assert.equal(proposal.tool, "propose_revision");
      assert.match(proposal.suggestion, /18420/);
      assert.equal(proposal.headline, "Weekend drop");
      assert.equal(signal.sufficient, true);
      assert.ok(signal.observations.some((o: any) => o.metric === "plays" && o.value === 18420));
      // the model saw the data marked as sample, not as Instagram-reported
      const prompt = String(h.fake.calls.find((c) => c.route === "/v1/json")!.body.prompt);
      assert.match(prompt, /SAMPLE numbers for a demonstration, not reported by Instagram/);
      assert.match(prompt, /"metric":"plays","value":18420/);
    } finally {
      await h.close();
    }
  });
});

test("an ungrounded model reply on sample data is replaced by the deterministic summary of the same sample numbers", async () => {
  await withDemo(true, async () => {
    const h = await harness({
      json: () => ({ ...GROUNDED, suggestion: "Plays will reach 25000 and sales will rise because of the new opening." }),
    });
    try {
      await h.call("POST", `/api/v1/campaigns/${h.id}/metrics/sample`, { preset: "reel-week-1" });
      const { proposal, trace } = (await (await h.call("POST", `/api/v1/campaigns/${h.id}/revision`, {})).json()).data;
      assert.equal(trace.sampleData, true);
      assert.equal(trace.grounded, false);
      assert.match(trace.fallbackReason, /sales|causation|number/);
      assert.match(proposal.suggestion, /plays 18420/);
      assert.match(proposal.suggestion, /saves 341/);
      assert.doesNotMatch(proposal.suggestion, /25000/);
    } finally {
      await h.close();
    }
  });
});

test("revision without sample data carries no sampleData flag and the prompt has no sample note", async () => {
  await withDemo(true, async () => {
    const h = await harness({ json: () => GROUNDED });
    try {
      h.store.put("metrics", "local-demo", h.id, {
        source: "Instagram",
        observedAt: "2026-11-01T00:00:00.000Z",
        data: {
          data: [
            { name: "plays", period: "lifetime", total_value: { value: 18420 } },
            { name: "saves", period: "lifetime", total_value: { value: 341 } },
          ],
        },
      });
      const { trace } = (await (await h.call("POST", `/api/v1/campaigns/${h.id}/revision`, {})).json()).data;
      assert.equal(trace.sampleData, undefined);
      assert.doesNotMatch(String(h.fake.calls.find((c) => c.route === "/v1/json")!.body.prompt), /SAMPLE numbers/);
    } finally {
      await h.close();
    }
  });
});
