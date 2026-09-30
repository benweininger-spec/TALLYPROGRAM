// Spins up a throwaway database per test file on a local Postgres, with the
// bits of Supabase that the migrations touch (auth schema, roles) stubbed.
// If no Postgres is reachable, pg tests are skipped rather than failed.
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { migrate } from '../../scripts/migrate.js';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

export async function pgAvailable() {
  const sql = postgres(ADMIN_URL, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const SUPABASE_STUB = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.jwt() returns jsonb language sql stable as
    $f$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.jwt() to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
`;

export async function freshDatabase({ migrationsDir } = {}) {
  const name = `ciggy_t_${randomBytes(4).toString('hex')}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const setup = postgres(url, { max: 1, onnotice: () => {} });
  await setup.unsafe(SUPABASE_STUB);
  await setup.end();
  await migrate(url, { log: () => {}, ...(migrationsDir ? { dir: migrationsDir } : {}) });
  return {
    url,
    async drop() {
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
