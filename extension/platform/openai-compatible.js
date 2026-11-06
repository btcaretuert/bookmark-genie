/**
 * Adapter of the `complete(request)` port for every provider except Claude, over plain `fetch`.
 * What differs between them is data in providers.js; what is left here are the two wire shapes:
 * Chat Completions and, for Perplexity, the Responses shape of its Agent API.
 *
 * Nothing in this file has been tried against a real provider, only against
 * tests/helpers/fake-openai.mjs, which models their documentation.
 */

import { findModel } from '../core/models.js';
import { failedBeforeSending, messageWith, parseRetryAfter, RetryLaterError, tokenCount } from './llm.js';
import { getProvider, resolveBaseURL } from './providers.js';

/**
 * @typedef {import('../core/types.js').CompletionRequest} CompletionRequest
 * @typedef {import('../core/types.js').CompletionResult} CompletionResult
 * @typedef {import('./providers.js').Provider} Provider
 */

const DEFAULT_TIMEOUT_MS = 120_000;

/** Perplexity allows only letters and digits here, so every provider gets a name that fits. */
const SCHEMA_NAME = 'result';

const MAX_API_MESSAGE_LENGTH = 500;

/** Key-shaped text inside an error. Some APIs quote part of the key they rejected. */
const KEY_SHAPED = /\b(?:sk|xai|pplx|gsk)-[\w*.-]{4,}|\bAIza[\w-]{10,}/g;

/**
 * A failure that waiting will not fix: wrong key, unknown model, exhausted balance, invalid
 * request. It propagates and stops the run instead of being retried.
 */
export class ProviderRequestError extends Error {
  /**
   * @param {string} message
   * @param {{status: number, requestId: string | null, apiMessage: string | null, stopsRun?: boolean}} details
   *   `stopsRun`: the whole run must stop, not only this model, because the next one would repeat
   *   the damage.
   */
  constructor(message, { status, requestId, apiMessage, stopsRun = false }) {
    super(message);
    this.name = 'ProviderRequestError';
    this.status = status;
    this.requestId = requestId;
    this.apiMessage = apiMessage;
    this.stopsRun = stopsRun;
  }
}

/**
 * Only text the API offered as a message is kept, never a structured detail: a validation error
 * can echo the request body, and with it the bookmarks.
 *
 * @param {string} text
 * @param {string} apiKey
 * @returns {{message: string | null, codes: string[], requestId: string | null}}
 */
function readErrorBody(text, apiKey) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { message: null, codes: [], requestId: null };
  }
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const inner = root?.error;
  const message = [typeof inner === 'string' ? inner : inner?.message, root?.message].find((value) => typeof value === 'string') ?? null;
  return {
    message: message === null ? null : message.replaceAll(apiKey, '[key]').replace(KEY_SHAPED, '[key]').slice(0, MAX_API_MESSAGE_LENGTH),
    codes: [inner?.code, inner?.type, inner?.status, root?.code, root?.type].filter((value) => typeof value === 'string'),
    requestId: typeof root?.request_id === 'string' ? root.request_id : null,
  };
}

/**
 * @param {Provider} provider
 * @param {Response} response
 * @param {string} text
 * @param {string} apiKey
 * @returns {Error}
 */
function errorForStatus(provider, response, text, apiKey) {
  const { status, headers } = response;
  const { message, codes, requestId: bodyRequestId } = readErrorBody(text, apiKey);
  const requestId = (provider.requestIdHeader && headers.get(provider.requestIdHeader)) || bodyRequestId;
  const details = { status, requestId, apiMessage: message };
  const permanent = new ProviderRequestError(messageWith(`${provider.name} rejected the request (status ${status})`, details), details);

  if (headers.get('x-should-retry') === 'false') return permanent;
  if (status === 429) {
    if (codes.some((code) => provider.quotaErrors.includes(code))) return permanent;
    return new RetryLaterError(messageWith('Rate limited', details), parseRetryAfter(headers), details);
  }
  if (status === 408 || status === 409) {
    return new RetryLaterError(messageWith(`Server asked to retry (${status})`, details), parseRetryAfter(headers), details);
  }
  // 501 means the feature does not exist: asking again changes nothing.
  if (status >= 500 && status !== 501) {
    return new RetryLaterError(messageWith(`Server error ${status}`, details), parseRetryAfter(headers), details);
  }
  return permanent;
}

/**
 * @param {Provider} provider
 * @param {any} error
 * @returns {Error}
 */
function errorForNetworkFailure(provider, error) {
  if (error?.name === 'TimeoutError') {
    return new RetryLaterError('Request timed out', null, { cause: error, timedOut: true });
  }
  const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message;
  // A refused redirect is a configuration problem, not a transient one.
  if (/redirect/i.test(String(error?.cause?.message ?? ''))) {
    return new Error(`${provider.name} answered with a redirect, which is refused so the bookmarks and the key stay on the fixed host`, { cause: error });
  }
  return new RetryLaterError(`Connection failed${reason ? ` (${reason})` : ''}`, null, { cause: error, mayHaveBilled: !failedBeforeSending(error) });
}

/**
 * Never fewer output tokens than the provider's own total implies. Whether reasoning falls inside
 * `completion_tokens` is undocumented for Gemini, and undercounting would let the budget be
 * crossed. What the total adds over the visible output can only be reasoning.
 *
 * @param {any} usage
 * @param {string} model the id that prices the attempt
 * @param {string} inputField
 * @param {string} outputField
 * @returns {CompletionResult['usage']}
 */
function summarizeUsage(usage, model, inputField, outputField) {
  if (usage === null || typeof usage !== 'object') throw new Error('Response usage is missing or unusable (usage)');
  const inputTokens = tokenCount(usage[inputField], inputField);
  const reported = tokenCount(usage[outputField], outputField);
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens;
  const listedReasoning = Number.isFinite(reasoning) && reasoning > 0 ? reasoning : 0;
  const fromTotal = Number.isFinite(usage.total_tokens) ? usage.total_tokens - inputTokens : 0;
  const outputTokens = Math.max(reported, fromTotal, listedReasoning > reported ? reported + listedReasoning : 0);
  const thinkingTokens = Math.min(Math.max(listedReasoning, fromTotal - reported), outputTokens);
  return {
    attempts: [{ model, inputTokens, outputTokens, thinkingTokens, kind: 'message' }],
    inputTokens,
    outputTokens,
    thinkingTokens,
    usedFallback: false,
  };
}

/**
 * Mistral answers with a list of chunks when it reasons; the thinking is not part of the answer.
 *
 * @param {unknown} content
 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' || part?.type === 'output_text')
    .map((part) => part.text)
    .join('');
}

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A minimal instance of a schema. DeepSeek's JSON mode asks for an example as well as a schema.
 *
 * @param {any} schema
 * @returns {unknown}
 */
function exampleOf(schema) {
  if (Array.isArray(schema?.enum)) return schema.enum[0];
  if (schema?.type === 'object') {
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, child]) => [name, exampleOf(child)]));
  }
  if (schema?.type === 'array') return schema.items ? [exampleOf(schema.items)] : [];
  if (schema?.type === 'integer' || schema?.type === 'number') return 0;
  if (schema?.type === 'boolean') return true;
  return 'text';
}

/**
 * Without a schema-enforcing mode, the schema can only be asked for in words. Lowercase "json" is
 * deliberate: DeepSeek requires that word in the prompt. `validateAssignments` and
 * `normalizeTaxonomy` remain the real protection.
 *
 * @param {object} schema
 */
function jsonInstruction(schema) {
  return `Return only a json object, with no other text, that conforms to this JSON Schema:\n${JSON.stringify(schema)}\nExample of the shape:\n${JSON.stringify(exampleOf(schema))}`;
}

/**
 * @param {Provider} provider
 * @param {object} schema
 */
function responseFormat(provider, schema) {
  return provider.structuredOutput === 'json_object'
    ? { type: 'json_object' }
    : { type: 'json_schema', json_schema: { name: SCHEMA_NAME, schema, strict: true } };
}

/**
 * @param {Provider} provider
 * @param {string} model
 * @param {string | null | undefined} effort
 * @param {CompletionRequest} request
 */
function chatBody(provider, model, effort, { system, user, schema, maxTokens }) {
  const systemText = provider.structuredOutput === 'json_object' ? `${system}\n\n${jsonInstruction(schema)}` : system;
  return {
    model,
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: user },
    ],
    [/** @type {string} */ (provider.maxTokensParam)]: maxTokens,
    response_format: responseFormat(provider, schema),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...provider.extraBody,
  };
}

/**
 * No `tools`, and the effort goes under `reasoning`: at the top level it would select a preset,
 * and a preset can search the web with the bookmarks.
 *
 * @param {Provider} provider
 * @param {string} model
 * @param {string | null | undefined} effort
 * @param {CompletionRequest} request
 */
function responsesBody(provider, model, effort, { system, user, schema, maxTokens }) {
  return {
    model,
    instructions: system,
    input: user,
    [/** @type {string} */ (provider.maxTokensParam)]: maxTokens,
    response_format: responseFormat(provider, schema),
    ...(effort ? { reasoning: { effort } } : {}),
    ...provider.extraBody,
  };
}

/**
 * @param {string} reason
 * @param {string | null} requestId
 */
function partwayFailure(reason, requestId) {
  return new RetryLaterError(messageWith(`The provider stopped partway (${reason})`, { requestId, apiMessage: null }), null, { status: 200, requestId });
}

/**
 * Whatever went wrong reading a 2xx, the provider may have billed it. The budget charges the
 * usage if it can be read, and the worst case if not.
 *
 * @param {any} error
 * @param {() => CompletionResult['usage']} readUsage
 */
function markBilled(error, readUsage) {
  error.mayHaveBilled = true;
  try {
    error.usage = { attempts: readUsage().attempts };
  } catch {
    // No usable usage: `mayHaveBilled` is all the budget gets.
  }
  return error;
}

/**
 * @param {Provider} provider
 * @param {any} body
 * @param {string | null} requestId
 * @returns {{stop: 'end_turn' | 'max_tokens' | 'refusal', text: string, category: string | null}}
 */
function readChatChoice(provider, body, requestId) {
  const choice = body?.choices?.[0];
  if (choice === null || typeof choice !== 'object' || choice.message === null || typeof choice.message !== 'object') {
    throw new Error(`Response has no choices (status 200${requestId ? `, request-id ${requestId}` : ''})`);
  }
  // A refusal text is an explanation, not a category: like the Claude adapter, it is not stored.
  if (typeof choice.message.refusal === 'string' && choice.message.refusal !== '') {
    return { stop: 'refusal', text: '', category: null };
  }
  const reason = choice.finish_reason;
  const stop = typeof reason === 'string' && Object.hasOwn(provider.finishReasons, reason) ? provider.finishReasons[reason] : undefined;
  if (stop === undefined) throw new Error(`Unexpected finish_reason: ${String(reason).slice(0, 40)}${requestId ? ` (request-id ${requestId})` : ''}`);
  if (stop === 'retry') throw partwayFailure(reason, requestId);
  return { stop, text: textOf(choice.message.content), category: stop === 'refusal' ? reason : null };
}

/**
 * @param {Provider} provider
 * @param {any} body
 * @param {string | null} requestId
 * @returns {{stop: 'end_turn' | 'max_tokens' | 'refusal', text: string, category: string | null}}
 */
function readResponsesOutput(provider, body, requestId) {
  const { status, output } = body ?? {};
  if (status === 'failed') throw partwayFailure(`status ${status}`, requestId);
  if ((status !== 'completed' && status !== 'incomplete') || !Array.isArray(output)) {
    throw new Error(`Unexpected response status: ${String(status).slice(0, 40)}${requestId ? ` (request-id ${requestId})` : ''}`);
  }
  // By this point the content has already reached the search engine. All that is left is to say
  // so and stop the run, instead of sending the next batch the same way.
  const toolRan = output.some((item) => typeof item?.type === 'string' && item.type.endsWith('_results'));
  if (toolRan || Object.keys(body.usage?.tool_calls_details ?? {}).length > 0) {
    throw new ProviderRequestError(`${provider.name} ran a tool such as a web search with the request content; stopping`, { status: 200, requestId, apiMessage: null, stopsRun: true });
  }
  const parts = output.filter((item) => item?.type === 'message').flatMap((item) => (Array.isArray(item.content) ? item.content : []));
  if (parts.some((part) => part?.type === 'refusal')) return { stop: 'refusal', text: '', category: null };
  return { stop: status === 'incomplete' ? 'max_tokens' : 'end_turn', text: textOf(parts), category: null };
}

/**
 * @param {{
 *   provider: string,
 *   model: string,
 *   apiKey: string,
 *   baseURL?: string,
 *   timeoutMs?: number,
 *   effort?: string | null,
 * }} options
 *   `baseURL`: only a loopback address, for tests. `effort`: omitted when empty, so the model's
 *   default applies; `effortFor` in core/models.js says what a catalog model accepts.
 * @returns {import('../core/types.js').Complete}
 */
export function createOpenAiCompatibleComplete({ provider: providerId, model, apiKey, baseURL, timeoutMs = DEFAULT_TIMEOUT_MS, effort }) {
  const provider = getProvider(providerId);
  if (provider.adapter === 'anthropic-sdk') throw new Error(`${provider.name} goes through createClaudeComplete, not this adapter`);
  if (!apiKey) throw new Error(`${provider.keyEnv} is required for ${provider.name}`);
  // Headers.append quotes a value it rejects, so a stray line break would put the key in an error.
  if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new Error(`The key in ${provider.keyEnv} has spaces or characters that cannot go in a header`);

  const url = `${resolveBaseURL(provider, baseURL)}${provider.completionPath}`;
  const isChat = provider.adapter === 'chat-completions';

  return async function complete(request) {
    const startedAt = performance.now();
    /** @type {Response} */
    let response;
    /** @type {string} */
    let text;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(isChat ? chatBody(provider, model, effort, request) : responsesBody(provider, model, effort, request)),
        // The bookmarks and the key must not follow a redirect to another host.
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The body counts against the same timeout: a server can send headers and then stall.
      text = await response.text();
    } catch (error) {
      throw errorForNetworkFailure(provider, error);
    }
    if (!response.ok) throw errorForStatus(provider, response, text, apiKey);

    const headerId = provider.requestIdHeader ? response.headers.get(provider.requestIdHeader) : null;
    const body = parseJson(text);
    const requestId = headerId || (typeof body?.id === 'string' && body.id !== '' ? body.id : null);
    const servedModel = typeof body?.model === 'string' && body.model !== '' ? body.model : model;
    // A served id the catalog knows sets the price; any other, such as one with a date suffix, would
    // be charged as an unknown model, so the requested id stays. `servedModel` is the truth.
    const pricedModel = findModel(`${providerId}/${servedModel}`) ? servedModel : model;
    const readUsage = () =>
      isChat
        ? summarizeUsage(body?.usage, pricedModel, 'prompt_tokens', 'completion_tokens')
        : summarizeUsage(body?.usage, pricedModel, 'input_tokens', 'output_tokens');

    try {
      if (body === null || typeof body !== 'object') {
        throw new Error(`Response is not JSON (status ${response.status}${requestId ? `, request-id ${requestId}` : ''})`);
      }
      const { stop, text: answer, category } = isChat ? readChatChoice(provider, body, requestId) : readResponsesOutput(provider, body, requestId);
      return {
        data: stop === 'refusal' ? null : parseJson(answer),
        stopReason: stop,
        refusalCategory: stop === 'refusal' ? category : null,
        servedModel,
        requestId,
        latencyMs: performance.now() - startedAt,
        usage: readUsage(),
      };
    } catch (error) {
      throw markBilled(error, readUsage);
    }
  };
}
