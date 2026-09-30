import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachStore } from './helpers/stores.js';
import { makeService } from '../lib/service.js';
import { makeFakeBroker } from '../lib/broker-fake.js';

const DAY = 86400000;
const at = (day) => new Date(`${day}T17:00:00Z`);

forEachStore('ledgers', (ctx) => {
  test('history: one row per day, day money follows the marks as they stand now', async () => {
    let now = at('2026-09-09');
    const broker = makeFakeBroker({ clock: () => now });
    const svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    now = at('2026-09-13');
    await svc.getState();
    // Corrected four days later, Sept 10 moves to the ghost in history too.
    await svc.setDay({ day: '2026-09-10', state: 'smoked' });
    const h = await svc.history();
    assert.deepEqual(h.days.map((d) => d.day), ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']);
    assert.deepEqual(h.days.map((d) => d.state), ['clean', 'smoked', 'clean', 'clean', 'clean']);
    assert.deepEqual(h.days.map((d) => d.burned_cents), [1200, 2400, 3600, 4800, 6000]);
    assert.deepEqual(h.days.map((d) => d.yours_cents), [1200, 1200, 2400, 3600, 3600]);
    assert.equal(h.days[0].ghost_cents, 0);
    assert.equal(h.days[1].ghost_cents, 1200);
    assert.ok(h.days[3].ghost_cents > 0);
    assert.equal(h.days.at(-1).ghost_cents, h.ghost_cents);
  });

  test('yours counts the portfolio at market value, and history lists trades', async () => {
    let now = at('2026-10-01');
    const broker = makeFakeBroker({ autoFill: true, clock: () => now });
    const svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    await svc.setMode('smoking');
    await ctx.store.tx((r) => r.insertLedger({ occurred_at: now, delta_cents: 5000, kind: 'adjust' }));
    await svc.requestTrade({ symbol: 'VTI', side: 'buy', notional_cents: 5000 });
    now = new Date(now.getTime() + DAY + 1000);
    await svc.processQueue();
    broker.setPrice('VTI', 290.12 * 1.1);
    const h = await svc.history();
    assert.equal(h.bank_cents, 0);
    assert.ok(Math.abs(h.portfolio_cents - 5500) <= 1);
    assert.equal(h.days.at(-1).yours_cents, h.portfolio_cents);
    assert.equal(h.trades.length, 1);
    assert.equal(h.trades[0].status, 'filled');
  });

  test('snapshot records the ghost too', async () => {
    let now = at('2026-09-09');
    const svc = makeService({ store: ctx.store, broker: makeFakeBroker({ clock: () => now }), clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    await svc.setMode('smoking');
    now = at('2026-09-11');
    const snap = await svc.snapshot();
    assert.equal(snap.day, '2026-09-11');
    assert.equal(snap.bank_cents, 0);
    assert.ok(snap.ghost_cents > 0);
    assert.equal(snap.burned_cents, 3600);
  });
});

forEachStore('ledgers: money in flight', (ctx) => {
  test('a queued buy stays in yours until it fills or is refunded', async () => {
    let now = at('2026-10-01');
    const broker = makeFakeBroker({ autoFill: true, clock: () => now });
    const svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    await svc.setMode('smoking');
    await ctx.store.tx((r) => r.insertLedger({ occurred_at: now, delta_cents: 10000, kind: 'adjust' }));
    await svc.requestTrade({ symbol: 'VTI', side: 'buy', notional_cents: 5000 });
    const { trade } = await svc.requestTrade({ symbol: 'VOO', side: 'buy', notional_cents: 2000 });
    let st = await svc.getState();
    assert.equal(st.queued_cents, 7000);
    assert.equal(st.bank_cents, 3000);
    now = at('2026-10-02');
    await svc.cancelTrade(trade.id);
    now = new Date(at('2026-10-02').getTime() + 2 * 3600000);
    await svc.processQueue();
    now = at('2026-10-03');
    const h = await svc.history();
    // Oct 1: bank 3000 + 7000 in flight. Oct 2: VOO refunded, VTI filled.
    assert.deepEqual(h.days.map((d) => d.yours_cents), [10000, 10000, 10000]);
  });
});
