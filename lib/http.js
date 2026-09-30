import { HttpError } from './errors.js';

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

// route({ GET: fn, POST: fn }) -> Vercel handler. Handlers return a JSON body.
export function route(methods) {
  return async function handler(req, res) {
    const fn = methods[req.method];
    if (!fn) {
      res.setHeader('allow', Object.keys(methods).join(', '));
      return send(res, 405, { error: 'method_not_allowed', message: `Use ${Object.keys(methods).join(' or ')}` });
    }
    try {
      const body = await fn(req, res);
      if (!res.writableEnded) send(res, 200, body ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.code, message: err.message });
      }
      console.error(err);
      return send(res, 500, { error: 'internal', message: 'Something went wrong on the server' });
    }
  };
}

export function body(req) {
  const b = req.body;
  if (b == null || b === '') return {};
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch {
      throw new HttpError(400, 'bad_json', 'Request body is not valid JSON');
    }
  }
  if (typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_body', 'Request body must be a JSON object');
  return b;
}

export function query(req) {
  if (req.query) return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams);
}
