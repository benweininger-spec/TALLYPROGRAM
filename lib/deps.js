// Builds the server's dependencies from environment variables, once per
// warm function. Tests and the local preview server swap them with setDeps().
import { makeAuth } from './auth.js';
import { makePgStore } from './store/pg.js';
import { makeService } from './service.js';
import { makeAlpaca } from './alpaca.js';

const PAPER_URL = 'https://paper-api.alpaca.markets';

// No keys means no broker: the bank still works, trading reports it is off.
// No base URL means paper. Going live is an explicit change.
export function brokerFromEnv(env) {
  if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY) return null;
  return makeAlpaca({
    keyId: env.ALPACA_KEY_ID,
    secretKey: env.ALPACA_SECRET_KEY,
    baseUrl: env.ALPACA_BASE_URL || PAPER_URL,
  });
}

let override = null;
let cached = null;

export function setDeps(deps) {
  override = deps;
}

export function getDeps() {
  if (override) return override;
  if (!cached) cached = fromEnv(process.env);
  return cached;
}

function fromEnv(env) {
  let service = null;
  return {
    auth: makeAuth({ env }),
    // Built lazily so /api/config works even before the database is set up.
    get service() {
      if (!service) {
        const store = makePgStore(env.DATABASE_URL);
        service = makeService({ store, broker: brokerFromEnv(env) });
      }
      return service;
    },
    publicConfig: () => ({
      supabaseUrl: env.SUPABASE_URL || null,
      supabaseAnonKey: env.SUPABASE_ANON_KEY || null,
      devFake: false,
    }),
  };
}
