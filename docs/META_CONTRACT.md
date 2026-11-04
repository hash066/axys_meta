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
