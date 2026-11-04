import React, { useEffect, useRef, useState } from "react";

/* Small shared pieces for the landing page and The Bench (worker A). */

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** True once the element has been (or, with `once` false, currently is) visible. */
export function useInView<T extends Element>(
  once = true,
  rootMargin = "0px 0px -8% 0px",
  threshold = 0.12,
) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          if (once) io.disconnect();
        } else if (!once) setSeen(false);
      },
      { rootMargin, threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once, rootMargin, threshold]);
  return [ref, seen] as const;
}

/** Scroll reveal wrapper. */
export function Reveal({
  as: Tag = "div",
  delay = 0,
  className = "",
  children,
  ...rest
}: {
  as?: any;
  delay?: number;
  className?: string;
  children?: React.ReactNode;
  [k: string]: any;
}) {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <Tag
      ref={ref}
      className={`rv${seen ? " in" : ""} ${className}`.trim()}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Counts up once, the first time it scrolls into view. */
export function Count({
  to,
  decimals = 0,
  duration = 1400,
  prefix = "",
  suffix = "",
}: {
  to: number;
  decimals?: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
}) {
  const reduced = useReducedMotion();
  const [ref, seen] = useInView<HTMLSpanElement>(true, "0px", 0.4);
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!seen) return;
    if (reduced) {
      setV(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setV(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, reduced, to, duration]);
  const fmt = (n: number) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  return (
    <span ref={ref} className="count">
      <span aria-hidden="true">
        {prefix}
        {fmt(v)}
        {suffix}
      </span>
      <span className="sr">
        {prefix}
        {fmt(to)}
        {suffix}
      </span>
    </span>
  );
}

export type Provenance =
  | "live engine"
  | "recorded run"
  | "measured offline"
  | "recorded sample"
  | "recorded live run";
export function Tag({ kind, title }: { kind: Provenance; title?: string }) {
  const cls = kind.replace(/\s+/g, "-");
  return (
    <span className={`tag tag-${cls}`} title={title}>
      <i aria-hidden="true" />
      {kind}
    </span>
  );
}

const PATHS: Record<string, string> = {
  arrow: "M5 12h14M12 5l7 7-7 7",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  play: "M6 3l14 9-14 9z",
  zap: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  alert:
    "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  bulb: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  layers: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  game: "M6 12h4M8 10v4M15 13h.01M18 11h.01M17.3 5H6.7a4 4 0 0 0-3.9 3.2l-1.6 8A3 3 0 0 0 6 19l2.5-2.5h7L18 19a3 3 0 0 0 4.8-2.8l-1.6-8A4 4 0 0 0 17.3 5z",
  scissors:
    "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12",
  film: "M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  eye: "M2 12s4-8 10-8 10 8 10 8-4 8-10 8S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  refresh:
    "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5",
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  box: "M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",
  menu: "M4 7h16M4 12h16M4 17h16",
  sun: "M12 3v2M12 19v2M5 12H3M21 12h-2M6 6 4.6 4.6M19.4 19.4 18 18M18 6l1.4-1.4M4.6 19.4 6 18M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  chart: "M3 3v18h18M7 15l4-5 3 3 5-7",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  hand: "M8 13V5a2 2 0 0 1 4 0v6M12 11V4a2 2 0 0 1 4 0v8M16 12V7a2 2 0 0 1 4 0v8a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.5L3 14a2 2 0 0 1 3.4-2L8 14",
  palette:
    "M12 22a10 10 0 1 1 10-10c0 3-2 4-4 4h-2a2 2 0 0 0-1.4 3.4c.9.9.4 2.6-2.6 2.6zM7.5 11h.01M10 7h.01M15 7h.01M17.5 11h.01",
};
export function Icon({
  name,
  size = 18,
  className,
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={`ico${className ? " " + className : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

export function SectionHead({
  icon,
  kicker,
  children,
  sub,
  id,
}: {
  icon: string;
  kicker: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
  id?: string;
}) {
  return (
    <Reveal className="sec-head">
      <span className="lp-pill">
        <Icon name={icon} size={14} />
        {kicker}
      </span>
      <h2 id={id}>{children}</h2>
      {sub ? <p className="sub">{sub}</p> : null}
    </Reveal>
  );
}
