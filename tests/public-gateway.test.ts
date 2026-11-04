import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../workers/public-gateway/worker.ts";

function fixture() {
  const values = new Map<string, string | ArrayBuffer>();
  const env: any = {
    SESSION_SECRET: "test-session-secret-at-least-thirty-two-bytes",
    EDGE_SERVICE_SECRET: "test-edge-service-secret-at-least-thirty-two-bytes",
    META_APP_ID: "2349611939193122",
    META_APP_SECRET: "test-meta-app-secret-at-least-thirty-two-bytes",
    META_API_VERSION: "v26.0",
    META_REDIRECT_URI: "https://axys.example/api/v1/oauth/callback",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key-at-least-thirty-two-bytes",
    NEBIUS_API_KEY: "unused-test-key",
    ASSETS: {
      fetch: async () => new Response("clean-axys-build", { status: 200 }),
    },
    AXYS_LIVE_STATE: {
      get: async (key: string, type = "text") => {
        const value = values.get(key);
        if (value == null) return null;
        if (type === "arrayBuffer") return value;
        const text = String(value);
        return type === "json" ? JSON.parse(text) : text;
      },
      put: async (key: string, value: string | ArrayBuffer) => {
        values.set(key, value);
      },
      delete: async (key: string) => values.delete(key),
      list: async ({ prefix = "" } = {}) => ({
        keys: [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
      }),
    },
  };
  return { env, values };
}

test("public app exposes the Axys WhatsApp entry and repository assets", async () => {
  const { env } = fixture();
  const response = await handle(
    new Request("https://axys.example/api/v1/public-config"),
    env,
  );
  const body: any = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.data.whatsappUrl, /^https:\/\/wa\.me\/919180499647/);
  assert.equal(body.data.workspaceReady, true);
  assert.equal(
    await (await handle(new Request("https://axys.example/"), env)).text(),
    "clean-axys-build",
  );
});

test("public app creates an isolated pilot session with credits", async () => {
  const { env } = fixture();
  const session = await handle(
    new Request("https://axys.example/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ create: true }),
    }),
    env,
  );
  assert.equal(session.status, 201);
  const setCookie = session.headers.get("set-cookie");
  assert.match(setCookie || "", /^axys_session=/);
  const capabilities = await handle(
    new Request("https://axys.example/api/v1/capabilities", {
      headers: { cookie: setCookie!.split(";")[0] },
    }),
    env,
  );
  const body: any = await capabilities.json();
  assert.equal(capabilities.status, 200);
  assert.equal(body.data.credits.balance, 20);
  assert.equal(body.data.nebius, true);
  assert.equal(body.data.instagram, true);

  const oauth = await handle(
    new Request("https://axys.example/api/v1/oauth/start", {
      method: "POST",
      headers: { cookie: setCookie!.split(";")[0] },
    }),
    env,
  );
  assert.equal(oauth.status, 200);
  const oauthUrl = new URL((await oauth.json()).data.url);
  assert.equal(oauthUrl.origin, "https://www.instagram.com");
  assert.equal(oauthUrl.searchParams.get("client_id"), env.META_APP_ID);
  assert.match(oauthUrl.searchParams.get("state") || "", /^[A-Za-z0-9_-]+$/);
});

test("WhatsApp bridge creates an isolated draft and one-time Studio handoff", async () => {
  const { env } = fixture();
  const internalHeaders = {
    authorization: `Bearer ${env.EDGE_SERVICE_SECRET}`,
    "x-hermes-user-id": "919999999999",
  };
  const uploaded = await handle(
    new Request("https://axys.example/internal/assets/wa-message-image-1", {
      method: "PUT",
      headers: {
        ...internalHeaders,
        "content-type": "image/jpeg",
        "x-proofgate-source-message-id": "wamid.1",
      },
      body: new Uint8Array([255, 216, 255, 217]),
    }),
    env,
  );
  assert.equal(uploaded.status, 201);
  const assetId = (await uploaded.json()).assetId;
  assert.match(assetId, /^[0-9a-f-]{36}$/);

  const intake = await handle(
    new Request("https://axys.example/internal/intake", {
      method: "POST",
      headers: {
        ...internalHeaders,
        "content-type": "application/json",
        "x-hermes-message-id": "wamid.1",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        businessName: "Maya Bakery",
        description: "Weekend brownie box",
        fulfillmentArea: "Bengaluru",
        leadTime: "Saturday after 4 PM",
        orderWhatsAppNumber: "+919999999999",
        projectIntent: "both",
        catalog: [
          {
            name: "Brownie box",
            priceMinor: 65000,
            currency: "INR",
            imageAssetId: assetId,
          },
        ],
      }),
    }),
    env,
  );
  assert.equal(intake.status, 201);
  const studioUrl = (await intake.json()).studio.url;
  assert.match(studioUrl, /^https:\/\/axys\.example\/handoff\//);

  const handoffPage = await handle(new Request(studioUrl), env);
  assert.equal(handoffPage.status, 200);
  assert.match(await handoffPage.text(), /Open my workspace/);
  const exchange = await handle(
    new Request(studioUrl, { method: "POST" }),
    env,
  );
  assert.equal(exchange.status, 303);
  assert.equal(exchange.headers.get("location"), "/app");
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0];

  const drafts = await handle(
    new Request("https://axys.example/api/v1/intake/whatsapp-drafts", {
      headers: { cookie },
    }),
    env,
  );
  assert.equal(drafts.status, 200);
  const rows = (await drafts.json()).data;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].plan.businessName, "Maya Bakery");
  assert.equal(rows[0].plan.catalog[0].priceMinor, 65000);

  const replay = await handle(new Request(studioUrl, { method: "POST" }), env);
  assert.equal(replay.status, 410);
});

test("WhatsApp bridge rejects unauthenticated intake", async () => {
  const { env } = fixture();
  const response = await handle(
    new Request("https://axys.example/internal/intake", {
      method: "POST",
      headers: { "x-hermes-user-id": "919999999999" },
      body: "{}",
    }),
    env,
  );
  assert.equal(response.status, 401);
});

test("cloud CRM records explicit lead, order and contact evidence", async () => {
  const { env, values } = fixture();
  const session = await handle(
    new Request("https://axys.example/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ create: true }),
    }),
    env,
  );
  const tenantId = (await session.clone().json()).data.tenant;
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const campaignId = crypto.randomUUID();
  values.set(
    `campaign:${tenantId}:${campaignId}`,
    JSON.stringify({
      id: campaignId,
      tenantId,
      revision: 1,
      state: "Published",
      facts: {
        business: "QA Bakery",
        offer: "Brownie box",
        collection: "Saturday",
        contact: "https://wa.me/919999999999",
        products: [],
        confirmed: true,
        source: "merchant",
      },
      brief: "QA",
      mode: "Both",
      layout: "editorial",
      reelStyle: "warm",
    }),
  );
  values.set(`public:${campaignId}`, JSON.stringify({ tenantId }));
  const headers = { cookie, "content-type": "application/json" };
  const sparseRevision = await handle(
    new Request(
      `https://axys.example/api/v1/campaigns/${campaignId}/revision`,
      {
        method: "POST",
        headers,
        body: "{}",
      },
    ),
    env,
  );
  assert.equal(sparseRevision.status, 201);
  assert.equal(
    (await sparseRevision.json()).data.proposal.status,
    "insufficient_signal",
  );
  const created = await handle(
    new Request("https://axys.example/api/v1/crm/leads", {
      method: "POST",
      headers,
      body: JSON.stringify({
        campaignId,
        source: "merchant",
        customerLabel: "Saturday enquiry",
        consent: true,
        idempotencyKey: crypto.randomUUID(),
      }),
    }),
    env,
  );
  assert.equal(created.status, 201);
  const lead = (await created.json()).data;
  for (const status of ["Replied", "Qualified"]) {
    const changed = await handle(
      new Request(`https://axys.example/api/v1/crm/leads/${lead.id}/status`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          status,
          idempotencyKey: crypto.randomUUID(),
        }),
      }),
      env,
    );
    assert.equal(changed.status, 200);
  }
  const ordered = await handle(
    new Request(`https://axys.example/api/v1/crm/leads/${lead.id}/orders`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        amountMinor: 65000,
        currency: "INR",
        idempotencyKey: crypto.randomUUID(),
      }),
    }),
    env,
  );
  assert.equal(ordered.status, 201);

  const contact = await handle(
    new Request(`https://axys.example/s/${campaignId}/contact`, {
      redirect: "manual",
    }),
    env,
  );
  assert.equal(contact.status, 302);
  assert.equal(contact.headers.get("location"), "https://wa.me/919999999999");

  const summary = await handle(
    new Request(
      `https://axys.example/api/v1/crm/summary?campaignId=${campaignId}`,
      { headers: { cookie } },
    ),
    env,
  );
  const result = (await summary.json()).data;
  assert.equal(result.contactActions, 1);
  assert.equal(result.leads, 1);
  assert.equal(result.ordered, 1);
  assert.equal(result.revenueMinorByCurrency.INR, 65000);
});
