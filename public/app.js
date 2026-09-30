const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

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
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt = (cents) => money.format((cents || 0) / 100);
const fmtWhole = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : fmt(cents));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const ICONS = {
  now: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="7"/><path d="M12 10v3l2 2M9 3h6"/></svg>',
  trade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l5-5 4 4 7-8"/><path d="M15 8h5v5"/></svg>',
  ledgers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V4M4 20h16"/><path d="M8 15l3-4 3 2 4-6"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
};

const TABS = [
  { id: 'now', label: 'Now', render: renderNow },
  { id: 'trade', label: 'Trade', render: renderTrade },
];

function storedTab() {
  try {
    return localStorage.getItem('ashes.tab');
  } catch {
    return null;
  }
}

async function refresh() {
  S.state = await api(`/api/state?tz=${encodeURIComponent(tz)}`);
}

async function renderApp() {
  $app.innerHTML = `<div class="boot">Loading…</div>`;
  try {
    await refresh();
  } catch (err) {
    if (S.token) $app.innerHTML = `<div class="boot">${esc(err.message)}</div>`;
    return;
  }
  if (!TABS.some((t) => t.id === S.tab)) S.tab = TABS.some((t) => t.id === storedTab()) ? storedTab() : 'now';
  $app.innerHTML = `
    <section class="screen" id="view"></section>
    ${TABS.length > 1 ? `<nav class="tabbar" aria-label="Sections">${TABS.map((t) => `
      <button data-tab="${t.id}" ${t.id === S.tab ? 'aria-current="page"' : ''}>${ICONS[t.id]}<span>${t.label}</span></button>`).join('')}
    </nav>` : ''}`;
  $app.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      S.tab = b.dataset.tab;
      try {
        localStorage.setItem('ashes.tab', S.tab);
      } catch {}
      $app.querySelectorAll('[data-tab]').forEach((x) => {
        if (x === b) x.setAttribute('aria-current', 'page');
        else x.removeAttribute('aria-current');
      });
      renderTab();
      refresh().then(renderTab).catch(() => {});
    }),
  );
  renderTab();
}

function renderTab() {
  clearInterval(S.ticker);
  const view = $app.querySelector('#view');
  if (!view || !S.state) return;
  const tab = TABS.find((t) => t.id === S.tab) || TABS[0];
  view.innerHTML = `
    <div class="topbar">
      <span class="brand">Ashes</span>
      <span class="badge ${esc(S.state.mode)}">${esc(S.state.mode)}</span>
    </div>
    <div id="tab"></div>`;
  tab.render(view.querySelector('#tab'));
}

// ---------- Now ----------
function renderNow(el) {
  const st = S.state;
  const t = st.today_counts;
  const capped = t.credited_cents >= t.cap_cents;
  el.innerHTML = `
    <div class="bank">
      <div class="bank-label">In the bank</div>
      <div class="bank-amount num" id="bank">${fmt(st.bank_cents)}</div>
      <div class="bank-float num" id="float" aria-hidden="true"></div>
    </div>
    <button class="btn primary craving" id="beat">I didn't smoke</button>
    <p class="msg center" id="nowMsg">${capped ? `Today's ${fmt(t.cap_cents)} is banked. Taps still count.` : `+${fmt(st.settings.credit_per_craving_cents)} per craving, up to ${fmt(t.cap_cents)} a day`}</p>
    <div class="stats">
      <div class="stat"><div class="stat-n num">${st.day_count}</div><div class="stat-l">Day</div></div>
      <div class="stat"><div class="stat-n num">${st.streak_days}</div><div class="stat-l">Smoke-free ${st.streak_days === 1 ? 'day' : 'days'}</div></div>
      <div class="stat"><div class="stat-n num">${t.beaten}</div><div class="stat-l">Beaten today</div></div>
    </div>
    <div class="meter" role="img" aria-label="${fmt(t.credited_cents)} of ${fmt(t.cap_cents)} banked today">
      <div class="meter-fill" style="width:${Math.min(100, (t.credited_cents / Math.max(1, t.cap_cents)) * 100)}%"></div>
    </div>
    <div class="row faint small"><span>Banked today</span><span class="num">${fmt(t.credited_cents)} / ${fmt(t.cap_cents)}</span></div>
    <button class="btn ghost slip" id="slip">I smoked</button>`;

  const beat = el.querySelector('#beat');
  const msg = el.querySelector('#nowMsg');
  beat.addEventListener('click', async () => {
    beat.disabled = true;
    navigator.vibrate?.(15);
    try {
      const r = await api('/api/craving', { method: 'POST', body: { beaten: true } });
      S.state.bank_cents = r.bank_cents;
      S.state.today_counts.beaten += 1;
      S.state.today_counts.credited_cents = r.today_credited_cents;
      renderTab();
      const float = $app.querySelector('#float');
      const m = $app.querySelector('#nowMsg');
      if (r.credited_cents > 0) {
        float.textContent = `+${fmt(r.credited_cents)}`;
        float.classList.add('go');
        $app.querySelector('#bank').classList.add('pulse');
      }
      m.textContent = r.credited_cents === 0 ? `Logged. Today's ${fmt(r.daily_cap_cents)} is already banked.` : r.capped ? `Banked ${fmt(r.credited_cents)}. That fills today.` : `Banked ${fmt(r.credited_cents)}.`;
    } catch (err) {
      msg.className = 'msg center error';
      msg.textContent = err.message;
      beat.disabled = false;
    }
  });

  const slip = el.querySelector('#slip');
  let armed = null;
  slip.addEventListener('click', async () => {
    if (!armed) {
      slip.textContent = 'Tap again to log it';
      armed = setTimeout(() => {
        armed = null;
        slip.textContent = 'I smoked';
      }, 3000);
      return;
    }
    clearTimeout(armed);
    slip.disabled = true;
    try {
      await api('/api/craving', { method: 'POST', body: { beaten: false } });
      await refresh();
      renderTab();
      $app.querySelector('#nowMsg').textContent = 'Logged. Next one counts.';
    } catch (err) {
      msg.className = 'msg center error';
      msg.textContent = err.message;
      slip.disabled = false;
    }
  });
}


// ---------- Trade ----------
const when = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function countdown(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'due now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

function renderTrade(el) {
  const st = S.state;
  const f = (S.tradeForm ||= { tier: null, symbol: null, name: '', confirm: false, msg: '', error: false });
  if (f.tier && !st.unlocked_tiers.includes(f.tier)) f.tier = null;
  const offline = st.mode === 'offline';
  const tiers = st.settings.tiers_cents;
  const ready = f.tier && f.symbol && !offline;

  el.innerHTML = `
    <div class="card">
      <div class="row"><span class="muted">In the bank</span><span class="num strong">${fmt(st.bank_cents)}</span></div>
      <div class="tiers" role="radiogroup" aria-label="Trade size">
        ${tiers.map((t) => {
          const open = st.unlocked_tiers.includes(t);
          return `<button class="tier ${f.tier === t ? 'on' : ''}" data-tier="${t}" role="radio" aria-checked="${f.tier === t}" ${open ? '' : 'disabled'}>
            <span class="tier-amt num">${fmtWhole(t)}</span>
            <span class="tier-sub num">${open ? 'unlocked' : `$${Math.ceil((t - st.bank_cents) / 100)} to go`}</span>
          </button>`;
        }).join('')}
      </div>
    </div>

    <h2>New trade</h2>
    ${offline ? `<div class="card muted">Trading is off until Alpaca keys are set on the server.</div>` : `
    <div class="card stack">
      ${f.symbol ? `
        <div class="row">
          <div><div class="strong">${esc(f.symbol)}</div><div class="muted small">${esc(f.name)}</div></div>
          <button class="btn small ghost" id="clearSym">Change</button>
        </div>` : `
        <label class="field"><span>Stock or ETF</span>
          <input class="input" id="sym" placeholder="Ticker or name, like VTI or Apple" autocomplete="off" autocapitalize="characters" spellcheck="false">
        </label>
        <ul class="list results" id="results"></ul>`}
      ${f.confirm ? `
        <div class="confirm">
          <p>Buy <strong>${fmt(f.tier)}</strong> of <strong>${esc(f.symbol)}</strong>. The bank pays now. It goes to Alpaca after <strong>${when(new Date(Date.now() + st.settings.cooldown_hours * 3600000))}</strong>, and you can cancel until then.</p>
          <div class="two">
            <button class="btn ghost" id="back">Back</button>
            <button class="btn primary" id="confirm">Queue it</button>
          </div>
        </div>` : `
        <button class="btn primary" id="queueBuy" ${ready ? '' : 'disabled'}>
          ${ready ? `Queue ${fmt(f.tier)} of ${esc(f.symbol)}` : !st.unlocked_tiers.length ? 'Bank more to unlock a trade' : !f.tier ? 'Pick a size above' : 'Pick a stock'}
        </button>`}
      <p class="msg ${f.error ? 'error' : ''}" id="tradeMsg">${esc(f.msg)}</p>
    </div>`}

    <h2>Queue</h2>
    ${st.queue_error ? `<p class="msg error">Could not reach Alpaca: ${esc(st.queue_error)}</p>` : ''}
    <div class="card">
      ${st.queue.length ? `<ul class="list">${st.queue.map((t) => `
        <li class="row">
          <div>
            <div><span class="side ${t.side}">${t.side}</span> <strong>${esc(t.symbol)}</strong> <span class="num">${t.side === 'buy' ? fmt(t.notional_cents) : `all, about ${fmt(t.notional_cents)}`}</span></div>
            <div class="muted small">${t.status === 'queued' ? `Sends <span class="num" data-count="${esc(t.execute_after)}">${countdown(t.execute_after)}</span>` : 'At Alpaca, waiting to fill'}</div>
          </div>
          ${t.status === 'queued' ? `<button class="btn small ghost" data-cancel="${esc(t.id)}">Cancel</button>` : ''}
        </li>`).join('')}</ul>` : `<div class="empty">Nothing queued.</div>`}
    </div>

    <h2>Positions</h2>
    <div class="card">
      ${st.positions.length ? `<ul class="list">${st.positions.map((p) => {
        const gain = p.value_cents - p.cost_cents;
        return `
        <li>
          <div class="row">
            <div><strong>${esc(p.symbol)}</strong> <span class="muted small num">${Number(p.qty).toFixed(4)} sh</span></div>
            <div class="num strong">${fmt(p.value_cents)}</div>
          </div>
          <div class="row small">
            <span class="num ${gain > 0 ? 'up' : gain < 0 ? 'down' : 'muted'}">${gain >= 0 ? '+' : '−'}${fmt(Math.abs(gain))} on ${fmt(p.cost_cents)}</span>
            ${p.sellable ? `<button class="btn small ghost" data-sell="${esc(p.symbol)}">Sell all</button>` : `<span class="faint">Locked until ${shortDate(p.sell_unlocks_at)}</span>`}
          </div>
        </li>`;
      }).join('')}</ul>` : `<div class="empty">No positions yet.</div>`}
      ${st.prices_stale && st.positions.length ? `<p class="faint small">Prices unavailable, showing cost.</p>` : ''}
    </div>`;

  const msg = (text, error = false) => {
    f.msg = text;
    f.error = error;
    const m = el.querySelector('#tradeMsg');
    if (m) {
      m.textContent = text;
      m.className = `msg ${error ? 'error' : ''}`;
    }
  };

  el.querySelectorAll('[data-tier]').forEach((b) =>
    b.addEventListener('click', () => {
      f.tier = Number(b.dataset.tier);
      f.confirm = false;
      f.msg = '';
      renderTab();
    }),
  );
  el.querySelector('#clearSym')?.addEventListener('click', () => {
    Object.assign(f, { symbol: null, name: '', confirm: false, msg: '' });
    renderTab();
    $app.querySelector('#sym')?.focus();
  });

  const input = el.querySelector('#sym');
  if (input) {
    const results = el.querySelector('#results');
    let timer = null;
    let seq = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) {
        results.innerHTML = '';
        return;
      }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const r = await api(`/api/symbol?q=${encodeURIComponent(q)}`);
          if (mine !== seq) return;
          results.innerHTML = r.results.length
            ? r.results.map((a) => `<li><button class="result" data-sym="${esc(a.symbol)}" data-name="${esc(a.name)}"><strong>${esc(a.symbol)}</strong> <span class="muted">${esc(a.name)}</span></button></li>`).join('')
            : `<li class="empty">No fractional stock or ETF matches.</li>`;
          results.querySelectorAll('[data-sym]').forEach((b) =>
            b.addEventListener('click', () => {
              Object.assign(f, { symbol: b.dataset.sym, name: b.dataset.name, msg: '' });
              renderTab();
            }),
          );
        } catch (err) {
          results.innerHTML = `<li class="msg error">${esc(err.message)}</li>`;
        }
      }, 250);
    });
  }

  el.querySelector('#queueBuy')?.addEventListener('click', () => {
    f.confirm = true;
    renderTab();
  });
  el.querySelector('#back')?.addEventListener('click', () => {
    f.confirm = false;
    renderTab();
  });
  el.querySelector('#confirm')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/trade', { method: 'POST', body: { symbol: f.symbol, side: 'buy', notional_cents: f.tier } });
      Object.assign(f, { tier: null, symbol: null, name: '', confirm: false });
      await refresh();
      f.msg = `Queued. ${r.trade.symbol} sends ${countdown(r.trade.execute_after)}.`;
      f.error = false;
      renderTab();
    } catch (err) {
      f.confirm = false;
      renderTab();
      msg(err.message, true);
    }
  });

  el.querySelectorAll('[data-cancel]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api('/api/trade/cancel', { method: 'POST', body: { id: b.dataset.cancel } });
        await refresh();
        f.msg = `Cancelled. ${fmt(r.trade.notional_cents || 0)} is back in the bank.`;
        if (r.trade.side === 'sell') f.msg = 'Cancelled the sell.';
        f.error = false;
        renderTab();
      } catch (err) {
        b.disabled = false;
        msg(err.message, true);
      }
    }),
  );

  el.querySelectorAll('[data-sell]').forEach((b) => {
    let armed = null;
    b.addEventListener('click', async () => {
      if (!armed) {
        b.textContent = 'Tap again to queue';
        armed = setTimeout(() => {
          armed = null;
          b.textContent = 'Sell all';
        }, 3000);
        return;
      }
      clearTimeout(armed);
      b.disabled = true;
      try {
        const r = await api('/api/trade', { method: 'POST', body: { symbol: b.dataset.sell, side: 'sell' } });
        await refresh();
        f.msg = `Sell queued. It sends ${countdown(r.trade.execute_after)}. Proceeds go to the bank.`;
        f.error = false;
        renderTab();
      } catch (err) {
        b.disabled = false;
        msg(err.message, true);
      }
    });
  });

  S.ticker = setInterval(() => {
    el.querySelectorAll('[data-count]').forEach((n) => (n.textContent = countdown(n.dataset.count)));
  }, 30000);
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
  const { createClient } = await import(SUPABASE_JS);
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
