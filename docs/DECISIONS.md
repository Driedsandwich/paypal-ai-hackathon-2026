# Decisions

Decisions made during build pass 1 (2026-11-01) where `docs/BUILD_SPEC.md` left a choice
open, or where the spec's preferred option did not work. Newest pass last.

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
10. **Rate limits are in memory** (per process): per client address (socket address, or the
    first `X-Forwarded-For` hop when `TRUST_PROXY=1`) and a global UTC-day cap. A request is
    counted when it reaches an AI route, before input validation. One chat request counts
    once even if the model uses several tool steps (`maxSteps` 5). Default output cap: 2000
    tokens per call (thinking included).
11. **Anthropic request options:** `effort: "low"` (the tasks are short and fully specified;
    Claude Opus 5.5 always thinks and thinking counts toward the output cap) and
    `fallbacks: "default"` (server-side fallback when a safety classifier declines a request;
    the provider adds the beta header) on models that support it (Opus 5.5, Opus 5, Fable 5.1,
    Sonnet 5.5). Not verified against the live API.

### PayPal flows

12. **Every PayPal write is a proposal**, including ones the spec did not list (create
    payment link, capture, seed demo data). The executor in `src/proposals/actions.ts` is the
    only code that calls write methods. Approve runs the stored, frozen payload once and
    ignores any request body. Rejected, executed, failed and unknown proposals cannot run.
13. **Invoice proposal = create draft + send** as one approved action. The invoice number is
    generated (`generate-next-invoice-number`) at execution time. Payment term `NET_10`.
    `send_to_recipient` and `send_to_invoicer` are true.
14. **`createDraftInvoice` accepts both 201 shapes:** the full invoice, or a `self` link whose
    last path segment is the id. No `Prefer` header is sent, because the Invoicing spec does
    not list one.
15. **Order path** (`PAYMENT_PATH=order`): `payment_source.paypal.experience_context` with
    `return_url`/`cancel_url` under `PUBLIC_BASE_URL`, `shipping_preference: GET_FROM_FILE`,
    `user_action: PAY_NOW`, item breakdown. The buyer link is `payer-action` (or `approve`).
    When PayPal returns the buyer to `/paypal/return?token=…`, a capture proposal is queued for
    the seller to approve.
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
    kept as `ignored`. Duplicate deliveries (same event id) are stored once. The log keeps 200
    events in memory.

### App and UI

21. **The app runs without PayPal credentials:** PayPal routes answer 503
    `paypal_not_configured`, and `/api/health` returns banner messages that the UI shows.
    `/health` now answers `{ ok, data }` like the API (the scaffold test was updated).
22. **CSRF guard instead of login:** POST bodies must be `application/json` (a cross-site
    form cannot send that without a CORS preflight, which is never granted). There is no
    login (see open questions in `BUILD_LOG.md`).
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
    `DEMO_BUYER_EMAILS`, `TRUST_PROXY`, `AG_STUDIO_LICENSE`, `PORT`.
