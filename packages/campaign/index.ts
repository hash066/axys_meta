import { z } from "zod";
import { createHash } from "node:crypto";
export const Product = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  priceMinor: z.number().int().nonnegative().max(100000000),
  currency: z.enum(["INR", "USD", "EUR", "GBP"]),
  assetId: z.string().uuid(),
});
export const Facts = z.object({
  business: z.string().min(1).max(100),
  offer: z.string().min(1).max(180),
  message: z.string().max(400).optional(),
  collection: z.string().min(1).max(120),
  contact: z
    .string()
    .url()
    .refine(
      (v) =>
        /^https:\/\//.test(v) && !new URL(v).username && !new URL(v).password,
      "Use an HTTPS contact URL",
    ),
  products: z.array(Product).min(1).max(6),
  validUntil: z.string().datetime().optional(),
  confirmed: z.literal(true),
  source: z.enum(["merchant", "whatsapp"]),
});
export const CampaignInput = z.object({
  facts: Facts,
  mode: z.enum(["Website", "Reels", "Both"]),
  layout: z.enum(["editorial", "catalog", "minimal"]),
  reelStyle: z.enum(["warm", "bold"]),
  brief: z.string().max(6000).default(""),
  voiceAssetId: z.string().uuid().optional(),
});
export type Input = z.infer<typeof CampaignInput>;
export type Campaign = Input & {
  id: string;
  tenantId: string;
  revision: number;
  state: string;
  site?: SiteSpec;
  reel?: ReelSpec;
  siteHash?: string;
  videoHash?: string;
  videoAssetId?: string;
  videoPosterId?: string;
  approval?: Approval;
  attempt?: Attempt;
  error?: string;
  trace?: unknown;
  generation?: {
    revision: number;
    ai: boolean;
    videoJobs: {
      id: string;
      contentHash: string;
      productId: string;
      shotIndex: number;
    }[];
    /** Spoken narration of the outcome reel (absent when audio was skipped). */
    narration?: Narration;
    /** Non-fatal problems while generating (for example narration voice unavailable). */
    warnings?: string[];
    /** What the delivered reel carries: voice+bed, bed only, silent, or skipped ({audio:false}). */
    audio?: { mix: "voice+bed" | "bed" | "silent" | "skipped"; reason?: string };
  };
};
export type Narration = {
  text: string;
  voice: string;
  model: string;
  credits: number;
  cached: boolean;
  source: "wonder" | "template";
  /** True when the validated text was reused from the narration text cache. */
  textCached?: boolean;
  /** Model that wrote the words (Muse Wonder) when it answered. */
  textModel?: string | null;
  /** Why the template replaced Wonder, when it did. */
  fallbackReason?: string;
};
export type SiteSpec = {
  schemaVersion: 1;
  facts: Input["facts"];
  layout: Input["layout"];
  headline: string;
  /** Optional Meta enrichment image shown in the site hero (SAM cutout or Muse Image scene). */
  hero?: SiteHero;
};
export type SiteHero = {
  assetId: string;
  kind: "cutout" | "scene";
  alt: string;
};
export type ReelSpec = {
  schemaVersion: 1;
  facts: Input["facts"];
  style: Input["reelStyle"];
  shots: { productId: string; duration: number; text: string }[];
  caption: string;
};
export type Approval = {
  id: string;
  digest: string;
  revision: number;
  accountId: string;
  schedule: string;
  approvedAt: string;
};
export type Attempt = {
  id: string;
  site: string;
  social: string;
  siteUrl?: string;
  containerId?: string;
  mediaId?: string;
  permalink?: string;
  error?: string;
  publishSent?: boolean;
};
export const Proposal = z
  .object({
    headline: z.string().min(1).max(180),
    layout: z.enum(["editorial", "catalog", "minimal"]).optional(),
    reelStyle: z.enum(["warm", "bold"]).optional(),
    productOrder: z.array(z.string().uuid()).max(6).optional(),
    suggestion: z.string().max(800),
    questions: z.array(z.string().max(200)).max(6),
    tool: z.enum(["render", "request_facts", "propose_revision"]),
  })
  .strict();
export function hash(value: unknown) {
  return createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? (value as string)
        : JSON.stringify(value),
    )
    .digest("hex");
}
/** Display form of an amount: USD $129.00, EUR €129.00, GBP £129.00, INR keeps "INR 129.00". */
export function formatMoney(currency: string, minor: number) {
  const n = (minor / 100).toFixed(2);
  return currency === "USD"
    ? `$${n}`
    : currency === "EUR"
      ? `€${n}`
      : currency === "GBP"
        ? `£${n}`
        : `${currency} ${n}`;
}
export const price = (p: Input["facts"]["products"][number]) =>
  formatMoney(p.currency, p.priceMinor);
export function specs(c: Input, headline = c.facts.offer, hero?: SiteHero) {
  const site: SiteSpec = {
    schemaVersion: 1,
    facts: c.facts,
    layout: c.layout,
    headline,
    ...(hero ? { hero } : {}),
  };
  const caption = `${c.facts.business}\n${c.facts.offer}${c.facts.message ? "\n" + c.facts.message : ""}\n${c.facts.products.map((p) => `${p.name} — ${price(p)}`).join("\n")}\n${c.facts.collection}\n${c.facts.contact}`;
  const reel: ReelSpec = {
    schemaVersion: 1,
    facts: c.facts,
    style: c.reelStyle,
    shots: c.facts.products.map((p) => ({
      productId: p.id,
      duration: 4,
      text: `${p.name}\n${price(p)}\n${c.facts.collection}`,
    })),
    caption,
  };
  return { site, reel };
}
export function digest(c: Campaign, accountId: string, schedule: string) {
  return hash({
    revision: c.revision,
    mode: c.mode,
    siteHash: c.siteHash,
    videoHash: c.videoHash,
    caption: c.reel?.caption,
    accountId,
    schedule,
  });
}
export function assertConsistent(c: Campaign) {
  if (
    !c.site ||
    !c.reel ||
    hash(c.site.facts) !== hash(c.facts) ||
    hash(c.reel.facts) !== hash(c.facts) ||
    c.reel.caption !== specs(c).reel.caption ||
    c.siteHash !== hash(c.site)
  )
    throw new Error("Artifact facts do not match. Regenerate before approval.");
}
