// The editorial position: 'quit' or 'smoking'. Sets how each day goes to
// press at midnight from today on.
import { route, body } from '../lib/http.js';
import { getDeps } from '../lib/deps.js';

export default route({
  PUT: async (req) => {
    const deps = getDeps();
    await deps.auth.owner(req);
    return deps.service.setMode(body(req).mode);
  },
});
