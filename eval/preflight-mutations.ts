/**
 * Mutation eval for Preflight (the "Red Pen" checks).
 *
 *   npm run eval:preflight            # offline, deterministic, no network
 *   npm run eval:preflight -- --live  # + ~10 Muse Wonder calls (fuzzy claims)
 *
 * Generated campaigns come from the real deterministic `specs()`. Mutations are
 * applied AFTER generation, then the real `deterministicIssuesFromTexts` runs.
 *
 * Families
 *   drift     the artifact text changes but the confirmed facts do not
 *   stale     the confirmed facts change but the artifacts are untouched
 *   benign    equivalent formatting; MUST NOT alarm
 *   debatable formatting that is arguably a real difference; reported apart
 *   control   untouched campaigns; MUST NOT alarm
 *   voice     seller transcript wrong / equivalent
 * Nothing here is hand-entered: every number in the report is counted.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { price, type Campaign } from "../packages/campaign/index.ts";
import {
  deterministicIssuesFromTexts,
  fuzzyIssues,
  surfaceTexts,
  type Issue,
  type Surface,
  type SurfaceTexts,
} from "../packages/meta/preflight.ts";
import { MuseGateway } from "../packages/meta/gateway.ts";
import { bases, clone, type Base } from "./fixtures.ts";
import { groupRates, pct, rate, rateOf, type Rate } from "./metrics.ts";

const groupBy = <T>(items: T[], key: (t: T) => string) => {
  const out: Record<string, T[]> = {};
  for (const it of items) (out[key(it)] ??= []).push(it);
  return out;
};

export type Subject = { c: Campaign; site: SurfaceTexts["site"] };
type Product = Campaign["facts"]["products"][number];
const SURFACES = ["site", "reel", "caption"] as const;
type Where = (typeof SURFACES)[number];

const subjectOf = (c: Campaign): Subject => ({
  c: clone(c),
  site: surfaceTexts(c).site,
});
const textsOf = (s: Subject): SurfaceTexts => ({
  ...surfaceTexts(s.c),
  site: s.site,
});
export const issuesOf = (
  s: Subject,
  voice?: string,
  allCutout = false,
): Issue[] =>
  deterministicIssuesFromTexts(s.c, textsOf(s), voice, {
    cutoutProductIds: new Set(
      allCutout ? s.c.facts.products.map((p) => p.id) : [],
    ),
  });

/** Apply fn to every text unit of a surface; null when nothing changed. */
export function mapText(
  s: Subject,
  where: Where,
  fn: (text: string) => string,
  only?: (unit: { index: number; text: string }) => boolean,
): Subject | null {
  const next: Subject = { c: clone(s.c), site: clone(s.site) };
  let changed = false;
  const apply = (text: string, index: number) => {
    if (only && !only({ index, text })) return text;
    const out = fn(text);
    if (out !== text) changed = true;
    return out;
  };
  if (where === "site") {
    if (!next.site) return null;
    next.site.lines = next.site.lines.map((l, i) => apply(l, i));
  } else if (where === "reel") {
    next.c.reel!.shots = next.c.reel!.shots.map((sh, i) => ({
      ...sh,
      text: apply(sh.text, i),
    }));
  } else {
    next.c.reel!.caption = apply(next.c.reel!.caption, 0);
  }
  return changed ? next : null;
}
const replaceAll = (from: string, to: string) => (t: string) =>
  t.split(from).join(to);

/** Index of the product's own unit: site line after its name, reel shot, caption. */
function priceUnit(s: Subject, where: Where, p: Product) {
  if (where === "reel")
    return (u: { index: number }) =>
      s.c.reel!.shots[u.index].productId === p.id;
  if (where === "site") {
    const lines = s.site!.lines;
    const at = lines.findIndex(
      (l, i) => l === p.name && lines[i + 1] === price(p),
    );
    return (u: { index: number }) => u.index === at + 1;
  }
  return () => true;
}

const money = (minor: number, cur: string) =>
  `${cur} ${(minor / 100).toFixed(2)}`;
const swapCurrency = (c: string) => (c === "INR" ? "USD" : "INR");
export const pickProduct = (c: Campaign) => c.facts.products[0];
/** A product whose name is not a substring of another product's name. */
export const pickNamed = (c: Campaign) =>
  c.facts.products.find(
    (p) =>
      !c.facts.products.some(
        (q) =>
          q.id !== p.id && q.name.toLowerCase().includes(p.name.toLowerCase()),
      ),
  )!;

/* ------------------------------------------------------------------ drift */
export type Case = {
  id: string;
  family: "drift" | "stale" | "benign" | "debatable" | "control" | "voice";
  /** core = a design-intended detection; extension/partial = known-limit probes */
  klass: "core" | "extension" | "partial";
  kind: string;
  surface: Where | "campaign" | "voice";
  base: string;
  /** Should preflight raise a block? */
  expectBlock: boolean;
  subject: Subject;
  voice?: string;
  /** Drift: exact wrong text and the reel shot a correct locate would name. */
  expectedWrong?: string | null;
  expectedShot?: number;
};

type DriftPlan = {
  kind: string;
  klass?: Case["klass"];
  surfaces?: Where[];
  make: (
    s: Subject,
    where: Where,
  ) => { next: Subject | null; wrong?: string | null; shot?: number };
};

const driftPlans: DriftPlan[] = [
  {
    kind: "price_up",
    make: (s, where) => {
      const p = pickProduct(s.c);
      const to = money(
        Math.round((p.priceMinor * 1.2) / 100) * 100 + 100,
        p.currency,
      );
      return {
        next: mapText(
          s,
          where,
          replaceAll(price(p), to),
          priceUnit(s, where, p),
        ),
        wrong: to,
        shot: s.c.reel!.shots.findIndex((x) => x.productId === p.id),
      };
    },
  },
  {
    kind: "price_down",
    make: (s, where) => {
      const p = pickProduct(s.c);
      const to = money(
        Math.max(100, Math.round((p.priceMinor * 0.8) / 100) * 100 - 100),
        p.currency,
      );
      return {
        next: mapText(
          s,
          where,
          replaceAll(price(p), to),
          priceUnit(s, where, p),
        ),
        wrong: to,
        shot: s.c.reel!.shots.findIndex((x) => x.productId === p.id),
      };
    },
  },
  {
    kind: "currency",
    make: (s, where) => {
      const p = pickProduct(s.c);
      const to = money(p.priceMinor, swapCurrency(p.currency));
      return {
        next: mapText(
          s,
          where,
          replaceAll(price(p), to),
          priceUnit(s, where, p),
        ),
        wrong: to,
        shot: s.c.reel!.shots.findIndex((x) => x.productId === p.id),
      };
    },
  },
  {
    kind: "offer",
    make: (s, where) => ({
      next: mapText(s, where, replaceAll(s.c.facts.offer, "Clearance sale")),
      wrong: "Clearance sale",
    }),
  },
  {
    kind: "collection",
    make: (s, where) => {
      const f = s.c.facts.collection;
      const to = /\d/.test(f)
        ? f.replace(/\d+/, (n) => String(Number(n) + 1))
        : "Collection details changed";
      return {
        next: mapText(s, where, replaceAll(f, to)),
        wrong: to,
        shot: 0,
      };
    },
  },
  {
    kind: "contact",
    surfaces: ["site", "caption"],
    make: (s, where) => {
      const f = s.c.facts.contact;
      const to = f.replace(/\/\/[^/]+/, "//other-shop.example");
      if (where === "caption")
        return { next: mapText(s, where, replaceAll(f, to)), wrong: to };
      const next: Subject = { c: clone(s.c), site: clone(s.site) };
      next.site!.hrefs = next.site!.hrefs.map((h) => (h === f ? to : h));
      next.site!.anchors = next.site!.anchors?.map((a) =>
        a.href === f ? { ...a, href: to } : a,
      );
      return {
        next,
        wrong: s.site!.anchors?.find((a) => a.href === f)?.text ?? null,
      };
    },
  },
  {
    // The confirmed link with a path appended: starts with it, but is another page.
    kind: "contact_extended",
    surfaces: ["site", "caption"],
    make: (s, where) => {
      const f = s.c.facts.contact;
      const to = f.replace(/\/?$/, "/checkout");
      if (where === "caption")
        return { next: mapText(s, where, replaceAll(f, to)), wrong: to };
      const next: Subject = { c: clone(s.c), site: clone(s.site) };
      next.site!.hrefs = next.site!.hrefs.map((h) => (h === f ? to : h));
      next.site!.anchors = next.site!.anchors?.map((x) =>
        x.href === f ? { ...x, href: to } : x,
      );
      return {
        next,
        wrong: s.site!.anchors?.find((x) => x.href === f)?.text ?? null,
      };
    },
  },
  {
    kind: "business",
    surfaces: ["site", "caption"],
    make: (s, where) => ({
      next: mapText(
        s,
        where,
        replaceAll(s.c.facts.business, "Sunrise Traders"),
      ),
      wrong: "Sunrise Traders",
    }),
  },
  {
    kind: "product_name",
    make: (s, where) => {
      const p = pickNamed(s.c);
      return {
        next: mapText(s, where, replaceAll(p.name, "Mystery item")),
        wrong: "Mystery item",
        shot: s.c.reel!.shots.findIndex((x) => x.productId === p.id),
      };
    },
  },
  {
    // The surface promises an expiry date other than the confirmed one.
    kind: "valid_until",
    make: (s, where) => {
      const line = "Valid until 31 December 2030";
      const next: Subject = { c: clone(s.c), site: clone(s.site) };
      if (where === "site") next.site!.lines.push(line);
      else if (where === "reel") {
        const last = next.c.reel!.shots.length - 1;
        next.c.reel!.shots[last].text += `\n${line}`;
      } else next.c.reel!.caption += `\n${line}`;
      return { next, wrong: line, shot: s.c.reel!.shots.length - 1 };
    },
  },
  // ---- known-limit probes (reported apart from the headline numbers) ----
  {
    kind: "business_extended",
    klass: "extension",
    surfaces: ["site", "caption"],
    make: (s, where) => ({
      next: mapText(
        s,
        where,
        replaceAll(s.c.facts.business, s.c.facts.business + " Pvt Ltd"),
      ),
      wrong: s.c.facts.business + " Pvt Ltd",
    }),
  },
  {
    kind: "offer_extended",
    klass: "extension",
    surfaces: ["site", "caption"],
    make: (s, where) => ({
      next: mapText(
        s,
        where,
        replaceAll(s.c.facts.offer, s.c.facts.offer + ", now 20% off"),
      ),
      wrong: s.c.facts.offer + ", now 20% off",
    }),
  },
  {
    // Only the first of the repeated occurrences on the site is stale.
    kind: "collection_one_of_two",
    klass: "partial",
    surfaces: ["site"],
    make: (s, where) => {
      const f = s.c.facts.collection;
      const to = /\d/.test(f)
        ? f.replace(/\d+/, (n) => String(Number(n) + 1))
        : "Collection details changed";
      const first = s.site!.lines.findIndex((l) => l === f);
      return {
        next: mapText(s, where, replaceAll(f, to), (u) => u.index === first),
        wrong: to,
      };
    },
  },
];

/* --------------------------------------------------------------- benign ---- */
const WHOLE = (p: Product) => p.priceMinor % 100 === 0;
const amount = (p: Product, dec: boolean) =>
  dec ? (p.priceMinor / 100).toFixed(2) : String(p.priceMinor / 100);
const group = (n: number, indian: boolean) => {
  const [i, d] = n.toFixed(2).split(".");
  const head = indian
    ? i.length > 3
      ? i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + i.slice(-3)
      : i
    : i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${head}.${d}`;
};
const SYM: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };
/** Equivalent renderings of one price (all must read as the same money). */
export function priceVariants(p: Product): Record<string, string> {
  const v: Record<string, string> = {
    symbol: `${SYM[p.currency]}${amount(p, true)}`,
    code_nospace: `${p.currency}${amount(p, true)}`,
    code_lower: `${p.currency.toLowerCase()} ${amount(p, true)}`,
    code_after: `${amount(p, true)} ${p.currency}`,
    symbol_space: `${SYM[p.currency]} ${amount(p, true)}`,
  };
  if (p.priceMinor % 10 === 0)
    v.one_decimal = `${p.currency} ${(p.priceMinor / 100).toFixed(1)}`;
  if (WHOLE(p)) {
    v.symbol_nodecimals = `${SYM[p.currency]}${amount(p, false)}`;
    v.code_nodecimals = `${p.currency} ${amount(p, false)}`;
    v.symbol_slash_dash = `${SYM[p.currency]}${amount(p, false)}/-`;
  }
  if (p.currency === "INR") {
    if (WHOLE(p)) {
      v.rs_dot = `Rs. ${amount(p, false)}`;
      v.rs_nodot = `Rs ${amount(p, false)}`;
      v.rs_glued = `Rs.${amount(p, false)}`;
      v.rupees_word = `${amount(p, false)} rupees`;
    }
    if (p.priceMinor >= 100000) {
      v.indian_grouping = `₹${group(p.priceMinor / 100, true)}`;
      v.western_grouping = `INR ${group(p.priceMinor / 100, false)}`;
    }
  } else if (p.priceMinor >= 100000) {
    v.western_grouping = `${p.currency} ${group(p.priceMinor / 100, false)}`;
  }
  return v;
}
const nonUrl = (fn: (s: string) => string) => (t: string) =>
  t
    .split(/(https?:\/\/[^\s"'<>)]+)/gi)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join("");

type TextVariant = {
  kind: string;
  fn: (t: string) => string;
  surfaces?: Where[];
};
const textVariants: TextVariant[] = [
  {
    kind: "trailing_spaces",
    fn: (t) =>
      t
        .split("\n")
        .map((l) => l + "   ")
        .join("\n"),
  },
  {
    kind: "leading_spaces",
    fn: (t) =>
      t
        .split("\n")
        .map((l) => "  " + l)
        .join("\n"),
  },
  { kind: "double_spaces", fn: nonUrl((t) => t.replace(/ /g, "  ")) },
  { kind: "tabs", fn: nonUrl((t) => t.replace(/ /g, "\t")) },
  { kind: "nbsp", fn: nonUrl((t) => t.replace(/ /g, " ")) },
  {
    kind: "crlf",
    fn: (t) => t.split("\n").join("\r\n"),
    surfaces: ["caption", "reel"],
  },
  { kind: "uppercase", fn: nonUrl((t) => t.toUpperCase()) },
  { kind: "lowercase", fn: nonUrl((t) => t.toLowerCase()) },
  {
    kind: "dash_style",
    fn: (t) => t.replace(/[–—]/g, "-"),
  },
  {
    kind: "dash_en_to_em",
    fn: (t) => t.replace(/—/g, "–"),
  },
  {
    kind: "bullet_prefix",
    fn: (t) =>
      t
        .split("\n")
        .map((l) => (l.trim() ? "• " + l : l))
        .join("\n"),
    surfaces: ["caption"],
  },
  {
    kind: "emoji_prefix",
    fn: (t) =>
      t
        .split("\n")
        .map((l) => (l.trim() ? "✨ " + l : l))
        .join("\n"),
    surfaces: ["caption"],
  },
];

/** The date as a confirmed expiry can legitimately be written. */
function dateForms(iso: string) {
  const d = new Date(iso);
  const day = d.getUTCDate(),
    y = d.getUTCFullYear();
  const long = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][d.getUTCMonth()];
  const short = long.slice(0, 3);
  const suffix =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  return {
    day_month_long: `${day} ${long} ${y}`,
    day_month_short: `${day} ${short} ${y}`,
    month_day_comma: `${long} ${day}, ${y}`,
    ordinal: `${day}${suffix} ${long} ${y}`,
    iso_date: iso.slice(0, 10),
    zero_padded: `${String(day).padStart(2, "0")} ${long} ${y}`,
  };
}
const contactVariants = (contact: string) => {
  const u = new URL(contact);
  const v: Record<string, string> = {
    host_uppercase: contact.replace(u.host, u.host.toUpperCase()),
    default_port: contact.replace(u.host, `${u.host}:443`),
    scheme_uppercase: contact.replace(/^https/, "HTTPS"),
  };
  if (u.pathname === "/" && !contact.endsWith("//"))
    v.root_slash_toggle = contact.endsWith("/")
      ? contact.slice(0, -1)
      : contact + "/";
  return v;
};

/* ----------------------------------------------------------- case builder -- */
export function buildCases(all: Base[] = bases()): Case[] {
  const cases: Case[] = [];
  const push = (c: Omit<Case, "id" | "klass"> & { klass?: Case["klass"] }) =>
    cases.push({
      klass: "core",
      ...c,
      id: `${c.family}/${c.kind}/${c.surface}/${c.base}#${cases.length}`,
    });

  for (const b of all) {
    const base = subjectOf(b.campaign);
    const c0 = b.campaign;

    push({
      family: "control",
      kind: "untouched",
      surface: "campaign",
      base: b.key,
      expectBlock: false,
      subject: base,
    });

    // ---- drift
    for (const plan of driftPlans)
      for (const where of plan.surfaces ?? SURFACES) {
        const made = plan.make(base, where);
        if (!made.next) continue; // fact not present on that surface -> not applicable
        push({
          family: "drift",
          klass: plan.klass ?? "core",
          kind: plan.kind,
          surface: where,
          base: b.key,
          expectBlock: true,
          subject: made.next,
          expectedWrong: made.wrong ?? null,
          expectedShot:
            made.shot !== undefined && made.shot >= 0 ? made.shot : undefined,
        });
      }

    // ---- stale facts (facts edited after generation, artifacts untouched)
    const stale = (kind: string, edit: (c: Campaign) => void) => {
      const next = subjectOf(c0);
      edit(next.c);
      next.c.revision++;
      push({
        family: "stale",
        kind,
        surface: "campaign",
        base: b.key,
        expectBlock: true,
        subject: next,
      });
    };
    const p0 = pickProduct(c0);
    stale("price_up", (c) => {
      c.facts.products[0].priceMinor = p0.priceMinor + 2000;
    });
    stale("price_down", (c) => {
      c.facts.products[0].priceMinor = Math.max(100, p0.priceMinor - 2000);
    });
    stale("currency", (c) => {
      c.facts.products[0].currency = swapCurrency(p0.currency) as never;
    });
    stale("offer", (c) => {
      c.facts.offer = "Clearance sale";
    });
    stale("collection", (c) => {
      c.facts.collection = "Collection moved to next month";
    });
    stale("contact", (c) => {
      c.facts.contact = "https://other-shop.example/contact";
    });
    stale("business", (c) => {
      c.facts.business = "Sunrise Traders";
    });
    stale("product_name", (c) => {
      pickNamed(c).name = "Mystery item";
    });
    stale("valid_until", (c) => {
      c.facts.validUntil = "2030-12-31T18:00:00.000Z";
    });
    if (c0.facts.message)
      stale("message", (c) => {
        c.facts.message = "Fresh daily.";
      });

    // ---- benign formatting (must not alarm)
    for (const where of SURFACES) {
      for (const tv of textVariants) {
        if (tv.surfaces && !tv.surfaces.includes(where)) continue;
        const next = mapText(base, where, tv.fn);
        if (next)
          push({
            family: "benign",
            kind: tv.kind,
            surface: where,
            base: b.key,
            expectBlock: false,
            subject: next,
          });
      }
      // price formats (every product's price on that surface)
      const kinds = new Set(
        c0.facts.products.flatMap((p) => Object.keys(priceVariants(p))),
      );
      for (const kind of kinds) {
        const next = mapText(base, where, (t) => {
          let out = t;
          for (const p of c0.facts.products) {
            const to = priceVariants(p)[kind];
            if (to) out = out.split(price(p)).join(to);
          }
          return out;
        });
        if (next)
          push({
            family: "benign",
            kind: `price_${kind}`,
            surface: where,
            base: b.key,
            expectBlock: false,
            subject: next,
          });
      }
    }
    // headline rewrite (site H1 differs from the offer, as a generator may write it)
    {
      const h = c0.site!.headline;
      const at = base.site!.lines.findIndex((l) => l === h);
      const next = mapText(
        base,
        "site",
        () => "A little something for your festive table",
        (u) => u.index === at,
      );
      if (next)
        push({
          family: "benign",
          kind: "headline_rewrite",
          surface: "site",
          base: b.key,
          expectBlock: false,
          subject: next,
        });
    }
    // contact URL forms
    for (const [kind, to] of Object.entries(
      contactVariants(c0.facts.contact),
    )) {
      const cap = mapText(base, "caption", replaceAll(c0.facts.contact, to));
      if (cap)
        push({
          family: "benign",
          kind: `contact_${kind}`,
          surface: "caption",
          base: b.key,
          expectBlock: false,
          subject: cap,
        });
      const site: Subject = { c: clone(base.c), site: clone(base.site) };
      site.site!.hrefs = site.site!.hrefs.map((h) =>
        h === c0.facts.contact ? to : h,
      );
      push({
        family: "benign",
        kind: `contact_${kind}`,
        surface: "site",
        base: b.key,
        expectBlock: false,
        subject: site,
      });
    }
    // expiry written in equivalent ways (only where a date is confirmed)
    if (c0.facts.validUntil)
      for (const [kind, text] of Object.entries(
        dateForms(c0.facts.validUntil),
      )) {
        const line = `Valid until ${text}`;
        const cap = clone(base);
        cap.c.reel!.caption += `\n${line}`;
        push({
          family: "benign",
          kind: `expiry_${kind}`,
          surface: "caption",
          base: b.key,
          expectBlock: false,
          subject: cap,
        });
        const site = { c: clone(base.c), site: clone(base.site) };
        site.site!.lines.push(line);
        push({
          family: "benign",
          kind: `expiry_${kind}`,
          surface: "site",
          base: b.key,
          expectBlock: false,
          subject: site,
        });
      }

    // ---- debatable (arguably a real difference; not in the benign denominator)
    {
      const bare = mapText(base, "caption", (t) =>
        t.split(price(p0)).join(amount(p0, true)),
      );
      if (bare)
        push({
          family: "debatable",
          kind: "price_without_currency",
          surface: "caption",
          base: b.key,
          expectBlock: false,
          subject: bare,
        });
      const u = new URL(c0.facts.contact);
      if (u.pathname !== "/") {
        const to = c0.facts.contact + "/";
        const cap = mapText(base, "caption", replaceAll(c0.facts.contact, to));
        if (cap)
          push({
            family: "benign",
            kind: "contact_path_trailing_slash",
            surface: "caption",
            base: b.key,
            expectBlock: false,
            subject: cap,
          });
        const site: Subject = { c: clone(base.c), site: clone(base.site) };
        site.site!.hrefs = site.site!.hrefs.map((h) =>
          h === c0.facts.contact ? to : h,
        );
        push({
          family: "benign",
          kind: "contact_path_trailing_slash",
          surface: "site",
          base: b.key,
          expectBlock: false,
          subject: site,
        });
      }
      const utm =
        c0.facts.contact +
        (c0.facts.contact.includes("?") ? "&" : "?") +
        "utm_source=reel";
      const cap = mapText(base, "caption", replaceAll(c0.facts.contact, utm));
      if (cap)
        push({
          family: "debatable",
          kind: "contact_tracking_param",
          surface: "caption",
          base: b.key,
          expectBlock: false,
          subject: cap,
        });
    }

    // ---- voice
    {
      const spoken = (money: string) => `The ${p0.name} is ${money} this week.`;
      push({
        family: "control",
        kind: "voice_exact",
        surface: "voice",
        base: b.key,
        expectBlock: false,
        subject: base,
        voice: spoken(price(p0)),
      });
      for (const [kind, text] of Object.entries(priceVariants(p0)))
        push({
          family: "benign",
          kind: `voice_${kind}`,
          surface: "voice",
          base: b.key,
          expectBlock: false,
          subject: base,
          voice: spoken(text),
        });
      const wrong = money(p0.priceMinor + 4000, p0.currency);
      push({
        family: "voice",
        kind: "voice_wrong_price",
        surface: "voice",
        base: b.key,
        expectBlock: true,
        subject: base,
        voice: spoken(wrong),
      });
    }
  }
  return cases;
}

/* ----------------------------------------------------------------- scoring -- */
export type CaseResult = {
  id: string;
  family: Case["family"];
  klass: Case["klass"];
  kind: string;
  surface: Case["surface"];
  base: string;
  expectBlock: boolean;
  /** any block issue anywhere */
  blocked: boolean;
  /** any block issue on the mutated surface (drift) */
  blockedOnSurface: boolean;
  issues: {
    surface: string;
    text: string;
    found: string;
    locateText: string | null;
    box: boolean;
  }[];
  /** drift only */
  locateExact?: boolean;
  shotRight?: boolean | null;
  invariantViolations: string[];
};

const inUnit = (b: number[]) =>
  b.length === 4 &&
  b.every((x) => x >= 0 && x <= 1) &&
  b[2] > 0 &&
  b[3] > 0 &&
  b[0] + b[2] <= 1 + 1e-9 &&
  b[1] + b[3] <= 1 + 1e-9;

/** Locate/fix invariants that must hold for EVERY issue, correct or not. */
export function invariants(
  s: Subject,
  issues: Issue[],
  issuesCutout: Issue[],
): string[] {
  const v: string[] = [];
  const t = textsOf(s);
  const lines: Record<string, string[]> = {
    site: t.site?.lines ?? [],
    caption: t.caption?.lines ?? [],
    reel: t.reel?.shots.flatMap((x) => x.split("\n")) ?? [],
  };
  for (const set of [issues, issuesCutout])
    for (const i of set) {
      if (!("locate" in i) || !("fix" in i)) v.push("missing locate/fix key");
      if (i.locate) {
        if (i.surface === "voice") v.push("voice issue has locate");
        else if (!lines[i.surface].some((l) => l.includes(i.locate!.text)))
          v.push(`locate.text not on surface: ${i.locate.text}`);
        if (i.locate.reel) {
          if (i.surface !== "reel") v.push("reel box on non-reel issue");
          if (!inUnit(i.locate.reel.box))
            v.push(`box out of [0,1]: ${i.locate.reel.box}`);
          if (
            !Number.isInteger(i.locate.reel.shot) ||
            i.locate.reel.shot < 0 ||
            i.locate.reel.shot >= (s.c.reel?.shots.length ?? 0)
          )
            v.push("bad shot index");
        }
      }
      if (i.severity === "warn" && i.fix) v.push("warn with fix");
      if (i.severity === "block" && i.surface !== "voice" && !i.fix)
        v.push("block without fix");
    }
  if (
    JSON.stringify(
      issues.map((i) => [i.severity, i.surface, i.text, i.expected, i.found]),
    ) !==
    JSON.stringify(
      issuesCutout.map((i) => [
        i.severity,
        i.surface,
        i.text,
        i.expected,
        i.found,
      ]),
    )
  )
    v.push("layout choice changed base issue fields");
  return v;
}

export function runCase(k: Case): CaseResult {
  const issues = issuesOf(k.subject, k.voice, false);
  const cut = issuesOf(k.subject, k.voice, true);
  const blocks = issues.filter((i) => i.severity === "block");
  const onSurface = blocks.filter((i) => i.surface === k.surface);
  const out: CaseResult = {
    id: k.id,
    family: k.family,
    klass: k.klass,
    kind: k.kind,
    surface: k.surface,
    base: k.base,
    expectBlock: k.expectBlock,
    blocked: blocks.length > 0,
    blockedOnSurface: onSurface.length > 0,
    issues: issues.map((i) => ({
      surface: i.surface,
      text: i.text,
      found: i.found,
      locateText: i.locate?.text ?? null,
      box: !!i.locate?.reel,
    })),
    invariantViolations: invariants(k.subject, issues, cut),
  };
  if (k.family === "drift" && k.expectedWrong) {
    const hit = (set: Issue[]) =>
      set.filter(
        (i) =>
          i.severity === "block" &&
          i.surface === k.surface &&
          i.locate?.text === k.expectedWrong,
      );
    out.locateExact = hit(issues).length > 0;
    if (k.surface === "reel" && k.expectedShot !== undefined) {
      const withBox = hit(cut)
        .concat(hit(issues))
        .filter((i) => i.locate?.reel);
      out.shotRight = withBox.length
        ? withBox.some((i) => i.locate!.reel!.shot === k.expectedShot)
        : null;
    }
  }
  return out;
}

export type Summary = ReturnType<typeof summarise>;
export function summarise(results: CaseResult[]) {
  const of = (f: (r: CaseResult) => boolean) => results.filter(f);
  const drift = of((r) => r.family === "drift" && r.klass === "core");
  const detSurface = (r: CaseResult) => r.blockedOnSurface;
  const controls = of((r) => r.family === "control");
  const benign = of((r) => r.family === "benign");
  const locatable = drift.filter(
    (r) => r.blockedOnSurface && r.locateExact !== undefined,
  );
  const reelDrift = locatable.filter(
    (r) => r.shotRight !== undefined && r.shotRight !== null,
  );
  const falseAlarm = (rs: CaseResult[]) =>
    rate(rs.filter((r) => r.blocked).length, rs.length);
  return {
    totals: {
      cases: results.length,
      byFamily: Object.fromEntries(
        Object.entries(groupBy(results, (r) => r.family)).map(([k, v]) => [
          k,
          v.length,
        ]),
      ),
    },
    detection: {
      drift_all_surfaces: rateOf(drift.map(detSurface)),
      drift_by_surface: groupRates(drift, (r) => String(r.surface), detSurface),
      drift_by_kind: groupRates(drift, (r) => r.kind, detSurface),
      drift_by_kind_surface: groupRates(
        drift,
        (r) => `${r.kind} @ ${r.surface}`,
        detSurface,
      ),
      stale_campaign_level: rateOf(
        of((r) => r.family === "stale").map((r) => r.blocked),
      ),
      stale_by_kind: groupRates(
        of((r) => r.family === "stale"),
        (r) => r.kind,
        (r) => r.blocked,
      ),
      voice_wrong_price: rateOf(
        of((r) => r.family === "voice").map((r) => r.blocked),
      ),
      extension_probes_by_kind: groupRates(
        of((r) => r.klass === "extension" && r.family === "drift"),
        (r) => `${r.kind} @ ${r.surface}`,
        detSurface,
      ),
      partial_probes_by_kind: groupRates(
        of((r) => r.klass === "partial"),
        (r) => `${r.kind} @ ${r.surface}`,
        detSurface,
      ),
    },
    falseAlarms: {
      controls: falseAlarm(controls),
      benign_all: falseAlarm(benign),
      benign_by_surface: Object.fromEntries(
        Object.entries(groupBy(benign, (r) => String(r.surface))).map(
          ([k, v]) => [k, falseAlarm(v)],
        ),
      ),
      benign_by_kind: Object.fromEntries(
        Object.entries(groupBy(benign, (r) => r.kind)).map(([k, v]) => [
          k,
          falseAlarm(v),
        ]),
      ),
      debatable_by_kind: Object.fromEntries(
        Object.entries(
          groupBy(
            of((r) => r.family === "debatable"),
            (r) => r.kind,
          ),
        ).map(([k, v]) => [k, falseAlarm(v)]),
      ),
    },
    locate: {
      exact_text_among_detected_drift: rateOf(
        locatable.map((r) => !!r.locateExact),
      ),
      by_kind: groupRates(
        locatable,
        (r) => r.kind,
        (r) => !!r.locateExact,
      ),
      reel_shot_correct_among_boxed: rateOf(
        reelDrift.map((r) => !!r.shotRight),
      ),
      invariant_violations: results.reduce(
        (n, r) => n + r.invariantViolations.length,
        0,
      ),
    },
    failures: {
      missedDrift: drift.filter((r) => !r.blockedOnSurface).map((r) => r.id),
      missedStale: of((r) => r.family === "stale" && !r.blocked).map(
        (r) => r.id,
      ),
      missedVoice: of((r) => r.family === "voice" && !r.blocked).map(
        (r) => r.id,
      ),
      falseAlarmControls: controls
        .filter((r) => r.blocked)
        .map((r) => `${r.id} -> ${r.issues.map((i) => i.text).join(" | ")}`),
      falseAlarmBenign: benign
        .filter((r) => r.blocked)
        .map(
          (r) =>
            `${r.id} -> ${r.issues
              .filter((i) => i)
              .map((i) => `${i.surface}: ${i.text} (found ${i.found})`)
              .join(" | ")}`,
        ),
      invariantViolations: results
        .filter((r) => r.invariantViolations.length)
        .map((r) => `${r.id}: ${r.invariantViolations.join("; ")}`),
    },
  };
}

/* -------------------------------------------------------------------- live -- */
const CLAIMS = [
  {
    key: "organic",
    line: "Made with 100% organic ingredients.",
    needle: "organic",
  },
  {
    key: "free_delivery",
    line: "Free delivery across India.",
    needle: "free delivery",
  },
  { key: "half_off", line: "50% off today only!", needle: "50% off" },
  { key: "award", line: "Award-winning craftsmanship.", needle: "award" },
  {
    key: "health",
    line: "Clinically proven to boost immunity.",
    needle: "clinically",
  },
  { key: "best", line: "Voted the best in the city.", needle: "best" },
  { key: "scarcity", line: "Only 3 left in stock.", needle: "3 left" },
];
export type LiveResult = {
  id: string;
  kind: "claim" | "control";
  claim?: string;
  base: string;
  ok: boolean;
  error?: string;
  model?: string;
  warnings: {
    surface: string;
    text: string;
    found: string;
    locateText: string | null;
  }[];
};
export async function runLive(
  gatewayUrl: string,
): Promise<{ model: string | null; results: LiveResult[]; calls: number }> {
  const gw = new MuseGateway({ baseUrl: gatewayUrl });
  const pool = bases();
  const pick = (k: string) => pool.find((b) => b.key === k)!;
  const claimBases = [
    "bakery",
    "jewellery",
    "sweets",
    "plants",
    "ink",
    "round-price",
    "usd-coffee",
  ];
  const controlBases = ["bakery", "jewellery", "plants"];
  const jobs = [
    ...CLAIMS.map((c, i) => ({
      id: `live/claim/${c.key}`,
      kind: "claim" as const,
      claim: c,
      base: pick(claimBases[i]),
    })),
    ...controlBases.map((k) => ({
      id: `live/control/${k}`,
      kind: "control" as const,
      claim: undefined,
      base: pick(k),
    })),
  ];
  let model: string | null = null;
  const results: LiveResult[] = [];
  for (const j of jobs) {
    const c = clone(j.base.campaign);
    if (j.claim) c.reel!.caption += `\n${j.claim.line}`;
    try {
      const r = await fuzzyIssues(c, gw);
      model = r.model;
      results.push({
        id: j.id,
        kind: j.kind,
        claim: j.claim?.key,
        base: j.base.key,
        ok: true,
        model: r.model,
        warnings: r.issues.map((i) => ({
          surface: i.surface,
          text: i.text,
          found: i.found,
          locateText: i.locate?.text ?? null,
        })),
      });
    } catch (e) {
      results.push({
        id: j.id,
        kind: j.kind,
        claim: j.claim?.key,
        base: j.base.key,
        ok: false,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        warnings: [],
      });
    }
  }
  return { model, results, calls: jobs.length };
}
export function summariseLive(live: Awaited<ReturnType<typeof runLive>>) {
  const claims = live.results.filter((r) => r.kind === "claim" && r.ok);
  const controls = live.results.filter((r) => r.kind === "control" && r.ok);
  const needle = (r: LiveResult) =>
    CLAIMS.find((c) => c.key === r.claim)!.needle;
  const mentions = (r: LiveResult) =>
    r.warnings.some((w) =>
      `${w.text} ${w.found}`.toLowerCase().includes(needle(r)),
    );
  return {
    model: live.model,
    calls: live.calls,
    errors: live.results.filter((r) => !r.ok).length,
    claim_any_caption_warning: rateOf(
      claims.map((r) => r.warnings.some((w) => w.surface === "caption")),
    ),
    claim_warning_names_the_claim: rateOf(claims.map(mentions)),
    claim_locate_exact: rateOf(
      claims.map((r) =>
        r.warnings.some(
          (w) =>
            w.locateText !== null &&
            w.surface === "caption" &&
            needle(r) &&
            w.locateText.toLowerCase().includes(needle(r)),
        ),
      ),
    ),
    control_any_warning: rateOf(controls.map((r) => r.warnings.length > 0)),
    note: "Wonder findings are warnings only (never block). Control campaigns here are the unmodified deterministic captions.",
  };
}

/* ------------------------------------------------------------------ report -- */
const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
const rt = (r: Rate) =>
  `<td>${r.k}/${r.n}</td><td>${r.rate === null ? "n/a" : (r.rate * 100).toFixed(1) + "%"}</td><td>${r.ci95 ? `${(r.ci95[0] * 100).toFixed(1)}–${(r.ci95[1] * 100).toFixed(1)}%` : "n/a"}</td>`;
const table = (
  title: string,
  rows: Record<string, Rate>,
  good: "high" | "low",
) =>
  `<h3>${esc(title)}</h3><table><tr><th>${good === "high" ? "Detected" : "False alarms"}</th><th>k/n</th><th>Rate</th><th>Wilson 95% CI</th></tr>${Object.entries(
    rows,
  )
    .map(([k, r]) => `<tr><td>${esc(k)}</td>${rt(r)}</tr>`)
    .join("")}</table>`;

export function renderHtml(report: any): string {
  const o = report.offline as Summary;
  const live = report.live;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preflight mutation eval</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#1d2420;background:#fbfaf6}h1{font-size:22px}h2{margin-top:32px;border-bottom:1px solid #d8d4c8}h3{margin:20px 0 6px;font-size:15px}table{border-collapse:collapse;width:100%;margin-bottom:8px}th,td{border:1px solid #d8d4c8;padding:4px 8px;text-align:left;font-variant-numeric:tabular-nums}th{background:#efece1}code{background:#efece1;padding:0 3px}.warn{background:#fff3d6;padding:8px 12px;border-left:4px solid #c88a00}.bad{color:#a02020}li{margin:2px 0}@media(prefers-color-scheme:dark){body{background:#151a17;color:#e8ece8}th{background:#222a25}th,td,h2{border-color:#39443d}code{background:#222a25}.warn{background:#3a3115}}</style></head><body>
<h1>Preflight mutation eval</h1>
<p>Generated ${esc(report.generatedAt)} &middot; Node ${esc(report.node)} &middot; ${o.totals.cases} offline cases from ${report.bases} deterministic campaigns.</p>
<div class="warn"><b>Scope.</b> Offline results measure the deterministic exact-match rules only. ${live ? `Live results (${esc(live.model)}, ${live.calls} Wonder calls) are separate below.` : "<b>Fuzzy (Wonder) detection was NOT evaluated in this run</b> (no --live)."} Cases from one campaign are correlated, so the confidence intervals understate the real uncertainty.</div>
<h2>Offline: deterministic rules</h2>
<h3>Headline</h3><table><tr><th>Metric</th><th>k/n</th><th>Rate</th><th>Wilson 95% CI</th></tr>
<tr><td>Drift detected on the mutated surface (core)</td>${rt(o.detection.drift_all_surfaces)}</tr>
<tr><td>Stale-fact edits blocked (campaign level)</td>${rt(o.detection.stale_campaign_level)}</tr>
<tr><td>Wrong spoken price blocked</td>${rt(o.detection.voice_wrong_price)}</tr>
<tr><td>False alarms on untouched controls</td>${rt(o.falseAlarms.controls)}</tr>
<tr><td>False alarms on benign formatting variants</td>${rt(o.falseAlarms.benign_all)}</tr>
<tr><td>Locate.text exactly the mutated text (among detected drift)</td>${rt(o.locate.exact_text_among_detected_drift)}</tr>
<tr><td>Reel box on the correct shot (among boxed reel drift)</td>${rt(o.locate.reel_shot_correct_among_boxed)}</tr></table>
<p>Locate/fix invariant violations across all cases (must be 0): <b>${o.locate.invariant_violations}</b></p>
${table("Detection by surface (drift)", o.detection.drift_by_surface, "high")}
${table("Detection by mutation kind (drift)", o.detection.drift_by_kind, "high")}
${table("Stale-fact edits by kind", o.detection.stale_by_kind, "high")}
${table("False alarms by benign variant", o.falseAlarms.benign_by_kind, "low")}
${table("False alarms by surface (benign)", o.falseAlarms.benign_by_surface, "low")}
${table("Debatable variants (not counted as benign)", o.falseAlarms.debatable_by_kind, "low")}
${table("Known-limit probes: extended text (superstring of the confirmed value)", o.detection.extension_probes_by_kind, "high")}
${table("Known-limit probes: one of two occurrences stale", o.detection.partial_probes_by_kind, "high")}
${table("Locate exactness by kind", o.locate.by_kind, "high")}
<h3>Failures</h3><ul>${[...o.failures.missedDrift, ...o.failures.missedStale, ...o.failures.missedVoice].map((f) => `<li class="bad">missed: ${esc(f)}</li>`).join("") || "<li>No missed core mutations.</li>"}${[...o.failures.falseAlarmControls, ...o.failures.falseAlarmBenign].map((f) => `<li class="bad">false alarm: ${esc(f)}</li>`).join("") || "<li>No false alarms on controls or benign variants.</li>"}</ul>
<h2>Live: Muse Wonder (fuzzy claims)</h2>
${
  live
    ? `<p>Model: <code>${esc(live.model)}</code> &middot; ${live.calls} calls &middot; errors: ${live.errors}</p><table><tr><th>Metric</th><th>k/n</th><th>Rate</th><th>Wilson 95% CI</th></tr>
<tr><td>Caption warning raised for an unsupported claim</td>${rt(live.claim_any_caption_warning)}</tr>
<tr><td>Warning names the claim</td>${rt(live.claim_warning_names_the_claim)}</tr>
<tr><td>Warning text found verbatim (locate)</td>${rt(live.claim_locate_exact)}</tr>
<tr><td>Warnings on unmodified controls (false alarms)</td>${rt(live.control_any_warning)}</tr></table><p>${esc(live.note)}</p>`
    : "<p>Not run. Re-run with <code>--live</code>.</p>"
}
</body></html>`;
}

/* -------------------------------------------------------------------- main -- */
async function main() {
  const live = process.argv.includes("--live");
  const urlArg = process.argv.find((a) => a.startsWith("--gateway="));
  const outDir = path.dirname(fileURLToPath(import.meta.url));
  const all = bases();
  const cases = buildCases(all);
  const results = cases.map(runCase);
  const offline = summarise(results);
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    bases: all.length,
    mode: { live },
    offline,
    live: null,
    notes: [
      "Offline numbers cover deterministic exact-match rules only; fuzzy (Wonder) detection is evaluated only in the live section.",
      "Cases share base campaigns, so Wilson intervals assume independence and are optimistic.",
      "Surface text variants for the site are applied to the rendered site text; reel and caption variants edit the stored reel spec.",
    ],
  };
  if (live) {
    const lr = await runLive(
      urlArg ? urlArg.slice(10) : "http://127.0.0.1:8766",
    );
    report.live = { ...summariseLive(lr), results: lr.results };
  } else
    (report.notes as string[]).push(
      "Fuzzy detection was not evaluated (run with --live).",
    );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "preflight-report.json"),
    JSON.stringify({ ...report, results: undefined }, null, 2),
  );
  writeFileSync(path.join(outDir, "preflight-report.html"), renderHtml(report));
  const o = offline;
  console.log(`cases: ${o.totals.cases}`);
  console.log(
    `drift detected (core):     ${pct(o.detection.drift_all_surfaces)}`,
  );
  for (const [k, r] of Object.entries(o.detection.drift_by_surface))
    console.log(`  ${k.padEnd(8)}  ${pct(r)}`);
  console.log(
    `stale detected:            ${pct(o.detection.stale_campaign_level)}`,
  );
  console.log(
    `voice wrong price:         ${pct(o.detection.voice_wrong_price)}`,
  );
  console.log(`false alarm controls:      ${pct(o.falseAlarms.controls)}`);
  console.log(`false alarm benign:        ${pct(o.falseAlarms.benign_all)}`);
  console.log(
    `locate exact:              ${pct(o.locate.exact_text_among_detected_drift)}`,
  );
  console.log(
    `reel shot correct:         ${pct(o.locate.reel_shot_correct_among_boxed)}`,
  );
  console.log(`invariant violations:      ${o.locate.invariant_violations}`);
  for (const [k, v] of Object.entries(o.failures))
    if (v.length)
      console.log(`${k}: ${v.length}\n  ` + v.slice(0, 12).join("\n  "));
  if (report.live) {
    const l = report.live as ReturnType<typeof summariseLive>;
    console.log(`LIVE model=${l.model} calls=${l.calls} errors=${l.errors}`);
    console.log(
      `  claim -> caption warning:  ${pct(l.claim_any_caption_warning)}`,
    );
    console.log(
      `  warning names claim:       ${pct(l.claim_warning_names_the_claim)}`,
    );
    console.log(`  control warnings:          ${pct(l.control_any_warning)}`);
  } else console.log("fuzzy detection NOT evaluated (no --live)");
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  await main();
