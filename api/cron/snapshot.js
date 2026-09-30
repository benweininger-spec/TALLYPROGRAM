// Daily: records bank + portfolio vs. burned for the Ledgers chart.
import { route } from '../../lib/http.js';
import { getDeps } from '../../lib/deps.js';

export default route({
  GET: async (req) => {
    const deps = getDeps();
    deps.auth.cron(req);
    return deps.service.snapshot();
  },
});
