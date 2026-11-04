// Generates the secrets a production deployment needs. Prints them once; store them in .env.production.
// Usage: node scripts/make-keys.mjs [tenantId]
import { createHash, randomBytes } from "node:crypto";

const tenant = (process.argv[2] ?? "demo").trim();
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenant)) {
  console.error("tenantId must be 1-64 characters of letters, digits, _ or -");
  process.exit(2);
}
const accessKey = randomBytes(18).toString("base64url");
const digest = createHash("sha256").update(accessKey).digest("hex");

console.log(`# Put these lines in .env.production (the workspace login key itself is NOT stored there).
AXYS_ACCESS_KEYS=${tenant}:${digest}
AXYS_TOKEN_KEY=${randomBytes(32).toString("base64")}
AXYS_MEDIA_KEY=${randomBytes(32).toString("base64")}

# Your Studio login key (type this into the Studio's "access key" box; keep it private):
#   ${accessKey}
`);
