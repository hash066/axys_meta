# Redesign contract: Hardwright-style landing, "The Bench" games, dark Studio theme

The user wants the site to look and feel like https://siliconsmith.vercel.app/ (their own "Hardwright" project): a dark landing page with a hero and floating cards,
animated stat counters, a "problem" stat grid, a recorded-session replay, a before/after drag slider, a 9-card capability grid, pipeline tabs, interactive mini-games
("The Bench": guess first, then watch the deterministic engines decide), how-it-works steps, an architecture layers section and a big closing CTA, plus a dark theme
for the app itself.

Reference screenshots (1440 px wide, scrolled in 900 px steps) are in
`C:/Users/asus/AppData/Local/Temp/claude/e74d84b441f26777/9b6ee208-6270-487b-8f41-fd8b563a9c05/scratchpad/ss/` (`s00.png` hero ... `s09.png`, and `sheet.png`, a contact sheet). View them with the Read tool.
The user's own source for that site is `E:/Winter/siliconsmith-web/` (Next.js). Read it for ideas; do not copy its brand names or copy. This product is Axys.

Theme tokens from that site: bg `#0b0c0b`, panel `#101210`, raised `#171a17`, sunken `#080908`, line `#222622`, line-2 `#323732`, ink `#eceee6`, ink-2 `#b4b9ad`, ink-3 `#8b9187`,
amber `#f0b43c`, red `#ff6a59`, green for pass. The live look uses an orange primary (about `#ff6a2b`; sample the exact value from the screenshots with PIL) and a violet/periwinkle
accent in heading gradients. Fonts: Geist Sans and Geist Mono (installed through @fontsource-variable and already imported in apps/studio/main.tsx).

## Honesty rules (hackathon judges read this)

Every number on the landing page must come from `docs/EVIDENCE.md`, `docs/META_NEW.md` or a live engine call, with a visible label saying whether it is "live engine",
"recorded run" or "measured offline". No invented metrics, testimonials, customer logos or sales claims. Include an "Honest limits" strip (no live-action footage, no voiceover,
Instagram posting not verified against a real account, parts handling only for the first product of a campaign, microphone capture and WhatsApp unverified).

Real numbers you may use:
- Offline mutation eval of the preflight (1,657 cases): drift in artifact text caught 312/312; edits after generation blocked 114/114; false alarms 0/1,111 on benign formatting variants and 0/24 on controls.
- Live Muse Wonder flagged 7/7 unsupported caption claims, with 0/3 false warnings on controls (small sample).
- Product film hero compositing fidelity: SSIM 0.87 to 0.91 (scene reel SSIM 0.937); measures compositing only.
- Cake cutout coverage 19% -> 28% once Muse Spark named the visible parts (raspberries).
- Muse Spark identified a mug, a sneaker and a cake correctly (3 of 3).
- 12 live commands tested including prompt injection and "set price to 0": all rejected safely with a question.
- 189 Node tests and 8 gateway tests pass.
- Models used: Muse Voice Transcribe, SAM 3.1, Muse Spark, Muse Wonder, Muse Image.

Real media (already copied) in `apps/studio/public/landing/`: reel-{sneaker,cake,mug}.mp4 with .jpg posters, film-*-frames.png contact sheets, cake-sam-cutout-before.png
(SAM masks: cake only versus cake with raspberries), redpen-live.png and redpen-live-fixed.png, scene-reel-frames.png. Optimise heavy images (sharp is installed) if useful.
The demo video the lead is recording will be served at `/demo.mp4`; it may not exist yet, so handle a 404 gracefully (for example hide the button).

## Public lab endpoints (node worker: server/**, packages/**, tests/**)

Stateless, no auth, no cookies, no model calls, rate limited (about 60 requests per minute per IP, in the style of the existing limiters), strict zod validation, JSON only,
no secrets and no tenant data. Define them before the auth middleware.

- `GET /api/v1/public/lab/preflight` returns `{scenarios:[{id,title,brief,facts:{business,offer,collection,contact,products:[{name,price}]},surfaces:{site,reel,caption}}]}`.
  4 to 6 prepared scenarios. Each has EXACTLY ONE surface with a subtle mismatch (wrong price, shifted date, different contact link, changed offer, different currency, extra link parameter).
  Build the surface texts with the real text builders where possible. Do not reveal which surface is wrong.
- `POST /api/v1/public/lab/preflight` with `{scenarioId, guess:"site"|"reel"|"caption"}` returns `{correct, wrongSurface, issues, engine}` where `issues` are the REAL deterministic preflight
  issues from `packages/meta/preflight.ts` (severity, surface, expected, found) and `engine` names the function used.
- `POST /api/v1/public/lab/phrase` with `{text}` (at most 60 characters) returns `{allowed, cleaned, reasons}` using the REAL kinetic-phrase filter from `packages/meta/direction.ts`
  (export a pure function if needed): digits, money, URLs, superlatives, claim words and more than 3 words are rejected. No model call.
- Tests for both endpoints (they are pure), including the rate limit and that no unvalidated input is echoed unsafely.

## Landing and games (UI worker A: new files apps/studio/landing.tsx, landing.css, bench.tsx, bench.css, public/landing/**, and the landing swap in apps/studio/main.tsx)

Sections in order. All responsive down to 390 px, keyboard accessible, `prefers-reduced-motion` respected, dark theme, scroll reveal.

1. Sticky nav and a side dot navigation.
2. Hero: big headline with an orange gradient word, sub copy, an orange "Open Studio" button, a "Watch the demo" button, three live-counting stats, and floating cards on the right
   (an autoplaying muted reel video card, a preflight card, a Red Pen card).
3. "The problem": a 4-stat grid.
4. "Meet Axys": a recorded-session replay (Say it, diff, Red Pen, Fix) played from real recorded data with Play and Reset.
5. A before/after drag slider (SAM cutout without and with the product's parts, from cake-sam-cutout-before.png and the film frames).
6. A 9-card capability grid with real numbers.
7. Pipeline tabs: Brief, Identify, Cut out, Film, Preflight, Publish, Learn.
8. "The Bench": at least FOUR games using real data: (1) "Spot the stale surface" on the live preflight lab endpoints; (2) "Would this tagline pass?" on the live phrase endpoint;
   (3) "Name that product" with recorded Muse Spark directions for the mug, sneaker and cake (guess category and mood, then reveal); (4) "Cutout or not?" with recorded SAM masks and coverage numbers.
   Optional fifth: "Pick the ink" with recorded contrast measurements.
9. How it works (5 steps), then architecture layers (Interface, Agents on Muse models, Verifiers, Isolation with Docker containers).
10. A "What is real" strip with the honest limits, then a closing CTA.

Studio sign-in must still work exactly as today (the landing's "Open Studio" goes to the workspace sign-in). Replace the old unauthenticated landing in main.tsx with an import of the new one.
Do not break `?studio=1` or any `?fixture=...` routes, or the Studio itself.

## Studio theme (UI worker B: CSS only in apps/studio/style.css, meta.css, redpen.css, sayit.css; no structural edits to main.tsx)

Re-theme the signed-in Studio to the same dark look using CSS variables (tokens above, orange primary, Geist). The generated merchant website preview and its CSS (apps/studio/site.css and the `.site-*` classes)
must stay light and cream because it is the merchant's page, but should sit inside a dark frame. Red Pen marks, the Say it bar, Meta Lens panels, the preflight panel, the credits chip, stage steps,
buttons, inputs and toasts must all be readable (WCAG AA) with consistent radii, shadows and borders, a subtle grid background and orange focus rings. Keep every class name and behaviour.

## Ownership and rules

- Node worker: server/**, packages/**, tests/**.
- UI worker A: the landing and bench files plus the landing swap in main.tsx.
- UI worker B: the CSS files listed above only.
- Lead: docs/**, scripts/**, README.md, public/demo.mp4, package.json.
- Never read or print .env* files. Never commit.
- Builds: `npm run build` writes ./dist (vite, emptyOutDir). Build only when needed, never delete dist by hand, and retry if another worker's build is running.
- Only UI worker A restarts the Studio server (kill only the listener on 4310, then `AXYS_DATA_DIR=var/demo AXYS_STARTER_CREDITS=400 npm start` in the background). The Muse gateway on 8766 must stay up.
- Screenshots: use headless Edge with Playwright like scripts/screenshot-redpen.mjs (the in-app browser's screenshots are too small). Write scripts into the scratchpad directory, not the repo.
