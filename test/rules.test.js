import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../lib/rules.js';
import { resolveSettings, validateSettingsPatch } from '../lib/config.js';
import { dayStart, localDay } from '../lib/time.js';

const s = resolveSettings({ quit_date: '2026-10-01' });
const asset = { symbol: 'VTI', class: 'us_equity', status: 'active', tradable: true, fractionable: true };
const buy = (over) => rules.validateBuy({ notionalCents: 5000, bankCents: 10000, asset, settings: s, ...over });

test('unlocked tiers are the tiers the bank covers', () => {
  assert.deepEqual(rules.unlockedTiers(0, s), []);
  assert.deepEqual(rules.unlockedTiers(4999, s), [2000]);
  assert.deepEqual(rules.unlockedTiers(20000, s), [2000, 5000, 10000, 20000]);
});

test('buy: rejects above bank, above $200, below $20, off-tier, non-fractionable, short', () => {
  assert.doesNotThrow(() => buy());
  assert.throws(() => buy({ notionalCents: 20000, bankCents: 19999 }), { code: 'insufficient_bank' });
  assert.throws(() => buy({ notionalCents: 25000, bankCents: 99999 }), { code: 'out_of_bounds' });
  assert.throws(() => buy({ notionalCents: 1000 }), { code: 'out_of_bounds' });
  assert.throws(() => buy({ notionalCents: 7500 }), { code: 'not_a_tier' });
  assert.throws(() => buy({ notionalCents: 50.5 }), { code: 'bad_amount' });
  assert.throws(() => buy({ asset: { ...asset, fractionable: false } }), { code: 'not_fractionable' });
  assert.throws(() => buy({ asset: { ...asset, tradable: false } }), { code: 'not_tradable' });
  assert.throws(() => buy({ asset: { ...asset, class: 'crypto' } }), { code: 'not_equity' });
  assert.throws(() => buy({ asset: null }), { code: 'unknown_symbol' });
  assert.throws(() => rules.normalizeSide('sell_short'), { code: 'bad_side' });
  assert.throws(() => rules.normalizeSide('short'), { code: 'bad_side' });
});

test('buy: a raised minimum trade applies on top of the hard floor', () => {
  const s2 = resolveSettings({ min_trade_cents: 5000 });
  assert.throws(() => buy({ notionalCents: 2000, settings: s2 }), { code: 'below_minimum' });
});

test('sell: locked inside the hold window, allowed after it', () => {
  const position = { symbol: 'VTI', qty: '0.1', avg_cost: '300', first_fill_at: new Date('2026-10-01T14:00:00Z') };
  const at = (iso) => ({ position, pendingSell: null, settings: s, now: new Date(iso) });
  assert.throws(() => rules.validateSell(at('2026-10-05T14:00:00Z')), { code: 'hold_locked' });
  assert.throws(() => rules.validateSell(at('2026-10-08T14:00:00Z')), { code: 'hold_locked' });
  assert.doesNotThrow(() => rules.validateSell(at('2026-10-08T14:00:01Z')));
  assert.throws(() => rules.validateSell({ ...at('2026-11-01T00:00:00Z'), pendingSell: {} }), { code: 'sell_pending' });
  assert.throws(() => rules.validateSell({ ...at('2026-11-01T00:00:00Z'), position: null }), { code: 'no_position' });
});

test('symbols are normalized and validated', () => {
  assert.equal(rules.normalizeSymbol(' brk.b '), 'BRK.B');
  assert.throws(() => rules.normalizeSymbol('VTI; drop table'), { code: 'bad_symbol' });
  assert.throws(() => rules.normalizeSymbol(''), { code: 'bad_symbol' });
});

test('settle: full buy fill keeps the debit, partial refunds the rest, none refunds all', () => {
  const trade = { side: 'buy', notional_cents: 5000 };
  const now = new Date();
  const full = rules.settleOrder(trade, { status: 'filled', filled_qty: '0.2', filled_avg_price: '250.01' }, now);
  assert.equal(full.status, 'filled');
  assert.equal(full.refundCents, 0);
  const partial = rules.settleOrder(trade, { status: 'canceled', filled_qty: '0.1', filled_avg_price: '250' }, now);
  assert.equal(partial.status, 'filled');
  assert.equal(partial.refundCents, 2500);
  const none = rules.settleOrder(trade, { status: 'expired', filled_qty: '0' }, now);
  assert.equal(none.status, 'rejected');
  assert.equal(none.refundCents, 5000);
  assert.equal(rules.settleOrder(trade, { status: 'accepted' }, now), null);
});

test('settle: a sell credits proceeds', () => {
  const r = rules.settleOrder({ side: 'sell' }, { status: 'filled', filled_qty: '0.2', filled_avg_price: '300' }, new Date());
  assert.equal(r.proceedsCents, 6000);
  assert.equal(r.positionDelta.qty, -0.2);
});

test('applyFill: averages cost, keeps first fill time, closes at zero', () => {
  const t1 = new Date('2026-10-01T00:00:00Z');
  const t2 = new Date('2026-10-02T00:00:00Z');
  const p1 = rules.applyFill('VTI', null, { qty: 0.1, price: 200 }, t1);
  assert.deepEqual(p1, { symbol: 'VTI', qty: '0.1', avg_cost: '200', first_fill_at: t1 });
  const p2 = rules.applyFill('VTI', p1, { qty: 0.1, price: 300 }, t2);
  assert.equal(p2.qty, '0.2');
  assert.equal(p2.avg_cost, '250');
  assert.equal(p2.first_fill_at, t1);
  assert.equal(rules.applyFill('VTI', p2, { qty: -0.2, price: 310 }, t2), null);
});

test('day count', () => {
  assert.equal(rules.dayCount('2026-10-01', '2026-10-01'), 1);
  assert.equal(rules.dayCount('2026-10-01', '2026-10-10'), 10);
  assert.equal(rules.dayCount(null, '2026-10-10'), 0);
});

test('calendar: past days as stored, today pencilled from the mode', () => {
  const rows = [
    { day: '2026-09-09', state: 'clean', source: 'auto', cents: 1200, settled_at: new Date() },
    { day: '2026-09-10', state: 'smoked', source: 'edit', cents: 1200, settled_at: new Date() },
  ];
  const cal = rules.calendar({ quitDay: '2026-09-09', today: '2026-09-11', rows, mode: 'smoking' });
  assert.deepEqual(cal.map((d) => [d.day, d.state, d.settled, d.today]), [
    ['2026-09-09', 'clean', true, false],
    ['2026-09-10', 'smoked', true, false],
    ['2026-09-11', 'smoked', false, true],
  ]);
  const pencilled = [...rows, { day: '2026-09-11', state: 'clean', source: 'edit', cents: null, settled_at: null }];
  assert.equal(rules.calendar({ quitDay: '2026-09-09', today: '2026-09-11', rows: pencilled, mode: 'smoking' }).at(-1).state, 'clean');
  assert.deepEqual(rules.calendar({ quitDay: '2026-09-12', today: '2026-09-11', rows, mode: 'quit' }), []);
});

test('days to settle: every past day without a settled row, never today', () => {
  const rows = [
    { day: '2026-09-09', settled_at: new Date() },
    { day: '2026-09-11', settled_at: null },
  ];
  assert.deepEqual(rules.daysToSettle({ quitDay: '2026-09-09', today: '2026-09-12', rows }), ['2026-09-10', '2026-09-11']);
  assert.deepEqual(rules.daysToSettle({ quitDay: '2026-09-12', today: '2026-09-12', rows: [] }), []);
});

test('streak counts clean days back from today', () => {
  const d = (...states) => states.map((state) => ({ state }));
  assert.equal(rules.streak(d('clean', 'smoked', 'clean', 'clean')), 2);
  assert.equal(rules.streak(d('clean', 'clean', 'smoked')), 0);
  assert.equal(rules.streak(d('clean')), 1);
  assert.equal(rules.streak([]), 0);
});

test('day edits: only from the quit date through today', () => {
  const ok = { today: '2026-09-12', quitDay: '2026-09-09' };
  assert.doesNotThrow(() => rules.validateDayEdit({ ...ok, day: '2026-09-09' }));
  assert.doesNotThrow(() => rules.validateDayEdit({ ...ok, day: '2026-09-12' }));
  assert.throws(() => rules.validateDayEdit({ ...ok, day: '2026-09-13' }), { code: 'future_day' });
  assert.throws(() => rules.validateDayEdit({ ...ok, day: '2026-09-08' }), { code: 'before_quit' });
  assert.throws(() => rules.validateDayEdit({ ...ok, day: '2026-02-30' }), { code: 'bad_day' });
  assert.throws(() => rules.normalizeDayState('meh'), { code: 'bad_state' });
});

test('ghost: closes carry over weekends; lots value at cost until priced', () => {
  const bars = [{ day: '2026-09-18', close: 500 }, { day: '2026-09-21', close: 510 }];
  assert.equal(rules.closeOnOrBefore(bars, '2026-09-20'), 500);
  assert.equal(rules.closeOnOrBefore(bars, '2026-09-21'), 510);
  assert.equal(rules.closeOnOrBefore(bars, '2026-09-17'), null);
  assert.equal(rules.lotShares(1200, 500), '0.024');
  assert.equal(rules.lotValueCents({ cents: 1200, shares: '0.024' }, 550), 1320);
  assert.equal(rules.lotValueCents({ cents: 1200, shares: null }, 550), 1200);
  assert.equal(rules.lotValueCents({ cents: 1200, shares: '0.024' }, null), 1200);
});

test('local days follow the user timezone across DST', () => {
  assert.equal(localDay(new Date('2026-10-02T05:00:00Z'), 'America/Los_Angeles'), '2026-10-01');
  assert.equal(dayStart('2026-10-01', 'America/Los_Angeles').toISOString(), '2026-10-01T07:00:00.000Z');
  assert.equal(dayStart('2026-12-01', 'America/Los_Angeles').toISOString(), '2026-12-01T08:00:00.000Z');
  assert.equal(dayStart('2026-11-01', 'America/New_York').toISOString(), '2026-11-01T04:00:00.000Z');
});

test('settings: guardrails can tighten but not loosen', () => {
  assert.deepEqual(validateSettingsPatch({ cooldown_hours: 48, hold_days: 30 }), { cooldown_hours: 48, hold_days: 30 });
  assert.throws(() => validateSettingsPatch({ cooldown_hours: 1 }), { code: 'bad_setting' });
  assert.throws(() => validateSettingsPatch({ hold_days: 0 }), { code: 'bad_setting' });
  assert.throws(() => validateSettingsPatch({ tiers_cents: [2000, 50000] }), { code: 'bad_setting' });
  assert.throws(() => validateSettingsPatch({ daily_cents: 99999 }), { code: 'bad_setting' });
  assert.throws(() => validateSettingsPatch({ mode: 'smoking' }), { code: 'bad_setting' });
  assert.deepEqual(validateSettingsPatch({ ghost_benchmark: ' qqq ' }), { ghost_benchmark: 'QQQ' });
  assert.throws(() => validateSettingsPatch({ ghost_benchmark: 'not a ticker' }), { code: 'bad_setting' });
  assert.equal(resolveSettings({ pack_price_cents: 1350, packs_per_day: 1.5 }).daily_cents, 2025);
  assert.deepEqual(validateSettingsPatch({ tiers_cents: [5000, 2000, 5000] }), { tiers_cents: [2000, 5000] });
});
