# The Market Page: build spec

A daily edition, written by Claude from real Alpaca data, in the paper's voice. It
reports what happened yesterday and offers three rungs the reader could put a small
sum into. It does not predict, rate, or urge. The reader decides, and every existing
trading rule still applies.

The editorial contract is already built and tested in `lib/edition.js`. This file is
the handoff for the rest: the daily job, the Claude call, the data fetch, and the
page. Everything in "Done" is final unless it turns out to be impossible; note why in
`DECISIONS.md` and pick the nearest alternative rather than stopping.

## Done (Fable)

| Piece | Where | What it settles |
|---|---|---|
| Universe | `DEFAULT_UNIVERSE`, `validateUniverse` in `lib/edition.js` | Three rungs: index, sector, name. The ladder tops out at large boring companies. Editable in Settings as `market_universe`, validated. |
| Schema | `EDITION_SCHEMA` | The JSON the model must return. Use it as the structured-output format. |
| Voice | `SYSTEM_PROMPT`, `buildUserPrompt()` | The standing rule, the tone, the three-rung framing, and how the data is laid out for the model. |
| Spike | `validateEdition()`, `findForecastLanguage()` | Rejects a draft that names a ticker outside the universe or at the wrong rung, reuses a ticker, repeats yesterday's three, overruns a length, or uses forecast language anywhere. Returns the clean edition with `name` filled in per rung. |
| Footer | `STANDING_RULE` | Printed under every edition by the app, never written by the model. |
| Sample | `lib/edition-sample.js` | A hand-written edition in the voice. The demo serves it. It is also the tone reference. |
| Storage | `editions` table (migration applied to CIGGYBANK), `getEdition` / `putEdition` / `listEditions` on both stores | One row per day: `content`, the `universe` in force, `model`, `generated_at`, `spiked`. |
| Tests | `test/edition.test.js` | Every rule above. |

## To build (Opus)

### 1. Market data: `broker.getNews()` and a bars helper

- Add `getNews({ symbols, start, limit })` to `lib/alpaca.js` using Alpaca's news
  endpoint (`GET https://data.alpaca.markets/v1beta1/news`, same key headers as bars;
  params `symbols`, `start`, `limit`, `sort=desc`). Return
  `[{ source, at, headline, symbols }]`. Add a fake to `lib/broker-fake.js` that
  returns three or four plausible headlines for the universe.
- Reuse `getDailyBars` for closes. For each symbol in the universe, fetch the last 6
  trading days. One request per symbol is fine at this size; cap concurrency at 4.

### 2. The Claude call: `lib/llm.js`

- `npm install @anthropic-ai/sdk`. Node, ESM, same style as the rest of `lib/`.
- Export `writeEdition({ system, user, schema })` that calls
  `client.messages.parse` with:
  - `model: 'claude-opus-5-5'`
  - `output_config: { format: { type: 'json_schema', schema: EDITION_SCHEMA } }`
    (the SDK's `zodOutputFormat` helper needs Zod; a plain JSON-schema format object
    is fine here and avoids the dependency; check the installed SDK's structured
    outputs docs for the exact shape of a non-Zod format).
  - `max_tokens: 4000`, `output_config.effort: 'low'`. This is a short piece of
    writing from supplied facts; it does not need deep thinking.
  - `system` as a single text block with `cache_control: { type: 'ephemeral' }` so the
    long voice prompt is cached across days.
- Check `stop_reason` before reading content. On `refusal`, treat as a spiked draft.
- Return `{ draft: parsed_output, model, usage }`.
- `ANTHROPIC_API_KEY` is a new Vercel env var. Add it to `.env.example`.

### 3. The daily job: `service.writeEdition()`

In `lib/service.js`, next to `snapshot()`:

1. Settle days first (use `inTx` or `settleIfDue`), then load settings.
2. `day` is today in the reader's timezone. If `getEdition(day)` exists and is not
   spiked, return it; the job is idempotent.
3. Gather: `bars` for every universe symbol (last 6 sessions), `news` for the universe
   (last 24 hours, limit 20), `positions` from the store, `previous` =
   `getEdition(yesterday)?.content ?? null`.
4. `buildUserPrompt(...)`, call `writeEdition`, then `validateEdition(draft, { universe, previous })`.
5. On a `bad_edition` error, call Claude once more with the reason appended to the
   user prompt as `EDITOR'S NOTE: your previous draft was spiked because <reason>. Fix
   that and return the whole edition again.` Validate again.
6. If it fails twice, or the data fetch fails, store a fallback edition with `spiked`
   set to the reason: headline `PRESSES DOWN; MARKET PAGE TO RESUME TOMORROW`, deck
   `The editors regret the gap and have docked themselves nothing.`, one-paragraph
   report saying what was unavailable, rungs = the first ticker at each rung with the
   note `Chosen by default while the presses were down.` It must pass
   `validateEdition` too.
7. `putEdition({ day, content, universe, model, spiked })`.

Wire it into `api/cron/[job].js` as `market-page` and add a `vercel.json` cron at
`25 13 * * 1-5` (6:25am Pacific, before the open; the Hobby plan allows daily crons).
Opening the app does not trigger it; a missing edition shows yesterday's with a
"late edition" line.

Add `editions: { today, previous }` to `getState()` so the page needs no new
endpoint. Serverless function count is at 11 of 12; do not add a route.

### 4. The page

On Now, between the X-Effect Index and the classifieds on mobile, and in the story
column under the lead story on wide. Grid areas: add `market` to the three layouts in
`V()` in `public/app.js`.

- Kicker `THE MARKET PAGE · MORNING EDITION`, Franklin label style. If the edition is
  yesterday's, `LATE EDITION · YESTERDAY'S PAGE`.
- Headline in Caslon at the ghost-headline size, the deck in italic Old Standard, the
  report paragraphs justified like the story.
- Three rungs as a 1px ink gap-grid, one row each on mobile, three columns at wide:
  rung label (`THE INDEX`, `THE SECTOR`, `THE NAME`), the ticker in Caslon 24px, the
  company name muted, the note in Old Standard 13px, and a `QUEUE $20` outline button.
  The button goes to Trade with the lowest unlocked tier and that symbol prefilled
  (set `S.trade.tier` and `S.trade.symbol`, then `ACT.tab`). Disabled with `BANK MORE`
  when nothing is unlocked. In the demo it still navigates; queuing is refused as usual.
- Closing note in italic, then `STANDING_RULE` in 10px muted Franklin.
- Settings gets a "The Market Page" section: a textarea for the universe, one ticker
  per line as `SYMBOL rung Name`, saved as `market_universe`. Show validation errors
  from the server as they come.

### 5. Tests

- `lib/llm.js` is mocked in tests; never call Claude in `npm test`.
- Service tests with a fake `writeEdition`: idempotent per day; a draft naming a
  ticker outside the universe is retried once with the editor's note; two bad drafts
  store the fallback with `spiked` set; the universe snapshot stored is the one in
  force; `getState().editions.today` is the stored edition.
- A fake-broker `getNews` test.

## Constraints

- The model never sees anything but the universe, closes, headlines, the reader's
  position symbols, and yesterday's rungs. No balances, no names, no email.
- The page never auto-buys. The 24-hour cooldown, tiers, and hold rules are untouched.
- Serve the edition only to the signed-in owner and the demo (the sample). It is
  one person's paper, not advice to others.
- Cost: one short Claude call a day, a few thousand input tokens with the voice prompt
  cached. Well under a dollar a month.
