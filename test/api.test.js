// Exercises the real handlers with fake dependencies, the way Vercel calls them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setDeps } from '../lib/deps.js';
import { makeAuth } from '../lib/auth.js';
import { makeMemoryStore } from '../lib/store/memory.js';
import { makeFakeBroker } from '../lib/broker-fake.js';
import { makeService } from '../lib/service.js';
import state from '../api/state.js';
import craving from '../api/craving.js';
import trade from '../api/trade/index.js';
import cancel from '../api/trade/cancel.js';
import cron from '../api/cron/execute-queue.js';

const env = { ALLOWED_EMAIL: 'owner@example.com', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'a', CRON_SECRET: 'cs' };
const fetchImpl = async (_url, init) => {
  const token = init.headers.authorization.slice(7);
  const email = { good: 'owner@example.com', other: 'x@example.com' }[token];
  return email ? { status: 200, ok: true, json: async () => ({ id: 'u', email }) } : { status: 401, ok: false };
};
const store = makeMemoryStore();
setDeps({
  auth: makeAuth({ env, fetchImpl }),
  service: makeService({ store, broker: makeFakeBroker() }),
  publicConfig: () => ({}),
});
after(() => setDeps(null));

async function call(handler, { method = 'GET', token = 'good', body, url = '/' } = {}) {
  const res = {
    statusCode: 200, headers: {}, writableEnded: false, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = JSON.parse(b); this.writableEnded = true; },
  };
  await handler({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return res;
}

test('every user endpoint requires the owner', async () => {
  for (const h of [state, craving, trade, cancel]) {
    const method = h === state ? 'GET' : 'POST';
    assert.equal((await call(h, { method, token: null })).statusCode, 401);
    assert.equal((await call(h, { method, token: 'bad' })).statusCode, 401);
    assert.equal((await call(h, { method, token: 'other' })).statusCode, 403);
  }
});

test('cron requires the cron secret, not a user token', async () => {
  assert.equal((await call(cron, { token: 'good' })).statusCode, 401);
  assert.equal((await call(cron, { token: 'cs' })).statusCode, 200);
});

test('rule violations come back as 400 with a code', async () => {
  const r = await call(trade, { method: 'POST', body: { symbol: 'VTI', side: 'buy', notional_cents: 50000 } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'out_of_bounds');
  const bad = await call(trade, { method: 'POST', body: '{nope' });
  assert.equal(bad.body.error, 'bad_json');
});

test('wrong method is 405, and a craving round-trips', async () => {
  assert.equal((await call(craving, { method: 'GET' })).statusCode, 405);
  const r = await call(craving, { method: 'POST', body: { beaten: true } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.credited_cents, 300);
  assert.equal(r.headers['cache-control'], 'no-store');
});

import { isSecretKey } from '../lib/deps.js';
test('secret Supabase keys are never treated as browser-safe', () => {
  const jwt = (role) => `x.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.y`;
  assert.equal(isSecretKey('sb_secret_abc'), true);
  assert.equal(isSecretKey(jwt('service_role')), true);
  assert.equal(isSecretKey(jwt('anon')), false);
  assert.equal(isSecretKey('sb_publishable_abc'), false);
});
