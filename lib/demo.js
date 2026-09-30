// A sample reader, 22 days in, for showing the app to people who are not
// signed in. Entirely in memory with a fake broker: it never touches the
// database or Alpaca. Rebuilt once per day per server instance.
import { makeMemoryStore } from './store/memory.js';
import { makeService } from './service.js';
import { makeFakeBroker } from './broker-fake.js';

const DAY = 86400000;
const TZ = 'America/Los_Angeles';

// Three weeks of believable history: three smoked days and two trades.
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
    for (let d = days; d >= 1; d--) {
      offsetMs = -d * DAY;
      await service.getState();
      if (d === 16 || d === 10 || d === 9) await service.setDay({ day: dayKey(), state: 'smoked' });
      await service.processQueue();
      if (d === 18) await service.requestTrade({ symbol: 'VOO', side: 'buy', notional_cents: 2000 });
      if (d === 11) await service.requestTrade({ symbol: 'AAPL', side: 'buy', notional_cents: 5000 });
    }
    offsetMs = 0;
    await service.processQueue();
    broker.setPrice('AAPL', 235.4);
    broker.setPrice('VOO', 551.2);
  } else {
    await service.ensureInitialized(TZ);
  }
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
