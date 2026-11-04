// Demo v2 recorder: landing page -> simulated WhatsApp (real voice note, real Muse Voice transcript) -> Studio continues from the draft
// -> live Meta pipeline -> reel with audio -> Say it / Red Pen / Fix -> Instagram preview (not posted) -> insights (sample) and the grounded feedback loop.
// Usage: node scripts/record-demo2.mjs <workDir>
// Needs: Studio on :4310 started with AXYS_DEMO_SAMPLES=true, gateway on :8766, a seeded WhatsApp draft (scripts/seed-whatsapp-draft.mts),
// narration clips in docs/evidence/narration (scripts/make-narration.mjs). Writes <workDir>/raw.webm, timeline.json (marks, speed segments, audio cues) and reel.mp4.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

const work = path.resolve(process.argv[2] ?? "demo-work");
mkdirSync(work, { recursive: true });
const BASE = process.env.AXYS_URL ?? "http://127.0.0.1:4310";
const KEY = process.env.AXYS_KEY ?? "local-demo";
const HANDLE = process.env.IG_HANDLE ?? "snifthathash";
const W = 1440;
const H = 810;
const narration = Object.fromEntries(JSON.parse(readFileSync("docs/evidence/narration/narration.json", "utf8")).map((n) => [n.id, n]));

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--force-color-profile=srgb"],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: work, size: { width: W, height: H } },
  deviceScaleFactor: 1,
  bypassCSP: true,
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const t0 = Date.now();
const now = () => Date.now() - t0;
const timeline = { marks: [], speed: [], cues: [], width: W, height: H };
const mark = (label) => {
  timeline.marks.push({ t: now(), label });
  console.log(`[${(now() / 1000).toFixed(1)}s] ${label}`);
};
const sleep = (ms) => page.waitForTimeout(ms);

await context.addInitScript(() => {
  const boot = () => {
    if (document.getElementById("__demo")) return;
    const root = document.createElement("div");
    root.id = "__demo";
    root.innerHTML = `
      <style>
        #__cur{position:fixed;z-index:2147483647;left:-40px;top:-40px;width:26px;height:26px;border-radius:50%;border:3px solid #ff7a3d;background:rgba(255,122,61,.18);
          pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 0 0 4px rgba(255,122,61,.14);transition:transform .08s}
        #__cur.down{transform:translate(-50%,-50%) scale(.72)}
        #__cap{position:fixed;z-index:2147483646;left:50%;bottom:22px;transform:translateX(-50%) translateY(12px);max-width:min(1080px,92vw);padding:12px 22px;border-radius:14px;
          background:rgba(11,12,11,.9);border:1px solid rgba(255,122,61,.4);color:#f4f4ef;font:600 22px/1.35 "Geist Variable",Geist,system-ui,sans-serif;text-align:center;
          box-shadow:0 18px 50px rgba(0,0,0,.55);opacity:0;transition:opacity .25s,transform .25s;pointer-events:none}
        #__cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
        #__cap small{display:block;margin-top:3px;font:500 14px/1.3 "Geist Variable",Geist,system-ui,sans-serif;color:#b4b9ad}
        #__card{position:fixed;z-index:2147483645;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
          background:radial-gradient(900px 500px at 70% 10%,rgba(255,122,61,.22),transparent 60%),radial-gradient(800px 500px at 10% 90%,rgba(139,140,240,.2),transparent 60%),#0b0c0b;
          color:#f4f4ef;font-family:"Geist Variable",Geist,system-ui,sans-serif;text-align:center;padding:40px;opacity:0;pointer-events:none;transition:opacity .45s}
        #__card.on{opacity:1}
        #__card h1{margin:0;font-size:76px;line-height:1.02;font-weight:800;letter-spacing:-.035em}
        #__card h1 em{font-style:normal;background:linear-gradient(90deg,#ff7a3d,#b89cff);-webkit-background-clip:text;background-clip:text;color:transparent}
        #__card p{margin:0;font-size:26px;color:#b4b9ad;max-width:1000px;line-height:1.4}
        #__card .chips{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:10px}
        #__card .chips span{padding:6px 14px;border:1px solid #323732;border-radius:999px;font:600 16px "Geist Mono Variable",monospace;color:#b4b9ad}
      </style>
      <div id="__card"></div><div id="__cap"></div><div id="__cur"></div>`;
    document.documentElement.appendChild(root);
    const cur = root.querySelector("#__cur");
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => cur.classList.add("down"), true);
    addEventListener("mouseup", () => cur.classList.remove("down"), true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
});

const caption = (text, sub = "") =>
  page.evaluate(([t, s]) => { const el = document.getElementById("__cap"); if (!el) return; el.innerHTML = t + (s ? `<small>${s}</small>` : ""); el.classList.add("on"); }, [text, sub]).catch(() => {});
const hideCaption = () => page.evaluate(() => document.getElementById("__cap")?.classList.remove("on")).catch(() => {});
const card = (html, on = true) =>
  page.evaluate(([h, o]) => { const el = document.getElementById("__card"); if (!el) return; if (h) el.innerHTML = h; el.classList.toggle("on", o); }, [html, on]).catch(() => {});

/** Starts a narration clip now: records the audio cue, shows its words as a subtitle, and resolves when the clip has finished. */
const narrate = (id, pad = 450) => {
  const n = narration[id];
  if (!n) throw new Error("unknown narration " + id);
  timeline.cues.push({ id, t: now(), file: n.file, durationSec: n.durationSec });
  console.log(`   ♪ ${id} (${n.durationSec}s)`);
  caption(n.text);
  return sleep(Math.round(n.durationSec * 1000) + pad).then(hideCaption);
};

const glide = async (loc) => {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const box = await loc.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 40), { steps: 26 });
  await sleep(240);
};
const click = async (loc) => { await glide(loc); await loc.click(); await sleep(320); };
const type = async (loc, text, delay = 36) => { await glide(loc); await loc.click(); await loc.fill(""); await loc.pressSequentially(text, { delay }); await sleep(220); };
const speedStart = (label, factor) => { timeline.speed.push({ start: now(), end: null, factor, label }); console.log(`   >> speed x${factor}: ${label}`); };
const speedEnd = () => { const s = timeline.speed[timeline.speed.length - 1]; s.end = now(); console.log(`   << ${((s.end - s.start) / 1000).toFixed(0)}s real`); };

try {
  // ===== 1. Title and landing =====
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await sleep(500);
  mark("title card");
  const n1 = narrate("n1");
  await card(`<h1>Make the reel.<br><em>Prove the price.</em></h1><p>A photo and a voice note become a website, a reel and a caption, and code proves they all agree.</p>
    <div class="chips"><span>Muse Voice</span><span>SAM 3.1</span><span>Muse Spark</span><span>Muse Wonder</span><span>Muse Image</span></div>`, true);
  await sleep(3600);
  await card("", false);
  await sleep(600);
  mark("landing hero");
  await n1;

  // ===== 2. The problem and the live engines =====
  mark("problem");
  const n2 = narrate("n2");
  await page.locator("#problem, .problem").first().scrollIntoViewIfNeeded().catch(() => page.mouse.wheel(0, 900));
  await sleep(2200);
  await page.locator("#bench").scrollIntoViewIfNeeded();
  await sleep(700);
  await page.getByRole("tab", { name: /tagline/ }).click();
  await sleep(400);
  await page.getByRole("button", { name: /It passes/ }).first().click().catch(() => {});
  await sleep(600);
  await n2;
  mark("bench");
  const own = page.locator("#own-phrase");
  await type(own, "Best price 50% off");
  await click(page.getByRole("button", { name: "Check", exact: true }));
  await sleep(2200);

  // ===== 3. WhatsApp (simulated) =====
  mark("whatsapp");
  await page.goto(BASE + "/?sim=whatsapp&autoplay=1", { waitUntil: "networkidle" });
  const n3 = narrate("n3", 200);
  await n3;
  await page.waitForSelector('.wa-play[aria-label="Pause voice note"]', { timeout: 30000 });
  timeline.cues.push({ id: "voiceNote", t: now() - 120, file: "apps/studio/public/demo/voice-note.mp3", durationSec: 11.9 });
  console.log("   ♪ voiceNote starts");
  mark("whatsapp: voice note playing");
  await page.waitForSelector("text=/Confirm these facts/i", { timeout: 60000 });
  mark("whatsapp: facts");
  const n4 = narrate("n4");
  await page.waitForSelector("text=/Open in Studio/i", { timeout: 60000 });
  await n4;
  await sleep(500);
  mark("whatsapp: draft ready");
  await click(page.getByText(/Open in Studio/i).first());
  await page.waitForLoadState("networkidle");
  await sleep(1200);

  // ===== 4. Studio: sign in; the draft imports =====
  mark("studio sign-in");
  await type(page.locator('input[type="password"]'), KEY, 50);
  await click(page.getByRole("button", { name: /Open workspace/ }));
  await page.waitForFunction(() => { const i = document.querySelector('input[placeholder="Your business name"]'); return i && i.value && i.value.length > 2; }, null, { timeout: 40000 });
  await sleep(900);
  mark("brief imported from the draft");
  await caption("The Studio picks up the WhatsApp draft: facts and photo arrive pre-filled.");
  await sleep(2200);
  await click(page.locator("label.check", { hasText: /permission to use/i }));
  await click(page.locator("label.check", { hasText: /I confirm these prices/i }));
  await click(page.getByRole("button", { name: /Save facts/ }));
  await sleep(1500);
  await hideCaption();

  // ===== 5. Meta Lens, then the film =====
  mark("create: meta lens");
  await caption("Live Meta calls: Muse Spark identifies the product, SAM 3.1 cuts it out, Muse Image builds backdrops.", "Sped up");
  await click(page.getByRole("button", { name: /^Run Meta Lens/ }).first());
  speedStart("meta lens enrich", 12);
  await page.waitForFunction(() => /Muse Spark identified/i.test(document.body.innerText), null, { timeout: 300000 });
  speedEnd();
  await hideCaption();
  await sleep(700);
  mark("create: identified");
  const n5 = narrate("n5");
  await page.getByText(/Muse Spark identified/i).first().scrollIntoViewIfNeeded();
  await sleep(4200);
  await page.getByRole("slider").first().scrollIntoViewIfNeeded().catch(() => {});
  await n5;
  const n6 = narrate("n6");
  await page.getByRole("button", { name: /Plan with Muse Wonder/ }).scrollIntoViewIfNeeded();
  await glide(page.getByRole("button", { name: /Plan with Muse Wonder/ }));
  await n6;
  mark("create: plan");
  await page.getByRole("button", { name: /Plan with Muse Wonder/ }).click();
  speedStart("plan + render", 10);
  await page.waitForSelector('video[aria-label^="Final reel"]', { state: "attached", timeout: 300000 });
  speedEnd();
  await sleep(1200);

  // ===== 6. The reel, with its own audio =====
  mark("review: film");
  const reelVideo = page.locator('video[aria-label^="Final reel"]').first();
  await reelVideo.scrollIntoViewIfNeeded();
  const reelSrc = await page.evaluate(() => document.querySelector('video[aria-label^="Final reel"]')?.currentSrc);
  if (reelSrc) {
    const res = await context.request.get(reelSrc);
    writeFileSync(path.join(work, "reel.mp4"), await res.body());
    timeline.reelFile = "reel.mp4";
  }
  await page.evaluate(() => {
    const v = document.querySelector('video[aria-label^="Final reel"]');
    if (!v) return;
    v.dataset.prevStyle = v.getAttribute("style") || "";
    v.setAttribute("style", v.dataset.prevStyle + ";position:fixed;left:50%;top:46%;height:84vh;width:auto;max-width:none;transform:translate(-50%,-50%);z-index:2147483000;border-radius:18px;box-shadow:0 0 0 2px rgba(255,122,61,.55),0 40px 120px rgba(0,0,0,.8);background:#000");
    v.currentTime = 0; v.play().catch(() => {});
  });
  timeline.cues.push({ id: "reelAudio", t: now(), file: "reel.mp4", durationSec: 10, isVideo: true });
  console.log("   ♪ reelAudio starts (the reel's own narration and music)");
  await sleep(10800);
  await page.evaluate(() => { const v = document.querySelector('video[aria-label^="Final reel"]'); if (v) v.setAttribute("style", v.dataset.prevStyle || ""); });

  // ===== 7. Say it, Red Pen, Fix =====
  mark("say it");
  const n7 = narrate("n7");
  const sayBox = page.locator("textarea").first();
  await sayBox.scrollIntoViewIfNeeded();
  await sleep(400);
  await type(sayBox, "make the sneaker price 99 dollars", 45);
  await click(page.getByRole("button", { name: /Show me the changes/ }));
  await page.waitForSelector("text=/Apply \\d+ change/i", { timeout: 90000 });
  await sleep(1500);
  await click(page.getByRole("button", { name: /^Apply \d+ change/ }));
  mark("red pen");
  await page.waitForSelector('[class*="redpen"] svg text', { timeout: 90000, state: "attached" });
  await n7;
  await sleep(900);
  await click(page.getByRole("button", { name: /Fix with Axys/ }).first());
  await caption("Fix with Axys regenerates from the confirmed facts and re-checks.", "Sped up");
  speedStart("regenerate for fix", 10);
  await page.waitForFunction(() => /fixed/i.test([...document.querySelectorAll("[aria-live]")].map((e) => e.textContent).join(" ")), null, { timeout: 300000 });
  speedEnd();
  await sleep(2600);
  mark("fixed");
  await hideCaption();

  // ===== 8. Instagram preview (not posted) =====
  mark("instagram preview");
  const n8 = narrate("n8");
  const ig = page.getByText(/Instagram preview/i).first();
  await ig.scrollIntoViewIfNeeded();
  await sleep(500);
  await click(page.getByRole("button", { name: new RegExp("Use @" + HANDLE) }).first());
  await sleep(2600);
  await n8;
  await click(page.getByRole("tab", { name: /Profile grid/ }).first());
  await sleep(2200);
  await click(page.getByRole("tab", { name: /^Reel$/ }).first());
  await sleep(800);

  // ===== 9. Insights (sample) and the grounded feedback loop =====
  mark("results");
  await click(page.locator("button", { hasText: "Results" }).first());
  await sleep(900);
  await click(page.getByRole("button", { name: /Load sample insights/ }));
  await page.waitForSelector("text=/SAMPLE DATA/i", { timeout: 30000 });
  await sleep(800);
  const n9 = narrate("n9");
  await page.mouse.wheel(0, 520);
  await sleep(2600);
  await page.mouse.wheel(0, 700);
  await sleep(2400);
  await n9;
  mark("feedback loop");
  const propose = page.getByRole("button", { name: /Propose a revision/ });
  await click(propose);
  await caption("Muse Wonder proposes one change from the numbers. Code checks that every number it quotes was really observed.", "Sample data in this demo");
  await page.waitForFunction(() => !/No proposal yet/i.test(document.body.innerText), null, { timeout: 120000 });
  await sleep(700);
  await page.getByText(/What Axys learned/i).first().scrollIntoViewIfNeeded().catch(() => {});
  await sleep(6800);
  await hideCaption();

  // ===== 10. Outro =====
  mark("outro");
  const n10 = narrate("n10", 800);
  await card(`<h1>Agents propose.<br><em>Code decides.</em></h1><p>Live on Meta's models: Muse Voice, SAM 3.1, Muse Spark, Muse Wonder, Muse Image.<br>Voice by ElevenLabs. The WhatsApp chat, the Instagram view and the insights numbers are simulated.</p>
    <div class="chips"><span>Axys for Meta</span><span>Open source: repo link in the submission</span></div>`, true);
  await n10;
  await sleep(1500);
  mark("end");
} catch (err) {
  mark("ERROR " + String(err).slice(0, 220));
  await page.screenshot({ path: path.join(work, "error.png") }).catch(() => {});
  console.error(err);
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  const src = await video.path();
  renameSync(src, path.join(work, "raw.webm"));
  timeline.totalMs = now();
  writeFileSync(path.join(work, "timeline.json"), JSON.stringify(timeline, null, 2));
  console.log("wrote", path.join(work, "raw.webm"), "and timeline.json");
}
