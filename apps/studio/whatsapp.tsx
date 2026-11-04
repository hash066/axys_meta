import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./whatsapp.css";

/**
 * ?sim=whatsapp: a SAMPLE WhatsApp conversation that shows how a merchant's voice note and photo
 * become a confirmed brief. Nothing here is sent through WhatsApp. The photo and the voice note come
 * from /demo/product.jpg and /demo/voice-note.mp3; the transcript comes from /demo/voice-note.json.
 * The facts checklist is extracted from that transcript by the small deterministic extractor below
 * (the real product does this with Muse Wonder and a confirmation step; this is the demo stand-in).
 */

const IMG = "/demo/product.jpg";
const AUDIO = "/demo/voice-note.mp3";
const JSON_URL = "/demo/voice-note.json";
const STUDIO_HREF = "/?studio=1&draft=whatsapp";

type Transcript = { text: string; durationSec?: number; source?: string };
type Facts = {
  business?: string;
  sender?: string;
  product?: string;
  price?: string;
  collection?: string;
  contact: string;
};

const MONTH = (m: string) => m.slice(0, 3);

export function extractFacts(text: string): Facts {
  const t = text.replace(/\s+/g, " ").trim();
  const sender = /\b(?:it'?s|this is|i'?m)\s+([A-Z][a-z]+)\b/.exec(t)?.[1];
  const business =
    /\bfrom\s+([A-Z][\w&']*(?:\s+[A-Z][\w&']*){0,3})/.exec(t)?.[1] ??
    /\bat\s+([A-Z][\w&']*(?:\s+[A-Z][\w&']*){0,3})/.exec(t)?.[1];
  const productRaw =
    /\b(?:dropping|launching|selling|releasing|making|baking|have|got)\s+(?:(?:our|my|the|a|an)\s+)+(?:new\s+)?(.+?)\s+(?:this|on|next|for|at|from)\b/i.exec(
      t,
    )?.[1];
  const product = productRaw?.replace(/\bthe\s+(?=sage|[a-z]+\s+(?:panels|trim|laces))/i, "").trim();
  const priceMatch = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(t);
  const price = priceMatch
    ? `$${Number(priceMatch[1]).toFixed(2)}`
    : undefined;
  const when =
    /\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:from\s+)?(\d{1,2}(?::\d\d)?\s*(?:am|pm)?)\s*(?:to|-|until)\s*(\d{1,2}(?::\d\d)?\s*(?:am|pm)?)/i.exec(
      t,
    );
  const collection = when
    ? `${when[1]}day, ${MONTH(when[2])} ${when[3]}, ${when[4].replace(/\s+/g, "")} to ${when[5].replace(/\s+/g, "")}`
    : undefined;
  return {
    business,
    sender,
    product,
    price,
    collection,
    contact: "Orders arrive in this WhatsApp chat",
  };
}

const fmt = (s: number) => {
  const n = Math.max(0, Math.round(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

/* ---------- icons: all inline SVG ---------- */
type IconName =
  | "back" | "video" | "phone" | "more" | "mic" | "play" | "pause" | "send" | "emoji" | "attach" | "camera"
  | "reply" | "external" | "lock" | "check" | "spark" | "replay" | "skip" | "plus" | "sticker";
const PATHS: Record<IconName, string> = {
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  video: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
  phone:
    "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z",
  more: "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  mic: "M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z",
  play: "M8 5.14v13.72c0 .79.87 1.27 1.54.84l10.77-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z",
  pause: "M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z",
  send: "M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z",
  emoji:
    "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z",
  attach:
    "M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z",
  camera:
    "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z",
  reply: "M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
  external:
    "M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
  lock: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  spark: "M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm7 12l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14z",
  replay: "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
  skip: "M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z",
  plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  sticker:
    "M21 11.5V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h6.5L21 11.5zM12 19.5V15c0-1.1.9-2 2-2h4.5L12 19.5z",
};
function Icon({ name, size = 24, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  );
}

/** WhatsApp-style tick marks, drawn here: one or two checks, grey or blue. */
function Ticks({ level }: { level: "sent" | "delivered" | "read" }) {
  return (
    <svg
      className={`wa-ticks ${level}`}
      width="16"
      height="11"
      viewBox="0 0 16 11"
      role="img"
      aria-label={level === "sent" ? "Sent" : level === "delivered" ? "Delivered" : "Read"}
    >
      <path d="M1.2 6.1 4.1 9 10.3 1.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {level !== "sent" ? (
        <path d="M5.9 8.2 6.7 9 12.9 1.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
    </svg>
  );
}

function useAutoTicks(speed: number, skip: boolean) {
  const [level, setLevel] = useState<"sent" | "delivered" | "read">(skip ? "read" : "sent");
  useEffect(() => {
    if (skip) {
      setLevel("read");
      return;
    }
    const a = setTimeout(() => setLevel("delivered"), 450 / speed);
    const b = setTimeout(() => setLevel("read"), 1250 / speed);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [speed, skip]);
  return level;
}

function StatusBar() {
  return (
    <div className="wa-status" aria-hidden="true">
      <span className="wa-clock">10:41</span>
      <span className="wa-sysicons">
        <svg width="17" height="12" viewBox="0 0 17 12">
          <rect x="0" y="8" width="3" height="4" rx="0.8" fill="currentColor" />
          <rect x="4.6" y="5.5" width="3" height="6.5" rx="0.8" fill="currentColor" />
          <rect x="9.2" y="3" width="3" height="9" rx="0.8" fill="currentColor" />
          <rect x="13.8" y="0" width="3" height="12" rx="0.8" fill="currentColor" opacity="0.4" />
        </svg>
        <svg width="16" height="12" viewBox="0 0 16 12">
          <path d="M8 11.4 5.6 8.9a3.5 3.5 0 0 1 4.8 0L8 11.4zM3.9 7.2a5.9 5.9 0 0 1 8.2 0l-1.2 1.2a4.2 4.2 0 0 0-5.8 0L3.9 7.2zM1.5 4.8a9.3 9.3 0 0 1 13 0l-1.2 1.2a7.6 7.6 0 0 0-10.6 0L1.5 4.8z" fill="currentColor" />
        </svg>
        <svg width="26" height="12" viewBox="0 0 26 12">
          <rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" opacity="0.55" />
          <rect x="2" y="2" width="16" height="8" rx="1.8" fill="currentColor" />
          <rect x="23" y="4" width="2" height="4" rx="1" fill="currentColor" opacity="0.55" />
        </svg>
      </span>
    </div>
  );
}

/* ---------- voice note ---------- */
function waveHeights(n: number) {
  // Deterministic pseudo-speech envelope.
  const out: number[] = [];
  let s = 7;
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    const env = 0.45 + 0.55 * Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.11 + 1));
    out.push(Math.round(4 + (0.35 + 0.65 * r) * env * 22));
  }
  return out;
}
const BARS = waveHeights(38);

function VoiceNote({
  durationHint,
  avatarLabel,
  time,
  ticks,
  transcript,
  transcriptState,
}: {
  durationHint?: number;
  avatarLabel: string;
  time: string;
  ticks: "sent" | "delivered" | "read";
  transcript: Transcript | null;
  transcriptState: "hidden" | "working" | "shown";
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(durationHint ?? 0);
  const [failed, setFailed] = useState(false);
  const [played, setPlayed] = useState(false);
  const drag = useRef(false);
  useEffect(() => {
    if (durationHint && !dur) setDur(durationHint);
  }, [durationHint, dur]);
  const seekTo = useCallback(
    (t: number) => {
      const a = audio.current;
      if (!a || !dur) return;
      const v = Math.min(dur, Math.max(0, t));
      a.currentTime = v;
      setCur(v);
    },
    [dur],
  );
  const fromPointer = (e: React.PointerEvent) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !dur) return;
    seekTo(((e.clientX - r.left) / r.width) * dur);
  };
  const toggle = () => {
    const a = audio.current;
    if (!a || failed) return;
    if (a.paused) a.play().catch(() => setFailed(true));
    else a.pause();
  };
  const frac = dur ? Math.min(1, cur / dur) : 0;
  return (
    <>
      <div className="wa-voice">
        <button
          type="button"
          className="wa-play"
          onClick={toggle}
          disabled={failed}
          aria-label={playing ? "Pause voice note" : "Play voice note"}
          title={failed ? "Voice note audio is not available" : undefined}
        >
          <Icon name={playing ? "pause" : "play"} size={26} />
        </button>
        <div className="wa-wavecol">
          <div
            ref={track}
            className="wa-wave"
            role="slider"
            tabIndex={0}
            aria-label="Voice note position"
            aria-valuemin={0}
            aria-valuemax={Math.round(dur)}
            aria-valuenow={Math.round(cur)}
            aria-valuetext={`${fmt(cur)} of ${fmt(dur)}`}
            onPointerDown={(e) => {
              drag.current = true;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              fromPointer(e);
            }}
            onPointerMove={(e) => drag.current && fromPointer(e)}
            onPointerUp={() => (drag.current = false)}
            onPointerCancel={() => (drag.current = false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowUp") (e.preventDefault(), seekTo(cur + 1));
              else if (e.key === "ArrowLeft" || e.key === "ArrowDown") (e.preventDefault(), seekTo(cur - 1));
              else if (e.key === "Home") (e.preventDefault(), seekTo(0));
              else if (e.key === "End") (e.preventDefault(), seekTo(dur));
              else if (e.key === " " || e.key === "Enter") (e.preventDefault(), toggle());
            }}
          >
            {BARS.map((h, i) => (
              <i key={i} className={i / BARS.length < frac ? "on" : ""} style={{ height: h }} />
            ))}
            <b className="wa-knob" style={{ left: `${frac * 100}%` }} />
          </div>
          <div className="wa-vfoot">
            <span className="wa-dur">{playing || cur > 0 ? fmt(cur) : fmt(dur)}</span>
            <span className="wa-meta">
              <time>{time}</time>
              <Ticks level={ticks} />
            </span>
          </div>
        </div>
        <div className="wa-avatar-mic" aria-hidden="true">
          <span className="wa-me">{avatarLabel}</span>
          <Icon name="mic" size={14} className={played ? "heard" : ""} />
        </div>
        <audio
          ref={audio}
          src={AUDIO}
          preload="metadata"
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
          onTimeUpdate={(e) => !drag.current && setCur(e.currentTarget.currentTime)}
          onPlay={() => (setPlaying(true), setPlayed(true))}
          onPause={() => setPlaying(false)}
          onEnded={() => (setPlaying(false), setCur(0))}
          onError={() => setFailed(true)}
        />
      </div>
      {transcriptState !== "hidden" ? (
        <div className="wa-transcript" aria-live="polite">
          <p className="wa-tlabel">
            <Icon name="spark" size={12} /> Transcribed with Muse Voice
          </p>
          {transcriptState === "working" ? (
            <p className="wa-tbody wa-shimmer" role="status">
              Transcribing…
            </p>
          ) : (
            <p className="wa-tbody">{transcript ? transcript.text : "Transcript not available in this demo build."}</p>
          )}
        </div>
      ) : null}
    </>
  );
}

/* ---------- main ---------- */
type Item = "img" | "voice" | "facts" | "confirm" | "draft";
const TIMES: Record<Item, string> = { img: "10:41", voice: "10:41", facts: "10:42", confirm: "10:42", draft: "10:43" };

export function WhatsAppSim() {
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const speed = Math.min(8, Math.max(0.25, Number(q.get("speed")) || 1));
  // ?autoplay=1 (used for the recorded demo): the voice note plays by itself and the assistant reacts only after it ends.
  const autoplay = q.get("autoplay") === "1";
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [runId, setRunId] = useState(0);
  const [skip, setSkip] = useState(false);
  const [tr, setTr] = useState<Transcript | null | undefined>(undefined);
  const [items, setItems] = useState<Item[]>([]);
  const [typing, setTyping] = useState(false);
  const [tState, setTState] = useState<"hidden" | "working" | "shown">("hidden");
  const [pressed, setPressed] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const confirmNow = useRef<(() => void) | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const skipRef = useRef(false);

  useEffect(() => {
    let dead = false;
    fetch(JSON_URL)
      .then(async (r) => {
        const ct = r.headers.get("content-type") || "";
        if (!r.ok || !ct.includes("json")) throw new Error("no transcript");
        return r.json();
      })
      .then((j) => !dead && setTr(typeof j?.text === "string" ? j : null))
      .catch(() => !dead && setTr(null));
    return () => {
      dead = true;
    };
  }, []);

  const facts = useMemo(() => extractFacts(tr?.text ?? ""), [tr]);

  useEffect(() => {
    if (tr === undefined) return;
    let dead = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    skipRef.current = false;
    setItems([]);
    setTyping(false);
    setTState("hidden");
    setPressed(false);
    setSkip(false);
    const w = (ms: number) =>
      new Promise<void>((res) => {
        if (skipRef.current) return res();
        const t = setTimeout(res, ms / speed);
        timers.push(t);
        const poll = setInterval(() => {
          if (skipRef.current || dead) (clearTimeout(t), clearInterval(poll), res());
        }, 80);
        timers.push(poll as unknown as ReturnType<typeof setTimeout>);
        setTimeout(() => clearInterval(poll), ms / speed + 100);
      });
    const add = (i: Item) => !dead && setItems((x) => (x.includes(i) ? x : [...x, i]));
    const type = async (ms: number) => {
      if (skipRef.current) return;
      setTyping(true);
      await w(ms);
      setTyping(false);
    };
    (async () => {
      await w(900);
      add("img");
      await w(2100);
      if (dead) return;
      add("voice");
      if (autoplay) {
        await w(350);
        (document.querySelector(".wa-play") as HTMLButtonElement | null)?.click();
        await w(((tr?.durationSec ?? 8) * 1000 + 700) * speed);
      } else await w(1500);
      if (dead) return;
      setTState("working");
      await w(1700);
      if (dead) return;
      setTState("shown");
      await w(1500);
      if (dead) return;
      await type(1900);
      if (dead) return;
      add("facts");
      await new Promise<void>((res) => {
        confirmNow.current = res;
        if (skipRef.current) return res();
        const t = setTimeout(res, 4200 / speed);
        timers.push(t);
        const poll = setInterval(() => {
          if (skipRef.current || dead) (clearTimeout(t), clearInterval(poll), res());
        }, 80);
        timers.push(poll as unknown as ReturnType<typeof setTimeout>);
      });
      confirmNow.current = null;
      if (dead) return;
      setPressed(true);
      await w(550);
      if (dead) return;
      add("confirm");
      await w(900);
      if (dead) return;
      await type(1700);
      if (dead) return;
      add("draft");
    })();
    return () => {
      dead = true;
      timers.forEach((t) => (clearTimeout(t), clearInterval(t as unknown as number)));
    };
  }, [runId, tr, speed, autoplay]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced || skip ? "auto" : "smooth" });
  }, [items.length, typing, tState, reduced, skip]);

  const skipToEnd = () => {
    skipRef.current = true;
    setSkip(true);
    setTState("shown");
    setPressed(true);
    setItems(["img", "voice", "facts", "confirm", "draft"]);
    setTyping(false);
    confirmNow.current?.();
  };
  const replay = () => setRunId((n) => n + 1);

  const done = items.includes("draft");
  const factRows: [string, string | undefined][] = [
    ["Business", facts.business],
    ["Product", facts.product],
    ["Price", facts.price],
    ["Collection", facts.collection],
    ["Contact", facts.contact],
  ];
  const sender = facts.sender ?? "You";
  const statusText = typing ? "typing…" : "online";

  return (
    <div className="wa-page">
      <div className="wa-toolbar">
        <div className="wa-toolbar-title">
          <span className="wa-mark">
            axys<span>●</span>
          </span>
          <span className="wa-toolbar-sub">Demo · how a voice note becomes a brief</span>
        </div>
        <div className="wa-toolbar-actions">
          <button type="button" className="wa-tool" onClick={replay}>
            <Icon name="replay" size={16} /> Replay
          </button>
          <button type="button" className="wa-tool" onClick={skipToEnd} disabled={done}>
            <Icon name="skip" size={16} /> Skip to end
          </button>
        </div>
      </div>

      <div className="wa-stage">
        <div className="wa-phone" role="group" aria-label="WhatsApp conversation with Axys Assistant">
          <StatusBar />
          <header className="wa-header">
            <a className="wa-back" href="/" aria-label="Back to the Axys home page">
              <Icon name="back" size={24} />
            </a>
            <div className="wa-peer-avatar" aria-hidden="true">
              <span>a</span>
              <i />
            </div>
            <div className="wa-peer">
              <h1>Axys Assistant</h1>
              <p aria-live="polite">{statusText}</p>
            </div>
            <div className="wa-header-actions" aria-hidden="true">
              <Icon name="video" size={22} />
              <Icon name="phone" size={21} />
              <Icon name="more" size={22} />
            </div>
          </header>

          <div className="wa-chat" ref={scroller}>
            <div className="wa-chip-row">
              <span className="wa-date">Today</span>
            </div>

            <ol className="wa-log" role="log" aria-label="Conversation" aria-live="polite">
              {items.includes("img") && (
                <li className="wa-row out">
                  <div className={`wa-bubble out tail wa-media${reduced ? " still" : ""}`}>
                    <div className="wa-imgwrap">
                      {imgOk ? (
                        <img
                          src={IMG}
                          alt="Product photo sent by the merchant: a sneaker on a plain background"
                          width="1080"
                          height="1080"
                          onError={() => setImgOk(false)}
                        />
                      ) : (
                        <div className="wa-imgmissing">Product photo not available yet</div>
                      )}
                      <span className="wa-imgmeta">
                        <time>{TIMES.img}</time>
                        <ImgTicks speed={speed} skip={skip} />
                      </span>
                    </div>
                  </div>
                </li>
              )}
              {items.includes("voice") && (
                <li className="wa-row out">
                  <div className={`wa-bubble out tail wa-voicebub${reduced ? " still" : ""}`}>
                    <VoiceBubble
                      speed={speed}
                      skip={skip}
                      avatarLabel={sender.slice(0, 1)}
                      durationHint={tr?.durationSec}
                      transcript={tr ?? null}
                      transcriptState={tState}
                    />
                  </div>
                </li>
              )}
              {items.includes("facts") && (
                <li className="wa-row in">
                  <div className="wa-stack">
                    <div className={`wa-bubble in tail${reduced ? " still" : ""}`}>
                      <p className="wa-text">
                        Thanks{facts.sender ? `, ${facts.sender}` : ""}. I listened to your voice note and looked at
                        the photo. Here is what I understood:
                      </p>
                      <ul className="wa-facts" aria-label="Extracted facts">
                        {factRows.map(([k, v]) => (
                          <li key={k} className={v ? "" : "missing"}>
                            <span className="wa-fk">{k}</span>
                            <span className="wa-fv">
                              {v ? (
                                <>
                                  <Icon name="check" size={13} className="wa-fcheck" />
                                  {v}
                                </>
                              ) : (
                                "Not heard, I will ask"
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="wa-text wa-ask">
                        <strong>Confirm these facts?</strong> I will only use what you confirm.
                      </p>
                      <span className="wa-meta plain">
                        <time>{TIMES.facts}</time>
                      </span>
                    </div>
                    <div className="wa-quick" role="group" aria-label="Quick replies">
                      <button
                        type="button"
                        className={pressed ? "pressed" : ""}
                        onClick={() => confirmNow.current?.()}
                        disabled={pressed}
                      >
                        <Icon name="reply" size={15} /> Confirm
                      </button>
                      <button type="button" disabled>
                        <Icon name="reply" size={15} /> Edit a fact
                      </button>
                    </div>
                  </div>
                </li>
              )}
              {items.includes("confirm") && (
                <li className="wa-row out">
                  <div className={`wa-bubble out tail${reduced ? " still" : ""}`}>
                    <p className="wa-text">Confirm</p>
                    <span className="wa-meta">
                      <time>{TIMES.confirm}</time>
                      <TickAuto speed={speed} skip={skip} />
                    </span>
                  </div>
                </li>
              )}
              {items.includes("draft") && (
                <li className="wa-row in">
                  <div className="wa-stack">
                    <div className={`wa-bubble in tail wa-link${reduced ? " still" : ""}`}>
                      <a className="wa-preview" href={STUDIO_HREF}>
                        <div className="wa-prevthumb">
                          {imgOk ? <img src={IMG} alt="" /> : null}
                          <span>Draft ready</span>
                        </div>
                        <div className="wa-prevtext">
                          <strong>Your campaign draft is ready</strong>
                          <span>
                            {facts.business ? `${facts.business}: ` : ""}reel and page, waiting for your review.
                          </span>
                          <em>{location.host} · Axys Studio</em>
                        </div>
                      </a>
                      <p className="wa-text">
                        Draft ready. The facts you confirmed are in the Brief, and the photo is attached. Open it in
                        Studio to generate the reel and website.
                      </p>
                      <span className="wa-meta plain">
                        <time>{TIMES.draft}</time>
                      </span>
                    </div>
                    <div className="wa-quick single">
                      <a className="wa-cta" href={STUDIO_HREF}>
                        <Icon name="external" size={15} /> Open in Studio
                      </a>
                    </div>
                  </div>
                </li>
              )}
              {typing && (
                <li className="wa-row in" aria-hidden="true">
                  <div className="wa-bubble in tail typing">
                    <i />
                    <i />
                    <i />
                  </div>
                </li>
              )}
            </ol>
          </div>

          <div className="wa-composer" aria-hidden="true">
            <div className="wa-input">
              <Icon name="emoji" size={24} />
              <span>Message</span>
              <Icon name="attach" size={22} />
              <Icon name="camera" size={22} />
            </div>
            <span className="wa-micbtn">
              <Icon name="mic" size={22} />
            </span>
          </div>
          <div className="wa-home" aria-hidden="true" />
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {done
          ? "Draft ready. A link Open in Studio is available in the last message."
          : items.includes("facts")
            ? "The assistant asks you to confirm the extracted facts."
            : ""}
      </p>
    </div>
  );
}

function ImgTicks({ speed, skip }: { speed: number; skip: boolean }) {
  return <Ticks level={useAutoTicks(speed, skip)} />;
}
function TickAuto({ speed, skip }: { speed: number; skip: boolean }) {
  return <Ticks level={useAutoTicks(speed, skip)} />;
}
function VoiceBubble(props: Omit<React.ComponentProps<typeof VoiceNote>, "time" | "ticks"> & { speed: number; skip: boolean }) {
  const ticks = useAutoTicks(props.speed, props.skip);
  const { speed: _s, skip: _k, ...rest } = props;
  return <VoiceNote {...rest} time={TIMES.voice} ticks={ticks} />;
}
