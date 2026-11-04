import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { renderReel } from "../packages/renderers/reel.ts";
import {
  decodeFrame,
  measureSceneFidelity,
} from "../packages/renderers/scene-fidelity.ts";
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

test("scene reel: plate + cutout renders a valid reel, Red Pen boxes still hit the text, fidelity is measurable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "axys-scene-"));
  try {
    const cutout = await cutoutPng();
    const spec = specFor(1);
    const r = await renderReel(
      spec,
      path.join(dir, "scene"),
      async () => {
        throw new Error("source photo must not be needed for a scene shot");
      },
      new Map(),
      new Map([["p0", cutout]]),
      [await platePng()],
    );
    assert.equal(r.scenes.length, 1);
    assert.equal(r.scenes[0].productId, "p0");
    const v = r.probe.streams.find(
      (s: { codec_type: string }) => s.codec_type === "video",
    );
    assert.equal(v.width, 1080);
    assert.equal(v.height, 1920);
    assert.ok(
      r.scenes[0].scrim.contrast >= 4.5,
      "text contrast target on the scrim",
    );
    const video = path.join(dir, "scene", "reel.mp4");
    await writeFile(path.join(dir, "bytes.mp4"), r.bytes);

    // 1. Red Pen: the box derived from layout maths still frames the price pill.
    const c = { reel: spec } as unknown as Campaign;
    const rect = reelRect(c, 0, "INR 129.00", true)!;
    assert.ok(rect, "box derivable");
    const frame = await decodeFrame(video, 3.0);
    const pill = colourBox(
      frame,
      hexToRgb("#233b31"),
      Math.floor(rect[1]) - 8,
      Math.ceil(rect[1] + rect[3]) + 8,
    );
    assert.ok(Math.abs(pill.x0 - rect[0]) <= 5, `x0 ${pill.x0} vs ${rect[0]}`);
    assert.ok(
      Math.abs(pill.x1 - (rect[0] + rect[2])) <= 5,
      `x1 ${pill.x1} vs ${rect[0] + rect[2]}`,
    );
    assert.ok(Math.abs(pill.y0 - rect[1]) <= 5, `y0 ${pill.y0} vs ${rect[1]}`);
    assert.ok(
      Math.abs(pill.y1 - (rect[1] + rect[3])) <= 5,
      `y1 ${pill.y1} vs ${rect[1] + rect[3]}`,
    );

    // 2. Fidelity: the real placement beats a deliberately wrong one by a wide margin.
    const times = [1.2, 3.2];
    const good = await measureSceneFidelity({
      video,
      shotIndex: 0,
      cutout,
      geometry: r.scenes[0].geometry,
      times,
    });
    const wrong = await measureSceneFidelity({
      video,
      shotIndex: 0,
      cutout,
      geometry: {
        ...r.scenes[0].geometry,
        contactRow: r.scenes[0].geometry.contactRow + 30,
      },
      times,
      options: { search: 0 },
    });
    assert.ok(
      Number.isFinite(good.meanMad) &&
        good.frames.every((f) => f.pixels > 10000),
    );
    assert.ok(
      good.meanMad < wrong.meanMad / 2,
      `${good.meanMad} vs ${wrong.meanMad}`,
    );
    assert.ok(good.meanSsim! > wrong.meanSsim!);
    console.log(
      `scene fidelity (synthetic): meanMad=${good.meanMad.toFixed(2)}/255 meanSsim=${good.meanSsim!.toFixed(3)} control meanMad=${wrong.meanMad.toFixed(2)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scene fallbacks: no plate gives the cutout reel, no cutout gives the baseline reel; extra products reuse the first plate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "axys-scene-fb-"));
  try {
    const cutout = await cutoutPng();
    const photo = await sharp({
      create: { width: 600, height: 600, channels: 3, background: "#7a8" },
    })
      .png()
      .toBuffer();
    const read = async () => photo;
    const noPlate = await renderReel(
      specFor(1),
      path.join(dir, "a"),
      read,
      new Map(),
      new Map([["p0", cutout]]),
    );
    assert.equal(noPlate.scenes.length, 0);
    const base = await renderReel(
      specFor(1),
      path.join(dir, "b"),
      read,
      new Map(),
      new Map(),
      [await platePng()],
    );
    assert.equal(base.scenes.length, 0);
    // two products, one plate, cutout only for the second: first is baseline, second a scene
    const mixed = await renderReel(
      specFor(2),
      path.join(dir, "c"),
      read,
      new Map(),
      new Map([["p1", cutout]]),
      [await platePng()],
    );
    assert.deepEqual(
      mixed.scenes.map((s) => s.index),
      [1],
    );
    const v = mixed.probe.streams.find(
      (s: { codec_type: string }) => s.codec_type === "video",
    );
    assert.equal(v.height, 1920);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
