// In-memory store with the same interface as the Postgres store. Used by the
// tests and by the local preview server. Transactions are serialized and roll
// back on error, like the real thing.
import { randomUUID } from 'node:crypto';

export function makeMemoryStore() {
  let db = {
    settings: {},
    cravings: [],
    ledger: [],
    trades: [],
    positions: {},
    snapshots: {},
  };
  const t = (d) => new Date(d).getTime();
  const copy = (x) => (x ? structuredClone(x) : x);

  const repo = {
    async getSettingsRaw() {
      return copy(db.settings);
    },
    async putSettings(obj) {
      Object.assign(db.settings, copy(obj));
    },
    async bankBalance() {
      return db.ledger.reduce((a, e) => a + e.delta_cents, 0);
    },
    async creditedBetween(start, end) {
      return db.cravings
        .filter((c) => t(c.occurred_at) >= t(start) && t(c.occurred_at) < t(end))
        .reduce((a, c) => a + c.credited_cents, 0);
    },
    async cravingCountsBetween(start, end) {
      const rows = db.cravings.filter((c) => t(c.occurred_at) >= t(start) && t(c.occurred_at) < t(end));
      return { beaten: rows.filter((c) => c.beaten).length, slipped: rows.filter((c) => !c.beaten).length };
    },
    async lastSlipAt() {
      const slips = db.cravings.filter((c) => !c.beaten).map((c) => t(c.occurred_at));
      return slips.length ? new Date(Math.max(...slips)) : null;
    },
    async insertCraving(c) {
      const row = { id: randomUUID(), occurred_at: new Date(), note: null, credited_cents: 0, ...c };
      db.cravings.push(row);
      return copy(row);
    },
    async insertLedger(e) {
      if (!e.delta_cents) throw new Error('ledger delta must be non-zero');
      const row = { id: randomUUID(), occurred_at: new Date(), ref_id: null, ...e };
      db.ledger.push(row);
      return copy(row);
    },
    async listLedger() {
      return copy(db.ledger);
    },
    async insertTrade(tr) {
      if (tr.side === 'buy' && !(tr.notional_cents >= 2000 && tr.notional_cents <= 20000)) {
        throw new Error('violates check constraint buy_notional_bounds');
      }
      const row = {
        id: randomUUID(), created_at: new Date(), notional_cents: null, qty: null, status: 'queued',
        alpaca_order_id: null, submitted_at: null, filled_at: null, fill_price: null, fill_qty: null, reason: null,
        ...tr,
      };
      db.trades.push(row);
      return copy(row);
    },
    async getTrade(id) {
      return copy(db.trades.find((x) => x.id === id) || null);
    },
    async updateTrade(id, patch) {
      const row = db.trades.find((x) => x.id === id);
      if (!row) throw new Error('no such trade');
      Object.assign(row, copy(patch));
      return copy(row);
    },
    async claimDue(now) {
      const due = db.trades.filter((x) => x.status === 'queued' && t(x.execute_after) <= t(now));
      for (const x of due) Object.assign(x, { status: 'submitted', submitted_at: new Date(now) });
      return copy(due);
    },
    async listTrades({ statuses, limit = 100 } = {}) {
      return copy(
        db.trades
          .filter((x) => !statuses || statuses.includes(x.status))
          .sort((a, b) => t(b.created_at) - t(a.created_at))
          .slice(0, limit),
      );
    },
    async getPosition(symbol) {
      return copy(db.positions[symbol] || null);
    },
    async listPositions() {
      return copy(Object.values(db.positions).sort((a, b) => a.symbol.localeCompare(b.symbol)));
    },
    async putPosition(p) {
      db.positions[p.symbol] = { ...copy(p), updated_at: new Date() };
    },
    async deletePosition(symbol) {
      delete db.positions[symbol];
    },
    async upsertSnapshot(s) {
      db.snapshots[s.day] = copy(s);
    },
    async listSnapshots(fromDay) {
      return copy(Object.values(db.snapshots).filter((s) => s.day >= fromDay).sort((a, b) => a.day.localeCompare(b.day)));
    },
  };

  let chain = Promise.resolve();
  return {
    kind: 'memory',
    tx(fn) {
      const run = chain.then(async () => {
        const saved = structuredClone(db);
        try {
          return await fn(repo);
        } catch (err) {
          db = saved;
          throw err;
        }
      });
      chain = run.catch(() => {});
      return run;
    },
    run(fn) {
      return fn(repo);
    },
    async end() {},
    // Test hook: move the clock on stored rows.
    _db: () => db,
  };
}
