# What is new in this fork (Meta Model API hackathon)

Pre-hackathon Axys code is fingerprinted in `docs/BASELINE.sha256`
(`sha256sum -c docs/BASELINE.sha256` lists every file that changed or was
removed since the Oct 19-26 build). This page lists the Node-side work.
Studio UI files (`apps/studio/**`) and the Python gateway (`gateway/**`) are
listed by their owners.

The automated tests use a local fake gateway (`tests/fake-gateway.ts`) on a
random port. The same routes have also been run against the live Meta API: see
`docs/EVIDENCE.md` and re-run with `node scripts/live-e2e.mjs`.

## Added files

| File | Why |
|---|---|
| `packages/meta/gateway.ts` | Typed, zod-validated client for the Muse gateway (`MUSE_GATEWAY_URL`, default `http://127.0.0.1:8766`): per-call timeouts, `redirect: "error"`, bounded response size, PNG signature checks, errors mapped to clear codes (`unavailable`, `timeout`, `no_key`, `bad_response`, ...). `museStatus()` is the cached, never-throwing health probe behind capabilities/public-config. |
| `packages/meta/budget.ts` | Per-campaign Muse call counter and cap (`MUSE_CAMPAIGN_CALL_CAP`, default 60). Replaces the Nebius dollar-spend plumbing. |
| `packages/meta/enrichment.ts` | `enrichCampaign()` (SAM cutout + overlay per product photo, optional Muse Image studio shots with Spark fidelity), persistence, and `usableMedia()` which decides what the renderers may use (ignores enrichment whose source photo changed; only uses a studio shot if `faithful === true`). |
| `packages/meta/preflight.ts` | Deterministic exact-match audit (prices, offer, message, business, collection, contact URL, expiry date) over site markup, reel shot text, caption and the seller-voice transcript; Muse Wonder pass for unsupported claims (warn only); `assertPreflightClear()` used by approval; `PreflightBlockedError`. |
| `packages/inference/meta.ts` | Campaign planner on Muse Wonder (low effort) via the gateway `/v1/json`. Same `propose(c, store, observations)` signature and `Proposal` validation as before. |
| `packages/renderers/cutout.ts` | Crops a SAM cutout to its visible pixels and fits it to the reel product area; returns null for empty/opaque images so the reel falls back to the plain photo. |
| `tests/fake-gateway.ts` | Fake Muse gateway (local HTTP server) shared by the tests. Not a test file itself. |
| `tests/meta-gateway.test.ts` | Gateway client: validation, error mapping, timeout, redirect refusal, status probe. |
| `tests/meta-preflight.test.ts` | Preflight rules incl. the **stale-price case** and the clean happy path, voice mismatch, Wonder warn-only behaviour, planner validation and call cap. |
| `tests/meta-routes.test.ts` | HTTP: enrich/enrichment, cutout actually composited in the rendered reel (pixel check), site hero served, stale-price end to end with `preflight_blocked`, voice limits, capabilities with no `NEBIUS_*`, Wonder planner. |
| `tests/meta-cutout.test.ts` | Cutout preparation edge cases. |
| `docs/META_NEW.md` | This page. |

## Changed files (pre-hackathon files)

| File | Change |
|---|---|
| `server/app.ts` | Imports the Meta planner/gateway; `createApp(store, {gateway?})`; `/capabilities` and `/public-config` report `muse` instead of `nebius`; new routes (below); `/generate` also accepts `mode: "muse"` (`"nemotron"` kept as an alias; any non-`manual` mode is an AI-planned job); `PUT /campaigns/:id?keepGenerated=true`; public site image route also serves the site's hero asset with its real MIME type; error handler maps `PreflightBlockedError` (409 `preflight_blocked`), `GatewayError` (503/502/422) and oversized bodies (413). |
| `server/engine.ts` | Uses the Meta planner and a `gateway` member; `approval()` refuses when preflight blocks; `generate()` feeds enrichment (site hero, reel cutouts) to the renderers. No change when no enrichment exists. |
| `packages/campaign/index.ts` | `SiteSpec.hero?` (optional, absent when no enrichment so baseline site hashes are unchanged) and an optional third `hero` argument to `specs()`. |
| `packages/renderers/Site.tsx` | Renders `<img class="site-hero-media">` when `spec.hero` exists. No CSS was added (that file is in `apps/studio/`); the image has fixed width/height attributes so it is usable without CSS. |
| `packages/renderers/reel.ts` | Optional `cutouts` argument: cutout shots pop in (ease-out scale + fade) over the brand-colour background, then drift; existing text overlay, transitions and photo/clip paths are untouched. |
| `services/providers/config.ts` | `nebiusChecks` replaced by `museChecks` (optional `MUSE_GATEWAY_URL` validation). `metaChecks` and `deploymentChecks` unchanged. |
| `tests/providers.test.ts` | Nebius-specific parts removed, see below. |

## Removed / adapted Nebius-specific items

- `packages/inference/nebius.ts` - deleted (replaced by `packages/inference/meta.ts`).
- `tests/providers.test.ts`:
  - `Nebius catalog parser rejects malformed provider responses` - deleted (tests only the Nebius model catalog).
  - `Nemotron planning disables visible reasoning and requires JSON output` - deleted (tests only the Nebius request body); its intent is covered by `Wonder planner validates proposals, ignores extra keys and enforces the call cap` in `tests/meta-preflight.test.ts`.
  - `provider configuration requires fresh bounded spend and exact callback` - adapted: Nebius variables and assertions removed, renamed `provider configuration requires exact callback and a valid gateway URL`, gateway URL check added. The Meta redirect and deployment assertions are unchanged.
- No `NEBIUS_*` variable is read anywhere. The `spend` table from `migrations/001.sql` is left in place (tenant deletion still touches it); nothing writes to it any more.

## New API (all under the existing session cookie + `Origin` rules)

New routes reply `{"data": X}` like the rest of the API **and** repeat X's fields at the top level, so both `j.data` and the contract shape work.

| Route | Notes |
|---|---|
| `GET /api/v1/capabilities`, `GET /api/v1/public-config` | `muse: {available, keyConfigured, reachable, models, error?}`. `available` is true only when the gateway is reachable and reports a key. |
| `POST /api/v1/voice/transcribe[?campaignId=uuid]` | Raw PCM16 16 kHz body (`application/octet-stream`, `audio/pcm` or `audio/L16`), 0.1 s to 60 s, even length. Returns `{transcript}`. With `campaignId` the transcript is saved and used by preflight as the voice surface. |
| `POST /api/v1/campaigns/:id/enrich[?scenes=0..2]` | Default 1 studio shot, first product only. Returns `{campaignId, products[], heroes[], models[], generatedAt, warnings[]}`. Persisted; applies to the **next** generation. A studio-shot failure keeps the SAM results and is listed in `warnings`. A SAM/gateway failure fails the call with no partial save. |
| `GET /api/v1/campaigns/:id/enrichment` | Persisted object or 404. |
| `POST /api/v1/campaigns/:id/preflight` | Optional body `{voiceTranscript?}`. Returns `{campaignId, ok, issues[], model, checkedAt, revision, fuzzy:{ran, error?}}`. If Wonder is unavailable the exact rules still run, `model` is `null` and `fuzzy.ran` is `false`. |
| `GET /api/v1/campaigns/:id/preflight` | Last stored result plus `current` (same revision) or 404. |
| `POST /api/v1/campaigns/:id/approve` | Now 409 `{error:{code:"preflight_blocked", message, issues[]}}` while any block issue exists (fresh exact rules plus the stored preflight for this revision). |

## Manual stale-price demo step

1. Generate a campaign so it has a site and reel.
2. Edit a product price with `PUT /api/v1/campaigns/:id?keepGenerated=true` (full campaign body + current `revision`). Without the flag the baseline behaviour is kept (edit resets to Draft and drops the generated artifacts).
3. Do **not** regenerate. Run preflight: site, reel and caption each get a `block` issue with `expected` = new price and `found` = old price; Approve returns `preflight_blocked`.
4. Regenerate, run preflight again: clean, approve works.

No route injects fake data; the flag only keeps the previously generated artifacts so they can be audited.

## Behaviour notes

- Preflight `block` is produced only by code. Wonder findings are always `warn`.
- The reel/site use enrichment only if the product still has the same source photo. Studio shots become the site hero only when the Spark fidelity check said `faithful === true`; otherwise the first SAM cutout is the hero.
- Re-running enrich stores new assets; older enrichment assets stay until the workspace is deleted (the 256 MB workspace media cap still applies).

## Render polish (reel + site hero)

| Change | Where | Notes |
|---|---|---|
| Cutout reel redesign | `packages/renderers/reel.ts`, `polish.ts`, `polish-art.ts` | Only the SAM-cutout path changed; photo and generated-clip shots keep the baseline filter graph and overlay. Product centred at y=640 with a baked soft drop shadow and contact shadow, spotlight background tinted by the cutout's dominant colour (sharp, deterministic) plus seeded film grain, pop-in then slow push and a 7px float, centred business small caps / large product name (auto-shrinks, up to 2 lines) / price pill / collection line fading up in sequence, per-shot counter. The last shot ends on a "Message us to order" CTA that appears at 2.3s and stays (no end fade on the last shot). Multi-product pacing (4s shots, 0.45s xfade) is unchanged. Poster for a cutout-first reel is taken at 1.6s instead of 0.8s. |
| Text safety | `polish.ts` `cleanText`, `polish-art.ts` `xmlEscape` | Text only ever reaches ffmpeg as pre-rendered PNG layers via SVG, with XML escaping as before; XML-illegal control characters are now stripped as well. No text goes into drawtext/filter strings. |
| Determinism | | Colour derivation, grain and layout are pure and seeded. The mp4 itself is not claimed byte-identical (x264 threading was not guaranteed before either). |
| Site hero | `Site.tsx`, `apps/studio/site.css` | With a hero image the section gets `has-media` and the copy is wrapped in `.site-hero-copy`: two columns on desktop, stacked below 760px (no horizontal overflow at 390px), cutout on a soft plate with shadow, studio shot rounded with shadow, pill CTA. Markup without a hero is unchanged. |
| Tests | `tests/render-polish.test.ts` | Colour maths, dominant colour, wrapping/fit, layout, scale, sanitising. |

## Red Pen (the signature feature)

The preflight does not only list problems; it marks up the merchant's actual website preview, reel frame and caption like an editor's red
pen, then turns the marks green when "Fix with Axys" regenerates and preflight passes. Screenshots of a live run:
`docs/evidence/redpen-live.png` (marked) and `docs/evidence/redpen-live-fixed.png` (fixed); reproduce with `node scripts/screenshot-redpen.mjs docs/evidence fix`.

| Area | Where | What |
|---|---|---|
| Preflight issue data | `packages/meta/preflight.ts`, `packages/meta/redpen.ts` | Each issue gains `locate` (`{text, reel:{shot, box}\|null}\|null`) and `fix` (`{kind:"regenerate",label}\|null`); existing fields unchanged. Reel boxes are normalised 0..1, derived from the renderer's own layout maths; `null` when not derivable. Verified against a real rendered frame (box lands on the price pill). |
| Fix semantics | same | Block issues on site/reel/caption get `regenerate`; Wonder warnings and seller-voice issues get `fix: null`. |
| Strictness fixes found by the eval | `packages/meta/preflight.ts` | Dash/quote typography treated as equivalent (was 3.6% false alarms on benign variants); confirmed phrases match across whitespace; `:443` and a trailing path slash equal; a caption link that merely extends the confirmed URL is now blocked. |
| Red Pen UI | `apps/studio/redpen.tsx`, `redpen.css`, `meta.tsx`, `main.tsx` | Hand-drawn animated marks anchored to DOM text (site, caption) and to the reel frame; numbered list mirrors the marks; aria-live announcements; reduced-motion respected; "Fix with Axys" regenerates, polls, re-runs preflight, marks turn green. `?fixture=meta&scenario=stale` stages it with no backend (badged fixture data). |
| Handwriting font | `apps/studio/public/fonts/caveat-latin.woff2` | Caveat (SIL OFL 1.1), bundled so the server's content-security policy cannot block it. |
| Mutation eval | `eval/*`, `npm run eval:preflight [-- --live]`, `tsconfig.json` (adds `eval`) | See below. |
| Scripts | `scripts/live-e2e.mjs`, `scripts/screenshot-redpen.mjs` | Reproducible live run and Red Pen capture. |
| Tests | `tests/meta-redpen.test.ts`, `tests/eval-metrics.test.ts`, assertions in `tests/meta-routes.test.ts` | |

### Preflight mutation eval (`eval/preflight-report.html`)

Offline, exact-match rules only, 1,657 cases from 12 generated campaigns (cases share base campaigns, so intervals are optimistic):
drift in artifact text detected 312/312 (site 120/120, reel 72/72, caption 120/120); facts edited after generation blocked 114/114;
wrong spoken price blocked 12/12; false alarms 0/24 on untouched controls and 0/1,111 on benign formatting variants
(`₹`, `Rs`, "129 rupees", grouping, case, spacing, dashes, date formats, `:443`, trailing slash).
`locate.text` matched the mutated text 312/312 and the reel box was on the correct shot 72/72.

Known misses (measured, not fixed): an extended value (`"... Pvt Ltd"`, `"..., now 20% off"`) and one stale occurrence among two (stale hero
line with a correct footer) are not detected because the check is "contains the confirmed value".

Live (Muse Wonder, 10 calls, 0 errors): unsupported caption claims flagged 7/7 (organic, free delivery, 50% off, award-winning, immunity,
"best in the city", "only 3 left"), 0/3 warnings on unmodified controls. Small sample.

## Round 2: product-true scene reel + "Say it" commands

Positioning: Meta's API has no video-generation model, so Axys does not compete on generative cinematography. It guarantees what generated
video cannot: **the exact product pixels** (SAM cutout composited, never regenerated), **correct facts on every surface**, and a **say-it workflow**.

| Area | Where | What |
|---|---|---|
| Backdrop plates | `gateway/server.py` `POST /v1/plate`, `gateway/meta_client.py` `generate_plate` | Text-only Muse Image call producing a product-free backdrop with an empty tabletop. |
| Plate enrichment | `packages/meta/plate.ts`, `enrichment.ts`, `gateway.ts`, `server/app.ts` (`enrich?plates=0\|1`) | Muse Wonder writes a short backdrop description; code rejects descriptions naming the product or containing digits, links, markup or words like product/price/logo/text/hand; deterministic safe fallback. |
| Scene reel | `packages/renderers/scene.ts`, `reel.ts`, `cutout.ts`, `server/engine.ts` (plumbing only) | Plate full-bleed with push-in and drift; SAM cutout grounded with a contact shadow and a cast shadow coloured from the plate; light sweep; parallax; text on a soft scrim with a contrast guarantee. Fallbacks: no plate -> cutout reel -> baseline. Text positions are identical to the cutout reel, so Red Pen boxes stay correct. |
| Product fidelity metric | `packages/renderers/fidelity.ts`, `scene-fidelity.ts` | `measureProductFidelity`: MAD and SSIM of the on-frame product against the resampled source cutout, on the opaque interior. Measures compositing fidelity only (not whether the cutout is a faithful picture of the real product). Real run, 5 frames: mean MAD 6.10/255 (2.4%), mean SSIM 0.937; outside the light sweep MAD about 2.8 (1.1%), SSIM about 0.956; the light sweep itself raises MAD to about 12; control with the placement shifted 25 px: MAD 22.0, SSIM 0.48. |
| Renderer robustness | `packages/renderers/reel.ts` | `command()` kills the whole ffmpeg process tree on timeout and has an opt-in stall watchdog; the main ffmpeg call is retried once if it stalls. (ffmpeg 8.1.2 was seen to stall intermittently on this machine.) |
| Command parse | `packages/meta/command.ts`, `server/app.ts` `POST /campaigns/:id/command` | Muse Wonder turns a spoken or typed change into a strict patch (`offer, message, collection, validUntil, products[{ref, priceMinor, name}]`). Never applies. Rules in code: every number/date/word must come from the command text; unknown fields, absurd or zero prices, injection-like text, conflicting values and ambiguous "move the sale to <day>" are rejected with a clarifying question; 10x price jumps ask for confirmation. |
| Command apply | `server/app.ts` `POST /campaigns/:id/command/apply`, shared `saveEdit()` | Accepts only a patch the server itself produced for that campaign and revision within the last hour (forged or altered patches get `not_verified`); applies with the `keepGenerated` semantics so artifacts stay and preflight/Red Pen mark them stale. |
| Studio | `apps/studio/sayit.tsx`, `sayit.css`, `redpen.tsx`, `meta.tsx`, `meta.css`, `main.tsx` | Say it bar (type or voice) with diff cards and the quote of what was said; Apply auto-runs preflight so Red Pen marks every stale surface; sticky dock with Fix with Axys; plates shown in Meta Lens. `?fixture=meta&scenario=command` stages the loop without a backend (badged). |
| Tests | `tests/meta-command.test.ts` (22), `tests/scene-math.test.ts`, `tests/scene-fidelity.test.ts`, `tests/scene-reel.test.ts`, `tests/fake-gateway.ts`, `tests/meta-routes.test.ts` | |

Live command results (real Muse Wonder, gateway on 8766): "make the bread one forty nine" -> bread 50.00 -> 149.00; "price 1,499 rupees" -> parsed with a
confirm question for the ~11.6x change; "change the offer to Diwali special" -> offer rewritten; "make it cheaper", "make it 149" (two products),
"set the mug price to 0", "mug 149, no wait 199", and a prompt-injection attempt -> all rejected with a question; "the offer ends Sunday" ->
end date resolved to Sun 8 Nov; "make the mug 149 and move the sale to Sunday" -> asks whether the collection day or the offer end is meant.
End to end on a live campaign: "make the mug one ninety nine rupees" parsed with the quote "one ninety nine rupees", applied, and preflight then
blocked the site, reel and caption (expected INR 199.00, found INR 129.00; reel box on the price pill).

## Round 3: publishing and the feedback loop

| Area | Where | What |
|---|---|---|
| Feedback logic | `packages/meta/feedback.ts` (new) | Normalises Instagram insights and website events into observations (unknown values are dropped, never zeroed); builds the revision prompt; `groundingProblem` requires the suggestion to quote at least one real observed number, rejects any number that was not observed, and rejects sales/revenue/causation wording; `fallbackProposal` summarises only the real numbers; `acceptRevision` keeps the confirmed offer, enforces `tool: propose_revision`, drops a product order with unknown ids. |
| Feedback planner | `packages/inference/meta.ts` `proposeRevision` | No observations: no model call, returns `request_facts` ("nothing to base a revision on"). With observations: Muse Wonder proposes one change; an ungrounded or obedient reply is replaced by the deterministic summary (`trace.grounded`, `trace.fallbackReason`). Response is still `{proposal, trace}` plus `signal`. |
| Route fix | `server/app.ts` `POST /campaigns/:id/revision` | Now calls `proposeRevision` with the app's configured gateway (it previously ignored the injected gateway and used the planner prompt, which answered "render this campaign" and never used the metrics). |
| Publish loop test | `tests/meta-publish-loop.test.ts` (new) | The real Instagram adapter (`services/publishing/meta.ts`) run against a LOCAL fake Graph API: REELS container with the signed https video URL and caption, status polling, exactly one `media_publish`, receipt/permalink, insights pull, then a grounded revision proposal; asserts nothing is republished. Proves our request building and state machine, not that Instagram accepts our app. |
| Feedback tests | `tests/meta-feedback.test.ts` (new, 7 tests) | Normalisation, grounding, forged or obedient replies, wrong tool, no-observation path. |
| Readiness | `scripts/publish-readiness.mjs` | Lists which settings are missing before a real post (names and pass/fail only, never values). |

Live check of the feedback planner (real Muse Wonder, fabricated-but-realistic numbers, NOT real Instagram data): with reach 420, likes 37, saves 2,
site visits 58 and contact clicks 3 it proposed moving the contact link higher and said the numbers were too small to justify a major change,
quoting saves 2, site_contact 3 and site_visit 58; with no observations it made no model call. Before the fix, the same inputs returned the
generic "render this campaign" answer and ignored the numbers.

## Round 4: product-aware studio film

Reference: a polished AI-generated ad (generative live action with actors and voiceover). Meta's API cannot produce that, so Axys reproduces its
ad grammar with the merchant's real product pixels: hero float, whip-pan with motion blur, macro close-up, bold kinetic type, a context scene and
the branded facts card. Everything is driven by Muse Spark first identifying what the product is.

| Area | Where | What |
|---|---|---|
| Product understanding | `packages/meta/direction.ts` (new), `enrichment.ts`, `server/app.ts` (`enrich?film=0\|1`) | One Muse Spark vision call returns category, subject, descriptors, **parts**, palette, mood, motion, up to 3 product-free backdrops (hero/context/detail) and kinetic phrases, validated fail-closed in code (phrases with digits, URLs, money, superlatives or claims are dropped; unknown enums, bad hex and unsafe backdrops fall back). Facts never come from the direction. Live on a mug, sneaker and cake: every field matched the photo. |
| Composite cutouts | `gateway/server.py` `POST /v1/segment_multi`, `gateway/meta_client.py` `union_masks`, `packages/meta/gateway.ts` `segmentMulti`, `enrichment.ts` | SAM correctly cuts "the cake" without its raspberries (they are separate objects). Spark now names the visible parts (e.g. raspberries); the product and its parts are cut out as one union mask with small gaps and holes filled. If the union fails, the first cutout is kept and a warning is added. Live: cake cutout coverage 19% -> 28% and every raspberry is now in the reel (`docs/evidence/cake-sam-cutout-before.png` shows the original cut). |
| Studio film | `packages/renderers/film.ts`, `film-art.ts`, `film-fidelity.ts`, `ffmpeg.ts`, `fonts/Anton-Regular.ttf` (OFL) | 10 s per product: hero float on a palette-tinted set, whip pans with real directional motion blur, macro close-up chosen by edge energy (never enlarged beyond 1.8x source pixels), context scene on a plate, kinetic phrases in Anton rendered as PNG layers (no drawtext), then the existing facts end card in the same positions (Red Pen boxes stay valid; facts visible from 7.6 s). Falls back film -> scene -> cutout -> baseline. Hero compositing fidelity on a real render: mean abs diff 4.3 to 6.3 /255, SSIM 0.87 to 0.91 (includes film grain and two H.264 encodes). |
| Studio UI | `apps/studio/film.tsx`, `meta.tsx`, `redpen.tsx`, `main.tsx` | "Muse Spark identified: ..." panel (category, palette swatches, mood/motion, plates labelled by purpose, phrases marked "Decoration, not facts"); Red Pen seeks to the facts card of film reels; reels autoplay muted in view (reduced motion respected). |
| Feedback loop | `packages/meta/feedback.ts`, `packages/inference/meta.ts` `proposeRevision` | See Round 3. |
| Tests | `tests/meta-direction.test.ts` (19), `tests/film-math.test.ts`, `tests/film-reel.test.ts`, `tests/meta-feedback.test.ts`, `tests/meta-publish-loop.test.ts`, `tests_py/test_gateway.py` (8) | |

Evidence: `docs/evidence/film-sneaker-frames.png` and `film-cake-frames.png` (frames at 0.6, 2.0, 3.6, 4.4/2.7, 5.6 and 8.6 s of live renders), reels in
`docs/evidence/sneaker/` and `docs/evidence/cake/`. Honest limits against the reference: no people or live footage, no billboard or tiled-panel
transitions, one backdrop per scene, the product floats slightly above the surface in the context scene, end card is a plain text block, no voiceover or music
(Meta's voice model only transcribes speech).

Kinetic type contrast (renderer, `film-art.ts` `chooseInk` / `chooseContextInk`): ink is chosen from the pixels actually behind each phrase (first option reaching 4.5:1, else
the better ink plus an opposing outline and shadow, with a stronger top scrim on busy plates). Measured on live renders (ink vs the background pixels inside the text box,
worst case / median): cake macro 7.57 / 10.55, cake context 2.67 / 7.23 (plain ink on the bright herb plate is worse, hence the outline), sneaker macro 6.88 / 10.88,
sneaker context 2.36 / 6.13. Final suite: 189 Node tests and 8 gateway tests pass.

## Round 5: Hardwright-style redesign (landing, The Bench, dark Studio) and live lab endpoints

The site was restyled to match the look of the user's own "Hardwright" project (dark base, orange and violet accents, stat counters, recorded replay, before/after slider,
capability grid, pipeline tabs, mini-games). Every number on the landing page carries a tag: live engine, recorded run or measured offline. Design brief: `docs/REDESIGN_CONTRACT.md`.

| Area | Where | What |
|---|---|---|
| Landing page | `apps/studio/landing.tsx`, `landing.css`, `landing-kit.tsx`, `main.tsx` | Hero with autoplaying reel card, problem stat grid, recorded Say it / Red Pen / Fix replay, cutout drag slider and film strips, nine capability cards, pipeline tabs, how it works, architecture layers, "What is real" and honest limits. Styles scoped under `.lp`. |
| The Bench | `apps/studio/bench.tsx`, `bench.css` | Five games. Live engine: Spot the stale surface (real preflight rules) and Would this tagline pass (real phrase filter); each falls back to clearly labelled recorded samples if the endpoint is unreachable. Recorded: Name that product, Cutout or not, Pick the ink. |
| Public lab endpoints | `packages/meta/lab.ts`, `direction.ts` (`kineticPhraseCheck`), `server/app.ts`, `tests/public-lab.test.ts` | `GET/POST /api/v1/public/lab/preflight` (six deterministic scenarios built from the real text builders, one stale surface each, checked by the real `deterministicIssuesFromTexts`) and `POST /api/v1/public/lab/phrase`. No auth, no cookies, no model calls, 60 requests/min/IP, strict validation, nothing echoed. |
| Dark Studio theme | `apps/studio/style.css`, `meta.css`, `redpen.css`, `sayit.css` | `--ax-*` tokens, orange primary, Geist, grid background, orange focus rings, AA contrast. The merchant website preview stays cream in a dark browser-style frame. The dead legacy `.marketing` block was removed. |
| Fonts | `package.json` (`@fontsource-variable/geist`, `geist-mono`) | Bundled, so the content-security policy cannot block them. |
| Assets | `apps/studio/public/landing/` | Real reels and optimised frames from the live runs in `docs/evidence/`. |

Test status after this round: 198 Node tests pass.
