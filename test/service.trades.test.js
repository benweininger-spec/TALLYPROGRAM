import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachStore } from './helpers/stores.js';
import { makeService } from '../lib/service.js';
import { makeFakeBroker } from '../lib/broker-fake.js';
import { BrokerError } from '../lib/alpaca.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

forEachStore('trading', (ctx) => {
  let now, broker, svc;

  async function setup(bankCents = 25000, opts = {}) {
    now = new Date('2026-10-01T17:00:00Z');
    broker = makeFakeBroker({ ...opts, clock: () => now });
    svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    // Days go to the ghost, so the bank holds only what each test puts in.
    await svc.setMode('smoking');
    if (bankCents) {
      await ctx.store.tx((r) => r.insertLedger({ occurred_at: now, delta_cents: bankCents, kind: 'adjust' }));
    }
  }
  const bank = async () => (await svc.getState()).bank_cents;
  const buy = (symbol, cents) => svc.requestTrade({ symbol, side: 'buy', notional_cents: cents });

  test('buy debits the bank now and waits out the cooldown', async () => {
    await setup(5000);
    const r = await buy('vti', 5000);
    assert.equal(r.trade.status, 'queued');
    assert.equal(r.trade.symbol, 'VTI');
    assert.equal(new Date(r.trade.execute_after) - now, 24 * HOUR);
    assert.equal(r.bank_cents, 0);
    now = new Date(now.getTime() + 23 * HOUR);
    assert.equal((await svc.processQueue()).claimed, 0);
    assert.equal(broker.orders.size, 0);
  });

  test('cannot buy above bank, above $200, below $20, off-tier, non-fractionable, or short', async () => {
    await setup(15000);
    await assert.rejects(buy('VTI', 20000), { code: 'insufficient_bank' });
    await assert.rejects(buy('VTI', 25000), { code: 'out_of_bounds' });
    await assert.rejects(buy('VTI', 1500), { code: 'out_of_bounds' });
    await assert.rejects(buy('VTI', 7500), { code: 'not_a_tier' });
    await assert.rejects(buy('NOFR', 5000), { code: 'not_fractionable' });
    await assert.rejects(buy('ZZZZ', 5000), { code: 'unknown_symbol' });
    await assert.rejects(svc.requestTrade({ symbol: 'VTI', side: 'sell_short', notional_cents: 5000 }), { code: 'bad_side' });
    await assert.rejects(svc.requestTrade({ symbol: 'VTI', side: 'short', notional_cents: 5000 }), { code: 'bad_side' });
    assert.equal(await bank(), 15000);
  });

  test('two simultaneous buys cannot overspend the bank', async () => {
    await setup(5000);
    const results = await Promise.allSettled([buy('VTI', 5000), buy('VOO', 5000)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'insufficient_bank');
    assert.equal(await bank(), 0);
  });

  test('cancelling a queued buy restores the bank exactly, once', async () => {
    await setup(12345);
    const { trade } = await buy('VTI', 10000);
    assert.equal(await bank(), 2345);
    const c = await svc.cancelTrade(trade.id);
    assert.equal(c.trade.status, 'cancelled');
    assert.equal(c.bank_cents, 12345);
    await assert.rejects(svc.cancelTrade(trade.id), { code: 'not_cancellable' });
    assert.equal(await bank(), 12345);
    now = new Date(now.getTime() + 2 * DAY);
    await svc.processQueue();
    assert.equal(broker.orders.size, 0);
  });

  test('after the cooldown it submits, settles the fill, and opens a position', async () => {
    await setup(5000);
    const { trade } = await buy('VTI', 5000);
    now = new Date(now.getTime() + DAY + 1000);
    let rep = await svc.processQueue();
    assert.equal(rep.claimed, 1);
    assert.equal(rep.working, 1);
    await assert.rejects(svc.cancelTrade(trade.id), { code: 'not_cancellable' });
    broker.fill(trade.id, { price: 250 });
    rep = await svc.processQueue();
    assert.equal(rep.settled, 1);
    const st = await svc.getState();
    assert.equal(st.bank_cents, 0);
    assert.equal(st.positions.length, 1);
    assert.equal(st.positions[0].symbol, 'VTI');
    assert.equal(st.positions[0].qty, '0.2');
    assert.equal(st.positions[0].sellable, false);
    assert.equal(st.queue.length, 0);
    const [order] = broker.orders.values();
    assert.deepEqual([order.type, order.time_in_force, order.notional, order.qty], ['market', 'day', '50.00', null]);
  });

  test('opening the app moves due trades along without cron', async () => {
    await setup(5000, { autoFill: true });
    await buy('VTI', 5000);
    now = new Date(now.getTime() + DAY + 1000);
    const st = await svc.getState();
    assert.equal(st.positions.length, 1);
    assert.equal(st.queue.length, 0);
  });

  test('an order Alpaca refuses is rejected and refunded', async () => {
    await setup(5000);
    const { trade } = await buy('VTI', 5000);
    now = new Date(now.getTime() + DAY + 1000);
    broker.failNextWith(new BrokerError(403, 'insufficient buying power'));
    const rep = await svc.processQueue();
    assert.equal(rep.rejected, 1);
    const st = await svc.getState();
    assert.equal(st.bank_cents, 5000);
    const t = await ctx.store.run((r) => r.getTrade(trade.id));
    assert.equal(t.status, 'rejected');
    assert.match(t.reason, /buying power/);
  });

  test('a network error leaves the trade to retry, without double-ordering', async () => {
    await setup(5000);
    const { trade } = await buy('VTI', 5000);
    now = new Date(now.getTime() + DAY + 1000);
    broker.failNextWith(new BrokerError(503, 'upstream timeout'));
    const rep = await svc.processQueue();
    assert.equal(rep.errors.length, 1);
    assert.equal((await ctx.store.run((r) => r.getTrade(trade.id))).status, 'submitted');
    await Promise.all([svc.processQueue(), svc.processQueue(), svc.processQueue()]);
    assert.equal(broker.orders.size, 1);
    assert.equal(broker.calls.filter((c) => c[0] === 'submitOrder').length >= 2, true);
    assert.equal(await bank(), 0);
  });

  test('a partial fill refunds the unfilled part', async () => {
    await setup(10000);
    const { trade } = await buy('VTI', 10000);
    now = new Date(now.getTime() + DAY + 1000);
    await svc.processQueue();
    broker.fill(trade.id, { qty: 0.1, price: 300, status: 'canceled' });
    await svc.processQueue();
    assert.equal(await bank(), 7000);
    const t = await ctx.store.run((r) => r.getTrade(trade.id));
    assert.equal(t.status, 'filled');
    assert.match(t.reason, /Partially filled/);
  });

  test('cannot sell inside the hold window; after it, a sell credits proceeds', async () => {
    await setup(5000, { autoFill: true });
    await buy('VTI', 5000);
    now = new Date(now.getTime() + DAY + 1000);
    await svc.processQueue();
    const filledAt = now;
    await assert.rejects(svc.requestTrade({ symbol: 'VTI', side: 'sell' }), { code: 'hold_locked' });
    now = new Date(filledAt.getTime() + 6 * DAY);
    await assert.rejects(svc.requestTrade({ symbol: 'VTI', side: 'sell' }), { code: 'hold_locked' });
    await assert.rejects(svc.requestTrade({ symbol: 'VOO', side: 'sell' }), { code: 'no_position' });

    now = new Date(filledAt.getTime() + 8 * DAY);
    broker.setPrice('VTI', 320);
    const { trade } = await svc.requestTrade({ symbol: 'VTI', side: 'sell' });
    await assert.rejects(svc.requestTrade({ symbol: 'VTI', side: 'sell' }), { code: 'sell_pending' });
    assert.equal(trade.status, 'queued');
    now = new Date(now.getTime() + DAY + 1000);
    await svc.processQueue();
    const st = await svc.getState();
    assert.equal(st.positions.length, 0);
    const shares = 50 / 290.12;
    assert.ok(Math.abs(st.bank_cents - Math.round(shares * 320 * 100)) <= 1);
  });

  test('symbol search only returns fractionable US equities', async () => {
    await setup(0);
    const { results } = await svc.searchSymbols('vt');
    assert.deepEqual(results.map((r) => r.symbol), ['VTI']);
    assert.equal((await svc.searchSymbols('nofr')).results.length, 0);
    assert.ok((await svc.searchSymbols('vanguard')).results.length >= 2);
  });
});
