import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Campaign, Narration } from "../packages/campaign/index.ts";
import type { MuseGateway } from "../packages/meta/gateway.ts";
import { NARRATION_VOICE, planNarration } from "../packages/meta/narration.ts";
import { muxAudio } from "../packages/renderers/audio.ts";
import type { Store } from "./store.ts";

export type ReelAudio = {
  bytes: Buffer;
  probe: unknown;
  narration?: Narration;
  audio: NonNullable<NonNullable<Campaign["generation"]>["audio"]>;
  warnings: string[];
};

const msg = (e: unknown) =>
  (e instanceof Error ? e.message : "failed").replace(/\s+/g, " ").slice(0, 200);

/**
 * Add the narration + music bed to a finished (silent) reel.
 *
 * Never throws and never fails the generation: if the gateway voice call fails
 * (or credits are short) the reel gets the bed alone and a warning; if muxing
 * itself fails the original silent reel is returned with a warning. The voice
 * gateway is called exactly once per attempt (no retries: it spends credits).
 */
export async function addReelAudio(
  store: Store,
  gateway: MuseGateway,
  c: Campaign,
  dir: string,
  rendered: { bytes: Buffer; probe: unknown },
  subject?: string,
): Promise<ReelAudio> {
  const warnings: string[] = [];
  const silent = (reason: string): ReelAudio => ({
    bytes: rendered.bytes,
    probe: rendered.probe,
    audio: { mix: "silent", reason },
    warnings: [...warnings, reason],
  });
  let planned;
  let input: string;
  try {
    await mkdir(dir, { recursive: true });
    input = path.join(dir, "reel-silent.mp4");
    await writeFile(input, rendered.bytes);
    planned = await planNarration(store, gateway, c, subject);
  } catch (e) {
    return silent(`Reel audio unavailable: ${msg(e)}`);
  }
  let voicePath: string | undefined;
  let spoken: Awaited<ReturnType<MuseGateway["speak"]>> | undefined;
  try {
    spoken = await gateway.speak(planned.text, NARRATION_VOICE);
    voicePath = path.join(dir, "narration.mp3");
    await writeFile(voicePath, spoken.audio);
  } catch (e) {
    voicePath = undefined;
    spoken = undefined;
    warnings.push(
      `Narration voice unavailable (${msg(e)}); the reel has the music bed only.`,
    );
  }
  const out = path.join(dir, "reel-final.mp4");
  try {
    let mixed;
    try {
      mixed = await muxAudio({ video: input, voice: voicePath, out });
    } catch (e) {
      if (!voicePath) throw e;
      // The clip could not be mixed: deliver the bed alone rather than nothing.
      warnings.push(`Narration could not be mixed (${msg(e)}); the reel has the music bed only.`);
      voicePath = undefined;
      spoken = undefined;
      mixed = await muxAudio({ video: input, out });
    }
    return {
      bytes: mixed.bytes,
      probe: mixed.probe,
      audio: { mix: mixed.mix, ...(warnings.length ? { reason: warnings[0] } : {}) },
      warnings,
      ...(spoken
        ? {
            narration: {
              text: planned.text,
              voice: NARRATION_VOICE,
              model: spoken.model,
              credits: spoken.credits,
              cached: spoken.cached,
              source: planned.source,
              textCached: planned.textCached,
              textModel: planned.textModel,
              ...(planned.fallbackReason
                ? { fallbackReason: planned.fallbackReason }
                : {}),
            },
          }
        : {}),
    };
  } catch (e) {
    warnings.push(`Reel audio mix failed (${msg(e)}); delivered without audio.`);
    return {
      bytes: rendered.bytes,
      probe: rendered.probe,
      audio: { mix: "silent", reason: warnings[warnings.length - 1] },
      warnings,
    };
  }
}
