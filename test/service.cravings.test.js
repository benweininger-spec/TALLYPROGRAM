import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachStore } from './helpers/stores.js';
import { makeService } from '../lib/service.js';

forEachStore('cravings and bank', (ctx) => {
  let now;
  const svc = () => makeService({ store: ctx.store, clock: () => now });

  test('first run sets quit date and timezone', async () => {
    now = new Date('2026-10-02T05:00:00Z'); // Oct 1, 10pm in LA
    const st = await svc().getState({ tz: 'America/Los_Angeles' });
    assert.equal(st.settings.quit_date, '2026-10-01');
    assert.equal(st.day_count, 1);
    assert.equal(st.bank_cents, 0);
  });

  test('daily credit cap holds across many taps, resets the next local day', async () => {
    now = new Date('2026-10-01T17:00:00Z');
    const s = svc();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await s.logCraving({ beaten: true }));
    assert.deepEqual(results.map((r) => r.credited_cents), [300, 300, 300, 300, 0, 0]);
    assert.equal(results.at(-1).bank_cents, 1200);
    assert.equal(results.at(-1).capped, true);
    now = new Date('2026-10-02T17:00:00Z');
    assert.equal((await s.logCraving({ beaten: true })).credited_cents, 300);
    assert.equal((await s.getState()).bank_cents, 1500);
  });

  test('concurrent taps cannot exceed the cap', async () => {
    now = new Date('2026-10-01T17:00:00Z');
    const s = svc();
    await s.ensureInitialized('America/Los_Angeles');
    const all = await Promise.all(Array.from({ length: 10 }, () => s.logCraving({ beaten: true })));
    assert.equal(all.reduce((a, r) => a + r.credited_cents, 0), 1200);
    assert.equal((await s.getState()).bank_cents, 1200);
  });

  test('a slip credits nothing, is counted, and resets the streak', async () => {
    now = new Date('2026-10-01T17:00:00Z');
    const s = svc();
    await s.getState({ tz: 'America/Los_Angeles' });
    now = new Date('2026-10-05T17:00:00Z');
    assert.equal((await s.getState()).streak_days, 5);
    const r = await s.logCraving({ beaten: false, note: 'bar' });
    assert.equal(r.credited_cents, 0);
    const st = await s.getState();
    assert.equal(st.streak_days, 0);
    assert.equal(st.today_counts.slipped, 1);
    assert.equal(st.bank_cents, 0);
    now = new Date('2026-10-07T17:00:00Z');
    assert.equal((await s.getState()).streak_days, 2);
  });

  test('burned tracks days since quitting', async () => {
    now = new Date('2026-10-01T17:00:00Z');
    const s = svc();
    await s.getState({ tz: 'America/Los_Angeles' });
    now = new Date('2026-10-10T17:00:00Z');
    assert.equal((await s.getState()).burned_cents, 12000);
  });

  test('bad input is rejected', async () => {
    now = new Date('2026-10-01T17:00:00Z');
    await assert.rejects(svc().logCraving({ beaten: 'yes' }), { code: 'bad_craving' });
    await assert.rejects(svc().logCraving({ beaten: true, note: 'x'.repeat(501) }), { code: 'bad_note' });
  });

  test('settings: cannot set quit date in the future or loosen guardrails', async () => {
    now = new Date('2026-10-01T17:00:00Z');
    const s = svc();
    await assert.rejects(s.updateSettings({ quit_date: '2026-10-05' }), { code: 'bad_setting' });
    await assert.rejects(s.updateSettings({ cooldown_hours: 2 }), { code: 'bad_setting' });
    await assert.rejects(s.updateSettings({ min_trade_cents: 5000 }), /at least the minimum/);
    const out = await s.updateSettings({ pack_price_cents: 1500, packs_per_day: 1.5 });
    assert.equal(out.daily_credit_cap_cents, 2250);
  });
});
