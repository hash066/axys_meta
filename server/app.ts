import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { Store } from "./store.ts";
import { Engine, type Asset } from "./engine.ts";
import {
  CampaignInput,
  type Input,
  hash,
  digest,
  type Campaign,
} from "../packages/campaign/index.ts";
import { Site } from "../packages/renderers/Site.tsx";
import {
  equal,
  sign,
  required,
  encrypt,
  decrypt,
  publicOrigin,
} from "./security.ts";
import {
  oauthUrl,
  exchange,
  refresh,
  Meta,
  type Connection,
} from "../services/publishing/meta.ts";
import type { WhatsAppDecision } from "./whatsapp-approval.ts";
import { ingestWhatsApp, type WhatsAppDraft } from "./whatsapp.ts";
import { hermesCommand } from "./hermes.ts";
import { propose, proposeRevision } from "../packages/inference/meta.ts";
import {
  GatewayError,
  MuseGateway,
  museStatus,
} from "../packages/meta/gateway.ts";
import { enrichCampaign, loadEnrichment } from "../packages/meta/enrichment.ts";
import {
  PreflightBlockedError,
  latestPreflight,
  runPreflight,
} from "../packages/meta/preflight.ts";
import {
  CommandError,
  COMMAND_MAX_CHARS,
  forgetVerified,
  parseCommand,
  verifyForApply,
} from "../packages/meta/command.ts";
import { kineticPhraseCheck } from "../packages/meta/direction.ts";
import {
  LAB_SURFACES,
  labCheck,
  labScenarioIds,
  labScenarios,
} from "../packages/meta/lab.ts";
import { installCrmRoutes } from "./crm.ts";

const LabGuess = z
  .object({
    scenarioId: z
      .string()
      .max(40)
      .refine((v) => labScenarioIds().includes(v)),
    guess: z.enum(LAB_SURFACES),
  })
  .strict();
const LabPhrase = z.object({ text: z.string().max(60) }).strict();
import { Credits } from "./credits.ts";
import {
  SAMPLE_PRESET,
  sampleInstagramRecord,
  sampleWebsiteRows,
} from "./sample-insights.ts";
export function createApp(
  store = new Store(),
  options: {
    gateway?: MuseGateway;
    now?: () => number;
    /** Narrate + add a music bed to generated reels (the server entry point enables it). */
    narrate?: boolean;
  } = {},
) {
  const app = express(),
    engine = new Engine(store),
    credits = new Credits(store);
  if (options.gateway) engine.gateway = options.gateway;
  engine.narrate = options.narrate ?? false;
  /** Demo-only sample insights (clearly labelled, never Instagram data). Read per request. */
  const demoSamples = () => process.env.AXYS_DEMO_SAMPLES === "true";
  const gateway = () => engine.gateway;
  const clock = () => (options.now ? options.now() : Date.now());
  /** New Meta routes answer `{data: X}` like the rest of the API and also
   * expose X's fields at the top level, matching docs/META_CONTRACT.md. */
  const reply = (res: express.Response, body: object, status = 200) =>
    res.status(status).json({ data: body, ...body });
  const origin = process.env.AXYS_ORIGIN || "http://127.0.0.1:4310";
  const production = process.env.NODE_ENV === "production";
  app.disable("x-powered-by");
  // Behind a reverse proxy (Caddy in compose.yaml) the real client address is in
  // X-Forwarded-For; without this every visitor shares the proxy's rate-limit bucket.
  if (process.env.AXYS_TRUST_PROXY)
    app.set("trust proxy", Number(process.env.AXYS_TRUST_PROXY) || 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "blob:", "data:"],
          mediaSrc: ["'self'", "blob:"],
          frameSrc: ["'self'"],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 150,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  const sessions = (req: express.Request) => {
    const id = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("axys_session="))
      ?.slice(13);
    if (!id) return;
    const session = store.get<{ tenant: string; expires: number }>(
      "session",
      "system",
      hash(id),
    );
    return session && session.expires > Date.now()
      ? { ...session, id }
      : undefined;
  };
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== origin
    )
      return res.status(403).json({
        error: {
          code: "origin",
          message: "Request origin is not authorized",
        },
      });
    next();
  });
  app.post(
    "/internal/hermes/tool",
    express.json({ limit: "32kb" }),
    (req, res) => {
      const key = process.env.AXYS_HERMES_BRIDGE_KEY;
      if (
        !key ||
        key.length < 32 ||
        !equal(String(req.headers.authorization || ""), `Bearer ${key}`)
      )
        return res.sendStatus(403);
      try {
        return res.json(
          hermesCommand(
            store,
            req.body,
            JSON.parse(required("WHATSAPP_TENANT_MAP")),
          ),
        );
      } catch {
        return res.status(400).json({
          status: "unavailable",
          customerMessage:
            "This action is unavailable. Please check Axys Studio.",
        });
      }
    },
  );
  app.get("/webhooks/whatsapp", (req, res) => {
    if (
      !process.env.WHATSAPP_VERIFY_TOKEN ||
      !equal(
        String(req.query["hub.verify_token"] || ""),
        process.env.WHATSAPP_VERIFY_TOKEN,
      )
    )
      return res.sendStatus(403);
    res.send(String(req.query["hub.challenge"] || ""));
  });
  app.post(
    "/webhooks/whatsapp",
    express.raw({ type: "application/json", limit: "100kb" }),
    (req, res) => {
      const result = ingestWhatsApp(
        store,
        req.body,
        String(req.headers["x-hub-signature-256"] || ""),
        required("WHATSAPP_APP_SECRET"),
        JSON.parse(required("WHATSAPP_TENANT_MAP")),
        process.env.WHATSAPP_PHONE_NUMBER_ID,
        process.env.WHATSAPP_APP_SECRET,
      );
      res.json(result);
    },
  );
  app.use(
    ["/api/v1/assets", "/api/v1/audio", "/api/v1/voice"],
    (req, res, next) => {
      if (!sessions(req))
        return res.status(401).json({
          error: { code: "auth", message: "Sign in before uploading media" },
        });
      next();
    },
  );
  // Spend-bearing Muse routes get a tighter per-IP limit than the global one.
  const museLimit = rateLimit({
    windowMs: 60000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(
    ["/api/v1/voice", /^\/api\/v1\/campaigns\/[^/]+\/(enrich|preflight|command)$/],
    museLimit,
  );
  // 16 kHz mono PCM16, at most 60 s.
  const MAX_PCM_BYTES = 60 * 16000 * 2;
  app.post(
    "/api/v1/voice/transcribe",
    express.raw({
      type: ["application/octet-stream", "audio/pcm", "audio/L16"],
      limit: MAX_PCM_BYTES,
    }),
  );
  app.post(
    "/api/v1/audio",
    express.raw({
      type: ["audio/wav", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg"],
      limit: "12mb",
    }),
  );
  app.post(
    "/api/v1/assets",
    express.raw({
      type: ["image/jpeg", "image/png", "image/webp"],
      limit: "12mb",
    }),
  );
  // Public lab: stateless, no auth, no cookies, no model calls. Mounted before
  // the global JSON parser and the auth middleware, with its own small parser
  // and error handler so no input (or parser message) is ever echoed back.
  const labFail = (res: express.Response, status: number, code: string) =>
    res.status(status).json({
      error: { code, message: "Invalid lab request" },
    });
  const lab = express.Router();
  lab.use(
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: { code: "rate_limited", message: "Too many lab requests" },
      },
    }),
  );
  lab.use(express.json({ limit: "2kb" }));
  lab.get("/preflight", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ scenarios: labScenarios() });
  });
  lab.post("/preflight", (req, res) => {
    const body = LabGuess.safeParse(req.body);
    if (!body.success) return labFail(res, 422, "validation");
    const verdict = labCheck(body.data.scenarioId, body.data.guess);
    if (!verdict) return labFail(res, 404, "not_found");
    res.set("Cache-Control", "no-store").json(verdict);
  });
  lab.post("/phrase", (req, res) => {
    const body = LabPhrase.safeParse(req.body);
    if (!body.success) return labFail(res, 422, "validation");
    res.set("Cache-Control", "no-store").json(kineticPhraseCheck(body.data.text));
  });
  lab.use(
    (
      _err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => labFail(res, 400, "bad_request"),
  );
  app.use("/api/v1/public/lab", lab);
  app.use(express.json({ limit: "100kb" }));
  app.get("/health", (_req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({ ok: true });
  });
  app.get("/api/v1/public-config", async (_req, res) => {
    const number = (process.env.WHATSAPP_PUBLIC_NUMBER || "").replace(
      /\D/g,
      "",
    );
    res.json({
      data: {
        whatsappUrl: number
          ? `https://wa.me/${number}?text=${encodeURIComponent("Hi Axys, help me create a campaign for my business.")}`
          : null,
        whatsappReady: Boolean(number),
        hosting: production ? "managed" : "local-development",
        muse: await museStatus(gateway()),
      },
    });
  });
  app.post("/api/v1/session", (req, res) => {
    const key = z.string().min(1).max(200).parse(req.body.key);
    let tenant: string | undefined;
    const entries = (process.env.AXYS_ACCESS_KEYS || "")
      .split(",")
      .filter(Boolean);
    for (const entry of entries) {
      const [id, digest] = entry.split(":");
      if (
        /^[a-zA-Z0-9_-]{1,64}$/.test(id) &&
        digest &&
        equal(hash(key), digest)
      )
        tenant = id;
    }
    if (!production && key === "local-demo" && entries.length === 0)
      tenant = "local-demo";
    if (!tenant)
      return res.status(401).json({
        error: { code: "auth", message: "Invalid workspace access key" },
      });
    credits.seed(tenant);
    const id = randomBytes(32).toString("hex");
    store.put("session", "system", hash(id), {
      tenant,
      expires: Date.now() + 8 * 3600000,
    });
    res
      .cookie("axys_session", id, {
        httpOnly: true,
        sameSite: "lax",
        secure: production,
        maxAge: 8 * 3600000,
        path: "/",
      })
      .json({ data: { tenant } });
  });
  app.get("/api/v1/oauth/callback", async (req, res) => {
    const session = sessions(req);
    if (!session)
      return res.status(401).send("Sign in again before connecting Instagram");
    const state = String(req.query.state || "");
    const pending = store.get<any>("oauth", session.tenant, hash(state));
    if (
      !pending ||
      pending.expires < Date.now() ||
      pending.session !== hash(session.id)
    )
      return res
        .status(400)
        .send("Expired or invalid connection request. Start again.");
    store.del("oauth", session.tenant, hash(state));
    const token = await exchange(
      z.string().min(1).max(4096).parse(req.query.code),
    );
    const profile = await new Meta(token.access_token).request("me", {
      fields: "user_id,username",
    });
    const accountId = String(profile.user_id);
    if (!/^\d+$/.test(accountId))
      throw new Error("Instagram account identity missing");
    const con: Connection = {
      id: accountId,
      tenantId: session.tenant,
      accountId,
      username: profile.username,
      token: encrypt(token.access_token, required("AXYS_TOKEN_KEY")),
      expiresAt: Date.now() + token.expires_in * 1000,
      active: true,
    };
    store.put("connection", session.tenant, accountId, con);
    res.redirect("/");
  });
  app.use("/api/v1", (req, res, next) => {
    const s = sessions(req);
    if (!s)
      return res.status(401).json({
        error: { code: "auth", message: "Sign in to your workspace" },
      });
    res.locals.tenant = s.tenant;
    res.locals.session = s.id;
    next();
  });
  installCrmRoutes(app, store);
  app.post("/api/v1/logout", (_req, res) => {
    store.del("session", "system", hash(res.locals.session));
    res.clearCookie("axys_session").json({ data: { ok: true } });
  });
  app.delete("/api/v1/tenant", (req, res) => {
    const tenant = res.locals.tenant as string;
    if (req.body.confirmation !== tenant)
      throw new Error(
        "Type the exact workspace identifier to confirm deletion",
      );
    if (
      store.db
        .prepare(
          "SELECT 1 FROM jobs WHERE tenant=? AND state='running' AND lease>? LIMIT 1",
        )
        .get(tenant, Date.now())
    )
      throw new Error("Wait for running jobs before deleting the workspace");
    const campaigns = (
      store.db
        .prepare("SELECT data FROM records WHERE kind='campaign' AND tenant=?")
        .all(tenant) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as Campaign);
    store.transaction(() => {
      for (const c of campaigns)
        store.db.prepare("DELETE FROM events WHERE site=?").run(c.id);
      store.db
        .prepare(
          "DELETE FROM records WHERE kind='site' AND json_extract(data,'$.tenantId')=?",
        )
        .run(tenant);
      store.db
        .prepare(
          "DELETE FROM records WHERE kind='session' AND json_extract(data,'$.tenant')=?",
        )
        .run(tenant);
      store.db.prepare("DELETE FROM records WHERE tenant=?").run(tenant);
      store.db.prepare("DELETE FROM jobs WHERE tenant=?").run(tenant);
      store.db.prepare("DELETE FROM publications WHERE tenant=?").run(tenant);
      store.db
        .prepare(
          "UPDATE spend SET tenant=?,campaign=?,trace=NULL WHERE tenant=?",
        )
        .run("deleted", "deleted", tenant);
    });
    const objectRoot = path.resolve(store.root, "objects");
    const dir = path.resolve(objectRoot, tenant);
    if (
      path.dirname(dir) !== objectRoot ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(tenant)
    )
      throw new Error("Invalid workspace storage path");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const renderRoot = path.resolve(store.root, "renders"),
      render = path.resolve(renderRoot, tenant);
    if (path.dirname(render) !== renderRoot)
      throw new Error("Invalid render storage path");
    if (existsSync(render)) rmSync(render, { recursive: true, force: true });
    res.clearCookie("axys_session").json({
      data: {
        deleted: true,
        note: "Workspace data removed. Non-identifying budget totals retained to preserve spending caps. Existing Instagram posts and operator backups require separate removal.",
      },
    });
  });
  app.get("/api/v1/capabilities", async (_req, res) => {
    res.json({
      data: {
        tenant: res.locals.tenant,
        muse: await museStatus(gateway()),
        instagram:
          !!process.env.META_APP_ID &&
          !!process.env.META_APP_SECRET &&
          !!process.env.META_API_VERSION &&
          !!process.env.AXYS_TOKEN_KEY,
        postingEnabled: process.env.AXYS_ALLOW_PUBLIC_POSTING === "true",
        connections: store
          .list<Connection>("connection", res.locals.tenant)
          .map(({ token, ...c }) => c),
        local: !production,
        demoSamples: demoSamples(),
        credits: credits.seed(res.locals.tenant),
      },
    });
  });
  app.post("/api/v1/assets", async (req, res) => {
    if (req.headers["x-asset-rights"] !== "confirmed")
      throw new Error("Confirm that you own or may use this image");
    if (!Buffer.isBuffer(req.body))
      throw new Error("Upload JPEG, PNG or WebP image bytes");
    res
      .status(201)
      .json({ data: await engine.image(res.locals.tenant, req.body) });
  });
  app.post("/api/v1/audio", async (req, res) => {
    if (
      req.headers["x-asset-rights"] !== "confirmed" ||
      !Buffer.isBuffer(req.body)
    )
      throw new Error("Confirm rights and upload an audio file");
    res
      .status(201)
      .json({ data: await engine.audio(res.locals.tenant, req.body) });
  });
  app.get("/api/v1/assets/:id", async (req, res) => {
    const a = store.get<Asset>("asset", res.locals.tenant, req.params.id);
    if (!a) return res.sendStatus(404);
    res
      .type(a.mime)
      .set("Cache-Control", "private, max-age=60")
      .sendFile(path.join(store.root, "objects", res.locals.tenant, a.hash));
  });
  const checkAssets = (tenant: string, c: z.infer<typeof CampaignInput>) => {
    if (
      c.voiceAssetId &&
      !store
        .get<Asset>("asset", tenant, c.voiceAssetId)
        ?.mime.startsWith("audio/")
    )
      throw new Error("Voice asset not found in this workspace");
    for (const p of c.facts.products)
      if (
        !store.get<Asset>("asset", tenant, p.assetId)?.mime.startsWith("image/")
      )
        throw new Error("Product image not found in this workspace");
  };
  app.get("/api/v1/intake", (_req, res) =>
    res.json({ data: store.list("intake", res.locals.tenant) }),
  );
  app.get("/api/v1/intake/whatsapp-drafts", (_req, res) =>
    res.json({
      data: store.list<WhatsAppDraft>("whatsapp-draft", res.locals.tenant),
    }),
  );
  app.post("/api/v1/intake/whatsapp-drafts/:id/import", (req, res) => {
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(req.params.id);
    const body = z
      .object({
        confirmFacts: z.literal(true),
        draftUpdatedAt: z.string().datetime(),
        campaign: CampaignInput,
      })
      .strict()
      .parse(req.body);
    const tenant = res.locals.tenant as string;
    const draft = store.get<WhatsAppDraft>("whatsapp-draft", tenant, id);
    if (!draft) throw new Error("WhatsApp draft not found");
    if (draft.status === "Imported" && draft.campaignId)
      return res.json({ data: engine.get(tenant, draft.campaignId) });
    if (draft.updatedAt !== body.draftUpdatedAt)
      throw new Error("WhatsApp draft changed. Review the latest version.");
    if (body.campaign.facts.source !== "whatsapp")
      throw new Error("Imported facts must identify WhatsApp as their source");
    checkAssets(tenant, body.campaign);
    const usable = new Map(
      draft.media
        .filter((item) => item.status === "Stored" && item.assetId)
        .map((item) => [item.assetId!, item.kind]),
    );
    for (const product of body.campaign.facts.products)
      if (usable.get(product.assetId) !== "image")
        throw new Error(
          "Each product image must come from this WhatsApp draft",
        );
    if (
      body.campaign.voiceAssetId &&
      usable.get(body.campaign.voiceAssetId) !== "audio"
    )
      throw new Error("Voice media must come from this WhatsApp draft");
    const previous = draft.campaignId
      ? engine.get(tenant, draft.campaignId)
      : undefined;
    if (previous && ["Publishing", "Generating"].includes(previous.state))
      throw new Error(
        "Wait for the linked campaign job before importing changes",
      );
    const campaign: Campaign = {
      ...body.campaign,
      id: previous?.id || randomUUID(),
      tenantId: tenant,
      revision: previous ? previous.revision + 1 : 1,
      state: "Draft",
    };
    store.transaction(() => {
      if (previous)
        store.put(
          "history",
          tenant,
          `${previous.id}-${previous.revision}`,
          previous,
        );
      engine.save(campaign);
      store.put("whatsapp-draft", tenant, id, {
        ...draft,
        status: "Imported",
        campaignId: campaign.id,
        importedAt: new Date().toISOString(),
      } satisfies WhatsAppDraft);
    });
    return res.status(201).json({ data: campaign });
  });
  app.get("/api/v1/campaigns", (_req, res) =>
    res.json({ data: store.list<Campaign>("campaign", res.locals.tenant) }),
  );
  app.post("/api/v1/campaigns", (req, res) => {
    const input = CampaignInput.parse(req.body);
    checkAssets(res.locals.tenant, input);
    const c: Campaign = {
      ...input,
      id: randomUUID(),
      tenantId: res.locals.tenant,
      revision: 1,
      state: "Draft",
    };
    engine.save(c);
    res.status(201).json({ data: c });
  });
  /** Save an edit to the confirmed facts. With `keepGenerated` (and existing
   * artifacts) the previously generated artifacts stay so preflight can audit
   * them against the new facts; approval stays refused until regenerated. */
  const saveEdit = (old: Campaign, input: Input, keepGenerated: boolean) => {
    store.put("history", old.tenantId, `${old.id}-${old.revision}`, old);
    const keep = keepGenerated && !!old.site;
    const c: Campaign = {
      ...input,
      id: old.id,
      tenantId: old.tenantId,
      revision: old.revision + 1,
      state: keep ? "NeedsReview" : "Draft",
      ...(keep
        ? {
            site: old.site,
            reel: old.reel,
            siteHash: old.siteHash,
            videoHash: old.videoHash,
            videoAssetId: old.videoAssetId,
            videoPosterId: old.videoPosterId,
          }
        : {}),
    };
    engine.save(c);
    return c;
  };
  app.get("/api/v1/campaigns/:id", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    res.json({
      data: {
        ...c,
        jobs: store.db
          .prepare(
            "SELECT id,kind,state,error FROM jobs WHERE tenant=? AND campaign=?",
          )
          .all(res.locals.tenant, c.id),
      },
    });
  });
  app.put("/api/v1/campaigns/:id", (req, res) => {
    const old = engine.get(res.locals.tenant, req.params.id);
    if (["Publishing", "Generating"].includes(old.state))
      throw new Error("Wait for publication to settle before editing");
    if (req.body.revision !== old.revision)
      throw new Error("This campaign changed. Reload before saving.");
    const input = CampaignInput.parse(req.body);
    checkAssets(res.locals.tenant, input);
    res.json({
      data: saveEdit(old, input, req.query.keepGenerated === "true"),
    });
  });
  app.post("/api/v1/campaigns/:id/generate", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    if (c.state === "Publishing") throw new Error("Publication is in progress");
    const mode = z.enum(["manual", "muse", "nemotron"]).parse(req.body.mode);
    const audio = z.boolean().optional().parse(req.body.audio);
    if (c.state === "Generating") return res.json({ data: c });
    if (c.site) {
      store.put("history", c.tenantId, `${c.id}-${c.revision}`, c);
      c.revision++;
      delete c.site;
      delete c.reel;
      delete c.siteHash;
      delete c.videoHash;
      delete c.videoAssetId;
      delete c.videoPosterId;
      delete c.attempt;
      delete c.generation;
    }
    store.put("generate-options", c.tenantId, c.id, {
      revision: c.revision,
      audio: audio !== false,
    });
    credits.seed(c.tenantId);
    credits.charge(c.tenantId, c.mode, `generation:${c.id}:${c.revision}`);
    c.state = "Generating";
    delete c.approval;
    delete c.error;
    engine.save(c);
    engine.enqueue(c, mode === "manual" ? "generate" : "generate-ai");
    res.status(202).json({ data: c });
  });
  app.post("/api/v1/voice/transcribe", async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 3200)
      throw new Error("Send at least 0.1 s of raw 16 kHz mono PCM16 audio");
    if (req.body.length % 2)
      throw new Error("PCM16 audio must have an even byte length");
    const campaignId = z.string().uuid().optional().parse(req.query.campaignId);
    const c = campaignId
      ? engine.get(res.locals.tenant, campaignId)
      : undefined;
    const transcript = await gateway().transcribe(req.body);
    if (c)
      store.put("voice-transcript", c.tenantId, c.id, {
        transcript,
        at: new Date().toISOString(),
      });
    reply(res, { transcript });
  });
  app.post("/api/v1/campaigns/:id/enrich", async (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    const scenes = z.coerce
      .number()
      .int()
      .min(0)
      .max(2)
      .default(1)
      .parse(req.query.scenes);
    const plates =
      req.query.plates === undefined
        ? undefined
        : z.coerce.number().int().min(0).max(1).parse(req.query.plates);
    const film =
      req.query.film === undefined
        ? undefined
        : z.coerce.number().int().min(0).max(1).parse(req.query.film);
    const {
      sources: _s,
      revision: _r,
      ...contract
    } = await enrichCampaign(engine, gateway(), c, scenes, plates, film);
    reply(res, contract);
  });
  app.post("/api/v1/campaigns/:id/command", async (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    const body = z
      .object({ text: z.string().min(1).max(COMMAND_MAX_CHARS) })
      .strict()
      .parse(req.body ?? {});
    reply(res, await parseCommand(store, gateway(), c, body.text, clock()));
  });
  app.post("/api/v1/campaigns/:id/command/apply", (req, res) => {
    const old = engine.get(res.locals.tenant, req.params.id);
    const body = z
      .object({ patch: z.unknown(), revision: z.number().int().positive() })
      .strict()
      .parse(req.body ?? {});
    if (["Publishing", "Generating"].includes(old.state))
      throw new CommandError(
        "Wait for generation or publication to settle before applying a change",
        "busy",
      );
    if (body.revision !== old.revision)
      throw new CommandError(
        "This campaign changed. Reload and say the change again.",
        "stale_revision",
      );
    const { patch, facts } = verifyForApply(store, old, body.patch, clock());
    const input = CampaignInput.parse({
      facts,
      mode: old.mode,
      layout: old.layout,
      reelStyle: old.reelStyle,
      brief: old.brief,
      ...(old.voiceAssetId ? { voiceAssetId: old.voiceAssetId } : {}),
    });
    // Same semantics as PUT ?keepGenerated=true: artifacts stay, so preflight
    // and Red Pen mark them stale until the merchant regenerates.
    const saved = saveEdit(old, input, true);
    forgetVerified(store, old, patch);
    res.json({ data: saved });
  });
  app.get("/api/v1/campaigns/:id/enrichment", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    const e = loadEnrichment(store, c);
    if (!e) throw new Error("Enrichment not found");
    const { sources: _s, revision: _r, ...contract } = e;
    reply(res, contract);
  });
  app.post("/api/v1/campaigns/:id/preflight", async (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    const body = z
      .object({ voiceTranscript: z.string().max(6000).optional() })
      .strict()
      .parse(req.body ?? {});
    reply(res, await runPreflight(store, gateway(), c, body.voiceTranscript));
  });
  app.get("/api/v1/campaigns/:id/preflight", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    const p = latestPreflight(store, c);
    if (!p) throw new Error("Preflight not found");
    reply(res, { ...p, current: p.revision === c.revision });
  });
  app.post("/api/v1/campaigns/:id/preview-digest", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    if (
      req.body.revision !== c.revision ||
      req.body.siteHash !== c.siteHash ||
      req.body.videoHash !== c.videoHash
    )
      throw new Error(
        "Preview is stale. Reload and review the current artifacts.",
      );
    const accountId = z.string().max(100).parse(req.body.accountId),
      schedule = z.string().datetime().parse(req.body.schedule);
    res.json({ data: { digest: digest(c, accountId, schedule) } });
  });
  app.get("/api/v1/campaigns/:id/decisions", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    res.json({
      data: store
        .list<WhatsAppDecision>("whatsapp-decision", c.tenantId)
        .filter((d) => d.campaignId === c.id)
        .map((d) => ({
          id: d.id,
          action: d.action,
          receivedAt: d.receivedAt,
          current: d.revision === c.revision,
        }))
        .sort((x, y) => y.receivedAt.localeCompare(x.receivedAt))
        .slice(0, 20),
    });
  });
  app.post("/api/v1/campaigns/:id/approve", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    const a = z
      .object({
        digest: z.string().length(64),
        accountId: z.string().max(100),
        schedule: z.string().datetime(),
      })
      .parse(req.body);
    res.json({ data: engine.approval(c, a.accountId, a.schedule, a.digest) });
  });
  app.post("/api/v1/campaigns/:id/publish", (req, res) =>
    res.status(202).json({
      data: engine.publish(
        engine.get(res.locals.tenant, req.params.id),
        z.string().uuid().parse(req.body.approvalId),
      ),
    }),
  );
  app.post("/api/v1/campaigns/:id/reconcile", async (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    engine.verify(c);
    if (!c.attempt) throw new Error("No publication attempt");
    if (c.attempt.mediaId) await engine.publishStep(c);
    else if (c.attempt.containerId) {
      const con = engine.connection(c.tenantId, c.approval!.accountId);
      const status = await new Meta(
        decrypt(con.token, required("AXYS_TOKEN_KEY")),
      ).status(c.attempt.containerId);
      store.put("reconciliation", c.tenantId, c.attempt.id, {
        status: status.status_code,
        checkedAt: new Date().toISOString(),
      });
      c.error = `Container ${status.status_code}. A confirmed media identifier is still required; no repost was attempted.`;
      engine.save(c);
    }
    res.json({ data: c });
  });
  app.post("/api/v1/campaigns/:id/retry", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    engine.verify(c);
    if (!c.attempt?.containerId || c.attempt.publishSent)
      throw new Error(
        "Only a known unpublished container may be retried. Reconcile uncertain outcomes.",
      );
    store.db
      .prepare(
        "UPDATE jobs SET state='queued',available=?,lease=0,error=NULL WHERE tenant=? AND campaign=? AND revision=? AND kind='publish' AND state='failed' AND tries<10",
      )
      .run(Date.now(), c.tenantId, c.id, c.revision);
    c.state = "Publishing";
    delete c.error;
    delete c.attempt.error;
    engine.saveAttempt(c);
    res.json({ data: c });
  });
  app.post("/api/v1/oauth/start", (_req, res) => {
    publicOrigin();
    required("META_APP_SECRET");
    required("AXYS_TOKEN_KEY");
    const state = randomBytes(32).toString("hex");
    store.put("oauth", res.locals.tenant, hash(state), {
      expires: Date.now() + 600000,
      session: hash(res.locals.session),
    });
    res.json({ data: { url: oauthUrl(state) } });
  });
  app.post("/api/v1/connections/:id/disconnect", (req, res) => {
    const con = store.get<Connection>(
      "connection",
      res.locals.tenant,
      req.params.id,
    );
    if (!con) return res.sendStatus(404);
    con.active = false;
    con.token = "";
    store.put("connection", res.locals.tenant, con.id, con);
    for (const c of store.list<Campaign>("campaign", res.locals.tenant)) {
      if (c.approval?.accountId === con.id) {
        delete c.approval;
        c.state = "NeedsReview";
        engine.save(c);
        store.db
          .prepare(
            "UPDATE jobs SET state='cancelled' WHERE tenant=? AND campaign=? AND kind='publish' AND state IN ('queued','running')",
          )
          .run(res.locals.tenant, c.id);
      }
    }
    res.json({ data: { disconnected: true } });
  });
  app.post("/api/v1/connections/:id/refresh", async (req, res) => {
    const con = engine.connection(res.locals.tenant, req.params.id);
    const token = await refresh(decrypt(con.token, required("AXYS_TOKEN_KEY")));
    con.token = encrypt(token.access_token, required("AXYS_TOKEN_KEY"));
    con.expiresAt = Date.now() + token.expires_in * 1000;
    store.put("connection", res.locals.tenant, con.id, con);
    res.json({ data: { refreshed: true } });
  });
  function metrics(c: Campaign) {
    const real = store.get<any>("metrics", c.tenantId, c.id);
    // Real Instagram insights always win; sample insights exist only in demo mode
    // and live in their own record, so real storage semantics are untouched.
    const sample =
      demoSamples() && !real?.data
        ? store.get<any>("metrics-sample", c.tenantId, c.id)
        : undefined;
    const base = {
      instagram: sample ||
        real || {
          source: "Instagram",
          value: null,
          reason: "Not retrieved or unavailable",
          observedAt: null,
        },
      website: sample
        ? sampleWebsiteRows(new Date(sample.observedAt))
        : store.db
            .prepare(
              "SELECT kind,COUNT(*) AS value,MAX(time) AS observedAt FROM events WHERE site=? GROUP BY kind",
            )
            .all(c.id),
      note: "Visits and contact clicks are not purchases. Automated traffic may be included.",
    };
    return sample ? { ...base, sample: true as const } : base;
  }
  app.get("/api/v1/campaigns/:id/metrics", (req, res) =>
    res.json({ data: metrics(engine.get(res.locals.tenant, req.params.id)) }),
  );
  app.post("/api/v1/campaigns/:id/metrics/sample", (req, res) => {
    if (!demoSamples()) return res.sendStatus(404);
    const c = engine.get(res.locals.tenant, req.params.id);
    z.object({ preset: z.literal(SAMPLE_PRESET) })
      .strict()
      .parse(req.body);
    store.put("metrics-sample", c.tenantId, c.id, sampleInstagramRecord(new Date(clock())));
    res.json({ data: metrics(c) });
  });
  app.post("/api/v1/campaigns/:id/metrics", async (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    if (!c.attempt?.mediaId)
      throw new Error("No confirmed Instagram media identifier");
    const con = engine.connection(c.tenantId, c.approval!.accountId);
    try {
      const data = await new Meta(
        decrypt(con.token, required("AXYS_TOKEN_KEY")),
      ).insights(c.attempt.mediaId, required("META_INSIGHT_METRICS"));
      store.put("metrics", c.tenantId, c.id, {
        source: "Instagram",
        apiVersion: required("META_API_VERSION"),
        observedAt: new Date().toISOString(),
        data,
      });
    } catch {
      store.put("metrics", c.tenantId, c.id, {
        source: "Instagram",
        value: null,
        observedAt: new Date().toISOString(),
        reason:
          "Insights unavailable. Check permissions, metric support and data delay.",
      });
    }
    res.json({ data: metrics(c) });
  });
  app.get("/api/v1/campaigns/:id/site-versions", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    res.json({
      data: store
        .list<any>("siteVersion", c.tenantId)
        .filter((v) => v.campaignId === c.id),
    });
  });
  app.post("/api/v1/campaigns/:id/rollback", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    if (c.state === "Publishing") throw new Error("Wait for publication");
    const revision = z.number().int().positive().parse(req.body.revision);
    const v = store.get<any>("siteVersion", c.tenantId, `${c.id}-${revision}`);
    if (!v || hash(v.spec) !== v.hash || req.body.siteHash !== v.hash)
      throw new Error(
        "Review the exact existing site version before restoring",
      );
    store.put("site", "public", c.id, {
      tenantId: c.tenantId,
      campaignId: c.id,
      revision,
      spec: v.spec,
      siteHash: v.hash,
      publishedAt: new Date().toISOString(),
    });
    res.json({
      data: {
        revision,
        siteHash: v.hash,
        note: "Website restored. Instagram unchanged.",
      },
    });
  });
  app.post("/api/v1/campaigns/:id/revision", async (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    const observed = metrics(c);
    const result = await proposeRevision(
      c,
      store,
      observed,
      engine.gateway,
      "sample" in observed && observed.sample === true,
    );
    store.put("proposal", c.tenantId, c.id, result);
    res.json({ data: result });
  });
  app.delete("/api/v1/campaigns/:id", (req, res) => {
    const c = engine.get(res.locals.tenant, req.params.id);
    if (["Publishing", "Generating"].includes(c.state))
      throw new Error("Wait for the current job before deleting");
    store.del("campaign", c.tenantId, c.id);
    store.del("site", "public", c.id);
    store.db
      .prepare(
        "UPDATE jobs SET state='cancelled' WHERE tenant=? AND campaign=?",
      )
      .run(c.tenantId, c.id);
    res.json({
      data: {
        deleted: true,
        note: "Existing Instagram media is not deleted. Private assets follow retention policy.",
      },
    });
  });
  app.get("/sites/:id/contact", (req, res) => {
    const site = store.get<any>("site", "public", req.params.id);
    if (!site) return res.sendStatus(404);
    store.db
      .prepare("INSERT INTO events VALUES(?,?,?)")
      .run(req.params.id, "contact", new Date().toISOString());
    res.redirect(site.spec.facts.contact);
  });
  app.get("/sites/:id/images/:assetId", async (req, res) => {
    const site = store.get<any>("site", "public", req.params.id);
    if (
      !site?.spec.facts.products.some(
        (p: any) => p.assetId === req.params.assetId,
      ) &&
      site?.spec.hero?.assetId !== req.params.assetId
    )
      return res.sendStatus(404);
    const asset = store.get<Asset>("asset", site.tenantId, req.params.assetId);
    res
      .type(asset?.mime.startsWith("image/") ? asset.mime : "image/jpeg")
      .send(await engine.bytes(site.tenantId, req.params.assetId));
  });
  app.get("/sites/:id", (req, res) => {
    const site = store.get<any>("site", "public", req.params.id);
    if (!site) return res.sendStatus(404);
    store.db
      .prepare("INSERT INTO events VALUES(?,?,?)")
      .run(req.params.id, "visit", new Date().toISOString());
    const html = renderToStaticMarkup(
      React.createElement(Site, {
        spec: site.spec,
        assetUrl: (id: string) => `/sites/${req.params.id}/images/${id}`,
        contactUrl: `/sites/${req.params.id}/contact`,
      }),
    );
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Merchant offer</title><link rel="stylesheet" href="/site.css"></head><body>${html}</body></html>`,
      );
  });
  app.get("/site.css", (_req, res) =>
    res.type("css").send(readFileSync("apps/studio/site.css", "utf8")),
  );
  app.get("/media/:id", async (req, res) => {
    const tenant = String(req.query.tenant),
      expires = Number(req.query.expires);
    if (
      !Number.isFinite(expires) ||
      expires < Date.now() ||
      expires > Date.now() + 24 * 3600000 ||
      !process.env.AXYS_MEDIA_KEY ||
      !equal(
        sign(
          `${tenant}:${req.params.id}:${expires}`,
          process.env.AXYS_MEDIA_KEY,
        ),
        String(req.query.sig),
      )
    )
      return res.sendStatus(403);
    const a = store.get<Asset>("asset", tenant, req.params.id);
    if (!a || a.mime !== "video/mp4") return res.sendStatus(404);
    res.type(a.mime).sendFile(path.join(store.root, "objects", tenant, a.hash));
  });
  app.get("/deletion", (_req, res) =>
    res
      .type("text")
      .send(
        "Sign in to delete a campaign through DELETE /api/v1/campaigns/:id and disconnect Instagram. Ask the deployment operator for complete tenant deletion. Existing Instagram posts must be removed in Instagram.",
      ),
  );
  app.get("/privacy", (_req, res) =>
    res
      .type("text")
      .send(
        "Axys stores campaign facts, uploaded media, encrypted connection tokens and aggregate visit/contact counts. Disconnect removes local token access. Delete a campaign to unpublish its site. Instagram posts remain until removed on Instagram. Operator must configure a retention period and contact before public onboarding.",
      ),
  );
  app.use(express.static(path.resolve("dist")));
  app.get("/", (_req, res) => res.sendFile(path.resolve("dist/index.html")));
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof z.ZodError)
        return res.status(422).json({
          error: {
            code: "validation",
            message: err.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          },
        });
      if (err instanceof PreflightBlockedError)
        return res.status(409).json({
          error: { code: err.code, message: err.message, issues: err.issues },
        });
      if (err instanceof CommandError)
        return res.status(err.status).json({
          error: { code: err.code, message: err.message },
        });
      if (err instanceof GatewayError)
        return res
          .status(
            ["bad_response", "upstream"].includes(err.code)
              ? 502
              : err.code === "bad_request"
                ? 422
                : 503,
          )
          .json({
            error: { code: `muse_${err.code}`, message: err.message },
          });
      if (err?.type === "entity.too.large")
        return res.status(413).json({
          error: { code: "too_large", message: "Upload is too large" },
        });
      const known = err instanceof Error ? err.message : "Request failed";
      const status = known.includes("not found") ? 404 : 409;
      res.status(status).json({
        error: {
          code: "request_failed",
          message: known.includes("SQLITE") ? "Storage request failed" : known,
        },
      });
    },
  );
  return { app, engine, store };
}
