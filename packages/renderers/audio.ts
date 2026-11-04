import { readFile } from "node:fs/promises";
import { command } from "./ffmpeg.ts";

/**
 * Reel audio: a locally synthesised music bed (free, no model, no licence) mixed
 * under an optional narration clip, muxed into the finished reel as AAC stereo.
 * The video stream is stream-copied (`-c:v copy`), so the pictures are untouched.
 */
export type MixResult = {
  bytes: Buffer;
  probe: unknown;
  /** "voice+bed" when a narration clip was mixed, "bed" for the music bed alone. */
  mix: "voice+bed" | "bed";
};

const ff = () => process.env.FFMPEG_PATH || "ffmpeg";
const fp = () => process.env.FFPROBE_PATH || "ffprobe";

/** Seconds the narration waits after the bed has started (lets the pad fade in first). */
export const VOICE_DELAY_SEC = 0.6;
export const BED_FADE_IN_SEC = 1.2;
export const BED_FADE_OUT_SEC = 1.6;

/**
 * Filter graph for the bed: a slow A-minor-seventh pad (detuned sine pairs for
 * warmth), a faint pink-noise air layer, low-passed and faded in and out. About
 * -24 dBFS before mixing, so it sits under speech.
 */
export function bedGraph(duration: number, out = "bed") {
  const d = duration.toFixed(3);
  // A2, E3, A3, C4, E4 plus a slightly detuned twin of each (beating = chorus).
  const notes = [110, 164.81, 220, 261.63, 329.63];
  const gain = [0.28, 0.22, 0.2, 0.14, 0.11]; // ffmpeg "sine" already scales by 1/8
  const voices = notes.flatMap((f, i) => [
    { f, g: gain[i] },
    { f: f * 1.004, g: gain[i] * 0.8 },
  ]);
  const src = voices.map(
    (v, i) =>
      `sine=f=${v.f.toFixed(2)}:r=48000:d=${d},volume=${v.g.toFixed(3)}[s${i}]`,
  );
  const sum = voices.map((_, i) => `[s${i}]`).join("");
  const fadeOutAt = Math.max(0, duration - BED_FADE_OUT_SEC).toFixed(3);
  return [
    ...src,
    `anoisesrc=color=pink:r=48000:a=0.02:d=${d},lowpass=f=900[air]`,
    `${sum}[air]amix=inputs=${voices.length + 1}:normalize=0,tremolo=f=0.18:d=0.35,lowpass=f=1800,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,afade=t=in:st=0:d=${BED_FADE_IN_SEC},afade=t=out:st=${fadeOutAt}:d=${BED_FADE_OUT_SEC}[${out}]`,
  ];
}

/** Duration (seconds) of the video stream, or the container when absent. */
export async function videoSeconds(file: string) {
  const probe = JSON.parse(
    await command(fp(), [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]),
  );
  const v = probe.streams.find(
    (s: { codec_type: string }) => s.codec_type === "video",
  );
  const d = Number(v?.duration ?? probe.format?.duration);
  if (!Number.isFinite(d) || d < 1 || d > 180)
    throw new Error("Cannot read the reel duration");
  return d;
}

/**
 * Mux bed (+ narration) into `video`, writing `out`. Voice is optional: without
 * it the bed plays alone, a little louder. Ducking: the bed is compressed by a
 * sidechain keyed on the voice, then a limiter keeps the sum below clipping.
 */
export async function muxAudio(opts: {
  video: string;
  voice?: string;
  out: string;
}): Promise<MixResult> {
  const duration = await videoSeconds(opts.video);
  const graph = [...bedGraph(duration)];
  if (opts.voice) {
    graph.push(
      // Speech to a steady level, stereo 48 kHz, delayed so the bed leads in.
      `[1:a]aresample=48000,loudnorm=I=-16:TP=-2:LRA=7,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${Math.round(VOICE_DELAY_SEC * 1000)}|${Math.round(VOICE_DELAY_SEC * 1000)},apad=whole_dur=${duration.toFixed(3)},asplit=2[vox][key]`,
      `[bed][key]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=450:makeup=1[ducked]`,
      `[ducked][vox]amix=inputs=2:normalize=0,alimiter=limit=0.85:level=disabled[aout]`,
    );
  } else {
    graph.push(`[bed]volume=1.6,alimiter=limit=0.85:level=disabled[aout]`);
  }
  await command(
    ff(),
    [
      "-y",
      "-i",
      opts.video,
      ...(opts.voice ? ["-i", opts.voice] : []),
      "-filter_complex",
      graph.join(";"),
      "-map",
      "0:v:0",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-t",
      duration.toFixed(3),
      "-movflags",
      "+faststart",
      opts.out,
    ],
    { timeoutMs: 120000, stallMs: 60000 },
  );
  const probe = JSON.parse(
    await command(fp(), [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      opts.out,
    ]),
  );
  const audio = probe.streams.filter(
    (s: { codec_type: string }) => s.codec_type === "audio",
  );
  if (
    audio.length !== 1 ||
    audio[0].codec_name !== "aac" ||
    audio[0].channels !== 2
  )
    throw new Error("Muxed reel audio validation failed");
  return {
    bytes: await readFile(opts.out),
    probe,
    mix: opts.voice ? "voice+bed" : "bed",
  };
}
