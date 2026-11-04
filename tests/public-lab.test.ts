import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import {
  LAB_SURFACES,
  labCheck,
  labScenarios,
} from "../packages/meta/lab.ts";
import { kineticPhraseCheck } from "../packages/meta/direction.ts";

const ORIGIN = "http://127.0.0.1:4310";

async function harness() {
  const root = mkdtempSync(path.resolve("var-test-"));
  const store = new Store(root);
  const { app } = createApp(store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (url: string, body: unknown, raw = false) =>
    fetch(base + url, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    });
  const close = async () => {
    server.close();
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { base, post, close };
}

test("lab scenarios: 4-6, deterministic, each has exactly one wrong surface the real engine flags", () => {
  const a = labScenarios();
  assert.ok(a.length >= 4 && a.length <= 6);
  assert.deepEqual(a, labScenarios());
  assert.equal(new Set(a.map((s) => s.id)).size, a.length);
  const wrongBySurface = new Set<string>();
  for (const s of a) {
    const verdicts = LAB_SURFACES.map((g) => labCheck(s.id, g)!);
    assert.ok(verdicts.every((v) => v.wrongSurface === verdicts[0].wrongSurface));
    const v = verdicts[0];
    wrongBySurface.add(v.wrongSurface);
    // Every issue is a blocking finding on that single surface; the other two pass.
    assert.ok(v.issues.length >= 1);
    assert.ok(v.issues.every((i) => i.severity === "block" && i.surface === v.wrongSurface));
    assert.equal(v.engine, "deterministicIssuesFromTexts");
    assert.deepEqual(
      verdicts.map((x) => x.correct),
      LAB_SURFACES.map((g) => g === v.wrongSurface),
    );
    assert.equal(s.facts.products.length, 2);
    assert.match(s.facts.products[0].price, /^\$\d+\.\d{2}$/);
    // Texts are the real builders' output.
    assert.ok(s.surfaces.site.lines.includes("MADE FOR YOUR MOMENTS"));
    assert.ok(s.surfaces.caption.lines[0] === s.facts.business);
    assert.ok(s.surfaces.reel.shots.length === 2);
    // The surface verdict does not leak into the visitor payload.
    assert.doesNotMatch(JSON.stringify(s), /wrong|mismatch|stale|mutation/i);
  }
  assert.equal(wrongBySurface.size, 3, "faults are spread over all surfaces");
});

test("GET /public/lab/preflight needs no auth and no cookies", async () => {
  const h = await harness();
  try {
    const r = await fetch(h.base + "/api/v1/public/lab/preflight");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null);
    const j = await r.json();
    assert.deepEqual(Object.keys(j), ["scenarios"]);
    assert.deepEqual(j.scenarios, labScenarios());
    const s = j.scenarios[0];
    assert.deepEqual(Object.keys(s), ["id", "title", "brief", "facts", "surfaces"]);
    assert.deepEqual(Object.keys(s.facts), [
      "business",
      "offer",
      "collection",
      "contact",
      "products",
    ]);
    assert.deepEqual(Object.keys(s.surfaces), ["site", "reel", "caption"]);
  } finally {
    await h.close();
  }
});

test("POST preflight returns the real issues for right and wrong guesses", async () => {
  const h = await harness();
  try {
    for (const s of labScenarios()) {
      const truth = labCheck(s.id, "site")!;
      for (const guess of LAB_SURFACES) {
        const r = await h.post("/api/v1/public/lab/preflight", {
          scenarioId: s.id,
          guess,
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.correct, guess === truth.wrongSurface);
        assert.equal(j.wrongSurface, truth.wrongSurface);
        assert.deepEqual(j.issues, truth.issues);
        assert.ok(j.issues.length >= 1);
        for (const i of j.issues) {
          assert.equal(i.severity, "block");
          assert.equal(i.surface, truth.wrongSurface);
          assert.equal(typeof i.expected, "string");
          assert.equal(typeof i.found, "string");
        }
        assert.equal(j.engine, "deterministicIssuesFromTexts");
      }
    }
  } finally {
    await h.close();
  }
});

test("specific faults are found with the expected values", () => {
  const find = (id: string) => labCheck(id, "site")!.issues;
  assert.match(find("bakery-price")[0].found, /\$84\.00/);
  assert.equal(find("bakery-price")[0].expected, "$48.00");
  assert.equal(labCheck("bakery-price", "reel")!.correct, true);
  assert.equal(labCheck("sneaker-contact", "site")!.correct, true);
  assert.equal(find("sneaker-contact")[0].found, "https://stridelane.example.com/orders");
  assert.equal(labCheck("tote-currency", "caption")!.issues[0].found, "€36.00");
  assert.equal(labCheck("tote-currency", "caption")!.issues[0].expected, "$36.00");
  assert.match(find("salon-link")[0].found, /\?ref=reel-4821$/);
  assert.equal(labCheck("pottery-date", "reel")!.wrongSurface, "reel");
  assert.equal(labCheck("coffee-offer", "site")!.wrongSurface, "site");
});

test("POST preflight validation: bad input is rejected without echo", async () => {
  const h = await harness();
  try {
    const canary = "ZZCANARY<script>alert(1)</script>";
    const bad: unknown[] = [
      {},
      { scenarioId: "bakery-price" },
      { scenarioId: "bakery-price", guess: "voice" },
      { scenarioId: "bakery-price", guess: canary },
      { scenarioId: canary, guess: "site" },
      { scenarioId: "nope", guess: "site" },
      { scenarioId: "bakery-price", guess: "site", extra: canary },
      { scenarioId: ["bakery-price"], guess: "site" },
      [],
      "str",
      null,
    ];
    for (const body of bad) {
      const r = await h.post("/api/v1/public/lab/preflight", body);
      // Bare primitives never reach zod: the strict JSON parser answers 400.
      const primitive = body === null || typeof body === "string";
      assert.equal(r.status, primitive ? 400 : 422, JSON.stringify(body));
      const t = await r.text();
      assert.doesNotMatch(t, /CANARY|script/);
      assert.equal(JSON.parse(t).error.code, primitive ? "bad_request" : "validation");
    }
    const broken = await h.post("/api/v1/public/lab/preflight", `{"scenarioId":"${canary}`, true);
    assert.equal(broken.status, 400);
    assert.doesNotMatch(await broken.text(), /CANARY|script|Unexpected/);
    const big = await h.post("/api/v1/public/lab/phrase", { text: "a".repeat(5000) });
    assert.ok([413, 400, 422].includes(big.status));
    const nonjson = await fetch(h.base + "/api/v1/public/lab/preflight", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
      body: "hello",
    });
    assert.equal(nonjson.status, 422);
    const noOrigin = await fetch(h.base + "/api/v1/public/lab/phrase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Morning ritual" }),
    });
    assert.equal(noOrigin.status, 403);
  } finally {
    await h.close();
  }
});

test("phrase filter uses the real rules", () => {
  const ok = kineticPhraseCheck("  Made by hand. ");
  assert.deepEqual(ok, { allowed: true, cleaned: "Made by hand", reasons: [] });
  assert.equal(kineticPhraseCheck("Morning ritual").allowed, true);
  const cases: [string, RegExp][] = [
    ["Only 3 left", /digit/],
    ["50% off today", /digit/],
    ["Just ₹499", /money/],
    ["Pay in dollars", /money/],
    ["visit shop.com", /link|instruction/],
    ["https://x.io", /link/],
    ["The best cake", /claim word "best"/],
    ["Tastiest cake", /superlative "tastiest"/],
    ["Guaranteed joy", /claim word/],
    ["slow golden quiet mornings", /more than 3 words/],
    ["", /empty/],
  ];
  for (const [text, re] of cases) {
    const r = kineticPhraseCheck(text);
    assert.equal(r.allowed, false, text);
    assert.equal(r.cleaned, "");
    assert.ok(r.reasons.some((x) => re.test(x)), `${text}: ${r.reasons}`);
  }
  const multi = kineticPhraseCheck("Best 5 cakes ever sold");
  assert.ok(multi.reasons.length >= 3);
  assert.equal(new Set(multi.reasons).size, multi.reasons.length);
  assert.ok(multi.reasons.includes("more than 3 words"));
});

test("POST phrase endpoint", async () => {
  const h = await harness();
  try {
    let r = await h.post("/api/v1/public/lab/phrase", { text: "Made by hand" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null);
    let j = await r.json();
    assert.deepEqual(
      { allowed: j.allowed, cleaned: j.cleaned, reasons: j.reasons },
      { allowed: true, cleaned: "Made by hand", reasons: [] },
    );
    r = await h.post("/api/v1/public/lab/phrase", { text: "Best price 50% off" });
    j = await r.json();
    assert.equal(j.allowed, false);
    assert.equal(j.cleaned, "");
    assert.ok(j.reasons.length >= 2);
    // Rejected text is never reflected back.
    r = await h.post("/api/v1/public/lab/phrase", { text: "<img src=x onerror=1>" });
    const t = await r.text();
    assert.equal(JSON.parse(t).allowed, false);
    assert.doesNotMatch(t, /onerror|<img/);
    for (const body of [{}, { text: 5 }, { text: "x".repeat(61) }, { text: "a", extra: 1 }, "s"]) {
      r = await h.post("/api/v1/public/lab/phrase", body);
      assert.equal(r.status, typeof body === "string" ? 400 : 422);
      assert.ok(["validation", "bad_request"].includes((await r.json()).error.code));
    }
    r = await h.post("/api/v1/public/lab/phrase", { text: "x".repeat(60) });
    assert.equal(r.status, 200);
  } finally {
    await h.close();
  }
});

test("lab is rate limited per IP (60 per minute) and replies stay JSON", async () => {
  const h = await harness();
  try {
    let limited: Response | undefined;
    for (let i = 0; i < 70 && !limited; i++) {
      const r = await h.post("/api/v1/public/lab/phrase", { text: "Morning ritual" });
      if (r.status === 429) limited = r;
      else assert.equal(r.status, 200);
    }
    assert.ok(limited, "expected 429");
    assert.match(limited!.headers.get("content-type") ?? "", /json/);
    assert.equal((await limited!.json()).error.code, "rate_limited");
  } finally {
    await h.close();
  }
});

test("lab leaks no secrets or tenant data and does not weaken auth elsewhere", async () => {
  const h = await harness();
  try {
    const all = JSON.stringify(labScenarios()) +
      JSON.stringify(labCheck("bakery-price", "reel"));
    assert.doesNotMatch(all, /tenant|public-lab|secret|token|AXYS_|api[_-]?key|password|cookie/i);
    // Only the fixed example hosts appear as URLs.
    for (const u of all.match(/https?:\/\/[^\s"\\]+/g) ?? [])
      assert.match(u, /^https:\/\/[a-z]+\.example\.com\//);
    // Neighbouring API routes still need a session.
    for (const p of ["/api/v1/campaigns", "/api/v1/public/lab/other"]) {
      const r = await fetch(h.base + p);
      assert.equal(r.status, 401, p);
    }
    const put = await fetch(h.base + "/api/v1/public/lab/phrase", { method: "PUT", headers: { Origin: ORIGIN } });
    assert.equal(put.status, 401);
  } finally {
    await h.close();
  }
});
