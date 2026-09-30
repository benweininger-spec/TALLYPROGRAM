// Postgres store. Connects through Supabase's transaction pooler as the
// database owner, so RLS does not apply here; the rules in lib/rules.js and
// lib/service.js are the gatekeepers. Every write runs in a transaction that
// holds one advisory lock, so a double-tap can never double-spend the bank.
import postgres from 'postgres';

const WRITE_LOCK = 72630001;

const TRADE_COLS = `id, created_at, symbol, side::text as side, notional_cents, qty::text as qty,
  execute_after, status::text as status, alpaca_order_id, submitted_at, filled_at,
  fill_price::text as fill_price, fill_qty::text as fill_qty, reason`;

function makeRepo(sql) {
  return {
    async getSettingsRaw() {
      const rows = await sql`select key, value from settings`;
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async putSettings(obj) {
      for (const [key, value] of Object.entries(obj)) {
        await sql`insert into settings (key, value, updated_at) values (${key}, ${sql.json(value)}, now())
          on conflict (key) do update set value = excluded.value, updated_at = now()`;
      }
    },
    async bankBalance() {
      const [r] = await sql`select coalesce(sum(delta_cents), 0)::int as n from bank_ledger`;
      return r.n;
    },
    async creditedBetween(start, end) {
      const [r] = await sql`select coalesce(sum(credited_cents), 0)::int as n from cravings
        where occurred_at >= ${start} and occurred_at < ${end}`;
      return r.n;
    },
    async cravingCountsBetween(start, end) {
      const [r] = await sql`select
          count(*) filter (where beaten)::int as beaten,
          count(*) filter (where not beaten)::int as slipped
        from cravings where occurred_at >= ${start} and occurred_at < ${end}`;
      return r;
    },
    async lastSlipAt() {
      const [r] = await sql`select max(occurred_at) as at from cravings where not beaten`;
      return r.at;
    },
    async insertCraving(c) {
      const [row] = await sql`insert into cravings (occurred_at, beaten, credited_cents, note)
        values (${c.occurred_at}, ${c.beaten}, ${c.credited_cents}, ${c.note ?? null}) returning *`;
      return row;
    },
    async insertLedger(e) {
      const [row] = await sql`insert into bank_ledger (occurred_at, delta_cents, kind, ref_id)
        values (${e.occurred_at}, ${e.delta_cents}, ${e.kind}, ${e.ref_id ?? null}) returning *`;
      return row;
    },
    async listLedger() {
      return sql`select * from bank_ledger order by occurred_at`;
    },
    async insertTrade(t) {
      const [row] = await sql.unsafe(
        `insert into trade_requests (created_at, symbol, side, notional_cents, qty, execute_after)
         values ($1, $2, $3, $4, $5, $6) returning ${TRADE_COLS}`,
        [t.created_at, t.symbol, t.side, t.notional_cents ?? null, t.qty ?? null, t.execute_after],
      );
      return row;
    },
    async getTrade(id) {
      const [row] = await sql.unsafe(`select ${TRADE_COLS} from trade_requests where id = $1`, [id]);
      return row || null;
    },
    async updateTrade(id, patch) {
      const allowed = ['status', 'qty', 'notional_cents', 'alpaca_order_id', 'submitted_at', 'filled_at', 'fill_price', 'fill_qty', 'reason'];
      const keys = Object.keys(patch).filter((k) => allowed.includes(k));
      if (!keys.length) return this.getTrade(id);
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const [row] = await sql.unsafe(
        `update trade_requests set ${sets} where id = $1 returning ${TRADE_COLS}`,
        [id, ...keys.map((k) => patch[k])],
      );
      return row;
    },
    async claimDue(now) {
      return sql.unsafe(
        `update trade_requests set status = 'submitted', submitted_at = $1
         where status = 'queued' and execute_after <= $1 returning ${TRADE_COLS}`,
        [now],
      );
    },
    async listTrades({ statuses, limit = 100 } = {}) {
      if (statuses) {
        return sql.unsafe(
          `select ${TRADE_COLS} from trade_requests where status::text = any($1) order by created_at desc limit $2`,
          [statuses, limit],
        );
      }
      return sql.unsafe(`select ${TRADE_COLS} from trade_requests order by created_at desc limit $1`, [limit]);
    },
    async getPosition(symbol) {
      const [row] = await sql`select symbol, qty::text as qty, avg_cost::text as avg_cost, first_fill_at
        from positions where symbol = ${symbol}`;
      return row || null;
    },
    async listPositions() {
      return sql`select symbol, qty::text as qty, avg_cost::text as avg_cost, first_fill_at
        from positions order by symbol`;
    },
    async putPosition(p) {
      await sql`insert into positions (symbol, qty, avg_cost, first_fill_at, updated_at)
        values (${p.symbol}, ${p.qty}, ${p.avg_cost}, ${p.first_fill_at}, now())
        on conflict (symbol) do update set qty = excluded.qty, avg_cost = excluded.avg_cost,
          first_fill_at = excluded.first_fill_at, updated_at = now()`;
    },
    async deletePosition(symbol) {
      await sql`delete from positions where symbol = ${symbol}`;
    },
    async upsertSnapshot(s) {
      await sql`insert into snapshots (day, bank_cents, portfolio_cents, burned_cents)
        values (${s.day}, ${s.bank_cents}, ${s.portfolio_cents}, ${s.burned_cents})
        on conflict (day) do update set bank_cents = excluded.bank_cents,
          portfolio_cents = excluded.portfolio_cents, burned_cents = excluded.burned_cents`;
    },
    async listSnapshots(fromDay) {
      return sql`select day::text as day, bank_cents, portfolio_cents, burned_cents
        from snapshots where day >= ${fromDay} order by day`;
    },
  };
}

export function makePgStore(url) {
  if (!url) throw new Error('DATABASE_URL is not set');
  // prepare: false is required by Supabase's transaction pooler.
  const sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });
  return {
    kind: 'pg',
    tx(fn) {
      return sql.begin(async (t) => {
        await t`select pg_advisory_xact_lock(${WRITE_LOCK})`;
        return fn(makeRepo(t));
      });
    },
    run(fn) {
      return fn(makeRepo(sql));
    },
    end() {
      return sql.end({ timeout: 5 });
    },
  };
}
