import React, { useEffect, useRef, type RefObject } from "react";

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
