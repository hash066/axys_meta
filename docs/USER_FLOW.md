# Axys merchant user flow

## Product stance

Axys serves **merchants and MSMEs**. Their shoppers are the visitors to the campaign websites Axys creates. The public Axys entry page therefore has two clear paths: **Start with WhatsApp** for the default conversational workflow, and **Open Studio** for merchants who prefer a visual workspace. Both paths resolve to the same workspace, credit balance, campaign drafts and publication history.

WhatsApp is the primary merchant interface. A merchant should be able to describe a sale, send owned photos or a voice note, review a private result, approve an exact action, and receive results without learning campaign software.

Axys Studio is an optional transparent control panel for people who want a larger preview, precise editing, account connection, history, or recovery controls. Opening Studio must preserve the same workspace, draft, media and campaign revision. The merchant never has to copy the brief from one interface to the other.

Axys separates four events that can look similar but have different consequences:

1. **Confirm facts** says the business facts are accurate.
2. **Approve an artifact** accepts the exact website, reel, caption, account and schedule shown.
3. **Publish** executes only that approval.
4. **Approve learning** accepts a proposed next revision after results arrive.

No general message such as “go ahead” authorizes future posts, a changed artifact, a different account, or a new experiment.

## Public entry, credits and hosted address

1. A merchant visits the permanent Axys URL and sees what Axys creates, what one generation costs in Axys credits, and which provider connections are ready.
2. The merchant starts in WhatsApp or signs into Studio. WhatsApp opens the registered Axys Business number with a short prefilled introduction; it does not create a second account.
3. The workspace receives an idempotent starter-credit grant only when the configured onboarding policy permits it. Website generation costs 1 credit, a reel costs 3, and both cost 4. Credits are Axys product units, not dollars or a claim about provider cost. A failed generation is refunded once.
4. Each approved website is published beneath the permanent Axys origin first. A platform-owned subdomain and customer-owned vanity domain are later routing choices over the same immutable site version.
5. Buying or topping up credits is unavailable until a real payment provider, price, tax treatment and refund policy are configured. The interface must never imply a successful purchase before that exists.

The first public release may use `project.pages.dev` for the Axys shell and `/sites/<opaque-id>` for campaign pages. Branded merchant subdomains require a domain controlled by Axys. Customer-owned domains require domain verification and Cloudflare custom-hostname routing. None of these addresses may depend on a merchant laptop or development tunnel.

## Identity and workspace mapping

The authenticated WhatsApp sender maps to one Axys workspace. The gateway supplies the sender identity; the agent and merchant cannot choose a tenant ID in a prompt. Raw phone numbers are not shown in Studio records or model context.

A new sender follows this sequence:

1. Axys recognizes an existing sender-to-workspace link or begins a controlled linking flow.
2. The merchant sees the business/workspace name before adding content.
3. If the number could represent more than one business, Axys asks which already authorized workspace to open. It does not merge workspaces.
4. Studio opens through a short-lived, single-workspace link or normal workspace sign-in. A link never grants access to another sender's drafts or assets.
5. A changed or shared phone number requires re-verification. Staff access is explicit, named and revocable.

An unknown sender may create an unconfirmed onboarding draft, but cannot view another workspace, connect Instagram, approve publication, or retrieve private media. Duplicate webhook delivery reuses the original intake record.

## End-to-end merchant journey

### 1. Onboarding in WhatsApp

Axys introduces itself in one short message and asks for a natural bundle:

> Tell me your business name, what you want to promote, area or collection details, price if relevant, how customers should contact you, and whether you want a website, a reel, or both. Send your own photos or a voice note if that is easier.

The merchant does not choose a technical template or complete a field-by-field interview. Axys infers presentation choices only when they do not change facts. It asks at most one consolidated follow-up listing all facts still required for a publishable campaign.

Returning merchants start from their workspace memory but see the reused facts in the confirmation summary. Old prices, availability and offer dates are never silently carried into a new sale.

### 2. Build the sale or campaign brief

Text messages, photo captions and consecutive messages accumulate in one sender-bound draft.

- **Text:** Preserve the merchant's words, currency and dates. Instructions embedded in merchant content remain data and cannot grant tools or publication authority.
- **Photos:** Store the Meta media reference first, then retrieve and validate the bytes through the private media worker. Record ownership/use confirmation. Unsupported or failed media stays visibly unresolved.
- **Voice:** Preserve the voice note as private media. When an approved speech service and language are available, show the transcript and confidence-sensitive uncertainties. Otherwise ask for a short text summary or let the merchant type/edit the transcript in Studio.
- **Video or document:** Retain the reference and caption, explain whether the current renderer can use it, and never imply successful ingestion when only metadata was received.

Axys sends one receipt after the useful bundle, not a message for every internal step. The receipt says what was saved, which media is still processing, and any single combined question that blocks a factual preview.

### 3. Confirm facts

Before generation, Axys presents a compact fact card:

- business and offer;
- products or services, exact prices and currency;
- area, collection/delivery terms and offer expiry;
- customer contact destination;
- selected owned media;
- Website, Reels, or Both.

The merchant chooses **Confirm facts** or **Edit**. A fact correction creates a new draft revision and invalidates any older confirmation. Optional marketing phrasing is clearly separated from factual claims.

The preferred WhatsApp flow uses a sender-bound signed confirmation control. Studio provides the same fact card, field-level editing and media thumbnails for merchants who want detail. Until native WhatsApp confirmation controls are live-verified, Studio confirmation is the safe operational handoff; Axys must say this plainly rather than treating free-form chat as a signed confirmation.

### 4. Generate and review private previews

Confirmed facts produce typed website and reel specifications. The website and reel share product IDs, prices, offer terms and contact destination. A deterministic check rejects mismatches before preview.

WhatsApp receives a concise summary plus:

- a private, expiring website preview link;
- a private reel preview with poster, duration and caption;
- a short list of checks completed;
- **Edit** and **Approve this version** actions.

Studio shows the same revision in desktop and mobile website views, a playable reel, caption, account destination, schedule and artifact status. Merchants may change copy, layout, shot order or media there. Any material edit creates a new revision and removes the prior approval.

Generation is not publication. A rendered MP4, local URL, upload receipt or provider container is never described as a live post.

### 5. Explicit approval and execution

The approval card identifies:

- campaign revision;
- website preview and reel;
- caption;
- Instagram account;
- immediate or scheduled time;
- offer expiry;
- the exact actions that will run.

The merchant can approve Website only, Instagram only, or Both when the product offers those scopes. Approval binds the exact artifact hashes, destination and time. A second tap is idempotent. Changed media, facts, caption, destination, schedule or expired consent requires a new approval.

Website and Instagram execute independently so one failure does not hide the other's receipt. Axys reports **Published** only with a confirmed hosted URL or Instagram media ID/permalink. An uncertain Instagram response becomes **Needs attention/Unknown** and triggers reconciliation of the existing request; Axys does not create a duplicate post.

### 6. Hosted customer journey

The hosted campaign page is fast, mobile-first and contains the confirmed offer, products, terms, business information and one clear contact action. The contact action opens the merchant-approved channel, normally WhatsApp, with a campaign-aware prefilled message.

The customer journey is:

1. Customer visits the campaign URL.
2. Axys records a privacy-minimized visit event.
3. Customer selects the contact/order action.
4. The customer sees what information will be sent and chooses to continue.
5. The message reaches the merchant's business channel with the campaign reference.
6. The merchant or an authorized staff member qualifies the request and records its outcome.

A visit is not a lead, a contact click is not an order, and an order is not revenue until the merchant marks the commercial outcome. Axys does not take payments in this flow.

### 7. Leads, orders and lightweight CRM

Axys creates a lead only from an inbound customer message or an explicit merchant entry. Each record includes source campaign, timestamp, contact permission, current owner and a simple status:

**New → Replied → Qualified → Ordered → Fulfilled**

**Not interested**, **Spam**, and **Do not contact** are terminal alternatives. A do-not-contact instruction immediately blocks promotional follow-up.

WhatsApp gives the merchant compact actions such as **Mark replied**, **Mark ordered** and **Do not contact**. Studio offers the searchable list, notes, assignment, duplicate review and campaign attribution. Sensitive customer data stays out of model prompts unless it is required for the merchant-authorized task. CRM exports and outreach require a separate explicit scope.

### 8. Instagram trial and main reel experiment

The first approved reel is a trial that proves the connected account, render constraints, publication receipt and metric availability. The merchant sees the exact account and can keep the trial private by stopping at preview.

After a successful trial, Axys may propose a main experiment of up to three merchant-approved variants. Variants share the confirmed offer and change one declared element, such as hook, cover or call to action. The proposal states:

- the hypothesis;
- the one variable changing;
- all three previews and captions;
- schedule and account;
- success metric and observation windows;
- any attribution limitation.

One signed campaign approval may cover only those immutable variants and schedules. Editing one variant invalidates that approval. Axys never adds a fourth post, substitutes media, or starts a new experiment from a broad standing instruction.

### 9. Metrics and merchant-approved learning

Results separate website visits, contact actions, leads, orders and Instagram metrics. Every number includes its denominator, source and observation window. Missing or delayed provider data is **Unknown**, not zero.

Axys compares the trial or variants at agreed checkpoints, for example 2, 24 and 72 hours, only when supported by the provider and the sample is meaningful. It reports **insufficient signal** when the evidence cannot support a winner.

Learning produces a proposal, never an automatic mutation:

1. Axys states the observed evidence.
2. It explains the proposed change and the expected tradeoff.
3. The merchant chooses **Use this for the next campaign**, **Edit**, or **Ignore**.
4. Acceptance creates a new draft revision.
5. That revision passes factual confirmation, preview and scoped approval again.

## Exact WhatsApp and Studio handoffs

| Moment            | WhatsApp owns                                              | Studio adds                                        | Shared source of truth                |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| Onboarding        | Conversation, sender identity, initial goal                | Workspace access and staff controls                | Sender-to-workspace mapping           |
| Brief             | Text, captions, voice/photo receipt, consolidated question | Structured editing and media inspection            | Versioned WhatsApp draft              |
| Fact confirmation | Compact summary and signed confirmation when available     | Full fact form and explicit import                 | Confirmed campaign input              |
| Preview           | Private summary, links and reel delivery                   | Desktop/mobile preview, playback and precise edits | Campaign revision and artifact hashes |
| Approval          | Short exact-scope approval card                            | Full diff, destination, schedule and history       | Signed approval digest                |
| Execution         | Progress and final receipts                                | Recovery, reconciliation and channel details       | Durable jobs and provider receipts    |
| Leads/orders      | Fast status actions and notifications                      | Search, notes, assignment and attribution          | Tenant-scoped CRM records             |
| Results           | Plain-language checkpoint and proposal                     | Detailed denominators and comparisons              | Raw timestamped observations          |

Switching surfaces never creates a second campaign. Studio shows when WhatsApp has a newer draft; importing it uses the exact update timestamp. After a Studio edit, WhatsApp references the new revision and does not continue presenting an older approval.

## Unhappy paths

| Condition                                          | Merchant experience                                                 | System behavior                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Unknown or unlinked sender                         | Clear linking prompt; no private history shown                      | Keep an isolated unconfirmed draft; deny protected actions      |
| Duplicate or out-of-order message                  | No duplicate receipt or product                                     | Deduplicate provider IDs and preserve revision order            |
| Photo/audio retrieval fails                        | “Media is saved but still processing”; offer retry or Studio upload | Bounded retries; final visible failure; no invented asset       |
| Voice language unsupported or transcript uncertain | Ask for text or highlighted correction                              | Preserve original audio; do not confirm uncertain facts         |
| Required facts missing                             | One consolidated question                                           | Generation remains blocked                                      |
| Facts changed after generation                     | New preview required                                                | Invalidate artifacts and approval                               |
| Generation fails                                   | Plain recovery message and retained brief                           | Retry only safe/idempotent jobs; preserve diagnostics privately |
| Preview link expires                               | One refresh action                                                  | Mint a new scoped link without changing the campaign            |
| Instagram not connected/expired                    | Reconnect in Studio; never ask for a password in chat               | Stop before publication and retain approval as unusable         |
| Rate limit or processing delay                     | Show next check and current known state                             | Back off; poll the existing container                           |
| Publication response uncertain                     | “Outcome being reconciled”                                          | Never resend the publish request automatically                  |
| Website succeeds, Instagram fails                  | Show website URL and Instagram failure separately                   | Record partial failure and retry only the failed eligible step  |
| Offer expires before schedule                      | Ask for a new date and approval                                     | Cancel execution                                                |
| Metrics unavailable                                | Show Unknown with reason and last check                             | Preserve null values; do not infer performance                  |
| Customer opts out                                  | Confirm no further promotional contact                              | Record revocation and block follow-up                           |
| Workspace deletion requested                       | Explain external posts/backups separately                           | Require exact tenant confirmation and apply retention policy    |

## Accessibility and language

- Keep WhatsApp messages short, use one decision per message, and avoid relying on emoji, color or formatting for meaning.
- Buttons have clear verbs and a text fallback. Screen-reader order follows the decision order.
- Preview pages support keyboard navigation, visible focus, semantic headings, sufficient contrast, alt text for meaningful product images and reduced motion.
- Captions remain readable inside conservative reel safe areas. Important facts also appear in the caption or page, not only in moving video or audio.
- Voice is optional. Every voice path has a text alternative, and transcripts are editable before confirmation.
- Store the merchant's preferred language per workspace. Do not silently translate business names, prices, addresses, legal terms or customer consent.
- If a language is unsupported by the configured model or speech service, keep the original text and request human confirmation. Never claim language quality from model availability alone.
- Dates, currency and number formats are shown in the merchant's locale while the structured value remains unambiguous.

## Trust, consent and data boundaries

The merchant must own or have permission to use uploaded media. Axys never fabricates testimonials, certifications, prices, availability, product appearance or customer consent. Reference reels are style evidence only; third-party faces, voices, logos, footage and exact creative expression are not copied.

Consent is scoped:

- WhatsApp intake permits private storage and draft creation for that workspace.
- Media-use confirmation permits rendering with the selected asset.
- Instagram connection uses Meta authorization; Axys never requests the Instagram password.
- Artifact approval permits only the named website/reel action.
- Customer contact consent governs CRM follow-up.
- Study recording, public case-study use and naming a merchant are separate choices.

Merchants can inspect the current draft, connected account, approvals, provider receipts and results in Studio. They can revoke an account connection, stop scheduled work and request workspace deletion. Existing external Instagram posts and legally required backups require separate handling and must be explained at deletion time.

## Current implementation boundary

The repository currently has locally tested sender-bound intake, media-reference jobs, private asset validation, WhatsApp draft listing, explicit Studio import, website/reel rendering, approval binding and provider adapters. The Hermes plugin is present but is not globally activated. The inspected Meta token was expired, and no live WhatsApp media, outbound message, native WhatsApp approval, public Instagram experiment, CRM workflow or merchant learning loop has been verified end to end.

Until those live gates pass, operators must distinguish **designed flow**, **locally tested behavior**, and **provider-verified behavior** in every demo and status report.
