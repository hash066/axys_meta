import http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { spawnSync } from "node:child_process";

let mp3Cache: Buffer | undefined;
/** A tiny real mp3 (a 1.5 s tone), synthesised once with ffmpeg. Never a network call. */
export function tinyMp3() {
  if (!mp3Cache) {
    const r = spawnSync(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v", "error", "-f", "lavfi", "-i", "sine=f=220:d=1.5:r=44100",
        "-ac", "1", "-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3", "pipe:1",
      ],
      { maxBuffer: 1 << 24 },
    );
    if (r.status !== 0 || !r.stdout?.length)
      throw new Error("fake gateway could not synthesise an mp3");
    mp3Cache = Buffer.from(r.stdout);
  }
  return mp3Cache;
}

/** Local stand-in for the Muse gateway. Never talks to api.meta.ai. */
export async function png(
  color = "#cc3322",
  w = 400,
  h = 400,
  transparent = true,
) {
  const rect = `<rect x="${w / 4}" y="${h / 4}" width="${w / 2}" height="${h / 2}" fill="${color}"/>`;
  return sharp(
    Buffer.from(
      `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${transparent ? "" : `<rect width="${w}" height="${h}" fill="#ddd"/>`}${rect}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}

export type FakeOptions = {
  keyConfigured?: boolean;
  segmentFound?: boolean;
  faithful?: boolean | null;
  transcript?: string;
  json?: (body: any) => unknown;
  failScene?: boolean;
  failJson?: boolean;
  failPlate?: boolean;
  /** Reply to the Muse Spark vision "PRODUCT DIRECTION" call (default: a valid direction). */
  direction?: unknown | ((body: any) => unknown);
  failDirection?: boolean;
  failSegmentMulti?: boolean;
  /** Reply to the Muse Wonder narration call: a text, or a function of the request body. */
  narration?: string | ((body: any) => unknown);
  /** /v1/speak answers with this HTTP status instead of audio (for example 402 = credits short). */
  failSpeak?: number;
};

/** A well-formed direction as Muse Spark would return it. */
export const GOOD_DIRECTION = {
  category: "homeware",
  subject: "ceramic mug",
  descriptors: ["glazed", "rounded", "speckled"],
  palette: ["#c8b79a", "#7a5c3e"],
  mood: "earthy",
  motion: "calm",
  worlds: [
    { purpose: "hero", backdrop: "a seamless warm studio wall with soft gradient light" },
    { purpose: "context", backdrop: "a sunlit wooden kitchen counter against a plaster wall" },
    { purpose: "detail", backdrop: "a close view of rough speckled stoneware texture in soft raking light" },
  ],
  phrases: ["Made by hand", "Morning ritual"],
};
export async function startFakeGateway(options: FakeOptions = {}) {
  const calls: {
    route: string;
    body?: any;
    fields?: Record<string, string>;
  }[] = [];
  const state = { ...options };
  /** (voice|text) pairs already voiced: the real gateway serves those from its clip cache for free. */
  const voiced = new Set<string>();
  const cutout = (await png()).toString("base64");
  const overlay = (await png("#2233cc", 400, 400, false)).toString("base64");
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const route = req.url || "";
      if (route === "/v1/health")
        return send(200, {
          key_configured: state.keyConfigured !== false,
          models: {
            spark: "muse-spark-1.3",
            wonder: "muse-wonder-1.0",
            image: "muse-image-1.0",
            sam: "sam-3.1",
            voice: "muse-voice-transcribe-1.0",
          },
        });
      if (state.keyConfigured === false)
        return send(503, { error: "MODEL_API_KEY is not configured" });
      if (route === "/v1/speak") {
        const body = JSON.parse(raw.toString("utf8"));
        calls.push({ route, body });
        if (state.failSpeak)
          return send(state.failSpeak, { error: "Not enough ElevenLabs credits left (fake)" });
        const key = `${body.voice}|${body.text}`;
        const cached = voiced.has(key);
        voiced.add(key);
        return send(200, {
          audio_mp3_b64: tinyMp3().toString("base64"),
          cached,
          credits_charged: cached ? 0 : String(body.text).length * 0.5,
          voice_id: "fakevoice0000000000",
          model: "eleven_flash_v2_5",
        });
      }
      if (route === "/v1/transcribe") {
        calls.push({ route, body: { bytes: raw.length } });
        return send(200, { transcript: state.transcript ?? "hello world" });
      }
      if (route === "/v1/segment" || route === "/v1/segment_multi" || route === "/v1/scene") {
        const form = await new Response(raw, {
          headers: { "content-type": String(req.headers["content-type"]) },
        }).formData();
        const fields: Record<string, string> = {};
        for (const [k, v] of form.entries())
          fields[k] = typeof v === "string" ? v : `file:${v.size}`;
        calls.push({ route, fields });
        if (route === "/v1/segment_multi" && state.failSegmentMulti)
          return send(502, { error: "SAM 3.1: overloaded" });
        if (route === "/v1/segment" || route === "/v1/segment_multi") {
          const found = state.segmentFound !== false;
          return send(200, {
            found,
            concept: fields.concept ?? (fields.concepts ? JSON.parse(fields.concepts).join(" + ") : undefined),
            coverage: found ? 0.31 : 0,
            bbox: found ? [100, 100, 300, 300] : null,
            size: [400, 400],
            overlay_png_b64: found ? overlay : null,
            cutout_png_b64: found ? cutout : null,
          });
        }
        if (state.failScene) return send(502, { error: "image model failed" });
        return send(200, {
          image_png_b64: (await png("#22aa44", 512, 512, false)).toString(
            "base64",
          ),
          fidelity: {
            faithful: state.faithful === undefined ? true : state.faithful,
            differences: state.faithful === false ? ["label differs"] : [],
          },
        });
      }
      if (route === "/v1/plate") {
        const body = JSON.parse(raw.toString("utf8"));
        calls.push({ route, body });
        if (state.failPlate) return send(502, { error: "image model failed" });
        return send(200, {
          image_png_b64: (await png("#b89b72", 540, 960, false)).toString(
            "base64",
          ),
        });
      }
      if (route === "/v1/json") {
        const body = JSON.parse(raw.toString("utf8"));
        calls.push({ route, body });
        if (
          body.model === "spark" &&
          Array.isArray(body.images_b64) &&
          String(body.prompt).startsWith("PRODUCT DIRECTION")
        ) {
          if (state.failDirection)
            return send(502, { error: "spark: model output was not JSON" });
          const d = state.direction;
          return send(200, {
            json:
              typeof d === "function"
                ? (d as (b: any) => unknown)(body)
                : d === undefined
                  ? GOOD_DIRECTION
                  : d,
            model: "muse-spark-1.3",
          });
        }
        if (
          state.narration !== undefined &&
          String(body.prompt).startsWith("You write the voice-over")
        )
          return send(200, {
            json:
              typeof state.narration === "function"
                ? (state.narration as (b: any) => object)(body)
                : { text: state.narration },
            model: "muse-wonder-1.0",
          });
        if (state.failJson)
          return send(502, { error: "model output was not JSON" });
        return send(200, {
          json: (state.json?.(body) as object) ?? { issues: [] },
          model: "muse-wonder-1.0",
        });
      }
      send(404, { error: "no such route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
