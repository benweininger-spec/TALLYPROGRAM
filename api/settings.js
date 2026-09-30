import { route, body } from '../lib/http.js';
import { getDeps } from '../lib/deps.js';

export default route({
  GET: async (req) => {
    const deps = getDeps();
    await deps.auth.owner(req);
    return deps.service.getSettings();
  },
  PUT: async (req) => {
    const deps = getDeps();
    await deps.auth.owner(req);
    return deps.service.updateSettings(body(req));
  },
});
