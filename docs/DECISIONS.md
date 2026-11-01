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
    `allowed_response_options.accept_claim`. The OpenAPI file names no rel values, so a link
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
