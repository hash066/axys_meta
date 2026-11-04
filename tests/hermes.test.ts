import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.ts";
import { hermesCommand } from "../server/hermes.ts";
import { ingestWhatsApp } from "../server/whatsapp.ts";
import { sign } from "../server/security.ts";
import { createApp } from "../server/app.ts";
import { Engine } from "../server/engine.ts";
import sharp from "sharp";
import {
  fetchWhatsAppMedia,
  type WhatsAppDraft,
  type WhatsAppMedia,
} from "../server/whatsapp.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "axys-hermes-"));
  const store = new Store(root);
  return {
    store,
    close() {
      store.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const context = {
  platform: "whatsapp_cloud",
  userId: "919000000001",
  messageId: "wamid.test-1",
};
const mapping = { "919000000001": "one", "919000000002": "two" };
test("Hermes preserves consecutive intake, deduplicates retries and isolates senders", () => {
  const f = fixture();
  try {
    const input = {
      action: "intake",
      context,
      payload: { text: "Bread is 100" },
    };
    hermesCommand(f.store, input, mapping);
    hermesCommand(f.store, input, mapping);
    hermesCommand(
      f.store,
      {
        ...input,
        context: { ...context, messageId: "wamid.test-2" },
        payload: { text: "Collection Saturday" },
      },
      mapping,
    );
    assert.equal(f.store.list("intake", "one").length, 2);
    assert.equal(f.store.list("intake", "two").length, 0);
    const draft = hermesCommand(
      f.store,
      { action: "draft", context, payload: {} },
      mapping,
    ).draft;
    assert.ok(draft);
    assert.equal(draft.brief, "Bread is 100\nCollection Saturday");
    assert.equal(draft.needsConfirmation, true);
    assert.throws(() =>
      hermesCommand(
        f.store,
        { ...input, context: { ...context, userId: "919000000099" } },
        mapping,
      ),
    );
    assert.throws(() =>
      hermesCommand(
        f.store,
        { ...input, payload: { text: "hello", tenantId: "two" } },
        mapping,
      ),
    );
    for (const action of ["publish", "approve", "execute_code"])
      assert.throws(() =>
        hermesCommand(f.store, { ...input, action }, mapping),
      );
  } finally {
    f.close();
  }
});
test("Hermes cannot prepare another tenant's campaign and status is scoped", () => {
  const f = fixture();
  try {
    const id = "f6e5c8db-c3d0-4f60-a23c-e559a1dcf9ed";
    f.store.put("campaign", "two", id, { id, state: "Draft", revision: 1 });
    assert.throws(() =>
      hermesCommand(
        f.store,
        { action: "prepare", context, payload: { campaignId: id } },
        mapping,
      ),
    );
    assert.deepEqual(
      hermesCommand(
        f.store,
        { action: "status", context, payload: {} },
        mapping,
      ).campaigns,
      [],
    );
    f.store.put("campaign", "one", id, {
      id,
      tenantId: "one",
      state: "Draft",
      revision: 1,
    });
    for (let i = 0; i < 2; i++)
      hermesCommand(
        f.store,
        { action: "prepare", context, payload: { campaignId: id } },
        mapping,
      );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n,
      1,
    );
  } finally {
    f.close();
  }
});
test("Meta webhook rejects invalid signatures and mismatched receiving phone IDs", () => {
  const f = fixture();
  try {
    const raw = Buffer.from(
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: "123" },
                  messages: [
                    {
                      id: "wamid.test",
                      from: context.userId,
                      type: "text",
                      text: { body: "hello" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const signature = "sha256=" + sign(raw.toString(), "secret");
    assert.throws(() =>
      ingestWhatsApp(f.store, raw, "invalid", "secret", mapping, "123"),
    );
    assert.equal(
      ingestWhatsApp(f.store, raw, signature, "secret", mapping, "456")
        .accepted,
      0,
    );
    assert.equal(
      ingestWhatsApp(f.store, raw, signature, "secret", mapping, "123")
        .accepted,
      1,
    );
    assert.equal(
      ingestWhatsApp(f.store, raw, signature, "secret", mapping, "123")
        .accepted,
      0,
    );
  } finally {
    f.close();
  }
});
test("WhatsApp captions and media references accumulate into one sender draft", () => {
  const f = fixture();
  try {
    const raw = Buffer.from(
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: "123" },
                  messages: [
                    {
                      id: "wamid.photo",
                      from: context.userId,
                      type: "image",
                      image: { id: "meta-media-1", caption: "Sourdough loaf" },
                    },
                    {
                      id: "wamid.voice",
                      from: context.userId,
                      type: "audio",
                      audio: { id: "meta-media-2" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const result = ingestWhatsApp(
      f.store,
      raw,
      "sha256=" + sign(raw.toString(), "secret"),
      "secret",
      mapping,
      "123",
    );
    assert.deepEqual(result, { accepted: 2, media: 2, decisions: 0 });
    const draft = f.store.list<WhatsAppDraft>("whatsapp-draft", "one")[0];
    assert.equal(draft.brief, "Sourdough loaf");
    assert.equal(draft.media.length, 2);
    assert.deepEqual(
      draft.media.map((item) => item.status),
      ["PendingFetch", "PendingFetch"],
    );
    assert.equal(f.store.list("whatsapp-draft", "two").length, 0);
    assert.equal(
      ingestWhatsApp(
        f.store,
        raw,
        "sha256=" + sign(raw.toString(), "secret"),
        "secret",
        mapping,
        "123",
      ).accepted,
      0,
    );
  } finally {
    f.close();
  }
});
test("authenticated Meta image retrieval validates and attaches a private asset", async () => {
  const f = fixture();
  try {
    hermesCommand(
      f.store,
      {
        action: "intake",
        context,
        payload: {
          media: [
            { id: "meta-image-id", type: "image", caption: "Bread photo" },
          ],
        },
      },
      mapping,
    );
    const media = f.store.list<WhatsAppMedia>("whatsapp-media", "one")[0];
    const image = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: "#d09a62",
      },
    })
      .png()
      .toBuffer();
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("graph.facebook.com"))
        return Response.json({
          url: "https://lookaside.fbsbx.com/whatsapp-media/test",
          mime_type: "image/png",
          file_size: image.length,
        });
      return new Response(image, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(image.length),
        },
      });
    };
    const asset = await fetchWhatsAppMedia(f.store, "one", media.id, {
      accessToken: "test-token",
      apiVersion: "v1.0",
      fetcher: fetcher as typeof fetch,
    });
    assert.equal(asset?.mime, "image/jpeg");
    assert.equal(calls.length, 2);
    const stored = f.store.get<WhatsAppMedia>(
      "whatsapp-media",
      "one",
      media.id,
    );
    assert.equal(stored?.status, "Stored");
    const draft = f.store.list<WhatsAppDraft>("whatsapp-draft", "one")[0];
    assert.equal(draft.media[0].assetId, asset?.id);
  } finally {
    f.close();
  }
});
test("WhatsApp media jobs retry durably and stop after the retry limit", async () => {
  const f = fixture();
  try {
    hermesCommand(
      f.store,
      {
        action: "intake",
        context,
        payload: { media: [{ id: "retry-image", type: "image" }] },
      },
      mapping,
    );
    const job = f.store.db
      .prepare("SELECT * FROM jobs WHERE kind='whatsapp-media'")
      .get() as any;
    assert.equal(job.state, "queued");
    let calls = 0;
    const engine = new Engine(f.store);
    engine.whatsappMedia = async () => {
      calls++;
      if (calls < 2) throw new Error("temporary Meta failure");
      return undefined;
    };
    await engine.tick();
    let current = f.store.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(job.id) as any;
    assert.equal(current.state, "queued");
    assert.equal(current.tries, 1);
    assert.equal(
      f.store.list<WhatsAppMedia>("whatsapp-media", "one")[0].status,
      "PendingFetch",
    );
    f.store.db.prepare("UPDATE jobs SET available=0 WHERE id=?").run(job.id);
    await engine.tick();
    current = f.store.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(job.id) as any;
    assert.equal(current.state, "done");
    assert.equal(current.tries, 2);

    f.store.db
      .prepare(
        "UPDATE jobs SET state='queued',tries=4,available=0,error=NULL WHERE id=?",
      )
      .run(job.id);
    engine.whatsappMedia = async () => {
      throw new Error("still unavailable");
    };
    await engine.tick();
    current = f.store.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(job.id) as any;
    assert.equal(current.state, "failed");
    assert.equal(current.tries, 5);
    assert.equal(
      f.store.list<WhatsAppMedia>("whatsapp-media", "one")[0].status,
      "Failed",
    );
  } finally {
    f.close();
  }
});
test("Studio explicitly confirms and idempotently imports a WhatsApp draft", async () => {
  const f = fixture();
  const previousKeys = process.env.AXYS_ACCESS_KEYS;
  delete process.env.AXYS_ACCESS_KEYS;
  const server = createApp(f.store).app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const asset = await new Engine(f.store).asset(
      "local-demo",
      Buffer.from("owned-image-fixture"),
      "image/jpeg",
    );
    const id = "a".repeat(64);
    const updatedAt = "2026-10-19T10:00:00.000Z";
    f.store.put("whatsapp-draft", "local-demo", id, {
      id,
      source: "whatsapp",
      sender: id,
      brief: "Bakery website",
      messageIds: ["message"],
      media: [
        { id: "media", kind: "image", status: "Stored", assetId: asset.id },
      ],
      mode: "Website",
      status: "NeedsConfirmation",
      updatedAt,
    });
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(base + "/api/v1/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4310",
      },
      body: JSON.stringify({ key: "local-demo" }),
    });
    const cookie = String(login.headers.get("set-cookie")).split(";")[0];
    const body = {
      confirmFacts: true,
      draftUpdatedAt: updatedAt,
      campaign: {
        facts: {
          business: "Test Bakery",
          offer: "Fresh sourdough",
          collection: "Collect Saturday",
          contact: "https://example.com/order",
          products: [
            {
              id: "29a81e64-cd01-45cb-92b0-b9bd728f6f03",
              name: "Sourdough",
              priceMinor: 50000,
              currency: "INR",
              assetId: asset.id,
            },
          ],
          confirmed: true,
          source: "whatsapp",
        },
        mode: "Website",
        layout: "editorial",
        reelStyle: "warm",
        brief: "Confirmed from WhatsApp draft",
      },
    };
    const imported = await fetch(
      base + `/api/v1/intake/whatsapp-drafts/${id}/import`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "http://127.0.0.1:4310",
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(imported.status, 201);
    const campaign = (await imported.json()).data;
    assert.equal(campaign.state, "Draft");
    const repeated = await fetch(
      base + `/api/v1/intake/whatsapp-drafts/${id}/import`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "http://127.0.0.1:4310",
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).data.id, campaign.id);
    assert.equal(f.store.list("campaign", "local-demo").length, 1);
  } finally {
    if (previousKeys === undefined) delete process.env.AXYS_ACCESS_KEYS;
    else process.env.AXYS_ACCESS_KEYS = previousKeys;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});
test("Hermes HTTP boundary rejects unauthenticated commands", async () => {
  const f = fixture();
  const previousKey = process.env.AXYS_HERMES_BRIDGE_KEY;
  const previousMap = process.env.WHATSAPP_TENANT_MAP;
  process.env.AXYS_HERMES_BRIDGE_KEY = "test-bridge-key-".repeat(4);
  process.env.WHATSAPP_TENANT_MAP = JSON.stringify(mapping);
  const server = createApp(f.store).app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/hermes/tool`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", context, payload: {} }),
      },
    );
    assert.equal(response.status, 403);
    const authorized = await fetch(
      `http://127.0.0.1:${address.port}/internal/hermes/tool`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.AXYS_HERMES_BRIDGE_KEY}`,
        },
        body: JSON.stringify({ action: "status", context, payload: {} }),
      },
    );
    assert.equal(authorized.status, 200);
    assert.deepEqual((await authorized.json()).campaigns, []);
  } finally {
    if (previousKey === undefined) delete process.env.AXYS_HERMES_BRIDGE_KEY;
    else process.env.AXYS_HERMES_BRIDGE_KEY = previousKey;
    if (previousMap === undefined) delete process.env.WHATSAPP_TENANT_MAP;
    else process.env.WHATSAPP_TENANT_MAP = previousMap;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});
