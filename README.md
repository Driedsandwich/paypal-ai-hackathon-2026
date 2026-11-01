# Okuri: an AI export desk for small Japanese sellers (working title)

Entry for the PayPal AI Hackathon 2026 (Devpost). Built on the **PayPal REST APIs (sandbox)**
and an **AI agent** (Anthropic Claude by default; Google Gemini or OpenAI optional).

## What it does

Small sellers in Japan (handmade crafts, used camera gear, collectibles) find overseas buyers
on social media, then stall on four chores: writing an English listing, asking for payment in
the buyer's currency, proving shipment, and answering a dispute in English. Okuri is a seller
cockpit where an AI agent does the paperwork and PayPal moves the money. The seller types the
item in Japanese. The agent drafts the English listing and a USD price, prepares a PayPal
invoice, records the tracking number with PayPal after shipping, and, when a buyer opens a
dispute, builds an evidence pack and drafts an English reply. **Nothing reaches a buyer or
PayPal until the seller clicks Approve**, and the server enforces that.

- **Main flow:** New item (Japanese) → AI listing + price estimate + customs line → invoice
  proposal → seller approves → PayPal sends the invoice → buyer pays (webhook) → seller adds
  tracking (approved) → if a dispute opens, AI evidence pack + reply (approved).
- **PayPal APIs used:** Invoicing v2 (create draft, send, remind, list, get, next number),
  Orders v2 (payment links as a fallback, capture, `/track`), Add Tracking v1
  (`trackers-batch`, for invoice payments), Customer Disputes v1 (list, get, provide evidence,
  send message, accept claim), Webhooks (signature verification).
- **AI part:** see [How AI is used](#how-ai-is-used).

## Judge walkthrough (about 5 minutes)

1. Open the app. The header shows which PayPal environment and which AI model are in use. A
   yellow banner explains anything that is not configured.
2. **New item:** pick a sample item (for example the tea bowl) and click *Draft English listing
   with AI*. You get an English title and description, item specifics, a USD price
   **estimate** (converted in code at `FX_JPY_PER_USD`), a plain customs description and an HS
   code candidate marked **check before use**.
3. Choose a demo buyer (for example *Demo buyer 1*) and click *Prepare invoice for approval*.
   A proposal card shows the Invoicing v2 payload (the buyer appears by alias) and the
   AI-written message to the buyer. Click **Approve and send**: the app creates the draft
   invoice and sends it through PayPal.
4. **Invoices:** the grid is read live from the sandbox. *Prepare reminders for unpaid
   invoices* creates one proposal per unpaid invoice to send **PayPal's standard reminder**
   (PayPal uses its own text; at most 2 per invoice per day). The AI writes a friendly
   message shown as **Copy for DM**, for the seller to send over social media.
5. Pay the invoice as the sandbox buyer. If a webhook is configured, `INVOICING.INVOICE.PAID`
   shows up under **Dashboard → PayPal webhook events**.
6. **Shipments:** enter the invoice id, carrier (for example `Japan Post`) and a tracking
   number, then approve. The app looks up the PayPal transaction and records the tracking.
7. **Disputes:** open a dispute as the sandbox buyer (Resolution Center), then *Open* it here,
   add the invoice id and tracking, and click *Build evidence pack with AI*. You get a summary,
   a timeline, a PDF invoice summary to attach, and an English reply. Any date, amount or
   tracking number the AI wrote that is not in the PayPal data is flagged in red. Only the
   actions PayPal currently allows become proposals (*Send reply* only while the dispute is an
   inquiry; *Provide evidence* only when PayPal asks for it). The app checks again right before
   sending; if the dispute has moved on, the proposal is marked *obsolete* and nothing is sent.
8. **Dashboard → Ask Okuri:** free chat (Japanese or English). The agent can look things up
   in PayPal; anything it wants to send becomes a proposal in the approvals panel.

## Built during the submission period

The submission period runs from 2026-10-01 to 2026-11-12 12:00 PT. Everything in this
repository was created during that period. Dated log of the work (newest last):

| Date (UTC) | Work |
| --- | --- |
| 2026-10-31 | Project scaffold: TypeScript/Node setup, PayPal REST client (OAuth token, Orders v2 create/capture, webhook endpoint with signature verification via the PayPal API), pluggable AI provider interface, tests with mocked PayPal responses, pre-publish check script, CI. |
| 2026-11-01 | Build pass 1 (spec v1): Invoicing v2, Add Tracking, Orders tracking and Customer Disputes calls; approval gate (server-side proposals); webhook event routing; AI agent (listing, invoice, reminders, dispute evidence pack, free chat) on the Vercel AI SDK with an offline fake provider; AI rate limits and daily cap; JSON API; minimal React UI with five views. |

## Setup

Requirements: Node.js 20.19 or later (22 recommended), npm, and a free PayPal developer
account (sandbox REST app with a client ID and secret). For a real AI model, an API key for
Anthropic, Google AI (Gemini) or OpenAI. Without any keys the app still runs offline.

```sh
git clone <this-repo-url>
cd paypal-ai-hackathon-2026
npm ci
cp .env.example .env   # then fill in the values (see below)
```

PayPal sandbox preparation:

1. In the PayPal developer dashboard, create a sandbox REST app and copy its client ID and
   secret into `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`.
2. Note the sandbox **personal** (buyer) account emails and put them in `DEMO_BUYER_EMAILS`.
   Invoices and payment links can only be sent to these accounts (shown as *Demo buyer 1, 2, …*).
3. Optional: add a webhook for `https://<your-host>/webhooks/paypal` with the events
   `INVOICING.INVOICE.PAID`, `PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED` and
   `CUSTOMER.DISPUTE.UPDATED`, and put its id in `PAYPAL_WEBHOOK_ID`.

## Run

```sh
npm run build                          # server (tsc) + UI (vite) into dist/
node --env-file=.env dist/server.js    # or: npm start (reads the real environment)
```

Open `http://localhost:3000`. The server listens on `PORT` (default 3000).

UI development with hot reload: run the server as above, then `npm run dev:web` (Vite on its
own port, proxying `/api` to port 3000).

### Payment path (invoice or payment link)

`PAYMENT_PATH=invoice` (default) uses the Invoicing v2 API. If the merchant sandbox account
cannot create invoices in USD (this can depend on the account's country), set
`PAYMENT_PATH=order`: the same flow then creates Orders v2 payment links (`payer-action`
link), the buyer is sent back to `/paypal/return`, and a capture proposal appears for the
seller to approve. The header and `/api/health` always show the path in use. **The hosted
demo is not deployed yet** (next pass); its path will be stated here once it is tested
against the sandbox account.

### HTTP API

JSON under `/api/`, every answer is `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "code", "message", … } }`. PayPal failures include PayPal's
`debug_id` (never request headers). POST bodies must be `application/json`, 64 KB max.

| Method and path | What it does |
| --- | --- |
| `GET /api/health` (also `/health`) | Configuration status, AI model, limits, banner messages |
| `POST /api/listings/draft` | AI: Japanese item → English listing (rate limited) |
| `POST /api/invoices/prepare` | AI: buyer message + invoice (or payment link) **proposal** |
| `POST /api/payment-links/prepare` | AI: Orders v2 payment link **proposal** |
| `GET /api/invoices`, `GET /api/invoices/{id}` | Live invoices from PayPal |
| `POST /api/invoices/nudge` | AI: reminder **proposals** for unpaid invoices |
| `GET /api/orders/{id}`, `POST /api/orders/{id}/capture` | Order status; capture **proposal** |
| `POST /api/tracking` | Tracking **proposal** (`kind: "invoice"` or `"order"`) |
| `GET /api/disputes`, `GET /api/disputes/{id}` | Live disputes from PayPal |
| `POST /api/disputes/{id}/evidence-pack` | AI: evidence pack + evidence and reply **proposals** |
| `POST /api/disputes/{id}/accept-claim` | Accept-claim **proposal** |
| `GET /api/proposals`, `POST /api/proposals/{id}/approve`, `…/reject` | The approval gate |
| `GET /api/events` | Webhook event log (in memory) |
| `POST /api/demo/seed` | **Proposal** to create sample invoices/payment links |
| `POST /api/chat` | AI: free chat with tools (rate limited) |
| `POST /webhooks/paypal` | PayPal webhook receiver (signature verified via PayPal) |

## Test

```sh
npm test                  # unit tests; PayPal and AI are faked, no keys or network needed
npm run typecheck         # TypeScript (server, tests and web UI)
npm run prepublish-check  # scan tracked files for secrets, local paths and emails
```

## Environment variables

See `.env.example`. Never commit `.env`. All are optional.

| Name | Description |
| --- | --- |
| `PAYPAL_CLIENT_ID` | Client ID of your PayPal REST app (developer dashboard). |
| `PAYPAL_CLIENT_SECRET` | Secret of that app. |
| `PAYPAL_ENV` | `sandbox` (default) or `live`. Selects `https://api-m.sandbox.paypal.com` or `https://api-m.paypal.com`. |
| `PAYPAL_WEBHOOK_ID` | ID of the webhook registered for the app; required to verify webhook signatures. |
| `PAYMENT_PATH` | `invoice` (default, Invoicing v2) or `order` (Orders v2 payment links). |
| `AI_PROVIDER` | `anthropic`, `google`, `openai` or `fake`. Empty means `fake` (offline, rule-based). |
| `AI_MODEL` | Model id. Defaults: `claude-opus-5-5` (anthropic), `gemini-3.5-flash` (google), `gpt-5.4-mini` (openai). |
| `AI_API_KEY` | API key for the chosen AI provider. |
| `AI_MAX_OUTPUT_TOKENS` | Max output tokens per AI call, thinking included (default 2000). |
| `AI_RATE_LIMIT_PER_IP` | Valid AI requests per client address per window, counted after input validation (default 20). |
| `AI_RATE_LIMIT_WINDOW_MINUTES` | Window for the per-address AI limits (default 10). |
| `AI_INVALID_RATE_LIMIT_PER_IP` | Invalid AI requests (bad input) per client address per window before the address is refused (default 20). |
| `AI_DAILY_CAP` | **Model calls** per UTC day for the whole server (default 300). Every chat tool step and every JSON repair retry counts. |
| `PROPOSAL_RATE_LIMIT` | New proposals per demo session and per client address per window (default 20). |
| `APPROVAL_RATE_LIMIT` | Approvals per demo session and per client address per window (default 20). |
| `PAYPAL_READ_RATE_LIMIT` | Requests that read from PayPal, per client address per window (default 60). |
| `RATE_LIMIT_WINDOW_MINUTES` | Window for the three limits above (default 10). |
| `PAYPAL_DAILY_WRITE_CAP` | PayPal write calls per UTC day for the whole server (default 100; an invoice costs 3: number, create, send). |
| `LIST_CACHE_SECONDS` | Seconds the invoice and dispute lists are cached, shared by all visitors (default 30; 0 disables). |
| `WEBHOOK_RATE_LIMIT` | Webhook requests per client address per minute (default 30). |
| `WEBHOOK_GLOBAL_RATE_LIMIT` | Webhook requests per minute for the whole server (default 120). |
| `SEED_SESSION_INTERVAL_MINUTES` | A demo session may run *Seed demo data* once per this many minutes (default 60). |
| `SEED_DAILY_CAP` | *Seed demo data* runs per UTC day for the whole server (default 10). |
| `EXECUTION_CONCURRENCY` | Approved actions that may run at the same time; more get 503 with `Retry-After` (default 2). |
| `FX_JPY_PER_USD` | Exchange rate for price estimates (default 150). |
| `SELLER_BUSINESS_NAME` | Seller name on invoices and the PayPal checkout page. |
| `PUBLIC_BASE_URL` | Public URL of the app, for PayPal return/cancel URLs (default `http://localhost:PORT`). |
| `DEMO_BUYER_EMAILS` | Sandbox buyer (personal) account emails, comma-separated. They are the **only** recipients invoices and payment links can go to; the UI and API show them as *Demo buyer 1, 2, …* and the address is added only at execution. |
| `TRUST_PROXY_HOPS` | Number of trusted proxies in front of the app (default 0 = use the socket address). With N > 0 the client address is the N-th `X-Forwarded-For` entry from the right, validated as an IP (falls back to the socket address). Behind a single platform proxy such as Render, set 1. |
| `AG_STUDIO_LICENSE` | AG Studio licence for the dashboard (next pass); empty shows a watermark. |
| `MAX_CONCURRENT_REQUESTS` | Concurrent in-flight API, webhook and return-page requests; more get 503 with `Retry-After` (default 20). |
| `PORT` | HTTP port (default 3000). |

## How AI is used

At runtime the model provider is chosen by `AI_PROVIDER`:

- **Anthropic Claude** (`anthropic`, default for the hosted demo; model `claude-opus-5-5`
  unless `AI_MODEL` says otherwise),
- **Google Gemini** (`google`) or **OpenAI** (`openai`),
- **fake**: a built-in, rule-based offline provider for tests and keyless demos. It is labelled
  "offline demo" everywhere it appears.

All real providers are called through the **Vercel AI SDK** (`ai` 6 with `@ai-sdk/*`).
The agent has four typed tasks and a chat entry point:

1. **draftListing**: Japanese item → English title, description, item specifics, a plain
   customs description and an HS code candidate (labelled "check before use"). The USD price
   is computed in code from `FX_JPY_PER_USD`, not by the model.
2. **prepareInvoice**: writes the buyer-facing note (sent in `invoice.detail.note`); the
   invoice JSON is built in code. On the payment-link path the note is a DM text.
3. **nudgeUnpaid**: a friendly DM text per unpaid invoice (only ids that exist are kept). The
   approved action sends PayPal's standard reminder; PayPal ignores custom reminder text.
4. **disputeEvidencePack**: summary, timeline, reply draft and evidence notes from PayPal's
   dispute data plus the seller's facts. A fact check flags any date, amount, tracking number
   or id that is not in the inputs. Buyer names and emails are not sent to the model.
5. **Chat**: the model can call tools named like PayPal's agent toolkit (`list_invoices`,
   `get_dispute`, `send_invoice_reminder`, `create_shipment_tracking`, …). Read tools run;
   tools that would change something only create proposals.

Every model answer must be JSON matching a schema (validated with zod, one retry). The
seller approves every action that reaches PayPal or a buyer. AI routes have a per-address
rate limit (counted after input validation), a separate limit for invalid requests, a daily
budget of model calls (each chat tool step and each retry counts) and an output-token cap
per call, with a clear message when a limit is hit. Model calls are aborted after 45 seconds.

## Architecture

```
src/
  server.ts            node:http app: /api, /webhooks/paypal, /paypal/return, static UI
  config.ts            env -> settings (all optional)
  http/                JSON API routes, error mapping, static file serving
  paypal/              REST client (fetch, no SDK): OAuth, Orders v2, Invoicing v2,
                       Add Tracking, Disputes, webhook verification; carrier mapping; types
  proposals/           approval gate (ProposalStore) and the executor, the only code that
                       calls PayPal write methods
  ai/                  provider seam, Vercel AI SDK provider, offline fake provider
  agent/               the four agent tasks, chat tools, schemas, JSON runner, fact check
  events/              in-memory webhook event log
  limits/              AI rate limit and daily cap
  docs/simple-pdf.ts   tiny PDF writer for the evidence attachment
  demo/items.ts        Japanese sample items
web/                   React UI (Vite), built to dist/public
scripts/               pre-publish scan of git-tracked files
test/                  vitest tests (PayPal and AI faked; no keys needed)
docs/                  build spec, decisions, build log, media
```

No database: state the app owns (proposals, events, rate-limit counters) is in memory;
invoices and disputes are always read live from PayPal.

## Demo media

Demo video and screenshots go in [`docs/media/`](docs/media/).

## Pre-existing components

Third-party code, assets, APIs and services used by this project (anything not created
during the submission period). Dependencies added in this build are pinned to exact versions in
`package.json`; the scaffold's dev tools (`typescript`, `vitest`, `@types/node`) keep their caret ranges.

| Component | License / terms | How it is used |
| --- | --- | --- |
| PayPal REST APIs (sandbox) | PayPal developer agreement | Payments: invoicing, orders, tracking, disputes, webhooks |
| Anthropic API (Claude) | Anthropic commercial terms | Default AI model at runtime |
| Google Gemini API | Google AI terms | Optional AI model at runtime |
| OpenAI API | OpenAI terms | Optional AI model at runtime |
| `ai` 6.0.320 (Vercel AI SDK) | Apache-2.0 | Calls the AI models, tool calling |
| `@ai-sdk/anthropic` 3.0.137 | Apache-2.0 | Anthropic provider for the AI SDK |
| `@ai-sdk/google` 3.0.140 | Apache-2.0 | Google provider for the AI SDK |
| `@ai-sdk/openai` 3.0.135 | Apache-2.0 | OpenAI provider for the AI SDK |
| `zod` 4.6.7 | MIT | Input and AI-output validation, tool schemas |
| `react` 19.3.1, `react-dom` 19.3.1 | MIT | Web UI |
| `vite` 8.3.5 (dev) | MIT | Builds the web UI (pulls in `lightningcss`, MPL-2.0, at build time only) |
| `@vitejs/plugin-react` 6.1.2 (dev) | MIT | React support for Vite |
| `typescript` 5.9.3 (dev) | Apache-2.0 | Type checking and server build |
| `vitest` 4.1.12 (dev) | MIT | Unit tests |
| `@types/node` 20.19.43, `@types/react` 19.3.0, `@types/react-dom` 19.3.0 (dev) | MIT | Type definitions |
| PayPal OpenAPI specifications (`paypal/paypal-rest-api-specifications`) | Reference only, not copied | Checked request/response field names |

`@paypal/agent-toolkit` was evaluated but is **not** used (see `docs/DECISIONS.md`).

## Before submitting

- [ ] Fill in the work log and demo media.
- [ ] `npm test` and `npm run prepublish-check` pass.
- [ ] Repository is public and contains `LICENSE`.
- [ ] Judges can run it from the Setup/Run steps with their own sandbox credentials.
- [ ] Hosted demo deployed; README states its payment path.

## License

[MIT](LICENSE)
