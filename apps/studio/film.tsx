import React, { useEffect, useRef, useState, type RefObject } from "react";
import "./reel.css";

/**
 * Studio-film constants, mirrored from the render contract (Addendum 3).
 * Studio never imports server code: if the renderer changes these, change them here too.
 *   shot k occupies [k * FILM_DURATION, (k + 1) * FILM_DURATION)
 *   the facts end card is on screen from FACTS_VISIBLE_FROM (7.6 s); we seek a little
 *   later (8.0 s) so the text block is fully faded in.
 */
export const FILM_DURATION = 10;
export const FILM_FACTS_SEEK = 8.0;

/** True only when the campaign trace says every product's reel shot used the film layout. */
export function usesFilmLayout(campaign: unknown): boolean {
  const g = (campaign as any)?.generation;
  const l = g && typeof g === "object" ? g.reelLayout : undefined;
  return (
    Array.isArray(l) && l.length > 0 && l.length <= 50 && l.every((x) => x === "film")
  );
}

/** Seek position (seconds) for a reel shot; the old behaviour when the film layout is not in use. */
export function shotSeek(
  film: boolean,
  shot: number,
  legacyStart: number | undefined,
): number | undefined {
  if (film && Number.isInteger(shot) && shot >= 0 && shot < 50)
    return shot * FILM_DURATION + FILM_FACTS_SEEK;
  return legacyStart;
}

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Autoplay a muted, looping preview while the video is mostly on screen.
 * Never autoplays under prefers-reduced-motion (the native controls stay).
 * `enabled=false` leaves playback entirely to the user.
 */
export function useAutoplayInView(
  ref: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  key?: unknown,
) {
  const wasAuto = useRef(false);
  useEffect(() => {
    const v = ref.current;
    if (!v || !enabled || prefersReducedMotion()) return;
    if (typeof IntersectionObserver !== "function") return;
    v.muted = true;
    v.loop = true;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!ref.current) return;
        if (e.isIntersecting && e.intersectionRatio >= 0.5) {
          if (ref.current.paused) {
            wasAuto.current = true;
            ref.current.play().catch(() => {
              /* autoplay refused: the controls remain */
            });
          }
        } else if (wasAuto.current && !ref.current.paused) {
          ref.current.pause();
          wasAuto.current = false;
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [ref, enabled, key]);
}

/** A reel <video> that autoplays muted and looping while on screen (not under reduced motion). */
export function AutoReel(props: React.VideoHTMLAttributes<HTMLVideoElement>) {
  const ref = useRef<HTMLVideoElement>(null);
  useAutoplayInView(ref, true, props.src);
  return <video ref={ref} muted loop playsInline {...props} />;
}

type Narration = { text?: string; voice?: string; model?: string; credits?: number; cached?: boolean; source?: string };
type AudioInfo = { mix?: string; reason?: string };

/**
 * The Final reel player: an autoplaying muted preview with a clear unmute control (browsers only
 * allow muted autoplay) and a line saying where the narration came from (campaign.generation).
 * The video keeps aria-label "Final reel ..." (scripts/record-demo.mjs finds it by that prefix).
 */
export function ReelPlayer({
  generation,
  ...video
}: React.VideoHTMLAttributes<HTMLVideoElement> & { generation?: unknown }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  useAutoplayInView(ref, true, video.src);
  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted, video.src]);
  const g = (generation ?? {}) as { narration?: Narration; audio?: AudioInfo; warnings?: string[] };
  const n = g.narration;
  const mix = g.audio?.mix;
  const hasSound = mix ? mix === "voice+bed" || mix === "bed" : !!n;
  return (
    <div className="reel-player">
      <div className="reel-frame">
        <video
          ref={ref}
          muted
          loop
          playsInline
          {...video}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        />
        {hasSound ? (
          <button
            type="button"
            className={`reel-unmute${muted ? "" : " on"}`}
            aria-pressed={!muted}
            onClick={() => {
              const next = !muted;
              setMuted(next);
              if (!next) ref.current?.play().catch(() => undefined);
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3 9.5v5h3.6L11.5 19V5L6.6 9.5Z" fill="currentColor" />
              {muted ? (
                <path d="m15.5 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              ) : (
                <path d="M15.3 8.7a4.600 4.600 0 0 1 0 6.600M17.800 6.200a8 8 0 0 1 0 11.600" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              )}
            </svg>
            {muted ? "Sound off · unmute" : "Sound on · mute"}
          </button>
        ) : null}
      </div>
      {n?.text || mix ? (
        <div className="reel-narration" role="group" aria-label="Reel audio">
          {n?.text ? (
            <>
              <p className="reel-credit">
                {n.source === "wonder"
                  ? "Narration written by Muse Wonder, voiced by ElevenLabs"
                  : "Narration from a fixed template built from your confirmed facts, voiced by ElevenLabs"}
              </p>
              <blockquote>{n.text}</blockquote>
              <p className="reel-meta">
                {[n.voice ? `voice ${n.voice}` : "", n.model ?? "", typeof n.credits === "number" ? `${n.credits} credits` : "", n.cached ? "cached clip" : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </>
          ) : null}
          {mix && mix !== "voice+bed" ? (
            <p className="reel-note">
              {mix === "bed" ? "Music bed only, no spoken narration." : mix === "silent" ? "This reel is silent." : "Audio was skipped for this reel."}
              {g.audio?.reason ? ` ${g.audio.reason}` : ""}
            </p>
          ) : null}
          {g.warnings?.length ? <p className="reel-note">{g.warnings.join(" ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
