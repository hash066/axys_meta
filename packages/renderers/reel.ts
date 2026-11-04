import sharp from "sharp";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { ReelSpec } from "../campaign/index.ts";
import { prepareCutout } from "./cutout.ts";
import {
  backgroundPalette,
  buildBackground,
  buildSprite,
  buildTextLayers,
  cutoutDominant,
  type TextLayer,
} from "./polish-art.ts";
import { cleanText, layoutText } from "./polish.ts";
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
export function command(exe: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(exe, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => {
      out = (out + b).slice(-20000);
    });
    p.stderr.on("data", (b) => {
      err = (err + b).slice(-4000);
    });
    const timer = setTimeout(() => p.kill(), 180000);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(out)
        : reject(
            new Error(`Media processing failed (${code}). ${err.slice(-250)}`),
          );
    });
  });
}
export async function renderReel(
  spec: ReelSpec,
  dir: string,
  readAsset: (id: string) => Promise<Buffer>,
  generatedClips = new Map<string, Buffer>(),
  /** Optional SAM cutouts (PNG with alpha) keyed by product id. */
  cutouts = new Map<string, Buffer>(),
) {
  await mkdir(dir, { recursive: true });
  const photos: string[] = [];
  const overlays: string[] = [];
  const sourceKinds: ("photo" | "clip" | "cutout")[] = [];
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
      const [name = "", priceText = "", ...rest] = cleanText(shot.text).split(
        /\r?\n/,
      );
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
    if (sourceKinds[i] === "cutout") {
      const plan = cutoutPlans.get(i)!;
      for (const f of [photos[i], plan.bgFile, ...plan.layerFiles]) {
        args.push("-loop", "1", "-t", "4.6", "-i", f);
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
      `[${k}:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1,` +
      `scale=w='trunc(iw*${scale}/2)*2':h='trunc(ih*${scale}/2)*2':eval=frame[cut${i}];` +
      `[${k + 1}:v]format=rgba[bg${i}];` +
      `[bg${i}][cut${i}]overlay=x='(W-w)/2':y='${cy}-h/2-7*sin(2*PI*t/3.6)':format=auto[s${i}0];`;
    plan.layers.forEach((layer, j) => {
      const d = layer.delay.toFixed(2);
      const fadeOut = layer.fadeOut ? ",fade=t=out:st=3.55:d=0.35:alpha=1" : "";
      chain +=
        `[${k + 2 + j}:v]format=rgba,fade=t=in:st=${d}:d=0.45:alpha=1${fadeOut}[tx${i}_${j}];` +
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
  await command(process.env.FFMPEG_PATH || "ffmpeg", args);
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
    sourceKinds[0] === "cutout" ? "1.6" : "0.8",
    "-frames:v",
    "1",
    poster,
  ]);
  return {
    bytes: await readFile(out),
    poster: await readFile(poster),
    probe,
    renderMode: "motion-template-v2" as const,
  };
}
