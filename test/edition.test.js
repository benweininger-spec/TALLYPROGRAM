import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_UNIVERSE, RUNGS, EDITION_SCHEMA, validateUniverse, validateEdition, findForecastLanguage, buildUserPrompt, SYSTEM_PROMPT } from '../lib/edition.js';
import { SAMPLE_EDITION } from '../lib/edition-sample.js';
import { resolveSettings, validateSettingsPatch } from '../lib/config.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('the sample edition passes as written, headline forced to caps', () => {
  const out = validateEdition({ ...clone(SAMPLE_EDITION), headline: 'Stocks drift higher; nobody claims credit' });
  assert.equal(out.headline, 'STOCKS DRIFT HIGHER; NOBODY CLAIMS CREDIT');
  assert.deepEqual(RUNGS.map((r) => out.rungs[r].symbol), ['VOO', 'XLK', 'COST']);
  assert.equal(out.rungs.name.name, 'Costco');
});

test('the default universe is valid and covers every rung', () => {
  const u = validateUniverse(DEFAULT_UNIVERSE);
  assert.equal(u.length, DEFAULT_UNIVERSE.length);
  for (const r of RUNGS) assert.ok(u.some((x) => x.rung === r));
});

test('universe: normalizes tickers, rejects junk, duplicates, and a missing rung', () => {
  const ok = validateUniverse([{ symbol: ' voo ', rung: 'index' }, { symbol: 'xlk', rung: 'sector', name: 'Tech' }, { symbol: 'aapl', rung: 'name' }]);
  assert.deepEqual(ok.map((x) => x.symbol), ['VOO', 'XLK', 'AAPL']);
  assert.equal(ok[0].name, 'VOO');
  assert.throws(() => validateUniverse([{ symbol: 'VOO', rung: 'index' }, { symbol: 'VTI', rung: 'index' }, { symbol: 'XLK', rung: 'sector' }]), /at least one name/);
  assert.throws(() => validateUniverse([...ok, { symbol: 'VOO', rung: 'name' }]), /listed twice/);
  assert.throws(() => validateUniverse([...ok, { symbol: 'not a ticker', rung: 'name' }]), /not a ticker/);
  assert.throws(() => validateUniverse([...ok, { symbol: 'TSLA', rung: 'meme' }]), /needs a rung/);
  assert.throws(() => validateUniverse([{ symbol: 'VOO', rung: 'index' }]), /3 to 60/);
});

test('universe is a setting; mode and daily amount are not', () => {
  assert.equal(resolveSettings().market_universe.length, DEFAULT_UNIVERSE.length);
  const patch = validateSettingsPatch({ market_universe: [{ symbol: 'vti', rung: 'index' }, { symbol: 'xlv', rung: 'sector' }, { symbol: 'jnj', rung: 'name' }] });
  assert.equal(patch.market_universe[2].symbol, 'JNJ');
  assert.throws(() => validateSettingsPatch({ market_universe: 'VOO,XLK,AAPL' }), { code: 'bad_setting' });
});

test('spike: a pick outside the universe, at the wrong rung, or used twice', () => {
  const d = clone(SAMPLE_EDITION);
  d.rungs.name.symbol = 'TSLA';
  assert.throws(() => validateEdition(d), /TSLA is not in the universe/);
  d.rungs.name.symbol = 'XLV';
  assert.throws(() => validateEdition(d), /XLV is a sector ticker, not name/);
  d.rungs.name.symbol = 'COST';
  d.rungs.index.symbol = 'VOO';
  d.rungs.sector.symbol = 'VOO';
  assert.throws(() => validateEdition(d), /VOO is a index ticker, not sector/);
  const custom = [{ symbol: 'VTI', rung: 'index' }, { symbol: 'XLK', rung: 'sector' }, { symbol: 'COST', rung: 'name' }];
  assert.throws(() => validateEdition(clone(SAMPLE_EDITION), { universe: validateUniverse(custom) }), /VOO is not in the universe/);
});

test('spike: forecast language anywhere on the page', () => {
  const cases = [
    ['deck', 'Analysts expect the rally will continue into the weekend.'],
    ['closing_note', 'Buy the dip.'],
    ['report', ['Tech led. It is likely to lead again.']],
    ['headline', 'MARKETS POISED TO RALLY'],
  ];
  for (const [field, value] of cases) {
    const d = clone(SAMPLE_EDITION);
    d[field] = value;
    assert.throws(() => validateEdition(d), /reads as a forecast/, `${field}`);
  }
  const d = clone(SAMPLE_EDITION);
  d.rungs.index.note = 'Set to open higher.';
  assert.throws(() => validateEdition(d), /rungs.index.note: reads as a forecast \("set to"\)/);
});

test('forecast lint matches whole phrases, not substrings', () => {
  assert.deepEqual(findForecastLanguage('The company expects nothing; this paper expected less.'), ['expects']);
  assert.deepEqual(findForecastLanguage('Shares rose 2.4% after the report.'), []);
  assert.deepEqual(findForecastLanguage('An upside-down day for energy.'), []);
  assert.deepEqual(findForecastLanguage('There is upside here.'), ['upside']);
  assert.deepEqual(findForecastLanguage('The outlook, the company said, was unchanged.'), ['outlook']);
});

test('spike: lengths, empties, and a page identical to yesterday', () => {
  const d = clone(SAMPLE_EDITION);
  d.headline = 'X'.repeat(81);
  assert.throws(() => validateEdition(d), /headline: over 80/);
  d.headline = 'FINE';
  d.report = [];
  assert.throws(() => validateEdition(d), /one to three paragraphs/);
  d.report = ['ok'];
  d.rungs.name.note = '';
  assert.throws(() => validateEdition(d), /rungs.name.note: empty/);
  d.rungs.name.note = 'Flat.';
  d.closing_note = '';
  assert.doesNotThrow(() => validateEdition(d));
  assert.throws(() => validateEdition(clone(SAMPLE_EDITION), { previous: SAMPLE_EDITION }), /identical to yesterday/);
  const varied = clone(SAMPLE_EDITION);
  varied.rungs.index.symbol = 'VTI';
  assert.doesNotThrow(() => validateEdition(varied, { previous: SAMPLE_EDITION }));
});

test('schema and validator agree on the fields', () => {
  assert.deepEqual(Object.keys(EDITION_SCHEMA.properties).sort(), Object.keys(validateEdition(clone(SAMPLE_EDITION))).sort());
  assert.deepEqual(EDITION_SCHEMA.required.sort(), Object.keys(EDITION_SCHEMA.properties).sort());
  assert.equal(EDITION_SCHEMA.additionalProperties, false);
});

test('the prompts carry the rule, the universe, the data, and yesterday', () => {
  assert.match(SYSTEM_PROMPT, /DOES NOT PREDICT\. IT REPORTS/);
  const p = buildUserPrompt({
    day: '2026-10-01',
    universe: validateUniverse(DEFAULT_UNIVERSE),
    bars: { VOO: [{ day: '2026-09-29', close: 500 }, { day: '2026-09-30', close: 505 }], XLK: [] },
    news: [{ source: 'Reuters', at: '2026-09-30T20:05:00Z', headline: 'Costco sales rise 6%', symbols: ['COST'] }],
    positions: [{ symbol: 'AAPL' }],
    previous: SAMPLE_EDITION,
  });
  assert.match(p, /index: VOO \(Vanguard S&P 500 ETF\)/);
  assert.match(p, /VOO: 2026-09-29 500, 2026-09-30 505 \| last session \+1\.00%/);
  assert.doesNotMatch(p, /XLK:/);
  assert.match(p, /Reuters .*Costco sales rise 6% \[COST\]/);
  assert.match(p, /THE READER HOLDS: AAPL/);
  assert.match(p, /YESTERDAY'S RUNGS: index VOO, sector XLK, name COST/);
  assert.match(p, /No predictions\.$/);
});
