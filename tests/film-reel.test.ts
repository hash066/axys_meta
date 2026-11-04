import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { renderReel } from "../packages/renderers/reel.ts";
import { decodeFrame } from "../packages/renderers/scene-fidelity.ts";
import { measureFilmHeroFidelity } from "../packages/renderers/film-fidelity.ts";
import { buildHeroAssets, studioColors, FILM_DURATION, FACTS_VISIBLE_FROM } from "../packages/renderers/film-art.ts";
import { cropToAlpha } from "../packages/renderers/cutout.ts";
import { mulberry32, hexToRgb } from "../packages/renderers/polish.ts";
import { reelRect } from "../packages/meta/redpen.ts";
import type { Campaign, ReelSpec } from "../packages/campaign/index.ts";

/** Synthetic blue speckled "mug": noisy rounded body, transparent outside. */
async function cutoutPng() {
  const w = 420,
    h = 360;
  const rand = mulberry32(11);
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / (w / 2 - 6),
        dy = (y + 0.5 - h / 2) / (h / 2 - 6);
      const inside = Math.pow(Math.abs(dx), 4) + Math.pow(Math.abs(dy), 4) <= 1;
      const n = Math.floor(rand() * 50);
      px.set(
        [40 + n, 80 + n + (y >> 3), 160 + n, inside ? 255 : 0],
        (y * w + x) * 4,
      );
    }
  return sharp(px, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
}
/** Synthetic backdrop: warm gradient with soft noise, portrait. */
async function platePng() {
  const w = 640,
    h = 960;
  const rand = mulberry32(5);
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const n = Math.floor(rand() * 10);
      px.set([150 + (x >> 4) + n, 120 + (y >> 5) + n, 90 + n], (y * w + x) * 3);
    }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

const facts = (n: number) => ({
  business: "Clay & Co",
  offer: "Weekend sale",
  message: "",
  collection: "Saturday 7 November 2026, 10am-4pm",
  contact: "https://example.com",
  products: Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: i === 0 ? "ceramic mug" : "stoneware bowl",
    priceMinor: 12900,
    currency: "INR",
    assetId: "a",
  })),
});
const specFor = (n: number, style: "warm" | "bold" = "warm"): ReelSpec => ({
  schemaVersion: 1,
  style,
  caption: "",
  facts: facts(n) as ReelSpec["facts"],
  shots: facts(n).products.map((p) => ({
    productId: p.id,
    duration: 4,
    text: `${p.name}\nINR 129.00\nSaturday 7 November 2026, 10am-4pm`,
  })),
});

/** Bounding box (frame px) of pixels close to `rgb` inside rows [y0, y1). */
function colourBox(
  f: { data: Uint8Array; width: number },
  rgb: { r: number; g: number; b: number },
  y0: number,
  y1: number,
  tol = 40,
) {
  let x0 = Infinity,
    x1 = -1,
    ymin = Infinity,
    ymax = -1;
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < f.width; x++) {
      const o = (y * f.width + x) * 3;
      if (
        Math.abs(f.data[o] - rgb.r) < tol &&
        Math.abs(f.data[o + 1] - rgb.g) < tol &&
        Math.abs(f.data[o + 2] - rgb.b) < tol
      ) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
      }
    }
  return { x0, x1, y0: ymin, y1: ymax };
}


const direction = {
  category: "homeware",
  subject: "ceramic mug",
  descriptors: ["blue", "speckled"],
  palette: ["#2f5d8a", "#e8dcc8"],
  mood: "warm",
  motion: "calm",
  worlds: [],
  // the last two must never reach the screen (claims / digits)
  phrases: ["Made by hand", "Morning ritual", "50% off today", "Best mug ever"],
};

test("studio film: one 10 s film per product, facts card at the same place, hero pixels intact, honest fallbacks", { timeout: 600000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "axys-film-"));
  try {
    const cutout = await cutoutPng();
    const spec = specFor(2);
    const t0 = Date.now();
    const r = await renderReel(
      spec,
      path.join(dir, "film"),
      async () => {
        throw new Error("source photo must not be needed for a film");
      },
      new Map(),
      new Map([
        ["p0", cutout],
        ["p1", cutout],
      ]),
      [await platePng(), await platePng(), await platePng()],
      { direction, platePurposes: ["hero", "context", "detail"] },
    );
    const ms = Date.now() - t0;
    assert.deepEqual(r.layouts, ["film", "film"]);
    assert.ok(r.film && r.film.heroes.length === 2 && r.film.macros.length === 2);
    const v = r.probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    assert.equal(v.width, 1080);
    assert.equal(v.height, 1920);
    assert.ok(Math.abs(Number(r.probe.format.duration) - 2 * FILM_DURATION) < 0.2, `duration ${r.probe.format.duration}`);
    // the macro never enlarges source pixels beyond 1.8x
    for (const m of r.film!.macros) assert.ok(m.plan.zoom <= 1.8 + 1e-9);

    // Red Pen: at k*D + 8.0 each product's price pill sits exactly where layoutText puts it.
    const video = path.join(dir, "film", "reel.mp4");
    const c = { reel: spec } as unknown as Campaign;
    const rect = reelRect(c, 0, "INR 129.00", true)!;
    for (const k of [0, 1]) {
      const frame = await decodeFrame(video, k * FILM_DURATION + 8.0);
      const pill = colourBox(frame, hexToRgb("#233b31"), Math.floor(rect[1]) - 8, Math.ceil(rect[1] + rect[3]) + 8);
      assert.ok(Math.abs(pill.x0 - rect[0]) <= 6, `k${k} x0 ${pill.x0} vs ${rect[0]}`);
      assert.ok(Math.abs(pill.x1 - (rect[0] + rect[2])) <= 6, `k${k} x1`);
      assert.ok(Math.abs(pill.y0 - rect[1]) <= 6, `k${k} y0 ${pill.y0} vs ${rect[1]}`);
      assert.ok(Math.abs(pill.y1 - (rect[1] + rect[3])) <= 6, `k${k} y1`);
      // ... and it is NOT there during the hero or macro shots
      for (const t of [1.2, 3.6]) {
        const early = await decodeFrame(video, k * FILM_DURATION + t);
        const none = colourBox(early, hexToRgb("#233b31"), Math.floor(rect[1]), Math.ceil(rect[1] + rect[3]), 12);
        assert.ok(none.x1 < 0 || none.x1 - none.x0 < 100, `pill colour absent at ${t}s`);
      }
    }
    assert.ok(FACTS_VISIBLE_FROM <= 8.0 - 0.3, "card is fully in before the Studio seeks 8.0");

    // Hero fidelity: the product's own pixels are intact (compositing fidelity, see fidelity.ts).
    const geometry = r.film!.heroes[0].geometry;
    const good = await measureFilmHeroFidelity({ video, shotIndex: 0, cutout, geometry, times: [2.05, 2.35] });
    const wrong = await measureFilmHeroFidelity({
      video,
      shotIndex: 0,
      cutout,
      geometry: { ...geometry, dh: geometry.dh + 60 },
      times: [2.05, 2.35],
      options: { search: 0 },
    });
    assert.ok(good.frames.every((f) => f.pixels > 10000));
    assert.ok(good.meanMad < wrong.meanMad, `${good.meanMad} vs ${wrong.meanMad}`);
    assert.ok(good.meanMad < 30, `meanMad ${good.meanMad}`);
    console.log(
      `film (2 products, synthetic): ${ms} ms total; hero fidelity meanMad=${good.meanMad.toFixed(2)}/255 meanSsim=${good.meanSsim!.toFixed(3)} control meanMad=${wrong.meanMad.toFixed(2)}; timings ${JSON.stringify(r.film!.timings)}`,
    );
    // hero geometry is the same function the renderer used
    const again = await buildHeroAssets((await cropToAlpha(cutout))!, studioColors(direction, null), "calm");
    assert.equal(again.geometry.dw, geometry.dw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("film fallbacks: no direction -> scene look; a product without cutout -> baseline; direction without plates keeps the cutout look; a hero-only plate set gets a procedural context scene", { timeout: 300000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "axys-film-fb-"));
  try {
    const cutout = await cutoutPng();
    const photo = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#884422" } }).png().toBuffer();
    // direction missing: scene look
    const a = await renderReel(
      specFor(1),
      path.join(dir, "a"),
      async () => photo,
      new Map(),
      new Map([["p0", cutout]]),
      [await platePng()],
      {},
    );
    assert.deepEqual(a.layouts, ["scene"]);
    assert.equal(a.film, null);
    // one of two products has no cutout: the whole reel keeps the older looks
    const b = await renderReel(
      specFor(2),
      path.join(dir, "b"),
      async () => photo,
      new Map(),
      new Map([["p0", cutout]]),
      [],
      { direction },
    );
    assert.deepEqual(b.layouts, ["cutout", "baseline"]);
    // direction but no plate at all (plates=0): the flat cutout look
    const c = await renderReel(
      specFor(1),
      path.join(dir, "c"),
      async () => photo,
      new Map(),
      new Map([["p0", cutout]]),
      [],
      { direction },
    );
    assert.deepEqual(c.layouts, ["cutout"]);
    // a hero plate only: the context shot is a procedural studio set, no phrases is fine
    const d = await renderReel(
      specFor(1),
      path.join(dir, "d"),
      async () => photo,
      new Map(),
      new Map([["p0", cutout]]),
      [await platePng()],
      { direction: { ...direction, phrases: [] }, platePurposes: ["hero"] },
    );
    assert.deepEqual(d.layouts, ["film"]);
    assert.equal(d.filmFallback, null);
    assert.ok(Math.abs(Number(d.probe.format.duration) - FILM_DURATION) < 0.2);
    // temp clips and raw whip frames are cleaned up
    const left = (await readdir(path.join(dir, "d"))).filter((n) => /\.(rgb)$|^(hero|macro|ctx)-\d+\.mp4$/.test(n));
    assert.deepEqual(left, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
