import { z } from "zod";
import { equal, sign } from "./security.ts";
import type { Store } from "./store.ts";
import { Engine, type Asset } from "./engine.ts";
import { hash } from "../packages/campaign/index.ts";
import { randomUUID } from "node:crypto";
import {
  parseButtonId,
  recordDecision,
  verifyButtonReply,
} from "./whatsapp-approval.ts";
import type { Campaign } from "../packages/campaign/index.ts";
import type { DraftPlan } from "../packages/meta/intake.ts";

const MediaKind = z.enum(["image", "audio", "video", "document"]);
export type WhatsAppMediaKind = z.infer<typeof MediaKind>;

export type WhatsAppMedia = {
  id: string;
  providerMediaId: string;
  providerMessageIdHash: string;
  kind: WhatsAppMediaKind;
  caption?: string;
  status: "PendingFetch" | "Stored" | "Unsupported" | "Failed";
  assetId?: string;
  mime?: string;
  receivedAt: string;
  error?: string;
};

export type WhatsAppDraft = {
  id: string;
  source: "whatsapp";
  sender: string;
  brief: string;
  messageIds: string[];
  media: Array<{
    id: string;
    kind: WhatsAppMediaKind;
    status: WhatsAppMedia["status"];
    assetId?: string;
  }>;
  mode?: "Website" | "Reels" | "Both";
  status: "NeedsConfirmation" | "Imported";
  /** Pre-fill for the Brief (deterministic transcript extraction); the merchant still confirms every fact. */
  plan?: DraftPlan;
  /** True for drafts created by scripts/seed-whatsapp-draft.mts, never by the WhatsApp bridge. */
  simulated?: boolean;
  campaignId?: string;
  importedAt?: string;
  updatedAt: string;
};

type Inbound = {
  id: string;
  from: string;
  type: string;
  text?: { body?: unknown };
  image?: { id?: unknown; caption?: unknown };
  audio?: { id?: unknown };
  interactive?: unknown;
  video?: { id?: unknown; caption?: unknown };
  document?: { id?: unknown; caption?: unknown };
};

function explicitMode(text: string): WhatsAppDraft["mode"] {
  const value = text.toLowerCase();
  const website = /\b(website|site|web page)\b/.test(value);
  const reels = /\b(reels?|instagram video)\b/.test(value);
  return website && reels
    ? "Both"
    : website
      ? "Website"
      : reels
        ? "Reels"
        : undefined;
}

function appendBrief(current: string, value?: string) {
  const clean = String(value || "").trim();
  if (!clean) return current;
  return [current, clean].filter(Boolean).join("\n").slice(-6000);
}

function updateDraft(
  store: Store,
  tenant: string,
  sender: string,
  messageId: string,
  text: string,
  media?: WhatsAppMedia,
) {
  const current = store.get<WhatsAppDraft>("whatsapp-draft", tenant, sender);
  const mode = explicitMode(text) || current?.mode;
  const mediaRows = current?.media ? [...current.media] : [];
  if (media && !mediaRows.some((item) => item.id === media.id))
    mediaRows.push({
      id: media.id,
      kind: media.kind,
      status: media.status,
      ...(media.assetId ? { assetId: media.assetId } : {}),
    });
  const draft: WhatsAppDraft = {
    id: sender,
    source: "whatsapp",
    sender,
    brief: appendBrief(current?.brief || "", text),
    messageIds: [...(current?.messageIds || []), messageId].slice(-100),
    media: mediaRows.slice(-24),
    ...(mode ? { mode } : {}),
    ...(current?.campaignId ? { campaignId: current.campaignId } : {}),
    ...(current?.importedAt ? { importedAt: current.importedAt } : {}),
    status: "NeedsConfirmation",
    updatedAt: new Date().toISOString(),
  };
  store.put("whatsapp-draft", tenant, sender, draft);
  return draft;
}

function mediaPart(message: Inbound) {
  if (!MediaKind.options.includes(message.type as WhatsAppMediaKind)) return;
  const part = message[message.type as WhatsAppMediaKind] as
    | { id?: unknown; caption?: unknown }
    | undefined;
  if (!part || typeof part.id !== "string" || !part.id) return;
  return {
    kind: message.type as WhatsAppMediaKind,
    providerMediaId: part.id.slice(0, 512),
    caption:
      typeof part.caption === "string"
        ? part.caption.slice(0, 1024)
        : undefined,
  };
}

export function saveWhatsAppMessage(
  store: Store,
  tenant: string,
  message: Inbound,
) {
  if (typeof message.id !== "string" || !message.id) return false;
  const id = hash(message.id);
  if (store.get("intake", tenant, id)) return false;
  const body =
    message.type === "text" && typeof message.text?.body === "string"
      ? message.text.body.slice(0, 6000)
      : "";
  const part = mediaPart(message);
  const text = appendBrief(body, part?.caption);
  const receivedAt = new Date().toISOString();
  let inserted = false;
  const persist = () => {
    if (store.get("intake", tenant, id)) return;
    let media: WhatsAppMedia | undefined;
    if (part) {
      const mediaId = hash(`${message.id}:${part.providerMediaId}`);
      media = {
        id: mediaId,
        providerMediaId: part.providerMediaId,
        providerMessageIdHash: id,
        kind: part.kind,
        ...(part.caption ? { caption: part.caption } : {}),
        status: ["image", "audio"].includes(part.kind)
          ? "PendingFetch"
          : "Unsupported",
        receivedAt,
        ...(["video", "document"].includes(part.kind)
          ? { error: "This media type is retained as metadata only." }
          : {}),
      };
      store.put("whatsapp-media", tenant, mediaId, media);
      if (media.status === "PendingFetch" && store.db?.prepare)
        store.db
          .prepare(
            "INSERT OR IGNORE INTO jobs(id,tenant,campaign,kind,revision,state,available) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            tenant,
            mediaId,
            "whatsapp-media",
            1,
            "queued",
            Date.now(),
          );
    }
    store.put("intake", tenant, id, {
      id,
      source: "whatsapp",
      sender: hash(message.from),
      text,
      ...(media ? { mediaId: media.id, mediaKind: media.kind } : {}),
      receivedAt,
      status: "NeedsConfirmation",
      note: media
        ? media.status === "PendingFetch"
          ? "Media reference saved for authenticated validation; confirm facts in Studio."
          : "Media reference saved, but this media type is not ingested."
        : "Confirm facts in Studio before generation.",
    });
    updateDraft(store, tenant, hash(message.from), id, text, media);
    inserted = true;
  };
  // Some pure validation callers use a minimal in-memory Store double.
  if (typeof store.transaction === "function") store.transaction(persist);
  else persist();
  return inserted;
}

function saveDecision(
  store: Store,
  tenant: string,
  message: Inbound,
  secret: string,
) {
  const raw = message.interactive as
    | { button_reply?: { id?: unknown } }
    | undefined;
  const id = raw?.button_reply?.id;
  const claim = typeof id === "string" ? parseButtonId(id) : undefined;
  const campaign = claim
    ? store.get<Campaign>("campaign", tenant, claim.campaignId)
    : undefined;
  // The claimed revision and hashes must match the campaign as it is now.
  if (!claim || !campaign || typeof message.id !== "string") return false;
  const subject = {
    tenant,
    campaignId: campaign.id,
    revision: campaign.revision,
    siteHash: campaign.siteHash ?? "",
    videoHash: campaign.videoHash ?? "",
  };
  const action = verifyButtonReply(message, subject, secret);
  return Boolean(
    action &&
      recordDecision(store, subject, action, hash(message.id), hash(message.from)),
  );
}

export function ingestWhatsApp(
  store: Store,
  raw: Buffer,
  signature: string,
  secret: string,
  mapping: Record<string, string>,
  phoneNumberId?: string,
  approvalSecret?: string,
) {
  if (
    raw.length > 100000 ||
    !equal("sha256=" + sign(raw.toString("utf8"), secret), signature)
  )
    throw new Error("Invalid WhatsApp signature");
  const body = JSON.parse(raw.toString("utf8"));
  let accepted = 0;
  let media = 0;
  let decisions = 0;
  for (const entry of (body.entry || []).slice(0, 10))
    for (const change of (entry.changes || []).slice(0, 10)) {
      if (
        phoneNumberId &&
        change.value?.metadata?.phone_number_id !== phoneNumberId
      )
        continue;
      for (const message of (change.value?.messages || []).slice(0, 20)) {
        const tenant = mapping[message.from];
        if (!tenant || !/^[\w-]{1,64}$/.test(tenant)) continue;
        if (message.type === "interactive") {
          if (approvalSecret && saveDecision(store, tenant, message, approvalSecret))
            decisions++;
          continue;
        }
        if (saveWhatsAppMessage(store, tenant, message)) {
          accepted++;
          if (mediaPart(message)) media++;
        }
      }
    }
  return { accepted, media, decisions };
}

function allowedDownload(url: URL) {
  return (
    url.protocol === "https:" &&
    ["facebook.com", "fbcdn.net", "fbsbx.com"].some(
      (suffix) =>
        url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  );
}

export async function fetchWhatsAppMedia(
  store: Store,
  tenant: string,
  id: string,
  options: {
    accessToken: string;
    apiVersion: string;
    fetcher?: typeof fetch;
  },
) {
  const item = store.get<WhatsAppMedia>("whatsapp-media", tenant, id);
  if (!item) throw new Error("WhatsApp media reference not found");
  if (item.status === "Stored")
    return store.get<Asset>("asset", tenant, item.assetId || "");
  if (item.kind !== "image" && item.kind !== "audio")
    throw new Error("Media type is not ingestible");
  const fetcher = options.fetcher || fetch;
  try {
    const metadata = await fetcher(
      `https://graph.facebook.com/${encodeURIComponent(options.apiVersion)}/${encodeURIComponent(item.providerMediaId)}`,
      { headers: { Authorization: `Bearer ${options.accessToken}` } },
    );
    if (!metadata.ok)
      throw new Error(`Meta media metadata HTTP ${metadata.status}`);
    const detail = z
      .object({
        url: z.string().url(),
        mime_type: z.string().max(100).optional(),
        file_size: z
          .number()
          .int()
          .positive()
          .max(12 * 1024 * 1024)
          .optional(),
      })
      .passthrough()
      .parse(await metadata.json());
    const url = new URL(detail.url);
    if (!allowedDownload(url))
      throw new Error("Meta returned an untrusted media URL");
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${options.accessToken}` },
    });
    if (!response.ok)
      throw new Error(`Meta media download HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 12 * 1024 * 1024)
      throw new Error("WhatsApp media exceeds 12MB");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 12 * 1024 * 1024)
      throw new Error("WhatsApp media size is invalid");
    const engine = new Engine(store);
    const asset =
      item.kind === "image"
        ? await engine.image(tenant, bytes)
        : await engine.audio(tenant, bytes);
    const stored: WhatsAppMedia = {
      ...item,
      status: "Stored",
      assetId: asset.id,
      mime: asset.mime,
    };
    delete stored.error;
    store.put("whatsapp-media", tenant, id, stored);
    for (const draft of store.list<WhatsAppDraft>("whatsapp-draft", tenant)) {
      if (!draft.media.some((row) => row.id === id)) continue;
      draft.media = draft.media.map((row) =>
        row.id === id ? { ...row, status: "Stored", assetId: asset.id } : row,
      );
      draft.updatedAt = new Date().toISOString();
      store.put("whatsapp-draft", tenant, draft.id, draft);
      break;
    }
    return asset;
  } catch (error) {
    store.put("whatsapp-media", tenant, id, {
      ...item,
      status: "Failed",
      error:
        error instanceof Error
          ? error.message.slice(0, 200)
          : "Media ingestion failed",
    } satisfies WhatsAppMedia);
    throw error;
  }
}
