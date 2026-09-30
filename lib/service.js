// Orchestrates rules, storage, and the broker. Every public method here is
// one API call's worth of work.
import { RuleError, HttpError } from './errors.js';
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
    // No cron needed for correctness: opening the app moves due trades along.
    let queueError = null;
    try {
      await processQueueIfDue();
    } catch (err) {
      queueError = err.message;
    }
    const market = await marketPrices();
    return store.run(async (repo) => {
      const now = clock();
      const s = await settingsOf(repo);
      const { today, start, end } = dayWindow(now, s.timezone);
      const bank = await repo.bankBalance();
      const counts = await repo.cravingCountsBetween(start, end);
      const lastSlip = await repo.lastSlipAt();
      const days = rules.dayCount(s.quit_date, today);
      const positions = (await repo.listPositions()).map((p) => valuePosition(p, market, s, now));
      const open = await repo.listTrades({ statuses: ['queued', 'submitted'], limit: 50 });
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
        portfolio_cents: positions.reduce((a, p) => a + p.value_cents, 0),
        prices_stale: market.stale,
        positions,
        queue: open.map(publicTrade).reverse(),
        queue_error: queueError,
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

  function valuePosition(p, market, s, now) {
    const qty = Number(p.qty);
    const price = market.prices[p.symbol] ?? Number(p.avg_cost);
    const unlocks = rules.holdUnlocksAt(p, s);
    return {
      symbol: p.symbol,
      qty: p.qty,
      avg_cost: p.avg_cost,
      price,
      value_cents: Math.round(qty * price * 100),
      cost_cents: Math.round(qty * Number(p.avg_cost) * 100),
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
      return store.tx(async (repo) => {
        const now = clock();
        const s = await settingsOf(repo);
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
    logCraving, getState, getSettings, updateSettings, ensureInitialized,
    searchSymbols, requestTrade, cancelTrade, processQueue,
  };
}
