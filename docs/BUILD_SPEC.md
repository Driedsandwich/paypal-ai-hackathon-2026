# Build spec v1 — Okuri: an AI export desk for small Japanese sellers (working title)

Status: spec for the first build pass (2026-11-01). The scaffold on branch `claude/scaffold`
(PayPal REST client, webhook verification, pluggable AI provider, tests, CI) is the base.
Work on branch `claude/build-v1`. Do not merge into `main`; the owner reviews and merges.

## 1. Product in one paragraph

Small sellers in Japan (handmade crafts, used camera gear, collectibles) get overseas
buyers through social media and DMs, but stall on four things: writing an English listing,
asking for payment in the buyer's currency, proving shipment, and answering a dispute in
English. Okuri is a seller cockpit where an AI agent does the paperwork and PayPal does the
money: the seller types the item in Japanese, the agent drafts the English listing and a USD
price, creates and sends a PayPal invoice, records the tracking number with PayPal after
shipping, and, when a buyer opens a dispute, assembles an evidence pack and drafts an English
reply. The seller approves every step that sends something to a buyer or to PayPal.

## 2. Hackathon constraints (from the official rules and organizer updates)

- PayPal developer platform (sandbox) and an AI model must both be central and visible.
  Name both in the README, the UI and the demo.
- Judges need something to run: a hosted demo URL and clear setup/run steps in the README.
  "A design mockup, static prototype, or non-functional demo does not meet this requirement."
- Public repo with an OSS license (MIT, already in place), English only.
- The demo must stay usable free of charge until 2026-12-15 08:00 PT.
- Never commit credentials. Everything secret comes from environment variables
  (names in `.env.example` only).
- Everything in the repo must be created during the submission period (2026-10-01 to
  2026-11-12). Third-party packages are listed in the README "Pre-existing components" table
  with their license.

## 3. Scope of this pass (backend + agent + minimal UI shell)

### 3.1 PayPal features (sandbox, REST via the existing `PayPalClient`)

Add methods to `src/paypal/client.ts` (or a sibling module) with unit tests that replace
`fetch` with the fake from `test/helpers/fake-fetch.ts`. Check every request and response
shape against developer.paypal.com before writing it; do not guess field names.

| Feature | Endpoint(s) | Notes |
| --- | --- | --- |
| Invoice: create draft, send, remind, get, list | Invoicing v2 `/v2/invoicing/invoices`, `/{id}/send`, `/{id}/remind`, `/v2/invoicing/generate-next-invoice-number` | Currency USD by default, any ISO code allowed. Primary payment path. |
| Payment link (fallback path) | Orders v2 create (already in the scaffold) | Used if invoices are not available for the merchant's sandbox country (see 3.5). Return the `payer-action`/`approve` link. |
| Shipment tracking | Orders v2 `POST /v2/checkout/orders/{id}/track` for order payments; Add Tracking `POST /v1/shipping/trackers-batch` (transaction id) for invoice payments | Carrier free text allowed (e.g. Japan Post). Verify which one the current docs recommend. |
| Disputes: list, get, provide evidence, send message, accept claim | Customer Disputes v1 `/v1/customer/disputes`, `/{id}`, `/{id}/provide-evidence` (multipart), `/{id}/send-message`, `/{id}/accept-claim` | Evidence = text notes + tracking info + optional generated PDF/PNG of the invoice. |
| Webhooks | existing `/webhooks/paypal` | Route `INVOICING.INVOICE.PAID`, `PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED` into an in-memory event log that the UI can read. |

Send a fresh `PayPal-Request-Id` on every create/send call. Surface PayPal's `debug_id` in
errors shown to the seller (never the request headers).

### 3.2 AI agent

- Provider is chosen by `AI_PROVIDER`: `anthropic` (default for the hosted demo), `google`
  (Gemini), `openai`, or `fake`. Model ids come from env (`AI_MODEL`), with a sensible
  default per provider. The `fake` provider must make the whole app usable offline and is
  what tests use.
- Preferred integration: Vercel AI SDK with PayPal's official `@paypal/agent-toolkit`
  (Apache-2.0) tools, if the toolkit's AI SDK adapter is compatible with the AI SDK version
  you install. If not compatible, define the agent tools yourself on top of `PayPalClient`
  and keep the same tool names as the toolkit where they overlap. Record the decision and
  the reason in `docs/DECISIONS.md`.
- Agent tasks (each is a typed function with a JSON-schema'd output, plus a free-chat entry
  point that can call the same tools):
  1. `draftListing(jpItem)` → English title, description, item specifics, suggested USD
     price (from JPY using `FX_JPY_PER_USD`, default 150, shown as an estimate), a plain
     English customs description and an HS code *candidate* labelled "check before use".
  2. `prepareInvoice(listing, buyer)` → invoice draft for seller approval.
  3. `nudgeUnpaid(invoices)` → friendly reminder text per unpaid invoice (seller approves
     before `remind`).
  4. `disputeEvidencePack(dispute, invoice, tracking, messages)` → evidence summary,
     timeline, list of attachments, and an English reply draft. Never claims facts that are
     not in the inputs.
- Human-in-the-loop: the agent only *proposes* actions that change state at PayPal or reach a
  buyer (send invoice, remind, add tracking, provide evidence, send message, accept claim).
  The UI shows the exact payload; the action runs only after the seller clicks Approve.
  Enforce this on the server (proposal id + explicit approve endpoint), not only in the UI.
- Cost and abuse limits for the hosted demo: per-IP rate limit on AI routes (default 20 per
  10 minutes), a global daily cap on AI calls (default 300), max output tokens per call, and
  a clear message when a limit is hit. All limits are env-configurable.

### 3.3 HTTP API (node:http, keep it framework-free unless there is a strong reason)

JSON routes under `/api/`: listings (draft), invoices (prepare, list, get), payment links,
tracking, disputes (list, get, evidence pack), proposals (list, approve, reject), events
(webhook log), health. Validate input sizes and types. Return `{ ok, data | error }`.

### 3.4 Demo data

No database (free hosting tiers either sleep or expire databases). On startup the app reads
live sandbox state (invoices, disputes) from PayPal. A "Seed demo data" action (behind the
same approval flow) creates 3–5 sample invoices to sandbox buyer emails configured in env.
Japanese sample items live in `src/demo/items.ts`.

### 3.5 Country fallback

The merchant's sandbox account may be Japan-based. If invoice creation in USD fails for that
account, the app must still work end to end through the Orders v2 payment-link path, and
the README must say which path the hosted demo uses. Make the path a config switch
(`PAYMENT_PATH=invoice|order`), not a code fork.

### 3.6 Minimal UI shell

A static single-page UI served by the same server (Vite + React + TypeScript is fine) with
the five views below. Keep styling minimal in this pass; a visual design will be supplied
later and applied in the next pass.

1. New item (Japanese input → English listing, price, customs line)
2. Invoices (status grid, prepare/send/remind with approval)
3. Shipments (add tracking with approval)
4. Disputes (evidence pack and reply draft with approval)
5. Dashboard placeholder (to be built with AG Studio from AG Grid in the next pass; plan for
   an `AG_STUDIO_LICENSE` env var and a watermark when it is missing)

## 4. Acceptance checks for this pass

- `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run prepublish-check` all
  pass locally and in CI on Node 20 and 22.
- Unit tests cover every new PayPal call (request method, path, headers incl.
  `PayPal-Request-Id`, body shape, error mapping with `debug_id`), the approval gate (state
  changing actions are refused without approval), rate limits, and each agent task with the
  `fake` provider.
- With `AI_PROVIDER=fake` and no PayPal variables, the server starts and the UI loads with an
  explanatory banner (no crash).
- README: replace the TODOs with a short product description, a judge walkthrough, the
  setup/run steps, env table (names only), the dated work log (append, newest last), the
  "Pre-existing components" table (every dependency you add, with license), and a section
  "How AI is used" naming the model provider(s) at runtime.
- `docs/DECISIONS.md` lists every decision you made that this spec left open.
- No real credentials, personal names, emails or local filesystem paths in tracked files
  (the pre-publish check must stay green).

## 5. Out of scope for this pass

Visual design polish, AG Studio dashboard, deployment config, demo video, second project.
