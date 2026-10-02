// Orchestrates rules, storage, and the broker. Every public method here is
// one API call's worth of work.
import { RuleError, HttpError } from './errors.js';
import { resolveSettings, validateSettingsPatch, checkSettingsCoherent, normalizeMode } from './config.js';
import { localDay, addDays, daysBetween, isTimeZone } from './time.js';
import * as rules from './rules.js';
import { paperRecord } from './record.js';

// Marks the ledger entries that cancel v1 craving credits.
export const LEGACY_OFFSET_REF = '00000000-0000-4000-8000-00000000c1a0';

export function makeService({ store, broker = null, clock = () => new Date() }) {
  const settingsOf = async (repo) => resolveSettings(await repo.getSettingsRaw());

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

  // ---------- calendar ----------

  // Every past day that has not settled goes to press: a clean day's amount
  // lands in the bank, a smoked day's becomes a ghost lot. A day keeps the
  // amount it settled with, even if pack price changes later.
  async function settleIn(repo, s, now) {
    // v2 pays each clean day in full, which covers what v1 craving taps
    // banked. Cancel those credits (the rows stay), including any tapped in
    // while v1 was still live.
    const legacy = await repo.legacyCravings(LEGACY_OFFSET_REF);
    if (legacy.net) {
      await repo.insertLedger({ occurred_at: legacy.lastAt ?? now, delta_cents: -legacy.net, kind: 'adjust', ref_id: LEGACY_OFFSET_REF });
    }
    if (!s.quit_date) return [];
    const today = localDay(now, s.timezone);
    const rows = await repo.listDays();
    const due = rules.daysToSettle({ quitDay: s.quit_date, today, rows });
    const byDay = new Map(rows.map((r) => [r.day, r]));
    for (const day of due) {
      const r = byDay.get(day);
      const state = r?.state ?? rules.defaultState(s.mode);
      const cents = s.daily_cents;
      await repo.putDay({ day, state, source: r?.source ?? 'auto', cents, settled_at: now });
      if (state === 'clean') await repo.insertLedger({ occurred_at: now, delta_cents: cents, kind: 'day', day });
      else await repo.putLot({ day, cents, benchmark: s.ghost_benchmark });
    }
    return due;
  }

  // A write transaction that settles any past days first, so every rule sees
  // an up-to-date bank.
  function inTx(fn) {
    return store.tx(async (repo) => {
      const now = clock();
      const s = await settingsOf(repo);
      await settleIn(repo, s, now);
      return fn(repo, s, now);
    });
  }

  async function settleIfDue() {
    const due = await store.run(async (repo) => {
      const s = await settingsOf(repo);
      const today = localDay(clock(), s.timezone);
      if ((await repo.legacyCravings(LEGACY_OFFSET_REF)).net) return true;
      return rules.daysToSettle({ quitDay: s.quit_date, today, rows: await repo.listDays() }).length;
    });
    if (due) await inTx(async () => {});
  }

  // Corrects a past day (moving its amount between bank and ghost) or files
  // a late report for today (pencilled until midnight).
  async function setDay({ day, state } = {}) {
    const next = rules.normalizeDayState(state);
    await ensureInitialized();
    await inTx(async (repo, s, now) => {
      const today = localDay(now, s.timezone);
      rules.validateDayEdit({ day, today, quitDay: s.quit_date });
      if (day === today) {
        await repo.putDay({ day, state: next, source: 'edit', cents: null, settled_at: null });
        return;
      }
      const row = await repo.getDay(day);
      if (row.state === next) return;
      if (next === 'smoked') {
        await repo.insertLedger({ occurred_at: now, delta_cents: -row.cents, kind: 'day', day });
        await repo.putLot({ day, cents: row.cents, benchmark: s.ghost_benchmark });
      } else {
        await repo.deleteLot(day);
        await repo.insertLedger({ occurred_at: now, delta_cents: row.cents, kind: 'day', day });
      }
      await repo.putDay({ ...row, state: next, source: 'edit' });
    });
    return getState();
  }

  // Changes how each day goes to press from today on. Today's own late
  // report, if any, is dropped so today follows the new position.
  async function setMode(mode) {
    const m = normalizeMode(mode);
    await ensureInitialized();
    await inTx(async (repo, s, now) => {
      await repo.putSettings({ mode: m });
      const today = localDay(now, s.timezone);
      const row = await repo.getDay(today);
      if (row && !row.settled_at) await repo.deleteDay(today);
    });
    return getState();
  }

  // ---------- ghost pricing ----------

  // Closing prices per calendar day, from the cache, topped up from Alpaca.
  // Only days whose close is final (before today in New York) are cached.
  async function getCloses(symbol, from, to) {
    const have = new Map();
    if (!from || from > to) return have;
    for (const c of await store.run((r) => r.listCloses(symbol, from, to))) have.set(c.day, Number(c.close));
    const final = localDay(clock(), 'America/New_York');
    let missing = [];
    for (let d = from; d <= to && d < final; d = addDays(d, 1)) if (!have.has(d)) missing.push(d);
    if (missing.length && broker?.getDailyBars) {
      try {
        let bars = await broker.getDailyBars(symbol, addDays(missing[0], -10), missing.at(-1));
        // Bars are split-adjusted as of when they are fetched. If the overlap
        // no longer matches what was cached, a split re-based the history:
        // fetch the whole range again so old and new closes agree.
        if (bars.some((b) => have.has(b.day) && Math.abs(b.close / have.get(b.day) - 1) > 0.02)) {
          missing = [];
          for (let d = from; d <= to && d < final; d = addDays(d, 1)) missing.push(d);
          bars = await broker.getDailyBars(symbol, addDays(from, -10), missing.at(-1));
        }
        const rows = [];
        for (const d of missing) {
          const close = rules.closeOnOrBefore(bars, d);
          if (close) {
            rows.push({ symbol, day: d, close });
            have.set(d, close);
          }
        }
        if (rows.length) await store.run((r) => r.putCloses(rows));
      } catch {
        // Market data unavailable: lots stay at cost until the next try.
      }
    }
    return have;
  }

  // Prices unpriced lots at their day's close and returns what the ghost
  // needs to be valued now. Never throws: without prices, lots count at cost.
  async function ghostMarket(s) {
    const symbol = s.ghost_benchmark;
    const today = localDay(clock(), s.timezone);
    const closes = await getCloses(symbol, s.quit_date, addDays(today, -1));
    const lots = await store.run((r) => r.listLots());
    const toPrice = lots.filter((l) => l.shares == null && l.benchmark === symbol && closes.has(l.day));
    if (toPrice.length) {
      await store.tx(async (repo) => {
        for (const l of toPrice) {
          const close = closes.get(l.day);
          await repo.setLotPrice(l.day, rules.lotShares(l.cents, close), String(close));
        }
      });
    }
    let price = null;
    if (broker?.getLatestPrice) {
      try {
        price = await broker.getLatestPrice(symbol);
      } catch {
        price = null;
      }
    }
    if (!price && closes.size) price = closes.get([...closes.keys()].sort().at(-1));
    return { symbol, price, closes };
  }

  // ---------- state ----------

  async function getState({ tz } = {}) {
    await ensureInitialized(tz);
    await settleIfDue();
    // No cron needed for correctness: opening the app moves due trades along.
    let queueError = null;
    try {
      await processQueueIfDue();
    } catch (err) {
      queueError = err.message;
    }
    const s0 = await store.run(settingsOf);
    const [market, ghostMkt] = await Promise.all([marketPrices(), ghostMarket(s0)]);
    const st = await store.run(async (repo) => {
      const now = clock();
      const s = await settingsOf(repo);
      const today = localDay(now, s.timezone);
      const bank = await repo.bankBalance();
      const dayCount = rules.dayCount(s.quit_date, today);
      const cal = rules.calendar({ quitDay: s.quit_date, today, rows: await repo.listDays(), mode: s.mode });
      const lots = new Map((await repo.listLots()).map((l) => [l.day, l]));
      const price = ghostMkt.symbol === s.ghost_benchmark ? ghostMkt.price : null;
      const lotValue = (l) => rules.lotValueCents(l.benchmark === s.ghost_benchmark ? l : { cents: l.cents }, price);
      // What a clean day's amount would be worth now, had it gone to the ghost.
      const wouldBe = (d) => {
        const close = ghostMkt.closes.get(d.day);
        return close && price ? Math.round((d.cents / 100 / close) * price * 100) : d.cents;
      };
      const days = cal.map((d) => ({
        ...d,
        ghost_value_cents: !d.settled ? null : d.state === 'smoked' && lots.has(d.day) ? lotValue(lots.get(d.day)) : wouldBe(d),
      }));
      const ghostValue = [...lots.values()].reduce((a, l) => a + lotValue(l), 0);
      const ghostCost = [...lots.values()].reduce((a, l) => a + l.cents, 0);
      const cash = new Map((await repo.tradeCash()).map((r) => [r.ref_id, r.cents]));
      const book = rules.tradeBook(await repo.listTrades({ statuses: ['filled'], limit: 10000 }), cash);
      const positions = (await repo.listPositions()).map((p) => valuePosition(p, market, s, now, book));
      const open = await repo.listTrades({ statuses: ['queued', 'submitted'], limit: 50 });
      return {
        broker_mode: broker?.mode ?? 'offline',
        now: now.toISOString(),
        today,
        mode: s.mode,
        daily_cents: s.daily_cents,
        bank_cents: bank,
        unlocked_tiers: rules.unlockedTiers(bank, s),
        day_count: dayCount,
        streak_days: rules.streak(cal),
        today_state: cal.at(-1)?.state ?? rules.defaultState(s.mode),
        burned_cents: rules.burnedCents(s, dayCount),
        days,
        ghost: {
          benchmark: s.ghost_benchmark,
          value_cents: ghostValue,
          cost_cents: ghostCost,
          lots: lots.size,
          priced: Boolean(price),
        },
        portfolio_cents: positions.reduce((a, p) => a + p.value_cents, 0),
        // Buys the bank has paid for that have not filled yet. Still yours.
        queued_cents: open.filter((t) => t.side === 'buy').reduce((a, t) => a + t.notional_cents, 0),
        prices_stale: market.stale,
        positions,
        trading: rules.tradingNet(book, positions),
        queue: open.map(publicTrade).reverse(),
        queue_error: queueError,
        settings: s,
      };
    });
    await store.tx((repo) =>
      repo.upsertSnapshot({
        day: st.today,
        bank_cents: st.bank_cents,
        portfolio_cents: st.portfolio_cents,
        burned_cents: st.burned_cents,
        ghost_cents: st.ghost.value_cents,
      }),
    );
    return st;
  }

  // ---------- ledgers ----------

  // Records today's totals. The daily cron calls this; opening the app does
  // too, so gaps only appear on days with neither.
  async function snapshot() {
    const st = await getState();
    return {
      day: st.today,
      bank_cents: st.bank_cents,
      portfolio_cents: st.portfolio_cents,
      burned_cents: st.burned_cents,
      ghost_cents: st.ghost.value_cents,
    };
  }

  // One row per day since the quit date (up to a year). Day money follows
  // the marks as they stand now, so corrections redraw history; trades and
  // stock values are as recorded.
  async function history() {
    const st = await getState();
    const s = st.settings;
    const from = s.quit_date > addDays(st.today, -364) ? s.quit_date : addDays(st.today, -364);
    const closes = await getCloses(s.ghost_benchmark, s.quit_date, addDays(st.today, -1));
    const record = await marketRecord(st.today);
    const out = await store.run(async (repo) => {
      const dayRows = new Map((await repo.listDays()).map((r) => [r.day, r]));
      const lots = (await repo.listLots()).filter((l) => l.benchmark === s.ghost_benchmark);
      const snaps = new Map((await repo.listSnapshots(s.quit_date)).map((x) => [x.day, x]));
      const ledger = await repo.listLedger();
      const trades = await repo.listTrades({ limit: 1000 });
      // A buy is paid for when requested and becomes stock when it fills.
      // In between (or until a refund) its money is in flight, still yours.
      const refundDay = new Map();
      for (const e of ledger) {
        if (e.kind === 'trade_credit' && e.ref_id && !refundDay.has(e.ref_id)) refundDay.set(e.ref_id, localDay(new Date(e.occurred_at), s.timezone));
      }
      const inFlight = trades
        .filter((t) => t.side === 'buy')
        .map((t) => ({
          from: localDay(new Date(t.created_at), s.timezone),
          to: t.status === 'filled' ? localDay(new Date(t.filled_at), s.timezone) : refundDay.get(t.id) ?? null,
          cents: t.notional_cents,
        }));
      // Stock value comes from daily snapshots. On days without one, carry
      // the last value forward and add that day's fills at their price.
      const fillsByDay = new Map();
      for (const t of trades) {
        if (t.status !== 'filled' || !t.fill_qty) continue;
        const d = localDay(new Date(t.filled_at), s.timezone);
        const v = Math.round(Number(t.fill_qty) * Number(t.fill_price) * 100);
        fillsByDay.set(d, (fillsByDay.get(d) || 0) + (t.side === 'buy' ? v : -v));
      }
      // Everything that is not day money, by the local day it happened.
      const otherByDay = new Map();
      for (const e of ledger) {
        if (e.kind === 'day') continue;
        const d = localDay(new Date(e.occurred_at), s.timezone);
        otherByDay.set(d, (otherByDay.get(d) || 0) + e.delta_cents);
      }
      const otherBefore = [...otherByDay].filter(([d]) => d < s.quit_date).reduce((a, [, v]) => a + v, 0);

      const days = [];
      let dayMoney = 0;
      let other = otherBefore;
      let stocks = 0;
      for (let d = s.quit_date; d <= st.today; d = addDays(d, 1)) {
        const row = dayRows.get(d);
        if (row?.settled_at && row.state === 'clean') dayMoney += row.cents;
        other += otherByDay.get(d) || 0;
        if (snaps.has(d)) stocks = snaps.get(d).portfolio_cents;
        else stocks = Math.max(0, stocks + (fillsByDay.get(d) || 0));
        if (d < from) continue;
        const isToday = d === st.today;
        let ghost = 0;
        if (!isToday) {
          for (const l of lots) {
            if (l.day > d) break;
            ghost += rules.lotValueCents(l, closes.get(d));
          }
        }
        days.push({
          day: d,
          state: isToday ? st.today_state : row?.state ?? 'clean',
          burned_cents: rules.burnedCents(s, rules.dayCount(s.quit_date, d)),
          yours_cents: isToday
            ? st.bank_cents + st.portfolio_cents + st.queued_cents
            : dayMoney + other + stocks + inFlight.filter((f) => f.from <= d && (f.to === null || d < f.to)).reduce((a, f) => a + f.cents, 0),
          ghost_cents: isToday ? st.ghost.value_cents : ghost,
        });
      }
      return {
        today: st.today,
        bank_cents: st.bank_cents,
        portfolio_cents: st.portfolio_cents,
        burned_cents: st.burned_cents,
        ghost_cents: st.ghost.value_cents,
        days,
        trades: trades.slice(0, 200).map(publicTrade),
      };
    });
    return { ...out, record };
  }

  // The Market Page's record over its last year of editions. Closes come
  // from the shared cache; only days that are final in New York are fetched.
  async function marketRecord(today) {
    const editions = (await store.run((r) => r.listEditionRungs({ limit: 366 }))).filter((e) => e.day <= today);
    const firstDay = {};
    for (const e of editions) {
      for (const pick of Object.values(e.content?.rungs ?? {})) {
        if (pick?.symbol && (!firstDay[pick.symbol] || e.day < firstDay[pick.symbol])) firstDay[pick.symbol] = e.day;
      }
    }
    const last = addDays(localDay(clock(), 'America/New_York'), -1);
    const closes = {};
    const symbols = Object.keys(firstDay);
    for (let i = 0; i < symbols.length; i += 4) {
      await Promise.all(
        symbols.slice(i, i + 4).map(async (sym) => {
          closes[sym] = await getCloses(sym, addDays(firstDay[sym], -1), last);
        }),
      );
    }
    return paperRecord({ editions, closes, today });
  }

  async function getSettings() {
    await ensureInitialized();
    return store.run(settingsOf);
  }

  async function updateSettings(patch) {
    const clean = validateSettingsPatch(patch);
    if (clean.ghost_benchmark && broker) {
      const asset = await broker.getAsset(clean.ghost_benchmark);
      if (!asset || asset.class !== 'us_equity' || asset.status !== 'active') {
        throw new RuleError('bad_setting', 'Ghost benchmark: Alpaca does not list that ticker');
      }
    }
    await ensureInitialized();
    return store.tx(async (repo) => {
      const now = clock();
      const before = await settingsOf(repo);
      const merged = resolveSettings({ ...(await repo.getSettingsRaw()), ...clean });
      checkSettingsCoherent(merged);
      if (clean.quit_date && clean.quit_date > localDay(now, merged.timezone)) {
        throw new RuleError('bad_setting', 'Quit date cannot be in the future');
      }
      // Past days settle on the terms they were printed under.
      await settleIn(repo, before, now);
      await repo.putSettings(clean);
      if (clean.quit_date && clean.quit_date > before.quit_date) {
        // Days before the new quit date were before our time: take their
        // money back out of the bank and the ghost.
        for (const r of await repo.listDays()) {
          if (r.day >= clean.quit_date) continue;
          if (r.settled_at && r.state === 'clean') {
            await repo.insertLedger({ occurred_at: now, delta_cents: -r.cents, kind: 'day', day: r.day });
          }
          await repo.deleteLot(r.day);
          await repo.deleteDay(r.day);
        }
      }
      if (clean.ghost_benchmark && clean.ghost_benchmark !== before.ghost_benchmark) {
        await repo.rebenchmarkLots(clean.ghost_benchmark);
      }
      const after = await settingsOf(repo);
      await settleIn(repo, after, now);
      return after;
    });
  }

  // ---------- trading ----------

  function needBroker() {
    if (!broker) throw new HttpError(503, 'broker_not_configured', 'Alpaca keys are not set on the server');
    return broker;
  }

  function publicTrade(t) {
    return {
      id: t.id,
      created_at: t.created_at,
      symbol: t.symbol,
      side: t.side,
      notional_cents: t.notional_cents,
      qty: t.qty,
      execute_after: t.execute_after,
      status: t.status,
      filled_at: t.filled_at,
      fill_price: t.fill_price,
      fill_qty: t.fill_qty,
      reason: t.reason,
    };
  }

  async function marketPrices() {
    if (!broker) return { prices: {}, stale: true };
    try {
      const list = await broker.getPositions();
      return { prices: Object.fromEntries(list.map((p) => [p.symbol, Number(p.current_price)])), stale: false };
    } catch {
      return { prices: {}, stale: true };
    }
  }

  // Cost is what the bank paid for the shares still held, so the gain is
  // the position's upside over having left that money in the bank.
  function valuePosition(p, market, s, now, book) {
    const qty = Number(p.qty);
    const priced = market.prices[p.symbol] != null;
    const price = priced ? market.prices[p.symbol] : Number(p.avg_cost);
    const cost = book?.open.get(p.symbol)?.cost_cents ?? Math.round(qty * Number(p.avg_cost) * 100);
    const value = priced ? Math.round(qty * price * 100) : cost;
    const unlocks = rules.holdUnlocksAt(p, s);
    return {
      symbol: p.symbol,
      qty: p.qty,
      avg_cost: p.avg_cost,
      price,
      priced,
      value_cents: value,
      cost_cents: cost,
      gain_cents: value - cost,
      days_held: Math.max(0, daysBetween(localDay(new Date(p.first_fill_at), s.timezone), localDay(now, s.timezone))),
      first_fill_at: p.first_fill_at,
      sell_unlocks_at: unlocks.toISOString(),
      sellable: unlocks < now,
    };
  }

  async function searchSymbols(q) {
    const b = needBroker();
    if (typeof q !== 'string' || !q.trim()) return { results: [] };
    if (q.length > 40) throw new RuleError('bad_query', 'Search is too long');
    const found = await b.searchAssets(q);
    return { results: found.map((a) => ({ symbol: a.symbol, name: a.name, exchange: a.exchange })) };
  }

  async function requestTrade({ symbol, side, notional_cents } = {}) {
    const b = needBroker();
    const sym = rules.normalizeSymbol(symbol);
    const sd = rules.normalizeSide(side);
    await ensureInitialized();

    if (sd === 'buy') {
      const cents = typeof notional_cents === 'string' ? Number(notional_cents) : notional_cents;
      const asset = await b.getAsset(sym);
      return inTx(async (repo, s, now) => {
        const bank = await repo.bankBalance();
        rules.validateBuy({ notionalCents: cents, bankCents: bank, asset, settings: s });
        const t = await repo.insertTrade({
          created_at: now, symbol: sym, side: 'buy', notional_cents: cents,
          execute_after: rules.executeAfter(now, s),
        });
        // The bank pays now. Cancel or rejection pays it back.
        await repo.insertLedger({ occurred_at: now, delta_cents: -cents, kind: 'trade_debit', ref_id: t.id });
        return { trade: publicTrade(t), bank_cents: bank - cents };
      });
    }

    const market = await marketPrices();
    return store.tx(async (repo) => {
      const now = clock();
      const s = await settingsOf(repo);
      const position = await repo.getPosition(sym);
      const open = await repo.listTrades({ statuses: ['queued', 'submitted'], limit: 200 });
      const pendingSell = open.find((t) => t.symbol === sym && t.side === 'sell') || null;
      rules.validateSell({ position, pendingSell, now, settings: s });
      const est = Math.round(Number(position.qty) * (market.prices[sym] ?? Number(position.avg_cost)) * 100);
      const t = await repo.insertTrade({
        created_at: now, symbol: sym, side: 'sell', notional_cents: est > 0 ? est : null,
        execute_after: rules.executeAfter(now, s),
      });
      return { trade: publicTrade(t), bank_cents: await repo.bankBalance() };
    });
  }

  async function cancelTrade(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new RuleError('bad_id', 'Unknown trade');
    return store.tx(async (repo) => {
      const t = await repo.getTrade(id);
      if (!t) throw new HttpError(404, 'not_found', 'Unknown trade');
      if (t.status !== 'queued') throw new RuleError('not_cancellable', 'Only queued trades can be cancelled');
      const now = clock();
      await repo.updateTrade(id, { status: 'cancelled', reason: 'Cancelled by you' });
      if (t.side === 'buy') {
        await repo.insertLedger({ occurred_at: now, delta_cents: t.notional_cents, kind: 'trade_credit', ref_id: id });
      }
      return { trade: publicTrade(await repo.getTrade(id)), bank_cents: await repo.bankBalance() };
    });
  }

  async function processQueueIfDue() {
    if (!broker) return null;
    const now = clock();
    const open = await store.run((r) => r.listTrades({ statuses: ['queued', 'submitted'], limit: 200 }));
    const due = open.some((t) => t.status === 'submitted' || new Date(t.execute_after) <= now);
    return due ? processQueue() : null;
  }

  // Idempotent and safe to run concurrently: claiming is atomic, orders are
  // keyed by client_order_id = trade id, and settling checks status first.
  async function processQueue() {
    const b = needBroker();
    const report = { claimed: 0, settled: 0, rejected: 0, working: 0, errors: [] };

    const claimed = await store.tx(async (repo) => {
      const rows = await repo.claimDue(clock());
      for (const t of rows) {
        if (t.side !== 'sell') continue;
        const pos = await repo.getPosition(t.symbol);
        if (pos) await repo.updateTrade(t.id, { qty: pos.qty });
        else await repo.updateTrade(t.id, { status: 'rejected', reason: 'Position no longer held' });
      }
      return rows;
    });
    report.claimed = claimed.length;

    const working = await store.run((r) => r.listTrades({ statuses: ['submitted'], limit: 50 }));
    for (const t of working) {
      try {
        const result = await advance(b, t);
        if (result === 'filled') report.settled++;
        else if (result === 'rejected') report.rejected++;
        else report.working++;
      } catch (err) {
        report.errors.push({ id: t.id, symbol: t.symbol, message: err.message });
      }
    }
    return report;
  }

  async function advance(b, t) {
    let order = t.alpaca_order_id ? await b.getOrder(t.alpaca_order_id) : await b.getOrderByClientId(t.id);
    if (!order) {
      if (t.alpaca_order_id) throw new Error(`Alpaca has no order ${t.alpaca_order_id}`);
      try {
        order = await b.submitOrder({
          client_order_id: t.id, symbol: t.symbol, side: t.side, notional_cents: t.notional_cents, qty: t.qty,
        });
      } catch (err) {
        if (err.duplicate) {
          order = await b.getOrderByClientId(t.id);
          if (!order) throw err;
        } else if (err.definitive) {
          await finalize(t.id, {
            status: 'rejected',
            reason: `Alpaca refused: ${err.message}`,
            refundCents: t.side === 'buy' ? t.notional_cents : 0,
            proceedsCents: 0,
            positionDelta: null,
          });
          return 'rejected';
        } else {
          throw err; // Network trouble or Alpaca down: try again next run.
        }
      }
    }
    if (!t.alpaca_order_id) {
      await store.tx(async (repo) => {
        const cur = await repo.getTrade(t.id);
        if (cur.status === 'submitted' && !cur.alpaca_order_id) await repo.updateTrade(t.id, { alpaca_order_id: order.id });
      });
    }
    const outcome = rules.settleOrder(t, order, clock());
    if (!outcome) return 'working';
    await finalize(t.id, outcome);
    return outcome.status;
  }

  async function finalize(id, o) {
    await store.tx(async (repo) => {
      const t = await repo.getTrade(id);
      if (t.status !== 'submitted') return; // Another run got here first.
      const at = clock();
      await repo.updateTrade(id, {
        status: o.status,
        reason: o.reason ?? null,
        fill_qty: o.fill_qty ?? null,
        fill_price: o.fill_price ?? null,
        filled_at: o.filled_at ?? null,
      });
      if (o.refundCents > 0) await repo.insertLedger({ occurred_at: at, delta_cents: o.refundCents, kind: 'trade_credit', ref_id: id });
      if (o.proceedsCents > 0) await repo.insertLedger({ occurred_at: at, delta_cents: o.proceedsCents, kind: 'trade_credit', ref_id: id });
      if (o.positionDelta) {
        const next = rules.applyFill(t.symbol, await repo.getPosition(t.symbol), o.positionDelta, o.filled_at || at);
        if (next) await repo.putPosition(next);
        else await repo.deletePosition(t.symbol);
      }
    });
  }

  return {
    getState, getSettings, updateSettings, ensureInitialized, setDay, setMode,
    searchSymbols, requestTrade, cancelTrade, processQueue, snapshot, history,
  };
}
