import React, { useCallback, useEffect, useRef, useState } from "react";
import "./landing.css";
import {
  Count,
  Icon,
  Reveal,
  SectionHead,
  Tag,
  useInView,
  useReducedMotion,
} from "./landing-kit";
import { Bench } from "./bench";

const STUDIO = "/?studio=1";
const L = "/landing/";

const SECTIONS = [
  { id: "top", label: "Overview", icon: "zap" },
  { id: "problem", label: "The problem", icon: "alert" },
  { id: "meet", label: "Meet Axys", icon: "bulb" },
  { id: "cutout", label: "Cutouts", icon: "scissors" },
  { id: "capabilities", label: "Capabilities", icon: "grid" },
  { id: "pipeline", label: "Pipeline", icon: "layers" },
  { id: "bench", label: "The Bench", icon: "game" },
  { id: "how", label: "How it works", icon: "list" },
  { id: "stack", label: "Architecture", icon: "box" },
  { id: "real", label: "What is real", icon: "shield" },
];

function useActiveSection() {
  const [active, setActive] = useState("top");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return active;
}

function Logo() {
  return (
    <a className="brand" href="/" aria-label="Axys home">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="lpg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff6a2b" />
            <stop offset="1" stopColor="#7f8cff" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill="url(#lpg)" />
        <path
          d="M9 22 16 9l7 13M11.6 17.5h8.8"
          fill="none"
          stroke="#0b0c0b"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>Axys</span>
    </a>
  );
}

function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const links = [
    ["meet", "Product"],
    ["cutout", "Cutouts"],
    ["pipeline", "Pipeline"],
    ["bench", "The Bench"],
    ["how", "How it works"],
    ["real", "Proof"],
  ];
  return (
    <header className={`nav${scrolled ? " scrolled" : ""}`}>
      <div className="nav-in wrap">
        <Logo />
        <nav className="nav-links" aria-label="Main">
          {links.map(([id, t]) => (
            <a key={id} href={`#${id}`}>
              {t}
            </a>
          ))}
        </nav>
        <div className="nav-end">
          <a className="btn btn-primary btn-sm" href={STUDIO}>
            Open Studio <Icon name="arrow" size={15} />
          </a>
          <button
            type="button"
            className="icon-btn nav-menu"
            aria-expanded={open}
            aria-controls="lp-mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? "x" : "menu"} />
          </button>
        </div>
      </div>
      <nav
        id="lp-mobile-nav"
        className={`nav-sheet${open ? " open" : ""}`}
        aria-label="Sections"
        hidden={!open}
      >
        {links.map(([id, t]) => (
          <a key={id} href={`#${id}`} onClick={() => setOpen(false)}>
            {t}
          </a>
        ))}
      </nav>
    </header>
  );
}

function DotNav({ active }: { active: string }) {
  return (
    <nav className="dots" aria-label="Page sections">
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={active === s.id ? "true" : undefined}
          className={active === s.id ? "on" : ""}
        >
          <Icon name={s.icon} size={16} />
          <span className="dot-label">{s.label}</span>
        </a>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ hero */

const REELS = [
  { id: "mug", label: "Mug", frame: "Hero float on a Muse Image backdrop" },
  { id: "sneaker", label: "Sneaker", frame: "Whip pan, macro, kinetic type" },
  { id: "cake", label: "Cake", frame: "Cutout with its raspberries" },
] as const;

function ReelCard() {
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [wrap, inView] = useInView<HTMLDivElement>(false, "0px", 0.25);
  const vid = useRef<HTMLVideoElement>(null);
  const r = REELS[i];
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    if (inView && !reduced) v.play().catch(() => undefined);
    else v.pause();
  }, [inView, reduced, i]);
  return (
    <div className="card reel-card" ref={wrap}>
      <div className="card-bar">
        <span className="dots3" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="mono">reel.mp4</span>
        <Tag kind="recorded run" title="FFmpeg render of a live Muse run, 4 Nov 2026" />
      </div>
      <div className="reel-frame">
        <video
          key={r.id}
          ref={vid}
          muted
          playsInline
          preload="none"
          poster={`${L}reel-${r.id}.webp`}
          aria-label={`${r.label} reel rendered by Axys: ${r.frame}`}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setI((n) => (n + 1) % REELS.length)}
          onLoadedData={() => (reduced ? undefined : vid.current?.play().catch(() => undefined))}
        >
          <source src={`${L}reel-${r.id}.mp4`} type="video/mp4" />
        </video>
        {reduced && !playing ? (
          <button
            type="button"
            className="reel-play"
            aria-label={`Play the ${r.label} reel`}
            onClick={() => vid.current?.play()}
          >
            <Icon name="play" size={22} />
          </button>
        ) : null}
      </div>
      <div className="reel-tabs" role="group" aria-label="Choose a reel">
        {REELS.map((x, n) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={n === i}
            className={n === i ? "on" : ""}
            onClick={() => setI(n)}
          >
            {x.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PreflightCard() {
  return (
    <div className="card pf-card">
      <p className="lp-eb">PREFLIGHT · exact rules</p>
      <p className="pf-title">Mug price after “make it 199”</p>
      <div className="chips" aria-label="Result per surface">
        <span className="chip bad">
          <Icon name="x" size={12} /> Site
        </span>
        <span className="chip bad">
          <Icon name="x" size={12} /> Reel
        </span>
        <span className="chip bad">
          <Icon name="x" size={12} /> Caption
        </span>
      </div>
      <p className="pf-line">
        Expected <b>INR 199.00</b>, found <s>INR 129.00</s> on all three. Approval is blocked.
      </p>
      <Tag kind="recorded live run" />
    </div>
  );
}

function RedPenCard() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <div className={`card rp-card${seen ? " drawn" : ""}`} ref={ref}>
      <p className="lp-eb">RED PEN · marked on the real page</p>
      <div className="lp-rp-body">
        <span className="rp-name">ceramic mug</span>
        <span className="rp-price">
          INR 129.00
          <svg viewBox="0 0 150 46" aria-hidden="true" className="rp-ring">
            <ellipse cx="75" cy="23" rx="70" ry="19" pathLength="1" />
          </svg>
          <svg viewBox="0 0 120 8" aria-hidden="true" className="lp-rp-strike">
            <path d="M2 4 Q30 1 60 4 T118 4" pathLength="1" />
          </svg>
        </span>
        <span className="lp-rp-note">now INR 199.00 — regenerate</span>
      </div>
      <Tag kind="recorded live run" />
    </div>
  );
}

function useDemoAvailable() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/demo.mp4", { method: "HEAD" })
      .then((r) => {
        const t = r.headers.get("content-type") ?? "";
        if (alive && r.ok && t.startsWith("video/")) setOk(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}

function DemoModal({ onClose }: { onClose: () => void }) {
  const d = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = d.current;
    if (el && !el.open) el.showModal();
  }, []);
  const close = () => {
    d.current?.querySelector("video")?.pause();
    d.current?.close();
    onClose();
  };
  return (
    <dialog
      ref={d}
      className="lp-dialog"
      aria-label="Axys demo video"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === d.current) close();
      }}
    >
      <div className="dlg-in">
        <button type="button" className="icon-btn dlg-x" onClick={close} aria-label="Close the demo">
          <Icon name="x" />
        </button>
        <video controls autoPlay playsInline preload="metadata" src="/demo.mp4" />
      </div>
    </dialog>
  );
}

function Hero() {
  const demo = useDemoAvailable();
  const [show, setShow] = useState(false);
  return (
    <section id="top" className="hero" aria-labelledby="h-hero">
      <div className="hero-bg" aria-hidden="true" />
      <div className="wrap hero-grid">
        <div className="lp-hero-copy">
          <span className="lp-pill lp-pill-or">
            <Icon name="zap" size={14} /> Muse models + deterministic checks
          </span>
          <h1 id="h-hero">
            Make the reel.
            <br />
            <span className="grad">Prove the price.</span>
          </h1>
          <p className="lede">
            Axys turns a product photo and one sentence into a website, a reel and a caption for a
            small business, then checks every price, date and link against what you confirmed
            before anything can be approved.
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href={STUDIO}>
              Open Studio <Icon name="arrow" size={16} />
            </a>
            {demo ? (
              <button type="button" className="btn btn-ghost" onClick={() => setShow(true)}>
                <Icon name="play" size={14} /> Watch the demo
              </button>
            ) : (
              <a className="btn btn-ghost" href="#meet">
                <Icon name="play" size={14} /> See a recorded session
              </a>
            )}
          </div>
          <ul className="hero-stats" aria-label="Headline numbers">
            <li>
              <b>
                <Count to={312} />
                <small>/312</small>
              </b>
              <span>drifted artifacts caught</span>
              <Tag kind="measured offline" />
            </li>
            <li>
              <b>
                <Count to={0} />
                <small>/1,111</small>
              </b>
              <span>false alarms on benign variants</span>
              <Tag kind="measured offline" />
            </li>
            <li>
              <b>
                <Count to={7} />
                <small>/7</small>
              </b>
              <span>unsupported claims flagged</span>
              <Tag kind="recorded live run" />
            </li>
          </ul>
        </div>
        <div className="hero-stage">
          <div className="fl fl-a">
            <ReelCard />
          </div>
          <div className="fl fl-b">
            <PreflightCard />
          </div>
          <div className="fl fl-c">
            <RedPenCard />
          </div>
        </div>
      </div>
      <a href="#problem" className="scroll-hint">
        <span className="mouse" aria-hidden="true" />
        Scroll to explore
      </a>
      {show ? <DemoModal onClose={() => setShow(false)} /> : null}
    </section>
  );
}

/* --------------------------------------------------------------- problem */

function Problem() {
  const stats = [
    {
      n: 312,
      d: "/312",
      title: "Drifted artifacts caught",
      body: "Site 120, reel 72 and caption 120 mutated texts, every one flagged by code.",
      tag: "measured offline" as const,
      tone: "red",
      icon: "x",
    },
    {
      n: 114,
      d: "/114",
      title: "Post-generation edits blocked",
      body: "Facts edited after generation, so artifacts are stale. Approval refused all of them.",
      tag: "measured offline" as const,
      tone: "amber",
      icon: "lock",
    },
    {
      n: 0,
      d: "/1,111",
      title: "False alarms on benign variants",
      body: "Rs, ₹, grouping, case, dashes, date formats, :443. Also 0/24 on untouched controls.",
      tag: "measured offline" as const,
      tone: "green",
      icon: "check",
    },
    {
      n: 7,
      d: "/7",
      title: "Unsupported claims flagged",
      body: "Live Muse Wonder caught organic, free delivery, 50% off and four more. 0/3 false warnings on controls (small sample).",
      tag: "recorded live run" as const,
      tone: "violet",
      icon: "eye",
    },
  ];
  return (
    <section id="problem" className="sec" aria-labelledby="h-problem">
      <div className="wrap">
        <SectionHead
          id="h-problem"
          icon="alert"
          kicker="The problem"
          sub="A site, a reel and a caption are written at different times. Change one fact and the others go quietly stale. These are the numbers from our own mutation eval of 1,657 cases."
        >
          A price is only right <span className="grad">everywhere.</span>
        </SectionHead>
        <div className="stat-grid">
          {stats.map((s, i) => (
            <Reveal key={s.title} delay={i * 70} className={`card stat tone-${s.tone}`}>
              <span className="stat-ico">
                <Icon name={s.icon} size={18} />
              </span>
              <div className="stat-n">
                <Count to={s.n} />
                <small>{s.d}</small>
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <Tag kind={s.tag} />
            </Reveal>
          ))}
        </div>
        <Reveal as="p" className="fine">
          Known misses, measured and not fixed: an extended value (“… Pvt Ltd”) and one stale
          occurrence among two are not detected, because the rule is “contains the confirmed
          value”. The 1,657 cases come from 12 generated campaigns, so the intervals are optimistic.
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- replay */

const COMMAND = "make the mug one ninety nine rupees";
const REPLAY_STEPS = ["Say it", "Diff", "Red Pen", "Fix"];
const SURFACES = [
  { id: "site", name: "Website", line: "ceramic mug", icon: "grid" },
  { id: "reel", name: "Reel, shot 1", line: "ceramic mug", icon: "film" },
  { id: "caption", name: "Caption", line: "ceramic mug —", icon: "chat" },
];

function Replay() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(-1);
  const [typed, setTyped] = useState(0);
  const [running, setRunning] = useState(false);
  const timers = useRef<number[]>([]);
  const clear = () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clear, []);
  const reset = useCallback(() => {
    clear();
    setStep(-1);
    setTyped(0);
    setRunning(false);
  }, []);
  const play = useCallback(() => {
    clear();
    setStep(0);
    setTyped(reduced ? COMMAND.length : 0);
    setRunning(true);
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    if (!reduced)
      for (let k = 1; k <= COMMAND.length; k++) at(120 + k * 42, () => setTyped(k));
    const t = reduced ? 900 : 1;
    at(2100 * t, () => setStep(1));
    at(4300 * t, () => setStep(2));
    at(7300 * t, () => setStep(3));
    at(9700 * t, () => {
      setStep(4);
      setRunning(false);
    });
  }, [reduced]);
  const say = [
    "Replay ready.",
    "You said: make the mug one ninety nine rupees.",
    "Muse Wonder parsed it: mug price from INR 149.00 to INR 199.00. Nothing applied yet.",
    "Applied. Preflight blocks the site, the reel and the caption: expected INR 199.00, found INR 129.00.",
    "Fix with Axys is regenerating all three from the confirmed facts.",
    "Preflight is clear. Every mark is green.",
  ][step + 1];
  const marked = step >= 2 && step < 4;
  const fixed = step >= 4;
  return (
    <Reveal className="replay card glass" aria-label="Recorded session replay">
      <div className="card-bar">
        <span className="dots3" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="mono">Axys · Say it → Red Pen → Fix</span>
        <Tag kind="recorded live run" />
        <span className="grow" />
        <button type="button" className="btn btn-primary btn-sm" onClick={play} disabled={running}>
          <Icon name={step >= 4 ? "refresh" : "play"} size={13} />
          {running ? "Playing" : step >= 4 ? "Replay" : "Play"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={reset} disabled={step < 0}>
          Reset
        </button>
      </div>
      <ol className="rp-steps" aria-label="Replay progress">
        {REPLAY_STEPS.map((s, i) => (
          <li key={s} className={step > i ? "done" : step === i ? "now" : ""}>
            <span>{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <div className="replay-body">
        <div className="log" aria-hidden={step < 0 ? undefined : undefined}>
          {step < 0 ? (
            <div className="idle">
              <Icon name="play" size={26} />
              <p>Press Play to replay a recorded “Say it” session.</p>
            </div>
          ) : null}
          {step >= 0 ? (
            <div className="bubble you">
              <span className="who">
                <Icon name="mic" size={13} /> You said
              </span>
              <p>
                “{COMMAND.slice(0, typed)}
                {typed < COMMAND.length ? <span className="caret" /> : null}”
              </p>
            </div>
          ) : null}
          {step >= 1 ? (
            <div className="bubble ax">
              <span className="who">Muse Wonder · parsed, not applied</span>
              <div className="diff">
                <span>Mug price</span>
                <s>INR 149.00</s>
                <Icon name="arrow" size={14} />
                <b>INR 199.00</b>
              </div>
              <p className="quote">
                heard as <em>“one ninety nine rupees”</em>
                {step >= 2 ? <span className="applied"><Icon name="check" size={12} /> Applied</span> : null}
              </p>
            </div>
          ) : null}
          {step >= 2 ? (
            <div className="bubble ax warn">
              <span className="who">Preflight · exact rules</span>
              <ul>
                {["site", "reel", "caption"].map((s) => (
                  <li key={s}>
                    <span className={`lp-sev${fixed ? " ok" : ""}`}>{fixed ? "clear" : "block"}</span>
                    {s}: expected INR 199.00, found {fixed ? "INR 199.00" : "INR 129.00"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {step >= 3 ? (
            <div className="bubble ax ok">
              <span className="who">Fix with Axys</span>
              <p>
                {fixed
                  ? "Regenerated from the confirmed facts. Preflight: 0 issues."
                  : "Regenerating site, reel and caption…"}
              </p>
              {!fixed ? <span className="bar" aria-hidden="true"><i /></span> : null}
            </div>
          ) : null}
        </div>
        <div className="surfaces">
          <p className="lp-eb">SURFACES · generated when the price was INR 129.00</p>
          {SURFACES.map((s) => (
            <div key={s.id} className={`surf${marked ? " marked" : ""}${fixed ? " fixed" : ""}`}>
              <span className="surf-name">
                <Icon name={s.icon} size={14} /> {s.name}
              </span>
              <span className="surf-line">
                {s.line}
                <span className="price">
                  {fixed ? "INR 199.00" : "INR 129.00"}
                  {marked ? (
                    <svg viewBox="0 0 120 34" aria-hidden="true" className="ring">
                      <ellipse cx="60" cy="17" rx="56" ry="13" pathLength="1" />
                    </svg>
                  ) : null}
                </span>
                {fixed ? <Icon name="check" size={15} className="tick" /> : null}
              </span>
              {marked ? <span className="hand">now INR 199.00 — regenerate</span> : null}
            </div>
          ))}
          <p className="surf-foot">
            {marked
              ? "The reel mark lands on the price pill, derived from the renderer's own layout maths."
              : fixed
                ? "All three regenerated; every mark is green."
                : "Three artifacts, one fact."}
          </p>
        </div>
      </div>
      <div className="sr" aria-live="polite" role="status">
        {say}
      </div>
      <p className="replay-note">
        Assembled from two recorded live runs on 4 Nov 2026 (the Say it parse and the Red Pen fix;
        the surfaces show the older INR 129.00 because the price had already been edited once).
        Timings are compressed for reading. Source: docs/META_NEW.md.
      </p>
    </Reveal>
  );
}

function Meet() {
  return (
    <section id="meet" className="sec" aria-labelledby="h-meet">
      <div className="wrap">
        <SectionHead
          id="h-meet"
          icon="bulb"
          kicker="The solution"
          sub="Say a change in plain words. Models propose, code verifies, and every stale surface is marked like an editor's red pen."
        >
          Meet <span className="grad">Axys</span>
        </SectionHead>
        <Reveal className="chips center">
          <span className="chip">Website</span>
          <span className="chip">Reel</span>
          <span className="chip">Caption</span>
        </Reveal>
        <Replay />
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- slider */

function BeforeAfter() {
  const [pos, setPos] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const from = (x: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPos(Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") setPos((p) => Math.max(0, p - step));
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") setPos((p) => Math.min(100, p + step));
    else if (e.key === "Home") setPos(0);
    else if (e.key === "End") setPos(100);
    else return;
    e.preventDefault();
  };
  return (
    <div className="ba">
      <div
        ref={box}
        className="ba-stage"
        onPointerDown={(e) => {
          drag.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          from(e.clientX);
        }}
        onPointerMove={(e) => drag.current && from(e.clientX)}
        onPointerUp={() => (drag.current = false)}
        onPointerCancel={() => (drag.current = false)}
      >
        <img src={`${L}cake-mask-with-parts.webp`} alt="SAM mask over the cake and its raspberries" width="640" height="426" loading="lazy" draggable={false} />
        <img
          className="ba-top"
          src={`${L}cake-mask-cake-only.webp`}
          alt="SAM mask over the cake only, raspberries left out"
          width="640"
          height="426"
          loading="lazy"
          draggable={false}
          style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        />
        <span className="ba-l">Cake only · 19% of the frame</span>
        <span className="ba-r">Cake + raspberries · 28%</span>
        <div className="ba-line" style={{ left: `${pos}%` }}>
          <div
            className="ba-handle"
            role="slider"
            tabIndex={0}
            aria-label="Compare the two SAM masks"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pos)}
            aria-valuetext={`${Math.round(pos)} percent: ${pos > 50 ? "mostly the cake-only mask" : "mostly the mask with raspberries"}`}
            onKeyDown={onKey}
          >
            <Icon name="arrow" size={14} className="flip" />
            <Icon name="arrow" size={14} />
          </div>
        </div>
      </div>
      <p className="cap">
        Drag the divider, or focus it and use the arrow keys (Shift for bigger steps). Left: SAM cuts
        “the cake” and leaves the raspberries, which are separate objects. Right: Muse Spark named the
        visible part, so product and parts are cut out as one union mask. Coverage 19% → 28% on a live
        run. Parts handling runs for the first product of a campaign only.{" "}
        <Tag kind="recorded live run" />
      </p>
    </div>
  );
}

const FILMS = {
  sneaker: { label: "Sneaker", n: ["Hero float", "Hero, camera moves", "Macro, whip pan", "Macro, kinetic type", "Context scene", "Facts card"] },
  cake: { label: "Cake", n: ["Hero float", "Hero, camera moves", "Macro", "Macro, kinetic type", "Context scene", "Facts card"] },
  mug: { label: "Mug", n: ["Hero float", "Hero, camera moves", "Macro", "Macro, kinetic type", "Context scene", "Facts card"] },
} as const;

function FilmStrip() {
  const [k, setK] = useState<keyof typeof FILMS>("sneaker");
  const f = FILMS[k];
  return (
    <div className="film">
      <div className="film-head">
        <h3>Same pixels, six moments</h3>
        <div className="seg" role="group" aria-label="Choose a film">
          {(Object.keys(FILMS) as (keyof typeof FILMS)[]).map((x) => (
            <button key={x} type="button" aria-pressed={x === k} className={x === k ? "on" : ""} onClick={() => setK(x)}>
              {FILMS[x].label}
            </button>
          ))}
        </div>
      </div>
      <ul className="film-strip" aria-label={`Six frames of the ${f.label} film`}>
        {f.n.map((name, i) => (
          <li key={`${k}-${i}`}>
            <img src={`${L}film-${k}-${i + 1}.webp`} alt={`${f.label} film frame ${i + 1}: ${name}`} width="360" height="640" loading="lazy" />
            <span>{name}</span>
          </li>
        ))}
      </ul>
      <p className="cap">
        Frames of live renders. The product pixels are the SAM cutout composited, never regenerated.
        Compositing fidelity on a real render: SSIM 0.87 to 0.91 (scene reel 0.937). That measures
        compositing only, not whether a cutout is a faithful picture of the real product.{" "}
        <Tag kind="measured offline" />
      </p>
    </div>
  );
}

function Cutout() {
  return (
    <section id="cutout" className="sec" aria-labelledby="h-cut">
      <div className="wrap">
        <SectionHead
          id="h-cut"
          icon="scissors"
          kicker="Product-true"
          sub="Meta's API has no video model, so Axys does not invent footage. It keeps your exact product pixels and builds the film around them."
        >
          The product stays <span className="grad">the product.</span>
        </SectionHead>
        <Reveal>
          <BeforeAfter />
        </Reveal>
        <Reveal>
          <FilmStrip />
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- capabilities */

const CAPS = [
  { i: "shield", t: "Exact-rule preflight", b: "Prices, offer, collection, contact and dates are matched in code across site, reel, caption and voice. A model can only warn.", n: "312/312", l: "drift caught", tag: "measured offline" },
  { i: "pen", t: "Red Pen", b: "Marks are drawn on the real website preview, the reel frame and the caption, then turn green after the fix.", n: "3 surfaces", l: "marked and re-checked", tag: "recorded live run" },
  { i: "mic", t: "Say it", b: "Type or speak a change. Muse Wonder parses it into a strict patch that is never applied until you confirm.", n: "12 commands", l: "all unsafe ones rejected with a question", tag: "recorded live run" },
  { i: "eye", t: "Product understanding", b: "Muse Spark names the product, its parts, mood and palette from the photo. Facts never come from it.", n: "3 of 3", l: "mug, sneaker, cake identified", tag: "recorded live run" },
  { i: "scissors", t: "SAM 3.1 cutouts", b: "The product and its visible parts are cut out as one union mask and composited, never regenerated.", n: "19% → 28%", l: "cake coverage with parts named", tag: "recorded live run" },
  { i: "film", t: "Studio film", b: "Hero float, whip pan, macro, kinetic type and a facts end card, rendered by FFmpeg from the cutout.", n: "SSIM 0.87–0.91", l: "hero compositing fidelity", tag: "measured offline" },
  { i: "palette", t: "Ink that stays legible", b: "Kinetic type picks its ink from the pixels behind it and adds an outline when plain ink cannot reach 4.5:1.", n: "2.4–7.6", l: "worst-pixel contrast in four renders", tag: "measured offline" },
  { i: "send", t: "Approval and publishing", b: "Hash-bound approvals, independent receipts per surface. Verified against a local fake Instagram only.", n: "0 posts", l: "to a real account so far", tag: "recorded run" },
  { i: "chart", t: "Grounded feedback", b: "A revision may only quote real observed numbers. With no data there is no model call at all.", n: "7 tests", l: "for the feedback rules", tag: "recorded run" },
] as const;

function Capabilities() {
  return (
    <section id="capabilities" className="sec" aria-labelledby="h-cap">
      <div className="wrap">
        <SectionHead
          id="h-cap"
          icon="grid"
          kicker="Capabilities"
          sub="Nine things the Studio does, each with the number we actually measured and where it came from."
        >
          Everything you need to <span className="grad">trust a campaign</span>
        </SectionHead>
        <div className="cap-grid">
          {CAPS.map((c, i) => (
            <Reveal as="article" key={c.t} delay={(i % 3) * 70} className="card cap-card">
              <div className="cap-top">
                <span className="cap-ico">
                  <Icon name={c.i} size={18} />
                </span>
                <span className="cap-idx">0{i + 1}</span>
              </div>
              <h3>{c.t}</h3>
              <p>{c.b}</p>
              <div className="cap-num">
                <b>{c.n}</b>
                <span>{c.l}</span>
              </div>
              <Tag kind={c.tag as any} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- pipeline */

const PIPE = [
  {
    id: "brief", name: "Brief", icon: "chat", model: "Muse Wonder · Muse Voice Transcribe",
    title: "Say what you sell, in your own words",
    body: "Type it or say it. The brief becomes confirmed facts: business, offer, collection time, contact link, products and prices. Nothing is generated until you confirm them, and every later check is against these facts.",
    nums: [["12", "live commands tested"], ["0", "unsafe ones applied"]], tag: "recorded live run",
    note: "Prompt injection and “set the price to 0” were rejected with a question. Microphone capture through the Studio is unverified.",
  },
  {
    id: "identify", name: "Identify", icon: "eye", model: "Muse Spark 1.3",
    title: "Muse Spark looks at the photo",
    body: "One vision call returns category, subject, descriptors, visible parts, palette, mood and motion. Code validates every field, drops phrases with digits, links, money or claims, and falls back safely.",
    nums: [["3/3", "mug, sneaker, cake correct"], ["0", "facts taken from it"]], tag: "recorded live run",
    note: "Try it yourself in the Bench: Name that product.",
  },
  {
    id: "cutout", name: "Cut out", icon: "scissors", model: "SAM 3.1",
    title: "Cut the product out, with its parts",
    body: "SAM cuts out the named product. Spark names the visible parts, and the union mask keeps them. Coverage: mug 25.1% (27.2% with the handle), sneaker 30.5%, cake 19.3% (28.0% with raspberries).",
    nums: [["19→28%", "cake coverage"], ["30.5%", "sneaker coverage"]], tag: "recorded live run",
    note: "SAM may miss unusual or thin objects, and only one product category was tested at scale.",
  },
  {
    id: "film", name: "Film", icon: "film", model: "FFmpeg + Muse Image backdrops",
    title: "A 10-second film from real pixels",
    body: "Hero float, whip pans with directional blur, a macro chosen by edge energy, kinetic type, a context scene on a generated backdrop and the facts end card. No actors, no voiceover.",
    nums: [["0.87–0.91", "SSIM, hero compositing"], ["0.937", "SSIM, scene reel"]], tag: "measured offline",
    note: "Fidelity measures compositing only.",
  },
  {
    id: "preflight", name: "Preflight", icon: "shield", model: "Exact rules + Muse Wonder (warn only)",
    title: "Check every surface, then mark it",
    body: "Deterministic rules block approval when a price, date, offer, message or link disagrees with the confirmed facts. Red Pen draws the marks on the real preview. Muse Wonder adds unsupported-claim warnings but never blocks.",
    nums: [["312/312", "drift caught"], ["0/1,111", "false alarms"]], tag: "measured offline",
    note: "Shown: a live Red Pen run with the price edited after generation.",
  },
  {
    id: "publish", name: "Publish", icon: "send", model: "Hash-bound approval",
    title: "Approve the exact version",
    body: "An approval is bound to hashes of the site, the reel, the account and the schedule. Website and Instagram publish independently with separate receipts, so partial failure stays visible.",
    nums: [["0", "real Instagram posts"], ["1", "local fake Graph API run"]], tag: "recorded run",
    note: "Instagram posting is not verified against a real account: the project has no Meta app credentials or public https address yet.",
  },
  {
    id: "learn", name: "Learn", icon: "chart", model: "Muse Wonder (grounded)",
    title: "Propose one grounded next move",
    body: "From real insights and site events, Wonder proposes one change. The reply must quote at least one observed number and may not claim sales or causation, otherwise a deterministic summary replaces it. No data, no model call.",
    nums: [["7", "feedback tests"], ["0", "calls with no data"]], tag: "recorded run",
    note: "The live check used synthetic numbers, not real Instagram data.",
  },
] as const;

function PipeVisual({ id }: { id: string }) {
  if (id === "film")
    return (
      <ul className="pipe-frames" aria-label="Film frames">
        {[1, 3, 4, 6].map((n) => (
          <li key={n}>
            <img src={`${L}film-sneaker-${n}.webp`} alt={`Sneaker film frame ${n}`} width="360" height="640" loading="lazy" />
          </li>
        ))}
      </ul>
    );
  if (id === "preflight")
    return (
      <div className="pipe-shot">
        <img src={`${L}redpen-live.webp`} alt="Red Pen marks on a live run: three numbered circles on the website preview, the reel frame and the caption" width="1000" height="1316" loading="lazy" />
      </div>
    );
  if (id === "cutout")
    return (
      <div className="pipe-shot wide">
        <img src={`${L}cake-mask-with-parts.webp`} alt="SAM mask on the cake and its raspberries" width="640" height="426" loading="lazy" />
      </div>
    );
  if (id === "identify")
    return (
      <ul className="pipe-spark" aria-label="Recorded Muse Spark directions">
        {[
          ["mug", "homeware", "earthy", ["#5a7da3", "#33465e"]],
          ["sneaker", "footwear", "fresh", ["#ffffff", "#a9bcae"]],
          ["cake", "food", "warm", ["#3a1e14", "#c92038"]],
        ].map(([n, c, m, pal]) => (
          <li key={n as string}>
            <img src={`${L}reel-${n}.webp`} alt="" width="540" height="960" loading="lazy" />
            <span>
              <b>{c as string}</b> · {m as string}
              <span className="sw">
                {(pal as string[]).map((h) => (
                  <i key={h} style={{ background: h }} />
                ))}
              </span>
            </span>
          </li>
        ))}
      </ul>
    );
  if (id === "brief")
    return (
      <div className="pipe-chat">
        <p className="b you">“make the mug one ninety nine rupees”</p>
        <p className="b ax">Mug price INR 149.00 → INR 199.00. Apply?</p>
        <p className="b you">“set the mug price to 0”</p>
        <p className="b ax warn">That would give the mug away. Did you mean a different price?</p>
      </div>
    );
  return (
    <div className="pipe-chat">
      <p className="b ax">Approval bound to: site hash · reel hash · account · schedule.</p>
      <p className="b ax">Website: published (receipt). Instagram: waiting for credentials. Shown separately.</p>
      <p className="b ax warn">No observations yet, so no suggestion was made.</p>
    </div>
  );
}

function Pipeline() {
  const [k, setK] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    let n = i;
    if (e.key === "ArrowRight") n = (i + 1) % PIPE.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + PIPE.length) % PIPE.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = PIPE.length - 1;
    else return;
    e.preventDefault();
    setK(n);
    refs.current[n]?.focus();
  };
  const p = PIPE[k];
  return (
    <section id="pipeline" className="sec" aria-labelledby="h-pipe">
      <div className="wrap">
        <SectionHead
          id="h-pipe"
          icon="layers"
          kicker="Pipeline"
          sub="Seven stages from a sentence to a verified post. Tap one."
        >
          From a sentence to a <span className="grad">verified post</span>
        </SectionHead>
        <Reveal className="tabs-wrap">
          <div className="tabs" role="tablist" aria-label="Pipeline stages">
            {PIPE.map((s, i) => (
              <button
                key={s.id}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                role="tab"
                id={`pt-${s.id}`}
                aria-selected={i === k}
                aria-controls="pipe-panel"
                tabIndex={i === k ? 0 : -1}
                className={i === k ? "on" : ""}
                onClick={() => setK(i)}
                onKeyDown={(e) => onKey(e, i)}
              >
                <span className="tab-ico">
                  <Icon name={s.icon} size={16} />
                </span>
                <span className="tab-n">{i + 1}</span>
                {s.name}
              </button>
            ))}
          </div>
          <div className="card glass pipe-panel" role="tabpanel" id="pipe-panel" aria-labelledby={`pt-${p.id}`} tabIndex={0}>
            <div className="pipe-copy">
              <span className="model">{p.model}</span>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
              <dl className="pipe-nums">
                {p.nums.map(([n, l]) => (
                  <div key={l}>
                    <dt>{n}</dt>
                    <dd>{l}</dd>
                  </div>
                ))}
              </dl>
              <p className="fine">{p.note}</p>
              <Tag kind={p.tag as any} />
            </div>
            <div className="pipe-vis">
              <PipeVisual id={p.id} />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- how / stack */

const HOW = [
  ["Confirm the truth", "Business facts, prices, dates and your own product photo become the single source of truth.", "list"],
  ["Understand the product", "Muse Spark reads the photo. SAM cuts out the product and its parts.", "eye"],
  ["Build every surface", "A site, a reel and a caption are generated from the same facts. The reel keeps your exact pixels.", "film"],
  ["Prove it, then fix it", "Exact rules check each surface. Red Pen marks mismatches and Fix with Axys regenerates.", "shield"],
  ["Approve, publish, learn", "You approve exact versions. Real events, never invented ones, can suggest the next move.", "send"],
];

function How() {
  return (
    <section id="how" className="sec" aria-labelledby="h-how">
      <div className="wrap">
        <SectionHead id="h-how" icon="list" kicker="How it works" sub="Five steps. You stay in charge of every fact and every publish.">
          One loop, <span className="grad">five steps</span>
        </SectionHead>
        <ol className="how-list">
          {HOW.map(([t, b, ic], i) => (
            <Reveal as="li" key={t} delay={i * 60} className="card how-step">
              <span className="how-n">{i + 1}</span>
              <span className="how-ico">
                <Icon name={ic} size={18} />
              </span>
              <h3>{t}</h3>
              <p>{b}</p>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

const LAYERS = [
  { t: "Interface", i: "grid", b: "Studio, the Say it bar, Red Pen, the hosted merchant site.", c: ["Studio", "Say it", "Red Pen", "Public site"] },
  { t: "Agents on Muse models", i: "bulb", b: "Models propose. They never decide what is true.", c: ["Muse Voice Transcribe", "SAM 3.1", "Muse Spark", "Muse Wonder", "Muse Image"] },
  { t: "Verifiers", i: "shield", b: "Plain code that cannot be argued with: exact-match preflight, command rules, phrase filter, fidelity measure.", c: ["Preflight", "Command guard", "Phrase filter", "Fidelity"] },
  { t: "Isolation", i: "lock", b: "Docker containers: only the gateway container is given the model key, only Caddy is published, renders are memory capped, workspaces are per tenant.", c: ["gateway", "app + FFmpeg", "Caddy"] },
];

function Stack() {
  return (
    <section id="stack" className="sec" aria-labelledby="h-stack">
      <div className="wrap">
        <SectionHead id="h-stack" icon="box" kicker="Architecture" sub="Four layers. The model sits in the second one, and the third one has the last word.">
          Agents propose. <span className="grad">Verifiers decide.</span>
        </SectionHead>
        <div className="layers">
          {LAYERS.map((l, i) => (
            <Reveal key={l.t} delay={i * 80} className={`card layer layer-${i + 1}`}>
              <span className="layer-ico">
                <Icon name={l.i} size={20} />
              </span>
              <div>
                <h3>
                  <span className="mono">L{i + 1}</span> {l.t}
                </h3>
                <p>{l.b}</p>
              </div>
              <ul className="chips">
                {l.c.map((x) => (
                  <li key={x} className="chip">
                    {x}
                  </li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>
        <Reveal as="p" className="fine center">
          Compose file defines the isolation (gateway, app, Caddy). Not exercised on the machine used for this build.
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- real + cta */

function Real() {
  return (
    <section id="real" className="sec" aria-labelledby="h-real">
      <div className="wrap">
        <SectionHead id="h-real" icon="shield" kicker="What is real" sub="Every number on this page is labelled with where it came from. Here is the summary, including what does not work yet.">
          Claims we can <span className="grad">back, and limits</span>
        </SectionHead>
        <div className="real-grid">
          <Reveal className="card real-col">
            <h3>
              <span className="d live" /> Live on this page
            </h3>
            <ul>
              <li>Spot the stale surface: real preflight on prepared scenarios.</li>
              <li>Would this tagline pass: the real kinetic-phrase filter.</li>
              <li>Neither calls a model. Both are stateless.</li>
            </ul>
            <Tag kind="live engine" />
          </Reveal>
          <Reveal delay={70} className="card real-col">
            <h3>
              <span className="d rec" /> Recorded runs
            </h3>
            <ul>
              <li>Reels, film frames, SAM masks, Spark directions and Red Pen screenshots from live Meta runs on 4 Nov 2026.</li>
              <li>12 live commands, Wonder 7/7 claims (0/3 false warnings, small sample), cake coverage 19% → 28%.</li>
              <li>Tests: 189 Node and 8 gateway tests pass.</li>
            </ul>
            <Tag kind="recorded live run" />
          </Reveal>
          <Reveal delay={140} className="card real-col">
            <h3>
              <span className="d off" /> Measured offline
            </h3>
            <ul>
              <li>Preflight mutation eval, 1,657 cases: 312/312, 114/114, 0/1,111, 0/24.</li>
              <li>SSIM 0.87 to 0.91 hero compositing, 0.937 scene reel.</li>
              <li>Contrast of kinetic type on four renders.</li>
            </ul>
            <Tag kind="measured offline" />
          </Reveal>
        </div>
        <Reveal className="limits card" aria-label="Honest limits">
          <h3>
            <Icon name="alert" size={16} /> Honest limits
          </h3>
          <ul>
            <li>No live-action footage and no voiceover or music. Meta&apos;s voice model only transcribes.</li>
            <li>Instagram posting is not verified against a real account; only a local fake Graph API was run.</li>
            <li>Cutouts with parts handling work for the first product of a campaign only.</li>
            <li>Microphone capture through the Studio and WhatsApp intake are unverified.</li>
            <li>Tested on a mug, a sneaker and a cake; SAM may miss unusual or thin objects.</li>
            <li>Known preflight misses: extended values and one stale occurrence among two.</li>
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="cta" aria-labelledby="h-cta">
      <div className="cta-glow" aria-hidden="true" />
      <Reveal className="wrap cta-in">
        <h2 id="h-cta">
          Ready when <span className="grad">you are.</span>
        </h2>
        <p className="lede">Open the Studio, confirm your facts and watch Red Pen mark every surface that disagrees.</p>
        <div className="cta-row center">
          <a className="btn btn-primary btn-lg" href={STUDIO}>
            Open Studio <Icon name="arrow" size={17} />
          </a>
          <a className="btn btn-ghost btn-lg" href="#bench">
            <Icon name="game" size={16} /> Play The Bench
          </a>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <Logo />
        <p>Campaign proofs for small businesses. Built on Muse Voice Transcribe, SAM 3.1, Muse Spark, Muse Wonder and Muse Image.</p>
        <a href="#top">Back to top</a>
      </div>
    </footer>
  );
}

export default function Landing() {
  const active = useActiveSection();
  useEffect(() => {
    const h = document.documentElement;
    h.classList.add("lp-on");
    return () => h.classList.remove("lp-on");
  }, []);
  return (
    <div className="lp">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav />
      <DotNav active={active} />
      <main id="main">
        <Hero />
        <Problem />
        <Meet />
        <Cutout />
        <Capabilities />
        <Pipeline />
        <section id="bench" className="sec bench-sec" aria-labelledby="h-bench">
          <Bench />
        </section>
        <How />
        <Stack />
        <Real />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}
