// A stand-in for Alpaca used by tests and the local preview. Enforces the
// same things the real one does that we rely on: unique client_order_id,
// fractionable checks, and order lifecycles.
import { randomUUID } from 'node:crypto';
import { BrokerError } from './alpaca.js';
import { addDays, daysBetween } from './time.js';

// [symbol, name, price, drift per day, wobble phase]. Drift and phase only
// shape the fake closes; the first ten keep the original curve the tests use.
const ASSETS = [
  ['VTI', 'Vanguard Total Stock Market ETF', 290.12],
  ['VOO', 'Vanguard S&P 500 ETF', 545.3],
  ['SPY', 'SPDR S&P 500 ETF Trust', 592.4],
  ['QQQ', 'Invesco QQQ Trust', 512.75],
  ['SCHD', 'Schwab US Dividend Equity ETF', 28.4],
  ['AAPL', 'Apple Inc. Common Stock', 231.5],
  ['MSFT', 'Microsoft Corporation Common Stock', 452.1],
  ['NVDA', 'NVIDIA Corporation Common Stock', 138.2],
  ['BRK.B', 'Berkshire Hathaway Inc. Class B', 470.05],
  ['TSLA', 'Tesla, Inc. Common Stock', 251.2],
  // The rest of the Market Page's default universe.
  ['VXUS', 'Vanguard Total International Stock ETF', 66.8, 0.0006, 1.3],
  ['XLK', 'Technology Select Sector SPDR Fund', 238.6, 0.0019, 0.4],
  ['XLV', 'Health Care Select Sector SPDR Fund', 147.9, -0.0004, 2.1],
  ['XLF', 'Financial Select Sector SPDR Fund', 50.2, 0.0009, 3.3],
  ['XLE', 'Energy Select Sector SPDR Fund', 88.4, -0.0021, 0.9],
  ['XLP', 'Consumer Staples Select Sector SPDR Fund', 81.1, 0.0002, 4.0],
  ['XLY', 'Consumer Discretionary Select Sector SPDR Fund', 214.7, 0.0013, 5.1],
  ['XLI', 'Industrial Select Sector SPDR Fund', 139.5, 0.0008, 1.8],
  ['XLU', 'Utilities Select Sector SPDR Fund', 79.3, -0.0007, 2.7],
  ['VNQ', 'Vanguard Real Estate ETF', 92.6, -0.0012, 3.9],
  ['JNJ', 'Johnson & Johnson Common Stock', 156.2, -0.0009, 0.2],
  ['PG', 'Procter & Gamble Company Common Stock', 168.4, 0.0003, 1.1],
  ['KO', 'Coca-Cola Company Common Stock', 69.7, 0.0001, 2.4],
  ['PEP', 'PepsiCo, Inc. Common Stock', 151.8, -0.0016, 3.6],
  ['COST', 'Costco Wholesale Corporation Common Stock', 942.3, 0.0024, 4.7],
  ['WMT', 'Walmart Inc. Common Stock', 98.1, 0.0015, 0.6],
  ['JPM', 'JPMorgan Chase & Co. Common Stock', 251.9, 0.0011, 5.5],
  ['HD', 'Home Depot, Inc. Common Stock', 402.6, -0.0003, 1.6],
  ['UNH', 'UnitedHealth Group Incorporated Common Stock', 318.4, -0.0031, 2.9],
].map(([symbol, name, price, drift = 0.0011, phase = 0]) => ({
  symbol, name, price, drift, phase, class: 'us_equity', status: 'active', tradable: true, fractionable: true, exchange: 'NYSE',
}));
ASSETS.push({ symbol: 'NOFR', name: 'No Fractions Corp', price: 10, drift: 0.0011, phase: 0, class: 'us_equity', status: 'active', tradable: true, fractionable: false, exchange: 'NASDAQ' });

export function makeFakeBroker({ autoFill = false, mode = 'paper', clock = () => new Date() } = {}) {
  const assets = new Map(ASSETS.map((a) => [a.symbol, { ...a }]));
  const orders = new Map(); // by client_order_id
  const holdings = new Map(); // symbol -> qty
  const calls = [];
  let failNext = null;
  // Closes are a function of the date, measured from the day this broker was
  // made, so a day's close is the same whenever it is fetched.
  const anchor = clock().toISOString().slice(0, 10);

  function fillOrder(o, { qty, price, status = 'filled' } = {}) {
    const px = price ?? assets.get(o.symbol).price;
    const q = qty ?? (o.notional ? +(Number(o.notional) / px).toFixed(9) : Number(o.qty));
    o.status = status;
    o.filled_qty = String(q);
    o.filled_avg_price = q > 0 ? String(px) : null;
    o.filled_at = q > 0 ? clock().toISOString() : null;
    const held = holdings.get(o.symbol) || 0;
    const next = +(held + (o.side === 'buy' ? q : -q)).toFixed(9);
    if (next > 0) holdings.set(o.symbol, next);
    else holdings.delete(o.symbol);
    return o;
  }

  return {
    mode,
    calls,
    assets,
    orders,
    // Makes the next broker call throw (e.g. a network error or a 403).
    failNextWith(err) {
      failNext = err;
    },
    setPrice(symbol, price) {
      assets.get(symbol).price = price;
    },
    fill(clientOrderId, opts) {
      return fillOrder(orders.get(clientOrderId), opts);
    },
    setStatus(clientOrderId, status) {
      orders.get(clientOrderId).status = status;
    },

    async getAsset(symbol) {
      calls.push(['getAsset', symbol]);
      return assets.has(symbol) ? { ...assets.get(symbol) } : null;
    },
    async searchAssets(q) {
      const n = q.trim().toUpperCase();
      return [...assets.values()]
        .filter((a) => a.fractionable && (a.symbol.startsWith(n) || (n.length >= 3 && a.name.toUpperCase().includes(n))))
        .slice(0, 12);
    },
    async submitOrder({ client_order_id, symbol, side, notional_cents, qty }) {
      calls.push(['submitOrder', client_order_id, symbol, side]);
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      if (orders.has(client_order_id)) throw new BrokerError(422, 'client_order_id must be unique', 40010001);
      const a = assets.get(symbol);
      if (!a) throw new BrokerError(422, `asset ${symbol} not found`);
      if (!a.fractionable) throw new BrokerError(422, 'fractional orders are not supported for this asset');
      if (side === 'sell' && Number(qty) > (holdings.get(symbol) || 0) + 1e-9) throw new BrokerError(403, 'insufficient qty available for order');
      const o = {
        id: randomUUID(), client_order_id, symbol, side, type: 'market', time_in_force: 'day',
        notional: side === 'buy' ? (notional_cents / 100).toFixed(2) : null,
        qty: side === 'sell' ? String(qty) : null,
        status: 'accepted', filled_qty: '0', filled_avg_price: null, filled_at: null,
      };
      orders.set(client_order_id, o);
      if (autoFill) fillOrder(o);
      return { ...o };
    },
    async getOrder(id) {
      calls.push(['getOrder', id]);
      const o = [...orders.values()].find((x) => x.id === id);
      return o ? { ...o } : null;
    },
    async getOrderByClientId(cid) {
      calls.push(['getOrderByClientId', cid]);
      const o = orders.get(cid);
      return o ? { ...o } : null;
    },
    // Weekday closes on a gentle wobble that lands near the price on the day
    // this broker was made.
    async getDailyBars(symbol, start, end) {
      calls.push(['getDailyBars', symbol, start, end]);
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      const a = assets.get(symbol);
      if (!a) return [];
      const today = clock().toISOString().slice(0, 10);
      const out = [];
      for (let d = start; d <= end && d < today; d = addDays(d, 1)) {
        const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const k = daysBetween(d, anchor);
        out.push({ day: d, close: +(a.price * (1 - a.drift * k + 0.012 * Math.sin(k * 0.9 + a.phase))).toFixed(2) });
      }
      return out;
    },
    // A few plausible wire headlines about whichever tickers are asked for.
    async getNews({ symbols, start, limit = 20 }) {
      calls.push(['getNews', symbols.join(','), start, limit]);
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      const at = new Date(clock().getTime() - 3 * 3600000).toISOString();
      const lines = [
        ['COST', 'Reuters', 'Costco monthly sales rise 6%, membership renewals hold at 93%'],
        ['XLE', 'Benzinga', 'Energy shares slip as crude falls for a second session'],
        ['AAPL', 'Reuters', 'Apple shares little changed after supplier report'],
        ['XLK', 'Benzinga', 'Technology sector leads broad market higher'],
        ['JPM', 'Reuters', 'JPMorgan reports record trading revenue for the quarter'],
        ['VOO', 'Benzinga', 'S&P 500 closes slightly higher in light volume'],
      ];
      return lines
        .filter(([sym]) => symbols.includes(sym))
        .slice(0, limit)
        .map(([sym, source, headline]) => ({ source, at, headline, symbols: [sym] }));
    },
    async getLatestPrice(symbol) {
      calls.push(['getLatestPrice', symbol]);
      return assets.get(symbol)?.price ?? null;
    },
    async getPositions() {
      calls.push(['getPositions']);
      return [...holdings.entries()].map(([symbol, qty]) => {
        const price = assets.get(symbol).price;
        return { symbol, qty: String(qty), current_price: String(price), market_value: String(+(qty * price).toFixed(2)) };
      });
    },
  };
}
