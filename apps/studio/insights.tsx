import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import "./insights.css";

/**
 * Insights dashboard for the Results stage. It renders whatever GET /campaigns/:id/metrics returns:
 *  - sample record (sample:true, source "Sample data (not Instagram)"): every card group carries a loud
 *    "SAMPLE DATA, not from Instagram" ribbon;
 *  - real Instagram insights (Graph rows in instagram.data.data): same cards, no ribbon, unknown values stay "Unknown";
 *  - nothing retrieved: an honest empty state.
 * Values missing from the record are never shown as zero.
 */

type Day = { day: string; plays?: number; reach_cumulative?: number; likes?: number; saves?: number; shares?: number };
type Bar = { label: string; pct: number };
export type Insights = {
  sample: boolean;
  source: string;
  observedAt?: string;
  kpi: Record<string, number | undefined>;
  days: Day[];
  retention: { second: number; pct: number }[];
  avgWatch?: number;
  age: Bar[];
  country: Bar[];
  visits?: number;
  contacts?: number;
  hasInstagram: boolean;
};

const ALIAS: Record<string, [string, number]> = {
  plays: ["plays", 1],
  views: ["plays", 1],
  reach: ["reach", 1],
  likes: ["likes", 1],
  comments: ["comments", 1],
  saved: ["saves", 1],
  saves: ["saves", 1],
  shares: ["shares", 1],
  profile_visits: ["profile_visits", 1],
  follows: ["follows", 1],
  avg_watch_time: ["avg_watch_time", 1],
  ig_reels_avg_watch_time: ["avg_watch_time", 0.001],
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

export function readInsights(metrics: any): Insights {
  const ig = metrics?.instagram;
  const sample = !!(metrics?.sample || ig?.sample);
  const kpi: Record<string, number | undefined> = {};
  const rows = Array.isArray(ig?.data?.data) ? ig.data.data : [];
  for (const r of rows) {
    const a = ALIAS[String(r?.name)];
    if (!a) continue;
    const v = num(r?.total_value?.value) ?? num(r?.values?.[0]?.value);
    if (v !== undefined) kpi[a[0]] = Math.round(v * a[1] * 100) / 100;
  }
  const series = ig?.series ?? {};
  const days: Day[] = Array.isArray(series.days)
    ? series.days.filter((d: any) => typeof d?.day === "string").slice(0, 31)
    : [];
  const retention = Array.isArray(series.retention)
    ? series.retention
        .filter((d: any) => num(d?.second) !== undefined && num(d?.pct) !== undefined)
        .map((d: any) => ({ second: d.second as number, pct: d.pct as number }))
    : [];
  const bars = (a: any): Bar[] =>
    Array.isArray(a)
      ? a.filter((b: any) => typeof b?.label === "string" && num(b?.pct) !== undefined).map((b: any) => ({ label: b.label, pct: b.pct }))
      : [];
  const site = Array.isArray(metrics?.website) ? metrics.website : [];
  const kind = (k: RegExp) => num(site.find((r: any) => k.test(String(r?.kind)))?.value);
  return {
    sample,
    source: typeof ig?.source === "string" ? ig.source : "Instagram",
    observedAt: typeof ig?.observedAt === "string" ? ig.observedAt : undefined,
    kpi,
    days,
    retention,
    avgWatch: num(series.avgWatchTimeSeconds) ?? kpi.avg_watch_time,
    age: bars(series.audience?.age),
    country: bars(series.audience?.country),
    visits: kind(/^(visit|visits|page_view)$/),
    contacts: kind(/^(contact|contacts|contact_click)$/),
    hasInstagram: Object.keys(kpi).length > 0,
  };
}

const fmt = (n: number | undefined, digits = 0) =>
  n === undefined ? "Unknown" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const pctOf = (a?: number, b?: number, d = 1) =>
  a !== undefined && b ? `${((a / b) * 100).toFixed(d)}%` : undefined;
const shortDay = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(+d) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/* ---------- ribbon + group ---------- */
function Ribbon() {
  return (
    <div className="ins-ribbon" role="note">
      <i aria-hidden="true" />
      <b>SAMPLE DATA</b>
      <span>not from Instagram</span>
    </div>
  );
}
function Group({ sample, title, eyebrow, children, className = "" }: { sample: boolean; title: string; eyebrow?: string; children: React.ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={`ins-group${sample ? " is-sample" : ""} ${className}`} aria-labelledby={id}>
      {sample ? <Ribbon /> : null}
      <div className="ins-group-body">
        <header className="ins-gh">
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h3 id={id}>{title}</h3>
        </header>
        {children}
      </div>
    </section>
  );
}

/* ---------- spark + charts ---------- */
function monotone(pts: [number, number][]): string {
  const n = pts.length;
  if (n < 2) return "";
  const dx: number[] = [], dy: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    dy.push(pts[i + 1][1] - pts[i][1]);
    m.push(dy[i] / dx[i]);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
    } else {
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) {
        const k = 3 / Math.sqrt(s);
        t[i] = k * a * m[i];
        t[i + 1] = k * b * m[i];
      }
    }
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i][0] + h).toFixed(1)} ${(pts[i][1] + t[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)} ${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 84, h = 28, max = Math.max(...values), min = Math.min(...values);
  const pts: [number, number][] = values.map((v, i) => [(i / (values.length - 1)) * (w - 4) + 2, h - 3 - ((v - min) / (max - min || 1)) * (h - 8)]);
  const d = monotone(pts);
  return (
    <svg className="ins-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={`${d} L${pts[pts.length - 1][0]} ${h} L${pts[0][0]} ${h}Z`} className="fill" />
      <path d={d} className="line" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.4" />
    </svg>
  );
}

type CPoint = { x: number; label: string; value: number };
function Chart({
  points, xTicks, yMax, yTicks, yFmt, valueFmt, ariaLabel, seriesName, tone, marker, height = 250,
}: {
  points: CPoint[]; xTicks: { x: number; label: string }[]; yMax: number; yTicks: number[];
  yFmt: (v: number) => string; valueFmt: (v: number) => string; ariaLabel: string; seriesName: string;
  tone: "orange" | "violet"; marker?: { x: number; label: string }; height?: number;
}) {
  const uid = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW(Math.max(260, Math.round(el.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height, L = 46, R = 18, T = 16, B = 34;
  const xs = points.map((p) => p.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const X = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const pts: [number, number][] = points.map((p) => [X(p.x), Y(p.value)]);
  const line = monotone(pts);
  const [active, setActive] = useState<number | null>(null);
  const idx = active;
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(p[0] - fx); if (d < bd) { bd = d; best = i; } });
    setActive(best);
  };
  const cur = idx !== null ? points[idx] : null;
  const curPt = idx !== null ? pts[idx] : null;
  return (
    <div
      className="ins-chart"
      ref={box}
      tabIndex={0}
      role="group"
      aria-label={`${ariaLabel}. Use the left and right arrow keys to read each value.`}
      onPointerMove={onMove}
      onPointerLeave={() => setActive(null)}
      onFocus={() => setActive((a) => a ?? points.length - 1)}
      onBlur={() => setActive(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") (e.preventDefault(), setActive((a) => Math.min(points.length - 1, (a ?? -1) + 1)));
        if (e.key === "ArrowLeft") (e.preventDefault(), setActive((a) => Math.max(0, (a ?? 1) - 1)));
        if (e.key === "Escape") setActive(null);
      }}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="presentation" className={`tone-${tone}`}>
        <defs>
          <linearGradient id={`g${uid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" className="stop-a" />
            <stop offset="1" className="stop-b" />
          </linearGradient>
        </defs>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={Y(t)} y2={Y(t)} className="grid" />
            <text x={L - 10} y={Y(t) + 4} textAnchor="end" className="tick">{yFmt(t)}</text>
          </g>
        ))}
        {xTicks.filter((_, i) => W >= 460 || i % 2 === 0 || i === xTicks.length - 1).map((t) => (
          <text key={t.x} x={X(t.x)} y={H - 10} textAnchor="middle" className="tick">{t.label}</text>
        ))}
        {marker ? (
          <g>
            <line x1={X(marker.x)} x2={X(marker.x)} y1={T} y2={H - B} className="marker" />
            <text x={X(marker.x) + 7} y={T + 12} className="marker-label">{marker.label}</text>
          </g>
        ) : null}
        <path d={`${line} L${pts[pts.length - 1][0].toFixed(1)} ${H - B} L${pts[0][0].toFixed(1)} ${H - B}Z`} fill={`url(#g${uid})`} />
        <path d={line} className="series" />
        {pts.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={idx === i ? 5.5 : 3.2} className={idx === i ? "dot on" : "dot"} />
        ))}
        {curPt ? <line x1={curPt[0]} x2={curPt[0]} y1={T} y2={H - B} className="guide" /> : null}
      </svg>
      {cur && curPt ? (
        <div className="ins-tip" style={{ left: Math.min(Math.max(curPt[0], 54), W - 54), top: curPt[1] }} aria-hidden="true">
          <small>{cur.label}</small>
          <b>{valueFmt(cur.value)}</b>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">{cur ? `${cur.label}: ${valueFmt(cur.value)} ${seriesName}` : ""}</p>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead><tr><th>Point</th><th>{seriesName}</th></tr></thead>
        <tbody>{points.map((p) => <tr key={p.x}><td>{p.label}</td><td>{valueFmt(p.value)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

const niceMax = (v: number) => {
  const p = Math.pow(10, Math.floor(Math.log10(v || 1)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
};

const SERIES: { id: "plays" | "reach_cumulative" | "likes" | "saves" | "shares"; label: string }[] = [
  { id: "plays", label: "Plays" },
  { id: "reach_cumulative", label: "Reach (cumulative)" },
  { id: "likes", label: "Likes" },
  { id: "saves", label: "Saves" },
  { id: "shares", label: "Shares" },
];

function DaysChart({ days }: { days: Day[] }) {
  const have = SERIES.filter((s) => days.every((d) => typeof d[s.id] === "number"));
  const [sel, setSel] = useState<string>(have[0]?.id ?? "plays");
  const cur = have.find((s) => s.id === sel) ?? have[0];
  if (!cur) return <p className="muted">The daily breakdown was not retrieved.</p>;
  const pts: CPoint[] = days.map((d, i) => ({ x: i, label: shortDay(d.day), value: d[cur.id] as number }));
  const max = niceMax(Math.max(...pts.map((p) => p.value)) * 1.05);
  const total = cur.id === "reach_cumulative" ? undefined : pts.reduce((a, p) => a + p.value, 0);
  return (
    <>
      <div className="ins-chips" role="radiogroup" aria-label="Metric shown in the 7-day chart">
        {have.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={cur.id === s.id} className={cur.id === s.id ? "on" : ""} onClick={() => setSel(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <Chart
        points={pts}
        xTicks={pts.map((p) => ({ x: p.x, label: p.label }))}
        yMax={max}
        yTicks={[0, max / 4, max / 2, (max * 3) / 4, max]}
        yFmt={(v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(Math.round(v)))}
        valueFmt={(v) => v.toLocaleString("en-US")}
        ariaLabel={`${cur.label} per day over the last ${days.length} days`}
        seriesName={cur.label.toLowerCase()}
        tone="orange"
      />
      <p className="ins-cap">
        {cur.label} by day, {shortDay(days[0].day)} to {shortDay(days[days.length - 1].day)}
        {total !== undefined ? <> · <b>{total.toLocaleString("en-US")}</b> total</> : <> · running total of unique accounts</>}
      </p>
    </>
  );
}

function RetentionChart({ points, avg }: { points: { second: number; pct: number }[]; avg?: number }) {
  const last = points[points.length - 1];
  const pts: CPoint[] = points.map((p) => ({ x: p.second, label: `${p.second} s`, value: p.pct }));
  const ticks = points.filter((p) => p.second % 2 === 0 || p === last).map((p) => ({ x: p.second, label: `${p.second}s` }));
  return (
    <>
      <Chart
        points={pts}
        xTicks={ticks}
        yMax={100}
        yTicks={[0, 25, 50, 75, 100]}
        yFmt={(v) => `${v}%`}
        valueFmt={(v) => `${v}% still watching`}
        ariaLabel="Audience retention: share of viewers still watching at each second"
        seriesName="retention"
        tone="violet"
        height={230}
        marker={avg !== undefined && avg <= last.second ? { x: avg, label: `avg watch ${avg} s` } : undefined}
      />
      <p className="ins-cap">
        <b>{points[0].pct}%</b> at {points[0].second} s falling to <b>{last.pct}%</b> at {last.second} s
      </p>
    </>
  );
}

function BarList({ rows, tone }: { rows: Bar[]; tone: "orange" | "violet" }) {
  const max = Math.max(...rows.map((r) => r.pct), 1);
  return (
    <ul className={`ins-bars tone-${tone}`}>
      {rows.map((r) => (
        <li key={r.label}>
          <span className="lbl">{r.label}</span>
          <span className="track" aria-hidden="true"><i style={{ width: `${(r.pct / max) * 100}%` }} /></span>
          <span className="val">{r.pct}%</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- learned card ---------- */
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
function Highlight({ text, obs }: { text: string; obs: { metric: string; value: number }[] }) {
  const byValue = new Map<string, string>();
  for (const o of obs) byValue.set(String(o.value), o.metric.replace(/_/g, " "));
  const out: React.ReactNode[] = [];
  let last = 0;
  text.replace(NUMBER, (m, off: number) => {
    const key = m.replace(/,/g, "");
    const metric = byValue.get(key) ?? byValue.get(String(Number(key)));
    if (off > last) out.push(text.slice(last, off));
    out.push(metric ? <mark key={off} title={`Observed ${metric}`}>{m}</mark> : m);
    last = off + m.length;
    return m;
  });
  out.push(text.slice(last));
  return <>{out}</>;
}

export type Proposal = {
  proposal?: { suggestion: string; headline?: string; layout?: string; reelStyle?: string; questions?: string[]; tool?: string };
  trace?: { grounded?: boolean; fallbackReason?: string; model?: string | null; sampleData?: boolean };
  signal?: { sufficient?: boolean; observations?: { source?: string; metric: string; value: number }[] };
};

function Learned({ sample, data, proposal, busy, canPropose, onPropose }: { sample: boolean; data: Insights; proposal?: Proposal; busy: boolean; canPropose: boolean; onPropose: () => void }) {
  const p = proposal?.proposal;
  const obs = proposal?.signal?.observations ?? [];
  const quoted = useMemo(() => {
    if (!p) return [];
    const nums = new Set((p.suggestion.match(NUMBER) ?? []).map((n) => String(Number(n.replace(/,/g, "")))));
    return obs.filter((o) => nums.has(String(o.value)));
  }, [p, obs]);
  const sampleRun = proposal?.trace?.sampleData ?? sample;
  return (
    <Group sample={sample} title="What Axys learned" eyebrow="WHAT SHOULD CHANGE NEXT?" className="ins-learned">
      <p className="muted ins-learn-intro">
        Muse Wonder reads the observed numbers and proposes one change. Code checks that every number it writes was
        actually observed, and a suggestion that fails the check is replaced by a plain summary. You approve any change.
      </p>
      <button type="button" disabled={!canPropose || busy} onClick={onPropose}>
        Propose a revision
      </button>
      {p ? (
        <div className="ins-proposal" aria-live="polite">
          <div className="ins-tags">
            {proposal?.trace?.grounded ? (
              <span className="ins-tag ok"><i />grounded</span>
            ) : (
              <span className="ins-tag warn" title={proposal?.trace?.fallbackReason}><i />deterministic summary</span>
            )}
            {sampleRun ? <span className="ins-tag sample"><i />sample data</span> : null}
            {proposal?.trace?.model ? <span className="ins-tag quiet">{proposal.trace.model}</span> : null}
          </div>
          <p className="ins-suggestion"><Highlight text={p.suggestion} obs={obs} /></p>
          {quoted.length ? (
            <div className="ins-quoted">
              <span>Numbers it quoted</span>
              {quoted.map((o) => (
                <b key={o.metric}>{o.metric.replace(/_/g, " ")} <em>{o.value.toLocaleString("en-US")}</em></b>
              ))}
            </div>
          ) : null}
          {(p.layout || p.reelStyle) ? (
            <div className="ins-quoted">
              <span>Suggested</span>
              {p.layout ? <b>layout <em>{p.layout}</em></b> : null}
              {p.reelStyle ? <b>reel style <em>{p.reelStyle}</em></b> : null}
            </div>
          ) : null}
          {p.questions?.length ? <ul className="ins-questions">{p.questions.map((q) => <li key={q}>{q}</li>)}</ul> : null}
          {proposal?.trace?.fallbackReason ? <p className="muted ins-why">Why the summary replaced the model text: {proposal.trace.fallbackReason}.</p> : null}
        </div>
      ) : (
        <p className="muted ins-empty-learn">
          {data.hasInstagram || data.visits !== undefined ? "No proposal yet. Press the button to run the grounded review." : "Load insights first: there is nothing observed to learn from yet."}
        </p>
      )}
    </Group>
  );
}

/* ---------- dashboard ---------- */
const KPIS: { id: string; label: string; unit?: string; sub?: (k: Insights["kpi"], d: Insights) => string | undefined; series?: keyof Day }[] = [
  { id: "plays", label: "Plays", series: "plays", sub: (k) => (k.plays && k.reach ? `${(k.plays / k.reach).toFixed(2)} plays per account reached` : undefined) },
  { id: "reach", label: "Reach", series: "reach_cumulative", sub: () => "unique accounts" },
  { id: "likes", label: "Likes", series: "likes", sub: (k) => { const r = pctOf(k.likes, k.plays); return r ? `${r} of plays` : undefined; } },
  { id: "comments", label: "Comments", sub: (k) => { const r = pctOf(k.comments, k.plays, 2); return r ? `${r} of plays` : undefined; } },
  { id: "saves", label: "Saves", series: "saves", sub: (k) => { const r = pctOf(k.saves, k.plays); return r ? `${r} of plays` : undefined; } },
  { id: "shares", label: "Shares", series: "shares", sub: (k) => { const r = pctOf(k.shares, k.plays); return r ? `${r} of plays` : undefined; } },
  { id: "profile_visits", label: "Profile visits", sub: (k) => { const r = pctOf(k.profile_visits, k.plays); return r ? `${r} of plays` : undefined; } },
  { id: "follows", label: "Follows", sub: (k) => { const r = pctOf(k.follows, k.profile_visits); return r ? `${r} of profile visits` : undefined; } },
  { id: "avg_watch_time", label: "Avg watch time", unit: " s", sub: (_k, d) => { const len = d.retention[d.retention.length - 1]?.second; const r = pctOf(d.avgWatch, len, 0); return r && len ? `${r} of the ${len} s reel` : undefined; } },
];

export function InsightsDashboard({
  metrics, demoSamples, busy, onLoadSample, onPropose, canPropose, proposal, headingLevel,
}: {
  metrics: any; demoSamples: boolean; busy: boolean; onLoadSample: () => void; onPropose: () => void; canPropose: boolean; proposal?: Proposal; headingLevel?: number;
}) {
  const d = useMemo(() => readInsights(metrics), [metrics]);
  const loaded = metrics !== undefined;
  const hasAny = d.hasInstagram || d.visits !== undefined || d.contacts !== undefined;
  void headingLevel;
  const observed = d.observedAt ? new Date(d.observedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : undefined;
  return (
    <div className="ins" data-sample={d.sample ? "true" : "false"}>
      <div className="ins-top">
        <div>
          <p className="eyebrow">INSIGHTS</p>
          <h2>How the reel is doing</h2>
          <p className="muted">
            {d.hasInstagram
              ? d.sample
                ? "Simulated first-week numbers for a 10 second reel, shown to demonstrate the dashboard and the feedback loop. Nothing here was retrieved from Instagram."
                : `Observed from Instagram${observed ? `, retrieved ${observed}` : ""}. Values Instagram did not return stay Unknown.`
              : loaded
                ? "No Instagram insights have been retrieved for this campaign."
                : "Load available results to see the dashboard."}
          </p>
        </div>
        <div className="ins-actions">
          {demoSamples ? (
            <button type="button" className="secondary" disabled={busy} onClick={onLoadSample}>
              Load sample insights
            </button>
          ) : null}
        </div>
      </div>

      {!d.hasInstagram ? (
        <section className="ins-empty">
          <div aria-hidden="true" className="ins-empty-art">
            <svg viewBox="0 0 120 48" width="120" height="48"><path d="M2 40 C20 40 24 14 44 18 S72 38 84 22 106 6 118 10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="2 7" /></svg>
          </div>
          <p><strong>Unknown, not zero.</strong> Insights appear here after a reel is posted and Instagram reports them{demoSamples ? ", or once you load the labelled sample numbers" : ""}.</p>
        </section>
      ) : (
        <>
          <Group sample={d.sample} title="Reel performance" eyebrow="LIFETIME TOTALS">
            <div className="ins-kpis">
              {KPIS.map((k) => {
                const v = d.kpi[k.id] ?? (k.id === "avg_watch_time" ? d.avgWatch : undefined);
                const vals = k.series ? d.days.map((x) => x[k.series!]).filter((n): n is number => typeof n === "number") : [];
                return (
                  <div className="ins-kpi" key={k.id}>
                    <span className="lbl">{k.label}</span>
                    <strong className={v === undefined ? "unknown" : ""}>
                      {v === undefined ? "Unknown" : k.id === "avg_watch_time" ? v.toFixed(1) : fmt(v)}
                      {v !== undefined && k.unit ? <small>{k.unit}</small> : null}
                    </strong>
                    <span className="sub">{v === undefined ? "not reported" : k.sub?.({ ...d.kpi, avg_watch_time: v }, d)}</span>
                    {vals.length > 1 ? <Spark values={vals} /> : null}
                  </div>
                );
              })}
            </div>
          </Group>

          {d.days.length > 1 || d.retention.length > 1 ? (
            <div className="ins-two">
              {d.days.length > 1 ? (
                <Group sample={d.sample} title="Last 7 days" eyebrow="PLAYS BY DAY">
                  <DaysChart days={d.days} />
                </Group>
              ) : null}
              {d.retention.length > 1 ? (
                <Group sample={d.sample} title="Retention" eyebrow="WHO KEEPS WATCHING">
                  <RetentionChart points={d.retention} avg={d.avgWatch} />
                </Group>
              ) : null}
            </div>
          ) : (
            <p className="muted ins-note">The daily breakdown and the retention curve were not retrieved for this reel.</p>
          )}

          {d.age.length || d.country.length ? (
            <Group sample={d.sample} title="Audience" eyebrow="WHO WATCHED">
              <div className="ins-aud">
                {d.age.length ? (
                  <div><h4>By age</h4><BarList rows={d.age} tone="orange" /></div>
                ) : null}
                {d.country.length ? (
                  <div><h4>By country</h4><BarList rows={d.country} tone="violet" /></div>
                ) : null}
              </div>
            </Group>
          ) : null}
        </>
      )}

      {hasAny ? (
        <Group sample={d.sample} title="Website" eyebrow="VISITS & CONTACT CLICKS" className="ins-site">
          <div className="ins-sitegrid">
            <div className="ins-kpi">
              <span className="lbl">Website visits</span>
              <strong className={d.visits === undefined ? "unknown" : ""}>{fmt(d.visits)}</strong>
              <span className="sub">{d.visits === undefined ? "no recorded events" : "page views of the campaign site"}</span>
            </div>
            <div className="ins-kpi">
              <span className="lbl">Contact clicks</span>
              <strong className={d.contacts === undefined ? "unknown" : ""}>{fmt(d.contacts)}</strong>
              <span className="sub">{pctOf(d.contacts, d.visits) ? `${pctOf(d.contacts, d.visits)} of visits` : d.contacts === undefined ? "no recorded events" : undefined}</span>
            </div>
          </div>
          <p className="muted ins-note">
            These events do not establish purchases or sales lift. Automated traffic may be included.
          </p>
        </Group>
      ) : null}

      <Learned sample={d.sample} data={d} proposal={proposal} busy={busy} canPropose={canPropose} onPropose={onPropose} />
    </div>
  );
}
