import { createHash } from "node:crypto";
import {
  CampaignInput,
  hash,
  price,
  specs,
  type Campaign,
} from "../campaign/index.ts";
import {
  deterministicIssuesFromTexts,
  surfaceTexts,
  type Issue,
  type SurfaceTexts,
} from "./preflight.ts";

/**
 * Public lab: prepared, fully deterministic "which surface is stale?" scenarios.
 * Surface texts come from the real builders (`specs()` and the real site
 * renderer through `surfaceTexts()`), then exactly one surface gets one subtle
 * mutation. The verdict is the REAL deterministic preflight, never a lookup.
 * No model, no storage, no tenant data.
 */

export const LAB_SURFACES = ["site", "reel", "caption"] as const;
export type LabSurface = (typeof LAB_SURFACES)[number];
export const LAB_ENGINE = "deterministicIssuesFromTexts";

type Mutation = {
  surface: LabSurface;
  /** Replace every occurrence on that surface (the site repeats the offer). */
  from: string;
  to: string;
  /** "link" rewrites the site's href values instead of visible lines. */
  target?: "text" | "href";
};
type Definition = {
  id: string;
  title: string;
  brief: string;
  facts: {
    business: string;
    offer: string;
    message?: string;
    collection: string;
    contact: string;
    products: { name: string; priceMinor: number; currency: "INR" | "USD" | "EUR" | "GBP" }[];
  };
  mutation: Mutation;
};

const DEFINITIONS: Definition[] = [
  {
    id: "bakery-price",
    title: "Saturday cake box",
    brief:
      "A bakery posts its weekend box on the site, as a reel and as a caption.",
    facts: {
      business: "Marigold Bakehouse",
      offer: "Festive cake box with free city delivery",
      message: "Baked the morning of pickup.",
      collection: "Saturday, Nov 21, 10am to 1pm ET",
      contact: "https://marigold.example.com/order",
      products: [
        { name: "Saffron Tea Cake", priceMinor: 6500, currency: "USD" },
        { name: "Raspberry Tart", priceMinor: 4800, currency: "USD" },
      ],
    },
    mutation: { surface: "reel", from: "$48.00", to: "$84.00" },
  },
  {
    id: "pottery-date",
    title: "Studio open day",
    brief: "A pottery studio announces a one-day open sale on every surface.",
    facts: {
      business: "Clayworks Studio",
      offer: "Open-day sale on hand-glazed mugs",
      collection: "Saturday, Nov 14, 11am to 4pm ET",
      contact: "https://clayworks.example.com/visit",
      products: [
        { name: "Glazed Mug", priceMinor: 2800, currency: "USD" },
        { name: "Speckle Bowl", priceMinor: 3600, currency: "USD" },
      ],
    },
    mutation: {
      surface: "reel",
      from: "Saturday, Nov 14",
      to: "Saturday, Nov 15",
    },
  },
  {
    id: "sneaker-contact",
    title: "Sneaker drop",
    brief: "A small shoe label sends everyone to one order page.",
    facts: {
      business: "Stride Lane",
      offer: "Second-pair sneaker drop, numbered runs only",
      message: "Sizes 6 to 11 in the first run.",
      collection: "Friday, Nov 27, 6pm ET",
      contact: "https://stridelane.example.com/order",
      products: [
        { name: "Court Low", priceMinor: 11900, currency: "USD" },
        { name: "Trail Mid", priceMinor: 13900, currency: "USD" },
      ],
    },
    mutation: {
      surface: "site",
      target: "href",
      from: "https://stridelane.example.com/order",
      to: "https://stridelane.example.com/orders",
    },
  },
  {
    id: "coffee-offer",
    title: "Roastery bundle",
    brief: "A roastery runs a bundle offer for the weekend market.",
    facts: {
      business: "Slow Burn Coffee",
      offer: "Buy two bags, get the third free",
      collection: "Sunday, Nov 22, 9am to 2pm ET",
      contact: "https://slowburn.example.com/market",
      products: [
        { name: "Hill Blend", priceMinor: 1800, currency: "USD" },
        { name: "Estate Roast", priceMinor: 2200, currency: "USD" },
      ],
    },
    mutation: {
      surface: "site",
      from: "Buy two bags, get the third free",
      to: "Buy two bags, get the third half off",
    },
  },
  {
    id: "tote-currency",
    title: "Linen totes",
    brief: "A Brooklyn studio sells two totes and reuses one price list everywhere.",
    facts: {
      business: "Loom & Thread",
      offer: "Spring tote edition",
      message: "Washed linen, made in small batches.",
      collection: "Thursday, Dec 3, 5pm ET",
      contact: "https://loomthread.example.com/shop",
      products: [
        { name: "Market Tote", priceMinor: 2400, currency: "USD" },
        { name: "Weekend Tote", priceMinor: 3600, currency: "USD" },
      ],
    },
    mutation: { surface: "caption", from: "$36.00", to: "€36.00" },
  },
  {
    id: "salon-link",
    title: "Salon booking",
    brief: "A salon shares one booking link with its two new treatments.",
    facts: {
      business: "North Light Salon",
      offer: "Winter glow facial week",
      message: "Book early, seats are few.",
      collection: "Monday, Dec 7, 10am to 6pm ET",
      contact: "https://northlight.example.com/book",
      products: [
        { name: "Glow Facial", priceMinor: 8500, currency: "USD" },
        { name: "Scalp Ritual", priceMinor: 6000, currency: "USD" },
      ],
    },
    mutation: {
      surface: "caption",
      from: "https://northlight.example.com/book",
      to: "https://northlight.example.com/book?ref=reel-4821",
    },
  },
];

/** Stable UUID-shaped id so the real Campaign schema validates. */
const uuid = (seed: string) => {
  const h = createHash("sha256").update(`axys-lab:${seed}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

type Built = {
  def: Definition;
  campaign: Campaign;
  texts: SurfaceTexts;
};

function build(def: Definition): Built {
  const input = CampaignInput.parse({
    facts: {
      ...def.facts,
      products: def.facts.products.map((p, i) => ({
        ...p,
        id: uuid(`${def.id}:p${i}`),
        assetId: uuid(`${def.id}:a${i}`),
      })),
      confirmed: true,
      source: "merchant",
    },
    mode: "Both",
    layout: "editorial",
    reelStyle: "warm",
    brief: "",
  });
  const campaign: Campaign = {
    ...input,
    id: uuid(`${def.id}:campaign`),
    tenantId: "public-lab",
    revision: 1,
    state: "NeedsReview",
  };
  const made = specs(campaign);
  Object.assign(campaign, made, { siteHash: hash(made.site) });
  // The REAL text a visitor/viewer reads, then exactly one mutation.
  const clean = surfaceTexts(campaign);
  const texts: SurfaceTexts = JSON.parse(JSON.stringify(clean));
  const { surface, from, to, target } = def.mutation;
  const swap = (s: string) => s.split(from).join(to);
  let changed = false;
  const map = (arr: string[]) =>
    arr.map((s) => {
      const n = swap(s);
      if (n !== s) changed = true;
      return n;
    });
  if (surface === "site" && texts.site) {
    if (target === "href") {
      texts.site.hrefs = map(texts.site.hrefs);
      texts.site.anchors = texts.site.anchors?.map((a) => {
        const href = swap(a.href);
        return { ...a, href };
      });
    } else texts.site.lines = map(texts.site.lines);
  } else if (surface === "reel" && texts.reel) texts.reel.shots = map(texts.reel.shots);
  else if (surface === "caption" && texts.caption)
    texts.caption.lines = map(texts.caption.lines);
  if (!changed)
    throw new Error(`Lab scenario ${def.id} mutation did not apply`);
  return { def, campaign, texts };
}

let cache: Built[] | undefined;
const built = () => (cache ??= DEFINITIONS.map(build));

export type LabScenario = {
  id: string;
  title: string;
  brief: string;
  facts: {
    business: string;
    offer: string;
    collection: string;
    contact: string;
    products: { name: string; price: string }[];
  };
  surfaces: {
    site: { lines: string[]; links: { text: string; href: string }[] };
    reel: { shots: string[] };
    caption: { lines: string[] };
  };
};

const view = (b: Built): LabScenario => {
  const { site, reel, caption } = b.texts;
  const f = b.campaign.facts;
  return {
    id: b.def.id,
    title: b.def.title,
    brief: b.def.brief,
    facts: {
      business: f.business,
      offer: f.offer,
      collection: f.collection,
      contact: f.contact,
      products: f.products.map((p) => ({ name: p.name, price: price(p) })),
    },
    surfaces: {
      site: {
        lines: [...(site?.lines ?? [])],
        links: (site?.anchors ?? []).map(({ text, href }) => ({ text, href })),
      },
      reel: { shots: [...(reel?.shots ?? [])] },
      caption: { lines: [...(caption?.lines ?? [])] },
    },
  };
};

export const labScenarioIds = () => built().map((b) => b.def.id);
export const labScenarios = (): LabScenario[] => built().map(view);

export type LabVerdict = {
  correct: boolean;
  wrongSurface: LabSurface;
  issues: Pick<Issue, "severity" | "surface" | "text" | "expected" | "found">[];
  engine: string;
};

/** Runs the real deterministic preflight over the scenario's three surfaces. */
export function labCheck(
  scenarioId: string,
  guess: LabSurface,
): LabVerdict | undefined {
  const b = built().find((x) => x.def.id === scenarioId);
  if (!b) return undefined;
  const issues = deterministicIssuesFromTexts(b.campaign, b.texts);
  // The engine, not the definition, decides which surface is wrong.
  const wrong = new Set(issues.map((i) => i.surface));
  const wrongSurface = LAB_SURFACES.find((s) => wrong.has(s));
  if (!wrongSurface || wrong.size !== 1)
    throw new Error(`Lab scenario ${scenarioId} is not single-fault`);
  return {
    correct: guess === wrongSurface,
    wrongSurface,
    issues: issues.map(({ severity, surface, text, expected, found }) => ({
      severity,
      surface,
      text,
      expected,
      found,
    })),
    engine: LAB_ENGINE,
  };
}
