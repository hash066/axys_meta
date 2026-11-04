import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANCHOR_Y,
  H,
  MAX_PRODUCT_W,
  TARGET_HEIGHT,
  W,
  bleedColors,
  contactLine,
  contrastRatio,
  percentileColor,
  plateStats,
  productMotion,
  productPlacement,
  sceneShotFilter,
  sceneSize,
  scrimPlan,
  shadowColor,
  shadowMotion,
  softenEdge,
  sweepProgress,
  type SceneGeometry,
} from "../packages/renderers/scene.ts";
import { backgroundPalette, layoutText } from "../packages/renderers/polish.ts";

const geom = (over: Partial<SceneGeometry> = {}): SceneGeometry => ({
  srcW: 650,
  srcH: 596,
  dw: 796,
  dh: 730,
  pw: 876,
  ph: 803,
  cw: 1840,
  ch: 980,
  shAx: 0.5,
  shAy: 0.8,
  contactRow: 803,
  footCx: 316,
  footW: 411,
  ...over,
});

/** Flat colour thumbnail, optionally brighter on the right half of the top. */
const thumb = (c: [number, number, number], rightBoost = 0) => {
  const width = 64,
    height = 96;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const boost = y < 45 && x >= 32 ? rightBoost : 0;
      data.set(
        c.map((v) => Math.min(255, v + boost)),
        (y * width + x) * 3,
      );
    }
  return { data, width, height };
};

test("product size follows the 35-42% height rule and the width cap", () => {
  const tall = sceneSize(300, 600);
  assert.ok(tall.dh / H >= 0.35 && tall.dh / H <= 0.42, String(tall.dh / H));
  assert.equal(tall.dh, TARGET_HEIGHT);
  const wide = sceneSize(1200, 400);
  assert.ok(wide.dw <= MAX_PRODUCT_W);
  const mug = sceneSize(650, 596);
  assert.ok(Math.abs(mug.dw / mug.dh - 650 / 596) < 0.01);
});

test("product motion settles in, drifts and keeps the contact line on the table", () => {
  const a = productMotion(0),
    b = productMotion(1),
    c = productMotion(4);
  assert.ok(
    a.dy < b.dy && b.dy === 0 && c.dy === 0,
    "settles down onto the table",
  );
  assert.ok(a.scale > productMotion(0.8).scale, "starts slightly larger");
  assert.ok(c.scale > b.scale, "slow push-in after settling");
  assert.ok(c.dx < b.dx, "parallax drift");
  assert.equal(shadowMotion(2).scale, 1 + (0.045 * 2) / 4);
  assert.equal(sweepProgress(0), 0);
  assert.equal(sweepProgress(9), 1);
  const g = geom();
  for (const t of [1, 2, 3, 4]) {
    const p = productPlacement(g, t);
    assert.ok(
      Math.abs(p.top + p.height - ANCHOR_Y) <= 2,
      `${t}: ${p.top + p.height}`,
    );
    assert.ok(p.top + p.height < 1270, "product never reaches the text block");
    assert.ok(p.left > 0 && p.left + p.width < W, "fully inside the frame");
  }
});

test("scrim is tinted from the plate and reaches text contrast on its brightest pixels", () => {
  const wood = plateStats(thumb([150, 110, 70]));
  for (const style of ["warm", "dark"]) {
    const palette = backgroundPalette(style, null);
    const plan = scrimPlan(wood, style, palette);
    assert.ok(plan.contrast >= 4.5, `${style} ${plan.contrast}`);
    assert.ok(plan.alpha >= 0.5 && plan.alpha <= 0.94);
    assert.deepEqual(scrimPlan(wood, style, palette), plan, "deterministic");
  }
  const light = plateStats(thumb([230, 225, 210]));
  const dark = scrimPlan(wood, "dark", backgroundPalette("dark", null));
  const darkOnLight = scrimPlan(light, "dark", backgroundPalette("dark", null));
  assert.notEqual(dark.color, darkOnLight.color, "colour comes from the plate");
  assert.ok(
    darkOnLight.alpha >= dark.alpha,
    "brighter plate needs a stronger scrim",
  );
});

test("shadow colour and cast direction come from the plate", () => {
  const base = plateStats(thumb([150, 110, 70]));
  const warmer = plateStats(thumb([180, 120, 60]));
  assert.notDeepEqual(
    shadowColor(base.footprint),
    shadowColor(warmer.footprint),
  );
  const s = shadowColor(base.footprint);
  assert.ok(s.r < base.footprint.r * 0.3 && s.g < base.footprint.g * 0.3);
  assert.equal(
    plateStats(thumb([100, 100, 100], 60)).castDir,
    -1,
    "light on the right: shadow falls left",
  );
  assert.equal(
    plateStats(thumb([160, 160, 160], 0)).castDir,
    -1,
    "no cue: defaults to left",
  );
  const leftLit = thumb([100, 100, 100]);
  for (let y = 0; y < 45; y++)
    for (let x = 0; x < 32; x++)
      leftLit.data.set([200, 200, 200], (y * 64 + x) * 3);
  assert.equal(plateStats(leftLit).castDir, 1);
  assert.deepEqual(percentileColor([], 0.9), { r: 0, g: 0, b: 0 });
  assert.ok(
    contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }) > 20.9,
  );
});

test("edge softening and colour bleeding only touch alpha edges and transparent pixels", () => {
  const w = 16,
    h = 16;
  const px = new Uint8Array(w * h * 4);
  for (let y = 4; y < 12; y++)
    for (let x = 4; x < 12; x++) px.set([200, 40, 30, 255], (y * w + x) * 4);
  const soft = softenEdge(px, w, h);
  for (let i = 0; i < w * h; i++) {
    assert.equal(soft[i * 4], px[i * 4], "rgb untouched");
    assert.equal(soft[i * 4 + 1], px[i * 4 + 1]);
  }
  assert.equal(soft[(8 * w + 8) * 4 + 3], 255, "interior stays opaque");
  assert.ok(soft[(4 * w + 4) * 4 + 3] < 255, "corner pixel choked");
  const bled = bleedColors(soft, w, h);
  assert.deepEqual(
    [...bled.subarray((2 * w + 2) * 4, (2 * w + 2) * 4 + 3)],
    [200, 40, 30],
  );
  assert.equal(bled[(2 * w + 2) * 4 + 3], 0, "alpha unchanged");
  assert.deepEqual(
    [...bled.subarray((8 * w + 8) * 4, (8 * w + 8) * 4 + 4)],
    [200, 40, 30, 255],
  );
  const line = contactLine(px, w, h);
  assert.equal(line.row, 12);
  assert.equal(line.width, 8);
});

test("scene filter graph draws no text and places text layers exactly like the cutout look", () => {
  const block = layoutText(
    "Clay & Co",
    "ceramic mug",
    "INR 129.00",
    "Saturday 7 November 2026",
    1270,
  );
  const layers = [
    { delay: 0.3, y: block.business.y, fadeOut: false },
    { delay: 0.6, y: block.price.y, fadeOut: true },
  ];
  const graph = sceneShotFilter(0, 0, geom(), layers);
  assert.ok(!/drawtext|subtitles/.test(graph), "text is only ever PNG layers");
  for (const l of layers)
    assert.ok(
      graph.includes(
        `y='${l.y}+34*pow(1-min(max((t-${l.delay.toFixed(2)})/0.6,0),1),3)'`,
      ),
    );
  assert.ok(graph.includes("fade=t=out:st=3.55:d=0.35:alpha=1"));
  assert.ok(graph.endsWith("[v0]"));
  assert.ok(
    graph.includes("1+0.08*min((on/30)/4,1)"),
    "plate push-in 1.00 -> 1.08",
  );
  assert.ok(
    graph.includes("-18*min(t,4)/4"),
    "product drifts at a different speed (parallax)",
  );
  assert.ok(graph.includes("zoompan"));
});
