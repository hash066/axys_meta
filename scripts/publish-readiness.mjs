// Reports what is still missing before Axys can publish a reel to a real Instagram account.
// Prints variable NAMES and pass/fail only; it never prints a value.
// Usage: node scripts/publish-readiness.mjs [path/to/.env]
import { existsSync, readFileSync } from "node:fs";

const envFile = process.argv[2] ?? (existsSync(".env") ? ".env" : existsSync("../.env") ? "../.env" : null);
const fromFile = {};
if (envFile)
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
const get = (k) => (process.env[k] ?? fromFile[k] ?? "").trim();

const checks = [
  ["MODEL_API_KEY", "Meta Model API key (Muse models)", () => !!get("MODEL_API_KEY")],
  ["META_APP_ID", "Meta app id (App Dashboard > Instagram > API setup with Instagram login)", () => !!get("META_APP_ID")],
  ["META_APP_SECRET", "Meta app secret (same page)", () => !!get("META_APP_SECRET")],
  ["META_API_VERSION", "Graph API version such as v23.0 (format vNN.0)", () => /^v\d+\.0$/.test(get("META_API_VERSION"))],
  [
    "AXYS_ORIGIN",
    "Public HTTPS address Meta can reach (Instagram downloads the reel from it). localhost does not work",
    () => {
      try {
        const u = new URL(get("AXYS_ORIGIN"));
        return u.protocol === "https:" && !/^(localhost|127\.|\[?::1)/.test(u.hostname);
      } catch {
        return false;
      }
    },
  ],
  [
    "META_REDIRECT_URI",
    "Must equal AXYS_ORIGIN + /api/v1/oauth/callback and be registered as a valid OAuth redirect in the Meta app",
    () => !!get("AXYS_ORIGIN") && get("META_REDIRECT_URI") === get("AXYS_ORIGIN").replace(/\/$/, "") + "/api/v1/oauth/callback",
  ],
  ["AXYS_TOKEN_KEY", "32-byte base64 key that encrypts the Instagram token at rest", () => Buffer.from(get("AXYS_TOKEN_KEY"), "base64").length === 32],
  ["AXYS_MEDIA_KEY", "Random secret that signs the temporary reel download links", () => get("AXYS_MEDIA_KEY").length >= 32],
  ["META_INSIGHT_METRICS", "Comma-separated insight metrics your account supports, e.g. reach,likes,saves,shares", () => /^[a-z_,]+$/.test(get("META_INSIGHT_METRICS"))],
  ["AXYS_ALLOW_PUBLIC_POSTING", "Set to true ONLY when you are ready for a real post (default blocks all posting)", () => get("AXYS_ALLOW_PUBLIC_POSTING") === "true"],
];

let missing = 0;
console.log(`Checked ${envFile ?? "process environment only"}\n`);
for (const [name, why, ok] of checks) {
  const pass = ok();
  if (!pass) missing++;
  console.log(`${pass ? "OK     " : "MISSING"}  ${name.padEnd(26)} ${pass ? "" : why}`);
}
console.log(
  missing
    ? `\n${missing} item(s) missing. Real posting stays disabled until they are set.`
    : "\nConfiguration looks complete. Connect the account in Studio (Publish > Connect your business Instagram), then post once with disposable content.",
);
console.log(`
Also needed outside this repo:
  - An Instagram PROFESSIONAL (business/creator) account, added to the Meta app as an Instagram tester (or the app approved for the permissions).
  - Permissions requested by Axys: instagram_business_basic, instagram_business_content_publish, instagram_business_manage_insights.
  - Generate secrets with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  - Reels must be 9:16 H.264/AAC; Axys renders that. The video URL Instagram fetches is signed and expires.`);
process.exit(missing ? 1 : 0);
