// Public: what the browser needs to start Supabase Auth. The anon key is
// designed to be public; RLS and the server-side checks do the protecting.
import { route } from '../lib/http.js';
import { getDeps } from '../lib/deps.js';

export default route({
  GET: () => getDeps().publicConfig(),
});
