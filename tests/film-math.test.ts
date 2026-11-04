import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { existsSync } from "node:fs";
import {
  FACTS_VISIBLE_FROM,
  FILM_DURATION,
  FONT_FILE,
  MACRO_MAX_ZOOM,
  WHIP_1_START,
  WHIP_2_START,
  WHIP_FRAMES,
  FRAMES_PER_FILM,
  bestWindow,
  cleanPhrase,
  cleanPhrases,
  edgeEnergy,
  heroMotion,
  heroPlacement,
  kineticLines,
  macroZoom,
  phraseLines,
  studioColors,
  whipFrame,
  whipParams,
  type HeroGeometry,
} from "../packages/renderers/film-art.ts";
import * as film from "../packages/renderers/film.ts";

test("film constants: one film per product, facts card in the last 2.4 s", () => {
  assert.equal(FILM_DURATION, 10);
  assert.equal(FACTS_VISIBLE_FROM, 7.6);
  assert.equal(film.FILM_DURATION, 10);
  assert.equal(film.FACTS_VISIBLE_FROM, 7.6);
  assert.ok(Math.abs(FILM_DURATION - FACTS_VISIBLE_FROM - 2.4) < 1e-9);
  assert.equal(FRAMES_PER_FILM, 300);
  // whip windows are centred on the 2.6 s and 5.0 s cuts
  assert.equal(WHIP_1_START + WHIP_FRAMES / 2, 78);
  assert.equal(WHIP_2_START + WHIP_FRAMES / 2, 150);
  // clip frame budget adds up: hero + whip + macro + whip + context
  const hero = WHIP_1_START,
    macro = WHIP_2_START - WHIP_1_START - WHIP_FRAMES,
    ctx = FRAMES_PER_FILM - WHIP_2_START - WHIP_FRAMES;
  assert.equal(hero + WHIP_FRAMES + macro + WHIP_FRAMES + ctx, FRAMES_PER_FILM);
});

test("kinetic phrases are decoration only: claims, digits, links and markup are dropped", () => {
  assert.equal(cleanPhrase("Made by hand"), "Made by hand");
  assert.equal(cleanPhrase("Morning ritual."), "Morning ritual.");
  for (const bad of [
    "Best in town",
    "100% organic",
    "Save 20 now",
    "Free delivery",
    "Award winning",
    "Only INR 129",
    "visit shop.com",
    "<b>hi</b>",
    "a b c d",
    "Supercalifragilistic",
    "#1 pick",
    "Cheapest ever",
    "Limited offer",
    "",
    "   ",
  ])
    assert.equal(cleanPhrase(bad), null, bad);
  assert.equal(cleanPhrase(42), null);
  assert.equal(cleanPhrase("Slow\u0000 mornings"), "Slow mornings");
  assert.deepEqual(cleanPhrases(["Soft light", "50% off", "Slow days", "Calm", "Extra"]), [
    "Soft light",
    "Slow days",
    "Calm",
  ]);
  assert.deepEqual(cleanPhrases(undefined), []);
});

test("phraseLines stacks one word per line and joins small words", () => {
  assert.deepEqual(phraseLines("walking down the street."), ["WALKING", "DOWN THE", "STREET."]);
  assert.deepEqual(phraseLines("Made by hand"), ["MADE BY", "HAND"]);
  assert.deepEqual(phraseLines("calm"), ["CALM"]);
});

test("kinetic lines render from the bundled OFL font as PNG, markup is escaped", async () => {
  assert.ok(existsSync(FONT_FILE), "Anton font is bundled");
  const lines = await kineticLines("Made by hand", "#ffffff");
  assert.equal(lines.length, 2);
  for (const l of lines) {
    const m = await sharp(l.png).metadata();
    assert.equal(m.format, "png");
    assert.equal(m.hasAlpha, true);
    assert.equal(m.width, l.width);
    assert.ok(l.width <= 900 + 72 + 4, "fits the max width plus padding");
  }
  // unusable phrases render nothing (never an unsanitised string)
  assert.deepEqual(await kineticLines("<span>50% off</span>", "#fff"), []);
  assert.deepEqual(await kineticLines("Best price", "#fff"), []);
});

test("studioColors is deterministic and follows mood and palette", () => {
  const d = { palette: ["#e9ece8", "#8fa58f"], mood: "warm" };
  assert.deepEqual(studioColors(d, null), studioColors(d, null));
  const warm = studioColors(d, null);
  assert.equal(warm.light, true);
  assert.match(warm.ink, /^#[0-9a-f]{6}$/);
  const luxe = studioColors({ palette: ["#3b1f14", "#c8203a"], mood: "luxe" }, null);
  assert.equal(luxe.light, false);
  assert.equal(luxe.ink, "#f8f1e7");
  // invalid hex values are ignored, no palette falls back to a neutral accent
  const bad = studioColors({ palette: ["red", "#12"], mood: "wild" }, null);
  assert.ok(bad.wall.r >= 0 && bad.wall.r <= 255);
});

test("macro zoom never enlarges source pixels beyond 1.8x and says so", () => {
  assert.equal(MACRO_MAX_ZOOM, 1.8);
  const big = macroZoom(3000);
  assert.equal(big.zoom, 1);
  assert.equal(big.capped, false);
  const mid = macroZoom(1500);
  assert.ok(mid.zoom > 1.2 && mid.zoom < 1.3);
  const tiny = macroZoom(400);
  assert.equal(tiny.zoom, 1.8);
  assert.equal(tiny.capped, true);
});

test("bestWindow picks the most detailed opaque region by edge energy", () => {
  const w = 60,
    h = 40;
  const rgba = new Uint8Array(w * h * 4).fill(255);
  // plain grey everywhere, a checkerboard patch at x 40..55, y 10..30
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let v = 128;
      if (x >= 40 && x < 56 && y >= 10 && y < 30) v = (x + y) % 2 ? 250 : 5;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
    }
  const energy = edgeEnergy(rgba, w, h);
  const alpha = new Uint8Array(w * h).fill(255);
  const best = bestWindow(energy, alpha, w, h, 16, 20, 0.5, 1);
  assert.ok(best.x >= 36 && best.x <= 44, `x ${best.x}`);
  assert.ok(best.y >= 6 && best.y <= 14, `y ${best.y}`);
  // transparent areas are never chosen: remove the patch's opacity
  const gone = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) for (let x = 36; x < w; x++) gone[y * w + x] = 0;
  const e2 = edgeEnergy(
    rgba.map((v, i) => (i % 4 === 3 ? gone[(i - 3) / 4] : v)),
    w,
    h,
  );
  const b2 = bestWindow(e2, gone, w, h, 16, 20, 0.9, 1);
  assert.ok(b2.x + 16 <= 36 + 1);
});

test("hero motion: eases in, tilt settles to exactly zero, placement mirrors the expressions", () => {
  const m0 = heroMotion(0, 0.05);
  assert.ok(m0.scale < 1 && m0.tiltDeg > 1.9);
  const m = heroMotion(2.0, 0.05);
  assert.equal(m.tiltDeg, 0);
  assert.ok(m.scale > 1);
  const g: HeroGeometry = {
    srcW: 800,
    srcH: 600,
    dw: 800,
    dh: 600,
    iw: 880,
    ih: 660,
    pw: 880 + 160,
    ph: 660 + 160,
    pad: 80,
    push: 0.05,
    shadowW: 1000,
    shadowH: 200,
  };
  const p = heroPlacement(g, 2.0);
  assert.ok(Math.abs(p.width / p.height - 880 / 660) < 1e-9, "aspect preserved");
  assert.ok(Math.abs(p.left + p.width / 2 - 540) < 2, "centred horizontally");
});

test("whip: position runs 0 -> full frame, blur peaks mid-way and is large (not a cross-fade)", () => {
  const ps = Array.from({ length: WHIP_FRAMES }, (_, i) => whipParams(i));
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i].offset > ps[i - 1].offset);
  assert.ok(ps[0].offset < 60 && ps[ps.length - 1].offset > 1020);
  const peak = Math.max(...ps.map((p) => p.blur));
  assert.ok(peak > 150);
  assert.ok(ps[0].blur < peak / 2 && ps[ps.length - 1].blur < peak / 2);
});

test("whipFrame produces a 1080x1920 raw frame with horizontal smear only", async () => {
  const stripe = (c: string) =>
    sharp({ create: { width: 1080, height: 1920, channels: 3, background: c } })
      .composite([
        {
          input: Buffer.from(
            `<svg width="1080" height="1920"><rect x="500" width="80" height="1920" fill="#fff"/></svg>`,
          ),
        },
      ])
      .removeAlpha()
      .raw()
      .toBuffer();
  const a = await stripe("#102030"),
    b = await stripe("#a03010");
  const mid = await whipFrame(a, b, 3);
  assert.equal(mid.length, 1080 * 1920 * 3);
  // vertical lines are smeared horizontally: rows are (nearly) identical, columns carry all variation
  const row = (y: number) => mid.subarray(y * 1080 * 3, (y + 1) * 1080 * 3);
  let diff = 0;
  const r0 = row(100),
    r1 = row(1500);
  for (let i = 0; i < r0.length; i++) diff += Math.abs(r0[i] - r1[i]);
  assert.ok(diff / r0.length < 1, "rows match: blur is horizontal");
  // and the stripe really is blurred: no pixel stays pure white
  let white = 0;
  for (let x = 0; x < 1080; x++) if (r0[x * 3] > 250 && r0[x * 3 + 1] > 250) white++;
  assert.equal(white, 0);
});

import { chooseContextInk, chooseInk, blockRect, contextShade, DARK_INK, LIGHT_INK } from "../packages/renderers/film-art.ts";
import { contrastRatio } from "../packages/renderers/scene.ts";
import { hexToRgb } from "../packages/renderers/polish.ts";

const flat = (v: number | [number, number, number], n = 50) =>
  Array.from({ length: n }, () => (typeof v === "number" ? { r: v, g: v, b: v } : { r: v[0], g: v[1], b: v[2] }));

test("chooseInk: dark background -> light ink, light background -> dark ink, no outline needed", () => {
  const darkBg = chooseInk(flat([60, 28, 24])); // chocolate macro
  assert.equal(darkBg.ink, LIGHT_INK);
  assert.equal(darkBg.stroke, null);
  assert.ok(darkBg.contrast >= 4.5, `${darkBg.contrast}`);
  const lightBg = chooseInk(flat([235, 225, 205]));
  assert.equal(lightBg.ink, DARK_INK);
  assert.equal(lightBg.stroke, null);
  assert.ok(lightBg.contrast >= 4.5);
  // the failing case from the live cake: maroon ink on chocolate is never picked
  assert.notEqual(chooseInk(flat([70, 40, 34])).ink, "#2a0a12");
});

test("chooseInk: mid-grey picks the better ink and adds an opposing outline", () => {
  const mid = chooseInk(flat(118));
  assert.ok(mid.plain < 4.5, "plain contrast is short on mid-grey");
  assert.ok(mid.stroke, "outline added");
  const lightRgb = hexToRgb(LIGHT_INK),
    darkRgb = hexToRgb(DARK_INK);
  const better =
    contrastRatio(lightRgb, { r: 118, g: 118, b: 118 }) >= contrastRatio(darkRgb, { r: 118, g: 118, b: 118 })
      ? LIGHT_INK
      : DARK_INK;
  assert.equal(mid.ink, better);
  assert.equal(mid.stroke!.color, better === LIGHT_INK ? DARK_INK : LIGHT_INK);
  assert.ok(mid.contrast >= 4.5, "ink vs outline contrast guards legibility");
  // worst-case pixels count: a mostly dark region with bright highlights is not 'dark'
  const mixed = [...flat(20, 40), ...flat(250, 10)];
  assert.ok(chooseInk(mixed).stroke || chooseInk(mixed).ink === LIGHT_INK);
});

test("chooseInk is deterministic and scrim levels are used before outlines", () => {
  const bright = flat([200, 190, 170]);
  assert.deepEqual(chooseInk(bright, { scrimLevels: [0.4, 0.6] }), chooseInk(bright, { scrimLevels: [0.4, 0.6] }));
  const withScrim = chooseInk(flat([150, 150, 150]), { scrimLevels: [0.2, 0.6, 0.8] });
  assert.equal(withScrim.ink, LIGHT_INK);
  assert.ok(withScrim.scrimAlpha > 0 && withScrim.stroke === null && withScrim.contrast >= 4.5);
});

test("chooseContextInk: shaded top of the frame, outline only as last resort", () => {
  const ys = Array.from({ length: 50 }, () => 150);
  const bright = chooseContextInk(flat([235, 232, 220]), ys);
  assert.ok(bright.contrast >= 4.5);
  const dark = chooseContextInk(flat([40, 40, 40]), ys);
  assert.equal(dark.ink, LIGHT_INK);
  assert.equal(dark.stroke, null);
  // shading only darkens
  const p = contextShade({ r: 200, g: 200, b: 200 }, 100, 0.5);
  assert.ok(p.r < 200);
  assert.deepEqual(contextShade({ r: 200, g: 200, b: 200 }, 1500, 0.5), { r: 200, g: 200, b: 200 });
});

test("blockRect stacks lines like the overlay y positions", () => {
  const r = blockRect([{ width: 300, height: 100 }, { width: 500, height: 100 }], 170, "left");
  assert.deepEqual([r.x, r.y, r.w, r.h], [54, 170, 500, 180]);
  const right = blockRect([{ width: 300, height: 100 }], 150, "right");
  assert.equal(right.x, 1080 - 54 - 300);
});

test("kineticLines with an outline renders a different, still valid PNG", async () => {
  const plain = await kineticLines("Dark velvet", "#f8f1e7");
  const outlined = await kineticLines("Dark velvet", "#f8f1e7", { stroke: { color: DARK_INK, width: 6 } });
  assert.equal(plain.length, outlined.length);
  assert.ok(!plain[0].png.equals(outlined[0].png));
  assert.equal((await sharp(outlined[0].png).metadata()).format, "png");
});
