/**
 * Claude adapter for the `complete(request)` port used by core/.
 *
 * The SDK class is injected: Node tools pass the npm package and the extension passes its
 * bundled copy, and neither path leaks into core/.
 */

/** Models that can retry a refusal on another model on the server. Claude Haiku 5.5 cannot. */
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A failure unrelated to the bookmarks: try the same request later. The caller's queue owns
 * this decision because the wait can outlive the page or service worker that made the call.
 */
export class RetryLaterError extends Error {
  /**
   * @param {string} message
   * @param {number | null} retryAfterMs null when the server gave no hint
   * @param {{status?: number | null, requestId?: string | null, apiMessage?: string | null, cause?: unknown, timedOut?: boolean, mayHaveBilled?: boolean}} [details]
   *   `timedOut`: the client gave up waiting; it drives the retry policy and implies
   *   `mayHaveBilled`. `mayHaveBilled`: the request may have reached the provider and been
   *   charged even though no usage came back (a timeout, a connection cut after sending).
   */
  constructor(message, retryAfterMs, { status = null, requestId = null, apiMessage = null, cause, timedOut = false, mayHaveBilled = false } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RetryLaterError';
    this.retryAfterMs = retryAfterMs;
    this.status = status;
    this.requestId = requestId;
    this.apiMessage = apiMessage;
    this.timedOut = timedOut;
    this.mayHaveBilled = mayHaveBilled || timedOut;
  }
}

const NEVER_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
]);
/** TLS fails during the handshake, before the request is written. */
const NEVER_SENT_PREFIXES = ['CERT_', 'UNABLE_TO_', 'DEPTH_ZERO', 'SELF_SIGNED', 'ERR_TLS_'];

/**
 * True when the failure happened before any byte of the request reached the provider, so
 * nothing can have been billed. Walks the `cause` chain because fetch wraps the system error
 * (`TypeError: fetch failed` -> `cause.code`) and the SDK wraps that again.
 *
 * @param {unknown} error
 */
export function failedBeforeSending(error) {
  let current = /** @type {any} */ (error);
  for (let depth = 0; depth < 6 && current; depth += 1, current = current.cause) {
    if (typeof current.code === 'string' && (NEVER_SENT_CODES.has(current.code) || NEVER_SENT_PREFIXES.some((prefix) => current.code.startsWith(prefix)))) return true;
  }
  return false;
}

/**
 * `retry-after-ms` wins over `retry-after`, as in the SDK. A past date or a zero gives null.
 *
 * @param {Headers | undefined} headers
 * @returns {number | null}
 */
export function parseRetryAfter(headers) {
  const millis = Number(headers?.get('retry-after-ms'));
  if (Number.isFinite(millis) && millis > 0) return millis;

  const value = headers?.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : null;
  const waitMs = Date.parse(value) - Date.now();
  return waitMs > 0 ? waitMs : null;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
export function tokenCount(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Response usage is missing or unusable (${field})`);
  }
  return value;
}

/**
 * One entry per attempt, each with its own model: tokens of different models are never
 * summed into one price. Top-level `usage` only covers the attempt that produced the message;
 * `usage.iterations` lists every attempt when a fallback ran. A declined attempt can be
 * listed without being billed, so the sum is a ceiling.
 *
 * Cache tokens are added to the input because their price is a multiple of it that this
 * code does not track, and this code never asks for caching.
 *
 * @param {any} usage
 * @param {string} requestedModel
 * @param {string} servedModel
 * @returns {import('../core/types.js').UsageAttempt[]}
 */
function summarizeAttempts(usage, requestedModel, servedModel) {
  if (usage === null || typeof usage !== 'object') throw new Error('Response usage is missing or unusable (usage)');

  /** @param {any} entry */
  const inputOf = (entry) =>
    tokenCount(entry.input_tokens, 'input_tokens') +
    (Number.isFinite(entry.cache_creation_input_tokens) ? entry.cache_creation_input_tokens : 0) +
    (Number.isFinite(entry.cache_read_input_tokens) ? entry.cache_read_input_tokens : 0);

  const iterations = Array.isArray(usage.iterations)
    ? usage.iterations.filter((/** @type {any} */ entry) => entry?.type === 'message' || entry?.type === 'fallback_message')
    : [];
  /** @type {import('../core/types.js').UsageAttempt[]} */
  const attempts = (iterations.length > 0 ? iterations : [{ type: 'message', ...usage }]).map((/** @type {any} */ entry) => {
    const kind = entry.type === 'fallback_message' ? 'fallback_message' : 'message';
    return {
      model: typeof entry.model === 'string' && entry.model !== '' ? entry.model : kind === 'fallback_message' ? servedModel : requestedModel,
      inputTokens: inputOf(entry),
      outputTokens: tokenCount(entry.output_tokens, 'output_tokens'),
      thinkingTokens: 0,
      kind,
    };
  });

  // Reasoning is part of output_tokens; the API only breaks it down for the whole message,
  // and the message comes from the last attempt.
  const thinking = usage.output_tokens_details?.thinking_tokens;
  const last = attempts[attempts.length - 1];
  if (Number.isFinite(thinking) && thinking > 0) last.thinkingTokens = Math.min(thinking, last.outputTokens);
  return attempts;
}

/**
 * The contract's stop reasons are provider-neutral: end_turn, max_tokens, refusal. Anything
 * else cannot come from a request without tools or stop sequences, so it is an error rather
 * than a value the callers would have to guess about.
 *
 * @param {unknown} reason
 * @returns {'end_turn' | 'max_tokens' | 'refusal'}
 */
function neutralStopReason(reason) {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end_turn';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'max_tokens';
  if (reason === 'refusal') return 'refusal';
  throw new Error(`Unexpected stop_reason: ${String(reason)}`);
}

/** @param {any[]} content */
function parseJsonText(content) {
  const text = content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {any} error
 * @returns {{status: number | null, requestId: string | null, apiMessage: string | null}}
 */
function describeError(error) {
  return {
    status: typeof error.status === 'number' ? error.status : null,
    requestId: error.requestID ?? null,
    apiMessage: error.apiMessage ?? null,
  };
}

/**
 * @param {string} base
 * @param {{requestId: string | null, apiMessage: string | null}} details
 */
export function messageWith(base, { requestId, apiMessage }) {
  return `${base}${apiMessage ? `: ${apiMessage}` : ''}${requestId ? ` (request-id ${requestId})` : ''}`;
}

/**
 * @param {{
 *   Anthropic: any,
 *   model: string,
 *   apiKey?: string,
 *   baseURL?: string,
 *   allowBrowser?: boolean,
 *   timeoutMs?: number,
 *   effort?: 'low' | 'medium' | 'high',
 *   fallback?: boolean,
 * }} options
 *   `fallback` lets Opus 5.5, Sonnet 5.5 and Fable 5.1 retry a refusal on another model. It is off by
 *   default: a measurement of one model must not silently include another.
 *   Without `apiKey` or `baseURL` the SDK reads its own environment; callers that care pass both.
 * @returns {import('../core/types.js').Complete}
 */
export function createClaudeComplete({
  Anthropic,
  model,
  apiKey,
  baseURL,
  allowBrowser = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  effort = 'low',
  fallback = false,
}) {
  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    // Retries honor any retry-after with no upper bound; RetryLaterError hands them to the queue.
    maxRetries: 0,
    timeout: timeoutMs,
    dangerouslyAllowBrowser: allowBrowser,
    // The bookmarks and the key must not follow a redirect to another host.
    fetchOptions: { redirect: 'error' },
  });
  const useFallback = fallback && SERVER_FALLBACK_MODELS.has(model);

  return async function complete({ system, user, schema, maxTokens }) {
    const params = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    };

    const startedAt = performance.now();
    // The SDK timeout only covers the wait for headers; this one also covers a body that stalls.
    const signal = AbortSignal.timeout(timeoutMs);
    /** @type {any} */
    let response;
    try {
      response = useFallback
        ? await client.beta.messages.create({ ...params, betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' }, { signal })
        : await client.messages.create(params, { signal });
    } catch (/** @type {any} */ error) {
      throw toRetryLater(Anthropic, error, signal) ?? error;
    }

    const requestId = response._request_id ?? null;
    /** @type {import('../core/types.js').UsageAttempt[] | undefined} */
    let attempts;
    try {
      const servedModel = typeof response.model === 'string' && response.model !== '' ? response.model : model;
      attempts = summarizeAttempts(response.usage, model, servedModel);
      if (!Array.isArray(response.content)) {
        throw new Error(`Response has no content (status 200${requestId ? `, request-id ${requestId}` : ''})`);
      }
      const sum = (/** @type {'inputTokens' | 'outputTokens' | 'thinkingTokens'} */ field) =>
        /** @type {import('../core/types.js').UsageAttempt[]} */ (attempts).reduce((total, attempt) => total + attempt[field], 0);

      const stopReason = neutralStopReason(response.stop_reason);
      const category = response.stop_details?.category;
      return {
        data: stopReason === 'refusal' ? null : parseJsonText(response.content),
        stopReason,
        // Only the policy category: the human-readable explanation is not stored.
        refusalCategory: stopReason === 'refusal' && typeof category === 'string' ? category : null,
        servedModel,
        requestId,
        latencyMs: performance.now() - startedAt,
        usage: {
          attempts,
          inputTokens: sum('inputTokens'),
          outputTokens: sum('outputTokens'),
          thinkingTokens: sum('thinkingTokens'),
          usedFallback: attempts.some((attempt) => attempt.kind === 'fallback_message'),
        },
      };
    } catch (/** @type {any} */ error) {
      // The provider answered 200, so the call was billed whatever went wrong afterwards.
      error.mayHaveBilled = true;
      if (attempts) error.usage = { attempts };
      throw error;
    }
  };
}

/**
 * Errors from the SDK that mean the provider answered with a non-2xx status never carry
 * `mayHaveBilled`: nothing was generated. A connection that dies after the request left, and
 * a body that is cut short, may have been billed.
 *
 * @param {any} Anthropic
 * @param {any} error
 * @param {AbortSignal} signal the per-call timeout
 * @returns {RetryLaterError | null} null when the failure must propagate as it is
 */
function toRetryLater(Anthropic, error, signal) {
  if (signal.aborted) {
    return new RetryLaterError('Request timed out', null, { cause: error, timedOut: true });
  }
  if (!(error instanceof Anthropic.APIError)) {
    // An SDK-side failure (invalid options) never left the process.
    if (error instanceof Anthropic.AnthropicError) return null;
    // Anything else is the body being cut after the headers (`TypeError: terminated`).
    return new RetryLaterError(`Connection lost (${error?.cause?.code ?? error?.message ?? 'unknown'})`, null, {
      cause: error,
      mayHaveBilled: !failedBeforeSending(error),
    });
  }
  // The server said a retry is pointless, whatever the status.
  if (error.headers?.get?.('x-should-retry') === 'false') return null;
  // The account's own spending limit keeps failing until it is raised.
  if (error.status === 429 && error.errorCode === 'enforced_spend_limit_reached') return null;

  const details = describeError(error);
  const retryAfterMs = parseRetryAfter(error.headers);
  const { status } = details;

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new RetryLaterError('Request timed out', null, { ...details, cause: error, timedOut: true });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    const reason = error.cause?.cause?.code ?? error.cause?.cause?.message ?? error.cause?.message;
    // A refused redirect is a configuration problem, not a transient one.
    if (/redirect/i.test(String(error.cause?.cause?.message ?? ''))) return null;
    return new RetryLaterError(`Connection failed${reason ? ` (${reason})` : ''}`, null, {
      ...details,
      cause: error,
      mayHaveBilled: !failedBeforeSending(error),
    });
  }
  if (status === 429) return new RetryLaterError(messageWith('Rate limited', details), retryAfterMs, { ...details, cause: error });
  if (status === 408 || status === 409) {
    return new RetryLaterError(messageWith(`Server asked to retry (${status})`, details), retryAfterMs, { ...details, cause: error });
  }
  if (status !== null && status >= 500) {
    return new RetryLaterError(messageWith(`Server error ${status}`, details), retryAfterMs, { ...details, cause: error });
  }
  return null;
}
