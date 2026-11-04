import http from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

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
};
export async function startFakeGateway(options: FakeOptions = {}) {
  const calls: {
    route: string;
    body?: any;
    fields?: Record<string, string>;
  }[] = [];
  const state = { ...options };
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
      if (route === "/v1/transcribe") {
        calls.push({ route, body: { bytes: raw.length } });
        return send(200, { transcript: state.transcript ?? "hello world" });
      }
      if (route === "/v1/segment" || route === "/v1/scene") {
        const form = await new Response(raw, {
          headers: { "content-type": String(req.headers["content-type"]) },
        }).formData();
        const fields: Record<string, string> = {};
        for (const [k, v] of form.entries())
          fields[k] = typeof v === "string" ? v : `file:${v.size}`;
        calls.push({ route, fields });
        if (route === "/v1/segment") {
          const found = state.segmentFound !== false;
          return send(200, {
            found,
            concept: fields.concept,
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
      if (route === "/v1/json") {
        const body = JSON.parse(raw.toString("utf8"));
        calls.push({ route, body });
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
