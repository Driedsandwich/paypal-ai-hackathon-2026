# Build log

## Pass 1: 2026-11-01 (spec v1, section 3)

Branch `claude/build-v1`. No pull request, nothing merged into `main`, no repository
settings or workflow changes (`.github/workflows/ci.yml` did not need changes).

### Result

- `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run prepublish-check`
  pass locally on Node 22. CI (Node 20 and 22) was green on the pushed commits checked so
  far; see the Actions tab for the latest run.
- **Tests: 44 before, 108 after** (4 → 9 test files).

### What I built (spec section 3)

| Spec item | Where | Status |
| --- | --- | --- |
| 3.1 Invoicing v2: create draft, send, remind, get, list, next number | `src/paypal/client.ts` | Done, unit-tested |
| 3.1 Payment link (Orders v2) + get order + capture | `src/paypal/client.ts`, `src/agent/tasks.ts` | Done |
| 3.1 Tracking: Orders `/track`, Add Tracking `trackers-batch` | `src/paypal/client.ts`, `src/paypal/carriers.ts` | Done |
| 3.1 Disputes: list, get, provide evidence (multipart), send message, accept claim | `src/paypal/client.ts` | Done (see open question 1) |
| 3.1 Webhook routing into an in-memory event log | `src/events/log.ts`, `src/server.ts` | Done |
| 3.1 Fresh `PayPal-Request-Id` per create/send; `debug_id` in errors | `src/paypal/client.ts`, `src/http/util.ts` | Done |
| 3.2 Providers `anthropic`/`google`/`openai`/`fake`, `AI_MODEL` | `src/ai/` | Done (real providers tested only with a mock model) |
| 3.2 Agent tasks 1-4 + free chat with tools | `src/agent/` | Done |
| 3.2 Server-enforced approval gate | `src/proposals/`, `/api/proposals/*` | Done |
| 3.2 Rate limit, daily cap, output-token cap, clear messages | `src/limits/`, `src/http/api.ts` | Done |
| 3.3 JSON API, input validation, `{ ok, data \| error }` | `src/http/` | Done |
| 3.4 Live reads from PayPal, seed demo data (approved), Japanese items | `src/http/api.ts`, `src/demo/items.ts` | Done |
| 3.5 `PAYMENT_PATH=invoice\|order` | `src/config.ts` and routes | Done |
| 3.6 UI shell with five views, banner, AG Studio watermark plan | `web/` | Done (minimal styling) |

Acceptance checks (section 4): unit tests cover every new PayPal call (method, path,
headers incl. `PayPal-Request-Id`, body, `debug_id` error mapping), the approval gate (unit
and over HTTP), rate limits (unit and over HTTP) and each agent task with the `fake`
provider. With `AI_PROVIDER=fake` and no PayPal variables the server starts and the UI loads
with the banner; I checked this in headless Chromium (screenshots not committed) and in
`test/api.test.ts`. README and `docs/DECISIONS.md` are updated.

### How I checked things

- PayPal shapes: against PayPal's official OpenAPI files (see DECISIONS 1), because
  developer.paypal.com is blocked from the build environment.
- Toolkit compatibility: installed `@paypal/agent-toolkit@1.11.0` with `ai@7.0.159` and
  `ai@6.0.320` in a scratch directory and ran its tools through a mock model (DECISIONS 3).
- Node 20: no local Node 20; checked the `engines` field of every installed package and relied
  on CI's Node 20 job.

### Skipped, and why

- **No calls against the real PayPal sandbox or a real AI model.** There are no credentials in
  this environment, and none should be added. Everything PayPal- and AI-facing is tested with
  fakes (recorded fetch, AI SDK mock model, offline provider).
- **No PNG attachment** for disputes, only a PDF invoice summary (the spec says PDF *or* PNG;
  PDF needs no dependency).
- **No browser tests of the PayPal flows** (approve buttons etc.). The UI was clicked through
  offline only; the same flows are covered at the HTTP level.
- **Hosted demo / deployment config, visual design, AG Studio dashboard, demo video:** out of
  scope (section 5).
- `@paypal/agent-toolkit`: not compatible (DECISIONS 3).

### Open questions for you

1. **Please allow `developer.paypal.com` in this environment's network settings** (or check by
   hand) so these can be confirmed against the official docs:
   - `provide-evidence`: the JSON part name `input` and the `evidences` wrapper;
   - `send-message`: JSON `{ "message" }` vs multipart;
   - `accept-claim`: whether `accept_claim_type` should be sent.
   The Add Tracking spec's `carrier` enum has no `OTHER` value, although its
   `carrier_name_other` description refers to it; I send `OTHER` for unknown carriers.
2. **Sandbox merchant country:** is the merchant sandbox account Japan-based? Please try one
   USD invoice. If it fails, set `PAYMENT_PATH=order` for the hosted demo, and the README line
   about the hosted path needs filling in.
3. **Default model and cost:** I set `claude-opus-5-5` as the Anthropic default. With the
   default caps (300 calls a day, at most 2000 output tokens, roughly 2k input tokens per call)
   the worst case is about USD 14 a day at list price (USD 4 / 20 per million input / output
   tokens); typical calls use far fewer output tokens. A cheaper model (for example
   `claude-haiku-5-5`) can be set with `AI_MODEL` if you prefer. Which do you want for the
   hosted demo?
4. **Google/OpenAI default ids** (`gemini-3.5-flash`, `gpt-5.4-mini`) are unverified. Keep or
   change?
5. **No login on the hosted demo:** any visitor can approve proposals, which act on the one
   sandbox merchant account. Fine for a sandbox demo, or do you want a simple demo passcode?
6. **Shipping:** invoices carry no shipping charge or shipping address yet (orders take the
   buyer's PayPal address). Should shipping be a separate invoice line?
7. **Abuse of the return URL:** `GET /paypal/return?token=…` queues a capture proposal (one per
   order id), and the in-memory store keeps at most 500 proposals, evicting finished ones first
   and then the oldest pending ones. Someone calling that URL with many fake tokens could push
   real pending proposals out. Acceptable for a sandbox demo, or should I check the order with
   PayPal before queueing?
8. **Product name:** "Okuri" is used as the working title in the UI and README. Keep it?

## Pass 2a (review fixes): 2026-11-01

Fixes for the independent public-demo review (findings F1-F13), following the owner's
decisions. Branch `claude/build-v1`, one commit per finding (in the order F5, F6, F13, F12,
F8, F1, F3, F10, F11, F4, F2, F9, F7) plus one follow-up and this docs commit. Nothing pushed,
remotes unchanged, no dependencies added. The web UI was not restyled; `web/` changed only
where a fix needed it (demo-mode notice, buyer alias picker instead of an email field, a
"Copy for DM" block, labels for the new statuses, reminder and dispute notes, a currency hint
and a PayPal-limits line).

### Result

- `npm run typecheck`, `npm test`, `npm run build`, `npm run prepublish-check` pass after
  every commit (Node 22 locally).
- **Tests: 108 before (9 files), 202 after (16 files).**
- The built server was started offline (`AI_PROVIDER=fake`, no PayPal) and checked with curl:
  the page load sets the session cookie (only on the HTML entry, never on cacheable assets),
  health shows the demo notice and limits, a listing
  draft works, `HEAD /paypal/return` returns 200 without a lookup, an unknown token shows
  "Payment not found".

### What changed, per finding

| Finding | Change | Where |
| --- | --- | --- |
| F1 public approval | Per-visitor demo sessions (httpOnly, SameSite=Lax, Secure on https cookie); proposals owned by the creating session; list/approve/reject see only your own (others: 404). Buyers chosen by alias (*Demo buyer N* from `DEMO_BUYER_EMAILS`), resolved to the address by the executor right before the PayPal call; anything else is refused. Payment links carry the resolved address as `payment_source.paypal.email_address`. Dispute actions only when currently allowed (F11). UI notice: "Demo mode: you act as the seller of a shared PayPal sandbox account." | `src/http/session.ts`, `src/demo/buyers.ts`, `src/proposals/store.ts`, `src/proposals/actions.ts`, `src/http/api.ts`, `src/agent/tools.ts`, `web/` |
| F2 limits | Per-session and per-address limits on proposal creation and approval (20/10 min), global daily cap on PayPal writes (100, reserved per proposal kind before execution), per-address PayPal read limit (60/10 min) plus a 30 s shared list cache, webhook limits (per address and global, before the body is read), seeding once per session per hour and a daily cap (10), execution concurrency 2. All env-configurable. | `src/limits/limits.ts`, `src/limits/demo-limits.ts`, `src/paypal/read-cache.ts`, `src/http/api.ts`, `src/server.ts` |
| F3 data exposure | Small public DTOs instead of PayPal objects; recipients by alias; other addresses masked (`m***@example.com`); every JSON response masked again in `sendJson`; proposals without owner id or base64. | `src/http/dto.ts`, `src/privacy/mask.ts`, `src/http/util.ts` |
| F4 return URL | Only order ids created here (bounded 3-day registry, mapped to the creating session); `HEAD` has no side effects; the order is fetched and a capture is queued only when `APPROVED`; "approved" text only then. Captures de-duplicated via the registry; the capture route also requires `APPROVED`. The store refuses new proposals when full of pending ones (plus a 50-per-address pending cap and 24 h expiry so this cannot lock the demo). | `src/http/paypal-return.ts`, `src/proposals/order-registry.ts`, `src/proposals/store.ts` |
| F5 client address | `TRUST_PROXY_HOPS` (default 0 = socket); N > 0 takes the N-th `X-Forwarded-For` entry from the right, validated and canonicalized, else the socket address. Render = 1 (README, `.env.example`). IPv6 limits keyed by /64. | `src/http/client-address.ts`, `src/config.ts` |
| F6 fake provider | Records requests only with the test option `{ record }`, in a bounded buffer. | `src/ai/fake-provider.ts` |
| F7 AI data | Emails, phone numbers and street-address-like lines redacted from free text before any model call (task inputs, chat messages, chat tool results); structured fields untouched. `create_invoice`/`create_order` take an alias. DECISIONS 8 rewritten with the real boundary. | `src/privacy/redact.ts`, `src/agent/json-task.ts`, `src/agent/tools.ts` |
| F8 deadlines | PayPal calls abort after 15 s, model calls after 45 s; `headersTimeout` 20 s, `requestTimeout` 30 s; at most 20 in-flight API/webhook/return requests. A timed-out PayPal write marks the proposal `unknown` ("needs checking", never retried); timed-out reads stay `failed`. Execution errors no longer echo internal messages. | `src/paypal/client.ts`, `src/ai/ai-sdk-provider.ts`, `src/server.ts` |
| F9 AI budget | `AI_DAILY_CAP` counts every model call (tool steps and repair retries); input is validated before the per-address allowance is debited; separate limit for invalid AI requests. | `src/limits/rate-limit.ts`, `src/ai/budget.ts`, `src/http/api.ts` |
| F10 reminders | Reminder proposals are "Send PayPal's standard reminder" (flags only); the AI text is a `copy_for_dm` shown to the seller, never sent; at most 2 reminders per invoice per day (skipped when proposing, `obsolete` at execution). New invoices keep the AI note in `invoice.detail.note`; no notification subject. The client's send/remind only send the flags. | `src/proposals/reminder-ledger.ts`, `src/agent/tasks.ts`, `src/paypal/client.ts`, `web/src/components.tsx` |
| F11 disputes | Proposals only for actions allowed now (message: stage `INQUIRY` + link; evidence: link; accept-claim: link or `allowed_response_options.accept_claim`); re-checked right before execution, else `obsolete` with a clear message. | `src/paypal/dispute-actions.ts`, `src/proposals/actions.ts`, `src/http/api.ts` |
| F12 money | 25 PayPal currencies; no decimals for JPY, HUF, TWD; integer minor units; per-currency formatting; invalid amounts refused (400) before a proposal exists. | `src/money.ts`, `src/agent/schemas.ts`, `src/agent/tasks.ts` |
| F13 webhooks | Separate 3-day de-duplication cache (bounded at 20,000, filled after verification); events without an id get 400 before any PayPal call; known redeliveries get 200 without re-verification. | `src/events/log.ts`, `src/paypal/webhook.ts` |

### How I checked things

- Dispute fields (`allowed_response_options`, `dispute_life_cycle_stage`, action descriptions)
  and `paypal_wallet.email_address` in PayPal's official OpenAPI files on GitHub; the
  Currency codes page on developer.paypal.com (reachable this time) for the 25 codes and the
  no-decimals footnote. The AI SDK source (`generateText` loop) for when `prepareStep` and
  `stopWhen` run.
- Every fix has unit and/or HTTP-level tests (cookie-aware test visitors for ownership).

### Not fixed, or only partly, and why

- **No calls against the real sandbox or a real model** (no credentials here, none added).
  Not verified live: the effect of `payment_source.paypal.email_address` on the checkout
  (expected: pre-filled login; DECISIONS 31), the exact rel names of dispute action links
  (matched by rel or path), and the `/send`/`/remind` behaviour without subject/note.
- **State is in memory and per process** (sessions' proposals, order registry, limit counters,
  reminder ledger, de-duplication ids). A restart clears them; several replicas would each
  enforce their own limits. A shared store was out of scope for a no-database demo.
- **Tracking proposals are not restricted to resources created by this demo.** A visitor can
  still propose tracking for any order/transaction id of the shared sandbox account (within
  the proposal, approval and write limits). The decided allowlist covered recipients and
  dispute actions only.
- **Redaction is pattern-based**: names are not detected, and an unusual number format can
  slip through or (rarely) a number such as an 11-digit tracking number starting with 070/080/090
  can be removed from chat text.
- **Accept-claim** still sends a note-only full refund (`accept_claim_type` not modeled), and
  evidence type selection is unchanged; both are outside the decisions.
- **AI SDK retries** after failed HTTP calls are not counted in the budget, and there is no
  total input-token cap across a chat (input stays bounded by 20 messages of 4,000 characters
  plus tool results).
- **Long executions keep a connection open** (a seed is up to 12 PayPal calls of at most 15 s
  each); `requestTimeout` only bounds receiving the request. The execution semaphore (2) and
  the in-flight cap (20) bound the total.
- Reminders sent outside the app are not counted by the 2-per-day ledger.

### Open questions for you

1. Keep `payment_source.paypal.email_address` on payment links (pre-fills the demo buyer at
   PayPal), or keep the alias only as app metadata?
2. Should tracking also be limited to invoices/orders created by this demo?
3. Are the default limits right for the hosted demo (20 proposals and 20 approvals per
   10 minutes per visitor, 100 PayPal writes and 10 seeds per day, 300 model calls per day)?
4. On the chosen host, please confirm that the platform proxy appends the client address to
   `X-Forwarded-For` (then `TRUST_PROXY_HOPS=1`).

Pass 1 open questions 5 (no login) and 7 (return URL abuse) are answered by F1 and F4.
