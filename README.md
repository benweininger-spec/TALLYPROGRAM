# Ciggy Bank

A one-person quit-smoking app, dressed as a 1950s newspaper. Every clean day banks
what a day of smoking used to cost. Banked money unlocks small, capped, long-only
stock trades through Alpaca. Every smoked day's money goes to a ghost portfolio of
what could have been. The v1 build spec is `PLAN.md`, the v2 design is described in
the handoff README it was built from, and `DECISIONS.md` says where the build departs
from either.

`legacy/` holds the old SB Forge inventory tally tool this repo used to be. It is
unused and kept only for reference.

## How it works

- **Now.** The front page. Every day since the quit date is clean or smoked. A day
  goes to press at local midnight: a clean day pays pack price × packs per day into
  the bank, a smoked day pays the same amount into the ghost. Today is pencilled in
  until then. The **editorial position** switch, I quit or I'm smoking, sets how each
  day is marked from today on. A **late report** marks today as smoked, or back to
  clean.
- **Calendar.** The X-effect index, a month at a time. Tap any past day to print a
  correction; its money moves between the bank and the ghost, so the two always add
  up to the full amount since the quit date.
- **The ghost.** Each smoked day's money is bought, on paper, at that day's close of a
  benchmark ETF (VOO unless you change it). It moves with the market and can never be
  spent. Change the benchmark and the whole ghost is repriced.
- **Trade.** Your bank unlocks tiers of $20, $50, $100, and $200. Pick a tier and a
  stock or ETF. The bank pays immediately and the order waits 24 hours before it goes
  to Alpaca. Cancel any time before then for a full refund. Positions cannot be sold
  for 7 days after the first fill; a sale sells the whole position and returns the
  proceeds to the bank. Each position shows its gain against keeping that money in
  the bank, in percent and dollars, and how long it has been held.
- **Ledgers.** Burned, yours, and could-have-been, charted daily since the quit
  date, with daily values and trade history. A fourth figure, **trading, net**, is
  what trading has added or cost against leaving every dollar in the bank: gains on
  what is held plus gains booked by sells.
- **The Market Page.** On Now, under the lead story: a morning edition written by
  Claude from the previous session's closes and headlines, with three rungs (an
  index fund, a sector fund, and a large company) each with a button that fills in
  the order form. Nothing is queued until you confirm, and the 24-hour cooldown
  still applies. Before the morning job runs, yesterday's page shows as a late edition.
- **The paper's own record.** At the foot of Ledgers, the Market Page keeps score on
  itself: $20 into each printed rung at the close of the day it ran, as three paper
  portfolios against a fourth, the mattress, which is the same $20 kept in the bank.
  A box score and a chart of each rung's return. These are the paper's picks, not
  your trades.
- **Settings.** Quit date, pack price, timezone, ghost benchmark, tiers, and the
  guardrails. Cooldown and hold can go up but never below 24 hours and 7 days. The $20
  to $200 range is fixed in code and in the database.

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
lib/rules.js    every calendar, banking, and trading rule, as pure functions
lib/service.js  one method per API call
lib/store/      Postgres store, plus an in-memory twin for tests and preview
lib/alpaca.js   Alpaca client; lib/broker-fake.js is its test double
supabase/migrations/  schema, row-level security, single-user lock
```

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. Open the SQL Editor and run every file in `supabase/migrations/`, in filename
   order. Or run `DATABASE_URL=... npm run migrate` locally.
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
evening, and writes the Market Page at 13:25 UTC on weekdays (see below). Opening the app also advances any trade whose 24 hours are up, so the cron is
a backstop. For a 15-minute cadence on the free plan, add repo secrets
`CIGGY_BANK_APP_URL` and `CIGGY_BANK_CRON_SECRET` to enable `.github/workflows/queue.yml`.

### The Market Page

Each weekday morning Claude writes a short edition from Alpaca's closes and headlines,
and offers three rungs from your universe. It reports; it never predicts.

1. Create an API key at console.anthropic.com and add it in Vercel as
   `ANTHROPIC_API_KEY` (Sensitive). Redeploy.
2. To print the first edition without waiting for the cron, call the job once:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://getciggybank.com/api/cron/market-page`
3. Edit the universe under Settings > The Market Page.

Without the key, or when Alpaca's data is down, the page runs a "presses down" notice
and the next run tries again. One short Claude call a day, two at most.

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
npm run dev     # http://localhost:3000: three weeks of fake data, fake broker, no sign-in
SEED=0 npm run dev   # the same, on day one
```

Tests run every rule and service path against both the in-memory store and a real
Postgres database, including concurrent taps and concurrent queue runs.
`TEST_DATABASE_ADMIN_URL` overrides the default `postgres://postgres:postgres@localhost:5432/postgres`.
