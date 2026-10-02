// Scheduled jobs, one function for all (Vercel's Hobby plan allows 12):
//   /api/cron/execute-queue  submits due trades and settles finished ones
//   /api/cron/snapshot       records today's totals for the Ledgers chart
//   /api/cron/market-page    writes today's Market Page (one Claude call,
//                            two at most); does nothing once today's is out
// All are safe to call as often as you like.
import { route, query } from '../../lib/http.js';
import { getDeps } from '../../lib/deps.js';
import { HttpError } from '../../lib/errors.js';

const JOBS = {
  'execute-queue': (service) => service.processQueue(),
  snapshot: (service) => service.snapshot(),
  'market-page': (service) => service.writeEdition(),
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
