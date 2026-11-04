import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Meta,
  MetaRequestError,
  oauthUrl,
} from "../services/publishing/meta.ts";
import {
  deploymentChecks,
  isPublicHttpsOrigin,
  metaChecks,
  museChecks,
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

test("provider configuration requires exact callback and a valid gateway URL", () => {
  const env = {
    NODE_ENV: "production",
    AXYS_ORIGIN: "https://campaigns.example.com",
    AXYS_DATA_DIR: "D:/persistent/axys",
    AXYS_TOKEN_KEY: Buffer.alloc(32).toString("base64"),
    AXYS_MEDIA_KEY: "m".repeat(32),
    AXYS_ACCESS_KEYS: `merchant:${"a".repeat(64)}`,
    META_APP_ID: "123",
    META_APP_SECRET: "present",
    META_API_VERSION: "v24.0",
    META_REDIRECT_URI: "https://campaigns.example.com/api/v1/oauth/callback",
    META_INSIGHT_METRICS: "views,reach",
  } as NodeJS.ProcessEnv;
  assert.equal(
    museChecks(env).some((check) => check.status === "blocked"),
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
  env.META_REDIRECT_URI = "https://other.example.com/callback";
  env.MUSE_GATEWAY_URL = "http://user:pw@127.0.0.1:8766";
  assert.equal(museChecks(env)[0].status, "blocked");
  env.MUSE_GATEWAY_URL = "http://127.0.0.1:8766";
  assert.equal(museChecks(env)[0].status, "pass");
  assert.equal(
    metaChecks(env).find((check) => check.name === "meta.redirect")?.status,
    "blocked",
  );
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
