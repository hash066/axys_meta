# Demo video

`docs/evidence/demo.mp4` (2:46, 1280x720, silent, about 8.9 MB). The same file is served by the landing page ("Watch the demo").

It is a real, scripted run of the landing page and the Studio against the live Meta models, not a mock-up. Nothing on screen is edited except the speed-up of the long waits
(marked "Sped up" in the captions) and the captions and title cards. Reproduce it with `scripts/record-demo.mjs` and `scripts/cut-demo.mjs`
(needs the Studio on :4310 with the `local-demo` key and the Muse gateway on :8766; costs a few cents of API credit).

| Time | What you see | What is live |
|---|---|---|
| 0:01 | Title card | |
| 0:06 | Landing hero, the problem, measured numbers | numbers are measured offline (see `docs/EVIDENCE.md`) |
| 0:17 | Replay of Say it, Red Pen, Fix; cutout slider | recorded real runs |
| 0:34 | The Bench: a tagline rejected, then accepted | **live engine** (the real phrase filter) |
| 0:46 | Studio sign-in, Brief form for a new campaign with a sneaker photo | real Studio |
| 1:16 | Meta Lens: Muse Spark identifies the product, SAM 3.1 cuts it out, Muse Image makes the backdrops | **live Meta calls** (wait sped up 12x) |
| 1:32 | Muse Wonder plans, FFmpeg renders the film | **live** (sped up 10x) |
| 1:36 | The 10-second studio film, shown large | real render of the live run |
| 1:52 | Say it: "make the sneaker price 3999 rupees" parsed, applied; Red Pen marks the stale site, reel and caption | **live** Muse Wonder + exact code checks |
| 2:19 | Fix with Axys regenerates; every mark turns green | **live** (sped up 10x) |
| 2:24 | Publish stage: posting is off; Results: no data means no model call | honest limits |
| 2:45 | Closing card | |

Not shown, because it is not verified: a real Instagram post, WhatsApp, microphone capture. The demo photo was generated with Muse Image.

## Optional narration (record your own voice over the silent video)

- 0:01 "Axys turns a product photo and one sentence into a website, a reel and a caption, then proves they all agree."
- 0:11 "Edit one price and the others go quietly stale. We measured it: 312 of 312 drifted artifacts caught, no false alarms in 1,111 harmless variants."
- 0:28 "SAM cuts out the cake, Muse Spark names the raspberries, the masks merge. The product stays your product: pixels are composited, never regenerated."
- 0:34 "These games run on the real engines. This is the same filter that guards our kinetic type."
- 0:56 "Now the real Studio. We start with facts and the merchant's own photo."
- 1:16 "Muse Spark identifies the product, SAM cuts it out, Muse Image builds backdrops. These are live calls; the wait is sped up."
- 1:36 "Muse Wonder plans, FFmpeg renders a ten-second film from the real product pixels. No actors, no stock footage."
- 1:52 "Say a change in plain words. Code checks every number against what you said. Red Pen marks every stale surface. One press fixes them."
- 2:24 "Publishing needs your own Instagram account and is off by default; we tested that path against a local fake and say so. With no data yet, the feedback loop makes no model call."
- 2:45 "Agents propose. Code decides."
