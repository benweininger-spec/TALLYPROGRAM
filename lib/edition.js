// The Market Page: the editorial contract for the daily edition.
//
// Every judgment call lives here as data and pure functions: what the paper
// may write about (the universe), the shape it must return (the schema), how
// it must sound (the prompt), and what gets a draft spiked (the validator).
// Nothing here calls Claude, Alpaca, or the database. lib/market.js does.
//
// The standing rule, printed on the page: the Ciggy Bank does not predict.
// It reports. A draft that forecasts is rejected, not edited.
import { RuleError } from './errors.js';

// ---------- the universe ----------
// Three rungs. The reader picks a rung, not a ranking. "name" is the top of
// the ladder and it is still a large, boring, fractionable company: the
// ladder stops well short of anything that moves 20% on a tweet.
export const RUNGS = Object.freeze(['index', 'sector', 'name']);

export const DEFAULT_UNIVERSE = Object.freeze([
  // index: broad, diversified
  { symbol: 'VOO', rung: 'index', name: 'Vanguard S&P 500 ETF' },
  { symbol: 'VTI', rung: 'index', name: 'Vanguard Total Stock Market ETF' },
  { symbol: 'SCHD', rung: 'index', name: 'Schwab U.S. Dividend Equity ETF' },
  { symbol: 'QQQ', rung: 'index', name: 'Invesco QQQ Trust' },
  { symbol: 'VXUS', rung: 'index', name: 'Vanguard Total International Stock ETF' },
  // sector: one slice of the market
  { symbol: 'XLK', rung: 'sector', name: 'Technology Select Sector SPDR' },
  { symbol: 'XLV', rung: 'sector', name: 'Health Care Select Sector SPDR' },
  { symbol: 'XLF', rung: 'sector', name: 'Financial Select Sector SPDR' },
  { symbol: 'XLE', rung: 'sector', name: 'Energy Select Sector SPDR' },
  { symbol: 'XLP', rung: 'sector', name: 'Consumer Staples Select Sector SPDR' },
  { symbol: 'XLY', rung: 'sector', name: 'Consumer Discretionary Select Sector SPDR' },
  { symbol: 'XLI', rung: 'sector', name: 'Industrial Select Sector SPDR' },
  { symbol: 'XLU', rung: 'sector', name: 'Utilities Select Sector SPDR' },
  { symbol: 'VNQ', rung: 'sector', name: 'Vanguard Real Estate ETF' },
  // name: one large company
  { symbol: 'AAPL', rung: 'name', name: 'Apple' },
  { symbol: 'MSFT', rung: 'name', name: 'Microsoft' },
  { symbol: 'JNJ', rung: 'name', name: 'Johnson & Johnson' },
  { symbol: 'PG', rung: 'name', name: 'Procter & Gamble' },
  { symbol: 'KO', rung: 'name', name: 'Coca-Cola' },
  { symbol: 'PEP', rung: 'name', name: 'PepsiCo' },
  { symbol: 'COST', rung: 'name', name: 'Costco' },
  { symbol: 'WMT', rung: 'name', name: 'Walmart' },
  { symbol: 'JPM', rung: 'name', name: 'JPMorgan Chase' },
  { symbol: 'BRK.B', rung: 'name', name: 'Berkshire Hathaway' },
  { symbol: 'HD', rung: 'name', name: 'Home Depot' },
  { symbol: 'UNH', rung: 'name', name: 'UnitedHealth' },
]);

const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

// Settings store the universe as [{ symbol, rung, name }]. Validates and
// normalizes a user-supplied list.
export function validateUniverse(list) {
  if (!Array.isArray(list) || list.length < 3 || list.length > 60) {
    throw new RuleError('bad_setting', 'Market universe: 3 to 60 tickers');
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const symbol = typeof item?.symbol === 'string' ? item.symbol.trim().toUpperCase() : '';
    if (!SYMBOL_RE.test(symbol)) throw new RuleError('bad_setting', `Market universe: ${JSON.stringify(item?.symbol ?? '')} is not a ticker`);
    if (!RUNGS.includes(item.rung)) throw new RuleError('bad_setting', `Market universe: ${symbol} needs a rung (index, sector, or name)`);
    if (seen.has(symbol)) throw new RuleError('bad_setting', `Market universe: ${symbol} is listed twice`);
    seen.add(symbol);
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 80) : symbol;
    out.push({ symbol, rung: item.rung, name });
  }
  for (const r of RUNGS) {
    if (!out.some((x) => x.rung === r)) throw new RuleError('bad_setting', `Market universe: at least one ${r} ticker`);
  }
  return out;
}

// ---------- the shape the paper returns ----------
// Used as the structured-output format on the Claude call and again by
// validateEdition on whatever comes back. Keep the two in step.
export const EDITION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'deck', 'report', 'rungs', 'closing_note'],
  properties: {
    headline: { type: 'string', description: 'Front-page headline, ALL CAPS, at most 80 characters, about what happened yesterday.' },
    deck: { type: 'string', description: 'One italic line under the headline, at most 160 characters.' },
    report: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { type: 'string', description: 'A paragraph of the report, at most 600 characters.' },
      description: 'Yesterday at the close. What moved, by how much, and the one or two headlines behind it. Past tense only.',
    },
    rungs: {
      type: 'object',
      additionalProperties: false,
      required: ['index', 'sector', 'name'],
      properties: {
        index: { $ref: '#/$defs/pick' },
        sector: { $ref: '#/$defs/pick' },
        name: { $ref: '#/$defs/pick' },
      },
    },
    closing_note: { type: 'string', description: 'One dry sentence to end on, at most 160 characters. May be empty.' },
  },
  $defs: {
    pick: {
      type: 'object',
      additionalProperties: false,
      required: ['symbol', 'note'],
      properties: {
        symbol: { type: 'string', description: 'A ticker from the universe, at the matching rung.' },
        note: { type: 'string', description: 'One sentence, at most 220 characters, on why this one is on the page today. Reported facts only.' },
      },
    },
  },
});

// ---------- the voice ----------
export const SYSTEM_PROMPT = `You write the Market Page of the Ciggy Bank, a one-reader newspaper that helps someone stay off cigarettes. Every clean day pays into their bank; the bank buys small amounts of stock. Your page is the morning edition they read with coffee.

Voice: a vintage American daily crossed with a 1950s print ad. Deadpan, dry, specific. Short sentences. Numbers where you have them. The joke is always the newspaper, its editors, and the market, never the reader. No exclamation marks. No emoji.

The standing rule, printed on every edition: THE CIGGY BANK DOES NOT PREDICT. IT REPORTS.
- Write only in the past tense about things that happened. Yesterday closed up or down; a company reported; a sector led or lagged.
- Never say what will, should, might, or could happen. Never say "expect", "forecast", "outlook", "bet", "play", "opportunity", "momentum", "due for", "poised", "set to", "buy", "sell", or "hold" as advice. Never rate anything. Never give a price target.
- Never flatter the reader or urge them. They decide. The page informs.

The three rungs are not a ranking of winners. They are three places the reader could put a small sum today, one per rung, chosen from the universe you are given and only from it:
- index: broad and diversified. The default. Note why today's news made it worth a line.
- sector: one slice of the market that was in the news yesterday, up or down.
- name: one large company that was in the news yesterday. Large, old, boring is a compliment here.
Each note states a fact about yesterday, not a reason to buy. Pick a different ticker from the one you picked yesterday when the news allows; the page should not read the same two days running.

If the data you are given is thin (a holiday, a data outage, no headlines), say so plainly in the report and still fill the rungs with the broadest, dullest choices. Do not invent numbers. Every number on the page must come from the data provided.`;

// Yesterday's edition and the reader's holdings are passed so the page does
// not repeat itself and can mention what the reader already owns.
export function buildUserPrompt({ day, universe, bars, news, positions = [], previous = null }) {
  const lines = [];
  lines.push(`Edition date: ${day}. Write about the most recent trading session in the data.`);
  lines.push('');
  lines.push('UNIVERSE (the only tickers you may name in the rungs):');
  for (const r of RUNGS) {
    lines.push(`  ${r}: ${universe.filter((u) => u.rung === r).map((u) => `${u.symbol} (${u.name})`).join(', ')}`);
  }
  lines.push('');
  lines.push('CLOSES, most recent last (symbol: day close, day close, ...):');
  for (const [symbol, series] of Object.entries(bars)) {
    if (!series?.length) continue;
    const last = series.at(-1);
    const prev = series.length > 1 ? series.at(-2) : null;
    const chg = prev ? (((last.close - prev.close) / prev.close) * 100).toFixed(2) : null;
    lines.push(`  ${symbol}: ${series.map((b) => `${b.day} ${b.close}`).join(', ')}${chg !== null ? ` | last session ${chg >= 0 ? '+' : ''}${chg}%` : ''}`);
  }
  lines.push('');
  lines.push(news?.length ? 'HEADLINES (source, time, headline):' : 'HEADLINES: none available.');
  for (const n of news || []) lines.push(`  ${n.source} ${n.at}: ${n.headline}${n.symbols?.length ? ` [${n.symbols.join(', ')}]` : ''}`);
  if (positions.length) {
    lines.push('');
    lines.push(`THE READER HOLDS: ${positions.map((p) => p.symbol).join(', ')}. You may mention how these fared yesterday. Do not tell them what to do with them.`);
  }
  if (previous) {
    lines.push('');
    lines.push(`YESTERDAY'S RUNGS: index ${previous.rungs.index.symbol}, sector ${previous.rungs.sector.symbol}, name ${previous.rungs.name.symbol}. Vary today's when the news allows.`);
  }
  lines.push('');
  lines.push('Return the edition as JSON matching the schema. Past tense only. No predictions.');
  return lines.join('\n');
}

// ---------- the spike ----------
// Phrases that turn reporting into forecasting or advice. Any one of these
// in any text field rejects the draft. Case-insensitive, whole words.
export const FORECAST_PHRASES = Object.freeze([
  'will rise', 'will fall', 'will go', 'will climb', 'will drop', 'will rally', 'will recover', 'will continue', 'will likely',
  'should rise', 'should fall', 'should climb', 'should recover', 'should buy', 'should sell', 'should hold',
  'is likely to', 'are likely to', 'likely to rise', 'likely to fall', 'expect', 'expected to', 'expects', 'forecast', 'outlook',
  'predict', 'prediction', 'projected', 'price target', 'target price', 'upside', 'downside risk',
  'buy now', 'buy the dip', 'time to buy', 'strong buy', 'bound to', 'poised to', 'set to', 'due for', 'on track to',
  'momentum play', 'opportunity', 'guaranteed', "can't lose", 'cannot lose', 'sure thing', 'to the moon', 'bet on', 'bullish on', 'bearish on',
  'we recommend', 'recommended', 'consider buying', 'consider adding', 'you should',
]);

const LIMITS = { headline: 80, deck: 160, paragraph: 600, note: 220, closing_note: 160 };

function text(v, field, max) {
  if (typeof v !== 'string') throw new RuleError('bad_edition', `${field}: missing`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s && field !== 'closing_note') throw new RuleError('bad_edition', `${field}: empty`);
  if (s.length > max) throw new RuleError('bad_edition', `${field}: over ${max} characters`);
  return s;
}

export function findForecastLanguage(s) {
  const low = ` ${s.toLowerCase().replace(/[^a-z'\- ]+/g, ' ').replace(/\s+/g, ' ')} `;
  return FORECAST_PHRASES.filter((p) => low.includes(` ${p} `));
}

// Returns a clean edition or throws RuleError('bad_edition', why). The
// caller retries once with the reason appended, then gives up for the day.
export function validateEdition(draft, { universe = DEFAULT_UNIVERSE, previous = null } = {}) {
  if (!draft || typeof draft !== 'object') throw new RuleError('bad_edition', 'Not an object');
  const out = {
    headline: text(draft.headline, 'headline', LIMITS.headline).toUpperCase(),
    deck: text(draft.deck, 'deck', LIMITS.deck),
    report: [],
    rungs: {},
    closing_note: text(draft.closing_note ?? '', 'closing_note', LIMITS.closing_note),
  };
  if (!Array.isArray(draft.report) || draft.report.length < 1 || draft.report.length > 3) {
    throw new RuleError('bad_edition', 'report: one to three paragraphs');
  }
  out.report = draft.report.map((p, i) => text(p, `report[${i}]`, LIMITS.paragraph));

  const bySymbol = new Map(universe.map((u) => [u.symbol, u]));
  const used = new Set();
  for (const rung of RUNGS) {
    const pick = draft.rungs?.[rung];
    const symbol = typeof pick?.symbol === 'string' ? pick.symbol.trim().toUpperCase() : '';
    const u = bySymbol.get(symbol);
    if (!u) throw new RuleError('bad_edition', `rungs.${rung}: ${symbol || 'missing'} is not in the universe`);
    if (u.rung !== rung) throw new RuleError('bad_edition', `rungs.${rung}: ${symbol} is a ${u.rung} ticker, not ${rung}`);
    if (used.has(symbol)) throw new RuleError('bad_edition', `rungs.${rung}: ${symbol} used twice`);
    used.add(symbol);
    out.rungs[rung] = { symbol, name: u.name, note: text(pick.note, `rungs.${rung}.note`, LIMITS.note) };
  }

  const fields = [
    ['headline', out.headline], ['deck', out.deck], ['closing_note', out.closing_note],
    ...out.report.map((p, i) => [`report[${i}]`, p]),
    ...RUNGS.map((r) => [`rungs.${r}.note`, out.rungs[r].note]),
  ];
  for (const [field, s] of fields) {
    const hits = findForecastLanguage(s);
    if (hits.length) throw new RuleError('bad_edition', `${field}: reads as a forecast ("${hits[0]}"). The paper reports; it does not predict.`);
  }
  if (previous && RUNGS.every((r) => previous.rungs?.[r]?.symbol === out.rungs[r].symbol)) {
    throw new RuleError('bad_edition', 'rungs: identical to yesterday. Vary at least one when the news allows.');
  }
  return out;
}

// The line the app prints under every edition. Not the model's to write.
export const STANDING_RULE = 'The Ciggy Bank does not predict. It reports. Nothing on this page is advice; the reader decides, and the 24-hour cooldown still applies.';
