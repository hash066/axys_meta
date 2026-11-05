// Mixes the demo's audio onto the silent cut: narration clips, the merchant voice note and the reel's own audio (voice + music bed),
// each placed at the output time of its cue (the same time mapping as scripts/cut-demo.mjs, including the speed-ups).
// Usage: node scripts/mix-demo-audio.mjs <workDir> <silent.mp4> <out.mp4>
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const work = path.resolve(process.argv[2] ?? "demo-work");
const silent = path.resolve(process.argv[3] ?? path.join(work, "demo-silent.mp4"));
const out = path.resolve(process.argv[4] ?? path.join(work, "demo.mp4"));
const tl = JSON.parse(readFileSync(path.join(work, "timeline.json"), "utf8"));

const probe = (file, entry = "format=duration") =>
  Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", entry, "-of", "default=nw=1:nk=1", file], { encoding: "utf8" }).stdout.trim());
const rawDuration = probe(path.join(work, "raw.webm"));
const k = rawDuration / (tl.totalMs / 1000);
const speeds = tl.speed.filter((s) => s.end).map((s) => ({ a: (s.start / 1000) * k, b: (s.end / 1000) * k, f: s.factor }));
const outTime = (scriptSeconds) => {
  const t = scriptSeconds * k;
  let saved = 0;
  for (const s of speeds) {
    if (t >= s.b) saved += (s.b - s.a) * (1 - 1 / s.f);
    else if (t > s.a) saved += (t - s.a) * (1 - 1 / s.f);
  }
  return t - saved;
};
const inSpeedUp = (scriptSeconds) => speeds.some((s) => scriptSeconds * k > s.a && scriptSeconds * k < s.b);

const gains = { voiceNote: 0.9, reelAudio: 3.2 };
// Optional: CUE_OVERRIDES='{"n10": 172.3}' pins a cue to an output time (used after splicing a re-recorded scene).
const overrides = JSON.parse(process.env.CUE_OVERRIDES ?? "{}");
const inputs = [];
const filters = [];
tl.cues.forEach((c, i) => {
  const file = c.isVideo ? path.join(work, c.file) : path.resolve(c.file);
  const start = overrides[c.id] ?? outTime(c.t / 1000);
  if (overrides[c.id] === undefined && inSpeedUp(c.t / 1000)) console.warn(`warning: cue ${c.id} starts inside a sped-up segment`);
  const ms = Math.max(0, Math.round(start * 1000));
  inputs.push("-i", file);
  const g = gains[c.id] ?? 1.0;
  filters.push(`[${i + 1}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms},volume=${g}[a${i}]`);
  console.log(`${c.id.padEnd(10)} at ${start.toFixed(1)} s (${(c.durationSec ?? 0).toFixed(1)} s)`);
});
const mixIn = tl.cues.map((_, i) => `[a${i}]`).join("");
filters.push(`${mixIn}amix=inputs=${tl.cues.length}:normalize=0:duration=longest,alimiter=limit=0.95[aout]`);
const videoDuration = probe(silent);

const r = spawnSync(
  "ffmpeg",
  ["-y", "-v", "error", "-i", silent, ...inputs, "-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", String(videoDuration), "-movflags", "+faststart", out],
  { stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`wrote ${out} (${probe(out).toFixed(1)} s)`);
