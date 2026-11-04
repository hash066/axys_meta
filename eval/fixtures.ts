import { createHash } from "node:crypto";
import { hash, specs, type Campaign } from "../packages/campaign/index.ts";

/** Deterministic UUID-shaped id so reports are reproducible run to run. */
export const detId = (label: string) => {
  const h = createHash("sha256").update(label).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

type ProductSeed = {
  name: string;
  priceMinor: number;
  currency?: "INR" | "USD" | "EUR" | "GBP";
};
type BaseSeed = {
  key: string;
  business: string;
  offer: string;
  message?: string;
  collection: string;
  contact: string;
  validUntil?: string;
  /** Caption/site wording that states the expiry (as a generator might). */
  expiryLine?: string;
  products: ProductSeed[];
  layout?: "editorial" | "catalog" | "minimal";
  reelStyle?: "warm" | "bold";
};

/** Twelve different, realistic merchants (varied length, currency, product
 * count, optional fields) so controls are not a single lucky example. */
export const SEEDS: BaseSeed[] = [
  {
    key: "bakery",
    business: "Test bakery",
    offer: "Weekend collection",
    message: "Baked fresh every morning.",
    collection: "24 October 2026, 4–6pm IST",
    contact: "https://example.com/contact",
    validUntil: "2026-10-25T18:00:00.000Z",
    products: [
      { name: "Bread", priceMinor: 12500 },
      { name: "Sourdough Bread", priceMinor: 21000 },
    ],
  },
  {
    key: "jewellery",
    business: "Meera Silver Studio",
    offer: "Festive silver edit",
    collection: "Diwali 2026 capsule",
    contact: "https://wa.me/919800000001",
    validUntil: "2026-11-08T18:29:00.000Z",
    expiryLine: "Valid until 08 November 2026",
    products: [
      { name: "Jhumka earrings", priceMinor: 129900 },
      { name: "Oxidised anklet", priceMinor: 89900 },
      { name: "Temple pendant", priceMinor: 249900 },
    ],
    layout: "catalog",
    reelStyle: "bold",
  },
  {
    key: "tea",
    business: "Nilgiri Leaf Co",
    offer: "Free tin with any two teas",
    message: "Single estate, small batch.",
    collection: "Autumn flush",
    contact: "https://nilgirileaf.example/shop",
    products: [
      { name: "Second flush Darjeeling", priceMinor: 45000 },
      { name: "Masala chai blend", priceMinor: 32000 },
    ],
    layout: "minimal",
  },
  {
    key: "candles",
    business: "Wick & Wonder",
    offer: "Buy 2 candles for INR 500",
    collection: "Winter scents, limited run",
    contact: "https://wickandwonder.example/order",
    products: [
      { name: "Cedar candle", priceMinor: 29900 },
      { name: "Vanilla bean candle", priceMinor: 29900 },
    ],
    reelStyle: "bold",
  },
  {
    key: "usd-coffee",
    business: "Harbor Roasters",
    offer: "Free shipping over $40",
    message: "Roasted to order.",
    collection: "Spring harvest, ships 3 March 2027",
    contact: "https://harborroasters.example/",
    validUntil: "2027-03-02T23:59:00.000Z",
    products: [
      { name: "Ethiopia Guji 250g", priceMinor: 1850, currency: "USD" },
      { name: "House blend 1kg", priceMinor: 4200, currency: "USD" },
    ],
  },
  {
    key: "single-long-name",
    business: "The Handloom Collective of Pochampally",
    offer: "Hand-woven ikat saree edit",
    message: "Every saree is woven on a pit loom by one artisan family.",
    collection: "Wedding season, pickup from 12 December 2026",
    contact: "https://handloomcollective.example/enquire",
    products: [
      {
        name: "Pochampally double ikat silk saree in indigo and rust",
        priceMinor: 1850000,
      },
    ],
    layout: "editorial",
  },
  {
    key: "gbp-print",
    business: "Fenwick Print Room",
    offer: "Spring print sale",
    collection: "Gallery pickup, Saturday 14 March 2027",
    contact: "https://fenwickprints.example/gallery",
    validUntil: "2027-03-14T12:00:00.000Z",
    expiryLine: "Offer ends 14 March 2027",
    products: [
      { name: "Linocut fox A3", priceMinor: 6500, currency: "GBP" },
      { name: "Riso heron A4", priceMinor: 3500, currency: "GBP" },
      { name: "Moth print A5", priceMinor: 2200, currency: "GBP" },
    ],
    layout: "catalog",
  },
  {
    key: "eur-ceramics",
    business: "Atelier Lune",
    offer: "Studio sale",
    message: "Glazed by hand in small batches.",
    collection: "Open studio 5–7 June 2027",
    contact: "https://atelierlune.example/studio",
    products: [
      { name: "Stoneware mug", priceMinor: 2800, currency: "EUR" },
      { name: "Speckled bowl", priceMinor: 3400, currency: "EUR" },
    ],
    reelStyle: "bold",
  },
  {
    key: "sweets",
    business: "Annapurna Sweets",
    offer: "Diwali boxes, order early",
    collection: "Delivery 28–30 October 2026",
    contact: "https://annapurna.example/diwali",
    validUntil: "2026-10-26T18:29:00.000Z",
    products: [
      { name: "Kaju katli 500g", priceMinor: 65000 },
      { name: "Motichoor ladoo 1kg", priceMinor: 82000 },
      { name: "Soan papdi 400g", priceMinor: 28000 },
      { name: "Gift hamper", priceMinor: 249900 },
    ],
    layout: "catalog",
  },
  {
    key: "plants",
    business: "Green Room Nursery",
    offer: "Monsoon plant swap",
    message: "Repotted and ready to gift.",
    collection: "Nursery pickup, weekends in July",
    contact: "https://greenroom.example/plants",
    products: [
      { name: "Monstera", priceMinor: 89900 },
      { name: "Snake plant", priceMinor: 34900 },
    ],
  },
  {
    key: "ink",
    business: "Quill & Co",
    offer: "Notebook bundle",
    collection: "Back to school 2026",
    contact: "https://quillandco.example/bundle",
    validUntil: "2026-09-30T18:29:00.000Z",
    expiryLine: "Valid till 30 September 2026",
    products: [
      { name: "A5 dotted notebook", priceMinor: 34900 },
      { name: "Fountain pen", priceMinor: 119900 },
    ],
    reelStyle: "bold",
  },
  {
    key: "round-price",
    business: "Rao Spice Mills",
    offer: "Stock-up pack",
    collection: "Ready for dispatch every Monday",
    contact: "https://raospice.example/packs",
    products: [
      { name: "Turmeric 1kg", priceMinor: 20000 },
      { name: "Red chilli 500g", priceMinor: 15000 },
      { name: "Garam masala 250g", priceMinor: 18500 },
    ],
  },
];

export type Base = { key: string; campaign: Campaign };

/** A generated campaign exactly as the deterministic generator stores it. */
export function buildCampaign(seed: BaseSeed): Campaign {
  const c: Campaign = {
    id: detId(seed.key + ":campaign"),
    tenantId: "eval",
    revision: 1,
    state: "Draft",
    mode: "Both",
    layout: seed.layout ?? "editorial",
    reelStyle: seed.reelStyle ?? "warm",
    brief: "",
    facts: {
      business: seed.business,
      offer: seed.offer,
      ...(seed.message ? { message: seed.message } : {}),
      collection: seed.collection,
      contact: seed.contact,
      confirmed: true,
      source: "merchant",
      ...(seed.validUntil ? { validUntil: seed.validUntil } : {}),
      products: seed.products.map((p, i) => ({
        id: detId(`${seed.key}:p${i}`),
        name: p.name,
        priceMinor: p.priceMinor,
        currency: p.currency ?? "INR",
        assetId: detId(`${seed.key}:a${i}`),
      })),
    },
  };
  const s = specs(c);
  if (seed.expiryLine) s.reel.caption += `\n${seed.expiryLine}`;
  Object.assign(c, s, { siteHash: hash(s.site), state: "NeedsReview" });
  return c;
}

export const bases = (): Base[] =>
  SEEDS.map((s) => ({ key: s.key, campaign: buildCampaign(s) }));

/** Deep copy without shared references (as after a store round-trip). */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
