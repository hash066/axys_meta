# Axys for Meta — build contract

Product: **Axys** (WhatsApp-first merchant campaign studio: products + photos + voice brief -> website + reel + connected Instagram -> results).
This fork keeps the Axys loop and replaces/extends the AI layer with Meta's Model API. Pre-hackathon code is fingerprinted in `docs/BASELINE.sha256`
(sha256 of every file as copied from the Oct 19-26 Axys build). Everything new or changed for the hackathon must be listed in `docs/META_NEW.md`.

## Facts about Meta's models (verified from Meta's public cookbook; do not guess others)

- Base URL `https://api.meta.ai/v1`, `Authorization: Bearer $MODEL_API_KEY`, OpenAI-compatible Responses API (`POST /responses`).
- **Muse Spark** `muse-spark-1.3`: multimodal (image in, text out) reasoning. **Muse Wonder** `muse-wonder-1.0`: text reasoning/agentic model (always reasons; `reasoning.effort` minimal..max; NOT a video model). **Muse Image** `muse-image-1.0`: image generation/editing via the `image_generation` tool. **SAM 3.1** `sam-3.1`: segmentation, output needs Meta's Python `meta_sam_parser`. **Muse Voice Transcribe**: realtime websocket ASR.
- There is NO video-generation model in the API. Reels stay FFmpeg compositions (as in baseline Axys), now built from SAM cutouts and Muse Image shots.

## Architecture

```
Studio (React, apps/studio)  <->  Express server (server/*)  <->  Muse gateway (Python FastAPI, gateway/, http://127.0.0.1:8766)  <->  api.meta.ai
```
The gateway is the only thing that holds `MODEL_API_KEY` and talks to Meta. The Node server calls it via `MUSE_GATEWAY_URL` (default `http://127.0.0.1:8766`).
If the gateway is down or has no key, Node features must degrade honestly: return a clear error / `{available:false}`, never fake success.

## Muse gateway API (owner: lead; implemented in `gateway/`)

- `GET /v1/health` -> `{"key_configured":bool,"models":{"spark":"muse-spark-1.3","wonder":"muse-wonder-1.0","image":"muse-image-1.0","sam":"sam-3.1","voice":"muse-voice-transcribe-1.0"}}`
- `POST /v1/transcribe` body = raw 16 kHz mono PCM16 bytes -> `{"transcript":"..."}`
- `POST /v1/segment` multipart (`image` file, `concept` text) -> `{"found":bool,"concept":"...","coverage":0-1,"bbox":[x0,y0,x1,y1]|null,"size":[w,h],"overlay_png_b64":"..."|null,"cutout_png_b64":"..."|null}`
- `POST /v1/scene` multipart (`image` file, `scene` text) -> `{"image_png_b64":"...","fidelity":{"faithful":bool|null,"differences":["..."]}}`
- `POST /v1/json` JSON `{"model":"wonder"|"spark","prompt":"...","images_b64":["png b64",...]?, "effort":"minimal|low|medium|high"?}` -> `{"json":{...},"model":"muse-wonder-1.0"}` (model output parsed as JSON; 502 with message if not JSON)
Errors: non-2xx with `{"error":"message"}`. 503 if no key.

## Node server additions (owner: node worker) — all under existing auth/tenant rules (reuse existing session/tenant middleware and asset store)

1. `packages/meta/gateway.ts`: typed client for the gateway (timeouts, `MUSE_GATEWAY_URL`, redirect: "error", errors mapped to clear messages).
2. Replace the Nebius/Nemotron planner: new `packages/inference/meta.ts` exporting the same `propose(...)` signature used by `server/engine.ts`, implemented with Muse Wonder through `/v1/json` (low reasoning effort). Keep the `Proposal` zod validation and the "untrusted data" system prompt. Drop Nebius spend-cap plumbing that no longer applies; keep a simple per-campaign call counter/cap. Remove Nebius from required config/capabilities so the app starts without any NEBIUS_* env; report Meta gateway status in `/api/v1/capabilities` and `/api/v1/public-config`.
3. `POST /api/v1/voice/transcribe` (raw PCM16 16 kHz body, max 60 s) -> `{transcript}` via gateway. Auth required.
4. `POST /api/v1/campaigns/:id/enrich` -> for each product photo: SAM segment (concept = the product name) producing overlay + cutout stored as assets; plus Muse Image studio shots (default 1 scene for the first product only, `?scenes=n` up to 2, to bound spend) with Spark fidelity check. Returns and persists:
   `{"campaignId","products":[{"productId","concept","found","coverage","bbox","overlayAssetId"|null,"cutoutAssetId"|null}],"heroes":[{"productId","scene","assetId","faithful":bool|null,"differences":[]}],"models":["sam-3.1","muse-image-1.0","muse-spark-1.3"],"generatedAt":"ISO"}`
   `GET /api/v1/campaigns/:id/enrichment` returns the persisted object or 404.
   Use enrichment in rendering: SAM cutouts feed the reel (cutout pop-in over a brand-colour background with the existing motion/overlays) and the site hero; heroes are optional extra images. Rendering must still work without enrichment (baseline behaviour).
5. `POST /api/v1/campaigns/:id/preflight` -> Muse Wonder audits ALL surfaces against the merchant-confirmed facts before approval: site spec, reel shots/text, caption, plus a seller-voice transcript if present. Returns
   `{"campaignId","ok":bool,"issues":[{"severity":"block"|"warn","surface":"site"|"reel"|"caption"|"voice","text":"...","expected":"...","found":"..."}],"model":"muse-wonder-1.0","checkedAt":"ISO"}`.
   Do the deterministic comparison in code FIRST (prices, offer text, contact URL, collection, validUntil appearing in each surface), and use Wonder only for the fuzzy part (claims in copy that facts do not support). Code-detected mismatches are always `block`. `POST .../approve` must refuse when a preflight with `block` issues exists for the current revision (add a clear error code `preflight_blocked`).
   A dev/demo route is NOT allowed to inject fake data into production paths; for the "stale price" demo moment add a clearly named test-only helper in tests and a documented manual step (edit the price after generation without regenerating) that the preflight must catch.
6. Voice: the existing audio upload route stays; add transcript text to the campaign `brief` flow via the new transcribe route (client sends PCM).
7. Tests for all of the above in `tests/*.test.ts` using a fake gateway (local http server on a random port). Keep all 68 existing tests passing (after removing/adjusting only the Nebius-specific ones; note each in META_NEW.md). `npm run typecheck && npm test` must pass.

## Studio UI additions (owner: ui worker; only `apps/studio/**`)

- Voice brief recorder: capture 16 kHz mono PCM16 in the browser (AudioContext at 16000, ScriptProcessor), POST raw bytes to `/api/v1/voice/transcribe`, put the transcript into the brief field (editable).
- **Meta Lens** panel/tab per campaign: calls `POST /api/v1/campaigns/:id/enrich` (show progress), then displays for each product a before/after reveal slider (original vs SAM overlay), the cutout on a checkerboard, and the Muse Image studio shots with a "matches your product" / "differs" fidelity badge. Model chips: SAM 3.1, Muse Image, Muse Spark.
- **Preflight** panel: button "Run preflight" -> `POST .../preflight`; show issues grouped by severity with surface, expected vs found; block/disable the Approve control (with explanation) while `block` issues exist; re-run clears it. Show "Checked by Muse Wonder + exact-match rules".
- Keep the existing 5-stage flow, WhatsApp entry, publishing and results screens working. Visual polish matters: this is the hackathon demo. Dark/light as per existing style is fine; do not rewrite unrelated screens.
- Everything must work with `?fixture=meta` that stubs ONLY the new endpoints client-side with clearly badged "FIXTURE DATA — not model output" content (so the UI can be developed and screenshotted without a key). Live path uses the real endpoints.

## Ownership (do not edit files you do not own)

| Owner | Files |
|---|---|
| lead | `gateway/**`, `docs/META_CONTRACT.md`, `README.md`, root config |
| node worker | `server/**`, `packages/**`, `services/**`, `migrations/**`, `tests/**`, `docs/META_NEW.md`, `package.json` deps (only if truly needed) |
| ui worker | `apps/studio/**` (and `vite.config.ts` only if required) |

Never read or print any `.env*` file. Never commit. Do not modify `docs/BASELINE.sha256`.

---

# Addendum: Red Pen (the unique factor)

Idea: Axys does not list preflight problems in a side panel. It **marks up the merchant's actual artifacts** like an editor's red pen:
a hand-drawn red ellipse and strike-through around the wrong text on the website preview, on the reel frame, and in the caption,
each with a short handwritten note ("now INR 149.00 — regenerate"). After the merchant clicks "Fix with Axys" (regenerate + re-run
preflight), the same marks turn green ticks where the issue is resolved. The artifact is the interface.

## Server additions (node worker: server/**, packages/**, tests/**, eval/**, package.json scripts)

1. Each preflight issue gains optional locating data (keep all existing fields):
   `"locate": {"text": "<exact wrong text as it appears on that surface, e.g. 'INR 129.00'>", "reel": {"shot": <0-based index>, "box": [x, y, w, h]} | null }`
   - `text` is the exact substring found on the surface (for caption/site) so the UI can find it in the DOM.
   - `reel.box` is a rectangle in NORMALISED coordinates (0..1) of the final 1080x1920 frame, computed from the real layout maths in
     `packages/renderers/polish.ts` / `polish-art.ts` for the line that carries the wrong value (price pill, product name, collection line,
     business line). For baseline (non-cutout) reels use the layout of that path or `null` if it cannot be computed honestly.
   - Never invent positions: if a box cannot be derived, send `null`.
2. `fix`: each issue also carries `"fix": {"kind":"regenerate","label":"Regenerate to use INR 149.00"}` for exact-rule mismatches
   (the single honest remedy is regenerating from the confirmed facts). Wonder-only warnings carry `"fix": null`.
3. Mutation eval harness `eval/preflight-mutations.ts` (run with `npm run eval:preflight`): builds generated campaigns offline using the
   existing deterministic `specs()` and renderers' text, then applies single-fact mutations AFTER generation (price up/down, currency, offer,
   collection/date, contact URL, business name, product name, validUntil) and equivalent formatting variants that must NOT alarm
   (`INR 129.00` vs `₹129`, `129` vs `129.00`, Indian grouping `1,299.00`, trailing spaces, case changes) plus untouched controls.
   Report per-surface detection rate, false-alarm rate on controls and on benign formatting variants, with counts and Wilson 95% CIs, to
   `eval/preflight-report.json` and a self-contained `eval/preflight-report.html`. An optional `--live` flag adds ~10 cases where the caption
   contains an unsupported claim ("organic", "free delivery", "50% off", "award-winning") and asks Muse Wonder via the gateway; report these
   separately as live results with the model id; without `--live` say plainly that fuzzy detection was not evaluated. Never fabricate numbers.
   Add unit tests for the harness's metric code.

## Studio additions (ui worker: apps/studio/**)

- In the Publish stage after a preflight with issues, a **Red pen** layer draws on the real artifacts:
  1. Website preview: find `locate.text` in the rendered site DOM (TreeWalker + Range.getClientRects), draw a hand-drawn wobbly SVG ellipse
     and strike-through over each match plus a handwritten note (Google font "Caveat", cursive fallback) near it with `expected`.
  2. Reel preview: overlay positioned from `locate.reel.box` on the reel frame/video (letterbox-aware), same mark style.
  3. Caption preview: highlight the matching text with a red underline/ellipse and the same note.
  Marks draw in with an animated stroke (disabled under `prefers-reduced-motion`), repositioned on resize/scroll, keyboard-reachable list below
  mirrors them (accessibility). A "Red pen on/off" toggle.
- **Fix with Axys** button: calls the existing generate route (`mode: "muse"`), polls until generation settles, re-runs preflight, and for each
  previously marked location that now passes animates the red mark turning into a green tick with "matches your confirmed facts".
  Approve stays disabled while block issues remain (existing behaviour).
- `?fixture=meta&scenario=stale` must stage this whole scenario without a backend (stale price on all three surfaces, then "fixed") with the
  existing visible "FIXTURE DATA — not model output" badge.
- Do not rewrite unrelated screens; mobile (390px) must work.

## Ownership
node worker: server/**, packages/**, tests/**, eval/**, package.json. ui worker: apps/studio/**. lead: docs/**, scripts/**, README.md.
Neither worker edits docs/ (report doc rows to the lead in the final message). Never read or print .env*. Never commit.

---

# Addendum 2: Product-true scene reel + "Say it" commands

Positioning (honest): Meta's API has no video-generation model, so Axys does not compete with Runway on generative cinematography.
Axys competes on what generative video cannot guarantee: **your exact product pixels** (SAM cutout composited, never regenerated),
**correct facts on every surface** (preflight + Red Pen), and a **say-it workflow** (speak a change, watch every surface follow).

## 1. Product-true scene reel (renderer worker: packages/renderers/**, new tests tests/scene-*.test.ts)

When the campaign has enrichment with a **backdrop plate** (a Muse Image backdrop with NO product in it, empty tabletop in the lower-middle)
AND a usable SAM cutout for the product, render a new scene shot instead of the flat-colour cutout shot:
- Plate = full-bleed background (cover-fit 1080x1920), slow push-in (e.g. 1.00 -> 1.08) and a slight drift.
- Product cutout composited on the tabletop (lower-middle, product ~35-42% of frame height), grounded with a contact shadow cast onto the plate
  (soft ellipse + longer faint shadow, tinted from the plate), gentle light sweep across the product, subtle settle-in animation.
  PARALLAX: background and product move at different speeds so it reads as depth. The product itself is never warped, regenerated or recoloured
  beyond the light sweep (keep it subtle).
- Text block stays in the SAME screen position and layers as the existing cutout shot (business, product name, price pill, collection line, CTA), on a soft
  bottom scrim for legibility, so `locate.reel.box` from `packages/meta/redpen.ts` stays correct. Add/keep a test proving the boxes are unchanged.
- Fallback: no plate -> existing cutout reel; no cutout -> baseline. Multi-product campaigns reuse one plate per product if available else the first plate.
- Product-pixel fidelity: implement `measureProductFidelity` (pure function + test): for sampled frames, compare the on-frame product region
  against the source cutout resampled with the known transform, report mean absolute difference over the opaque region (and SSIM if feasible). Be honest
  about what it measures (compositing fidelity, not "AI faithfulness"). Report numbers; do not invent thresholds.
- Plumbing: read `plates` from enrichment (type below); a minimal edit of the render-plumbing lines in `server/engine.ts` is allowed for you ONLY if needed
  (re-read the file immediately before editing; the node worker owns the rest).

## 2. Plates + commands (node worker: server/**, packages/meta/**, packages/inference/**, tests/** except tests/scene-*.test.ts)

- Gateway already has `POST /v1/plate` JSON `{backdrop}` -> `{image_png_b64}` (text-only Muse Image, product-free backdrop). Add the client method + fake-gateway support.
- Enrichment gains `plates?: {assetId: string, backdrop: string}[]` (persisted, bounded; `POST .../enrich?plates=0|1`, default 1 when scenes are enabled).
  The backdrop description comes from Muse Wonder (short, matches the product category/brief, NEVER names the product itself), with a deterministic safe fallback.
  Existing enrichment fields and routes stay unchanged and backward compatible.
- `POST /api/v1/campaigns/:id/command` body `{text}` (<= 500 chars): Muse Wonder turns a spoken/typed change ("make the mug 149 and move the sale to Sunday")
  into a STRICT patch: allowed fields only `offer, message, collection, validUntil (ISO), products[{ref: product name or 0-based index, priceMinor, name}]`.
  Returns `{understood, patch, diff:[{field,label,from,to,quote}], summary, questions[], model}`. It never applies anything.
  Anti-hallucination is enforced IN CODE: every number/date/word in the patch must be justified by the command text (numbers must appear in it, with
  currency/words like "149", "one forty nine", "₹149" handled sensibly; a patch value not supported by the text is rejected with `understood:false` and a question).
  Unknown fields, extra products, price <= 0 or absurd values are rejected. Treat the text as untrusted.
- `POST /api/v1/campaigns/:id/command/apply` body `{patch, revision}`: re-validates, applies to the confirmed facts using the same semantics as
  `PUT ...?keepGenerated=true` (artifacts stay, so preflight/Red Pen mark them stale), returns the campaign. Refuses on stale revision or while generating.
- Tests with the fake gateway, including adversarial command text (prompt injection, "set price to 0", conflicting values).

## 3. Studio (ui worker: apps/studio/**)

- A **Say it** bar in the Review and Publish stages: text field + mic button (reuse the existing 16 kHz recorder -> /voice/transcribe) -> `POST .../command`.
  Show diff cards (field, old -> new, the quote from what was said) with Apply / Cancel and any clarifying question. Apply -> `.../command/apply`, refresh the
  campaign, auto-run preflight so Red Pen marks every stale surface, then offer Fix with Axys (existing). The whole loop must feel like one gesture:
  say it -> see the diff -> everything marked stale -> one press -> everything fixed.
- Meta Lens shows the backdrop plate(s) with the model chip "Muse Image" and a "no product in the plate" note.
- `?fixture=meta&scenario=command` stages the full loop with no backend (visible FIXTURE badge).

## Ownership
renderer worker: packages/renderers/**, tests/scene-*.test.ts. node worker: server/**, packages/meta/**, packages/inference/**, other tests/**. ui worker: apps/studio/**.
lead: gateway/**, docs/**, scripts/**, README.md. Workers never edit docs/ (report rows). Never read/print .env*. Never commit. Never restart servers
unless you own it: the UI worker may rebuild (`npm run build`) and restart the Studio server on 4310 with
`AXYS_DATA_DIR=var/demo AXYS_STARTER_CREDITS=200 npm start` after killing only the process listening on 4310; the gateway on 8766 must stay up.

---

# Addendum 3: Product-aware "studio film" reel

Reference: the user showed a polished AI-generated ad (ElevenLabs Creative, shoe brand). That is generative live-action video with actors and
voiceover, which Meta's API cannot produce and we do not claim to. What we CAN reproduce honestly is its ad grammar, using only the real product
pixels (SAM cutout) plus Muse Image backdrops: a hero shot with the product floating on a tinted studio gradient, a macro close-up, whip-pan
transitions with motion blur, large kinetic type, a lifestyle context scene chosen for THIS product, and a branded end card. Everything is driven
by Muse Spark first identifying what the product is.

## 1. Product understanding (node worker: server/**, packages/meta/**, packages/inference/**, tests/** except scene/film tests)

New step in enrich (when scenes or plates are enabled): one Muse Spark VISION call through the gateway (`POST /v1/json`, model `spark`, the product photo in `images_b64`)
returns a `direction` object, persisted in the enrichment (`direction?` field, backward compatible) and validated in code (zod, fail-closed to a default):
```
{ category: footwear|apparel|jewellery|homeware|food|beverage|beauty|electronics|furniture|toys|stationery|plants|other,
  subject: "<=4 words generic noun phrase, e.g. 'ceramic mug'",   // used in prompts, never a brand claim
  descriptors: [<=4 short visual adjectives seen in the photo],
  palette: ["#rrggbb" x 2-3 dominant product colours],
  mood: warm|minimal|bold|playful|luxe|earthy|fresh,
  motion: calm|punchy,
  worlds: [{ purpose: "hero"|"context"|"detail", backdrop: "<product-free backdrop description>" } x up to 3],
  phrases: [<=3 short kinetic words/phrases, <=3 words each, evocative, e.g. "Made by hand", "Morning ritual"] }
```
Rules in code: `backdrop` strings go through the existing plate safety checks (no product name, digits, links, markup, product/price/logo/text/hand words);
`phrases` must contain NO digits, no currency, no superlatives or claims (best, #1, guaranteed, free, organic, certified, award, cheapest, sale, % ...),
no URLs, <=3 words each, otherwise dropped; unknown enum values fall back to `other`/`warm`/`calm`; palette must be valid hex. Deterministic fallback direction when
Spark fails (category other, palette from the cutout, generic worlds, no phrases). The phrases are decoration only: facts (prices, offer, dates) NEVER come from `direction`.
Plates: generate up to 3 plates (hero studio backdrop tinted to the palette, context scene, optional detail/texture) via the existing `/v1/plate` and persist
`plates?: {assetId, backdrop, purpose?}[]` (purpose optional, backward compatible); default `?plates=` stays 0|1 for the old reel but a new `?film=1` (default 1 when scenes are on)
generates the three plates in parallel with a cap. Bounded spend: at most 1 Spark + 3 Image plate calls per product extra.
The UI and renderer read `direction` and `plates[].purpose`.

## 2. Studio film template (renderer worker: packages/renderers/**, tests/film-*.test.ts, packages/renderers/fonts/**)

When a product has a SAM cutout and enrichment with `direction` + plates, render a ~10 s film per product (keep the existing scene/cutout/baseline paths as fallbacks):
1. Hero float (0-2.6 s): product floats over a studio gradient plate (hero plate or a procedural gradient from `direction.palette`), soft floor shadow + glow, slow push and 1-2 degree tilt, light sweep. Brand small-caps only.
2. Whip transition (~0.25 s): horizontal motion-blur streak between shots (real directional blur on the outgoing/incoming frames, not a cross-fade).
3. Macro (2.6-5.0 s): crop-zoom into the most detailed region of the cutout (choose by edge energy) with a shallow-depth blur falloff and slow drift; keep resampling honest (do not zoom beyond ~1.8x of source pixels without saying so in the report); first kinetic phrase.
4. Context (5.0-7.6 s): the product grounded on the context plate (reuse the scene shot logic), second kinetic phrase if any.
5. End card (7.6-10 s): EXACTLY the existing facts text layout (same layers, same screen positions as the current cutout/scene text block, so Red Pen `locate.reel.box` stays correct), on a scrim over the plate, with price pill and CTA.
Kinetic type: a bold condensed display face bundled in the repo (SIL OFL, e.g. Anton or Bebas Neue; fetch the TTF, add an OFL note, keep license text), rendered with sharp's text input (`fontfile`) as transparent PNG layers, animated with ffmpeg expressions (word-by-word pop/slide, tracking). Phrases come ONLY from `direction.phrases`; never render anything else that looks like a claim.
Style follows `direction.mood/motion` (calm = slower pushes, punchy = faster cuts) and palette. Text stays PNG layers (no drawtext), same escaping rules.
Per-product duration is a constant D = 10 s so that shot k occupies [k*D, (k+1)*D); the facts end card is the last 2.4 s of that interval. Expose `FILM_DURATION` and
`FACTS_VISIBLE_FROM = 7.6` as exported constants (the UI seeks to `k*D + 8.0` to show the facts). Render budget: aim for <= 45 s per product on this machine; report timings.
Reuse `measureProductFidelity` on the hero shot to confirm the product pixels are intact; report numbers.

## 3. Studio UI (ui worker: apps/studio/**)

- Meta Lens shows "Muse Spark identified: <subject> · <category>", palette swatches, mood/motion chips, the three plates with their purpose labels and the kinetic phrases
  (marked "decoration, not facts"). Fixture support in `?fixture=meta`.
- Red Pen reel preview: seek to `shot*FILM_DURATION + 8.0` (import the constant value 10 / 8.0 through a shared constant in apps/studio, do not import server code) when the
  film layout is in use; keep the old seek for older reels (campaign trace tells which: `reel.layout`, see below).
- The reel preview player autoplays muted loop on hover/visible with reduced-motion respected.

## Interfaces between workers
- enrichment type (node worker owns): `direction?`, `plates?: {assetId, backdrop, purpose?}[]`.
- the renderer reads enrichment via the existing loadEnrichment plumbing in server/engine.ts (minimal edit allowed to pass `direction` and plates with purposes; re-read the file first).
- render result: `renderReel` returns `layout: "film" | "scene" | "cutout" | "baseline"` per product; engine stores `generation.reelLayout` (array) in the campaign trace (renderer may edit the minimal engine lines for this).

## Ownership
node worker: server/**, packages/meta/**, packages/inference/**, tests/** except film/scene tests. renderer worker: packages/renderers/**, tests/film-*.test.ts, tests/scene-*.test.ts.
ui worker: apps/studio/**. lead: gateway/**, docs/**, scripts/**, README.md. Never read/print .env*. Never commit. Workers do not edit docs/ (report rows).
Do not start/stop servers except the UI worker (rebuild + restart Studio on 4310 with `AXYS_DATA_DIR=var/demo AXYS_STARTER_CREDITS=200 npm start` after killing only the 4310 listener; gateway on 8766 stays up).
Sample products (real Muse Image photos) for development: <local path>,sneaker,cake}.png
and older assets (cutout.png, plate.png) in <local path>
Test on at least TWO different product types so the look is not tuned to the mug. Be honest in the final report about what looks weaker than the reference (it is generative live-action; we are not).
