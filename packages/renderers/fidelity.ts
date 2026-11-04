/**
 * Product-pixel fidelity of a composited reel frame.
 *
 * WHAT THIS MEASURES: compositing fidelity. For a frame, the source SAM cutout
 * is resampled (bilinear) into the box where the renderer says it placed the
 * product, and compared with what is actually in the (decoded, H.264) frame
 * over the product's opaque interior. A low difference means the encoder and
 * compositor kept the product's own pixels; it says nothing about whether the
 * cutout itself is a faithful picture of the real product, and the deliberate
 * light sweep counts as a difference. No thresholds are implied.
 *
 * Pure: no I/O. Frames are raw interleaved 8-bit buffers.
 */
export type RawImage = {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 3 | 4;
};
export type Placement = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type FidelityFrame = {
  t: number;
  frame: RawImage;
  /** Where the renderer put the product's bounding box on this frame. */
  placement: Placement;
};
export type FrameFidelity = {
  t: number;
  /** Mean absolute difference over the opaque interior, 0..255 per channel. */
  mad: number;
  /** mad / 255. */
  madNorm: number;
  /** Mean SSIM on luma over 7x7 windows fully inside the interior (null if none). */
  ssim: number | null;
  /** Pixels compared. */
  pixels: number;
  /** Integer shift (frame px) that best aligned the model to the frame. */
  offset: [number, number];
};
export type FidelityReport = {
  frames: FrameFidelity[];
  meanMad: number;
  meanMadNorm: number;
  meanSsim: number | null;
  maxMad: number;
};
export type FidelityOptions = {
  /** Source alpha (0..255) counted as opaque. Default 250. */
  opaqueAlpha?: number;
  /** Interior erosion in frame px so edge blending is excluded. Default 3. */
  erode?: number;
  /** Alignment search radius in px to absorb integer rounding. Default 2. */
  search?: number;
};

const luma = (r: number, g: number, b: number) =>
  0.299 * r + 0.587 * g + 0.114 * b;

/** Bilinear sample of an RGBA source at float coords (pixel centres at +0.5). */
function sample(src: RawImage, sx: number, sy: number, out: Float64Array) {
  const x = Math.min(Math.max(sx - 0.5, 0), src.width - 1);
  const y = Math.min(Math.max(sy - 0.5, 0), src.height - 1);
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, src.width - 1),
    y1 = Math.min(y0 + 1, src.height - 1);
  const fx = x - x0,
    fy = y - y0;
  const c = src.channels;
  const at = (xx: number, yy: number, k: number) =>
    src.data[(yy * src.width + xx) * c + k];
  for (let k = 0; k < 4; k++) {
    const kk = k === 3 && c === 3 ? -1 : k;
    const v = (xx: number, yy: number) => (kk < 0 ? 255 : at(xx, yy, kk));
    out[k] =
      v(x0, y0) * (1 - fx) * (1 - fy) +
      v(x1, y0) * fx * (1 - fy) +
      v(x0, y1) * (1 - fx) * fy +
      v(x1, y1) * fx * fy;
  }
}

/**
 * Source resampled into `placement` as a pixel grid (RGBA floats). The grid
 * covers the integer box [floor(left), ceil(left+width)) x [...) of the frame.
 */
export function resampleToPlacement(src: RawImage, p: Placement) {
  const x0 = Math.floor(p.left),
    y0 = Math.floor(p.top);
  const w = Math.ceil(p.left + p.width) - x0,
    h = Math.ceil(p.top + p.height) - y0;
  const rgba = new Float64Array(w * h * 4);
  const px = new Float64Array(4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = ((x0 + x + 0.5 - p.left) / p.width) * src.width;
      const sy = ((y0 + y + 0.5 - p.top) / p.height) * src.height;
      if (sx < 0 || sy < 0 || sx > src.width || sy > src.height) {
        rgba.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 4);
        continue;
      }
      sample(src, sx, sy, px);
      rgba.set(px, (y * w + x) * 4);
    }
  return { x0, y0, w, h, rgba };
}

/** Binary mask eroded by `r` px (square structuring element). */
export function erodeMask(mask: Uint8Array, w: number, h: number, r: number) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let d = -r; d <= r && ok; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= w || !mask[y * w + xx]) ok = 0;
      }
      tmp[y * w + x] = ok;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let d = -r; d <= r && ok; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= h || !tmp[yy * w + x]) ok = 0;
      }
      out[y * w + x] = ok;
    }
  return out;
}

function compare(
  frame: RawImage,
  grid: ReturnType<typeof resampleToPlacement>,
  mask: Uint8Array,
  dx: number,
  dy: number,
  stride: number,
) {
  let sum = 0,
    n = 0;
  for (let y = 0; y < grid.h; y += stride)
    for (let x = 0; x < grid.w; x += stride) {
      if (!mask[y * grid.w + x]) continue;
      const fx = grid.x0 + x + dx,
        fy = grid.y0 + y + dy;
      if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) continue;
      const fo = (fy * frame.width + fx) * frame.channels;
      const go = (y * grid.w + x) * 4;
      sum +=
        Math.abs(frame.data[fo] - grid.rgba[go]) +
        Math.abs(frame.data[fo + 1] - grid.rgba[go + 1]) +
        Math.abs(frame.data[fo + 2] - grid.rgba[go + 2]);
      n += 3;
    }
  return n ? sum / n : Infinity;
}

export function measureFrame(
  f: FidelityFrame,
  source: RawImage,
  opts: FidelityOptions = {},
): FrameFidelity {
  const opaque = opts.opaqueAlpha ?? 250;
  const grid = resampleToPlacement(source, f.placement);
  const raw = new Uint8Array(grid.w * grid.h);
  for (let i = 0; i < raw.length; i++)
    raw[i] = grid.rgba[i * 4 + 3] >= opaque ? 1 : 0;
  const mask = erodeMask(raw, grid.w, grid.h, opts.erode ?? 3);
  // Alignment search on a sub-sampled grid, then exact measurement at the best shift.
  const r = Math.max(0, Math.floor(opts.search ?? 2));
  let best = { dx: 0, dy: 0, v: Infinity };
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const v = compare(f.frame, grid, mask, dx, dy, 3);
      if (v < best.v) best = { dx, dy, v };
    }
  const { dx, dy } = best;
  const fr = f.frame;
  let sum = 0,
    n = 0;
  for (let y = 0; y < grid.h; y++)
    for (let x = 0; x < grid.w; x++) {
      if (!mask[y * grid.w + x]) continue;
      const fx = grid.x0 + x + dx,
        fy = grid.y0 + y + dy;
      if (fx < 0 || fy < 0 || fx >= fr.width || fy >= fr.height) continue;
      const fo = (fy * fr.width + fx) * fr.channels;
      const go = (y * grid.w + x) * 4;
      sum +=
        Math.abs(fr.data[fo] - grid.rgba[go]) +
        Math.abs(fr.data[fo + 1] - grid.rgba[go + 1]) +
        Math.abs(fr.data[fo + 2] - grid.rgba[go + 2]);
      n += 3;
    }
  // SSIM on luma, 7x7 windows (stride 4) fully inside the mask.
  const C1 = (0.01 * 255) ** 2,
    C2 = (0.03 * 255) ** 2,
    K = 7;
  let ss = 0,
    sn = 0;
  for (let y = 0; y + K <= grid.h; y += 4)
    for (let x = 0; x + K <= grid.w; x += 4) {
      let inside = true;
      for (let j = 0; j < K && inside; j++)
        for (let i = 0; i < K; i++)
          if (!mask[(y + j) * grid.w + x + i]) {
            inside = false;
            break;
          }
      if (!inside) continue;
      let ma = 0,
        mb = 0,
        aa = 0,
        bb = 0,
        ab = 0;
      let ok = true;
      for (let j = 0; j < K && ok; j++)
        for (let i = 0; i < K; i++) {
          const fx = grid.x0 + x + i + dx,
            fy = grid.y0 + y + j + dy;
          if (fx < 0 || fy < 0 || fx >= fr.width || fy >= fr.height) {
            ok = false;
            break;
          }
          const fo = (fy * fr.width + fx) * fr.channels;
          const go = ((y + j) * grid.w + x + i) * 4;
          const a = luma(fr.data[fo], fr.data[fo + 1], fr.data[fo + 2]);
          const b = luma(grid.rgba[go], grid.rgba[go + 1], grid.rgba[go + 2]);
          ma += a;
          mb += b;
          aa += a * a;
          bb += b * b;
          ab += a * b;
        }
      if (!ok) continue;
      const m = K * K;
      ma /= m;
      mb /= m;
      const va = aa / m - ma * ma,
        vb = bb / m - mb * mb,
        cov = ab / m - ma * mb;
      ss +=
        ((2 * ma * mb + C1) * (2 * cov + C2)) /
        ((ma * ma + mb * mb + C1) * (va + vb + C2));
      sn++;
    }
  const mad = n ? sum / n : NaN;
  return {
    t: f.t,
    mad,
    madNorm: mad / 255,
    ssim: sn ? ss / sn : null,
    pixels: n / 3,
    offset: [dx, dy],
  };
}

/** Compare sampled frames against the source cutout (see file header). */
export function measureProductFidelity(
  frames: FidelityFrame[],
  source: RawImage,
  opts: FidelityOptions = {},
): FidelityReport {
  if (source.channels !== 4) throw new Error("source cutout must be RGBA");
  const per = frames.map((f) => measureFrame(f, source, opts));
  const ok = per.filter((p) => Number.isFinite(p.mad));
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  const ss = ok.map((p) => p.ssim).filter((v): v is number => v !== null);
  return {
    frames: per,
    meanMad: mean(ok.map((p) => p.mad)),
    meanMadNorm: mean(ok.map((p) => p.madNorm)),
    meanSsim: ss.length ? mean(ss) : null,
    maxMad: ok.length ? Math.max(...ok.map((p) => p.mad)) : NaN,
  };
}
