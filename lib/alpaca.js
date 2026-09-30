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

export function makeAlpaca({ keyId, secretKey, baseUrl, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/$/, '');
  const mode = /paper-api\.alpaca\.markets/.test(base) ? 'paper' : 'live';
  let assetCache = { at: 0, list: null };

  async function call(path, { method = 'GET', body } = {}) {
    const r = await fetchImpl(`${base}${path}`, {
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
  };
}
