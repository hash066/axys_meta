// Turns the raw recording into the final demo: speeds up the long waits marked by record-demo.mjs, scales to 1280x720,
// adds a silent audio track (some platforms require one) and encodes H.264.
// Usage: node scripts/cut-demo.mjs [workDir] [out.mp4] [videoOffsetSeconds]
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const work = path.resolve(process.argv[2] ?? "demo-work");
const out = path.resolve(process.argv[3] ?? path.join(work, "demo.mp4"));
const offset = Number(process.argv[4] ?? 0); // extra constant lag between the script clock and the video
const tl = JSON.parse(readFileSync(path.join(work, "timeline.json"), "utf8"));
// The recorder's video can end up shorter than the script clock; rescale script time to video time.
const rawProbe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path.join(work, "raw.webm")], { encoding: "utf8" });
const rawDuration = Number(rawProbe.stdout.trim());
const k = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration / (tl.totalMs / 1000) : 1;
console.log(`script clock ${(tl.totalMs / 1000).toFixed(1)} s, video ${rawDuration} s, scale ${k.toFixed(4)}`);
const total = (tl.totalMs / 1000) * k;

// Build contiguous segments [start, end, factor] covering the whole recording.
const speeds = tl.speed.filter((s) => s.end).map((s) => ({ a: (s.start / 1000) * k + offset, b: (s.end / 1000) * k + offset, f: s.factor }));
const segs = [];
let cursor = 0;
for (const s of speeds.sort((x, y) => x.a - y.a)) {
  if (s.a > cursor) segs.push([cursor, s.a, 1]);
  segs.push([s.a, s.b, s.f]);
  cursor = s.b;
}
segs.push([cursor, total + offset + 1, 1]);

const parts = segs.map(
  ([a, b, f], i) =>
    `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${f},fps=30[v${i}]`,
);
const concat = segs.map((_, i) => `[v${i}]`).join("") + `concat=n=${segs.length}:v=1:a=0,scale=1280:720:flags=lanczos,format=yuv420p[v]`;
const graph = [...parts, concat].join(";\n");
writeFileSync(path.join(work, "filter.txt"), graph);

const outDuration = segs.reduce((n, [a, b, f]) => n + (b - a) / f, 0);
console.log(`segments: ${segs.length}; expected duration about ${outDuration.toFixed(1)} s`);

const r = spawnSync(
  "ffmpeg",
  [
    "-y", "-v", "error",
    "-i", path.join(work, "raw.webm"),
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-filter_complex_script", path.join(work, "filter.txt"),
    "-map", "[v]", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "64k", "-shortest",
    out,
  ],
  { stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);
const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", "-of", "default=nw=1", out], { encoding: "utf8" });
console.log(probe.stdout.trim());
console.log("wrote", out);
