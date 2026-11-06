import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { createServer } from 'node:http';

import Anthropic from '@anthropic-ai/sdk';

import { buildClassifyRequest } from '../../extension/core/classify.js';
import { createClaudeComplete, failedBeforeSending, messageWith, parseRetryAfter, RetryLaterError, tokenCount } from '../../extension/platform/llm.js';
import { createBudget, withBudget } from '../../extension/core/budget.js';
import { startFakeClaude } from '../helpers/fake-claude.mjs';

const REQUEST = buildClassifyRequest([{ id: 'a', title: 'Pan', url: 'example.com/pan' }], [{ name: 'Programación' }]);

let savedEnvironment;

before(() => {
  savedEnvironment = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

after(() => {
  if (savedEnvironment.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedEnvironment.key;
  if (savedEnvironment.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = savedEnvironment.url;
});

let fake;

/**
 * @param {Parameters<typeof startFakeClaude>[0]} options
 * @param {string} [model]
 * @param {object} [adapterOptions]
 */
async function setUp(options, model = 'claude-haiku-5-5', adapterOptions = {}) {
  fake = await startFakeClaude(options);
  process.env.ANTHROPIC_BASE_URL = fake.baseURL;
  return createClaudeComplete({ Anthropic, model, ...adapterOptions });
}

beforeEach(async () => {
  await fake?.close();
  fake = undefined;
});

after(async () => {
  await fake?.close();
});

test('sends structured output at low effort and no sampling parameters', async () => {
  const complete = await setUp();
  const result = await complete(REQUEST);

  const { url, body } = fake.requests[0];
  assert.match(url, /^\/v1\/messages/);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, REQUEST.maxTokens);
  assert.equal(body.system, REQUEST.system);
  assert.deepEqual(body.output_config, { effort: 'low', format: { type: 'json_schema', schema: REQUEST.schema } });
  for (const forbidden of ['temperature', 'top_p', 'top_k', 'fallbacks', 'betas', 'thinking']) {
    assert.ok(!(forbidden in body), `${forbidden} must not be sent`);
  }

  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(result.data, { assignments: [{ i: 0, f: 0, confidence: 'high' }] });
  assert.deepEqual(result.usage, {
    attempts: [{ model: 'claude-haiku-5-5', inputTokens: 100, outputTokens: 50, thinkingTokens: 0, kind: 'message' }],
    inputTokens: 100,
    outputTokens: 50,
    thinkingTokens: 0,
    usedFallback: false,
  });
  assert.equal(result.servedModel, 'claude-haiku-5-5');
  assert.match(result.requestId ?? '', /^req_fake_\d+$/);
  assert.equal(result.refusalCategory, null);
  assert.ok(result.latencyMs >= 0);
});

test('Haiku gets no server-side fallback even when asked', async () => {
  const complete = await setUp({}, 'claude-haiku-5-5', { fallback: true });
  await complete(REQUEST);
  assert.equal(fake.requests[0].headers['anthropic-beta'], undefined);
});

for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
  test(`${model} sends no fallback unless asked`, async () => {
    const complete = await setUp({}, model);
    await complete(REQUEST);
    assert.equal(fake.requests[0].headers['anthropic-beta'], undefined);
    assert.ok(!('fallbacks' in fake.requests[0].body));
  });

  test(`${model} opts into the default server-side fallback when asked`, async () => {
    const complete = await setUp({}, model, { fallback: true });
    await complete(REQUEST);
    const { headers, body } = fake.requests[0];
    assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(body.fallbacks, 'default');
    assert.ok(!('betas' in body), 'betas travels as a header');
  });
}

/** @param {string} title */
const requestTitled = (title) => buildClassifyRequest([{ id: 'a', title, url: 'example.com' }], [{ name: 'Programación' }]);

test('a refusal is reported without reading content, with its category only', async () => {
  const complete = await setUp();
  const result = await complete(requestTitled('REFUSE_ME'));
  assert.equal(result.stopReason, 'refusal');
  assert.equal(result.data, null);
  assert.equal(result.refusalCategory, 'general_harms');
  assert.ok(!JSON.stringify(result).includes('fake explanation'), 'the explanation text is not kept');
});

test('usage keeps one entry per attempt with its own model', async () => {
  const complete = await setUp(
    {
      servedModel: 'claude-fable-5',
      usage: { input_tokens: 7, output_tokens: 3 },
    },
    'claude-opus-5-5',
    { fallback: true },
  );
  const { usage, servedModel } = await complete(REQUEST);
  assert.equal(servedModel, 'claude-fable-5');
  assert.deepEqual(usage.attempts, [
    { model: 'claude-opus-5-5', inputTokens: 7, outputTokens: 0, thinkingTokens: 0, kind: 'message' },
    { model: 'claude-fable-5', inputTokens: 7, outputTokens: 3, thinkingTokens: 0, kind: 'fallback_message' },
  ]);
  assert.equal(usage.inputTokens, 14);
  assert.equal(usage.outputTokens, 3);
  assert.equal(usage.usedFallback, true);
});

test('an iteration without a model gets the requested one, a fallback gets the served one', async () => {
  const complete = await setUp(
    {
      servedModel: 'claude-fable-5',
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        iterations: [
          { type: 'message', input_tokens: 10, output_tokens: 0 },
          { type: 'fallback_message', input_tokens: 7, output_tokens: 3 },
        ],
      },
    },
    'claude-opus-5-5',
  );
  const { usage } = await complete(REQUEST);
  assert.deepEqual(usage.attempts.map((attempt) => attempt.model), ['claude-opus-5-5', 'claude-fable-5']);
});

test('reasoning tokens are reported apart and stay inside the output', async () => {
  const complete = await setUp();
  const result = await complete(requestTitled('THINK_ME'));
  assert.equal(result.usage.thinkingTokens, 30);
  assert.equal(result.usage.outputTokens, 50);
  assert.deepEqual(result.data, { assignments: [{ i: 0, f: 0, confidence: 'high' }] });
});

test('a thinking block before the text is ignored', async () => {
  const complete = await setUp();
  const result = await complete(requestTitled('THINK_ME'));
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(result.data);
});

test('invalid JSON becomes null data, not a crash, so the batch counts as missing', async () => {
  const complete = await setUp();
  const result = await complete(requestTitled('BAD_JSON_ME'));
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.data, null);
});

test('a truncated answer is reported as max_tokens with null data', async () => {
  const complete = await setUp();
  const result = await complete(requestTitled('TRUNCATE_ME'));
  assert.equal(result.stopReason, 'max_tokens');
  assert.equal(result.data, null);
});

test('effort is configurable and reaches the request', async () => {
  const complete = await setUp({}, 'claude-haiku-5-5', { effort: 'medium' });
  await complete(REQUEST);
  assert.equal(fake.requests[0].body.output_config.effort, 'medium');
});

test('an explicit apiKey and baseURL win over the environment', async () => {
  fake = await startFakeClaude();
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
  const complete = createClaudeComplete({ Anthropic, model: 'claude-haiku-5-5', apiKey: 'explicit-key', baseURL: fake.baseURL });
  await complete(REQUEST);
  assert.equal(fake.requests[0].headers.authorization, 'Bearer explicit-key');
});

test('usage that is missing or not numeric is an error, not zero cost', async () => {
  for (const usage of [{}, { input_tokens: 'many', output_tokens: 5 }, { input_tokens: 5 }]) {
    const complete = await setUp({ usage });
    await assert.rejects(complete(REQUEST), (error) => {
      assert.ok(!(error instanceof RetryLaterError));
      assert.match(error.message, /usage is missing or unusable/);
      return true;
    });
    await fake.close();
  }
});

test('a 200 without content is an error with the status and request-id', async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_nocontent' });
      response.end(JSON.stringify({ id: 'x', type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const complete = createClaudeComplete({ Anthropic, model: 'claude-haiku-5-5' });
    await assert.rejects(complete(REQUEST), (error) => {
      assert.ok(!(error instanceof RetryLaterError));
      assert.match(error.message, /no content \(status 200, request-id req_nocontent\)/);
      return true;
    });
  } finally {
    server.close();
  }
});

test('the fake rejects what the documented contract rejects', async () => {
  fake = await startFakeClaude();
  const post = (body, headers = {}) =>
    fetch(`${fake.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'x' }],
        ...body,
      }),
    });
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };

  assert.equal((await post({ fallbacks: 'default' })).status, 400, 'fallbacks needs the beta header');
  assert.equal((await post({ fallbacks: 'default' }, { 'anthropic-beta': 'server-side-fallback-2026-07-01' })).status, 200);
  assert.equal((await post({ model: 'claude-haiku-5-5', fallbacks: [{ model: 'claude-opus-5-5' }] }, { 'anthropic-beta': 'server-side-fallback-2026-07-01' })).status, 400);
  assert.equal((await post({ output_config: { effort: 'extreme' } })).status, 400);
  assert.equal((await post({ output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: {} } } } })).status, 400);
  assert.equal((await post({ output_config: { effort: 'low', format: { type: 'json_schema', schema } } })).status, 200);
  assert.equal((await post({ output_config: { format: { type: 'json_schema', schema: { ...schema, properties: { a: { type: 'string', maxLength: 3 } } } } } })).status, 400);
  assert.equal((await post({ betas: ['x'] })).status, 400, 'betas travels as a header');
  assert.equal((await post({ model: 'claude-unknown' })).status, 404);

  const rejected = await post({ output_config: { effort: 'extreme' } });
  assert.match(rejected.headers.get('request-id') ?? '', /^req_fake_/);
  assert.match((await rejected.json()).request_id, /^req_fake_/);
});

test('a body the fake cannot interpret gets a 400 and the fake keeps serving', async () => {
  fake = await startFakeClaude({ strict: false });
  const garbage = await fetch(`${fake.baseURL}/v1/messages`, { method: 'POST', body: '{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"no tags"}]}' });
  assert.equal(garbage.status, 200);
  const broken = await fetch(`${fake.baseURL}/v1/messages`, { method: 'POST', body: 'not json' });
  assert.equal(broken.status, 400);
  const empty = await fetch(`${fake.baseURL}/v1/messages`, { method: 'POST', body: '{"messages":[]}' });
  assert.equal(empty.status, 400);
  const still = await fetch(`${fake.baseURL}/v1/messages`, { method: 'POST', body: '"just a string"' });
  assert.equal(still.status, 400);
});

test('classification answers vary with the number of folders', async () => {
  const complete = await setUp();
  const items = [0, 1, 2, 3].map((n) => ({ id: String(n), title: `t${n}`, url: `example.com/${n}` }));
  const { data } = await complete(buildClassifyRequest(items, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]));
  assert.deepEqual(data.assignments.map((entry) => entry.f), [0, 1, 2, 0]);
});

test('a rate limit becomes RetryLaterError without waiting inside the SDK', async () => {
  const complete = await setUp({ rateLimitFirst: 1, retryAfter: '3600' });
  const startedAt = Date.now();
  await assert.rejects(complete(REQUEST), (error) => {
    assert.ok(error instanceof RetryLaterError);
    assert.equal(error.retryAfterMs, 3_600_000);
    return true;
  });
  assert.ok(Date.now() - startedAt < 5000, 'must not sleep on a long retry-after');
  assert.equal(fake.requests.length, 1, 'the SDK must not retry on its own');
});

test('the same adapter maps rate limits on the beta path', async () => {
  const complete = await setUp({ rateLimitFirst: 1, retryAfter: '12' }, 'claude-opus-5-5');
  await assert.rejects(complete(REQUEST), (error) => {
    assert.ok(error instanceof RetryLaterError);
    assert.equal(error.retryAfterMs, 12_000);
    return true;
  });
});

test('a rate limit without a hint leaves the wait to the caller', async () => {
  const complete = await setUp({ rateLimitFirst: 1 });
  await assert.rejects(complete(REQUEST), (error) => error instanceof RetryLaterError && error.retryAfterMs === null);
});

test('an overloaded server becomes RetryLaterError', async () => {
  const complete = await setUp({ serverErrorFirst: 1 });
  await assert.rejects(complete(REQUEST), (error) => error instanceof RetryLaterError);
});

test('an unreachable server becomes RetryLaterError', async () => {
  const closed = await startFakeClaude();
  await closed.close();
  process.env.ANTHROPIC_BASE_URL = closed.baseURL;
  const complete = createClaudeComplete({ Anthropic, model: 'claude-haiku-5-5' });
  await assert.rejects(complete(REQUEST), (error) => error instanceof RetryLaterError && error.retryAfterMs === null);
});

test('a rejected key is a permanent failure, not something to retry', async () => {
  const complete = await setUp({ rejectModel: 'claude-haiku-5-5' });
  await assert.rejects(complete(REQUEST), (error) => error instanceof Anthropic.AuthenticationError);
  assert.equal(fake.requests.length, 1);
});

test('RetryLaterError keeps status, request-id, API message and cause', async () => {
  const complete = await setUp({ rateLimitFirst: 1, retryAfter: '5' });
  await assert.rejects(complete(REQUEST), (error) => {
    assert.ok(error instanceof RetryLaterError);
    assert.equal(error.status, 429);
    assert.match(error.requestId, /^req_fake_/);
    assert.equal(error.apiMessage, 'slow down');
    assert.ok(error.cause instanceof Anthropic.RateLimitError);
    assert.equal(error.timedOut, false);
    assert.match(error.message, /Rate limited: slow down \(request-id req_fake_\d+\)/);
    return true;
  });
});

test('retry-after as an HTTP date is honored and a past date gives null', async () => {
  const future = new Date(Date.now() + 30_000).toUTCString();
  let complete = await setUp({ rateLimitFirst: 1, retryAfter: future });
  await assert.rejects(complete(REQUEST), (error) => {
    assert.ok(error.retryAfterMs > 20_000 && error.retryAfterMs <= 30_000, `got ${error.retryAfterMs}`);
    return true;
  });
  await fake.close();

  complete = await setUp({ rateLimitFirst: 1, retryAfter: new Date(Date.now() - 60_000).toUTCString() });
  await assert.rejects(complete(REQUEST), (error) => error instanceof RetryLaterError && error.retryAfterMs === null);
  await fake.close();

  complete = await setUp({ rateLimitFirst: 1, retryAfter: '0' });
  await assert.rejects(complete(REQUEST), (error) => error instanceof RetryLaterError && error.retryAfterMs === null);
});

test('retry-after-ms wins over retry-after', async () => {
  const complete = await setUp({ rateLimitFirst: 1, retryAfter: '60', retryAfterMs: '1500' });
  await assert.rejects(complete(REQUEST), (error) => error instanceof RetryLaterError && error.retryAfterMs === 1500);
});

for (const status of [408, 409, 500, 502, 504]) {
  test(`status ${status} is retryable later`, async () => {
    const complete = await setUp({ statusFirst: { status } });
    await assert.rejects(complete(REQUEST), (error) => {
      assert.ok(error instanceof RetryLaterError);
      assert.equal(error.status, status);
      assert.match(error.requestId, /^req_fake_/);
      return true;
    });
    assert.equal(fake.requests.length, 1, 'the SDK must not retry on its own');
  });
}

test('x-should-retry false propagates the SDK error even on a 500', async () => {
  const complete = await setUp({ statusFirst: { status: 500, headers: { 'x-should-retry': 'false' } } });
  await assert.rejects(complete(REQUEST), (error) => error instanceof Anthropic.InternalServerError && !(error instanceof RetryLaterError));
});

for (const status of [400, 401, 402, 403, 404, 413]) {
  test(`status ${status} is permanent and keeps its request-id`, async () => {
    const complete = await setUp({ statusFirst: { status } });
    await assert.rejects(complete(REQUEST), (error) => {
      assert.ok(error instanceof Anthropic.APIError && !(error instanceof RetryLaterError));
      assert.equal(error.status, status);
      assert.match(error.requestID, /^req_fake_/);
      return true;
    });
  });
}

test('a timeout is marked timedOut, without a status', async () => {
  const complete = await setUp({ hangFirst: 1 }, 'claude-haiku-5-5', { timeoutMs: 300 });
  await assert.rejects(complete(REQUEST), (error) => {
    assert.ok(error instanceof RetryLaterError);
    assert.equal(error.timedOut, true);
    assert.equal(error.status, null);
    assert.equal(error.retryAfterMs, null);
    return true;
  });
});

test('a refused connection is not marked timedOut and names the reason', async () => {
  const closed = await startFakeClaude();
  await closed.close();
  const complete = createClaudeComplete({ Anthropic, model: 'claude-haiku-5-5', baseURL: closed.baseURL });
  await assert.rejects(complete(REQUEST), (error) => {
    assert.ok(error instanceof RetryLaterError);
    assert.equal(error.timedOut, false);
    assert.match(error.message, /Connection failed \(ECONNREFUSED\)/);
    assert.ok(error.cause);
    return true;
  });
});

test('a redirect is refused and is not retryable', async () => {
  const target = await startFakeClaude();
  const redirector = createServer((request, response) => {
    request.resume();
    response.writeHead(307, { location: `${target.baseURL}/v1/messages` });
    response.end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  try {
    const complete = createClaudeComplete({ Anthropic, model: 'claude-haiku-5-5', baseURL: `http://127.0.0.1:${redirector.address().port}` });
    await assert.rejects(complete(REQUEST), (error) => !(error instanceof RetryLaterError));
    assert.equal(target.requests.length, 0, 'the body must not reach the redirect target');
  } finally {
    redirector.close();
    await target.close();
  }
});

test('stop reasons are normalized to end_turn, max_tokens and refusal', async () => {
  for (const [reason, expected] of [['stop_sequence', 'end_turn'], ['model_context_window_exceeded', 'max_tokens']]) {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'x', type: 'message', model: 'claude-haiku-5-5', stop_reason: reason, content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const complete = createClaudeComplete({ Anthropic, model: 'claude-haiku-5-5', baseURL: `http://127.0.0.1:${server.address().port}` });
      assert.equal((await complete(REQUEST)).stopReason, expected);
    } finally {
      server.close();
    }
  }
});

test('a stop reason outside the neutral set is an error', async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'x', type: 'message', model: 'claude-haiku-5-5', stop_reason: 'pause_turn', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const complete = createClaudeComplete({ Anthropic, model: 'claude-haiku-5-5', baseURL: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(complete(REQUEST), /Unexpected stop_reason: pause_turn/);
  } finally {
    server.close();
  }
});

const PRICES = { 'claude-haiku-5-5': { input: 0.1, output: 0.5 }, 'claude-opus-5-5': { input: 4, output: 20 } };
const count = (text) => text.length / 3;

test('the fake rejects the sampling parameters of API version 2026-10-21', async () => {
  fake = await startFakeClaude();
  for (const extra of [{ temperature: 0 }, { top_p: 0.9 }, { top_k: 5 }]) {
    const response = await fetch(`${fake.baseURL}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }], ...extra }),
    });
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
});

test('the helpers other adapters share are exported', () => {
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '3' })), 3000);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after-ms': '40', 'retry-after': '3' })), 40);
  assert.equal(tokenCount(5, 'x'), 5);
  assert.throws(() => tokenCount(-1, 'output_tokens'), /unusable \(output_tokens\)/);
  assert.equal(messageWith('Rate limited', { requestId: 'req_1', apiMessage: 'slow' }), 'Rate limited: slow (request-id req_1)');
});

test('failedBeforeSending recognizes the never-sent causes anywhere in the chain', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) });
    assert.equal(failedBeforeSending(new Error('wrapped', { cause: error })), true, code);
  }
  for (const code of ['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT']) {
    assert.equal(failedBeforeSending(new Error('x', { cause: Object.assign(new Error('y'), { code }) })), false, code);
  }
  assert.equal(failedBeforeSending(undefined), false);
});

test('a refused connection did not reach the provider: not mayHaveBilled', async () => {
  const closed = await startFakeClaude();
  await closed.close();
  const complete = createClaudeComplete({ Anthropic, model: 'claude-haiku-5-5', baseURL: closed.baseURL });
  await assert.rejects(complete(REQUEST), (error) => error instanceof RetryLaterError && error.mayHaveBilled === false);
});

test('HTTP errors are not mayHaveBilled', async () => {
  for (const status of [429, 500, 529, 400]) {
    const complete = await setUp({ statusFirst: { status } });
    await assert.rejects(complete(REQUEST), (error) => error.mayHaveBilled !== true);
    await fake.close();
  }
});

test('a connection dropped after the request left is retryable and may have billed', async () => {
  const complete = await setUp({ dropFirst: 1 });
  await assert.rejects(complete(REQUEST), (error) => {
    assert.ok(error instanceof RetryLaterError, `got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.mayHaveBilled, true);
    assert.equal(error.timedOut, false);
    return true;
  });
  assert.equal(fake.requests.length, 1);
});

test('a body cut after the headers does not escape as a bare TypeError', async () => {
  const complete = await setUp({ cutBodyFirst: 1 });
  await assert.rejects(complete(REQUEST), (error) => {
    assert.ok(error instanceof RetryLaterError, `got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.mayHaveBilled, true);
    return true;
  });
});

test('a body that stalls after the headers times out instead of hanging', async () => {
  const complete = await setUp({ stallBodyFirst: 1 }, 'claude-haiku-5-5', { timeoutMs: 400 });
  const startedAt = Date.now();
  await assert.rejects(complete(REQUEST), (error) => {
    assert.ok(error instanceof RetryLaterError, `got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.timedOut, true);
    assert.equal(error.mayHaveBilled, true);
    return true;
  });
  assert.ok(Date.now() - startedAt < 3000);
});

test('a timeout implies mayHaveBilled', () => {
  assert.equal(new RetryLaterError('t', null, { timedOut: true }).mayHaveBilled, true);
  assert.equal(new RetryLaterError('t', null).mayHaveBilled, false);
});

test('a 429 for the account spend limit is not retried', async () => {
  const complete = await setUp({ statusFirst: { status: 429, errorCode: 'enforced_spend_limit_reached' } });
  await assert.rejects(complete(REQUEST), (error) => error instanceof Anthropic.RateLimitError && !(error instanceof RetryLaterError));
});

test('a 429 with another error code is still retried later', async () => {
  const complete = await setUp({ statusFirst: { status: 429, errorCode: 'something_else' } });
  await assert.rejects(complete(REQUEST), (error) => error instanceof RetryLaterError);
});

test('a 200 with a stop reason outside the contract is billed: the error carries the usage', async () => {
  const complete = await setUp({ stopReason: 'pause_turn', usage: { input_tokens: 70, output_tokens: 30 } });
  await assert.rejects(complete(REQUEST), (error) => {
    assert.match(error.message, /Unexpected stop_reason/);
    assert.equal(error.mayHaveBilled, true);
    assert.deepEqual(error.usage.attempts, [{ model: 'claude-haiku-5-5', inputTokens: 70, outputTokens: 30, thinkingTokens: 0, kind: 'message' }]);
    return true;
  });
});

test('a paid 200 with unusable usage is mayHaveBilled without usage', async () => {
  const complete = await setUp({ usage: { input_tokens: 'many', output_tokens: 5 } });
  await assert.rejects(complete(REQUEST), (error) => error.mayHaveBilled === true && error.usage === undefined);
});

test('withBudget charges what a 200 with a bad stop reason really cost', async () => {
  const complete = await setUp({ stopReason: 'pause_turn', usage: { input_tokens: 1_000_000, output_tokens: 100 } }, 'claude-haiku-5-5');
  const budget = createBudget(10);
  await assert.rejects(withBudget(complete, { model: 'claude-haiku-5-5', budget, estimateTokens: count, prices: PRICES })(REQUEST));
  assert.equal(budget.spentUsd, 0.1 + 100 * 0.5 / 1_000_000);
});

test('withBudget charges the worst case for a dropped connection', async () => {
  const complete = await setUp({ dropFirst: 1 });
  const budget = createBudget(10);
  await assert.rejects(withBudget(complete, { model: 'claude-haiku-5-5', budget, estimateTokens: count, prices: PRICES })(REQUEST));
  assert.ok(budget.spentUsd > 0 && budget.lostUsd === budget.spentUsd);
});

test('withBudget charges nothing for a refused connection', async () => {
  const closed = await startFakeClaude();
  await closed.close();
  const complete = createClaudeComplete({ Anthropic, model: 'claude-haiku-5-5', baseURL: closed.baseURL });
  const budget = createBudget(10);
  await assert.rejects(withBudget(complete, { model: 'claude-haiku-5-5', budget, estimateTokens: count, prices: PRICES })(REQUEST));
  assert.equal(budget.spentUsd, 0);
});
