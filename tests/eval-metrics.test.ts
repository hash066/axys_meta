import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRates, pct, rate, rateOf, wilson } from "../eval/metrics.ts";
import {
  buildCases,
  priceVariants,
  runCase,
  summarise,
} from "../eval/preflight-mutations.ts";
import { bases, detId } from "../eval/fixtures.ts";
import { parsePrices } from "../packages/meta/preflight.ts";

const close = (a: number, b: number, eps = 5e-4) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test("Wilson interval matches reference values and edge cases", () => {
  // Reference (Wilson, z=1.96): 5/10 -> [0.2366, 0.7634]; 0/10 -> [0, 0.2775]; 10/10 -> [0.7225, 1]
  const [l, h] = wilson(5, 10)!;
  close(l, 0.2366);
  close(h, 0.7634);
  const zero = wilson(0, 10)!;
  assert.equal(zero[0], 0);
  close(zero[1], 0.2775);
  const all = wilson(10, 10)!;
  assert.equal(all[1], 1);
  close(all[0], 0.7225);
  assert.equal(wilson(0, 0), null);
  assert.throws(() => wilson(3, 2), RangeError);
  assert.throws(() => wilson(-1, 2), RangeError);
  assert.throws(() => wilson(1.5, 2), RangeError);
});

test("rate, rateOf, groupRates and pct", () => {
  assert.deepEqual(rate(0, 0), { k: 0, n: 0, rate: null, ci95: null });
  assert.match(pct(rate(0, 0)), /no cases/);
  const r = rateOf([true, true, false, true]);
  assert.equal(r.k, 3);
  assert.equal(r.n, 4);
  assert.equal(r.rate, 0.75);
  const g = groupRates(
    [
      { k: "a", ok: true },
      { k: "a", ok: false },
      { k: "b", ok: true },
    ],
    (x) => x.k,
    (x) => x.ok,
  );
  assert.deepEqual(Object.keys(g), ["a", "b"]);
  assert.equal(g.a.n, 2);
  assert.equal(g.b.rate, 1);
  assert.match(pct(rate(3, 4)), /75\.0% \(3\/4\), 95% CI/);
});

test("price variants all parse back to the same money", () => {
  for (const b of bases())
    for (const p of b.campaign.facts.products)
      for (const [kind, text] of Object.entries(priceVariants(p))) {
        const got = parsePrices(text);
        assert.ok(
          got.some(
            (m) => m.currency === p.currency && m.minor === p.priceMinor,
          ),
          `${b.key} ${kind}: ${text} -> ${JSON.stringify(got)}`,
        );
      }
});

test("harness: deterministic ids, controls clean, mutations caught, invariants hold", () => {
  assert.equal(detId("x"), detId("x"));
  assert.notEqual(detId("x"), detId("y"));
  const cases = buildCases(bases().slice(0, 3));
  assert.deepEqual(
    cases.map((c) => c.id),
    buildCases(bases().slice(0, 3)).map((c) => c.id),
  );
  const results = cases.map(runCase);
  const s = summarise(results);
  assert.equal(s.falseAlarms.controls.k, 0);
  assert.equal(s.falseAlarms.benign_all.k, 0);
  assert.equal(
    s.detection.drift_all_surfaces.k,
    s.detection.drift_all_surfaces.n,
  );
  assert.equal(s.locate.invariant_violations, 0);
  assert.ok(s.detection.drift_all_surfaces.n > 50);
  // summarise counts what it is given: a forged miss lowers the rate
  const d = results.find((r) => r.family === "drift" && r.klass === "core")!;
  d.blockedOnSurface = false;
  const s2 = summarise(results);
  assert.equal(
    s2.detection.drift_all_surfaces.k,
    s2.detection.drift_all_surfaces.n - 1,
  );
});
