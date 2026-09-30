import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachStore } from './helpers/stores.js';
import { makeService } from '../lib/service.js';
import { makeFakeBroker } from '../lib/broker-fake.js';

const DAY = 86400000;

forEachStore('ledgers', (ctx) => {
  test('snapshots feed a daily series with carry-forward and a live today', async () => {
    let now = new Date('2026-10-01T17:00:00Z');
    const broker = makeFakeBroker({ autoFill: true, clock: () => now });
    const svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    await svc.logCraving({ beaten: true });
    const snap = await svc.snapshot();
    assert.deepEqual(snap, { day: '2026-10-01', bank_cents: 300, portfolio_cents: 0, burned_cents: 1200 });

    now = new Date(now.getTime() + 3 * DAY); // Oct 4, no snapshots Oct 2-3
    for (let i = 0; i < 4; i++) await svc.logCraving({ beaten: true });
    const h = await svc.history();
    assert.deepEqual(h.days.map((d) => d.day), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    assert.deepEqual(h.days.map((d) => d.burned_cents), [1200, 2400, 3600, 4800]);
    assert.deepEqual(h.days.map((d) => d.yours_cents), [300, 300, 300, 1500]);
  });

  test('yours counts the portfolio at market value, and history lists trades', async () => {
    let now = new Date('2026-10-01T17:00:00Z');
    const broker = makeFakeBroker({ autoFill: true, clock: () => now });
    const svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
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
});
