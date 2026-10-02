// Ciggy Bank v2, "The Ad in the Journal".
// Plain JS, no build step: every screen is a template string set as
// innerHTML. Clicks are delegated through data-act attributes.
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const $app = document.getElementById('app');
const S = {
  config: null,
  supabase: null,
  token: null,
  demo: false, // showing the sample reader to a visitor who is not signed in
  state: null,
  history: null,
  tab: 'now',
  layout: 'narrow',
  month: null, // { y, m } for calendar paging
  editDay: null,
  confirmMode: null,
  dialogErr: '',
  busy: false,
  toast: null,
  trade: { tier: null, symbol: null, name: '', confirm: false, msg: '', error: false },
  settingsMsg: '',
  settingsErr: false,
};

// ---------- formatting ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AP = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const WDN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (c) => (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (c) => `${c < 0 ? '−' : ''}$${num(c)}`;
const whole = (c) => `${c < 0 ? '−' : ''}$${Math.round(Math.abs(c) / 100).toLocaleString('en-US')}`;
// Signed money and percentages for gains: +$0.84, −$0.12, $0.00; +1.68%.
const sfmt = (c) => `${c > 0 ? '+' : ''}${fmt(c)}`;
const pct = (x, dp = 2) => {
  if (x == null || !Number.isFinite(x)) return '–';
  const r = Math.round(x * 100 * 10 ** dp) / 10 ** dp;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(dp)}%`;
};
const UP = '#2E6B45';
const DOWN = '#8E1F16';
const gainColor = (c) => (c > 0 ? UP : c < 0 ? DOWN : '#1B1712');
const ord = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const parseDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (day, n) => {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const ap = (day) => {
  const d = parseDay(day);
  return `${AP[d.getMonth()]} ${d.getDate()}`;
};
const wd3 = (day) => WDN[parseDay(day).getDay()].slice(0, 3);
const localDayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: S.state?.settings?.timezone || undefined });
const plural = (n, one, many) => (n === 1 ? one : many);
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const numberWord = (n) => (n < 20 ? WORDS[n] : n < 100 ? TENS[Math.floor(n / 10)] + (n % 10 ? `-${WORDS[n % 10]}` : '') : String(n));
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// "$12" in headlines; "twelve dollars" in stories when it reads naturally.
const dailyStr = (c) => (c % 100 === 0 ? `$${(c / 100).toLocaleString('en-US')}` : fmt(c));
const dailyWords = (c) => (c % 100 === 0 && c / 100 < 100 ? `${numberWord(c / 100)} dollars` : dailyStr(c));

// ---------- marks (24-unit viewBox) ----------
const X_PATH = 'M5 5L19 19M19 5L5 19';
function markSvg(kind, size, { fg = '#1B1712', x = '#C0321F', sw = 3, style = '' } = {}) {
  let inner = '';
  if (kind === 'clean') inner = `<path d="${X_PATH}" stroke="${x}" stroke-width="${sw}" stroke-linecap="round" fill="none"/>`;
  else if (kind === 'pending') inner = `<path d="${X_PATH}" stroke="${fg}" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="2.4 2.4" fill="none"/>`;
  else if (kind === 'smoked') inner = `<circle cx="12" cy="12" r="6.3" fill="${fg}"/><circle cx="12" cy="12" r="9.6" fill="none" stroke="${fg}" stroke-width="1" stroke-dasharray="1.4 2.4"/>`;
  else if (kind === 'future') inner = '<circle cx="12" cy="12" r="1.4" fill="#A69C8C"/>';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"${style ? ` style="${style}"` : ''}>${inner}</svg>`;
}

// ---------- layout ----------
// Width is measured with a ResizeObserver on <html>, not only 'resize'.
const layoutFor = (w) => (w >= 1180 ? 'three' : w >= 760 ? 'wide' : 'narrow');
function V() {
  const wide = S.layout !== 'narrow';
  const three = S.layout === 'three';
  return {
    wide,
    three,
    pagePad: wide ? '0 40px 60px' : '0 14px 100px',
    datelineFs: wide ? '11px' : '9px',
    headPad: wide ? '22px 0 18px' : '10px 0 8px',
    headRule: wide ? '3px double #1B1712' : 'none',
    headCols: three ? 'minmax(0,210px) minmax(0,1fr) minmax(0,210px)' : wide ? 'minmax(0,150px) minmax(0,1fr) minmax(0,150px)' : 'minmax(0,1fr)',
    colGap: wide ? '28px' : '12px',
    nowCols: three ? 'minmax(0,1fr) minmax(0,1.35fr) minmax(0,1fr)' : 'minmax(0,1.1fr) minmax(0,1fr)',
    // Single quotes: these land inside a double-quoted style attribute.
    // The Market Page runs full width under the lead story on wide pages,
    // so its three rungs get three columns; on a phone it follows the index.
    nowAreas: three
      ? "'story bank toggle' 'story bank late' 'market market market' 'ghost week class'"
      : wide
        ? "'story bank' 'story toggle' 'story late' 'market market' 'week week' 'ghost class'"
        : "'story bank' 'toggle toggle' 'week week' 'market market' 'class class' 'ghost ghost' 'late late'",
    rowGap: wide ? '18px' : '0px',
    storyFs: three ? '16px' : wide ? '14px' : '11px',
    tableFs: wide ? '14px' : '10.5px',
    smallFs: wide ? '13px' : '10px',
    ghostHeadFs: wide ? '24px' : '17px',
    blockTop: wide ? '0px' : '12px',
    sideRule: wide ? '1px solid #1B1712' : 'none',
    sidePad: wide ? '28px' : '0px',
    weekRule: three ? 'none' : '1px solid #1B1712',
    weekCellH: wide ? '72px' : '52px',
    calCols: wide ? 'minmax(0,1.5fr) minmax(0,1fr)' : 'minmax(0,1fr)',
    tradeCols: three ? 'repeat(3,minmax(0,1fr))' : wide ? 'repeat(2,minmax(0,1fr))' : 'minmax(0,1fr)',
    ledgerCols: wide ? 'minmax(0,1.3fr) minmax(0,1fr)' : 'minmax(0,1fr)',
    toastBottom: wide ? '28px' : '86px',
  };
}
function watchLayout() {
  const apply = () => {
    const next = layoutFor(document.documentElement.clientWidth || window.innerWidth);
    document.documentElement.dataset.layout = next;
    if (next !== S.layout) {
      S.layout = next;
      if (S.state) render();
    }
  };
  apply();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(apply).observe(document.documentElement);
  window.addEventListener('resize', apply);
}

// ---------- server ----------
const DEMO_NO = 'Demo edition. Sign in to make changes.';
function demoPath(path) {
  const [base, qs = ''] = path.split('?');
  const view = { '/api/state': 'state', '/api/history': 'history', '/api/symbol': 'symbol' }[base];
  return view ? `/api/demo?view=${view}${qs && view === 'symbol' ? `&${qs}` : ''}` : null;
}

async function api(path, { method = 'GET', body } = {}) {
  if (S.demo) {
    const demo = method === 'GET' ? demoPath(path) : null;
    if (!demo) throw Object.assign(new Error(DEMO_NO), { code: 'demo' });
    path = demo;
  }
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
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
async function refresh() {
  S.state = await api(`/api/state?tz=${encodeURIComponent(tz)}`);
}
async function refreshHistory() {
  S.history = await api('/api/history');
}

function flash(msg) {
  clearTimeout(S.toastT);
  S.toast = msg;
  renderToast();
  S.toastT = setTimeout(() => {
    S.toast = null;
    renderToast();
  }, 3600);
}

// ---------- the front page's copy, by state ----------
function money(st) {
  const lots = st.ghost.lots;
  return {
    D: dailyStr(st.daily_cents),
    Dw: dailyWords(st.daily_cents),
    bench: st.ghost.benchmark,
    lots,
    ghost: st.ghost.value_cents,
    gain: st.ghost.value_cents - st.ghost.cost_cents,
    yours: st.bank_cents + st.portfolio_cents + (st.queued_cents || 0),
    isSmoking: st.mode === 'smoking',
    todayClean: st.today_state === 'clean',
    lived: st.day_count > 1,
  };
}

function frontPage(st) {
  const { D, Dw, bench, lots, ghost, gain, isSmoking, todayClean, lived } = money(st);
  const streak = st.streak_days;
  let kicker, headline, deck, first, rest, more, mood;
  if (isSmoking) {
    kicker = 'Markets tumble';
    mood = 'down';
    headline = 'BANK SUSPENDS DEPOSITS PENDING FURTHER NOTICE';
    deck = `Daily ${D} rerouted to could-have-been, where it will be invested and admired from a distance.`;
    first = 'T';
    rest = 'he Ciggy Bank stopped taking deposits today after the bearer changed the editorial position to I’m smoking.';
    more = [
      `Each day’s ${Dw} now goes to the Could-Have-Been fund, invested in ${bench} and reported with all the enthusiasm of a weather forecast.`,
      'Officials say the doors reopen the moment the box is unchecked. “We’re not going anywhere,” said a spokesman. “We’re a bank.”',
    ];
  } else if (!todayClean) {
    kicker = 'Markets dip';
    mood = 'down';
    headline = 'MARKETS DIP ON LATE REPORT; TOMORROW OPENS AT THE BELL';
    deck = `Today’s ${D} routed to could-have-been. Analysts note this happens, and then the next day happens.`;
    first = 'A';
    rest = ` late report filed this afternoon marked today as smoked. Under standing rules, the day’s ${Dw} go to the Could-Have-Been fund at midnight instead of the bank.`;
    more = [`No other penalties apply. The bank’s ${fmt(st.bank_cents)} is untouched.`, '“It’s one day,” said a source close to the calendar. “There’s another one tomorrow. We checked.”'];
  } else if (!lived) {
    kicker = 'Opening bell';
    mood = 'up';
    headline = 'BEARER QUITS; MARKETS OPEN HIGHER ON THE NEWS';
    deck = `Analysts expect ${D} by midnight. Cravings forecast, expected to pass.`;
    first = 'T';
    rest = 'he bearer announced this morning that they have quit smoking, a statement markets received with cautious enthusiasm.';
    more = [
      `Under the terms of the arrangement, every clean day pays ${D} into the Ciggy Bank at midnight. There is no fee, no minimum, and nobody to call.`,
      '“We’ve heard this before,” said a cigarette, reached for comment at a gas station. “We’ll see.”',
    ];
  } else if (streak === 1) {
    kicker = 'Recovery rally';
    mood = 'up';
    headline = 'LOCAL MAN BACK ON THE WAGON; WAGON REPORTS NO COMPLAINTS';
    deck = `${capFirst(Dw)} expected at the close. Yesterday declines to comment.`;
    first = 'T';
    rest = 'he bearer returned to form today, declining every cigarette offered by circumstance, habit, and a coworker named Dale.';
    more = [`Under standing rules, today’s ${Dw} land in the bank at midnight.`, lots ? `The Could-Have-Been fund sits at ${fmt(ghost)}. It is not growing tonight.` : ''].filter(Boolean);
  } else {
    kicker = 'Bull market';
    mood = 'up';
    headline = `LOCAL MAN DECLINES CIGARETTE FOR ${ord(streak).toUpperCase()} STRAIGHT DAY`;
    deck = 'Lungs “cautiously optimistic.” Ghost portfolio files complaint, is ignored.';
    first = 'T';
    rest = `rading was brisk yesterday as the bearer once again failed to purchase a pack, sending the bank up ${Dw} at the close.`;
    more = [
      '“We had a moment around 3 p.m.,” said a source close to the lungs. “He looked at the gas station. He kept walking.”',
      lots ? `The Could-Have-Been fund, which invests money the bearer did smoke, closed at ${fmt(ghost)}, a gain nobody is celebrating.` : 'The Could-Have-Been fund remains empty, its managers visibly bored.',
    ];
  }
  const classifieds = isSmoking
    ? [
        { head: 'NOTICE', body: 'The bank is open whenever you are. Hours: always. Parking: validated.' },
        { head: 'WANTED', body: `One (1) box, unchecked. Reward: ${D} a day, indefinitely.` },
      ]
    : !lived
      ? [
          { head: 'WANTED', body: 'Something to do with hands. Pen accepted. Will consider a second pen.' },
          { head: 'LOST', body: 'One lighter. Finder may keep it. Finder is encouraged to keep it.' },
        ]
      : [
          { head: 'FOR SALE', body: `One nicotine habit, lightly used, ${streak} ${plural(streak, 'day', 'days')} idle. Must go. No offer at all preferred.` },
          { head: 'CORRECTION', body: 'Yesterday’s edition called today a “bear day.” It was a Tuesday. We regret the error.' },
        ];
  const ghostHead = lots === 0 ? 'Could-Have-Been Fund Idle' : gain >= 0 ? 'Could-Have-Been Fund Edges Up' : 'Could-Have-Been Fund Slips';
  const ghostStory =
    lots === 0
      ? '“Frankly, it’s the best result we could hope for,” said one of its managers, from a folding chair. The fund holds $0.00 and intends to keep it that way.'
      : `The fund, which holds the price of ${lots} smoked ${plural(lots, 'day', 'days')} invested in ${bench} as if saved, closed at ${fmt(ghost)}. It cannot be spent, traded, or withdrawn. It exists to be looked at, briefly, and then not.`;
  return { kicker, headline, deck, first, rest, more, mood, classifieds, ghostHead, ghostStory };
}

function headFor(tab, st) {
  const { D, isSmoking, todayClean, lived, yours, ghost } = money(st);
  if (tab === 'now') return frontPage(st);
  if (tab === 'calendar') {
    const c = st.days.filter((d) => d.state === 'clean').length;
    const s = st.days.length - c;
    return lived
      ? { kicker: 'The X-Effect Index · Page 2', headline: `${st.day_count} DAYS ON THE BOOKS; ${c} CLEAN, ${s} SMOKED`, deck: `Every day is worth ${D}. Clean days pay the bank; smoked days pay the ghost. The two always add up.` }
      : { kicker: 'The X-Effect Index · Page 2', headline: 'ONE DAY ON THE BOOKS; JURY STILL OUT', deck: 'Tonight at midnight, today’s cell goes to press with its X.' };
  }
  if (tab === 'trade') {
    const u = st.unlocked_tiers;
    if (u.length) {
      return {
        kicker: 'The trading desk',
        headline: `BANK CLEARS BEARER FOR TRADES UP TO ${whole(u.at(-1))}`,
        deck: `Orders wait ${st.settings.cooldown_hours} hours before they go to Alpaca, which is roughly ${st.settings.cooldown_hours - 1} hours and 55 minutes longer than a craving.`,
      };
    }
    const first = Math.min(...st.settings.tiers_cents);
    const n = Math.max(1, Math.ceil((first - st.bank_cents) / Math.max(1, st.daily_cents)));
    return {
      kicker: 'The trading desk',
      headline: `TRADING DESK OPENS AT ${whole(first)}; BEARER ADVISED TO WAIT ${numberWord(n).toUpperCase()} ${plural(n, 'DAY', 'DAYS')}`,
      deck: `${capFirst(numberWord(n))} clean ${plural(n, 'day unlocks', 'days unlock')} the first trade. The desk will be here. It’s a desk.`,
    };
  }
  if (tab === 'ledgers') {
    return { kicker: 'The books', headline: 'BURNED, YOURS, AND COULD-HAVE-BEEN', deck: `Had you kept smoking, ${fmt(st.burned_cents)} would be gone. Instead ${fmt(yours)} is yours and ${fmt(ghost)} is a ghost.` };
  }
  return { kicker: 'Masthead & standing rules', headline: 'THE FINE PRINT', deck: 'Changes take effect with the next edition. Guardrails can tighten, never loosen.' };
}

function weatherOf(st) {
  const { D, isSmoking, todayClean } = money(st);
  if (isSmoking) return 'Overcast, bank closed';
  if (todayClean) return `High of ${whole(st.bank_cents + st.daily_cents)} by midnight`;
  return `Overcast, ${D} to the ghost`;
}

// ---------- shell ----------
const TABS = [
  ['now', 'Now'],
  ['calendar', 'Calendar'],
  ['trade', 'Trade'],
  ['ledgers', 'Ledgers'],
  ['settings', 'Settings'],
];

function masthead(day) {
  const v = V();
  if (!v.wide) {
    return `<header class="masthead"><div class="mh-n">
      <div class="mh-row"><div class="mh-intro">Introducing the</div><div class="mh-vol">Vol. I · No. ${day ?? 1} · 12¢</div></div>
      <div class="mh-logo">Ciggy Bank</div>
      <div class="mh-tag"><span>The only cigarette that pays you back.</span><span style="white-space:nowrap">${day ? `Day ${day}` : ''}</span></div>
    </div></header>`;
  }
  return `<header class="masthead"><div class="mh-w">
    <div class="mh-center"><div style="text-align:center"><div class="mh-intro">Introducing the</div><div class="mh-logo">Ciggy Bank</div></div></div>
    <div class="mh-tag"><span>The only cigarette that pays you back.</span><span>${day ? `Day ${day}` : ''}</span></div>
  </div></header>`;
}

function render() {
  const st = S.state;
  if (!st) return;
  const v = V();
  const hd = headFor(S.tab, st);
  const isNow = S.tab === 'now';
  const up = isNow && hd.mood === 'up';
  const down = isNow && hd.mood === 'down';
  const weather = weatherOf(st);
  const today = st.today;
  const dateline = `${wd3(today)}., ${ap(today)}, ${parseDay(today).getFullYear()}`;
  const tabsHtml = TABS.map(([id, label]) => `<button data-act="tab" data-arg="${id}"${S.tab === id ? ' aria-current="page"' : ''}>${v.wide ? label : `<span>${label}</span>`}</button>`).join('');
  const screens = { now: screenNow, calendar: screenCalendar, trade: screenTrade, ledgers: screenLedgers, settings: screenSettings };

  $app.innerHTML = `
    <div class="grain" aria-hidden="true"></div>
    ${masthead(st.day_count)}
    <div class="page" style="padding:${v.pagePad}">
      <div class="dateline" style="font-size:${v.datelineFs}">
        <span>${dateline}</span>
        ${v.wide ? '' : `<span><b>Weather:</b> ${esc(weather)}</span>`}
      </div>
      ${S.demo ? `<div class="demo-bar" style="font-size:${v.datelineFs}"><span><b>Demo edition.</b> A sample reader, ${st.day_count} days in. Look around; nothing here is real.</span><button class="redlink" data-act="signin">Sign in →</button></div>` : ''}
      ${v.wide ? `<nav class="topnav" aria-label="Sections">${tabsHtml}</nav>` : ''}
      <div class="head" style="grid-template-columns:${v.headCols};padding:${v.headPad};border-bottom:${v.headRule}">
        ${v.wide ? `<div class="ear"><b>Weather.</b> ${esc(weather)}. Light cravings after lunch, clearing by evening.</div>` : ''}
        <div class="head-c">
          <div class="kicker${down ? ' down' : ''}">
            ${up ? '<span aria-hidden="true" class="stars">★★★</span>' : ''}
            <span>${esc(hd.kicker)}</span>
            ${down ? '<svg aria-hidden="true" width="46" height="14" viewBox="0 0 64 18"><path d="M1 3 L14 8 L22 5 L34 12 L44 10 L63 17" fill="none" stroke="#C0321F" stroke-width="2.4" stroke-linejoin="round"/><path d="M55 17 L63 17 L63 9" fill="none" stroke="#C0321F" stroke-width="2.4"/></svg>' : ''}
          </div>
          <h1 class="headline">${esc(hd.headline)}</h1>
          <p class="deck">${esc(hd.deck)}</p>
        </div>
        ${v.wide ? `<div class="ear r"><b>Vol. I, No. ${st.day_count}.</b> Price: 12¢, or one cigarette you did not buy.</div>` : ''}
      </div>
      <div id="screen">${(screens[S.tab] || screenNow)(st, v)}</div>
    </div>
    ${v.wide ? '' : `<nav class="tabbar" aria-label="Sections"><div class="in">${tabsHtml}</div></nav>`}
    <div id="overlay">${overlayHtml(st)}</div>
    <div id="toast"></div>`;
  renderToast();
  afterRender();
}

function afterRender() {
  S.chartRO?.forEach((ro) => ro.disconnect());
  S.chartRO = [];
  if (S.tab === 'ledgers') {
    for (const [id, draw] of [['#chart', drawChart], ['#rchart', drawRecordChart]]) {
      const box = $app.querySelector(id);
      if (!box) continue;
      draw(box);
      if (typeof ResizeObserver === 'undefined') continue;
      let w = box.clientWidth;
      const ro = new ResizeObserver(() => {
        if (box.clientWidth !== w) {
          w = box.clientWidth;
          draw(box);
        }
      });
      ro.observe(box);
      S.chartRO.push(ro);
    }
  }
  const dlg = $app.querySelector('.dialog [data-focus]');
  if (dlg) dlg.focus();
}

function renderToast() {
  const el = $app.querySelector('#toast');
  if (!el) return;
  el.innerHTML = S.toast
    ? `<div class="toast" role="status" style="bottom:${V().toastBottom}"><b>Stop press</b><span>${esc(S.toast)}</span></div>`
    : '';
}

// ---------- Now ----------
function dayCell(d, label, { month = false } = {}) {
  const st = S.state;
  const info = d ? st.days.find((x) => x.day === d) : null;
  const future = d && d > st.today;
  const before = d && d < st.settings.quit_date;
  const isToday = d === st.today;
  const editing = d && S.editDay === d;
  const bg = before || !d ? '#E6DABE' : isToday ? '#1B1712' : '#EFE4CB';
  const fg = future ? '#A69C8C' : isToday ? '#EFE4CB' : '#1B1712';
  let kind = null;
  if (info && info.state === 'clean') kind = isToday ? 'pending' : 'clean';
  else if (info && info.state === 'smoked') kind = 'smoked';
  else if (future) kind = 'future';
  const aria = !d ? '' : before ? 'Before quit date' : future ? `${ap(d)}, not yet` : `${ap(d)}, ${info.state}${isToday ? ', today' : ''}. Tap to correct.`;
  const style = `background:${bg};color:${fg};box-shadow:${editing ? 'inset 0 0 0 3px #C0321F' : 'none'}`;
  const svg = kind ? markSvg(kind, month ? 26 : 22, { fg, x: isToday ? '#EFE4CB' : '#C0321F', sw: month ? 2.8 : 3, style: month ? 'margin-top:6px' : '' }) : month ? '' : '<svg width="22" height="22" aria-hidden="true"></svg>';
  const lab = before || !d ? '' : label;
  if (month) {
    return `<button class="mcell" ${info ? `data-act="edit" data-arg="${d}"` : 'disabled'} aria-label="${esc(aria)}" style="${style}">
      <span class="d" style="font-weight:${isToday ? 700 : 400}">${lab}</span>${svg}</button>`;
  }
  return `<button class="cell" ${info ? `data-act="edit" data-arg="${d}"` : 'disabled'} aria-label="${esc(aria)}" style="${style};min-height:${V().weekCellH}">
    <span class="d" style="font-weight:${isToday ? 700 : 400}">${lab}</span>${svg}</button>`;
}

function screenNow(st, v) {
  const fp = frontPage(st);
  const { isSmoking, todayClean, lots, ghost, gain } = money(st);
  const bankStr = fmt(st.bank_cents);
  const dot = bankStr.lastIndexOf('.');
  const week = [];
  for (let i = -6; i <= 0; i++) {
    const d = addDays(st.today, i);
    week.push(dayCell(d, `${WDN[parseDay(d).getDay()].slice(0, 2).toUpperCase()} ${parseDay(d).getDate()}`));
  }
  const tonightOff = isSmoking || !todayClean;
  return `<section class="now" data-screen-label="Now" style="grid-template-columns:${v.nowCols};grid-template-areas:${v.nowAreas};column-gap:${v.colGap};row-gap:${v.rowGap}">
    <div class="story" style="padding-right:${v.colGap};font-size:${v.storyFs}">
      <p><span class="dropcap">${esc(fp.first)}</span>${esc(fp.rest)}</p>
      ${fp.more.map((p) => `<p>${esc(p)}</p>`).join('')}
    </div>

    <div class="bankcol">
      <div class="lbl">In the bank</div>
      <div class="bankfig">${esc(bankStr.slice(0, dot))}<span class="c">${esc(bankStr.slice(dot))}</span></div>
      ${!isSmoking && todayClean ? '<div class="wink">and counting!</div>' : ''}
      <div class="quotes" style="font-size:${v.tableFs}">
        <b>CIGB</b><span class="k">Bank, tonight</span><span class="v" style="color:${tonightOff ? '#5E554A' : '#2E6B45'}">${tonightOff ? '— 0.00' : `▲ ${num(st.daily_cents)}`}</span>
        <b>STKS</b><span class="k">Stocks</span><span class="v">${num(st.portfolio_cents)}</span>
        <b>GHST</b><span class="k">Ghost</span><span class="v" style="color:#7A7266">${num(ghost)}</span>
        <span></span><span class="note">${lots ? `${gain >= 0 ? '▲' : '▼'} ${num(gain)} since bought, ${gain >= 0 ? 'unfortunately' : 'fortunately'}` : 'empty, as hoped'}</span>
        <b>BRND</b><span class="k">Burned</span><span class="v" style="color:#22335E">−${num(st.burned_cents)}</span>
      </div>
    </div>

    <div class="togglecol" style="padding-top:${v.blockTop};border-left:${v.sideRule};padding-left:${v.sidePad}">
      <div class="lbl">Editorial position</div>
      <div class="radio2" role="radiogroup" aria-label="Editorial position">
        <button class="opt" role="radio" aria-checked="${!isSmoking}" data-act="mode" data-arg="quit"><span class="box18">${isSmoking ? '' : '✕'}</span><span class="t">I quit</span></button>
        <button class="opt" role="radio" aria-checked="${isSmoking}" data-act="mode" data-arg="smoking"><span class="box18">${isSmoking ? '✕' : ''}</span><span class="t">I'm smoking</span></button>
      </div>
      <div class="mode-note">${isSmoking ? 'Each night goes to press as smoked until you check the other box. The paper will not editorialize.' : 'Check one. Tonight is marked accordingly. Yesterday is not your business anymore.'}</div>
    </div>

    <div class="weekcol" style="padding-top:${v.blockTop}">
      <div class="week-head" style="border-top:${v.weekRule}">
        <span class="l">X-Effect Index · week ending today</span>
        <button class="redlink" data-act="tab" data-arg="calendar">Full table, p. 2 →</button>
      </div>
      <div class="cells">${week.join('')}</div>
    </div>

    ${marketPage(st, v)}

    <div class="classcol" style="margin-top:${v.blockTop};border-left:${v.sideRule};padding-left:${v.sidePad};font-size:${v.smallFs}">
      ${fp.classifieds.map((a) => `<p><b>${esc(a.head)}</b> — ${esc(a.body)}</p>`).join('')}
    </div>

    <div class="ghostcol" style="margin-top:${v.blockTop};border-right:${v.sideRule};padding-right:${v.sidePad}">
      <div class="ghost-head" style="font-size:${v.ghostHeadFs}">${esc(fp.ghostHead)}</div>
      <p style="font-size:${v.storyFs}">${esc(fp.ghostStory)}</p>
    </div>

    <div class="latecol" style="margin-top:${v.blockTop};border-left:${v.sideRule};padding-left:${v.sidePad}">
      <button class="late" data-act="edit" data-arg="${st.today}">
        <span class="n">${todayClean ? `Late report · costs ${esc(dailyStr(st.daily_cents))}, nothing else` : `Late report · puts ${esc(dailyStr(st.daily_cents))} back`}</span>
        <span class="c">${todayClean ? 'I smoked today' : 'Today was clean'}</span>
      </button>
    </div>
  </section>`;
}

// ---------- The Market Page ----------
// Written each weekday morning by the daily job. Opening the app never
// writes one: without today's, yesterday's runs as a late edition.
const RUNG_LABEL = { index: 'The Index', sector: 'The Sector', name: 'The Name' };
function marketPage(st, v) {
  const ed = st.editions?.today || st.editions?.previous;
  if (!ed) return '';
  const c = ed.content;
  const late = !st.editions.today;
  const kicker = !late
    ? 'The Market Page · Morning edition'
    : `Late edition · ${ed.day === addDays(st.today, -1) ? 'yesterday' : WDN[parseDay(ed.day).getDay()]}'s page`;
  const tier = st.unlocked_tiers.length ? Math.min(...st.unlocked_tiers) : null;
  const rungs = ['index', 'sector', 'name']
    .map((r) => {
      const pk = c.rungs[r];
      return `<div class="rung">
        <div class="rl">${RUNG_LABEL[r]}</div>
        <div class="rt">${esc(pk.symbol)}</div>
        <div class="rn">${esc(pk.name)}</div>
        <p class="note">${esc(pk.note)}</p>
        ${tier
          ? `<button class="btn-outline" data-act="queueRung" data-arg="${esc(pk.symbol)}" data-name="${esc(pk.name)}">Queue ${whole(tier)}</button>`
          : '<button class="btn-outline" disabled>Bank more</button>'}
      </div>`;
    })
    .join('');
  return `<div class="marketcol" style="margin-top:${v.blockTop}">
    <div class="mp-kicker">${esc(kicker)}</div>
    <h2 class="mp-head" style="font-size:${v.ghostHeadFs}">${esc(c.headline)}</h2>
    <p class="mp-deck">${esc(c.deck)}</p>
    <div class="mp-report" style="font-size:${v.storyFs};column-count:${v.three ? 2 : 1}">${c.report.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
    <div class="rungs" style="grid-template-columns:${v.wide ? 'repeat(3, minmax(0, 1fr))' : 'minmax(0, 1fr)'}">${rungs}</div>
    ${c.closing_note ? `<p class="mp-close">${esc(c.closing_note)}</p>` : ''}
    <p class="mp-rule">${esc(st.editions.standing_rule)}</p>
  </div>`;
}

// ---------- Calendar ----------
function screenCalendar(st, v) {
  const quit = st.settings.quit_date;
  const t = parseDay(st.today);
  const q = parseDay(quit);
  const mo = S.month || { y: t.getFullYear(), m: t.getMonth() };
  const cells = [];
  const firstDow = new Date(mo.y, mo.m, 1).getDay();
  for (let i = 0; i < firstDow; i++) cells.push(dayCell(null, '', { month: true }));
  const dim = new Date(mo.y, mo.m + 1, 0).getDate();
  for (let d = 1; d <= dim; d++) {
    const key = `${mo.y}-${String(mo.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push(dayCell(key, String(d), { month: true }));
  }
  while (cells.length % 7) cells.push(dayCell(null, '', { month: true }));
  const idx = mo.y * 12 + mo.m;
  const noPrev = idx <= q.getFullYear() * 12 + q.getMonth();
  const noNext = idx >= t.getFullYear() * 12 + t.getMonth();
  const amount = (d) => d.cents ?? st.daily_cents;
  const clean = st.days.filter((d) => d.state === 'clean');
  const smoked = st.days.filter((d) => d.state === 'smoked');
  const total = st.days.reduce((a, d) => a + amount(d), 0);
  const D = dailyStr(st.daily_cents);
  const keyBox = (inner, extra = '') => `<span class="sym" style="${extra}">${inner}</span>`;
  return `<section class="cal" data-screen-label="Calendar" style="grid-template-columns:${v.calCols};gap:22px ${v.colGap}">
    <div>
      <div class="month-head">
        <button class="monthnav" data-act="month" data-arg="-1" ${noPrev ? 'disabled' : ''} aria-label="Previous month">‹</button>
        <div class="month-label">${MONTHS[mo.m]} ${mo.y}</div>
        <button class="monthnav" data-act="month" data-arg="1" ${noNext ? 'disabled' : ''} aria-label="Next month">›</button>
      </div>
      <div class="wd">${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((w) => `<div>${w}</div>`).join('')}</div>
      <div class="cells">${cells.join('')}</div>
      <p class="cal-hint">${st.day_count > 1 ? `Quit ${ap(quit)}. The shaded cells were before our time.` : 'Day one. The shaded cells were before our time.'}</p>
    </div>

    <div class="side" style="border-left:${v.sideRule};padding-left:${v.sidePad}">
      <div>
        <div class="lbl">Box score</div>
        <div class="score">
          <div><div class="k">Clean days</div><div class="n" style="color:#C0321F">${clean.length}</div><div class="m">${fmt(clean.reduce((a, d) => a + amount(d), 0))} to the bank</div></div>
          <div><div class="k">Smoked days</div><div class="n">${smoked.length}</div><div class="m" style="color:#7A7266">${fmt(smoked.reduce((a, d) => a + amount(d), 0))} to the ghost</div></div>
        </div>
        <div class="score-total"><span>Total, ${st.days.length} × ${esc(D)}</span><b class="nums">${fmt(total)}</b></div>
      </div>
      <div>
        <div class="lbl">Key to symbols</div>
        <div class="key">
          <div>${keyBox(markSvg('clean', 20))}Clean. Its ${esc(D)} is in the bank.</div>
          <div>${keyBox(markSvg('smoked', 20))}Smoked. Its ${esc(D)} is could-have-been.</div>
          <div>${keyBox(markSvg('pending', 20, { fg: '#EFE4CB' }), 'background:#1B1712')}Today. Pencilled in; goes to press at midnight.</div>
          <div>${keyBox(markSvg('future', 20))}Not yet printed.</div>
          <div>${keyBox(markSvg('clean', 20), 'border:0;box-shadow:inset 0 0 0 3px #C0321F')}Under correction.</div>
        </div>
      </div>
      <div class="notice">
        <div class="t">Notice to readers</div>
        <p class="body13">Tap any past day to print a correction. Money follows the mark, so the bank and the ghost always add up to ${fmt(total)}. Days before the quit date were before our time.</p>
      </div>
    </div>
  </section>`;
}

// ---------- Trade ----------
function countdown(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'due now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}
const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function screenTrade(st, v) {
  const f = S.trade;
  if (f.tier && !st.unlocked_tiers.includes(f.tier)) f.tier = null;
  const offline = st.broker_mode === 'offline';
  const ready = f.tier && f.symbol && !offline;
  const cta = !st.unlocked_tiers.length ? 'Bank more to unlock a trade' : !f.tier ? 'Pick a size above' : !f.symbol ? 'Pick a stock' : `Queue ${fmt(f.tier)} of ${f.symbol}`;
  const s = st.settings;
  const tiers = s.tiers_cents
    .map((t) => {
      const open = st.unlocked_tiers.includes(t);
      const on = f.tier === t;
      return `<button class="tier" role="radio" aria-checked="${on}" data-act="tier" data-arg="${t}" ${open ? '' : 'disabled'}>
        <span class="box18">${on ? '✕' : ''}</span><span class="a">${whole(t)}</span><span class="s">${open ? 'Unlocked' : `${whole(t - st.bank_cents)} to go`}</span></button>`;
    })
    .join('');
  // Each position against the mattress: the bank earns nothing, so the gain
  // on what the bank paid is the upside over straight saving.
  const positions = st.positions
    .map((p) => {
      const g = p.gain_cents ?? p.value_cents - p.cost_cents;
      const unlock = localDayOf(p.sell_unlocks_at);
      const held = p.days_held == null ? '' : p.days_held === 0 ? ', bought today' : `, held ${p.days_held} ${plural(p.days_held, 'day', 'days')}`;
      const vs = p.priced === false
        ? `No price yet, shown at what the bank paid${held}`
        : `<b style="color:${gainColor(g)}">${g > 0 ? '▲ ' : g < 0 ? '▼ ' : ''}${pct(p.cost_cents ? Math.abs(g) / p.cost_cents : 0).replace('+', '')}</b> · ${g === 0 ? 'even with keeping it in the bank' : `${fmt(Math.abs(g))} ${g > 0 ? 'ahead of' : 'behind'} keeping it in the bank`}${held}`;
      return `<span class="sym">${esc(p.symbol)}</span><span class="q">${Number(p.qty).toFixed(4)} sh</span><span class="v">${fmt(p.value_cents)}</span>
        <span class="g">${vs}</span>
        ${p.sellable ? `<button class="sell" data-act="sell" data-arg="${esc(p.symbol)}">Sell all</button>` : `<span class="lock">Locked till ${ap(unlock)}</span>`}
        <span class="sep"></span>`;
    })
    .join('');
  const queue = st.queue
    .map(
      (t) => `<li><div><div><span class="side-tag ${t.side}">${t.side}</span> <b>${esc(t.symbol)}</b> <span class="nums">${t.side === 'buy' ? fmt(t.notional_cents) : `all, about ${fmt(t.notional_cents || 0)}`}</span></div>
        <div class="w">${t.status === 'queued' ? `Sends <span data-count="${esc(t.execute_after)}">${countdown(t.execute_after)}</span>` : 'At Alpaca, waiting to fill'}</div></div>
        ${t.status === 'queued' ? `<button class="btn-outline" data-act="cancel" data-arg="${esc(t.id)}">Cancel</button>` : ''}</li>`,
    )
    .join('');
  const min = Math.min(...s.tiers_cents);
  const max = Math.max(...s.tiers_cents);
  return `<section class="trade" data-screen-label="Trade" style="grid-template-columns:${v.tradeCols};gap:22px ${v.colGap}">
    <div class="coupon">
      <div class="coupon-tab">✂ Order form</div>
      <div class="avail"><span>Available in the bank</span><b class="nums">${fmt(st.bank_cents)}</b></div>
      <div class="tiers" role="radiogroup" aria-label="Trade size">${tiers}</div>
      ${offline ? '<p class="body13" style="margin-top:14px">The desk has no broker line. Set the Alpaca keys on the server to trade.</p>' : `
      <div class="pick">
        <span>Stock or ETF</span>
        ${f.symbol
          ? `<div class="chosen"><span><b>${esc(f.symbol)}</b> <small>${esc(f.name)}</small></span><button class="redlink" data-act="unpick">Change</button></div>`
          : `<input class="inp" id="sym" placeholder="Ticker or name, like VTI or Apple" autocomplete="off" autocapitalize="characters" spellcheck="false"><ul class="results" id="results"></ul>`}
      </div>
      ${f.confirm
        ? `<div class="confirm"><p>Buy <b>${fmt(f.tier)}</b> of <b>${esc(f.symbol)}</b>. The bank pays now. It goes to Alpaca after <b>${when(new Date(Date.now() + s.cooldown_hours * 3600000))}</b>, and you can cancel until then.</p>
            <div class="two"><button class="btn-outline" data-act="back">Back</button><button class="btn-ink" data-act="queue" data-focus>Queue it</button></div></div>`
        : `<button class="btn-ink cta" data-act="confirm" ${ready ? '' : 'disabled'}>${esc(cta)}</button>`}`}
      <p class="fine">The bank pays now. Alpaca gets it in ${s.cooldown_hours} hours. Cancel any time before, no questions asked, because nobody's asking.</p>
      ${f.msg ? `<p class="msg${f.error ? ' error' : ''}" style="margin-top:6px;text-align:center">${esc(f.msg)}</p>` : ''}
    </div>

    <div>
      <div class="lbl">Positions · against the bank</div>
      ${st.positions.length ? `<div class="pos">${positions}</div>` : '<p class="body13" style="margin-top:10px">No positions. The first $20 opens the desk.</p>'}
      ${st.prices_stale && st.positions.length ? '<p class="fine" style="text-align:left">Prices unavailable; shown at cost.</p>' : ''}
    </div>

    <div style="display:grid;gap:18px">
      <div>
        <div class="lbl">Queue</div>
        ${st.queue_error ? `<p class="msg error" style="margin-top:8px">Could not reach Alpaca: ${esc(st.queue_error)}</p>` : ''}
        ${st.queue.length ? `<ul class="queue">${queue}</ul>` : '<p class="body13" style="margin-top:10px">Nothing queued. The desk is quiet. Someone is doing a crossword.</p>'}
      </div>
      <div class="rules">
        <div class="t">Rules of the desk</div>
        <div class="l">
          <div>1. Orders run ${whole(min)} to ${whole(max)}, unlocked as the bank grows.</div>
          <div>2. Every order waits ${s.cooldown_hours} hours. Cravings rarely do.</div>
          <div>3. Positions hold ${s.hold_days} days before they can be sold.</div>
          <div>4. A sell sells the whole position. Proceeds go to the bank.</div>
        </div>
      </div>
    </div>
  </section>`;
}

// ---------- Ledgers ----------
const STATUS = { queued: 'Queued', submitted: 'At Alpaca', filled: 'Filled', cancelled: 'Cancelled', rejected: 'Rejected' };

function screenLedgers(st, v) {
  const { yours, ghost, lots, bench } = money(st);
  const h = S.history;
  const rows = h ? [...h.days].reverse().slice(0, v.wide ? 14 : 10) : [];
  const trades = h ? h.trades : [];
  return `<section class="ledgers" data-screen-label="Ledgers">
    <div class="figs">
      <div class="fig"><div class="k"><i style="border-color:#22335E"></i>Burned</div><div class="v" style="color:#22335E">−${fmt(st.burned_cents)}</div><div class="s">had you kept at it</div></div>
      <div class="fig"><div class="k"><i style="border-color:#C0321F"></i>Yours</div><div class="v" style="color:#C0321F">${fmt(yours)}</div><div class="s">bank ${fmt(st.bank_cents)} · stocks ${fmt(st.portfolio_cents)}${st.queued_cents ? ` · queued ${fmt(st.queued_cents)}` : ''}</div></div>
      <div class="fig"><div class="k"><i style="border-color:#7A7266;border-top-style:dashed"></i>Could-have-been</div><div class="v" style="color:#7A7266">${fmt(ghost)}</div><div class="s">${lots ? `${lots} smoked ${plural(lots, 'day', 'days')}, in ${esc(bench)}` : 'nothing smoked, nothing lost'}</div>${lots ? `<div class="s" style="font-style:normal;color:#5E554A">${fmt(yours + ghost)} had every day been clean</div>` : ''}</div>
      ${tradingFig(st)}
    </div>

    <div class="figbox">
      <div class="t">Fig. 1 · The three sums, daily, since the quit date</div>
      <div class="chart" id="chart">${h ? '' : '<p class="body13">Setting the figure…</p>'}</div>
      ${lots === 0 ? '<p class="nog">The ghost line lies on top of yours. Nothing smoked, nothing to haunt.</p>' : ''}
    </div>

    <div class="lower" style="grid-template-columns:${v.ledgerCols};gap:22px ${v.colGap}">
      <div>
        <div class="lbl">Daily values</div>
        <div class="daily">
          <span class="h">Day</span><span class="h r" style="color:#22335E">Burned</span><span class="h r" style="color:#C0321F">Yours</span><span class="h r" style="color:#7A7266">Ghost</span>
          ${rows
            .map((r) => {
              const isToday = r.day === st.today;
              const mk = r.state === 'smoked' ? '<circle cx="12" cy="12" r="8" fill="#1B1712"/>' : '<path d="M5 5L19 19M19 5L5 19" stroke="#C0321F" stroke-width="3.6" stroke-linecap="round" fill="none"/>';
              return `<span class="dl"><svg width="12" height="12" viewBox="0 0 24 24" aria-label="${r.state}" style="flex:none">${mk}</svg>${isToday ? 'Today' : `${wd3(r.day)}. ${ap(r.day)}`}</span>
                <span class="r" style="color:#22335E">${fmt(-r.burned_cents)}</span><span class="r">${r.yours_cents == null ? '–' : fmt(r.yours_cents)}</span><span class="r" style="color:#7A7266">${fmt(r.ghost_cents)}</span>`;
            })
            .join('')}
        </div>
      </div>
      <div>
        <div class="lbl">Trade history</div>
        ${trades.length
          ? `<div class="hist">${trades
              .map((t) => {
                const filled = t.fill_qty && t.fill_price ? Math.round(Number(t.fill_qty) * Number(t.fill_price) * 100) : null;
                const amt = filled ?? t.notional_cents;
                return `<span>${ap(localDayOf(t.created_at))}</span><span><span class="side-tag ${t.side}">${t.side}</span> <b>${esc(t.symbol)}</b></span>
                  <span class="r">${amt == null ? '–' : fmt(amt)}</span><span class="st ${t.status}"${t.reason ? ` title="${esc(t.reason)}"` : ''}>${STATUS[t.status]}</span>`;
              })
              .join('')}</div>`
          : '<p class="body13" style="margin-top:10px">No trades yet. The ledger is very tidy.</p>'}
      </div>
    </div>

    ${recordSection(h, v)}
  </section>`;
}

// What trading has added or cost against leaving every dollar in the bank.
function tradingFig(st) {
  const t = st.trading;
  if (!t) return '';
  if (!t.bought_cents) {
    return `<div class="fig"><div class="k">Trading, net</div><div class="v">$0.00</div><div class="s">nothing traded, so even with the bank</div></div>`;
  }
  const plain = 'font-style:normal;color:#5E554A';
  return `<div class="fig"><div class="k">Trading, net</div><div class="v" style="color:${gainColor(t.net_cents)}">${sfmt(t.net_cents)}</div>
    <div class="s">against keeping it in the bank</div>
    <div class="s" style="${plain}"><b style="color:${gainColor(t.net_cents)}">${pct(t.net_cents / t.bought_cents)}</b> on ${fmt(t.bought_cents)} bought</div>
    <div class="s" style="${plain}">held ${sfmt(t.unrealized_cents)}${t.sells ? ` · sold ${sfmt(t.realized_cents)}` : ''}</div>
    ${st.prices_stale && st.positions.length ? `<div class="s" style="${plain}">No prices; held at cost.</div>` : ''}</div>`;
}

// ---------- The paper's own record ----------
// What the Market Page printed, scored. Kept apart from what you bought.
const RECORD = [
  { key: 'index', name: 'The Index', color: '#1B1712', w: 2.4 },
  { key: 'sector', name: 'The Sector', color: '#B8923F', w: 2 },
  { key: 'name', name: 'The Name', color: '#22335E', w: 2 },
];
const MATTRESS = { key: 'mattress', name: 'The Mattress', color: '#A69C8C', w: 1.6, dash: true };
const RUNG_WORD = { index: 'the index', sector: 'the sector', name: 'the name' };

function recordSection(h, v) {
  const head = (since) => `<div class="lbl-row"><span class="lbl">The Market Page · its own record</span>${since ? `<span class="rec-since">Since ${ap(since)}</span>` : ''}</div>`;
  if (!h) return '';
  const r = h.record;
  if (!r || !r.editions) {
    return `<div class="record">${head()}<p class="body13" style="margin-top:10px">The paper keeps score on its own picks, $20 a rung at the day's close, from its first edition. It has not printed one yet.</p></div>`;
  }
  const rows = [...RECORD.map((x) => ({ ...x, ...r.rungs[x.key] })), { ...MATTRESS, ...r.mattress }]
    .map(
      (x) => `<span class="rn"><i class="lk${x.dash ? ' dash' : ''}" style="border-color:${x.color}"></i>${x.name}</span>
        <span class="r ret" style="color:${x.key === 'mattress' ? '#1B1712' : gainColor(x.pct)}">${pct(x.pct)}</span>
        <span class="r">${x.picks}</span><span class="r">${whole(x.in_cents)}</span><span class="r">${x.picks ? fmt(x.now_cents) : '–'}</span>`,
    )
    .join('');
  const move = (x) => (Math.round(x * 10000) === 0 ? 'flat' : `${x > 0 ? 'up' : 'down'} ${pct(Math.abs(x)).replace('+', '')}`);
  const pick = (b) => `${esc(b.symbol)}, ${RUNG_WORD[b.rung]} on ${ap(b.day)}, ${move(b.pct)}`;
  const deck = `<p class="rec-deck">Every Market Page prints three rungs. This is $20 in each, at the close of the day it ran, against the same $20 kept in the bank. The paper's picks, not your trades.</p>`;
  if (!r.mattress.picks) {
    return `<div class="record">${head(r.since)}${deck}<p class="bw" style="margin:0">The first picks await a closing price.</p></div>`;
  }
  return `<div class="record">
    ${head(r.since)}
    ${deck}
    <div class="lower" style="grid-template-columns:${v.ledgerCols};gap:18px ${v.colGap}">
      <div class="figbox">
        <div class="t">Fig. 2 · Return on the paper's picks, by rung</div>
        <div class="chart" id="rchart"></div>
        <div class="rkey">${[...RECORD, MATTRESS].map((x) => `<span><i class="lk${x.dash ? ' dash' : ''}" style="border-color:${x.color}"></i>${x.name}</span>`).join('')}</div>
      </div>
      <div>
        <div class="lbl">Box score${r.as_of ? ` · at the ${ap(r.as_of)} close` : ''}</div>
        <div class="box">
          <span class="h">Rung</span><span class="h r">Return</span><span class="h r">Picks</span><span class="h r">In</span><span class="h r">Now</span>
          ${rows}
        </div>
        ${r.best ? `<p class="bw">Best pick: ${pick(r.best)}.${r.worst ? ` Worst: ${pick(r.worst)}.` : ''}</p>` : ''}
        ${r.pending ? `<p class="bw">${r.pending === 1 ? 'The latest edition’s three await' : `The last ${numberWord(r.pending)} editions await`} a closing price.</p>` : ''}
      </div>
    </div>
  </div>`;
}

function drawRecordChart(box) {
  const r = S.history?.record;
  if (!r || !r.days.length || !r.mattress.picks) return;
  const days = r.days;
  const n = days.length;
  const last = n - 1;
  const W = Math.max(300, box.clientWidth);
  const H = V().wide ? 240 : 200;
  const m = { l: 56, r: 12, t: 14, b: 22 };
  const series = [...RECORD.map((x) => ({ ...x, vals: days.map((d) => d[x.key]) })), { ...MATTRESS, vals: days.map(() => 0) }];
  const all = series.flatMap((x) => x.vals).filter((x) => x != null);
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  // At least a percentage point of range, so a quiet week reads as quiet.
  if (hi - lo < 0.01) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.005;
    hi = mid + 0.005;
  }
  const nice = (span) => {
    const raw = span / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const q = raw / mag;
    return (q <= 1 ? 1 : q <= 2 ? 2 : q <= 2.5 ? 2.5 : q <= 5 ? 5 : 10) * mag;
  };
  const step = nice(hi - lo);
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const dp = step * 100 >= 1 ? 0 : step * 100 >= 0.1 ? 1 : 2;
  const x = (i) => m.l + (n === 1 ? (W - m.l - m.r) / 2 : (i / (n - 1)) * (W - m.l - m.r));
  const y = (val) => m.t + ((hi - val) / (hi - lo)) * (H - m.t - m.b);
  const grid = [];
  for (let val = lo; val <= hi + step / 1e6; val += step) grid.push(Math.abs(val) < step / 1e6 ? 0 : val);
  // Skips days before a rung's first priced pick.
  const line = (arr) => {
    let out = '';
    let pen = false;
    arr.forEach((val, i) => {
      if (val == null) return (pen = false);
      out += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`;
      pen = true;
    });
    return out;
  };
  const xi = n === 1 ? [0] : [...new Set([0, Math.floor(last / 2), last])];
  const today = S.state.today;
  const dayName = (i) => (days[i].day === today ? 'TODAY' : ap(days[i].day).toUpperCase());
  const lastOf = (x) => x.vals[last];
  const drawn = [...series].reverse(); // the index on top

  box.innerHTML = `
    ${grid.map((val) => `<span class="yl" style="top:${(y(val) - 5).toFixed(1)}px">${val === 0 ? '0%' : pct(val, dp)}</span>`).join('')}
    ${xi.map((i) => `<span class="xl" style="left:${x(i).toFixed(1)}px;transform:${n === 1 ? 'translateX(-50%)' : i === 0 ? 'none' : i === last ? 'translateX(-100%)' : 'translateX(-50%)'}">${dayName(i)}</span>`).join('')}
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="Return on the paper's picks by rung since ${ap(days[0].day)}. ${series.map((s) => `${s.name} ${pct(lastOf(s))}`).join(', ')}. Use arrow keys to read each day.">
      ${grid.map((val) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(val).toFixed(1)}" y2="${y(val).toFixed(1)}" stroke="#D6C8A6" stroke-width="1"/>`).join('')}
      ${drawn.map((s) => `<path d="${line(s.vals)}" fill="none" stroke="${s.color}" stroke-width="${s.w}"${s.dash ? ' stroke-dasharray="4 4"' : ''} stroke-linejoin="round"/>`).join('')}
      ${drawn.filter((s) => lastOf(s) != null).map((s) => `<circle cx="${x(last).toFixed(1)}" cy="${y(lastOf(s)).toFixed(1)}" r="${s.dash ? 3 : 4}" fill="${s.color}"/>`).join('')}
      <g class="cross" display="none">
        <line class="cl" y1="${m.t}" y2="${H - m.b}" stroke="#5E554A" stroke-width="1"/>
        ${drawn.map((s) => `<circle class="c-${s.key}" r="4" fill="${s.color}" stroke="#EFE4CB" stroke-width="2"/>`).join('')}
      </g>
      <rect class="hit" x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}"/>
    </svg>
    <div class="tip" hidden></div>`;
  wireChart(box, { n, W, x, label: (i) => (days[i].day === today ? 'Today' : `${wd3(days[i].day)}. ${ap(days[i].day)}`), points: (i) => series.map((s) => ({ sel: `.c-${s.key}`, y: s.vals[i] == null ? null : y(s.vals[i]) })), rows: (i) => series.map((s) => ({ label: s.name, value: pct(s.vals[i]), color: s.color, dash: s.dash })), m });
}

// Crosshair, tooltip, and arrow keys for a day-by-day chart.
function wireChart(box, { n, W, x, m, label, points, rows }) {
  const last = n - 1;
  const svg = box.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const tip = box.querySelector('.tip');
  let idx = last;
  function show(i) {
    idx = Math.max(0, Math.min(last, i));
    const cx = x(idx);
    cross.setAttribute('display', 'inline');
    const cl = cross.querySelector('.cl');
    cl.setAttribute('x1', cx);
    cl.setAttribute('x2', cx);
    for (const p of points(idx)) {
      const c = cross.querySelector(p.sel);
      c.setAttribute('display', p.y == null ? 'none' : 'inline');
      if (p.y != null) {
        c.setAttribute('cx', cx);
        c.setAttribute('cy', p.y);
      }
    }
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'h';
    head.textContent = label(idx);
    tip.append(head);
    for (const r of rows(idx)) {
      const row = document.createElement('div');
      row.className = 'r';
      const key = document.createElement('i');
      key.className = `lk${r.dash ? ' dash' : ''}`;
      key.style.borderColor = r.color;
      const b = document.createElement('b');
      b.textContent = r.value;
      const name = document.createElement('span');
      name.textContent = r.label;
      row.append(key, b, name);
      tip.append(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = cx + 12 + tw <= W ? cx + 12 : cx - 12 - tw;
    tip.style.left = `${Math.max(0, left)}px`;
  }
  function hide() {
    cross.setAttribute('display', 'none');
    tip.hidden = true;
  }
  const pick = (e) => {
    const rect = svg.getBoundingClientRect();
    return n === 1 ? 0 : Math.round(((e.clientX - rect.left - m.l) / (W - m.l - m.r)) * last);
  };
  svg.addEventListener('pointermove', (e) => show(pick(e)));
  svg.addEventListener('pointerdown', (e) => show(pick(e)));
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(idx));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: idx - 1, ArrowRight: idx + 1, Home: 0, End: last }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    show(k);
  });
}

function drawChart(box) {
  const h = S.history;
  if (!h || !h.days.length) return;
  const days = h.days;
  const n = days.length;
  const last = n - 1;
  const W = Math.max(300, box.clientWidth);
  const H = V().wide ? 300 : 220;
  const m = { l: 56, r: 12, t: 14, b: 22 };
  const burned = days.map((d) => -d.burned_cents);
  const yours = days.map((d) => d.yours_cents ?? 0);
  const ghost = days.map((d) => d.ghost_cents ?? 0);
  // Stacked on Yours: the dashed line is what Yours would be had every
  // smoked day been clean. The gap between the two is the ghost.
  const stacked = yours.map((v, i) => v + ghost[i]);
  const vals = [...burned, ...stacked, 0];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1000) hi = lo + 1000;
  const nice = (r) => {
    const raw = r / 5;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const q = raw / mag;
    return (q <= 1 ? 1 : q <= 2 ? 2 : q <= 2.5 ? 2.5 : q <= 5 ? 5 : 10) * mag;
  };
  const step = nice(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const x = (i) => m.l + (n === 1 ? (W - m.l - m.r) / 2 : (i / (n - 1)) * (W - m.l - m.r));
  const y = (val) => m.t + ((hi - val) / (hi - lo)) * (H - m.t - m.b);
  const grid = [];
  for (let val = lo; val <= hi + 1e-9; val += step) grid.push(val);
  const label = (val) => (val === 0 ? '$0' : `${val < 0 ? '−' : ''}$${Math.abs(val / 100).toLocaleString('en-US')}`);
  const line = (arr) => arr.map((val, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join('');
  const area = (arr) => (n < 2 ? '' : `M${x(0).toFixed(1)},${y(0).toFixed(1)}` + arr.map((val, i) => `L${x(i).toFixed(1)},${y(val).toFixed(1)}`).join('') + `L${x(last).toFixed(1)},${y(0).toFixed(1)}Z`);
  // The region between two series, lower drawn back to front.
  const band = (lo, hi) => (n < 2 ? '' : hi.map((val, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join('') + [...lo.keys()].reverse().map((i) => `L${x(i).toFixed(1)},${y(lo[i]).toFixed(1)}`).join('') + 'Z');
  const xi = n === 1 ? [0] : [...new Set([0, Math.floor(last / 2), last])];
  const today = S.state.today;
  const dayName = (i) => (days[i].day === today ? 'TODAY' : ap(days[i].day).toUpperCase());

  box.innerHTML = `
    ${grid.map((val) => `<span class="yl" style="top:${(y(val) - 5).toFixed(1)}px">${label(val)}</span>`).join('')}
    ${xi.map((i) => `<span class="xl" style="left:${x(i).toFixed(1)}px;transform:${n === 1 ? 'translateX(-50%)' : i === 0 ? 'none' : i === last ? 'translateX(-100%)' : 'translateX(-50%)'}">${dayName(i)}</span>`).join('')}
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="Burned, yours, and yours had every day been clean, over ${n} ${plural(n, 'day', 'days')}. Burned ${fmt(burned[last])}, yours ${fmt(yours[last])}, had every day been clean ${fmt(stacked[last])}. Use arrow keys to read each day.">
      ${grid.map((val) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(val).toFixed(1)}" y2="${y(val).toFixed(1)}" stroke="${val === 0 ? '#1B1712' : '#D6C8A6'}" stroke-width="${val === 0 ? 1.2 : 1}"/>`).join('')}
      <path d="${area(burned)}" fill="#22335E" opacity=".08"/>
      <path d="${area(yours)}" fill="#C0321F" opacity=".1"/>
      <path d="${line(burned)}" fill="none" stroke="#22335E" stroke-width="2" stroke-linejoin="round"/>
      <path d="${band(yours, stacked)}" fill="#7A7266" opacity=".12"/>
      <path d="${line(stacked)}" fill="none" stroke="#7A7266" stroke-width="2" stroke-dasharray="4 4" stroke-linejoin="round"/>
      <path d="${line(yours)}" fill="none" stroke="#C0321F" stroke-width="2.4" stroke-linejoin="round"/>
      <circle cx="${x(last).toFixed(1)}" cy="${y(burned[last]).toFixed(1)}" r="4" fill="#22335E"/>
      <circle cx="${x(last).toFixed(1)}" cy="${y(stacked[last]).toFixed(1)}" r="4" fill="#7A7266"/>
      <circle cx="${x(last).toFixed(1)}" cy="${y(yours[last]).toFixed(1)}" r="4.5" fill="#C0321F"/>
      <g class="cross" display="none">
        <line class="cl" y1="${m.t}" y2="${H - m.b}" stroke="#5E554A" stroke-width="1"/>
        <circle class="cb" r="4" fill="#22335E" stroke="#EFE4CB" stroke-width="2"/>
        <circle class="cg" r="4" fill="#7A7266" stroke="#EFE4CB" stroke-width="2"/>
        <circle class="cy" r="4.5" fill="#C0321F" stroke="#EFE4CB" stroke-width="2"/>
      </g>
      <rect class="hit" x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}"/>
    </svg>
    <div class="tip" hidden></div>`;

  const svg = box.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const tip = box.querySelector('.tip');
  let idx = last;
  const set = (sel, attr, val) => cross.querySelector(sel).setAttribute(attr, val);
  function show(i) {
    idx = Math.max(0, Math.min(last, i));
    const cx = x(idx);
    cross.setAttribute('display', 'inline');
    set('.cl', 'x1', cx);
    set('.cl', 'x2', cx);
    for (const [sel, arr] of [['.cb', burned], ['.cg', stacked], ['.cy', yours]]) {
      set(sel, 'cx', cx);
      set(sel, 'cy', y(arr[idx]));
    }
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'h';
    head.textContent = days[idx].day === today ? 'Today' : `${wd3(days[idx].day)}. ${ap(days[idx].day)}`;
    tip.append(head);
    for (const [label, val, color, dash] of [['Had every day been clean', stacked[idx], '#7A7266', true], ['Yours', yours[idx], '#C0321F', false], ['of it could-have-been', ghost[idx], '#7A7266', true], ['Burned', burned[idx], '#22335E', false]]) {
      if (label.startsWith('of it') && !ghost[idx]) continue;
      const row = document.createElement('div');
      row.className = 'r';
      const key = document.createElement('i');
      key.className = `lk${dash ? ' dash' : ''}`;
      key.style.borderColor = color;
      const b = document.createElement('b');
      b.textContent = fmt(val);
      const name = document.createElement('span');
      name.textContent = label;
      row.append(key, b, name);
      tip.append(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = cx + 12 + tw <= W ? cx + 12 : cx - 12 - tw;
    tip.style.left = `${Math.max(0, left)}px`;
  }
  function hide() {
    cross.setAttribute('display', 'none');
    tip.hidden = true;
  }
  const pick = (e) => {
    const r = svg.getBoundingClientRect();
    return n === 1 ? 0 : Math.round(((e.clientX - r.left - m.l) / (W - m.l - m.r)) * last);
  };
  svg.addEventListener('pointermove', (e) => show(pick(e)));
  svg.addEventListener('pointerdown', (e) => show(pick(e)));
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(idx));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: idx - 1, ArrowRight: idx + 1, Home: 0, End: last }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    show(k);
  });
}

// ---------- Settings ----------
const dollars = (c) => (c / 100).toFixed(2);
const toCents = (val) => Math.round(Number(val) * 100);

function screenSettings(st, v) {
  const s = st.settings;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [s.timezone];
  const brokerLine = { paper: 'Paper trading. Pretend money, real feelings.', live: 'Live trading. Real money, real feelings.', offline: 'Not connected. No keys, no feelings.' }[st.broker_mode];
  return `<form id="settings" class="settings" data-screen-label="Settings" novalidate style="grid-template-columns:${v.tradeCols};gap:26px ${v.colGap}">
    <div class="col">
      <div class="lbl">The habit</div>
      <label class="field"><span>Quit date</span><input class="inp" type="date" name="quit_date" value="${esc(s.quit_date)}" max="${esc(st.today)}"></label>
      <div class="pair">
        <label class="field"><span>Pack price ($)</span><input class="inp" name="pack_price_cents" inputmode="decimal" value="${dollars(s.pack_price_cents)}"></label>
        <label class="field"><span>Packs per day</span><input class="inp" name="packs_per_day" inputmode="decimal" value="${s.packs_per_day}"></label>
      </div>
      <div class="worth"><span>A day is worth</span><b id="worth">${fmt(s.daily_cents)}</b></div>
      <label class="field"><span>Timezone</span><input class="inp" name="timezone" list="zones" value="${esc(s.timezone)}" autocomplete="off" spellcheck="false"></label>
      <datalist id="zones">${zones.map((z) => `<option value="${esc(z)}">`).join('')}</datalist>
    </div>
    <div class="col">
      <div class="lbl-row"><span class="lbl">The ghost</span><span class="tag-new">New</span></div>
      <label class="field"><span>Ghost benchmark (ticker)</span><input class="inp" name="ghost_benchmark" value="${esc(s.ghost_benchmark)}" autocapitalize="characters" spellcheck="false" style="letter-spacing:.06em"></label>
      <p class="body13">Each smoked day's ${esc(dailyStr(st.daily_cents))} is bought at that day's close, as if you'd saved it. Change the ticker and the whole ghost is redrawn, retroactively, like a good biography.</p>
      <div class="lbl" style="margin-top:8px">Broker</div>
      <div class="broker"><span>Alpaca</span><span>${brokerLine}</span></div>
      <div class="lbl" style="margin-top:8px">The Market Page</div>
      <label class="field"><span>Universe · one per line: ticker, rung, name</span>
        <textarea class="inp area" name="market_universe" rows="9" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(universeText(s.market_universe))}</textarea></label>
      <p class="body13">The only tickers the paper may print. Rungs are index, sector, and name, at least one of each.</p>
    </div>
    <div class="col">
      <div class="lbl">Trading rules</div>
      <label class="field"><span>Trade tiers ($20 to $200)</span><input class="inp" name="tiers_cents" value="${s.tiers_cents.map((t) => (t / 100).toFixed(0)).join(', ')}"></label>
      <div class="pair">
        <label class="field"><span>Cooldown (hrs, 24+)</span><input class="inp" name="cooldown_hours" inputmode="numeric" value="${s.cooldown_hours}"></label>
        <label class="field"><span>Hold (days, 7+)</span><input class="inp" name="hold_days" inputmode="numeric" value="${s.hold_days}"></label>
      </div>
      <p class="body13" style="font-style:italic;line-height:normal">Cooldown and hold can go up, never down. Editors are only human.</p>
      <button class="btn-ink save" type="submit">Send to press</button>
      ${S.settingsMsg ? `<p class="msg${S.settingsErr ? ' error' : ''}">${esc(S.settingsMsg)}</p>` : ''}
      ${S.config?.devFake ? '' : S.demo ? '<button class="btn-outline signout" type="button" data-act="signin">Sign in</button>' : '<button class="btn-outline signout" type="button" data-act="signout">Sign out</button>'}
    </div>
  </form>`;
}

const universeText = (list) => list.map((u) => `${u.symbol} ${u.rung} ${u.name}`).join('\n');
// "VOO index Vanguard S&P 500 ETF" per line. The server validates the rest.
function parseUniverse(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [symbol, rung = '', ...name] = l.split(/\s+/);
      return { symbol: symbol.toUpperCase(), rung: rung.toLowerCase(), name: name.join(' ') || symbol.toUpperCase() };
    });
}

async function saveSettings(form) {
  const s = S.state.settings;
  const val = Object.fromEntries(new FormData(form));
  const patch = {
    quit_date: val.quit_date,
    timezone: val.timezone.trim(),
    pack_price_cents: toCents(val.pack_price_cents),
    packs_per_day: Number(val.packs_per_day),
    ghost_benchmark: val.ghost_benchmark.trim().toUpperCase(),
    tiers_cents: val.tiers_cents.split(/[\s,$]+/).filter(Boolean).map(toCents),
    cooldown_hours: Number(val.cooldown_hours),
    hold_days: Number(val.hold_days),
    market_universe: parseUniverse(val.market_universe || ''),
  };
  for (const [k, x] of Object.entries(patch)) if (JSON.stringify(x) === JSON.stringify(s[k])) delete patch[k];
  if (!Object.keys(patch).length) {
    S.settingsMsg = 'Nothing changed. The presses rest.';
    S.settingsErr = false;
    return render();
  }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    await api('/api/settings', { method: 'PUT', body: patch });
    await refresh();
    S.history = null;
    S.settingsMsg = '';
    S.settingsErr = false;
    render();
    flash('Sent to press. Changes take effect with this edition.');
  } catch (err) {
    S.settingsMsg = err.message;
    S.settingsErr = true;
    render();
  }
}

// ---------- overlays ----------
function overlayHtml(st) {
  if (S.editDay) {
    const ed = st.days.find((d) => d.day === S.editDay);
    if (!ed) return '';
    const toSmoked = ed.state === 'clean';
    const isToday = ed.day === st.today;
    const amt = isToday ? st.daily_cents : ed.cents;
    const A = dailyStr(amt);
    const name = isToday ? 'Today' : ap(ed.day);
    const bank = st.bank_cents;
    const ghost = st.ghost.value_cents;
    const gv = ed.ghost_value_cents ?? amt;
    const bankTo = isToday ? bank : toSmoked ? bank - amt : bank + amt;
    const ghostTo = isToday ? ghost : toSmoked ? ghost + gv : ghost - gv;
    const note = isToday ? (toSmoked ? ` (+${A} to the ghost at midnight)` : ` (+${A} at midnight)`) : '';
    const c = isToday
      ? {
          kicker: 'Late report',
          title: toSmoked ? 'Today goes to press as smoked.' : 'Today goes to press as clean.',
          body: toSmoked ? `At midnight today’s ${A} goes to could-have-been instead of the bank. It’s the day, not a verdict.` : `At midnight today’s ${A} lands in the bank, where it belongs.`,
          cta: 'File report',
          cancel: 'Never mind',
        }
      : {
          kicker: 'Correction',
          title: toSmoked ? `${name} was smoked.` : `${name} was clean.`,
          body: toSmoked
            ? `An earlier edition reported ${name} as clean. It was smoked. ${A} moves from the bank to could-have-been. The Ciggy Bank regrets the error.`
            : `An earlier edition reported ${name} as smoked. It was clean. ${A} moves from could-have-been back to the bank. The Ciggy Bank is delighted by the error.`,
          cta: 'Print correction',
          cancel: 'Let it stand',
        };
    return `<div class="scrim" data-act="scrim">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="${c.kicker}">
        <div class="dlg-k"><span class="red">${c.kicker}</span><span>${WDN[parseDay(ed.day).getDay()]}, ${ap(ed.day)}</span></div>
        <h2>${esc(c.title)}</h2>
        <p class="b">${esc(c.body)}</p>
        <div class="dlg-money"><span>Bank <b>${fmt(bank)}</b> → <b>${fmt(bankTo)}${!toSmoked ? esc(note) : ''}</b></span><span class="g">Ghost ${fmt(ghost)} → ${fmt(ghostTo)}${toSmoked ? esc(note) : ''}</span></div>
        ${S.dialogErr ? `<p class="dlg-err">${esc(S.dialogErr)}</p>` : ''}
        <div class="dlg-btns"><button class="btn-outline" data-act="closeDialog" data-focus>${c.cancel}</button><button class="btn-ink" data-act="saveDay" ${S.busy ? 'disabled' : ''}>${c.cta}</button></div>
      </div></div>`;
  }
  if (S.confirmMode) {
    const cm = S.confirmMode;
    const A = dailyStr(st.daily_cents);
    return `<div class="scrim" data-act="scrim">
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Change of editorial position">
        <div class="dlg-k"><span class="red">Change of editorial position</span></div>
        <h2>${cm === 'smoking' ? 'I’m smoking.' : 'I quit.'}</h2>
        <p class="b">${
          cm === 'smoking'
            ? `From today, each day goes to press as smoked and its ${A} goes to could-have-been. The bank stops growing until you switch back.`
            : `From today, each day goes to press as clean and its ${A} lands in the bank at midnight.`
        }</p>
        <p class="i">Past days stand as printed. Correct them on the calendar.</p>
        ${S.dialogErr ? `<p class="dlg-err">${esc(S.dialogErr)}</p>` : ''}
        <div class="dlg-btns" style="margin-top:18px"><button class="btn-outline" data-act="closeDialog" data-focus>${cm === 'smoking' ? 'Keep I quit' : 'Keep as is'}</button><button class="btn-ink" data-act="saveMode" ${S.busy ? 'disabled' : ''}>Change position</button></div>
      </div></div>`;
  }
  return '';
}

function closeDialog() {
  S.editDay = null;
  S.confirmMode = null;
  S.dialogErr = '';
  S.busy = false;
  render();
}

// ---------- actions ----------
const ACT = {
  tab(el) {
    S.tab = el.dataset.arg;
    S.editDay = null;
    try {
      localStorage.setItem('ciggybank.v2.tab', S.tab);
    } catch {}
    window.scrollTo(0, 0);
    render();
    const tab = S.tab;
    const work = tab === 'ledgers' ? Promise.all([refresh(), refreshHistory()]) : refresh();
    work.then(() => S.tab === tab && !S.editDay && !S.confirmMode && render()).catch(() => {});
  },
  // A rung's button: the order form, prefilled with the smallest unlocked
  // tier and that ticker. Nothing is queued until the reader confirms.
  queueRung(el) {
    const tiers = S.state.unlocked_tiers;
    if (!tiers.length) return;
    S.trade = { ...S.trade, tier: Math.min(...tiers), symbol: el.dataset.arg, name: el.dataset.name || '', confirm: false, msg: '', error: false };
    ACT.tab({ dataset: { arg: 'trade' } });
  },
  edit(el) {
    S.editDay = el.dataset.arg;
    S.dialogErr = '';
    render();
  },
  mode(el) {
    if (el.dataset.arg === S.state.mode) return;
    S.confirmMode = el.dataset.arg;
    S.dialogErr = '';
    render();
  },
  scrim(el, e) {
    if (e.target === el) closeDialog();
  },
  closeDialog,
  async saveDay() {
    const st = S.state;
    const ed = st.days.find((d) => d.day === S.editDay);
    const next = ed.state === 'clean' ? 'smoked' : 'clean';
    const isToday = ed.day === st.today;
    const A = dailyStr(isToday ? st.daily_cents : ed.cents);
    const name = isToday ? 'Today' : ap(ed.day);
    S.busy = true;
    render();
    try {
      S.state = await api('/api/day', { method: 'PUT', body: { day: ed.day, state: next } });
      S.history = null;
      S.editDay = null;
      S.busy = false;
      render();
      if (S.tab === 'ledgers') refreshHistory().then(render).catch(() => {});
      flash(
        isToday
          ? next === 'smoked'
            ? `Today goes to press as smoked. ${A} to the ghost at midnight.`
            : `Today goes to press as clean. ${A} to the bank at midnight.`
          : next === 'smoked'
            ? `Correction printed. ${name}’s ${A} moved to could-have-been.`
            : `Correction printed. ${name}’s ${A} is back in the bank.`,
      );
    } catch (err) {
      S.busy = false;
      S.dialogErr = err.message;
      render();
    }
  },
  async saveMode() {
    const cm = S.confirmMode;
    S.busy = true;
    render();
    try {
      S.state = await api('/api/mode', { method: 'PUT', body: { mode: cm } });
      S.confirmMode = null;
      S.busy = false;
      render();
      flash(cm === 'smoking' ? 'Editorial position changed: I’m smoking. Today is pencilled as smoked.' : 'Editorial position changed: I quit. Today is pencilled as clean.');
    } catch (err) {
      S.busy = false;
      S.dialogErr = err.message;
      render();
    }
  },
  month(el) {
    const t = parseDay(S.state.today);
    const mo = S.month || { y: t.getFullYear(), m: t.getMonth() };
    const i = mo.y * 12 + mo.m + Number(el.dataset.arg);
    S.month = { y: Math.floor(i / 12), m: i % 12 };
    render();
  },
  tier(el) {
    Object.assign(S.trade, { tier: Number(el.dataset.arg), confirm: false, msg: '' });
    render();
  },
  unpick() {
    Object.assign(S.trade, { symbol: null, name: '', confirm: false, msg: '' });
    render();
    $app.querySelector('#sym')?.focus();
  },
  pickSym(el) {
    Object.assign(S.trade, { symbol: el.dataset.arg, name: el.dataset.name, msg: '' });
    render();
  },
  confirm() {
    S.trade.confirm = true;
    render();
  },
  back() {
    S.trade.confirm = false;
    render();
  },
  async queue(el) {
    const f = S.trade;
    el.disabled = true;
    try {
      const r = await api('/api/trade', { method: 'POST', body: { symbol: f.symbol, side: 'buy', notional_cents: f.tier } });
      Object.assign(f, { tier: null, symbol: null, name: '', confirm: false, msg: '', error: false });
      await refresh();
      render();
      flash(`Order queued. ${r.trade.symbol} goes to Alpaca ${countdown(r.trade.execute_after)}.`);
    } catch (err) {
      Object.assign(f, { confirm: false, msg: err.message, error: true });
      render();
    }
  },
  async cancel(el) {
    el.disabled = true;
    try {
      const r = await api('/api/trade/cancel', { method: 'POST', body: { id: el.dataset.arg } });
      await refresh();
      render();
      flash(r.trade.side === 'buy' ? `Order cancelled. ${fmt(r.trade.notional_cents)} is back in the bank.` : 'Sell cancelled. The position stays.');
    } catch (err) {
      Object.assign(S.trade, { msg: err.message, error: true });
      render();
    }
  },
  async sell(el) {
    if (!el.dataset.armed) {
      el.dataset.armed = '1';
      el.textContent = 'Tap again to sell';
      setTimeout(() => {
        if (el.isConnected) {
          delete el.dataset.armed;
          el.textContent = 'Sell all';
        }
      }, 3000);
      return;
    }
    el.disabled = true;
    try {
      const r = await api('/api/trade', { method: 'POST', body: { symbol: el.dataset.arg, side: 'sell' } });
      await refresh();
      render();
      flash(`Sell queued. It goes to Alpaca ${countdown(r.trade.execute_after)}. Proceeds go to the bank.`);
    } catch (err) {
      Object.assign(S.trade, { msg: err.message, error: true });
      render();
    }
  },
  signout: () => signOut(),
  signin: () => renderLogin(),
  demo: () => renderDemo(),
};

function bindEvents() {
  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled || !$app.contains(el)) return;
    const fn = ACT[el.dataset.act];
    if (fn) fn(el, e);
  });
  $app.addEventListener('submit', (e) => {
    if (e.target.id === 'settings') {
      e.preventDefault();
      saveSettings(e.target);
    }
  });
  let timer = null;
  let seq = 0;
  $app.addEventListener('input', (e) => {
    const t = e.target;
    if (t.form?.id === 'settings' && (t.name === 'pack_price_cents' || t.name === 'packs_per_day')) {
      const c = Math.round(toCents(t.form.pack_price_cents.value) * Number(t.form.packs_per_day.value));
      const w = $app.querySelector('#worth');
      if (w) w.textContent = Number.isFinite(c) ? fmt(c) : '–';
    }
    if (t.id !== 'sym') return;
    clearTimeout(timer);
    const q = t.value.trim();
    const results = $app.querySelector('#results');
    if (!q) {
      results.innerHTML = '';
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const r = await api(`/api/symbol?q=${encodeURIComponent(q)}`);
        if (mine !== seq || !results.isConnected) return;
        results.innerHTML = r.results.length
          ? r.results.map((a) => `<li><button type="button" data-act="pickSym" data-arg="${esc(a.symbol)}" data-name="${esc(a.name)}"><b>${esc(a.symbol)}</b> <span class="muted">${esc(a.name)}</span></button></li>`).join('')
          : '<li class="none">No fractional stock or ETF by that name.</li>';
      } catch (err) {
        results.innerHTML = `<li class="none">${esc(err.message)}</li>`;
      }
    }, 250);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (S.editDay || S.confirmMode)) closeDialog();
  });
  setInterval(() => {
    $app.querySelectorAll('[data-count]').forEach((n) => (n.textContent = countdown(n.dataset.count)));
  }, 30000);
  // Coming back to the app shows fresh numbers; Settings is left alone so a
  // half-edited form is never wiped.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !S.token || !S.state || S.tab === 'settings' || S.editDay || S.confirmMode) return;
    refresh()
      .then(() => (S.tab === 'ledgers' ? refreshHistory() : null))
      .then(render)
      .catch(() => {});
  });
}

// ---------- sign-in ----------
async function signOut() {
  S.token = null;
  S.state = null;
  if (S.supabase) await S.supabase.auth.signOut().catch(() => {});
  renderDemo();
}

// Visitors who are not signed in see the sample reader.
function renderDemo() {
  S.demo = true;
  S.token = null;
  S.history = null;
  S.editDay = null;
  S.confirmMode = null;
  renderApp();
}

function renderLogin(message = '') {
  $app.innerHTML = `
    <div class="grain" aria-hidden="true"></div>
    ${masthead(null)}
    <section class="login">
      <div class="kick">Subscriber services</div>
      <h1>Delivered to one address only.</h1>
      <p class="deck">Enter it and the paper sends a sign-in link.</p>
      <form id="login">
        <label class="field"><span>Email</span><input class="inp" type="email" name="email" autocomplete="email" required inputmode="email"></label>
        <button class="btn-ink save" type="submit">Send sign-in link</button>
      </form>
      <form id="otp" hidden>
        <label class="field"><span>Or type the 6-digit code from the email</span><input class="inp nums" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label>
        <button class="btn-outline" type="submit">Sign in with code</button>
      </form>
      <p class="msg" id="loginMsg" style="margin-top:14px;text-align:center">${esc(message)}</p>
      <p style="text-align:center;margin-top:18px"><button class="redlink" data-act="demo">← Back to the demo</button></p>
    </section>`;
  const msg = $app.querySelector('#loginMsg');
  const otp = $app.querySelector('#otp');
  let email = '';
  $app.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    email = new FormData(e.target).get('email').trim();
    msg.className = 'msg';
    msg.textContent = 'Sending…';
    const { error } = await S.supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin, shouldCreateUser: true } });
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

async function renderApp() {
  $app.innerHTML = '<div class="boot">Setting type…</div>';
  try {
    await refresh();
  } catch (err) {
    if (S.token || S.demo) $app.innerHTML = `<div class="boot">${esc(err.message)}</div>`;
    return;
  }
  try {
    const saved = localStorage.getItem('ciggybank.v2.tab');
    if (TABS.some(([id]) => id === saved)) S.tab = saved;
  } catch {}
  render();
  if (S.tab === 'ledgers') refreshHistory().then(render).catch(() => {});
}

// ---------- boot ----------
async function boot() {
  watchLayout();
  bindEvents();
  S.config = await fetch('/api/config').then((r) => r.json());
  if (S.config.error) throw new Error(S.config.message || 'Server misconfigured');
  if (S.config.devFake) {
    S.token = 'dev';
    return renderApp();
  }
  if (!S.config.supabaseUrl || !S.config.supabaseAnonKey) {
    $app.innerHTML = '<div class="boot">Server is missing SUPABASE_URL or SUPABASE_ANON_KEY.</div>';
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
    if (S.token) S.demo = false;
    if (event === 'INITIAL_SESSION') return S.token ? renderApp() : renderDemo();
    if (S.token && !had) renderApp();
    else if (!S.token && had) renderDemo();
  });
}

boot().catch((err) => {
  $app.innerHTML = `<div class="boot">Could not start: ${esc(err.message)}</div>`;
});
