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

## The idea worth seeing: preflight

Edit a price after the site and reel were generated. Axys's preflight compares the confirmed facts against the website text,
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

Checks: `npm run typecheck && npm test` (Node) and `python -m pytest -q tests_py` (gateway).

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
- **Not verified:** voice transcription with a real microphone through the Studio, WhatsApp intake, and publishing to a
  connected Instagram account (requires Meta app credentials and a refreshed token). Nothing has been posted anywhere.
- **Known limits:** SAM may miss unusual or very thin products; single-node SQLite; reels are FFmpeg compositions because Meta's
  API has no video-generation model.
