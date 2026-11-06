/**
 * Spending cap. Pure: no console, no waiting. Retry policy lives with the caller.
 *
 * @typedef {{model: string, maxTokens: number, outputTokens: number}} CapBreach
 * @typedef {{spentUsd: number, maxUsd: number, lostUsd: number, capBrokenBy: CapBreach | null}} Budget
 *   `lostUsd` is the part of `spentUsd` charged for calls that gave no usable answer: at the
 *   worst case if they reported no usage, at their real usage if they did.
 *   `capBrokenBy`: a provider answered with more output than `max_tokens`, so the worst case
 *   this budget relies on is not a ceiling for it.
 */

/**
 * Bytes/3 already overshoots ordinary text, but URLs and JSON punctuation tokenize worse and
 * the newer tokenizer yields about 30 % more tokens (same pricing page). Input is cheap next
 * to the output allowance, so the worst case pays the margin: a cap that stops a little
 * early is better than one that is crossed.
 */
export const INPUT_ESTIMATE_MARGIN = 1.3;

export class BudgetExceededError extends Error {}

/**
 * @typedef {Record<string, {input: number, output: number}>} PriceTable USD per million tokens by model id
 */

/**
 * @param {string} model
 * @param {PriceTable} prices
 */
function priceOf(model, prices) {
  if (Object.hasOwn(prices, model)) return prices[model];
  // An id the table does not know (a fallback model, a dated alias) costs at least as much as
  // the dearest known one, so the total never undercounts.
  const known = Object.values(prices);
  return {
    input: Math.max(0, ...known.map((price) => price.input)),
    output: Math.max(0, ...known.map((price) => price.output)),
  };
}

/**
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {PriceTable} prices the provider catalog
 */
export function costOf(model, inputTokens, outputTokens, prices) {
  const price = priceOf(model, prices);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Each attempt at the rate of the model that ran it. Reasoning is already inside
 * `outputTokens`, so `thinkingTokens` is not added again.
 *
 * @param {{model?: string, inputTokens: number, outputTokens: number}[]} attempts
 * @param {string} requestedModel used for an attempt that names no model
 * @param {PriceTable} prices
 */
export function costOfAttempts(attempts, requestedModel, prices) {
  return attempts.reduce(
    (total, attempt) => total + costOf(attempt.model || requestedModel, attempt.inputTokens, attempt.outputTokens, prices),
    0,
  );
}

/** @param {number} usd */
export const formatUsd = (usd) => `US$${usd.toFixed(4)}`;

/** @param {number} maxUsd */
export function createBudget(maxUsd) {
  return { spentUsd: 0, maxUsd, lostUsd: 0, capBrokenBy: null };
}

/**
 * The check uses the worst case of the next call, so the cap holds as a ceiling instead of
 * being noticed after it has been crossed.
 *
 * @param {{spentUsd: number, maxUsd: number}} budget
 * @param {number} worstCaseUsd
 */
export function assertWithinBudget(budget, worstCaseUsd) {
  if (budget.spentUsd + worstCaseUsd > budget.maxUsd) {
    throw new BudgetExceededError(`Next call could exceed the ${formatUsd(budget.maxUsd)} cap`);
  }
}

/**
 * Highest price the call can reach. With a server-side fallback, a declined attempt and the
 * fallback attempt can both be billed, the second at a model this table may not know.
 *
 * @param {import('./types.js').CompletionRequest} request
 * @param {{model: string, estimateTokens: (text: string) => number, mayFallback?: boolean, prices: PriceTable}} options
 */
export function worstCaseUsd(request, { model, estimateTokens, mayFallback = false, prices }) {
  const inputTokens = Math.ceil(estimateTokens(request.system + request.user + JSON.stringify(request.schema)) * INPUT_ESTIMATE_MARGIN);
  const once = costOf(model, inputTokens, request.maxTokens, prices);
  return mayFallback ? once + costOf('', inputTokens, request.maxTokens, prices) : once;
}

/**
 * Checks the worst case before each call and charges the real usage after it.
 *
 * Every error thrown after the request may have reached the provider carries
 * `mayHaveBilled`. If it also carries `usage.attempts` (a 200 whose body was unusable) the
 * real cost is charged; otherwise the worst case is, and it is counted as lost. The cap stays
 * a ceiling at the price of a pessimistic total. Placed inside the caller's retry loop, every
 * such attempt is charged. How many times to retry is the caller's decision.
 *
 * The worst case assumes the provider honors `max_tokens`. If an answer exceeds it, the
 * paid answer is returned and the next call is refused: the cap cannot be guaranteed with
 * that provider.
 *
 * @param {import('./types.js').Complete} complete
 * @param {{model: string, budget: Budget, estimateTokens: (text: string) => number, mayFallback?: boolean, prices: PriceTable}} options
 * @returns {import('./types.js').Complete}
 */
export function withBudget(complete, { model, budget, estimateTokens, mayFallback = false, prices }) {
  /**
   * @param {{model?: string, inputTokens: number, outputTokens: number}[]} attempts
   * @param {number} maxTokens
   */
  function charge(attempts, maxTokens) {
    budget.spentUsd += costOfAttempts(attempts, model, prices);
    const over = attempts.find((attempt) => attempt.outputTokens > maxTokens);
    if (over) budget.capBrokenBy ??= { model: over.model || model, maxTokens, outputTokens: over.outputTokens };
  }

  return async (request) => {
    if (budget.capBrokenBy) {
      const { model: broken, maxTokens, outputTokens } = budget.capBrokenBy;
      throw new BudgetExceededError(
        `${broken} returned ${outputTokens} output tokens for max_tokens ${maxTokens}: that provider did not respect the maximum, so the ${formatUsd(budget.maxUsd)} cap cannot be guaranteed with it. Try --effort none if the model supports it`,
      );
    }
    const worst = worstCaseUsd(request, { model, estimateTokens, mayFallback, prices });
    assertWithinBudget(budget, worst);
    try {
      const result = await complete(request);
      charge(result.usage.attempts, request.maxTokens);
      return result;
    } catch (error) {
      const failure = /** @type {{mayHaveBilled?: unknown, timedOut?: unknown, usage?: {attempts?: unknown}} | null} */ (error);
      if (Array.isArray(failure?.usage?.attempts)) {
        const before = budget.spentUsd;
        charge(failure.usage.attempts, request.maxTokens);
        budget.lostUsd += budget.spentUsd - before;
      } else if (failure?.mayHaveBilled === true || failure?.timedOut === true) {
        budget.spentUsd += worst;
        budget.lostUsd += worst;
      }
      throw error;
    }
  };
}
