import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./bench.css";
import { Icon, Reveal, SectionHead, Tag, useInView } from "./landing-kit";

const L = "/landing/";
const LAB = "/api/v1/public/lab";

async function lab<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(LAB + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json"))
    throw new Error("lab unavailable");
  return (await r.json()) as T;
}

const shuffle = <T,>(a: readonly T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

function Score({ right, total, label = "right" }: { right: number; total: number; label?: string }) {
  return (
    <span className="score" aria-label={`Score: ${right} of ${total} ${label}`}>
      <Icon name="check" size={13} /> {right}/{total} {label}
    </span>
  );
}

/* ================================================================= 1. stale surface */

type Surf = {
  site: { lines: string[]; links: { text: string; href: string }[] } | string;
  reel: { shots: string[] } | string;
  caption: { lines: string[] } | string;
};
type Scenario = {
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
  surfaces: Surf;
};
type Issue = { severity: string; surface: string; text?: string; expected?: string; found?: string };
type Verdict = { correct: boolean; wrongSurface: "site" | "reel" | "caption"; issues: Issue[]; engine: string };

/** Two recorded fallback scenarios in dollars (the engine verdict shape is the real one). Used only when the lab endpoint is unreachable. */
const SAMPLE: { scenario: Scenario; verdict: Omit<Verdict, "correct"> }[] = [
  {
    scenario: {
      id: "bakery-price",
      title: "Saturday cake box",
      brief: "A bakery posts its weekend box on the site, as a reel and as a caption.",
      facts: {
        business: "Marigold Bakehouse",
        offer: "Festive cake box with free city delivery",
        collection: "Saturday, Nov 21, 10am to 1pm ET",
        contact: "https://marigold.example.com/order",
        products: [
          { name: "Saffron Tea Cake", price: "$26.00" },
          { name: "Raspberry Tart", price: "$19.00" },
        ],
      },
      surfaces: {
        site: {
          lines: [
            "Marigold Bakehouse", "Explore collection", "MADE FOR YOUR MOMENTS", "Festive cake box with free city delivery",
            "Baked the morning of pickup.", "Saturday, Nov 21, 10am to 1pm ET", "Enquire about this offer ↗",
            "Saffron Tea Cake", "$26.00", "Raspberry Tart", "$19.00", "Marigold Bakehouse",
            "Festive cake box with free city delivery · Saturday, Nov 21, 10am to 1pm ET",
            "Contact the merchant to confirm availability.",
          ],
          links: [
            { text: "Explore collection", href: "#collection" },
            { text: "Enquire about this offer ↗", href: "https://marigold.example.com/order" },
          ],
        },
        reel: {
          shots: [
            "Saffron Tea Cake\n$26.00\nSaturday, Nov 21, 10am to 1pm ET",
            "Raspberry Tart\n$91.00\nSaturday, Nov 21, 10am to 1pm ET",
          ],
        },
        caption: {
          lines: [
            "Marigold Bakehouse", "Festive cake box with free city delivery", "Baked the morning of pickup.",
            "Saffron Tea Cake — $26.00", "Raspberry Tart — $19.00",
            "Saturday, Nov 21, 10am to 1pm ET", "https://marigold.example.com/order",
          ],
        },
      },
    },
    verdict: {
      wrongSurface: "reel",
      engine: "deterministicIssuesFromTexts",
      issues: [{ severity: "block", surface: "reel", text: 'Price for "Raspberry Tart" on the reel does not match the confirmed price', expected: "$19.00", found: "$91.00" }],
    },
  },
  {
    scenario: {
      id: "sneaker-contact",
      title: "Sneaker drop",
      brief: "A small shoe label sends everyone to one order page.",
      facts: {
        business: "Stride Lane",
        offer: "Second-pair sneaker drop, numbered runs only",
        collection: "Friday, Nov 27, 6pm ET",
        contact: "https://stridelane.example.com/order",
        products: [
          { name: "Court Low", price: "$89.00" },
          { name: "Trail Mid", price: "$119.00" },
        ],
      },
      surfaces: {
        site: {
          lines: [
            "Stride Lane", "Explore collection", "MADE FOR YOUR MOMENTS", "Second-pair sneaker drop, numbered runs only",
            "Sizes 6 to 11 in the first run.", "Friday, Nov 27, 6pm ET", "Enquire about this offer ↗",
            "Court Low", "$89.00", "Trail Mid", "$119.00", "Stride Lane",
            "Second-pair sneaker drop, numbered runs only · Friday, Nov 27, 6pm ET",
            "Contact the merchant to confirm availability.",
          ],
          links: [
            { text: "Explore collection", href: "#collection" },
            { text: "Enquire about this offer ↗", href: "https://stridelane.example.com/orders" },
          ],
        },
        reel: {
          shots: [
            "Court Low\n$89.00\nFriday, Nov 27, 6pm ET",
            "Trail Mid\n$119.00\nFriday, Nov 27, 6pm ET",
          ],
        },
        caption: {
          lines: [
            "Stride Lane", "Second-pair sneaker drop, numbered runs only", "Sizes 6 to 11 in the first run.",
            "Court Low — $89.00", "Trail Mid — $119.00", "Friday, Nov 27, 6pm ET",
            "https://stridelane.example.com/order",
          ],
        },
      },
    },
    verdict: {
      wrongSurface: "site",
      engine: "deterministicIssuesFromTexts",
      issues: [{ severity: "block", surface: "site", text: "Contact link on the site does not match the confirmed contact", expected: "https://stridelane.example.com/order", found: "https://stridelane.example.com/orders" }],
    },
  },
];

type Row = { text: string; kind?: "link" | "shot" };
const rowsOf = (s: Scenario, id: "site" | "reel" | "caption"): Row[] => {
  const v: any = s.surfaces[id];
  if (typeof v === "string") return v.split("\n").map((text) => ({ text }));
  if (id === "reel")
    return (v.shots as string[]).flatMap((shot, i) => [
      { text: `Shot ${i + 1}`, kind: "shot" as const },
      ...shot.split("\n").map((text) => ({ text })),
    ]);
  const out: Row[] = (v.lines as string[]).map((text) => ({ text }));
  if (id === "site" && Array.isArray(v.links))
    for (const l of v.links as { text: string; href: string }[])
      out.push({ text: `${l.text} → ${l.href}`, kind: "link" });
  return out;
};
const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
const sim = (a: string, b: string) => {
  const A = words(a);
  const B = words(b);
  let n = 0;
  A.forEach((w) => B.has(w) && n++);
  return n / Math.max(1, A.size + B.size - n);
};
/** Which rows on the wrong surface carry the mismatching text. Best effort, display only. */
const markedRows = (rows: Row[], issues: Issue[]): Set<number> => {
  const hit = new Set<number>();
  for (const is of issues) {
    const found = (is.found ?? "").trim();
    if (!found) continue;
    let ix = rows.reduce<number[]>((a, r, i) => (r.kind !== "shot" && (r.text === found || (found.length > 3 && r.text.includes(found))) ? [...a, i] : a), []);
    if (!ix.length && found.includes("\n")) {
      const best = found
        .split("\n")
        .map((p) => ({ p, s: sim(p, is.expected ?? "") }))
        .sort((a, b) => b.s - a.s)[0]?.p;
      if (best) ix = rows.reduce<number[]>((a, r, i) => (r.text.includes(best) ? [...a, i] : a), []);
    }
    ix.forEach((i) => hit.add(i));
  }
  return hit;
};

const SURF_META = {
  site: { name: "Website", icon: "grid" },
  reel: { name: "Reel text", icon: "film" },
  caption: { name: "Caption", icon: "chat" },
} as const;

function StaleGame({ active }: { active: boolean }) {
  const [data, setData] = useState<{ scenarios: Scenario[]; live: boolean } | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready">("idle");
  const [i, setI] = useState(0);
  const [guess, setGuess] = useState<string>("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [sample, setSample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const next = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!active || state !== "idle") return;
    setState("loading");
    lab<{ scenarios: Scenario[] }>("/preflight")
      .then((j) => {
        if (!Array.isArray(j.scenarios) || !j.scenarios.length) throw new Error("empty");
        const sc = shuffle(j.scenarios);
        setData({ scenarios: sc, live: true });
      })
      .catch(() => setData({ scenarios: shuffle(SAMPLE.map((s) => s.scenario)), live: false }))
      .finally(() => setState("ready"));
  }, [active, state]);

  const sc = data?.scenarios[i % (data?.scenarios.length || 1)];
  const choose = async (g: "site" | "reel" | "caption") => {
    if (!sc || verdict || busy) return;
    setGuess(g);
    setBusy(true);
    try {
      let v: Verdict;
      if (data?.live) {
        v = await lab<Verdict>("/preflight", { scenarioId: sc.id, guess: g });
        setSample(false);
      } else throw new Error("offline");
      setVerdict(v);
      setScore((s) => ({ right: s.right + (v.correct ? 1 : 0), total: s.total + 1 }));
    } catch {
      const rec = SAMPLE.find((s) => s.scenario.id === sc.id);
      if (rec) {
        const v = { ...rec.verdict, correct: rec.verdict.wrongSurface === g };
        setSample(true);
        setVerdict(v);
        setScore((s) => ({ right: s.right + (v.correct ? 1 : 0), total: s.total + 1 }));
      }
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (verdict) next.current?.focus({ preventScroll: true });
  }, [verdict]);
  const again = () => {
    setVerdict(null);
    setGuess("");
    setI((n) => n + 1);
  };
  if (state !== "ready" || !data || !sc)
    return <p className="g-loading" role="status">Loading scenarios…</p>;
  return (
    <div className="game">
      <div className="game-head">
        <div>
          <h3>Spot the stale surface</h3>
          <p>
            One of these three has drifted from the confirmed facts by a single detail. Which one? Then
            the real preflight rules decide.
          </p>
        </div>
        <div className="game-meta">
          <Score {...score} />
          {data.live ? <Tag kind="live engine" /> : <Tag kind="recorded sample" />}
        </div>
      </div>
      {!data.live ? (
        <p className="notice" role="note">
          The lab endpoint was unreachable, so you are playing recorded sample data: two scenarios
          copied from an earlier run of the engine. Nothing below is being checked live right now.
        </p>
      ) : null}
      <div className="facts">
        <p className="lp-eb">
          CONFIRMED FACTS · {sc.title}
        </p>
        <p className="brief">{sc.brief}</p>
        <dl>
          <div><dt>Business</dt><dd>{sc.facts.business}</dd></div>
          <div><dt>Offer</dt><dd>{sc.facts.offer}</dd></div>
          <div><dt>Collection</dt><dd>{sc.facts.collection}</dd></div>
          <div><dt>Contact</dt><dd className="mono">{sc.facts.contact}</dd></div>
          <div>
            <dt>Products</dt>
            <dd>{sc.facts.products.map((p) => `${p.name} ${p.price}`).join(" · ")}</dd>
          </div>
        </dl>
      </div>
      <div className="surf-grid" role="group" aria-label="Pick the stale surface">
        {(["site", "reel", "caption"] as const).map((id) => {
          const rows = rowsOf(sc, id);
          const wrong = verdict?.wrongSurface === id;
          const marks = wrong && verdict ? markedRows(rows, verdict.issues) : new Set<number>();
          return (
            <div key={id} className={`s-card${wrong ? " wrong" : ""}${verdict && guess === id && !wrong ? " mis" : ""}${verdict && !wrong ? " dim" : ""}`}>
              <div className="s-head">
                <span><Icon name={SURF_META[id].icon} size={14} /> {SURF_META[id].name}</span>
                {verdict && wrong ? <span className="s-flag bad">stale</span> : null}
                {verdict && guess === id ? <span className="s-flag you">your pick</span> : null}
              </div>
              <ul className="s-rows">
                {rows.map((r, n) => (
                  <li key={n} className={`${r.kind ?? ""}${marks.has(n) ? " hit" : ""}`}>
                    {r.text}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn btn-ghost btn-sm s-pick"
                disabled={!!verdict || busy}
                aria-label={`Flag the ${SURF_META[id].name} as the stale surface`}
                onClick={() => choose(id)}
              >
                <Icon name="pen" size={13} /> This one is stale
              </button>
            </div>
          );
        })}
      </div>
      <div className="result" role="status" aria-live="polite">
        {verdict ? (
          <>
            <p className={`result-h ${verdict.correct ? "ok" : "bad"}`}>
              <Icon name={verdict.correct ? "check" : "x"} size={16} />
              {verdict.correct
                ? `Correct: the ${SURF_META[verdict.wrongSurface].name.toLowerCase()} was stale.`
                : `Not this time: it was the ${SURF_META[verdict.wrongSurface].name.toLowerCase()}.`}
            </p>
            <ul className="issues">
              {verdict.issues.map((is, n) => (
                <li key={n}>
                  <span className={`lp-sev ${is.severity}`}>{is.severity}</span>
                  <span>
                    {is.text}
                    <span className="ef">
                      expected <b>{is.expected}</b>
                      {is.found ? <> , found <s>{(is.found.length > 70 ? is.found.slice(0, 67) + "…" : is.found).replace(/\n/g, " ↵ ")}</s></> : null}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="engine">
              {sample ? "Recorded from" : "Decided by"} <code>{verdict.engine}</code> in packages/meta/preflight.ts
              {sample ? ", not computed just now." : ", the same rules that block approval in the Studio."}
            </p>
            <button ref={next} type="button" className="btn btn-primary btn-sm" onClick={again}>
              Next scenario <Icon name="arrow" size={14} />
            </button>
          </>
        ) : (
          <p className="hint">{busy ? "Asking the engine…" : "Read the three surfaces against the facts, then flag one."}</p>
        )}
      </div>
    </div>
  );
}

/* ================================================================= 2. tagline */

type Phrase = { allowed: boolean; cleaned: string; reasons: string[] };
/** Verdicts recorded from kineticPhraseCheck on 4 Nov 2026; used only if the endpoint is unreachable. */
const PHRASES: Record<string, Phrase> = {
  "Morning ritual": { allowed: true, cleaned: "Morning ritual", reasons: [] },
  "Slow sweetness": { allowed: true, cleaned: "Slow sweetness", reasons: [] },
  "Eat more cake": { allowed: true, cleaned: "Eat more cake", reasons: [] },
  "Handmade daily": { allowed: true, cleaned: "Handmade daily", reasons: [] },
  "Best mugs in town": { allowed: false, cleaned: "", reasons: ["more than 3 words", 'claim word "best"'] },
  "Only 3 left": { allowed: false, cleaned: "", reasons: ["contains a digit", 'claim word "only"'] },
  "Made by hand with love": { allowed: false, cleaned: "", reasons: ["more than 3 words"] },
  "Clinically proven calm": { allowed: false, cleaned: "", reasons: ['claim word "clinically"', 'claim word "proven"'] },
  "Visit shop.com": { allowed: false, cleaned: "", reasons: ["instruction-like or a link", "contains markup or a link", 'claim word "visit"', 'claim word "shop"'] },
  "Free delivery": { allowed: false, cleaned: "", reasons: ['claim word "free"'] },
};
const CANDIDATES = Object.keys(PHRASES);

async function checkPhrase(text: string): Promise<{ r: Phrase; live: boolean } | null> {
  try {
    const r = await lab<Phrase>("/phrase", { text });
    if (typeof r.allowed !== "boolean") throw new Error("shape");
    return { r: { allowed: r.allowed, cleaned: String(r.cleaned ?? ""), reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [] }, live: true };
  } catch {
    const rec = PHRASES[text.trim()];
    return rec ? { r: rec, live: false } : null;
  }
}

function PhraseGame({ active }: { active: boolean }) {
  const [order, setOrder] = useState<string[]>(() => shuffle(CANDIDATES));
  const [i, setI] = useState(0);
  const [res, setRes] = useState<{ r: Phrase; live: boolean; guess: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const [own, setOwn] = useState("");
  const [ownRes, setOwnRes] = useState<{ r: Phrase; live: boolean; text: string } | null | "off">(null);
  const next = useRef<HTMLButtonElement>(null);
  const phrase = order[i % order.length];
  const guess = async (g: boolean) => {
    if (res || busy) return;
    setBusy(true);
    const c = await checkPhrase(phrase);
    setBusy(false);
    if (!c) return setRes({ r: { allowed: false, cleaned: "", reasons: [] }, live: false, guess: g });
    setRes({ ...c, guess: g });
    setScore((s) => ({ right: s.right + (c.r.allowed === g ? 1 : 0), total: s.total + 1 }));
  };
  useEffect(() => {
    if (res) next.current?.focus({ preventScroll: true });
  }, [res]);
  const submitOwn = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = own.trim();
    if (!t) return;
    setBusy(true);
    const c = await checkPhrase(t);
    setBusy(false);
    setOwnRes(c ? { ...c, text: t } : "off");
  };
  const unreachable = res && !res.live && !PHRASES[phrase];
  return (
    <div className="game">
      <div className="game-head">
        <div>
          <h3>Would this tagline pass?</h3>
          <p>
            Axys puts short kinetic phrases on your reel. They are decoration, so code rejects digits,
            money, links, superlatives, claim words and anything over three words. Guess first.
          </p>
        </div>
        <div className="game-meta">
          <Score {...score} />
          {res ? (res.live ? <Tag kind="live engine" /> : <Tag kind="recorded sample" />) : <Tag kind="live engine" />}
        </div>
      </div>
      <div className="phrase-stage">
        <p className="lp-eb">PHRASE {(i % order.length) + 1} OF {order.length}</p>
        <p className={`phrase${res ? (res.r.allowed ? " ok" : " no") : ""}`}>{phrase}</p>
        <div className="guess-row" role="group" aria-label="Your guess">
          <button type="button" className="btn btn-ghost" disabled={!!res || busy} onClick={() => guess(true)}>
            <Icon name="check" size={15} /> It passes
          </button>
          <button type="button" className="btn btn-ghost" disabled={!!res || busy} onClick={() => guess(false)}>
            <Icon name="x" size={15} /> It is rejected
          </button>
        </div>
      </div>
      <div className="result" role="status" aria-live="polite">
        {res && !unreachable ? (
          <>
            <p className={`result-h ${res.r.allowed === res.guess ? "ok" : "bad"}`}>
              <Icon name={res.r.allowed === res.guess ? "check" : "x"} size={16} />
              {res.r.allowed === res.guess ? "You called it. " : "Not quite. "}
              The filter {res.r.allowed ? "allows" : "rejects"} “{phrase}”.
            </p>
            {res.r.allowed ? (
              <p className="engine">Cleaned phrase used on the reel: <code>{res.r.cleaned}</code></p>
            ) : (
              <ul className="reasons">
                {res.r.reasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
            <p className="engine">
              {res.live ? "Decided now by" : "Recorded from"} <code>kineticPhraseCheck</code> in packages/meta/direction.ts. No model call.
            </p>
            <button ref={next} type="button" className="btn btn-primary btn-sm" onClick={() => { setRes(null); setI((n) => n + 1); }}>
              Next phrase <Icon name="arrow" size={14} />
            </button>
          </>
        ) : unreachable ? (
          <p className="notice" role="note">The live phrase endpoint is unreachable right now.</p>
        ) : (
          <p className="hint">{busy ? "Asking the filter…" : "Does it pass, or is it rejected?"}</p>
        )}
      </div>
      <form className="own" onSubmit={submitOwn}>
        <label htmlFor="own-phrase">Try your own tagline</label>
        <div className="own-row">
          <input
            id="own-phrase"
            value={own}
            maxLength={60}
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. Quiet warmth"
            onChange={(e) => setOwn(e.target.value)}
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !own.trim()}>
            Check
          </button>
        </div>
        <div role="status" aria-live="polite" className="own-out">
          {ownRes === "off" ? (
            <span className="notice">The live phrase endpoint is unreachable, so custom text cannot be checked.</span>
          ) : ownRes ? (
            <span className={ownRes.r.allowed ? "own-ok" : "own-no"}>
              <Icon name={ownRes.r.allowed ? "check" : "x"} size={14} />{" "}
              {ownRes.r.allowed ? `Allowed. Cleaned: “${ownRes.r.cleaned}”` : `Rejected: ${ownRes.r.reasons.join("; ")}`}
              {ownRes.live ? "" : " (recorded sample)"}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}

/* ================================================================= 3. name that product */

type Dir = {
  id: "mug" | "sneaker" | "cake";
  subject: string;
  category: string;
  descriptors: string[];
  palette: string[];
  mood: string;
  motion: string;
  parts: string[];
  phrases: string[];
  when: string;
};
/** Muse Spark 1.3 directions stored by live runs on 4 Nov 2026 (docs/evidence). */
const DIRS: Dir[] = [
  { id: "mug", subject: "ceramic mug", category: "homeware", descriptors: ["blue", "speckled", "glossy", "rounded"], palette: ["#5a7da3", "#33465e"], mood: "earthy", motion: "calm", parts: ["handle"], phrases: ["Morning ritual", "Made by hand", "Quiet warmth"], when: "4 Nov 2026" },
  { id: "sneaker", subject: "running sneaker", category: "footwear", descriptors: ["airy", "sleek", "laced", "padded"], palette: ["#ffffff", "#a9bcae"], mood: "fresh", motion: "punchy", parts: [], phrases: ["Morning air", "Steady breath", "Quiet pace"], when: "4 Nov 2026" },
  { id: "cake", subject: "chocolate raspberry cake", category: "food", descriptors: ["glossy", "dark", "round", "bright"], palette: ["#3a1e14", "#c92038"], mood: "warm", motion: "calm", parts: ["raspberries"], phrases: ["Soft gathering", "Summer evening", "Melted dusk"], when: "4 Nov 2026" },
];
const CATS = ["footwear", "apparel", "homeware", "food", "beverage", "beauty"];
const MOODS = ["warm", "minimal", "bold", "playful", "luxe", "earthy", "fresh"];

function Choice({ name, options, value, onChange, disabled, label }: { name: string; options: string[]; value: string; onChange: (v: string) => void; disabled: boolean; label: string }) {
  return (
    <fieldset className="choice" disabled={disabled}>
      <legend>{label}</legend>
      <div className="lp-choice-row">
        {options.map((o) => (
          <label key={o} className={value === o ? "on" : ""}>
            <input type="radio" name={name} value={o} checked={value === o} onChange={() => onChange(o)} />
            <span>{o}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ProductGame() {
  const [order] = useState(() => shuffle(DIRS));
  const [i, setI] = useState(0);
  const [cat, setCat] = useState("");
  const [mood, setMood] = useState("");
  const [shown, setShown] = useState(false);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const d = order[i % order.length];
  const reveal = () => {
    setShown(true);
    setScore((s) => ({ right: s.right + (cat === d.category ? 1 : 0) + (mood === d.mood ? 1 : 0), total: s.total + 2 }));
  };
  const nextRound = () => {
    setShown(false);
    setCat("");
    setMood("");
    setI((n) => n + 1);
  };
  return (
    <div className="game">
      <div className="game-head">
        <div>
          <h3>Name that product</h3>
          <p>
            Muse Spark looked at each photo and returned a creative direction. Guess its category and
            mood first, then see what it actually said.
          </p>
        </div>
        <div className="game-meta">
          <Score {...score} label="matched" />
          <Tag kind="recorded live run" />
        </div>
      </div>
      <div className="prod">
        <figure className="prod-fig">
          <img src={`${L}reel-${d.id}.webp`} alt="A product frame from a rendered reel. What is it?" width="540" height="960" loading="lazy" />
          <figcaption>Frame {(i % order.length) + 1} of {order.length}</figcaption>
        </figure>
        <div className="prod-q">
          <Choice name={`cat-${d.id}`} label="Category" options={CATS} value={cat} onChange={setCat} disabled={shown} />
          <Choice name={`mood-${d.id}`} label="Mood" options={MOODS} value={mood} onChange={setMood} disabled={shown} />
          {!shown ? (
            <button type="button" className="btn btn-primary" disabled={!cat || !mood} onClick={reveal}>
              Reveal Muse Spark&apos;s answer
            </button>
          ) : null}
          <div className="result" role="status" aria-live="polite">
            {shown ? (
              <>
                <p className={`result-h ${cat === d.category ? "ok" : "bad"}`}>
                  <Icon name={cat === d.category ? "check" : "x"} size={16} />
                  Category: Spark said <b>{d.category}</b>
                  {cat === d.category ? "." : `, you said ${cat}.`}
                </p>
                <p className={`result-h ${mood === d.mood ? "ok" : "meh"}`}>
                  <Icon name={mood === d.mood ? "check" : "palette"} size={16} />
                  Mood: Spark said <b>{d.mood}</b>
                  {mood === d.mood ? "." : `, you said ${mood}. Mood is a judgement call, not a right answer.`}
                </p>
                <dl className="spark">
                  <div><dt>Subject</dt><dd>{d.subject}</dd></div>
                  <div><dt>Descriptors</dt><dd>{d.descriptors.join(", ")}</dd></div>
                  <div><dt>Motion</dt><dd>{d.motion}</dd></div>
                  <div><dt>Parts</dt><dd>{d.parts.length ? d.parts.join(", ") : "none named"}</dd></div>
                  <div>
                    <dt>Palette</dt>
                    <dd>
                      {d.palette.map((h) => (
                        <span key={h} className="lp-swatch"><i style={{ background: h }} />{h}</span>
                      ))}
                    </dd>
                  </div>
                  <div><dt>Reel phrases</dt><dd>{d.phrases.join(" · ")} <em>(decoration, not facts)</em></dd></div>
                </dl>
                <p className="engine">Recorded output of muse-spark-1.3, {d.when}, validated fail-closed in code. Facts such as prices never come from it.</p>
                <button type="button" className="btn btn-primary btn-sm" onClick={nextRound}>
                  Next product <Icon name="arrow" size={14} />
                </button>
              </>
            ) : (
              <p className="hint">Pick one of each, then reveal.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================= 4. cutout or not */

function CutoutGame() {
  const [round, setRound] = useState(0);
  const [flip] = useState(() => Math.random() < 0.5);
  const [pick, setPick] = useState<"cake" | "parts" | "">("");
  const [guess, setGuess] = useState(30);
  const [shown, setShown] = useState(false);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const A = flip ? "parts" : "cake";
  const B = flip ? "cake" : "parts";
  const img = (k: string) => (k === "cake" ? "cake-mask-cake-only" : "cake-mask-with-parts");
  const answer1 = () => {
    setShown(true);
    setScore((s) => ({ right: s.right + (pick === "parts" ? 1 : 0), total: s.total + 1 }));
  };
  const answer2 = () => {
    setShown(true);
    setScore((s) => ({ right: s.right + (Math.abs(guess - 25.1) <= 6 ? 1 : 0), total: s.total + 1 }));
  };
  const go = () => {
    setShown(false);
    setRound((r) => r + 1);
  };
  return (
    <div className="game">
      <div className="game-head">
        <div>
          <h3>Cutout or not?</h3>
          <p>SAM 3.1 cuts products out of photos so the reel can use your exact pixels. Two rounds on real masks and real coverage numbers.</p>
        </div>
        <div className="game-meta">
          <Score {...score} />
          <Tag kind="recorded live run" />
        </div>
      </div>
      {round === 0 ? (
        <div>
          <p className="q">Round 1 of 2 · Which mask would you put in a reel for this cake?</p>
          <div className="mask-pair" role="radiogroup" aria-label="Choose a mask">
            {[A, B].map((k, n) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={pick === k}
                disabled={shown}
                className={`mask${pick === k ? " on" : ""}${shown && k === "parts" ? " best" : ""}`}
                onClick={() => setPick(k as any)}
              >
                <img src={`${L}${img(k)}.webp`} alt={`Mask ${n === 0 ? "A" : "B"}: green overlay on ${k === "cake" ? "the cake only, raspberries uncovered" : "the cake and its raspberries"}`} width="640" height="426" loading="lazy" />
                <span className="mask-l">Mask {n === 0 ? "A" : "B"}</span>
                {shown ? <span className="mask-c">{k === "cake" ? "19% of the frame" : "28% of the frame"}</span> : null}
              </button>
            ))}
          </div>
          {!shown ? (
            <button type="button" className="btn btn-primary" disabled={!pick} onClick={answer1}>Lock in my pick</button>
          ) : null}
          <div className="result" role="status" aria-live="polite">
            {shown ? (
              <>
                <p className={`result-h ${pick === "parts" ? "ok" : "bad"}`}>
                  <Icon name={pick === "parts" ? "check" : "x"} size={16} />
                  {pick === "parts" ? "Yes: the mask that keeps the raspberries." : "Not quite: the raspberries would be missing."}
                </p>
                <p className="engine">
                  SAM correctly cuts “the cake” and leaves the raspberries, because they are separate objects. Muse Spark named the
                  visible part, and the union mask lifted coverage from 19% to 28%. Parts handling runs for the first product of a campaign only.
                </p>
                <button type="button" className="btn btn-primary btn-sm" onClick={go}>Round 2 <Icon name="arrow" size={14} /></button>
              </>
            ) : <p className="hint">Look at what each green overlay leaves out.</p>}
          </div>
        </div>
      ) : (
        <div>
          <p className="q">Round 2 of 2 · How much of this mug photo does SAM&apos;s cutout cover?</p>
          <div className="cov">
            <img src={`${L}mug-photo.webp`} alt="Photo of a blue speckled ceramic mug on a wooden table" width="960" height="640" loading="lazy" />
            <div className="cov-q">
              <label htmlFor="cov-range">Your guess: <b>{guess}%</b> of the frame</label>
              <input id="cov-range" type="range" min={5} max={60} step={1} value={guess} disabled={shown} onChange={(e) => setGuess(Number(e.target.value))} aria-valuetext={`${guess} percent`} />
              {!shown ? <button type="button" className="btn btn-primary" onClick={answer2}>Check</button> : null}
              <div className="result" role="status" aria-live="polite">
                {shown ? (
                  <>
                    <p className={`result-h ${Math.abs(guess - 25.1) <= 6 ? "ok" : "bad"}`}>
                      <Icon name={Math.abs(guess - 25.1) <= 6 ? "check" : "x"} size={16} />
                      SAM covered <b>25.1%</b>. You said {guess}% ({Math.abs(guess - 25.1) <= 6 ? "within 6 points" : "more than 6 points off"}).
                    </p>
                    <table className="cov-table">
                      <caption className="sr">Recorded SAM coverage from live runs</caption>
                      <thead><tr><th scope="col">Product</th><th scope="col">Cutout alone</th><th scope="col">With named parts</th></tr></thead>
                      <tbody>
                        <tr><th scope="row">Mug</th><td>25.1%</td><td>27.2% (handle)</td></tr>
                        <tr><th scope="row">Sneaker</th><td>30.5%</td><td>no parts named</td></tr>
                        <tr><th scope="row">Cake</th><td>19.3%</td><td>28.0% (raspberries)</td></tr>
                      </tbody>
                    </table>
                    <p className="engine">Coverage is the share of the frame inside the mask. Recorded from live SAM 3.1 runs, 4 Nov 2026. SAM may miss unusual or thin objects.</p>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRound(0); setShown(false); setPick(""); setGuess(30); }}>Play again</button>
                  </>
                ) : <p className="hint">Slide to your guess, then check.</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================= 5. pick the ink */

const INK = [
  { id: "cake-macro", img: "film-cake-3", what: "Cake, macro close-up", worst: 7.57, median: 10.55 },
  { id: "cake-ctx", img: "film-cake-5", what: "Cake, context scene", worst: 2.67, median: 7.23 },
  { id: "sneaker-macro", img: "film-sneaker-4", what: "Sneaker, macro close-up", worst: 6.88, median: 10.88 },
  { id: "sneaker-ctx", img: "film-sneaker-5", what: "Sneaker, context scene", worst: 2.36, median: 6.13 },
];
function InkGame() {
  const [order] = useState(() => shuffle(INK));
  const [i, setI] = useState(0);
  const [g, setG] = useState<boolean | null>(null);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const r = order[i % order.length];
  const pass = r.worst >= 4.5;
  const ask = (v: boolean) => {
    setG(v);
    setScore((s) => ({ right: s.right + (v === pass ? 1 : 0), total: s.total + 1 }));
  };
  const pct = (n: number) => `${Math.min(100, (n / 12) * 100)}%`;
  return (
    <div className="game">
      <div className="game-head">
        <div>
          <h3>Pick the ink</h3>
          <p>
            The renderer chooses the ink for kinetic type from the pixels actually behind it. In this
            frame, does the text reach WCAG AA (4.5:1) at its worst pixel?
          </p>
        </div>
        <div className="game-meta">
          <Score {...score} />
          <Tag kind="measured offline" />
        </div>
      </div>
      <div className="ink">
        <figure className="ink-fig">
          <img src={`${L}${r.img}.webp`} alt={`${r.what}: kinetic type over the product`} width="360" height="640" loading="lazy" />
          <figcaption>{r.what}</figcaption>
        </figure>
        <div className="ink-q">
          <div className="guess-row" role="group" aria-label="Your guess">
            <button type="button" className="btn btn-ghost" disabled={g !== null} onClick={() => ask(true)}>
              <Icon name="check" size={15} /> Yes, 4.5:1 or better
            </button>
            <button type="button" className="btn btn-ghost" disabled={g !== null} onClick={() => ask(false)}>
              <Icon name="x" size={15} /> No, it falls short
            </button>
          </div>
          <div className="result" role="status" aria-live="polite">
            {g !== null ? (
              <>
                <p className={`result-h ${g === pass ? "ok" : "bad"}`}>
                  <Icon name={g === pass ? "check" : "x"} size={16} />
                  {pass ? "It does: worst pixel " : "It falls short: worst pixel "}
                  <b>{r.worst.toFixed(2)}:1</b>, median <b>{r.median.toFixed(2)}:1</b>.
                </p>
                <div className="meter" aria-hidden="true">
                  <div className="m-row"><span>worst</span><i><b className={pass ? "ok" : "bad"} style={{ width: pct(r.worst) }} /></i></div>
                  <div className="m-row"><span>median</span><i><b className="ok" style={{ width: pct(r.median) }} /></i></div>
                  <span className="m-mark">4.5</span>
                </div>
                <p className="engine">
                  {pass
                    ? "Plain ink was enough on this plate."
                    : "A bright, busy plate. No plain ink reaches 4.5:1 here, so the renderer picks the better ink and adds an opposing outline and shadow, plus a stronger top scrim."}{" "}
                  Measured on live renders as ink vs the background pixels inside the text box (<code>chooseInk</code> in film-art.ts).
                </p>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => { setG(null); setI((n) => n + 1); }}>
                  Next frame <Icon name="arrow" size={14} />
                </button>
              </>
            ) : <p className="hint">Think about how bright and busy the backdrop is.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================= shell */

const GAMES = [
  { id: "stale", name: "Spot the stale surface", icon: "eye", tag: "live engine" },
  { id: "phrase", name: "Would this tagline pass?", icon: "pen", tag: "live engine" },
  { id: "product", name: "Name that product", icon: "bulb", tag: "recorded" },
  { id: "cutout", name: "Cutout or not?", icon: "scissors", tag: "recorded" },
  { id: "ink", name: "Pick the ink", icon: "palette", tag: "recorded" },
] as const;

export function Bench() {
  const [k, setK] = useState(0);
  const [seen, setSeen] = useState<Set<number>>(new Set([0]));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [wrap, inView] = useInView<HTMLDivElement>(true, "200px 0px", 0.01);
  const select = (n: number) => {
    setK(n);
    setSeen((s) => new Set(s).add(n));
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    let n = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % GAMES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + GAMES.length) % GAMES.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = GAMES.length - 1;
    else return;
    e.preventDefault();
    select(n);
    refs.current[n]?.focus();
  };
  return (
    <div className="wrap" ref={wrap}>
      <SectionHead
        id="h-bench"
        icon="game"
        kicker="Interactive"
        sub="Five short games on the real thing. Guess first, then watch the deterministic checks decide. Two run against live engines; three replay recorded runs, and each says which."
      >
        The <span className="grad">Bench</span>
      </SectionHead>
      <Reveal className="bench card glass">
        <div className="g-tabs" role="tablist" aria-label="Games" aria-orientation="horizontal">
          {GAMES.map((g, i) => (
            <button
              key={g.id}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="tab"
              id={`gt-${g.id}`}
              aria-selected={i === k}
              aria-controls={`gp-${g.id}`}
              tabIndex={i === k ? 0 : -1}
              className={i === k ? "on" : ""}
              onClick={() => select(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <Icon name={g.icon} size={16} />
              <span className="g-name">{g.name}</span>
              <span className={`g-kind ${g.tag === "live engine" ? "live" : "rec"}`}>{g.tag}</span>
            </button>
          ))}
        </div>
        {GAMES.map((g, i) => (
          <div key={g.id} role="tabpanel" id={`gp-${g.id}`} aria-labelledby={`gt-${g.id}`} hidden={i !== k} className="g-panel">
            {seen.has(i) || (inView && i === 0) ? (
              g.id === "stale" ? <StaleGame active={i === k || inView} /> :
              g.id === "phrase" ? <PhraseGame active={i === k} /> :
              g.id === "product" ? <ProductGame /> :
              g.id === "cutout" ? <CutoutGame /> : <InkGame />
            ) : null}
          </div>
        ))}
      </Reveal>
    </div>
  );
}
