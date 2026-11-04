import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCampaign, clone, SEEDS } from "../eval/fixtures.ts";
import type { Campaign } from "../packages/campaign/index.ts";
import {
  deterministicIssues,
  fuzzyIssues,
  type Issue,
} from "../packages/meta/preflight.ts";
import { MuseGateway } from "../packages/meta/gateway.ts";
import {
  closestLine,
  diffPairs,
  normaliseRect,
  replacedFragment,
  replacementFor,
} from "../packages/meta/redpen.ts";
import { textWidth } from "../packages/renderers/polish.ts";
import { startFakeGateway } from "./fake-gateway.ts";

const seed = (key: string) => SEEDS.find((s) => s.key === key)!;
const bakery = () => buildCampaign(seed("bakery"));
const allCutouts = (c: Campaign) => ({
  cutoutProductIds: new Set(c.facts.products.map((p) => p.id)),
});
const near = (a: number, b: number, eps = 1.5e-4) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const inUnit = ([x, y, w, h]: number[]) =>
  x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9;

/** Edit the price after generation, keep the old artifacts (the documented stale step). */
function stalePrice(c: Campaign) {
  const s = clone(c);
  s.facts.products[0].priceMinor = 12900;
  s.revision++;
  return s;
}

test("every deterministic issue carries locate and fix keys; existing fields are unchanged", () => {
  const issues = deterministicIssues(stalePrice(bakery()));
  const base = (i: Issue) => ({
    severity: i.severity,
    surface: i.surface,
    text: i.text,
    expected: i.expected,
    found: i.found,
  });
  for (const surface of ["site", "reel", "caption"] as const)
    assert.deepEqual(issues.filter((i) => i.surface === surface).map(base), [
      {
        severity: "block",
        surface,
        text: `Price for "Bread" on the ${surface} does not match the confirmed price`,
        expected: "INR 129.00",
        found: "INR 125.00",
      },
    ]);
  for (const i of issues) {
    assert.ok("locate" in i && "fix" in i);
    assert.deepEqual(i.fix, {
      kind: "regenerate",
      label: "Regenerate to use INR 129.00",
    });
    assert.equal(i.locate!.text, "INR 125.00");
  }
  assert.equal(issues.find((i) => i.surface === "site")!.locate!.reel, null);
  assert.equal(issues.find((i) => i.surface === "caption")!.locate!.reel, null);
  assert.ok(issues.find((i) => i.surface === "reel")!.locate!.reel);
});

test("baseline reel box tracks the price line vs the collection line (hand-computed layout)", () => {
  const c = bakery();
  // Price drift on shot 0 (Bread).
  const p = clone(c);
  p.reel!.shots[0].text = p.reel!.shots[0].text.replace(
    "INR 125.00",
    "INR 149.00",
  );
  const price = deterministicIssues(p).find(
    (i) => i.surface === "reel" && /Price for "Bread"/.test(i.text),
  )!;
  assert.equal(price.locate!.text, "INR 149.00");
  assert.equal(price.locate!.reel!.shot, 0);
  const [px, py, pw, ph] = price.locate!.reel!.box;
  // lines: business(0) name(1) price(2) collection(3); baseline 1130+52j, 36px text.
  near(px, 90 / 1080);
  near(py, (1130 + 2 * 52 - 29) / 1920);
  near(ph, 36 / 1920);
  near(pw, textWidth("INR 149.00", 36) / 1080);

  // Collection drift on shot 1 (Sourdough).
  const col = clone(c);
  col.reel!.shots[1].text = col.reel!.shots[1].text.replace(
    "24 October",
    "25 October",
  );
  const issue = deterministicIssues(col).find(
    (i) => i.surface === "reel" && /Collection details/.test(i.text),
  )!;
  assert.equal(issue.locate!.text.startsWith("25 October"), true);
  assert.equal(issue.locate!.reel!.shot, 1);
  near(issue.locate!.reel!.box[1], (1130 + 3 * 52 - 29) / 1920);
  assert.ok(
    issue.locate!.reel!.box[1] > price.locate!.reel!.box[1],
    "collection is below the price",
  );
});

test("cutout reel box uses layoutText: price pill vs details line", () => {
  const c = bakery();
  const p = clone(c);
  p.reel!.shots[0].text = p.reel!.shots[0].text.replace(
    "INR 125.00",
    "INR 149.00",
  );
  const opts = allCutouts(c);
  const price = deterministicIssues(p, undefined, opts).find(
    (i) => i.surface === "reel" && /Price for "Bread"/.test(i.text),
  )!;
  const [x, y, w, h] = price.locate!.reel!.box;
  // layoutText("Test bakery","Bread","INR 149.00",collection): nameTop 1322,
  // name 92px -> line height 99, priceTop 1443, pill 76 tall, details top 1549.
  near(y, 1443 / 1920);
  near(h, 76 / 1920);
  near(x + w / 2, 0.5); // pill is centred
  const col = clone(c);
  col.reel!.shots[0].text = col.reel!.shots[0].text.replace(
    "24 October",
    "25 October",
  );
  const issue = deterministicIssues(col, undefined, opts).find(
    (i) => i.surface === "reel" && /Collection details/.test(i.text),
  )!;
  assert.equal(issue.locate!.reel!.shot, 0);
  near(issue.locate!.reel!.box[1], 1549 / 1920);
  near(issue.locate!.reel!.box[3], 47 / 1920);
  // Same issue fields whichever layout is used.
  assert.deepEqual(
    deterministicIssues(col).map(({ locate: _l, ...i }) => i),
    deterministicIssues(col, undefined, opts).map(({ locate: _l, ...i }) => i),
  );
});

test("price above collection and boxes inside the frame for wrapped long names (both layouts)", () => {
  const c = buildCampaign(seed("single-long-name"));
  for (const opts of [{}, allCutouts(c)]) {
    const m = clone(c);
    m.reel!.shots[0].text = m
      .reel!.shots[0].text.replace("INR 18500.00", "INR 19999.00")
      .replace("12 December", "13 December")
      .replace("Pochampally double", "Mystery double");
    const issues = deterministicIssues(m, undefined, opts).filter(
      (i) => i.surface === "reel" && i.locate?.reel,
    );
    assert.ok(issues.length >= 2);
    for (const i of issues)
      assert.ok(inUnit(i.locate!.reel!.box), JSON.stringify(i.locate));
    const price = issues.find((i) => i.locate!.text.startsWith("INR"))!;
    const col = issues.find((i) => i.locate!.text.includes("13 December"))!;
    assert.ok(price.locate!.reel!.box[1] < col.locate!.reel!.box[1]);
  }
});

test("not derivable means null, never a guess", () => {
  const c = bakery();
  const noPrice = clone(c);
  noPrice.reel!.shots[0].text = "Bread\n\n" + c.facts.collection;
  const none = deterministicIssues(noPrice).find((i) =>
    /No price shown/.test(i.text),
  )!;
  assert.equal(none.locate, null);
  assert.ok(none.fix, "still fixable by regenerating");

  const gone = clone(c);
  delete gone.site;
  const noSite = deterministicIssues(gone).find((i) => i.surface === "site")!;
  assert.equal(noSite.locate, null);
  assert.equal(noSite.fix?.label, "Regenerate from the confirmed facts");

  // Seller voice: regenerating cannot change what was said.
  const voice = deterministicIssues(c, "Bread is 99 rupees").find(
    (i) => i.surface === "voice",
  )!;
  assert.equal(voice.locate, null);
  assert.equal(voice.fix, null);
});

test("business mismatch is located by template diff", () => {
  const m = bakery();
  m.site!.facts = { ...m.site!.facts, business: "Sunrise Traders" };
  m.reel!.caption = m.reel!.caption.replace("Test bakery", "Sunrise Traders");
  const issues = deterministicIssues(m);
  const cap = issues.find(
    (i) => i.surface === "caption" && /Business name/.test(i.text),
  )!;
  assert.equal(cap.locate!.text, "Sunrise Traders");
});

test("Wonder warnings: located only when the quoted words are verbatim; no fix", async () => {
  const fake = await startFakeGateway({
    json: () => ({
      issues: [
        {
          surface: "caption",
          text: "Unsupported",
          found: "Baked fresh every morning.",
        },
        { surface: "caption", text: "Invented", found: "best in town" },
      ],
    }),
  });
  try {
    const r = await fuzzyIssues(
      bakery(),
      new MuseGateway({ baseUrl: fake.url }),
    );
    assert.equal(r.issues[0].locate!.text, "Baked fresh every morning.");
    assert.equal(r.issues[1].locate, null);
    assert.ok(r.issues.every((i) => i.fix === null && i.severity === "warn"));
  } finally {
    await fake.close();
  }
});

test("regressions found by the eval: typography, whitespace in confirmed text, link handling", () => {
  const c = bakery();
  const dash = clone(c);
  dash.reel!.caption = dash.reel!.caption.replace("4–6pm", "4-6pm");
  assert.deepEqual(deterministicIssues(dash), []);

  const spaced = buildCampaign(seed("candles"));
  spaced.reel!.caption = spaced.reel!.caption.replace(
    "Buy 2 candles for INR 500",
    "Buy 2  candles for INR  500",
  );
  assert.deepEqual(deterministicIssues(spaced), []);

  const port = clone(c);
  port.reel!.caption = port.reel!.caption.replace(
    "example.com/contact",
    "example.com:443/contact/",
  );
  assert.deepEqual(deterministicIssues(port), []);

  const longer = clone(c);
  longer.reel!.caption = longer.reel!.caption.replace(
    "https://example.com/contact",
    "https://example.com/contact/checkout",
  );
  const hit = deterministicIssues(longer).find((i) => i.surface === "caption")!;
  assert.match(hit.text, /link in the caption/);
  assert.equal(hit.locate!.text, "https://example.com/contact/checkout");
});

test("redpen helpers", () => {
  assert.equal(normaliseRect([-10, 0, 5, 5]), null);
  assert.deepEqual(normaliseRect([540, 960, 1080, 1920]), [0.5, 0.5, 0.5, 0.5]);
  assert.equal(
    closestLine(["Hello world", "Other"], "Hello wurld", []),
    "Hello world",
  );
  assert.equal(closestLine(["abc", "xyz"], "completely different", []), null);
  assert.equal(closestLine(["Bread A", "Bread B"], "Bread C", []), null);
  assert.deepEqual(diffPairs(["a", "b", "c"], ["a", "X", "c"]), [
    { expected: "b", actual: "X" },
  ]);
  assert.equal(
    replacedFragment(
      "Bread — INR 125.00",
      "Mystery item — INR 125.00",
      "Bread",
    ),
    "Mystery item",
  );
  assert.equal(
    replacementFor(
      ["x", "Weekend sale · 24 Oct"],
      ["x", "Weekend sale · 25 Oct"],
      "24 Oct",
    ),
    "25 Oct",
  );
  assert.equal(replacedFragment("abc", "abc", "zzz"), null);
});
