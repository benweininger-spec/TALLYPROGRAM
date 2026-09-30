// Public, read-only: the sample reader shown to visitors who are not
// signed in. Fake data only; there is nothing here to write to.
import { route, query } from '../lib/http.js';
import { getDemo } from '../lib/demo.js';
import { HttpError } from '../lib/errors.js';

export default route({
  GET: async (req) => {
    const { view, q } = query(req);
    const { service } = await getDemo();
    if (view === 'state') return service.getState();
    if (view === 'history') return service.history();
    if (view === 'symbol') return service.searchSymbols(q);
    throw new HttpError(400, 'bad_view', 'Ask for state, history, or symbol');
  },
});
