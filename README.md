# Okuri: an AI export desk for small Japanese sellers

Entry for the PayPal AI Hackathon 2026 (Devpost). Built on the **PayPal REST APIs (sandbox)**
and an **AI agent** (Anthropic Claude by default; Google Gemini or OpenAI optional).

**Try it: <https://okuri.onrender.com>** (PayPal sandbox, Claude with Gemini as fallback). It
runs on Render's free plan: if nobody has used it for a while, the first page load takes
**about a minute** while the instance wakes up. The steps are in the
[judge walkthrough](#judge-walkthrough-about-5-minutes).

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
  Orders v2 (payment links as a fallback, capture, `/track`, also for invoice payments),
  Payments v2 (read a capture), Add Tracking v1 (`trackers-batch`, fallback for invoice
  payments), Customer Disputes v1 (list, get, provide evidence,
  send message, accept claim), Webhooks (signature verification).
- **AI part:** see [How AI is used](#how-ai-is-used).

## Hosted demo

**URL: <https://okuri.onrender.com>** (deployed from `render.yaml`; see
[Deploy on Render](#deploy-on-render)).

- Runs on Render's free plan with the PayPal **sandbox** and **Claude** (`claude-opus-5-5`,
  Anthropic API) as the AI model, with **Gemini** (Google AI Studio API) as an automatic
  fallback. The header shows both labels.
- **Waking up:** the free instance sleeps after about 15 minutes without visitors. The first
  page load then takes **about one minute** (a blank page or Render's loading screen); after
  that the app answers normally. Waking up also clears the in-memory state (your proposals
  and the activity log); invoices the app created are recognised again from PayPal.
- **No buyer login needed to try it:** the shared sandbox account already has paid sales from
  our own test (for example *OK-8789*, a tea bowl paid on 2026-11-01) and a sample dispute case
  (step 6 below). The sandbox buyer's login is not published. To pay invoices yourself, run
  the app with your own sandbox app and buyer (see [Run](#run)). Invoices from the hosted demo
  can only go to the configured demo buyers, shown as *Demo buyer 1, 2…*.
- No login: each browser gets its own demo session. Proposals you create are visible only in
  your browser; invoices on the shared sandbox account are visible to every visitor.

## Judge walkthrough (about 5 minutes)

1. **Open the app.** The home page is the **journey** of one sale: from the seller in Japan
   (left) to the buyer's country (right) in five steps: Draft, Invoice, Paid, Tracking,
   Delivered. The header shows **PayPal sandbox** and the AI model (**Claude**). The count
   strip shows how many sales are at each stage. *Previous / Next* switch between sales.
2. **New item:** pick a sample (for example 手作り 抹茶碗, a tea bowl), choose the buyer
   country and click *Draft English listing with AI*. You get an English title and
   description, item specifics, a USD price **estimate** (converted in code at
   `FX_JPY_PER_USD`), a customs line and an HS code candidate marked **check before use**.
3. Choose *Demo buyer 1* and click *Prepare invoice for approval*. You land on the journey at
   step 2 with a callout: the invoice total and **Approve**. *Review* opens the **Approvals**
   inbox, which lists every proposal across sales with the exact PayPal payload. Click
   **Approve**: the app creates the invoice with the Invoicing v2 API and PayPal emails it.
4. **Paid:** paying needs the sandbox buyer's login, which is not published. Use *Previous /
   Next* to open a sale our sandbox buyer already paid (for example *OK-8789*): the journey
   shows *Paid* and the next step, *Tracking*. With your own sandbox app and buyer (see
   [Run](#run)) you can pay the invoice yourself from PayPal's email; the journey then moves to
   *Paid* (the list is cached for up to 30 seconds; reload the page).
5. **Tracking:** on a paid sale (for example *OK-8789*), at step 4 enter a carrier
   (`Japan Post`) and a tracking number, click *Add tracking*, then **Approve**. The app registers the tracking with PayPal for this payment.
   Tracking can only be added to invoices and payment links this demo created.
6. **Dispute:** open **Disputes**, paste the sample case ID `PP-R-HNF-10195796` into the box
   at the top and click *Open a case by ID*. Our sandbox buyer opened this *item not received*
   case for sale *OK-8786* (a paid, tracked invoice) on 2026-11-01 (UTC), so that sale's journey also
   shows a dashed branch to **Evidence + reply**. Okuri built the evidence pack; PayPal refused
   the first evidence type (proof of fulfillment, `EVIDENCE_TYPE_IS_NOT_ALLOWED`), Okuri sent
   nothing and offered the same facts as an *OTHER* proposal, and after the seller's approval
   PayPal accepted it (with the PDF invoice summary attached) and moved the case to its own
   review (it may be closed by the time you read this). PayPal now offers the seller no action,
   so the app says so and shows the case read-only: *Build evidence pack with AI* still writes a
   summary, a timeline, an English reply and the evidence notes, and flags in red any date,
   amount or tracking number it cannot back up with PayPal's data, but there is nothing to
   approve. Only actions PayPal currently allows ever become proposals. (An earlier sample case,
   `PP-R-EMU-10195761`, is about a test order outside the demo and is not linked to a journey.)
   For a case of your own (your own sandbox app and buyer), open an *item not received* case in
   PayPal's Resolution Center and paste its **case ID** (it looks like `PP-R-ABC-12345678`):
   new sandbox cases can take a while (more than 3 minutes in our test) to appear in PayPal's
   dispute list, and *Open a case by ID* reads them at once (sooner when the dispute webhook is
   set up, see Setup).
7. **Insights:** revenue by buyer country, unpaid invoices and the dispute rate, built with
   AG Studio from the same sales.
8. *Ask Okuri* (footer link): free chat with the agent in Japanese or English; anything it
   wants to send becomes a proposal in Approvals.

**No PayPal at hand?** The offline demo (`PAYPAL_OFFLINE_DEMO=true`, see Run) gives every
browser six sample sales at different steps, with *Simulate buyer payment / dispute /
delivery* buttons in place of the buyer. Nothing reaches PayPal; the header says "offline".

## Built during the submission period

The submission period runs from 2026-10-01 to 2026-11-12 12:00 PT. Everything in this
repository was created during that period. Dated log of the work (newest last):

| Date (UTC) | Work |
| --- | --- |
| 2026-10-31 | Project scaffold: TypeScript/Node setup, PayPal REST client (OAuth token, Orders v2 create/capture, webhook endpoint with signature verification via the PayPal API), pluggable AI provider interface, tests with mocked PayPal responses, pre-publish check script, CI. |
| 2026-11-01 | Build pass 1 (spec v1): Invoicing v2, Add Tracking, Orders tracking and Customer Disputes calls; approval gate (server-side proposals); webhook event routing; AI agent (listing, invoice, reminders, dispute evidence pack, free chat) on the Vercel AI SDK with an offline fake provider; AI rate limits and daily cap; JSON API; minimal React UI with five views. |
| 2026-11-01 | Pass 2a (review fixes for the public demo): per-visitor demo sessions and proposal ownership; recipients only from the demo-buyer allowlist (by alias); public DTOs and email masking; limits on proposals, approvals, PayPal reads/writes, webhooks, seeding and execution; verified return page; deadlines and an "unknown" outcome for timed-out writes; AI budget per model call; redaction of contact details before AI calls; PayPal's standard reminders with a Copy-for-DM text; dispute actions only when PayPal allows them; currency precision; 3-day webhook de-duplication. |
| 2026-11-01 | Pass 2: visual design (S3 "transaction journey" structure with the A1 "paper & seal" look; layout table in `docs/design/LAYOUT_TABLE.md`); journeys API and sale registry; Approvals inbox; offline PayPal simulator (`PAYPAL_OFFLINE_DEMO`); tracking only for sales this demo created; AI fallback provider; Insights with AG Studio; Render Blueprint (`render.yaml`); screenshots in `docs/media/`. |
| 2026-11-01 | Pass 3a: dispute discovery. Cases are found from PayPal's list, verified dispute webhooks and *Open a case by ID* (a bounded in-memory registry), linked to their sale by the disputed transaction (invoice payment or order capture), with a clear state when PayPal offers the seller no action; tests use a recorded sandbox dispute shape. |
| 2026-11-01 | Pass 4 (after the first Render deploy): a missing AI key no longer stops startup (offline AI + banner, or no fallback); accept-claim only when PayPal offers its link; optional shipping on invoices ("Item + Shipping"); Insights' by-country Disputes column visible; README with the hosted URL and "AI tools used". |
| 2026-11-01 | Hosted demo on Render checked end to end against the real sandbox: invoices created, sent and paid in USD from a Japan-based sandbox merchant; a buyer dispute opened by its case ID and the seller's evidence submitted through the Disputes API after approval; demo video recorded from the hosted demo; README for judges. |
| 2026-11-01 | Pass 5 (after the hosted-demo checks): dispute evidence notes and replies sendable as is (seller to-dos listed separately, no claims of attachments that are not there); a refused evidence type offers a new OTHER proposal; the case is re-read after a dispute action; invoice notes with shipping state the total; a clear message when PayPal refuses Add Tracking for lack of permission. Pass 5b: tracking for invoice payments goes through Orders v2 `/track` on the order PayPal names for the payment (checked live on the hosted demo). |
| 2026-11-01 | Pass 6 (after a restart of the free hosting instance): journeys rebuilt from PayPal keep their titles (English from the invoice item, Japanese from the invoice's private memo) and show tracking registered with PayPal (read from the Orders v2 order behind the invoice payment), with a few cached PayPal reads at most per page load. |
| 2026-11-04 | Seal mark (owner's choice): the outline square next to the wordmark became a vermilion square stamp with a white 送 and a light stamped texture, so it no longer reads as a missing-glyph box or a checkbox; the same seal is the favicon. Screenshots in `docs/media/` retaken with `scripts/screenshots.mjs` (the `compare-*` images are kept as they were). |
| 2026-11-06 | MCP server (`src/mcp/server.ts`, `npm run mcp`): lets other AI agents use Okuri's JSON API as tools over stdio; writes stay proposals, approve and reject tools offered with `destructiveHint` so the client asks the person each time (`OKURI_MCP_ALLOW_APPROVE=0` removes them); `test/mcp.test.ts`; the server side is unchanged. |
| 2026-11-06 | Disputes after a restart: PayPal's sandbox list names only the buyer's transaction, so listed cases are read by id (a few per page load) and link to their journeys again; seller ids from a read by id are no longer overwritten by the list (decision 84). |

## Setup

Requirements: Node.js 20.19+ or 22.12+ (22 recommended), npm, and a free PayPal developer
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
   secret into `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`. Tracking for an invoice payment
   goes through Orders v2 `/track` on the order PayPal names for that payment (read from the
   capture); only when PayPal names no order does the app fall back to
   `POST /v1/shipping/trackers-batch`, which needs the app's shipping trackers permission (scope
   `https://uri.paypal.com/services/shipping/trackers/readwrite`; without it PayPal answers 403
   and the tracking proposal says so).
2. Note the sandbox **personal** (buyer) account emails and put them in `DEMO_BUYER_EMAILS`.
   Invoices and payment links can only be sent to these accounts (shown as *Demo buyer 1, 2, …*).
3. Optional: add a webhook for `https://<your-host>/webhooks/paypal` with the events
   `INVOICING.INVOICE.PAID`, `PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED` and
   `CUSTOMER.DISPUTE.UPDATED`, and put its id in `PAYPAL_WEBHOOK_ID`. With the dispute events
   the app learns about new cases before they appear in PayPal's dispute list.

## Run

```sh
npm run build                          # server (tsc) + UI (vite) into dist/
node --env-file=.env dist/server.js    # or: npm start (reads the real environment)
```

Open `http://localhost:3000`. The server listens on `PORT` (default 3000).

**Run it with your own sandbox app (judges):** create a sandbox REST app and a sandbox
personal (buyer) account in the PayPal developer dashboard, then put into `.env` at least
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DEMO_BUYER_EMAILS` (the buyer account's email)
and, for Claude, `AI_PROVIDER=anthropic` and `AI_API_KEY`. Leave `AI_PROVIDER` empty to use the
offline rule-based AI instead. Then `npm run build` and `node --env-file=.env dist/server.js`,
open `http://localhost:3000`, and follow the walkthrough above. Webhooks need a public URL
(optional; the app also reads the invoice status from PayPal).

**Offline demo (no keys at all):**

```sh
npm run build
PAYPAL_OFFLINE_DEMO=true node dist/server.js
```

Every browser gets a private, in-memory PayPal with six sample sales (one waiting for invoice
approval, one waiting for payment, one waiting for tracking approval, one shipped with an open
dispute, one delivered, one draft); Approvals starts with three proposals (that invoice, PayPal's
reminder for the unpaid sale, and the tracking). Approve, reject, prepare and *Simulate…* buttons all work;
nothing leaves the process. Screenshots: `node scripts/screenshots.mjs` (needs Playwright with
Chromium, not a project dependency) writes them to `docs/media/`.

### Deploy on Render

`render.yaml` is a Render Blueprint for one **free web service** (no database): build
`npm ci && npm run build`, start `npm start`, health check `/api/health`, Node 22
(`NODE_VERSION`), `TRUST_PROXY_HOPS=1`. In the Render dashboard choose *New → Blueprint*, pick
this repository, and fill in the values marked `sync: false` (PayPal client id and secret,
webhook id, AI keys, AG Studio licence, demo buyer emails, `PUBLIC_BASE_URL` = the service
URL, seller name). Without `AI_API_KEY` the server still starts, with the offline AI and a
banner that says so. Set `PAYPAL_OFFLINE_DEMO=true` to run the hosted demo without PayPal
credentials. The hosted demo at <https://okuri.onrender.com> was deployed from this Blueprint
on 2026-11-01 (Render's form rejects a pasted value whose name `render.yaml` already sets,
such as `PAYPAL_ENV` or `AI_PROVIDER`: leave those out when you paste an `.env`).

UI development with hot reload: run the server as above, then `npm run dev:web` (Vite on its
own port, proxying `/api` to port 3000).

### Payment path (invoice or payment link)

`PAYMENT_PATH=invoice` (default) uses the Invoicing v2 API. If the merchant sandbox account
cannot create invoices in USD (this can depend on the account's country), set
`PAYMENT_PATH=order`: the same flow then creates Orders v2 payment links (`payer-action`
link), the buyer is sent back to `/paypal/return`, and a capture proposal appears for the
seller to approve. The header and `/api/health` always show the path in use. The hosted demo
uses `PAYMENT_PATH=invoice` (`render.yaml`); on 2026-11-01 a Japan-based sandbox merchant
created, sent and was paid for USD invoices this way.

### HTTP API

JSON under `/api/`, every answer is `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "code", "message", … } }`. PayPal failures include PayPal's
`debug_id` (never request headers). POST bodies must be `application/json`, 64 KB max.

**Public demo mode.** There is no login. Each visitor gets a demo session (an httpOnly
`okuri_sid` cookie); proposals belong to the session that created them, and only that session
can list, approve or reject them. Buyers are chosen by alias (`{ "buyer": { "alias": "Demo
buyer 1" } }`); invoices and payment links can only go to `DEMO_BUYER_EMAILS`. Responses are
small DTOs with email addresses masked. Limits answer 429 (or 503 when busy) with
`Retry-After` and a clear message.

| Method and path | What it does |
| --- | --- |
| `GET /api/health` (also `/health`) | Configuration status, AI model, limits, banner messages |
| `GET /api/demo/items` | The sample items behind New item's quick-fill buttons |
| `POST /api/listings/draft` | AI: Japanese item → English listing (rate limited) |
| `POST /api/invoices/prepare` | AI: buyer note + invoice (or payment link) **proposal** for a demo buyer; optional `listing.shipping` (same currency as the price) becomes the invoice's shipping charge |
| `POST /api/payment-links/prepare` | AI: Orders v2 payment link **proposal** for a demo buyer |
| `GET /api/invoices`, `GET /api/invoices/{id}` | Live invoices from PayPal |
| `POST /api/invoices/nudge` | AI: **proposals** to send PayPal's standard reminder, each with a Copy-for-DM text |
| `GET /api/orders/{id}`, `POST /api/orders/{id}/capture` | Order status; capture **proposal** (orders created in your session, once PayPal reports `APPROVED`) |
| `POST /api/tracking` | Tracking **proposal** (`kind: "invoice"` with `invoice_id`, or `"order"`), only for invoices and orders this demo created |
| `GET /api/disputes`, `GET /api/disputes/{id}` | Disputes from PayPal's list plus cases the app knows from webhooks or by ID (`in_paypal_list`, linked `sale_id`); one case with what PayPal allows now (`seller_action_available`, `notice`) |
| `POST /api/disputes/open` | *Open a case by ID*: `{ "dispute_id": "PP-…" }`; reads the case from PayPal and remembers it for every visitor (10 lookups per 10 minutes per browser and per address, on top of the PayPal read limit) |
| `POST /api/disputes/{id}/evidence-pack` | AI: evidence pack + evidence and reply **proposals** (only for actions PayPal currently allows; read-only pack when it allows none) |
| `POST /api/disputes/{id}/accept-claim` | Accept-claim **proposal** (only when PayPal allows it) |
| `GET /api/proposals`, `POST /api/proposals/{id}/approve`, `…/reject` | The approval gate (your session's proposals only) |
| `GET /api/events` | Webhook event log (in memory) |
| `POST /api/demo/seed` | **Proposal** to create sample invoices/payment links for the demo buyers (once per hour per visitor) |
| `POST /api/chat` | AI: free chat with tools (rate limited) |
| `GET /api/journeys` | Sales (journeys) you can see, with steps, the callout for the current step, dispute branch, activity and counts |
| `POST /api/offline/simulate` | Offline demo only: act as the buyer (`payment`, `dispute`) or the carrier (`delivery`) for one of your sales |
| `POST /webhooks/paypal` | PayPal webhook receiver (signature verified via PayPal) |
| `GET /paypal/return`, `GET /paypal/cancel` | Pages the buyer lands on after approving or cancelling a payment link |

## Use Okuri from an AI agent (MCP)

Okuri also speaks the [Model Context Protocol](https://modelcontextprotocol.io), so another AI
(Claude Desktop, Claude Code, or any MCP client) can use it as a tool. The MCP server
(`src/mcp/server.ts`, stdio) is a thin client of the JSON API above: it calls the hosted demo
(or any Okuri you point it at) over HTTP and changes nothing on the server side. The same
validation, limits and approval gate apply to an AI agent as to a person in the web UI.

**What an agent can do.** Look at the seller's sales (`okuri_list_journeys`), draft an English
listing from a Japanese item (`okuri_draft_listing`), prepare an invoice (`okuri_prepare_invoice`),
prepare a tracking number (`okuri_add_tracking`), list disputes (`okuri_list_disputes`) and build
an evidence pack for one (`okuri_build_evidence_pack`), read the proposals
(`okuri_list_proposals`) and the server status (`okuri_health`).

**Safety.**

- Everything that would write to PayPal is a **proposal**. The prepare, add and build tools only
  create proposals; nothing reaches PayPal until a proposal is approved.
- The approval gate is the same for people and agents: the stored payload runs exactly as shown,
  in the session that created it. An agent cannot change a payload when it approves.
- `okuri_approve_proposal` and `okuri_reject_proposal` are offered so an agent can carry a sale
  end to end, and they are marked `destructiveHint: true`: clients that honor MCP hints (Claude
  Desktop, Claude Code) ask the person before each call. Set `OKURI_MCP_ALLOW_APPROVE=0` to
  remove them; then the agent prepares and the seller approves in the web UI.
- It is the PayPal sandbox (or the in-memory simulation): no real money moves.

**Set up.** Build once, then point the client at `dist/mcp/server.js` (use your own absolute path):

```sh
npm ci && npm run build
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "okuri": {
      "command": "node",
      "args": ["/path/to/paypal-ai-hackathon-2026/dist/mcp/server.js"],
      "env": { "OKURI_URL": "https://okuri.onrender.com" }
    }
  }
}
```

Claude Code:

```sh
claude mcp add okuri --env OKURI_URL=https://okuri.onrender.com -- node /path/to/paypal-ai-hackathon-2026/dist/mcp/server.js
```

| Variable | Meaning |
| --- | --- |
| `OKURI_URL` | The Okuri to use. Default `https://okuri.onrender.com`. The free instance can take about a minute to wake up; calls wait up to 120 seconds. |
| `OKURI_SESSION` | Optional. The value of the `okuri_sid` cookie of a browser session. Without it the server takes a new demo session from the site on the first call. |
| `OKURI_MCP_ALLOW_APPROVE` | `0` removes the approve and reject tools. Default: offered (marked destructive). |

**Work in the browser's session.** Each visitor has a private demo session, so an agent starting
fresh sees its own seeded sales. To let the agent work on the same sales as the browser: open
the demo, open the browser's developer tools, copy the value of the `okuri_sid` cookie
(Application or Storage tab, Cookies) into `OKURI_SESSION`, and restart the client. The
proposals the agent makes then appear in the browser's **Approvals** page, where the seller
reviews and approves them. Treat the value like a password for that session; it can approve
that session's proposals (sandbox only).

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
| `AI_FALLBACK_PROVIDER` | Optional second provider (`anthropic`, `google`, `openai`), used automatically when the primary fails, times out, is cut off by the output cap, or its daily budget is used up. Empty = no fallback. |
| `AI_FALLBACK_MODEL` | Model id for the fallback (default: that provider's default). |
| `AI_FALLBACK_API_KEY` | API key for the fallback provider (without it the fallback is skipped with a warning). |
| `AI_FALLBACK_DAILY_CAP` | Model calls per UTC day for the fallback provider (default 300). |
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
| `AG_STUDIO_LICENSE` | AG Studio licence key for the Insights dashboard. Empty runs AG Studio as a trial (a console message and a short "For Trial Use Only" watermark). The key is sent to the browser (AG Studio is a browser component). |
| `PAYPAL_OFFLINE_DEMO` | `true` = simulate PayPal in memory, a private world per browser; nothing reaches PayPal. For keyless demos and screenshots. Wins over the PayPal credentials. Default `false`. |
| `MAX_CONCURRENT_REQUESTS` | Concurrent in-flight API, webhook and return-page requests; more get 503 with `Retry-After` (default 20). |
| `PORT` | HTTP port (default 3000). |

## How AI is used

At runtime the model provider is chosen by `AI_PROVIDER`:

- **Anthropic Claude** (`anthropic`, default for the hosted demo; model `claude-opus-5-5`
  unless `AI_MODEL` says otherwise),
- **Google Gemini** (`google`) or **OpenAI** (`openai`),
- **fake**: a built-in, rule-based offline provider for tests and keyless demos. It is labelled
  "offline demo" everywhere it appears.

The hosted demo uses Claude (Anthropic API) as the primary model and Gemini (Google AI Studio
API key, `AI_FALLBACK_PROVIDER=google`) as the fallback. A missing key never stops the server:
without `AI_API_KEY` the offline provider answers and a banner says so; without
`AI_FALLBACK_API_KEY` the app runs without a fallback and `/api/health` says so (`ai.warnings`).

All real providers are called through the **Vercel AI SDK** (`ai` 6 with `@ai-sdk/*`).
With `AI_FALLBACK_PROVIDER` (for example `google`), a second provider answers automatically
when the primary errors, times out, is cut off by the output cap, or its daily budget
(`AI_DAILY_CAP`) is used up; the fallback has its own budget (`AI_FALLBACK_DAILY_CAP`). Every
AI answer carries `generated_by` (provider and model, plus `fallback_from` when the fallback
answered), and the UI shows which one wrote it ("Claude", or "Gemini · fallback").
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
   or id that is not in the inputs.
5. **Chat**: the model can call tools named like PayPal's agent toolkit (`list_invoices`,
   `get_dispute`, `send_invoice_reminder`, `create_shipment_tracking`, …). Read tools run;
   tools that would change something only create proposals.

**What the model sees.** Item text, listing text, invoice numbers, dates, amounts and item
names, dispute metadata, and free text (dispute messages, seller notes, chat messages and tool
results) **after redaction**: email addresses, phone numbers and street-address-like lines are
replaced by placeholders such as `[phone removed]` before any model call. Buyer email
addresses from PayPal records are never sent, and the chat agent picks buyers by alias (*Demo
buyer 1*). The redaction is pattern-based: names and unusual formats can slip through.

Every model answer must be JSON matching a schema (validated with zod, one retry). The
seller approves every action that reaches PayPal or a buyer. AI routes have a per-address
rate limit (counted after input validation), a separate limit for invalid requests, a daily
budget of model calls (each chat tool step and each retry counts) and an output-token cap
per call, with a clear message when a limit is hit. Model calls are aborted after 45 seconds.

## AI tools used

- **At runtime (in the app):** Claude through the Anthropic API is the primary model; Gemini
  through the Google AI Studio API is the automatic fallback. Both are called through the
  Vercel AI SDK. Details: [How AI is used](#how-ai-is-used). (OpenAI is supported by the code
  but not used on the hosted demo.)
- **To build the project:** AI coding agents helped. **Claude Code** (Anthropic) wrote the
  implementation and the fixes, working from written specs and reviews. **OpenAI Codex** made
  the visual design mockups (the reference images in `docs/design/`) and did an independent
  code review. The coding work is logged pass by pass in `docs/BUILD_LOG.md`, with the
  decisions in `docs/DECISIONS.md`. The coding agents are not part of the running app.

## Architecture

```
src/
  server.ts            node:http app: /api, /webhooks/paypal, /paypal/return, static UI
  config.ts            env -> settings (all optional)
  http/                JSON API routes, demo sessions, client address, public DTOs,
                       PayPal return page, error mapping, static file serving
  paypal/              REST client (fetch, no SDK): OAuth, Orders v2, Invoicing v2,
                       Add Tracking, Disputes, webhook verification; carrier mapping; types;
                       offline in-memory simulator
  proposals/           approval gate (ProposalStore), the executor (the only code that
                       calls PayPal write methods), order registry, reminder ledger
  ai/                  provider seam, Vercel AI SDK provider, offline fake provider
  agent/               the four agent tasks, chat tools, schemas, JSON runner, fact check
  events/              in-memory webhook event log and 3-day de-duplication cache
  limits/              AI limits and budget; limits on the shared PayPal account
  privacy/             email masking for responses, redaction before AI calls
  journeys/            sale registry and markers, journey view, offline PayPal worlds,
                       tracking allowlist, dispute-id registry and dispute linking
  money.ts             currencies, precision, integer minor units
  util/                bounded TTL map
  docs/simple-pdf.ts   tiny PDF writer for the evidence attachment
  demo/                Japanese sample items, demo buyers (aliases)
web/                   React UI (Vite), built to dist/public; Insights with AG Studio
scripts/               pre-publish scan of git-tracked files; screenshot script
render.yaml            Render Blueprint (free web service)
test/                  vitest tests (PayPal and AI faked; no keys needed)
docs/                  build spec, decisions, build log, media
```

No database: state the app owns (proposals, demo sessions' ownership, order registry, events,
de-duplication ids, limit counters, the dispute-id registry) is in memory and per process;
invoices and disputes are read live from PayPal (list reads cached for 30 seconds). Disputes
that PayPal's list does not return yet (known from a webhook or opened by ID) are read by id.

## Demo media

Screenshots of the offline demo at 1440×900 and 390×844 are in [`docs/media/`](docs/media/)
(`journey-*`, `approvals-*`, `new-item-*`, `disputes-*`, `insights-*`,
`journey-menu-open-mobile.png`). The design targets they were compared with are in
[`docs/design/`](docs/design/). The demo video (under three minutes, recorded from the hosted
demo) is linked from the Devpost submission.

## Pre-existing components

Third-party code, assets, APIs and services used by this project (anything not created
during the submission period). Dependencies added in this build are pinned to exact versions in
`package.json`; the scaffold's dev tools (`typescript`, `vitest`, `@types/node`) keep their caret ranges.

| Component | License / terms | How it is used |
| --- | --- | --- |
| PayPal REST APIs (sandbox) | PayPal developer agreement | Payments: invoicing, orders, tracking, disputes, webhooks |
| Anthropic API (Claude) | Anthropic commercial terms | Default AI model at runtime |
| Google Gemini API (Google AI Studio) | Google AI terms | Fallback AI model at runtime (hosted demo) |
| OpenAI API | OpenAI terms | Optional AI model at runtime |
| `ai` 6.0.320 (Vercel AI SDK) | Apache-2.0 | Calls the AI models, tool calling |
| `@ai-sdk/anthropic` 3.0.137 | Apache-2.0 | Anthropic provider for the AI SDK |
| `@ai-sdk/google` 3.0.140 | Apache-2.0 | Google provider for the AI SDK |
| `@ai-sdk/openai` 3.0.135 | Apache-2.0 | OpenAI provider for the AI SDK |
| `zod` 4.6.7 | MIT | Input and AI-output validation, tool schemas |
| `@modelcontextprotocol/sdk` 1.32.2 | MIT | MCP server (stdio) so other AI agents can use Okuri as a tool |
| `react` 19.3.1, `react-dom` 19.3.1 | MIT | Web UI |
| `vite` 8.3.5 (dev) | MIT | Builds the web UI (pulls in `lightningcss`, MPL-2.0, at build time only) |
| `@vitejs/plugin-react` 6.1.2 (dev) | MIT | React support for Vite |
| `typescript` 5.9.3 (dev) | Apache-2.0 | Type checking and server build |
| `vitest` 4.1.12 (dev) | MIT | Unit tests |
| `@types/node` 20.19.43, `@types/react` 19.3.0, `@types/react-dom` 19.3.0 (dev) | MIT | Type definitions |
| `ag-studio-react` 3.0.0, `ag-studio` 3.0.0 (with `ag-grid-enterprise`, `ag-grid-react`, `ag-charts-enterprise`, `ag-stack`) | Commercial (AG Grid EULA); runs as a trial without `AG_STUDIO_LICENSE` | Insights dashboard (embedded analytics) |
| `@fontsource/noto-sans-jp` 5.3.1, `@fontsource/noto-serif-jp` 5.3.1 (Noto Sans JP / Noto Serif JP by Google) | OFL-1.1 | Self-hosted UI fonts; the seal mark and favicon embed the outline of one glyph (送) from Noto Serif JP Bold |
| Render (free web service) | Render terms | Hosting of the demo |
| PayPal OpenAPI specifications (`paypal/paypal-rest-api-specifications`) | Reference only, not copied | Checked request/response field names |

`@paypal/agent-toolkit` was evaluated but is **not** used (see `docs/DECISIONS.md`).

## License

[MIT](LICENSE)
