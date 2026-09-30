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

## Partial fills

If a buy order ends partially filled, the unfilled dollars return to the bank and the
position records what was actually bought. An order that fills nothing is a rejection
with a full refund.

## Days and streaks

- A `timezone` setting decides where each day starts. It defaults to the browser's
  zone on first run.
- Day count starts at 1 on the quit date.
- The streak counts clean days back from today, including today's pencilled mark.
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

## v2: calendar, ghost, and the newspaper redesign

The v2 design handoff made most calls already: no craving button, clean days bank
automatically at midnight, month-view calendar, one state per day, a VOO ghost bought
at each smoked day's close, paper theme only. These are the calls it left open.

- **Settlement is lazy, not a midnight job.** A past day settles the first time
  anything reads or writes after it ends (opening the app, a cron, a trade). All
  settling runs under the write lock and rechecks inside it, so racing requests settle
  each day once. A day that settles while nobody opened the app takes the editorial
  position in force at the time, which is the one the user last chose.
- **A day keeps the amount it settled with.** Changing pack price only affects days
  that settle afterwards. The invariant tested is therefore
  bank 'day' entries + ghost lot cents = sum of settled day amounts, which equals
  daily × settled days while the price is unchanged.
- **Corrections may take the bank below zero.** If the money for a day was already
  spent on a trade and the day is then corrected to smoked, the bank shows a negative
  balance until clean days refill it. Blocking the correction would make the record
  lie to protect the balance.
- **Moving the quit date later** takes the money for the dropped days back out of the
  bank and the ghost. Moving it earlier settles the added days under the current
  position.
- **Old craving credits are cancelled by the server**, not the migration. v2 pays
  each clean day in full, which covers what the taps used to bank; keeping both would
  count the same day twice. On any write, the server books one 'adjust' entry against
  whatever craving credit is not yet cancelled, marked with a fixed reference so it
  never repeats. That also catches taps made on the live v1 app after the migration
  but before v2 deploys. The craving rows stay.
- **Ghost prices** come from Alpaca's daily bars, split-adjusted, cached per calendar
  day in `price_closes`. Weekends and holidays use the last close. Only closes that
  are final (before today in New York) are cached. A lot whose close is not known yet
  counts at cost until it is. The current value uses the latest IEX trade price.
  Dividends are ignored.
- **History recomputes day money from the marks as they stand**, so a correction
  redraws the chart retroactively, as the design asks. Trades and stock values are as
  recorded: stocks come from daily snapshots, carried forward with that day's fills on
  days without one, and a buy counts as yours from the moment the bank pays until it
  fills or is refunded.
- **"Yours" includes queued buys.** The bank pays when an order is queued, so without
  this the figure would dip for a day on every trade.
- **"$12" in the copy is the real daily amount.** Every place the design says $12 or
  "twelve dollars" uses pack price × packs per day, spelled out in words where the
  design does and the amount is whole dollars under $100.
- **Real trading stays.** The design's Trade screen is a static mock. The real search,
  confirm step, queue with countdown and cancel, and two-tap sell are restyled into
  it. Sellable positions show a Sell all button where the mock printed "Sellable".
- **Toast centering** uses auto margins instead of `left:50%` with a transform, so a
  long message is not squeezed into half the screen width.
- **Box sizing** follows the prototype: it has no global border-box reset, so its
  bordered 18px and 30px squares render at 22px and 32px. The build matches that.
- **Chart colors** are the design's navy, red, and ghost gray. The palette validator
  flags navy as darker than its lightness band and the two quiet colors as low-chroma;
  its separation checks (color-blind, normal vision, contrast) pass. The ghost line is
  also dashed, every series has a legend key, and the daily table carries every value.
- **Broker line in Settings** has three variants: paper (the design's copy), live
  ("Real money, real feelings."), and no keys ("No keys, no feelings.").
