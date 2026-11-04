import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { alphaBounds, prepareCutout } from "../packages/renderers/cutout.ts";

test("cutout preparation crops to visible pixels and rejects empty or opaque images", async () => {
  const rgba = Buffer.alloc(4 * 4 * 4);
  rgba[(1 * 4 + 2) * 4 + 3] = 255;
  assert.deepEqual(alphaBounds(rgba, 4, 4), {
    left: 2,
    top: 1,
    width: 1,
    height: 1,
  });
  assert.equal(alphaBounds(Buffer.alloc(64), 4, 4), null);

  const art = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 200,
            height: 100,
            channels: 4,
            background: "#cc3322",
          },
        })
          .png()
          .toBuffer(),
        left: 300,
        top: 250,
      },
    ])
    .png()
    .toBuffer();
  const out = await prepareCutout(art);
  const meta = await sharp(out!).metadata();
  assert.equal(meta.width, 900);
  assert.ok(Math.abs(meta.height! - 450) <= 4);
  assert.equal(meta.hasAlpha, true);

  const empty = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  assert.equal(await prepareCutout(empty), null);
  const opaque = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  assert.equal(await prepareCutout(opaque), null);
  assert.equal(await prepareCutout(Buffer.from("not an image")), null);
});
