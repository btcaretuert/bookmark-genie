import { createServer } from 'node:http';

const KNOWN_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
const FALLBACK_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALLOWED_KEYS = new Set([
  'model', 'max_tokens', 'system', 'messages', 'output_config', 'fallbacks', 'thinking', 'stop_sequences', 'metadata', 'tools', 'tool_choice', 'service_tier', 'stream',
]);

/**
 * Local stand-in for the Messages API. It answers through the real SDK's wire format, so
 * tests cover the request shape and error mapping without a key or any spending.
 *
 * It validates the request the way the documented contract does, so a body the real API
 * would reject with a 400 is rejected here too: `fallbacks` without the beta header, a list
 * of fallbacks on Haiku, an invalid `effort`, an object schema without
 * `additionalProperties: false`, unknown top-level fields, and the sampling parameters
 * (`temperature`, `top_p`, `top_k`) that API version 2026-10-21 rejects. What it cannot know, such as
 * the real server-side classifier or the fallback model chosen, it only imitates.
 *
 * Titles drive the behavior of a request (any bookmark of the request is enough):
 *   REFUSE_ME          the whole request is refused (stop_reason refusal, category general_harms)
 *   TRUNCATE_ME        the whole request stops at max_tokens with a cut-off JSON
 *   BAD_JSON_ME        the answer is not JSON
 *   THINK_ME           a thinking block comes before the text, with thinking_tokens in usage
 *   SKIP_ME            that bookmark's index is left out of the answer
 *
 * Classification answers assign bookmark `i` to folder `i % folderCount`, so a wrong
 * mapping from folder number to name shows up in the output.
 *
 * Errors carry `request-id` and `request_id` like the real API.
 *
 * @param {{
 *   rateLimitFirst?: number,
 *   retryAfter?: string,
 *   retryAfterMs?: string,
 *   serverErrorFirst?: number,
 *   statusFirst?: {status: number, count?: number, headers?: Record<string, string>, errorCode?: string},
 *   dropFirst?: number,
 *   cutBodyFirst?: number,
 *   stallBodyFirst?: number,
 *   stopReason?: string,
 *   hangFirst?: number,
 *   rejectModel?: string,
 *   usage?: object,
 *   exceedMaxTokens?: boolean,
 *   inflateInput?: {request: number, inputTokens: number},
 *   servedModel?: string,
 *   strict?: boolean,
 * }} [options]
 *   `servedModel`: answer with `model` set to this id and, if `usage` has no `iterations`,
 *   a declined attempt on the requested model followed by a `fallback_message` on this one.
 */
export async function startFakeClaude(options = {}) {
  /** @type {{url: string | undefined, headers: import('node:http').IncomingHttpHeaders, body: any}[]} */
  const requests = [];
  let rateLimitsLeft = options.rateLimitFirst ?? 0;
  let serverErrorsLeft = options.serverErrorFirst ?? 0;
  let statusLeft = options.statusFirst?.count ?? 1;
  let hangsLeft = options.hangFirst ?? 0;
  let dropsLeft = options.dropFirst ?? 0;
  let cutsLeft = options.cutBodyFirst ?? 0;
  let stallsLeft = options.stallBodyFirst ?? 0;
  let counter = 0;
  /** @type {Set<import('node:http').ServerResponse>} */
  const hanging = new Set();

  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      counter += 1;
      const requestId = `req_fake_${String(counter).padStart(4, '0')}`;

      const send = (/** @type {number} */ status, /** @type {any} */ payload, headers = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', 'request-id': requestId, ...headers });
        response.end(JSON.stringify(payload));
      };
      const sendError = (/** @type {number} */ status, /** @type {string} */ type, /** @type {string} */ message, headers = {}) =>
        send(status, { type: 'error', error: { type, message }, request_id: requestId }, headers);

      try {
        handle(request, raw, { send, sendError, requestId, response });
      } catch (error) {
        // A body the fake does not understand must not take the whole test process down.
        sendError(400, 'invalid_request_error', `fake-claude could not interpret the request: ${/** @type {Error} */ (error).message}`);
      }
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} raw
   * @param {{send: Function, sendError: Function, requestId: string, response: import('node:http').ServerResponse}} io
   */
  function handle(request, raw, { send, sendError, requestId, response }) {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      sendError(400, 'invalid_request_error', 'Request body is not valid JSON');
      return;
    }
    requests.push({ url: request.url, headers: request.headers, body });

    if (options.rejectModel !== undefined && options.rejectModel === body?.model) {
      sendError(401, 'authentication_error', 'invalid x-api-key');
      return;
    }
    if (dropsLeft > 0) {
      dropsLeft -= 1;
      response.socket?.destroy();
      return;
    }
    if (cutsLeft > 0 || stallsLeft > 0) {
      // Headers and the start of a 200 body, then the body dies or never ends.
      const cut = cutsLeft > 0;
      if (cut) cutsLeft -= 1;
      else stallsLeft -= 1;
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000', 'request-id': 'req_cut' });
      response.write('{"id":"msg_cut",');
      if (cut) setTimeout(() => response.socket?.destroy(), 20);
      else hanging.add(response);
      return;
    }
    if (hangsLeft > 0) {
      hangsLeft -= 1;
      hanging.add(response);
      return;
    }
    if (options.statusFirst && statusLeft > 0) {
      statusLeft -= 1;
      if (options.statusFirst.errorCode) {
        send(options.statusFirst.status, {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'limit', details: { error_code: options.statusFirst.errorCode } },
          request_id: requestId,
        }, options.statusFirst.headers);
        return;
      }
      sendError(options.statusFirst.status, 'api_error', `fake status ${options.statusFirst.status}`, options.statusFirst.headers);
      return;
    }
    if (rateLimitsLeft > 0) {
      rateLimitsLeft -= 1;
      sendError(429, 'rate_limit_error', 'slow down', {
        ...(options.retryAfter ? { 'retry-after': options.retryAfter } : {}),
        ...(options.retryAfterMs ? { 'retry-after-ms': options.retryAfterMs } : {}),
      });
      return;
    }
    if (serverErrorsLeft > 0) {
      serverErrorsLeft -= 1;
      sendError(529, 'overloaded_error', 'overloaded');
      return;
    }

    const problem = options.strict === false ? null : contractProblem(body, request.headers);
    if (problem) {
      sendError(problem.status ?? 400, problem.type ?? 'invalid_request_error', problem.message);
      return;
    }

    const user = body.messages[0].content;
    // A real API stops at max_tokens; `exceedMaxTokens` imitates one that does not.
    const defaultUsage = { input_tokens: 100, output_tokens: options.exceedMaxTokens ? body.max_tokens + 10 : Math.min(50, body.max_tokens) };
    // `inflateInput` imitates a tokenizer that counts more than the tool estimated, on one request
    // (1-based), while the answer still respects `max_tokens`.
    if (options.inflateInput && requests.length === options.inflateInput.request) defaultUsage.input_tokens = options.inflateInput.inputTokens;
    const usage = options.usage ?? defaultUsage;
    const reply = (/** @type {string} */ stopReason, /** @type {any[]} */ content, extra = {}, usageOverride = usage) => {
      const withFallback =
        options.servedModel && !('iterations' in usageOverride)
          ? {
              ...usageOverride,
              iterations: [
                { type: 'message', model: body.model, input_tokens: usageOverride.input_tokens, output_tokens: 0 },
                { type: 'fallback_message', model: options.servedModel, input_tokens: usageOverride.input_tokens, output_tokens: usageOverride.output_tokens },
              ],
            }
          : usageOverride;
      send(200, {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: options.servedModel ?? body.model,
        stop_reason: stopReason,
        stop_details: null,
        content,
        usage: withFallback,
        ...extra,
      });
    };

    if (user.includes('REFUSE_ME')) {
      reply('refusal', [], { stop_details: { type: 'refusal', category: 'general_harms', explanation: 'fake explanation' } });
      return;
    }
    if (user.includes('TRUNCATE_ME')) {
      reply('max_tokens', [{ type: 'text', text: '{"assignments":[{"i":0,"f":0,"conf' }]);
      return;
    }
    if (user.includes('BAD_JSON_ME')) {
      reply('end_turn', [{ type: 'text', text: 'Sure! Here is the answer: {not json' }]);
      return;
    }

    const answer = answerFor(body, user);
    const content = [{ type: 'text', text: JSON.stringify(answer) }];
    if (user.includes('THINK_ME')) {
      reply(
        'end_turn',
        [{ type: 'thinking', thinking: 'The bookmark looks like a cooking page.', signature: 'fake-signature' }, ...content],
        { },
        { ...usage, output_tokens_details: { thinking_tokens: Math.min(30, usage.output_tokens ?? 0) } },
      );
      return;
    }
    reply(options.stopReason ?? 'end_turn', content);
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const response of hanging) response.destroy();
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * What the documented API would reject before sampling.
 *
 * @param {any} body
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {{status?: number, type?: string, message: string} | null}
 */
function contractProblem(body, headers) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { message: 'Request body must be an object' };
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) return { message: `${key}: Extra inputs are not permitted` };
  }
  if (!KNOWN_MODELS.includes(body.model)) return { status: 404, type: 'not_found_error', message: `model: ${body.model}` };
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return { message: 'max_tokens: must be a positive integer' };
  if (!Array.isArray(body.messages) || body.messages[0]?.role !== 'user' || typeof body.messages[0]?.content !== 'string') {
    return { message: 'messages: the first message must be a user message with text' };
  }

  if ('fallbacks' in body) {
    const beta = String(headers['anthropic-beta'] ?? '');
    if (!beta.split(',').map((value) => value.trim()).includes(FALLBACK_BETA)) {
      return { message: 'fallbacks: Extra inputs are not permitted' };
    }
    if (Array.isArray(body.fallbacks) && !FALLBACK_MODELS.includes(body.model)) {
      return { message: `fallbacks: ${body.model} does not support a list of fallback models` };
    }
    if (body.fallbacks !== 'default' && !Array.isArray(body.fallbacks)) return { message: 'fallbacks: must be "default" or a list' };
  }

  const config = body.output_config;
  if (config !== undefined) {
    if (config === null || typeof config !== 'object') return { message: 'output_config: must be an object' };
    if ('effort' in config && !EFFORTS.includes(config.effort)) {
      return { message: `output_config.effort: must be one of ${EFFORTS.join(', ')}` };
    }
    if ('format' in config) {
      if (config.format?.type !== 'json_schema' || typeof config.format.schema !== 'object') {
        return { message: 'output_config.format: type must be "json_schema" with a schema' };
      }
      const schemaProblem = findSchemaProblem(config.format.schema, 'output_config.format.schema');
      if (schemaProblem) return { message: schemaProblem };
    }
  }
  return null;
}

/**
 * Subset of the documented structured-output limits that this project can break.
 *
 * @param {any} node
 * @param {string} path
 * @returns {string | null}
 */
function findSchemaProblem(node, path) {
  if (node === null || typeof node !== 'object') return null;
  for (const unsupported of ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'pattern', 'maxItems']) {
    if (unsupported in node) return `${path}: ${unsupported} is not supported`;
  }
  if ('minItems' in node && ![0, 1].includes(node.minItems)) return `${path}: minItems may only be 0 or 1`;
  if (node.type === 'object' || 'properties' in node) {
    if (node.additionalProperties !== false) return `${path}: additionalProperties must be false for objects`;
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      const found = findSchemaProblem(child, `${path}.properties.${name}`);
      if (found) return found;
    }
  }
  if (node.items) return findSchemaProblem(node.items, `${path}.items`);
  return null;
}

/**
 * @param {any} body
 * @param {string} user
 */
function answerFor(body, user) {
  if (body.output_config?.format?.schema?.properties?.folders) {
    return {
      folders: [
        { name: 'Programación', description: 'Código y herramientas.' },
        { name: 'Cocina', description: 'Recetas.' },
      ],
    };
  }
  const bookmarks = JSON.parse(user.match(/<bookmarks>\n(.*)\n<\/bookmarks>/s)?.[1] ?? '[]');
  const folders = JSON.parse(user.match(/<folders>\n(.*)\n<\/folders>/s)?.[1] ?? '[]');
  const folderCount = Math.max(1, folders.length);
  const assignments = bookmarks
    .filter((/** @type {{title: string}} */ bookmark) => !bookmark.title.includes('SKIP_ME'))
    .map((/** @type {{i: number}} */ bookmark) => ({ i: bookmark.i, f: bookmark.i % folderCount, confidence: 'high' }));
  return { assignments };
}
