# Decisions

Decisions made during the build passes where `docs/BUILD_SPEC.md` left a choice open, or where
the spec's preferred option did not work. Newest pass last. Items replaced by a later pass say
so and point to the new item.

## Pass 1 (2026-11-01)

### Sources and verification

1. **Where PayPal field names come from.** developer.paypal.com (and docs.paypal.ai) cannot be
   reached from the build environment (DNS blocked by its network policy). I used PayPal's
   official OpenAPI specifications (`paypal/paypal-rest-api-specifications` on GitHub, the
   source of the API reference on developer.paypal.com) for every request and response shape.
   This includes the Orders v2 `payment_source.paypal.experience_context` fields and enums,
   item `category`, `amount.breakdown.item_total`, the three carrier enums and the disputes
   `tracking_info` fields. Three multipart dispute bodies are only partly described there, so
   for those:
   - `provide-evidence`: the spec confirms `multipart/form-data` with file parts named
     `evidence-file`. The JSON part name `input` (holding `{ "evidences": [...] }`) comes from a
     third-party mirror of the PayPal docs. **Needs re-checking on developer.paypal.com.**
   - `send-message`: JSON `{ "message": "..." }`, from search-result text of the
     developer.paypal.com page (the spec lists only a multipart `message_document` part).
   - `accept-claim`: JSON `{ "note": "..." }`, as PayPal's own `@paypal/agent-toolkit` sends it.
     `accept_claim_type` is not sent because no request schema for it could be verified.
2. **AI SDK version: `ai` 6, not 7.** `ai@7` and `@ai-sdk/*@4` declare `engines.node >=22`; the
   project must stay green on Node 20. `ai@6.0.320` with `@ai-sdk/*@3` (Node >=18) is the
   newest line that supports Node 20.
3. **`@paypal/agent-toolkit` is not used (spec fallback applied).** Version 1.11.0 depends on
   `ai ^4` and builds tools with the v4 `parameters` field. Tested with `ai@7.0.159` and
   `ai@6.0.320` and a mock model: every toolkit tool reached the model with an empty input
   schema (`{"type":"object","properties":{},"additionalProperties":false}`), so the model
   cannot pass arguments. Also, its tools execute PayPal writes directly (no approval step)
   and it pulls in `openai`, `@langchain/core`, `mathjs`, `axios` and more. Its npm
   `license` field says ISC, not Apache-2.0 as the spec assumed. The agent tools are our own
   on `PayPalClient`, named like the toolkit's where they overlap (`list_invoices`,
   `get_invoice`, `send_invoice_reminder`, `create_invoice`, `create_order`, `get_order`,
   `create_shipment_tracking`, `list_disputes`, `get_dispute`, `accept_dispute_claim`) plus
   `send_dispute_message`.

### AI

4. **Default models:** `claude-opus-5-5` (anthropic), `gemini-3.5-flash` (google),
   `gpt-5.4-mini` (openai); `AI_MODEL` overrides. The Google and OpenAI ids were taken from
   the model-id lists in the installed provider packages and are not verified against a live
   API.
5. **Structured output by JSON-in-text + zod**, with one retry that feeds back the validation
   issues. No forced tool choice and no provider-specific structured-output mode: Claude Opus
   5.5 rejects forced `tool_choice`, and one path behaves the same on every provider. No
   `temperature` is sent (newer models reject sampling parameters).
6. **Numbers are computed in code, not by the model:** the USD estimate is
   `round(price_jpy / FX_JPY_PER_USD, 2)`; invoice and order JSON is built by pure functions.
   The model writes only text (listing, notes, reminders, replies).
7. **Fact check for dispute texts:** dates, money amounts, UPU tracking numbers and PayPal-style
   ids in AI text that do not appear in the inputs are listed as `unverified_facts` and shown
   in red. Text is not changed automatically; the seller decides.
8. **Personal data to the model** (revised in pass 2a, F7). The real boundary: structured buyer
   identity from PayPal records (emails, names, addresses) is never put into prompts, and the
   chat tools take a buyer alias, never an email. Free text *is* sent, because the tasks need
   it: dispute messages, seller notes, item descriptions, chat messages and tool results. Before
   any model call that free text goes through a pattern-based redactor
   (`src/privacy/redact.ts`) that replaces email addresses, phone numbers (international,
   Japanese and North American formats, full-width digits, "phone:/電話" prefixes) and
   street-address-like lines (house number + street word, Apt/Suite/PO Box, US ZIP and UK
   postcodes, 〒 and 都道府県…丁目/番地 patterns) with placeholders. Structured fields
   (tracking numbers, ids, amounts) are left alone so the evidence pack still works. Names and
   unusual formats are not detected; the model's output still needs seller approval.
9. **Offline `fake` provider** is rule-based (a small Japanese→English glossary, material and
   HS-code hints) and labels its text "[offline demo]". It drives all tests and keyless demos.
10. **Rate limits are in memory** (per process). *Superseded in pass 2a:* the client address
    now comes from `TRUST_PROXY_HOPS` (29), AI requests are counted after validation and the
    daily cap counts model calls (36). Default output cap: 2000 tokens per call (thinking
    included).
11. **Anthropic request options:** `effort: "low"` (the tasks are short and fully specified;
    Claude Opus 5.5 always thinks and thinking counts toward the output cap) and
    `fallbacks: "default"` (server-side fallback when a safety classifier declines a request;
    the provider adds the beta header) on models that support it (Opus 5.5, Opus 5, Fable 5.1,
    Sonnet 5.5). Not verified against the live API.

### PayPal flows

12. **Every PayPal write is a proposal**, including ones the spec did not list (create
    payment link, capture, seed demo data). The executor in `src/proposals/actions.ts` is the
    only code that calls write methods. Approve runs the stored, frozen payload once and
    ignores any request body. Only pending proposals can run (statuses in 34).
13. **Invoice proposal = create draft + send** as one approved action. The invoice number is
    generated (`generate-next-invoice-number`) at execution time. Payment term `NET_10`.
    `send_to_recipient` and `send_to_invoicer` are true; no subject or note is sent with
    `/send` (37).
14. **`createDraftInvoice` accepts both 201 shapes:** the full invoice, or a `self` link whose
    last path segment is the id. No `Prefer` header is sent, because the Invoicing spec does
    not list one.
15. **Order path** (`PAYMENT_PATH=order`): `payment_source.paypal.experience_context` with
    `return_url`/`cancel_url` under `PUBLIC_BASE_URL`, `shipping_preference: GET_FROM_FILE`,
    `user_action: PAY_NOW`, item breakdown. The buyer link is `payer-action` (or `approve`).
    When PayPal returns the buyer to `/paypal/return?token=…`, a capture proposal is queued for
    the seller to approve (checked with PayPal first since pass 2a, 33).
16. **Tracking:** Orders v2 `/track` for payment links (needs `capture_id`). For invoice
    payments the Add Tracking API `trackers-batch` with the invoice's
    `payments.transactions[].payment_id`. PayPal's spec marks `trackers-batch` deprecated *for
    Orders v2 orders* and recommends `/track` there; invoice payments are not Orders v2
    orders, so `trackers-batch` remains the documented path. Errors returned inside a 200
    batch response are raised as `PayPalApiError`.
17. **Carrier names** are free text, mapped per API: Japan Post → `JPN_JAPAN_POST`; Yamato →
    `YAMATO` / `JP_KURO_NEKO_YAMATO_UNYUU` / `JPN_YAMATO`; Sagawa → `SAGAWA` / `JPN_SAGAWA`;
    major global carriers by code. Anything else becomes `OTHER` + `carrier_name_other`.
18. **Evidence:** `PROOF_OF_FULFILLMENT` with `tracking_info` when tracking is given,
    otherwise `OTHER` with notes. The optional attachment is a one-page **PDF** invoice
    summary written by a tiny built-in PDF writer (ASCII text only; no PNG, no dependency).
19. **Errors shown to the seller** carry PayPal's `debug_id` (from the body, or the
    `paypal-debug-id` response header), error name and issues. HTTP mapping: PayPal 400/422 →
    422, 404 → 404, other → 502.
20. **Webhooks:** the four spec events are routed into categories; other verified events are
    kept as `ignored`. The log keeps 200 events in memory; de-duplication moved to a separate
    3-day cache in pass 2a (41).

### App and UI

21. **The app runs without PayPal credentials:** PayPal routes answer 503
    `paypal_not_configured`, and `/api/health` returns banner messages that the UI shows.
    `/health` now answers `{ ok, data }` like the API (the scaffold test was updated).
22. **CSRF guard instead of login:** POST bodies must be `application/json` (a cross-site
    form cannot send that without a CORS preflight, which is never granted). There is no
    login; since pass 2a every visitor gets a demo session (28).
23. **Limits on input:** 64 KB per API body (1 MB for webhooks), field lengths follow
    PayPal's maxima (item name 200, note 1000, dispute message 2000, …).
24. **UI:** Vite + React + TypeScript in `web/`, built into `dist/public` and served by the
    same server with SPA fallback and a path-traversal guard. Hash-based view switching, a
    global "Waiting for your approval" panel, and the agent chat on the Dashboard view. The
    Vite config lives in `web/` so vitest does not pick it up.
25. **Node engines:** `>=20.19` because Vite 8 requires `^20.19.0 || >=22.12.0`.
26. **Removed the scaffold's `HttpAiProvider` template**; the real providers come from the AI
    SDK. `AI_PROVIDER` values other than `anthropic|google|openai|fake` are rejected at start.
27. **New env names** (all in `.env.example`, empty): `PAYMENT_PATH`, `AI_MODEL`,
    `AI_MAX_OUTPUT_TOKENS`, `AI_RATE_LIMIT_PER_IP`, `AI_RATE_LIMIT_WINDOW_MINUTES`,
    `AI_DAILY_CAP`, `FX_JPY_PER_USD`, `SELLER_BUSINESS_NAME`, `PUBLIC_BASE_URL`,
    `DEMO_BUYER_EMAILS`, `TRUST_PROXY` (replaced by `TRUST_PROXY_HOPS` in pass 2a),
    `AG_STUDIO_LICENSE`, `PORT`. Pass 2a names: see 43.

## Pass 2a (2026-11-01): review fixes

Decisions for the fixes to the public-demo review (F1-F13). The owner decided the direction of
each fix; these are the choices made while implementing them.

### Visitors and recipients

28. **Demo sessions instead of login (F1).** The server sets `okuri_sid` (32 random bytes,
    base64url) with `HttpOnly; SameSite=Lax; Path=/; Max-Age=30 days`, plus `Secure` when
    `PUBLIC_BASE_URL` is https, the socket is TLS, or (with `TRUST_PROXY_HOPS` > 0) the proxy's
    `X-Forwarded-Proto` says https. The cookie is issued on the first API call or page load.
    Sessions have no server-side state: a proposal stores its owner session id, and
    list/approve/reject only see the caller's own proposals; other ids answer 404 (existence
    is not revealed). The owner id is never returned. The UI says: "Demo mode: you act as the
    seller of a shared PayPal sandbox account."
29. **Client address (F5):** `TRUST_PROXY_HOPS` (default 0 = socket address). With N > 0 the
    address is the N-th `X-Forwarded-For` entry from the right (each trusted proxy appends the
    address it saw, so everything further left is client-controlled), validated with
    `net.isIP` and canonicalized (brackets/ports stripped, `::ffff:` IPv4-mapped addresses
    unwrapped, IPv6 lower-case compressed); otherwise the socket address. On one platform proxy
    such as Render the value is 1. Per-address limits key IPv6 by /64. A set `TRUST_PROXY`
    only logs a hint.
30. **Recipients by alias, resolved at execution (F1, F3).** `DEMO_BUYER_EMAILS` become
    *Demo buyer 1, 2, …* (duplicates collapse). Proposal payloads store `recipient_alias`; the
    executor resolves it right before the PayPal call and refuses anything else: an invoice
    that already names `primary_recipients`, notification `additional_recipients`, or an
    order that already names `payment_source.paypal.email_address`. Seeds check all recipients
    before the first write. Without `DEMO_BUYER_EMAILS` nothing can be billed (409).
31. **Payment links get a recipient too.** The decision says "invoices and payment links only
    to recipients in DEMO_BUYER_EMAILS"; an Orders v2 link has no recipient by itself, so the
    resolved address is sent as `payment_source.paypal.email_address`. That field is in the
    official Orders v2 OpenAPI (`paypal_wallet.email_address`, "The email address of the PayPal
    account holder."); its effect on the checkout (expected: pre-filled login) is **not
    verified against the sandbox**. Anyone with the link can still pay it.
32. **Public data (F3):** routes return small DTOs (`src/http/dto.ts`): invoice rows/details
    without invoicer, billing details or memo; disputes without buyer objects or extensions;
    proposals without owner, with attachment sizes instead of base64. Recipients appear by
    alias, other addresses as `m***@example.com`. `sendJson` masks every email address in
    every JSON response as a safety net. PayPal reads are not filtered per session: since all
    invoices and links go to demo buyers, the shared account holds only demo data.

### Return page and queue

33. **Return page (F4).** Only order ids created by this server are accepted: a bounded
    registry (2,000 entries, 3-day expiry) maps order id to the creating session. `HEAD` never
    looks anything up. `GET` fetches the order and queues a capture proposal (in the creating
    session, even if the buyer uses another browser) only when PayPal reports `APPROVED`; the
    page then says "Payment approved". Other outcomes have fixed texts (not approved yet,
    already complete, not found, could not check, try again shortly). Captures are
    de-duplicated through the registry. The capture route also requires `APPROVED` and
    returns the existing capture proposal.
34. **Proposal statuses and capacity.** New statuses: `unknown` (a PayPal write timed out;
    needs checking, never retried), `obsolete` (no longer allowed right before execution;
    nothing sent), `expired` (pending for 24 hours). The store (500 entries) never evicts
    pending or executing proposals; when full of them it refuses new ones (503). Finished ones
    are dropped oldest first, `unknown` last. To keep the refusal from becoming a lock-out,
    each client address may have at most 50 pending proposals and pending proposals expire
    after 24 hours; both are constants, not env.

### Limits and deadlines

35. **Shared-account limits (F2)** are in memory per process (several replicas would each
    enforce their own). Proposal and approval limits count per session *and* per address, so a
    new cookie does not reset them. The daily write cap reserves a fixed cost per proposal kind
    before execution starts (invoice 3: number, create, send; seed 3 per invoice or 1 per
    order; others 1); a refused approval stays pending; an `obsolete` execution is refunded,
    `failed` and `unknown` are not (a write may have happened). The read limit counts requests
    that read PayPal (API routes, chat tool reads, the return page). The 30-second list cache
    is shared by all visitors, coalesces identical in-flight reads and is cleared after every
    executed action and every new webhook event. Seeding is limited at approval (once per
    session per interval, daily cap) and checked early when proposing. The execution limit is
    a semaphore without a queue: a third concurrent approval gets 503 with `Retry-After`.
    Webhooks are limited per address and globally before the body is read.
36. **AI budget (F9).** `AI_DAILY_CAP` counts model calls: the AI SDK provider debits each step
    in `prepareStep` (tool steps included), each JSON repair retry is a separate call, and the
    offline provider mirrors this. A chat that runs out between steps stops early with a note;
    a call that would exceed the budget is refused (429). AI routes validate input, buyer,
    queue and proposal limits first, then take the per-address allowance; a separate limit
    (`AI_INVALID_RATE_LIMIT_PER_IP`) counts invalid AI requests. Retries inside the AI SDK after
    a failed HTTP call (default 2) are not counted; failed calls are normally not billed.
37. **Reminders (F10).** PayPal says user-provided `subject`/`note` on `/send` and `/remind`
    "will not be honored", so the client sends only the two flags. A reminder proposal is "Send
    PayPal's standard reminder"; the AI text is stored as `copy_for_dm` and shown with a Copy
    button (sellers talk to buyers in DMs). At most 2 reminders per invoice per UTC day,
    enforced when proposing (skipped) and at execution (`obsolete`); a reminder PayPal refuses
    gives its slot back. Reminders sent outside the app are not counted. New invoices keep the
    AI note in `invoice.detail.note`; the AI no longer writes a subject.
38. **Dispute actions (F11).** send-message needs stage `INQUIRY` and the send-message link;
    provide-evidence needs its link; accept-claim needs its link or
    `allowed_response_options.accept_claim` (*changed in pass 4:* the link is required, see 68). The OpenAPI file names no rel values, so a link
    counts when its rel is the action name (`send_message` or `send-message`) or its href path
    ends with the action path. The executor re-reads the dispute before each dispute write and
    marks the proposal `obsolete` when the action is gone; the approved payload is never
    changed. The model sees `allowed_actions`. Evidence type selection is unchanged (tracking
    given → `PROOF_OF_FULFILLMENT`, otherwise `OTHER`).
39. **Money (F12).** Currency list and decimals from PayPal's Currency codes reference (25
    codes; HUF, JPY, TWD without decimals). Seller prices must be a listed code, the right
    precision and > 0; values with a decimal point are refused for zero-decimal currencies
    (not rounded). Totals are unit × quantity in integer minor units. PayPal-sourced amounts
    keep the looser schema so reads in other currencies do not fail.
40. **Deadlines (F8).** PayPal calls: 15 s for request and body together. Model calls: 45 s per
    `complete()` call (a chat with tool steps is one call). Server `headersTimeout` 20 s,
    `requestTimeout` 30 s. In-flight cap counts `/api/*` (health exempt), the webhook and the
    return page. A timeout counts as a write (`unknown`) unless the method is GET or the path
    is OAuth, webhook verification or invoice-number generation. Execution errors show only
    safe messages; other internal errors become "internal error".
41. **Webhook de-duplication (F13):** a separate cache of event ids (3 days, at most 20,000),
    filled only after a successful signature verification, so a forged event cannot block the
    real one. A known redelivery gets 200 without another verification call. Events without a
    valid id (1-128 of `A-Za-z0-9._:-`) get 400 before any call to PayPal.
42. **Offline provider recording (F6):** off by default; tests opt in with `{ record: true }`
    (50 entries) or a number.
43. **New env names in pass 2a** (all in `.env.example`, empty): `TRUST_PROXY_HOPS`,
    `MAX_CONCURRENT_REQUESTS`, `PROPOSAL_RATE_LIMIT`, `APPROVAL_RATE_LIMIT`,
    `PAYPAL_READ_RATE_LIMIT`, `RATE_LIMIT_WINDOW_MINUTES`, `PAYPAL_DAILY_WRITE_CAP`,
    `LIST_CACHE_SECONDS`, `WEBHOOK_RATE_LIMIT`, `WEBHOOK_GLOBAL_RATE_LIMIT`,
    `SEED_SESSION_INTERVAL_MINUTES`, `SEED_DAILY_CAP`, `EXECUTION_CONCURRENCY`,
    `AI_INVALID_RATE_LIMIT_PER_IP`. Removed: `TRUST_PROXY`.

## Pass 2 (2026-11-01): design, journeys, hosting

Pass-1 and pass-2a decisions stand as written above (model `claude-opus-5-5` with the per-call
output cap, no login, name "Okuri", demo sessions, limits, masking, dispute/state checks).

### Design

44. **Structure from S3, look from A1** (`docs/design/DESIGN.md`), written down region by region
    in `docs/design/LAYOUT_TABLE.md` before the UI code. Borrowed: S1's inbox for Approvals
    (list + detail + action bar), S4's per-country idea for Insights (as a bar chart and a
    country ledger, see 52). Navigation is a top tab row (S3) with A1's selected style
    (vermilion rule + lighter paper), not A1's sidebar. Switchable themes: not built.
45. **Labels are honest.** The model chip shows the configured provider's name ("Claude" for
    `anthropic`, "Gemini", "OpenAI"), with the model id as tooltip; with the fake provider it
    says "Offline AI", never "Claude". The PayPal chip says "PayPal sandbox", plus "· offline"
    when the simulator runs. The committed screenshots were taken offline, so they show
    "Offline AI" and "· offline" where the targets show "Claude" and "PayPal sandbox".
46. **Fonts** are self-hosted with `@fontsource` (Noto Serif JP 600/700, Noto Sans JP 400/700),
    not loaded from Google at runtime (privacy, and the screenshot browser has no CJK fonts).
    The browser loads only the unicode-range chunks it needs.
47. **Callouts keep Reject next to Approve** (the S3 target shows only Review + Approve): the
    A1 rule pairs Approve with Reject, and rejecting from the journey avoids a detour.
48. **Demo notices are one line** with a details disclosure (the banner rows of pass 1 pushed the
    journey below the fold); the offline state is also in the PayPal chip.

### Journeys and the offline demo

49. **A sale ("journey") registry** (`src/journeys/sales.ts`, in memory, 5,000 entries, 7 days)
    ties draft, invoice/order, payment, tracking and dispute together. Every listing draft
    starts a journey. A journey is private to its session until PayPal holds the invoice or
    order; then every visitor sees it (it is on the shared sandbox account, like the pass-1
    invoice list). Journeys are computed on each read from the registry, PayPal's invoice list
    (page 1, 50 items, cached 30 s) and dispute list, and the visitor's own proposals.
50. **Marker in PayPal records:** invoices carry `detail.reference = "Okuri OK-1234 US"` (shown
    to the buyer as the invoice reference), payment links `purchase_units[0].custom_id` (not
    shown). After a restart of the free instance the app rebuilds journeys from marked invoices
    and still recognises them for tracking. Orders cannot be listed, so order journeys are
    memory-only. The marker also carries the buyer country (no PayPal field holds it; the seller
    chooses it on New item). Disputes are linked to a sale by
    `disputed_transactions[].seller_transaction_id` (or `invoice_number`) when PayPal's list
    returns them; this is **not verified against the sandbox** (the list may omit them).
    *Extended in pass 3a:* cases known by webhook or by ID too, and capture ids (58, 62).
51. **Offline demo is opt-in** (`PAYPAL_OFFLINE_DEMO=true`), not automatic without credentials,
    so the pass-1 behaviour (503 + banner) stays. It implements the app's PayPal calls in memory
    (`src/paypal/offline.ts`, `PayPalApi` = the subset of `PayPalClient` the app uses) with one
    private world per session (500 worlds, 24 h), seeded with six fictional sales at different
    steps and three pending proposals. Buyers are three made-up addresses on `.invalid`, built
    at runtime. Simulated buyer actions (`POST /api/offline/simulate`: payment, dispute,
    delivery) exist only in this mode; "Delivered" is never used to mean "dispute resolved".
    Approvals, limits and the executor run exactly as with PayPal.
52. **Tracking only for sales this demo created** (follow-up to pass 2a): the tracking route and
    the chat tool accept an invoice or order when it is in the registry or carries the marker;
    a bare `transaction_id` is accepted only when it belongs to a registered sale. Others get
    403 `not_created_by_demo`. Demo-wide, not per session (a judge may pay in one browser and
    ship in another). Two pass-1 tests were changed to give their fake invoice/order a marker.

### Insights

53. **AG Studio is used** (`ag-studio-react` 3.0.0 + `ag-studio` 3.0.0; it pulls
    `ag-grid-enterprise` and `ag-charts-enterprise`): installable, works with React 19 and
    Vite 8, no fallback to AG Grid/Charts Community was needed. A pre-built view-mode report:
    bar chart "revenue by buyer country", grid "unpaid invoices", value widget "dispute rate"
    (disputed ÷ paid sales, a measure expression), grid "by country". AG Studio has **no map
    widget**, so S4's map became the bar chart and the country ledger. Data comes from
    `/api/journeys` in the browser (USD sales only). The view is lazy-loaded (one ~5 MB chunk,
    1.5 MB gzip). `AG_STUDIO_LICENSE` is passed to the browser through `/api/health` (AG
    licence keys are browser keys); without it AG Studio runs as a trial: a console message and
    a "For Trial Use Only" mark that fades after a few seconds, only on non-localhost hosts.
    Licence: commercial (AG Grid EULA), listed in the README.

### AI fallback

54. **`AI_FALLBACK_PROVIDER`** (+ `AI_FALLBACK_MODEL`, `AI_FALLBACK_API_KEY`,
    `AI_FALLBACK_DAILY_CAP`, default 300): the fallback answers when the primary throws (API
    error), times out (45 s), stops with `finishReason: "length"` (cut off by
    `AI_MAX_OUTPUT_TOKENS`), or its daily budget (`AI_DAILY_CAP`) is used up. The fallback has
    its own daily budget and a 30 s deadline. The route-level daily check passes while either
    provider has budget; the per-address limits are shared. A chat whose tools already ran on
    the primary is not repeated (it could queue the same proposal twice). Answers carry
    `generated_by.fallback_from { provider, model, reason }`; the UI shows "Gemini · fallback".
    A fallback provider without a key is skipped with a log warning (the server still starts).

### Hosting

55. **Render free web service** (`render.yaml`): `npm ci && npm run build`, `npm start`, health
    check `/api/health`, `NODE_VERSION=22.12.0`, `TRUST_PROXY_HOPS=1`, `PORT=10000`,
    `autoDeploy: false`, every `.env.example` name; credentials and per-deployment values
    (PayPal id/secret/webhook id, AI keys, AG Studio licence, demo buyer emails, public URL,
    seller name) have `sync: false`. Defaults: `AI_PROVIDER=anthropic`, `AI_MODEL=claude-opus-5-5`,
    `AI_FALLBACK_PROVIDER=google`. Render's docs could not be opened from the build environment
    (proxy 403), so the Blueprint follows the spec as known; check on first deploy.
56. **The sandbox buyer login for judges** goes into the Devpost testing instructions, not the
    public repository.
57. **New env names in pass 2:** `PAYPAL_OFFLINE_DEMO`, `AI_FALLBACK_PROVIDER`,
    `AI_FALLBACK_MODEL`, `AI_FALLBACK_API_KEY`, `AI_FALLBACK_DAILY_CAP` (all in `.env.example`).
    New routes: `GET /api/journeys`, `POST /api/offline/simulate`. `/api/health` adds
    `paypal.offline`, `countries`, `ai.fallback`, `limits.fallback`, `agStudio.licenseKey`.

## Pass 3a (2026-11-01): dispute discovery

A sandbox case was readable by id but missing from PayPal's dispute list for at least 3
minutes, and offered no seller action (`test/fixtures/sandbox-dispute-20261101.json`).

58. **Three sources, one registry.** Dispute ids come from PayPal's list, verified
    `CUSTOMER.DISPUTE.CREATED`/`UPDATED` webhooks, and reads by id (*Open a case by ID* and
    `GET /api/disputes/{id}`). The registry (`src/journeys/disputes.ts`) is in memory, bounded
    (2,000 entries, 30 days, oldest dropped first) and shared by all visitors, like the
    account's dispute list. It keeps reduced data only: summary fields, transaction ids and
    amounts, action links and `allowed_response_options`; no messages, evidence or buyer
    objects (those are read fresh for the case view). The offline demo does not use it: each
    visitor's simulated list is complete and private.
59. **Merging.** Pages show PayPal's list (page 1, 50, cached 30 s) plus registered cases the
    list does not return, newest first. Ids that came only from the list are not read one by
    one when they drop out of it (as before). Cases known from a webhook or by id are read by id
    on each page load through the 30-second cache, at most 10 per load (newest first); older
    ones show their last known data. List items without transaction ids keep the ones from an
    earlier read by id; action links are only taken from reads by id. If the list call fails,
    registered cases still show with a warning; with none registered, the error is returned as
    before.
60. **Not found.** A registered id that PayPal answers 404 for is dropped, but only one hour
    after it was first registered: a case announced by a verified webhook may not be readable
    at once (the list lags too, so reads by id might as well).
61. **Webhook follow-up.** After verification, and only for a new event id, a dispute event
    whose `resource.dispute_id` is a valid case id registers the id at once; the detail is read
    by id in the background (one read per id at a time), so PayPal's delivery does not wait up
    to 15 s for it. A failed read is logged and the id stays registered, so the next page load
    reads it. Only the id is taken from the event body. Unverified events, redeliveries and
    other event types register nothing.
62. **Linking.** A dispute belongs to a sale when a `disputed_transactions[].seller_transaction_id`
    equals the sale's invoice payment transaction id (`payments.transactions[].payment_id`) or
    its order capture id; `invoice_number` stays as a fallback. New
    `SaleRegistry.bySellerTransaction`; the tracking allowlist keeps `byTransaction` (invoice
    payments only), so tracking rules did not change. A sale with a transaction or capture id is
    checked even when its invoice is not on the first page of the invoice list. When a sale has
    several cases, an open one is shown first.
63. **Open a case by ID** (`POST /api/disputes/open`). The id is trimmed and upper-cased and must
    look like PayPal's case ids (`PP-` and 1-7 groups of letters/digits, at most 64 characters:
    `PP-D-27803`, `PP-R-EMU-10195761`, `PP-000-042-663-135`, the simulator's `PP-D-OFF…`);
    anything else gets 400 before PayPal is called. PayPal 404 or 403 becomes 404
    `dispute_not_found` with PayPal's status, name and debug_id. Limits: the route counts as a
    PayPal read (the existing per-address limit, which is how other PayPal reads are limited;
    they are not per session), plus `DISPUTE_LOOKUP_LIMIT` = 10 lookups per window per session
    *and* per address (a constant, not env), because each lookup may add to the shared registry.
64. **No seller action.** When `disputeActions` allows nothing (for example links hold only
    `self`), the detail, the evidence-pack response and the journey's dispute carry
    `seller_action_available: false` and a `notice`: "PayPal is reviewing this case. No seller
    action is available right now." (closed cases: "This case is closed. No seller action is
    available."; `WAITING_FOR_BUYER_RESPONSE`: "PayPal is waiting for the buyer's response. …").
    The journey states this only for cases read by id on that page load, because list items
    carry no action links. The evidence pack and the English reply draft are still built and
    shown read-only (evidence notes "kept ready, not sent", reply as Copy-for-DM); proposals are
    still created only for allowed actions (38 unchanged), and the accept-claim button shows
    only when allowed.
65. **Recommendation follows PayPal.** New `recommended_action` value `wait_for_paypal`. In code,
    after the model answers: no allowed action → `wait_for_paypal` (missing information is still
    listed); a PayPal action that is not allowed → `needs_seller_input`. The prompt says the same.
66. **No new env names.** New route `POST /api/disputes/open`; `GET /api/disputes` rows add
    `in_paypal_list`, `sources` and `sale_id`, the response adds `warnings`; `GET
    /api/disputes/{id}` adds `seller_action_available`, `notice` and `sale_id`; the journey's
    `dispute` adds `in_paypal_list` and, when known, `seller_action_available` and `notice`.

## Pass 4 (2026-11-01): after the first Render deploy

The first Render deploy exited at startup because `AI_API_KEY` was not set yet. A live check
then passed walkthrough steps 1 to 3 on the real sandbox (draft listing, prepare invoice,
approve, PayPal sent the invoice).

67. **A missing AI key never stops the server.** New `createAiSetupFromEnv` (used by
    `src/server.ts`): primary key missing (empty or blank) → the offline (rule-based) provider
    answers, the fallback is not used (so every answer comes from one clearly labelled source),
    a banner line says "AI is not configured: AI_API_KEY is not set for AI_PROVIDER=…, so the
    offline AI answers … Set the key and restart." (same banner list as the PayPal notice), and
    `/api/health` `ai` adds `configured: false` and `warnings`. Only the fallback key missing →
    the primary runs without a fallback and `ai.warnings` says so (no banner: answers still come
    from the real model). Blank (spaces only) keys count as missing for both. Both lines are
    logged at startup. An unknown `AI_PROVIDER` value still
    stops the server (a typo should be fixed, not hidden). `createAiProviderFromEnv` keeps
    throwing for direct callers. No new env names.
68. **Seller actions only from what PayPal offers (supersedes the accept-claim part of 38).**
    Every action needs its HATEOAS link, accept-claim included. `allowed_response_options`,
    where present, can only narrow: if it is there, `accept_claim` must be listed in it, and an
    explicit empty `accept_claim_types` list means not allowed; absent means no extra
    restriction. Reason: on the real sandbox case (fixture, links only `self`) the app reported
    accept-claim as allowed; the only path to that was `allowed_response_options.accept_claim`
    counting on its own. Tests: the fixture as recorded and with `allowed_response_options`
    added, at INQUIRY and CHARGEBACK, unit and over HTTP (no proposal, 409, no PayPal write).
69. **Shipping on invoices.** `listing.shipping` (optional, `{ currency_code, value }`) must be
    in the price's currency and follows the pass-2a precision rules (no decimals for JPY, HUF,
    TWD; at most 2 otherwise; greater than zero); errors are 400 before a proposal exists. The
    invoice gets Invoicing v2 `amount.breakdown.shipping.amount`; items are unchanged, so
    PayPal adds the shipping to the total. Payment links (order path) put it in
    `purchase_units[0].amount.breakdown.shipping` and in the total, so it is never dropped
    silently. The sale's `amount` (journeys, Insights) is now the billed total, item total plus
    shipping, computed in integer minor units (`listingTotals`). The offline simulator adds the
    shipping to the invoice total. UI: an optional Shipping field on New item (sent only when
    greater than zero); the approval preview and the journey callouts show a Shipping row and
    "Item … + Shipping …"; the draft journey's callout shows the same line.
70. **Insights by-country Disputes column.** The column had the right sums (they were in the
    page), but the ledger widget was too short for six countries plus the total row, so AG
    Grid showed a vertical scrollbar that sat over the right edge of the last column, where the
    right-aligned numbers are. The ledger's height now follows the number of countries
    (`ledgerTracks`, frame height grows with it), so no scrollbar appears. The row maths moved to
    `web/src/insights-data.ts` (pure, unit-tested): the per-country sums of revenue, unpaid and
    disputes equal the cards above (paid revenue, unpaid, "n of m paid sales").
71. **README "AI tools used".** Runtime: Claude (Anthropic API) primary, Gemini (Google AI
    Studio API) fallback. Build: Claude Code for implementation and fixes, OpenAI Codex for the
    visual design mockups and an independent code review (as stated by the owner). Hosted URL
    `https://okuri.onrender.com` at the top with the about-a-minute wake-up note.
