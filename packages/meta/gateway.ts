import { z } from "zod";

/**
 * Typed client for the Muse gateway (Python FastAPI, the only process that
 * holds MODEL_API_KEY and talks to api.meta.ai). See docs/META_CONTRACT.md.
 * Every response is zod-validated; errors are mapped to clear messages and the
 * client never fabricates a result.
 */
export type GatewayErrorCode =
  | "config"
  | "unavailable"
  | "timeout"
  | "no_key"
  | "upstream"
  | "bad_request"
  | "bad_response";

export class GatewayError extends Error {
  constructor(
    message: string,
    public code: GatewayErrorCode,
    public status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8766";
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const Health = z.object({
  key_configured: z.boolean(),
  models: z.record(z.string(), z.string()),
});
const Transcript = z.object({ transcript: z.string().max(20000) });
const Segment = z.object({
  found: z.boolean(),
  concept: z.string().max(200),
  coverage: z.number().min(0).max(1),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  overlay_png_b64: z.string().nullable(),
  cutout_png_b64: z.string().nullable(),
});
const Scene = z.object({
  image_png_b64: z.string().min(1),
  fidelity: z.object({
    faithful: z.boolean().nullable(),
    differences: z.array(z.string().max(500)).max(20),
  }),
});
const Plate = z.object({ image_png_b64: z.string().min(1) });
const Speak = z.object({
  audio_mp3_b64: z.string().min(1),
  cached: z.boolean(),
  credits_charged: z.number().min(0),
  voice_id: z.string().max(100),
  model: z.string().max(100),
});
const MAX_MP3_BYTES = 4 * 1024 * 1024;
const JsonReply = z.object({
  json: z.record(z.string(), z.unknown()),
  model: z.string().max(100),
});

export type GatewayHealth = z.infer<typeof Health>;
export type SegmentResult = {
  found: boolean;
  concept: string;
  coverage: number;
  bbox: [number, number, number, number] | null;
  size: [number, number];
  overlay: Buffer | null;
  cutout: Buffer | null;
};
export type SceneResult = {
  image: Buffer;
  faithful: boolean | null;
  differences: string[];
};
export type SpeakResult = {
  audio: Buffer;
  cached: boolean;
  credits: number;
  voiceId: string;
  model: string;
};
export type JsonRequest = {
  model: "wonder" | "spark";
  prompt: string;
  imagesB64?: string[];
  effort?: "minimal" | "low" | "medium" | "high";
};

export function decodePng(b64: string, what: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length > MAX_IMAGE_BYTES * 1.4)
    throw new GatewayError(
      `Muse gateway returned an invalid ${what}`,
      "bad_response",
    );
  const bytes = Buffer.from(b64, "base64");
  if (
    bytes.length < 16 ||
    bytes.length > MAX_IMAGE_BYTES ||
    !bytes.subarray(0, 8).equals(PNG_MAGIC)
  )
    throw new GatewayError(
      `Muse gateway returned an invalid ${what}`,
      "bad_response",
    );
  return bytes;
}

export class MuseGateway {
  constructor(
    private options: { baseUrl?: string; fetch?: typeof fetch } = {},
  ) {}
  get baseUrl() {
    const raw = (
      this.options.baseUrl ||
      process.env.MUSE_GATEWAY_URL ||
      DEFAULT_GATEWAY_URL
    ).trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new GatewayError("MUSE_GATEWAY_URL is not a valid URL", "config");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new GatewayError(
        "MUSE_GATEWAY_URL must be an http(s) URL without credentials, query or fragment",
        "config",
      );
    return url.href.replace(/\/+$/, "");
  }
  private async call<T>(
    route: string,
    init: RequestInit,
    timeoutMs: number,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const doFetch = this.options.fetch || fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.baseUrl}${route}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      const name = (e as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError")
        throw new GatewayError(
          `Muse gateway did not answer within ${Math.round(timeoutMs / 1000)}s`,
          "timeout",
        );
      throw new GatewayError(
        "Muse gateway is not reachable. Start it (python gateway) or set MUSE_GATEWAY_URL.",
        "unavailable",
      );
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_RESPONSE_BYTES)
      throw new GatewayError(
        "Muse gateway response is too large",
        "bad_response",
      );
    let text: string;
    try {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_RESPONSE_BYTES)
        throw new GatewayError(
          "Muse gateway response is too large",
          "bad_response",
        );
      text = buffer.toString("utf8");
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      throw new GatewayError(
        "Muse gateway closed the connection before responding",
        "unavailable",
      );
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const err = body && typeof body === "object" ? (body as any).error : "";
      const detail =
        typeof err === "string"
          ? err
          : typeof err?.message === "string"
            ? err.message
            : "";
      const clean = detail.replace(/[\r\n]+/g, " ").slice(0, 300);
      if (response.status === 503)
        throw new GatewayError(
          clean || "Muse gateway has no model API key configured",
          "no_key",
          503,
        );
      throw new GatewayError(
        `Muse gateway error (${response.status})${clean ? `: ${clean}` : ""}`,
        response.status >= 400 && response.status < 500
          ? "bad_request"
          : "upstream",
        response.status,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new GatewayError(
        "Muse gateway returned an unexpected response shape",
        "bad_response",
      );
    return parsed.data;
  }
  health() {
    return this.call("/v1/health", { method: "GET" }, 3000, Health);
  }
  async transcribe(pcm16: Buffer) {
    if (!pcm16.length || pcm16.length % 2)
      throw new GatewayError("Audio must be 16-bit PCM", "bad_request");
    const r = await this.call(
      "/v1/transcribe",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(pcm16),
      },
      45000,
      Transcript,
    );
    return r.transcript.trim();
  }
  async segment(image: Buffer, concept: string): Promise<SegmentResult> {
    const form = new FormData();
    form.set("image", new Blob([new Uint8Array(image)]), "image");
    form.set("concept", concept.slice(0, 200));
    const r = await this.call(
      "/v1/segment",
      { method: "POST", body: form },
      90000,
      Segment,
    );
    return {
      found: r.found,
      concept: r.concept,
      coverage: r.coverage,
      bbox: r.bbox,
      size: r.size,
      overlay: r.overlay_png_b64
        ? decodePng(r.overlay_png_b64, "overlay")
        : null,
      cutout: r.cutout_png_b64 ? decodePng(r.cutout_png_b64, "cutout") : null,
    };
  }
  /** Union of several concepts (the product plus its visible parts) cut out as one piece. */
  async segmentMulti(image: Buffer, concepts: string[]): Promise<SegmentResult> {
    const list = concepts.map((c) => c.trim().slice(0, 80)).filter(Boolean).slice(0, 4);
    if (!list.length)
      throw new GatewayError("At least one concept is required", "bad_request");
    const form = new FormData();
    form.set("image", new Blob([new Uint8Array(image)]), "image");
    form.set("concepts", JSON.stringify(list));
    const r = await this.call(
      "/v1/segment_multi",
      { method: "POST", body: form },
      150000,
      Segment,
    );
    return {
      found: r.found,
      concept: r.concept,
      coverage: r.coverage,
      bbox: r.bbox,
      size: r.size,
      overlay: r.overlay_png_b64 ? decodePng(r.overlay_png_b64, "overlay") : null,
      cutout: r.cutout_png_b64 ? decodePng(r.cutout_png_b64, "cutout") : null,
    };
  }
  async scene(image: Buffer, scene: string): Promise<SceneResult> {
    const form = new FormData();
    form.set("image", new Blob([new Uint8Array(image)]), "image");
    form.set("scene", scene.slice(0, 1000));
    const r = await this.call(
      "/v1/scene",
      { method: "POST", body: form },
      180000,
      Scene,
    );
    return {
      image: decodePng(r.image_png_b64, "scene image"),
      faithful: r.fidelity.faithful,
      differences: r.fidelity.differences,
    };
  }
  /** Text-only Muse Image call: a product-free backdrop (PNG) for compositing. */
  async plate(backdrop: string): Promise<Buffer> {
    const text = backdrop.replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 300)
      throw new GatewayError(
        "Backdrop description must be 3 to 300 characters",
        "bad_request",
      );
    const r = await this.call(
      "/v1/plate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backdrop: text }),
      },
      180000,
      Plate,
    );
    return decodePng(r.image_png_b64, "backdrop plate");
  }
  /**
   * Spoken audio (ElevenLabs behind the gateway; Meta's API has no speech model).
   * SPENDS REAL CREDITS unless the gateway has the clip cached. Callers must not
   * loop or retry. Throws GatewayError on any failure; never fabricates audio.
   */
  async speak(text: string, voice = "reel"): Promise<SpeakResult> {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 400)
      throw new GatewayError("Spoken text must be 1 to 400 characters", "bad_request");
    const r = await this.call(
      "/v1/speak",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean, voice }),
      },
      60000,
      Speak,
    );
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(r.audio_mp3_b64))
      throw new GatewayError("Muse gateway returned invalid audio", "bad_response");
    const audio = Buffer.from(r.audio_mp3_b64, "base64");
    const mp3 =
      audio.subarray(0, 3).toString() === "ID3" ||
      (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
    if (audio.length < 16 || audio.length > MAX_MP3_BYTES || !mp3)
      throw new GatewayError("Muse gateway returned invalid audio", "bad_response");
    return {
      audio,
      cached: r.cached,
      credits: r.credits_charged,
      voiceId: r.voice_id,
      model: r.model,
    };
  }
  json(request: JsonRequest) {
    if (request.prompt.length > 120000)
      throw new GatewayError("Prompt is too large", "bad_request");
    return this.call(
      "/v1/json",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          prompt: request.prompt,
          ...(request.imagesB64?.length
            ? { images_b64: request.imagesB64 }
            : {}),
          ...(request.effort ? { effort: request.effort } : {}),
        }),
      },
      120000,
      JsonReply,
    );
  }
}

export type MuseStatus = {
  available: boolean;
  keyConfigured: boolean;
  reachable: boolean;
  models: Record<string, string>;
  error?: string;
};
let cached: { at: number; key: string; value: MuseStatus } | undefined;
/** Health probe for capabilities/public-config. Cached 5s; never throws. */
export async function museStatus(gateway: MuseGateway): Promise<MuseStatus> {
  let key = "";
  try {
    key = gateway.baseUrl;
  } catch (e) {
    return {
      available: false,
      keyConfigured: false,
      reachable: false,
      models: {},
      error: (e as Error).message,
    };
  }
  if (cached && cached.key === key && Date.now() - cached.at < 5000)
    return cached.value;
  let value: MuseStatus;
  try {
    const h = await gateway.health();
    value = {
      available: h.key_configured,
      keyConfigured: h.key_configured,
      reachable: true,
      models: h.models,
      ...(h.key_configured
        ? {}
        : { error: "Muse gateway has no model API key" }),
    };
  } catch (e) {
    value = {
      available: false,
      keyConfigured: false,
      reachable: false,
      models: {},
      error: e instanceof Error ? e.message : "Muse gateway check failed",
    };
  }
  cached = { at: Date.now(), key, value };
  return value;
}
export function resetMuseStatusCache() {
  cached = undefined;
}
