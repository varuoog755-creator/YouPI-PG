# Deploying YOUPI PG on Render (or any split-host platform)

This fork fixes the reverse proxies so the services can run as **separate hosts**.
The upstream code assumed every service runs on one machine on fixed ports, which
is why the admin panel returned `502 connect ECONNREFUSED 127.0.0.1:6100` when
deployed to Render.

## What was broken

The apps proxy requests between each other, but the target was hardcoded:

| File | Problem |
| --- | --- |
| `apps/merchant-admin/src/server.js` | `/api/*` proxy forced `127.0.0.1:$PAYMENT_API_PORT`, so `BASE_PAYMENT_API_URL` was stored but never used → **502** |
| `apps/merchant-admin/src/server.js` | Control-center proxy forced `127.0.0.1:$CONTROL_CENTER_PORT` → **502** |
| `apps/checkout-portal/src/server.js` | `/api/*` proxy forced `127.0.0.1:$PAYMENT_API_PORT` → **502** |
| `apps/checkout-portal/src/server.js` | `fetchPaymentState()` polled `127.0.0.1` → checkout state never loaded |
| `apps/coin-wallet-store/src/server.js` | `/checkout/*` reverse proxy forced `127.0.0.1:$CHECKOUT_PORT` → **502** |
| `apps/coin-wallet-store/src/server.js` | `/api/v1/*` proxy parsed the URL but always used plain `http` → failed against an HTTPS upstream |
| `apps/checkout-portal/src/sdk/youpi*.js` | Fallback assumed the portal is reachable at `hostname:7000`; hosted platforms expose one public port |
| `apps/gmail-observer/src/server.js` | Contained a hardcoded personal test domain (`gauravtesting.online`) in the API-base resolution |
| `apps/payment-api/src/routes/checkout.routes.js` | Observer health checks hardcoded `127.0.0.1` |
| `apps/payment-api/src/routes/admin.routes.js` | Gmail observer `/stop` call hardcoded `127.0.0.1` |

## What changed

- Added a `resolveUpstream(baseUrl, fallbackPort)` helper in each affected service.
  It parses a base URL, picks `http` or `https` accordingly, and derives the
  hostname/port/Host header. When the variable is missing it falls back to the
  original loopback behaviour, so **single-host local runs are unchanged**.
- Added `buildProxyHeaders()` which strips hop-by-hop headers (`connection`,
  `keep-alive`, `transfer-encoding`, …) before forwarding across hosts, and sets
  `Host` to the upstream plus `x-forwarded-host` / `x-forwarded-proto`.
- New environment variables (all optional, all default to previous behaviour):
  - `BASE_CONTROL_CENTER_URL` — merchant-admin → control center
  - `CHECKOUT_URL` for the store is `BASE_CHECKOUT_URL`
  - `SMS_OBSERVER_URL`, `GMAIL_OBSERVER_URL` — payment-api → observers
- Merchant admin now supports optional HTTP Basic Auth:
  `ADMIN_BASIC_AUTH_USER` + `ADMIN_BASIC_AUTH_PASS`. `/health` stays open for
  liveness probes. See the security note below.

## Security: the admin surface had no authentication

Worth being explicit: **the merchant admin UI and its `/api/*` proxy had no auth
at all.** The `.env.example` advertises `INITIAL_ADMIN_EMAIL`,
`INITIAL_ADMIN_PASSWORD`, `JWT_SECRET` and `ENCRYPTION_MASTER_KEY`, but none of
those variables are read anywhere in the code. A public Render URL therefore
exposed privileged payment operations to anyone.

Always set `ADMIN_BASIC_AUTH_USER` and `ADMIN_BASIC_AUTH_PASS` on the
`youpi-merchant-admin` service for any public deployment.

## Build command

These apps have **no `build` script**. Render's auto-detected build command is
`npm install; npm run build`, which fails with `npm error Missing script: "build"`.
Use:

- Build command: `npm install`
- Start command: `node src/index.js`
- Root directory: the app folder (`apps/payment-api`, etc.)

`render.yaml` in the repo root encodes all of this.

## Required environment variables

| Service | Variables |
| --- | --- |
| `youpi-payment-api` | `BASE_CHECKOUT_URL`, `BASE_ADMIN_URL`, `BASE_DEMO_STORE_URL` |
| `youpi-checkout` | `BASE_PAYMENT_API_URL` |
| `youpi-merchant-admin` | `BASE_PAYMENT_API_URL`, `BASE_CHECKOUT_URL`, `ADMIN_BASIC_AUTH_USER`, `ADMIN_BASIC_AUTH_PASS` |
| `youpi-showcase-store` | `BASE_PAYMENT_API_URL`, `BASE_CHECKOUT_URL` |

Every service also needs the shared secrets
(`ANDROID_ENROLLMENT_SECRET`, `YOUPI_WEBHOOK_SECRET`) to match, and the same
`SQLITE_DB_PATH` if you want all services on one database file.

## Free-tier limitations (not fixable in code)

1. **Services sleep.** Render's free tier idles out after ~15 minutes of no
   traffic; the first request after that takes 30–60s while the instance boots.
   A `healthCheckPath` does not prevent this on the free plan. Use a paid plan,
   or an external keep-warm pinger, if you need instant responses.
2. **SQLite resets on every deploy.** Free tier has no persistent disk, so
   `data/youpi_pg.sqlite` is lost on each deploy and does not survive. The code
   honours `SQLITE_DB_PATH`, so mounting a Render Disk at `/var/data` (paid) and
   setting `SQLITE_DB_PATH=/var/data/youpi_pg.sqlite` is the fix. Note that
   pointing every service at one SQLite file across separate hosts is not a
   supported topology — use one Postgres via `DATABASE_URL`-style external
   storage if you need multi-service shared persistence.
3. **`USE_SQLITE_FALLBACK` and `DATABASE_URL` are not read by the code.** They
   appear in `.env.example`, but `packages/db` uses `node:sqlite` exclusively.
   Setting them is harmless but currently a no-op.

## Not deployed here

The `sms-observer`, `gmail-observer`, `control-center`, and `payment-help`
services were not deployed. They are optional and the payment API degrades
gracefully without them — observer health checks fail fast and payment
verification then relies on the Android companion app pairing. If you deploy
them, point `SMS_OBSERVER_URL` / `GMAIL_OBSERVER_URL` /
`BASE_CONTROL_CENTER_URL` at those services.

## Local run (unchanged)

```bash
npm install
cp .env.example .env
npm run dev
```

With no `*_URL` variables set, every proxy falls back to loopback exactly as
before, so the single-host topology keeps working.