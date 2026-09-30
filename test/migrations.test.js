import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { pgAvailable, freshDatabase } from './helpers/pg.js';
import { migrate } from '../scripts/migrate.js';

const available = await pgAvailable();
let db, sql;

before(async () => {
  if (!available) return;
  db = await freshDatabase();
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql`insert into private.app_config (allowed_email) values ('owner@example.com')`;
});
after(async () => {
  if (!available) return;
  await sql.end();
  await db.drop();
});

const opts = { skip: !available && 'no local Postgres' };

test('migrations are idempotent', opts, async () => {
  await migrate(db.url, { log: () => {} });
  const rows = await sql`select name from private.schema_migrations order by name`;
  assert.deepEqual(rows.map((r) => r.name), ['20260930022438_core.sql', '20260930022510_single_user_rls.sql', '20260930023454_revoke_anon_is_owner.sql', '20261001000000_calendar_and_ghost.sql']);
});

test('only the allowed email can sign up', opts, async () => {
  await assert.rejects(sql`insert into auth.users (email) values ('stranger@example.com')`, /Sign-ups are closed/);
  await sql`insert into auth.users (email) values ('Owner@Example.com')`;
  await assert.rejects(sql`update auth.users set email = 'stranger@example.com'`, /Sign-ups are closed/);
});

test('buy notional bounds are enforced by the database', opts, async () => {
  const ins = (cents) => sql`insert into trade_requests (symbol, side, notional_cents, execute_after)
    values ('VTI', 'buy', ${cents}, now())`;
  await assert.rejects(ins(1999), /buy_notional_bounds/);
  await assert.rejects(ins(20001), /buy_notional_bounds/);
  await ins(2000);
  await sql`delete from trade_requests`;
});

async function asUser(email, fn) {
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ email })}, true)`;
    await tx`set local role authenticated`;
    return fn(tx);
  });
}

test('RLS: owner reads, everyone else sees nothing, nobody writes', opts, async () => {
  await sql`insert into settings (key, value) values ('pack_price_cents', '1200')`;
  const mine = await asUser('owner@example.com', (tx) => tx`select * from settings`);
  assert.equal(mine.length, 1);
  const theirs = await asUser('stranger@example.com', (tx) => tx`select * from settings`);
  assert.equal(theirs.length, 0);
  await assert.rejects(
    asUser('owner@example.com', (tx) => tx`insert into bank_ledger (delta_cents, kind) values (100000, 'adjust')`),
    /permission denied/,
  );
});

test('v2 migration offsets legacy craving credits once and keeps the rows', opts, async () => {
  const { mkdtemp, readdir, copyFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const src = new URL('../supabase/migrations/', import.meta.url).pathname;
  const files = (await readdir(src)).filter((f) => f.endsWith('.sql')).sort();
  const early = await mkdtemp(join(tmpdir(), 'mig-'));
  for (const f of files.slice(0, 3)) await copyFile(join(src, f), join(early, f));
  const db2 = await freshDatabase({ migrationsDir: early });
  const sql2 = postgres(db2.url, { max: 1, onnotice: () => {} });
  try {
    await sql2`insert into bank_ledger (delta_cents, kind) values (300, 'craving'), (300, 'craving'), (-2000, 'trade_debit')`;
    await migrate(db2.url, { log: () => {} });
    const rows = await sql2`select kind::text, delta_cents from bank_ledger order by kind::text`;
    assert.equal(rows.filter((r) => r.kind === 'craving').length, 2);
    const [{ n }] = await sql2`select coalesce(sum(delta_cents), 0)::int as n from bank_ledger where kind in ('craving', 'adjust')`;
    assert.equal(n, 0);
    const [{ total }] = await sql2`select sum(delta_cents)::int as total from bank_ledger`;
    assert.equal(total, -2000);
  } finally {
    await sql2.end();
    await db2.drop();
  }
});

test('v2 tables: a settled day must carry its amount', opts, async () => {
  await assert.rejects(sql`insert into days (day, state, settled_at) values ('2026-10-01', 'clean', now())`, /days_settled_has_cents/);
  await sql`insert into days (day, state) values ('2026-10-01', 'clean')`;
  await sql`delete from days`;
});
