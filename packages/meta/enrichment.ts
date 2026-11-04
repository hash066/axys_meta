import { z } from "zod";
import type { Store } from "../../server/store.ts";
import type { Engine, Asset } from "../../server/engine.ts";
import type { Campaign, SiteHero } from "../campaign/index.ts";
import { MuseGateway } from "./gateway.ts";
import { consumeCall } from "./budget.ts";

export const MODELS = ["sam-3.1", "muse-image-1.0", "muse-spark-1.3"] as const;

/** Persisted object. The first block is the public contract; `revision` and
 * `sources` are additive provenance used to ignore stale enrichment. */
export const Enrichment = z.object({
  campaignId: z.string().uuid(),
  products: z.array(
    z.object({
      productId: z.string().uuid(),
      concept: z.string().max(200),
      found: z.boolean(),
      coverage: z.number().min(0).max(1),
      bbox: z
        .tuple([z.number(), z.number(), z.number(), z.number()])
        .nullable(),
      overlayAssetId: z.string().uuid().nullable(),
      cutoutAssetId: z.string().uuid().nullable(),
    }),
  ),
  heroes: z.array(
    z.object({
      productId: z.string().uuid(),
      scene: z.string().max(300),
      assetId: z.string().uuid(),
      faithful: z.boolean().nullable(),
      differences: z.array(z.string().max(500)),
    }),
  ),
  models: z.array(z.string()),
  generatedAt: z.string().datetime(),
  revision: z.number().int().positive(),
  sources: z.record(z.string(), z.string()),
  warnings: z.array(z.string().max(300)).default([]),
});
export type Enrichment = z.infer<typeof Enrichment>;

/** Scene prompts. They never request text, prices, logos or extra objects. */
export const SCENES = [
  "on a clean studio surface with soft natural window light and a muted warm backdrop",
  "on a rustic wooden table in a cosy lifestyle setting with shallow depth of field",
] as const;
const sceneText = (name: string, scene: string) =>
  `Place the product (${name.slice(0, 80)}) ${scene}. Keep the product itself exactly as photographed: same shape, colours, label and quantity. Do not add any text, prices, logos, people, hands or other products.`;

const running = new Set<string>();

export async function enrichCampaign(
  engine: Engine,
  gateway: MuseGateway,
  c: Campaign,
  scenes = 1,
): Promise<Enrichment> {
  if (!Number.isInteger(scenes) || scenes < 0 || scenes > SCENES.length)
    throw new Error(`scenes must be an integer from 0 to ${SCENES.length}`);
  const key = `${c.tenantId}:${c.id}`;
  if (running.has(key)) throw new Error("Enrichment is already running");
  running.add(key);
  try {
    const store = engine.store;
    const products: Enrichment["products"] = [];
    const sources: Record<string, string> = {};
    const warnings: string[] = [];
    const bytesOf = new Map<string, Buffer>();
    for (const p of c.facts.products) {
      const bytes = await engine.bytes(c.tenantId, p.assetId);
      bytesOf.set(p.id, bytes);
      consumeCall(store, c.tenantId, c.id, "sam");
      const seg = await gateway.segment(bytes, p.name);
      const overlay = seg.overlay
        ? (await engine.asset(c.tenantId, seg.overlay, "image/png")).id
        : null;
      const cutout =
        seg.found && seg.cutout
          ? (await engine.asset(c.tenantId, seg.cutout, "image/png")).id
          : null;
      sources[p.id] = p.assetId;
      products.push({
        productId: p.id,
        concept: seg.concept || p.name,
        found: seg.found,
        coverage: seg.coverage,
        bbox: seg.bbox,
        overlayAssetId: overlay,
        cutoutAssetId: cutout,
      });
    }
    const heroes: Enrichment["heroes"] = [];
    const first = c.facts.products[0];
    for (let i = 0; i < scenes; i++) {
      try {
        consumeCall(store, c.tenantId, c.id, "muse-image");
        const scene = SCENES[i];
        const result = await gateway.scene(
          bytesOf.get(first.id)!,
          sceneText(first.name, scene),
        );
        const asset = await engine.asset(c.tenantId, result.image, "image/png");
        heroes.push({
          productId: first.id,
          scene,
          assetId: asset.id,
          faithful: result.faithful,
          differences: result.differences,
        });
      } catch (e) {
        warnings.push(
          `Studio shot ${i + 1} unavailable: ${e instanceof Error ? e.message : "failed"}`.slice(
            0,
            300,
          ),
        );
      }
    }
    const out: Enrichment = {
      campaignId: c.id,
      products,
      heroes,
      models: [...MODELS],
      generatedAt: new Date().toISOString(),
      revision: c.revision,
      sources,
      warnings,
    };
    store.put("enrichment", c.tenantId, c.id, out);
    return out;
  } finally {
    running.delete(key);
  }
}

export function loadEnrichment(store: Store, c: Campaign) {
  const raw = store.get<unknown>("enrichment", c.tenantId, c.id);
  const parsed = Enrichment.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export type UsableMedia = {
  /** productId -> cutout asset id (only when the source photo is unchanged). */
  cutouts: Map<string, string>;
  hero?: SiteHero;
};
/**
 * Enrichment that may be rendered for the campaign's CURRENT products. An
 * entry is used only if the product still exists with the same source photo
 * and the stored asset is still an image/png in this workspace. Muse Image
 * scenes are used only when the fidelity check said `faithful === true`.
 */
export function usableMedia(store: Store, c: Campaign): UsableMedia {
  const media: UsableMedia = { cutouts: new Map() };
  const e = loadEnrichment(store, c);
  if (!e) return media;
  const png = (id: string | null) =>
    !!id && store.get<Asset>("asset", c.tenantId, id)?.mime === "image/png";
  const current = (productId: string) =>
    c.facts.products.find(
      (p) => p.id === productId && e.sources[productId] === p.assetId,
    );
  for (const p of e.products) {
    if (p.found && current(p.productId) && png(p.cutoutAssetId))
      media.cutouts.set(p.productId, p.cutoutAssetId!);
  }
  const scene = e.heroes.find(
    (h) => h.faithful === true && current(h.productId) && png(h.assetId),
  );
  if (scene)
    media.hero = {
      assetId: scene.assetId,
      kind: "scene",
      alt: `${current(scene.productId)!.name} studio shot`,
    };
  else {
    for (const p of c.facts.products) {
      const id = media.cutouts.get(p.id);
      if (id) {
        media.hero = { assetId: id, kind: "cutout", alt: p.name };
        break;
      }
    }
  }
  return media;
}
