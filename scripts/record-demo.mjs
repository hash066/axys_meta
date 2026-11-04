// Records the Axys for Meta demo: a real, scripted walk through the landing page and the Studio on live data.
// Usage: node scripts/record-demo.mjs <photo.png> [workDir]
// Needs the Studio on :4310 (workspace login key local-demo) and the Muse gateway on :8766. Costs a few cents of API credit.
// Writes <workDir>/raw.webm and <workDir>/timeline.json (marks and speed-up segments for scripts/cut-demo.mjs).
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

const photo = path.resolve(process.argv[2] ?? "docs/evidence/sample-product.png");
const work = path.resolve(process.argv[3] ?? "demo-work");
mkdirSync(work, { recursive: true });
const BASE = process.env.AXYS_URL ?? "http://127.0.0.1:4310";
const KEY = process.env.AXYS_KEY ?? "local-demo";
const W = 1440;
const H = 810;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--force-color-profile=srgb"],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: work, size: { width: W, height: H } },
  deviceScaleFactor: 1,
  bypassCSP: true, // the Studio's content-security policy would block the injected caption styles
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const t0 = Date.now();
const now = () => Date.now() - t0;
const timeline = { marks: [], speed: [], width: W, height: H };
const mark = (label) => {
  timeline.marks.push({ t: now(), label });
  console.log(`[${(now() / 1000).toFixed(1)}s] ${label}`);
};
const sleep = (ms) => page.waitForTimeout(ms);

// ---- on-screen furniture: orange cursor, captions, title cards ----
await context.addInitScript(() => {
  const boot = () => {
    if (document.getElementById("__demo")) return;
    const root = document.createElement("div");
    root.id = "__demo";
    root.innerHTML = `
      <style>
        #__demo *{box-sizing:border-box}
        #__cur{position:fixed;z-index:2147483647;left:-40px;top:-40px;width:26px;height:26px;border-radius:50%;
          border:3px solid #ff7a3d;background:rgba(255,122,61,.18);pointer-events:none;transform:translate(-50%,-50%);
          box-shadow:0 0 0 4px rgba(255,122,61,.14);transition:transform .08s}
        #__cur.down{transform:translate(-50%,-50%) scale(.72)}
        #__cap{position:fixed;z-index:2147483646;left:50%;bottom:26px;transform:translateX(-50%) translateY(14px);max-width:min(1100px,92vw);
          padding:14px 24px;border-radius:14px;background:rgba(11,12,11,.9);border:1px solid rgba(255,122,61,.45);
          color:#f4f4ef;font:600 24px/1.35 "Geist Variable",Geist,system-ui,sans-serif;letter-spacing:-.01em;text-align:center;
          box-shadow:0 18px 50px rgba(0,0,0,.55);opacity:0;transition:opacity .25s,transform .25s;pointer-events:none}
        #__cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
        #__cap small{display:block;margin-top:4px;font:500 15px/1.3 "Geist Variable",Geist,system-ui,sans-serif;color:#b4b9ad;letter-spacing:0}
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
  page.evaluate(([t, s]) => {
    const el = document.getElementById("__cap");
    if (!el) return;
    el.innerHTML = t + (s ? `<small>${s}</small>` : "");
    el.classList.add("on");
  }, [text, sub]);
const hideCaption = () => page.evaluate(() => document.getElementById("__cap")?.classList.remove("on"));
const card = (html, on = true) =>
  page.evaluate(([h, o]) => {
    const el = document.getElementById("__card");
    if (!el) return;
    if (h) el.innerHTML = h;
    el.classList.toggle("on", o);
  }, [html, on]);
const say = async (text, ms, sub = "") => {
  await caption(text, sub);
  await sleep(ms);
};

// ---- helpers ----
const glide = async (loc) => {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const box = await loc.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 40), { steps: 28 });
  await sleep(260);
};
const click = async (loc) => {
  await glide(loc);
  await loc.click();
  await sleep(350);
};
const type = async (loc, text, delay = 38) => {
  await glide(loc);
  await loc.click();
  await loc.fill(""); // some fields prefill (the contact URL starts with https://)
  await loc.pressSequentially(text, { delay });
  await sleep(250);
};
const speedStart = (label, factor) => {
  timeline.speed.push({ start: now(), end: null, factor, label });
  console.log(`   >> speed x${factor} begins: ${label}`);
};
const speedEnd = () => {
  const s = timeline.speed[timeline.speed.length - 1];
  s.end = now();
  console.log(`   << speed ends after ${((s.end - s.start) / 1000).toFixed(0)}s real time`);
};

try {
  // ============ 1. Title ============
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await sleep(600);
  mark("title card");
  await card(
    `<h1>Make the reel.<br><em>Prove the price.</em></h1><p>Axys turns a product photo and one sentence into a website, a reel and a caption, then proves they all agree.</p>
     <div class="chips"><span>Muse Voice</span><span>SAM 3.1</span><span>Muse Spark</span><span>Muse Wonder</span><span>Muse Image</span></div>`,
    true,
  );
  await sleep(4200);
  await card("", false);
  await sleep(700);

  // ============ 2. Landing page ============
  mark("landing hero");
  await say("A reel, a site and a caption are written at different times. Change one fact and the others go quietly stale.", 5200);
  await hideCaption();
  await page.locator("#problem, .problem").first().scrollIntoViewIfNeeded().catch(() => page.mouse.wheel(0, 900));
  await sleep(500);
  mark("problem");
  await say("Measured offline on 1,657 cases: 312 of 312 drifted artifacts caught. 0 false alarms in 1,111 harmless formatting variants.", 5600);
  await hideCaption();

  mark("replay");
  const replay = page.locator(".replay").first();
  await replay.scrollIntoViewIfNeeded();
  await sleep(500);
  await caption("Say it. See the diff. Every stale surface is red-penned. One press fixes it.", "Replay of a recorded live run");
  await click(page.getByRole("button", { name: "Play", exact: true }));
  await sleep(10500);
  await hideCaption();

  mark("cutouts");
  const slider = page.getByRole("slider").first();
  await slider.scrollIntoViewIfNeeded();
  await sleep(500);
  await caption("SAM cuts out the cake. Muse Spark names the raspberries. The masks merge: 19% becomes 28%.", "The product stays your product: pixels are composited, never regenerated");
  await slider.focus();
  for (let i = 0; i < 26; i++) { await page.keyboard.press("ArrowRight"); await sleep(55); }
  await sleep(1400);
  for (let i = 0; i < 18; i++) { await page.keyboard.press("ArrowLeft"); await sleep(55); }
  await sleep(1200);
  await hideCaption();

  mark("bench");
  await page.locator("#bench").scrollIntoViewIfNeeded();
  await sleep(600);
  await caption("The Bench: games on the real engines. Guess first, then the checks decide.");
  await page.getByRole("tab", { name: /tagline/ }).click();
  await sleep(500);
  await page.getByRole("button", { name: /It passes/ }).first().click().catch(() => {});
  await sleep(1100);
  const own = page.locator("#own-phrase");
  await type(own, "Best price 50% off");
  await click(page.getByRole("button", { name: "Check", exact: true }));
  await sleep(2400);
  await own.fill("");
  await type(own, "Made by hand");
  await click(page.getByRole("button", { name: "Check", exact: true }));
  await sleep(2600);
  await hideCaption();

  // ============ 3. Studio: sign in ============
  mark("open studio");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await sleep(900);
  await click(page.getByRole("link", { name: /Open Studio/ }).first().or(page.getByRole("button", { name: /Open Studio/ }).first()));
  await sleep(1200);
  await say("Now the real Studio, on live Meta models.", 2200);
  await hideCaption();
  await type(page.locator('input[type="password"]'), KEY, 55);
  await click(page.getByRole("button", { name: /Open workspace/ }));
  await sleep(1800);

  // ============ 4. Brief: a new campaign ============
  mark("brief");
  await click(page.getByRole("button", { name: /New campaign/ }).first());
  await sleep(600);
  await caption("Start with what is true: your facts and your own photo.", "The demo photo was made with Muse Image");
  await type(page.getByPlaceholder("Your business name"), "Stride Lane");
  await type(page.getByPlaceholder("What are you offering?"), "Weekend sneaker drop");
  await type(page.getByPlaceholder(/24 October 2026/), "Saturday 7 November 2026, 10am to 4pm IST");
  await type(page.locator('input[type="url"]').first(), "https://example.com/stridelane");
  await type(page.getByPlaceholder(/Describe your campaign/), "Lightweight white mesh running sneaker with sage-green panels.", 22);
  await sleep(300);
  await click(page.locator("label.check", { hasText: /permission to use/i }));
  await sleep(400);
  await page.locator('input[aria-label="Product photo"]').setInputFiles(photo);
  await page.waitForSelector(".product-edit", { timeout: 30000 });
  await sleep(900);
  const pname = page.locator(".product-edit label", { hasText: "Product name" }).locator("input");
  await pname.fill("");
  await type(pname, "white sneaker");
  const price = page.locator(".product-edit label", { hasText: /^Price/ }).locator("input");
  await price.fill("3499");
  await sleep(500);
  await click(page.locator("label.check", { hasText: /I confirm these prices/i }));
  await sleep(500);
  await click(page.getByRole("button", { name: /Save facts/ }));
  await sleep(1800);
  await hideCaption();

  // ============ 5. Create: Meta Lens (real SAM + Spark + Muse Image), then the film ============
  mark("create: meta lens");
  await caption("Muse Spark identifies the product. SAM 3.1 cuts it out. Muse Image builds the backdrops.", "Live calls. The wait is sped up.");
  await click(page.getByRole("button", { name: /^Run Meta Lens/ }).first());
  speedStart("meta lens enrich", 12);
  await page.waitForFunction(() => /Muse Spark identified/i.test(document.body.innerText), null, { timeout: 300000 });
  speedEnd();
  await sleep(1200);
  mark("create: identified");
  await hideCaption();
  await say("It named the product, its palette and its mood. The words on screen are decoration, never facts.", 4200);
  const identity = page.getByText(/Muse Spark identified/i).first();
  await identity.scrollIntoViewIfNeeded();
  await sleep(2600);
  const lens = page.getByRole("slider").first();
  await lens.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(1600);
  await hideCaption();

  mark("create: plan");
  await click(page.getByRole("button", { name: /Plan with Muse Wonder/ }));
  await caption("Muse Wonder plans the campaign. FFmpeg renders the film from your real product pixels.", "Sped up");
  speedStart("plan + render", 10);
  await page.waitForSelector("video", { timeout: 300000 });
  await page.waitForFunction(() => !/Generating|Rendering/i.test(document.body.innerText) || !!document.querySelector("video[src], video source"), null, { timeout: 300000 });
  speedEnd();
  await sleep(1500);
  await hideCaption();

  // ============ 6. Review: the film and the site ============
  mark("review: film");
  const reelVideo = page.locator('video[aria-label^="Final reel"]').first();
  await reelVideo.waitFor({ state: "attached", timeout: 120000 });
  await reelVideo.scrollIntoViewIfNeeded();
  await page.evaluate(() => { const v = document.querySelector('video[aria-label^="Final reel"]'); if (v) { v.currentTime = 0; v.muted = true; v.play().catch(() => {}); } });
  await sleep(500);
  // cinema view: show the real reel large while it plays, then put it back
  await page.evaluate(() => {
    const v = document.querySelector('video[aria-label^="Final reel"]');
    if (!v) return;
    v.dataset.prevStyle = v.getAttribute("style") || "";
    v.setAttribute("style", (v.dataset.prevStyle + ";position:fixed;left:50%;top:46%;height:80vh;width:auto;max-width:none;transform:translate(-50%,-50%);z-index:2147483000;border-radius:18px;box-shadow:0 0 0 2px rgba(255,122,61,.55),0 40px 120px rgba(0,0,0,.8);background:#000").replace(/^;/, ""));
    v.currentTime = 0; v.play().catch(() => {});
  });
  await say("A 10-second studio film: hero, whip-pan, macro, kinetic type, context scene, then the facts card.", 11800, "No actors and no stock footage. Your exact product, composited.");
  await page.evaluate(() => { const v = document.querySelector('video[aria-label^="Final reel"]'); if (v) v.setAttribute("style", v.dataset.prevStyle || ""); });
  await hideCaption();
  mark("review: site");
  await page.getByText(/Website preview/i).first().scrollIntoViewIfNeeded().catch(() => {});
  await say("The website is built from the same confirmed facts.", 3600);
  await hideCaption();

  // ============ 7. Say it, Red Pen, Fix ============
  mark("say it");
  const sayBox = page.locator("textarea").first();
  await sayBox.scrollIntoViewIfNeeded();
  await sleep(500);
  await caption("Say it once. Every surface follows.", "Muse Wonder parses it. Code checks every number against your words.");
  await type(sayBox, "make the sneaker price 3999 rupees", 45);
  await click(page.getByRole("button", { name: /Show me the changes/ }));
  await page.waitForSelector("text=/Apply 1 change|Apply \\d+ change/i", { timeout: 90000 });
  await sleep(2600);
  await click(page.getByRole("button", { name: /^Apply \d+ change/ }));
  mark("red pen");
  await page.waitForSelector('[class*="redpen"] svg text', { timeout: 90000, state: "attached" });
  await hideCaption();
  await sleep(1000);
  await say("Red Pen marks the real website, the real reel and the caption where they are now stale.", 6200, "INR 3,499 is still printed everywhere. The check is exact, not a model's opinion.");
  await hideCaption();
  await click(page.getByRole("button", { name: /Fix with Axys/ }).first());
  await caption("Fix with Axys: regenerate from the confirmed facts, re-run the check.", "Sped up");
  speedStart("regenerate for fix", 10);
  await page.waitForFunction(() => /fixed/i.test([...document.querySelectorAll("[aria-live]")].map((e) => e.textContent).join(" ")), null, { timeout: 300000 });
  speedEnd();
  await sleep(3600);
  mark("fixed");
  await hideCaption();
  await say("Every mark turns green. Approval stays blocked until all of them do.", 4200);
  await hideCaption();

  // ============ 8. Publish and results (honest) ============
  mark("publish");
  await click(page.locator("button", { hasText: "Publish" }).first());
  await sleep(900);
  await say("Publishing needs your own Instagram account. Posting is off by default and was not verified against a real account.", 5600, "Tested end to end against a local fake Instagram instead.");
  await hideCaption();
  mark("results");
  await click(page.locator("button", { hasText: "Results" }).first());
  await sleep(700);
  await click(page.getByRole("button", { name: /Propose a revision/ }));
  await sleep(1800);
  await say("The feedback loop never invents numbers. With no data yet it makes no model call and says so.", 5200, "With real insights, a revision must quote the real numbers.");
  await hideCaption();

  // ============ 9. Outro ============
  mark("outro");
  await card(
    `<h1>Agents propose.<br><em>Code decides.</em></h1><p>Live on Meta's models: Muse Voice, SAM 3.1, Muse Spark, Muse Wonder, Muse Image.<br>198 Node tests and 8 gateway tests pass. No real Instagram post yet. Honest limits are on the landing page.</p>
     <div class="chips"><span>Axys for Meta</span><span>Open source: repo link in the submission</span></div>`,
    true,
  );
  await sleep(5200);
  mark("end");
} catch (err) {
  mark("ERROR " + String(err).slice(0, 200));
  await page.screenshot({ path: path.join(work, "error.png") }).catch(() => {});
  console.error(err);
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  const src = await video.path();
  const dest = path.join(work, "raw.webm");
  renameSync(src, dest);
  timeline.totalMs = now();
  writeFileSync(path.join(work, "timeline.json"), JSON.stringify(timeline, null, 2));
  console.log("wrote", dest, "and timeline.json");
}
