import sharp from "sharp";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { ReelSpec } from "../campaign/index.ts";
import { prepareCutout } from "./cutout.ts";
import { command } from "./ffmpeg.ts";
import {
  buildScene,
  preparePlate,
  sceneShotFilter,
  STILL,
  type SceneGeometry,
  type ScenePlan,
} from "./scene.ts";
import {
  backgroundPalette,
  buildBackground,
  buildSprite,
  buildTextLayers,
  cutoutDominant,
  type TextLayer,
} from "./polish-art.ts";
import { cleanText, layoutText } from "./polish.ts";
import { renderFilm, type FilmDirection, type FilmReport } from "./film.ts";
const wrap = (text: string) => {
  const chars = Array.from(text),
    lines: string[] = [];
  for (let i = 0; i < chars.length; i += 38)
    lines.push(chars.slice(i, i + 38).join(""));
  return lines;
};
const xml = (s: string) =>
  s.replace(
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
export { command, type CommandOptions } from "./ffmpeg.ts";
/** Validates the encoded reel and extracts its poster frame. */
async function finishReel(out: string, dir: string, posterAt: string) {
  const probe = JSON.parse(
    await command(process.env.FFPROBE_PATH || "ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      out,
    ]),
  );
  const v = probe.streams.find(
    (s: { codec_type: string }) => s.codec_type === "video",
  );
  if (
    v.width !== 1080 ||
    v.height !== 1920 ||
    v.codec_name !== "h264" ||
    Number(probe.format.duration) < 3 ||
    Number(probe.format.size) > 100000000
  )
    throw new Error("Encoded video validation failed");
  const poster = path.join(dir, "poster.png");
  await command(process.env.FFMPEG_PATH || "ffmpeg", [
    "-y",
    "-i",
    out,
    "-ss",
    posterAt,
    "-frames:v",
    "1",
    poster,
  ]);
  return { bytes: await readFile(out), poster: await readFile(poster), probe };
}
export async function renderReel(
  spec: ReelSpec,
  dir: string,
  readAsset: (id: string) => Promise<Buffer>,
  generatedClips = new Map<string, Buffer>(),
  /** Optional SAM cutouts (PNG with alpha) keyed by product id. */
  cutouts = new Map<string, Buffer>(),
  /**
   * Optional product-free backdrop plates (PNG/JPEG). A product that has a SAM
   * cutout gets the product-true scene shot on plates[its index], else plates[0].
   */
  plates: Buffer[] = [],
  /**
   * Studio film (needs Muse Spark's `direction` AND a usable cutout for every
   * shot; any failure falls back to the scene/cutout/baseline looks).
   * `platePurposes[i]` labels plates[i] ("hero" | "context" | "detail").
   */
  film?: { direction?: FilmDirection; platePurposes?: (string | undefined)[] },
) {
  await mkdir(dir, { recursive: true });
  const photos: string[] = [];
  const overlays: string[] = [];
  const sourceKinds: ("photo" | "clip" | "cutout" | "scene")[] = [];
  const scenePlans = new Map<
    number,
    ScenePlan & { layers: TextLayer[]; layerFiles: string[] }
  >();
  const plateCache = new Map<
    Buffer,
    Awaited<ReturnType<typeof preparePlate>>
  >();
  /** Text layers of the cutout and scene looks: identical layout (Red Pen boxes depend on it). */
  const textLayersFor = async (
    i: number,
    shotText: string,
    palette: ReturnType<typeof backgroundPalette>,
  ) => {
    const [name = "", priceText = "", ...rest] =
      cleanText(shotText).split(/\r?\n/);
    const block = layoutText(
      cleanText(spec.facts.business),
      name,
      priceText,
      rest.join(" · "),
    );
    const layers = await buildTextLayers(block, palette, {
      index: i,
      total: spec.shots.length,
      last: i === spec.shots.length - 1,
      cta: "Message us to order →",
    });
    const layerFiles: string[] = [];
    for (let j = 0; j < layers.length; j++) {
      const f = path.join(dir, `text-${i}-${j}.png`);
      await writeFile(f, layers[j].png);
      layerFiles.push(f);
    }
    return { layers, layerFiles };
  };
  const filmEligible =
    !!film?.direction &&
    plates.length > 0 && // direction AND plates (plates=0 keeps the flat cutout look)
    spec.shots.length > 0 &&
    spec.shots.every(
      (s) => cutouts.has(s.productId) && !generatedClips.has(s.productId),
    );
  let filmFallback: string | null = null;
  if (filmEligible) {
    try {
      const palette = backgroundPalette(spec.style, null);
      const r = await renderFilm({
        spec,
        dir,
        cutouts,
        plates: plates.map((png, i) => ({
          png,
          purpose: film!.platePurposes?.[i],
        })),
        direction: film!.direction,
        textLayersFor,
        palette,
      });
      const done = await finishReel(r.out, dir, "1.4");
      return {
        ...done,
        renderMode: "motion-template-v2" as const,
        layouts: spec.shots.map(() => "film" as const) as (
          | "film"
          | "scene"
          | "cutout"
          | "baseline"
        )[],
        film: r as FilmReport | null,
        filmFallback: null as string | null,
        scenes: [] as {
          index: number;
          productId: string;
          geometry: SceneGeometry;
          scrim: ScenePlan["scrim"];
        }[],
      };
    } catch (e) {
      // Any film failure degrades to the scene/cutout/baseline looks below.
      filmFallback = e instanceof Error ? e.message.slice(0, 300) : "film failed";
      if (process.env.AXYS_FFMPEG_TRACE) console.error("[film] fallback:", e);
    }
  }
  const cutoutPlans = new Map<
    number,
    {
      sprite: { width: number; height: number };
      bgFile: string;
      layers: TextLayer[];
      layerFiles: string[];
    }
  >();
  for (let i = 0; i < spec.shots.length; i++) {
    const shot = spec.shots[i],
      product = spec.facts.products.find((p) => p.id === shot.productId)!;
    const warm = spec.style === "warm";
    const lines = [spec.facts.business, ...shot.text.split("\n")].flatMap(wrap);
    const svg = `<svg width="1080" height="1920"><defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${warm ? "#f4ecdf" : "#162b26"}" stop-opacity="0"/><stop offset="1" stop-color="${warm ? "#f4ecdf" : "#162b26"}" stop-opacity="1"/></linearGradient></defs><rect y="900" width="1080" height="1020" fill="url(#shade)"/><rect y="1030" width="1080" height="890" fill="${warm ? "#f4ecdf" : "#162b26"}"/>${lines.map((line, j) => `<text x="90" y="${1130 + j * 52}" fill="${warm ? "#233b31" : "#ffffff"}" font-family="Arial" font-size="36" font-weight="${j === 1 ? "bold" : "normal"}">${xml(line)}</text>`).join("")}<text x="90" y="1815" fill="${warm ? "#63736a" : "#b8cec7"}" font-family="Arial" font-size="25" letter-spacing="4">${xml(String(i + 1).padStart(2, "0"))} / ${xml(String(spec.shots.length).padStart(2, "0"))}</text></svg>`;
    const generated = generatedClips.get(product.id);
    const photoFile = path.join(
      dir,
      generated ? `generated-${i}.mp4` : `photo-${i}.png`,
    );
    const overlayFile = path.join(dir, `overlay-${i}.png`);
    if (!generated && plates.length && cutouts.has(product.id)) {
      const idx = spec.facts.products.findIndex((p) => p.id === product.id);
      const raw = plates[idx] ?? plates[0];
      if (!plateCache.has(raw)) plateCache.set(raw, await preparePlate(raw));
      const plate = plateCache.get(raw);
      const palette = backgroundPalette(spec.style, null);
      // Any failure building the scene falls back to the flat-colour cutout shot.
      const built = plate
        ? await buildScene(
            cutouts.get(product.id)!,
            plate,
            spec.style,
            palette,
            dir,
            String(i),
          ).catch(() => null)
        : null;
      if (built) {
        const text = await textLayersFor(i, shot.text, palette);
        scenePlans.set(i, { ...built, ...text });
        photos.push(built.files.plate);
        overlays.push(built.files.scrim);
        sourceKinds.push("scene");
        continue;
      }
    }
    const cutout =
      !generated && cutouts.has(product.id)
        ? await prepareCutout(cutouts.get(product.id)!)
        : null;
    if (cutout) {
      const cutoutFile = path.join(dir, `cutout-${i}.png`);
      const sprite = await buildSprite(cutout);
      await writeFile(cutoutFile, sprite.png);
      const palette = backgroundPalette(
        spec.style,
        await cutoutDominant(cutout),
      );
      const bgFile = path.join(dir, `bg-${i}.png`);
      await writeFile(bgFile, await buildBackground(palette));
      const { layers, layerFiles } = await textLayersFor(i, shot.text, palette);
      cutoutPlans.set(i, { sprite, bgFile, layers, layerFiles });
      photos.push(cutoutFile);
      overlays.push(bgFile);
      sourceKinds.push("cutout");
      continue;
    }
    if (generated) {
      await writeFile(photoFile, generated);
      sourceKinds.push("clip");
    } else {
      const photo = await sharp(await readAsset(product.assetId))
        .rotate()
        .resize(1400, 1400, { fit: "cover" })
        .png()
        .toBuffer();
      await writeFile(photoFile, photo);
      sourceKinds.push("photo");
    }
    await writeFile(
      overlayFile,
      await sharp(Buffer.from(svg)).png().toBuffer(),
    );
    photos.push(photoFile);
    overlays.push(overlayFile);
  }
  const args = ["-y"];
  // Input index of each shot's first input (cutout shots use extra inputs).
  const first: number[] = [];
  let inputs = 0;
  for (let i = 0; i < photos.length; i++) {
    first.push(inputs);
    if (sourceKinds[i] === "scene") {
      const sp = scenePlans.get(i)!;
      const fl = sp.files;
      // Plate is a single frame (zoompan expands it); the rest loop at 30 fps.
      args.push("-i", fl.plate);
      inputs++;
      for (const f of [
        fl.product,
        fl.shadow,
        fl.band,
        fl.scrim,
        ...sp.layerFiles,
      ]) {
        args.push("-i", f);
        inputs++;
      }
      continue;
    }
    if (sourceKinds[i] === "cutout") {
      const plan = cutoutPlans.get(i)!;
      for (const f of [photos[i], plan.bgFile, ...plan.layerFiles]) {
        args.push("-i", f);
        inputs++;
      }
      continue;
    }
    if (sourceKinds[i] === "photo")
      args.push("-loop", "1", "-t", "4.6", "-i", photos[i]);
    else args.push("-i", photos[i]);
    args.push("-loop", "1", "-t", "4.6", "-i", overlays[i]);
    inputs += 2;
  }
  args.push(
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
  );
  const transition = 0.45;
  /**
   * Cutout shot: tinted grain background, product pops in (ease-out scale and
   * fade), then pushes in slowly while floating a few pixels; text layers fade
   * up in sequence; the last shot ends on a call-to-action.
   */
  const cutoutShotFilter = (i: number, k: number) => {
    const plan = cutoutPlans.get(i)!;
    const ease = "(1-pow(1-min(t/0.55,1),3))";
    const scale = `(0.72+0.28*${ease}+0.05*t/4.6)`;
    const cy = 640;
    let chain =
      `[${k}:v]${STILL}format=rgba,fade=t=in:st=0:d=0.3:alpha=1,` +
      `scale=w='trunc(iw*${scale}/2)*2':h='trunc(ih*${scale}/2)*2':eval=frame[cut${i}];` +
      `[${k + 1}:v]${STILL}format=rgba[bg${i}];` +
      `[bg${i}][cut${i}]overlay=x='(W-w)/2':y='${cy}-h/2-7*sin(2*PI*t/3.6)':format=auto[s${i}0];`;
    plan.layers.forEach((layer, j) => {
      const d = layer.delay.toFixed(2);
      const fadeOut = layer.fadeOut ? ",fade=t=out:st=3.55:d=0.35:alpha=1" : "";
      chain +=
        `[${k + 2 + j}:v]${STILL}format=rgba,fade=t=in:st=${d}:d=0.45:alpha=1${fadeOut}[tx${i}_${j}];` +
        `[s${i}${j}][tx${i}_${j}]overlay=x=0:y='${layer.y}+34*pow(1-min(max((t-${d})/0.6,0),1),3)':format=auto[s${i}${j + 1}];`;
    });
    return (
      chain +
      `[s${i}${plan.layers.length}]trim=duration=4,setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
    );
  };
  const shotFilters = photos.map((_, i) => {
    const direction = i % 2 === 0 ? 1 : -1;
    const k = first[i];
    if (sourceKinds[i] === "scene")
      return sceneShotFilter(
        i,
        k,
        scenePlans.get(i)!.geometry,
        scenePlans.get(i)!.layers,
      );
    if (sourceKinds[i] === "cutout") return cutoutShotFilter(i, k);
    const base =
      sourceKinds[i] === "clip"
        ? `[${k}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,trim=duration=4,setpts=PTS-STARTPTS[base${i}];`
        : `[${k}:v]scale=1400:1400,crop=1400:1400,` +
          `zoompan=z='min(zoom+0.0011,1.14)':x='iw/2-(iw/zoom/2)+${direction}*sin(on/17)*8':y='ih/2-(ih/zoom/2)':d=138:s=1080x1030:fps=30,setsar=1[photo${i}];` +
          `color=c='${spec.style === "warm" ? "#f4ecdf" : "#162b26"}':s=1080x1920:d=4.6:r=30[canvas${i}];` +
          `[canvas${i}][photo${i}]overlay=0:0[base${i}];`;
    return (
      base +
      `[${k + 1}:v]format=rgba,fade=t=in:st=0:d=0.35:alpha=1,fade=t=out:st=3.55:d=0.35:alpha=1[text${i}];` +
      `[base${i}][text${i}]overlay=0:0,trim=duration=4,setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
    );
  });
  const transitions: string[] = [];
  let current = "v0";
  for (let i = 1; i < photos.length; i++) {
    const output = i === photos.length - 1 ? "out" : `mix${i}`;
    const offset = i * (4 - transition);
    transitions.push(
      `[${current}][v${i}]xfade=transition=${spec.style === "warm" ? "fadeblack" : "smoothleft"}:duration=${transition}:offset=${offset.toFixed(2)}[${output}]`,
    );
    current = output;
  }
  if (photos.length === 1) transitions.push("[v0]null[out]");
  const filter = [...shotFilters, ...transitions].join(";");
  const out = path.join(dir, "reel.mp4");
  const duration =
    photos.length * 4 - Math.max(0, photos.length - 1) * transition;
  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-map",
    `${inputs}:a`,
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    out,
  );
  // Scene shots are heavier (plate parallax, shadows, light sweep): more time each.
  // ffmpeg can deadlock on long filter graphs; a silent run is killed and retried once.
  const ffmpeg = () =>
    command(process.env.FFMPEG_PATH || "ffmpeg", args, {
      timeoutMs: 180000 + 120000 * scenePlans.size,
      stallMs: 60000,
    });
  await ffmpeg().catch((e: Error) =>
    /stalled/.test(e.message) ? ffmpeg() : Promise.reject(e),
  );
  const done = await finishReel(
    out,
    dir,
    sourceKinds[0] === "cutout" || sourceKinds[0] === "scene" ? "1.6" : "0.8",
  );
  return {
    ...done,
    renderMode: "motion-template-v2" as const,
    /** Per shot: which look was rendered. */
    layouts: sourceKinds.map((k) =>
      k === "scene" ? ("scene" as const) : k === "cutout" ? ("cutout" as const) : ("baseline" as const),
    ),
    film: null as FilmReport | null,
    /** Why the film was skipped after being attempted (null when not attempted or it rendered). */
    filmFallback,
    /** Product-true scene shots (shot index -> geometry), for fidelity checks. */
    scenes: [...scenePlans].map(([index, p]) => ({
      index,
      productId: spec.shots[index].productId,
      geometry: p.geometry as SceneGeometry,
      scrim: p.scrim,
    })),
  };
}
