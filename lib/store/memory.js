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
    days: {},
    lots: {},
    closes: {},
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
    async insertLedger(e) {
      if (!e.delta_cents) throw new Error('ledger delta must be non-zero');
      const row = { id: randomUUID(), occurred_at: new Date(), ref_id: null, day: null, ...e };
      db.ledger.push(row);
      return copy(row);
    },
    async listLedger() {
      return copy(db.ledger);
    },
    // v1 craving credits and the offsets already booked against them.
    async legacyCravings(offsetRef) {
      const rows = db.ledger.filter((e) => e.kind === 'craving' || (e.kind === 'adjust' && e.ref_id === offsetRef));
      const cravings = rows.filter((e) => e.kind === 'craving').map((e) => t(e.occurred_at));
      return { net: rows.reduce((a, e) => a + e.delta_cents, 0), lastAt: cravings.length ? new Date(Math.max(...cravings)) : null };
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
      db.snapshots[s.day] = { ghost_cents: 0, ...copy(s) };
    },
    async listDays() {
      return copy(Object.values(db.days).sort((a, b) => a.day.localeCompare(b.day)));
    },
    async getDay(day) {
      return copy(db.days[day] || null);
    },
    async putDay(row) {
      if ((row.settled_at == null) !== (row.cents == null)) throw new Error('violates check constraint days_settled_has_cents');
      db.days[row.day] = { source: 'auto', cents: null, settled_at: null, ...copy(row), updated_at: new Date() };
    },
    async deleteDay(day) {
      delete db.days[day];
    },
    async listLots() {
      return copy(Object.values(db.lots).sort((a, b) => a.day.localeCompare(b.day)));
    },
    async getLot(day) {
      return copy(db.lots[day] || null);
    },
    async putLot(lot) {
      db.lots[lot.day] = { shares: null, price: null, created_at: new Date(), ...copy(lot) };
    },
    async deleteLot(day) {
      delete db.lots[day];
    },
    async setLotPrice(day, shares, price) {
      if (db.lots[day]) Object.assign(db.lots[day], { shares, price });
    },
    async rebenchmarkLots(benchmark) {
      for (const l of Object.values(db.lots)) Object.assign(l, { benchmark, shares: null, price: null });
    },
    async listCloses(symbol, from, to) {
      return copy(
        Object.values(db.closes)
          .filter((c) => c.symbol === symbol && c.day >= from && c.day <= to)
          .sort((a, b) => a.day.localeCompare(b.day)),
      );
    },
    async putCloses(rows) {
      for (const r of rows) db.closes[`${r.symbol}|${r.day}`] = { ...r, close: String(r.close) };
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
