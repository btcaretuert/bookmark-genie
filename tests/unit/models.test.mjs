import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { costOf, costOfAttempts } from '../../extension/core/budget.js';
import {
  budgetPrices,
  CATALOG,
  effortFor,
  findModel,
  isExpectedServedModel,
  manifestPrices,
  parseModelRef,
  selectCandidates,
} from '../../extension/core/models.js';
import { PROVIDERS } from '../../extension/platform/providers.js';
import { runModels } from '../../tools/lib/models-cmd.mjs';
import { startFakeOpenAi } from '../helpers/fake-openai.mjs';

const TODAY = '2026-11-05';

// --- parseModelRef ---

for (const [ref, provider, model] of [
  ['anthropic/claude-haiku-5-5', 'anthropic', 'claude-haiku-5-5'],
  ['xai/grok-4.20-0309-non-reasoning', 'xai', 'grok-4.20-0309-non-reasoning'],
  ['perplexity/openai/gpt-6-luna', 'perplexity', 'openai/gpt-6-luna'],
  ['gemini/gemini-2.5-flash-lite', 'gemini', 'gemini-2.5-flash-lite'],
]) {
  test(`parseModelRef splits ${ref} at the first slash`, () => {
    assert.deepEqual(parseModelRef(ref), { provider, model });
  });
}

for (const ref of [
  'claude-haiku-5-5',
  '',
  '/model',
  'provider/',
  'provider//model',
  'provider/model/',
  'Provider/model',
  'provider/mo del',
  'provider/mo\ndel',
  'provider/../../etc/passwd',
  'provider/./model',
  'provider/model?x=1',
  null,
  undefined,
  42,
  ['provider/model'],
]) {
  test(`parseModelRef rejects ${JSON.stringify(ref)}`, () => {
    assert.throws(() => parseModelRef(ref), /must be provider\/model/);
  });
}

// --- The catalog itself ---

test('every catalog entry is complete, sourced and dated', () => {
  for (const entry of CATALOG) {
    const name = entry.ref;
    assert.equal(entry.ref, `${entry.provider}/${entry.id}`, name);
    assert.deepEqual(parseModelRef(entry.ref), { provider: entry.provider, model: entry.id }, name);
    assert.ok(Object.hasOwn(PROVIDERS, entry.provider), `${name}: unknown provider`);
    assert.ok(entry.prices.input > 0 && Number.isFinite(entry.prices.input), `${name}: input price`);
    assert.ok(entry.prices.output > 0 && Number.isFinite(entry.prices.output), `${name}: output price`);
    assert.match(entry.source, /^https:\/\//, `${name}: source`);
    assert.match(entry.readOn, /^\d{4}-\d{2}-\d{2}$/, `${name}: date read`);
    assert.ok(['json_schema', 'json_object'].includes(entry.structuredOutput), `${name}: structured output`);
    assert.ok(entry.effortLevels === null || (Array.isArray(entry.effortLevels) && entry.effortLevels.length > 0), `${name}: effort`);
    assert.ok(['pinned', 'stable-name', 'moving-alias'].includes(entry.idStability), `${name}: id stability`);
    assert.ok([true, false, 'depends'].includes(entry.trainingByDefault), `${name}: training`);
  }
});

test('refs and wire ids are unique, because the budget table is keyed by id', () => {
  assert.equal(new Set(CATALOG.map((entry) => entry.ref)).size, CATALOG.length);
  assert.equal(new Set(CATALOG.map((entry) => entry.id)).size, CATALOG.length);
});

test('no moving alias where a fixed version exists: only DeepSeek, which has none', () => {
  for (const entry of CATALOG) {
    assert.doesNotMatch(entry.id, /latest/, `${entry.ref} is an alias`);
    if (entry.provider === 'deepseek') assert.equal(entry.idStability, 'moving-alias');
    else assert.notEqual(entry.idStability, 'moving-alias', entry.ref);
  }
});

test('a model with a shut-down date already announced nearby stays out', () => {
  for (const id of ['gpt-5-nano', 'gpt-5-mini', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gpt-5.4-nano']) {
    assert.equal(CATALOG.some((entry) => entry.id === id), false, id);
  }
});

test('Mistral Large 4 stays out: as a Preview model it trains on the data, whatever the settings', () => {
  assert.equal(CATALOG.some((entry) => /mistral-large-4/.test(entry.id)), false);
});

test('Perplexity Sonar stays out: its purpose is searching with the content', () => {
  assert.equal(CATALOG.some((entry) => /sonar/.test(entry.id)), false);
});

test('Grok models that reason stay out: the token cap does not bound their reasoning', () => {
  const groks = CATALOG.filter((entry) => entry.provider === 'xai');
  assert.deepEqual(groks.map((entry) => entry.id), ['grok-4.20-0309-non-reasoning']);
  assert.equal(groks[0].effortLevels, null);
});

test('prices match what the documentation said on the date read', () => {
  const expected = {
    'anthropic/claude-haiku-5-5': [0.1, 0.5],
    'anthropic/claude-sonnet-5-5': [2, 10],
    'anthropic/claude-opus-5-5': [4, 20],
    'anthropic/claude-fable-5-1': [10, 50],
    'openai/gpt-6-luna': [0.125, 0.5],
    'gemini/gemini-2.5-flash-lite': [0.1, 0.4],
    'gemini/gemini-3.1-flash-lite': [0.25, 1.5],
    'gemini/gemini-3.5-flash-lite': [0.3, 2.5],
    'mistral/ministral-3b-2512': [0.1, 0.1],
    'mistral/ministral-8b-2512': [0.15, 0.15],
    'mistral/mistral-small-2603': [0.15, 0.6],
    'xai/grok-4.20-0309-non-reasoning': [1.25, 2.5],
    'deepseek/deepseek-flash': [0.3, 1.2],
    'deepseek/deepseek-v4-pro': [1.32, 3.96],
    'perplexity/openai/gpt-6-luna': [0.125, 0.5],
    'perplexity/perplexity/glm-5.3-flash': [0.15, 0.5],
  };
  assert.deepEqual(Object.fromEntries(CATALOG.map((entry) => [entry.ref, [entry.prices.input, entry.prices.output]])), expected);
});

test('DeepSeek is priced at its peak rate, so the budget stays a ceiling', () => {
  const flash = findModel('deepseek/deepseek-flash');
  assert.deepEqual(flash.prices, { input: 0.3, output: 1.2 });
  assert.match(flash.note, /Peak/);
});

test('training flags say what the documentation says, for every provider', () => {
  const expected = { anthropic: false, openai: false, xai: false, perplexity: false, gemini: 'depends', mistral: 'depends', deepseek: true };
  for (const entry of CATALOG) assert.equal(entry.trainingByDefault, expected[entry.provider], entry.ref);
});

test('only DeepSeek has no schema mode', () => {
  for (const entry of CATALOG) assert.equal(entry.structuredOutput, entry.provider === 'deepseek' ? 'json_object' : 'json_schema', entry.ref);
});

// --- Lookups ---

test('findModel finds by reference, and not by a bare id', () => {
  assert.equal(findModel('openai/gpt-6-luna').id, 'gpt-6-luna');
  assert.equal(findModel('perplexity/openai/gpt-6-luna').provider, 'perplexity');
  assert.equal(findModel('gpt-6-luna'), undefined);
  assert.equal(findModel('openai/nope'), undefined);
});

test('effortFor only lets through a level the model confirms', () => {
  const small = findModel('mistral/mistral-small-2603');
  assert.equal(effortFor(small, 'high'), 'high');
  assert.equal(effortFor(small, 'low'), null);
  assert.equal(effortFor(findModel('xai/grok-4.20-0309-non-reasoning'), 'low'), null);
  assert.equal(effortFor(findModel('deepseek/deepseek-flash'), 'medium'), null, 'it maps to high silently, at a higher cost');
  assert.equal(effortFor(findModel('anthropic/claude-haiku-5-5'), 'low'), 'low');
  assert.equal(effortFor(findModel('anthropic/claude-haiku-5-5'), undefined), null);
  assert.equal(effortFor(findModel('anthropic/claude-haiku-5-5'), null), null);
});

test('effortFor accepts none only where the documentation confirms it', () => {
  assert.equal(effortFor(findModel('deepseek/deepseek-flash'), 'none'), 'none');
  assert.equal(effortFor(findModel('openai/gpt-6-luna'), 'none'), 'none');
  assert.equal(effortFor(findModel('gemini/gemini-2.5-flash-lite'), 'none'), 'none');
  assert.equal(effortFor(findModel('mistral/mistral-small-2603'), 'none'), 'none');
  assert.equal(effortFor(findModel('gemini/gemini-3.1-flash-lite'), 'none'), null, 'documented as impossible on 3.x');
  assert.equal(effortFor(findModel('anthropic/claude-haiku-5-5'), 'none'), null);
  assert.equal(effortFor(findModel('perplexity/openai/gpt-6-luna'), 'none'), null, 'not in the reasoning.effort enum');
});

test('the default effort is the documented one, and null where nothing is documented', () => {
  const expected = {
    'deepseek/deepseek-flash': 'high',
    'deepseek/deepseek-v4-pro': 'high',
    'gemini/gemini-2.5-flash-lite': 'none',
    'openai/gpt-6-luna': 'medium',
    'anthropic/claude-haiku-5-5': 'medium',
    'anthropic/claude-sonnet-5-5': 'high',
    'anthropic/claude-opus-5-5': 'medium',
    'anthropic/claude-fable-5-1': 'high',
  };
  for (const entry of CATALOG) assert.equal(entry.defaultEffort, expected[entry.ref] ?? null, entry.ref);
});

test('only the Anthropic models documented with it have a server fallback, and Haiku 5.5 is not one', () => {
  const withFallback = CATALOG.filter((entry) => entry.serverFallback).map((entry) => entry.ref);
  assert.deepEqual(withFallback, ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-fable-5-1']);
});

for (const [ref, served, expected] of [
  ['openai/gpt-6-luna', 'gpt-6-luna', true],
  ['openai/gpt-6-luna', 'gpt-6-luna-2026-05-18', true],
  ['anthropic/claude-haiku-5-5', 'claude-haiku-5-5-20261007', true],
  ['openai/gpt-6-luna', 'gpt-4o-mini-otro-modelo', false],
  ['openai/gpt-6-luna', 'gpt-6-luna-pro', false],
  ['openai/gpt-6-luna', 'gpt-6-luna-2026-05', false],
  ['openai/gpt-6-luna', 'gpt-6-luna-202605', false],
  ['openai/gpt-6-luna', 'xgpt-6-luna', false],
  ['gemini/gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', false],
  ['anthropic/claude-sonnet-5-5', 'claude-fable-5-1', false],
  ['deepseek/deepseek-flash', 'DeepSeek-V4.1-Flash-1017', true],
  ['deepseek/deepseek-v4-pro', 'anything-else', true],
  ['perplexity/openai/gpt-6-luna', 'openai/gpt-6-luna', true],
  ['perplexity/openai/gpt-6-luna', 'gpt-6-luna', true],
  ['perplexity/openai/gpt-6-luna', 'gpt-6-luna-2026-05-18', true],
  ['perplexity/openai/gpt-6-luna', 'luna', false],
  ['perplexity/perplexity/glm-5.3-flash', 'glm-5.3-flash', true],
  ['openai/not-in-the-catalog', 'not-in-the-catalog', true],
  ['openai/not-in-the-catalog', 'other', false],
  ['gemini/gemini-3.5-flash-lite', 'models/gemini-3.5-flash-lite', true],
  ['gemini/gemini-3.5-flash-lite', 'models/other', false],
]) {
  test(`isExpectedServedModel(${ref}, ${served}) is ${expected}`, () => {
    assert.equal(isExpectedServedModel(ref, served), expected);
  });
}

test('only Perplexity may drop the provider prefix of an id', () => {
  assert.equal(isExpectedServedModel('openai/vendor/model', 'model'), false);
});

// --- selectCandidates ---

const ids = (entries) => entries.map((entry) => entry.ref);

test('selectCandidates sorts by input price, then output, then reference', () => {
  const prices = selectCandidates(CATALOG).map((entry) => [entry.prices.input, entry.prices.output]);
  assert.deepEqual(prices, prices.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]));
  assert.equal(ids(selectCandidates(CATALOG))[0], 'mistral/ministral-3b-2512');
});

test('selectCandidates filters by maximum input price, inclusive', () => {
  const entries = selectCandidates(CATALOG, { maxInputPrice: 0.125 });
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.prices.input <= 0.125));
  assert.ok(ids(entries).includes('openai/gpt-6-luna'));
  assert.ok(!ids(entries).includes('mistral/ministral-8b-2512'));
});

test('selectCandidates with a price of zero finds nothing rather than ignoring the filter', () => {
  assert.deepEqual(selectCandidates(CATALOG, { maxInputPrice: 0 }), []);
});

test('requireStructuredOutput leaves out JSON mode', () => {
  const entries = selectCandidates(CATALOG, { requireStructuredOutput: true, allowMovingAlias: true });
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.structuredOutput === 'json_schema'));
  assert.ok(!entries.some((entry) => entry.provider === 'deepseek'));
});

test('excludeTrainingByDefault leaves out a provider that trains and one that depends on the account', () => {
  const entries = selectCandidates(CATALOG, { excludeTrainingByDefault: true, allowMovingAlias: true });
  assert.ok(entries.length > 0);
  assert.deepEqual([...new Set(entries.map((entry) => entry.provider))].sort(), ['anthropic', 'openai', 'perplexity', 'xai']);
});

test('providers restricts the result; an empty list means none', () => {
  assert.ok(selectCandidates(CATALOG, { providers: ['mistral'] }).every((entry) => entry.provider === 'mistral'));
  assert.deepEqual(selectCandidates(CATALOG, { providers: [] }), []);
});

test('a moving alias is left out unless asked for', () => {
  assert.ok(!selectCandidates(CATALOG).some((entry) => entry.idStability === 'moving-alias'));
  assert.ok(selectCandidates(CATALOG, { allowMovingAlias: true }).some((entry) => entry.idStability === 'moving-alias'));
});

test('selectCandidates does not change the catalog', () => {
  const before = ids(CATALOG);
  selectCandidates(CATALOG);
  assert.deepEqual(ids(CATALOG), before);
  assert.ok(Object.isFrozen(CATALOG));
});

// --- The shapes other modules take ---

test('budgetPrices has the table budget.js takes, keyed by wire id', () => {
  const prices = budgetPrices();
  assert.deepEqual(prices['gpt-6-luna'], { input: 0.125, output: 0.5 });
  assert.deepEqual(prices['openai/gpt-6-luna'], { input: 0.125, output: 0.5 });
  assert.equal(Object.hasOwn(prices, 'openai/gpt-5-nano'), false);

  const attempts = [{ model: 'grok-4.20-0309-non-reasoning', inputTokens: 1_000_000, outputTokens: 1_000_000, thinkingTokens: 0, kind: 'message' }];
  assert.equal(costOfAttempts(attempts, 'grok-4.20-0309-non-reasoning', prices), 3.75);
});

test('budgetPrices returns copies: a caller cannot change the catalog through it', () => {
  budgetPrices()['gpt-6-luna'].input = 99;
  assert.equal(findModel('openai/gpt-6-luna').prices.input, 0.125);
});

test('an unknown served model costs the dearest of the table, including a dearer fallback', () => {
  const prices = budgetPrices();
  assert.equal(costOf('some-unknown-fallback', 1_000_000, 1_000_000, prices), 60);
  assert.equal(costOf('claude-fable-5-1', 1_000_000, 1_000_000, prices), 60);
});

test('manifestPrices is keyed by reference and carries its source and date', () => {
  const prices = manifestPrices();
  const entry = prices['perplexity/openai/gpt-6-luna'];
  assert.equal(entry.input, 0.125);
  assert.equal(entry.output, 0.5);
  assert.equal(entry.read_on, '2026-11-05');
  assert.match(entry.source, /^https:\/\/docs\.perplexity\.ai\//);
  assert.equal(Object.keys(prices).length, CATALOG.length);
});

// --- runModels: all of it against local servers ---

let fakes = [];

afterEach(async () => {
  await Promise.all(fakes.map((fake) => fake.close()));
  fakes = [];
});

async function fakeFor(dialect, options = {}) {
  const fake = await startFakeOpenAi({ dialect, ...options });
  fakes.push(fake);
  return fake;
}

/** @param {object} options */
async function run(options) {
  const lines = [];
  const code = await runModels({ env: {}, write: (line) => lines.push(line), today: TODAY, ...options });
  return { code, text: lines.join('\n'), lines };
}

const KEY = 'test-key-not-real-abcdef123456';

test('runModels lists the whole catalog without a key and sends nothing', async () => {
  const { code, text } = await run({});
  assert.equal(code, 0);
  for (const entry of CATALOG) assert.ok(text.includes(entry.ref), entry.ref);
  assert.ok(text.includes('0.125 / 0.5'));
  assert.ok(text.includes('json only'));
  assert.ok(text.includes('depends on account'));
  assert.ok(text.includes('moving-alias'));
  assert.ok(text.includes('not before 2027-10-07'));
});

test('runModels shows the note of each model it lists, such as why a cost is overestimated', async () => {
  const deepseek = await run({ provider: 'deepseek' });
  assert.match(deepseek.text, /deepseek\/deepseek-flash: Peak rate, so the budget stays a ceiling; off-peak is half/);

  const openai = await run({ provider: 'openai' });
  assert.match(openai.text, /openai\/gpt-6-luna: List input is 0\.10\. Priced at the 0\.125 of a cache write/);
  assert.ok(!openai.text.includes('Peak rate'));
});

test('runModels narrows to one provider', async () => {
  const { code, text } = await run({ provider: 'mistral' });
  assert.equal(code, 0);
  assert.ok(text.includes('mistral/ministral-3b-2512'));
  assert.ok(!text.includes('openai/gpt-6-luna'));
});

test('runModels shows the data policy of what it lists, with its source and date', async () => {
  const { text } = await run({ provider: 'gemini' });
  assert.match(text, /Google Gemini: trains by default: depends on the account/);
  assert.match(text, /Only you can check: Confirm the key belongs to a project with active billing/);
  assert.match(text, /Source: https:\/\/aistudio\.google\.com\/docs\/terms \(read 2026-11-05\)/);
  assert.ok(!text.includes('DeepSeek:'));
});

test('--candidates leaves out the policy of a provider with no candidates', async () => {
  const { text } = await run({ candidates: true });
  assert.ok(text.includes('OpenAI: trains by default: no'));
  assert.ok(!text.includes('DeepSeek:'));
  assert.ok(!text.includes('Mistral:'));
});

test('runModels says why Copilot is not available, and fails', async () => {
  const { code, text } = await run({ provider: 'copilot' });
  assert.equal(code, 1);
  assert.match(text, /GitHub Models was retired/);
});

test('runModels fails on an unknown provider', async () => {
  const { code, text } = await run({ provider: 'nope' });
  assert.equal(code, 1);
  assert.match(text, /Unknown provider/);
});

test('--candidates defaults to the privacy-first filters', async () => {
  const { code, text } = await run({ candidates: true });
  assert.equal(code, 0);
  assert.ok(text.includes('openai/gpt-6-luna'));
  assert.ok(!text.includes('deepseek/'));
  assert.ok(!text.includes('gemini/'));
  assert.ok(!text.includes('mistral/'));
});

test('--candidates accepts its own filters and stays within the provider', async () => {
  const { text } = await run({ candidates: { maxInputPrice: 0.1 }, provider: 'gemini' });
  assert.ok(text.includes('gemini/gemini-2.5-flash-lite'));
  assert.ok(!text.includes('gemini/gemini-3.1-flash-lite'));
  assert.ok(!text.includes('openai/gpt-6-luna'));
});

test('--check without any key checks nothing, sends nothing and says so', async () => {
  const fake = await fakeFor('openai');
  const { code, text } = await run({ check: true, env: { OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /openai: skipped, OPENAI_API_KEY is not set/);
  assert.match(text, /Nothing was checked/);
  assert.equal(fake.requests.length, 0);
});

test('--check calls only the providers with a key, and reports new, missing and retiring models', async () => {
  const fake = await fakeFor('openai', {
    listed: [
      { id: 'gpt-6-luna', object: 'model', created: 1, owned_by: 'openai', shutdown_date: '2027-03-01' },
      { id: 'gpt-7-nova', object: 'model', created: 2, owned_by: 'openai', shutdown_date: null },
    ],
  });
  const { code, text } = await run({ check: true, env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /openai: 2 listed, 1 new, 0 missing, 1 retiring or retired/);
  assert.match(text, /new: gpt-7-nova/);
  assert.match(text, /retiring or retired: gpt-6-luna \(retiring 2027-03-01\)/);
  assert.match(text, /anthropic: skipped/);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].url, '/models');
  assert.equal(fake.requests[0].headers.authorization, `Bearer ${KEY}`);
});

test('--check passes when the catalog matches, and a new model alone does not fail it', async () => {
  const fake = await fakeFor('openai', { listed: [{ id: 'gpt-6-luna', shutdown_date: null }, { id: 'gpt-7-nova' }] });
  const { code, text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 0);
  assert.match(text, /1 new, 0 missing, 0 retiring/);
});

test('--check fails when a catalog model disappeared', async () => {
  const fake = await fakeFor('openai', { listed: [{ id: 'gpt-7-nova' }] });
  const { code, text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /missing from the listing: gpt-6-luna/);
});

test('--check: a past shutdown date reads as retired', async () => {
  const fake = await fakeFor('openai', { listed: [{ id: 'gpt-6-luna', shutdown_date: '2026-11-01' }] });
  const { code, text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /gpt-6-luna \(retired 2026-11-01\)/);
});

test('--check: Anthropic sends its version header and reads lifecycle and retires_at', async () => {
  const fake = await fakeFor('anthropic', {
    listed: [
      { id: 'claude-haiku-5-5', lifecycle: 'active', retires_at: null },
      { id: 'claude-sonnet-5-5', lifecycle: 'deprecated', retires_at: null },
      { id: 'claude-opus-5-5', lifecycle: 'deprecated', retires_at: '2027-01-15T00:00:00Z' },
      { id: 'claude-fable-5-1', lifecycle: 'retired', retires_at: '2026-01-01T00:00:00Z' },
    ],
  });
  const { code, text } = await run({ check: true, provider: 'anthropic', env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /claude-sonnet-5-5 \(deprecated\)/);
  assert.match(text, /claude-opus-5-5 \(retiring 2027-01-15\)/);
  assert.match(text, /claude-fable-5-1 \(retired\)/);
  assert.ok(!/claude-haiku-5-5 \(/.test(text));
  assert.equal(fake.requests[0].headers['anthropic-version'], '2026-10-21');
  assert.ok(fake.requests[0].url.startsWith('/v1/models'));
});

test('--check: Gemini strips the prefix of its ids', async () => {
  const fake = await fakeFor('gemini', {
    listed: [{ id: 'models/gemini-2.5-flash-lite' }, { id: 'models/gemini-3.1-flash-lite' }, { id: 'models/gemini-3.5-flash-lite' }],
  });
  const { code, text } = await run({ check: true, provider: 'gemini', env: { GEMINI_API_KEY: KEY, GEMINI_BASE_URL: fake.baseURL } });
  assert.equal(code, 0);
  assert.match(text, /3 listed, 0 new, 0 missing/);
});

test('--check: Mistral reads deprecation and archived', async () => {
  const fake = await fakeFor('mistral', {
    listed: [
      { id: 'ministral-3b-2512', deprecation: '2027-02-01' },
      { id: 'ministral-8b-2512', archived: true },
      { id: 'mistral-small-2603' },
    ],
  });
  const { code, text } = await run({ check: true, provider: 'mistral', env: { MISTRAL_API_KEY: KEY, MISTRAL_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /ministral-3b-2512 \(retiring 2027-02-01\)/);
  assert.match(text, /ministral-8b-2512 \(archived\)/);
});

test('--check: Perplexity keeps the slash in its ids', async () => {
  const fake = await fakeFor('perplexity', { listed: [{ id: 'openai/gpt-6-luna' }, { id: 'perplexity/glm-5.3-flash' }] });
  const { code } = await run({ check: true, provider: 'perplexity', env: { PERPLEXITY_API_KEY: KEY, PERPLEXITY_BASE_URL: fake.baseURL } });
  assert.equal(code, 0);
  assert.equal(fake.requests[0].url, '/v1/models');
});

test('--check never prints the key, even when the API echoes it', async () => {
  const fake = await fakeFor('openai', { statusFirst: { status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } } });
  const { code, text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /the listing failed: status 401: Incorrect API key provided: \[redacted\]/);
  assert.equal(text.includes(KEY), false);
});

test('--check does not follow a redirect with the key', async () => {
  const fake = await fakeFor('openai', { redirectFirst: 1, listed: [{ id: 'gpt-6-luna' }] });
  const { code, text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /the listing failed/);
  assert.equal(fake.requests.length, 1);
});

test('--check: a key with a line break, which fetch would quote in its error, is not printed either', async () => {
  const fake = await fakeFor('openai');
  const broken = `${KEY}\nsecond-line-of-the-key`;
  const { code, text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: broken, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes('second-line-of-the-key'), false);
});

test('--check refuses a base URL outside loopback before sending the key anywhere', async () => {
  const { code, text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://evil.example/v1' } });
  assert.equal(code, 1);
  assert.match(text, /must be a loopback address/);
  assert.equal(text.includes('evil.example'), false);
});

test('--check: a server that does not answer a listing fails that provider', async () => {
  const fake = await fakeFor('openai');
  await fake.close();
  const { code, text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /the listing failed/);
});

test('--check: a listing with an unexpected shape fails instead of reporting everything as missing', async () => {
  const fake = await fakeFor('openai', { statusFirst: { status: 200, body: { models: [] } } });
  const { code, text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(code, 1);
  assert.match(text, /has no data array/);
});

test('--check: an id with terminal escapes cannot reach the terminal', async () => {
  const fake = await fakeFor('openai', { listed: [{ id: 'gpt-6-luna' }, { id: 'evil\u001b]0;pwned\u0007model' }] });
  const { text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.equal(/[\u0000-\u001f]/.test(text.replaceAll('\n', '')), false);
});

test('--check shows a long list of new models with a count, not all of it', async () => {
  const listed = [{ id: 'gpt-6-luna' }, ...Array.from({ length: 45 }, (_, index) => ({ id: `other-${index}` }))];
  const fake = await fakeFor('openai', { listed });
  const { text } = await run({ check: true, provider: 'openai', env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseURL } });
  assert.match(text, /and 5 more/);
  assert.ok(!text.includes('other-44'));
});
