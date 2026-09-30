import { route } from '../lib/http.js';
import { getDeps } from '../lib/deps.js';

export default route({
  GET: async (req) => {
    const user = await getDeps().auth.owner(req);
    return { email: user.email };
  },
});
