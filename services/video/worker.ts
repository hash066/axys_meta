import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const Receipt = z
  .object({
    requestId: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    seed: z.number().int().nonnegative(),
    seconds: z.number().positive().max(8),
    width: z.number().int().positive().max(2160),
    height: z.number().int().positive().max(2160),
    provider: z.string().min(1).max(80),
    costUsd: z.number().nonnegative().max(100),
    costBasis: z.enum(["provider-billed", "runtime-estimate"]),
    gpuMilliseconds: z.number().int().nonnegative().max(86_400_000).optional(),
    gpuMeasurement: z
      .enum(["provider-receipt", "allocated-wall-clock"])
      .optional(),
  })
  .strict();

export type GeneratedClip = z.infer<typeof Receipt> & {
  bytes: Buffer;
  sha256: string;
};

export type VideoGenerationInput = {
  image: Buffer;
  prompt: string;
  seed: number;
  seconds: number;
  maxCostUsd?: number;
};

function configuredWorker() {
  const raw = process.env.AXYS_VIDEO_WORKER_URL;
  const token = process.env.AXYS_VIDEO_WORKER_TOKEN;
  const maxCostUsd = Number(process.env.AXYS_VIDEO_WORKER_REQUEST_MAX_USD);
  const campaignMaxUsd = Number(process.env.AXYS_VIDEO_WORKER_CAMPAIGN_MAX_USD);
  if (
    !raw &&
    !token &&
    !process.env.AXYS_VIDEO_WORKER_REQUEST_MAX_USD &&
    !process.env.AXYS_VIDEO_WORKER_CAMPAIGN_MAX_USD
  )
    return;
  if (!raw || !token)
    throw new Error("Video worker configuration is incomplete");
  const url = new URL("/v1/image-to-video", raw);
  if (
    url.protocol !== "https:" ||
    token.length < 32 ||
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd <= 0 ||
    maxCostUsd > 5 ||
    !Number.isFinite(campaignMaxUsd) ||
    campaignMaxUsd < maxCostUsd ||
    campaignMaxUsd > 20
  )
    throw new Error(
      "Video worker requires HTTPS, a strong token, a $0.01–$5 request cap, and a bounded campaign cap",
    );
  return { url, token, maxCostUsd, campaignMaxUsd };
}

export function hasVideoWorker() {
  return Boolean(configuredWorker());
}

export function videoCampaignCap() {
  const worker = configuredWorker();
  if (!worker) throw new Error("Online video generation is not configured");
  return worker.campaignMaxUsd;
}

export async function generateClip(input: VideoGenerationInput) {
  const worker = configuredWorker();
  if (!worker) throw new Error("Online video generation is not configured");
  if (input.image.length < 1 || input.image.length > 12 * 1024 * 1024)
    throw new Error("Video source image must be at most 12 MB");
  if (!input.prompt.trim() || input.prompt.length > 1200)
    throw new Error("Video motion prompt is invalid");
  if (!Number.isInteger(input.seed) || input.seed < 0)
    throw new Error("Video seed is invalid");
  if (input.seconds < 2 || input.seconds > 8)
    throw new Error("Video duration must be between 2 and 8 seconds");
  const authorizedCost = Math.min(
    worker.maxCostUsd,
    input.maxCostUsd ?? worker.maxCostUsd,
  );
  if (!Number.isFinite(authorizedCost) || authorizedCost <= 0)
    throw new Error("No video generation budget remains");
  const body = JSON.stringify({
    imageBase64: input.image.toString("base64"),
    prompt: input.prompt,
    negativePrompt:
      "text, logo, watermark, duplicate product, deformed product, changed packaging, changed color, extra objects",
    seed: input.seed,
    seconds: input.seconds,
    aspectRatio: "9:16",
    preserveFirstFrame: true,
    maxCostUsd: authorizedCost,
  });
  const signature = createHmac("sha256", worker.token)
    .update(body)
    .digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
  try {
    const response = await fetch(worker.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${worker.token}`,
        "content-type": "application/json",
        "x-axys-signature": `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Video worker failed with HTTP ${response.status}`);
    const declared = response.headers.get("x-axys-video-sha256") || "";
    const receiptHeader = response.headers.get("x-axys-video-receipt");
    const receiptSignature =
      response.headers.get("x-axys-receipt-signature") || "";
    if (
      !/^[a-f0-9]{64}$/.test(declared) ||
      !receiptHeader ||
      !/^sha256=[a-f0-9]{64}$/.test(receiptSignature)
    )
      throw new Error("Video worker response is missing its integrity receipt");
    const expectedReceiptSignature = `sha256=${createHmac(
      "sha256",
      worker.token,
    )
      .update(`${declared}.${receiptHeader}`)
      .digest("hex")}`;
    if (
      !timingSafeEqual(
        Buffer.from(receiptSignature),
        Buffer.from(expectedReceiptSignature),
      )
    )
      throw new Error("Video worker receipt signature is invalid");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 100 * 1024 * 1024)
      throw new Error("Generated video exceeds the 100 MB limit");
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (
      !timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(declared, "hex"))
    )
      throw new Error("Generated video does not match its integrity receipt");
    const receipt = Receipt.parse(
      JSON.parse(Buffer.from(receiptHeader, "base64url").toString("utf8")),
    );
    if (
      receipt.seed !== input.seed ||
      receipt.seconds !== input.seconds ||
      receipt.width / receipt.height !== 704 / 1280
    )
      throw new Error("Video worker receipt does not match the requested shot");
    if (receipt.costUsd > authorizedCost)
      throw new Error("Video worker exceeded the authorized request cost");
    return { ...receipt, bytes, sha256: actual } satisfies GeneratedClip;
  } finally {
    clearTimeout(timer);
  }
}
