# What is new in this fork (Meta Model API hackathon)

Pre-hackathon Axys code is fingerprinted in `docs/BASELINE.sha256`
(`sha256sum -c docs/BASELINE.sha256` lists every file that changed or was
removed since the Oct 19-26 build). This page lists the Node-side work.
Studio UI files (`apps/studio/**`) and the Python gateway (`gateway/**`) are
listed by their owners.

Nothing here has been run against the live Meta API. Every test uses a local
fake gateway (`tests/fake-gateway.ts`) on a random port.

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
