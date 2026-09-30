// Builds the server's dependencies from environment variables, once per
// warm function. Tests and the local dev server swap them with setDeps().
import { makeAuth } from './auth.js';

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
  return {
    auth: makeAuth({ env }),
    publicConfig: () => ({
      supabaseUrl: env.SUPABASE_URL || null,
      supabaseAnonKey: env.SUPABASE_ANON_KEY || null,
      devFake: false,
    }),
  };
}
