import { createServer } from 'node:http';

/**
 * Local stand-in for the providers behind `openai-compatible.js`. Each dialect models what that
 * provider's documentation says (docs/proveedores.md), including the differences that break a
 * naive client, and rejects what the documented contract rejects. It proves the
 * adapter follows what was read; it cannot prove that what was read matches the real service.
 * Where the documentation is silent (Gemini's finish_reason, Mistral's refusals), it imitates the
 * OpenAI behavior, which is a guess.
 *
 * Titles drive the behavior of a request (any bookmark of the request is enough):
 *   REFUSE_ME        refused, the way the dialect signals it
 *   FILTER_ME        finish_reason content_filter, on the chat dialects
 *   TRUNCATE_ME      stops at the token cap with cut-off JSON
 *   LONG_CONTEXT_ME  Mistral's finish_reason model_length
 *   BAD_JSON_ME      the answer is not JSON
 *   BLANK_ME         the answer is only spaces, with a normal stop (DeepSeek's JSON mode)
 *   THINK_ME         reasoning tokens in usage, reported the way the dialect does
 *   CACHE_WRITE_ME   OpenAI's implicit cache writes the whole prompt: 3000 of 3000 tokens, 800 out
 *   STALL_ME         a partway failure: DeepSeek insufficient_system_resource, Mistral error, Perplexity failed
 *   ODD_STOP_ME      a finish_reason outside the contract
 *   END_TURN_ME      finish_reason end_turn, which xAI documents besides stop
 *   NO_USAGE_ME      the response has no usage
 *   SEARCH_ME        Perplexity answers as if it had searched
 *   SKIP_ME          that bookmark's index is left out of the answer
 *
 * @typedef {'openai' | 'gemini' | 'mistral' | 'xai' | 'deepseek' | 'perplexity' | 'anthropic'} Dialect
 * @param {{
 *   dialect?: Dialect,
 *   rateLimitFirst?: number,
 *   retryAfter?: string,
 *   retryAfterMs?: string,
 *   statusFirst?: {status: number, count?: number, headers?: Record<string, string>, body?: unknown},
 *   hangFirst?: number,
 *   hangBodyFirst?: number,
 *   cutFirst?: number,
 *   cutBodyFirst?: number,
 *   redirectFirst?: number,
 *   rawFirst?: {text: string, status?: number, count?: number},
 *   keepAliveLines?: number,
 *   servedModel?: string,
 *   strict?: boolean,
 *   usage?: object,
 *   exceedMaxTokens?: boolean,
 *   listed?: object[],
 * }} [options]
 */
export async function startFakeOpenAi(options = {}) {
  const dialect = options.dialect ?? 'openai';
  const spec = SPECS[dialect];
  /** @type {{method: string | undefined, url: string | undefined, headers: import('node:http').IncomingHttpHeaders, body: any}[]} */
  const requests = [];
  let rateLimitsLeft = options.rateLimitFirst ?? 0;
  let statusLeft = options.statusFirst?.count ?? 1;
  let hangsLeft = options.hangFirst ?? 0;
  let bodyHangsLeft = options.hangBodyFirst ?? 0;
  let cutsLeft = options.cutFirst ?? 0;
  let bodyCutsLeft = options.cutBodyFirst ?? 0;
  let redirectsLeft = options.redirectFirst ?? 0;
  let rawLeft = options.rawFirst?.count ?? 1;
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
      const io = makeIo(response, spec, counter);
      try {
        handle(request, raw, response, io);
      } catch (error) {
        // A body the fake does not understand must not take the whole test process down.
        io.sendError(400, 'invalid_request_error', `fake-openai could not interpret the request: ${/** @type {Error} */ (error).message}`);
      }
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} raw
   * @param {import('node:http').ServerResponse} response
   * @param {ReturnType<typeof makeIo>} io
   */
  function handle(request, raw, response, io) {
    if (request.method === 'GET') {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: null });
      if (redirectsLeft > 0) {
        redirectsLeft -= 1;
        response.writeHead(307, { location: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}${spec.listingPath}` });
        return response.end();
      }
      if (!authorized(request.headers)) return io.sendError(401, 'authentication_error', 'Missing or invalid key');
      if (options.statusFirst && statusLeft > 0) {
        statusLeft -= 1;
        return io.send(options.statusFirst.status, options.statusFirst.body ?? errorBody(spec, 'api_error', `fake status ${options.statusFirst.status}`), options.statusFirst.headers);
      }
      if (request.url?.split('?')[0] !== spec.listingPath) return io.sendError(404, 'not_found_error', `No such path: ${request.url}`);
      if (spec.listingNeeds && !request.headers[spec.listingNeeds]) return io.sendError(400, 'invalid_request_error', `${spec.listingNeeds} header is required`);
      return io.send(200, { object: 'list', data: options.listed ?? [] });
    }

    /** @type {any} */
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return io.sendError(400, 'invalid_request_error', 'Request body is not valid JSON');
    }
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });

    if (hangsLeft > 0) {
      hangsLeft -= 1;
      hanging.add(response);
      return undefined;
    }
    if (bodyHangsLeft > 0) {
      bodyHangsLeft -= 1;
      hanging.add(response);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"id":');
      return undefined;
    }
    if (cutsLeft > 0) {
      cutsLeft -= 1;
      request.socket.destroy();
      return undefined;
    }
    if (bodyCutsLeft > 0) {
      bodyCutsLeft -= 1;
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      response.write('{"id":', () => request.socket.destroy());
      return undefined;
    }
    if (redirectsLeft > 0) {
      redirectsLeft -= 1;
      response.writeHead(307, { location: 'http://127.0.0.1:9/stolen' });
      return response.end();
    }
    if (options.rawFirst && rawLeft > 0) {
      rawLeft -= 1;
      response.writeHead(options.rawFirst.status ?? 200, { 'content-type': 'text/html' });
      return response.end(options.rawFirst.text);
    }
    if (options.statusFirst && statusLeft > 0) {
      statusLeft -= 1;
      return io.send(options.statusFirst.status, options.statusFirst.body ?? errorBody(spec, 'api_error', `fake status ${options.statusFirst.status}`), options.statusFirst.headers);
    }
    if (rateLimitsLeft > 0) {
      rateLimitsLeft -= 1;
      return io.send(429, errorBody(spec, 'rate_limit_error', 'slow down'), {
        ...(options.retryAfter ? { 'retry-after': options.retryAfter } : {}),
        ...(options.retryAfterMs ? { 'retry-after-ms': options.retryAfterMs } : {}),
        ...(dialect === 'openai' ? { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1s' } : {}),
      });
    }

    if (!authorized(request.headers)) return io.sendError(401, 'authentication_error', 'Missing or invalid key');
    if (request.url !== spec.completionPath) return io.sendError(404, 'not_found_error', `No such path: ${request.url}`);

    if (options.strict !== false) {
      const problem = spec.check(body);
      if (problem) return io.sendError(problem.status ?? 400, 'invalid_request_error', problem.message);
    }

    const answerTo = dialect === 'perplexity' ? replyAsAgent : replyAsChat;
    return answerTo(body, spec, dialect, options, io);
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

  /** @param {import('node:http').ServerResponse} response @param {Spec} dialectSpec @param {number} number */
  function makeIo(response, dialectSpec, number) {
    const requestId = `req_fake_${String(number).padStart(4, '0')}`;
    const send = (/** @type {number} */ status, /** @type {any} */ payload, /** @type {Record<string, string>} */ headers = {}) => {
      const idHeader = dialectSpec.requestIdHeader ? { [dialectSpec.requestIdHeader]: requestId } : {};
      response.writeHead(status, { 'content-type': 'application/json', ...idHeader, ...headers });
      // DeepSeek documents blank lines before the JSON while a non-streaming request waits.
      response.end(`${'\n'.repeat(options.keepAliveLines ?? 0)}${JSON.stringify(payload)}`);
    };
    return {
      number,
      send,
      sendError: (/** @type {number} */ status, /** @type {string} */ type, /** @type {string} */ message) => send(status, errorBody(dialectSpec, type, message)),
    };
  }
}

/** @param {import('node:http').IncomingHttpHeaders} headers */
function authorized(headers) {
  return /^Bearer \S+$/.test(String(headers.authorization ?? ''));
}

/**
 * @param {Spec} spec
 * @param {string} type
 * @param {string} message
 */
function errorBody(spec, type, message) {
  return spec.errorAtRoot ? { message, type, param: null, code: null } : { error: { message, type, param: null, code: null } };
}

/**
 * @param {any} body
 * @param {Spec} spec
 * @param {Dialect} dialect
 * @param {{usage?: object, servedModel?: string}} options
 * @param {{number: number, send: Function}} io
 */
function replyAsChat(body, spec, dialect, options, io) {
  const user = String(body.messages.find((/** @type {{role: string}} */ message) => message.role === 'user')?.content ?? '');
  const baseMessage = { role: 'assistant', content: /** @type {unknown} */ (null), refusal: /** @type {string | null} */ (null) };
  const usage = usageFor(dialect, user, options.usage, outputFor(options, body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens));

  /** @param {string} finishReason @param {object} message */
  const reply = (finishReason, message) =>
    io.send(200, {
      id: `chatcmpl-fake-${io.number}`,
      object: 'chat.completion',
      created: 1_780_000_000,
      model: options.servedModel ?? body.model,
      choices: [{ index: 0, message: { ...baseMessage, ...message }, finish_reason: finishReason }],
      ...(user.includes('NO_USAGE_ME') ? {} : { usage }),
    });

  if (user.includes('REFUSE_ME')) {
    // xAI and OpenAI document the field. The others do not document a signal; DeepSeek has only the filter.
    if (dialect === 'openai' || dialect === 'xai') return reply('stop', { refusal: 'I cannot help with that request about a person.' });
    return reply('content_filter', { content: '' });
  }
  if (user.includes('FILTER_ME')) return reply('content_filter', { content: '' });
  if (user.includes('TRUNCATE_ME')) return reply('length', { content: '{"assignments":[{"i":0,"f":0,"conf' });
  if (user.includes('LONG_CONTEXT_ME')) return reply('model_length', { content: '{"assignments":[' });
  if (user.includes('BAD_JSON_ME')) return reply('stop', { content: 'Sure! Here is the answer: {not json' });
  if (user.includes('BLANK_ME')) return reply('stop', { content: ' '.repeat(40) });
  if (user.includes('ODD_STOP_ME')) return reply('recitation', { content: '' });
  if (user.includes('END_TURN_ME')) return reply('end_turn', { content: JSON.stringify(answerFor(user)) });
  if (user.includes('STALL_ME')) {
    return reply(dialect === 'mistral' ? 'error' : 'insufficient_system_resource', { content: '{"assignments":[' });
  }

  const answer = JSON.stringify(answerFor(user));
  // Mistral answers with chunks when it reasons, and puts the thinking in a chunk of its own.
  if (dialect === 'mistral' && body.reasoning_effort === 'high') {
    return reply('stop', {
      content: [
        { type: 'thinking', thinking: [{ type: 'text', text: 'The bookmark looks like a recipe.' }] },
        { type: 'text', text: answer },
      ],
    });
  }
  if (dialect === 'deepseek' && user.includes('THINK_ME')) return reply('stop', { content: answer, reasoning_content: 'Thinking about it.' });
  return reply('stop', { content: answer });
}

/**
 * @param {any} body
 * @param {Spec} spec
 * @param {Dialect} dialect
 * @param {{usage?: object, servedModel?: string}} options
 * @param {{number: number, send: Function}} io
 */
function replyAsAgent(body, spec, dialect, options, io) {
  const user = String(body.input);
  const usage = usageFor(dialect, user, options.usage, outputFor(options, body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens));

  /** @param {string} status @param {object[]} output @param {object} [extra] */
  const reply = (status, output, extra = {}) =>
    io.send(200, {
      id: `resp_fake_${io.number}`,
      object: 'response',
      created_at: 1_780_000_000,
      status,
      model: options.servedModel ?? body.model,
      output,
      error: null,
      ...(user.includes('NO_USAGE_ME') ? {} : { usage }),
      ...extra,
    });
  /** @param {string} text */
  const message = (text) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });

  const wantsSearch = 'effort' in body || (Array.isArray(body.tools) && body.tools.some((/** @type {{type: string}} */ tool) => tool.type === 'web_search'));
  if (wantsSearch || user.includes('SEARCH_ME')) {
    return reply('completed', [{ type: 'search_results', results: [{ title: 'A result', url: 'https://example.com' }] }, message(JSON.stringify(answerFor(user)))]);
  }
  if (user.includes('REFUSE_ME')) return reply('completed', [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] }]);
  if (user.includes('TRUNCATE_ME')) return reply('incomplete', [message('{"assignments":[{"i":0,"f":0,"conf')]);
  if (user.includes('BAD_JSON_ME')) return reply('completed', [message('Sure! Here is the answer: {not json')]);
  if (user.includes('STALL_ME')) return reply('failed', [], { error: { message: 'An upstream failure', code: 'upstream', type: 'server_error' } });
  if (user.includes('ODD_STOP_ME')) return reply('queued', []);
  return reply('completed', [message(JSON.stringify(answerFor(user)))]);
}

/**
 * A real provider stops at the maximum it was given, so by default the answer never exceeds it;
 * `exceedMaxTokens` imitates one that does not.
 *
 * @param {{exceedMaxTokens?: boolean}} options
 * @param {unknown} maxTokens
 */
function outputFor(options, maxTokens) {
  const limit = Number.isInteger(maxTokens) ? /** @type {number} */ (maxTokens) : 50;
  return options.exceedMaxTokens ? limit + 10 : Math.min(50, limit);
}

/**
 * @param {Dialect} dialect
 * @param {string} user
 * @param {object | undefined} override
 * @param {number} [out] output tokens of the default usage
 */
function usageFor(dialect, user, override, out = 50) {
  if (override) return override;
  const thinking = user.includes('THINK_ME') ? 30 : 0;
  switch (dialect) {
    case 'openai':
      if (user.includes('CACHE_WRITE_ME')) {
        return { prompt_tokens: 3000, completion_tokens: 800, total_tokens: 3800, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3000 } };
      }
      return { prompt_tokens: 100, completion_tokens: out, total_tokens: 100 + out, completion_tokens_details: { reasoning_tokens: thinking, accepted_prediction_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
    case 'deepseek':
      return { prompt_tokens: 100, completion_tokens: out, total_tokens: 100 + out, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens_details: { reasoning_tokens: thinking } };
    case 'xai':
      // Not documented whether reasoning is inside completion_tokens: this is the unfavorable case.
      return { prompt_tokens: 100, completion_tokens: out, total_tokens: 100 + out + thinking, completion_tokens_details: { reasoning_tokens: thinking }, prompt_tokens_details: { cached_tokens: 0 }, cost_in_usd_ticks: 1000 };
    case 'gemini':
      // Hidden thoughts: billed, inside the total, in no other field.
      return { prompt_tokens: 100, completion_tokens: out, total_tokens: 100 + out + thinking };
    case 'mistral':
      return { prompt_tokens: 100, completion_tokens: out, total_tokens: 100 + out };
    default:
      return { input_tokens: 100, output_tokens: out, total_tokens: 100 + out, output_tokens_details: { reasoning_tokens: thinking }, cost: { currency: 'USD', input_cost: 0, output_cost: 0, total_cost: 0 } };
  }
}

/** @param {string} user */
function answerFor(user) {
  // The Ctrl+D request of the extension: the first folder, sure, or a new one when there is none.
  if (user.includes('<new_bookmark>')) {
    const folders = JSON.parse(user.match(/<folders>\n(.*)\n<\/folders>/s)?.[1] ?? '[]');
    return folders.length > 0
      ? { kind: 'existing', folder: 0, confidence: 'high', name: '', description: '', together: [] }
      : { kind: 'new', folder: -1, confidence: 'high', name: 'Nueva', description: 'Una carpeta nueva.', together: [] };
  }
  if (user.includes('<bookmark_sample>')) {
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

/**
 * @typedef {{
 *   completionPath: string,
 *   listingPath: string,
 *   listingNeeds?: string,
 *   requestIdHeader: string | null,
 *   errorAtRoot?: boolean,
 *   check: (body: any) => {status?: number, message: string} | null,
 * }} Spec
 */

/** @param {any} body */
function chatShapeProblem(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { message: 'Request body must be an object' };
  if (typeof body.model !== 'string') return { message: 'model is required' };
  if (!Array.isArray(body.messages) || !body.messages.some((/** @type {{role: string}} */ message) => message.role === 'user')) {
    return { message: 'messages: a user message is required' };
  }
  for (const key of ['tools', 'tool_choice', 'temperature', 'top_p', 'stream', 'logprobs']) {
    if (key in body) return { message: `${key}: this project never sends it` };
  }
  return null;
}

/**
 * @param {any} body
 * @param {string[]} allowed
 */
function unknownField(body, allowed) {
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  return extra ? { message: `${extra}: unexpected field` } : null;
}

/**
 * OpenAI's documented strict-mode rules, the strictest of the group.
 *
 * @param {any} node
 * @param {string} path
 * @returns {string | null}
 */
function strictSchemaProblem(node, path) {
  if (node === null || typeof node !== 'object') return null;
  for (const unsupported of ['allOf', 'not', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else']) {
    if (unsupported in node) return `${path}: ${unsupported} is not supported`;
  }
  if (node.type === 'object') {
    if (node.additionalProperties !== false) return `${path}: additionalProperties must be false`;
    const names = Object.keys(node.properties ?? {});
    const missing = names.find((name) => !node.required?.includes(name));
    if (missing) return `${path}: ${missing} must be listed in required`;
    for (const name of names) {
      const found = strictSchemaProblem(node.properties[name], `${path}.properties.${name}`);
      if (found) return found;
    }
  }
  if (Array.isArray(node.enum) && node.enum.length === 0) return `${path}: enum must not be empty`;
  if (Array.isArray(node.items)) return `${path}: items must be a schema, not an array`;
  return node.items ? strictSchemaProblem(node.items, `${path}.items`) : null;
}

/**
 * @param {any} format
 * @param {RegExp} namePattern
 */
function jsonSchemaProblem(format, namePattern) {
  if (format?.type !== 'json_schema') return { message: 'response_format: type must be json_schema' };
  const declared = format.json_schema;
  if (declared === null || typeof declared !== 'object' || typeof declared.schema !== 'object') return { message: 'response_format.json_schema.schema is required' };
  if (typeof declared.name !== 'string' || !namePattern.test(declared.name)) return { message: 'response_format.json_schema.name is invalid' };
  if (declared.schema.type !== 'object') return { message: 'response_format: the root must be an object' };
  const problem = strictSchemaProblem(declared.schema, 'schema');
  return problem ? { message: problem } : null;
}

/** @type {Record<Dialect, Spec>} */
const SPECS = {
  openai: {
    completionPath: '/chat/completions',
    listingPath: '/models',
    requestIdHeader: 'x-request-id',
    check(body) {
      const shape = chatShapeProblem(body);
      if (shape) return shape;
      const extra = unknownField(body, ['model', 'messages', 'max_completion_tokens', 'response_format', 'reasoning_effort', 'store']);
      if (extra) return extra;
      if (!Number.isInteger(body.max_completion_tokens) || body.max_completion_tokens < 1) return { message: 'max_completion_tokens: must be a positive integer' };
      if (body.reasoning_effort !== undefined && !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort)) return { message: 'reasoning_effort: invalid value' };
      if (body.store !== false) return { message: 'store: this project must send false' };
      if (body.model !== 'gpt-6-luna') return { status: 404, message: `The model ${body.model} does not exist` };
      return jsonSchemaProblem(body.response_format, /^[a-zA-Z0-9_-]{1,64}$/);
    },
  },
  gemini: {
    completionPath: '/chat/completions',
    listingPath: '/models',
    requestIdHeader: null,
    check(body) {
      const shape = chatShapeProblem(body);
      if (shape) return shape;
      const extra = unknownField(body, ['model', 'messages', 'max_tokens', 'response_format', 'reasoning_effort']);
      if (extra) return extra;
      if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return { message: 'max_tokens: must be a positive integer' };
      // Documented: reasoning can only be turned off on the 2.5 models.
      if (body.reasoning_effort === 'none' && !String(body.model).startsWith('gemini-2.5')) return { message: 'reasoning_effort: reasoning cannot be turned off on this model' };
      return jsonSchemaProblem(body.response_format, /^[a-zA-Z0-9_-]{1,64}$/);
    },
  },
  mistral: {
    completionPath: '/chat/completions',
    listingPath: '/models',
    requestIdHeader: null,
    errorAtRoot: true,
    check(body) {
      const shape = chatShapeProblem(body);
      if (shape) return { status: 422, message: shape.message };
      const extra = unknownField(body, ['model', 'messages', 'max_tokens', 'response_format', 'reasoning_effort']);
      if (extra) return { status: 422, message: extra.message };
      if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return { status: 422, message: 'max_tokens: must be a positive integer' };
      // Only these two are documented for this model; the other levels are for Mistral Large 4.
      if (body.model === 'mistral-small-2603' && body.reasoning_effort !== undefined && !['none', 'high'].includes(body.reasoning_effort)) {
        return { status: 422, message: 'reasoning_effort: not supported on this model' };
      }
      return jsonSchemaProblem(body.response_format, /^[a-zA-Z0-9_-]{1,64}$/);
    },
  },
  xai: {
    completionPath: '/chat/completions',
    listingPath: '/models',
    requestIdHeader: null,
    check(body) {
      const shape = chatShapeProblem(body);
      if (shape) return shape;
      const extra = unknownField(body, ['model', 'messages', 'max_completion_tokens', 'response_format', 'reasoning_effort']);
      if (extra) return extra;
      if (!Number.isInteger(body.max_completion_tokens) || body.max_completion_tokens < 1) return { message: 'max_completion_tokens: must be a positive integer' };
      if (body.reasoning_effort !== undefined && String(body.model).includes('non-reasoning')) return { message: 'reasoning_effort: this model does not reason' };
      return jsonSchemaProblem(body.response_format, /^[a-zA-Z0-9_-]{1,64}$/);
    },
  },
  deepseek: {
    completionPath: '/chat/completions',
    listingPath: '/models',
    requestIdHeader: null,
    check(body) {
      const shape = chatShapeProblem(body);
      if (shape) return shape;
      const extra = unknownField(body, ['model', 'messages', 'max_tokens', 'response_format', 'reasoning_effort']);
      if (extra) return { status: 422, message: extra.message };
      if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 393_216) return { status: 422, message: 'max_tokens: out of range' };
      if (body.reasoning_effort !== undefined && !['none', 'low', 'high', 'max', 'minimal', 'medium', 'xhigh'].includes(body.reasoning_effort)) return { status: 422, message: 'reasoning_effort: invalid value' };
      if (!['text', 'json_object'].includes(body.response_format?.type)) return { status: 422, message: 'response_format.type: must be one of text or json_object' };
      const prompt = body.messages.map((/** @type {{content: string}} */ message) => message.content).join('\n');
      if (body.response_format.type === 'json_object' && !prompt.includes('json')) return { message: "Prompt must contain the word 'json' to use 'response_format' of type 'json_object'" };
      return null;
    },
  },
  perplexity: {
    completionPath: '/v1/agent',
    listingPath: '/v1/models',
    requestIdHeader: 'x-request-id',
    check(body) {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return { message: 'Request body must be an object' };
      if ('messages' in body) return { message: 'messages: the Agent API takes input and instructions' };
      if ('disable_search' in body) return { message: 'disable_search: not part of the Agent API' };
      if (typeof body.input !== 'string' || body.input === '') return { message: 'input is required' };
      if (typeof body.model !== 'string' && !('effort' in body)) return { message: 'model is required when effort is absent' };
      if (String(body.model).startsWith('anthropic/') && !Number.isInteger(body.max_output_tokens)) return { message: 'validation failed: max_output_tokens is required when using Anthropic models.' };
      if (body.reasoning !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning?.effort)) return { message: 'reasoning.effort: invalid value' };
      if (body.store !== false) return { message: 'store: this project must send false' };
      // Documented: the name allows letters and digits only, 1 to 64.
      return jsonSchemaProblem(body.response_format, /^[a-zA-Z0-9]{1,64}$/);
    },
  },
  anthropic: {
    completionPath: '/v1/messages',
    listingPath: '/v1/models',
    listingNeeds: 'anthropic-version',
    requestIdHeader: 'request-id',
    check: () => null,
  },
};
