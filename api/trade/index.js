import { route, body } from '../../lib/http.js';
import { getDeps } from '../../lib/deps.js';

export default route({
  POST: async (req) => {
    const deps = getDeps();
    await deps.auth.owner(req);
    const { symbol, side, notional_cents } = body(req);
    return deps.service.requestTrade({ symbol, side, notional_cents });
  },
});
