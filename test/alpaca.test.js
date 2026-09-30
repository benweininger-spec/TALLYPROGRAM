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
