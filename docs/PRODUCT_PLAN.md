# AXYS / AXCAS

Full product rebuild | Website + reels + connected Instagram | 19 October 2026

## The product in one sentence

A merchant gives Axys their products, photos and a voice brief; Axys builds a real website, creates a matching reel, publishes through a connected Instagram account, and uses actual performance data to propose the next campaign.

## The scope you asked for

Axys is the name used in this plan for a fresh implementation of Axcas. Website rendering, reel creation, Instagram OAuth, real publishing and feedback are all core. This supersedes the previous plan that narrowed the product to updates and approvals. The scratch rebuild removes any assumed time advantage from reusing the old application.

## The strongest version

One campaign is a shared, versioned object across the website and Instagram. Changing an offer updates the draft page, reel script, caption and destination together. The merchant sees the differences, approves the exact outputs, and receives the actual site URL and Instagram permalink. This makes the product more coherent than a disconnected website generator plus caption tool.

## My honest assessment

Axys has the clearer path to early merchant revenue, but it enters crowded categories. A beautiful generated site alone will not distinguish it. The competitive demo is the entire operational loop with a real merchant, a real post, a real failure handled correctly and measurable time saved. Meta access is a critical dependency, not a final-day integration.

## How to use this document

Pages 2-5 define the experience and integrations; 6-8 cover engineering and proof; 9-10 cover execution and economics; 11 compares Morph; 12 lists primary sources. All numerical performance and pricing goals below are proposed experiments, not results already achieved.

# 01 / The complete experience

Start with one merchant niche; preserve the full product loop.

## A concrete first customer

Use a home bakery or small food business with an existing professional Instagram account. The merchant supplies six product photos, prices, collection times and a voice note about a weekend offer. Do not invent inventory, discounts, dietary claims, testimonials or delivery promises.

## Step 1: connect and understand

The onboarding screen shows business identity, media ownership, website destination and Instagram connection status. Voice input is transcribed, then Nemotron produces a structured business profile and asks only for missing essentials. The merchant can correct the transcript and product facts before anything is generated.

## Step 2: create both surfaces

The studio has Website and Reel tabs sharing the same campaign. The site includes hero, product collection, offer details, contact action and business information. The reel uses the same products, price and offer window. Users can change layout, copy, shot order, voice and caption without starting again.

## Step 3: approve and publish

A side-by-side preview shows desktop/mobile site and vertical video. The publish panel names the Instagram account, campaign destination and schedule. Website and Instagram are separate external actions with separate receipts. A successful website deployment must not conceal a failed reel upload.

## Step 4: observe and improve

The dashboard displays real, time-stamped Instagram insights where available, plus website visits and contact-button events. Nemotron proposes one revision grounded in those observations. The merchant approves a new version; the system does not silently replace a public offer or publish another post.

## The memorable demo moment

Ask the merchant to change the price and collection time. Show every draft surface update coherently, then reveal a deliberately injected stale-price mismatch being caught before publication. This is useful operational intelligence, rather than an animation of agents talking.

# 02 / NVIDIA and Nebius architecture

Make the sponsor stack responsible for the core decisions and expensive work.

## The runtime flow

Browser / optional WhatsApp intake -> authenticated API -> campaign database and asset store -> Nemotron on Nebius Token Factory -> typed website and reel specifications -> render / verify jobs -> merchant approval -> website host and Instagram API -> metrics collector -> next proposal.

## Required: Nemotron through Token Factory

Use an available NVIDIA Nemotron model for brief interpretation, campaign planning, tool selection, copy and revision reasoning. Query the account model catalog on day one and pin the exact model ID and configuration. Use a smaller available variant for extraction and a stronger variant for ambiguous planning; do not promise Ultra availability solely because the track mentions it. Record request IDs, latency, tokens and cost for the demo.

## Useful additional NVIDIA models

For voice, evaluate NVIDIA Parakeet/Canary ASR and Magpie TTS through supported NVIDIA speech deployments on Nebius GPU compute. Validate the actual language and voice before committing. These are separate deployments unless your endpoint explicitly exposes them; Token Factory text access does not imply speech access. Check model and NIM deployment licenses separately. Text input and merchant-recorded audio remain usable fallbacks.

## Nebius compute with a real purpose

Run rendering, browser verification and batch analytics as asynchronous jobs where supported. CPU tasks do not need GPUs merely to inflate platform usage. Self-host speech on a suitable Nebius GPU instance or endpoint after a compatibility test. Use durable storage for assets and receipts; jobs must survive retries without relying on local ephemeral files.

## Do not pad the architecture

GROOT and Cosmos are unnecessary for merchant websites and reels. Do not add robotics or synthetic video just to collect NVIDIA logos. The meaningful technical evidence is a multi-step Nemotron workflow, working model deployment, consistent outputs and measured latency/cost. NVIDIA use should remain visible in tracing and documentation.

# 03 / Website and reel studio

A fresh implementation with controlled, editable outputs.

## Website rendering

Nemotron generates a validated SiteSpec, not arbitrary executable code. Support three polished layout families and composable sections. Store product IDs, prices, offer dates, media references, layout tokens and contact destinations as typed fields. Render with a deterministic React component library. Provide desktop and mobile preview, section ordering, copy editing and publishable URLs.

## Website verification

Run browser checks at mobile and desktop widths. Verify product and price consistency, image loading, navigation, contact actions, readable contrast and absence of horizontal overflow. A screenshot is evidence of appearance; it does not prove buttons work. Check links and interactions separately. Preserve the prior published version so a bad revision can be rolled back.

## Reel rendering

Nemotron creates a storyboard with shot durations, product references, caption and voice script. A template engine such as Remotion/FFmpeg composes merchant images or clips, camera movement, typography, subtitles and permitted audio. Start with two high-quality visual styles. NVIDIA speech can narrate; the renderer determines timing. Preview the actual final encoded file, not an approximation.

## Media acceptance

Use a vertical target such as 1080 x 1920, then validate codec, duration, file size and other constraints against the current Instagram API before upload. Keep text inside conservative safe margins. Use owned or licensed music and assets; do not imply access to Instagram licensed music through the publishing API. Do not synthesize misleading product appearances.

## One source of truth

Campaign facts populate both outputs. A deterministic validator compares structured prices, dates and product IDs. Nemotron reviews meaning and tone, but an LLM is not the only factual gate. Approval stores the website specification hash, rendered-video hash, caption, destination account and publish time. Any relevant edit invalidates approval.

## Keep the experience simple

Use five visible stages: Brief, Create, Review, Publish, Results. Put job logs behind an optional details panel. Merchants should see a helpful explanation and repair action when something fails, not infrastructure terminology.

# 04 / The real Instagram connection

The first engineering milestone is a real authorized publication.

## Choose one authentication route

Use the official Instagram API for a supported professional account. Prefer the Instagram Login route if it supports the required capabilities for your app; confirm permissions and account eligibility in the current developer console. The Facebook Login route has different permissions and a linked-Page requirement. Do not mix credentials, account IDs or scopes between the two paths. Consumer accounts are not the target.

## Day-one proof

Create the Meta app, configure HTTPS OAuth callbacks and privacy/deletion endpoints, connect an eligible account that you are authorized to use, and publish one simple test reel through the backend. Then fetch its media ID/permalink and at least one supported insight. This test must happen before polishing the AI studio.

## Real access versus general availability

Development-mode testing with eligible app roles is different from onboarding arbitrary merchants. App review, advanced access and business verification may be needed for the intended permissions and customer population. Record exactly which mode the demo uses. Do not promise review approval within eleven days. Customers must never be asked for their Instagram passwords.

## Publish sequence

Create the media container with the approved reel and caption; make the asset reachable by Meta for ingestion; poll processing status; publish the finished container; reconcile and store the resulting media ID; retrieve the permalink. Only then label the post Published. Keep the asset accessible for processing, but avoid exposing unrelated private assets.

## Failure behavior

Expired consent -> reconnect. Processing error -> show actionable status. Publish timeout -> reconcile the existing container/media before retrying. Duplicate button presses -> one idempotent command. Revoked token -> cancel pending work. Rate limits -> backoff and display next retry. Never substitute a video download and call that a completed Instagram integration.

## Analytics and linking caveat

Query only metrics supported by the selected API version and permissions. Missing data is Unknown, not zero. Do not assume URLs in reel captions are clickable or that your API can change the profile bio. Have the merchant configure the campaign link when required; explain the attribution limits in Results.

# 05 / Engineering contract

A small number of durable objects makes a complicated workflow understandable.

## Data model

Tenant, MerchantProfile, Product, Asset, Campaign, SiteVersion, ReelVersion, Connection, Approval, PublishAttempt and MetricSnapshot. Every object has a tenant ID. Each version retains its inputs, model/configuration, schema version and artifact hashes. PublishAttempt holds provider IDs and the last confirmed external state.

## Command boundaries

POST campaign -> create draft. POST generate -> enqueue model/render jobs. POST approve -> bind exact hashes and target. POST publish -> create idempotent publication command. GET status -> return independent website and social states. POST disconnect -> revoke local access and cancel queued work. The model can propose commands; the backend enforces permissions.

## State machine

Draft -> Generating -> NeedsReview -> Approved -> Publishing -> Published or PartialFailure. Internally, each channel has its own state machine. Editing an approved artifact returns it to NeedsReview. A schedule fires only if approval, connection and offer validity still hold. Reconciliation jobs recover interrupted attempts.

## Security that fits the actual product

Keep OAuth tokens encrypted server-side with a key-management service, redact them from logs, verify OAuth state and webhook signatures, and isolate tenant storage and queries. Restrict render-worker network access, validate fetched media URLs, block private network destinations and constrain file sizes. Treat merchant captions, uploaded documents and external pages as untrusted input, never tool instructions.

## Operational reliability

Use a durable database and queue/outbox so external actions survive restarts. Set bounded retries, dead-letter failed jobs and expose support-friendly receipts. Log provider errors without secrets. Support deletion and token disconnect. Test two merchants in parallel to catch cross-account asset or publishing mistakes.

## Definition of complete

A new merchant can connect, create both outputs, revise, approve and actually publish; the system shows confirmed URLs, handles one induced failure and later retrieves actual metrics. A working happy-path screen recording without recoverable backend state is insufficient.

# 06 / Tests with actual merchants

Prove usability and functionality; do not pretend a small pilot proves revenue lift.

## Recruitment target, not an achieved result

Aim for five merchants in one niche, including at least two authorized professional accounts that can publish. Recruit immediately and obtain consent for account actions, media use and recording. Keep app-role test accounts separate from evidence of general customer onboarding. Use anonymized participant IDs unless a merchant agrees to be named.

## Session protocol

Ask each participant to launch one real offer: supply assets, correct facts, create a site and reel, connect an account, revise a detail and approve publication. Let them attempt the workflow without coaching, then record where help was required. Conduct a second session for the results screen and next campaign. Publishing is optional for participants who do not consent, and counts separately.

## Metrics to collect

Record task completion n/N, unassisted completion n/N, time from complete inputs to approved outputs, human corrections, factual mismatches, render failures, publish success, duplicate posts, cost per campaign and willingness to pay. Report medians and ranges alongside sample sizes. A target is four of five unassisted completions and zero incorrect public prices; these are acceptance goals, not promises.

## A useful comparison

Time the same merchant preparing a similar offer with their usual tools. Counterbalance which workflow they use first where practical. A five-person comparison is directional; task differences and learning effects remain. Report observed minutes saved, not an unsupported percentage increase in sales.

## Reliability suite

Prepare 20 varied input cases, including missing prices, conflicting dates, duplicate publish requests, expired tokens, worker restart, unavailable image and a cross-tenant access attempt. Test deterministic constraints independently of model judgment. Separate fixture-based tests from real provider calls in the evidence report.

## Evidence wording for the demo

Use a statement such as: "Five merchants attempted the workflow; four completed unaided; two consented to real publication." Replace these illustrative numbers with actual results. Show dates and anonymized receipts. Website visits, contact clicks and Instagram views are different metrics; none alone establishes a sale.

# 07 / Eleven-day delivery plan

Parallel workstreams, with dependencies settled before visual polish.

## 19-20 October: remove external uncertainty

Owner A proves Instagram connection, publishing and insights. Owner B runs Nemotron through the actual Nebius account and pins model IDs. Owner C builds the campaign schema and minimal website renderer. Owner D recruits merchants and establishes visual design. Gate: one genuine reel published, one page deployed, and one traced model run. If Meta is blocked, Axys is not on track for this full scope.

## 21-22 October: connect the full path

Build the studio, two reel templates, asset ingestion, approval hashes and durable jobs. Deploy one campaign end to end. Add speech only after a working deployment test. The complete website and Instagram loop takes priority over extra themes or languages.

## 23-25 October: publish the pilot early

Run merchant sessions and publish consented campaigns so insights have time to arrive. Add real metrics retrieval, failure reconciliation and revision suggestions. Fix the most common usability problems. Keep a record of actual model calls, costs and production IDs for the evidence bundle.

## 26-27 October: demonstrate reliability

Run the adversarial-input and retry suite, check tenant isolation, collect follow-up feedback and measure the same outputs with a simpler single-prompt baseline. Freeze feature scope. Decide which evidence can honestly be claimed.

## 28-30 October: package and submit

Record a sub-three-minute demo, publish the licensed repository and reproducible setup, provide a working deployment and documented demo access. Explain the relationship to earlier Axcas work and exactly what was built during the hackathon. Submit ahead of 30 October, 10:00am PDT / 10:30pm IST. Keep a working demo available throughout judging.

## What is deliberately deferred

Paid ads, payments, multi-network publishing, arbitrary site code generation and autonomous promotional experiments. These are not required to preserve website rendering, reels, connected Instagram and the feedback loop. If there is spare time, improve verified reliability before adding channels.

# 08 / The demo judges should see

A proposed 2 minute 50 second story with real external evidence.

## 0:00-0:20 | The merchant problem

Introduce one consenting merchant and their actual offer. Show the assets and voice brief. State the exact job: turn this offer into a live page and Instagram reel, then learn from results. Avoid leading with a stack diagram.

## 0:20-0:55 | Creation

Show the Nemotron-produced campaign and generated website and reel. Make one change to price or timing and show both previews update. Display a small live trace indicating the NVIDIA model and Nebius execution; keep implementation detail secondary to the product.

## 0:55-1:30 | Real action

Show the connected account, approval and publication receipt, then open the deployed page and Instagram permalink. Long processing can be compressed with a clearly labeled time jump. Do not disguise prerecorded output as a live response.

## 1:30-2:00 | Reliability

Show a stale-price check blocking a publication or a retry recovering without a duplicate. The message should be understandable to the merchant. This proves the workflow handles more than ideal prompts.

## 2:00-2:30 | Results

Show earlier real pilot metrics with timestamps and sample size, then a suggested next campaign grounded in those numbers. Present user-study outcomes and time/cost measurements. Clearly label missing or delayed insights.

## 2:30-2:50 | Why it matters

Explain the wedge: small merchants who need a coherent campaign without assembling several tools. Close with a real participant quote used with permission, one measured outcome and the working application link.

## Alignment with judging

The official rubric weights implementation, design, impact and idea equally. Implementation: traced end-to-end behavior and failure recovery. Design: merchants can complete tasks. Impact: observed time saved and repeat usage. Idea: one consistent campaign across creation, action and measurement. More model names are not an extra scoring category. [1,2]

# 09 / A business, not just a submission

Sell repeated campaign completion, then measure retention.

## Competition is real

Shopify already offers AI store creation, and Buffer already supports Instagram planning and publishing. These are overlapping capabilities, not proof that the exact Axys experience exists everywhere. Your differentiation must be a simpler end-to-end job for a defined niche, with consistent facts and less manual coordination. Do not pitch website generation or scheduling alone as novel. [7,8]

## Initial buyer and offer

Target owner-operated businesses that publish offers weekly and already accept enquiries through contact channels. Start with a hands-on paid pilot covering website, four campaign packages and a results review. Avoid merchants who need complex inventory, regulated claims or custom checkout integrations in the first cohort.

## Pricing experiments

Test $29, $59 and $99 monthly packages with explicit usage limits; these are hypotheses, not market-validated prices. Ask for a paid second month rather than relying on enthusiastic feedback. Track repeat campaign creation, subscriber retention and support time. Distribution may get signups; repeated value must keep them.

## Unit economics

Contribution per customer = subscription revenue minus model inference, speech, rendering, storage, delivery, hosting, payment fees and variable support. Meter each campaign. Limit free regenerations, cache unchanged assets and batch non-urgent analysis. Do not assume credits remain after the hackathon. Put an account-level spend cap and idle GPU shutdown in the first deployment.

## The million-dollar arithmetic

At $59/month, 1,413 paying customers generate about $1.00M annual recurring revenue before churn, costs and taxes. That is a scaling scenario, not a forecast or personal wealth outcome. Acquisition value depends on retention, margins, growth and buyer demand; a hackathon win does not establish those.

## 30 days after submission

Run ten paying pilots, observe a second campaign cycle, measure support burden and identify the highest-retention niche. If customers only want a one-time website, price that honestly or find a recurring problem. Do not hide a low-retention service behind a SaaS label.

# 10 / Axys versus Morph

The recommendation changes only when the evidence changes.

## Axys advantages

More accessible merchant testing, familiar software engineering and an earlier route to small paid pilots. It can score well on design and impact if the full real workflow is dependable. Starting from scratch still creates meaningful schedule pressure; this plan does not assume the old implementation works.

## Axys disadvantages

Crowded product category; real Meta access can block the core flow; a huge interface without evidence will look ordinary. The strongest technical feature is coordinated, verified execution, which takes effort to explain visually.

## Morph advantages

A robot failing under a changed condition and recovering through measured simulation experiments makes a stronger technical demonstration. NVIDIA robotics tools and Nebius GPU jobs have an intrinsic purpose. A credible before/after with held-out tests could make Morph more distinctive.

## Morph disadvantages

An existing tutorial plus an LLM dashboard is weak novelty. Recovery may not beat simple search, hardware may not match the simulator, and a startup buyer may have a long procurement cycle. Robot access alone does not solve these problems.

## My call as of 19 October

For grand-prize ambition, I would give Morph the first 48-hour feasibility test because you prioritize technical distinction and sponsor fit. Choose it only if the supported simulation works and an initial recovery experiment shows useful signal beyond a trivial baseline. Otherwise choose Axys, provided the real Instagram gate has passed. For the fastest revenue experiment, Axys is the stronger choice.

## Do not split the submission effort

Run only small feasibility spikes for both, then commit the team to one by 21 October. A full Axys product plus an unfinished robot demo weakens both. There is no evidence-based way to assign a winning probability from concept descriptions or predict a judge's private preferences.

# 11 / Sources and assumptions

Primary sources checked 19 October 2026; implementation choices are proposals.

## [1] Official rules

https://nebiusglobalaihackathon.devpost.com/rules

## [2] Organizer judging guidance

https://nebiusglobalaihackathon.devpost.com/updates/46204-here-s-how-judging-works

## [3] Meta official API collection

https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api

## [4] Nebius model access and compute examples

https://github.com/nebius/nebius-physical-ai/blob/main/docs/workbench/token-factory.md
https://github.com/nebius/nebius-physical-ai/blob/main/docs/workbench/cookbooks/tokenfactory-compute-combos.md

## [5] NVIDIA speech serving

https://docs.nvidia.com/nim/speech/latest/about/how-it-works.html

## [6] NVIDIA speech model checkpoints

https://docs.nvidia.com/nemo/speech/nightly/asr/asr_checkpoints.html

## [7] Shopify AI store builder

https://www.shopify.com/tools/ai-store-builder

## [8] Buffer Instagram capabilities

https://support.buffer.com/en-us/articles/using-instagram-with-buffer-YSjg2dXFV8

## Verification limits

Meta developer documentation was not retrievable through the research browser for every route. Exact permissions, app-review requirements and media constraints must therefore be checked in the current Meta console before coding. Model access, GPU quota, serverless compatibility, pricing and participant availability are unverified until tested in your accounts. No pilots or performance results are claimed in this plan.
