# Ashes — build spec

A single-user app for Ben. Every cigarette craving he beats banks money. Banked money
unlocks real, capped, long-only stock trades. The point is to make the saved money feel
real and to make deploying it feel earned, without turning trading into the next habit.

This file is the spec for the builder agent. Decisions below are final unless they
turn out to be impossible; if one is, note why in `DECISIONS.md` and pick the nearest
alternative rather than stopping.

## Scope

Build features 1 through 4. Feature 5 (prediction markets) is deliberately excluded.

1. **Craving bank with earned tiers.** Each beaten craving credits a fixed amount to the
   bank. Bank thresholds unlock a trade of that size. Limits are earned, never chosen
   in the moment.
2. **Real brokerage, fractional, long-only.** Orders go to Alpaca. No shorts, margin,
   options, or crypto. Paper mode first; live is a config switch.
3. **Cooldown and commitment.** A trade request sits in a queue for 24 hours before it
   executes. Positions cannot be sold for 7 days after fill.
4. **Two ledgers.** "Burned" (what the money would have gone to as cigarettes, always
   trending to zero) versus "Yours" (bank plus portfolio value), on one chart.

## Stack

Match the shape of the old repo (static page plus Vercel functions), not a framework.

- **Frontend:** one static `public/index.html`, vanilla JS, no build step. Mobile first,
  it will be used on a phone during a craving. Dark theme by default.
- **API:** Vercel serverless functions in `api/`. Node 20, ESM.
- **Database:** Supabase Postgres. Migrations in `supabase/migrations/`. Row Level
  Security on, single user.
- **Auth:** Supabase Auth, email magic link. One allowed email, enforced by an RLS
  policy and a check in every API route. Nobody else can ever create an account.
- **Broker:** Alpaca Trading API. `ALPACA_BASE_URL` selects paper
  (`https://paper-api.alpaca.markets`) or live. Market data from Alpaca's data API.
- **Scheduler:** Vercel Cron hitting `api/cron/execute-queue` every 15 minutes during
  market hours, and `api/cron/snapshot` once daily after close.

Secrets (Vercel env vars, never committed): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `ALPACA_BASE_URL`,
`ALLOWED_EMAIL`, `CRON_SECRET`. Ship `.env.example` listing them.

## Configuration (stored in `settings` table, editable in the UI)

| key | default | meaning |
|---|---|---|
| `quit_date` | set on first run | day zero |
| `pack_price_cents` | 1200 | what a pack cost |
| `packs_per_day` | 1.0 | prior habit |
| `credit_per_craving_cents` | 300 | bank credit per beaten craving |
| `daily_credit_cap_cents` | computed | `pack_price * packs_per_day`; cravings past this still log but credit nothing |
| `tiers_cents` | `[2000, 5000, 10000, 20000]` | unlock sizes. Max trade is $200, hard-coded server-side as well |
| `cooldown_hours` | 24 | queue delay |
| `hold_days` | 7 | minimum hold before a sell is allowed |
| `min_trade_cents` | 2000 | hard floor, also server-side |

The daily cap matters. Without it the craving button becomes a money printer and the
bank stops meaning anything.

## Data model

```sql
settings        (key text pk, value jsonb, updated_at)
cravings        (id, occurred_at, beaten bool, credited_cents int, note text)
bank_ledger     (id, occurred_at, delta_cents int, kind enum('craving','trade_debit','trade_credit','adjust'), ref_id uuid null)
trade_requests  (id, created_at, symbol text, notional_cents int, side enum('buy','sell'),
                 execute_after timestamptz, status enum('queued','cancelled','submitted','filled','rejected'),
                 alpaca_order_id text null, filled_at, fill_price numeric, fill_qty numeric, reason text)
positions       (symbol pk, qty numeric, avg_cost numeric, first_fill_at timestamptz)  -- cache of Alpaca
snapshots       (day date pk, bank_cents int, portfolio_cents int, burned_cents int)
```

Bank balance is always `sum(bank_ledger.delta_cents)`. Never store it as a column.

## Rules engine (server-side, `lib/rules.js`, unit tested)

All of these run in the API, never trusted from the browser.

- A craving credits `credit_per_craving_cents` only if today's credited total is below
  `daily_credit_cap_cents`. Otherwise it logs with `credited_cents = 0`.
- A buy request is valid only if: `notional` is exactly one of the tiers, `notional <=
  bank balance`, `notional` is between the hard floor and hard ceiling ($20 to $200),
  and the symbol is a tradable, fractionable US equity or ETF per Alpaca's assets
  endpoint. Debit the bank immediately on request, credit it back on cancel or reject.
- `execute_after = created_at + cooldown_hours`. A request can be cancelled any time
  before it is submitted. Cancelling is free and is the intended escape hatch.
- A sell request is valid only if `first_fill_at + hold_days < now` for that symbol.
  Sell proceeds credit the bank ledger on fill.
- Order type is always `market`, time in force `day`, `notional` in dollars. Never
  `qty` for buys. Never `short`. Reject the request rather than clamp it.
- Cron picks up `queued` rows with `execute_after < now`, submits to Alpaca, marks
  `submitted`, then polls order status on later runs to mark `filled` or `rejected`.
  Outside market hours, submit anyway with `day` TIF and let Alpaca queue it.

## API routes

All routes require a Supabase session JWT in `Authorization: Bearer`, verified server
side, and the user's email must equal `ALLOWED_EMAIL`. Cron routes require
`CRON_SECRET` instead.

```
POST /api/craving            {beaten, note}            -> {credited_cents, bank_cents, today_credited_cents}
GET  /api/state                                         -> bank, unlocked tiers, positions, queue, streak, day count
POST /api/trade              {symbol, notional_cents, side}  -> trade_request row
POST /api/trade/cancel       {id}
GET  /api/symbol?q=          -> Alpaca asset lookup, returns tradable+fractionable only
GET  /api/history            -> snapshots for the chart
GET  /api/settings, PUT /api/settings
GET  /api/cron/execute-queue (CRON_SECRET)
GET  /api/cron/snapshot      (CRON_SECRET)
```

## UI (one page, four sections, bottom tab bar on mobile)

1. **Now.** Huge bank number. One full-width button: "I didn't smoke." Tap gives a
   short haptic-style animation and shows the credit, or "logged, cap reached today".
   Under it: day count since quit, current streak of days with zero smoked, and
   cravings beaten today. A second, small, grey button: "I smoked" (logs
   `beaten=false`, resets streak, credits nothing, no guilt copy).
2. **Trade.** Tier meter showing which of $20 / $50 / $100 / $200 are unlocked by the
   current bank. Symbol search. Pick a tier, confirm, request goes to the queue with a
   visible countdown. Queue list with cancel. Positions list with hold-lock countdown
   and a sell button that enables after 7 days.
3. **Ledgers.** Line chart, two series: "Burned" (cumulative `pack_price * packs_per_day
   * days`, drawn as what you would have lost, so it goes down from zero) and "Yours"
   (bank + portfolio). Use a tiny inline SVG chart, no chart library. Below it, the
   trade history table.
4. **Settings.** The table above, plus a paper/live badge that reads from the API so
   there is no doubt which one is active.

Copy tone: plain, no cheerleading, no streak-shaming. Numbers do the talking.

## Build order

Each step ends with something runnable. Commit after each.

1. Supabase migration, RLS, `ALLOWED_EMAIL` policy. Magic-link login page.
2. `lib/rules.js` with tests (node's built-in `node:test`). Cravings and bank ledger.
   The "Now" screen working end to end.
3. Alpaca client, symbol search, trade request + queue + cancel. Cron execute-queue.
   Paper mode only. The "Trade" screen.
4. Snapshot cron, ledgers chart, trade history.
5. Settings screen, `.env.example`, README with deploy steps, `vercel.json` cron config.

## Acceptance

- Cannot request a trade above bank balance, above $200, below $20, off-tier, for a
  non-fractionable symbol, or as a short. Each is a test.
- Cannot sell inside the hold window. Test.
- Daily credit cap holds. Test.
- Cancelling a queued request restores the bank exactly. Test.
- Switching `ALPACA_BASE_URL` is the only change needed to go live, and the UI badge
  reflects it.
- Works on a phone in a dark room with one thumb.

## Out of scope

Multi-user, social features, notifications, options, crypto, leverage, any form of
recommendation or "hot stocks" surface, streak rewards beyond the number itself.
