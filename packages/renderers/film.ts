import sharp from "sharp";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReelSpec } from "../campaign/index.ts";
import { cropToAlpha, prepareCutout } from "./cutout.ts";
import { command } from "./ffmpeg.ts";
import {
  blockRect,
  buildMacro,
  chooseContextInk,
  chooseInk,
  DARK_INK,
  LIGHT_INK,
  samplePixels,
  type ContextInk,
  type InkChoice,
  buildHeroAssets,
  brandLayer,
  cleanPhrases,
  FPS,
  FRAMES_PER_FILM,
  FACTS_VISIBLE_FROM,
  H,
  HERO_CX,
  HERO_CY,
  HERO_SHADOW_Y,
  HERO_SWEEP_LEN,
  HERO_SWEEP_START,
  HERO_SETTLE,
  HERO_TILT_DEG,
  HERO_TILT_END,
  heroSweepExpr,
  kineticLines,
  MACRO_H,
  MACRO_W,
  plateBackground,
  studioBackground,
  studioColors,
  W,
  WHIP_1_START,
  WHIP_2_START,
  WHIP_FRAMES,
  whipFrame,
  CUT_1,
  CUT_2,
  type FilmDirection,
  type HeroGeometry,
  type KineticLine,
  type MacroPlan,
  type StudioColors,
} from "./film-art.ts";
import {
  PLATE_MARGIN,
  buildScene,
  preparePlate,
  sceneShotFilter,
  stillFor,
  type SceneGeometry,
} from "./scene.ts";
import { cutoutDominant, type TextLayer } from "./polish-art.ts";
import type { Palette } from "./polish.ts";

export {
  FILM_DURATION,
  FACTS_VISIBLE_FROM,
  type FilmDirection,
} from "./film-art.ts";

/** Frames of each rendered clip (hero and macro include the whip windows). */
const HERO_FRAMES = WHIP_1_START + WHIP_FRAMES; // 82
const MACRO_FRAMES = WHIP_2_START + WHIP_FRAMES - WHIP_1_START; // 80
const CTX_START = WHIP_2_START; // 146
const CTX_FRAMES = FRAMES_PER_FILM - CTX_START; // 154
/** Local clock of the end-card moment inside the context clip. */
const TAU_FACTS = FACTS_VISIBLE_FROM - CTX_START / FPS;

export type FilmPlate = { png: Buffer; purpose?: string };
export type FilmInput = {
  spec: ReelSpec;
  dir: string;
  cutouts: Map<string, Buffer>;
  plates: FilmPlate[];
  direction?: FilmDirection;
  /** Same text layers as the scene/cutout looks (Red Pen depends on it). */
  textLayersFor: (
    i: number,
    shotText: string,
    palette: Palette,
  ) => Promise<{ layers: TextLayer[]; layerFiles: string[] }>;
  palette: Palette;
  /** Used to measure / report per-stage timings (ms). */
  onTiming?: (stage: string, ms: number) => void;
};
export type FilmReport = FilmResult;
export type FilmResult = {
  out: string;
  /** Hero shots (shot index -> geometry) for the compositing-fidelity check. */
  heroes: { index: number; productId: string; geometry: HeroGeometry }[];
  macros: { index: number; plan: MacroPlan }[];
  /** Ink chosen for each kinetic phrase from the luminance under it (null: no phrase). */
  inks: { index: number; macro: InkChoice | null; context: ContextInk | null }[];
  scenes: { index: number; geometry: SceneGeometry }[];
  timings: Record<string, number>;
};

const ffmpeg = (args: string[], timeoutMs = 240000) =>
  command(process.env.FFMPEG_PATH || "ffmpeg", args, { timeoutMs, stallMs: 90000 });
/** One retry when ffmpeg stalls (a silent run is killed by command()). */
const run = (args: string[], timeoutMs?: number) =>
  ffmpeg(args, timeoutMs).catch((e: Error) =>
    /stalled/.test(e.message) ? ffmpeg(args, timeoutMs) : Promise.reject(e),
  );

/** Intermediate encode: near-lossless so whip frames and the final pass stay clean. */
const INTER = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "14", "-pix_fmt", "yuv420p", "-an"];
const NOISE = "noise=alls=5:allf=t+u";

const f = (n: number) => String(+n.toFixed(4));

/** Slide-in/fade-in overlay of a kinetic line. `side`: left- or right-aligned. */
function kineticChain(
  prev: string,
  idx: number,
  line: KineticLine,
  y: number,
  start: number,
  side: "left" | "right",
  tag: string,
) {
  const x0 = side === "left" ? 54 : W - 54 - line.width;
  const dir = side === "left" ? -1 : 1;
  const ease = `pow(1-min(max((t-${f(start)})/0.35,0),1),3)`;
  return (
    `[${idx}:v]${stillFor(5.4)}format=rgba,fade=t=in:st=${f(start)}:d=0.15:alpha=1[${tag}k];` +
    `[${prev}][${tag}k]overlay=x='${x0}+${dir * 110}*${ease}':y='${y}+26*${ease}':format=auto[${tag}o];`
  );
}

/** Stacked y positions of a phrase block whose first line starts at `top`. */
const lineYs = (lines: KineticLine[], top: number) => {
  let y = top;
  return lines.map((l) => {
    const at = y;
    y += Math.round(l.height * 0.8);
    return at;
  });
};

const MACRO_TEXT_TOP = 170;
const CTX_TEXT_TOP = 150;

type Product = { id: string; cropped: Buffer };

export async function renderFilm(o: FilmInput): Promise<FilmResult> {
  const temp: string[] = [];
  try {
    return await renderFilmInner(o, temp);
  } finally {
    await Promise.all(temp.map((p) => rm(p, { force: true }).catch(() => undefined)));
  }
}

async function renderFilmInner(o: FilmInput, temp: string[]): Promise<FilmResult> {
  const { spec, dir } = o;
  await mkdir(dir, { recursive: true });
  const timings: Record<string, number> = {};
  const mark = async <T>(stage: string, p: Promise<T>) => {
    const t0 = Date.now();
    const r = await p;
    timings[stage] = (timings[stage] ?? 0) + (Date.now() - t0);
    o.onTiming?.(stage, Date.now() - t0);
    return r;
  };
  const punchy = o.direction?.motion === "punchy";
  const phrases = cleanPhrases(o.direction?.phrases);
  const heroPlate = o.plates.find((p) => p.purpose === "hero");
  const detailPlate = o.plates.find((p) => p.purpose === "detail");
  const contextPlates = o.plates.some((p) => p.purpose)
    ? o.plates.filter((p) => p.purpose === "context")
    : o.plates;

  const products: Product[] = [];
  for (const shot of spec.shots) {
    const cut = o.cutouts.get(shot.productId);
    const cropped = cut ? await cropToAlpha(cut) : null;
    if (!cropped) throw new Error("film needs a usable cutout for every shot");
    products.push({ id: shot.productId, cropped });
  }

  const inks: FilmResult["inks"] = [];
  const heroes: FilmResult["heroes"] = [];
  const macros: FilmResult["macros"] = [];
  const scenes: FilmResult["scenes"] = [];
  const args: string[] = ["-y"];
  const parts: string[] = [];
  let nIn = 0;
  const addIn = (...a: string[]) => {
    args.push(...a);
    return nIn++;
  };

  for (let i = 0; i < spec.shots.length; i++) {
    const shot = spec.shots[i];
    const prod = products[i];
    const tag = String(i);
    const prepared = await prepareCutout(o.cutouts.get(prod.id)!);
    const colors: StudioColors = studioColors(
      o.direction,
      prepared ? await cutoutDominant(prepared) : null,
    );

    /* ---------- build every still ---------- */
    const built = await mark(
      "stills",
      (async () => {
        const heroBgP = heroPlate
          ? plateBackground(heroPlate.png, W, H, colors)
          : studioBackground(W, H, colors, { horizon: 1230, lightY: HERO_CY - 60, beam: 0.22 });
        const heroP = buildHeroAssets(prod.cropped, colors, punchy ? "punchy" : "calm");
        const macroP = (async () => {
          const macroBg = detailPlate
            ? await plateBackground(detailPlate.png, MACRO_W, MACRO_H, colors)
            : await studioBackground(MACRO_W, MACRO_H, colors, {
                horizon: Math.round(MACRO_H * 0.84),
                lightX: MACRO_W * 0.4,
                lightY: MACRO_H * 0.4,
                seed: 0xbeef,
                beam: 0.14,
              });
          return buildMacro(prod.cropped, colors, macroBg);
        })();
        const sceneP = (async () => {
          const chosen = contextPlates[i] ?? contextPlates[0];
          const fallback = () =>
            studioBackground(1280, H, colors, {
              horizon: 1060,
              lightY: 720,
              lightX: 640,
              seed: 0xc0de,
              beam: 0.16,
            });
          let plate = await preparePlate(chosen ? chosen.png : await fallback());
          if (!plate) plate = await preparePlate(await fallback());
          const scene = plate
            ? await buildScene(prod.cropped, plate, spec.style, o.palette, dir, `ctx${tag}`)
            : null;
          if (!scene) throw new Error("film context scene could not be built");
          return scene;
        })();
        const [heroBg, hero, macro, scene, brand, text] = await Promise.all([
          heroBgP,
          heroP,
          macroP,
          sceneP,
          brandLayer(spec.facts.business, colors.ink),
          o.textLayersFor(i, shot.text, o.palette),
        ]);
        return { heroBg, hero, macro, scene, brand, text };
      })(),
    );
    /* Kinetic type colour adapts to what is under it (WCAG-style contrast, deterministic). */
    const macroBox = (() => {
      const probe = phrases[0] ? kineticLines(phrases[0], "#ffffff") : Promise.resolve([]);
      return probe;
    })();
    const probe1 = await macroBox;
    let phrase1: KineticLine[] = [];
    let ink1: InkChoice | null = null;
    if (probe1.length) {
      const r = blockRect(probe1, MACRO_TEXT_TOP, "left");
      // frame -> macro canvas: +80 margin, widened for the drift/push of the shot
      const { px } = await samplePixels(built.macro.png, {
        x: r.x + 80 - 70,
        y: r.y + 80 - 70,
        w: r.w + 140,
        h: r.h + 140,
      });
      ink1 = chooseInk(px, { light: LIGHT_INK, dark: DARK_INK, size: 250 });
      phrase1 = await kineticLines(phrases[0], ink1.ink, { stroke: ink1.stroke });
    }
    const probe2 = phrases[1] ? await kineticLines(phrases[1], "#ffffff", { maxSize: 230 }) : [];
    let phrase2: KineticLine[] = [];
    let ink2: ContextInk | null = null;
    if (probe2.length) {
      const r = blockRect(probe2, CTX_TEXT_TOP, "right");
      const plateRaw = await readFile(built.scene.files.plate);
      // frame -> normalised plate: + PLATE_MARGIN in x; widened for the push-in
      const { px, ys } = await samplePixels(plateRaw, {
        x: r.x + PLATE_MARGIN - 60,
        y: r.y - 90,
        w: r.w + 120,
        h: r.h + 180,
      });
      ink2 = chooseContextInk(px, ys);
      phrase2 = await kineticLines(phrases[1], ink2.ink, { maxSize: 230, stroke: ink2.stroke });
    }
    inks.push({ index: i, macro: ink1, context: ink2 });

    const file = async (name: string, buf: Buffer) => {
      const p = path.join(dir, `${name}-${tag}.png`);
      await writeFile(p, buf);
      return p;
    };
    const fHeroBg = await file("hero-bg", built.heroBg);
    const fSprite = await file("hero-sprite", built.hero.sprite);
    const fShadow = await file("hero-shadow", built.hero.shadow);
    const fBand = await file("hero-band", built.hero.band);
    const fBrand = built.brand ? await file("brand", built.brand) : null;
    const fMacro = await file("macro", built.macro.png);
    const lineFile = async (name: string, ls: KineticLine[]) =>
      Promise.all(ls.map((l, j) => file(`${name}-${j}`, l.png)));
    const f1 = await lineFile("kin1", phrase1);
    const f2 = await lineFile("kin2", phrase2);
    heroes.push({ index: i, productId: prod.id, geometry: built.hero.geometry });
    macros.push({ index: i, plan: built.macro.plan });
    scenes.push({ index: i, geometry: built.scene.geometry });
    const g = built.hero.geometry;

    /* The three clips render concurrently (each is one ffmpeg process). */
    const jobs: Promise<unknown>[] = [];
    /* ---------- hero clip ---------- */
    const heroOut = path.join(dir, `hero-${tag}.mp4`);
    temp.push(heroOut);
    {
      const S = stillFor(3.4);
      const kp = f(g.dw / g.iw);
      const sc = `(${f(0.94)}+0.06*(1-pow(1-min(t/${HERO_SETTLE},1),3)))*(1+${g.push}*min(t,2.8)/2.8)`;
      const bob = `(-9*sin(2*PI*t/3.2))`;
      const a = ["-i", fHeroBg, "-i", fSprite, "-i", fShadow, "-i", fBand];
      if (fBrand) a.push("-i", fBrand);
      const rot = `(${f((HERO_TILT_DEG * Math.PI) / 180)}*pow(1-min(t/${HERO_TILT_END},1),3))`;
      const gr =
        `color=c=black:s=${W}x${H}:r=${FPS}:d=3.4[base];` +
        `[0:v]${S}format=rgba,scale=w='trunc(${W}*(1+0.035*min(t,2.8)/2.8)/2)*2':h='trunc(${H}*(1+0.035*min(t,2.8)/2.8)/2)*2':eval=frame:flags=bicubic[bgz];` +
        `[base][bgz]overlay=x='(W-w)/2':y='(H-h)/2':format=auto[b0];` +
        `[2:v]${S}format=rgba,fade=t=in:st=0.1:d=0.6:alpha=1,scale=w='trunc(${g.shadowW}*${sc}*(1+0.05*sin(2*PI*t/3.2))/2)*2':h='trunc(${g.shadowH}*${sc}*(1+0.05*sin(2*PI*t/3.2))/2)*2':eval=frame:flags=bilinear[sh];` +
        `[b0][sh]overlay=x='${HERO_CX}-w/2':y='${HERO_SHADOW_Y}-h/2':format=auto[b1];` +
        `[1:v]${S}format=rgba,split=2[pa][pb];[pb]alphaextract[pal];` +
        `[3:v]${S}format=gray,crop=w=${g.pw}:h=${g.ph}:x='${heroSweepExpr(g.pw)}':y=0[bd];` +
        `[bd][pal]blend=all_mode=multiply[mk];` +
        `color=c=white:s=${g.pw}x${g.ph}:r=${FPS}:d=3.4,format=rgba[wh];[wh][mk]alphamerge[sw];[pa][sw]overlay=format=auto[lit];` +
        `[lit]fade=t=in:st=0:d=0.35:alpha=1,rotate=a='-${rot}':ow=iw:oh=ih:c=none:bilinear=1,` +
        `scale=w='trunc(${g.pw}*${kp}*${sc}/2)*2':h='trunc(${g.ph}*${kp}*${sc}/2)*2':eval=frame:flags=bicubic[pr];` +
        `[b1][pr]overlay=x='${HERO_CX}-w/2':y='${HERO_CY}+${bob}-h/2':format=auto[b2];` +
        (fBrand
          ? `[4:v]${S}format=rgba,fade=t=in:st=0.3:d=0.5:alpha=1[br];[b2][br]overlay=x=0:y='150+14*pow(1-min(max((t-0.3)/0.6,0),1),3)':format=auto[b3];`
          : `[b2]null[b3];`) +
        `[b3]format=yuv420p,setsar=1[v]`;
      jobs.push(mark(
        "hero",
        run([...(["-y"] as string[]), ...a, "-filter_complex", gr, "-map", "[v]", "-frames:v", String(HERO_FRAMES), "-r", String(FPS), ...INTER, heroOut]),
      ));
    }

    /* ---------- macro clip ---------- */
    const macroOut = path.join(dir, `macro-${tag}.mp4`);
    temp.push(macroOut);
    {
      const S = stillFor(3.4);
      const a = ["-i", fMacro];
      let idx = 1;
      const lineIdx: number[] = [];
      for (const lf of f1) {
        a.push("-i", lf);
        lineIdx.push(idx++);
      }
      const pushM = punchy ? 0.075 : 0.045;
      const Z = `(1+${pushM}*min(t,2.8)/2.8)`;
      let gr =
        `color=c=black:s=${W}x${H}:r=${FPS}:d=3.4[mb];` +
        `[0:v]${S}format=rgba,scale=w='trunc(${MACRO_W}*${Z}/2)*2':h='trunc(${MACRO_H}*${Z}/2)*2':eval=frame:flags=bicubic[cv];` +
        `[mb][cv]overlay=x='(W-w)/2+(25-50*min(t,2.8)/2.8)':y='(H-h)/2+(-14+28*min(t,2.8)/2.8)':format=auto[m0];`;
      let prev = "m0";
      const ys = lineYs(phrase1, 170);
      phrase1.forEach((l, j) => {
        gr += kineticChain(prev, lineIdx[j], l, ys[j], 0.3 + j * 0.1, "left", `m${j}`);
        prev = `m${j}o`;
      });
      gr += `[${prev}]format=yuv420p,setsar=1[v]`;
      jobs.push(mark(
        "macro",
        run(["-y", ...a, "-filter_complex", gr, "-map", "[v]", "-frames:v", String(MACRO_FRAMES), "-r", String(FPS), ...INTER, macroOut]),
      ));
    }

    /* ---------- context + end card clip ---------- */
    const ctxOut = path.join(dir, `ctx-${tag}.mp4`);
    temp.push(ctxOut);
    {
      const sf = built.scene.files;
      const a: string[] = [];
      let idx = 0;
      for (const p of [sf.plate, sf.product, sf.shadow, sf.band, sf.scrim]) {
        a.push("-i", p);
        idx++;
      }
      const lineIdx: number[] = [];
      for (const lf of f2) {
        a.push("-i", lf);
        lineIdx.push(idx++);
      }
      const textIdx: number[] = [];
      for (const lf of built.text.layerFiles) {
        a.push("-i", lf);
        textIdx.push(idx++);
      }
      const dur = CTX_FRAMES / FPS + 0.1;
      let gr =
        sceneShotFilter(i, 0, built.scene.geometry, [], {
          dur,
          scrimFade: { st: +(TAU_FACTS - 0.35).toFixed(3), d: 0.45 },
          rawLabel: "c0",
        }) + ";";
      let prev = "c0";
      const ys = lineYs(phrase2, 150);
      if (phrase2.length) {
        // top scrim so the type reads on any plate; fades away before the end card
        const top = await sharp(
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="720"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="${ink2?.scrimAlpha ?? 0}"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="720" fill="url(#g)"/></svg>`,
          ),
        )
          .png()
          .toBuffer();
        const ft = await file("ctx-top", top);
        a.push("-i", ft);
        const ti = idx++;
        const t0 = 0.25,
          t1 = TAU_FACTS - 0.1;
        gr += `[${ti}:v]${stillFor(dur + 0.6)}format=rgba,fade=t=in:st=${f(t0)}:d=0.4:alpha=1,fade=t=out:st=${f(t1)}:d=0.3:alpha=1[ctxt];[${prev}][ctxt]overlay=0:0:format=auto[ct];`;
        prev = "ct";
        phrase2.forEach((l, j) => {
          const start = 0.3 + j * 0.1;
          const xl = W - 54 - l.width;
          const ease = `pow(1-min(max((t-${f(start)})/0.35,0),1),3)`;
          gr +=
            `[${lineIdx[j]}:v]${stillFor(dur + 0.6)}format=rgba,fade=t=in:st=${f(start)}:d=0.15:alpha=1,fade=t=out:st=${f(t1)}:d=0.25:alpha=1[kl${j}];` +
            `[${prev}][kl${j}]overlay=x='${xl}+110*${ease}':y='${ys[j]}+26*${ease}':format=auto[kc${j}];`;
          prev = `kc${j}`;
        });
      }
      // End card: the facts block, same layers and positions as the scene/cutout looks.
      built.text.layers.forEach((layer, j) => {
        const d = (TAU_FACTS + Math.min(j, 5) * 0.04).toFixed(3);
        gr +=
          `[${textIdx[j]}:v]${stillFor(dur + 0.6)}format=rgba,fade=t=in:st=${d}:d=0.18:alpha=1[tx${j}];` +
          `[${prev}][tx${j}]overlay=x=0:y='${layer.y}+18*pow(1-min(max((t-${d})/0.2,0),1),3)':format=auto[tc${j}];`;
        prev = `tc${j}`;
      });
      gr += `[${prev}]format=yuv420p,setsar=1[v]`;
      jobs.push(mark(
        "context",
        run(["-y", ...a, "-filter_complex", gr, "-map", "[v]", "-frames:v", String(CTX_FRAMES), "-r", String(FPS), ...INTER, ctxOut]),
      ));
    }

    // allSettled: no ffmpeg process may outlive a failed sibling.
    const settled = await Promise.allSettled(jobs);
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) throw failed.reason;

    /* ---------- whip pans (real directional blur on decoded frames) ---------- */
    const whips: string[] = [];
    await mark(
      "whip",
      (async () => {
        const RAW = W * H * 3;
        /** Decodes WHIP_FRAMES frames starting at frame `from` as one raw RGB buffer. */
        const extract = async (video: string, from: number, name: string) => {
          const rawFile = path.join(dir, `${name}-${tag}.rgb`);
          await run([
            "-y",
            "-i",
            video,
            "-vf",
            `select='between(n\,${from}\,${from + WHIP_FRAMES - 1})'`,
            "-fps_mode",
            "passthrough",
            "-frames:v",
            String(WHIP_FRAMES),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            rawFile,
          ]);
          temp.push(rawFile);
          const buf = await readFile(rawFile);
          if (buf.length !== RAW * WHIP_FRAMES) throw new Error("whip frames missing");
          return buf;
        };
        const pairs: [string, number, string, number, string][] = [
          [heroOut, WHIP_1_START, macroOut, 0, "w1"],
          [macroOut, WHIP_2_START - WHIP_1_START, ctxOut, 0, "w2"],
        ];
        for (const [va, fa, vb, fb, name] of pairs) {
          const [A, B] = [await extract(va, fa, `${name}a`), await extract(vb, fb, `${name}b`)];
          const frames: Buffer[] = [];
          for (let n = 0; n < WHIP_FRAMES; n++)
            frames.push(
              await whipFrame(
                A.subarray(n * RAW, (n + 1) * RAW),
                B.subarray(n * RAW, (n + 1) * RAW),
                n,
                punchy,
              ),
            );
          const rawOut = path.join(dir, `${name}-${tag}.rgb`);
          await writeFile(rawOut, Buffer.concat(frames));
          temp.push(rawOut);
          whips.push(rawOut);
        }
      })(),
    );

    /* ---------- final graph pieces for this product ---------- */
    const iHero = addIn("-i", heroOut);
    const iMacro = addIn("-i", macroOut);
    const iCtx = addIn("-i", ctxOut);
    const rawIn = (file: string) =>
      addIn("-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${W}x${H}`, "-framerate", String(FPS), "-i", file);
    const iW1 = rawIn(whips[0]);
    const iW2 = rawIn(whips[1]);
    const norm = "format=yuv420p,setsar=1,fps=30,setpts=PTS-STARTPTS";
    parts.push(
      `[${iHero}:v]trim=start_frame=0:end_frame=${WHIP_1_START},${norm}[h${i}]`,
      `[${iW1}:v]${norm}[wa${i}]`,
      `[${iMacro}:v]trim=start_frame=${WHIP_FRAMES}:end_frame=${WHIP_2_START - WHIP_1_START},${norm}[m${i}]`,
      `[${iW2}:v]${norm}[wb${i}]`,
      `[${iCtx}:v]trim=start_frame=${WHIP_FRAMES},${norm}[c${i}]`,
      `[h${i}][wa${i}][m${i}][wb${i}][c${i}]concat=n=5:v=1:a=0[p${i}]`,
    );
  }

  const n = spec.shots.length;
  const audio = addIn("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  const joined =
    n === 1
      ? `[p0]${NOISE}[out]`
      : `${Array.from({ length: n }, (_, i) => `[p${i}]`).join("")}concat=n=${n}:v=1:a=0,${NOISE}[out]`;
  const out = path.join(dir, "reel.mp4");
  await mark(
    "assemble",
    run(
      [
        ...args,
        "-filter_complex",
        [...parts, joined].join(";"),
        "-map",
        "[out]",
        "-map",
        `${audio}:a`,
        "-t",
        String(n * (FRAMES_PER_FILM / FPS)),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "21",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        out,
      ],
      600000,
    ),
  );
  return { out, heroes, macros, inks, scenes, timings };
}

export { CUT_1, CUT_2 };
