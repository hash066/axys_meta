import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { catalog, propose } from "../packages/inference/nebius.ts";
import type { Campaign } from "../packages/campaign/index.ts";
import { Store } from "../server/store.ts";
import {
  Meta,
  MetaRequestError,
  oauthUrl,
} from "../services/publishing/meta.ts";
import {
  deploymentChecks,
  isPublicHttpsOrigin,
  metaChecks,
  nebiusChecks,
} from "../services/providers/config.ts";

test("public deployment origin rejects local, private and path-bearing URLs", () => {
  assert.equal(isPublicHttpsOrigin("https://campaigns.example.com"), true);
  for (const url of [
    "http://campaigns.example.com",
    "https://127.0.0.1",
    "https://10.0.0.4",
    "https://172.20.0.4",
    "https://192.168.1.4",
    "https://[::1]",
    "https://campaigns.example.com/path",
    "https://user:pass@campaigns.example.com",
  ])
    assert.equal(isPublicHttpsOrigin(url), false, url);
});

test("provider configuration requires fresh bounded spend and exact callback", () => {
  const env = {
    NODE_ENV: "production",
    AXYS_ORIGIN: "https://campaigns.example.com",
    AXYS_DATA_DIR: "D:/persistent/axys",
    AXYS_TOKEN_KEY: Buffer.alloc(32).toString("base64"),
    AXYS_MEDIA_KEY: "m".repeat(32),
    AXYS_ACCESS_KEYS: `merchant:${"a".repeat(64)}`,
    NEBIUS_API_KEY: "present",
    NEBIUS_MODEL: "nvidia/Nemotron-3_5-Lightning",
    NEBIUS_CREDIT_VERIFIED_AT: new Date().toISOString(),
    NEBIUS_PRICING_SOURCE:
      "https://nebius.com/services/token-factory/models/nvidia-nemotron-models-inference",
    NEBIUS_INPUT_USD_PER_MILLION: "0.06",
    NEBIUS_OUTPUT_USD_PER_MILLION: "0.24",
    NEBIUS_CREDIT_USD: "10",
    NEBIUS_ACCOUNT_CAP_USD: "2",
    NEBIUS_CAMPAIGN_CAP_USD: "0.10",
    META_APP_ID: "123",
    META_APP_SECRET: "present",
    META_API_VERSION: "v24.0",
    META_REDIRECT_URI: "https://campaigns.example.com/api/v1/oauth/callback",
    META_INSIGHT_METRICS: "views,reach",
  } as NodeJS.ProcessEnv;
  assert.equal(
    nebiusChecks(env).some((check) => check.status === "blocked"),
    false,
  );
  assert.equal(
    metaChecks(env).some((check) => check.status === "blocked"),
    false,
  );
  assert.equal(
    deploymentChecks(env).some((check) => check.status === "blocked"),
    false,
  );
  env.NEBIUS_CREDIT_VERIFIED_AT = new Date(
    Date.now() - 2 * 86400000,
  ).toISOString();
  env.NEBIUS_CAMPAIGN_CAP_USD = "3";
  env.META_REDIRECT_URI = "https://other.example.com/callback";
  assert.equal(
    nebiusChecks(env).filter((check) => check.status === "blocked").length,
    2,
  );
  assert.equal(
    metaChecks(env).find((check) => check.name === "meta.redirect")?.status,
    "blocked",
  );
});

test("Nebius catalog parser rejects malformed provider responses", async () => {
  const old = process.env.NEBIUS_API_KEY;
  process.env.NEBIUS_API_KEY = "test-only";
  try {
    const ok = await catalog(
      (async () =>
        new Response(
          JSON.stringify({ data: [{ id: "nvidia/Nemotron-test" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )) as typeof fetch,
    );
    assert.equal(ok.data[0].id, "nvidia/Nemotron-test");
    await assert.rejects(
      () =>
        catalog(
          (async () =>
            new Response(JSON.stringify({ data: [{}] }))) as typeof fetch,
        ),
      /invalid response/,
    );
  } finally {
    if (old === undefined) delete process.env.NEBIUS_API_KEY;
    else process.env.NEBIUS_API_KEY = old;
  }
});

test("Nemotron planning disables visible reasoning and requires JSON output", async () => {
  const old = { ...process.env };
  const root = mkdtempSync(path.join(tmpdir(), "axys-nebius-test-"));
  const store = new Store(root);
  const productId = randomUUID();
  const campaign: Campaign = {
    id: randomUUID(),
    tenantId: "provider-test",
    revision: 1,
    state: "Draft",
    mode: "Both",
    layout: "editorial",
    reelStyle: "warm",
    brief: "Fixture only",
    facts: {
      business: "Fixture bakery",
      offer: "Fixture loaf",
      collection: "Tomorrow",
      contact: "https://example.com/contact",
      confirmed: true,
      source: "merchant",
      products: [
        {
          id: productId,
          name: "Fixture loaf",
          priceMinor: 10000,
          currency: "INR",
          assetId: randomUUID(),
        },
      ],
    },
  };
  Object.assign(process.env, {
    NEBIUS_API_KEY: "fixture-key",
    NEBIUS_MODEL: "nvidia/Nemotron-3_5-Lightning",
    NEBIUS_CREDIT_VERIFIED_AT: new Date().toISOString(),
    NEBIUS_PRICING_SOURCE: "https://example.com/pricing",
    NEBIUS_INPUT_USD_PER_MILLION: "0.06",
    NEBIUS_OUTPUT_USD_PER_MILLION: "0.24",
    NEBIUS_CREDIT_USD: "1",
    NEBIUS_ACCOUNT_CAP_USD: "0.05",
    NEBIUS_CAMPAIGN_CAP_USD: "0.01",
  });
  try {
    const result = await propose(campaign, store, [], (async (input, init) => {
      if (String(input).endsWith("/models"))
        return new Response(
          JSON.stringify({ data: [{ id: process.env.NEBIUS_MODEL }] }),
        );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.reasoning_effort, "none");
      assert.deepEqual(body.response_format, { type: "json_object" });
      return new Response(
        JSON.stringify({
          id: "fixture-request",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  headline: campaign.facts.offer,
                  suggestion: "Render the confirmed offer.",
                  questions: [],
                  tool: "render",
                  layout: "editorial",
                  reelStyle: "warm",
                  productOrder: [productId],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    }) as typeof fetch);
    assert.equal(result.proposal.tool, "render");
    assert.equal(result.trace.requestId, "fixture-request");
  } finally {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
    process.env = old;
  }
});

test("Meta adapter uses Instagram Login graph host and classifies rate limits", async () => {
  const old = process.env.META_API_VERSION;
  process.env.META_API_VERSION = "v24.0";
  let requested = "";
  const meta = new Meta("test-token", (async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({ error: { code: 4 } }), {
      status: 429,
      headers: { "retry-after": "30", "x-fb-request-id": "request-fixture" },
    });
  }) as typeof fetch);
  try {
    await assert.rejects(
      () => meta.receipt("123"),
      (error: unknown) => {
        assert.ok(error instanceof MetaRequestError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterSeconds, 30);
        assert.equal(error.requestId, "request-fixture");
        return true;
      },
    );
    assert.equal(
      requested,
      "https://graph.instagram.com/v24.0/123?fields=id%2Cpermalink%2Ctimestamp",
    );
  } finally {
    if (old === undefined) delete process.env.META_API_VERSION;
    else process.env.META_API_VERSION = old;
  }
});

test("Meta publishing validates media URL, caption, identifiers and OAuth state", () => {
  const old = {
    META_API_VERSION: process.env.META_API_VERSION,
    META_APP_ID: process.env.META_APP_ID,
    META_REDIRECT_URI: process.env.META_REDIRECT_URI,
  };
  Object.assign(process.env, {
    META_API_VERSION: "v24.0",
    META_APP_ID: "123",
    META_REDIRECT_URI: "https://campaigns.example.com/api/v1/oauth/callback",
  });
  try {
    const meta = new Meta(
      "token",
      (async () => new Response("{}")) as typeof fetch,
    );
    assert.throws(() =>
      meta.create("abc", "https://example.com/reel.mp4", "caption"),
    );
    assert.throws(() =>
      meta.create("123", "http://example.com/reel.mp4", "caption"),
    );
    assert.throws(() => meta.create("123", "https://example.com/reel.mp4", ""));
    assert.throws(() => oauthUrl("short"), /OAuth state/);
    assert.match(
      oauthUrl("a".repeat(32)),
      /instagram_business_content_publish/,
    );
  } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
