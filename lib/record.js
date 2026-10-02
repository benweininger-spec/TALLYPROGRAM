// The Market Page's own record. Every edition prints three rungs; this is
// what $20 into each, at the close of the day it was printed, would be worth
// now. Three paper portfolios (the index, the sector, the name) and the
// mattress: the same $20 kept in the bank, which earns nothing.
//
// These are the paper's picks, not the reader's trades. Nothing here reads
// positions or the ledger. Pure functions: the service supplies editions and
// cached closes.
import { addDays } from './time.js';
import { RUNGS } from './edition.js';

export const RECORD_LOT_CENTS = 2000;

const round6 = (x) => Math.round(x * 1e6) / 1e6;

// The price cache holds a close for every calendar day: the close on or
// before it. Weekends and holidays repeat the last session's close, so a day
// is a session when its close differs from the day before. (Two sessions in
// a row closing at the same price read as one; the lot then prices a session
// later, never earlier.) Returns sessions in order.
export function sessionsOf(closes) {
  const out = [];
  for (const day of [...closes.keys()].sort()) {
    const close = closes.get(day);
    const prev = closes.get(addDays(day, -1));
    if (prev === undefined || prev !== close) out.push({ day, close });
  }
  return out;
}

// A lot printed on `day` buys at the close of the first session on or after
// it. An edition goes out before the open, so this is a price the paper had
// not seen; a weekend or holiday edition waits for the next session.
export function entrySession(sessions, day) {
  return sessions.find((x) => x.day >= day) ?? null;
}

const lotValue = (lot, close, cents) => Math.round((cents * close) / lot.entry_close);

// editions: [{ day, content: { rungs: { index: { symbol }, ... } } }]
// closes:   { SYMBOL: Map(day -> close) }, through the last final close
// today:    the reader's today
export function paperRecord({ editions, closes, today, lotCents = RECORD_LOT_CENTS }) {
  const eds = editions.filter((e) => e?.content?.rungs && e.day <= today).sort((a, b) => (a.day < b.day ? -1 : 1));
  const empty = { picks: 0, in_cents: 0, now_cents: 0, pct: null };
  if (!eds.length) {
    return {
      lot_cents: lotCents, since: null, as_of: null, editions: 0, pending: 0,
      rungs: Object.fromEntries(RUNGS.map((r) => [r, { ...empty }])), mattress: { ...empty },
      best: null, worst: null, days: [],
    };
  }

  const sessions = {};
  const sessionsFor = (sym) => (sessions[sym] ??= sessionsOf(closes[sym] ?? new Map()));
  const lots = [];
  for (const e of eds) {
    for (const rung of RUNGS) {
      const symbol = e.content.rungs[rung]?.symbol;
      if (!symbol) continue;
      const s = entrySession(sessionsFor(symbol), e.day);
      lots.push({ rung, symbol, day: e.day, entry_day: s?.day ?? null, entry_close: s?.close ?? null });
    }
  }
  const priced = lots.filter((l) => l.entry_close);
  const lastClose = {};
  let asOf = null;
  for (const sym of new Set(lots.map((l) => l.symbol))) {
    const last = sessionsFor(sym).at(-1);
    if (!last) continue;
    lastClose[sym] = last.close;
    if (!asOf || last.day > asOf) asOf = last.day;
  }

  const score = (list) => {
    const inCents = list.length * lotCents;
    const nowCents = list.reduce((a, l) => a + lotValue(l, lastClose[l.symbol], lotCents), 0);
    return { picks: list.length, in_cents: inCents, now_cents: nowCents, pct: inCents ? round6(nowCents / inCents - 1) : null };
  };
  const rungs = Object.fromEntries(RUNGS.map((r) => [r, score(priced.filter((l) => l.rung === r))]));
  // The mattress takes $20 for every edition whose picks have a price in.
  const settled = new Set(priced.map((l) => l.day)).size;
  const mattress = { picks: settled, in_cents: settled * lotCents, now_cents: settled * lotCents, pct: settled ? 0 : null };

  const graded = priced
    .map((l) => ({ rung: l.rung, symbol: l.symbol, day: l.day, pct: round6(lastClose[l.symbol] / l.entry_close - 1) }))
    .sort((a, b) => b.pct - a.pct || (a.day < b.day ? -1 : 1));
  const best = graded[0] ?? null;
  const worst = graded.length > 1 ? graded.at(-1) : null;

  // Daily return of each paper portfolio on what it had put in by then.
  // A lot joins on its entry session; until then its result is not in.
  const days = [];
  const cur = {};
  for (let d = eds[0].day; d <= today; d = addDays(d, 1)) {
    for (const sym of Object.keys(lastClose)) {
      const c = closes[sym]?.get(d);
      if (c !== undefined) cur[sym] = c;
    }
    const row = { day: d };
    for (const r of RUNGS) {
      let n = 0;
      let value = 0;
      for (const l of priced) {
        if (l.rung !== r || l.entry_day > d || cur[l.symbol] === undefined) continue;
        n++;
        value += lotValue(l, cur[l.symbol], lotCents);
      }
      row[r] = n ? round6(value / (n * lotCents) - 1) : null;
    }
    days.push(row);
  }

  return {
    lot_cents: lotCents,
    since: eds[0].day,
    as_of: asOf,
    editions: eds.length,
    pending: new Set(lots.filter((l) => !l.entry_close).map((l) => l.day)).size,
    rungs,
    mattress,
    best,
    worst,
    days,
  };
}
