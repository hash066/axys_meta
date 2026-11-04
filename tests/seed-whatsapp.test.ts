import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { extractPlan } from "../packages/meta/intake.ts";
import { tinyMp3 } from "./fake-gateway.ts";

const ORIGIN = "http://127.0.0.1:4310";
const TRANSCRIPT =
  "Hey, it's Mia from Stride Lane. We're dropping our our new white running sneaker with the sage green panels this Saturday, November 7th, 10 to 4. It's $89. Can you turn this photo into a reel and a page for me?";

test("extractPlan reads only what the transcript says and lists what it inferred", () => {
  const plan = extractPlan(TRANSCRIPT, { phone: "+1 555 555 0142" });
  assert.deepEqual(plan, {
    businessName: "Stride Lane",
    description: "New white running sneaker with the sage green panels",
    leadTime: "Saturday, Nov 7, 10am to 4pm",
    orderWhatsAppNumber: "15555550142",
    catalog: [{ name: "White running sneaker with the sage green panels", priceMinor: 8900, currency: "USD" }],
    source: "deterministic-transcript-extraction",
    uncertain: ["am/pm was not spoken for the collection time and was inferred."],
  });
  // explicit am/pm, a spoken amount, a timezone supplied by the operator
  const b = extractPlan(
    "This is Raj from Annapurna Sweets. We have our kaju katli box on Nov 12th from 9am to 5pm for eighty nine dollars. Call 415 555 0100.",
    { timezone: "ET" },
  );
  assert.equal(b.businessName, "Annapurna Sweets");
  assert.equal(b.leadTime, "Nov 12, 9am to 5pm ET");
  assert.deepEqual(b.catalog, [{ name: "Kaju katli box", priceMinor: 8900, currency: "USD" }]);
  assert.equal(b.orderWhatsAppNumber, "4155550100");
  assert.deepEqual(b.uncertain, []);
  // nothing recognisable -> empty fields and honest notes, never invented values
  const none = extractPlan("hello there, call me back");
  assert.equal(none.businessName, "");
  assert.deepEqual(none.catalog, []);
  assert.equal(none.leadTime, "");
  assert.ok(none.uncertain.length >= 4);
  // two prices -> the first, flagged
  assert.ok(extractPlan("It's Al from Shoe Co, we are dropping our boots Nov 3, 10 to 4. It's $50 or $60.").uncertain.some((u) => /More than one price/.test(u)));
});

test("scripts/seed-whatsapp-draft.mts seeds a draft the Studio's import flow accepts and the Brief can be pre-filled from", async () => {
  const dir = mkdtempSync(path.resolve("var-test-"));
  try {
    const photo = path.join(dir, "photo.jpg");
    writeFileSync(
      photo,
      await sharp({ create: { width: 600, height: 600, channels: 3, background: "#c39159" } }).jpeg().toBuffer(),
    );
    const voice = path.join(dir, "voice.mp3");
    writeFileSync(voice, tinyMp3());
    const data = path.join(dir, "data");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-whatsapp-draft.mts", ...args], { encoding: "utf8" });

    // missing inputs are refused with a clear message
    const noPhoto = run("--transcript", TRANSCRIPT);
    assert.equal(noPhoto.status, 1);
    assert.match(noPhoto.stderr, /--photo/);
    // dry run touches nothing
    const dry = run("--photo", photo, "--transcript", TRANSCRIPT, "--data-dir", data, "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).plan.catalog[0].priceMinor, 8900);

    const r = run("--photo", photo, "--voice", voice, "--transcript", TRANSCRIPT, "--data-dir", data, "--tenant", "local-demo", "--phone", "15555550142");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.seeded, true);
    assert.equal(out.simulated, true);
    assert.deepEqual(out.media, ["image", "audio"]);
    assert.match(out.draftId, /^[a-f0-9]{64}$/);

    // the real server reads that data dir and lists the draft for the workspace
    const store = new Store(data);
    const { app } = createApp(store);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((res) => server.once("listening", res));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const login = await fetch(base + "/api/v1/session", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "local-demo" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const call = (method: string, url: string, body?: unknown) =>
        fetch(base + url, {
          method,
          headers: { Origin: ORIGIN, Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      const drafts = (await (await call("GET", "/api/v1/intake/whatsapp-drafts")).json()).data;
      assert.equal(drafts.length, 1);
      const d = drafts[0];
      assert.equal(d.source, "whatsapp");
      assert.equal(d.status, "NeedsConfirmation");
      assert.equal(d.simulated, true);
      assert.equal(d.brief, TRANSCRIPT);
      assert.equal(d.plan.businessName, "Stride Lane");
      assert.deepEqual(d.media.map((m: any) => [m.kind, m.status]), [["image", "Stored"], ["audio", "Stored"]]);
      assert.ok(d.media.every((m: any) => m.assetId));
      // The Studio's pickDraft builds the Brief from plan exactly like this, then imports.
      const image = d.media.find((m: any) => m.kind === "image");
      const audio = d.media.find((m: any) => m.kind === "audio");
      const campaign = {
        facts: {
          business: d.plan.businessName,
          offer: d.plan.description,
          collection: d.plan.leadTime,
          contact: `https://wa.me/${d.plan.orderWhatsAppNumber}`,
          confirmed: true,
          source: "whatsapp",
          products: [
            {
              id: crypto.randomUUID(),
              name: d.plan.catalog[0].name,
              priceMinor: d.plan.catalog[0].priceMinor,
              currency: d.plan.catalog[0].currency,
              assetId: image.assetId,
            },
          ],
        },
        mode: d.mode,
        layout: "editorial",
        reelStyle: "warm",
        brief: d.brief,
        voiceAssetId: audio.assetId,
      };
      const imported = await call("POST", `/api/v1/intake/whatsapp-drafts/${d.id}/import`, {
        confirmFacts: true,
        draftUpdatedAt: d.updatedAt,
        campaign,
      });
      assert.equal(imported.status, 201, await imported.clone().text());
      const c = (await imported.json()).data;
      assert.equal(c.facts.source, "whatsapp");
      assert.equal(c.facts.products[0].currency, "USD");
      assert.equal(c.facts.products[0].priceMinor, 8900);
      assert.equal(c.facts.collection, "Saturday, Nov 7, 10am to 4pm");
      const after = (await (await call("GET", "/api/v1/intake/whatsapp-drafts")).json()).data[0];
      assert.equal(after.status, "Imported");
      assert.equal(after.campaignId, c.id);
      // another tenant sees nothing
      assert.equal(store.list("whatsapp-draft", "someone-else").length, 0);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
      store.db.close();
    }
    // re-seeding replaces the draft for the same phone (still exactly one)
    const again = run("--photo", photo, "--transcript", TRANSCRIPT, "--data-dir", data);
    assert.equal(again.status, 0, again.stderr);
    const s2 = new Store(data);
    assert.equal(s2.list("whatsapp-draft", "local-demo").length, 1);
    s2.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
