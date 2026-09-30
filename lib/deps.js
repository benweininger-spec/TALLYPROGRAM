// Builds the server's dependencies from environment variables, once per
// warm function. Tests and the local preview server swap them with setDeps().
import { makeAuth } from './auth.js';
import { makePgStore } from './store/pg.js';
import { makeService } from './service.js';

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
        service = makeService({ store });
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
