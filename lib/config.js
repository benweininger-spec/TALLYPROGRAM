import { RuleError } from './errors.js';
import { isDay, isTimeZone } from './time.js';

// Limits nobody can change from the UI. The database repeats the trade bounds.
export const HARD = Object.freeze({
  MIN_TRADE_CENTS: 2000,
  MAX_TRADE_CENTS: 20000,
  MIN_COOLDOWN_HOURS: 24,
  MIN_HOLD_DAYS: 7,
});

export const DEFAULTS = Object.freeze({
  quit_date: null,
  timezone: 'America/Los_Angeles',
  pack_price_cents: 1200,
  packs_per_day: 1,
  credit_per_craving_cents: 300,
  tiers_cents: [2000, 5000, 10000, 20000],
  cooldown_hours: 24,
  hold_days: 7,
  min_trade_cents: 2000,
});

export function resolveSettings(raw = {}) {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined && raw[k] !== null) s[k] = raw[k];
  s.tiers_cents = [...s.tiers_cents];
  // Derived, not editable: you can bank at most what you used to burn.
  s.daily_credit_cap_cents = Math.round(s.pack_price_cents * s.packs_per_day);
  return s;
}

const int = (v) => Number.isInteger(v);
const bad = (key, why) => new RuleError('bad_setting', `${key}: ${why}`);

const VALIDATORS = {
  quit_date: (v) => {
    if (!isDay(v)) throw bad('quit_date', 'use YYYY-MM-DD');
    return v;
  },
  timezone: (v) => {
    if (!isTimeZone(v)) throw bad('timezone', 'not a known timezone');
    return v;
  },
  pack_price_cents: (v) => {
    if (!int(v) || v < 100 || v > 10000) throw bad('pack_price_cents', 'between $1 and $100');
    return v;
  },
  packs_per_day: (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.1 || v > 10) throw bad('packs_per_day', 'between 0.1 and 10');
    return Math.round(v * 100) / 100;
  },
  credit_per_craving_cents: (v) => {
    if (!int(v) || v < 25 || v > 5000) throw bad('credit_per_craving_cents', 'between $0.25 and $50');
    return v;
  },
  tiers_cents: (v) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 6) throw bad('tiers_cents', 'one to six tiers');
    for (const t of v) {
      if (!int(t) || t < HARD.MIN_TRADE_CENTS || t > HARD.MAX_TRADE_CENTS) throw bad('tiers_cents', 'each between $20 and $200');
    }
    return [...new Set(v)].sort((a, b) => a - b);
  },
  // Guardrails can be tightened from the UI, never loosened below the defaults.
  cooldown_hours: (v) => {
    if (!int(v) || v < HARD.MIN_COOLDOWN_HOURS || v > 720) throw bad('cooldown_hours', 'between 24 and 720');
    return v;
  },
  hold_days: (v) => {
    if (!int(v) || v < HARD.MIN_HOLD_DAYS || v > 365) throw bad('hold_days', 'between 7 and 365');
    return v;
  },
  min_trade_cents: (v) => {
    if (!int(v) || v < HARD.MIN_TRADE_CENTS || v > HARD.MAX_TRADE_CENTS) throw bad('min_trade_cents', 'between $20 and $200');
    return v;
  },
};

export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new RuleError('bad_setting', 'Send an object of settings');
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!VALIDATORS[k]) throw bad(k, 'unknown or read-only setting');
    out[k] = VALIDATORS[k](v);
  }
  return out;
}

// Checks that only make sense on the merged result.
export function checkSettingsCoherent(s) {
  if (s.tiers_cents.some((t) => t < s.min_trade_cents)) {
    throw new RuleError('bad_setting', 'Every tier must be at least the minimum trade');
  }
}
