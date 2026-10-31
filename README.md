# paypal-ai-hackathon-2026

Entry for the PayPal AI Hackathon 2026 (Devpost). Work in progress.

## What it does

> TODO: one-paragraph description of the project (problem, who it is for, how PayPal and AI are used).

- TODO: main user flow
- TODO: which PayPal APIs are used and why
- TODO: what the AI part does

## Built during the submission period

The submission period runs from 2026-10-01 to 2026-11-12 12:00 PT. Everything in this
repository was created during that period. Dated log of the work (newest last):

| Date (UTC) | Work |
| --- | --- |
| 2026-10-31 | Project scaffold: TypeScript/Node setup, PayPal REST client (OAuth token, Orders v2 create/capture, webhook endpoint with signature verification via the PayPal API), pluggable AI provider interface, tests with mocked PayPal responses, pre-publish check script, CI. |

## Setup

Requirements: Node.js 20.6 or later (for `--env-file`), npm, a free PayPal developer account
(sandbox app with a client ID and secret).

```sh
git clone <this-repo-url>
cd paypal-ai-hackathon-2026
npm ci
cp .env.example .env   # then fill in the values (see below)
```

## Run

```sh
npm run build
node --env-file=.env dist/server.js
```

The server listens on `PORT` (default 3000):

- `GET /health` – liveness check, shows the PayPal environment in use
- `POST /webhooks/paypal` – PayPal webhook receiver (signature verified via PayPal)

> TODO: app routes and a short walkthrough for judges once the project is chosen.

## Test

```sh
npm test                  # unit tests; PayPal is mocked, no keys or network needed
npm run typecheck         # TypeScript type check
npm run prepublish-check  # scan tracked files for secrets, local paths and emails
```

## Environment variables

See `.env.example`. Never commit `.env`.

| Name | Description |
| --- | --- |
| `PAYPAL_CLIENT_ID` | Client ID of your PayPal REST app (developer dashboard). |
| `PAYPAL_CLIENT_SECRET` | Secret of that app. |
| `PAYPAL_ENV` | `sandbox` (default) or `live`. Selects `https://api-m.sandbox.paypal.com` or `https://api-m.paypal.com`. |
| `PAYPAL_WEBHOOK_ID` | ID of the webhook registered for the app; required to verify webhook signatures. |
| `AI_PROVIDER` | AI provider name. Empty or `fake` uses the built-in fake provider. |
| `AI_API_KEY` | API key for the chosen AI provider. |
| `PORT` | Optional HTTP port (default 3000). |

## Architecture

```
src/
  server.ts          node:http server (health + webhook routes)
  paypal/
    config.ts        env -> config, sandbox/live base URL
    client.ts        PayPal REST via fetch: OAuth token (cached until expiry),
                     Orders v2 create/capture, verify-webhook-signature
    webhook.ts       framework-free webhook handler (parse -> verify -> onEvent)
  ai/
    provider.ts      AiProvider interface (the only thing callers depend on)
    fake-provider.ts deterministic provider for tests/offline demos
    http-provider.ts template for a real provider (fetch, no vendor SDK)
scripts/
  prepublish-check.mjs  pre-publish scan of git-tracked files
test/                vitest tests (fetch is replaced by a fake; no keys needed)
docs/media/          demo video and screenshots
```

PayPal is called through its public REST API with `fetch` (no SDK). The only runtime
dependency is Node itself; dev dependencies are TypeScript, vitest and Node types.

## Demo media

Demo video and screenshots go in [`docs/media/`](docs/media/).

## Pre-existing components

Third-party code, assets, APIs and services used by this project (anything not created
during the submission period). Added as they are used.

| Component | License / terms | How it is used |
| --- | --- | --- |
| | | |

## Before submitting

- [ ] Fill in the TODO sections above and the work log.
- [ ] `npm test` and `npm run prepublish-check` pass.
- [ ] Repository is public and contains `LICENSE`.
- [ ] Judges can run it from the Setup/Run steps with their own sandbox credentials.

## License

[MIT](LICENSE)
