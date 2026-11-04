import { numbersIn } from "./command.ts";
import { parsePrices } from "./preflight.ts";

/**
 * Deterministic extraction of a merchant's voice-note transcript into the draft
 * "plan" the Studio pre-fills the Brief from (businessName, description,
 * leadTime, orderWhatsAppNumber, catalog). Plain pattern rules, no model: it
 * reads only what the transcript literally says, leaves everything else empty
 * and lists what it had to infer in `uncertain`. The merchant still confirms
 * every fact in the Brief before anything is generated.
 */
export type DraftPlan = {
  businessName: string;
  description: string;
  /** Collection date and time as the Studio shows it (the Brief joins it with fulfillmentArea). */
  leadTime: string;
  fulfillmentArea?: string;
  orderWhatsAppNumber?: string;
  catalog: { name: string; priceMinor: number; currency: "USD" | "EUR" | "GBP" | "INR" }[];
  source: "deterministic-transcript-extraction";
  uncertain: string[];
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_RE = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function business(text: string, fallback?: string) {
  const m =
    /\b(?:it'?s|it’s|this is|i'?m|i’m|i am|we are|we’re|we're)\s+(?:[A-Z][\w'’-]*\s+)?from\s+((?:[A-Z0-9][\w&'’-]*)(?:\s+(?:&|and|of|the|\+)?\s*[A-Z0-9][\w&'’-]*){0,4})/.exec(
      text,
    ) ??
    /\b(?:at|from)\s+((?:[A-Z][\w&'’-]*)(?:\s+[A-Z][\w&'’-]*){1,3})(?=[,.!]|\s+(?:we|i)\b)/.exec(
      text,
    );
  return (m?.[1] ?? fallback ?? "").replace(/[.,!]+$/, "").trim();
}

function product(text: string) {
  const m =
    /\b(?:dropping|launching|releasing|selling|introducing|have|got|bringing|opening)\s+(?:(?:our|my|the|a|an)\s+)+(?:(?:our|my|the|a|an)\s+)*(?:(new|brand new)\s+)?(.+?)(?=\s+(?:this|next|on|at|from|for|tomorrow|today|starting)\b|[.,!?;]|$)/i.exec(
      text,
    );
  if (!m) return undefined;
  const name = m[2].trim();
  return { name: sentenceCase(name).slice(0, 80), isNew: Boolean(m[1]) };
}

function amount(text: string) {
  const found = parsePrices(text);
  if (found.length)
    return {
      priceMinor: found[0].minor,
      currency: (found[0].currency === "OTHER" ? "USD" : found[0].currency) as DraftPlan["catalog"][number]["currency"],
      distinct: new Set(found.map((f) => `${f.currency}${f.minor}`)).size,
    };
  // Spoken amounts ("eighty nine dollars").
  for (const n of numbersIn(text))
    if (
      n.kind === "word" &&
      /^\s*(?:us\s+)?(?:dollars?|bucks)\b/i.test(text.slice(n.end))
    )
      return { priceMinor: Math.round(n.values[0] * 100), currency: "USD" as const, distinct: 1 };
  return undefined;
}

function collection(text: string, uncertain: string[], timezone?: string) {
  const re = new RegExp(
    String.raw`(?:${WEEKDAY_RE}[,\s]+)?${MONTH_RE}\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?\s*(?:from\s+|between\s+|at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:to|-|–|until|till|and)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`,
    "i",
  );
  const m = re.exec(text);
  if (!m) {
    const d = new RegExp(String.raw`(?:${WEEKDAY_RE}[,\s]+)?${MONTH_RE}\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b`, "i").exec(text);
    if (!d) return "";
    uncertain.push("No collection time was spoken; only the date was found.");
    return `${d[1] ? cap(d[1]) + ", " : ""}${MONTHS[monthIndex(d[2])]} ${Number(d[3])}`;
  }
  const [, wd, mon, day, h1s, m1, ap1, h2s, m2, ap2] = m;
  const h1 = Number(h1s),
    h2 = Number(h2s);
  const norm = (a?: string) => (a ? (a.toLowerCase().startsWith("a") ? "am" : "pm") : undefined);
  let a1 = norm(ap1),
    a2 = norm(ap2);
  if (!a1 || !a2) {
    // "10 to 4": a shop opens in the morning and closes in the afternoon.
    uncertain.push("am/pm was not spoken for the collection time and was inferred.");
    if (!a2 && a1) a2 = a1 === "am" && h2 < h1 ? "pm" : a1 === "am" && h2 === 12 ? "pm" : a1;
    else if (!a1 && a2) a1 = a2 === "pm" && h1 > h2 && h1 !== 12 ? "am" : a2;
    else if (h1 >= 7 && h1 <= 11) {
      a1 = "am";
      a2 = h2 < h1 || h2 <= 8 ? "pm" : h2 === 12 ? "pm" : "am";
    } else {
      a1 = "pm";
      a2 = "pm";
    }
  }
  const clock = (h: number, mm: string | undefined, ap: string) => `${h}${mm && mm !== "00" ? ":" + mm : ""}${ap}`;
  return (
    `${wd ? cap(wd) + ", " : ""}${MONTHS[monthIndex(mon)]} ${Number(day)}, ` +
    `${clock(h1, m1, a1!)} to ${clock(h2, m2, a2!)}${timezone ? " " + timezone : ""}`
  );
}
const monthIndex = (s: string) =>
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
    s.slice(0, 3).toLowerCase(),
  );

export function extractPlan(
  transcript: string,
  opts: { phone?: string; business?: string; timezone?: string } = {},
): DraftPlan {
  const text = transcript.replace(/\s+/g, " ").trim().slice(0, 6000);
  const uncertain: string[] = [];
  const name = business(text, opts.business);
  if (!name) uncertain.push("Business name was not spoken.");
  const item = product(text);
  if (!item) uncertain.push("Product was not recognised.");
  const money = amount(text);
  if (!money) uncertain.push("Price was not recognised.");
  else if (money.distinct > 1) uncertain.push("More than one price was spoken; the first was used.");
  const when = collection(text, uncertain, opts.timezone);
  if (!when) uncertain.push("Collection date and time were not recognised.");
  const phone = (opts.phone ?? /\+?\d[\d\s().-]{7,}\d/.exec(text)?.[0] ?? "").replace(/\D/g, "");
  if (!phone) uncertain.push("No order phone number was given.");
  return {
    businessName: name,
    description: item ? (item.isNew ? `New ${item.name.charAt(0).toLowerCase()}${item.name.slice(1)}` : item.name).slice(0, 180) : "",
    leadTime: when,
    ...(phone ? { orderWhatsAppNumber: phone } : {}),
    catalog:
      item && money
        ? [{ name: item.name, priceMinor: money.priceMinor, currency: money.currency }]
        : [],
    source: "deterministic-transcript-extraction",
    uncertain,
  };
}
