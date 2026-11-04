// Makes the demo's merchant voice note and proves the voice-ingestion path end to end:
//   spoken line -> ElevenLabs (natural voice, via the Muse gateway) -> mp3 (what the WhatsApp screen plays)
//   -> 16 kHz mono PCM16 -> Muse Voice Transcribe (a Meta model, real) -> transcript used to fill the Brief.
// Usage: node scripts/make-voice-note.mjs [outDir] [photo.png]
// Costs ElevenLabs credits (about 115 for the default line) the first time; repeats are cached by the gateway.
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const GATEWAY = process.env.MUSE_GATEWAY_URL ?? "http://127.0.0.1:8766";
const outDir = path.resolve(process.argv[2] ?? "apps/studio/public/demo");
const photo = process.argv[3];
mkdirSync(outDir, { recursive: true });

const SPOKEN =
  "Hey, it's Mia from Stride Lane. We're dropping our new white running sneaker with the sage green panels this Saturday, November seventh, ten to four. It's eighty nine dollars. Can you turn this photo into a reel and a page for me?";

const post = async (route, body, headers = { "Content-Type": "application/json" }) => {
  const r = await fetch(GATEWAY + route, { method: "POST", headers, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${route}: ${r.status} ${j.error ?? ""}`);
  return j;
};

console.log("spoken text:", SPOKEN.length, "characters");
const speech = await post("/v1/speak", JSON.stringify({ text: SPOKEN, voice: "merchant" }));
console.log(`voice: ${speech.cached ? "from cache (free)" : `generated, ${speech.credits_charged} credits`}, model ${speech.model}`);
const mp3 = Buffer.from(speech.audio_mp3_b64, "base64");
writeFileSync(path.join(outDir, "voice-note.mp3"), mp3);

// mp3 -> raw 16 kHz mono PCM16, the format Muse Voice Transcribe expects
const ff = spawnSync("ffmpeg", ["-v", "error", "-i", path.join(outDir, "voice-note.mp3"), "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], { maxBuffer: 64 * 1024 * 1024 });
if (ff.status !== 0) throw new Error("ffmpeg failed: " + ff.stderr.toString().slice(0, 200));
const pcm = ff.stdout;
const durationSec = Math.round((pcm.length / 32000) * 10) / 10;
console.log(`audio: ${durationSec} s`);

const t0 = Date.now();
const tr = await post("/v1/transcribe", pcm, { "Content-Type": "application/octet-stream" });
const transcript = tr.transcript;
console.log(`Muse Voice Transcribe (${Date.now() - t0} ms):`, JSON.stringify(transcript));

// rough word-level comparison (spoken numbers may come back as digits, which is fine)
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const a = norm(SPOKEN), b = norm(transcript);
const dp = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
const wer = dp[a.length][b.length] / a.length;
console.log(`word error rate vs the spoken script: ${(wer * 100).toFixed(1)}% (${dp[a.length][b.length]} edits over ${a.length} words)`);

writeFileSync(
  path.join(outDir, "voice-note.json"),
  JSON.stringify({ text: transcript, durationSec, source: "Muse Voice Transcribe", spoken: SPOKEN, wordErrorRate: Math.round(wer * 1000) / 1000, voiceModel: speech.model }, null, 2),
);
if (photo) {
  const sharp = (await import("sharp")).default;
  await sharp(readFileSync(photo)).resize(1080, 1080, { fit: "cover" }).jpeg({ quality: 86 }).toFile(path.join(outDir, "product.jpg"));
  console.log("wrote product.jpg");
}
console.log("wrote", path.join(outDir, "voice-note.mp3"), "and voice-note.json");
