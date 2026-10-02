// The Market Page's daily job, with a fake writer: Claude is never called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachStore } from './helpers/stores.js';
import { makeService } from '../lib/service.js';
import { makeFakeBroker } from '../lib/broker-fake.js';
import { BrokerError } from '../lib/alpaca.js';
import { RuleError } from '../lib/errors.js';
import { SAMPLE_EDITION } from '../lib/edition-sample.js';
import { validateEdition, STANDING_RULE, SYSTEM_PROMPT, EDITION_SCHEMA } from '../lib/edition.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const at = (iso) => new Date(iso);
const draft = (rungs = {}) => {
  const d = clone(SAMPLE_EDITION);
  for (const [r, symbol] of Object.entries(rungs)) d.rungs[r].symbol = symbol;
  return d;
};

// A writer that hands back the given drafts (or throws the given errors) in
// order, and remembers what it was asked.
function fakeWriter(...replies) {
  const calls = [];
  const writer = async (args) => {
    calls.push(args);
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return { draft: r, model: 'claude-test', usage: { input_tokens: 1, output_tokens: 1 } };
  };
  writer.calls = calls;
  return writer;
}

forEachStore('market page', (ctx) => {
  let now, broker;
  async function setup(writer, opts = {}) {
    now = at(opts.at ?? '2026-10-06T13:25:00Z'); // a Tuesday, 6:25am Pacific
    broker = opts.broker === null ? null : makeFakeBroker({ autoFill: true, clock: () => now });
    const svc = makeService({ store: ctx.store, broker, clock: () => now, writer });
    await svc.ensureInitialized('America/Los_Angeles');
    return svc;
  }
  const stored = (day) => ctx.store.run((r) => r.getEdition(day));

  test('writes today’s edition from the data, once; state carries it', async () => {
    const writer = fakeWriter(draft());
    const svc = await setup(writer);
    await ctx.store.tx((r) => r.insertLedger({ occurred_at: now, delta_cents: 5000, kind: 'adjust' }));
    await svc.requestTrade({ symbol: 'AAPL', side: 'buy', notional_cents: 2000 });
    now = at('2026-10-07T13:25:00Z');
    await svc.processQueue();
    const r = await svc.writeEdition();
    assert.equal(r.status, 'written');
    assert.equal(r.day, '2026-10-07');
    assert.equal(r.attempts, 1);
    assert.equal(writer.calls.length, 1);

    const { system, user, schema } = writer.calls[0];
    assert.equal(system, SYSTEM_PROMPT);
    assert.equal(schema, EDITION_SCHEMA);
    assert.match(user, /^Edition date: 2026-10-07\./);
    assert.match(user, /index: VOO \(Vanguard S&P 500 ETF\)/);
    // The last six sessions through yesterday, per ticker.
    const line = user.split('\n').find((l) => l.startsWith('  COST:'));
    assert.equal(line.split('|')[0].split(',').length, 6);
    assert.match(line, /2026-10-06 /);
    assert.doesNotMatch(user, /2026-10-07 \d/);
    assert.match(user, /Reuters .*Costco monthly sales rise 6%.* \[COST\]/);
    assert.match(user, /THE READER HOLDS: AAPL\./);
    // Never balances, never names.
    assert.doesNotMatch(user, /\$|bank|cents|owner|@/i);

    const e = await stored('2026-10-07');
    assert.equal(e.spiked, null);
    assert.equal(e.model, 'claude-test');
    assert.deepEqual(e.content, validateEdition(draft()));
    const st = await svc.getState();
    assert.deepEqual(st.editions.today.content, e.content);
    assert.equal(st.editions.today.day, '2026-10-07');
    assert.equal(st.editions.standing_rule, STANDING_RULE);

    const again = await svc.writeEdition();
    assert.equal(again.status, 'exists');
    assert.equal(writer.calls.length, 1);
  });

  test('stores the universe in force, and the page may only print from it', async () => {
    const custom = [{ symbol: 'VTI', rung: 'index' }, { symbol: 'XLV', rung: 'sector' }, { symbol: 'JNJ', rung: 'name' }];
    const writer = fakeWriter(draft(), draft({ index: 'VTI', sector: 'XLV', name: 'JNJ' }));
    const svc = await setup(writer);
    await svc.updateSettings({ market_universe: custom });
    const r = await svc.writeEdition();
    assert.equal(r.status, 'written');
    assert.equal(r.attempts, 2);
    assert.match(writer.calls[1].user, /EDITOR'S NOTE: your previous draft was spiked because rungs.index: VOO is not in the universe\. Fix that and return the whole edition again\.$/);
    const e = await stored('2026-10-06');
    assert.deepEqual(e.universe.map((u) => u.symbol), ['VTI', 'XLV', 'JNJ']);
    assert.equal(e.content.rungs.name.symbol, 'JNJ');
    // Only the universe's tickers were fetched.
    const fetched = new Set(broker.calls.filter((c) => c[0] === 'getDailyBars').map((c) => c[1]));
    assert.ok(['VTI', 'XLV', 'JNJ'].every((s) => fetched.has(s)));
    assert.ok(!fetched.has('COST'));
  });

  test('a draft outside the universe is retried once with the editor’s note', async () => {
    const writer = fakeWriter(draft({ name: 'TSLA' }), draft());
    const svc = await setup(writer);
    const r = await svc.writeEdition();
    assert.equal(r.status, 'written');
    assert.equal(writer.calls.length, 2);
    assert.ok(writer.calls[1].user.startsWith(writer.calls[0].user));
    assert.match(writer.calls[1].user, /spiked because rungs.name: TSLA is not in the universe/);
  });

  test('two bad drafts run the fallback, which passes the paper’s own rules; the next run tries again', async () => {
    const forecast = draft();
    forecast.deck = 'Analysts expect more of the same.';
    const writer = fakeWriter(draft({ name: 'TSLA' }), forecast, draft());
    const svc = await setup(writer);
    const r = await svc.writeEdition();
    assert.equal(r.status, 'spiked');
    assert.match(r.spiked, /^Spiked twice: deck: reads as a forecast/);
    const e = await stored('2026-10-06');
    assert.match(e.spiked, /reads as a forecast/);
    assert.equal(e.model, 'fallback');
    assert.equal(e.content.headline, 'PRESSES DOWN; MARKET PAGE TO RESUME TOMORROW');
    assert.equal(e.content.deck, 'The editors regret the gap and have docked themselves nothing.');
    assert.match(e.content.report[0], /Both drafts were spiked/);
    // Postgres keeps jsonb keys in its own order; read the rungs by name.
    assert.deepEqual(['index', 'sector', 'name'].map((k) => e.content.rungs[k].symbol), ['VOO', 'XLK', 'AAPL']);
    assert.ok(Object.values(e.content.rungs).every((p) => p.note === 'Chosen by default while the presses were down.'));
    assert.deepEqual(validateEdition(e.content), e.content);

    const retry = await svc.writeEdition();
    assert.equal(retry.status, 'written');
    assert.equal((await stored('2026-10-06')).spiked, null);
  });

  test('a declined draft counts as spiked; an API failure goes straight to the fallback', async () => {
    let writer = fakeWriter(new RuleError('bad_edition', 'the draft was declined by the writer'), draft());
    let svc = await setup(writer);
    assert.equal((await svc.writeEdition()).status, 'written');
    assert.match(writer.calls[1].user, /spiked because the draft was declined/);

    await ctx.store.tx((r) => r.putEdition({ day: '2026-10-06', content: {}, universe: [], model: 'x', spiked: 'reset' }));
    writer = fakeWriter(new Error('529 overloaded'), draft());
    svc = await setup(writer);
    const r = await svc.writeEdition();
    assert.equal(r.status, 'spiked');
    assert.equal(writer.calls.length, 1);
    const e = await stored('2026-10-06');
    assert.equal(e.spiked, 'Writer unavailable: 529 overloaded');
    assert.match(e.content.report[0], /The writer could not be reached/);
  });

  test('no market data or no writer: the fallback, and Claude is not called', async () => {
    let writer = fakeWriter(draft());
    let svc = await setup(writer);
    broker.getDailyBars = async () => {
      throw new BrokerError(500, 'data API down');
    };
    let r = await svc.writeEdition();
    assert.equal(r.status, 'spiked');
    assert.match(r.spiked, /^Market data unavailable: 26 of 26 bar requests failed \(VOO: 500 data API down\)/);
    assert.equal(writer.calls.length, 0);

    svc = await setup(null);
    r = await svc.writeEdition();
    assert.equal(r.spiked, 'ANTHROPIC_API_KEY is not set');
    assert.match((await stored('2026-10-06')).content.report[0], /no writer on staff/);

    writer = fakeWriter(draft());
    svc = await setup(writer, { broker: null });
    r = await svc.writeEdition();
    assert.match(r.spiked, /Alpaca keys are not set/);
    assert.equal(writer.calls.length, 0);
  });

  test('without headlines the page still goes out and says the wire was quiet', async () => {
    const writer = fakeWriter(draft());
    const svc = await setup(writer);
    broker.getNews = async () => {
      throw new BrokerError(500, 'news down');
    };
    assert.equal((await svc.writeEdition()).status, 'written');
    assert.match(writer.calls[0].user, /HEADLINES: none available\./);
  });

  test('Monday follows Friday: the last edition is "yesterday", and repeating it is spiked', async () => {
    await ctx.store.tx((r) => r.putEdition({ day: '2026-10-09', content: validateEdition(draft()), universe: [], model: 'x' }));
    const writer = fakeWriter(draft(), draft({ index: 'VTI' }));
    const svc = await setup(writer, { at: '2026-10-12T13:25:00Z' }); // Monday
    const before = await svc.getState();
    assert.equal(before.editions.today, null);
    assert.equal(before.editions.previous.day, '2026-10-09');
    const r = await svc.writeEdition();
    assert.equal(r.attempts, 2);
    assert.match(writer.calls[0].user, /YESTERDAY'S RUNGS: index VOO, sector XLK, name COST\./);
    assert.match(writer.calls[1].user, /identical to yesterday/);
    const after = await svc.getState();
    assert.equal(after.editions.today.content.rungs.index.symbol, 'VTI');
    assert.equal(after.editions.previous.day, '2026-10-09');
  });
});
