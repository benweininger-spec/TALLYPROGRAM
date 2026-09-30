// Every banking and trading rule, as pure functions. The API calls these;
// nothing here trusts the browser, touches the database, or calls Alpaca.
import { RuleError } from './errors.js';
import { HARD } from './config.js';
import { daysBetween } from './time.js';

const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const DAY_MS = 86400000;

// ---------- bank ----------

// A beaten craving credits the per-craving amount, but never past the daily
// cap. Near the cap it credits the remainder. A slip credits nothing.
export function creditForCraving({ beaten, todayCreditedCents, settings }) {
  if (!beaten) return 0;
  const room = settings.daily_credit_cap_cents - todayCreditedCents;
  return Math.max(0, Math.min(settings.credit_per_craving_cents, room));
}

export function unlockedTiers(bankCents, settings) {
  return settings.tiers_cents.filter((t) => t >= settings.min_trade_cents && t <= bankCents);
}

// ---------- days ----------

// Quit day is day 1.
export function dayCount(quitDay, today) {
  if (!quitDay) return 0;
  return Math.max(0, daysBetween(quitDay, today) + 1);
}

// Whole days without smoking, counting today. A slip today makes it zero.
export function streakDays({ quitDay, today, lastSlipDay }) {
  if (lastSlipDay && (!quitDay || lastSlipDay >= quitDay)) return Math.max(0, daysBetween(lastSlipDay, today));
  return dayCount(quitDay, today);
}

export function burnedCents(settings, days) {
  return Math.round(settings.pack_price_cents * settings.packs_per_day * days);
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
