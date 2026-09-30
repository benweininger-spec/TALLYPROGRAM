// Scheduled jobs, one function for both (Vercel's Hobby plan allows 12):
//   /api/cron/execute-queue  submits due trades and settles finished ones
//   /api/cron/snapshot       records today's totals for the Ledgers chart
// Both are safe to call as often as you like.
import { route, query } from '../../lib/http.js';
import { getDeps } from '../../lib/deps.js';
import { HttpError } from '../../lib/errors.js';

const JOBS = {
  'execute-queue': (service) => service.processQueue(),
  snapshot: (service) => service.snapshot(),
};

export default route({
  GET: async (req) => {
    const deps = getDeps();
    deps.auth.cron(req);
    const name = query(req).job ?? String(req.url || '').split('?')[0].split('/').pop();
    const job = JOBS[name];
    if (!job) throw new HttpError(404, 'not_found', 'No such job');
    return job(deps.service);
  },
});
