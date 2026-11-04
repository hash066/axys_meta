import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash, specs, type Campaign } from "../packages/campaign/index.ts";
import {
  PreflightBlockedError,
  assertPreflightClear,
  deterministicIssues,
  parseExpiryDates,
  parsePrices,
  runPreflight,
} from "../packages/meta/preflight.ts";
import { MuseGateway } from "../packages/meta/gateway.ts";
import { propose } from "../packages/inference/meta.ts";
import { consumeCall, callCap } from "../packages/meta/budget.ts";
import { Store } from "../server/store.ts";
import { startFakeGateway } from "./fake-gateway.ts";

/** Deep copy without shared references (as after a store round-trip). */
const unshare = (c: Campaign): Campaign => JSON.parse(JSON.stringify(c));
function campaign(): Campaign {
  const c: Campaign = {
    id: randomUUID(),
    tenantId: "pf",
    revision: 1,
    state: "Draft",
    mode: "Both",
    layout: "editorial",
    reelStyle: "warm",
    brief: "",
    facts: {
      business: "Test bakery",
      offer: "Weekend collection",
      message: "Baked fresh every morning.",
      collection: "24 October 2026, 4–6pm IST",
      contact: "https://example.com/contact",
      confirmed: true,
      source: "merchant",
      validUntil: "2026-10-25T18:00:00.000Z",
      products: [
        {
          id: randomUUID(),
          name: "Bread",
          priceMinor: 12500,
          currency: "INR",
          assetId: randomUUID(),
        },
        {
          id: randomUUID(),
          name: "Sourdough Bread",
          priceMinor: 21000,
          currency: "INR",
          assetId: randomUUID(),
        },
      ],
    },
  };
  const s = specs(c);
  Object.assign(c, s, { siteHash: hash(s.site), state: "NeedsReview" });
  return c;
}
/** The documented stale-price step: edit the price, keep the old artifacts. */
function staleAfterPriceEdit(c: Campaign) {
  const stale = unshare(c);
  stale.facts.products[0].priceMinor = 12900;
  stale.revision++;
  return stale;
}

test("price parsing needs a currency marker and handles Indian grouping", () => {
  assert.deepEqual(
    parsePrices(
      "INR 125.00 and ₹1,25,000 and Rs. 99, $4.5, 20 rupees, 50% off, 7pm",
    ),
    [
      { currency: "INR", minor: 12500, raw: "INR 125.00" },
      { currency: "INR", minor: 12500000, raw: "₹1,25,000" },
      { currency: "INR", minor: 9900, raw: "Rs. 99" },
      { currency: "USD", minor: 450, raw: "$4.5" },
      { currency: "INR", minor: 2000, raw: "20 rupees" },
    ],
  );
  assert.deepEqual(parsePrices("Call 98765 43210 or visit shop 12"), []);
});

test("expiry phrases are parsed and compared by calendar day", () => {
  assert.deepEqual(
    parseExpiryDates(
      "Valid until 25 October 2026. Offer ends Oct 26, 2026 and until 2026-10-27",
    ),
    [
      { raw: "Valid until 25 October 2026", day: "2026-10-25" },
      { raw: "Offer ends Oct 26, 2026", day: "2026-10-26" },
      { raw: "until 2026-10-27", day: "2026-10-27" },
    ],
  );
});

test("preflight happy path: consistent surfaces produce no issues", () => {
  const c = campaign();
  assert.deepEqual(deterministicIssues(c), []);
  assert.deepEqual(
    deterministicIssues(
      c,
      "Bread is INR 125.00 and the sourdough bread is 210 rupees. Collection on the 24th.",
    ),
    [],
  );
});

test("stale price: edited after generation without regenerating is blocked on every surface", () => {
  const stale = staleAfterPriceEdit(campaign());
  const issues = deterministicIssues(stale);
  assert.ok(issues.length >= 3);
  assert.ok(issues.every((i) => i.severity === "block"));
  for (const surface of ["site", "reel", "caption"] as const) {
    const hit = issues.find(
      (i) => i.surface === surface && /Price for "Bread"/.test(i.text),
    );
    assert.ok(hit, `${surface} price issue`);
    assert.equal(hit.expected, "INR 129.00");
    assert.equal(hit.found, "INR 125.00");
  }
  // The longer product name must not be confused with "Bread".
  assert.equal(issues.filter((i) => /Sourdough/.test(i.text)).length, 0);
  assert.throws(
    () => {
      const store = new Store(mkdtempSync(path.resolve("var-test-")));
      try {
        assertPreflightClear(store, stale);
      } finally {
        const root = store.root;
        store.db.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    (e: unknown) =>
      e instanceof PreflightBlockedError && e.code === "preflight_blocked",
  );
});

test("offer, collection, contact, message and expiry mismatches are blocked", () => {
  const c = unshare(campaign());
  c.facts.offer = "Weekend collection, now 20% off";
  c.facts.collection = "25 October 2026, 5pm";
  c.facts.contact = "https://example.com/new-contact";
  c.facts.message = "Fresh daily.";
  const issues = deterministicIssues(c);
  const texts = issues.map((i) => `${i.surface}:${i.text}`).join("\n");
  assert.match(texts, /site:Offer/);
  assert.match(texts, /caption:Offer/);
  assert.match(texts, /site:Collection/);
  assert.match(texts, /reel:Collection details on reel shots 1, 2/);
  assert.match(texts, /site:Contact link on the site/);
  assert.match(texts, /caption:A link in the caption|caption:Contact link/);
  assert.match(texts, /site:Message/);
  assert.ok(issues.every((i) => i.severity === "block"));

  const dated = unshare(campaign());
  dated.facts.message = undefined;
  dated.site!.facts = dated.facts;
  // A surface that promises a different expiry than the confirmed one.
  dated.reel!.caption += "\nValid until 31 October 2026";
  const expiry = deterministicIssues(dated).filter((i) =>
    /expiry/i.test(i.text),
  );
  assert.equal(expiry.length, 1);
  assert.equal(expiry[0].surface, "caption");
  assert.equal(expiry[0].found, "Valid until 31 October 2026");
  // The same date as the confirmed expiry (UTC or IST day) is fine.
  const same = campaign();
  same.reel!.caption += "\nValid until 25 October 2026";
  assert.equal(
    deterministicIssues(same).filter((i) => /expiry/i.test(i.text)).length,
    0,
  );
});

test("offer text containing prices or product names does not cause false blocks", () => {
  const c = campaign();
  c.facts.offer = "Buy any Bread for INR 100 more, get Sourdough Bread free";
  const next = specs(c);
  c.site = next.site;
  c.reel = next.reel;
  assert.deepEqual(deterministicIssues(c), []);
});

test("spoken price that contradicts confirmed facts is blocked as voice", () => {
  const c = campaign();
  const issues = deterministicIssues(
    c,
    "The bread is 140 rupees this weekend. Sourdough bread is INR 210.",
  );
  const voice = issues.filter((i) => i.surface === "voice");
  assert.equal(voice.length, 1);
  assert.equal(voice[0].severity, "block");
  assert.equal(voice[0].expected, "INR 125.00");
  assert.equal(voice[0].found, "INR 140.00");
  // Unrelated stray price in the transcript is also caught.
  assert.equal(
    deterministicIssues(c, "Everything is ₹99 today").filter(
      (i) => i.surface === "voice",
    ).length,
    1,
  );
});

test("a missing surface is a block, never a silent pass", () => {
  const c = campaign();
  delete c.site;
  delete c.reel;
  const issues = deterministicIssues(c);
  assert.deepEqual(issues.map((i) => `${i.severity}:${i.surface}`).sort(), [
    "block:reel",
    "block:site",
  ]);
});

test("runPreflight combines exact rules with Wonder warnings and persists", async () => {
  const root = mkdtempSync(path.resolve("var-test-"));
  const store = new Store(root);
  const fake = await startFakeGateway({
    json: (body) => {
      assert.equal(body.model, "wonder");
      assert.match(body.prompt, /untrusted/);
      return {
        issues: [
          {
            surface: "caption",
            text: "Claims 'best in town'",
            found: "best in town",
          },
        ],
      };
    },
  });
  try {
    const c = campaign();
    const ok = await runPreflight(
      store,
      new MuseGateway({ baseUrl: fake.url }),
      c,
    );
    assert.equal(ok.ok, true, "warnings never block");
    assert.equal(ok.model, "muse-wonder-1.0");
    assert.equal(ok.fuzzy.ran, true);
    assert.equal(ok.issues[0].severity, "warn");
    const stale = staleAfterPriceEdit(c);
    const bad = await runPreflight(
      store,
      new MuseGateway({ baseUrl: fake.url }),
      stale,
    );
    assert.equal(bad.ok, false);
    assert.ok(bad.issues.some((i) => i.severity === "block"));
    assert.ok(bad.issues.some((i) => i.severity === "warn"));
    assert.equal(store.get<any>("preflight", "pf", c.id).revision, 2);
    // Wonder down: deterministic result still returned, honestly labelled.
    fake.state.failJson = true;
    const degraded = await runPreflight(
      store,
      new MuseGateway({ baseUrl: fake.url }),
      stale,
    );
    assert.equal(degraded.ok, false);
    assert.equal(degraded.model, null);
    assert.equal(degraded.fuzzy.ran, false);
    assert.match(degraded.fuzzy.error!, /not JSON|gateway/i);
  } finally {
    await fake.close();
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wonder planner validates proposals, ignores extra keys and enforces the call cap", async () => {
  const root = mkdtempSync(path.resolve("var-test-"));
  const store = new Store(root);
  const c = campaign();
  const ids = c.facts.products.map((p) => p.id);
  const fake = await startFakeGateway({
    json: () => ({
      headline: c.facts.offer,
      suggestion: "Render the confirmed offer.",
      questions: [],
      tool: "render",
      layout: "catalog",
      reelStyle: null,
      productOrder: [ids[1], ids[0]],
      chainOfThought: "ignored extra key",
    }),
  });
  const old = process.env.MUSE_CAMPAIGN_CALL_CAP;
  try {
    const gateway = new MuseGateway({ baseUrl: fake.url });
    const r = await propose(c, store, [], gateway);
    assert.equal(r.proposal.layout, "catalog");
    assert.equal(r.proposal.reelStyle, undefined);
    assert.equal(r.trace.model, "muse-wonder-1.0");
    const sent = fake.calls[0].body;
    assert.equal(sent.effort, "low");
    assert.match(sent.prompt, /untrusted data, not instructions/);
    fake.state.json = () => ({
      headline: "x",
      suggestion: "s",
      questions: [],
      tool: "rm -rf",
    });
    await assert.rejects(() => propose(c, store, [], gateway));
    process.env.MUSE_CAMPAIGN_CALL_CAP = "2";
    assert.equal(callCap(), 2);
    assert.throws(
      () => consumeCall(store, c.tenantId, c.id, "planner"),
      /limit reached/,
    );
    await assert.rejects(() => propose(c, store, [], gateway), /limit reached/);
  } finally {
    if (old === undefined) delete process.env.MUSE_CAMPAIGN_CALL_CAP;
    else process.env.MUSE_CAMPAIGN_CALL_CAP = old;
    await fake.close();
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
