# Ciggy Bank

A one-person quit-smoking app. Every craving you beat banks money. Banked money
unlocks small, capped, long-only stock trades through Alpaca. The build spec is
`PLAN.md`; where the build deviates from it, `DECISIONS.md` says why.

`legacy/` holds the old SB Forge inventory tally tool this repo used to be. It is
unused and kept only for reference.

## How it works

- **Now.** Tap "I didn't smoke" when you beat a craving. Each tap banks $3, up to
  what you used to spend in a day. Past that cap, taps still count but bank nothing.
  "I smoked" logs a slip, resets the streak, and banks nothing.
- **Trade.** Your bank unlocks tiers of $20, $50, $100, and $200. Pick a tier and a
  stock or ETF. The bank pays immediately and the order waits 24 hours before it goes
  to Alpaca. Cancel any time before then for a full refund. Positions cannot be sold
  for 7 days after the first fill; a sale sells the whole position and returns the
  proceeds to the bank.
- **Ledgers.** A chart of what cigarettes would have burned against what you have now,
  bank plus stocks, with trade history.
- **Settings.** Pack price, quit date, tiers, and the guardrails. Cooldown and hold can
  go up but never below 24 hours and 7 days. The $20 to $200 range is fixed in code and
  in the database.

Orders are always market orders for a dollar amount, fractional shares, day only. No
shorting, margin, options, or crypto.

**The bank is bookkeeping, not a bank account.** In paper mode that doesn't matter.
Before going live, deposit at least your bank balance into the Alpaca account. A
simple routine is to transfer the bank balance once a month.

## Stack

Static page in `public/`, Vercel functions in `api/`, Supabase for Postgres and
magic-link sign-in, Alpaca for orders. No framework and no build step.

```
api/            HTTP endpoints, thin wrappers around lib/service.js
lib/rules.js    every banking and trading rule, as pure functions
lib/service.js  one method per API call
lib/store/      Postgres store, plus an in-memory twin for tests and preview
lib/alpaca.js   Alpaca client; lib/broker-fake.js is its test double
supabase/migrations/  schema, row-level security, single-user lock
```

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. Open the SQL Editor. Paste and run `supabase/migrations/0001_core.sql`, then
   `0002_single_user_rls.sql`. Or run `DATABASE_URL=... npm run migrate` locally.
3. Lock the app to your email:
   ```sql
   insert into private.app_config (allowed_email) values ('you@example.com');
   ```
   The email must be lowercase. Any other address is refused at sign-up by a
   database trigger.
4. Authentication > URL Configuration: set Site URL to your Vercel URL and add it to
   Redirect URLs.
5. Optional, for phones: Authentication > Emails > Magic Link, add `{{ .Token }}` to
   the template. The login screen then accepts the 6-digit code, which helps when the
   email link opens in a different browser than the app, such as a home-screen app.
6. Note the Project URL and anon key from Project Settings > API. From Connect, copy
   the Transaction pooler connection string, port 6543.

### 2. Alpaca paper account

1. Sign up at alpaca.markets with an email and password. The paper account needs no
   identity check and no money.
2. In the dashboard, switch to the Paper account, which starts with $100,000 of
   pretend cash.
3. Under API Keys, generate a key. Copy the key ID and the secret; the secret is shown
   once.

### 3. Vercel

1. Import this repo as a new project. Framework preset: Other. No build command.
2. Add every variable from `.env.example` in Project Settings > Environment Variables.
   Generate `CRON_SECRET` with `openssl rand -hex 32`.
3. Deploy. Open the URL, enter your email, and follow the link.

Vercel Cron runs the trade queue once each weekday morning and a snapshot each
evening. Opening the app also advances any trade whose 24 hours are up, so the cron is
a backstop. For a 15-minute cadence on the free plan, add repo secrets
`CIGGY_BANK_APP_URL` and `CIGGY_BANK_CRON_SECRET` to enable `.github/workflows/queue.yml`.

### 4. Going live

Only after at least two weeks on paper. Then:

1. Open and fund a live Alpaca account. Identity verification is required.
2. Generate live API keys.
3. In Vercel, set `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, and set `ALPACA_BASE_URL` to
   `https://api.alpaca.markets`. Redeploy.
4. The badge in the top corner turns red and reads LIVE.

Positions and fills from paper stay in the database and will look like live ones.
If you want a clean start, truncate `trade_requests` and `positions` before switching.

## Development

```
npm install
npm test        # needs a local Postgres for the database half; skips it otherwise
npm run dev     # http://localhost:3000 with fake data, fake broker, no sign-in
```

Tests run every rule and service path against both the in-memory store and a real
Postgres database, including concurrent taps and concurrent queue runs.
`TEST_DATABASE_ADMIN_URL` overrides the default `postgres://postgres:postgres@localhost:5432/postgres`.
