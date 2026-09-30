// Local preview with no Supabase and no Alpaca: in-memory data, a fake
// broker, and sign-in skipped. Never deployed; Vercel only runs api/*.js.
//   npm run dev            -> http://localhost:3000
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setDeps } from '../lib/deps.js';
import { makeMemoryStore } from '../lib/store/memory.js';
import { makeService } from '../lib/service.js';
import { makeFakeBroker } from '../lib/broker-fake.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);

const DAY = 86400000;
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);
const store = makeMemoryStore();
const broker = makeFakeBroker({ autoFill: true, clock });
const service = makeService({ store, broker, clock });

// Three weeks of believable history, like the design's "Three weeks in":
// three smoked days and two trades. SEED=0 starts empty (day one).
async function seed(days = 21) {
  offsetMs = -days * DAY;
  await service.ensureInitialized('America/Los_Angeles');
  const dayKey = () => clock().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
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
  await service.getState();
}
if (process.env.SEED !== '0') await seed();
else await service.ensureInitialized('America/Los_Angeles');
setDeps({
  auth: { owner: async () => ({ id: 'dev', email: 'dev@localhost' }), cron: () => true },
  service,
  broker,
  publicConfig: () => ({ supabaseUrl: null, supabaseAnonKey: null, devFake: true }),
});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function apiHandler(pathname) {
  const rel = pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9/-]+$/.test(rel)) return null;
  for (const candidate of [`api/${rel}.js`, `api/${rel}/index.js`]) {
    const file = join(root, candidate);
    if (await stat(file).catch(() => null)) return (await import(pathToFileURL(file).href)).default;
  }
  return null;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        const handler = await apiHandler(url.pathname);
        if (!handler) {
          res.statusCode = 404;
          return res.end('{"error":"not_found"}');
        }
        let raw = '';
        for await (const chunk of req) raw += chunk;
        req.body = raw ? JSON.parse(raw) : undefined;
        req.query = Object.fromEntries(url.searchParams);
        return await handler(req, res);
      }
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (path.includes('..')) throw new Error('bad path');
      const data = await readFile(join(root, 'public', path));
      res.setHeader('content-type', TYPES[extname(path)] || 'application/octet-stream');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  })
  .listen(port, () => console.log(`Preview (fake data, no sign-in): http://localhost:${port}`));
