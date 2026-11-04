import sharp from "sharp";

/** Bounding box of pixels with alpha above `threshold`, or null if empty. */
export function alphaBounds(
  rgba: Buffer,
  width: number,
  height: number,
  threshold = 16,
) {
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (rgba[(y * width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0
    ? null
    : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * Crops a SAM cutout PNG to its visible pixels and fits it inside the reel's
 * product area. Returns null when the image is empty or unreadable so the
 * caller falls back to the plain photo shot.
 */
export async function prepareCutout(
  png: Buffer,
  maxWidth = 900,
  maxHeight = 860,
) {
  try {
    const base = sharp(png, { limitInputPixels: 40000000 });
    const meta = await base.metadata();
    if (!meta.width || !meta.height || !meta.hasAlpha) return null;
    // Analyse a bounded-size copy, then map the box back to full resolution.
    const scale = Math.min(1, 1024 / Math.max(meta.width, meta.height));
    const small = await sharp(png)
      .ensureAlpha()
      .resize(
        Math.max(1, Math.round(meta.width * scale)),
        Math.max(1, Math.round(meta.height * scale)),
      )
      .raw()
      .toBuffer({ resolveWithObject: true });
    const box = alphaBounds(small.data, small.info.width, small.info.height);
    if (!box) return null;
    const left = Math.max(0, Math.floor(box.left / scale));
    const top = Math.max(0, Math.floor(box.top / scale));
    const width = Math.min(meta.width - left, Math.ceil(box.width / scale) + 1);
    const height = Math.min(
      meta.height - top,
      Math.ceil(box.height / scale) + 1,
    );
    if (width < 8 || height < 8) return null;
    return await sharp(png)
      .ensureAlpha()
      .extract({ left, top, width, height })
      .resize(maxWidth, maxHeight, {
        fit: "inside",
        withoutEnlargement: false,
      })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}
