import React, {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Campaign } from "../../packages/campaign/index";
import {
  COMMAND_ID,
  FIXTURE,
  FixtureBadge,
  MetaError,
  PreflightPanel,
  SURFACE_LABEL,
  VoiceRecorder,
  assetSrc,
  blockCount,
  fixtureReelFrame,
  liveRequest,
  requestPreflight,
  sleepMs,
  type Issue,
  type PreflightState,
} from "./meta";
import { RedPen, type RedPenController, type RedPenSettle } from "./redpen";
import "./sayit.css";
import { money as formatMoney } from "./money";

/* ================================================================== *
 * Say it: say or type a change -> diff cards -> Apply -> every stale
 * surface is red-penned -> Fix with Axys -> green.
 * Everything that comes from the server is rendered as React text.
 * ================================================================== */

type RpPhase = "idle" | "regenerating" | "checking";

/** Wires the Say it bar to the Red Pen board so "Fix with Axys" is one press. */
export function useSayItLink() {
  const controller = useRef<RedPenController | null>(null);
  const [phase, setPhase] = useState<RpPhase>("idle");
  const [settle, setSettle] = useState<RedPenSettle | null>(null);
  const redpen = useMemo(
    () => ({
      controller,
      onPhase: (p: RpPhase) => {
        setPhase(p);
        if (p !== "idle") setSettle(null);
      },
      onSettle: (r: RedPenSettle | null) => setSettle(r),
    }),
    [],
  );
  return { controller, phase, settle, redpen };
}
export type SayItLink = ReturnType<typeof useSayItLink>;

/* ---------------- validated server shapes ---------------- */
type DiffItem = {
  field: string;
  label: string;
  from: string;
  to: string;
  quote: string;
};
type Command = {
  understood: boolean;
  patch: Record<string, unknown> | null;
  diff: DiffItem[];
  summary: string;
  questions: string[];
  model: string;
  text: string;
};
const str = (v: unknown, max = 300) =>
  typeof v === "string" ? v.slice(0, max) : "";

function shown(v: unknown, field: string, label: string, c: Campaign): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number" && Number.isFinite(v)) {
    if (/price/i.test(field + " " + label)) {
      const p =
        c.facts.products.find((x) => label.includes(x.name)) ??
        c.facts.products[0];
      return formatMoney(p?.currency ?? "USD", v);
    }
    return String(v);
  }
  if (typeof v === "string") return v.slice(0, 200);
  return "—";
}

function parseCommand(raw: any, text: string, c: Campaign): Command {
  if (!raw || typeof raw !== "object")
    throw new MetaError("The server returned an unexpected answer.");
  const diff: DiffItem[] = (Array.isArray(raw.diff) ? raw.diff : [])
    .slice(0, 12)
    .map((d: any) => {
      const field = str(d?.field, 80),
        label = str(d?.label, 120) || field;
      return {
        field,
        label,
        from: shown(d?.from, field, label, c),
        to: shown(d?.to, field, label, c),
        quote: str(d?.quote, 300),
      };
    })
    .filter((d: DiffItem) => d.label);
  const patch =
    raw.patch && typeof raw.patch === "object" && !Array.isArray(raw.patch)
      ? (raw.patch as Record<string, unknown>)
      : null;
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .slice(0, 4)
    .map((q: unknown) => str(q, 300))
    .filter(Boolean);
  // Fail closed: "understood" without a patch or any visible change is not applyable.
  const understood = raw.understood === true && !!patch && diff.length > 0;
  if (raw.understood === true && !understood && !questions.length)
    questions.push(
      "Axys could not turn that into a change you can check. Say it a little differently.",
    );
  return {
    understood,
    patch,
    diff: understood ? diff : [],
    summary: str(raw.summary, 400),
    questions,
    model: str(raw.model, 40),
    text,
  };
}

async function askCommand(
  c: Campaign,
  text: string,
  signal: AbortSignal,
): Promise<Command> {
  const raw = FIXTURE
    ? await fixtureAsk(c, text, signal)
    : await liveRequest(`/campaigns/${encodeURIComponent(c.id)}/command`, {
        method: "POST",
        json: { text },
        signal,
      });
  return parseCommand(raw, text, c);
}
async function applyCommand(
  c: Campaign,
  patch: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Campaign> {
  const raw = FIXTURE
    ? await fixtureApply(c, patch, signal)
    : await liveRequest(
        `/campaigns/${encodeURIComponent(c.id)}/command/apply`,
        { method: "POST", json: { patch, revision: c.revision }, signal },
      );
  if (!raw || raw.id !== c.id || !Number.isInteger(raw.revision))
    throw new MetaError("The server returned an unexpected campaign.");
  return raw as Campaign;
}

/* ---------------- fixture interpreter (clearly not a model) ---------------- */
const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const STOP = new Set(["the", "and", "box", "tin", "set", "for", "our"]);
const moneyOf = (p: { currency: string; priceMinor: number }) =>
  formatMoney(p.currency, p.priceMinor);

async function fixtureAsk(c: Campaign, text: string, signal: AbortSignal) {
  await sleepMs(1100, signal);
  const low = text.toLowerCase();
  const diff: any[] = [];
  const patch: any = {};
  const questions: string[] = [];
  const clauseAround = (idx: number) => {
    const start =
      Math.max(
        low.lastIndexOf(" and ", idx),
        low.lastIndexOf(",", idx),
        low.lastIndexOf(";", idx),
        low.lastIndexOf(".", idx),
      ) + 1;
    const rest = low.slice(idx);
    const m = /\s+and\s+|[,;.]/.exec(rest);
    const end = m ? idx + m.index : text.length;
    return text
      .slice(start, end)
      .replace(/^\s*(and|then)\s+/i, "")
      .trim();
  };
  // prices: a product named in the text, then the first plain number after it
  const prods = c.facts.products;
  const hits = prods
    .map((p, i) => {
      const tokens = p.name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOP.has(t));
      const at = tokens
        .map((t) => low.indexOf(t))
        .filter((n) => n >= 0)
        .sort((a, b) => a - b)[0];
      return { p, i, at };
    })
    .filter((h) => h.at !== undefined && h.at >= 0)
    .sort((a, b) => (a.at as number) - (b.at as number));
  const targets = hits.length
    ? hits
    : prods.length === 1
      ? [{ p: prods[0], i: 0, at: 0 }]
      : [];
  const NUM =
    /(?:\$|₹|rs\.?\s*|inr\s*|usd\s*)?(\d+(?:\.\d{1,2})?)(?!\s*(?:am|pm|%|:|st|nd|rd|th))/i;
  targets.forEach((h, k) => {
    const seg = low.slice(h.at as number, targets[k + 1]?.at ?? low.length);
    const m = NUM.exec(seg);
    if (!m) return;
    const n = Number(m[1]);
    const idx = (h.at as number) + m.index;
    if (!(n > 0) || n > 100000) {
      questions.push(
        n > 0
          ? `${n} looks too high for ${h.p.name}. What price did you mean?`
          : `A price of ${n} can't be applied. What price should ${h.p.name} have?`,
      );
      return;
    }
    const minor = Math.round(n * 100);
    if (minor === h.p.priceMinor) return;
    patch.products = [
      ...(patch.products ?? []),
      { ref: h.p.name, priceMinor: minor },
    ];
    diff.push({
      field: `products.${h.p.id}.priceMinor`,
      label: `Price · ${h.p.name}`,
      from: moneyOf(h.p),
      to: moneyOf({ ...h.p, priceMinor: minor }),
      quote: clauseAround(idx),
    });
  });
  const day = DAYS.find((d) => new RegExp(`\\b${d}\\b`, "i").test(low));
  if (day) {
    const Day = day[0].toUpperCase() + day.slice(1);
    const cur = c.facts.collection;
    const had = DAYS.find((d) =>
      new RegExp(`\\b${d}\\b`, "i").test(cur.toLowerCase()),
    );
    const next = had ? cur.replace(new RegExp(`\\b${had}\\b`, "i"), Day) : Day;
    if (next !== cur) {
      patch.collection = next;
      diff.push({
        field: "collection",
        label: "Pickup · collection",
        from: cur,
        to: next,
        quote: clauseAround(low.search(new RegExp(`\\b${day}\\b`, "i"))),
      });
    }
  }
  if (!diff.length)
    return {
      understood: false,
      patch: null,
      diff: [],
      summary: "",
      questions: questions.length
        ? questions
        : [
            "I couldn't find a price or day to change in that. Try “make the brownie box 149” or “move pickup to Sunday”.",
          ],
      model: "fixture",
    };
  return {
    understood: true,
    patch,
    diff,
    summary: diff.map((d) => `${d.label}: ${d.from} to ${d.to}`).join("; "),
    questions,
    model: "fixture",
  };
}

async function fixtureApply(
  c: Campaign,
  patch: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Campaign> {
  await sleepMs(800, signal);
  const facts = {
    ...c.facts,
    products: c.facts.products.map((p) => ({ ...p })),
  };
  if (typeof patch.collection === "string") facts.collection = patch.collection;
  for (const ch of (patch.products as any[]) ?? []) {
    const p =
      facts.products.find((x) => x.name === ch.ref) ?? facts.products[ch.ref];
    if (p && typeof ch.priceMinor === "number") p.priceMinor = ch.priceMinor;
  }
  return { ...c, facts, revision: c.revision + 1, state: "NeedsReview" };
}

/* ---------------- the bar ---------------- */
type Step =
  | "ask"
  | "thinking"
  | "confirm"
  | "applying"
  | "checking"
  | "marked"
  | "fixed";
const RAIL = ["Say it", "Confirm", "Marked", "Fixed"];
const railIndex = (s: Step) =>
  s === "ask" || s === "thinking"
    ? 0
    : s === "confirm" || s === "applying"
      ? 1
      : s === "fixed"
        ? 3
        : 2;

const reduceMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const modelLabel = (m: string) =>
  /^muse-wonder/.test(m)
    ? "Muse Wonder"
    : m === "fixture"
      ? "Fixture interpreter (not a model)"
      : m;

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

export function SayIt({
  campaign,
  link,
  disabled,
  onApplied,
  onPreflight,
  initialText = "",
}: {
  campaign: Campaign;
  link: SayItLink;
  disabled?: boolean;
  /** Called with the campaign returned by apply (artifacts untouched, so they are stale). */
  onApplied: (next: Campaign) => void;
  onPreflight: (s: PreflightState) => void;
  initialText?: string;
}) {
  const uid = useId();
  const [text, setText] = useState(initialText);
  const [step, setStep] = useState<Step>("ask");
  const [cmd, setCmd] = useState<Command>();
  const [applied, setApplied] = useState<DiffItem[]>([]);
  const [marks, setMarks] = useState<{
    blocks: number;
    warns: number;
    surfaces: string[];
  }>();
  const [error, setError] = useState("");
  const [micError, setMicError] = useState("");
  const [micPhase, setMicPhase] = useState<"idle" | "recording" | "sending">(
    "idle",
  );
  const [announce, setAnnounce] = useState("");
  const [fixNote, setFixNote] = useState("");
  const abort = useRef<AbortController | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const campaignId = campaign.id;
  const { phase: rpPhase, settle } = link;

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    // another campaign: start clean
    abort.current?.abort();
    setStep("ask");
    setCmd(undefined);
    setApplied([]);
    setMarks(undefined);
    setError("");
  }, [campaignId]);

  // grow the field with its text
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, [text, step]);

  // the Red Pen board finished a fix
  useEffect(() => {
    if (!settle || (step !== "marked" && step !== "fixed")) return;
    if (settle.error) {
      setFixNote(`Fix did not finish. ${settle.error}`);
      setAnnounce(`Fix did not finish. ${settle.error}`);
    } else if (settle.blocking === 0) {
      setStep("fixed");
      setFixNote("");
      setTimeout(() => {
        document
          .getElementById("redpen")
          ?.scrollIntoView({
            block: "start",
            behavior: reduceMotion() ? "auto" : "smooth",
          });
      }, 900);
      setAnnounce(
        "Fixed. The website, reel and caption now match your confirmed facts. Approval is available.",
      );
    } else {
      setFixNote(
        `${plural(settle.fixed, "mark")} fixed, ${settle.blocking} still need${settle.blocking === 1 ? "s" : ""} attention below.`,
      );
      setAnnounce(
        `${settle.fixed} fixed. ${settle.blocking} still ${settle.blocking === 1 ? "needs" : "need"} your attention.`,
      );
    }
  }, [settle]); // eslint-disable-line react-hooks/exhaustive-deps

  // move focus with the loop so keyboard and screen-reader users follow it
  useEffect(() => {
    if (step === "confirm") confirmRef.current?.focus();
    else if (step === "marked" || step === "fixed") headRef.current?.focus();
  }, [step]);

  const busy =
    step === "thinking" || step === "applying" || step === "checking";
  const off = !!disabled || busy || rpPhase !== "idle";

  async function submit(override?: string) {
    const t = (override ?? text).trim();
    if (!t || off) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setError("");
    setCmd(undefined);
    setStep("thinking");
    setAnnounce("Reading your change.");
    try {
      const out = await askCommand(campaign, t, ac.signal);
      if (ac.signal.aborted) return;
      setCmd(out);
      setStep("confirm");
      setAnnounce(
        out.understood
          ? `${plural(out.diff.length, "change")} to confirm. ${out.diff.map((d) => `${d.label}: ${d.from} becomes ${d.to}.`).join(" ")} Nothing is applied until you press Apply.`
          : `Not applied. ${out.questions.join(" ") || "Axys needs more detail."}`,
      );
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setStep("ask");
      const m = e?.message || "Could not read that change.";
      setError(m);
      setAnnounce(`Could not read that change. ${m}`);
    }
  }

  function cancel() {
    abort.current?.abort();
    setCmd(undefined);
    setError("");
    setStep("ask");
    setAnnounce("Cancelled. Nothing was changed.");
    requestAnimationFrame(() => area.current?.focus());
  }

  async function apply() {
    if (!cmd?.understood || !cmd.patch || busy) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setError("");
    setStep("applying");
    setAnnounce("Applying your change to the confirmed facts.");
    let next: Campaign;
    try {
      next = await applyCommand(campaign, cmd.patch, ac.signal);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setStep("confirm");
      const m =
        e instanceof MetaError && e.status === 409
          ? `${e.message} Ask again so Axys reads the latest version.`
          : e?.message || "Could not apply that change.";
      setError(m);
      setAnnounce(`Not applied. ${m}`);
      return;
    }
    setApplied(cmd.diff);
    setStep("checking");
    setAnnounce("Applied. Checking every surface against the new facts.");
    onApplied(next);
    try {
      const result = await requestPreflight(next, ac.signal);
      onPreflight({ result, revision: next.revision });
      const issues = result.issues;
      const blocks = issues.filter((i) => i.severity === "block").length;
      const surfaces = [
        ...new Set(
          issues.filter((i) => i.severity === "block").map((i) => i.surface),
        ),
      ].map((s) => SURFACE_LABEL[s as Issue["surface"]].toLowerCase());
      setMarks({ blocks, warns: issues.length - blocks, surfaces });
      setText("");
      if (blocks === 0) {
        setStep("fixed");
        setAnnounce(
          "Applied. Every surface already matches your confirmed facts. Nothing is stale.",
        );
      } else {
        setStep("marked");
        setAnnounce(
          `Applied. ${plural(blocks, "stale mark")} drawn on the ${surfaces.join(", ")}. Press Fix with Axys to regenerate and re-check.`,
        );
        setTimeout(() => {
          document
            .getElementById("redpen")
            ?.scrollIntoView({
              block: "start",
              behavior: reduceMotion() ? "auto" : "smooth",
            });
        }, 450);
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setMarks({ blocks: 0, warns: 0, surfaces: [] });
      setStep("marked");
      const m = e?.message || "Preflight failed.";
      setError(
        `Your change was applied, but the check could not run. ${m} Run preflight below.`,
      );
      setAnnounce(`Applied, but the check could not run. ${m}`);
    }
  }

  function fix() {
    setFixNote("");
    if (!link.controller.current) {
      setFixNote("The red pen board is not ready yet. Run preflight below.");
      return;
    }
    link.controller.current.fix();
  }

  function again() {
    setStep("ask");
    setCmd(undefined);
    setMarks(undefined);
    setApplied([]);
    setError("");
    setFixNote("");
    link.redpen.onSettle(null);
    requestAnimationFrame(() => area.current?.focus());
  }

  const fixing = rpPhase !== "idle";
  const dock = step === "marked" || step === "fixed";
  const fixedNow = step === "fixed";
  const ri = railIndex(step);

  const p0 = campaign.facts.products.find((p) => p.priceMinor > 0);
  const examples = [
    p0 &&
      `Make the ${p0.name.slice(0, 36).toLowerCase()} ${Math.round(p0.priceMinor / 100) + 20}`,
    "Move the sale to Sunday",
  ].filter(Boolean) as string[];

  const headline =
    step === "ask" || step === "thinking"
      ? "Say what should change"
      : step === "confirm"
        ? cmd?.understood
          ? `Confirm ${plural(cmd.diff.length, "change")}`
          : "One more detail, please"
        : step === "applying"
          ? "Applying to your facts…"
          : step === "checking"
            ? "Checking every surface…"
            : fixedNow
              ? marks && marks.blocks === 0 && !settle
                ? "Nothing is stale"
                : "Every surface matches"
              : fixing
                ? rpPhase === "regenerating"
                  ? "Regenerating from your new facts…"
                  : "Re-checking every surface…"
                : `${plural(marks?.blocks ?? 0, "stale mark")} drawn on your pages`;

  return (
    <section
      className={`sayit step-${step}${dock ? " is-dock" : ""}${fixing ? " is-fixing" : ""}`}
      aria-labelledby={`${uid}-h`}
      onKeyDown={(e) => {
        if (
          e.key === "Escape" &&
          (step === "confirm" || step === "thinking") &&
          micPhase === "idle"
        ) {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="si-top">
        <div className="si-title">
          <p className="eyebrow">SAY IT</p>
          <h2 id={`${uid}-h`} ref={headRef} tabIndex={-1}>
            {headline}
          </h2>
        </div>
        <ol className="si-rail" aria-label="Progress of this change">
          {RAIL.map((label, i) => (
            <li
              key={label}
              className={
                i < ri || (fixedNow && i === 3) ? "done" : i === ri ? "now" : ""
              }
              aria-current={i === ri ? "step" : undefined}
            >
              <span className="si-dot" aria-hidden="true">
                {i < ri || (fixedNow && i === 3) ? "✓" : i + 1}
              </span>
              <span className="si-rail-label">{label}</span>
            </li>
          ))}
        </ol>
      </div>
      {!dock && <FixtureBadge />}

      {!dock && (
        <>
          <form
            className="si-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div
              className={`si-field${micPhase === "recording" ? " is-rec" : ""}`}
            >
              <label htmlFor={`${uid}-in`} className="sr-only">
                Describe the change in your own words, for example a new price
                or day
              </label>
              <textarea
                id={`${uid}-in`}
                ref={area}
                rows={1}
                value={text}
                maxLength={500}
                readOnly={busy || step === "confirm"}
                placeholder={
                  micPhase === "recording"
                    ? "Listening… press stop when you are done"
                    : examples[0]
                      ? `Try: “${examples[0]}”`
                      : "Say or type what should change"
                }
                aria-describedby={`${uid}-hint`}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              <VoiceRecorder
                variant="inline"
                disabled={off || step === "confirm"}
                onError={setMicError}
                onPhase={setMicPhase}
                onTranscript={(t) => {
                  const said = t.slice(0, 500);
                  setText(said);
                  void submit(said);
                }}
              />
            </div>
            {step !== "confirm" && (
              <button
                type="submit"
                className="si-go"
                disabled={off || !text.trim()}
              >
                {step === "thinking" ? (
                  <>
                    <span className="si-spin" aria-hidden="true" /> Reading…
                  </>
                ) : (
                  "Show me the changes"
                )}
              </button>
            )}
          </form>
          <p className="si-hint" id={`${uid}-hint`}>
            {text.length > 400 ? (
              <span className="si-count">
                {500 - text.length} characters left.{" "}
              </span>
            ) : null}
            Speak or type. Nothing changes until you press Apply; every number
            and day must come from your own words.
          </p>
          {micError && (
            <p className="si-alert" role="alert">
              {micError}
            </p>
          )}
          {step === "ask" && !text && examples.length > 0 && (
            <div className="si-chips" role="group" aria-label="Examples">
              {examples.map((x) => (
                <button
                  type="button"
                  key={x}
                  className="si-chip"
                  disabled={off}
                  onClick={() => {
                    setText(x);
                    area.current?.focus();
                  }}
                >
                  {x}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {step === "thinking" && (
        <div className="si-skeleton" aria-hidden="true">
          <i />
          <i />
        </div>
      )}

      {step === "confirm" && cmd && (
        <div
          className="si-confirm"
          ref={confirmRef}
          tabIndex={-1}
          role="group"
          aria-label={
            cmd.understood
              ? `${plural(cmd.diff.length, "change")} to confirm`
              : "Axys needs more detail"
          }
        >
          {cmd.understood ? (
            <>
              <ul className="si-cards">
                {cmd.diff.map((d, i) => (
                  <li
                    className="si-card"
                    key={d.field + i}
                    style={{ "--i": i } as CSSProperties}
                  >
                    <p className="si-label">{d.label}</p>
                    <p className="si-change">
                      <span className="si-from">
                        <span className="sr-only">From </span>
                        <s>{d.from}</s>
                      </span>
                      <svg
                        className="si-arrow"
                        viewBox="0 0 40 16"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M2 8h34M29 2l7 6-7 6" />
                      </svg>
                      <span className="si-to">
                        <span className="sr-only">to </span>
                        <mark>{d.to}</mark>
                      </span>
                    </p>
                    {d.quote && (
                      <blockquote className="si-quote">
                        <span className="si-quote-by">You said</span>
                        <q>{d.quote}</q>
                      </blockquote>
                    )}
                  </li>
                ))}
              </ul>
              {cmd.summary && <p className="si-summary">{cmd.summary}</p>}
            </>
          ) : (
            <div className="si-ask">
              <p className="si-ask-h">
                Not applied.{" "}
                {cmd.questions.length
                  ? "Axys needs an answer:"
                  : "Axys needs more detail."}
              </p>
              {cmd.questions.length > 0 && (
                <ul>
                  {cmd.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              )}
              {cmd.summary && <p className="si-summary">{cmd.summary}</p>}
            </div>
          )}
          {cmd.understood && cmd.questions.length > 0 && (
            <div className="si-ask soft">
              <p className="si-ask-h">Also</p>
              <ul>
                {cmd.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="si-actions">
            {cmd.understood ? (
              <button
                type="button"
                className="si-apply"
                onClick={() => void apply()}
              >
                Apply {plural(cmd.diff.length, "change")}
              </button>
            ) : (
              <button
                type="button"
                className="si-apply"
                onClick={() => {
                  cancel();
                }}
              >
                Edit what I said
              </button>
            )}
            {cmd.understood && (
              <button type="button" className="si-text" onClick={cancel}>
                Cancel
              </button>
            )}
            <span className="si-by">
              Read by <b>{modelLabel(cmd.model) || "Muse Wonder"}</b>, then
              checked in code against your words.
            </span>
          </div>
        </div>
      )}

      {(step === "applying" || step === "checking") && (
        <div className="si-progress" aria-hidden="true">
          <i className={step === "checking" ? "two" : "one"} />
        </div>
      )}

      {dock && (
        <div className="si-dockbody">
          <ul className="si-applied" aria-label="Changes applied to your facts">
            {applied.map((d, i) => (
              <li key={d.field + i}>
                <span className="si-applied-l">{d.label}</span>
                <span className="si-applied-v">
                  <s>{d.from}</s> <b aria-hidden="true">→</b>{" "}
                  <span className="sr-only">to </span>
                  <mark>{d.to}</mark>
                </span>
              </li>
            ))}
          </ul>
          <div className="si-dockrow">
            <p className="si-status">
              {fixedNow ? (
                <>
                  <svg
                    className="si-tick"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <circle cx="12" cy="12" r="10.5" />
                    <path d="M7 12.5l3.2 3.2L17 8.8" />
                  </svg>
                  {settle && !settle.error
                    ? `${plural(settle.fixed, "mark")} turned green. Everything matches your confirmed facts.`
                    : "Applied. The website, reel and caption already match your facts."}
                </>
              ) : fixing ? (
                rpPhase === "regenerating" ? (
                  "Redrawing the website, reel and caption from your new facts. The red marks stay until the new version is ready."
                ) : (
                  "Looking at every surface again."
                )
              ) : (
                `Axys marked the ${marks?.surfaces.join(", ") || "pages"} where the old values still show. ${fixNote}`
              )}
            </p>
            <div className="si-dockbtns">
              {!fixedNow && (
                <button
                  type="button"
                  className="si-apply si-fix"
                  onClick={fix}
                  disabled={fixing || !!disabled}
                  aria-busy={fixing}
                >
                  {fixing ? (
                    <>
                      <span className="si-spin dark" aria-hidden="true" />
                      {rpPhase === "regenerating"
                        ? "Regenerating…"
                        : "Re-checking…"}
                    </>
                  ) : (
                    "Fix with Axys"
                  )}
                </button>
              )}
              <button
                type="button"
                className="si-text"
                onClick={again}
                disabled={fixing}
              >
                Say another change
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="si-alert" role="alert">
          {error}
        </p>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
    </section>
  );
}

/* ================================================================== *
 * Staged scenario: ?fixture=meta&scenario=command (no backend).
 * ================================================================== */
type Facts = Campaign["facts"];
function demoFacts(): Facts {
  return {
    business: "Bake & Co",
    offer: "Weekend brownie box",
    collection: "Saturday after 4 pm",
    contact: "https://example.com/order",
    products: [
      {
        id: "p1",
        name: "Weekend brownie box",
        priceMinor: 12900,
        currency: "USD",
        assetId: "fixture:orig:0:0",
      },
      {
        id: "p2",
        name: "Salted caramel tin",
        priceMinor: 8900,
        currency: "USD",
        assetId: "fixture:orig:1:0",
      },
    ],
    confirmed: true,
    source: "merchant",
  };
}
function demoCampaign(
  facts: Facts,
  artifactFacts: Facts,
  revision: number,
): Campaign {
  return {
    id: COMMAND_ID,
    tenantId: "fixture",
    revision,
    state: "NeedsReview",
    facts,
    brief: "",
    mode: "Both",
    layout: "editorial",
    reelStyle: "warm",
    site: {
      schemaVersion: 1,
      facts: artifactFacts,
      layout: "editorial",
      headline: artifactFacts.offer,
    },
    reel: {
      schemaVersion: 1,
      facts: artifactFacts,
      style: "warm",
      shots: [
        {
          productId: "p1",
          duration: 4,
          text: moneyOf(artifactFacts.products[0]),
        },
        { productId: "p2", duration: 4, text: artifactFacts.collection },
      ],
      caption: `${artifactFacts.business}\n${artifactFacts.offer}\n${artifactFacts.products.map((p) => `${p.name} — ${moneyOf(p)}`).join("\n")}\n${artifactFacts.collection}\n${artifactFacts.contact}`,
    },
  } as Campaign;
}

export function CommandDemo() {
  const link = useSayItLink();
  const [c, setC] = useState<Campaign>(() =>
    demoCampaign(demoFacts(), demoFacts(), 1),
  );
  const [pf, setPf] = useState<PreflightState>();
  const [round, setRound] = useState(0);
  const latest = useRef(c);
  latest.current = c;
  const blocked = blockCount(pf, c) > 0;
  const regenerate = async () => {
    const cur = latest.current;
    setC({ ...cur, state: "Generating", site: undefined, reel: undefined });
    await sleepMs(2200);
    const next = demoCampaign(cur.facts, cur.facts, cur.revision + 1);
    setC(next);
    return next;
  };
  const frame = (shot: number, camp: Campaign) => {
    const f = camp.reel?.facts;
    if (!f) return undefined;
    return fixtureReelFrame(
      shot,
      f.products[0].name,
      moneyOf(f.products[0]),
      f.collection,
    ).src;
  };
  return (
    <div className="rp-demo">
      <header className="rp-demo-head">
        <div className="wordmark">
          axys<span>●</span>
        </div>
        <div>
          <p className="eyebrow">REVIEW AND PUBLISH · STAGED SCENARIO</p>
          <h1>Say it once. Every surface follows.</h1>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setC(demoCampaign(demoFacts(), demoFacts(), 1));
            setPf(undefined);
            setRound((n) => n + 1);
          }}
        >
          Restart scenario
        </button>
      </header>
      <FixtureBadge />
      <p className="muted rp-demo-note">
        Scenario: a finished campaign (website, reel, caption at $129.00,
        pickup Saturday). Say a change, confirm the diff, and watch the red pen
        mark every surface that still shows the old values, then fix them in one
        press. The interpreter, the checks and every frame here are staged in
        the browser; none of it is model output.
      </p>
      <SayIt
        key={`si${round}`}
        campaign={c}
        link={link}
        disabled={c.state === "Generating"}
        initialText="Make the brownie box 149 and move the pickup to Sunday"
        onApplied={setC}
        onPreflight={setPf}
      />
      <PreflightPanel
        key={`pf${round}`}
        campaign={c}
        state={pf}
        onResult={setPf}
      />
      <RedPen
        key={`rp${round}`}
        campaign={c}
        state={pf}
        onResult={setPf}
        regenerate={regenerate}
        reelFrame={frame}
        assetUrl={(id) => assetSrc(id) || ""}
        {...link.redpen}
      />
      <section className="panel">
        <h2>Approve this exact version</h2>
        {blocked && (
          <p className="approve-block" id="cmd-demo-block">
            Approval is disabled: preflight found {blockCount(pf, c)} blocking
            issue
            {blockCount(pf, c) > 1 ? "s" : ""}. Fix the facts or outputs, then
            re-run preflight above.
          </p>
        )}
        <button
          type="button"
          aria-disabled={blocked || !pf || undefined}
          aria-describedby={blocked ? "cmd-demo-block" : undefined}
          onClick={() => {}}
        >
          I approve this version (fixture: nothing is sent)
        </button>
      </section>
    </div>
  );
}
