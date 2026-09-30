import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAuth } from '../lib/auth.js';

const env = {
  ALLOWED_EMAIL: 'Owner@Example.com',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  CRON_SECRET: 's3cret',
};
const fakeFetch = (email, status = 200) => async () => ({
  status,
  ok: status < 300,
  json: async () => ({ id: 'u1', email }),
});
const req = (auth) => ({ headers: auth ? { authorization: auth } : {} });

test('owner: accepts the allowed email case-insensitively', async () => {
  const a = makeAuth({ env, fetchImpl: fakeFetch('owner@example.com') });
  assert.equal((await a.owner(req('Bearer t'))).email, 'owner@example.com');
});

test('owner: rejects missing token, bad token, and other users', async () => {
  const a = makeAuth({ env, fetchImpl: fakeFetch('owner@example.com') });
  await assert.rejects(a.owner(req()), { status: 401 });
  await assert.rejects(makeAuth({ env, fetchImpl: fakeFetch('x', 401) }).owner(req('Bearer t')), { status: 401 });
  await assert.rejects(makeAuth({ env, fetchImpl: fakeFetch('someone@else.com') }).owner(req('Bearer t')), { status: 403 });
});

test('owner: refuses to run without ALLOWED_EMAIL', async () => {
  const a = makeAuth({ env: { ...env, ALLOWED_EMAIL: '' }, fetchImpl: fakeFetch('owner@example.com') });
  await assert.rejects(a.owner(req('Bearer t')), { status: 500 });
});

test('cron: requires the exact secret', () => {
  const a = makeAuth({ env });
  assert.equal(a.cron(req('Bearer s3cret')), true);
  assert.throws(() => a.cron(req('Bearer nope')), { status: 401 });
  assert.throws(() => a.cron(req()), { status: 401 });
});
