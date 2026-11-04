import { test } from "node:test";
import assert from "node:assert/strict";
import {
  erodeMask,
  measureProductFidelity,
  resampleToPlacement,
  type RawImage,
} from "../packages/renderers/fidelity.ts";
import { mulberry32 } from "../packages/renderers/polish.ts";

/** Textured RGBA "product": noisy blue ellipse on transparent. */
function product(w: number, h: number): RawImage {
  const rand = mulberry32(7);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / (w / 2),
        dy = (y + 0.5 - h / 2) / (h / 2);
      const inside = dx * dx + dy * dy <= 1;
      const n = Math.floor(rand() * 60);
      data.set(
        [
          40 + n + (x % 17) * 3,
          80 + n + (y % 13) * 4,
          150 + n,
          inside ? 255 : 0,
        ],
        (y * w + x) * 4,
      );
    }
  return { data, width: w, height: h, channels: 4 };
}
/** Paste `src` into an RGB frame at integer (left, top); background grey. */
function frameWith(
  src: RawImage,
  left: number,
  top: number,
  tweak = 0,
): RawImage {
  const fw = 400,
    fh = 400;
  const data = new Uint8Array(fw * fh * 3).fill(120);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const o = (y * src.width + x) * 4;
      if (src.data[o + 3] < 128) continue;
      const f = ((top + y) * fw + left + x) * 3;
      for (let k = 0; k < 3; k++)
        data[f + k] = Math.min(255, Math.max(0, src.data[o + k] + tweak));
    }
  return { data, width: fw, height: fh, channels: 3 };
}
const box = { left: 100, top: 150, width: 160, height: 120 };

test("identical placement scores a perfect match", () => {
  const src = product(160, 120);
  const r = measureProductFidelity(
    [{ t: 1, frame: frameWith(src, 100, 150), placement: box }],
    src,
  );
  assert.ok(r.frames[0].mad < 1e-9);
  assert.ok(r.frames[0].ssim! > 0.999, String(r.frames[0].ssim));
  assert.ok(r.frames[0].pixels > 8000);
  assert.deepEqual(r.frames[0].offset, [0, 0]);
});

test("a known brightness lift is reported as exactly that difference", () => {
  const src = product(160, 120);
  const r = measureProductFidelity(
    [{ t: 1, frame: frameWith(src, 100, 150, 10), placement: box }],
    src,
  );
  // +10 per channel, minus the few values clamped at 255
  assert.ok(r.meanMad > 9 && r.meanMad <= 10, String(r.meanMad));
  assert.ok(Math.abs(r.meanMadNorm - r.meanMad / 255) < 1e-12);
});

test("alignment search absorbs 1-2 px rounding, but a real misplacement is not hidden", () => {
  const src = product(160, 120);
  const frame = frameWith(src, 102, 149);
  const searched = measureProductFidelity(
    [{ t: 1, frame, placement: box }],
    src,
    { search: 2 },
  );
  assert.ok(searched.frames[0].mad < 1e-9);
  assert.deepEqual(searched.frames[0].offset, [2, -1]);
  const strict = measureProductFidelity(
    [{ t: 1, frame, placement: box }],
    src,
    { search: 0 },
  );
  assert.ok(strict.frames[0].mad > 5);
  const far = measureProductFidelity(
    [{ t: 1, frame: frameWith(src, 130, 150), placement: box }],
    src,
    { search: 2 },
  );
  assert.ok(far.frames[0].mad > 5 && far.frames[0].ssim! < 0.8);
});

test("scaled placement is compared against the resampled cutout; masks and edge cases", () => {
  const src = product(160, 120);
  const half = resampleToPlacement(src, {
    left: 0,
    top: 0,
    width: 80,
    height: 60,
  });
  const small: RawImage = {
    data: Uint8Array.from(half.rgba, (v) => Math.round(v)),
    width: 80,
    height: 60,
    channels: 4,
  };
  const r = measureProductFidelity(
    [
      {
        t: 2,
        frame: frameWith(small, 50, 60),
        placement: { left: 50, top: 60, width: 80, height: 60 },
      },
    ],
    src,
  );
  assert.ok(r.frames[0].mad < 1, String(r.frames[0].mad));
  const m = new Uint8Array(100).fill(1);
  const e = erodeMask(m, 10, 10, 2);
  assert.equal(e[0], 0, "border pixels erode away");
  assert.equal(e[5 * 10 + 5], 1);
  assert.equal(erodeMask(m, 10, 10, 0), m);
  assert.throws(() =>
    measureProductFidelity([], { ...src, channels: 3 } as RawImage),
  );
  const empty = measureProductFidelity([], src);
  assert.equal(empty.frames.length, 0);
  assert.ok(Number.isNaN(empty.meanMad));
});
