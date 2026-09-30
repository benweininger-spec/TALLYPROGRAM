import { timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';

function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function need(env, name) {
  const v = env[name];
  if (!v) throw new HttpError(500, 'misconfigured', `Server is missing ${name}`);
  return v;
}

// Verifies the Supabase session token with Supabase itself, then checks the
// email against ALLOWED_EMAIL. Works with both legacy and asymmetric JWT keys.
export function makeAuth({ env = process.env, fetchImpl = fetch } = {}) {
  return {
    async owner(req) {
      const allowed = need(env, 'ALLOWED_EMAIL').trim().toLowerCase();
      const url = need(env, 'SUPABASE_URL').replace(/\/$/, '');
      const anon = need(env, 'SUPABASE_ANON_KEY');
      const token = bearer(req);
      if (!token) throw new HttpError(401, 'unauthenticated', 'Sign in first');
      const r = await fetchImpl(`${url}/auth/v1/user`, {
        headers: { apikey: anon, authorization: `Bearer ${token}` },
      });
      if (r.status === 401 || r.status === 403) throw new HttpError(401, 'unauthenticated', 'Session expired, sign in again');
      if (!r.ok) throw new HttpError(502, 'auth_unavailable', 'Could not reach Supabase Auth');
      const user = await r.json();
      if (!user?.email || user.email.toLowerCase() !== allowed) {
        throw new HttpError(403, 'forbidden', 'This app has exactly one user');
      }
      return { id: user.id, email: user.email };
    },

    // Vercel Cron sends "Authorization: Bearer $CRON_SECRET".
    cron(req) {
      const secret = need(env, 'CRON_SECRET');
      const got = bearer(req) || '';
      const a = Buffer.from(got);
      const b = Buffer.from(secret);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new HttpError(401, 'unauthenticated', 'Bad cron secret');
      }
      return true;
    },
  };
}
