/**
 * Pure helpers for the cutout reel look (colour derivation, text fitting and
 * layout maths). Everything here is deterministic and free of I/O so it can be
 * unit tested; the sharp/ffmpeg glue lives in reel.ts and sprite.ts.
 */
export type Rgb = { r: number; g: number; b: number };

export const hexToRgb = (hex: string): Rgb => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Bad hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const clamp8 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
export const rgbToHex = ({ r, g, b }: Rgb) =>
  "#" + [r, g, b].map((v) => clamp8(v).toString(16).padStart(2, "0")).join("");
/** Linear mix: t=0 -> a, t=1 -> b. */
export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
});

/**
 * Dominant colour of the opaque pixels of an RGBA buffer. Pixels are bucketed
 * to 4 bits per channel and each bucket is weighted by count and saturation
 * so a coloured product beats a grey highlight. Ties resolve to the lowest
 * bucket key, so the result is fully deterministic. Null if nothing is opaque.
 */
export function dominantColor(
  rgba: Buffer | Uint8Array,
  width: number,
  height: number,
  minAlpha = 200,
): Rgb | null {
  const buckets = new Map<
    number,
    { n: number; r: number; g: number; b: number }
  >();
  const total = width * height;
  // Sample at most ~65k pixels on a fixed stride.
  const stride = Math.max(1, Math.floor(total / 65536));
  for (let p = 0; p < total; p += stride) {
    const o = p * 4;
    if (rgba[o + 3] < minAlpha) continue;
    const r = rgba[o],
      g = rgba[o + 1],
      b = rgba[o + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    buckets.set(key, e);
  }
  let best: { score: number; key: number; c: Rgb } | null = null;
  for (const [key, e] of buckets) {
    const c = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n };
    const mx = Math.max(c.r, c.g, c.b),
      mn = Math.min(c.r, c.g, c.b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    const score = e.n * (0.2 + sat);
    if (!best || score > best.score || (score === best.score && key < best.key))
      best = { score, key, c };
  }
  return best
    ? {
        r: Math.round(best.c.r),
        g: Math.round(best.c.g),
        b: Math.round(best.c.b),
      }
    : null;
}

export type Palette = {
  /** Spotlight centre colour behind the product. */
  center: string;
  /** Edge/vignette colour. */
  edge: string;
  ink: string;
  muted: string;
  pillFill: string;
  pillInk: string;
};

/** Brand background tinted by the product's dominant colour (or untinted). */
export function backgroundPalette(
  style: string,
  dominant: Rgb | null,
): Palette {
  const warm = style === "warm";
  const brand = hexToRgb(warm ? "#f4ecdf" : "#162b26");
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  const tint = dominant ? mixRgb(dominant, white, 0.3) : brand;
  const k = dominant ? 1 : 0;
  const center = warm
    ? mixRgb(mixRgb(brand, white, 0.55), tint, 0.05 * k)
    : mixRgb(brand, tint, 0.14 * k);
  const edge = warm
    ? mixRgb(mixRgb(brand, black, 0.03), tint, 0.14 * k)
    : mixRgb(mixRgb(brand, black, 0.35), tint, 0.05 * k);
  return {
    center: rgbToHex(center),
    edge: rgbToHex(edge),
    ink: warm ? "#233b31" : "#ffffff",
    muted: warm ? "#5d6d64" : "#b8cec7",
    pillFill: warm ? "#233b31" : "#f4ecdf",
    pillInk: warm ? "#f4ecdf" : "#162b26",
  };
}

/** Deterministic PRNG (mulberry32) for the film grain. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Strip control characters that are illegal in XML 1.0 (stricter than baseline). */
export const cleanText = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

/** Rough Arial advance width (px) used for wrapping and pill sizing. */
export function textWidth(text: string, size: number, bold = false) {
  let em = 0;
  for (const ch of Array.from(text)) {
    const c = ch.codePointAt(0)!;
    if (ch === " ") em += 0.278;
    else if (/[0-9]/.test(ch)) em += 0.556;
    else if (/[A-Z]/.test(ch)) em += ch === "I" ? 0.28 : 0.69;
    else if (/[a-z]/.test(ch))
      em += /[ijl]/.test(ch) ? 0.23 : /[mw]/.test(ch) ? 0.8 : 0.52;
    else if (c < 128) em += 0.33;
    else em += 1;
  }
  return em * size * (bold ? 1.07 : 1);
}

/** Greedy word wrap by measured width; over-long words are split by character. */
export function wrapByWidth(
  text: string,
  maxWidth: number,
  size: number,
  bold = false,
) {
  const lines: string[] = [];
  let line = "";
  const push = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (textWidth(w, size, bold) > maxWidth) {
      push();
      const chars = Array.from(w);
      let n = chars.length;
      while (
        n > 1 &&
        textWidth(chars.slice(0, n).join(""), size, bold) > maxWidth
      )
        n--;
      lines.push(chars.slice(0, n).join(""));
      w = chars.slice(n).join("");
    }
    const next = line ? line + " " + w : w;
    if (line && textWidth(next, size, bold) > maxWidth) {
      push();
      line = w;
    } else line = next;
  }
  push();
  return lines.length ? lines : [""];
}

/** Largest size from `sizes` that fits in `maxLines` (else the smallest). */
export function fitText(
  text: string,
  sizes: number[],
  maxWidth: number,
  maxLines: number,
  bold = false,
) {
  for (const size of sizes) {
    const lines = wrapByWidth(text, maxWidth, size, bold);
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrapByWidth(text, maxWidth, size, bold) };
}

/** Scale factor so a w x h cutout fits the product box (never above 1). */
export function productScale(w: number, h: number, maxW = 860, maxH = 940) {
  return Math.min(1, maxW / w, maxH / h);
}

export type TextBlock = {
  business: { text: string; size: number; y: number };
  name: { lines: string[]; size: number; y: number; lineHeight: number };
  price: {
    text: string;
    size: number;
    y: number;
    width: number;
    height: number;
  };
  details: { lines: string[]; size: number; y: number; lineHeight: number };
  end: number;
  ctaY: number;
};

/** Vertical stack of the reel text below the product (all y values are tops). */
export function layoutText(
  business: string,
  name: string,
  price: string,
  details: string,
  top = 1270,
): TextBlock {
  const maxW = 900;
  const n = fitText(name, [92, 80, 68, 58, 50], maxW, 2, true);
  const d = fitText(details, [36, 32, 28], maxW, 2);
  const nameLH = Math.round(n.size * 1.08);
  const detLH = Math.round(d.size * 1.3);
  const bizSize = 28;
  const nameTop = top + bizSize + 24;
  const pillH = 76;
  const priceTop = nameTop + n.lines.length * nameLH + 22;
  const priceSize = 40;
  const pillW = Math.round(textWidth(price, priceSize, true) + 76);
  const detTop = priceTop + pillH + 30;
  const end = detTop + d.lines.length * detLH;
  return {
    business: { text: business, size: bizSize, y: top },
    name: { lines: n.lines, size: n.size, y: nameTop, lineHeight: nameLH },
    price: {
      text: price,
      size: priceSize,
      y: priceTop,
      width: pillW,
      height: pillH,
    },
    details: { lines: d.lines, size: d.size, y: detTop, lineHeight: detLH },
    end,
    ctaY: Math.min(1762, Math.max(end + 30, 1740)),
  };
}
