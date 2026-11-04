# Contract: reel audio, WhatsApp flow, Instagram preview and insights, dollars

The user asked for: (1) natural-sounding voice, (2) voice ingestion shown as a WhatsApp flow that continues in the Studio, (3) audio in the outcome reel,
(4) a very realistic Instagram view of the reel posted, with analytics and the feedback loop, (5) every currency changed from INR to dollars.
The WhatsApp chat, the Instagram view and the insights numbers are SAMPLE.
(the user will also label them in the submission). Never present sample numbers as real Instagram data. No real Instagram login or post is made.

## Facts about voice (verified)
- Meta's Model API has no speech synthesis or music model. Muse Voice Transcribe only transcribes. Spoken audio comes from ElevenLabs through the Muse gateway;
  the WORDS are written by Muse Wonder and validated in code. Say this honestly in docs and UI copy.
- The gateway (already built, port 8766) exposes `POST /v1/speak` `{text<=400 chars, voice:"narrator"|"merchant"|"reel"|"calm"|<voice name>, model?}` ->
  `{audio_mp3_b64, cached, credits_charged, voice_id, model}` and `GET /v1/speak/budget` -> `{tier, limit, used, remaining, ...}`. Clips are cached on disk by (voice, model, text).
- The ElevenLabs account is on the FREE tier with about 1,440 credits left (the default model costs 0.5 credit per character, so about 2,880 characters in total).
  EVERY generated line spends real, scarce credits. Never call /v1/speak in loops, retries or tests against the live gateway; tests must use the fake gateway. Keep lines short.

## Node worker (server/**, packages/**, tests/**, scripts/** for seed scripts only)

1. **Dollars.** Default currency becomes USD. `price()` in packages/campaign/index.ts formats USD as `$129.00` (EUR `€`, GBP `£`, INR keeps `INR 129.00`); preflight's parsing and
   normalisation must treat `$129.00`, `$129`, `USD 129.00`, `129 dollars` and `129.00 USD` as the same price and still flag a different number; keep all benign-variant behaviour for the other currencies. Update the
   public lab scenarios (packages/meta/lab.ts) to dollars (keep one scenario about a currency mismatch, e.g. a caption in EUR), the sample dataset, fake gateway defaults and all affected tests.
   Dates in lab scenarios and docs examples become US style (e.g. `Saturday, Nov 7, 10am to 4pm ET`). Do not change historical evidence files in docs/evidence.
2. **Reel narration (audio in the outcome reel).** After the film renders, add audio: (a) Muse Wonder writes ONE narration of at most 28 words from the confirmed facts and the product direction
   (business, product, the price and the collection date and time each appear correctly; a call to action; no superlatives, claims, guarantees, discounts or numbers that are not in the facts);
   (b) code validates it with the same grounding style as packages/meta/command.ts and feedback.ts (every number and date must match the facts; reject claim words; fall back to a deterministic
   template if Wonder fails or violates a rule); (c) `POST /v1/speak` voice `reel` speaks it; (d) a soft music bed is synthesised locally with ffmpeg (no cost: layered filtered sine pads or noise, about 10 s, fade in and out);
   (e) mix with ducking under the voice and mux into the final mp4 as AAC stereo, keeping the video stream untouched. If the gateway voice call fails or credits are short, the reel is delivered with the bed only (or silent) and a warning is recorded; never fail the whole generation.
   Store `generation.narration = {text, voice, model, credits, cached, source:"wonder"|"template"}` in the campaign trace; accept `{audio:false}` in the generate body to skip. Include the narration text in the preflight as a surface
   so a spoken price that does not match the confirmed price BLOCKS approval (exact rules, same as the other surfaces); add Red Pen locate data as `null` for it. Tests with the fake gateway (add `/v1/speak` support to tests/fake-gateway.ts returning a tiny valid mp3 or wav).
3. **Sample insights (demo-gated).** Only when `AXYS_DEMO_SAMPLES=true`: `POST /api/v1/campaigns/:id/metrics/sample` with `{preset:"reel-week-1"}` stores a metrics record flagged `sample:true` with source
   `"Sample data (not Instagram)"`, plus a 7-day series. Realistic and internally consistent numbers for a 10 s reel (plays about 18,420; reach about 12,960; likes 1,184; comments 62; saves 341; shares 97; profile visits 428; follows 56; average watch time 6.4 s;
   a retention curve that falls from 100% at 0 s to about 46% at 10 s; audience split by age and by country with plausible percentages that sum to 100; website visits 58 and contact clicks 3). Metric names must match `^[a-z][a-z_]*$` for the feedback normaliser.
   `GET .../metrics` returns it with `sample:true`; `POST .../revision` runs the REAL grounded feedback planner on it (packages/meta/feedback.ts) and the trace gets `sampleData:true`; the proposal must still quote real (sample) numbers.
   Without the env flag the route answers 404. Never touch real Instagram metrics storage semantics.
4. **WhatsApp draft seeding.** Read server/whatsapp.ts and the draft import route (`/api/v1/intake/whatsapp-drafts*`). Provide `scripts/seed-whatsapp-draft.mts` (run with tsx) that creates, in a given data dir and tenant (default `local-demo`),
   a WhatsApp-style draft the Studio's existing "Continue a WhatsApp draft" flow can import: the merchant photo (path argument), the transcript text (argument or file), source `whatsapp`, so that importing pre-fills the Brief (business, offer, collection,
   contact, products) from a structured extraction of the transcript done by the existing intake logic or a documented deterministic extraction. If the existing flow cannot do this without the WhatsApp bridge, implement the smallest honest alternative and document it.
5. Keep all existing tests passing (`npm run typecheck && npm test`, about 2 minutes) and add tests for everything above. Report exact JSON shapes and test counts.

## UI worker (apps/studio/** only)

1. **Dollars.** Default currency USD in the Brief form and anywhere a default exists; landing page, Bench games, fixtures and copy: INR becomes dollars, dates US style. Recorded-media captions that quote INR from past runs
   (replay, evidence strips) must be updated to dollar equivalents ONLY if the underlying media is re-generated later by the lead; for now change text and mark TODO-regenerate in a code comment where an image or video still shows INR (list them in your report).
2. **WhatsApp flow demo** at `?sim=whatsapp` (public, no auth): a very realistic WhatsApp chat screen (phone-style frame or full-page, green header with contact "Axys Assistant", wallpaper, date chip, bubbles with tails and timestamps, double blue ticks, typing indicator, voice-note bubble with a waveform
   and a play button that actually plays `/demo/voice-note.mp3` and scrubs, image bubble with the product photo `/demo/product.jpg`, quick-reply buttons, link preview card "Open in Studio"). Scripted timeline (auto-plays after a short delay, with a Replay button and `?sim=whatsapp&speed=1`):
   merchant sends the product photo, then the voice note (transcript revealed under it as "Transcribed with Muse Voice" using `/demo/voice-note.json` -> `{text, durationSec}`), the Axys assistant replies with the extracted facts as a checklist (business, product, price, collection time, contact) and asks "Confirm these facts?", merchant taps Confirm,
   In the Studio, `?studio=1&draft=whatsapp` should land the user on the existing "Continue a WhatsApp draft" import if a draft exists (do not change the import logic itself).
3. **Instagram preview** (Publish stage and Results): a pixel-faithful phone preview of an Instagram Reel as it would appear for the connected or typed handle: top status bar, reel video (the real reel, with a mute/unmute button; audio now exists), right-hand action rail (like, comment, share, save, more), bottom: avatar ring, `@handle` with Follow button, caption with "more", audio row ("Original audio" and the handle), plus a profile-grid view tab showing the reel thumbnail as the newest post.
   Handle input "Preview as @" defaults to the saved value (localStorage) or `your_brand`; the demo uses `snifthathash`. A visible, tasteful tag "Preview, not posted" is part of the component. No real login and no network call to Instagram.
4. **Insights dashboard** (Results stage): KPI cards (plays, reach, likes, comments, saves, shares, profile visits, follows, average watch time), a 7-day line chart in SVG, a retention curve, audience bars, the website visits and contact clicks, and a "What Axys learned" card showing the real grounded revision proposal from `POST /api/v1/campaigns/:id/revision` (suggestion, the observed numbers it quoted highlighted, and the "grounded" and "sample data" tags).
   When the metrics record has `sample:true`, show a loud but elegant "SAMPLE DATA, not from Instagram" ribbon on every card group. With real Instagram metrics the same cards show real values without the ribbon. A "Load sample insights" button (visible only when the server reports demo samples are enabled via GET /api/v1/capabilities `demoSamples:true`; the node worker adds that flag) calls the sample route.
5. **Reel audio in the Studio**: the Final reel player gets a clear unmute control (reels autoplay muted), and a small "Narration written by Muse Wonder, voiced by ElevenLabs" line reading `generation.narration` when present.
6. Keep every existing behaviour; mobile 390 px; accessibility (captions for the voice note via the transcript, aria-live, keyboard, reduced motion). Headless Edge screenshots at 1440 and 390 of every new screen, LOOK at them and iterate. `npm run typecheck` green.

## Ownership and rules
- Node worker: server/**, packages/**, tests/**, scripts/seed-whatsapp-draft.mts. UI worker: apps/studio/** only. Lead: gateway/**, docs/**, other scripts/**, public assets under apps/studio/public/demo/, README, recordings.
- Never read or print .env* files. Never commit. Never call the live `/v1/speak` yourselves (credits are scarce); the lead generates the real audio files. Never start servers except: the UI worker may rebuild and restart the Studio
  (kill only the listener on 4310, then `AXYS_DATA_DIR=var/demo AXYS_STARTER_CREDITS=400 AXYS_DEMO_SAMPLES=true npm start` in the background); the gateway on 8766 must stay up.
- Screenshots: headless Edge with Playwright like scripts/screenshot-redpen.mjs; write scripts into the scratchpad directory `C:/Users/asus/AppData/Local/Temp/claude/e74d84b441f26777/9b6ee208-6270-487b-8f41-fd8b563a9c05/scratchpad/`, not the repo.
