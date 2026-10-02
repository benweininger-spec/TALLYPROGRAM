import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAlpaca, BrokerError } from '../lib/alpaca.js';
import { brokerFromEnv } from '../lib/deps.js';

function recorder(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const [status, body] = responses.shift() || [200, {}];
    return { status, ok: status < 300, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

test('mode comes from the base URL only', () => {
  assert.equal(makeAlpaca({ keyId: 'k', secretKey: 's', baseUrl: 'https://paper-api.alpaca.markets' }).mode, 'paper');
  assert.equal(makeAlpaca({ keyId: 'k', secretKey: 's', baseUrl: 'https://api.alpaca.markets' }).mode, 'live');
  assert.equal(brokerFromEnv({ ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's' }).mode, 'paper');
  assert.equal(brokerFromEnv({}), null);
});

test('buys send a dollar notional market day order; sells send qty', async () => {
  const { calls, fetchImpl } = recorder([[200, { id: 'o1' }], [200, { id: 'o2' }]]);
  const a = makeAlpaca({ keyId: 'k', secretKey: 's', baseUrl: 'https://paper-api.alpaca.markets/', fetchImpl });
  await a.submitOrder({ client_order_id: 'c1', symbol: 'VTI', side: 'buy', notional_cents: 5000, qty: null });
  await a.submitOrder({ client_order_id: 'c2', symbol: 'VTI', side: 'sell', notional_cents: 9999, qty: '0.123' });
  assert.equal(calls[0].url, 'https://paper-api.alpaca.markets/v2/orders');
  assert.equal(calls[0].init.headers['APCA-API-KEY-ID'], 'k');
  assert.deepEqual(JSON.parse(calls[0].init.body), { symbol: 'VTI', side: 'buy', type: 'market', time_in_force: 'day', client_order_id: 'c1', notional: '50.00' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { symbol: 'VTI', side: 'sell', type: 'market', time_in_force: 'day', client_order_id: 'c2', qty: '0.123' });
});

test('errors are classified for retry decisions', async () => {
  const { fetchImpl } = recorder([
    [422, { code: 40010001, message: 'client_order_id must be unique' }],
    [403, { message: 'insufficient buying power' }],
    [500, { message: 'oops' }],
    [404, { message: 'not found' }],
  ]);
  const a = makeAlpaca({ keyId: 'k', secretKey: 's', baseUrl: 'https://paper-api.alpaca.markets', fetchImpl });
  const o = { client_order_id: 'c', symbol: 'VTI', side: 'buy', notional_cents: 5000 };
  await assert.rejects(a.submitOrder(o), (e) => e instanceof BrokerError && e.duplicate && e.definitive);
  await assert.rejects(a.submitOrder(o), (e) => !e.duplicate && e.definitive);
  await assert.rejects(a.submitOrder(o), (e) => !e.definitive);
  assert.equal(await a.getOrderByClientId('nope'), null);
});

test('search ranks exact, then prefix, then name matches', async () => {
  const assets = [
    { symbol: 'VTIP', name: 'Vanguard Short-Term Inflation', tradable: true, fractionable: true },
    { symbol: 'VTI', name: 'Vanguard Total Stock Market', tradable: true, fractionable: true },
    { symbol: 'VOO', name: 'Vanguard S&P 500', tradable: true, fractionable: true },
    { symbol: 'VTX', name: 'Not fractionable', tradable: true, fractionable: false },
  ];
  const { fetchImpl } = recorder([[200, assets]]);
  const a = makeAlpaca({ keyId: 'k', secretKey: 's', baseUrl: 'https://paper-api.alpaca.markets', fetchImpl });
  assert.deepEqual((await a.searchAssets('vti')).map((x) => x.symbol), ['VTI', 'VTIP']);
  assert.deepEqual((await a.searchAssets('vanguard')).map((x) => x.symbol), ['VTIP', 'VTI', 'VOO']);
});

test('news: one request to the data host for the universe, newest first', async () => {
  const { calls, fetchImpl } = recorder([[200, {
    news: [
      { id: 1, headline: ' Costco sales rise 6% ', source: 'reuters', created_at: '2026-10-06T20:05:00Z', symbols: ['COST'] },
      { id: 2, headline: '', source: 'benzinga', created_at: '2026-10-06T19:00:00Z', symbols: [] },
      { id: 3, headline: 'Energy slips', author: 'Wire', created_at: '2026-10-06T18:00:00Z' },
    ],
  }]]);
  const a = makeAlpaca({ keyId: 'k', secretKey: 's', baseUrl: 'https://paper-api.alpaca.markets', fetchImpl });
  const news = await a.getNews({ symbols: ['COST', 'XLE', 'BRK.B'], start: '2026-10-06T13:25:00.000Z', limit: 80 });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://data.alpaca.markets/v1beta1/news');
  assert.equal(url.searchParams.get('symbols'), 'COST,XLE,BRK.B');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('sort'), 'desc');
  assert.equal(url.searchParams.get('start'), '2026-10-06T13:25:00.000Z');
  assert.equal(calls[0].init.headers['APCA-API-SECRET-KEY'], 's');
  assert.deepEqual(news, [
    { source: 'reuters', at: '2026-10-06T20:05:00Z', headline: 'Costco sales rise 6%', symbols: ['COST'] },
    { source: 'Wire', at: '2026-10-06T18:00:00Z', headline: 'Energy slips', symbols: [] },
  ]);
});

import { makeFakeBroker } from '../lib/broker-fake.js';
test('fake news: plausible headlines, only for the tickers asked about', async () => {
  const b = makeFakeBroker({ clock: () => new Date('2026-10-06T13:25:00Z') });
  const news = await b.getNews({ symbols: ['COST', 'XLE', 'MSFT'], start: '2026-10-05T13:25:00Z', limit: 20 });
  assert.deepEqual(news.map((n) => n.symbols[0]), ['COST', 'XLE']);
  assert.ok(news.every((n) => n.source && n.headline && n.at < '2026-10-06T13:25:00Z'));
  assert.equal((await b.getNews({ symbols: ['COST', 'XLE'], limit: 1 })).length, 1);
});
