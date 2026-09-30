# Decisions

Where the build departs from `PLAN.md`, or fills a gap it left open.

## Direct Postgres instead of the service role key

The spec listed `SUPABASE_SERVICE_ROLE_KEY`. The server instead connects with
`DATABASE_URL` through Supabase's transaction pooler. Every write runs in one
transaction holding an advisory lock, so reading the bank, checking a rule, and
writing the result are atomic. Through the Supabase REST API that would need the rules
duplicated in SQL functions. Tests prove ten simultaneous taps cannot beat the daily
cap and two simultaneous buys cannot overspend the bank.

Auth still goes through Supabase: the server checks each token with Supabase Auth,
then compares the email to `ALLOWED_EMAIL`.

## Cron cadence

The spec asked for the queue every 15 minutes. Vercel's Hobby plan has historically
allowed only daily crons, and a more frequent schedule fails the deploy. I could not
confirm the current limit from this environment, so `vercel.json` uses daily
schedules that work on any plan. Correctness does not depend on cadence:

- Opening the app runs any due trades before showing state.
- `.github/workflows/queue.yml` hits the endpoint every 15 minutes in market hours once
  two repo secrets are set.
- On Vercel Pro, change the execute-queue schedule to `*/15 13-21 * * 1-5`.

## Queue safety

Each trade's Alpaca `client_order_id` is its own id. Claiming a due trade is one
atomic update, a duplicate submit is detected and looked up rather than failed, and
settling checks the trade is still unsettled. Running the queue twice at once, or
retrying after a timeout, never places a second order.

Alpaca's 400, 403, 404, and 422 responses are final: the trade is rejected and a buy is
refunded. Anything else, such as a timeout or a 5xx, leaves the trade to retry.

## Guardrails can tighten, not loosen

Settings are editable as the spec said, but cooldown cannot go below 24 hours, hold
cannot go below 7 days, and the minimum trade cannot go below $20. Letting the UI lower
them in a weak moment would undo the point of having them.

## Sells

The spec allowed sells after the hold but did not say how much. A sell always sells the
whole position, and it waits out the same cooldown as a buy, since panic selling is
also an impulse. The share count is fixed when the order is sent, not when requested.
Proceeds credit the bank on fill.

## Daily cap near the limit

When one full credit would pass the cap, the tap banks the remainder. With a $10 cap
and $3 credits the day banks $3, $3, $3, $1. The cap is never exceeded.

## Partial fills

If a buy order ends partially filled, the unfilled dollars return to the bank and the
position records what was actually bought. An order that fills nothing is a rejection
with a full refund.

## Days and streaks

- A `timezone` setting decides where each day starts. It defaults to the browser's
  zone on first run.
- Day count starts at 1 on the quit date.
- The streak counts days without a slip, including today. A slip today makes it 0.
- Burned is `pack price × packs per day × day count`. Changing pack price redraws the
  whole Burned line, which is intended: it is an estimate, not a record.

## Positions

The `positions` table tracks shares and cost from this app's own fills. Current prices
come from Alpaca's positions endpoint at read time. If Alpaca is unreachable, values
fall back to cost and the Trade screen says so. Use a dedicated Alpaca account: other
holdings in the same account are ignored by the app but share its buying power.

## Extras not in the spec

- `GET /api/config` gives the browser the Supabase URL and anon key, which are public
  by design. `GET /api/me` confirms who is signed in.
- The login screen also accepts the 6-digit email code, because a magic link on a phone
  often opens in a different browser than a home-screen app.
- With no Alpaca keys the app still runs. The bank works and trading reports that it is
  off. No base URL means paper, never live.
- `npm run dev` serves a seeded preview with fake data and no sign-in, for UI work.
- A GitHub Actions workflow runs the test suite against Postgres 16 on every push.
