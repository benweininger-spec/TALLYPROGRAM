// Every banking and trading rule, as pure functions. The API calls these;
// nothing here trusts the browser, touches the database, or calls Alpaca.
import { RuleError } from './errors.js';
import { HARD } from './config.js';
import { daysBetween, addDays, isDay } from './time.js';

const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const DAY_MS = 86400000;

// ---------- bank ----------

export function unlockedTiers(bankCents, settings) {
  return settings.tiers_cents.filter((t) => t >= settings.min_trade_cents && t <= bankCents);
}

// ---------- days ----------

// Quit day is day 1.
export function dayCount(quitDay, today) {
  if (!quitDay) return 0;
  return Math.max(0, daysBetween(quitDay, today) + 1);
}

export function burnedCents(settings, days) {
  return Math.round(settings.pack_price_cents * settings.packs_per_day * days);
}

// ---------- calendar ----------
// Every day since the quit date is clean or smoked. Past days are settled:
// their amount sits in the bank (clean) or the ghost (smoked). Today is
// pencilled in and settles at local midnight.

export function defaultState(mode) {
  return mode === 'smoking' ? 'smoked' : 'clean';
}

export function normalizeDayState(state) {
  if (state === 'clean' || state === 'smoked') return state;
  throw new RuleError('bad_state', 'A day is clean or smoked');
}

// Past days (quit date through yesterday) that have not settled yet.
export function daysToSettle({ quitDay, today, rows }) {
  if (!quitDay) return [];
  const settled = new Set(rows.filter((r) => r.settled_at).map((r) => r.day));
  const out = [];
  for (let d = quitDay; d < today; d = addDays(d, 1)) if (!settled.has(d)) out.push(d);
  return out;
}

// One entry per day from the quit date through today, oldest first.
export function calendar({ quitDay, today, rows, mode }) {
  if (!quitDay || quitDay > today) return [];
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let d = quitDay; d <= today; d = addDays(d, 1)) {
    const r = byDay.get(d);
    out.push({
      day: d,
      state: r?.state ?? defaultState(mode),
      source: r?.source ?? 'auto',
      settled: Boolean(r?.settled_at),
      cents: r?.cents ?? null,
      today: d === today,
    });
  }
  return out;
}

// Consecutive clean days ending today, counting today's pencilled mark.
export function streak(days) {
  let n = 0;
  for (let i = days.length - 1; i >= 0 && days[i].state === 'clean'; i--) n++;
  return n;
}

export function validateDayEdit({ day, today, quitDay }) {
  if (!isDay(day)) throw new RuleError('bad_day', 'Use a date like 2026-09-21');
  if (!quitDay || day < quitDay) throw new RuleError('before_quit', 'That day was before the quit date');
  if (day > today) throw new RuleError('future_day', 'That day has not happened yet');
}

// ---------- ghost ----------

// The last close on or before a day. Bars are [{ day, close }] sorted by day.
export function closeOnOrBefore(bars, day) {
  let found = null;
  for (const b of bars) {
    if (b.day > day) break;
    found = b.close;
  }
  return found;
}

export function lotShares(cents, close) {
  return String(+(cents / 100 / close).toFixed(9));
}

// A lot is worth its shares at the given price, or its cost until priced.
export function lotValueCents(lot, price) {
  if (lot.shares == null || !(price > 0)) return lot.cents;
  return Math.round(Number(lot.shares) * price * 100);
}

// ---------- trades ----------

export function normalizeSymbol(symbol) {
  const s = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  if (!SYMBOL_RE.test(s)) throw new RuleError('bad_symbol', 'That is not a ticker symbol');
  return s;
}

export function normalizeSide(side) {
  if (side === 'buy' || side === 'sell') return side;
  throw new RuleError('bad_side', 'Only plain buys and sells. No shorting.');
}

export function executeAfter(now, settings) {
  return new Date(now.getTime() + settings.cooldown_hours * 3600000);
}

export function checkAsset(asset) {
  if (!asset) throw new RuleError('unknown_symbol', 'Alpaca does not list that symbol');
  if (asset.class !== 'us_equity') throw new RuleError('not_equity', 'Only US stocks and ETFs');
  if (!asset.tradable || asset.status !== 'active') throw new RuleError('not_tradable', 'That symbol is not tradable right now');
  if (!asset.fractionable) throw new RuleError('not_fractionable', 'That symbol cannot be bought in fractional shares');
}

export function validateBuy({ notionalCents, bankCents, asset, settings }) {
  if (!Number.isInteger(notionalCents)) throw new RuleError('bad_amount', 'Amount must be whole cents');
  if (notionalCents < HARD.MIN_TRADE_CENTS || notionalCents > HARD.MAX_TRADE_CENTS) {
    throw new RuleError('out_of_bounds', 'Trades are $20 to $200');
  }
  if (notionalCents < settings.min_trade_cents) throw new RuleError('below_minimum', 'Below your minimum trade');
  if (!settings.tiers_cents.includes(notionalCents)) throw new RuleError('not_a_tier', 'Pick one of your tiers');
  if (notionalCents > bankCents) throw new RuleError('insufficient_bank', 'Not enough in the bank yet');
  checkAsset(asset);
}

export function holdUnlocksAt(position, settings) {
  return new Date(new Date(position.first_fill_at).getTime() + settings.hold_days * DAY_MS);
}

export function validateSell({ position, pendingSell, now, settings }) {
  if (!position) throw new RuleError('no_position', 'You do not hold that symbol');
  if (pendingSell) throw new RuleError('sell_pending', 'A sell for that symbol is already queued');
  const unlocks = holdUnlocksAt(position, settings);
  if (!(unlocks < now)) {
    throw new RuleError('hold_locked', `Held positions unlock on ${unlocks.toISOString().slice(0, 10)}`);
  }
}

// ---------- fills ----------

const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected']);

// Turns a finished Alpaca order into what should happen to our books.
// Returns null while the order is still working.
export function settleOrder(trade, order, now) {
  if (!TERMINAL.has(order.status)) return null;
  const qty = Number(order.filled_qty || 0);
  const price = Number(order.filled_avg_price || 0);
  if (qty > 0 && price > 0) {
    const filledCents = Math.round(qty * price * 100);
    const partial = order.status !== 'filled';
    const base = {
      status: 'filled',
      fill_qty: String(order.filled_qty),
      fill_price: String(order.filled_avg_price),
      filled_at: order.filled_at ? new Date(order.filled_at) : now,
      reason: partial ? `Partially filled, then ${order.status}` : null,
    };
    if (trade.side === 'buy') {
      const refund = partial ? Math.max(0, trade.notional_cents - filledCents) : 0;
      return { ...base, refundCents: refund, proceedsCents: 0, positionDelta: { qty, price } };
    }
    return { ...base, refundCents: 0, proceedsCents: filledCents, positionDelta: { qty: -qty, price } };
  }
  return {
    status: 'rejected',
    reason: `Order ${order.status}${order.reject_reason ? `: ${order.reject_reason}` : ''}`,
    refundCents: trade.side === 'buy' ? trade.notional_cents : 0,
    proceedsCents: 0,
    positionDelta: null,
  };
}

// Applies a fill to a position. Returns the new position, or null if closed.
export function applyFill(symbol, position, { qty, price }, at) {
  const oldQty = position ? Number(position.qty) : 0;
  const newQty = +(oldQty + qty).toFixed(9);
  if (newQty <= 0) return null;
  if (qty > 0) {
    const oldCost = position ? Number(position.avg_cost) * oldQty : 0;
    return {
      symbol,
      qty: String(newQty),
      avg_cost: String(+((oldCost + qty * price) / newQty).toFixed(6)),
      // The hold clock starts at the first fill and does not reset on top-ups.
      first_fill_at: position ? position.first_fill_at : at,
    };
  }
  return { ...position, qty: String(newQty) };
}

// ---------- trading vs. saving ----------
// The bank earns nothing, so a trade's gain on what the bank paid for it is
// its upside over straight saving.

// Replays filled trades in fill order, with cost counted in what the bank
// actually paid (debit less any refund) and proceeds in what it got back.
// `cash` maps trade id -> net bank cents for that trade. Returns the cost of
// what is still held, per symbol, and the gain booked by sells.
export function tradeBook(filled, cash = new Map()) {
  const open = new Map();
  let realized = 0;
  let bought = 0;
  let sells = 0;
  const atFill = (t) => Math.round(Number(t.fill_qty) * Number(t.fill_price) * 100);
  const order = [...filled]
    .filter((t) => t.status === 'filled' && Number(t.fill_qty) > 0)
    .sort((a, b) => new Date(a.filled_at) - new Date(b.filled_at));
  for (const t of order) {
    const qty = Number(t.fill_qty);
    const b = open.get(t.symbol) || { qty: 0, cost_cents: 0 };
    if (t.side === 'buy') {
      const cost = cash.has(t.id) ? -cash.get(t.id) : atFill(t);
      bought += cost;
      open.set(t.symbol, { qty: +(b.qty + qty).toFixed(9), cost_cents: b.cost_cents + cost });
      continue;
    }
    const proceeds = cash.has(t.id) ? cash.get(t.id) : atFill(t);
    const left = +(b.qty - qty).toFixed(9);
    const removed = left <= 0 ? b.cost_cents : Math.round((b.cost_cents * qty) / b.qty);
    realized += proceeds - removed;
    sells++;
    if (left <= 0) open.delete(t.symbol);
    else open.set(t.symbol, { qty: left, cost_cents: b.cost_cents - removed });
  }
  return { open, realized_cents: realized, bought_cents: bought, sells };
}

// What trading has added or cost against leaving every dollar in the bank:
// gains on what is held now plus gains already booked by sells.
export function tradingNet(book, positions) {
  const unrealized = positions.reduce((a, p) => a + (p.value_cents - p.cost_cents), 0);
  return {
    net_cents: book.realized_cents + unrealized,
    realized_cents: book.realized_cents,
    unrealized_cents: unrealized,
    bought_cents: book.bought_cents,
    sells: book.sells,
  };
}
