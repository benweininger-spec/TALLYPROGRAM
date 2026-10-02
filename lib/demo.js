// A sample reader, 22 days in, for showing the app to people who are not
// signed in. Entirely in memory with a fake broker: it never touches the
// database or Alpaca. Rebuilt once per day per server instance.
import { makeMemoryStore } from './store/memory.js';
import { makeService } from './service.js';
import { makeFakeBroker } from './broker-fake.js';
import { SAMPLE_EDITION } from './edition-sample.js';
import { DEFAULT_UNIVERSE } from './edition.js';

const DAY = 86400000;
const TZ = 'America/Los_Angeles';

// The Market Page's past editions for the demo: the sample's words with a
// different three rungs each weekday, so the paper has a record to show.
const RUNG_SYMBOLS = Object.fromEntries(
  ['index', 'sector', 'name'].map((r) => [r, DEFAULT_UNIVERSE.filter((u) => u.rung === r)]),
);
function demoEdition(i) {
  const pick = (r) => {
    const list = RUNG_SYMBOLS[r];
    const u = list[(i * (r === 'name' ? 5 : 1)) % list.length];
    return { symbol: u.symbol, name: u.name, note: `${u.name}. A demo pick, printed for the record.` };
  };
  return { ...SAMPLE_EDITION, rungs: { index: pick('index'), sector: pick('sector'), name: pick('name') } };
}

// Three weeks of believable history: three smoked days, a few trades (one
// sold at a small gain, one held at a small loss), and two weeks of the
// Market Page.
export async function seedDemo({ days = 21, now = () => Date.now() } = {}) {
  let offsetMs = 0;
  const clock = () => new Date(now() + offsetMs);
  const store = makeMemoryStore();
  const broker = makeFakeBroker({ autoFill: true, clock });
  const service = makeService({ store, broker, clock });
  if (days > 0) {
    offsetMs = -days * DAY;
    await service.ensureInitialized(TZ);
    const dayKey = () => clock().toLocaleDateString('en-CA', { timeZone: TZ });
    let printed = 0;
    for (let d = days; d >= 1; d--) {
      offsetMs = -d * DAY;
      if (d === 7) broker.setPrice('VOO', 549.1);
      await service.getState();
      if (d === 16 || d === 10 || d === 9) await service.setDay({ day: dayKey(), state: 'smoked' });
      await service.processQueue();
      if (d === 18) await service.requestTrade({ symbol: 'VOO', side: 'buy', notional_cents: 2000 });
      if (d === 11) await service.requestTrade({ symbol: 'AAPL', side: 'buy', notional_cents: 5000 });
      if (d === 8) await service.requestTrade({ symbol: 'VOO', side: 'sell' });
      if (d === 5) await service.requestTrade({ symbol: 'MSFT', side: 'buy', notional_cents: 2000 });
      const dow = new Date(`${dayKey()}T12:00:00Z`).getUTCDay();
      if (d <= 15 && dow !== 0 && dow !== 6) {
        await store.tx((r) => r.putEdition({ day: dayKey(), content: demoEdition(printed++), universe: DEFAULT_UNIVERSE, model: 'sample' }));
      }
    }
    offsetMs = 0;
    await service.processQueue();
    broker.setPrice('AAPL', 235.4);
    broker.setPrice('VOO', 551.2);
    broker.setPrice('MSFT', 449.3);
  } else {
    await service.ensureInitialized(TZ);
  }
  const today = clock().toLocaleDateString('en-CA', { timeZone: TZ });
  await store.tx((r) => r.putEdition({ day: today, content: SAMPLE_EDITION, universe: DEFAULT_UNIVERSE, model: 'sample' }));
  await service.getState();
  return { store, broker, service };
}

let cached = null;
export function getDemo() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  if (!cached || cached.day !== today) {
    cached = { day: today, demo: seedDemo() };
    cached.demo.catch(() => (cached = null));
  }
  return cached.demo;
}
