// Voices the demo narration lines through the Muse gateway (ElevenLabs behind it) and records each clip's duration.
// Usage: node scripts/make-narration.mjs [lines.json] [outDir]   (cached lines cost nothing; new lines spend ElevenLabs credits)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const GATEWAY = process.env.MUSE_GATEWAY_URL ?? "http://127.0.0.1:8766";
const lines = JSON.parse(readFileSync(path.resolve(process.argv[2] ?? "scripts/demo-narration.json"), "utf8"));
const outDir = path.resolve(process.argv[3] ?? "docs/evidence/narration");
mkdirSync(outDir, { recursive: true });

const chars = lines.reduce((n, l) => n + l.text.length, 0);
const budget = await (await fetch(GATEWAY + "/v1/speak/budget")).json();
console.log(`${lines.length} lines, ${chars} characters (about ${chars / 2} credits); budget remaining ${budget.remaining}`);
if (chars / 2 > budget.remaining - 150) throw new Error("Not enough ElevenLabs credits for these lines; shorten them or add credits.");

const out = [];
for (const l of lines) {
  const r = await fetch(GATEWAY + "/v1/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: l.text, voice: "narrator" }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${l.id}: ${j.error}`);
  const file = path.join(outDir, `${l.id}.mp3`);
  writeFileSync(file, Buffer.from(j.audio_mp3_b64, "base64"));
  const p = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
  const durationSec = Math.round(Number(p.stdout) * 100) / 100;
  out.push({ id: l.id, text: l.text, file: path.relative(process.cwd(), file).split(path.sep).join("/"), durationSec, credits: j.credits_charged, cached: j.cached });
  console.log(`${l.id}: ${durationSec}s ${j.cached ? "(cached)" : `(${j.credits_charged} credits)`}`);
}
writeFileSync(path.join(outDir, "narration.json"), JSON.stringify(out, null, 2));
console.log("total speech:", out.reduce((n, o) => n + o.durationSec, 0).toFixed(1), "s");
