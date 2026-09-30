// A stand-in for Alpaca used by tests and the local preview. Enforces the
// same things the real one does that we rely on: unique client_order_id,
// fractionable checks, and order lifecycles.
import { randomUUID } from 'node:crypto';
import { BrokerError } from './alpaca.js';

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
].map(([symbol, name, price]) => ({
  symbol, name, price, class: 'us_equity', status: 'active', tradable: true, fractionable: true, exchange: 'NYSE',
}));
ASSETS.push({ symbol: 'NOFR', name: 'No Fractions Corp', price: 10, class: 'us_equity', status: 'active', tradable: true, fractionable: false, exchange: 'NASDAQ' });

export function makeFakeBroker({ autoFill = false, mode = 'paper', clock = () => new Date() } = {}) {
  const assets = new Map(ASSETS.map((a) => [a.symbol, { ...a }]));
  const orders = new Map(); // by client_order_id
  const holdings = new Map(); // symbol -> qty
  const calls = [];
  let failNext = null;

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
    async getPositions() {
      calls.push(['getPositions']);
      return [...holdings.entries()].map(([symbol, qty]) => {
        const price = assets.get(symbol).price;
        return { symbol, qty: String(qty), current_price: String(price), market_value: String(+(qty * price).toFixed(2)) };
      });
    },
  };
}
