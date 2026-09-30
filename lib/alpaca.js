// Thin Alpaca Trading API client. Only the calls this app needs.
// Paper vs live is decided by ALPACA_BASE_URL and nothing else.

export class BrokerError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    // Alpaca said no to this order; retrying will not help.
    this.definitive = [400, 403, 404, 422].includes(status);
    // We already sent this client_order_id; look it up instead.
    this.duplicate = status === 422 && /client_order_id/i.test(message || '');
  }
}

const ASSET_TTL_MS = 60 * 60 * 1000;
const DATA_URL = 'https://data.alpaca.markets';

export function makeAlpaca({ keyId, secretKey, baseUrl, dataUrl = DATA_URL, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/$/, '');
  const dataBase = dataUrl.replace(/\/$/, '');
  const mode = /paper-api\.alpaca\.markets/.test(base) ? 'paper' : 'live';
  let assetCache = { at: 0, list: null };
  // Consolidated (SIP) history is free for anything older than 15 minutes.
  // If the account cannot use it, fall back to IEX for the rest of the run.
  let barFeed = 'sip';

  async function call(path, { method = 'GET', body, host = base } = {}) {
    const r = await fetchImpl(`${host}${path}`, {
      method,
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secretKey,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404 && method === 'GET') return null;
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }
    if (!r.ok) throw new BrokerError(r.status, data?.message || `Alpaca returned ${r.status}`, data?.code);
    return data;
  }

  async function listAssets() {
    if (!assetCache.list || Date.now() - assetCache.at > ASSET_TTL_MS) {
      const all = await call('/v2/assets?status=active&asset_class=us_equity');
      assetCache = { at: Date.now(), list: (all || []).filter((a) => a.tradable && a.fractionable) };
    }
    return assetCache.list;
  }

  return {
    mode,

    getAsset(symbol) {
      return call(`/v2/assets/${encodeURIComponent(symbol)}`);
    },

    async searchAssets(q, limit = 12) {
      const needle = q.trim().toUpperCase();
      if (!needle) return [];
      let list;
      try {
        list = await listAssets();
      } catch {
        const one = await call(`/v2/assets/${encodeURIComponent(needle)}`).catch(() => null);
        return one && one.tradable && one.fractionable ? [one] : [];
      }
      const scored = [];
      for (const a of list) {
        const sym = a.symbol.toUpperCase();
        const name = (a.name || '').toUpperCase();
        let score = -1;
        if (sym === needle) score = 0;
        else if (sym.startsWith(needle)) score = 1 + sym.length / 100;
        else if (needle.length >= 3 && name.includes(needle)) score = 2;
        if (score >= 0) scored.push([score, a]);
      }
      return scored.sort((x, y) => x[0] - y[0]).slice(0, limit).map(([, a]) => a);
    },

    submitOrder({ client_order_id, symbol, side, notional_cents, qty }) {
      const order = { symbol, side, type: 'market', time_in_force: 'day', client_order_id };
      if (side === 'buy') order.notional = (notional_cents / 100).toFixed(2);
      else order.qty = String(qty);
      return call('/v2/orders', { method: 'POST', body: order });
    },

    getOrder(id) {
      return call(`/v2/orders/${encodeURIComponent(id)}`);
    },

    getOrderByClientId(clientOrderId) {
      return call(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`);
    },

    async getPositions() {
      return (await call('/v2/positions')) || [];
    },

    // Daily closes, split-adjusted, as [{ day: 'YYYY-MM-DD', close }].
    async getDailyBars(symbol, start, end) {
      const out = [];
      let pageToken = null;
      do {
        const q = new URLSearchParams({ timeframe: '1Day', start, end, adjustment: 'split', limit: '10000', feed: barFeed });
        if (pageToken) q.set('page_token', pageToken);
        let res;
        try {
          res = await call(`/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`, { host: dataBase });
        } catch (err) {
          if (barFeed === 'sip' && (err.status === 403 || err.status === 422)) {
            barFeed = 'iex';
            continue;
          }
          throw err;
        }
        for (const b of res?.bars || []) out.push({ day: String(b.t).slice(0, 10), close: Number(b.c) });
        pageToken = res?.next_page_token || null;
      } while (pageToken);
      return out.sort((a, b) => a.day.localeCompare(b.day));
    },

    async getLatestPrice(symbol) {
      const res = await call(`/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`, { host: dataBase });
      const p = Number(res?.trade?.p);
      return p > 0 ? p : null;
    },
  };
}
