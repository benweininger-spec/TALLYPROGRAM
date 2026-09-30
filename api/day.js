// Marks a day clean or smoked. Past days are corrections that move that
// day's money between the bank and the ghost; today is a late report.
import { route, body } from '../lib/http.js';
import { getDeps } from '../lib/deps.js';

export default route({
  PUT: async (req) => {
    const deps = getDeps();
    await deps.auth.owner(req);
    const { day, state } = body(req);
    return deps.service.setDay({ day, state });
  },
});
