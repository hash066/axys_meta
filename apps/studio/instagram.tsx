import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import "./instagram.css";

/**
 * Instagram preview: a phone mock of how the reel WOULD look on a profile. Nothing is posted and
 * nothing is requested from Instagram: the handle is only text typed here (kept in localStorage).
 * The "Preview, not posted" tag is part of the component and cannot be hidden by props.
 */

const KEY = "axys.preview.handle";
const DEFAULT_HANDLE = "your_brand";
export const DEMO_HANDLE = "snifthathash";

const cleanHandle = (v: string) => v.replace(/^@+/, "").replace(/[^A-Za-z0-9._]/g, "").slice(0, 30);

function useHandle(connected?: string) {
  const [handle, setHandle] = useState(() => {
    try {
      const saved = cleanHandle(localStorage.getItem(KEY) || "");
      if (saved) return saved;
    } catch {
      /* storage blocked */
    }
    return cleanHandle(connected || "") || DEFAULT_HANDLE;
  });
  const set = (v: string) => {
    const c = cleanHandle(v);
    setHandle(c);
    try {
      if (c) localStorage.setItem(KEY, c);
    } catch {
      /* ignore */
    }
  };
  return [handle || DEFAULT_HANDLE, handle, set] as const;
}

export type IgStats = { likes?: number; comments?: number; shares?: number; saves?: number; plays?: number };

const compact = (n: number | undefined) => {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en-US");
};

/* ---------- icons (inline SVG) ---------- */
const S = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
function I({ n, size = 26, filled, className }: { n: string; size?: number; filled?: boolean; className?: string }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true, focusable: false, className } as const;
  switch (n) {
    case "heart":
      return (
        <svg {...p}>
          <path
            d="M16.792 3.904A4.989 4.989 0 0 1 21.5 9.122c0 3.072-2.652 4.959-5.197 7.222-2.512 2.243-3.865 3.469-4.303 3.752-.477-.309-2.143-1.823-4.303-3.752C5.141 14.072 2.5 12.167 2.5 9.122a4.989 4.989 0 0 1 4.708-5.218 4.21 4.21 0 0 1 3.675 1.941c.84 1.175.98 1.763 1.12 1.763s.278-.588 1.11-1.766a4.17 4.17 0 0 1 3.679-1.938Z"
            {...S}
            fill={filled ? "currentColor" : "none"}
          />
        </svg>
      );
    case "comment":
      return (
        <svg {...p}>
          <path d="M20.656 17.008a9.993 9.993 0 1 0-3.59 3.615L22 22Z" {...S} strokeLinejoin="round" />
        </svg>
      );
    case "send":
      return (
        <svg {...p}>
          <line x1="22" y1="3" x2="9.218" y2="10.083" {...S} />
          <polygon points="11.698 20.334 22 3.001 2 3.001 9.218 10.084 11.698 20.334" {...S} />
        </svg>
      );
    case "save":
      return (
        <svg {...p}>
          <polygon points="20 21 12 13.44 4 21 4 3 20 3 20 21" {...S} fill={filled ? "currentColor" : "none"} />
        </svg>
      );
    case "more":
      return (
        <svg {...p}>
          <circle cx="12" cy="5" r="1.7" fill="currentColor" />
          <circle cx="12" cy="12" r="1.7" fill="currentColor" />
          <circle cx="12" cy="19" r="1.7" fill="currentColor" />
        </svg>
      );
    case "moreh":
      return (
        <svg {...p}>
          <circle cx="5" cy="12" r="1.7" fill="currentColor" />
          <circle cx="12" cy="12" r="1.7" fill="currentColor" />
          <circle cx="19" cy="12" r="1.7" fill="currentColor" />
        </svg>
      );
    case "camera":
      return (
        <svg {...p}>
          <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.1c.5 0 .9-.3 1.1-.7l.4-.8c.2-.4.6-.7 1.1-.7h5.6c.5 0 .9.3 1.1.7l.4.8c.2.4.6.7 1.1.7h1.1A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z" {...S} />
          <circle cx="12" cy="12.8" r="3.6" {...S} />
        </svg>
      );
    case "note":
      return (
        <svg {...p}>
          <path d="M9 18V6.6l10-2.2v11.2" {...S} strokeWidth={2} />
          <circle cx="6.8" cy="18" r="2.4" fill="currentColor" />
          <circle cx="16.8" cy="15.8" r="2.4" fill="currentColor" />
        </svg>
      );
    case "volume":
      return (
        <svg {...p}>
          <path d="M3 9.5v5h3.6L11.5 19V5L6.6 9.5Z" fill="currentColor" />
          <path d="M15.3 8.7a4.6 4.6 0 0 1 0 6.6M17.8 6.2a8 8 0 0 1 0 11.6" {...S} />
        </svg>
      );
    case "mute":
      return (
        <svg {...p}>
          <path d="M3 9.5v5h3.6L11.5 19V5L6.6 9.5Z" fill="currentColor" />
          <path d="m15.5 9.5 5 5m0-5-5 5" {...S} />
        </svg>
      );
    case "home":
      return (
        <svg {...p}>
          <path d="M9.005 16.545a2.997 2.997 0 0 1 2.997-2.997A2.997 2.997 0 0 1 15 16.545V22h7V11.543L12 2 2 11.543V22h7.005Z" {...S} fill={filled ? "currentColor" : "none"} />
        </svg>
      );
    case "reels":
      return (
        <svg {...p}>
          <rect x="2.5" y="2.5" width="19" height="19" rx="5" {...S} />
          <line x1="2.7" y1="8" x2="21.3" y2="8" {...S} />
          <line x1="9.2" y1="2.7" x2="12.2" y2="8" {...S} />
          <line x1="15.4" y1="2.7" x2="18.4" y2="8" {...S} />
          <path d="m10.3 11.6 4.4 2.5a.6.6 0 0 1 0 1l-4.4 2.5a.6.6 0 0 1-.9-.5v-5a.6.6 0 0 1 .9-.5Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "search":
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="8" {...S} />
          <line x1="21" y1="21" x2="16.65" y2="16.65" {...S} />
        </svg>
      );
    case "plus":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="18" height="18" rx="5" {...S} />
          <path d="M12 7.5v9M7.5 12h9" {...S} />
        </svg>
      );
    case "menu":
      return (
        <svg {...p}>
          <path d="M3 6h18M3 12h18M3 18h18" {...S} />
        </svg>
      );
    case "grid":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="18" height="18" {...S} strokeWidth={1.6} />
          <path d="M9.01 3v18M14.99 3v18M3 9.01h18M3 14.99h18" {...S} strokeWidth={1.6} />
        </svg>
      );
    case "tag":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="18" height="18" rx="2.5" {...S} strokeWidth={1.6} />
          <circle cx="12" cy="10" r="2.8" {...S} strokeWidth={1.6} />
          <path d="M6.5 20c.8-3 2.8-4.5 5.5-4.5s4.700 1.500 5.500 4.500" {...S} strokeWidth={1.6} />
        </svg>
      );
    case "chev":
      return (
        <svg {...p}>
          <path d="m6 9 6 6 6-6" {...S} />
        </svg>
      );
    case "play":
      return (
        <svg {...p}>
          <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.77-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14Z" fill="currentColor" />
        </svg>
      );
    case "pause":
      return (
        <svg {...p}>
          <path d="M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}

function StatusBar() {
  return (
    <div className="ig-status" aria-hidden="true">
      <span>9:41</span>
      <span className="ig-status-icons">
        <svg width="17" height="11" viewBox="0 0 17 11">
          <rect x="0" y="7" width="3" height="4" rx="0.8" fill="currentColor" />
          <rect x="4.6" y="5" width="3" height="6" rx="0.8" fill="currentColor" />
          <rect x="9.2" y="2.5" width="3" height="8.5" rx="0.8" fill="currentColor" />
          <rect x="13.8" y="0" width="3" height="11" rx="0.8" fill="currentColor" />
        </svg>
        <svg width="16" height="11" viewBox="0 0 16 12">
          <path d="M8 11.4 5.600 8.900a3.500 3.500 0 0 1 4.800 0L8 11.400zM3.900 7.200a5.900 5.900 0 0 1 8.200 0l-1.200 1.200a4.200 4.200 0 0 0-5.800 0L3.900 7.200zM1.500 4.800a9.300 9.300 0 0 1 13 0l-1.200 1.200a7.600 7.600 0 0 0-10.600 0L1.500 4.800z" fill="currentColor" />
        </svg>
        <svg width="25" height="12" viewBox="0 0 26 12">
          <rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" opacity="0.5" />
          <rect x="2" y="2" width="16" height="8" rx="1.800" fill="currentColor" />
          <rect x="23" y="4" width="2" height="4" rx="1" fill="currentColor" opacity="0.5" />
        </svg>
      </span>
    </div>
  );
}

function Avatar({ handle, size, ring }: { handle: string; size: number; ring?: boolean }) {
  const letter = (handle[0] || "a").toUpperCase();
  return (
    <span className={`ig-avatar${ring ? " ring" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <span className="ig-avatar-in" style={{ fontSize: size * 0.4 }}>
        {letter}
      </span>
    </span>
  );
}

function BottomNav({ active, handle }: { active: "home" | "reels" | "profile"; handle: string }) {
  return (
    <nav className="ig-nav" aria-hidden="true">
      <I n="home" size={25} filled={active === "home"} />
      <I n="reels" size={25} />
      <I n="send" size={25} />
      <I n="search" size={25} />
      <span className={`ig-navavatar${active === "profile" ? " on" : ""}`}>
        <Avatar handle={handle} size={24} />
      </span>
    </nav>
  );
}

export type InstagramPreviewProps = {
  videoSrc?: string;
  posterSrc?: string;
  caption?: string;
  business?: string;
  offer?: string;
  /** Username of a connected Instagram account, used only to pre-fill the field. */
  connectedHandle?: string;
  /** Sample counters; when given the tag says so. Never real Instagram numbers unless the caller has them. */
  stats?: IgStats | null;
  statsAreSample?: boolean;
  /** Start unmuted state hint; reels autoplay muted. */
  hasAudio?: boolean;
  headingLevel?: 2 | 3;
  /** Standalone demo page: shows which reel is being used. */
  note?: string;
};

export function InstagramPreview(props: InstagramPreviewProps) {
  const { videoSrc, posterSrc, caption, business, offer, connectedHandle, stats, statsAreSample, hasAudio } = props;
  const uid = useId();
  const [handle, raw, setHandle] = useHandle(connectedHandle);
  const [tab, setTab] = useState<"reel" | "grid">("reel");
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [more, setMore] = useState(false);
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const vid = useRef<HTMLVideoElement>(null);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const v = vid.current;
    if (v) v.muted = muted;
  }, [muted, tab]);
  useEffect(() => {
    const v = vid.current;
    if (!v || tab !== "reel") return;
    if (reduced) {
      v.pause();
      setPaused(true);
    } else v.play().catch(() => setPaused(true));
  }, [tab, videoSrc, reduced]);

  const text = (caption ?? "").trim() || "Your caption appears here once the reel is generated.";
  const flat = text.replace(/\s+/g, " ");
  const short = flat.length > 56 ? `${flat.slice(0, 56).trimEnd()}…` : flat;
  const hasMore = flat.length > 56;
  const Heading = (props.headingLevel === 3 ? "h3" : "h2") as "h2";
  const tag = statsAreSample && stats ? "Preview, not posted · sample numbers" : "Preview, not posted";

  const togglePlay = () => {
    const v = vid.current;
    if (!v) return;
    if (v.paused) (v.play(), setPaused(false));
    else (v.pause(), setPaused(true));
  };

  return (
    <section className="ig-preview" aria-labelledby={`${uid}-h`}>
      <header className="ig-head">
        <div>
          <p className="eyebrow">INSTAGRAM PREVIEW</p>
          <Heading id={`${uid}-h`}>How the reel will look on @{handle}</Heading>
        </div>
        <span className="ig-tag" role="note">
          <i aria-hidden="true" />
          {tag}
        </span>
      </header>

      <div className="ig-controls">
        <label className="ig-handle">
          <span>Preview as @</span>
          <input
            value={raw}
            onChange={(e) => setHandle(e.target.value)}
            placeholder={DEFAULT_HANDLE}
            maxLength={31}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            aria-describedby={`${uid}-n`}
          />
        </label>
        <button type="button" className="ig-chip" onClick={() => setHandle(DEMO_HANDLE)}>
          Use @{DEMO_HANDLE}
        </button>
        <div className="ig-tabs" role="tablist" aria-label="Preview view">
          {(
            [
              ["reel", "Reel"],
              ["grid", "Profile grid"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`${uid}-t-${id}`}
              aria-selected={tab === id}
              aria-controls={`${uid}-p`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  const next = id === "reel" ? "grid" : "reel";
                  setTab(next);
                  document.getElementById(`${uid}-t-${next}`)?.focus();
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted ig-note" id={`${uid}-n`}>
        A simulated mock. It is not posted, uses no Instagram login and makes no request to Instagram; the handle is
        only text you type here. {props.note}
      </p>

      <div className="ig-body">
      <div className="ig-stage" role="tabpanel" id={`${uid}-p`} aria-labelledby={`${uid}-t-${tab}`}>
        <div className="ig-phone">
          <div className="ig-screen">
            {tab === "reel" ? (
              <>
                {videoSrc ? (
                  <video
                    ref={vid}
                    className="ig-video"
                    src={videoSrc}
                    poster={posterSrc}
                    muted
                    loop
                    playsInline
                    autoPlay={!reduced}
                    preload="metadata"
                    onClick={togglePlay}
                    aria-label="Reel video preview"
                  />
                ) : (
                  <div className="ig-novideo">
                    <I n="reels" size={36} />
                    <span>No reel yet. Generate outputs to preview it here.</span>
                  </div>
                )}
                <div className="ig-shade top" aria-hidden="true" />
                <div className="ig-shade bottom" aria-hidden="true" />
                <StatusBar />
                <div className="ig-topbar">
                  <span className="ig-title">Reels</span>
                  <I n="camera" size={26} />
                </div>
                {paused && videoSrc ? (
                  <span className="ig-pause" aria-hidden="true">
                    <I n="play" size={30} />
                  </span>
                ) : null}
                {videoSrc ? (
                  <button
                    type="button"
                    className="ig-mute"
                    onClick={() => setMuted((m) => !m)}
                    aria-pressed={!muted}
                    aria-label={muted ? "Unmute reel" : "Mute reel"}
                    title={hasAudio === false ? "This reel has no narration (music bed or silent)" : undefined}
                  >
                    <I n={muted ? "mute" : "volume"} size={17} />
                  </button>
                ) : null}

                <div className="ig-rail">
                  <button type="button" aria-pressed={liked} aria-label={liked ? "Unlike" : "Like"} onClick={() => setLiked((v) => !v)} className={liked ? "liked" : ""}>
                    <I n="heart" size={28} filled={liked} />
                    <span>{compact((stats?.likes ?? 0) + (liked ? 1 : 0))}</span>
                  </button>
                  <button type="button" aria-label="Comment">
                    <I n="comment" size={27} />
                    <span>{compact(stats?.comments)}</span>
                  </button>
                  <button type="button" aria-label="Share">
                    <I n="send" size={27} />
                    <span>{compact(stats?.shares)}</span>
                  </button>
                  <button type="button" aria-pressed={saved} aria-label={saved ? "Remove from saved" : "Save"} onClick={() => setSaved((v) => !v)}>
                    <I n="save" size={26} filled={saved} />
                    <span>{stats?.saves != null ? compact(stats.saves + (saved ? 1 : 0)) : ""}</span>
                  </button>
                  <button type="button" aria-label="More options">
                    <I n="more" size={24} />
                  </button>
                  <span className="ig-audiotile" aria-hidden="true">
                    {posterSrc ? <img src={posterSrc} alt="" /> : <I n="note" size={14} />}
                  </span>
                </div>

                <div className="ig-info">
                  <div className="ig-userrow">
                    <Avatar handle={handle} size={34} ring />
                    <strong className="ig-user">{handle}</strong>
                    <button type="button" className="ig-follow">
                      Follow
                    </button>
                  </div>
                  <div className={`ig-caption${more ? " open" : ""}`}>
                    {more ? (
                      <p>
                        {text}{" "}
                        <button type="button" className="ig-more" onClick={() => setMore(false)}>
                          less
                        </button>
                      </p>
                    ) : (
                      <p>
                        {short}
                        {hasMore ? (
                          <>
                            {" "}
                            <button type="button" className="ig-more" onClick={() => setMore(true)}>
                              more
                            </button>
                          </>
                        ) : null}
                      </p>
                    )}
                  </div>
                  <div className="ig-audio">
                    <I n="note" size={13} />
                    <span>
                      <b>{handle}</b> · Original audio
                    </span>
                  </div>
                </div>
                <BottomNav active="reels" handle={handle} />
              </>
            ) : (
              <>
                <StatusBar />
                <div className="ig-prof-top">
                  <span className="ig-prof-name">
                    {handle} <I n="chev" size={14} />
                  </span>
                  <span className="ig-prof-icons">
                    <I n="plus" size={24} />
                    <I n="menu" size={24} />
                  </span>
                </div>
                <div className="ig-prof-scroll">
                  <div className="ig-prof-head">
                    <Avatar handle={handle} size={82} ring />
                    <dl className="ig-stats">
                      <div>
                        <dt>posts</dt>
                        <dd>1</dd>
                      </div>
                      <div>
                        <dt>followers</dt>
                        <dd>—</dd>
                      </div>
                      <div>
                        <dt>following</dt>
                        <dd>—</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="ig-bio">
                    <strong>{business || handle}</strong>
                    <span className="ig-cat">Shop</span>
                    {offer ? <span>{offer}</span> : null}
                  </div>
                  <div className="ig-prof-btns">
                    <button type="button">Edit profile</button>
                    <button type="button">Share profile</button>
                  </div>
                  <div className="ig-prof-tabs" aria-hidden="true">
                    <span className="on">
                      <I n="grid" size={24} />
                    </span>
                    <span>
                      <I n="reels" size={24} />
                    </span>
                    <span>
                      <I n="tag" size={24} />
                    </span>
                  </div>
                  <ul className="ig-grid" aria-label="Posts on the profile, newest first">
                    <li className="ig-cell newest">
                      {videoSrc ? (
                        posterSrc ? (
                          <img src={posterSrc} alt="Reel thumbnail, newest post" />
                        ) : (
                          <video src={`${videoSrc}#t=0.6`} muted playsInline preload="metadata" aria-label="Reel thumbnail, newest post" />
                        )
                      ) : (
                        <span className="ig-cellempty" />
                      )}
                      <span className="ig-cellreel" aria-hidden="true">
                        <I n="reels" size={17} />
                      </span>
                      {stats?.plays != null ? (
                        <span className="ig-cellplays" aria-hidden="true">
                          <I n="play" size={12} /> {compact(stats.plays)}
                        </span>
                      ) : null}
                      <span className="ig-newtag">Not posted</span>
                    </li>
                    {[0, 1, 2, 3, 4].map((i) => (
                      <li key={i} className="ig-cell blank" aria-hidden="true" />
                    ))}
                  </ul>
                </div>
                <BottomNav active="profile" handle={handle} />
              </>
            )}
          </div>
        </div>
      </div>
      <ul className="ig-legend">
        <li>
          <strong>Reel</strong> is how the video plays in the Reels tab. It starts muted, as Instagram does; use the speaker
          button to hear the narration.
        </li>
        <li>
          <strong>Profile grid</strong> shows the reel as the newest post, with a reel badge.
        </li>
        <li>
          Counters show zero until there is something real to show. Nothing here comes from Instagram.
        </li>
      </ul>
      </div>
    </section>
  );
}

/** ?sim=instagram: standalone page using a recorded landing reel so the mock can be inspected without a login. */
export function InstagramSim() {
  const base = "/landing/reel-sneaker";
  const caption = useMemo(
    () =>
      "Stride Lane drops the white running sneaker with sage green panels this Saturday, Nov 7, 10am to 4pm ET. $89.00. Message us to reserve a pair.",
    [],
  );
  return (
    <div className="ig-simpage">
      <InstagramPreview
        videoSrc={`${base}.mp4`}
        posterSrc={`${base}.jpg`}
        caption={caption}
        business="Stride Lane"
        offer="White running sneaker, sage green panels"
        note="This page uses a recorded demo reel (silent), not a reel generated for your campaign."
      />
    </div>
  );
}
