import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';

import { buildClassifyRequest } from '../../extension/core/classify.js';
import { CATALOG } from '../../extension/core/models.js';
import { createComplete } from '../../extension/platform/complete-factory.js';
import { describeDataPolicy, EXCLUDED_PROVIDERS, getProvider, PROVIDERS, requiresTrainingConsent, resolveBaseURL } from '../../extension/platform/providers.js';
import { startFakeClaude } from '../helpers/fake-claude.mjs';
import { startFakeOpenAi } from '../helpers/fake-openai.mjs';

const KEY = 'test-key-not-real-1234567890';
const REQUEST = buildClassifyRequest([{ id: 'a', title: 'Pan', url: 'example.com/pan' }], [{ name: 'Cocina' }]);

let fake;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

// --- The registry ---

test('the registry holds exactly the providers with a usable API', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['anthropic', 'deepseek', 'gemini', 'mistral', 'openai', 'perplexity', 'xai']);
  assert.equal(Object.hasOwn(PROVIDERS, 'copilot'), false);
  assert.ok(Object.hasOwn(EXCLUDED_PROVIDERS, 'copilot'));
});

for (const [id, provider] of Object.entries(PROVIDERS)) {
  test(`${id}: the registry entry is complete`, () => {
    assert.equal(provider.id, id);
    assert.match(provider.keyEnv, /^[A-Z]+_API_KEY$/);
    assert.match(provider.baseUrlEnv, /^[A-Z]+_BASE_URL$/);
    assert.match(provider.baseURL, /^https:\/\/[a-z0-9.-]+(\/[a-z0-9/]+)?$/);
    assert.ok(['anthropic-sdk', 'chat-completions', 'responses'].includes(provider.adapter));
    assert.ok(['json_schema', 'json_object'].includes(provider.structuredOutput));
    assert.ok(provider.listing.path.startsWith('/'));
    if (provider.adapter !== 'anthropic-sdk') {
      assert.ok(provider.completionPath?.startsWith('/'));
      assert.ok(provider.maxTokensParam);
    }
    if (provider.adapter === 'chat-completions') {
      assert.equal(provider.finishReasons.stop, 'end_turn');
      assert.equal(provider.finishReasons.length, 'max_tokens');
    }
  });

  test(`${id}: the data policy has every field, with a source and a date`, () => {
    const policy = provider.dataPolicy;
    assert.ok([true, false, 'depends'].includes(policy.trainingByDefault));
    for (const field of ['training', 'retention', 'zeroRetention', 'region']) {
      assert.equal(typeof policy[field], 'string', field);
      assert.ok(policy[field].length > 0, field);
    }
    assert.match(policy.source, /^https:\/\//);
    assert.match(policy.readOn, /^\d{4}-\d{2}-\d{2}$/);
    if (policy.trainingByDefault !== false) assert.ok(policy.accountCheck, 'what the owner has to confirm');
  });

  test(`${id}: has at least one model in the catalog, with the same training flag and output mode`, () => {
    const entries = CATALOG.filter((entry) => entry.provider === id);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.equal(entry.trainingByDefault, provider.dataPolicy.trainingByDefault, entry.ref);
      assert.equal(entry.structuredOutput, provider.structuredOutput, entry.ref);
    }
  });
}

test('Perplexity goes through the Agent API, never Sonar', () => {
  assert.equal(PROVIDERS.perplexity.adapter, 'responses');
  assert.equal(PROVIDERS.perplexity.completionPath, '/v1/agent');
});

test('the finish reasons documented by each provider are mapped', () => {
  assert.equal(PROVIDERS.mistral.finishReasons.model_length, 'max_tokens');
  assert.equal(PROVIDERS.mistral.finishReasons.error, 'retry');
  assert.equal(PROVIDERS.deepseek.finishReasons.insufficient_system_resource, 'retry');
  assert.equal(PROVIDERS.deepseek.finishReasons.aborted, 'retry');
  assert.equal(PROVIDERS.xai.finishReasons.end_turn, 'end_turn');
  assert.equal(PROVIDERS.openai.finishReasons.content_filter, 'refusal');
});

test('the token cap has the name each documentation gives it', () => {
  assert.equal(PROVIDERS.openai.maxTokensParam, 'max_completion_tokens');
  assert.equal(PROVIDERS.xai.maxTokensParam, 'max_completion_tokens');
  assert.equal(PROVIDERS.mistral.maxTokensParam, 'max_tokens');
  assert.equal(PROVIDERS.deepseek.maxTokensParam, 'max_tokens');
  assert.equal(PROVIDERS.perplexity.maxTokensParam, 'max_output_tokens');
});

test('the fixed destinations are the documented hosts', () => {
  const hosts = Object.fromEntries(Object.values(PROVIDERS).map((provider) => [provider.id, new URL(provider.baseURL).hostname]));
  assert.deepEqual(hosts, {
    anthropic: 'api.anthropic.com',
    openai: 'api.openai.com',
    gemini: 'generativelanguage.googleapis.com',
    mistral: 'api.mistral.ai',
    xai: 'api.x.ai',
    deepseek: 'api.deepseek.com',
    perplexity: 'api.perplexity.ai',
  });
});

// --- Lookups ---

test('getProvider knows the registry and nothing else', () => {
  assert.equal(getProvider('openai').name, 'OpenAI');
  assert.throws(() => getProvider('copilot'), /Provider copilot is not available: no usable inference API/);
  assert.throws(() => getProvider('nope'), /Unknown provider "nope". Known providers: anthropic,/);
});

for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
  test(`getProvider does not find ${id} through the prototype chain`, () => {
    assert.throws(() => getProvider(id), /Unknown provider/);
  });
}

test('a provider that trains or depends on the account needs an explicit choice', () => {
  assert.equal(requiresTrainingConsent(PROVIDERS.anthropic), false);
  assert.equal(requiresTrainingConsent(PROVIDERS.openai), false);
  assert.equal(requiresTrainingConsent(PROVIDERS.xai), false);
  assert.equal(requiresTrainingConsent(PROVIDERS.perplexity), false);
  assert.equal(requiresTrainingConsent(PROVIDERS.gemini), true);
  assert.equal(requiresTrainingConsent(PROVIDERS.mistral), true);
  assert.equal(requiresTrainingConsent(PROVIDERS.deepseek), true);
});

test('describeDataPolicy says what trains, what to confirm and where it was read', () => {
  const deepseek = describeDataPolicy(PROVIDERS.deepseek).join('\n');
  assert.match(deepseek, /^DeepSeek: trains by default: yes\. /);
  assert.match(deepseek, /Region: Stored in the People's Republic of China/);
  assert.match(deepseek, /Only you can check: Ask privacy@deepseek\.com/);
  assert.match(deepseek, /Source: https:\/\/cdn\.deepseek\.com\/.* \(read 2026-11-05\)/);

  assert.match(describeDataPolicy(PROVIDERS.gemini)[0], /trains by default: depends on the account/);

  const xai = describeDataPolicy(PROVIDERS.xai).join('\n');
  assert.match(xai, /trains by default: no\. /);
  assert.ok(!xai.includes('Only you can check'), 'nothing to confirm');
});

// --- Where the bookmarks can go ---

test('without an override, the destination is the one in the registry', () => {
  assert.equal(resolveBaseURL(PROVIDERS.openai), 'https://api.openai.com/v1');
  assert.equal(resolveBaseURL(PROVIDERS.openai, undefined), 'https://api.openai.com/v1');
  assert.equal(resolveBaseURL(PROVIDERS.openai, ''), 'https://api.openai.com/v1');
});

for (const local of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080', 'https://localhost:8443', 'http://127.0.0.1:8080/v1']) {
  test(`a loopback override is accepted: ${local}`, () => {
    assert.equal(resolveBaseURL(PROVIDERS.openai, local), local);
  });
}

test('a trailing slash on an override does not double the path', () => {
  assert.equal(resolveBaseURL(PROVIDERS.openai, 'http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
});

for (const bad of [
  'https://api.openai.com/v1',
  'https://evil.example',
  'http://127.0.0.1.evil.example',
  'http://localhost.evil.example',
  'http://evil.example/127.0.0.1',
  'http://127.0.0.1@evil.example',
  'http://user:secret@127.0.0.1:8080',
  'http://10.0.0.1',
  'http://0.0.0.0:8080',
  'ftp://127.0.0.1',
  'file:///etc/passwd',
  'not a url',
]) {
  test(`an override outside loopback is refused without quoting it: ${bad}`, () => {
    assert.throws(
      () => resolveBaseURL(PROVIDERS.openai, bad),
      (error) => /must be a loopback address/.test(error.message) && !error.message.includes('secret') && !error.message.includes('evil'),
    );
  });
}

// --- createComplete ---

test('createComplete sends a chat provider through the fetch adapter', async () => {
  fake = await startFakeOpenAi({ dialect: 'mistral' });
  const complete = createComplete({ ref: 'mistral/ministral-8b-2512', apiKey: KEY, baseURL: fake.baseURL });
  const result = await complete(REQUEST);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(fake.requests[0].body.model, 'ministral-8b-2512');
});

test('createComplete passes the model with its slash to Perplexity', async () => {
  fake = await startFakeOpenAi({ dialect: 'perplexity' });
  const complete = createComplete({ ref: 'perplexity/openai/gpt-6-luna', apiKey: KEY, baseURL: fake.baseURL, effort: 'low' });
  await complete(REQUEST);
  assert.equal(fake.requests[0].body.model, 'openai/gpt-6-luna');
  assert.deepEqual(fake.requests[0].body.reasoning, { effort: 'low' });
});

test('createComplete sends Anthropic through the SDK, with the given key and destination', async () => {
  fake = await startFakeClaude();
  const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'a-key-from-the-environment';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
  try {
    const complete = createComplete({ ref: 'anthropic/claude-haiku-5-5', apiKey: KEY, baseURL: fake.baseURL, Anthropic, effort: 'medium' });
    const result = await complete(REQUEST);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.servedModel, 'claude-haiku-5-5');
    assert.equal(fake.requests.length, 1, 'the base URL in the environment was not used');
    assert.equal(fake.requests[0].body.model, 'claude-haiku-5-5');
    assert.equal(fake.requests[0].body.output_config.effort, 'medium');
    const sentKey = fake.requests[0].headers['x-api-key'] ?? fake.requests[0].headers.authorization;
    assert.ok(String(sentKey).includes(KEY));
  } finally {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved.url;
  }
});

test('createComplete passes fallback on to Anthropic', async () => {
  fake = await startFakeClaude();
  const complete = createComplete({ ref: 'anthropic/claude-sonnet-5-5', apiKey: KEY, baseURL: fake.baseURL, Anthropic, fallback: true });
  await complete(REQUEST);
  assert.equal(fake.requests[0].body.fallbacks, 'default');
});

for (const ref of ['openai/gpt-6-luna', 'gemini/gemini-3.1-flash-lite', 'mistral/ministral-8b-2512', 'xai/grok-4.20-0309-non-reasoning', 'deepseek/deepseek-flash', 'perplexity/openai/gpt-6-luna']) {
  test(`createComplete refuses fallback with ${ref}`, () => {
    assert.throws(() => createComplete({ ref, apiKey: KEY, fallback: true }), /--fallback is only available with Anthropic/);
  });
}

test('createComplete lets through only the effort a catalog model confirms', async () => {
  fake = await startFakeOpenAi({ dialect: 'mistral' });
  const low = createComplete({ ref: 'mistral/mistral-small-2603', apiKey: KEY, baseURL: fake.baseURL, effort: 'low' });
  await low(REQUEST);
  assert.equal('reasoning_effort' in fake.requests[0].body, false);

  const high = createComplete({ ref: 'mistral/mistral-small-2603', apiKey: KEY, baseURL: fake.baseURL, effort: 'high' });
  await high(REQUEST);
  assert.equal(fake.requests[1].body.reasoning_effort, 'high');
});

test('createComplete sends none where it is documented: on DeepSeek it turns reasoning off', async () => {
  fake = await startFakeOpenAi({ dialect: 'deepseek' });
  const complete = createComplete({ ref: 'deepseek/deepseek-flash', apiKey: KEY, baseURL: fake.baseURL, effort: 'none' });
  await complete(REQUEST);
  assert.equal(fake.requests[0].body.reasoning_effort, 'none');
});

test('createComplete does not send an effort to the Grok model that does not reason', async () => {
  fake = await startFakeOpenAi({ dialect: 'xai' });
  const complete = createComplete({ ref: 'xai/grok-4.20-0309-non-reasoning', apiKey: KEY, baseURL: fake.baseURL, effort: 'low' });
  const result = await complete(REQUEST);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal('reasoning_effort' in fake.requests[0].body, false);
});

test('createComplete sends a model outside the catalog as asked, for the caller to decide', async () => {
  fake = await startFakeOpenAi({ dialect: 'gemini' });
  const complete = createComplete({ ref: 'gemini/gemini-4-argon', apiKey: KEY, baseURL: fake.baseURL, effort: 'low' });
  await complete(REQUEST);
  assert.equal(fake.requests[0].body.model, 'gemini-4-argon');
  assert.equal(fake.requests[0].body.reasoning_effort, 'low');
});

test('createComplete requires a key on every path', () => {
  assert.throws(() => createComplete({ ref: 'anthropic/claude-haiku-5-5', apiKey: '', Anthropic }), /ANTHROPIC_API_KEY is required/);
  assert.throws(() => createComplete({ ref: 'openai/gpt-6-luna' }), /OPENAI_API_KEY is required/);
});

test('createComplete requires the SDK class only for Anthropic', () => {
  assert.throws(() => createComplete({ ref: 'anthropic/claude-haiku-5-5', apiKey: KEY }), /Anthropic SDK class is required/);
  assert.doesNotThrow(() => createComplete({ ref: 'openai/gpt-6-luna', apiKey: KEY }));
});

test('createComplete refuses a destination outside loopback, Anthropic included', () => {
  assert.throws(() => createComplete({ ref: 'anthropic/claude-haiku-5-5', apiKey: KEY, baseURL: 'https://proxy.example', Anthropic }), /must be a loopback address/);
  assert.throws(() => createComplete({ ref: 'openai/gpt-6-luna', apiKey: KEY, baseURL: 'https://proxy.example' }), /must be a loopback address/);
});

test('createComplete refuses a malformed reference and an unknown or excluded provider', () => {
  assert.throws(() => createComplete({ ref: 'gpt-6-luna', apiKey: KEY }), /must be provider\/model/);
  assert.throws(() => createComplete({ ref: 'nope/x', apiKey: KEY }), /Unknown provider/);
  assert.throws(() => createComplete({ ref: 'copilot/gpt-6', apiKey: KEY }), /not available/);
});
