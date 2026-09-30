import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachStore } from './helpers/stores.js';
import { makeService } from '../lib/service.js';
import { makeFakeBroker } from '../lib/broker-fake.js';
import { addDays } from '../lib/time.js';

const DAY = 86400000;

forEachStore('calendar and ghost', (ctx) => {
  let now, broker, svc;
  // 10am in Los Angeles on the given day.
  const at = (day) => new Date(`${day}T17:00:00Z`);

  async function setup({ quit = '2026-09-09', withBroker = true } = {}) {
    now = at(quit);
    broker = withBroker ? makeFakeBroker({ clock: () => now }) : null;
    svc = makeService({ store: ctx.store, broker, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
  }

  // bank 'day' entries + ghost lot cents = sum of settled day amounts.
  async function books() {
    return ctx.store.run(async (r) => {
      const ledger = await r.listLedger();
      const lots = await r.listLots();
      const days = await r.listDays();
      return {
        dayMoney: ledger.filter((e) => e.kind === 'day').reduce((a, e) => a + e.delta_cents, 0),
        ghostCost: lots.reduce((a, l) => a + l.cents, 0),
        settled: days.filter((d) => d.settled_at).reduce((a, d) => a + d.cents, 0),
        settledCount: days.filter((d) => d.settled_at).length,
        lots,
      };
    });
  }

  test('today is pencilled in; it settles to the bank at midnight', async () => {
    await setup();
    let st = await svc.getState();
    assert.equal(st.day_count, 1);
    assert.equal(st.bank_cents, 0);
    assert.equal(st.today_state, 'clean');
    assert.equal(st.days.length, 1);
    assert.equal(st.days[0].settled, false);
    now = at('2026-09-10');
    st = await svc.getState();
    assert.equal(st.bank_cents, 1200);
    assert.equal(st.days[0].settled, true);
    assert.equal(st.days[0].cents, 1200);
    assert.equal(st.streak_days, 2);
  });

  test('a day settles exactly once, even when many requests race', async () => {
    await setup();
    now = at('2026-09-12');
    await Promise.all(Array.from({ length: 6 }, () => svc.getState()));
    const b = await books();
    assert.equal(b.settledCount, 3);
    assert.equal(b.dayMoney, 3600);
  });

  test('I’m smoking: days go to the ghost; switching back only changes today', async () => {
    await setup();
    await svc.setMode('smoking');
    let st = await svc.getState();
    assert.equal(st.mode, 'smoking');
    assert.equal(st.today_state, 'smoked');
    now = at('2026-09-12');
    st = await svc.getState();
    assert.equal(st.bank_cents, 0);
    assert.equal(st.ghost.lots, 3);
    assert.equal(st.ghost.cost_cents, 3600);
    await svc.setDay({ day: '2026-09-12', state: 'clean' });
    st = await svc.setMode('quit');
    assert.equal(st.today_state, 'clean');
    assert.deepEqual(st.days.map((d) => d.state), ['smoked', 'smoked', 'smoked', 'clean']);
    now = at('2026-09-13');
    st = await svc.getState();
    assert.equal(st.bank_cents, 1200);
    assert.equal(st.ghost.cost_cents, 3600);
  });

  test('a late report pencils today as smoked; nothing moves until midnight', async () => {
    await setup();
    now = at('2026-09-11');
    await svc.getState();
    let st = await svc.setDay({ day: '2026-09-11', state: 'smoked' });
    assert.equal(st.today_state, 'smoked');
    assert.equal(st.bank_cents, 2400);
    assert.equal(st.ghost.cost_cents, 0);
    assert.equal(st.streak_days, 0);
    now = at('2026-09-12');
    st = await svc.getState();
    assert.equal(st.bank_cents, 2400);
    assert.equal(st.ghost.cost_cents, 1200);
    assert.equal(st.streak_days, 1);
  });

  test('corrections move a past day’s money both ways, and repeat corrections do nothing', async () => {
    await setup();
    now = at('2026-09-14');
    await svc.getState();
    // Sept 9 through 13 have settled: five clean days.
    let st = await svc.setDay({ day: '2026-09-10', state: 'smoked' });
    assert.equal(st.bank_cents, 6000 - 1200);
    assert.equal(st.ghost.cost_cents, 1200);
    st = await svc.setDay({ day: '2026-09-10', state: 'smoked' });
    assert.equal(st.bank_cents, 4800);
    st = await svc.setDay({ day: '2026-09-10', state: 'clean' });
    assert.equal(st.bank_cents, 6000);
    assert.equal(st.ghost.cost_cents, 0);
    const b = await books();
    assert.equal(b.dayMoney + b.ghostCost, b.settled);
  });

  test('cannot mark the future, days before quitting, or nonsense', async () => {
    await setup();
    now = at('2026-09-12');
    await assert.rejects(svc.setDay({ day: '2026-09-13', state: 'smoked' }), { code: 'future_day' });
    await assert.rejects(svc.setDay({ day: '2026-09-08', state: 'smoked' }), { code: 'before_quit' });
    await assert.rejects(svc.setDay({ day: '2026-09-10', state: 'maybe' }), { code: 'bad_state' });
    await assert.rejects(svc.setDay({ day: 'yesterday', state: 'clean' }), { code: 'bad_day' });
    await assert.rejects(svc.setMode('vaping'), { code: 'bad_mode' });
  });

  test('invariant: bank day money + ghost cost = settled days × daily, under any edits', async () => {
    await setup();
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let today = '2026-09-09';
    for (let i = 0; i < 30; i++) {
      now = at(today);
      const r = rand();
      if (r < 0.15) await svc.setMode(rand() < 0.5 ? 'smoking' : 'quit');
      else if (r < 0.5) {
        const back = Math.floor(rand() * (i + 1));
        await svc.setDay({ day: addDays(today, -back), state: rand() < 0.5 ? 'smoked' : 'clean' });
      } else await svc.getState();
      today = addDays(today, 1);
    }
    now = at(today);
    const st = await svc.getState();
    const b = await books();
    assert.equal(b.settledCount, 30);
    assert.equal(b.dayMoney + b.ghostCost, 30 * 1200);
    assert.equal(st.bank_cents, b.dayMoney);
    const smoked = st.days.filter((d) => d.settled && d.state === 'smoked').length;
    assert.equal(b.lots.length, smoked);
  });

  test('ghost lots are bought at the day’s close and valued at the latest price', async () => {
    await setup({ quit: '2026-09-21' });
    await svc.setMode('smoking');
    now = at('2026-09-24');
    const st = await svc.getState();
    assert.equal(st.ghost.lots, 3);
    const lots = (await books()).lots;
    assert.ok(lots.every((l) => l.shares && l.price && l.benchmark === 'VOO'));
    const bars = await broker.getDailyBars('VOO', '2026-09-10', '2026-09-23');
    const close = (d) => bars.filter((b) => b.day <= d).at(-1).close;
    const latest = broker.assets.get('VOO').price;
    const expected = ['2026-09-21', '2026-09-22', '2026-09-23'].reduce((a, d) => a + Math.round((12 / close(d)) * latest * 100), 0);
    assert.ok(Math.abs(st.ghost.value_cents - expected) <= 2, `${st.ghost.value_cents} vs ${expected}`);
    assert.equal(st.ghost.cost_cents, 3600);
  });

  test('a weekend day is bought at Friday’s close', async () => {
    await setup({ quit: '2026-09-19' }); // a Saturday
    await svc.setMode('smoking');
    now = at('2026-09-22');
    await svc.getState();
    const lots = (await books()).lots;
    const bars = await broker.getDailyBars('VOO', '2026-09-10', '2026-09-21');
    const friday = bars.find((b) => b.day === '2026-09-18').close;
    assert.equal(Number(lots.find((l) => l.day === '2026-09-19').price), friday);
    assert.equal(Number(lots.find((l) => l.day === '2026-09-20').price), friday);
  });

  test('changing the benchmark redraws the whole ghost', async () => {
    await setup({ quit: '2026-09-21' });
    await svc.setMode('smoking');
    now = at('2026-09-24');
    const before = await svc.getState();
    await svc.updateSettings({ ghost_benchmark: 'qqq' });
    const after = await svc.getState();
    assert.equal(after.ghost.benchmark, 'QQQ');
    assert.equal(after.ghost.cost_cents, before.ghost.cost_cents);
    assert.ok((await books()).lots.every((l) => l.benchmark === 'QQQ' && l.shares));
    await assert.rejects(svc.updateSettings({ ghost_benchmark: 'ZZZZ' }), /does not list/);
  });

  test('without market data the ghost counts at cost', async () => {
    await setup({ withBroker: false });
    await svc.setMode('smoking');
    now = at('2026-09-12');
    const st = await svc.getState();
    assert.equal(st.ghost.value_cents, 3600);
    assert.equal(st.ghost.priced, false);
    assert.equal(st.broker_mode, 'offline');
  });

  test('settled days keep their amount when the pack price changes', async () => {
    await setup();
    now = at('2026-09-11');
    await svc.getState();
    await svc.updateSettings({ pack_price_cents: 1500 });
    now = at('2026-09-12');
    const st = await svc.getState();
    assert.deepEqual(st.days.filter((d) => d.settled).map((d) => d.cents), [1200, 1200, 1500]);
    assert.equal(st.bank_cents, 3900);
    assert.equal(st.daily_cents, 1500);
  });

  test('moving the quit date later takes those days back out; earlier settles more', async () => {
    await setup();
    now = at('2026-09-14');
    await svc.setDay({ day: '2026-09-09', state: 'smoked' });
    let st = await svc.getState();
    assert.equal(st.bank_cents, 4 * 1200);
    assert.equal(st.ghost.cost_cents, 1200);
    st = await svc.updateSettings({ quit_date: '2026-09-12' }).then(() => svc.getState());
    assert.equal(st.bank_cents, 2 * 1200);
    assert.equal(st.ghost.cost_cents, 0);
    assert.equal(st.days[0].day, '2026-09-12');
    st = await svc.updateSettings({ quit_date: '2026-09-10' }).then(() => svc.getState());
    assert.equal(st.bank_cents, 4 * 1200);
    const b = await books();
    assert.equal(b.dayMoney + b.ghostCost, b.settled);
  });

  test('a correction can take the bank below zero after the money was spent', async () => {
    await setup();
    now = at('2026-09-11');
    await svc.getState();
    await ctx.store.tx((r) => r.insertLedger({ occurred_at: now, delta_cents: -2400, kind: 'trade_debit' }));
    const st = await svc.setDay({ day: '2026-09-09', state: 'smoked' });
    assert.equal(st.bank_cents, -1200);
    assert.deepEqual(st.unlocked_tiers, []);
  });
});

forEachStore('v1 craving credits', (ctx) => {
  test('are cancelled once, including taps made while v1 was still live; rows stay', async () => {
    const now = new Date('2026-09-30T17:00:00Z');
    const svc = makeService({ store: ctx.store, clock: () => now });
    await svc.ensureInitialized('America/Los_Angeles');
    const tap = (at) => ctx.store.tx((r) => r.insertLedger({ occurred_at: at, delta_cents: 300, kind: 'craving' }));
    await tap(new Date('2026-09-30T15:00:00Z'));
    await tap(new Date('2026-09-30T16:00:00Z'));
    await ctx.store.tx((r) => r.insertLedger({ occurred_at: now, delta_cents: -2000, kind: 'trade_debit' }));
    let st = await svc.getState();
    assert.equal(st.bank_cents, -2000);
    st = await svc.getState();
    assert.equal(st.bank_cents, -2000);
    await tap(new Date('2026-09-30T16:30:00Z'));
    st = await svc.getState();
    assert.equal(st.bank_cents, -2000);
    const ledger = await ctx.store.run((r) => r.listLedger());
    assert.equal(ledger.filter((e) => e.kind === 'craving').length, 3);
    assert.equal(ledger.filter((e) => e.kind === 'adjust').length, 2);
  });
});
