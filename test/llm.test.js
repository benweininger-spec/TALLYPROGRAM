// The Claude call, against a fake client. npm test never calls Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeEdition, EDITION_MODEL } from '../lib/llm.js';
import { writerFromEnv } from '../lib/deps.js';
import { EDITION_SCHEMA, SYSTEM_PROMPT } from '../lib/edition.js';
import { SAMPLE_EDITION } from '../lib/edition-sample.js';

// Stands in for client.messages: applies the request's own parser to the
// reply text, the way the SDK's parse() does.
function fakeClient(stop_reason, text) {
  const calls = [];
  return {
    calls,
    messages: {
      async parse(params) {
        calls.push(params);
        return { stop_reason, model: params.model, usage: { input_tokens: 900, output_tokens: 400 }, parsed_output: params.output_config.format.parse(text) };
      },
    },
  };
}
const args = { system: SYSTEM_PROMPT, user: 'Edition date: 2026-10-06.', schema: EDITION_SCHEMA };

test('one call: Opus, low effort, the edition schema as the output format, the voice prompt cached', async () => {
  const client = fakeClient('end_turn', JSON.stringify(SAMPLE_EDITION));
  const out = await writeEdition(args, { client });
  assert.deepEqual(out.draft, JSON.parse(JSON.stringify(SAMPLE_EDITION)));
  assert.equal(out.model, 'claude-opus-5-5');
  assert.equal(out.usage.output_tokens, 400);
  const p = client.calls[0];
  assert.equal(EDITION_MODEL, 'claude-opus-5-5');
  assert.equal(p.model, EDITION_MODEL);
  assert.equal(p.max_tokens, 4000);
  assert.deepEqual(p.system, [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(p.messages, [{ role: 'user', content: args.user }]);
  assert.equal(p.output_config.effort, 'low');
  assert.equal(p.output_config.format.type, 'json_schema');
  // The contract's schema, as structured outputs takes it: same fields and
  // refs; maxItems moved into the description for validateEdition to enforce.
  const schema = p.output_config.format.schema;
  assert.deepEqual(schema.required, EDITION_SCHEMA.required);
  assert.equal(schema.properties.rungs.properties.name.$ref, '#/$defs/pick');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.report.maxItems, undefined);
  assert.match(schema.properties.report.description, /maxItems: 3/);
  assert.equal(EDITION_SCHEMA.properties.report.maxItems, 3, 'the contract itself is untouched');
});

test('a refusal, a cut-off reply, or no edition is a spiked draft, not a crash', async () => {
  for (const [stop, text, why] of [
    ['refusal', 'I would rather not.', /declined/],
    ['max_tokens', '{"headline": "STOCKS', /past the space/],
    ['end_turn', 'not json', /without an edition/],
  ]) {
    await assert.rejects(writeEdition(args, { client: fakeClient(stop, text) }), (e) => e.code === 'bad_edition' && why.test(e.message));
  }
});

test('no key, no writer: the job runs the fallback instead', () => {
  assert.equal(writerFromEnv({}), null);
  assert.equal(typeof writerFromEnv({ ANTHROPIC_API_KEY: 'sk-test' }), 'function');
});
