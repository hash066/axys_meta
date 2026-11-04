import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, price } from "../packages/campaign/index.ts";
import {
  deterministicIssues,
  parsePrices,
  type Issue,
} from "../packages/meta/preflight.ts";
import { buildCampaign } from "../eval/fixtures.ts";
import { clone } from "../eval/fixtures.ts";
import type { Campaign } from "../packages/campaign/index.ts";

const COLLECTION = "Saturday, Nov 7, 10am to 4pm ET";
const seed = (priceMinor = 12900, currency: "USD" | "EUR" | "GBP" | "INR" = "USD") =>
  buildCampaign({
    key: `dollar-${currency}-${priceMinor}`,
    business: "Dollar Test",
    offer: "Weekend collection",
    collection: COLLECTION,
    contact: "https://t.example/c",
    validUntil: "2026-11-08T04:59:00.000Z",
    products: [{ name: "Canvas tote", priceMinor, currency }],
  });

test("price() formats dollars, euros and pounds with a symbol and keeps INR as a code", () => {
  const c = seed();
  assert.equal(price(c.facts.products[0]), "$129.00");
  assert.equal(formatMoney("USD", 5), "$0.05");
  assert.equal(formatMoney("USD", 129900), "$1299.00");
  assert.equal(formatMoney("EUR", 12900), "€129.00");
  assert.equal(formatMoney("GBP", 12900), "£129.00");
  assert.equal(formatMoney("INR", 12900), "INR 129.00");
  // the generated artifacts carry exactly that text
  assert.match(c.reel!.caption, /Canvas tote — \$129\.00/);
  assert.match(c.reel!.shots[0].text, /\n\$129\.00\n/);
  assert.equal(c.reel!.shots[0].text.split("\n")[2], COLLECTION);
});

/** Block issues raised on one surface when `text` replaces the confirmed price there. */
function blocksFor(
  surface: "caption" | "reel" | "voice" | "narration",
  text: string,
): Issue[] {
  const c: Campaign = clone(seed());
  let voice: string | undefined;
  if (surface === "caption")
    c.reel!.caption = c.reel!.caption.replace("$129.00", text);
  else if (surface === "reel")
    c.reel!.shots[0].text = c.reel!.shots[0].text.replace("$129.00", text);
  else if (surface === "voice") voice = `The Canvas tote is ${text} this week.`;
  else
    c.generation = {
      revision: 1,
      ai: false,
      videoJobs: [],
      narration: {
        text: `Dollar Test. Canvas tote, ${text}. ${COLLECTION}. Tap the link to order.`,
        voice: "reel",
        model: "eleven_flash_v2_5",
        credits: 0,
        cached: true,
        source: "template",
      },
    };
  return deterministicIssues(c, voice).filter(
    (i) => i.severity === "block" && i.surface === surface,
  );
}

/** The documented table: every form of the SAME confirmed price is accepted. */
export const SAME_AS_129 = [
  "$129.00",
  "$129",
  "$129.0",
  "$ 129.00",
  "USD 129.00",
  "USD 129",
  "USD129.00",
  "usd 129",
  "USD $129.00",
  "USD$129.00",
  "US$129.00",
  "129 dollars",
  "129 dollar",
  "129 DOLLARS",
  "129 US dollars",
  "129.00 USD",
  "129 USD",
  "129.00 usd",
];
/** Different money, a different currency, or a form that cannot be trusted: all BLOCK. */
export const NOT_129 = [
  "$129.01",
  "$128.99",
  "$128.00",
  "$130",
  "$12.90",
  "$1290",
  "$1,290.00",
  "$1.29",
  "$129,00", // European decimal comma reads as 12,900 here: refused, never guessed
  "130 dollars",
  "1290 dollars",
  "129 euros",
  "€129.00",
  "EUR 129.00",
  "£129.00",
  "129 pounds",
  "129 rupees",
  "INR 129.00",
  "Rs. 129",
  "₹129",
  "A$129.00",
  "CA$129",
  "C$129.00",
  "NZ$129",
];

for (const surface of ["caption", "reel", "voice", "narration"] as const) {
  test(`dollar formats on the ${surface}: every form of $129.00 is accepted`, () => {
    for (const form of SAME_AS_129)
      assert.deepEqual(
        blocksFor(surface, form).map((i) => i.text),
        [],
        `${surface}: "${form}" should read as $129.00`,
      );
  });
  test(`dollar formats on the ${surface}: a different number, currency or format BLOCKS`, () => {
    for (const form of NOT_129)
      assert.ok(
        blocksFor(surface, form).length >= 1,
        `${surface}: "${form}" must be blocked`,
      );
  });
}

test("parsePrices reads each dollar form once, with the right currency and minor units", () => {
  const one = (t: string) => parsePrices(t).map((m) => `${m.currency}${m.minor}`);
  for (const form of SAME_AS_129) assert.deepEqual(one(form), ["USD12900"], form);
  assert.deepEqual(one("A$129 and US$129"), ["OTHER12900", "USD12900"]);
  assert.deepEqual(one("1,299 dollars and $1,299.50"), ["USD129900", "USD129950"]);
  // no marker, no price
  assert.deepEqual(one("size 129, call 555 0100, 129.00"), []);
  // other currencies keep their old behaviour
  // "12,50" reads as grouped 1,250 (never as a decimal comma): refused rather than guessed
  assert.deepEqual(one("€12,50 and £9.99 and 20 rupees"), ["EUR125000", "GBP999", "INR2000"]);
});

test("a euro or pound product still reads its own symbol and code and blocks a dollar sign", () => {
  for (const [cur, sym, code] of [
    ["EUR", "€", "EUR"],
    ["GBP", "£", "GBP"],
  ] as const) {
    const c = seed(2800, cur);
    const own = price(c.facts.products[0]);
    assert.equal(own, `${sym}28.00`);
    const ok = (t: string) => {
      const x: Campaign = clone(c);
      x.reel!.caption = x.reel!.caption.replace(own, t);
      return deterministicIssues(x).filter((i) => i.severity === "block" && i.surface === "caption");
    };
    for (const t of [`${sym}28.00`, `${sym}28`, `${code} 28.00`, `28.00 ${code}`, `${sym} 28.00`])
      assert.deepEqual(ok(t), [], t);
    for (const t of ["$28.00", "USD 28.00", "28 dollars", `${sym}29.00`])
      assert.ok(ok(t).length >= 1, t);
  }
});

test("an INR product keeps INR 129.00 and its benign variants", () => {
  const c = seed(12900, "INR");
  assert.equal(price(c.facts.products[0]), "INR 129.00");
  const ok = (t: string) => {
    const x: Campaign = clone(c);
    x.reel!.caption = x.reel!.caption.replace("INR 129.00", t);
    return deterministicIssues(x).filter((i) => i.severity === "block" && i.surface === "caption");
  };
  for (const t of ["INR 129.00", "₹129", "Rs. 129", "Rs 129", "129 rupees", "129.00 INR", "inr 129"])
    assert.deepEqual(ok(t), [], t);
  for (const t of ["$129.00", "129 dollars", "INR 130"]) assert.ok(ok(t).length >= 1, t);
});

test("an offer that quotes dollars is masked, not read as a stray price", () => {
  const c = buildCampaign({
    key: "mask",
    business: "Dollar Test",
    offer: "Two totes for $200",
    collection: COLLECTION,
    contact: "https://t.example/c",
    products: [{ name: "Canvas tote", priceMinor: 12900, currency: "USD" }],
  });
  assert.deepEqual(
    deterministicIssues(c).filter((i) => i.severity === "block"),
    [],
  );
});

test("expiry dates are accepted in the merchant's US day as well as UTC and IST, and wrong days still block", () => {
  // 2026-11-08T04:59Z is still Nov 7 on the US east and west coasts.
  const day = (text: string) => {
    const c: Campaign = clone(seed());
    c.reel!.caption += `\n${text}`;
    return deterministicIssues(c).filter(
      (i) => i.severity === "block" && i.surface === "caption",
    );
  };
  for (const t of ["Valid until Nov 7, 2026", "Offer ends November 8, 2026", "Valid until 2026-11-07"])
    assert.deepEqual(day(t), [], t);
  for (const t of ["Valid until Nov 6, 2026", "Valid until Nov 9, 2026", "Valid until Nov 7, 2027"])
    assert.ok(day(t).length >= 1, t);
});

test("narration is its own preflight surface: locate is null, the remedy is to regenerate", () => {
  const issues = blocksFor("narration", "$139.00");
  assert.ok(issues.length >= 1);
  for (const i of issues) {
    assert.equal(i.surface, "narration");
    assert.equal(i.locate, null);
    assert.equal(i.fix?.kind, "regenerate");
  }
  assert.match(issues[0].text, /narration/i);
  assert.equal(issues[0].expected, "$129.00");
  assert.equal(issues[0].found, "$139.00");
});
