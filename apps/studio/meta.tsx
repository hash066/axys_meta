import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Campaign } from "../../packages/campaign/index";
import "./meta.css";

/* ------------------------------------------------------------------ *
 * Fixture mode: `?fixture=meta` stubs ONLY the new Meta endpoints.
 * Everything it returns is placeholder data and is badged as such.
 * ------------------------------------------------------------------ */
export const FIXTURE =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("fixture") === "meta";
const FIXTURE_ERROR =
  FIXTURE && new URLSearchParams(location.search).get("fx") === "error";
/** `?fixture=meta&scenario=stale` stages the Red Pen scenario (stale price on every surface). */
export const SCENARIO_STALE =
  FIXTURE && new URLSearchParams(location.search).get("scenario") === "stale";
export const STALE_ID = "fx-stale-demo";
/** `?fixture=meta&scenario=command` stages the whole Say it loop (say -> diff -> apply -> red pen -> fix). */
export const SCENARIO_COMMAND =
  FIXTURE && new URLSearchParams(location.search).get("scenario") === "command";
export const COMMAND_ID = "fx-command-demo";

export function FixtureBadge() {
  if (!FIXTURE) return null;
  return (
    <span className="fixture-badge" role="note">
      FIXTURE DATA — not model output
    </span>
  );
}

export class MetaError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export async function liveRequest(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<any> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  let body = rest.body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, { ...rest, headers, body });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new MetaError("Could not reach the Axys server.");
  }
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON body */
  }
  if (!response.ok) {
    const message =
      typeof payload?.error?.message === "string"
        ? payload.error.message.slice(0, 400)
        : response.status === 404
          ? "Not available on this server."
          : `Request failed (${response.status}).`;
    throw new MetaError(message, response.status);
  }
  return payload?.data ?? payload;
}

/* ---------- fixture image generation (canvas placeholders) ---------- */
type FxKind = "orig" | "overlay" | "cutout" | "hero" | "plate";
const fxCache = new Map<string, string>();
const HUES = [24, 200, 330, 95, 260, 45];

function drawProduct(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  idx: number,
  fill: string,
) {
  const bw = w * 0.52,
    bh = h * 0.3,
    x = (w - bw) / 2 + (idx % 2 ? 14 : -10),
    y = h * 0.4;
  const hue = HUES[idx % HUES.length];
  ctx.beginPath();
  ctx.roundRect(x, y, bw, bh, 18);
  ctx.fillStyle = fill || `hsl(${hue} 55% 52%)`;
  ctx.fill();
  if (!fill) {
    ctx.beginPath();
    ctx.roundRect(x - 6, y - 26, bw + 12, 40, 12);
    ctx.fillStyle = `hsl(${hue} 50% 38%)`;
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fillRect(x + bw * 0.18, y + bh * 0.4, bw * 0.64, bh * 0.2);
  }
  return { x, y, bw, bh };
}

function fixtureImage(kind: FxKind, idx: number, scene = 0): string {
  const key = `${kind}:${idx}:${scene}`;
  const hit = fxCache.get(key);
  if (hit) return hit;
  const w = 480,
    h = 600;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  if (kind === "orig" || kind === "overlay") {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#d9cdb6");
    g.addColorStop(1, "#a99b82");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(60,50,35,.18)";
    for (let i = 0; i < 9; i++) ctx.fillRect(i * 60 - 20, 0, 22, h);
    ctx.fillStyle = "rgba(60,50,35,.35)";
    ctx.fillRect(0, h * 0.72, w, h * 0.28);
    const p = drawProduct(ctx, w, h, idx, "");
    if (kind === "overlay") {
      ctx.save();
      ctx.fillStyle = "rgba(20,184,166,.45)";
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.bw, p.bh, 18);
      ctx.roundRect(p.x - 6, p.y - 26, p.bw + 12, 40, 12);
      ctx.fill();
      ctx.strokeStyle = "#0f766e";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  } else if (kind === "cutout") {
    ctx.clearRect(0, 0, w, h);
    drawProduct(ctx, w, h, idx, "");
  } else if (kind === "plate") {
    // A backdrop with NO product: wall, window light, empty tabletop.
    const wall = ctx.createLinearGradient(0, 0, 0, h * 0.64);
    wall.addColorStop(0, scene === 1 ? "#2b2438" : "#efe3cf");
    wall.addColorStop(1, scene === 1 ? "#4a3d62" : "#d2bf9f");
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(
      w * 0.2,
      h * 0.18,
      10,
      w * 0.2,
      h * 0.18,
      w * 0.8,
    );
    glow.addColorStop(0, "rgba(255,244,214,.75)");
    glow.addColorStop(1, "rgba(255,244,214,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    const top = ctx.createLinearGradient(0, h * 0.62, 0, h);
    top.addColorStop(0, scene === 1 ? "#5d4a3a" : "#b98c5a");
    top.addColorStop(1, scene === 1 ? "#2a1f17" : "#7c5a37");
    ctx.fillStyle = top;
    ctx.fillRect(0, h * 0.62, w, h * 0.38);
    ctx.fillStyle = "rgba(255,255,255,.12)";
    ctx.fillRect(0, h * 0.62, w, 3);
    if (scene === 3) {
      // hero plate: tinted studio gradient with a soft floor, nothing on it
      const g = ctx.createRadialGradient(w / 2, h * 0.42, 20, w / 2, h * 0.5, w * 0.95);
      g.addColorStop(0, "#f4dcc2");
      g.addColorStop(0.6, "#c4793f");
      g.addColorStop(1, "#3b2a20");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    } else if (scene === 2) {
      // detail plate: close texture, nothing on it
      ctx.fillStyle = "#8a6034";
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 38; i++) {
        ctx.fillStyle = `rgba(${i % 2 ? "60,36,14" : "230,190,140"},.${(i % 5) + 1}2)`;
        ctx.fillRect(0, i * 16 + ((i * 7) % 9), w, 2 + (i % 3));
      }
    }
  } else {
    const g = ctx.createRadialGradient(w / 2, h * 0.45, 20, w / 2, h / 2, w);
    g.addColorStop(0, scene ? "#f3e7ff" : "#fff6e3");
    g.addColorStop(1, scene ? "#6b4aa0" : "#c9a566");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,.22)";
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.74, w * 0.3, 16, 0, 0, Math.PI * 2);
    ctx.fill();
    drawProduct(ctx, w, h, idx, "");
  }
  const label = {
    orig: "FIXTURE ORIGINAL",
    overlay: "FIXTURE OVERLAY",
    cutout: "FIXTURE CUTOUT",
    hero: "FIXTURE STUDIO SHOT",
    plate: "FIXTURE BACKDROP PLATE (no product)",
  }[kind];
  ctx.fillStyle = "rgba(10,10,10,.78)";
  ctx.fillRect(0, h - 34, w, 34);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 13px Arial, sans-serif";
  ctx.fillText(`${label} — not model output`, 14, h - 12);
  const url = c.toDataURL("image/png");
  fxCache.set(key, url);
  return url;
}

/**
 * Fixture reel frame (9:16 canvas). The returned box is derived from the
 * geometry actually drawn here, so the fixture never invents a position.
 */
const reelCache = new Map<string, { src: string; box: number[] }>();
export function fixtureReelFrame(
  shot: number,
  name: string,
  priceText: string,
  collection: string,
) {
  const key = [shot, name, priceText, collection].join("|");
  const hit = reelCache.get(key);
  if (hit) return hit;
  const w = 540,
    h = 960;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  const out = { src: "", box: [0.3, 0.64, 0.4, 0.07] };
  if (!ctx) return out;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#3b2418");
  g.addColorStop(1, "#150e0b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  if (shot === 0) {
    drawProduct(ctx, w, h * 0.78, 0, "");
    ctx.fillStyle = "#fbf5e9";
    ctx.font = "700 44px Georgia, serif";
    ctx.fillText(name.slice(0, 22), w / 2, h * 0.6);
    ctx.font = "800 46px Arial, sans-serif";
    const tw = ctx.measureText(priceText).width;
    const px = w / 2 - tw / 2 - 26,
      pw = tw + 52,
      py = h * 0.645,
      ph = 70;
    ctx.fillStyle = "#e8b04a";
    ctx.beginPath();
    ctx.roundRect(px, py, pw, ph, 35);
    ctx.fill();
    ctx.fillStyle = "#2a170c";
    ctx.fillText(priceText, w / 2, py + 50);
    out.box = [px / w, py / h, pw / w, ph / h];
  } else {
    ctx.fillStyle = "#fbf5e9";
    ctx.font = "600 30px Arial, sans-serif";
    ctx.fillText("COLLECT", w / 2, h * 0.44);
    ctx.font = "700 40px Georgia, serif";
    ctx.fillText(collection.slice(0, 26), w / 2, h * 0.5);
    out.box = [0.1, 0.46, 0.8, 0.06];
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,.12)";
  ctx.fillRect(0, h - 40, w, 40);
  ctx.fillStyle = "#f3efe6";
  ctx.font = "bold 13px Arial, sans-serif";
  ctx.fillText("FIXTURE REEL FRAME — not model output", 14, h - 15);
  out.src = c.toDataURL("image/png");
  reelCache.set(key, out);
  return out;
}

/** Resolve an asset id from the server to an image URL, or null if malformed. */
export function assetSrc(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const f = /^fixture:(orig|overlay|cutout|hero|plate):(\d{1,2}):(\d)$/.exec(
    id,
  );
  if (f) return FIXTURE ? fixtureImage(f[1] as FxKind, +f[2], +f[3]) : null;
  return /^[A-Za-z0-9_-]{8,64}$/.test(id)
    ? `/api/v1/assets/${encodeURIComponent(id)}`
    : null;
}

/* ---------- normalised, validated server shapes ---------- */
const str = (v: unknown, max = 300) =>
  typeof v === "string" ? v.slice(0, max) : "";
const ID_RE = /^[A-Za-z0-9:_-]{1,80}$/;
const idOf = (v: unknown) =>
  typeof v === "string" && ID_RE.test(v) ? v : null;

type LensProduct = {
  productId: string;
  concept: string;
  found: boolean;
  coverage: number | null;
  bbox: number[] | null;
  size: number[] | null;
  overlayAssetId: string | null;
  cutoutAssetId: string | null;
};
type LensHero = {
  productId: string;
  scene: string;
  assetId: string | null;
  faithful: boolean | null;
  differences: string[];
};
type PlatePurpose = "hero" | "context" | "detail";
type LensPlate = {
  assetId: string;
  backdrop: string;
  purpose: PlatePurpose | null;
};
export const CATEGORIES = [
  "footwear",
  "apparel",
  "jewellery",
  "homeware",
  "food",
  "beverage",
  "beauty",
  "electronics",
  "furniture",
  "toys",
  "stationery",
  "plants",
  "other",
] as const;
export const MOODS = [
  "warm",
  "minimal",
  "bold",
  "playful",
  "luxe",
  "earthy",
  "fresh",
] as const;
/** Muse Spark's reading of the product photo (Addendum 3). Decoration and prompts only; never facts. */
type Direction = {
  /** "spark" = read by Muse Spark; "fallback" = deterministic default after a failed call. */
  source: "spark" | "fallback" | null;
  category: (typeof CATEGORIES)[number];
  subject: string;
  descriptors: string[];
  palette: string[];
  mood: (typeof MOODS)[number] | null;
  motion: "calm" | "punchy" | null;
  worlds: { purpose: PlatePurpose; backdrop: string }[];
  phrases: string[];
};
type Enrichment = {
  campaignId: string;
  products: LensProduct[];
  heroes: LensHero[];
  plates: LensPlate[];
  direction: Direction | null;
  models: string[];
  generatedAt: string;
};

const PURPOSES = ["hero", "context", "detail"] as const;
const purposeOf = (v: unknown): PlatePurpose | null =>
  PURPOSES.includes(v as PlatePurpose) ? (v as PlatePurpose) : null;
/** Visible text only: no control characters, collapsed whitespace. Rendered as React text, never markup. */
const clean = (v: unknown, max: number) =>
  str(v, max * 2)
    .replace(/[\p{Cc}<>]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function parseDirection(raw: unknown): Direction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const list = (v: unknown, n: number) => (Array.isArray(v) ? v.slice(0, n) : []);
  const subject = clean(d.subject, 40);
  const palette = list(d.palette, 3)
    .filter((h): h is string => typeof h === "string" && HEX_RE.test(h))
    .map((h) => h.toLowerCase());
  const phrases = list(d.phrases, 3)
    .map((p) => clean(p, 30))
    .filter((p) => p && p.split(" ").length <= 3);
  const worlds = list(d.worlds, 3)
    .map((w: any) => ({
      purpose: purposeOf(w?.purpose),
      backdrop: clean(w?.backdrop, 240),
    }))
    .filter((w): w is Direction["worlds"][number] => !!w.purpose && !!w.backdrop);
  const category = (CATEGORIES as readonly string[]).includes(d.category as string)
    ? (d.category as Direction["category"])
    : "other";
  const out: Direction = {
    source: d.source === "spark" || d.source === "fallback" ? d.source : null,
    category,
    subject,
    descriptors: list(d.descriptors, 4).map((x) => clean(x, 24)).filter(Boolean),
    palette,
    mood: (MOODS as readonly string[]).includes(d.mood as string)
      ? (d.mood as Direction["mood"])
      : null,
    motion: d.motion === "calm" || d.motion === "punchy" ? d.motion : null,
    worlds,
    phrases,
  };
  // nothing usable at all: show nothing rather than an empty card
  return subject || palette.length || phrases.length || out.mood ? out : null;
}

function parseEnrichment(raw: any, campaignId: string): Enrichment {
  if (!raw || typeof raw !== "object" || raw.campaignId !== campaignId)
    throw new MetaError("The server returned an unexpected Meta Lens result.");
  const nums = (v: unknown, n: number) =>
    Array.isArray(v) &&
    v.length === n &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
      ? (v as number[])
      : null;
  return {
    campaignId,
    products: (Array.isArray(raw.products) ? raw.products : [])
      .slice(0, 12)
      .map((p: any) => ({
        productId: idOf(p?.productId) || "",
        concept: str(p?.concept, 120),
        found: p?.found === true,
        coverage:
          typeof p?.coverage === "number" && Number.isFinite(p.coverage)
            ? Math.min(1, Math.max(0, p.coverage))
            : null,
        bbox: nums(p?.bbox, 4),
        size: nums(p?.size, 2),
        overlayAssetId: idOf(p?.overlayAssetId),
        cutoutAssetId: idOf(p?.cutoutAssetId),
      }))
      .filter((p: LensProduct) => p.productId),
    heroes: (Array.isArray(raw.heroes) ? raw.heroes : [])
      .slice(0, 6)
      .map((h: any) => ({
        productId: idOf(h?.productId) || "",
        scene: str(h?.scene, 240),
        assetId: idOf(h?.assetId),
        faithful: typeof h?.faithful === "boolean" ? h.faithful : null,
        differences: (Array.isArray(h?.differences) ? h.differences : [])
          .slice(0, 8)
          .map((d: unknown) => str(d, 240))
          .filter(Boolean),
      })),
    plates: (Array.isArray(raw.plates) ? raw.plates : [])
      .slice(0, 6)
      .map((p: any) => ({
        assetId: idOf(p?.assetId) || "",
        backdrop: str(p?.backdrop, 300),
        purpose: purposeOf(p?.purpose),
      }))
      .filter((p: LensPlate) => p.assetId),
    direction: parseDirection(raw.direction),
    models: (Array.isArray(raw.models) ? raw.models : [])
      .filter(
        (m: unknown) => typeof m === "string" && /^[\w.\-]{1,40}$/.test(m),
      )
      .slice(0, 8),
    generatedAt: str(raw.generatedAt, 40),
  };
}

export type Locate = {
  text: string;
  reel: { shot: number; box: [number, number, number, number] } | null;
};
export type IssueFix = { kind: "regenerate"; label: string };
export type Issue = {
  severity: "block" | "warn";
  surface: "site" | "reel" | "caption" | "voice" | "other";
  text: string;
  expected: string;
  found: string;
  /** Optional: where the wrong value sits on the artifact (Red Pen). */
  locate: Locate | null;
  /** Optional: the single honest remedy, if the server offers one. */
  fix: IssueFix | null;
};
export type Preflight = {
  campaignId: string;
  ok: boolean;
  issues: Issue[];
  model: string;
  checkedAt: string;
};
function parseLocate(v: any): Locate | null {
  if (!v || typeof v !== "object") return null;
  const text = str(v.text, 200).trim();
  let reel: Locate["reel"] = null;
  const r = v.reel;
  if (
    r &&
    typeof r === "object" &&
    Number.isInteger(r.shot) &&
    r.shot >= 0 &&
    r.shot < 50 &&
    Array.isArray(r.box) &&
    r.box.length === 4 &&
    r.box.every((n: unknown) => typeof n === "number" && Number.isFinite(n))
  ) {
    const [x, y, w, h] = r.box as number[];
    // Anything outside the normalised frame is rejected, never clamped into a guess.
    if (x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1.001 && y + h <= 1.001)
      reel = { shot: r.shot, box: [x, y, w, h] };
  }
  return text || reel ? { text, reel } : null;
}
function parseFix(v: any): IssueFix | null {
  return v && typeof v === "object" && v.kind === "regenerate"
    ? { kind: "regenerate", label: str(v.label, 160) || "Regenerate" }
    : null;
}
export function parsePreflight(raw: any, campaignId: string): Preflight {
  if (!raw || typeof raw !== "object" || raw.campaignId !== campaignId)
    throw new MetaError("The server returned an unexpected preflight result.");
  const surfaces = ["site", "reel", "caption", "voice"];
  return {
    campaignId,
    ok: raw.ok === true,
    issues: (Array.isArray(raw.issues) ? raw.issues : [])
      .slice(0, 50)
      .map((i: any) => ({
        // Unknown severity fails closed: treated as blocking.
        severity: i?.severity === "warn" ? "warn" : "block",
        surface: surfaces.includes(i?.surface) ? i.surface : "other",
        text: str(i?.text, 500),
        expected: str(i?.expected, 300),
        found: str(i?.found, 300),
        locate: parseLocate(i?.locate),
        fix: parseFix(i?.fix),
      })),
    model: str(raw.model, 40),
    checkedAt: str(raw.checkedAt, 40),
  };
}
export type PreflightState = { result: Preflight; revision: number };
export const blockCount = (s: PreflightState | undefined, c: Campaign) =>
  s && s.result.campaignId === c.id && s.revision === c.revision
    ? s.result.issues.filter((i) => i.severity === "block").length
    : 0;

export const SURFACE_LABEL: Record<Issue["surface"], string> = {
  site: "Website",
  reel: "Reel",
  caption: "Caption",
  voice: "Voice brief",
  other: "Other",
};

/** One request path for preflight, shared by the panel and the Red Pen fix flow. */
export async function requestPreflight(
  campaign: Campaign,
  signal?: AbortSignal,
): Promise<Preflight> {
  const raw = FIXTURE
    ? await fixtureRequest(
        `/campaigns/${campaign.id}/preflight`,
        { signal },
        campaign,
      )
    : await liveRequest(`/campaigns/${campaign.id}/preflight`, {
        method: "POST",
        json: {},
        signal,
      });
  return parsePreflight(raw, campaign.id);
}

export const sleepMs = sleep;

const when = (iso: string) => {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? d.toLocaleString() : "";
};

/**
 * Fixture preflight for the Say it scenario: a plain comparison of the confirmed
 * facts with the facts the artifacts were generated from (what the real exact-match
 * rules do), with positions taken from the geometry the fixture reel frame drew.
 */
function fixtureStaleIssues(campaign: Campaign) {
  const art = campaign.site!.facts;
  const money = (q: { currency: string; priceMinor: number }) =>
    `${q.currency} ${(q.priceMinor / 100).toFixed(2)}`;
  const issues: any[] = [];
  const lead = art.products[0];
  campaign.facts.products.forEach((p) => {
    const was = art.products.find((x) => x.id === p.id);
    if (
      !was ||
      (was.priceMinor === p.priceMinor && was.currency === p.currency)
    )
      return;
    const expected = money(p),
      found = money(was);
    const fix = { kind: "regenerate", label: `Regenerate to use ${expected}` };
    issues.push({
      severity: "block",
      surface: "site",
      text: `The website shows a different price for ${p.name}.`,
      expected,
      found,
      locate: { text: found, reel: null },
      fix,
    });
    if (was.id === lead.id)
      issues.push({
        severity: "block",
        surface: "reel",
        text: `The reel text shows a different price for ${p.name}.`,
        expected,
        found,
        locate: {
          text: found,
          reel: {
            shot: 0,
            box: fixtureReelFrame(0, was.name, found, art.collection).box,
          },
        },
        fix,
      });
    issues.push({
      severity: "block",
      surface: "caption",
      text: `The caption shows a different price for ${p.name}.`,
      expected,
      found,
      locate: { text: found, reel: null },
      fix,
    });
  });
  if (campaign.facts.collection !== art.collection) {
    const expected = campaign.facts.collection,
      found = art.collection;
    const fix = { kind: "regenerate", label: `Regenerate to use ${expected}` };
    const tail = (surface: string, text: string, locate: any) =>
      issues.push({
        severity: "block",
        surface,
        text,
        expected,
        found,
        locate,
        fix,
      });
    tail("site", "The website shows a different collection time.", {
      text: found,
      reel: null,
    });
    tail("reel", "The reel shows a different collection time.", {
      text: found,
      reel: {
        shot: 1,
        box: fixtureReelFrame(1, lead.name, money(lead), found).box,
      },
    });
    tail("caption", "The caption shows a different collection time.", {
      text: found,
      reel: null,
    });
  }
  return issues;
}

/* ---------- fixture endpoint handlers ---------- */
const fxRuns = new Map<string, number>();
async function fixtureRequest(
  path: string,
  init: RequestInit,
  campaign?: Campaign,
): Promise<any> {
  const signal = init.signal ?? undefined;
  if (FIXTURE_ERROR) {
    await sleep(700, signal);
    throw new MetaError(
      "Muse gateway is not reachable (fixture error state: ?fx=error).",
      503,
    );
  }
  if (path === "/voice/transcribe") {
    await sleep(900, signal);
    const bytes = (init.body as ArrayBuffer).byteLength;
    return {
      transcript: `[FIXTURE TRANSCRIPT — not speech recognition] ${(bytes / 32000).toFixed(1)}s of audio (${bytes} bytes) reached the stub. Edit this text.`,
    };
  }
  const m = /^\/campaigns\/([^/]+)\/(enrichment|enrich|preflight)(?:\?|$)/.exec(
    path,
  );
  if (!m || !campaign) throw new MetaError("Not available.", 404);
  if (m[2] === "enrichment") throw new MetaError("No enrichment yet.", 404);
  if (m[2] === "enrich") {
    await sleep(3500, signal);
    const q = new URLSearchParams(path.split("?")[1]);
    const scenes = Number(q.get("scenes")) || 1;
    const withPlates = q.get("plates") !== "0";
    const ps = campaign.facts.products;
    return {
      campaignId: campaign.id,
      products: ps.map((p, i) => {
        const found = !(ps.length > 2 && i === 2);
        return {
          productId: p.id,
          concept: p.name,
          found,
          coverage: found ? 0.31 + i * 0.07 : 0,
          bbox: found ? [120, 240, 360, 384] : null,
          size: [480, 600],
          overlayAssetId: found ? `fixture:overlay:${i}:0` : null,
          cutoutAssetId: found ? `fixture:cutout:${i}:0` : null,
        };
      }),
      heroes: Array.from({ length: Math.min(2, scenes) }, (_, s) => ({
        productId: ps[0].id,
        scene: s
          ? "On a dark marble counter, evening light"
          : "Warm wooden table, soft morning light",
        assetId: `fixture:hero:0:${s}`,
        faithful: s ? false : true,
        differences: s
          ? [
              "Lid colour looks lighter than your photo",
              "Label stripe is missing",
            ]
          : [],
      })),
      plates: withPlates
        ? [
            {
              assetId: "fixture:plate:0:3",
              purpose: "hero",
              backdrop:
                "Warm terracotta studio gradient with a soft floor glow, empty centre",
            },
            {
              assetId: "fixture:plate:0:0",
              purpose: "context",
              backdrop:
                "Warm oak tabletop against a plaster wall, soft window light from the left, empty surface in the lower middle",
            },
            {
              assetId: "fixture:plate:0:2",
              purpose: "detail",
              backdrop: "Close view of oiled oak grain, shallow depth, nothing on it",
            },
          ]
        : [],
      direction: withPlates
        ? {
            category: "homeware",
            subject: "ceramic mug",
            descriptors: ["glazed", "terracotta", "rounded handle"],
            palette: ["#c4793f", "#f1e4cf", "#3b2a20"],
            mood: "warm",
            motion: "calm",
            worlds: [
              { purpose: "hero", backdrop: "Terracotta studio gradient, soft floor glow" },
              { purpose: "context", backdrop: "Oak table by a window, morning light" },
              { purpose: "detail", backdrop: "Close oak grain texture" },
            ],
            phrases: ["Made by hand", "Morning ritual"],
          }
        : undefined,
      models: ["sam-3.1", "muse-image-1.0", "muse-spark-1.3"],
      generatedAt: new Date().toISOString(),
    };
  }
  await sleep(1200, signal);
  if (campaign.id === STALE_ID && campaign.site && campaign.reel) {
    const money = (q: { currency: string; priceMinor: number }) =>
      `${q.currency} ${(q.priceMinor / 100).toFixed(2)}`;
    const prod = campaign.facts.products[0];
    const expected = money(prod);
    const found = money(campaign.site.facts.products[0]);
    const warn = {
      severity: "warn",
      surface: "site",
      text: "Headline claims “Best in the city”, which your facts do not support.",
      expected: "No superlative claims",
      found: "Best in the city",
      locate: { text: "Best in the city", reel: null },
      fix: null,
    };
    const issues =
      expected === found
        ? [warn]
        : (() => {
            const frame = fixtureReelFrame(0, prod.name, found, "");
            const fix = {
              kind: "regenerate",
              label: `Regenerate to use ${expected}`,
            };
            return [
              {
                severity: "block",
                surface: "site",
                text: `The website shows a different price for ${prod.name}.`,
                expected,
                found,
                locate: { text: found, reel: null },
                fix,
              },
              {
                severity: "block",
                surface: "reel",
                text: `The reel text shows a different price for ${prod.name}.`,
                expected,
                found,
                locate: { text: found, reel: { shot: 0, box: frame.box } },
                fix,
              },
              {
                severity: "block",
                surface: "caption",
                text: `The caption shows a different price for ${prod.name}.`,
                expected,
                found,
                locate: { text: found, reel: null },
                fix,
              },
              warn,
            ];
          })();
    return {
      campaignId: campaign.id,
      ok: !issues.some((i) => i.severity === "block"),
      issues,
      model: "muse-wonder-1.0",
      checkedAt: new Date().toISOString(),
    };
  }
  if (campaign.id === COMMAND_ID && campaign.site && campaign.reel) {
    const issues = fixtureStaleIssues(campaign);
    return {
      campaignId: campaign.id,
      ok: !issues.some((i) => i.severity === "block"),
      issues,
      model: "muse-wonder-1.0",
      checkedAt: new Date().toISOString(),
    };
  }
  const n = (fxRuns.get(campaign.id) ?? 0) + 1;
  fxRuns.set(campaign.id, n);
  const p = campaign.facts.products[0];
  const price = (minor: number) => `${p.currency} ${(minor / 100).toFixed(2)}`;
  return {
    campaignId: campaign.id,
    ok: n % 2 === 0,
    issues:
      n % 2 === 0
        ? []
        : [
            {
              severity: "block",
              surface: "reel",
              text: `Reel text shows a different price for ${p.name}.`,
              expected: price(p.priceMinor),
              found: price(p.priceMinor + 5000),
              locate: { text: price(p.priceMinor + 5000), reel: null },
              fix: {
                kind: "regenerate",
                label: `Regenerate to use ${price(p.priceMinor)}`,
              },
            },
            {
              severity: "block",
              surface: "caption",
              text: "Caption collection time does not match the confirmed facts.",
              expected: campaign.facts.collection,
              found: "Sunday, 10 am",
            },
            {
              severity: "warn",
              surface: "site",
              text: "Headline claims “best in the city”, which your facts do not support.",
              expected: "No superlative claims",
              found: "Best in the city",
            },
          ],
    model: "muse-wonder-1.0",
    checkedAt: new Date().toISOString(),
  };
}

/* ---------- small shared UI ---------- */
const MODEL_LABEL: Record<string, string> = {
  "sam-3.1": "SAM 3.1",
  "muse-image-1.0": "Muse Image",
  "muse-spark-1.3": "Muse Spark",
  "muse-wonder-1.0": "Muse Wonder",
};
function ModelChip({ id, label }: { id?: string; label?: string }) {
  return (
    <span className="model-chip">{label || MODEL_LABEL[id || ""] || id}</span>
  );
}

const PURPOSE_LABEL: Record<PlatePurpose, { name: string; hint: string }> = {
  hero: { name: "Hero", hint: "studio backdrop" },
  context: { name: "Context", hint: "lifestyle scene" },
  detail: { name: "Detail", hint: "texture" },
};
function sortedPlates(plates: LensPlate[]) {
  const rank = (p: LensPlate) => (p.purpose ? PURPOSES.indexOf(p.purpose) : 9);
  return [...plates].sort((a, b) => rank(a) - rank(b));
}

/** Readable text colour for a swatch: black or white, whichever has the higher contrast. */
function inkFor(hex: string) {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return L > 0.179 ? "#111111" : "#ffffff";
}

function Identity({ d }: { d: Direction }) {
  const subject = d.subject || "this product";
  if (d.source === "fallback")
    return (
      <section className="lens-identity" aria-labelledby="lens-identity-h">
        <div className="ident-head">
          <ModelChip id="muse-spark-1.3" />
          <h3 id="lens-identity-h">Muse Spark could not identify this product</h3>
        </div>
        <p className="ident-desc">
          Axys used a neutral default look ({d.category}
          {d.mood ? `, ${d.mood}` : ""}) with colours taken from your cutout.
          Nothing below was read from the photo by a model, and no kinetic
          phrases are used. Run Meta Lens again to retry.
        </p>
      </section>
    );
  return (
    <section className="lens-identity" aria-labelledby="lens-identity-h">
      <div className="ident-head">
        <ModelChip id="muse-spark-1.3" />
        <h3 id="lens-identity-h">
          Muse Spark identified: <strong>{subject}</strong>
        </h3>
        <span className="ident-cat" title="Category">
          {d.category}
        </span>
      </div>
      {d.descriptors.length > 0 && (
        <p className="ident-desc">
          Seen in your photo: {d.descriptors.join(" · ")}
        </p>
      )}
      <div className="ident-cols">
        {d.palette.length > 0 && (
          <div>
            <h4 id="ident-pal-h">Palette from the photo</h4>
            <ul className="swatches" aria-labelledby="ident-pal-h">
              {d.palette.map((h) => (
                <li
                  key={h}
                  className="swatch"
                  style={{ background: h, color: inkFor(h) }}
                >
                  <span className="sr-only">Colour </span>
                  {h.toUpperCase()}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(d.mood || d.motion) && (
          <div>
            <h4 id="ident-style-h">Film style</h4>
            <ul className="ident-chips" aria-labelledby="ident-style-h">
              {d.mood && (
                <li>
                  <span className="ident-k">Mood</span> {d.mood}
                </li>
              )}
              {d.motion && (
                <li>
                  <span className="ident-k">Motion</span> {d.motion}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
      {d.phrases.length > 0 && (
        <div className="ident-phrases">
          <h4 id="ident-ph-h">
            Kinetic phrases{" "}
            <span className="ident-deco">Decoration, not facts</span>
          </h4>
          <ul aria-labelledby="ident-ph-h">
            {d.phrases.map((ph) => (
              <li key={ph}>{ph}</li>
            ))}
          </ul>
          <small>
            Short mood words for the film. Prices, offers and dates never come
            from here; they come only from your confirmed facts.
          </small>
        </div>
      )}
    </section>
  );
}

function SafeImg({
  src,
  alt,
  className,
}: {
  src: string | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed)
    return (
      <div
        className={`img-missing ${className || ""}`}
        role="img"
        aria-label={`${alt} (image unavailable)`}
      >
        Image unavailable
      </div>
    );
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
    />
  );
}

function Reveal({
  before,
  after,
  label,
  aspect,
}: {
  before: string | null;
  after: string | null;
  label: string;
  aspect: string;
}) {
  const [pos, setPos] = useState(50);
  return (
    <div
      className="reveal"
      style={{ "--pos": `${pos}%`, aspectRatio: aspect } as CSSProperties}
    >
      <SafeImg
        className="reveal-img"
        src={before}
        alt={`Original photo: ${label}`}
      />
      <div className="reveal-after">
        <SafeImg
          className="reveal-img"
          src={after}
          alt={`SAM 3.1 overlay: ${label}`}
        />
      </div>
      <span className="reveal-tag left">Original</span>
      <span className="reveal-tag right">SAM 3.1 overlay</span>
      <div className="reveal-handle" aria-hidden="true">
        <span>⇆</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label={`Compare original and overlay for ${label}`}
        aria-valuetext={`${pos}% original shown, ${100 - pos}% overlay shown`}
      />
    </div>
  );
}

function Fidelity({ faithful }: { faithful: boolean | null }) {
  if (faithful === true)
    return <span className="fidelity ok">✓ Matches your product</span>;
  if (faithful === false)
    return <span className="fidelity differs">! Differs from your photo</span>;
  return <span className="fidelity unknown">? Fidelity not checked</span>;
}

/* ================================================================== *
 * Meta Lens
 * ================================================================== */
export function MetaLens({ campaign }: { campaign: Campaign }) {
  const [data, setData] = useState<Enrichment>();
  const [state, setState] = useState<"loading" | "idle" | "running">("loading");
  const [error, setError] = useState("");
  const [scenes, setScenes] = useState(1);
  const [wantPlates, setWantPlates] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [announce, setAnnounce] = useState("");
  const abort = useRef<AbortController | undefined>(undefined);
  const id = campaign.id;

  const call = useCallback(
    (path: string, init: RequestInit = {}) =>
      FIXTURE ? fixtureRequest(path, init, campaign) : liveRequest(path, init),
    [campaign],
  );

  useEffect(() => {
    const ac = new AbortController();
    setData(undefined);
    setError("");
    setState("loading");
    call(`/campaigns/${id}/enrichment`, { signal: ac.signal })
      .then((raw) => setData(parseEnrichment(raw, id)))
      .catch((e) => {
        if (e?.name === "AbortError") return;
        if (!(e instanceof MetaError && e.status === 404))
          setError(e.message || "Could not load Meta Lens.");
      })
      .finally(() => !ac.signal.aborted && setState("idle"));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (state !== "running") return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  async function run() {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    const timeout = setTimeout(() => ac.abort(), 5 * 60_000);
    setError("");
    setState("running");
    setAnnounce("Meta Lens started. This can take a minute or more.");
    try {
      const raw = await call(
        `/campaigns/${id}/enrich?scenes=${scenes}&plates=${wantPlates ? 1 : 0}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: ac.signal,
        },
      );
      const next = parseEnrichment(raw, id);
      setData(next);
      setAnnounce(
        `Meta Lens finished: ${next.products.filter((p) => p.found).length} of ${next.products.length} products segmented, ${next.heroes.length} studio shots.`,
      );
    } catch (e: any) {
      const msg =
        e?.name === "AbortError"
          ? "Meta Lens timed out or was cancelled. The server may still be working; reload to check."
          : e?.message || "Meta Lens failed.";
      setError(msg);
      setAnnounce(`Meta Lens failed. ${msg}`);
    } finally {
      clearTimeout(timeout);
      setState("idle");
    }
  }

  const products = campaign.facts.products;
  const running = state === "running";
  return (
    <section className="panel lens" aria-labelledby={`lens-h-${id}`}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">META LENS</p>
          <h2 id={`lens-h-${id}`}>See your products the way the models do</h2>
        </div>
        <div className="chip-row" aria-label="Models used">
          {(data?.models.length
            ? data.models
            : ["sam-3.1", "muse-image-1.0", "muse-spark-1.3"]
          ).map((m) => (
            <ModelChip key={m} id={m} />
          ))}
        </div>
      </div>
      <FixtureBadge />
      <p className="muted">
        Segments each product photo with SAM 3.1, then makes a studio shot with
        Muse Image and checks it against your photo with Muse Spark. Run it
        before rendering so cutouts can feed the reel and site. Your original
        photos are never replaced.
      </p>
      <div className="lens-actions">
        <label className="inline-field">
          Studio shots
          <select
            value={scenes}
            disabled={running}
            onChange={(e) => setScenes(Number(e.target.value))}
          >
            <option value={1}>1 (first product)</option>
            <option value={2}>2 (more spend)</option>
          </select>
        </label>
        <label className="inline-field lens-check">
          <input
            type="checkbox"
            checked={wantPlates}
            disabled={running}
            onChange={(e) => setWantPlates(e.target.checked)}
          />
          Backdrop plates (no product in them)
        </label>
        <button onClick={run} disabled={running || state === "loading"}>
          {running
            ? "Running Meta Lens…"
            : data
              ? "Run Meta Lens again"
              : "Run Meta Lens"}
        </button>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      {running && (
        <div className="progress" aria-hidden={false}>
          <div className="progress-bar" aria-hidden="true">
            <i />
          </div>
          <p className="muted">
            Working for {elapsed}s — one request segments every photo, then
            generates and checks the studio shots. The server does not report
            finer progress, so this bar is indeterminate.
          </p>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          Meta Lens could not finish. {error}
        </div>
      )}
      {state === "loading" && (
        <p className="muted">Checking for earlier results…</p>
      )}
      {!data && state === "idle" && !error && (
        <p className="muted">No Meta Lens results for this campaign yet.</p>
      )}
      {data && (
        <div className="lens-results">
          <p className="muted">
            {data.generatedAt && <>Generated {when(data.generatedAt)}. </>}
            {products.length > data.products.length &&
              "Some products were not part of this run."}
          </p>
          {data.direction && <Identity d={data.direction} />}
          {data.products.map((p, i) => {
            const prod = products.find((x) => x.id === p.productId);
            const name = p.concept || prod?.name || "Product";
            const aspect = p.size ? `${p.size[0]} / ${p.size[1]}` : "4 / 5";
            const original = FIXTURE
              ? assetSrc(`fixture:orig:${i}:0`)
              : assetSrc(prod?.assetId);
            const hero = data.heroes.filter((h) => h.productId === p.productId);
            return (
              <article className="lens-product" key={p.productId}>
                <h3>{name}</h3>
                {!p.found ? (
                  <p className="lens-notfound">
                    SAM 3.1 did not find “{name}” in this photo, so there is no
                    cutout. Rename the product to describe what is visible, or
                    use a clearer photo.
                  </p>
                ) : (
                  <div className="lens-grid">
                    <figure>
                      <Reveal
                        before={original}
                        after={assetSrc(p.overlayAssetId)}
                        label={name}
                        aspect={aspect}
                      />
                      <figcaption>
                        Drag or use arrow keys to reveal the SAM overlay.
                        {p.coverage !== null && (
                          <>
                            {" "}
                            Covers {Math.round(p.coverage * 100)}% of the frame.
                          </>
                        )}
                        {p.bbox && (
                          <>
                            {" "}
                            Box {p.bbox.map((n) => Math.round(n)).join(", ")}.
                          </>
                        )}
                      </figcaption>
                    </figure>
                    <figure>
                      <div className="checker" style={{ aspectRatio: aspect }}>
                        <SafeImg
                          src={assetSrc(p.cutoutAssetId)}
                          alt={`Cutout of ${name} on a transparency checkerboard`}
                        />
                      </div>
                      <figcaption>
                        Cutout (checkerboard shows transparency)
                      </figcaption>
                    </figure>
                  </div>
                )}
                {hero.map((h, k) => (
                  <figure className="hero-shot" key={k}>
                    <SafeImg
                      src={assetSrc(h.assetId)}
                      alt={`Muse Image studio shot of ${name}${h.scene ? `: ${h.scene}` : ""}`}
                    />
                    <figcaption>
                      <Fidelity faithful={h.faithful} />
                      <span className="hero-scene">{h.scene}</span>
                      {h.differences.length > 0 && (
                        <ul>
                          {h.differences.map((d, j) => (
                            <li key={j}>{d}</li>
                          ))}
                        </ul>
                      )}
                      <small>
                        Generated image. Review before using it publicly.
                      </small>
                    </figcaption>
                  </figure>
                ))}
              </article>
            );
          })}
          {data.plates.length > 0 && (
            <section
              className="lens-plates"
              aria-labelledby={`lens-plates-h-${id}`}
            >
              <div className="lens-plates-head">
                <h3 id={`lens-plates-h-${id}`}>Backdrop plates: hero, context, detail</h3>
                <ModelChip id="muse-image-1.0" />
              </div>
              <p className="muted">
                Muse Image paints the empty tabletop only. Your real product
                cutout is placed on it in the reel, never regenerated.
              </p>
              <div className="plate-grid">
                {sortedPlates(data.plates).map((pl, k) => (
                  <figure className="plate" key={pl.assetId + k}>
                    <SafeImg
                      src={assetSrc(pl.assetId)}
                      alt={`Muse Image ${pl.purpose ? PURPOSE_LABEL[pl.purpose].name.toLowerCase() + " " : ""}backdrop plate${pl.backdrop ? `: ${pl.backdrop}` : ""}. It contains no product.`}
                    />
                    <figcaption>
                      {pl.purpose && (
                        <span className={`plate-purpose p-${pl.purpose}`}>
                          {PURPOSE_LABEL[pl.purpose].name}
                          <i> · {PURPOSE_LABEL[pl.purpose].hint}</i>
                        </span>
                      )}
                      <span className="plate-tag">No product in the plate</span>
                      <span className="hero-scene">{pl.backdrop}</span>
                      <small>
                        Generated image. A backdrop only, so nothing on it can
                        misstate your product.
                      </small>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}

/* ================================================================== *
 * Preflight
 * ================================================================== */
const SURFACE = SURFACE_LABEL;
export function PreflightPanel({
  campaign,
  state,
  onResult,
  autoRun,
}: {
  campaign: Campaign;
  state: PreflightState | undefined;
  onResult: (s: PreflightState) => void;
  /** Run once on mount when there is no result yet (used by the staged fixture scenario). */
  autoRun?: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [announce, setAnnounce] = useState("");
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    setError("");
    setAnnounce("");
  }, [campaign.id]);

  async function run() {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);
    setError("");
    setAnnounce("Running preflight.");
    try {
      const result = await requestPreflight(campaign, ac.signal);
      onResult({ result, revision: campaign.revision });
      const b = result.issues.filter((i) => i.severity === "block").length;
      const w = result.issues.length - b;
      setAnnounce(
        b
          ? `Preflight found ${b} blocking issue${b > 1 ? "s" : ""} and ${w} warning${w === 1 ? "" : "s"}. Approval is disabled.`
          : `Preflight passed with ${w} warning${w === 1 ? "" : "s"}.`,
      );
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(e?.message || "Preflight failed.");
      setAnnounce("Preflight failed.");
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (autoRun && !state) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current =
    state && state.result.campaignId === campaign.id ? state : undefined;
  const stale = !!current && current.revision !== campaign.revision;
  const issues = stale ? [] : (current?.result.issues ?? []);
  const blocks = issues.filter((i) => i.severity === "block");
  const warns = issues.filter((i) => i.severity === "warn");

  const group = (list: Issue[], kind: "block" | "warn") =>
    list.length > 0 && (
      <section
        className={`pf-group ${kind}`}
        aria-label={kind === "block" ? "Blocking issues" : "Warnings"}
      >
        <h3>
          {kind === "block" ? "Blocking" : "Warnings"}{" "}
          <span>{list.length}</span>
        </h3>
        <ul>
          {list.map((i, k) => (
            <li key={k} className="pf-issue">
              <div className="pf-top">
                <span className="surface-chip">{SURFACE[i.surface]}</span>
                <span className={`sev ${kind}`}>
                  {kind === "block" ? "Must fix" : "Review"}
                </span>
              </div>
              <p>{i.text}</p>
              {(i.expected || i.found) && (
                <dl className="pf-compare">
                  <div>
                    <dt>Expected</dt>
                    <dd>{i.expected || "—"}</dd>
                  </div>
                  <div>
                    <dt>Found</dt>
                    <dd>{i.found || "—"}</dd>
                  </div>
                </dl>
              )}
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <section className="panel preflight" aria-labelledby="pf-h">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">PREFLIGHT</p>
          <h2 id="pf-h">Check every surface against your confirmed facts</h2>
        </div>
        <button className="secondary" onClick={run} disabled={running}>
          {running
            ? "Checking…"
            : current
              ? "Re-run preflight"
              : "Run preflight"}
        </button>
      </div>
      <FixtureBadge />
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      {error && (
        <div className="error" role="alert">
          Preflight could not run. {error}
        </div>
      )}
      {!current && !error && (
        <p className="muted">
          Not run for this version yet. Preflight compares prices, offer text,
          contact link, collection and end date on the website, reel, caption
          and voice brief.
        </p>
      )}
      {stale && (
        <p className="pf-stale" role="status">
          The last result was for an earlier version of this campaign. Run
          preflight again.
        </p>
      )}
      {current && !stale && (
        <>
          <div className={`pf-summary ${blocks.length ? "blocked" : "clear"}`}>
            <strong>
              {blocks.length
                ? `${blocks.length} blocking issue${blocks.length > 1 ? "s" : ""}: approval is disabled`
                : "No blocking issues"}
            </strong>
            <span>
              {warns.length} warning{warns.length === 1 ? "" : "s"}
              {current.result.checkedAt && (
                <> · {when(current.result.checkedAt)}</>
              )}
            </span>
          </div>
          {group(blocks, "block")}
          {group(warns, "warn")}
          <p className="muted pf-foot">
            Checked by <ModelChip label="Muse Wonder" /> + exact-match rules.
            Exact-match mismatches are always blocking; the model only flags
            claims the facts do not support.
          </p>
        </>
      )}
    </section>
  );
}

/* ================================================================== *
 * Voice brief recorder (16 kHz mono PCM16)
 * ================================================================== */
const TARGET_RATE = 16000;
const MAX_SECONDS = 60;

function toPcm16(chunks: Float32Array[], rate: number): Int16Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const flat = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    flat.set(c, o);
    o += c.length;
  }
  let src = flat;
  if (rate !== TARGET_RATE) {
    const ratio = rate / TARGET_RATE;
    const n = Math.floor(flat.length / ratio);
    src = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio,
        i0 = Math.floor(p),
        i1 = Math.min(i0 + 1, flat.length - 1);
      src[i] = flat[i0] + (flat[i1] - flat[i0]) * (p - i0);
    }
  }
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function VoiceRecorder({
  onTranscript,
  disabled,
  variant = "card",
  onError,
  onPhase,
}: {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** "inline": a round mic button only (used by the Say it bar). Errors go to onError. */
  variant?: "card" | "inline";
  onError?: (message: string) => void;
  onPhase?: (phase: "idle" | "recording" | "sending") => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "sending">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [announce, setAnnounce] = useState("");
  const [done, setDone] = useState("");
  const rig = useRef<
    | undefined
    | {
        ctx: AudioContext;
        stream: MediaStream;
        proc: ScriptProcessorNode;
        src: MediaStreamAudioSourceNode;
        chunks: Float32Array[];
        samples: number;
        timer: number;
      }
  >(undefined);
  const meter = useRef<HTMLSpanElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    onPhase?.(phase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  useEffect(() => {
    onError?.(error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      teardown();
    };
  }, []);

  function teardown() {
    const r = rig.current;
    if (!r) return;
    rig.current = undefined;
    clearInterval(r.timer);
    r.proc.onaudioprocess = null;
    try {
      r.proc.disconnect();
      r.src.disconnect();
    } catch {
      /* already disconnected */
    }
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx.close().catch(() => {});
  }

  async function start() {
    setError("");
    setDone("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "This browser cannot record audio here. Type or paste your brief instead.",
      );
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (e: any) {
      setError(
        e?.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it in the browser, or type your brief."
          : e?.name === "NotFoundError"
            ? "No microphone was found."
            : "The microphone could not be opened.",
      );
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      ctx = new AudioContext(); // resampled to 16 kHz before sending
    }
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    const state = { ctx, stream, proc, src, chunks, samples: 0, timer: 0 };
    proc.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      state.samples += input.length;
      let sum = 0;
      for (let i = 0; i < input.length; i += 8) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / (input.length / 8));
      if (meter.current)
        meter.current.style.setProperty(
          "--level",
          String(Math.min(1, rms * 5)),
        );
      if (state.samples / ctx.sampleRate >= MAX_SECONDS) void finish();
    };
    src.connect(proc);
    proc.connect(ctx.destination); // outputs silence; required for events in some browsers
    state.timer = window.setInterval(() => {
      const s = Math.floor(state.samples / ctx.sampleRate);
      setSeconds(s);
      if (s > 0 && s % 15 === 0) setAnnounce(`${s} seconds recorded.`);
    }, 250);
    rig.current = state;
    setSeconds(0);
    setPhase("recording");
    setAnnounce(
      "Recording started. Press stop when you are done, or Escape to discard.",
    );
  }

  function discard() {
    teardown();
    setPhase("idle");
    setSeconds(0);
    setAnnounce("Recording discarded.");
  }

  async function finish() {
    const r = rig.current;
    if (!r) return;
    const rate = r.ctx.sampleRate;
    const chunks = r.chunks;
    teardown();
    if (meter.current) meter.current.style.setProperty("--level", "0");
    const pcm = toPcm16(chunks, rate);
    if (pcm.length < TARGET_RATE / 2) {
      setPhase("idle");
      setError("That recording was too short. Hold on for at least a second.");
      return;
    }
    if (!alive.current) return;
    setPhase("sending");
    setAnnounce("Recording stopped. Transcribing.");
    try {
      const body = pcm.buffer.slice(
        pcm.byteOffset,
        pcm.byteOffset + pcm.byteLength,
      ) as ArrayBuffer;
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      };
      const data = FIXTURE
        ? await fixtureRequest("/voice/transcribe", init)
        : await liveRequest("/voice/transcribe", init);
      const text = str(data?.transcript, 6000).trim();
      if (!text)
        throw new MetaError(
          "No speech was recognised. Try again closer to the microphone.",
        );
      if (!alive.current) return;
      onTranscript(text);
      setDone(
        `Transcript added to your brief (${text.length} characters). Check the wording.`,
      );
      setAnnounce("Transcript added to the brief. Check the wording.");
    } catch (e: any) {
      if (!alive.current) return;
      setError(e?.message || "Transcription failed.");
      setAnnounce("Transcription failed.");
    } finally {
      if (alive.current) setPhase("idle");
    }
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  if (variant === "inline")
    return (
      <div
        className={`voice-inline ${phase}`}
        onKeyDown={(e) => {
          if (e.key === "Escape" && phase === "recording") {
            e.stopPropagation();
            discard();
          }
        }}
      >
        {phase === "recording" && (
          <span className="vi-live">
            <span className="rec-dot" aria-hidden="true" />
            <span
              className="rec-time"
              role="timer"
              aria-label="Recording length"
            >
              {mm}:{ss}
            </span>
            <span className="rec-meter" ref={meter} aria-hidden="true">
              <i />
            </span>
            <button type="button" className="vi-discard" onClick={discard}>
              Discard
            </button>
          </span>
        )}
        <button
          type="button"
          className={`vi-mic${phase === "recording" ? " is-rec" : ""}`}
          aria-label={
            phase === "recording"
              ? "Stop recording and transcribe"
              : phase === "sending"
                ? "Transcribing"
                : "Speak your change"
          }
          disabled={disabled || phase === "sending"}
          onClick={() => (phase === "recording" ? void finish() : void start())}
        >
          {phase === "sending" ? (
            <span className="vi-spin" aria-hidden="true" />
          ) : phase === "recording" ? (
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              aria-hidden="true"
              focusable="false"
            >
              <rect
                x="6"
                y="6"
                width="12"
                height="12"
                rx="2.5"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              width="24"
              height="24"
              aria-hidden="true"
              focusable="false"
            >
              <rect
                x="9"
                y="3"
                width="6"
                height="12"
                rx="3"
                fill="currentColor"
              />
              <path
                d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
        <div className="sr-only" role="status" aria-live="polite">
          {announce}
        </div>
      </div>
    );
  return (
    <div
      className="voice"
      onKeyDown={(e) => {
        if (e.key === "Escape" && phase === "recording") {
          e.stopPropagation();
          discard();
        }
      }}
    >
      <div className="voice-head">
        <strong>Speak your brief</strong>
        <ModelChip label="Muse Voice" />
        <FixtureBadge />
      </div>
      <div className="voice-row">
        {phase === "recording" ? (
          <button
            type="button"
            className="rec-stop"
            onClick={() => void finish()}
          >
            ■ Stop and transcribe
          </button>
        ) : (
          <button
            type="button"
            className="secondary rec-start"
            onClick={() => void start()}
            disabled={disabled || phase === "sending"}
          >
            {phase === "sending" ? "Transcribing…" : "● Record voice brief"}
          </button>
        )}
        {phase === "recording" && (
          <>
            <button type="button" className="text-button" onClick={discard}>
              Discard
            </button>
            <span className="rec-dot" aria-hidden="true" />
            <span
              className="rec-time"
              role="timer"
              aria-label="Recording length"
            >
              {mm}:{ss} / 01:00
            </span>
            <span className="rec-meter" ref={meter} aria-hidden="true">
              <i />
            </span>
          </>
        )}
      </div>
      <p className="muted voice-note">
        Up to 60 seconds, recorded as 16 kHz mono audio. It is sent to the Axys
        server for transcription only after you stop. The transcript lands in
        the brief below, where you can fix it.
      </p>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      {done && <p className="voice-done">{done}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
