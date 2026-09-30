// Runs a suite against both the in-memory store and a real Postgres store.
import { describe, before, after, beforeEach } from 'node:test';
import postgres from 'postgres';
import { makeMemoryStore } from '../../lib/store/memory.js';
import { makePgStore } from '../../lib/store/pg.js';
import { pgAvailable, freshDatabase } from './pg.js';

const hasPg = await pgAvailable();

export function forEachStore(title, body) {
  describe(`${title} [memory]`, () => {
    const ctx = {};
    beforeEach(() => {
      ctx.store = makeMemoryStore();
    });
    body(ctx);
  });

  describe(`${title} [postgres]`, { skip: !hasPg && 'no local Postgres' }, () => {
    const ctx = {};
    let db, raw, store;
    before(async () => {
      db = await freshDatabase();
      raw = postgres(db.url, { max: 1, onnotice: () => {} });
      store = makePgStore(db.url);
    });
    beforeEach(async () => {
      await raw`truncate settings, cravings, bank_ledger, trade_requests, positions, snapshots`;
      ctx.store = store;
    });
    after(async () => {
      await store?.end();
      await raw?.end();
      await db?.drop();
    });
    body(ctx);
  });
}
