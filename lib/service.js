// Orchestrates rules, storage, and the broker. Every public method here is
// one API call's worth of work.
import { RuleError } from './errors.js';
import { resolveSettings, validateSettingsPatch, checkSettingsCoherent } from './config.js';
import { localDay, dayStart, addDays, isTimeZone } from './time.js';
import * as rules from './rules.js';

export function makeService({ store, broker = null, clock = () => new Date() }) {
  const settingsOf = async (repo) => resolveSettings(await repo.getSettingsRaw());

  function dayWindow(now, tz) {
    const today = localDay(now, tz);
    return { today, start: dayStart(today, tz), end: dayStart(addDays(today, 1), tz) };
  }

  // Sets quit_date to today on first run. The browser's timezone is only a
  // hint used that one time.
  async function ensureInitialized(tzHint) {
    const raw = await store.run((r) => r.getSettingsRaw());
    if (raw.quit_date) return;
    await store.tx(async (repo) => {
      const again = await repo.getSettingsRaw();
      if (again.quit_date) return;
      const tz = again.timezone || (isTimeZone(tzHint) ? tzHint : resolveSettings().timezone);
      await repo.putSettings({ timezone: tz, quit_date: localDay(clock(), tz) });
    });
  }

  async function logCraving({ beaten, note } = {}) {
    if (typeof beaten !== 'boolean') throw new RuleError('bad_craving', 'Say whether you smoked');
    if (note != null && (typeof note !== 'string' || note.length > 500)) {
      throw new RuleError('bad_note', 'Notes are text, 500 characters at most');
    }
    await ensureInitialized();
    return store.tx(async (repo) => {
      const now = clock();
      const s = await settingsOf(repo);
      const { start, end } = dayWindow(now, s.timezone);
      const before = await repo.creditedBetween(start, end);
      const credit = rules.creditForCraving({ beaten, todayCreditedCents: before, settings: s });
      const row = await repo.insertCraving({ occurred_at: now, beaten, credited_cents: credit, note: note?.trim() || null });
      if (credit > 0) await repo.insertLedger({ occurred_at: now, delta_cents: credit, kind: 'craving', ref_id: row.id });
      return {
        beaten,
        credited_cents: credit,
        capped: beaten && credit < s.credit_per_craving_cents,
        bank_cents: await repo.bankBalance(),
        today_credited_cents: before + credit,
        daily_cap_cents: s.daily_credit_cap_cents,
      };
    });
  }

  async function getState({ tz } = {}) {
    await ensureInitialized(tz);
    return store.run(async (repo) => {
      const now = clock();
      const s = await settingsOf(repo);
      const { today, start, end } = dayWindow(now, s.timezone);
      const bank = await repo.bankBalance();
      const counts = await repo.cravingCountsBetween(start, end);
      const lastSlip = await repo.lastSlipAt();
      const days = rules.dayCount(s.quit_date, today);
      return {
        mode: broker?.mode ?? 'offline',
        now: now.toISOString(),
        today,
        bank_cents: bank,
        unlocked_tiers: rules.unlockedTiers(bank, s),
        day_count: days,
        streak_days: rules.streakDays({
          quitDay: s.quit_date,
          today,
          lastSlipDay: lastSlip ? localDay(new Date(lastSlip), s.timezone) : null,
        }),
        burned_cents: rules.burnedCents(s, days),
        today_counts: {
          beaten: counts.beaten,
          slipped: counts.slipped,
          credited_cents: await repo.creditedBetween(start, end),
          cap_cents: s.daily_credit_cap_cents,
        },
        settings: s,
      };
    });
  }

  async function getSettings() {
    await ensureInitialized();
    return store.run(settingsOf);
  }

  async function updateSettings(patch) {
    const clean = validateSettingsPatch(patch);
    return store.tx(async (repo) => {
      const merged = resolveSettings({ ...(await repo.getSettingsRaw()), ...clean });
      checkSettingsCoherent(merged);
      if (clean.quit_date && clean.quit_date > localDay(clock(), merged.timezone)) {
        throw new RuleError('bad_setting', 'quit_date cannot be in the future');
      }
      await repo.putSettings(clean);
      return resolveSettings(await repo.getSettingsRaw());
    });
  }

  return { logCraving, getState, getSettings, updateSettings, ensureInitialized };
}
