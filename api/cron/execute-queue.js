// Submits trades whose cooldown has passed and settles ones Alpaca has
// finished. Safe to call as often as you like.
import { route } from '../../lib/http.js';
import { getDeps } from '../../lib/deps.js';

export default route({
  GET: async (req) => {
    const deps = getDeps();
    deps.auth.cron(req);
    return deps.service.processQueue();
  },
});
