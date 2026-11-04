import sharp, { type OverlayOptions } from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alphaBounds } from "./cutout.ts";
import {
  hexToRgb,
  mixRgb,
  mulberry32,
  rgbToHex,
  type Rgb,
} from "./polish.ts";
import {
  bleedColors,
  buildBandPng,
  contrastRatio,
  percentileColor,
  relLuminance,
  softenEdge,
} from "./scene.ts";

/**
 * Art and pure maths for the "studio film" template: procedural studio
 * gradients, hero/macro stills, kinetic type (Anton via sharp text input, PNG
 * layers only) and whip-pan frames. Pure helpers are exported for tests; the
 * ffmpeg orchestration lives in film.ts.
 */
export const W = 1080;
export const H = 1920;
export const FPS = 30;
/** Seconds one product's film occupies; shot k covers [k*D, (k+1)*D). */
export const FILM_DURATION = 10;
/** The facts end card starts here (last 2.4 s of the interval). */
export const FACTS_VISIBLE_FROM = 7.6;
/** Whip transitions: 8 frames (0.267 s) centred on the cuts at 2.6 s and 5.0 s. */
export const WHIP_FRAMES = 8;
export const CUT_1 = 2.6;
export const CUT_2 = 5.0;
export const FRAMES_PER_FILM = FILM_DURATION * FPS;
/** First frame (within one film) of each whip window. */
export const WHIP_1_START = Math.round(CUT_1 * FPS) - WHIP_FRAMES / 2;
export const WHIP_2_START = Math.round(CUT_2 * FPS) - WHIP_FRAMES / 2;
/** Source pixels may be enlarged by at most this factor in the macro shot. */
export const MACRO_MAX_ZOOM = 1.8;
export const FONT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fonts",
  "Anton-Regular.ttf",
);

const clamp01 = (u: number) => Math.min(Math.max(u, 0), 1);
const easeOut = (u: number) => 1 - Math.pow(1 - clamp01(u), 3);

/* ------------------------------ direction ------------------------------ */

/** Muse Spark's read of the product (node worker validates; we re-sanitise what we draw). */
export type FilmDirection = {
  category?: string;
  subject?: string;
  descriptors?: string[];
  palette?: string[];
  mood?: string;
  motion?: string;
  worlds?: { purpose?: string; backdrop?: string }[];
  phrases?: string[];
};

const CLAIM =
  /(\d|[$€£₹%#@:/\\<>{}\[\]|*_=+~^`]|www|http|\.(com|in|co|io)\b|\b(best|top|only|never|always|guarantee[ds]?|free|organic|certified|award|cheapest|cheap|sale|offer|discount|off|new|official|genuine|original|authentic|100|no\.?1|number|worlds?|ever|proven|clinically|natural|vegan|safe|healthy|cure[sd]?|save|win|deal|limited|premium)\b)/i;
/**
 * A phrase is decoration only. Drops anything that could read as a claim
 * (digits, currency, superlatives, urls) and anything that is not plain Latin
 * text; max 3 words of at most 14 characters, 24 in total. Null when unusable.
 */
export function cleanPhrase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || CLAIM.test(t)) return null;
  if (!/^[A-Za-z][A-Za-z'’.,!?&\- ]*$/.test(t)) return null;
  const words = t.split(" ");
  if (words.length > 3 || words.some((w) => w.length > 14) || t.length > 24)
    return null;
  return t.replace(/’/g, "'");
}
export const cleanPhrases = (list: unknown): string[] =>
  (Array.isArray(list) ? list : [])
    .map(cleanPhrase)
    .filter((p): p is string => !!p)
    .slice(0, 3);

/* ------------------------------ colours ------------------------------ */

const sat = (c: Rgb) => {
  const mx = Math.max(c.r, c.g, c.b);
  return mx === 0 ? 0 : (mx - Math.min(c.r, c.g, c.b)) / mx;
};
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

export type StudioColors = {
  accent: Rgb;
  wall: Rgb;
  edge: Rgb;
  floor: Rgb;
  floorDeep: Rgb;
  shadow: Rgb;
  /** Type colour, dark on light walls and cream on dark ones. */
  ink: string;
  light: boolean;
};

/** Studio colours from the direction's palette and mood (deterministic). */
export function studioColors(
  d: FilmDirection | undefined,
  dominant: Rgb | null,
): StudioColors {
  const cols = (d?.palette ?? [])
    .filter((h) => typeof h === "string" && /^#[0-9a-f]{6}$/i.test(h))
    .map(hexToRgb);
  if (dominant) cols.push(dominant);
  // The most saturated colour wins; near-greys lose to anything with colour.
  const accent =
    [...cols].sort((a, b) => sat(b) - sat(a))[0] ?? { r: 196, g: 150, b: 110 };
  const peach = { r: 238, g: 190, b: 150 };
  let wall: Rgb;
  switch (d?.mood) {
    case "minimal":
      wall = mixRgb(accent, WHITE, 0.8);
      break;
    case "bold":
      wall = mixRgb(accent, BLACK, 0.18);
      break;
    case "luxe":
      wall = mixRgb(accent, BLACK, 0.72);
      break;
    case "playful":
      wall = mixRgb(accent, WHITE, 0.3);
      break;
    case "earthy":
      wall = mixRgb(mixRgb(accent, { r: 168, g: 132, b: 92 }, 0.5), WHITE, 0.3);
      break;
    case "fresh":
      wall = mixRgb(mixRgb(accent, { r: 190, g: 225, b: 225 }, 0.4), WHITE, 0.4);
      break;
    default: // warm: peach wall tinted by the product, like a sunlit studio
      wall = mixRgb(mixRgb(peach, accent, 0.3), WHITE, 0.16);
  }
  const light = relLuminance(wall) > 0.3;
  return {
    accent,
    wall,
    edge: mixRgb(wall, BLACK, light ? 0.38 : 0.55),
    floor: mixRgb(wall, BLACK, light ? 0.2 : 0.3),
    floorDeep: mixRgb(wall, BLACK, light ? 0.5 : 0.62),
    shadow: mixRgb(wall, BLACK, 0.8),
    ink: light ? rgbToHex(mixRgb(accent, BLACK, 0.82)) : "#f8f1e7",
    light,
  };
}

/* ------------------------------ backdrops ------------------------------ */

const f = (n: number) => String(+n.toFixed(2));
const grain = (w: number, h: number, seed: number) => {
  const rand = mulberry32(seed);
  const noise = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = rand() < 0.5 ? 0 : 255;
    noise[i * 4] = noise[i * 4 + 1] = noise[i * 4 + 2] = v;
    noise[i * 4 + 3] = 6;
  }
  return noise;
};

/**
 * Procedural studio set: lit wall with a diagonal window beam, soft horizon
 * into a darker floor, light pool behind the product, vignette and grain.
 * `horizon` is the y of the wall/floor seam, `lightY` the y of the light pool.
 */
export async function studioBackground(
  w: number,
  h: number,
  c: StudioColors,
  o: { horizon: number; lightX?: number; lightY: number; seed?: number; beam?: number },
) {
  const lx = o.lightX ?? w / 2;
  const hz = o.horizon;
  const hex = (x: Rgb) => rgbToHex(x);
  const pool = hex(mixRgb(c.wall, WHITE, c.light ? 0.5 : 0.18));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>
<radialGradient id="wall" gradientUnits="userSpaceOnUse" cx="${f(lx)}" cy="${f(o.lightY)}" r="${f(h * 0.78)}"><stop offset="0" stop-color="${pool}"/><stop offset="0.35" stop-color="${hex(c.wall)}"/><stop offset="1" stop-color="${hex(c.edge)}"/></radialGradient>
<linearGradient id="floor" gradientUnits="userSpaceOnUse" x1="0" y1="${f(hz - 90)}" x2="0" y2="${f(h)}"><stop offset="0" stop-color="${hex(c.floor)}" stop-opacity="0"/><stop offset="0.16" stop-color="${hex(c.floor)}" stop-opacity="0.55"/><stop offset="0.4" stop-color="${hex(c.floor)}" stop-opacity="0.9"/><stop offset="1" stop-color="${hex(c.floorDeep)}"/></linearGradient>
<radialGradient id="floorlight" gradientUnits="userSpaceOnUse" cx="${f(lx)}" cy="${f(hz + 160)}" r="${f(w * 0.75)}" gradientTransform="translate(0 ${f(hz + 160)}) scale(1 0.42) translate(0 ${f(-(hz + 160))})"><stop offset="0" stop-color="#fff" stop-opacity="${c.light ? 0.2 : 0.1}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<radialGradient id="vig" gradientUnits="userSpaceOnUse" cx="${f(w / 2)}" cy="${f(h * 0.46)}" r="${f(h * 0.72)}"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${c.light ? 0.3 : 0.5}"/></radialGradient>
<filter id="b1" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${f(w * 0.045)}"/></filter>
<filter id="b2"><feGaussianBlur stdDeviation="3"/></filter>
</defs>
<rect width="${w}" height="${h}" fill="url(#wall)"/>
<g filter="url(#b1)" opacity="${f(o.beam ?? 0.2)}"><polygon points="${f(-0.05 * w)},${f(h * 0.02)} ${f(0.42 * w)},0 ${f(1.1 * w)},${f(hz * 0.92)} ${f(0.52 * w)},${f(hz * 1.02)}" fill="#fff"/><polygon points="${f(0.5 * w)},0 ${f(0.64 * w)},0 ${f(1.1 * w)},${f(hz * 0.5)} ${f(1.1 * w)},${f(hz * 0.72)}" fill="#fff" opacity="0.7"/></g>
<rect y="${f(hz - 90)}" width="${w}" height="${f(h - hz + 90)}" fill="url(#floor)"/>
<rect y="${f(hz - 1)}" width="${w}" height="3" fill="#fff" opacity="${c.light ? 0.16 : 0.08}" filter="url(#b2)"/>
<rect width="${w}" height="${h}" fill="url(#floorlight)"/>
<rect width="${w}" height="${h}" fill="url(#vig)"/></svg>`;
  return sharp(Buffer.from(svg))
    .composite([
      { input: grain(w, h, o.seed ?? 0x5eed), raw: { width: w, height: h, channels: 4 } },
    ])
    .png({ compressionLevel: 3 })
    .toBuffer();
}

/** A supplied backdrop plate as hero/macro background: cover fit + the same vignette. */
export async function plateBackground(plate: Buffer, w: number, h: number, c: StudioColors) {
  const base = await sharp(plate, { limitInputPixels: 80000000 })
    .rotate()
    .removeAlpha()
    .resize(w, h, { fit: "cover" })
    .png()
    .toBuffer();
  const vig = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><radialGradient id="v" gradientUnits="userSpaceOnUse" cx="${w / 2}" cy="${h * 0.46}" r="${h * 0.72}"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${c.light ? 0.28 : 0.45}"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#v)"/></svg>`;
  return sharp(base)
    .composite([{ input: Buffer.from(vig) }])
    .png()
    .toBuffer();
}

/* ------------------------------ hero ------------------------------ */

export const HERO_CX = 540;
export const HERO_CY = 800;
export const HERO_BOX = { w: 960, h: 800 };
export const HERO_SWEEP_START = 0.5;
export const HERO_SWEEP_LEN = 1.5;
export const HERO_SETTLE = 0.8;
export const HERO_TILT_DEG = 2;
export const HERO_TILT_END = 1.5;
export const HERO_SHADOW_Y = 1262;

export type HeroGeometry = {
  srcW: number;
  srcH: number;
  /** Product box at scale 1 (frame px). */
  dw: number;
  dh: number;
  /** Sprite = product + transparent pad on every side. */
  pw: number;
  ph: number;
  pad: number;
  /** Product part of the sprite. */
  iw: number;
  ih: number;
  push: number;
  shadowW: number;
  shadowH: number;
};

/** Hero motion: ease-out scale-in, slow push, float, tilt that settles to 0. */
export function heroMotion(t: number, push: number) {
  const settle = 0.94 + 0.06 * easeOut(t / HERO_SETTLE);
  return {
    scale: settle * (1 + (push * Math.min(t, 2.8)) / 2.8),
    bob: -9 * Math.sin((2 * Math.PI * t) / 3.2),
    tiltDeg: HERO_TILT_DEG * (1 - easeOut(t / HERO_TILT_END)),
  };
}
/** Where the product's own box lands in the frame at time t (mirrors the ffmpeg expressions). */
export function heroPlacement(g: HeroGeometry, t: number) {
  const m = heroMotion(t, g.push);
  const k = (g.dw / g.iw) * m.scale; // sprite px -> frame px
  const sw = Math.trunc((g.pw * k) / 2) * 2,
    sh = Math.trunc((g.ph * k) / 2) * 2;
  return {
    left: HERO_CX - sw / 2 + g.pad * k,
    top: HERO_CY + m.bob - sh / 2 + g.pad * k,
    width: g.iw * k,
    height: g.ih * k,
  };
}
export const heroSweepExpr = (pw: number) =>
  `(iw-${pw})*(1-min(max((t-${HERO_SWEEP_START})/${HERO_SWEEP_LEN},0),1))`;

export async function buildHeroAssets(
  cropped: Buffer,
  c: StudioColors,
  motion: "calm" | "punchy",
) {
  const meta = await sharp(cropped).metadata();
  const srcW = meta.width!,
    srcH = meta.height!;
  const k = Math.min(HERO_BOX.w / srcW, HERO_BOX.h / srcH);
  const dw = Math.max(8, Math.round(srcW * k)),
    dh = Math.max(8, Math.round(srcH * k));
  const iw = Math.ceil(dw * 1.1),
    ih = Math.max(8, Math.round((iw * srcH) / srcW));
  const raw = await sharp(cropped)
    .ensureAlpha()
    .resize(iw, ih, { kernel: "lanczos3" })
    .raw()
    .toBuffer();
  const soft = bleedColors(softenEdge(raw, iw, ih), iw, ih);
  const pad = Math.ceil(Math.max(iw, ih) * 0.09);
  const pw = iw + 2 * pad,
    ph = ih + 2 * pad;
  const sprite = await sharp(soft, { raw: { width: iw, height: ih, channels: 4 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const g: HeroGeometry = {
    srcW,
    srcH,
    dw,
    dh,
    iw,
    ih,
    pw,
    ph,
    pad,
    push: motion === "punchy" ? 0.085 : 0.05,
    shadowW: 0,
    shadowH: 0,
  };
  // Floor shadow: wide soft ellipse + tighter core, tinted from the floor, on a canvas
  // with room for the blur (no clipped edges).
  const ew = Math.round(dw * 0.95),
    eh = Math.round(Math.max(40, dw * 0.1));
  const sp = 130;
  g.shadowW = ew + 2 * sp;
  g.shadowH = eh + 2 * sp;
  const sc = rgbToHex(c.shadow);
  const sw = g.shadowW,
    sh = g.shadowH;
  const shadow = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}"><defs><filter id="a" filterUnits="userSpaceOnUse" x="0" y="0" width="${sw}" height="${sh}"><feGaussianBlur stdDeviation="${f(eh * 0.55)}"/></filter><filter id="b" filterUnits="userSpaceOnUse" x="0" y="0" width="${sw}" height="${sh}"><feGaussianBlur stdDeviation="${f(eh * 0.22)}"/></filter></defs><ellipse cx="${sw / 2}" cy="${sh / 2}" rx="${f(ew / 2)}" ry="${f(eh / 2)}" fill="${sc}" fill-opacity="${c.light ? 0.42 : 0.65}" filter="url(#a)"/><ellipse cx="${sw / 2}" cy="${sh / 2}" rx="${f(ew * 0.3)}" ry="${f(eh * 0.2)}" fill="#000" fill-opacity="0.32" filter="url(#b)"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const band = await buildBandPng(pw, ph, 0.2);
  return { geometry: g, sprite, shadow, band };
}

/* ------------------------------ macro ------------------------------ */

export const MACRO_W = 1240;
export const MACRO_H = 2080;

/** Sobel gradient magnitude of the luma of an RGBA raw image, zero where transparent. */
export function edgeEnergy(rgba: Uint8Array, w: number, h: number) {
  const l = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    l[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (rgba[i * 4 + 3] < 200) continue;
      // Skip the silhouette rim: only count edges whose 3x3 neighbourhood is opaque.
      let solid = true;
      for (let dy = -1; dy <= 1 && solid; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (rgba[(i + dy * w + dx) * 4 + 3] < 200) {
            solid = false;
            break;
          }
      if (!solid) continue;
      const gx =
        l[i - w + 1] + 2 * l[i + 1] + l[i + w + 1] - l[i - w - 1] - 2 * l[i - 1] - l[i + w - 1];
      const gy =
        l[i + w - 1] + 2 * l[i + w] + l[i + w + 1] - l[i - w - 1] - 2 * l[i - w] - l[i - w + 1];
      e[i] = Math.hypot(gx, gy);
    }
  return e;
}

/**
 * Window (x, y, size ww x wh, all in the energy map's pixels) with the highest
 * mean edge energy whose area is at least `minCover` product. Integral images
 * make it O(w*h). Falls back to the window centred on the product's centre.
 */
export function bestWindow(
  energy: Float32Array,
  alpha: Uint8Array,
  w: number,
  h: number,
  ww: number,
  wh: number,
  minCover = 0.5,
  step = 2,
) {
  ww = Math.min(Math.max(2, Math.round(ww)), w);
  wh = Math.min(Math.max(2, Math.round(wh)), h);
  const integral = (get: (i: number) => number) => {
    const s = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += get(y * w + x);
        s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
      }
    }
    return s;
  };
  const sumE = integral((i) => energy[i]);
  const sumA = integral((i) => (alpha[i] >= 200 ? 1 : 0));
  const box = (s: Float64Array, x: number, y: number) =>
    s[(y + wh) * (w + 1) + x + ww] - s[y * (w + 1) + x + ww] - s[(y + wh) * (w + 1) + x] + s[y * (w + 1) + x];
  let best = { x: Math.round((w - ww) / 2), y: Math.round((h - wh) / 2), score: -1 };
  for (let y = 0; y + wh <= h; y += step)
    for (let x = 0; x + ww <= w; x += step) {
      const cover = box(sumA, x, y) / (ww * wh);
      if (cover < minCover) continue;
      const score = box(sumE, x, y) / (ww * wh);
      if (score > best.score) best = { x, y, score };
    }
  return best;
}

export type MacroPlan = {
  /** Display scale: frame pixels per source pixel (1 = native, >1 enlarges). */
  zoom: number;
  /** True when the source pixels are enlarged (zoom > 1). */
  upscaled: boolean;
  /** True when the zoom hit MACRO_MAX_ZOOM (the product is small in the source). */
  capped: boolean;
  /** Focus point in source (cropped cutout) pixels. */
  fx: number;
  fy: number;
};

/** Macro zoom: show the product ~1.7x frame-wide, never enlarging source pixels beyond 1.8x. */
export function macroZoom(srcW: number) {
  const want = (W * 1.7) / srcW;
  const zoom = Math.min(MACRO_MAX_ZOOM, Math.max(1, want));
  return { zoom, capped: want > MACRO_MAX_ZOOM };
}

export async function buildMacro(
  cropped: Buffer,
  c: StudioColors,
  bg: Buffer,
): Promise<{ png: Buffer; plan: MacroPlan }> {
  const meta = await sharp(cropped).metadata();
  const srcW = meta.width!,
    srcH = meta.height!;
  const { zoom, capped } = macroZoom(srcW);
  // Analyse a bounded copy to find the most detailed region.
  const sc = Math.min(1, 480 / Math.max(srcW, srcH));
  const aw = Math.max(8, Math.round(srcW * sc)),
    ah = Math.max(8, Math.round(srcH * sc));
  const small = await sharp(cropped).ensureAlpha().resize(aw, ah).raw().toBuffer();
  const energy = edgeEnergy(small, aw, ah);
  const alpha = new Uint8Array(aw * ah);
  for (let i = 0; i < aw * ah; i++) alpha[i] = small[i * 4 + 3];
  // Scoring window: the central sharp zone of the frame, in analysis pixels.
  const win = bestWindow(
    energy,
    alpha,
    aw,
    ah,
    (W * 0.6 * sc) / zoom,
    (H * 0.26 * sc) / zoom,
  );
  const fx = (win.x + (Math.round((W * 0.6 * sc) / zoom) || 2) / 2) / sc;
  const fy = (win.y + (Math.round((H * 0.26 * sc) / zoom) || 2) / 2) / sc;
  const plan: MacroPlan = { zoom, upscaled: zoom > 1.0001, capped, fx, fy };
  // Product scaled by `zoom`, focus point on the canvas centre (a little above it).
  const tw = Math.max(8, Math.round(srcW * zoom)),
    th = Math.max(8, Math.round(srcH * zoom));
  const scaled = await sharp(cropped)
    .ensureAlpha()
    .resize(tw, th, { kernel: "lanczos3" })
    .png()
    .toBuffer();
  const left = Math.round(MACRO_W / 2 - fx * zoom),
    top = Math.round(MACRO_H * 0.47 - fy * zoom);
  const ix0 = Math.max(0, left),
    iy0 = Math.max(0, top);
  const ix1 = Math.min(MACRO_W, left + tw),
    iy1 = Math.min(MACRO_H, top + th);
  const layers: OverlayOptions[] = [];
  if (ix1 > ix0 && iy1 > iy0) {
    const region = await sharp(scaled)
      .extract({ left: ix0 - left, top: iy0 - top, width: ix1 - ix0, height: iy1 - iy0 })
      .png()
      .toBuffer();
    // Soft drop shadow so the product separates from the wall.
    const sil = await sharp({
      create: { width: ix1 - ix0, height: iy1 - iy0, channels: 4, background: rgbToHex(c.shadow) },
    })
      .composite([{ input: region, blend: "dest-in" }])
      .png()
      .toBuffer();
    const shadowCanvas = await sharp({
      create: { width: MACRO_W, height: MACRO_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: sil, left: ix0, top: Math.min(MACRO_H - 1, iy0 + 46) }])
      .blur(34)
      .linear([1, 1, 1, 0.5], [0, 0, 0, 0])
      .png()
      .toBuffer();
    layers.push({ input: shadowCanvas }, { input: region, left: ix0, top: iy0 });
  }
  const sharpCanvas = await sharp(bg).composite(layers).png().toBuffer();
  // Shallow depth of field: blurred copy shown towards the top and bottom edges.
  const blurred = await sharp(sharpCanvas).removeAlpha().blur(20).raw().toBuffer();
  const mask = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${MACRO_W}" height="${MACRO_H}"><defs><linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="0.2" stop-color="#fff"/><stop offset="0.36" stop-color="#000"/><stop offset="0.6" stop-color="#000"/><stop offset="0.82" stop-color="#fff"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="${MACRO_W}" height="${MACRO_H}" fill="url(#m)"/></svg>`,
    ),
  )
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer();
  const blurLayer = await sharp(blurred, { raw: { width: MACRO_W, height: MACRO_H, channels: 3 } })
    .joinChannel(mask, { raw: { width: MACRO_W, height: MACRO_H, channels: 1 } })
    .png()
    .toBuffer();
  const png = await sharp(sharpCanvas)
    .composite([{ input: blurLayer }])
    .png({ compressionLevel: 3 })
    .toBuffer();
  return { png, plan };
}

/* ------------------------------ kinetic type ------------------------------ */

const pangoEscape = (s: string) =>
  s.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Splits a phrase into display lines: one word per line, small words join the next/previous one. */
export function phraseLines(phrase: string) {
  const lines: string[] = [];
  for (const w of phrase.toUpperCase().split(/\s+/).filter(Boolean)) {
    const prev = lines[lines.length - 1];
    if (prev !== undefined && (w.length <= 3 || prev.length <= 3) && prev.length + 1 + w.length <= 12)
      lines[lines.length - 1] = prev + " " + w;
    else lines.push(w);
  }
  return lines;
}

export type KineticLine = { png: Buffer; width: number; height: number };

/**
 * Anton, tightly tracked, one PNG per line (transparent, with a soft shadow
 * baked in). Size is the largest (<= maxSize) at which the widest line fits
 * `maxW`. Only sanitised phrases get here; markup is escaped regardless.
 */
export async function kineticLines(
  phrase: string,
  ink: string,
  opts: {
    maxW?: number;
    maxSize?: number;
    shadow?: boolean;
    /** Outline colour (hex) and width in px, from `chooseInk` when contrast is short. */
    stroke?: { color: string; width: number } | null;
  } = {},
): Promise<KineticLine[]> {
  const clean = cleanPhrase(phrase);
  if (!clean) return [];
  const lines = phraseLines(clean);
  const maxW = opts.maxW ?? 900,
    maxSize = opts.maxSize ?? 250;
  const text = async (t: string, size: number) => {
    const raw = await sharp({
      text: {
        text: `<span foreground="${ink}" letter_spacing="${Math.round(size * 0.015 * 1024)}">${pangoEscape(t)}</span>`,
        font: `Anton ${size}`,
        fontfile: FONT_FILE,
        rgba: true,
        dpi: 72,
        spacing: 0,
      },
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const b = alphaBounds(raw.data, raw.info.width, raw.info.height, 8);
    if (!b) return null;
    return sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: 4 } })
      .extract(b)
      .png()
      .toBuffer({ resolveWithObject: true });
  };
  const probe = await Promise.all(lines.map((l) => text(l, 200)));
  const widest = Math.max(1, ...probe.map((p) => p?.info.width ?? 0));
  const size = Math.round(Math.max(90, Math.min(maxSize, (200 * maxW) / widest)));
  const out: KineticLine[] = [];
  for (const l of lines) {
    const t = await text(l, size);
    if (!t) continue;
    const pad = 36;
    const canvasW = t.info.width + 2 * pad,
      canvasH = t.info.height + 2 * pad;
    const empty = { r: 0, g: 0, b: 0, alpha: 0 };
    const padded = await sharp(t.data)
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: empty })
      .png()
      .toBuffer();
    /** Flat-colour copy of the glyph shapes (exact colour, unlike tint). */
    const flat = (color: string, shape: Buffer = padded) =>
      sharp({ create: { width: canvasW, height: canvasH, channels: 4, background: color } })
        .composite([{ input: shape, blend: "dest-in" }])
        .png()
        .toBuffer();
    const layers: OverlayOptions[] = [];
    const st = opts.stroke;
    let outline: Buffer | null = null;
    if (st && st.width > 0) {
      // Outline = union of the glyphs shifted around a ring (16 directions).
      const solid = await flat(st.color);
      const ring: OverlayOptions[] = [];
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * 2 * Math.PI;
        ring.push({
          input: solid,
          left: Math.round(Math.cos(ang) * st.width),
          top: Math.round(Math.sin(ang) * st.width),
        });
      }
      outline = await sharp({ create: { width: canvasW, height: canvasH, channels: 4, background: empty } })
        .composite(ring)
        .png()
        .toBuffer();
    }
    if (opts.shadow !== false) {
      // Soft contact shadow, coloured like the outline (or black) so it always opposes the ink.
      const shadowColor = st?.color ?? "#000000";
      const sh = await sharp(await flat(shadowColor, outline ?? padded))
        .blur(9)
        .linear([1, 1, 1, 0.42], [0, 0, 0, 0])
        .png()
        .toBuffer();
      layers.push({ input: sh, left: 0, top: 6 });
    }
    if (outline) layers.push({ input: outline, left: 0, top: 0 });
    layers.push({ input: padded, left: 0, top: 0 });
    const png = await sharp({
      create: { width: canvasW, height: canvasH + 6, channels: 4, background: empty },
    })
      .composite(layers)
      .png()
      .toBuffer();
    out.push({ png, width: canvasW, height: canvasH + 6 });
  }
  return out;
}

/* ------------------------- legibility of kinetic type ------------------------- */

export const INK_TARGET = 4.5;
export const LIGHT_INK = "#f8f1e7";
export const DARK_INK = "#17120f";

/** Stacked block rectangle of kinetic lines (frame px) whose first line starts at `top`. */
export function blockRect(
  lines: { width: number; height: number }[],
  top: number,
  side: "left" | "right",
) {
  const w = Math.max(0, ...lines.map((l) => l.width));
  let h = 0;
  lines.forEach((l, i) => {
    h += i === lines.length - 1 ? l.height : Math.round(l.height * 0.8);
  });
  return { x: side === "left" ? 54 : W - 54 - w, y: top, w, h };
}

export type InkChoice = {
  ink: string;
  /** Outline colour/width, set when plain contrast is below the target. */
  stroke: { color: string; width: number } | null;
  /** Scrim opacity (0 = none) the caller must draw behind the type for this choice. */
  scrimAlpha: number;
  /** Worst-case contrast of the ink on the sampled background (before any outline). */
  plain: number;
  /** Contrast that guards legibility: plain, or ink vs outline when outlined. */
  contrast: number;
};

/**
 * Light or dark ink for type over sampled background pixels, deterministic.
 * Worst case is used: light ink is judged against the brightest (p90) pixel,
 * dark ink against the darkest (p10). `scrimLevels` are extra black scrim
 * opacities the caller can draw (tried in order for light ink; dark ink is
 * judged without a scrim). The first option reaching `target` wins, light ink
 * first; otherwise the better-contrast ink (light at the strongest scrim)
 * gets an opposing outline.
 */
export function chooseInk(
  bg: Rgb[],
  o: { target?: number; scrimLevels?: number[]; light?: string; dark?: string; size?: number } = {},
): InkChoice {
  const target = o.target ?? INK_TARGET;
  const light = o.light ?? LIGHT_INK,
    dark = o.dark ?? DARK_INK;
  const lightRgb = hexToRgb(light),
    darkRgb = hexToRgb(dark);
  const levels = o.scrimLevels?.length ? o.scrimLevels : [0];
  const black = { r: 0, g: 0, b: 0 };
  const worstLight = (a: number) =>
    contrastRatio(lightRgb, percentileColor(bg.map((p) => mixRgb(p, black, a)), 0.9));
  const worstDark = contrastRatio(darkRgb, percentileColor(bg, 0.1));
  const tries = levels.map((a) => ({ a, c: worstLight(a) }));
  for (const { a, c } of tries)
    if (c >= target) return { ink: light, stroke: null, scrimAlpha: a, plain: c, contrast: c };
  if (worstDark >= target)
    return { ink: dark, stroke: null, scrimAlpha: 0, plain: worstDark, contrast: worstDark };
  const strongest = tries[tries.length - 1];
  const width = Math.max(3, Math.round((o.size ?? 200) * 0.03));
  if (strongest.c >= worstDark)
    return {
      ink: light,
      stroke: { color: dark, width },
      scrimAlpha: strongest.a,
      plain: strongest.c,
      contrast: contrastRatio(lightRgb, darkRgb),
    };
  return {
    ink: dark,
    stroke: { color: light, width },
    scrimAlpha: 0,
    plain: worstDark,
    contrast: contrastRatio(darkRgb, lightRgb),
  };
}

export type ContextInk = InkChoice;
/**
 * Ink for the context shot's phrase: light ink under an increasingly strong top
 * scrim first, then dark ink without one, else the better ink with an outline
 * at the strongest scrim. `ys` are the frame rows of the sampled pixels.
 */
export function chooseContextInk(px: Rgb[], ys: number[], levels = [0.42, 0.58, 0.74]): ContextInk {
  const shade = (a: number) => px.map((p, i) => contextShade(p, ys[i], a));
  for (const a of levels) {
    const c = chooseInk(shade(a));
    if (c.ink === LIGHT_INK && !c.stroke) return { ...c, scrimAlpha: a };
  }
  const dark = chooseInk(shade(0));
  if (dark.ink === DARK_INK && !dark.stroke) return { ...dark, scrimAlpha: 0 };
  // outlined fallback: the outline carries legibility, so a middle scrim is enough
  const top = levels[Math.min(1, levels.length - 1)];
  const c = chooseInk(shade(top));
  return { ...c, scrimAlpha: c.ink === LIGHT_INK ? top : 0 };
}

/** RGB pixels of a rectangle of a PNG (coarse deterministic grid). */
export async function samplePixels(
  png: Buffer,
  rect: { x: number; y: number; w: number; h: number },
  step = 6,
): Promise<{ px: Rgb[]; ys: number[] }> {
  const meta = await sharp(png).metadata();
  const left = Math.max(0, Math.floor(rect.x)),
    top = Math.max(0, Math.floor(rect.y));
  const width = Math.min(meta.width! - left, Math.ceil(rect.w)),
    height = Math.min(meta.height! - top, Math.ceil(rect.h));
  if (width < 1 || height < 1) return { px: [], ys: [] };
  const { data, info } = await sharp(png)
    .extract({ left, top, width, height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px: Rgb[] = [],
    ys: number[] = [];
  for (let y = 0; y < info.height; y += step)
    for (let x = 0; x < info.width; x += step) {
      const o = (y * info.width + x) * 3;
      px.push({ r: data[o], g: data[o + 1], b: data[o + 2] });
      ys.push(top + y);
    }
  return { px, ys };
}

/** Colour of a context-shot pixel after its own top vignette and the type scrim. */
export function contextShade(p: Rgb, y: number, scrimAlpha: number): Rgb {
  const vig = y < 380 ? 0.22 * (1 - y / 380) : 0;
  const top = y < 720 ? scrimAlpha * (1 - y / 720) : 0;
  return mixRgb(p, { r: 0, g: 0, b: 0 }, 1 - (1 - vig) * (1 - top));
}

/** Brand name as small tracked caps (hero shot), centred, one PNG. */
export async function brandLayer(business: string, ink: string) {
  const t = business
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .toUpperCase()
    .slice(0, 40);
  if (!t.trim()) return null;
  const size = 30;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="64"><text x="${W / 2}" y="40" text-anchor="middle" fill="${ink}" fill-opacity="0.85" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="bold" letter-spacing="10">${pangoEscape(t)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/* ------------------------------ whip pan ------------------------------ */

/** Whip parameters for frame i of n: strip offset (px) and horizontal blur length (px, full res). */
export function whipParams(i: number, n = WHIP_FRAMES, punchy = false) {
  const u = (i + 0.5) / n;
  const ease = u * u * (3 - 2 * u); // smoothstep: position
  return {
    u,
    offset: Math.round(W * ease),
    blur: Math.round((punchy ? 300 : 240) * Math.pow(Math.sin(Math.PI * u), 0.9)) + 8,
  };
}

/**
 * One whip frame from the outgoing frame A and incoming frame B (raw RGB
 * 1080x1920x3 buffers; returns the same): the strip [A|B] slides left while a horizontal box blur (a real
 * directional blur, not a cross-fade) peaks mid-way.
 */
export async function whipFrame(a: Buffer, b: Buffer, i: number, punchy = false) {
  const p = whipParams(i, WHIP_FRAMES, punchy);
  const hw = W / 2,
    hh = H / 2;
  const half = async (img: Buffer) =>
    sharp(img, { raw: { width: W, height: H, channels: 3 } })
      .resize(hw, hh, { kernel: "linear" })
      .raw()
      .toBuffer();
  const [ra, rb] = await Promise.all([half(a), half(b)]);
  // Directional motion blur: mean of N windows spread along the pan direction,
  // at half resolution on the strip [A|B] (a real blur, not a cross-fade).
  const N = p.blur > 24 ? 40 : 4;
  const acc = new Uint16Array(hw * hh * 3);
  const rowBytes = hw * 3;
  for (let j = 0; j < N; j++) {
    const left = Math.min(
      hw,
      Math.max(0, Math.round((p.offset - p.blur / 2 + (p.blur * j) / (N - 1)) / 2)),
    );
    const s = left * 3; // byte offset of the window inside a strip row
    for (let y = 0; y < hh; y++) {
      const o = y * rowBytes;
      for (let x = 0; x < rowBytes; x++) {
        const k = s + x;
        acc[o + x] += k < rowBytes ? ra[o + k] : rb[o + k - rowBytes];
      }
    }
  }
  const out = Buffer.alloc(acc.length);
  // A touch of exposure at peak speed, like a fast pan.
  const gain = (1 + 0.07 * Math.sin(Math.PI * p.u)) / N;
  for (let k = 0; k < acc.length; k++) out[k] = Math.min(255, Math.round(acc[k] * gain));
  return sharp(out, { raw: { width: hw, height: hh, channels: 3 } })
    .resize(W, H, { kernel: "cubic" })
    .raw()
    .toBuffer();
}
