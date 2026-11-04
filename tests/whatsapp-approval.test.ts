import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.ts";
import {
  approvalButtons,
  parseButtonId,
  recordDecision,
  verifyButtonReply,
  type ApprovalSubject,
} from "../server/whatsapp-approval.ts";

const secret = "test-secret";
const subject: ApprovalSubject = {
  tenant: "one",
  campaignId: "c1",
  revision: 2,
  siteHash: "s".repeat(64),
  videoHash: "v".repeat(64),
};
const reply = (id: string) => ({
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id, title: "x" } },
});
const ids = () =>
  approvalButtons("919000000001", subject, "Review", secret).interactive.action
    .buttons.map((b) => b.reply.id);

test("buttons fit WhatsApp limits and carry three signed actions", () => {
  const payload = approvalButtons("919000000001", subject, "Review", secret);
  const buttons = payload.interactive.action.buttons;
  assert.equal(buttons.length, 3);
  for (const b of buttons) {
    assert.ok(b.reply.id.length <= 256);
    assert.ok(b.reply.title.length <= 20);
  }
  assert.equal(parseButtonId(buttons[0].reply.id)?.action, "approve");
});

test("a genuine reply verifies; tampering, other secrets and stale content do not", () => {
  const [approve] = ids();
  assert.equal(verifyButtonReply(reply(approve), subject, secret), "approve");
  assert.equal(verifyButtonReply(reply(approve), subject, "other"), undefined);
  assert.equal(
    verifyButtonReply(reply(approve.replace("approve", "changes")), subject, secret),
    undefined,
  );
  assert.equal(
    verifyButtonReply(reply(approve), { ...subject, siteHash: "x".repeat(64) }, secret),
    undefined,
  );
  assert.equal(
    verifyButtonReply(reply(approve), { ...subject, campaignId: "c2" }, secret),
    undefined,
  );
  assert.equal(verifyButtonReply({ type: "text" }, subject, secret), undefined);
  assert.equal(parseButtonId("garbage"), undefined);
});

test("decisions are recorded once per message and never publish", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "axys-appr-"));
  const store = new Store(root);
  try {
    const first = recordDecision(store, subject, "approve", "wamid.1", "h");
    assert.equal(first?.status, "Recorded");
    assert.equal(recordDecision(store, subject, "approve", "wamid.1", "h"), undefined);
    assert.equal(store.list("whatsapp-decision", "one").length, 1);
    assert.equal(store.list("whatsapp-decision", "two").length, 0);
  } finally {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import { createHmac } from "node:crypto";
import { ingestWhatsApp } from "../server/whatsapp.ts";
import { approvalButtons as buildButtons } from "../server/whatsapp-approval.ts";

test("webhook records a verified button tap once and ignores forged, stale and unmapped taps", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "axys-appr2-"));
  const store = new Store(root);
  try {
    const campaign = {
      id: "c1",
      tenantId: "one",
      revision: 2,
      siteHash: subject.siteHash,
      videoHash: subject.videoHash,
    };
    store.put("campaign", "one", "c1", campaign);
    const wa = "app-secret";
    const body = (from: string, mid: string, id: string) =>
      Buffer.from(
        JSON.stringify({
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: "123" },
                    messages: [{ id: mid, from, ...reply(id) }],
                  },
                },
              ],
            },
          ],
        }),
      );
    const send = (raw: Buffer) =>
      ingestWhatsApp(
        store,
        raw,
        "sha256=" + createHmac("sha256", wa).update(raw).digest("hex"),
        wa,
        { "919000000001": "one" },
        "123",
        wa,
      );
    const good = buildButtons("919000000001", subject, "r", wa).interactive.action
      .buttons[0].reply.id;
    assert.equal(send(body("919000000001", "m1", good)).decisions, 1);
    assert.equal(send(body("919000000001", "m1", good)).decisions, 0);
    assert.equal(
      send(body("919000000001", "m2", good.slice(0, -1) + "0")).decisions,
      0,
    );
    assert.equal(send(body("919000000009", "m3", good)).decisions, 0);
    store.put("campaign", "one", "c1", { ...campaign, siteHash: "z".repeat(64) });
    assert.equal(send(body("919000000001", "m4", good)).decisions, 0);
    assert.equal(store.list("whatsapp-decision", "one").length, 1);
  } finally {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import { createApp } from "../server/app.ts";

test("Studio lists WhatsApp decisions for its own campaign only", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "axys-appr3-"));
  const store = new Store(root);
  const previous = process.env.AXYS_ACCESS_KEYS;
  delete process.env.AXYS_ACCESS_KEYS;
  const server = createApp(store).app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const mine = { ...subject, tenant: "local-demo" };
    store.put("campaign", "local-demo", "c1", {
      id: "c1",
      tenantId: "local-demo",
      revision: 3,
    });
    recordDecision(store, mine, "changes", "m1", "h");
    recordDecision(store, { ...mine, campaignId: "c9" }, "approve", "m2", "h");
    recordDecision(store, { ...mine, tenant: "other" }, "approve", "m3", "h");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = await fetch(base + "/api/v1/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:4310",
      },
      body: JSON.stringify({ key: "local-demo" }),
    });
    const cookie = String(login.headers.get("set-cookie")).split(";")[0];
    const res = await fetch(base + "/api/v1/campaigns/c1/decisions", {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()).data;
    assert.equal(data.length, 1);
    assert.equal(data[0].action, "changes");
    assert.equal(data[0].current, false); // taken at revision 2, campaign is now 3
  } finally {
    server.close();
    if (previous === undefined) delete process.env.AXYS_ACCESS_KEYS;
    else process.env.AXYS_ACCESS_KEYS = previous;
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
