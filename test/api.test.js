// Exercises the real handlers with fake dependencies, the way Vercel calls them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setDeps } from '../lib/deps.js';
import { makeAuth } from '../lib/auth.js';
import { makeMemoryStore } from '../lib/store/memory.js';
import { makeFakeBroker } from '../lib/broker-fake.js';
import { makeService } from '../lib/service.js';
import state from '../api/state.js';
import day from '../api/day.js';
import mode from '../api/mode.js';
import trade from '../api/trade/index.js';
import cancel from '../api/trade/cancel.js';
import cron from '../api/cron/[job].js';

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
  for (const h of [state, day, mode, trade, cancel]) {
    const method = h === state ? 'GET' : h === day || h === mode ? 'PUT' : 'POST';
    assert.equal((await call(h, { method, token: null })).statusCode, 401);
    assert.equal((await call(h, { method, token: 'bad' })).statusCode, 401);
    assert.equal((await call(h, { method, token: 'other' })).statusCode, 403);
  }
});

test('cron requires the cron secret, not a user token', async () => {
  assert.equal((await call(cron, { token: 'good', url: '/api/cron/execute-queue' })).statusCode, 401);
  assert.equal((await call(cron, { token: 'cs', url: '/api/cron/execute-queue' })).statusCode, 200);
  assert.equal((await call(cron, { token: 'cs', url: '/api/cron/snapshot' })).statusCode, 200);
  assert.equal((await call(cron, { token: 'good', url: '/api/cron/market-page' })).statusCode, 401);
  // No writer configured here: the job answers, and the page runs the fallback.
  const mp = await call(cron, { token: 'cs', url: '/api/cron/market-page' });
  assert.equal(mp.statusCode, 200);
  assert.equal(mp.body.status, 'spiked');
  assert.equal((await call(cron, { token: 'cs', url: '/api/cron/nope' })).statusCode, 404);
});

test('rule violations come back as 400 with a code', async () => {
  const r = await call(trade, { method: 'POST', body: { symbol: 'VTI', side: 'buy', notional_cents: 50000 } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'out_of_bounds');
  const bad = await call(trade, { method: 'POST', body: '{nope' });
  assert.equal(bad.body.error, 'bad_json');
});

test('wrong method is 405; a late report and a mode change round-trip', async () => {
  assert.equal((await call(day, { method: 'POST' })).statusCode, 405);
  const st = await call(state);
  const today = st.body.today;
  const r = await call(day, { method: 'PUT', body: { day: today, state: 'smoked' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.today_state, 'smoked');
  assert.equal(r.headers['cache-control'], 'no-store');
  const m = await call(mode, { method: 'PUT', body: { mode: 'smoking' } });
  assert.equal(m.body.mode, 'smoking');
  const bad = await call(mode, { method: 'PUT', body: { mode: 'sometimes' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, 'bad_mode');
});

import { isSecretKey } from '../lib/deps.js';
test('secret Supabase keys are never treated as browser-safe', () => {
  const jwt = (role) => `x.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.y`;
  assert.equal(isSecretKey('sb_secret_abc'), true);
  assert.equal(isSecretKey(jwt('service_role')), true);
  assert.equal(isSecretKey(jwt('anon')), false);
  assert.equal(isSecretKey('sb_publishable_abc'), false);
});

import demo from '../api/demo.js';
test('demo: public, 22 days in, read-only by construction', async () => {
  const st = await call(demo, { token: null, url: '/api/demo?view=state' });
  assert.equal(st.statusCode, 200);
  assert.equal(st.body.day_count, 22);
  assert.equal(st.body.days.filter((d) => d.state === 'smoked').length, 3);
  assert.equal(st.body.positions.length, 2);
  // One sell booked a small gain; the two held positions are one up, one down.
  assert.equal(st.body.trading.sells, 1);
  assert.ok(st.body.trading.realized_cents > 0);
  assert.ok(st.body.positions.some((p) => p.gain_cents > 0) && st.body.positions.some((p) => p.gain_cents < 0));
  const h = await call(demo, { token: null, url: '/api/demo?view=history' });
  assert.equal(h.body.days.length, 22);
  // The paper's record: two weeks of weekday editions, today's not yet scored.
  assert.ok(h.body.record.editions >= 10);
  assert.ok(h.body.record.rungs.index.picks > 0);
  assert.equal(h.body.record.mattress.pct, 0);
  // The sample edition is on the demo's front page.
  assert.equal(st.body.editions.today.content.headline, 'STOCKS DRIFT HIGHER; NOBODY CLAIMS CREDIT');
  assert.equal((await call(demo, { token: null, method: 'PUT', url: '/api/demo' })).statusCode, 405);
  assert.equal((await call(demo, { token: null, url: '/api/demo?view=settings' })).statusCode, 400);
});
