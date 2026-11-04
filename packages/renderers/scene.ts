import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cropToAlpha } from "./cutout.ts";
import {
  hexToRgb,
  mixRgb,
  rgbToHex,
  type Palette,
  type Rgb,
} from "./polish.ts";

/**
 * Product-true scene shot: a Muse Image backdrop plate (no product in it) is
 * the full-bleed background, the real SAM cutout is composited on its tabletop
 * (never warped or regenerated), grounded by a contact + cast shadow tinted
 * from the plate. Layout/colour maths here is pure and deterministic; the
 * sharp/ffmpeg glue is at the bottom. Text is NOT drawn here: the caller adds
 * the same PNG text layers as the cutout look, at the same positions.
 */
export const W = 1080;
export const H = 1920;
export const FPS = 30;
/** Seconds of motion (the shot is trimmed to 4 s). */
export const SPAN = 4;
/**
 * Filter prefix that turns a single decoded still into 4.6 s of frames in memory.
 * (ffmpeg's `-loop 1` re-opens and re-decodes the image for EVERY frame, which is
 * pathologically slow for big noisy PNGs and stalls under file scanners.)
 */
export const STILL = `loop=loop=${Math.round(4.6 * 30) - 1}:size=1,setpts=N/(30*TB),fps=30,`;
/** Same as STILL for a clip of `seconds` (a film shot can run longer than 4.6 s). */
export const stillFor = (seconds: number) =>
  `loop=loop=${Math.max(1, Math.round(seconds * 30) - 1)}:size=1,setpts=N/(30*TB),fps=30,`;
export const ANCHOR_X = 540;
/** Frame y of the product's contact line (above the text block at y=1270). */
export const ANCHOR_Y = 1190;
export const TARGET_HEIGHT = Math.round(H * 0.36);
export const MAX_PRODUCT_W = 860;
export const PLATE_W = 1280; // plate is normalised to PLATE_W x H (cover fit)
/** Plate is upscaled this much inside ffmpeg so zoompan crops stay sub-pixel smooth. */
export const PLATE_UP = 1.5;
export const PLATE_MARGIN = (PLATE_W - W) / 2;
export const BG_ZOOM = 0.08;
export const BG_DRIFT_X = 5; // px the plate drifts over the shot (content moves left)
export const PRODUCT_ZOOM = 0.045;
export const PRODUCT_DRIFT_X = -18; // nearer than the plate, so it moves more
export const SETTLE = 0.8;
export const SETTLE_LIFT = 22;
export const SETTLE_SCALE = 0.03;
export const SWEEP_START = 1.0;
export const SWEEP_LEN = 2.2;
export const SWEEP_PEAK = 0.18; // max white mix at the band centre (subtle)
const SPRITE_OVERSAMPLE = 1.1;

/* ------------------------------ pure maths ------------------------------ */

export type SceneGeometry = {
  /** Source cutout (cropped to its alpha) size. */
  srcW: number;
  srcH: number;
  /** Displayed product size at motion scale 1. */
  dw: number;
  dh: number;
  /** Product sprite size (oversampled so ffmpeg mostly downsamples). */
  pw: number;
  ph: number;
  /** Shadow sprite (cropped to its visible pixels) and where the contact point sits in it (0..1). */
  cw: number;
  ch: number;
  shAx: number;
  shAy: number;
  /** Row (0-based, in the sprite) of the product's contact line + 1. */
  contactRow: number;
  /** Contact line x centre within the sprite, and its width. */
  footCx: number;
  footW: number;
};

/** Product is ~38% of the frame height, never wider than MAX_PRODUCT_W. */
export function sceneSize(srcW: number, srcH: number) {
  const k = Math.min(TARGET_HEIGHT / srcH, MAX_PRODUCT_W / srcW);
  return {
    dw: Math.max(8, Math.round(srcW * k)),
    dh: Math.max(8, Math.round(srcH * k)),
  };
}

const clamp01 = (u: number) => Math.min(Math.max(u, 0), 1);

/** Product motion at time t: scale, drift and the settle-in lift. */
export function productMotion(t: number) {
  const u = Math.pow(1 - clamp01(t / SETTLE), 3);
  return {
    scale: 1 + (PRODUCT_ZOOM * Math.min(t, SPAN)) / SPAN + SETTLE_SCALE * u,
    dx: (PRODUCT_DRIFT_X * Math.min(t, SPAN)) / SPAN,
    dy: -SETTLE_LIFT * u,
  };
}
/** Shadow stays on the table: no lift, no settle scale. */
export function shadowMotion(t: number) {
  return {
    scale: 1 + (PRODUCT_ZOOM * Math.min(t, SPAN)) / SPAN,
    dx: (PRODUCT_DRIFT_X * Math.min(t, SPAN)) / SPAN,
  };
}
export const sweepProgress = (t: number) =>
  clamp01((t - SWEEP_START) / SWEEP_LEN);

/**
 * Where the product's bounding box lands on the frame at time t, mirroring the
 * ffmpeg expressions (even-truncated scale, bottom-anchored at the contact line).
 */
export function productPlacement(g: SceneGeometry, t: number) {
  const m = productMotion(t);
  const k = (g.dw / g.pw) * m.scale;
  const w = Math.trunc((g.pw * k) / 2) * 2;
  const h = Math.trunc((g.ph * k) / 2) * 2;
  return {
    left: ANCHOR_X + m.dx - w / 2,
    top: ANCHOR_Y + m.dy - (h * g.contactRow) / g.ph,
    width: w,
    height: h,
  };
}

/* colour helpers */
export type Raw = { data: Uint8Array; width: number; height: number };
const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
export const relLuminance = (c: Rgb) =>
  0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
export const contrastRatio = (a: Rgb, b: Rgb) => {
  const x = relLuminance(a),
    y = relLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Pixels of an RGB raw image inside a fractional box (0..1 each side). */
function regionPixels(
  raw: Raw,
  fx0: number,
  fy0: number,
  fx1: number,
  fy1: number,
) {
  const x0 = Math.max(0, Math.floor(fx0 * raw.width)),
    x1 = Math.min(raw.width, Math.max(x0 + 1, Math.ceil(fx1 * raw.width)));
  const y0 = Math.max(0, Math.floor(fy0 * raw.height)),
    y1 = Math.min(raw.height, Math.max(y0 + 1, Math.ceil(fy1 * raw.height)));
  const out: Rgb[] = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * raw.width + x) * 3;
      out.push({ r: raw.data[o], g: raw.data[o + 1], b: raw.data[o + 2] });
    }
  return out;
}
export const meanColor = (px: Rgb[]): Rgb => {
  const n = Math.max(1, px.length);
  const s = px.reduce(
    (a, c) => ({ r: a.r + c.r, g: a.g + c.g, b: a.b + c.b }),
    { r: 0, g: 0, b: 0 },
  );
  return { r: s.r / n, g: s.g / n, b: s.b / n };
};
/** Colour of the pixel at luminance percentile p (0..1); deterministic. */
export function percentileColor(px: Rgb[], p: number): Rgb {
  if (!px.length) return { r: 0, g: 0, b: 0 };
  const sorted = px
    .map((c, i) => ({ c, i, l: relLuminance(c) }))
    .sort((a, b) => a.l - b.l || a.i - b.i);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].c;
}

export type PlateStats = {
  /** Mean colour under the text/scrim zone and its bright (p90) colour. */
  lower: Rgb;
  lowerBright: Rgb;
  /** Mean colour of the tabletop around the contact line. */
  footprint: Rgb;
  /** Direction the cast shadow falls: -1 left, +1 right (away from the brighter side). */
  castDir: -1 | 1;
};

/** Plate statistics from a small RGB thumbnail of the normalised plate. */
export function plateStats(thumb: Raw): PlateStats {
  // Frame x -> plate x adds PLATE_MARGIN; fractions are of the plate.
  const fx = (x: number) => (x + PLATE_MARGIN) / PLATE_W;
  const fy = (y: number) => y / H;
  const lowerPx = regionPixels(thumb, fx(0), fy(1100), fx(W), 1);
  const foot = regionPixels(
    thumb,
    fx(300),
    fy(ANCHOR_Y - 60),
    fx(780),
    fy(ANCHOR_Y + 120),
  );
  const left = meanColor(regionPixels(thumb, 0, 0, 0.5, fy(1000)));
  const right = meanColor(regionPixels(thumb, 0.5, 0, 1, fy(1000)));
  const diff = relLuminance(right) - relLuminance(left);
  return {
    lower: meanColor(lowerPx),
    lowerBright: percentileColor(lowerPx, 0.9),
    footprint: meanColor(foot),
    castDir: diff < -0.005 ? 1 : -1,
  };
}

/** Shadow colour comes from the plate: the local tabletop, darkened. */
export const shadowColor = (foot: Rgb): Rgb =>
  mixRgb(foot, { r: 0, g: 0, b: 0 }, 0.82);

export type ScrimPlan = {
  color: string;
  /** Peak opacity at the bottom of the frame. */
  alpha: number;
  /** Worst contrast ratio of the palette's text colours on the scrimmed plate. */
  contrast: number;
};
/**
 * Soft bottom scrim tinted from the plate (dark for the dark brand, light for
 * the warm brand). Opacity is the smallest value from 0.5 that gives the
 * palette's text colours >= `target` contrast on the plate's bright (p90)
 * colour, capped at 0.94.
 */
export function scrimPlan(
  plate: PlateStats,
  style: string,
  palette: Pick<Palette, "ink" | "muted">,
  target = 4.5,
): ScrimPlan {
  const light = style === "warm";
  const color = light
    ? mixRgb(plate.lower, { r: 255, g: 252, b: 246 }, 0.93)
    : mixRgb(plate.lower, { r: 0, g: 0, b: 0 }, 0.86);
  const texts = [hexToRgb(palette.ink), hexToRgb(palette.muted)];
  let alpha = 0.5,
    worst = 0;
  for (; alpha <= 0.94 + 1e-9; alpha += 0.02) {
    const bg = mixRgb(plate.lowerBright, color, alpha);
    worst = Math.min(...texts.map((t) => contrastRatio(t, bg)));
    if (worst >= target) break;
  }
  alpha = Math.min(alpha, 0.94);
  return {
    color: rgbToHex(color),
    alpha: Math.round(alpha * 100) / 100,
    contrast: worst,
  };
}

/** 3x3 alpha choke + soften on an RGBA buffer (edge pixels only; colours untouched). */
export function softenEdge(rgba: Uint8Array, w: number, h: number) {
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4 + 3];
  const er = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx)),
            yy = Math.min(h - 1, Math.max(0, y + dy));
          const v = a[yy * w + xx];
          if (v < m) m = v;
        }
      er[y * w + x] = m;
    }
  const out = Buffer.from(rgba);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx)),
            yy = Math.min(h - 1, Math.max(0, y + dy));
          s += er[yy * w + xx];
        }
      out[(y * w + x) * 4 + 3] = Math.round(s / 9);
    }
  return out;
}

/**
 * Spreads edge colours into fully transparent pixels (alpha untouched) so that
 * scaling in ffmpeg, which is not alpha-premultiplied, cannot pull black into
 * the product edge.
 */
export function bleedColors(
  rgba: Uint8Array,
  w: number,
  h: number,
  passes = 10,
) {
  const out = Buffer.from(rgba);
  let known = new Uint8Array(w * h);
  for (let i = 0; i < known.length; i++) known[i] = out[i * 4 + 3] > 0 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = Uint8Array.from(known);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (known[y * w + x]) continue;
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h || !known[yy * w + xx])
              continue;
            const o = (yy * w + xx) * 4;
            r += out[o];
            g += out[o + 1];
            b += out[o + 2];
            n++;
          }
        if (n) {
          const o = (y * w + x) * 4;
          out[o] = Math.round(r / n);
          out[o + 1] = Math.round(g / n);
          out[o + 2] = Math.round(b / n);
          next[y * w + x] = 1;
        }
      }
    known = next;
  }
  return out;
}

/** Contact line of an RGBA sprite: last row with real mass and its horizontal extent. */
export function contactLine(rgba: Uint8Array, w: number, h: number) {
  let yb = h - 1;
  const rowCount = (y: number) => {
    let n = 0;
    for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4 + 3] > 128) n++;
    return n;
  };
  while (yb > 0 && rowCount(yb) < Math.max(3, w * 0.02)) yb--;
  const y0 = Math.max(0, yb - Math.max(2, Math.round(h * 0.06)));
  let x0 = w,
    x1 = -1;
  for (let y = y0; y <= yb; y++)
    for (let x = 0; x < w; x++)
      if (rgba[(y * w + x) * 4 + 3] > 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
  if (x1 < 0) {
    x0 = 0;
    x1 = w - 1;
  }
  return { row: yb + 1, cx: (x0 + x1 + 1) / 2, width: x1 - x0 + 1 };
}

/* ------------------------- ffmpeg expression strings ------------------------- */
const f = (n: number) => String(+n.toFixed(5));
const T = "t";
export const expr = {
  productScale: `(1+${PRODUCT_ZOOM}*min(${T},${SPAN})/${SPAN}+${SETTLE_SCALE}*pow(1-min(${T}/${SETTLE},1),3))`,
  shadowScale: `(1+${PRODUCT_ZOOM}*min(${T},${SPAN})/${SPAN})`,
  dx: `(${PRODUCT_DRIFT_X}*min(${T},${SPAN})/${SPAN})`,
  dy: `(-${SETTLE_LIFT}*pow(1-min(${T}/${SETTLE},1),3))`,
};
const zoomExpr = `(1+${BG_ZOOM}*min((on/${FPS})/${SPAN},1))`;
const driftExpr = `(${BG_DRIFT_X}*min((on/${FPS})/${SPAN},1))`;

export type SceneFiles = {
  plate: string;
  product: string;
  shadow: string;
  band: string;
  scrim: string;
};
export type TextLayerLite = { delay: number; y: number; fadeOut: boolean };

/**
 * One scene shot's filter graph. Inputs from index `k`: plate, product,
 * shadow, sweep band, scrim, then the text layers (same overlay rule as the
 * cutout look). Returns the graph that ends in label `[v<i>]`.
 */
export type SceneShotOptions = {
  /** Seconds of output (default 4: the classic scene shot). */
  dur?: number;
  /** Fade the scrim in (seconds) instead of showing it from the first frame. */
  scrimFade?: { st: number; d: number };
  /** Return the graph ending in `[<label>]` (untrimmed) so the caller can keep compositing. */
  rawLabel?: string;
};
export function sceneShotFilter(
  i: number,
  k: number,
  g: SceneGeometry,
  layers: TextLayerLite[],
  opts: SceneShotOptions = {},
) {
  const dur = opts.dur ?? 4;
  const STILL = stillFor(dur + 0.6);
  const frames = Math.round((dur + 0.6) * FPS);
  const kp = f(g.dw / g.pw);
  const scale = (w: number, h: number, s: string) =>
    `scale=w='trunc(${w}*${kp}*${s}/2)*2':h='trunc(${h}*${kp}*${s}/2)*2':eval=frame:flags=bicubic`;
  const bf = f(g.contactRow / g.ph);
  const sax = f(g.shAx),
    say = f(g.shAy);
  let c =
    `[${k}:v]scale=${PLATE_W * PLATE_UP}:${H * PLATE_UP}:flags=bicubic,` +
    `zoompan=z='${zoomExpr}':x='${PLATE_UP}*(${PLATE_MARGIN}+${ANCHOR_X}-${ANCHOR_X}/${zoomExpr}+${driftExpr})':` +
    `y='${PLATE_UP}*(${ANCHOR_Y}-${ANCHOR_Y}/${zoomExpr})':d=${frames}:s=${W}x${H}:fps=${FPS},format=rgba[bg${i}];` +
    `[${k + 4}:v]${STILL}format=rgba${opts.scrimFade ? `,fade=t=in:st=${opts.scrimFade.st}:d=${opts.scrimFade.d}:alpha=1` : ""}[scr${i}];` +
    `[bg${i}][scr${i}]overlay=0:0:format=auto[pl${i}];` +
    // shadow (stays on the table)
    `[${k + 2}:v]${STILL}format=rgba,fade=t=in:st=0.1:d=0.7:alpha=1,${scale(g.cw, g.ch, expr.shadowScale)}[sh${i}];` +
    `[pl${i}][sh${i}]overlay=x='${ANCHOR_X}+${expr.dx}-w*${sax}':y='${ANCHOR_Y}-h*${say}':format=auto[a${i}];` +
    // product + light sweep (white lift through band x product alpha)
    `[${k + 1}:v]${STILL}format=rgba,split=2[pa${i}][pb${i}];` +
    `[pb${i}]alphaextract[pal${i}];` +
    `[${k + 3}:v]${STILL}format=gray,crop=w=${g.pw}:h=${g.ph}:x='(iw-${g.pw})*(1-min(max((t-${SWEEP_START})/${SWEEP_LEN},0),1))':y=0[bd${i}];` +
    `[bd${i}][pal${i}]blend=all_mode=multiply[mk${i}];` +
    `color=c=white:s=${g.pw}x${g.ph}:r=${FPS}:d=${dur + 0.6},format=rgba[wh${i}];` +
    `[wh${i}][mk${i}]alphamerge[sw${i}];` +
    `[pa${i}][sw${i}]overlay=format=auto[lit${i}];` +
    `[lit${i}]fade=t=in:st=0:d=0.35:alpha=1,${scale(g.pw, g.ph, expr.productScale)}[pr${i}];` +
    `[a${i}][pr${i}]overlay=x='${ANCHOR_X}+${expr.dx}-w/2':y='${ANCHOR_Y}+${expr.dy}-h*${bf}':format=auto[s${i}0];`;
  layers.forEach((layer, j) => {
    const d = layer.delay.toFixed(2);
    const fadeOut = layer.fadeOut ? ",fade=t=out:st=3.55:d=0.35:alpha=1" : "";
    c +=
      `[${k + 5 + j}:v]${STILL}format=rgba,fade=t=in:st=${d}:d=0.45:alpha=1${fadeOut}[tx${i}_${j}];` +
      `[s${i}${j}][tx${i}_${j}]overlay=x=0:y='${layer.y}+34*pow(1-min(max((t-${d})/0.6,0),1),3)':format=auto[s${i}${j + 1}];`;
  });
  if (opts.rawLabel) return c + `[s${i}${layers.length}]null[${opts.rawLabel}]`;
  return (
    c +
    `[s${i}${layers.length}]trim=duration=${dur},setpts=PTS-STARTPTS,fps=${FPS},setsar=1,format=yuv420p[v${i}]`
  );
}

/* ------------------------------ sharp glue ------------------------------ */

export type ScenePlan = {
  geometry: SceneGeometry;
  files: SceneFiles;
  scrim: ScrimPlan;
  stats: PlateStats;
};

/** Plate normalised to PLATE_W x H (cover fit) with its statistics. */
export async function preparePlate(plate: Buffer) {
  try {
    const png = await sharp(plate, { limitInputPixels: 80000000 })
      .rotate()
      .removeAlpha()
      .resize(PLATE_W, H, { fit: "cover", position: "centre" })
      .png({ compressionLevel: 4 })
      .toBuffer();
    const t = await sharp(png)
      .resize(64, 96, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      png,
      stats: plateStats({
        data: t.data,
        width: t.info.width,
        height: t.info.height,
      }),
    };
  } catch {
    return null;
  }
}

const svgWrap = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}">${body}</svg>`;

/** Sweep band: grey ramp, soft diagonal highlight (peak = SWEEP_PEAK of white), (pw + 1.4 pw) x ph. */
export async function buildBandPng(pw: number, ph: number, peakMix = SWEEP_PEAK) {
  const bw = Math.round(pw * 0.7);
  const bandW = pw + 2 * bw;
  const bc = bandW / 2;
  const peak = Math.round(peakMix * 255);
  const gv = (v: number) =>
    `rgb(${Math.round(v * peak)},${Math.round(v * peak)},${Math.round(v * peak)})`;
  const bandSvg = svgWrap(
    bandW,
    ph,
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${f(bc - bw / 2)}" y1="0" x2="${f(bc + bw / 2)}" y2="0" gradientTransform="rotate(-18 ${f(bc)} ${f(ph / 2)})"><stop offset="0" stop-color="${gv(0)}"/><stop offset="0.3" stop-color="${gv(0.35)}"/><stop offset="0.5" stop-color="${gv(1)}"/><stop offset="0.7" stop-color="${gv(0.35)}"/><stop offset="1" stop-color="${gv(0)}"/></linearGradient></defs><rect width="${bandW}" height="${ph}" fill="#000"/><rect width="${bandW}" height="${ph}" fill="url(#g)"/>`,
  );
  return sharp(Buffer.from(bandSvg)).removeAlpha().greyscale().png().toBuffer();
}

/**
 * Builds every static asset of a scene shot into `dir` (files named with
 * `tag`). Returns null if the cutout or plate is unusable, so the caller can
 * fall back to the flat-colour cutout shot.
 */
export async function buildScene(
  cutoutPng: Buffer,
  plate: NonNullable<Awaited<ReturnType<typeof preparePlate>>>,
  style: string,
  palette: Pick<Palette, "ink" | "muted">,
  dir: string,
  tag: string,
): Promise<ScenePlan | null> {
  const cropped = await cropToAlpha(cutoutPng);
  if (!cropped) return null;
  const meta = await sharp(cropped).metadata();
  const srcW = meta.width!,
    srcH = meta.height!;
  const { dw, dh } = sceneSize(srcW, srcH);
  const pw = Math.ceil(dw * SPRITE_OVERSAMPLE),
    ph = Math.max(8, Math.round((pw * srcH) / srcW));
  const resized = await sharp(cropped)
    .ensureAlpha()
    .resize(pw, ph, { kernel: "lanczos3" })
    .raw()
    .toBuffer();
  const soft = bleedColors(softenEdge(resized, pw, ph), pw, ph);
  const productPng = await sharp(soft, {
    raw: { width: pw, height: ph, channels: 4 },
  })
    .png()
    .toBuffer();
  const foot = contactLine(soft, pw, ph);
  const padX = Math.ceil(Math.max(0.55 * pw, 0.5 * ph));
  const padBottom = Math.ceil(ph * 0.22);
  const cw = pw + 2 * padX,
    ch = ph + padBottom;
  const geometry: SceneGeometry = {
    srcW,
    srcH,
    dw,
    dh,
    pw,
    ph,
    cw,
    ch,
    shAx: 0.5,
    shAy: 1,
    contactRow: foot.row,
    footCx: foot.cx,
    footW: foot.width,
  };

  // Shadow canvas: cast shadow (flattened, sheared silhouette) + contact shadow.
  const sc = rgbToHex(shadowColor(plate.stats.footprint));
  const dir_ = plate.stats.castDir;
  const silhouette = await sharp({
    create: { width: pw, height: ph, channels: 4, background: sc },
  })
    .composite([{ input: productPng, blend: "dest-in" }])
    .png()
    .toBuffer();
  const reach = 0.42,
    squash = 0.12;
  const e = padX + dir_ * reach * foot.row; // x' = x + dir*reach*(row - y)
  const fy = foot.row + squash * foot.row; // y' = row + squash*(row - y)
  const cxBase = padX + foot.cx;
  const far = cxBase + dir_ * (reach * ph + pw * 0.5);
  const rx = (foot.width / 2) * 1.06,
    ry = Math.max(8, rx * 0.2);
  const cy = foot.row - ry * 0.4;
  const shadowSvg = svgWrap(
    cw,
    ch,
    `<defs>
<filter id="b1" filterUnits="userSpaceOnUse" x="0" y="0" width="${cw}" height="${ch}"><feGaussianBlur stdDeviation="${Math.max(6, Math.round(ph * 0.014))}"/></filter>
<filter id="b2" filterUnits="userSpaceOnUse" x="0" y="0" width="${cw}" height="${ch}"><feGaussianBlur stdDeviation="${f(ry * 1.4)}"/></filter>
<filter id="b3" filterUnits="userSpaceOnUse" x="0" y="0" width="${cw}" height="${ch}"><feGaussianBlur stdDeviation="${f(ry * 0.45)}"/></filter>
<filter id="b4" filterUnits="userSpaceOnUse" x="0" y="0" width="${cw}" height="${ch}"><feGaussianBlur stdDeviation="${f(Math.max(3, ry * 0.18))}"/></filter>
<linearGradient id="fall" gradientUnits="userSpaceOnUse" x1="${f(cxBase)}" y1="0" x2="${f(far)}" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0.08"/></linearGradient>
<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${cw}" height="${ch}"><rect width="${cw}" height="${ch}" fill="url(#fall)"/></mask>
</defs>
<g mask="url(#m)" opacity="0.55"><g filter="url(#b1)"><image width="${pw}" height="${ph}" xlink:href="data:image/png;base64,${silhouette.toString("base64")}" transform="matrix(1 0 ${f(-dir_ * reach)} ${f(-squash)} ${f(e)} ${f(fy)})"/></g></g>
<ellipse cx="${f(cxBase)}" cy="${f(cy)}" rx="${f(rx * 1.25)}" ry="${f(ry * 2.2)}" fill="${sc}" fill-opacity="0.38" filter="url(#b2)"/>
<ellipse cx="${f(cxBase)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${sc}" fill-opacity="0.8" filter="url(#b3)"/>
<ellipse cx="${f(cxBase)}" cy="${f(foot.row - ry * 0.25)}" rx="${f(rx * 0.88)}" ry="${f(Math.max(3, ry * 0.45))}" fill="#000" fill-opacity="0.45" filter="url(#b4)"/>`,
  );
  const shadowRaw = await sharp(Buffer.from(shadowSvg))
    .ensureAlpha()
    .raw()
    .toBuffer()
    .catch(() => null);
  if (!shadowRaw) return null;
  // Crop to the visible shadow (the canvas is mostly empty) so ffmpeg scales far fewer pixels.
  let bx0 = cw,
    by0 = ch,
    bx1 = -1,
    by1 = -1;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      if (shadowRaw[(y * cw + x) * 4 + 3] > 1) {
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
  if (bx1 < 0) return null;
  const sx0 = Math.max(0, bx0 - 2),
    sy0 = Math.max(0, by0 - 2);
  const sw = Math.min(cw, bx1 + 3) - sx0,
    sh = Math.min(ch, by1 + 3) - sy0;
  const shadowPng = await sharp(bleedColors(shadowRaw, cw, ch), {
    raw: { width: cw, height: ch, channels: 4 },
  })
    .extract({ left: sx0, top: sy0, width: sw, height: sh })
    .png()
    .toBuffer();
  geometry.cw = sw;
  geometry.ch = sh;
  // anchor = product centre (x) and contact row (y), in canvas coords, matching the product overlay
  geometry.shAx = (padX + pw / 2 - sx0) / sw;
  geometry.shAy = (foot.row - sy0) / sh;

  const bandPng = await buildBandPng(pw, ph);

  // Scrim (+ faint top vignette), colour from the plate.
  const scrim = scrimPlan(plate.stats, style, palette);
  const top = rgbToHex(mixRgb(plate.stats.lower, { r: 0, g: 0, b: 0 }, 0.9));
  const stop = (o: number, a: number, c = scrim.color) =>
    `<stop offset="${o}" stop-color="${c}" stop-opacity="${f(a)}"/>`;
  const scrimSvg = svgWrap(
    W,
    H,
    `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">${stop(0, 0)}${stop(1040 / H, 0)}${stop(1190 / H, scrim.alpha * 0.3)}${stop(1290 / H, scrim.alpha * 0.8)}${stop(1420 / H, scrim.alpha)}${stop(1, scrim.alpha)}</linearGradient>
<linearGradient id="v" x1="0" y1="0" x2="0" y2="1">${stop(0, 0.22, top)}${stop(380 / H, 0, top)}</linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#v)"/><rect width="${W}" height="${H}" fill="url(#s)"/>`,
  );
  const scrimPng = await sharp(Buffer.from(scrimSvg)).png().toBuffer();

  const files: SceneFiles = {
    plate: path.join(dir, `plate-${tag}.png`),
    product: path.join(dir, `cutout-${tag}.png`),
    shadow: path.join(dir, `shadow-${tag}.png`),
    band: path.join(dir, `band-${tag}.png`),
    scrim: path.join(dir, `scrim-${tag}.png`),
  };
  await Promise.all([
    writeFile(files.plate, plate.png),
    writeFile(files.product, productPng),
    writeFile(files.shadow, shadowPng),
    writeFile(files.band, bandPng),
    writeFile(files.scrim, scrimPng),
  ]);
  return { geometry, files, scrim, stats: plate.stats };
}
