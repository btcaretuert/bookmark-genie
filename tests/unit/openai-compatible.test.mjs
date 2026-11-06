import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';

import { createBudget, withBudget } from '../../extension/core/budget.js';
import { buildClassifyRequest, classifyBatch } from '../../extension/core/classify.js';
import { budgetPrices } from '../../extension/core/models.js';
import { proposeTaxonomy } from '../../extension/core/taxonomy.js';
import { RetryLaterError } from '../../extension/platform/llm.js';
import { createOpenAiCompatibleComplete, ProviderRequestError } from '../../extension/platform/openai-compatible.js';
import { startFakeOpenAi } from '../helpers/fake-openai.mjs';

const KEY = 'test-key-not-real-1234567890';

const MODELS = {
  openai: 'gpt-6-luna',
  gemini: 'gemini-3.1-flash-lite',
  mistral: 'ministral-8b-2512',
  xai: 'grok-4.20-0309-non-reasoning',
  deepseek: 'deepseek-flash',
  perplexity: 'openai/gpt-6-luna',
};
const ALL_PROVIDERS = Object.keys(MODELS);
const CHAT_PROVIDERS = ALL_PROVIDERS.filter((provider) => provider !== 'perplexity');

const FOLDERS = [{ name: 'Programación' }, { name: 'Cocina' }, { name: 'Viajes' }];

let fake;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/**
 * @param {keyof typeof MODELS} provider
 * @param {Parameters<typeof startFakeOpenAi>[0]} [fakeOptions]
 * @param {object} [adapterOptions]
 */
async function setUp(provider, fakeOptions = {}, adapterOptions = {}) {
  fake = await startFakeOpenAi({ dialect: provider, ...fakeOptions });
  return createOpenAiCompatibleComplete({ provider, model: MODELS[provider], apiKey: KEY, baseURL: fake.baseURL, ...adapterOptions });
}

const requestWith = (title = 'Pan') => buildClassifyRequest([{ id: 'a', title, url: 'example.com/pan' }], FOLDERS);

const bookmarks = (titles) => titles.map((title, index) => ({ id: `id-${index}`, title, url: `example.com/${index}` }));

function assertSchemaRequest(body) {
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.name, 'result');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties), ['assignments']);
}

// --- The request each provider's documentation asks for ---

for (const [provider, capName] of [
  ['openai', 'max_completion_tokens'],
  ['xai', 'max_completion_tokens'],
  ['gemini', 'max_tokens'],
  ['mistral', 'max_tokens'],
]) {
  test(`${provider}: sends its documented token cap and a strict schema, with the bearer key`, async () => {
    const complete = await setUp(provider);
    const request = requestWith();
    await complete(request);

    const [{ url, body, headers }] = fake.requests;
    assert.equal(url, '/chat/completions');
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, MODELS[provider]);
    assert.equal(body[capName], request.maxTokens);
    for (const other of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
      if (other !== capName) assert.equal(other in body, false, `${other} must not be sent`);
    }
    assert.deepEqual(body.messages, [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ]);
    assertSchemaRequest(body);
    assert.equal('reasoning_effort' in body, false, 'without an effort, the model default applies');
  });
}

test('openai: states store false, so the bookmarks are never kept by this call', async () => {
  const complete = await setUp('openai');
  await complete(requestWith());
  assert.equal(fake.requests[0].body.store, false);
});

test('deepseek: JSON mode with the schema, an example and the word json in the system prompt', async () => {
  const complete = await setUp('deepseek');
  const request = requestWith();
  await complete(request);

  const { body } = fake.requests[0];
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const [system, user] = body.messages;
  assert.ok(system.content.startsWith(request.system), 'the original instructions stay first');
  assert.ok(system.content.includes(JSON.stringify(request.schema)));
  assert.ok(system.content.includes('json'));
  assert.ok(system.content.includes('{"assignments":[{"i":0,"f":0,"confidence":"high"}]}'), 'an example of the shape');
  assert.equal(user.content, request.user, 'the bookmarks stay in the user message, apart from the instructions');
  assert.equal(body.max_tokens, request.maxTokens);
});

test('perplexity: uses the Agent API shape and nothing that can trigger a web search', async () => {
  const complete = await setUp('perplexity');
  const request = requestWith();
  await complete(request);

  const [{ url, body }] = fake.requests;
  assert.equal(url, '/v1/agent');
  assert.equal(body.instructions, request.system);
  assert.equal(body.input, request.user);
  assert.equal(body.max_output_tokens, request.maxTokens);
  assert.equal(body.store, false);
  assertSchemaRequest(body);
  for (const forbidden of ['effort', 'tools', 'messages', 'preset', 'disable_search']) {
    assert.equal(forbidden in body, false, `${forbidden} must not be sent`);
  }
});

test('perplexity: an effort goes under reasoning, never at the top level, where it selects a preset that can search', async () => {
  const complete = await setUp('perplexity', {}, { effort: 'low' });
  const result = await complete(requestWith());

  const { body } = fake.requests[0];
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal('effort' in body, false);
  assert.equal(result.stopReason, 'end_turn');
});

for (const provider of CHAT_PROVIDERS.filter((item) => item !== 'xai')) {
  test(`${provider}: an effort goes out as reasoning_effort`, async () => {
    const complete = await setUp(provider, {}, { effort: 'high', model: provider === 'mistral' ? 'mistral-small-2603' : MODELS[provider] });
    await complete(requestWith());
    assert.equal(fake.requests[0].body.reasoning_effort, 'high');
  });
}

test('xai: the fake rejects an effort on the model that does not reason, as the documented contract would', async () => {
  const complete = await setUp('xai', {}, { effort: 'low' });
  await assert.rejects(complete(requestWith()), (error) => error instanceof ProviderRequestError && error.status === 400 && /does not reason/.test(error.apiMessage));
});

test('a schema that breaks the strict rules reaches the provider and comes back as a permanent error', async () => {
  const complete = await setUp('openai');
  const request = { ...requestWith(), schema: { type: 'object', properties: { a: { type: 'string' } }, required: [] } };
  await assert.rejects(complete(request), (error) => error instanceof ProviderRequestError && /additionalProperties/.test(error.apiMessage));
});

// --- CompletionResult, exactly ---

for (const provider of ALL_PROVIDERS) {
  test(`${provider}: returns exactly the CompletionResult contract`, async () => {
    const complete = await setUp(provider);
    const result = await complete(requestWith());

    assert.deepEqual(Object.keys(result).sort(), ['data', 'latencyMs', 'refusalCategory', 'requestId', 'servedModel', 'stopReason', 'usage']);
    assert.deepEqual(result.data, { assignments: [{ i: 0, f: 0, confidence: 'high' }] });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.refusalCategory, null);
    assert.equal(result.servedModel, MODELS[provider]);
    assert.equal(typeof result.latencyMs, 'number');
    assert.ok(result.latencyMs >= 0);
    assert.deepEqual(Object.keys(result.usage).sort(), ['attempts', 'inputTokens', 'outputTokens', 'thinkingTokens', 'usedFallback']);
    assert.equal(result.usage.usedFallback, false);
    assert.equal(result.usage.inputTokens, 100);
    assert.equal(result.usage.outputTokens, 50);
    assert.equal(result.usage.thinkingTokens, 0);
    assert.deepEqual(result.usage.attempts, [{ model: MODELS[provider], inputTokens: 100, outputTokens: 50, thinkingTokens: 0, kind: 'message' }]);
  });
}

test('requestId comes from the header where one is documented', async () => {
  const complete = await setUp('openai');
  assert.equal((await complete(requestWith())).requestId, 'req_fake_0001');
});

test('requestId falls back to the response id where no header is documented', async () => {
  const complete = await setUp('gemini');
  assert.equal((await complete(requestWith())).requestId, 'chatcmpl-fake-1');
});

test('a dated served model is reported, while the attempt keeps the id the catalog prices', async () => {
  const complete = await setUp('openai', { servedModel: 'gpt-6-luna-2026-05-18' });
  const result = await complete(requestWith());
  assert.equal(result.servedModel, 'gpt-6-luna-2026-05-18');
  assert.equal(result.usage.attempts[0].model, 'gpt-6-luna');
});

test('a retired model routed to another one of the catalog is charged at the rate of the one that answered', async () => {
  const complete = await setUp('gemini', { servedModel: 'gemini-3.5-flash-lite' }, { model: 'gemini-2.5-flash-lite' });
  const budget = createBudget(1);
  const charged = withBudget(complete, { model: 'gemini-2.5-flash-lite', budget, estimateTokens: (text) => text.length, prices: budgetPrices() });
  const result = await charged(requestWith());

  assert.equal(result.servedModel, 'gemini-3.5-flash-lite');
  assert.equal(result.usage.attempts[0].model, 'gemini-3.5-flash-lite');
  assert.ok(Math.abs(budget.spentUsd - (100 * 0.3 + 50 * 2.5) / 1_000_000) < 1e-12);
});

test('a served model of another provider, or unknown, keeps the price of the one requested', async () => {
  const complete = await setUp('openai', { servedModel: 'claude-fable-5-1' });
  assert.equal((await complete(requestWith())).usage.attempts[0].model, 'gpt-6-luna');
});

test('openai: a batch whose prompt is written to the cache is charged what the documentation says', async () => {
  const complete = await setUp('openai');
  const budget = createBudget(1);
  const charged = withBudget(complete, { model: 'gpt-6-luna', budget, estimateTokens: (text) => text.length, prices: budgetPrices() });
  const { usage } = await charged(requestWith('CACHE_WRITE_ME'));

  assert.equal(usage.inputTokens, 3000);
  // Documented rates: cache writes at 0.125 and output at 0.50, per million tokens.
  assert.ok(Math.abs(budget.spentUsd - 0.000775) < 1e-12, `charged ${budget.spentUsd}`);
});

test('a response without a model reports the requested one', async () => {
  const complete = await setUp('openai', {
    statusFirst: { status: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } },
  });
  assert.equal((await complete(requestWith())).servedModel, 'gpt-6-luna');
});

// --- stopReason stays neutral ---

for (const provider of ALL_PROVIDERS) {
  test(`${provider}: truncation is max_tokens, with no data`, async () => {
    const complete = await setUp(provider);
    const result = await complete(requestWith('TRUNCATE_ME'));
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal(result.data, null);
    assert.equal(result.refusalCategory, null);
  });

  test(`${provider}: a refusal is refusal, with no data and no explanation kept`, async () => {
    const complete = await setUp(provider);
    const result = await complete(requestWith('REFUSE_ME'));
    assert.equal(result.stopReason, 'refusal');
    assert.equal(result.data, null);
    assert.equal(JSON.stringify(result).includes('I cannot help'), false);
  });
}

for (const provider of ['openai', 'xai']) {
  test(`${provider}: a refusal in the message field wins over finish_reason stop, with no category`, async () => {
    const complete = await setUp(provider);
    const result = await complete(requestWith('REFUSE_ME'));
    assert.equal(result.stopReason, 'refusal');
    assert.equal(result.refusalCategory, null);
  });
}

for (const provider of ['openai', 'gemini', 'mistral', 'deepseek']) {
  test(`${provider}: finish_reason content_filter is a refusal, and its category says so`, async () => {
    const complete = await setUp(provider);
    const result = await complete(requestWith('FILTER_ME'));
    assert.equal(result.stopReason, 'refusal');
    assert.equal(result.refusalCategory, 'content_filter');
    assert.equal(result.data, null);
  });
}

test('mistral: model_length is max_tokens', async () => {
  const complete = await setUp('mistral');
  assert.equal((await complete(requestWith('LONG_CONTEXT_ME'))).stopReason, 'max_tokens');
});

test('xai: finish_reason end_turn is end_turn', async () => {
  const complete = await setUp('xai');
  const result = await complete(requestWith('END_TURN_ME'));
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(result.data);
});

test('a finish_reason outside the contract throws instead of passing for a normal answer, without retrying', async () => {
  const complete = await setUp('gemini');
  await assert.rejects(complete(requestWith('ODD_STOP_ME')), (error) => !(error instanceof RetryLaterError) && /Unexpected finish_reason: recitation/.test(error.message) && /chatcmpl-fake-1/.test(error.message));
});

test('a value that is not part of the provider map is not found through the prototype chain', async () => {
  const complete = await setUp('openai', {
    statusFirst: { status: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'constructor' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } },
  });
  await assert.rejects(complete(requestWith()), /Unexpected finish_reason: constructor/);
});

for (const [provider, reason] of [
  ['deepseek', 'insufficient_system_resource'],
  ['mistral', 'error'],
  ['perplexity', 'status failed'],
]) {
  test(`${provider}: a partway failure (${reason}) is retried later and marked as possibly billed, without being a timeout`, async () => {
    const complete = await setUp(provider);
    await assert.rejects(complete(requestWith('STALL_ME')), (error) => {
      assert.ok(error instanceof RetryLaterError);
      assert.equal(error.mayHaveBilled, true);
      assert.equal(error.timedOut, false);
      assert.equal(error.status, 200);
      assert.equal(error.retryAfterMs, null);
      assert.ok(error.message.includes(reason));
      return true;
    });
  });
}

test('perplexity: a status that makes no sense without background mode is an error', async () => {
  const complete = await setUp('perplexity');
  await assert.rejects(complete(requestWith('ODD_STOP_ME')), (error) => !(error instanceof RetryLaterError) && /Unexpected response status: queued/.test(error.message));
});

// --- Usage ---

for (const provider of ALL_PROVIDERS) {
  test(`${provider}: a response without usage throws an error that is not retried`, async () => {
    const complete = await setUp(provider);
    await assert.rejects(complete(requestWith('NO_USAGE_ME')), (error) => !(error instanceof RetryLaterError) && /usage is missing/.test(error.message));
  });
}

for (const [label, usage, field] of [
  ['a number as text', { prompt_tokens: '100', completion_tokens: 50 }, 'prompt_tokens'],
  ['a negative count', { prompt_tokens: 100, completion_tokens: -1 }, 'completion_tokens'],
  ['a missing count', { prompt_tokens: 100 }, 'completion_tokens'],
]) {
  test(`usage with ${label} throws`, async () => {
    const complete = await setUp('openai', { usage });
    await assert.rejects(complete(requestWith()), new RegExp(`usage is missing or unusable \\(${field}\\)`));
  });
}

test('openai: reasoning inside completion_tokens is not counted twice', async () => {
  const complete = await setUp('openai');
  const { usage } = await complete(requestWith('THINK_ME'));
  assert.equal(usage.outputTokens, 50);
  assert.equal(usage.thinkingTokens, 30);
});

test('deepseek: reasoning_tokens is read and the reasoning text does not reach the answer', async () => {
  const complete = await setUp('deepseek');
  const result = await complete(requestWith('THINK_ME'));
  assert.equal(result.usage.thinkingTokens, 30);
  assert.ok(result.data.assignments);
  assert.equal(JSON.stringify(result).includes('Thinking about it'), false);
});

test('xai: reasoning billed outside completion_tokens still reaches the budget, through the total', async () => {
  const complete = await setUp('xai');
  const { usage } = await complete(requestWith('THINK_ME'));
  assert.equal(usage.outputTokens, 80);
  assert.equal(usage.thinkingTokens, 30);
  assert.equal(usage.attempts[0].outputTokens, 80);
});

test('gemini: thoughts that appear only in the total are charged as output and reported as reasoning', async () => {
  const complete = await setUp('gemini');
  const { usage } = await complete(requestWith('THINK_ME'));
  assert.equal(usage.outputTokens, 80);
  assert.equal(usage.thinkingTokens, 30);
  assert.equal(usage.attempts[0].thinkingTokens, 30);
});

test('reasoning larger than the output cannot be inside it, so it is added', async () => {
  const complete = await setUp('openai', { usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 40 } } });
  const { usage } = await complete(requestWith());
  assert.equal(usage.outputTokens, 45);
  assert.equal(usage.thinkingTokens, 40);
});

test('a total smaller than the parts is ignored', async () => {
  const complete = await setUp('openai', { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 10 } });
  assert.equal((await complete(requestWith())).usage.outputTokens, 50);
});

test('perplexity: reads its own usage fields, and a tool that ran stops everything', async () => {
  let complete = await setUp('perplexity');
  const { usage } = await complete(requestWith('THINK_ME'));
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 50);
  assert.equal(usage.thinkingTokens, 30);
  await fake.close();

  complete = await setUp('perplexity', { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, tool_calls_details: { search_web: { invocation: 1 } } } });
  await assert.rejects(complete(requestWith()), (error) => error instanceof ProviderRequestError && /ran a tool/.test(error.message));
});

// --- What the answer can look like ---

test('mistral: reasoning returns a list of chunks, and only the text counts as the answer', async () => {
  const complete = await setUp('mistral', {}, { model: 'mistral-small-2603', effort: 'high' });
  const result = await complete(requestWith());
  assert.deepEqual(result.data, { assignments: [{ i: 0, f: 0, confidence: 'high' }] });
  assert.equal(result.stopReason, 'end_turn');
});

test('mistral: the fake rejects an effort that is not documented for this model', async () => {
  const complete = await setUp('mistral', {}, { model: 'mistral-small-2603', effort: 'low' });
  await assert.rejects(complete(requestWith()), (error) => error instanceof ProviderRequestError && error.status === 422);
});

test('a part of another type does not count as the answer, even with a text field', async () => {
  const complete = await setUp('mistral', {
    statusFirst: {
      status: 200,
      body: {
        id: 'x',
        choices: [{ message: { content: [{ type: 'thinking', text: 'not the answer ' }, { type: 'text', text: '{"ok":true}' }] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    },
  });
  assert.deepEqual((await complete(requestWith())).data, { ok: true });
});

test('a filtered answer has no data, even if what got through happens to be valid JSON', async () => {
  const complete = await setUp('openai', {
    statusFirst: {
      status: 200,
      body: { id: 'x', choices: [{ message: { content: '{"assignments":[]}' }, finish_reason: 'content_filter' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    },
  });
  const result = await complete(requestWith());
  assert.equal(result.stopReason, 'refusal');
  assert.equal(result.data, null);
});

test('deepseek: blank lines before the JSON, which keep the connection alive, do not break it', async () => {
  const complete = await setUp('deepseek', { keepAliveLines: 5 });
  assert.ok((await complete(requestWith())).data.assignments);
});

test('deepseek: content the API blanked comes back as no data with a normal stop', async () => {
  const complete = await setUp('deepseek');
  const result = await complete(requestWith('BLANK_ME'));
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.data, null);
});

for (const provider of ALL_PROVIDERS) {
  test(`${provider}: an answer that is not JSON has no data, with a normal stop`, async () => {
    const complete = await setUp(provider);
    const result = await complete(requestWith('BAD_JSON_ME'));
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.data, null);
  });
}

// --- Errors ---

test('429 is retried later and carries the status, the request id and the message', async () => {
  const complete = await setUp('openai', { rateLimitFirst: 1, retryAfter: '7' });
  await assert.rejects(complete(requestWith()), (error) => {
    assert.ok(error instanceof RetryLaterError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 7000);
    assert.equal(error.requestId, 'req_fake_0001');
    assert.equal(error.apiMessage, 'slow down');
    assert.equal(error.timedOut, false);
    assert.match(error.message, /Rate limited: slow down \(request-id req_fake_0001\)/);
    return true;
  });
});

test('retry-after-ms wins over retry-after', async () => {
  const complete = await setUp('openai', { rateLimitFirst: 1, retryAfter: '7', retryAfterMs: '250' });
  await assert.rejects(complete(requestWith()), (error) => error.retryAfterMs === 250);
});

for (const [label, value, expected] of [
  ['none', undefined, null],
  ['zero', '0', null],
  ['a past date', 'Wed, 21 Oct 2015 07:28:00 GMT', null],
]) {
  test(`a 429 with retry-after ${label} leaves the wait to the caller`, async () => {
    const complete = await setUp('openai', { rateLimitFirst: 1, retryAfter: value });
    await assert.rejects(complete(requestWith()), (error) => error instanceof RetryLaterError && error.retryAfterMs === expected);
  });
}

test('a retry-after date in the future becomes a wait', async () => {
  const complete = await setUp('perplexity', { rateLimitFirst: 1, retryAfter: new Date(Date.now() + 60_000).toUTCString() });
  await assert.rejects(complete(requestWith()), (error) => error.retryAfterMs > 30_000 && error.retryAfterMs <= 60_000);
});

for (const [provider, code, field] of [
  ['openai', 'insufficient_quota', 'type'],
  ['openai', 'credit_balance_exhausted', 'code'],
  ['openai', 'organization_spend_limit_exceeded', 'code'],
  ['openai', 'project_spend_limit_exceeded', 'code'],
  ['openai', 'organization_usage_limit_exceeded', 'code'],
  ['gemini', 'quota_exceeded', 'code'],
]) {
  test(`${provider}: a 429 with ${field} ${code} is not worth a wait`, async () => {
    const complete = await setUp(provider, { statusFirst: { status: 429, body: { error: { message: 'Pay first', [field]: code } } } });
    await assert.rejects(complete(requestWith()), (error) => error instanceof ProviderRequestError && error.status === 429 && error.apiMessage === 'Pay first');
  });
}

test('gemini: a 429 that is a rate limit is retried', async () => {
  const complete = await setUp('gemini', { statusFirst: { status: 429, body: { error: { message: 'Slow', code: 'rate_limit_exceeded' } } } });
  await assert.rejects(complete(requestWith()), (error) => error instanceof RetryLaterError);
});

for (const status of [408, 409, 500, 502, 503, 504, 529]) {
  test(`${status} is retried later`, async () => {
    const complete = await setUp('openai', { statusFirst: { status, headers: { 'retry-after': '3' } } });
    await assert.rejects(complete(requestWith()), (error) => {
      assert.ok(error instanceof RetryLaterError);
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 3000);
      assert.equal(error.requestId, 'req_fake_0001');
      return true;
    });
  });
}

for (const status of [400, 401, 402, 403, 404, 415, 422, 501]) {
  test(`${status} is permanent and keeps what the API said`, async () => {
    const complete = await setUp('openai', { statusFirst: { status } });
    await assert.rejects(complete(requestWith()), (error) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.status, status);
      assert.equal(error.requestId, 'req_fake_0001');
      assert.equal(error.apiMessage, `fake status ${status}`);
      assert.match(error.message, new RegExp(`OpenAI rejected the request \\(status ${status}\\): fake status ${status} \\(request-id req_fake_0001\\)`));
      return true;
    });
  });
}

test('x-should-retry false makes even a server error permanent', async () => {
  const complete = await setUp('openai', { statusFirst: { status: 500, headers: { 'x-should-retry': 'false' } } });
  await assert.rejects(complete(requestWith()), (error) => error instanceof ProviderRequestError && error.status === 500);
});

test('mistral: reads an error whose message is at the root', async () => {
  const complete = await setUp('mistral', { statusFirst: { status: 401 } });
  await assert.rejects(complete(requestWith()), (error) => error.apiMessage === 'fake status 401');
});

test('xai: reads an error that is a plain string', async () => {
  const complete = await setUp('xai', { statusFirst: { status: 400, body: { code: 'Client specified an invalid argument', error: 'Bad model' } } });
  await assert.rejects(complete(requestWith()), (error) => error.apiMessage === 'Bad model');
});

test('gemini: reads an error wrapped in a list', async () => {
  const complete = await setUp('gemini', { statusFirst: { status: 400, body: [{ error: { code: 400, message: 'Bad schema', status: 'INVALID_ARGUMENT' } }] } });
  await assert.rejects(complete(requestWith()), (error) => error.apiMessage === 'Bad schema');
});

test('an HTML error page is retried without quoting the page', async () => {
  const complete = await setUp('openai', { rawFirst: { status: 502, text: '<html>Bad gateway from a proxy</html>' } });
  await assert.rejects(complete(requestWith()), (error) => {
    assert.ok(error instanceof RetryLaterError);
    assert.equal(error.apiMessage, null);
    assert.equal(error.message.includes('proxy'), false);
    return true;
  });
});

test('a validation error that echoes the request body does not carry the bookmarks into the error', async () => {
  const complete = await setUp('mistral', {
    statusFirst: { status: 422, body: { object: 'error', message: { detail: [{ msg: 'bad', input: { title: 'Mi historia clínica' } }] }, type: 'invalid_request' } },
  });
  await assert.rejects(complete(requestWith()), (error) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.equal(error.apiMessage, null);
    assert.equal(JSON.stringify({ ...error, message: error.message }).includes('historia'), false);
    return true;
  });
});

test('the key never survives in an error, whole or partly quoted', async () => {
  const complete = await setUp('openai', {
    statusFirst: { status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}. Also sk-abc123***xyz is wrong.` } } },
  });
  await assert.rejects(complete(requestWith()), (error) => {
    const everything = `${error.message} ${error.apiMessage} ${JSON.stringify(error)}`;
    assert.equal(everything.includes(KEY), false);
    assert.equal(everything.includes('sk-abc123'), false);
    assert.match(error.apiMessage, /\[key\]/);
    return true;
  });
});

test('a very long API message is cut', async () => {
  const complete = await setUp('openai', { statusFirst: { status: 400, body: { error: { message: 'x'.repeat(5000) } } } });
  await assert.rejects(complete(requestWith()), (error) => error.apiMessage.length === 500);
});

test('a request that gets no response times out and is marked, so the budget can charge it', async () => {
  const complete = await setUp('openai', { hangFirst: 1 }, { timeoutMs: 100 });
  await assert.rejects(complete(requestWith()), (error) => {
    assert.ok(error instanceof RetryLaterError);
    assert.equal(error.timedOut, true);
    assert.equal(error.retryAfterMs, null);
    assert.match(error.message, /timed out/);
    return true;
  });
});

test('a response that stalls after its headers also times out', async () => {
  const complete = await setUp('openai', { hangBodyFirst: 1 }, { timeoutMs: 100 });
  await assert.rejects(complete(requestWith()), (error) => error instanceof RetryLaterError && error.timedOut === true);
});

test('a refused connection is retried, is not a timeout and keeps its cause', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const complete = createOpenAiCompatibleComplete({ provider: 'openai', model: 'gpt-6-luna', apiKey: KEY, baseURL: `http://127.0.0.1:${port}` });
  await assert.rejects(complete(requestWith()), (error) => {
    assert.ok(error instanceof RetryLaterError);
    assert.equal(error.timedOut, false);
    assert.match(error.message, /Connection failed \(ECONNREFUSED\)/);
    assert.ok(error.cause);
    return true;
  });
});

test('a redirect is refused, not retried and not followed', async () => {
  const complete = await setUp('openai', { redirectFirst: 1 });
  await assert.rejects(complete(requestWith()), (error) => !(error instanceof RetryLaterError) && /redirect/.test(error.message));
  assert.equal(fake.requests.length, 1);
});

test('a 200 that is not JSON is an error with its status', async () => {
  const complete = await setUp('openai', { rawFirst: { text: '<html>Welcome to the captive portal</html>' } });
  await assert.rejects(complete(requestWith()), (error) => !(error instanceof RetryLaterError) && /not JSON \(status 200/.test(error.message));
});

for (const [label, body] of [
  ['no choices', { id: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } }],
  ['empty choices', { id: 'x', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }],
  ['a choice without a message', { id: 'x', choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }],
]) {
  test(`a 200 with ${label} is an error, not a TypeError`, async () => {
    const complete = await setUp('openai', { statusFirst: { status: 200, body } });
    await assert.rejects(complete(requestWith()), (error) => !(error instanceof TypeError) && /no choices \(status 200, request-id/.test(error.message));
  });
}

test('perplexity: a 200 without output is an error', async () => {
  const complete = await setUp('perplexity', { statusFirst: { status: 200, body: { status: 'completed' } } });
  await assert.rejects(complete(requestWith()), /Unexpected response status: completed/);
});

test('perplexity: if a search ran anyway, the whole run must stop, not only this model', async () => {
  const complete = await setUp('perplexity');
  await assert.rejects(complete(requestWith('SEARCH_ME')), (error) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.match(error.message, /ran a tool such as a web search/);
    assert.equal(error.stopsRun, true);
    return true;
  });
});

test('no other permanent error stops the whole run', async () => {
  const complete = await setUp('openai', { statusFirst: { status: 401 } });
  await assert.rejects(complete(requestWith()), (error) => error instanceof ProviderRequestError && error.stopsRun === false);
});

// --- What the budget can charge when a call fails ---

/** @param {Parameters<typeof createOpenAiCompatibleComplete>[0]['provider']} model */
function budgeted(complete, model) {
  const budget = createBudget(1);
  return { budget, charged: withBudget(complete, { model, budget, estimateTokens: (text) => text.length, prices: budgetPrices() }) };
}

const NO_CHOICES = { id: 'x', model: 'gpt-6-luna', choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } };

for (const [label, provider, title, options, input, output] of [
  ['an unknown finish_reason', 'gemini', 'ODD_STOP_ME', {}, 100, 50],
  ['no choices', 'openai', 'Pan', { statusFirst: { status: 200, body: NO_CHOICES } }, 100, 50],
  ['a tool that ran', 'perplexity', 'SEARCH_ME', {}, 100, 50],
  ['a status outside the contract', 'perplexity', 'ODD_STOP_ME', {}, 100, 50],
  ['a partway failure', 'deepseek', 'STALL_ME', {}, 100, 50],
]) {
  test(`${provider}: after a 200, ${label} is charged the usage the response reported`, async () => {
    const { budget, charged } = budgeted(await setUp(provider, options), MODELS[provider]);
    await assert.rejects(charged(requestWith(title)), (error) => {
      assert.equal(error.mayHaveBilled, true);
      assert.deepEqual(error.usage, { attempts: [{ model: MODELS[provider], inputTokens: input, outputTokens: output, thinkingTokens: 0, kind: 'message' }] });
      return true;
    });
    const { input: inputPrice, output: outputPrice } = budgetPrices()[MODELS[provider]];
    assert.ok(Math.abs(budget.spentUsd - (input * inputPrice + output * outputPrice) / 1_000_000) < 1e-12, `charged ${budget.spentUsd}`);
  });
}

for (const [label, title, options] of [
  ['no usage', 'NO_USAGE_ME', {}],
  ['a body that is not JSON', 'Pan', { rawFirst: { text: '<html>A captive portal</html>' } }],
  ['a partway failure without usage', 'STALL_ME NO_USAGE_ME', {}],
]) {
  test(`after a 200, ${label} is charged its worst case, because nothing says what it cost`, async () => {
    const { budget, charged } = budgeted(await setUp('deepseek', options), 'deepseek-flash');
    await assert.rejects(charged(requestWith(title)), (error) => {
      assert.equal(error.mayHaveBilled, true);
      assert.equal(error.usage, undefined);
      return true;
    });
    assert.ok(budget.spentUsd > 0);
    assert.equal(budget.lostUsd, budget.spentUsd);
  });
}

for (const [label, options] of [
  ['before any response', { cutFirst: 1 }],
  ['in the middle of the body', { cutBodyFirst: 1 }],
]) {
  test(`a connection cut ${label} is retried and charged its worst case: the provider already had the request`, async () => {
    const { budget, charged } = budgeted(await setUp('openai', options), 'gpt-6-luna');
    await assert.rejects(charged(requestWith()), (error) => {
      assert.ok(error instanceof RetryLaterError);
      assert.equal(error.mayHaveBilled, true);
      assert.equal(error.timedOut, false);
      assert.match(error.message, /Connection failed/);
      return true;
    });
    assert.equal(fake.requests.length, 1, 'the request did arrive');
    assert.ok(budget.spentUsd > 0);
    assert.equal(budget.lostUsd, budget.spentUsd);
  });
}

test('a connection that was never made is not charged: nothing was sent', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const complete = createOpenAiCompatibleComplete({ provider: 'openai', model: 'gpt-6-luna', apiKey: KEY, baseURL: `http://127.0.0.1:${port}` });
  const { budget, charged } = budgeted(complete, 'gpt-6-luna');
  await assert.rejects(charged(requestWith()), (error) => error instanceof RetryLaterError && error.mayHaveBilled === false);
  assert.equal(budget.spentUsd, 0);
});

test('a timeout is marked as possibly billed', async () => {
  const complete = await setUp('openai', { hangFirst: 1 }, { timeoutMs: 100 });
  await assert.rejects(complete(requestWith()), (error) => error.timedOut === true && error.mayHaveBilled === true);
});

for (const status of [400, 429, 500]) {
  test(`an HTTP ${status} is not marked as billed`, async () => {
    const complete = await setUp('openai', { statusFirst: { status } });
    const { budget, charged } = budgeted(complete, 'gpt-6-luna');
    await assert.rejects(charged(requestWith()), (error) => error.mayHaveBilled !== true && error.usage === undefined);
    assert.equal(budget.spentUsd, 0);
  });
}

test('a refused redirect is not marked as billed', async () => {
  const complete = await setUp('openai', { redirectFirst: 1 });
  await assert.rejects(complete(requestWith()), (error) => error.mayHaveBilled !== true);
});

// --- The fake is only worth what it rejects ---

const GOOD_SCHEMA = {
  type: 'json_schema',
  json_schema: { name: 'result', strict: true, schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false } },
};
const MESSAGES = [
  { role: 'system', content: 'Return json.' },
  { role: 'user', content: 'Hello' },
];
const GOOD_BODIES = {
  openai: { model: 'gpt-6-luna', messages: MESSAGES, max_completion_tokens: 10, response_format: GOOD_SCHEMA, store: false },
  gemini: { model: 'gemini-3.1-flash-lite', messages: MESSAGES, max_tokens: 10, response_format: GOOD_SCHEMA },
  mistral: { model: 'mistral-small-2603', messages: MESSAGES, max_tokens: 10, response_format: GOOD_SCHEMA },
  xai: { model: 'grok-4.20-0309-non-reasoning', messages: MESSAGES, max_completion_tokens: 10, response_format: GOOD_SCHEMA },
  deepseek: { model: 'deepseek-flash', messages: MESSAGES, max_tokens: 10, response_format: { type: 'json_object' } },
  perplexity: { model: 'openai/gpt-6-luna', instructions: 'Return json.', input: 'Hello', max_output_tokens: 10, response_format: GOOD_SCHEMA, store: false },
};
const PATHS = { perplexity: '/v1/agent' };

/** @param {keyof typeof GOOD_BODIES} dialect @param {object} body @param {string | undefined} [key] */
async function post(dialect, body, key = KEY) {
  const response = await fetch(`${fake.baseURL}${PATHS[dialect] ?? '/chat/completions'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  return response.status;
}

for (const dialect of ALL_PROVIDERS) {
  test(`fake ${dialect}: accepts the documented request, and refuses it without a key or at the wrong path`, async () => {
    fake = await startFakeOpenAi({ dialect });
    assert.equal(await post(dialect, GOOD_BODIES[dialect]), 200);
    assert.equal(await post(dialect, GOOD_BODIES[dialect], ''), 401);
    const wrongPath = await fetch(`${fake.baseURL}/v1/sonar`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: JSON.stringify(GOOD_BODIES[dialect]) });
    assert.equal(wrongPath.status, 404);
  });
}

const without = (body, key) => Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));
const schemaWith = (schema, name = 'result') => ({ type: 'json_schema', json_schema: { name, strict: true, schema } });
const OPEN_OBJECT = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };

for (const [dialect, label, change, status] of [
  ['openai', 'the deprecated max_tokens', (body) => ({ ...without(body, 'max_completion_tokens'), max_tokens: 10 }), 400],
  ['openai', 'no token cap', (body) => without(body, 'max_completion_tokens'), 400],
  ['openai', 'sampling parameters', (body) => ({ ...body, temperature: 0.2 }), 400],
  ['openai', 'tools', (body) => ({ ...body, tools: [] }), 400],
  ['openai', 'an unknown effort', (body) => ({ ...body, reasoning_effort: 'extreme' }), 400],
  ['openai', 'an unknown model', (body) => ({ ...body, model: 'gpt-nope' }), 404],
  ['openai', 'store left to its default', (body) => without(body, 'store'), 400],
  ['openai', 'a schema that allows extra properties', (body) => ({ ...body, response_format: schemaWith(OPEN_OBJECT) }), 400],
  ['openai', 'a property outside required', (body) => ({ ...body, response_format: schemaWith({ ...OPEN_OBJECT, required: [], additionalProperties: false }) }), 400],
  ['openai', 'a root that is not an object', (body) => ({ ...body, response_format: schemaWith({ type: 'array', items: { type: 'string' } }) }), 400],
  ['openai', 'an unsupported keyword', (body) => ({ ...body, response_format: schemaWith({ type: 'object', allOf: [], properties: {}, required: [], additionalProperties: false }) }), 400],
  ['openai', 'a schema name with spaces', (body) => ({ ...body, response_format: schemaWith(GOOD_SCHEMA.json_schema.schema, 'my schema') }), 400],
  ['openai', 'plain JSON mode', (body) => ({ ...body, response_format: { type: 'json_object' } }), 400],
  ['gemini', 'turning reasoning off on a 3.x model', (body) => ({ ...body, reasoning_effort: 'none' }), 400],
  ['gemini', 'an unrecognized cap name', (body) => ({ ...without(body, 'max_tokens'), max_completion_tokens: 10 }), 400],
  ['mistral', 'an effort not documented for the model', (body) => ({ ...body, reasoning_effort: 'low' }), 422],
  ['mistral', 'a cap that is not an integer', (body) => ({ ...body, max_tokens: '10' }), 422],
  ['xai', 'the deprecated max_tokens', (body) => ({ ...without(body, 'max_completion_tokens'), max_tokens: 10 }), 400],
  ['xai', 'an effort on a model that does not reason', (body) => ({ ...body, reasoning_effort: 'low' }), 400],
  ['xai', 'an empty enum', (body) => ({ ...body, response_format: schemaWith({ type: 'object', properties: { a: { enum: [] } }, required: ['a'], additionalProperties: false }) }), 400],
  ['xai', 'items as an array', (body) => ({ ...body, response_format: schemaWith({ type: 'object', properties: { a: { type: 'array', items: [] } }, required: ['a'], additionalProperties: false }) }), 400],
  ['deepseek', 'a JSON Schema, which it does not have', (body) => ({ ...body, response_format: GOOD_SCHEMA }), 422],
  ['deepseek', 'JSON mode without the word json in the prompt', (body) => ({ ...body, messages: [{ role: 'user', content: 'Hello' }] }), 400],
  ['deepseek', 'a cap out of range', (body) => ({ ...body, max_tokens: 400_000 }), 422],
  ['perplexity', 'the chat shape', (body) => ({ ...body, messages: MESSAGES }), 400],
  ['perplexity', 'disable_search, which the Agent API does not have', (body) => ({ ...body, disable_search: true }), 400],
  ['perplexity', 'a schema name with an underscore', (body) => ({ ...body, response_format: schemaWith(GOOD_SCHEMA.json_schema.schema, 'my_schema') }), 400],
  ['perplexity', 'an Anthropic model without a cap', (body) => ({ ...without(body, 'max_output_tokens'), model: 'anthropic/claude-haiku-5-5' }), 400],
  ['perplexity', 'an unknown reasoning effort', (body) => ({ ...body, reasoning: { effort: 'extreme' } }), 400],
  ['perplexity', 'no input', (body) => without(body, 'input'), 400],
]) {
  test(`fake ${dialect}: rejects ${label} with ${status}`, async () => {
    fake = await startFakeOpenAi({ dialect });
    assert.equal(await post(dialect, change(GOOD_BODIES[dialect])), status);
  });
}

test('fake perplexity: a top-level effort or a search tool answers with search results, as the documented preset would', async () => {
  fake = await startFakeOpenAi({ dialect: 'perplexity' });
  for (const extra of [{ effort: 'fast' }, { tools: [{ type: 'web_search' }] }]) {
    const response = await fetch(`${fake.baseURL}/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ ...GOOD_BODIES.perplexity, ...extra, input: '<bookmarks>\n[]\n</bookmarks>' }),
    });
    const { output } = await response.json();
    assert.equal(output[0].type, 'search_results');
  }
});

// --- Before anything is sent ---

test('without a key, it fails when created, not on the first bookmark', () => {
  assert.throws(() => createOpenAiCompatibleComplete({ provider: 'openai', model: 'gpt-6-luna', apiKey: '' }), /OPENAI_API_KEY is required/);
  assert.throws(() => createOpenAiCompatibleComplete({ provider: 'deepseek', model: 'deepseek-flash' }), /DEEPSEEK_API_KEY is required/);
});

test('a key with a stray line break is refused without quoting it', () => {
  const brokenKey = 'sk-secret\nsecond-line';
  assert.throws(
    () => createOpenAiCompatibleComplete({ provider: 'openai', model: 'gpt-6-luna', apiKey: brokenKey }),
    (error) => /OPENAI_API_KEY has spaces/.test(error.message) && !error.message.includes('secret'),
  );
});

for (const baseURL of ['https://evil.example', 'http://127.0.0.1.evil.example', 'http://127.0.0.1@evil.example', 'not a url']) {
  test(`a base URL outside loopback is refused before sending anything: ${baseURL}`, () => {
    assert.throws(() => createOpenAiCompatibleComplete({ provider: 'openai', model: 'gpt-6-luna', apiKey: KEY, baseURL }), /must be a loopback address/);
  });
}

test('Claude and unknown or excluded providers do not go through this adapter', () => {
  assert.throws(() => createOpenAiCompatibleComplete({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: KEY }), /createClaudeComplete/);
  assert.throws(() => createOpenAiCompatibleComplete({ provider: 'nope', model: 'x', apiKey: KEY }), /Unknown provider/);
  assert.throws(() => createOpenAiCompatibleComplete({ provider: 'copilot', model: 'x', apiKey: KEY }), /GitHub Models was retired/);
});

// --- core/ works unchanged on top of this adapter ---

for (const provider of ALL_PROVIDERS) {
  test(`${provider}: classifyBatch works unchanged, mapping numbers back to folders`, async () => {
    const complete = await setUp(provider);
    const { assignments, unclassified, stats } = await classifyBatch(complete, bookmarks(['Uno', 'Dos', 'Tres', 'Cuatro']), FOLDERS);

    assert.deepEqual(
      assignments.map(({ id, folder, confidence }) => [id, folder, confidence]),
      [
        ['id-0', 'Programación', 'high'],
        ['id-1', 'Cocina', 'high'],
        ['id-2', 'Viajes', 'high'],
        ['id-3', 'Programación', 'high'],
      ],
    );
    assert.deepEqual(unclassified, []);
    assert.equal(stats.calls, 1);
    assert.equal(assignments[0].servedModel, MODELS[provider]);
    assert.ok(assignments[0].requestId);
  });

  test(`${provider}: classifyBatch retries a skipped index`, async () => {
    const complete = await setUp(provider);
    const { assignments, unclassified, stats } = await classifyBatch(complete, bookmarks(['Uno', 'SKIP_ME']), FOLDERS);
    assert.equal(assignments.length, 1);
    assert.deepEqual(unclassified, [{ id: 'id-1', reason: 'missing', refusalCategory: null }]);
    assert.equal(stats.retries, 1);
  });

  test(`${provider}: classifyBatch isolates a refused title by splitting the batch`, async () => {
    const complete = await setUp(provider);
    const { assignments, unclassified, stats } = await classifyBatch(complete, bookmarks(['Uno', 'REFUSE_ME', 'Tres']), FOLDERS);
    assert.deepEqual(
      assignments.map(({ id }) => id).sort(),
      ['id-0', 'id-2'],
    );
    assert.equal(unclassified.length, 1);
    assert.equal(unclassified[0].id, 'id-1');
    assert.equal(unclassified[0].reason, 'refusal');
    assert.ok(stats.splits >= 1);
  });

  test(`${provider}: classifyBatch reports a truncated bookmark`, async () => {
    const complete = await setUp(provider);
    const { unclassified, stats } = await classifyBatch(complete, bookmarks(['TRUNCATE_ME']), FOLDERS);
    assert.deepEqual(unclassified, [{ id: 'id-0', reason: 'truncated', refusalCategory: null }]);
    assert.equal(stats.truncations, 1);
  });

  test(`${provider}: an answer that is not JSON ends as missing, after one paid retry`, async () => {
    const complete = await setUp(provider);
    const { assignments, unclassified, stats } = await classifyBatch(complete, bookmarks(['BAD_JSON_ME']), FOLDERS);
    assert.deepEqual(assignments, []);
    assert.deepEqual(unclassified, [{ id: 'id-0', reason: 'missing', refusalCategory: null }]);
    assert.equal(stats.calls, 2);
  });

  test(`${provider}: proposeTaxonomy works unchanged`, async () => {
    const complete = await setUp(provider);
    const result = await proposeTaxonomy(complete, {
      existingFolders: ['Recetas'],
      sample: bookmarks(['Uno', 'Dos']).map(({ title, url }) => ({ title, url })),
      maxFolders: 5,
      language: 'Spanish',
    });
    assert.deepEqual(
      result.folders.map((folder) => folder.name),
      ['Programación', 'Cocina'],
    );
    assert.equal(result.lastStopReason, 'end_turn');
    assert.equal(result.attempts, 1);
    assert.equal(result.builtFrom, 2);
    assert.equal(result.refusals, 0);
  });

  test(`${provider}: the budget charges the real usage at the catalog price`, async () => {
    const prices = budgetPrices();
    const complete = await setUp(provider);
    const budget = createBudget(1);
    const charged = withBudget(complete, { model: MODELS[provider], budget, estimateTokens: (text) => text.length, prices });
    await charged(requestWith());
    const { input, output } = prices[MODELS[provider]];
    assert.ok(Math.abs(budget.spentUsd - (100 * input + 50 * output) / 1_000_000) < 1e-12);
  });
}

test('deepseek: classifyBatch survives a blanked answer the same way as a skipped one', async () => {
  const complete = await setUp('deepseek');
  const { assignments, unclassified } = await classifyBatch(complete, bookmarks(['BLANK_ME']), FOLDERS);
  assert.deepEqual(assignments, []);
  assert.equal(unclassified[0].reason, 'missing');
});

test('deepseek: a model that ignores the schema in the prompt is stopped by the local validation', async () => {
  const complete = await setUp('deepseek', {
    statusFirst: {
      status: 200,
      count: 2,
      body: {
        id: 'x',
        model: 'deepseek-flash',
        choices: [{ message: { content: JSON.stringify({ assignments: [{ i: 99, f: 99, confidence: 'maybe' }], extra: true }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    },
  });
  const { assignments, unclassified, stats } = await classifyBatch(complete, bookmarks(['Uno']), FOLDERS);
  assert.deepEqual(assignments, []);
  assert.equal(unclassified[0].reason, 'missing');
  assert.equal(stats.invalidEntries, 2);
});

