import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const $app = document.getElementById('app');
const S = { config: null, supabase: null, token: null };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${S.token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    await signOut();
    throw new Error(data.message || 'Signed out');
  }
  if (!r.ok) throw Object.assign(new Error(data.message || `Request failed (${r.status})`), { code: data.error });
  return data;
}

async function signOut() {
  S.token = null;
  if (S.supabase) await S.supabase.auth.signOut().catch(() => {});
  renderLogin();
}

// ---------- login ----------
function renderLogin(message = '') {
  $app.innerHTML = `
    <section class="login">
      <h1>Ashes</h1>
      <p>Cravings you beat become money you can invest.</p>
      <form id="login" class="stack">
        <label class="field"><span>Email</span>
          <input class="input" type="email" name="email" autocomplete="email" required inputmode="email">
        </label>
        <button class="btn primary" type="submit">Send sign-in link</button>
      </form>
      <form id="otp" class="stack" hidden style="margin-top:20px">
        <label class="field"><span>Or type the 6-digit code from the email</span>
          <input class="input num" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6">
        </label>
        <button class="btn" type="submit">Sign in with code</button>
      </form>
      <p class="msg" id="loginMsg" style="margin-top:16px">${esc(message)}</p>
    </section>`;
  const msg = $app.querySelector('#loginMsg');
  const otp = $app.querySelector('#otp');
  let email = '';
  $app.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    email = new FormData(e.target).get('email').trim();
    msg.className = 'msg';
    msg.textContent = 'Sending…';
    const { error } = await S.supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin, shouldCreateUser: true },
    });
    if (error) {
      msg.className = 'msg error';
      msg.textContent = error.message;
      return;
    }
    msg.textContent = 'Check your email. Open the link on this device.';
    otp.hidden = false;
  });
  otp.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = new FormData(e.target).get('code').trim();
    const { error } = await S.supabase.auth.verifyOtp({ email, token, type: 'email' });
    if (error) {
      msg.className = 'msg error';
      msg.textContent = error.message;
    }
  });
}

// ---------- app ----------
async function renderApp() {
  $app.innerHTML = `<div class="boot">Loading…</div>`;
  try {
    const me = await api('/api/me');
    $app.innerHTML = `
      <section class="screen">
        <div class="topbar"><span class="brand">Ashes</span></div>
        <div class="card stack">
          <div>Signed in as <strong>${esc(me.email)}</strong>.</div>
          <button class="btn ghost" id="signout">Sign out</button>
        </div>
      </section>`;
    $app.querySelector('#signout').addEventListener('click', signOut);
  } catch (err) {
    if (S.token) renderLogin(err.message);
  }
}

// ---------- boot ----------
async function boot() {
  S.config = await fetch('/api/config').then((r) => r.json());
  if (S.config.devFake) {
    S.token = 'dev';
    return renderApp();
  }
  if (!S.config.supabaseUrl || !S.config.supabaseAnonKey) {
    $app.innerHTML = `<div class="boot">Server is missing SUPABASE_URL or SUPABASE_ANON_KEY.</div>`;
    return;
  }
  S.supabase = createClient(S.config.supabaseUrl, S.config.supabaseAnonKey, {
    auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  // Fires once with INITIAL_SESSION on subscribe, then on every change.
  S.supabase.auth.onAuthStateChange((event, session) => {
    const had = Boolean(S.token);
    S.token = session?.access_token || null;
    if (event === 'INITIAL_SESSION') return S.token ? renderApp() : renderLogin();
    if (S.token && !had) renderApp();
    else if (!S.token && had) renderLogin();
  });
}

boot().catch((err) => {
  $app.innerHTML = `<div class="boot">Could not start: ${esc(err.message)}</div>`;
});
