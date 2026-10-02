// Builds the server's dependencies from environment variables, once per
// warm function. Tests and the local preview server swap them with setDeps().
import { makeAuth } from './auth.js';
import { HttpError } from './errors.js';
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

// The Market Page's writer. Loaded on first use, so routes that never call
// Claude do not pay to load the SDK.
export function writerFromEnv(env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  return async (args) => (await import('./llm.js')).writeEdition(args);
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
        service = makeService({ store, broker: brokerFromEnv(env), writer: writerFromEnv(env) });
      }
      return service;
    },
    publicConfig: () => {
      const key = env.SUPABASE_ANON_KEY || null;
      if (isSecretKey(key)) {
        throw new HttpError(500, 'misconfigured', 'SUPABASE_ANON_KEY holds a secret key. Use the publishable or anon key.');
      }
      return { supabaseUrl: env.SUPABASE_URL || null, supabaseAnonKey: key, devFake: false };
    },
  };
}

// The browser receives SUPABASE_ANON_KEY. A secret or service-role key there
// would give anyone full database access, so refuse to serve one.
export function isSecretKey(key) {
  if (!key) return false;
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'service_role';
  } catch {
    return false;
  }
}
