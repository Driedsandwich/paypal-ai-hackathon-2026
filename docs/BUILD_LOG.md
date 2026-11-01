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
7. **Product name:** "Okuri" is used as the working title in the UI and README. Keep it?
