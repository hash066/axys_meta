import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { MuseGateway, resetMuseStatusCache } from "../packages/meta/gateway.ts";
import {
  narrationKey,
  narrationProblem,
  planNarration,
  templateNarration,
  MAX_CHARS,
  MAX_WORDS,
} from "../packages/meta/narration.ts";
import {
  assertPreflightClear,
  deterministicIssues,
  PreflightBlockedError,
} from "../packages/meta/preflight.ts";
import { muxAudio } from "../packages/renderers/audio.ts";
import type { Campaign } from "../packages/campaign/index.ts";
import { bases, buildCampaign, clone } from "../eval/fixtures.ts";
import { startFakeGateway, type FakeOptions } from "./fake-gateway.ts";

const ORIGIN = "http://127.0.0.1:4310";
const TENANT = "local-demo";
const COLLECTION = "Saturday, Nov 7, 10am to 4pm ET";
const GOOD =
  "Stride Lane has the White sneaker for $89.00. Come by Saturday, Nov 7, 10am to 4pm ET, or message us to order.";

async function harness(options: FakeOptions = {}, narrate = true) {
  resetMuseStatusCache();
  const root = mkdtempSync(path.resolve("var-test-"));
  const store = new Store(root);
  const fake = await startFakeGateway(options);
  const { app, engine } = createApp(store, {
    gateway: new MuseGateway({ baseUrl: fake.url }),
    narrate,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const login = await fetch(base + "/api/v1/session", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ key: "local-demo" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const call = (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(base + url, {
      method,
      headers: {
        Origin: ORIGIN,
        Cookie: cookie,
        ...(body !== undefined && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      body:
        body === undefined
          ? undefined
          : Buffer.isBuffer(body)
            ? new Uint8Array(body)
            : JSON.stringify(body),
    });
  const newCampaign = async (priceMinor = 8900) => {
    const img = await sharp(
      Buffer.from(
        `<svg width="600" height="600"><rect width="600" height="600" fill="#c39159"/><circle cx="300" cy="300" r="150" fill="#263d35"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const up = await call("POST", "/api/v1/assets", img, {
      "Content-Type": "image/png",
      "x-asset-rights": "confirmed",
    });
    const assetId = (await up.json()).data.id as string;
    const r = await call("POST", "/api/v1/campaigns", {
      facts: {
        business: "Stride Lane",
        offer: "Weekend drop",
        collection: COLLECTION,
        contact: "https://stridelane.example/order",
        confirmed: true,
        source: "merchant",
        products: [
          { id: crypto.randomUUID(), name: "White sneaker", priceMinor, currency: "USD", assetId },
        ],
      },
      mode: "Reels",
      layout: "editorial",
      reelStyle: "warm",
      brief: "",
    });
    assert.equal(r.status, 201);
    return (await r.json()).data as Campaign;
  };
  const speakCalls = () => fake.calls.filter((c) => c.route === "/v1/speak");
  const narrationCalls = () =>
    fake.calls.filter((c) => c.route === "/v1/json" && String(c.body.prompt).startsWith("You write the voice-over"));
  return {
    root,
    store,
    engine,
    fake,
    call,
    base,
    newCampaign,
    speakCalls,
    narrationCalls,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await fake.close();
      store.db.close();
      assert.equal(path.dirname(path.resolve(root)), path.resolve("."));
      rmSync(root, { recursive: true, force: true });
      resetMuseStatusCache();
    },
  };
}

/* ------------------------------------------------------------- measurement */
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
function volume(file: string, window?: [number, number]) {
  const af = (window ? `atrim=${window[0]}:${window[1]},` : "") + "volumedetect";
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", af, "-f", "null", "-"], { encoding: "utf8" });
  const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1]);
  const max = Number(/max_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1]);
  assert.ok(Number.isFinite(mean) && Number.isFinite(max), r.stderr.slice(-300));
  return { mean, max };
}
function loudness(file: string) {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
  const tail = r.stderr.slice(r.stderr.indexOf("Summary:"));
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(tail)?.[1]);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(tail)?.[1]);
  assert.ok(Number.isFinite(lufs) && Number.isFinite(peak), tail.slice(0, 300));
  return { lufs, peak };
}
function videoMd5(file: string) {
  const r = spawnSync(ffmpeg, ["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"], { encoding: "utf8" });
  const m = /MD5=([0-9a-f]{32})/.exec(r.stdout);
  assert.ok(m, r.stderr);
  return m[1];
}
function streams(file: string) {
  const r = spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" });
  return JSON.parse(r.stdout).streams as { codec_type: string; codec_name: string; channels?: number; sample_rate?: string }[];
}
const rendersDir = (h: { store: Store }, c: Campaign) =>
  path.join(h.store.root, "renders", c.tenantId, c.id, String(c.revision));

/* ------------------------------------------------------------- validation */
const usd = () =>
  buildCampaign({
    key: "narr",
    business: "Stride Lane",
    offer: "Weekend drop",
    collection: COLLECTION,
    contact: "https://stridelane.example/order",
    products: [{ name: "White sneaker", priceMinor: 8900, currency: "USD" }],
  });

test("narration validation: a grounded sentence passes, every kind of drift is named and refused", () => {
  const c = usd();
  assert.equal(narrationProblem(GOOD, c), null);
  assert.equal(narrationProblem("Stride Lane. White sneaker, $89. Saturday, Nov 7, 10am to 4pm ET. Tap the link to order.", c), null);
  const bad: [string, RegExp][] = [
    ["Stride Lane has the White sneaker for $79.00. Come by Saturday, Nov 7, 10am to 4pm ET, or message us to order.", /price/],
    ["Stride Lane has the White sneaker. Come by Saturday, Nov 7, 10am to 4pm ET, or message us to order now.", /price/],
    ["Stride Lane has the White sneaker for $89.00 and a $5.00 case. Saturday, Nov 7, 10am to 4pm ET. Order.", /price|number/],
    ["Stride Lane has the White sneaker for 89 euros. Saturday, Nov 7, 10am to 4pm ET. Order today.", /price/],
    ["Stride Lane has the White sneaker for $89.00. Saturday, Nov 8, 10am to 4pm ET. Order through the link.", /collection/],
    ["Stride Lane has the White sneaker for $89.00. Saturday, Nov 7, 10am to 5pm ET. Order through the link.", /collection/],
    ["Stride Lane has the White sneaker for $89.00. Saturday, Nov 7, 10am to 4pm ET. Order through the link, 20 pairs left.", /number 20/],
    ["Stride Lane has the best White sneaker for $89.00. Saturday, Nov 7, 10am to 4pm ET. Order through the link.", /claim word "best"/],
    ["Stride Lane has the White sneaker for $89.00, free shipping. Saturday, Nov 7, 10am to 4pm ET. Order through the link.", /claim word "free"/],
    ["Stride Lane has the White sneaker for $89.00, a guaranteed fit. Saturday, Nov 7, 10am to 4pm ET. Order through the link.", /claim word/],
    ["Stride Lane has the White sneaker for $89.00, limited stock. Saturday, Nov 7, 10am to 4pm ET. Order through the link.", /claim word "limited"/],
    ["Stride Lane has the White sneaker for $89.00, 20% off. Saturday, Nov 7, 10am to 4pm ET. Order through the link.", /symbols|claim word|number/],
    ["Stride Lane has the White sneaker for $89.00 two days only. Saturday, Nov 7, 10am to 4pm ET. Order through the link.", /number word|claim word/],
    ["Stride Lane has the White sneaker for $89.00. Saturday, Nov 7, 10am to 4pm ET and again in December. Order through the link.", /date \(dec\)/],
    ["Stride Lane has the White sneaker for $89.00. Saturday, Nov 7, 10am to 4pm ET, or tomorrow. Order through the link.", /day \(tom\)/],
    ["Stride Lane has the White sneaker for $89.00. Saturday, Nov 7, 10am to 4pm ET. Visit https://stridelane.example/order", /web address/],
    ["Stride Lane has the White sneaker for $89.00. Saturday, Nov 7, 10am to 4pm ET.", /call to action/],
    ["Sneaker for $89.00. Saturday, Nov 7, 10am to 4pm ET. Tap the link to order.", /business/],
    ["Stride Lane has the shoe for $89.00. Saturday, Nov 7, 10am to 4pm ET. Tap the link to order.", /White sneaker/],
    ["Stride Lane has the White sneaker \u{1F45F} for $89.00. Saturday, Nov 7, 10am to 4pm ET. Tap the link to order.", /emoji|symbols/],
    ["Stride Lane\nWhite sneaker $89.00. Saturday, Nov 7, 10am to 4pm ET. Tap the link to order.", /line break/],
    ["Order now.", /too short|business/],
    [GOOD + " " + GOOD, /words/],
  ];
  for (const [text, why] of bad)
    assert.match(narrationProblem(text, c) ?? "VALID", why, text);
  // a claim word the merchant's own facts use is the merchant's claim, not the model's
  const free = buildCampaign({
    key: "free",
    business: "Tin Co",
    offer: "Free tin with any two teas",
    collection: "Autumn flush",
    contact: "https://tin.example/c",
    products: [{ name: "Masala chai", priceMinor: 1200, currency: "USD" }],
  });
  assert.equal(narrationProblem("Tin Co. Masala chai, $12.00. Autumn flush. Free tin with any two teas. Tap the link to order.", free), null);
});

test("the deterministic template is always short, grounded and preflight-clean for every merchant shape", () => {
  for (const b of bases()) {
    const c = b.campaign;
    const t = templateNarration(c);
    assert.ok(t.split(/\s+/).length <= MAX_WORDS + 0 || t.length > MAX_CHARS, `${b.key}: ${t}`);
    // Whatever the template says, it is exactly the confirmed facts: the real preflight finds nothing to block.
    const x: Campaign = clone(c);
    x.generation = {
      revision: 1, ai: false, videoJobs: [],
      narration: { text: t, voice: "reel", model: "m", credits: 0, cached: true, source: "template" },
    };
    assert.deepEqual(
      deterministicIssues(x).filter((i) => i.severity === "block" && i.surface === "narration"),
      [],
      `${b.key}: ${t}`,
    );
    // And it names the confirmed price of the first product exactly once.
    assert.ok(t.includes(x.reel!.shots[0].text.split("\n")[1]), `${b.key}: ${t}`);
  }
  const t = templateNarration(usd());
  assert.equal(t, "Stride Lane. White sneaker, $89.00. Saturday, Nov 7, 10am to 4pm ET. Tap the link to order.");
  assert.equal(narrationProblem(t, usd()), null);
  assert.ok(t.length <= MAX_CHARS && t.split(" ").length <= MAX_WORDS);
});

/* ---------------------------------------------------------------- planning */
test("planNarration: Wonder text is used when valid; a violation or a failure falls back to the template; text is cached per campaign", async () => {
  const h = await harness({ narration: GOOD });
  try {
    const c = await h.newCampaign();
    const gw = h.engine.gateway;
    const a = await planNarration(h.store, gw, c, "sneaker");
    assert.deepEqual(
      { text: a.text, source: a.source, textCached: a.textCached, textModel: a.textModel },
      { text: GOOD, source: "wonder", textCached: false, textModel: "muse-wonder-1.0" },
    );
    // Same campaign again: cached, no new Wonder call, identical words.
    const b = await planNarration(h.store, gw, c, "sneaker");
    assert.equal(b.text, GOOD);
    assert.equal(b.textCached, true);
    assert.equal(h.narrationCalls().length, 1);
    // The prompt carries the facts and the visual subject, as untrusted data.
    const prompt = String(h.narrationCalls()[0].body.prompt);
    assert.match(prompt, /"priceText":"\$89\.00"/);
    assert.match(prompt, /"visualSubject":"sneaker"/);
    assert.equal(h.narrationCalls()[0].body.model, "wonder");
    // A different visual subject, price or date is a different key -> Wonder is asked again.
    assert.notEqual(narrationKey(c, "sneaker"), narrationKey(c, "shoe"));
    const pricier = clone(c);
    pricier.facts.products[0].priceMinor = 9500;
    assert.notEqual(narrationKey(c, "sneaker"), narrationKey(pricier, "sneaker"));
    const later = clone(c);
    later.facts.collection = "Sunday, Nov 8, 10am to 4pm ET";
    assert.notEqual(narrationKey(c, "sneaker"), narrationKey(later, "sneaker"));
    // Wrong price from Wonder (for the changed campaign) -> template, with the reason.
    h.fake.state.narration = GOOD; // still says $89.00
    const bad = await planNarration(h.store, gw, pricier, "sneaker");
    assert.equal(bad.source, "template");
    assert.match(bad.fallbackReason!, /\$95\.00/);
    assert.match(bad.text, /\$95\.00/);
    assert.equal(bad.textCached, false);
    // ... and the template is cached too, so the same words are spoken again (free via the gateway cache).
    const again = await planNarration(h.store, gw, pricier, "sneaker");
    assert.equal(again.text, bad.text);
    assert.equal(again.textCached, true);
    // Wonder down -> template.
    h.fake.state.failJson = true;
    const down = await planNarration(h.store, gw, later, "sneaker");
    assert.equal(down.source, "template");
    assert.match(down.text, /Sunday, Nov 8/);
    // Garbage shape -> template.
    h.fake.state.failJson = false;
    h.fake.state.narration = () => ({ text: 42 });
    const odd = await planNarration(h.store, gw, clone({ ...c, id: crypto.randomUUID() }), "x");
    assert.equal(odd.source, "template");
    // The narration is counted against the campaign's Muse call cap.
    assert.ok(h.store.get<any>("muse-calls", c.tenantId, c.id).byKind.narration >= 3);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------- end to end */
test("generate adds narration + music bed: voice from the gateway, AAC stereo, video untouched, audible and not clipping", async () => {
  const h = await harness({ narration: GOOD });
  try {
    const campaign = await h.newCampaign();
    const c = h.engine.get(TENANT, campaign.id);
    assert.equal(await h.engine.generate(c, false), true);
    const done = h.engine.get(TENANT, campaign.id);
    assert.equal(done.state, "NeedsReview");
    // exactly one voice call, with the validated words and the "reel" voice
    assert.equal(h.speakCalls().length, 1);
    assert.deepEqual(h.speakCalls()[0].body, { text: GOOD, voice: "reel" });
    const n = done.generation!.narration!;
    assert.deepEqual(n, {
      text: GOOD,
      voice: "reel",
      model: "eleven_flash_v2_5",
      credits: GOOD.length * 0.5,
      cached: false,
      source: "wonder",
      textCached: false,
      textModel: "muse-wonder-1.0",
    });
    assert.deepEqual(done.generation!.audio, { mix: "voice+bed" });
    assert.equal(done.generation!.warnings, undefined);
    // also in the campaign trace
    assert.deepEqual((done.trace as any).narration, n);
    // the stored mp4: exactly one AAC stereo audio stream, the video stream is still h264
    const dir = rendersDir(h, done);
    const final = path.join(dir, "reel-final.mp4");
    const types = streams(final);
    assert.deepEqual(types.map((s) => s.codec_type).sort(), ["audio", "video"]);
    const audio = types.find((s) => s.codec_type === "audio")!;
    assert.equal(audio.codec_name, "aac");
    assert.equal(audio.channels, 2);
    assert.equal(audio.sample_rate, "48000");
    // the video stream was copied, not re-encoded: its packets are bit-identical
    assert.equal(videoMd5(final), videoMd5(path.join(dir, "reel-silent.mp4")));
    // loudness on the real mux: audible, headroom kept (no clipping)
    const all = volume(final);
    assert.ok(all.mean > -40, `mean ${all.mean} dB is inaudible`);
    assert.ok(all.max < -1, `peak ${all.max} dB has no headroom`);
    const r128 = loudness(final);
    assert.ok(r128.lufs > -32 && r128.lufs < -12, `integrated ${r128.lufs} LUFS`);
    assert.ok(r128.peak < -1, `sample peak ${r128.peak} dBFS`);
    // the voice window is clearly louder than the same window of a bed-only mux (the tone is the voice)
    const bedOnly = path.join(dir, "bed-only-check.mp4");
    await muxAudio({ video: path.join(dir, "reel-silent.mp4"), out: bedOnly });
    const withVoice = volume(final, [0.8, 1.8]);
    const bedWindow = volume(bedOnly, [0.8, 1.8]);
    assert.ok(withVoice.mean > bedWindow.mean + 3, `${withVoice.mean} vs bed ${bedWindow.mean}`);
    // the bed alone is audible too (not silence) and fades in
    assert.ok(bedWindow.mean > -45, `bed ${bedWindow.mean}`);
    assert.ok(volume(bedOnly, [0, 0.2]).max < volume(bedOnly, [1.5, 2]).max, "bed fades in");
    // the delivered asset is that file and its probe is the muxed one
    const probe = h.store.get<any>("probe", TENANT, done.videoAssetId!);
    assert.ok(probe.streams.some((s: any) => s.codec_type === "audio" && s.codec_name === "aac" && s.channels === 2));
    // preflight sees the narration as a surface and finds nothing wrong with it
    const issues = deterministicIssues(done);
    assert.deepEqual(issues.filter((i) => i.surface === "narration"), []);
    assertPreflightClear(h.store, done);
  } finally {
    await h.close();
  }
});

test("regenerating an unchanged campaign speaks identical words (free from the gateway cache); a price change speaks new words", async () => {
  let wonderRuns = 0;
  const h = await harness({
    // Wonder words it differently every time: only the cache keeps the voice text stable.
    narration: (body) => {
      wonderRuns++;
      const price = /"priceText":"([^"]+)"/.exec(String(body.prompt))![1];
      return {
        text:
          wonderRuns === 1
            ? `Stride Lane has the White sneaker for ${price}. Come by ${COLLECTION}, or message us to order.`
            : `Stride Lane, White sneaker, ${price}. ${COLLECTION}. Tap the link to order.`,
      };
    },
  });
  try {
    const campaign = await h.newCampaign();
    await h.engine.generate(h.engine.get(TENANT, campaign.id), false);
    const first = clone(h.engine.get(TENANT, campaign.id));
    await h.engine.generate(h.engine.get(TENANT, campaign.id), false);
    const second = h.engine.get(TENANT, campaign.id);
    const spoken = h.speakCalls().map((c) => c.body.text);
    assert.equal(spoken.length, 2);
    assert.equal(spoken[0], spoken[1], "identical text -> the gateway serves the cached clip");
    assert.equal(wonderRuns, 1, "Wonder asked once");
    assert.equal(first.generation!.narration!.textCached, false);
    assert.equal(first.generation!.narration!.cached, false);
    assert.ok(first.generation!.narration!.credits > 0);
    assert.equal(second.generation!.narration!.textCached, true);
    assert.equal(second.generation!.narration!.cached, true);
    assert.equal(second.generation!.narration!.credits, 0);
    assert.equal(second.generation!.narration!.text, spoken[0]);
    // price change -> new facts -> new key -> new words and a voice call for them
    const edited = h.engine.get(TENANT, campaign.id);
    edited.facts.products[0].priceMinor = 9500;
    delete edited.site;
    delete edited.reel;
    delete edited.siteHash;
    delete edited.generation;
    await h.engine.generate(edited, false);
    const third = h.engine.get(TENANT, campaign.id).generation!.narration!;
    assert.match(third.text, /\$95\.00/);
    assert.doesNotMatch(third.text, /\$89\.00/);
    assert.notEqual(third.text, spoken[0]);
    assert.equal(wonderRuns, 2);
    assert.equal(third.textCached, false);
    assert.equal(h.speakCalls().length, 3);
    assert.equal(h.speakCalls()[2].body.text, third.text);
    // the text is at most 24 words / 150 characters (credits are scarce)
    for (const t of spoken.concat(third.text)) {
      assert.ok(t.split(/\s+/).length <= 24 && t.length <= 150, t);
    }
  } finally {
    await h.close();
  }
});

test("a failing or credit-short voice never fails the generation: the reel keeps the bed, a warning is recorded, no retry", async () => {
  const h = await harness({ narration: GOOD, failSpeak: 402 });
  try {
    const campaign = await h.newCampaign();
    assert.equal(await h.engine.generate(h.engine.get(TENANT, campaign.id), false), true);
    const done = h.engine.get(TENANT, campaign.id);
    assert.equal(done.state, "NeedsReview");
    assert.equal(done.error, undefined);
    assert.equal(h.speakCalls().length, 1, "the voice is requested exactly once");
    assert.equal(done.generation!.narration, undefined, "nothing was spoken, so no narration is claimed");
    assert.equal(done.generation!.audio!.mix, "bed");
    assert.match(done.generation!.warnings![0], /Narration voice unavailable/);
    assert.match(done.generation!.warnings![0], /credits/i);
    const final = path.join(rendersDir(h, done), "reel-final.mp4");
    assert.equal(streams(final).filter((s) => s.codec_type === "audio").length, 1);
    assert.ok(volume(final).mean > -45);
    assert.ok(volume(final).max < -1);
    assert.deepEqual(deterministicIssues(done).filter((i) => i.surface === "narration"), []);
  } finally {
    await h.close();
  }
});

test("{audio:false} skips narration and the voice gateway; narration is off unless the server turns it on", async () => {
  const h = await harness({ narration: GOOD });
  try {
    const campaign = await h.newCampaign();
    const r = await h.call("POST", `/api/v1/campaigns/${campaign.id}/generate`, { mode: "manual", audio: false });
    assert.equal(r.status, 202);
    for (let i = 0; i < 30 && h.engine.get(TENANT, campaign.id).state === "Generating"; i++) await h.engine.tick();
    const done = h.engine.get(TENANT, campaign.id);
    assert.equal(done.state, "NeedsReview", done.error);
    assert.equal(h.speakCalls().length, 0);
    assert.equal(h.narrationCalls().length, 0);
    assert.equal(done.generation!.narration, undefined);
    assert.deepEqual(done.generation!.audio, { mix: "silent", reason: "Audio skipped (audio:false)" });
    // a non-boolean is rejected
    const bad = await h.call("POST", `/api/v1/campaigns/${campaign.id}/generate`, { mode: "manual", audio: "no" });
    assert.equal(bad.status, 422);
    // audio left out -> narration is wanted again
    const again = await h.call("POST", `/api/v1/campaigns/${campaign.id}/generate`, { mode: "manual" });
    assert.equal(again.status, 202);
    for (let i = 0; i < 30 && h.engine.get(TENANT, campaign.id).state === "Generating"; i++) await h.engine.tick();
    assert.equal(h.engine.get(TENANT, campaign.id).generation!.narration!.text, GOOD);
    assert.equal(h.speakCalls().length, 1);
  } finally {
    await h.close();
  }
  // Default engine (no server opt-in): the live voice gateway can never be reached from tests or scripts.
  const off = await harness({ narration: GOOD }, false);
  try {
    const campaign = await off.newCampaign();
    await off.engine.generate(off.engine.get(TENANT, campaign.id), false);
    assert.equal(off.speakCalls().length, 0);
    assert.equal(off.engine.get(TENANT, campaign.id).generation!.narration, undefined);
    assert.equal(off.engine.get(TENANT, campaign.id).generation!.audio, undefined);
  } finally {
    await off.close();
  }
});

test("a spoken price that does not match the confirmed price BLOCKS approval (exact rules, same as the other surfaces)", async () => {
  const h = await harness({ narration: GOOD });
  try {
    const campaign = await h.newCampaign();
    await h.engine.generate(h.engine.get(TENANT, campaign.id), false);
    const c = h.engine.get(TENANT, campaign.id);
    assertPreflightClear(h.store, c); // clean as generated
    // Someone edits the facts afterwards (or the narration was tampered with): the spoken price is now wrong.
    const wrong = clone(c);
    wrong.generation!.narration!.text = GOOD.replace("$89.00", "$98.00");
    const issues = deterministicIssues(wrong).filter((i) => i.severity === "block");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].surface, "narration");
    assert.equal(issues[0].locate, null);
    assert.equal(issues[0].expected, "$89.00");
    assert.equal(issues[0].found, "$98.00");
    assert.throws(() => assertPreflightClear(h.store, wrong), (e: unknown) => e instanceof PreflightBlockedError && /narration/i.test(e.message));
    // The same via the facts: raise the confirmed price, keep the old narration.
    const stale = clone(c);
    stale.facts.products[0].priceMinor = 9500;
    stale.revision++;
    const staleIssues = deterministicIssues(stale).filter((i) => i.severity === "block" && i.surface === "narration");
    assert.ok(staleIssues.length >= 1);
    // A spoken date other than the confirmed expiry also blocks.
    const dated = clone(c);
    dated.facts.validUntil = "2026-11-08T04:59:00.000Z";
    dated.generation!.narration!.text = GOOD + " Valid until Nov 20, 2026.";
    assert.ok(deterministicIssues(dated).some((i) => i.surface === "narration" && i.severity === "block"));
    // Through the route too: the preflight response carries the narration issue.
    const live = clone(c);
    live.generation!.narration!.text = GOOD.replace("$89.00", "$98.00");
    h.engine.save(live);
    const pf = await h.call("POST", `/api/v1/campaigns/${campaign.id}/preflight`, {});
    const body = (await pf.json()).data;
    assert.equal(body.ok, false);
    assert.ok(body.issues.some((i: any) => i.surface === "narration" && i.severity === "block" && i.locate === null));
  } finally {
    await h.close();
  }
});
