// The one Claude call: the Market Page's daily draft. Everything about what
// the page may say lives in lib/edition.js; this file only sends it.
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { RuleError } from './errors.js';

export const EDITION_MODEL = 'claude-opus-5-5';

let shared = null;
function defaultClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  // The SDK retries overloads and network errors itself. Kept short so two
  // drafts and the data fetch fit well inside the function's time limit.
  shared ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 90_000 });
  return shared;
}

// Returns { draft, model, usage }. Throws RuleError('bad_edition') when
// Claude declines or runs out of room, which the caller treats like any
// spiked draft; anything else (no key, API down) is thrown as is.
export async function writeEdition({ system, user, schema }, { client = defaultClient(), model = EDITION_MODEL } = {}) {
  // A refusal or a cut-off reply is not JSON. Parse leniently so the stop
  // reason, checked below, says what happened instead of a parse error.
  const format = jsonSchemaOutputFormat(schema);
  const lenient = { ...format, parse: (text) => { try { return format.parse(text); } catch { return null; } } };
  const msg = await client.messages.parse({
    model,
    max_tokens: 4000,
    // The voice prompt is the same every day; mark it for the prompt cache.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    // A short piece of writing from supplied facts. The helper moves the
    // constraints structured outputs do not take (maxItems) into
    // descriptions; validateEdition still enforces them.
    output_config: { effort: 'low', format: lenient },
  });
  if (msg.stop_reason === 'refusal') throw new RuleError('bad_edition', 'the draft was declined by the writer');
  if (msg.stop_reason === 'max_tokens') throw new RuleError('bad_edition', 'the draft ran past the space allowed');
  if (!msg.parsed_output) throw new RuleError('bad_edition', 'the draft came back without an edition');
  return { draft: msg.parsed_output, model: msg.model || model, usage: msg.usage };
}
