import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachStore } from './helpers/stores.js';
import { makeService } from '../lib/service.js';
import { makeFakeBroker } from '../lib/broker-fake.js';
import { SAMPLE_EDITION } from '../lib/edition-sample.js';
import { DEFAULT_UNIVERSE } from '../lib/edition.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const at = (day) => new Date(`${day}T17:00:00Z`);

forEachStore('trading vs. saving', (ctx) => {
  let now, broker, svc;
  async function setup(bankCents) {
    now = at('2026-10-01');
    broker = makeFakeBroker({ autoFill: true, clock: () => now });
    svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    await svc.setMode('smoking');
    await ctx.store.tx((r) => r.insertLedger({ occurred_at: now, delta_cents: bankCents, kind: 'adjust' }));
  }
  const later = (ms) => (now = new Date(now.getTime() + ms));

  test('a position is measured against the bank: gain on what it cost, and days held', async () => {
    await setup(5000);
    await svc.requestTrade({ symbol: 'VTI', side: 'buy', notional_cents: 5000 });
    later(DAY + 1000);
    await svc.processQueue();
    broker.setPrice('VTI', 300);
    later(3 * DAY);
    const [p] = (await svc.getState()).positions;
    assert.equal(p.cost_cents, 5000);
    assert.equal(p.priced, true);
    assert.equal(p.days_held, 3);
    assert.ok(Math.abs(p.value_cents - Math.round((50 / 290.12) * 300 * 100)) <= 1);
    assert.equal(p.gain_cents, p.value_cents - 5000);
  });

  test('trading, net: held gains, then booked gains; queued and cancelled buys count for nothing', async () => {
    await setup(10000);
    await svc.requestTrade({ symbol: 'VTI', side: 'buy', notional_cents: 5000 });
    let st = await svc.getState();
    assert.deepEqual(st.trading, { net_cents: 0, realized_cents: 0, unrealized_cents: 0, bought_cents: 0, sells: 0 });
    later(DAY + 1000);
    await svc.processQueue();
    broker.setPrice('VTI', 310);
    const { trade } = await svc.requestTrade({ symbol: 'VOO', side: 'buy', notional_cents: 2000 });
    st = await svc.getState();
    const held = st.positions[0].gain_cents;
    assert.ok(held > 0);
    assert.deepEqual(st.trading, { net_cents: held, realized_cents: 0, unrealized_cents: held, bought_cents: 5000, sells: 0 });
    await svc.cancelTrade(trade.id);
    assert.equal((await svc.getState()).trading.net_cents, held);

    later(8 * DAY);
    await svc.requestTrade({ symbol: 'VTI', side: 'sell' });
    later(DAY + 1000);
    await svc.processQueue();
    st = await svc.getState();
    assert.equal(st.positions.length, 0);
    const proceeds = st.bank_cents - 5000; // 10000 in, 5000 spent, VOO refunded
    assert.equal(st.trading.realized_cents, proceeds - 5000);
    assert.equal(st.trading.net_cents, proceeds - 5000);
    assert.equal(st.trading.unrealized_cents, 0);
    assert.equal(st.trading.sells, 1);
  });

  test('without prices, positions show at what the bank paid and add nothing', async () => {
    await setup(5000);
    await svc.requestTrade({ symbol: 'VTI', side: 'buy', notional_cents: 5000 });
    later(DAY + 1000);
    await svc.processQueue();
    broker.getPositions = async () => {
      throw new Error('Alpaca is down');
    };
    const st = await svc.getState();
    assert.equal(st.prices_stale, true);
    assert.equal(st.positions[0].priced, false);
    assert.equal(st.positions[0].value_cents, 5000);
    assert.equal(st.positions[0].gain_cents, 0);
    assert.equal(st.trading.net_cents, 0);
  });
});

forEachStore('the paper’s own record', (ctx) => {
  const edition = (index, sector, name) => ({
    ...SAMPLE_EDITION,
    rungs: { index: { symbol: index, name: index, note: 'x' }, sector: { symbol: sector, name: sector, note: 'x' }, name: { symbol: name, name, note: 'x' } },
  });
  const put = (day, rungs) => ctx.store.tx((r) => r.putEdition({ day, content: edition(...rungs), universe: DEFAULT_UNIVERSE, model: 'test' }));

  test('history scores each printed rung at its close and leaves your trades out of it', async () => {
    let now = at('2026-09-21'); // a Monday
    const broker = makeFakeBroker({ autoFill: true, clock: () => now });
    const svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    await put('2026-09-21', ['VOO', 'XLK', 'COST']);
    await put('2026-09-22', ['VTI', 'XLE', 'UNH']);
    await put('2026-09-26', ['QQQ', 'XLV', 'KO']); // a Saturday
    await put('2026-09-29', ['SCHD', 'XLF', 'PG']); // today
    now = at('2026-09-29');
    // A trade of your own, in a printed rung, changes nothing on the record.
    await svc.requestTrade({ symbol: 'XLK', side: 'buy', notional_cents: 2000 });

    const r = (await svc.history()).record;
    assert.equal(r.since, '2026-09-21');
    assert.equal(r.as_of, '2026-09-28');
    assert.equal(r.editions, 4);
    assert.equal(r.pending, 1);

    const close = async (sym, day) => (await broker.getDailyBars(sym, '2026-09-14', day)).filter((b) => b.day <= day).at(-1).close;
    const lot = async (sym, day) => Math.round((2000 * (await close(sym, '2026-09-28'))) / (await close(sym, day)));
    // The Saturday edition buys at Monday's close.
    const index = (await lot('VOO', '2026-09-21')) + (await lot('VTI', '2026-09-22')) + (await lot('QQQ', '2026-09-28'));
    assert.equal(r.rungs.index.picks, 3);
    assert.equal(r.rungs.index.in_cents, 6000);
    assert.equal(r.rungs.index.now_cents, index);
    const name = (await lot('COST', '2026-09-21')) + (await lot('UNH', '2026-09-22')) + (await lot('KO', '2026-09-28'));
    assert.equal(r.rungs.name.now_cents, name);
    assert.deepEqual(r.mattress, { picks: 3, in_cents: 6000, now_cents: 6000, pct: 0 });
    assert.ok(r.best.pct >= r.worst.pct);
    assert.equal(r.days[0].day, '2026-09-21');
    assert.equal(r.days.at(-1).day, '2026-09-29');
    assert.equal(r.days.at(-1).index, r.rungs.index.pct);
    // Closes went into the shared cache, so the next read needs no fetch.
    const calls = broker.calls.length;
    await svc.history();
    assert.equal(broker.calls.filter((c, i) => i >= calls && c[0] === 'getDailyBars').length, 0);
  });

  test('a split re-bases the cached closes instead of reading as a 66% loss', async () => {
    let now = at('2026-09-21');
    const broker = makeFakeBroker({ clock: () => now });
    const svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    await put('2026-09-21', ['VOO', 'XLK', 'WMT']);
    now = at('2026-09-24');
    const before = (await svc.history()).record.rungs.name.pct;
    // A 3-for-1 split: Alpaca now reports every past close a third as high.
    broker.setPrice('WMT', 98.1 / 3);
    now = at('2026-09-25');
    const after = (await svc.history()).record.rungs.name.pct;
    assert.ok(Math.abs(after - before) < 0.05, `${before} then ${after}`);
    const cached = await ctx.store.run((r) => r.listCloses('WMT', '2026-09-21', '2026-09-21'));
    assert.ok(Math.abs(Number(cached[0].close) - (await broker.getDailyBars('WMT', '2026-09-21', '2026-09-21'))[0].close) < 0.01);
  });

  test('no editions yet: an empty record, and no market data fetched for it', async () => {
    const now = at('2026-09-29');
    const broker = makeFakeBroker({ clock: () => now });
    const svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    const r = (await svc.history()).record;
    assert.equal(r.editions, 0);
    assert.equal(r.since, null);
    assert.deepEqual(r.days, []);
    assert.ok(broker.calls.filter((c) => c[0] === 'getDailyBars').every((c) => c[1] === 'VOO'));
  });
});
