import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backgroundPalette,
  cleanText,
  dominantColor,
  fitText,
  hexToRgb,
  layoutText,
  mixRgb,
  mulberry32,
  productScale,
  rgbToHex,
  textWidth,
  wrapByWidth,
} from "../packages/renderers/polish.ts";
import { xmlEscape } from "../packages/renderers/polish-art.ts";

const solid = (r: number, g: number, b: number, a = 255, n = 64) => {
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) buf.set([r, g, b, a], i * 4);
  return buf;
};

test("colour helpers round-trip and mix", () => {
  assert.deepEqual(hexToRgb("#f4ecdf"), { r: 244, g: 236, b: 223 });
  assert.equal(rgbToHex({ r: 300, g: -4, b: 15.4 }), "#ff000f");
  assert.deepEqual(
    mixRgb({ r: 0, g: 0, b: 0 }, { r: 100, g: 200, b: 50 }, 0.5),
    { r: 50, g: 100, b: 25 },
  );
  assert.throws(() => hexToRgb("blue"));
});

test("dominantColor ignores transparent pixels and prefers saturated colour", () => {
  assert.equal(dominantColor(solid(10, 20, 30, 0), 8, 8), null);
  const blue = solid(40, 90, 200, 255, 40);
  const grey = solid(200, 200, 200, 255, 60);
  const ghost = solid(255, 0, 0, 10, 500);
  const mix = Buffer.concat([blue, grey, ghost]);
  const c = dominantColor(mix, mix.length / 4, 1)!;
  assert.ok(c.b > c.r && c.b > 150, JSON.stringify(c));
  // deterministic
  assert.deepEqual(dominantColor(mix, mix.length / 4, 1), c);
});

test("backgroundPalette is deterministic, tinted and keeps text contrast colours", () => {
  const plain = backgroundPalette("warm", null);
  const tinted = backgroundPalette("warm", { r: 40, g: 90, b: 200 });
  assert.notEqual(plain.edge, tinted.edge);
  assert.deepEqual(backgroundPalette("warm", { r: 40, g: 90, b: 200 }), tinted);
  assert.equal(plain.ink, "#233b31");
  const dark = backgroundPalette("other", null);
  assert.equal(dark.ink, "#ffffff");
  assert.match(dark.center, /^#[0-9a-f]{6}$/);
});

test("mulberry32 is seeded and in range", () => {
  const a = mulberry32(7),
    b = mulberry32(7);
  for (let i = 0; i < 20; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test("text wrapping keeps words, splits over-long words and fits sizes", () => {
  assert.ok(textWidth("WWWW", 40) > textWidth("iiii", 40));
  const lines = wrapByWidth(
    "Hand glazed speckled stoneware mug",
    500,
    60,
    true,
  );
  assert.ok(lines.length >= 2);
  assert.equal(lines.join(" "), "Hand glazed speckled stoneware mug");
  const long = wrapByWidth("x".repeat(80), 300, 40);
  assert.ok(long.length > 1);
  assert.equal(long.join(""), "x".repeat(80));
  assert.deepEqual(wrapByWidth("", 300, 40), [""]);
  const short = fitText("mug", [92, 80], 900, 2, true);
  assert.equal(short.size, 92);
  const big = fitText(
    "a very long product name ".repeat(6).trim(),
    [92, 50],
    900,
    2,
    true,
  );
  assert.equal(big.size, 50);
});

test("layoutText stacks blocks without overlap and keeps the CTA below", () => {
  const b = layoutText(
    "Clay & Co",
    "ceramic mug",
    "INR 129.00",
    "Saturday 7 November 2026",
  );
  assert.ok(
    b.name.y > b.business.y && b.price.y > b.name.y && b.details.y > b.price.y,
  );
  assert.ok(b.ctaY >= b.end && b.ctaY + 84 <= 1840);
  const two = layoutText(
    "B",
    "Hand-glazed speckled stoneware ceramic mug set",
    "INR 1,299.00",
    "x ".repeat(60),
  );
  assert.ok(two.name.lines.length >= 2 && two.end < 1800);
  assert.ok(two.price.width > 200);
});

test("productScale never enlarges and respects both axes", () => {
  assert.equal(productScale(400, 400), 1);
  assert.equal(productScale(1720, 400), 0.5);
  assert.equal(productScale(400, 1880), 0.5);
});

test("text sanitising: control chars stripped and XML escaped", () => {
  assert.equal(cleanText("a\u0000b\u0008c\nd"), "abc\nd");
  assert.equal(xmlEscape(`<tspan>"&'\u0001`), "&lt;tspan&gt;&quot;&amp;&apos;");
});
