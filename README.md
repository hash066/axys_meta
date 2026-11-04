# Axys for Meta

A merchant gives Axys their products, photos and a voice brief. Axys builds a real website and a vertical reel from the same
confirmed facts, checks that every surface says the same thing **before** anything is published, and (with a connected
Instagram account) publishes and learns from the results. WhatsApp-first, Studio optional.

Built for the Meta Global AI Developer Hackathon. Every Meta model has a job that feeds the next:

| Meta model | Job in Axys |
|---|---|
| **Muse Voice Transcribe** | Turns the merchant's spoken brief into text (browser records 16 kHz PCM, streamed over Meta's realtime socket) |
| **SAM 3.1** | Cuts each product out of its photo; the cutout drives the reel and the site hero |
| **Muse Image** | Places the real product into a studio scene; Muse Spark then checks the product still matches the original |
| **Muse Wonder** | Plans the campaign (headline, layout, shot order) and audits all surfaces in preflight |
| **Muse Spark** | Vision judge for the studio-shot fidelity check |

## Why this and not generative video

Meta's API has no video-generation model, so Axys does not compete with Runway on generated cinematography, and does not claim to.
It guarantees what generated video cannot:

- **Your exact product.** The reel composites the SAM cutout of your real photo onto a Muse Image backdrop that has no product in it.
  The product pixels are never regenerated, so they cannot morph; compositing fidelity is measured (`measureProductFidelity`).
- **The right facts on every surface.** Preflight compares the website, reel, caption and your spoken brief against what you confirmed.
- **Say it, don't redo it.** Speak or type a change; every stale surface is marked and fixed in one press.

## The reel: a product-aware studio film

Muse Spark first identifies what the product is (category, parts, palette, mood). The reel then follows the grammar of a polished product ad using your
real product pixels: a hero shot with the product floating on a palette-tinted set, a whip-pan with real motion blur, a macro close-up, bold kinetic
type chosen for that product, a context scene, and the price-and-date card. See `docs/evidence/film-sneaker-frames.png` and `film-cake-frames.png`.
Composite products are cut out whole: Muse Spark names visible parts (raspberries on a cake) and SAM masks are merged.

## The signature moment: Say it, Red Pen, Fix

Say "make the mug one ninety nine rupees" (or edit a price after generation). Muse Wonder turns it into a strict, code-checked change
(every number must come from your words); you confirm the diff; then Axys does not just list a problem: it **red-pens your actual pages**. A
hand-drawn ellipse and strike-through appear on the wrong price in the real website preview, on the real reel frame and in the
caption, each with a handwritten note ("now INR 149.00 - regenerate"). Press **Fix with Axys**: it regenerates from your confirmed facts,
re-runs preflight, and every mark turns into a green tick in place. See `docs/evidence/redpen-live.png` and `redpen-live-fixed.png`.

## What preflight checks

Before anything can be approved, Axys's preflight compares the confirmed facts against the website text,
the reel storyboard, the caption and the spoken brief, using exact-match rules first and Muse Wonder for fuzzy claims.
A mismatch blocks approval: *expected INR 149.00, found INR 129.00* on site, reel and caption. Exact-rule findings can never be
downgraded by a model.

## Architecture

```
Studio (React)  <->  Express server (TypeScript, SQLite, FFmpeg)  <->  Muse gateway (Python/FastAPI)  <->  api.meta.ai
```

The gateway is the only process holding `MODEL_API_KEY`. If it is down or has no key, features fail with a clear message;
nothing is faked.

## Run

Requires Node 22+, Python 3.11+, FFmpeg/ffprobe.

```powershell
# 1. Python gateway (reads MODEL_API_KEY from .env here or in the parent folder)
python -m venv .venv
.venv\Scripts\pip install -r gateway\requirements.txt
.venv\Scripts\python -m uvicorn gateway.server:app --port 8766

# 2. Axys server + Studio (second terminal)
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4310/?studio=1 and use the `local-demo` development login.
`?fixture=meta` shows the Meta panels with clearly badged fixture data and no API key.

Development note: the demo workspace gets a one-time allowance of Axys product credits (a Both-mode generation costs 4). For repeated
demo runs start the server with a fresh data directory and a larger allowance, e.g. `AXYS_DATA_DIR=var/demo AXYS_STARTER_CREDITS=200 npm start`.
These are Axys's own ledger units, not Meta API credits.

Checks: `npm run typecheck && npm test` (Node, 110 tests) and `python -m pytest -q tests_py` (gateway). Live evidence:
`node scripts/live-e2e.mjs` (see `docs/EVIDENCE.md`); preflight robustness: `npm run eval:preflight`.

## Demo

`docs/evidence/demo.mp4` is a 2:46 real run of the Studio on live Meta models (also served at `/demo.mp4` and from the landing page). Timeline and narration in `docs/DEMO.md`.

## Deploy

`compose.yaml` runs the gateway, the app and Caddy (automatic HTTPS) on any small Linux server. See `docs/DEPLOY.md`; secrets via `node scripts/make-keys.mjs`.

## What was built during the hackathon, and what was not

This repository starts from **Axys**, a campaign studio built before the hackathon (Oct 19-26, 2026): campaign schema, credit
ledger, CRM, WhatsApp intake, Instagram publishing adapters, FFmpeg reel renderer and the React studio.
`docs/BASELINE.sha256` fingerprints every file exactly as copied. **`docs/META_NEW.md` lists every file added or changed for
the hackathon**: the Muse gateway, the Meta-powered planner and preflight, SAM cutout and Muse Image enrichment, voice
transcription, cutout-driven rendering and the new Studio panels. The previous NVIDIA/Nebius planner was removed.

## Honest status

- **Verified live against Meta's API:** Muse Wonder planning and preflight, SAM 3.1 segmentation of a product photo, Muse Image
  studio shot plus Spark fidelity check, and the full enrich -> generate -> preflight -> stale-price-block flow on one campaign.
- **Test photo:** the live runs used a product photo generated with Muse Image, not a real merchant's photo.
- **Red Pen verified live:** marks rendered on real server data, and "Fix with Axys" regenerated and turned all three marks green
  (screenshots in `docs/evidence/`). Preflight mutation eval: 0 false alarms on 1,111 benign variants offline; two documented misses.
- **Not verified:** voice transcription with a real microphone through the Studio, WhatsApp intake, and publishing to a
  connected Instagram account (requires Meta app credentials and a refreshed token). Nothing has been posted anywhere.
- **Product film verified live on a sneaker and a cake** (real SAM, Spark, Muse Image plates); a mug was tested earlier. Frames in `docs/evidence/`.
- **Known limits:** SAM may miss unusual or very thin products; single-node SQLite; reels are FFmpeg compositions because Meta's
  API has no video-generation model.
