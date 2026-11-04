import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Campaign } from "../../packages/campaign/index";
import { Site } from "../../packages/renderers/Site";
import {
  FixtureBadge,
  PreflightPanel,
  STALE_ID,
  SURFACE_LABEL,
  assetSrc,
  blockCount,
  fixtureReelFrame,
  requestPreflight,
  sleepMs,
  type Issue,
  type PreflightState,
} from "./meta";
import { shotSeek, useAutoplayInView, usesFilmLayout } from "./film";
import "./redpen.css";
import { money as formatMoney } from "./money";

/* ================================================================== *
 * Red Pen: marks the merchant's real artifacts like an editor's pen.
 * Every string that comes from the server is rendered as a React text
 * node or an SVG text node; nothing is ever set as HTML.
 * ================================================================== */

type Rect = { x: number; y: number; w: number; h: number };
type Status = "open" | "fixed";
type Item = { key: string; issue: Issue; status: Status };
type Targets = Rect[][]; // matches -> line rects (host-local coordinates)
type Layout = {
  sizes: Record<Surf, { w: number; h: number; g?: number }>;
  geo: Record<string, Targets>;
};
type Surf = "site" | "reel" | "caption";

const NOTE_FONT = `"Caveat", "Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive`;

/* ---------------- deterministic hand-drawn geometry ---------------- */
function hashOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rngFor(seed: string) {
  let a = hashOf(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f1 = (n: number) => Math.round(n * 10) / 10;
type Pt = [number, number];
/** Catmull-Rom through the points, as a cubic Bezier path (smooth, pen-like). */
function smooth(pts: Pt[]): string {
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i],
      p1 = pts[i],
      p2 = pts[i + 1],
      p3 = pts[i + 2] ?? p2;
    d += ` C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d;
}
type Shape = {
  ellipse: string;
  strike: string;
  tick: string;
  bounds: Rect; // the ellipse's outer bounds
  cx: number;
  cy: number;
};
function drawShape(r: Rect, seed: string): Shape {
  const rnd = rngFor(seed);
  const cx = r.x + r.w / 2,
    cy = r.y + r.h / 2;
  const rx = Math.max((r.w / 2) * 1.2 + 11, 24),
    ry = Math.max((r.h / 2) * 1.4 + 7, 15);
  const a0 = -Math.PI * 0.62 + (rnd() - 0.5) * 0.5;
  const sweep = Math.PI * 2 * 1.08; // overshoots its own start, like a real loop
  const N = 30;
  const pts: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N,
      a = a0 + t * sweep;
    const k = 1 + (rnd() - 0.5) * 0.06 + t * 0.075;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  const sp: Pt[] = [];
  const x0 = r.x - 7,
    x1 = r.x + r.w + 7,
    slope = (rnd() - 0.5) * 5;
  for (let i = 0; i <= 7; i++) {
    const t = i / 7;
    sp.push([
      x0 + (x1 - x0) * t,
      cy + 1 + slope * (t - 0.5) + (rnd() - 0.5) * 2.4,
    ]);
  }
  const tx = cx + rx * 0.7,
    ty = Math.max(cy - ry * 0.95, 2);
  const tick = smooth([
    [tx, ty + 9 + (rnd() - 0.5)],
    [tx + 5, ty + 15],
    [tx + 8, ty + 18 + (rnd() - 0.5)],
    [tx + 17, ty + 6],
    [tx + 26, ty - 6 + (rnd() - 0.5)],
  ]);
  return {
    ellipse: smooth(pts),
    strike: smooth(sp),
    tick,
    bounds: { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 },
    cx,
    cy,
  };
}
function wrapNote(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

/* ---------------- finding text in the real DOM ---------------- */
const NBSP = / /g;
function findTextRects(root: Element, needle: string): Targets {
  const nd = needle.replace(NBSP, " ");
  if (!nd.trim()) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      return !p || p.closest("script,style,noscript,svg,[hidden]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: { node: Text; start: number; len: number }[] = [];
  let full = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = (n.nodeValue || "").replace(NBSP, " ");
    nodes.push({ node: n as Text, start: full.length, len: v.length });
    full += v;
  }
  const all = (hay: string, ndl: string) => {
    const out: number[] = [];
    for (let i = hay.indexOf(ndl); i >= 0; i = hay.indexOf(ndl, i + ndl.length))
      out.push(i);
    return out;
  };
  let hits = all(full, nd);
  if (!hits.length) {
    const lf = full.toLowerCase(),
      ln = nd.toLowerCase();
    if (lf.length === full.length && ln.length === nd.length)
      hits = all(lf, ln);
  }
  const locate = (pos: number, end: boolean) => {
    for (const n of nodes)
      if (
        end
          ? pos > n.start && pos <= n.start + n.len
          : pos >= n.start && pos < n.start + n.len
      )
        return { node: n.node, off: pos - n.start };
    return undefined;
  };
  const out: Targets = [];
  for (const h of hits.slice(0, 6)) {
    const s = locate(h, false),
      e = locate(h + nd.length, true);
    if (!s || !e) continue;
    const range = document.createRange();
    try {
      range.setStart(s.node, s.off);
      range.setEnd(e.node, e.off);
    } catch {
      continue;
    }
    // one rect per visual line
    const lines: DOMRect[] = [];
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      const hit = lines.find((l) => Math.abs(l.top - r.top) < r.height / 2);
      if (hit) {
        const x0 = Math.min(hit.left, r.left),
          x1 = Math.max(hit.right, r.right);
        lines[lines.indexOf(hit)] = new DOMRect(
          x0,
          hit.top,
          x1 - x0,
          hit.height,
        );
      } else lines.push(new DOMRect(r.left, r.top, r.width, r.height));
    }
    if (lines.length)
      out.push(
        lines.map((l) => ({ x: l.left, y: l.top, w: l.width, h: l.height })),
      );
  }
  return out; // viewport coordinates; the caller converts to host-local
}
const toLocal = (t: Targets, host: DOMRect): Targets =>
  t.map((lines) =>
    lines.map((l) => ({
      x: l.x - host.left,
      y: l.y - host.top,
      w: l.w,
      h: l.h,
    })),
  );
const sameLayout = (a: Layout | undefined, b: Layout) =>
  !!a &&
  JSON.stringify(a, (_, v) => (typeof v === "number" ? Math.round(v) : v)) ===
    JSON.stringify(b, (_, v) => (typeof v === "number" ? Math.round(v) : v));

/** The picture rectangle inside a letterboxed (object-fit: contain) box. */
function containRect(W: number, H: number, aspect: number): Rect {
  if (!(aspect > 0) || !W || !H) return { x: 0, y: 0, w: W, h: H };
  if (W / H > aspect) {
    const w = H * aspect;
    return { x: (W - w) / 2, y: 0, w, h: H };
  }
  const h = W / aspect;
  return { x: 0, y: (H - h) / 2, w: W, h };
}

const issueKey = (i: Issue) =>
  [i.surface, i.severity, i.locate?.text ?? "", i.expected, i.found].join("|");
function toItems(issues: Issue[], status: Status = "open"): Item[] {
  const seen = new Map<string, number>();
  return issues.map((issue) => {
    const base = issueKey(issue);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n ? `${base}#${n}` : base, issue, status };
  });
}
const noteFor = (it: Item) => {
  const e = it.issue.expected;
  if (it.status === "fixed") return "matches your confirmed facts";
  if (it.issue.severity === "warn")
    return e ? `check this: ${e}` : "please check";
  if (it.issue.fix) return e ? `now ${e} — regenerate` : "regenerate";
  return e ? `should be ${e}` : "does not match";
};
const clip = (s: string, n: number) =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

/* ---------------- the SVG mark layer for one surface ---------------- */
type MarkView = {
  key: string;
  n: number;
  item: Item;
  targets: Targets;
};
function MarkLayer({
  w,
  h,
  marks,
  fs,
  active,
  highlight,
  hidden,
  busy,
  gutter = 0,
  prefer = "above",
}: {
  w: number;
  h: number;
  marks: MarkView[];
  fs: number;
  active: string | null;
  highlight?: boolean;
  hidden?: boolean;
  busy?: boolean;
  /** Width of a reserved right-hand margin; notes go there like an editor's margin notes. */
  gutter?: number;
  prefer?: "above" | "below";
}) {
  const placed: Rect[] = [];
  const cw = fs * 0.56;
  const views = marks.map((m, mi) => {
    const lineRects = m.targets.flatMap((t) => t.slice(0, 3));
    const shapes = lineRects.map((r, li) => ({
      r,
      s: drawShape(r, `${m.key}:${li}`),
    }));
    const note = clip(noteFor(m.item), 60);
    const useGutter = gutter >= 90;
    const maxChars = useGutter
      ? Math.max(9, Math.floor((gutter - 18) / cw))
      : Math.max(12, Math.min(26, Math.floor((w - 24) / cw)));
    const lines = wrapNote(note, maxChars);
    const nw = Math.max(...lines.map((l) => l.length)) * cw + 8;
    const nh = lines.length * fs * 1.02 + 4;
    const b = shapes[0].s.bounds;
    const above: { x: number; y: number }[] = [
      { x: b.x + b.w * 0.45, y: b.y - nh - 9 },
      { x: b.x + b.w * 0.55 - nw, y: b.y - nh - 9 },
    ];
    const below: { x: number; y: number }[] = [
      { x: b.x + b.w * 0.45, y: b.y + b.h + 9 },
      { x: b.x + b.w * 0.55 - nw, y: b.y + b.h + 9 },
    ];
    const cands = useGutter
      ? [
          { x: w - gutter + 12, y: shapes[0].s.cy - nh / 2 },
          { x: w - gutter + 12, y: shapes[0].s.cy - nh / 2 + nh + 6 },
          { x: w - gutter + 12, y: shapes[0].s.cy - nh / 2 - nh - 6 },
        ]
      : prefer === "below"
        ? [...below, ...above]
        : [...above, ...below];
    const fits = (c: { x: number; y: number }) =>
      c.x >= 4 &&
      c.y >= 4 &&
      c.x + nw <= w - 4 &&
      c.y + nh <= h - 4 &&
      !placed.some(
        (p) =>
          c.x < p.x + p.w + 6 &&
          c.x + nw + 6 > p.x &&
          c.y < p.y + p.h + 4 &&
          c.y + nh + 4 > p.y,
      );
    const pick = cands.find(fits) ?? cands[0];
    const nx = Math.max(4, Math.min(pick.x, Math.max(4, w - nw - 4)));
    const ny = Math.max(4, Math.min(pick.y, Math.max(4, h - nh - 4)));
    placed.push({ x: nx, y: ny, w: nw, h: nh });
    // leader: note edge -> ellipse edge, with a small arrow head
    const rnd = rngFor(m.key + ":leader");
    const side = useGutter && nx > b.x + b.w * 0.7;
    const isAbove = ny + nh / 2 < b.y + b.h / 2;
    const sx = side
      ? nx - 4
      : Math.max(nx + 6, Math.min(nx + nw * 0.3, nx + nw - 6));
    const sy = side ? ny + fs * 0.45 : isAbove ? ny + nh + 1 : ny - fs * 0.15;
    const ex = side
      ? b.x + b.w - 2
      : Math.max(b.x + b.w * 0.25, Math.min(sx + 8, b.x + b.w * 0.75));
    const ey = side ? shapes[0].s.cy : isAbove ? b.y + 2 : b.y + b.h - 2;
    const mx =
      (sx + ex) / 2 + (side ? 0 : (rnd() - 0.5) * 20 + (isAbove ? -10 : 10));
    const my = (sy + ey) / 2 + (side ? (rnd() - 0.5) * 14 : 0);
    const leader = `M${f1(sx)} ${f1(sy)} Q${f1(mx)} ${f1(my)} ${f1(ex)} ${f1(ey)}`;
    const th = Math.atan2(ey - my, ex - mx);
    const ah = (da: number) =>
      `M${f1(ex)} ${f1(ey)} l${f1(Math.cos(th + Math.PI + da) * 8)} ${f1(Math.sin(th + Math.PI + da) * 8)}`;
    const arrow = `${ah(-0.5)} ${ah(0.5)}`;
    return { m, mi, shapes, lines, nx, ny, nh, leader, arrow, badge: b };
  });
  return (
    <svg
      className={`rp-layer${hidden ? " is-hidden" : ""}${busy ? " is-busy" : ""}`}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      focusable="false"
    >
      {views.map(({ m, mi, shapes, lines, nx, ny, leader, arrow, badge }) => (
        <g
          key={m.key}
          className={`rp-mark ${m.item.status} ${m.item.issue.severity}${active === m.key ? " active" : ""}`}
          style={{ "--d": `${mi * 0.4}s` } as CSSProperties}
        >
          {shapes.map(({ r, s }, li) => (
            <g key={li}>
              {highlight && (
                <rect
                  className="rp-hl"
                  x={f1(r.x - 2)}
                  y={f1(r.y)}
                  width={f1(r.w + 4)}
                  height={f1(r.h)}
                  rx={3}
                />
              )}
              <path
                className="rp-ink rp-under rp-draw"
                d={s.ellipse}
                pathLength={1}
              />
              <path
                className="rp-ink rp-ellipse rp-draw"
                d={s.ellipse}
                pathLength={1}
              />
              {m.item.issue.severity === "block" && (
                <>
                  <path
                    className="rp-ink rp-under rp-strike rp-draw"
                    d={s.strike}
                    pathLength={1}
                  />
                  <path
                    className="rp-ink rp-strike rp-draw"
                    d={s.strike}
                    pathLength={1}
                  />
                </>
              )}
              {li === 0 && (
                <>
                  <path
                    className="rp-ink rp-under rp-tick"
                    d={s.tick}
                    pathLength={1}
                  />
                  <path className="rp-ink rp-tick" d={s.tick} pathLength={1} />
                </>
              )}
            </g>
          ))}
          <g key={m.item.status} className="rp-notegrp">
            <path className="rp-ink rp-leader" d={leader} />
            <path className="rp-ink rp-leader" d={arrow} />
            <text
              className="rp-note"
              x={f1(nx)}
              y={f1(ny + fs * 0.82)}
              fontSize={fs}
              fontFamily={NOTE_FONT}
              transform={`rotate(-2.5 ${f1(nx)} ${f1(ny)})`}
            >
              {lines.map((l, i) => (
                <tspan key={i} x={f1(nx)} dy={i === 0 ? 0 : fs * 1.02}>
                  {l}
                </tspan>
              ))}
            </text>
          </g>
          <g
            className="rp-badge"
            transform={`translate(${f1(Math.max(11, badge.x + 8))} ${f1(Math.max(11, badge.y + 6))})`}
          >
            <circle r={9} />
            <text textAnchor="middle" dy="0.35em" fontSize={11}>
              {m.n}
            </text>
          </g>
        </g>
      ))}
    </svg>
  );
}

/* ---------------- the Red Pen panel ---------------- */
type Phase = "idle" | "regenerating" | "checking";
/** Lets a sibling (the Say it bar) press "Fix with Axys" on this board. */
export type RedPenController = { fix: () => void };
export type RedPenSettle = {
  /** block-severity marks still open after the re-check */
  blocking: number;
  fixed: number;
  error?: string;
};
export type RedPenProps = {
  controller?: React.MutableRefObject<RedPenController | null>;
  onPhase?: (phase: Phase) => void;
  onSettle?: (r: RedPenSettle) => void;
  campaign: Campaign;
  state: PreflightState | undefined;
  onResult: (s: PreflightState) => void;
  /** Regenerate from confirmed facts and resolve with the settled campaign. */
  regenerate: () => Promise<Campaign>;
  /** Fixture hook: a canvas frame for the reel instead of a real video. */
  reelFrame?: (shot: number, c: Campaign) => string | undefined;
  assetUrl?: (id: string) => string;
  fixtureBadge?: boolean;
};

const reduceMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export function RedPen({
  campaign,
  state,
  onResult,
  regenerate,
  reelFrame,
  assetUrl,
  controller,
  onPhase,
  onSettle,
}: RedPenProps) {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem("axys.redpen") !== "off";
    } catch {
      return true;
    }
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [announce, setAnnounce] = useState("");
  const [settled, setSettled] = useState<Item[] | null>(null);
  const [frozen, setFrozen] = useState<Item[] | null>(null);
  const [layout, setLayout] = useState<Layout>();
  const [active, setActive] = useState<string | null>(null);
  const [shot, setShot] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [aspect, setAspect] = useState(9 / 16);
  const settledFor = useRef("");
  const lastGood = useRef<Campaign>(campaign);
  const lastGeo = useRef<Record<string, Targets>>({});
  const abort = useRef<AbortController | undefined>(undefined);
  const siteHost = useRef<HTMLDivElement>(null),
    siteScroll = useRef<HTMLDivElement>(null),
    siteRoot = useRef<HTMLDivElement>(null),
    capHost = useRef<HTMLDivElement>(null),
    capText = useRef<HTMLPreElement>(null),
    reelHost = useRef<HTMLDivElement>(null),
    video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    onPhase?.(phase);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (controller) controller.current = { fix: () => void fix() };
    return () => {
      if (controller) controller.current = null;
    };
  });

  if (campaign.site) lastGood.current = campaign;
  const shown = campaign.site ? campaign : lastGood.current;
  useEffect(() => () => abort.current?.abort(), []);

  // items currently on the board
  const current =
    state &&
    state.result.campaignId === campaign.id &&
    state.revision === campaign.revision
      ? state
      : undefined;
  useEffect(() => {
    // a preflight run outside of the fix flow starts the board afresh
    if (current && current.result.checkedAt !== settledFor.current) {
      setSettled(null);
    }
  }, [current?.result.checkedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSettled(null);
    setFrozen(null);
    setError("");
    setPhase("idle");
    settledFor.current = "";
    lastGeo.current = {};
  }, [campaign.id]);

  const fromState = useMemo(
    () => (current ? toItems(current.result.issues) : []),
    [current],
  );
  const items: Item[] =
    settled ?? (phase !== "idle" ? frozen : null) ?? fromState;
  const sig = items.map((i) => i.key + ":" + i.status).join("¦");
  const openFixable = items.filter(
    (i) => i.status === "open" && i.issue.fix?.kind === "regenerate",
  );

  // reel shot: first shot that carries an open mark
  useEffect(() => {
    const first = items.find((i) => i.issue.locate?.reel);
    setShot(first?.issue.locate?.reel?.shot ?? 0);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const frame = reelFrame?.(shot, shown);
  const shots = shown.reel?.shots ?? [];

  /* ----- geometry: find each located thing in the real DOM ----- */
  const frameRef = useRef(0);
  const compute = useCallback(() => {
    const sh = siteHost.current?.getBoundingClientRect(),
      ch = capHost.current?.getBoundingClientRect(),
      rh = reelHost.current?.getBoundingClientRect();
    const sizes: Layout["sizes"] = {
      site: { w: sh?.width ?? 0, h: sh?.height ?? 0 },
      caption: {
        w: ch?.width ?? 0,
        h: ch?.height ?? 0,
        g: capText.current
          ? parseFloat(getComputedStyle(capText.current).paddingRight) || 0
          : 0,
      },
      reel: { w: rh?.width ?? 0, h: rh?.height ?? 0 },
    };
    const geo: Layout["geo"] = {};
    for (const it of items) {
      const { issue } = it;
      const want =
        it.status === "fixed" ? issue.expected : issue.locate?.text || "";
      let t: Targets = [];
      if (issue.surface === "site" && sh && siteRoot.current && sh.width > 0)
        t = toLocal(findTextRects(siteRoot.current, want), sh);
      else if (
        issue.surface === "caption" &&
        ch &&
        capText.current &&
        ch.width > 0
      )
        t = toLocal(findTextRects(capText.current, want), ch);
      else if (issue.surface === "reel" && rh && rh.width > 0) {
        const r = issue.locate?.reel;
        if (r && r.shot === shot) {
          const c = containRect(rh.width, rh.height, aspect);
          t = [
            [
              {
                x: c.x + r.box[0] * c.w,
                y: c.y + r.box[1] * c.h,
                w: r.box[2] * c.w,
                h: r.box[3] * c.h,
              },
            ],
          ];
        }
      }
      if (t.length) lastGeo.current[it.key] = t;
      else if (it.status === "fixed" && lastGeo.current[it.key])
        t = lastGeo.current[it.key];
      geo[it.key] = t;
    }
    const next = { sizes, geo };
    setLayout((prev) => (sameLayout(prev, next) ? prev : next));
  }, [items, shot, aspect]); // eslint-disable-line react-hooks/exhaustive-deps

  const schedule = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(compute);
  }, [compute]);

  useLayoutEffect(() => {
    compute();
  }, [compute, shown.site, shown.reel, enabled, frame]);

  useEffect(() => {
    const ro = new ResizeObserver(schedule);
    for (const el of [
      siteHost.current,
      siteRoot.current,
      capHost.current,
      capText.current,
      reelHost.current,
    ])
      if (el) ro.observe(el);
    const sc = siteScroll.current;
    sc?.addEventListener("scroll", schedule, { passive: true });
    const root = siteRoot.current;
    root?.addEventListener("load", schedule, true); // images finishing layout
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    const vis = () => !document.hidden && schedule();
    document.addEventListener("visibilitychange", vis);
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      sc?.removeEventListener("scroll", schedule);
      root?.removeEventListener("load", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [schedule, items.length > 0]);

  /* ----- views per surface ----- */
  const marksFor = (surface: Surf): MarkView[] =>
    items
      .map((item, i) => ({ key: item.key, n: i + 1, item }))
      .filter((m) => m.item.issue.surface === surface)
      .map((m) => ({ ...m, targets: layout?.geo[m.key] ?? [] }))
      .filter((m) => m.targets.some((t) => t.length));
  const placedKeys = new Set(
    (["site", "reel", "caption"] as Surf[]).flatMap((s) =>
      marksFor(s).map((m) => m.key),
    ),
  );
  const placedCount = items.filter((i) => placedKeys.has(i.key)).length;

  /* ----- announcements (aria-live) ----- */
  const announced = useRef("");
  useEffect(() => {
    if (!items.length || phase !== "idle") return;
    const t = setTimeout(() => {
      const open = items.filter((i) => i.status === "open").length;
      const fixed = items.length - open;
      const key = `${sig}|${placedCount}`;
      if (announced.current === key) return;
      announced.current = key;
      const plural = (n: number) => `${n} problem${n === 1 ? "" : "s"}`;
      if (fixed > 0)
        setAnnounce(
          `${fixed} fixed.${open ? ` ${plural(open)} still ${open === 1 ? "needs" : "need"} your attention.` : " Every marked problem now matches your confirmed facts."}`,
        );
      else {
        const unplaced = items.length - placedCount;
        setAnnounce(
          `${plural(items.length)} marked.${unplaced ? ` ${unplaced} could not be placed on a preview and ${unplaced === 1 ? "is" : "are"} only in the list.` : ""} A list of the marks follows.`,
        );
      }
    }, 450);
    return () => clearTimeout(t);
  }, [sig, placedCount, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ----- first reveal: bring the first mark on the site into view ----- */
  const revealed = useRef("");
  const reveal = useCallback(
    (key: string) => {
      const it = items.find((i) => i.key === key);
      const g = layout?.geo[key]?.[0]?.[0];
      if (!it || !g) return;
      const behavior: ScrollBehavior = reduceMotion() ? "auto" : "smooth";
      if (
        it.issue.surface === "site" &&
        siteScroll.current &&
        siteHost.current
      ) {
        const sc = siteScroll.current;
        sc.scrollTo({
          top: Math.max(0, sc.scrollTop + g.y - sc.clientHeight / 2 + g.h),
          behavior,
        });
      }
      const host =
        it.issue.surface === "site"
          ? siteHost.current
          : it.issue.surface === "caption"
            ? capHost.current
            : reelHost.current;
      host?.scrollIntoView({ block: "nearest", behavior });
    },
    [items, layout],
  );
  useEffect(() => {
    if (
      !layout ||
      !items.length ||
      phase !== "idle" ||
      revealed.current === sig
    )
      return;
    if (!items.some((i) => i.issue.surface === "site")) return;
    revealed.current = sig;
    // measure fresh after the DOM settles: a regenerated site resets its scroll position
    setTimeout(() => {
      const sc = siteScroll.current,
        root = siteRoot.current;
      if (!sc || !root) return;
      for (const it of items) {
        if (it.issue.surface !== "site") continue;
        const want =
          it.status === "fixed"
            ? it.issue.expected
            : it.issue.locate?.text || "";
        const hit = findTextRects(root, want)[0]?.[0];
        if (!hit) continue;
        const top =
          sc.scrollTop +
          hit.y -
          sc.getBoundingClientRect().top -
          sc.clientHeight / 2 +
          hit.h;
        sc.scrollTo({
          top: Math.max(0, top),
          behavior: reduceMotion() ? "auto" : "smooth",
        });
        return;
      }
    }, 250);
  }, [layout, sig, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ----- Fix with Axys ----- */
  async function fix() {
    if (phase !== "idle") return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    const before = items;
    setError("");
    setSettled(null);
    setFrozen(before);
    setPhase("regenerating");
    setAnnounce(
      "Regenerating the website, reel and caption from your confirmed facts.",
    );
    try {
      const next = await regenerate();
      if (ac.signal.aborted) return;
      setPhase("checking");
      setAnnounce("Regenerated. Checking every surface again.");
      const result = await requestPreflight(next, ac.signal);
      const still = new Set(toItems(result.issues).map((i) => i.key));
      const stillOpen = toItems(result.issues);
      const resolved: Item[] = before
        .filter((b) => !still.has(b.key))
        .map((b) => ({ ...b, status: "fixed" as const }));
      const kept = stillOpen.map((o) => ({ ...o, status: "open" as const }));
      // the board keeps its original order: still-open and fixed in place, new issues last
      const order = new Map(before.map((b, i) => [b.key, i]));
      const board = [...resolved, ...kept].sort(
        (a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99),
      );
      settledFor.current = result.checkedAt;
      setSettled(board);
      onSettle?.({
        blocking: kept.filter((k) => k.issue.severity === "block").length,
        fixed: resolved.length,
      });
      onResult({ result, revision: next.revision });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      const msg = e?.message || "Fix did not finish.";
      setError(msg);
      setAnnounce(`Fix did not finish. ${msg}`);
      onSettle?.({ blocking: -1, fixed: 0, error: msg });
    } finally {
      setPhase("idle");
      setFrozen(null);
    }
  }

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    try {
      localStorage.setItem("axys.redpen", next ? "on" : "off");
    } catch {
      /* storage unavailable */
    }
    setAnnounce(
      next
        ? "Red pen on."
        : "Red pen off. The list below still shows every problem.",
    );
  }

  /* ----- reel ----- */
  const starts = useMemo(() => {
    let t = 0;
    return shots.map((s) => {
      const at = t;
      t += s.duration;
      return at;
    });
  }, [shots]);
  // film layout (campaign trace `generation.reelLayout`): shot k starts at k * 10 s and the facts end card shows from 8 s
  const film = usesFilmLayout(shown);
  function pickShot(i: number) {
    setShot(i);
    const v = video.current;
    const at = shotSeek(film, i, starts[i]);
    if (v && at !== undefined && Number.isFinite(at)) {
      try {
        v.pause();
        v.currentTime = at;
      } catch {
        /* metadata not loaded yet */
      }
    }
  }

  // Film reels: park the video on the facts end card of the marked shot so the marks sit on the text they point at.
  const markedReel = items.some(
    (i) => i.issue.surface === "reel" && i.issue.locate?.reel,
  );
  function parkOnFacts() {
    const v = video.current;
    if (!v || !film || !markedReel || v.readyState < 1) return;
    try {
      v.pause();
      v.currentTime = shotSeek(film, shot, undefined) ?? 0;
    } catch {
      /* not seekable yet */
    }
  }
  useEffect(parkOnFacts, [film, markedReel, shot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autoplay a muted loop when visible, except while marks sit on the reel (they hide during playback).
  useAutoplayInView(
    video,
    !(
      enabled &&
      items.some((i) => i.issue.surface === "reel" && i.issue.locate?.reel)
    ),
    shown.videoAssetId,
  );

  if (!items.length && !error && phase === "idle") return null;

  const sz = layout?.sizes;
  const busy = phase !== "idle";
  const open = items.filter((i) => i.status === "open");
  const fixedN = items.length - open.length;
  const layer = (
    s: Surf,
    fs: number,
    extra: Partial<React.ComponentProps<typeof MarkLayer>> = {},
  ) =>
    enabled && sz && sz[s].w > 0 ? (
      <MarkLayer
        w={Math.round(sz[s].w)}
        h={Math.round(sz[s].h)}
        marks={marksFor(s)}
        fs={fs}
        active={active}
        busy={busy}
        {...extra}
      />
    ) : null;
  const au =
    assetUrl ?? ((id: string) => `/api/v1/assets/${encodeURIComponent(id)}`);
  const showReelMarks = items.some(
    (i) => i.issue.surface === "reel" && i.issue.locate?.reel,
  );

  return (
    <section className="panel redpen" id="redpen" aria-labelledby="rp-h">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">RED PEN</p>
          <h2 id="rp-h">
            {fixedN && !open.length
              ? "Every mark is fixed"
              : "Marked on your real pages"}
          </h2>
        </div>
        <div className="rp-actions">
          <button
            type="button"
            className="secondary"
            aria-pressed={enabled}
            onClick={toggle}
          >
            Red pen: {enabled ? "on" : "off"}
          </button>
          {(openFixable.length > 0 || busy) && (
            <button
              type="button"
              className="rp-fix"
              onClick={() => void fix()}
              disabled={busy}
              aria-describedby="rp-fix-help"
            >
              {phase === "regenerating"
                ? "Regenerating…"
                : phase === "checking"
                  ? "Re-checking…"
                  : "Fix with Axys"}
            </button>
          )}
        </div>
      </div>
      <FixtureBadge />
      <p className="muted rp-help" id="rp-fix-help">
        {busy
          ? phase === "regenerating"
            ? "Regenerating the website, reel and caption from your confirmed facts. The marks stay on the old version until the new one is ready."
            : "Checking every surface against your confirmed facts again."
          : openFixable.length
            ? "Axys regenerates all three artifacts from your confirmed facts, runs preflight again, and turns each mark green where it now matches."
            : open.length
              ? "These marks have no automatic fix. Review the wording and edit your facts or notes."
              : "Preflight found nothing blocking. Approval is available."}
      </p>
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <div className="rp-grid">
        <figure className="rp-fig rp-fig-site">
          <figcaption>Website preview</figcaption>
          <div className="rp-host" ref={siteHost}>
            <div
              className="rp-scroll"
              ref={siteScroll}
              tabIndex={0}
              role="region"
              aria-label="Website preview, scrollable. Red pen marks are listed below."
            >
              <div className="rp-site" ref={siteRoot} inert>
                {shown.site && <Site spec={shown.site} assetUrl={au} />}
              </div>
            </div>
            {layer("site", 22)}
          </div>
        </figure>

        <div className="rp-side">
          <figure className="rp-fig rp-fig-reel">
            <figcaption>
              Reel
              {shots.length > 1 ? `, shot ${shot + 1} of ${shots.length}` : ""}
            </figcaption>
            <div className="rp-host rp-dark" ref={reelHost}>
              <div className="rp-reel-stage">
                {frame ? (
                  <img
                    className="rp-reel-media"
                    src={frame}
                    alt={`Reel frame, shot ${shot + 1}`}
                  />
                ) : shown.videoAssetId ? (
                  <video
                    ref={video}
                    className="rp-reel-media"
                    controls
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    poster={
                      shown.videoPosterId
                        ? `/api/v1/assets/${shown.videoPosterId}`
                        : undefined
                    }
                    src={`/api/v1/assets/${shown.videoAssetId}`}
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      if (v.videoWidth && v.videoHeight)
                        setAspect(v.videoWidth / v.videoHeight);
                      parkOnFacts();
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                    aria-label="Final reel"
                  />
                ) : (
                  <p className="rp-noreel">No encoded reel to mark yet.</p>
                )}
              </div>
              {layer("reel", 19, { hidden: playing, prefer: "below" })}
            </div>
            {shots.length > 1 && (
              <div
                className="rp-shots"
                role="group"
                aria-label="Choose a reel shot"
              >
                {shots.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    className={shot === i ? "selected" : "secondary"}
                    aria-pressed={shot === i}
                    onClick={() => pickShot(i)}
                  >
                    Shot {i + 1}
                  </button>
                ))}
              </div>
            )}
            {playing && showReelMarks && (
              <p className="muted rp-small">
                Marks are hidden while the reel plays.
              </p>
            )}
          </figure>
        </div>
      </div>
      <figure className="rp-fig rp-fig-caption">
        <figcaption>Caption</figcaption>
        <div className="rp-host rp-cap" ref={capHost}>
          <pre className="rp-caption" ref={capText}>
            {shown.reel?.caption}
          </pre>
          {layer("caption", 22, {
            highlight: true,
            gutter: layout?.sizes.caption.g,
          })}
        </div>
      </figure>

      <h3 className="rp-list-h" id="rp-list-h">
        {open.length
          ? `${open.length} mark${open.length === 1 ? "" : "s"} to resolve`
          : "All marks resolved"}
        {fixedN > 0 && (
          <span className="rp-fixed-count"> · {fixedN} fixed</span>
        )}
      </h3>
      <ol className="rp-list" aria-labelledby="rp-list-h">
        {items.map((it, i) => {
          const ok = it.status === "fixed";
          const placed = placedKeys.has(it.key);
          return (
            <li
              key={it.key}
              className={`rp-li ${it.status} ${it.issue.severity}`}
            >
              <button
                type="button"
                className="rp-item"
                aria-current={active === it.key ? "true" : undefined}
                onMouseEnter={() => setActive(it.key)}
                onMouseLeave={() => setActive((a) => (a === it.key ? null : a))}
                onFocus={() => {
                  setActive(it.key);
                  reveal(it.key);
                }}
                onBlur={() => setActive((a) => (a === it.key ? null : a))}
                onClick={() => reveal(it.key)}
              >
                <span className="rp-num" aria-hidden="true">
                  {ok ? "✓" : i + 1}
                </span>
                <span className="rp-body">
                  <span className="rp-meta">
                    <span className="surface-chip">
                      {SURFACE_LABEL[it.issue.surface]}
                    </span>
                    <span
                      className={`rp-state ${ok ? "ok" : it.issue.severity}`}
                    >
                      {ok
                        ? "Fixed: matches your confirmed facts"
                        : it.issue.severity === "block"
                          ? "Must fix"
                          : "Review"}
                    </span>
                  </span>
                  <span className="rp-text">{it.issue.text}</span>
                  {(it.issue.expected || it.issue.found) && (
                    <span className="rp-diff">
                      {it.issue.found && !ok && (
                        <>
                          Found <s>{it.issue.found}</s>.{" "}
                        </>
                      )}
                      {it.issue.expected && <>Expected {it.issue.expected}.</>}
                    </span>
                  )}
                  <span className="rp-where">
                    {placed && enabled
                      ? `Marked on the ${SURFACE_LABEL[it.issue.surface].toLowerCase()}${it.issue.surface === "reel" && it.issue.locate?.reel ? ` (shot ${it.issue.locate.reel.shot + 1})` : ""}. Press to show it.`
                      : !enabled
                        ? "Red pen is off."
                        : it.issue.locate
                          ? it.issue.surface === "reel" &&
                            it.issue.locate.reel &&
                            it.issue.locate.reel.shot !== shot
                            ? `On reel shot ${it.issue.locate.reel.shot + 1}. Choose that shot to see the mark.`
                            : "Could not be placed on the preview."
                          : it.issue.surface === "narration"
                            ? "Spoken in the reel audio, so there is no frame to mark; listed only."
                            : "No position available; listed only."}
                    {it.issue.fix && !ok && ` Fix: ${it.issue.fix.label}.`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ================================================================== *
 * Staged scenario: ?fixture=meta&scenario=stale (no backend needed).
 * ================================================================== */
function staleCampaign(revision: 1 | 2): Campaign {
  const confirmed = [
    {
      id: "p1",
      name: "Weekend brownie box",
      priceMinor: 14900,
      currency: "USD" as const,
      assetId: "fixture:orig:0:0",
    },
    {
      id: "p2",
      name: "Salted caramel tin",
      priceMinor: 8900,
      currency: "USD" as const,
      assetId: "fixture:orig:1:0",
    },
  ];
  const facts = {
    business: "Bake & Co",
    offer: "Weekend brownie box",
    collection: "Saturday after 4 pm",
    contact: "https://example.com/order",
    products: confirmed,
    confirmed: true as const,
    source: "merchant" as const,
  };
  // revision 1: artifacts were generated, then the price was edited to 149.00 without regenerating.
  const artifactFacts =
    revision === 1
      ? {
          ...facts,
          products: [{ ...confirmed[0], priceMinor: 12900 }, confirmed[1]],
        }
      : facts;
  const money = (p: { currency: string; priceMinor: number }) =>
    formatMoney(p.currency, p.priceMinor);
  return {
    id: STALE_ID,
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
      headline: "Best in the city: the weekend brownie box",
    },
    reel: {
      schemaVersion: 1,
      facts: artifactFacts,
      style: "warm",
      shots: [
        {
          productId: "p1",
          duration: 4,
          text: money(artifactFacts.products[0]),
        },
        { productId: "p2", duration: 4, text: facts.collection },
      ],
      caption: `${facts.business}\n${facts.offer}\n${artifactFacts.products.map((p) => `${p.name} — ${money(p)}`).join("\n")}\n${facts.collection}\n${facts.contact}`,
    },
  };
}

export function RedPenDemo() {
  const [c, setC] = useState<Campaign>(() => staleCampaign(1));
  const [pf, setPf] = useState<PreflightState>();
  const [round, setRound] = useState(0);
  const blocked = blockCount(pf, c) > 0;
  const regenerate = async () => {
    setC((x) => ({
      ...x,
      state: "Generating",
      site: undefined,
      reel: undefined,
    }));
    await sleepMs(2200);
    const next = staleCampaign(2);
    setC(next);
    return next;
  };
  const frame = (shot: number, camp: Campaign) => {
    const p = camp.reel?.facts.products[0];
    if (!p) return undefined;
    return fixtureReelFrame(
      shot,
      p.name,
      formatMoney(p.currency, p.priceMinor),
      camp.facts.collection,
    ).src;
  };
  return (
    <div className="rp-demo">
      <header className="rp-demo-head">
        <div className="wordmark">
          axys<span>●</span>
        </div>
        <div>
          <p className="eyebrow">PUBLISH · STAGED SCENARIO</p>
          <h1>The price changed after generation</h1>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setC(staleCampaign(1));
            setPf(undefined);
            setRound((n) => n + 1);
          }}
        >
          Restart scenario
        </button>
      </header>
      <FixtureBadge />
      <p className="muted rp-demo-note">
        Scenario: the merchant changed the price to $149.00 after the
        website, reel and caption were generated at $129.00. Preflight finds
        it on all three, and the red pen marks it where it sits. Every number
        and frame on this page is fixture data staged in the browser.
      </p>
      <PreflightPanel
        key={`pf${round}`}
        campaign={c}
        state={pf}
        onResult={setPf}
        autoRun
      />
      <RedPen
        key={`rp${round}`}
        campaign={c}
        state={pf}
        onResult={setPf}
        regenerate={regenerate}
        reelFrame={frame}
        assetUrl={(id) => assetSrc(id) || ""}
      />
      <section className="panel">
        <h2>Approve this exact version</h2>
        {blocked && (
          <p className="approve-block" id="rp-demo-block">
            Approval is disabled: preflight found {blockCount(pf, c)} blocking
            issue
            {blockCount(pf, c) > 1 ? "s" : ""}. Fix the facts or outputs, then
            re-run preflight above.
          </p>
        )}
        <button
          type="button"
          aria-disabled={blocked || !pf || undefined}
          aria-describedby={blocked ? "rp-demo-block" : undefined}
          onClick={() => {}}
        >
          I approve this version (fixture: nothing is sent)
        </button>
      </section>
    </div>
  );
}
