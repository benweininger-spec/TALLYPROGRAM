import { route, body } from '../../lib/http.js';
import { getDeps } from '../../lib/deps.js';

export default route({
  POST: async (req) => {
    const deps = getDeps();
    await deps.auth.owner(req);
    return deps.service.cancelTrade(body(req).id);
  },
});
