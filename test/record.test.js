import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionsOf, entrySession, paperRecord, RECORD_LOT_CENTS } from '../lib/record.js';
import { tradeBook, tradingNet } from '../lib/rules.js';
import { addDays } from '../lib/time.js';

// Calendar-day closes the way the cache holds them: weekends and holidays
// repeat the last session's close.
function cacheOf(from, to, sessions) {
  const m = new Map();
  let last;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (sessions[d] !== undefined) last = sessions[d];
    if (last !== undefined) m.set(d, last);
  }
  return m;
}
const ed = (day, index, sector, name) => ({ day, content: { rungs: { index: { symbol: index }, sector: { symbol: sector }, name: { symbol: name } } } });

test('sessions: weekends and holidays repeat a close and are not sessions', () => {
  // Fri Sept 4, Labor Day Mon Sept 7 closed, Tue Sept 8.
  const m = cacheOf('2026-09-03', '2026-09-08', { '2026-09-03': 100, '2026-09-04': 101, '2026-09-08': 103 });
  assert.deepEqual(sessionsOf(m).map((x) => x.day), ['2026-09-03', '2026-09-04', '2026-09-08']);
  const s = sessionsOf(m);
  // An edition printed on the holiday, or the weekend before it, buys at
  // Tuesday's close: never a price from before it went to press.
  assert.deepEqual(entrySession(s, '2026-09-05'), { day: '2026-09-08', close: 103 });
  assert.deepEqual(entrySession(s, '2026-09-07'), { day: '2026-09-08', close: 103 });
  assert.deepEqual(entrySession(s, '2026-09-04'), { day: '2026-09-04', close: 101 });
  assert.equal(entrySession(s, '2026-09-09'), null);
});

test('record: $20 a rung at the close, scored against the mattress', () => {
  const closes = {
    VOO: cacheOf('2026-09-30', '2026-10-05', { '2026-09-30': 500, '2026-10-01': 505, '2026-10-02': 510, '2026-10-05': 520 }),
    XLK: cacheOf('2026-09-30', '2026-10-05', { '2026-09-30': 200, '2026-10-01': 200.5, '2026-10-02': 198, '2026-10-05': 190 }),
    COST: cacheOf('2026-09-30', '2026-10-05', { '2026-09-30': 900, '2026-10-01': 901, '2026-10-02': 905, '2026-10-05': 910 }),
    VTI: cacheOf('2026-10-01', '2026-10-05', { '2026-10-01': 290, '2026-10-02': 292, '2026-10-05': 295 }),
  };
  const editions = [
    ed('2026-10-01', 'VOO', 'XLK', 'COST'),
    ed('2026-10-03', 'VTI', 'XLK', 'COST'), // a Saturday: buys Monday's close
    ed('2026-10-06', 'VOO', 'XLK', 'COST'), // today: no close yet
  ];
  const r = paperRecord({ editions, closes, today: '2026-10-06' });
  assert.equal(r.since, '2026-10-01');
  assert.equal(r.as_of, '2026-10-05');
  assert.equal(r.editions, 3);
  assert.equal(r.pending, 1);
  const L = RECORD_LOT_CENTS;
  // Index: VOO at 505 now 520; VTI bought Monday at 295, still 295.
  assert.deepEqual(r.rungs.index, { picks: 2, in_cents: 2 * L, now_cents: Math.round((L * 520) / 505) + L, pct: r.rungs.index.pct });
  assert.equal(r.rungs.index.pct, Math.round(((Math.round((L * 520) / 505) + L) / (2 * L) - 1) * 1e6) / 1e6);
  assert.ok(r.rungs.sector.pct < 0, 'the paper reports its misses');
  assert.deepEqual(r.mattress, { picks: 2, in_cents: 2 * L, now_cents: 2 * L, pct: 0 });
  assert.equal(r.best.symbol, 'VOO');
  assert.equal(r.worst.symbol, 'XLK');
  assert.equal(r.worst.day, '2026-10-01');
  // One row a day from the first edition through today. A lot joins on its
  // entry session; the weekend edition is not in until Monday.
  assert.deepEqual(r.days.map((d) => d.day), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
  assert.equal(r.days[0].index, 0);
  assert.equal(r.days[1].index, Math.round((Math.round((L * 510) / 505) / L - 1) * 1e6) / 1e6);
  assert.equal(r.days[3].index, r.days[1].index);
  assert.equal(r.days.at(-1).index, r.rungs.index.pct);
  assert.equal(r.days.at(-1).sector, r.rungs.sector.pct);
});

test('record: a rung with no price yet is not scored, and no editions is an empty record', () => {
  const r = paperRecord({ editions: [ed('2026-10-06', 'VOO', 'XLK', 'COST')], closes: {}, today: '2026-10-06' });
  assert.equal(r.editions, 1);
  assert.equal(r.pending, 1);
  assert.deepEqual(r.rungs.name, { picks: 0, in_cents: 0, now_cents: 0, pct: null });
  assert.equal(r.mattress.pct, null);
  assert.equal(r.best, null);
  assert.deepEqual(r.days, [{ day: '2026-10-06', index: null, sector: null, name: null }]);
  const none = paperRecord({ editions: [], closes: {}, today: '2026-10-06' });
  assert.equal(none.since, null);
  assert.equal(none.editions, 0);
  assert.deepEqual(none.days, []);
});

const fill = (id, symbol, side, qty, price, at) => ({ id, symbol, side, status: 'filled', fill_qty: String(qty), fill_price: String(price), filled_at: at });

test('trade book: cost is what the bank paid, gains booked when sold', () => {
  const trades = [
    fill('b1', 'VTI', 'buy', 0.2, 250, '2026-10-01T14:00:00Z'),
    fill('b2', 'VTI', 'buy', 0.1, 300, '2026-10-02T14:00:00Z'),
    fill('b3', 'AAPL', 'buy', 0.08, 230, '2026-10-02T15:00:00Z'), // partly filled, $1.60 refunded
    fill('s1', 'VTI', 'sell', 0.3, 310, '2026-10-12T14:00:00Z'),
  ];
  const cash = new Map([['b1', -5000], ['b2', -3000], ['b3', -1840], ['s1', 9300]]);
  const book = tradeBook(trades, cash);
  assert.equal(book.bought_cents, 9840);
  assert.equal(book.realized_cents, 9300 - 8000);
  assert.equal(book.sells, 1);
  assert.deepEqual([...book.open.keys()], ['AAPL']);
  assert.equal(book.open.get('AAPL').cost_cents, 1840);
  const net = tradingNet(book, [{ value_cents: 2000, cost_cents: 1840 }]);
  assert.deepEqual(net, { net_cents: 1300 + 160, realized_cents: 1300, unrealized_cents: 160, bought_cents: 9840, sells: 1 });
});

test('trade book: a partial sell keeps the rest at its share of the cost', () => {
  const trades = [fill('b1', 'VOO', 'buy', 0.04, 500, '2026-10-01T14:00:00Z'), fill('s1', 'VOO', 'sell', 0.01, 520, '2026-10-09T14:00:00Z')];
  const book = tradeBook(trades, new Map([['b1', -2000], ['s1', 520]]));
  assert.equal(book.realized_cents, 520 - 500);
  assert.equal(book.open.get('VOO').cost_cents, 1500);
  assert.equal(book.open.get('VOO').qty, 0.03);
  // Without ledger rows, the fill itself is the cost.
  assert.equal(tradeBook(trades).bought_cents, 2000);
});
