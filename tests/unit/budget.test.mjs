import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertWithinBudget, BudgetExceededError, costOf, formatUsd } from '../../extension/core/budget.js';

const HAIKU_OPUS = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

test('cost applies the per-million prices of the model', () => {
  assert.equal(costOf('claude-haiku-5-5', 1_000_000, 1_000_000, HAIKU_OPUS), 0.1 + 0.5);
  assert.equal(costOf('claude-opus-5-5', 500_000, 0, HAIKU_OPUS), 2);
});

test('prices are mandatory: there is no provider-specific default table', () => {
  assert.throws(() => costOf('claude-haiku-5-5', 1, 1, undefined));
});

test('the budget check uses spent plus the worst case of the next call', () => {
  const budget = { spentUsd: 0.5, maxUsd: 1 };
  assertWithinBudget(budget, 0.5);
  assert.throws(() => assertWithinBudget(budget, 0.5001), BudgetExceededError);
});

test('usd is formatted with four decimals', () => {
  assert.equal(formatUsd(0.5), 'US$0.5000');
});

import { costOfAttempts, createBudget, INPUT_ESTIMATE_MARGIN, withBudget, worstCaseUsd } from '../../extension/core/budget.js';

const CATALOG = { 'a/cheap': { input: 1, output: 2 }, 'a/dear': { input: 10, output: 20 } };
const result = (attempts) => ({
  data: {},
  stopReason: 'end_turn',
  refusalCategory: null,
  servedModel: 'a/cheap',
  requestId: null,
  latencyMs: 0,
  usage: { attempts, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, usedFallback: false },
});
const REQUEST = { system: 'x'.repeat(300), user: 'y'.repeat(300), schema: {}, maxTokens: 1000 };
const count = (text) => text.length / 3;

test('each attempt is priced at its own model and unknown models at the dearest known rate', () => {
  const attempts = [
    { model: 'a/cheap', inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0, kind: 'message' },
    { model: 'other', inputTokens: 1_000_000, outputTokens: 1_000_000, thinkingTokens: 0, kind: 'fallback_message' },
  ];
  assert.equal(costOfAttempts(attempts, 'a/cheap', CATALOG), 1 + 10 + 20);
});

test('an attempt without a model uses the requested one, and thinking is not charged twice', () => {
  const attempts = [{ model: '', inputTokens: 0, outputTokens: 1_000_000, thinkingTokens: 900_000, kind: 'message' }];
  assert.equal(costOfAttempts(attempts, 'a/dear', CATALOG), 20);
});

test('an inherited property name is not a price', () => {
  assert.equal(costOfAttempts([{ model: 'constructor', inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0, kind: 'message' }], 'x', CATALOG), 10);
});

test('the worst case adds the input margin and the full output allowance', () => {
  const inputTokens = Math.ceil(count('x'.repeat(300) + 'y'.repeat(300) + '{}') * INPUT_ESTIMATE_MARGIN);
  const expected = (inputTokens * 1 + 1000 * 2) / 1_000_000;
  assert.equal(worstCaseUsd(REQUEST, { model: 'a/cheap', estimateTokens: count, prices: CATALOG }), expected);
});

test('a possible fallback doubles the worst case at the dearest rate', () => {
  const single = worstCaseUsd(REQUEST, { model: 'a/cheap', estimateTokens: count, prices: CATALOG });
  const withFallback = worstCaseUsd(REQUEST, { model: 'a/cheap', estimateTokens: count, mayFallback: true, prices: CATALOG });
  assert.ok(withFallback > single * 5);
});

test('withBudget refuses a call whose worst case crosses the cap, without calling', async () => {
  const budget = createBudget(0.0001);
  let calls = 0;
  const guarded = withBudget(async () => { calls += 1; return result([]); }, { model: 'a/dear', budget, estimateTokens: count, prices: CATALOG });
  await assert.rejects(guarded(REQUEST), BudgetExceededError);
  assert.equal(calls, 0);
});

test('withBudget charges the real usage of every attempt', async () => {
  const budget = createBudget(10);
  const attempts = [
    { model: 'a/dear', inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0, kind: 'message' },
    { model: 'a/cheap', inputTokens: 0, outputTokens: 1_000_000, thinkingTokens: 0, kind: 'fallback_message' },
  ];
  await withBudget(async () => result(attempts), { model: 'a/dear', budget, estimateTokens: count, prices: CATALOG })(REQUEST);
  assert.equal(budget.spentUsd, 12);
  assert.equal(budget.lostUsd, 0);
});

test('a timeout is charged at its worst case and counted as lost', async () => {
  const budget = createBudget(10);
  const timedOut = Object.assign(new Error('t'), { timedOut: true });
  const guarded = withBudget(async () => { throw timedOut; }, { model: 'a/cheap', budget, estimateTokens: count, prices: CATALOG });
  await assert.rejects(guarded(REQUEST), (error) => error === timedOut);
  const worst = worstCaseUsd(REQUEST, { model: 'a/cheap', estimateTokens: count, prices: CATALOG });
  assert.equal(budget.spentUsd, worst);
  assert.equal(budget.lostUsd, worst);
});

test('other failures cost nothing', async () => {
  const budget = createBudget(10);
  const guarded = withBudget(async () => { throw new Error('boom'); }, { model: 'a/cheap', budget, estimateTokens: count, prices: CATALOG });
  await assert.rejects(guarded(REQUEST), /boom/);
  assert.equal(budget.spentUsd, 0);
});

test('an error that may have billed, with no usage, is charged at its worst case and counted as lost', async () => {
  const budget = createBudget(10);
  const failure = Object.assign(new Error('cut'), { mayHaveBilled: true });
  const guarded = withBudget(async () => { throw failure; }, { model: 'a/cheap', budget, estimateTokens: count, prices: CATALOG });
  await assert.rejects(guarded(REQUEST), (error) => error === failure);
  const worst = worstCaseUsd(REQUEST, { model: 'a/cheap', estimateTokens: count, prices: CATALOG });
  assert.equal(budget.spentUsd, worst);
  assert.equal(budget.lostUsd, worst);
});

test('an error that carries the usage it was paid for is charged that, not the worst case', async () => {
  const budget = createBudget(10);
  const attempts = [{ model: 'a/dear', inputTokens: 100_000, outputTokens: 50_000, thinkingTokens: 0, kind: 'message' }];
  const failure = Object.assign(new Error('unknown finish_reason'), { mayHaveBilled: true, usage: { attempts } });
  const guarded = withBudget(async () => { throw failure; }, { model: 'a/dear', budget, estimateTokens: count, prices: CATALOG });
  await assert.rejects(guarded(REQUEST));
  assert.equal(budget.spentUsd, 1 + 1);
  assert.equal(budget.lostUsd, 2);
});

test('an error before anything was sent costs nothing', async () => {
  const budget = createBudget(10);
  const failure = Object.assign(new Error('refused'), { mayHaveBilled: false });
  const guarded = withBudget(async () => { throw failure; }, { model: 'a/cheap', budget, estimateTokens: count, prices: CATALOG });
  await assert.rejects(guarded(REQUEST));
  assert.deepEqual([budget.spentUsd, budget.lostUsd], [0, 0]);
});

test('an answer above max_tokens is kept and charged, then the next call is refused', async () => {
  const budget = createBudget(0.05);
  const attempts = [{ model: 'a/dear', inputTokens: 100, outputTokens: 30_000, thinkingTokens: 0, kind: 'message' }];
  let calls = 0;
  const guarded = withBudget(async () => { calls += 1; return result(attempts); }, { model: 'a/dear', budget, estimateTokens: count, prices: CATALOG });
  const first = await guarded(REQUEST);
  assert.equal(first.usage.attempts, attempts, 'the paid answer is returned');
  assert.ok(budget.spentUsd > budget.maxUsd);
  assert.deepEqual(budget.capBrokenBy, { model: 'a/dear', maxTokens: 1000, outputTokens: 30_000 });
  await assert.rejects(guarded(REQUEST), (error) => {
    assert.ok(error instanceof BudgetExceededError);
    assert.match(error.message, /a\/dear returned 30000 output tokens for max_tokens 1000/);
    assert.match(error.message, /did not respect the maximum/);
    assert.match(error.message, /--effort none/);
    return true;
  });
  assert.equal(calls, 1);
});

test('an answer exactly at max_tokens does not break the cap', async () => {
  const budget = createBudget(10);
  const attempts = [{ model: 'a/cheap', inputTokens: 1, outputTokens: 1000, thinkingTokens: 0, kind: 'message' }];
  await withBudget(async () => result(attempts), { model: 'a/cheap', budget, estimateTokens: count, prices: CATALOG })(REQUEST);
  assert.equal(budget.capBrokenBy, null);
});

test('a paid error answer above max_tokens also breaks the cap', async () => {
  const budget = createBudget(10);
  const attempts = [{ model: 'a/cheap', inputTokens: 1, outputTokens: 5000, thinkingTokens: 0, kind: 'message' }];
  const failure = Object.assign(new Error('bad'), { mayHaveBilled: true, usage: { attempts } });
  await assert.rejects(withBudget(async () => { throw failure; }, { model: 'a/cheap', budget, estimateTokens: count, prices: CATALOG })(REQUEST));
  assert.equal(budget.capBrokenBy?.outputTokens, 5000);
});
