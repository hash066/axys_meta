import sharp from "sharp";
import {
  backgroundPalette,
  cleanText,
  dominantColor,
  mulberry32,
  productScale,
  textWidth,
  type Palette,
  type TextBlock,
} from "./polish.ts";

const W = 1080;
const H = 1920;
export const SPRITE_PAD = 110;
export const PRODUCT_CENTER_Y = 640;

export const xmlEscape = (s: string) =>
  cleanText(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );

/** Dominant colour of a prepared cutout PNG (bounded analysis copy). */
export async function cutoutDominant(png: Buffer) {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .resize(160, 160, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return dominantColor(data, info.width, info.height);
}

/**
 * Product sprite: the cutout with a soft drop shadow and a flattened contact
 * shadow baked underneath, padded evenly so the product centre is the sprite
 * centre (so scaling and floating in ffmpeg stay centred on the product).
 */
export async function buildSprite(cutout: Buffer) {
  const meta = await sharp(cutout).metadata();
  const k = productScale(meta.width!, meta.height!);
  const pw = Math.max(8, Math.round(meta.width! * k));
  const ph = Math.max(8, Math.round(meta.height! * k));
  const product = await sharp(cutout)
    .ensureAlpha()
    .resize(pw, ph)
    .png()
    .toBuffer();
  const sw = pw + SPRITE_PAD * 2;
  const sh = ph + SPRITE_PAD * 2;
  // Silhouette shadow: product alpha as black, blurred, offset downwards.
  const silhouette = await sharp({
    create: {
      width: pw,
      height: ph,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([{ input: product, blend: "dest-in" }])
    .png()
    .toBuffer();
  // sharp applies blur before compositing, so flatten the padded canvas first.
  const padded = await sharp({
    create: {
      width: sw,
      height: sh,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: silhouette, left: SPRITE_PAD, top: SPRITE_PAD + 26 }])
    .png()
    .toBuffer();
  const drop = await sharp(padded)
    .blur(24)
    .linear([1, 1, 1, 0.34], [0, 0, 0, 0])
    .png()
    .toBuffer();
  const cy = SPRITE_PAD + ph - 4;
  const contact = await sharp(
    Buffer.from(
      `<svg width="${sw}" height="${sh}"><ellipse cx="${sw / 2}" cy="${cy + 8}" rx="${Math.round(pw * 0.42)}" ry="20" fill="#000" fill-opacity="0.5"/></svg>`,
    ),
  )
    .blur(12)
    .png()
    .toBuffer();
  const sprite = await sharp({
    create: {
      width: sw,
      height: sh,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: drop },
      { input: contact },
      { input: product, left: SPRITE_PAD, top: SPRITE_PAD },
    ])
    .png()
    .toBuffer();
  return { png: sprite, width: sw, height: sh };
}

/** 1080x1920 brand background: spotlight gradient tinted by the product + grain. */
export async function buildBackground(palette: Palette) {
  const svg = `<svg width="${W}" height="${H}"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${W / 2}" cy="${PRODUCT_CENTER_Y}" r="1250"><stop offset="0" stop-color="${palette.center}"/><stop offset="1" stop-color="${palette.edge}"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
  const rand = mulberry32(0x5eed);
  const noise = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = rand() < 0.5 ? 0 : 255;
    noise[i * 4] = noise[i * 4 + 1] = noise[i * 4 + 2] = v;
    noise[i * 4 + 3] = 7;
  }
  return sharp(Buffer.from(svg))
    .composite([{ input: noise, raw: { width: W, height: H, channels: 4 } }])
    .png({ compressionLevel: 3 })
    .toBuffer();
}

export type TextLayer = {
  png: Buffer;
  y: number;
  delay: number;
  /** Fade out at the end of the shot (multi-product transitions). */
  fadeOut: boolean;
};

const layerSvg = (h: number, body: string) =>
  `<svg width="${W}" height="${h}">${body}</svg>`;
const font = 'font-family="Arial, Helvetica, sans-serif"';

/** Staggered text layers for a shot. */
export async function buildTextLayers(
  block: TextBlock,
  p: Palette,
  opts: { index: number; total: number; last: boolean; cta: string },
): Promise<TextLayer[]> {
  const raw: { svg: string; y: number; delay: number; fadeOut: boolean }[] = [];
  const b = block.business;
  raw.push({
    svg: layerSvg(
      b.size + 16,
      `<text x="${W / 2}" y="${b.size}" text-anchor="middle" fill="${p.muted}" ${font} font-size="${b.size}" font-weight="bold" letter-spacing="7">${xmlEscape(b.text.toUpperCase())}</text>`,
    ),
    y: b.y,
    delay: 0.3,
    fadeOut: !opts.last,
  });
  const n = block.name;
  raw.push({
    svg: layerSvg(
      n.lines.length * n.lineHeight + 20,
      n.lines
        .map(
          (line, j) =>
            `<text x="${W / 2}" y="${Math.round(n.size * 0.82 + j * n.lineHeight)}" text-anchor="middle" fill="${p.ink}" ${font} font-size="${n.size}" font-weight="bold" letter-spacing="-1">${xmlEscape(line)}</text>`,
        )
        .join(""),
    ),
    y: n.y,
    delay: 0.45,
    fadeOut: !opts.last,
  });
  const pr = block.price;
  if (pr.text.trim())
    raw.push({
      svg: layerSvg(
        pr.height,
        `<rect x="${(W - pr.width) / 2}" y="0" width="${pr.width}" height="${pr.height}" rx="${pr.height / 2}" fill="${p.pillFill}"/><text x="${W / 2}" y="${Math.round(pr.height / 2 + pr.size * 0.35)}" text-anchor="middle" fill="${p.pillInk}" ${font} font-size="${pr.size}" font-weight="bold">${xmlEscape(pr.text)}</text>`,
      ),
      y: pr.y,
      delay: 0.6,
      fadeOut: !opts.last,
    });
  const d = block.details;
  if (d.lines.some((l) => l.trim()))
    raw.push({
      svg: layerSvg(
        d.lines.length * d.lineHeight + 14,
        d.lines
          .map(
            (line, j) =>
              `<text x="${W / 2}" y="${Math.round(d.size + j * d.lineHeight)}" text-anchor="middle" fill="${p.muted}" ${font} font-size="${d.size}">${xmlEscape(line)}</text>`,
          )
          .join(""),
      ),
      y: d.y,
      delay: 0.75,
      fadeOut: !opts.last,
    });
  raw.push({
    svg: layerSvg(
      40,
      `<text x="${W / 2}" y="28" text-anchor="middle" fill="${p.muted}" ${font} font-size="24" letter-spacing="5">${xmlEscape(String(opts.index + 1).padStart(2, "0"))} / ${xmlEscape(String(opts.total).padStart(2, "0"))}</text>`,
    ),
    y: 1850,
    delay: 0.3,
    fadeOut: !opts.last,
  });
  if (opts.last) {
    const size = 36;
    const w = Math.round(textWidth(opts.cta, size, true) + 90);
    raw.push({
      svg: layerSvg(
        84,
        `<rect x="${(W - w) / 2 + 2}" y="2" width="${w - 4}" height="80" rx="40" fill="none" stroke="${p.ink}" stroke-width="3"/><text x="${W / 2}" y="${Math.round(42 + size * 0.35)}" text-anchor="middle" fill="${p.ink}" ${font} font-size="${size}" font-weight="bold">${xmlEscape(opts.cta)}</text>`,
      ),
      y: block.ctaY,
      delay: 2.3,
      fadeOut: false,
    });
  }
  return Promise.all(
    raw.map(async (r) => ({
      png: await sharp(Buffer.from(r.svg)).png().toBuffer(),
      y: r.y,
      delay: r.delay,
      fadeOut: r.fadeOut,
    })),
  );
}

export { backgroundPalette };
