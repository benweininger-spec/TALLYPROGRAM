// Applies supabase/migrations/*.sql in order, once each.
// Usage: DATABASE_URL=postgres://... npm run migrate
import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

export async function migrate(url, { dir = DEFAULT_DIR, log = console.log } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql`create schema if not exists private`;
    await sql`create table if not exists private.schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await sql`select name from private.schema_migrations`).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const text = await readFile(join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into private.schema_migrations (name) values (${file})`;
      });
      log(`applied ${file}`);
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate(process.env.DATABASE_URL).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
