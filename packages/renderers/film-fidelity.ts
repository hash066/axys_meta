import sharp from "sharp";
import { cropToAlpha } from "./cutout.ts";
import {
  measureProductFidelity,
  type FidelityOptions,
  type FidelityReport,
} from "./fidelity.ts";
import { FILM_DURATION, heroPlacement, type HeroGeometry } from "./film-art.ts";
import { decodeFrame } from "./scene-fidelity.ts";

/**
 * Compositing fidelity of the HERO shot of a rendered film (see fidelity.ts for
 * what that does and does not measure). Frames are taken after the scale-in
 * (0.8 s), after the tilt has settled to exactly 0 (1.5 s) and after the light
 * sweep ended (2.0 s), and before the whip starts (2.47 s). Film grain and
 * H.264 (twice: intermediate and final encode) count as differences.
 */
export async function measureFilmHeroFidelity(opts: {
  video: string;
  shotIndex: number;
  cutout: Buffer;
  geometry: HeroGeometry;
  times?: number[];
  options?: FidelityOptions;
}): Promise<FidelityReport> {
  const cropped = await cropToAlpha(opts.cutout);
  if (!cropped) throw new Error("cutout has no visible pixels");
  const src = await sharp(cropped)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const origin = opts.shotIndex * FILM_DURATION;
  const frames = [];
  for (const t of opts.times ?? [2.05, 2.2, 2.35, 2.45])
    frames.push({
      t,
      frame: await decodeFrame(opts.video, origin + t),
      placement: heroPlacement(opts.geometry, t),
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
