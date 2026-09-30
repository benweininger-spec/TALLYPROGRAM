import { route, query } from '../lib/http.js';
import { getDeps } from '../lib/deps.js';

export default route({
  GET: async (req) => {
    const deps = getDeps();
    await deps.auth.owner(req);
    return deps.service.searchSymbols(query(req).q);
  },
});
