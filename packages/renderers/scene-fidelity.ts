import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cropToAlpha } from "./cutout.ts";
import { command } from "./reel.ts";
import {
  measureProductFidelity,
  type FidelityOptions,
  type FidelityReport,
} from "./fidelity.ts";
import { productPlacement, type SceneGeometry } from "./scene.ts";

const TRANSITION = 0.45;
const SHOT = 4;

/** Decoded RGB frame at `seconds` of a video (1080x1920 rgb24). */
export async function decodeFrame(video: string, seconds: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "axys-frame-"));
  try {
    const out = path.join(dir, "f.png");
    await command(process.env.FFMPEG_PATH || "ffmpeg", [
      "-y",
      "-ss",
      seconds.toFixed(3),
      "-i",
      video,
      "-frames:v",
      "1",
      out,
    ]);
    const { data, info } = await sharp(out)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data: new Uint8Array(data),
      width: info.width,
      height: info.height,
      channels: 3 as const,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Compositing fidelity of one scene shot of a rendered reel: decodes frames at
 * `times` (seconds into that shot; keep them after the 0.9 s settle and before
 * the 3.55 s transition) and compares the product region against the source
 * cutout, resampled to where the renderer placed it. See fidelity.ts for what
 * this does and does not measure.
 */
export async function measureSceneFidelity(opts: {
  video: string;
  shotIndex: number;
  cutout: Buffer;
  geometry: SceneGeometry;
  times?: number[];
  options?: FidelityOptions;
}): Promise<FidelityReport> {
  const cropped = await cropToAlpha(opts.cutout);
  if (!cropped) throw new Error("cutout has no visible pixels");
  const src = await sharp(cropped)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const times = opts.times ?? [1.0, 1.6, 2.2, 2.8, 3.4];
  const origin = opts.shotIndex * (SHOT - TRANSITION);
  const frames = [];
  for (const t of times)
    frames.push({
      t,
      frame: await decodeFrame(opts.video, origin + t),
      placement: productPlacement(opts.geometry, t),
    });
  return measureProductFidelity(
    frames,
    {
      data: new Uint8Array(src.data),
      width: src.info.width,
      height: src.info.height,
      channels: 4,
    },
    opts.options,
  );
}
