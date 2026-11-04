/**
 * Seeds a SIMULATED WhatsApp draft into a data directory so the Studio's
 * "Continue a WhatsApp draft" flow can import it, without the WhatsApp bridge.
 *
 *   npx tsx scripts/seed-whatsapp-draft.mts --photo apps/studio/public/demo/product.jpg \
 *       --transcript-file apps/studio/public/demo/voice-note.json \
 *       [--voice apps/studio/public/demo/voice-note.mp3] \
 *       [--data-dir var/demo] [--tenant local-demo] [--phone 15555550142] \
 *       [--business "Stride Lane"] [--timezone ET] [--mode Both] [--dry-run]
 *
 * --transcript "text" or --transcript-file path (a .json file with a "text" field, or plain text).
 *
 * What it writes (the same records the WhatsApp bridge writes, plus `plan`):
 *  - the photo (and optional voice note) as stored, rights-confirmed assets of the tenant,
 *  - one "whatsapp-draft" (source "whatsapp", status NeedsConfirmation, simulated: true) whose
 *    `brief` is the transcript and whose `plan` is a deterministic extraction of it
 *    (packages/meta/intake.ts): businessName, description, leadTime, orderWhatsAppNumber, catalog.
 *    The Studio pre-fills the Brief from `plan` when the draft is picked; the merchant confirms
 *    every fact there, so a wrong extraction can never be generated or posted unreviewed.
 *
 * Why not the real intake path: that path needs the signed Meta webhook and an authenticated
 * media download, which cannot run offline. This script writes the same record shapes directly.
 * Nothing leaves the machine. Re-running replaces the draft for the same phone number.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { hash } from "../packages/campaign/index.ts";
import { extractPlan } from "../packages/meta/intake.ts";
import { Engine } from "../server/engine.ts";
import { Store } from "../server/store.ts";
import type { WhatsAppDraft, WhatsAppMedia } from "../server/whatsapp.ts";

const { values } = parseArgs({
  options: {
    photo: { type: "string" },
    voice: { type: "string" },
    transcript: { type: "string" },
    "transcript-file": { type: "string" },
    "data-dir": { type: "string" },
    tenant: { type: "string", default: "local-demo" },
    phone: { type: "string", default: "15555550142" },
    business: { type: "string" },
    timezone: { type: "string" },
    mode: { type: "string", default: "Both" },
    "dry-run": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(`seed-whatsapp-draft: ${message}`);
  process.exit(1);
}

if (!values.photo) fail("--photo <image path> is required");
if (!["Website", "Reels", "Both"].includes(values.mode!)) fail("--mode must be Website, Reels or Both");
if (!/^[\w-]{1,64}$/.test(values.tenant!)) fail("--tenant must be 1 to 64 letters, digits, _ or -");
if (!/^\d{7,15}$/.test(values.phone!)) fail("--phone must be digits only, e.g. 15555550142");

let transcript = values.transcript;
if (!transcript && values["transcript-file"]) {
  const raw = readFileSync(values["transcript-file"], "utf8");
  try {
    const parsed = JSON.parse(raw);
    transcript = typeof parsed?.text === "string" ? parsed.text : raw;
  } catch {
    transcript = raw;
  }
}
transcript = transcript?.replace(/\s+/g, " ").trim();
if (!transcript) fail("--transcript <text> or --transcript-file <path> is required");

const plan = extractPlan(transcript, {
  phone: values.phone,
  business: values.business,
  timezone: values.timezone,
});

if (values["dry-run"]) {
  console.log(JSON.stringify({ transcript, plan }, null, 2));
  process.exit(0);
}

const root = path.resolve(values["data-dir"] || process.env.AXYS_DATA_DIR || "var");
const tenant = values.tenant!;
const store = new Store(root);
const engine = new Engine(store);
const now = new Date().toISOString();
const sender = hash(values.phone!);
const messageId = hash(`seed:${sender}:${transcript}`);
const media: WhatsAppDraft["media"] = [];

async function addMedia(kind: "image" | "audio", file: string) {
  const bytes = readFileSync(file);
  const asset = kind === "image" ? await engine.image(tenant, bytes) : await engine.audio(tenant, bytes);
  const id = hash(`seed:${messageId}:${kind}:${asset.hash}`);
  const row: WhatsAppMedia = {
    id,
    providerMediaId: `simulated-${kind}`,
    providerMessageIdHash: messageId,
    kind,
    status: "Stored",
    assetId: asset.id,
    mime: asset.mime,
    receivedAt: now,
  };
  store.put("whatsapp-media", tenant, id, row);
  media.push({ id, kind, status: "Stored", assetId: asset.id });
}

try {
  await addMedia("image", values.photo!);
  if (values.voice) await addMedia("audio", values.voice);
  store.put("intake", tenant, messageId, {
    id: messageId,
    source: "whatsapp",
    sender,
    text: transcript,
    receivedAt: now,
    status: "NeedsConfirmation",
    simulated: true,
    note: "Simulated WhatsApp message created by scripts/seed-whatsapp-draft.mts; confirm facts in Studio.",
  });
  const draft: WhatsAppDraft = {
    id: sender,
    source: "whatsapp",
    sender,
    brief: transcript,
    messageIds: [messageId],
    media,
    mode: values.mode as WhatsAppDraft["mode"],
    status: "NeedsConfirmation",
    plan,
    simulated: true,
    updatedAt: now,
  };
  store.put("whatsapp-draft", tenant, sender, draft);
  console.log(
    JSON.stringify(
      {
        seeded: true,
        simulated: true,
        dataDir: root,
        tenant,
        draftId: sender,
        media: media.map((m) => m.kind),
        plan,
        next: "Open the Studio with this data dir, sign in to that workspace, and use /?studio=1&draft=whatsapp",
      },
      null,
      2,
    ),
  );
} finally {
  store.db.close();
}
