/**
 * Model catalog: what was read in each provider's documentation, with its source. Pure data and
 * pure functions. Everything here was checked by hand on `readOn`; no listing API supplies it
 * all, and most supply no price (see docs/proveedores.md).
 *
 * @typedef {'json_schema' | 'json_object'} StructuredOutput
 *   `json_object` guarantees valid JSON at most, so the schema travels in the system prompt.
 * @typedef {boolean | 'depends'} TrainingDefault
 *   `depends`: on the account's plan or settings, which no API reports.
 * @typedef {'pinned' | 'stable-name' | 'moving-alias'} IdStability
 *   `pinned`: the provider says the id is fixed. `stable-name`: the provider offers this name as
 *   the version but does not promise it never moves. `moving-alias`: it has already changed
 *   meaning, and no fixed id exists.
 * @typedef {{
 *   ref: string,
 *   provider: string,
 *   id: string,
 *   prices: {input: number, output: number},
 *   readOn: string,
 *   source: string,
 *   structuredOutput: StructuredOutput,
 *   effortLevels: string[] | null,
 *   defaultEffort: string | null,
 *   serverFallback: boolean,
 *   idStability: IdStability,
 *   trainingByDefault: TrainingDefault,
 *   retiresNotBefore: string | null,
 *   note: string | null,
 *   newAccounts?: false,
 * }} ModelEntry
 *   `prices` in USD per million tokens, at the rate that applies to a prompt of a few thousand
 *   tokens. `id` is what goes on the wire and what `usage.attempts[].model` reports.
 *   `effortLevels` lists only levels the documentation confirms; null means no level is confirmed.
 *   `defaultEffort`: what the model does when no effort is sent, if documented, as one of the
 *   levels `reasoningAllowanceFor` knows. `serverFallback`: it can retry a refusal on another
 *   model on the server. `newAccounts: false`: the provider refuses it to accounts created now;
 *   older ones may still have it, so the extension marks it instead of hiding it.
 */

const READ_ON = '2026-11-05';

const ANTHROPIC_PRICES = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI_MODEL = 'https://developers.openai.com/api/docs/models/gpt-6-luna';
const GEMINI_PRICES = 'https://aistudio.google.com/docs/pricing';
const MISTRAL_PRICES = 'https://docs.mistral.ai/inference/pricing';
const XAI_PRICES = 'https://docs.x.ai/developers/pricing';
const DEEPSEEK_PRICES = 'https://api-docs.deepseek.com/quick_start/pricing';
const PERPLEXITY_MODELS = 'https://docs.perplexity.ai/docs/agent-api/models';

const CLAUDE_EFFORT = ['low', 'medium', 'high'];

/**
 * @param {string} provider
 * @param {Omit<ModelEntry, 'ref' | 'provider' | 'readOn' | 'note' | 'retiresNotBefore' | 'defaultEffort' | 'serverFallback'> & {retiresNotBefore?: string, defaultEffort?: string, serverFallback?: boolean, note?: string}} fields
 * @returns {ModelEntry}
 */
function model(provider, { retiresNotBefore, defaultEffort, serverFallback = false, note, ...fields }) {
  return {
    ref: `${provider}/${fields.id}`,
    provider,
    readOn: READ_ON,
    retiresNotBefore: retiresNotBefore ?? null,
    defaultEffort: defaultEffort ?? null,
    serverFallback,
    note: note ?? null,
    ...fields,
  };
}

/** @type {readonly ModelEntry[]} */
export const CATALOG = Object.freeze([
  model('anthropic', {
    id: 'claude-haiku-5-5',
    prices: { input: 0.1, output: 0.5 },
    source: ANTHROPIC_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: CLAUDE_EFFORT,
    defaultEffort: 'medium',
    idStability: 'pinned',
    trainingByDefault: false,
    retiresNotBefore: '2027-10-07',
    note: 'Prompts over 100,000 tokens cost 0.50/2.50.',
  }),
  model('anthropic', {
    id: 'claude-sonnet-5-5',
    prices: { input: 2, output: 10 },
    source: ANTHROPIC_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: CLAUDE_EFFORT,
    defaultEffort: 'high',
    serverFallback: true,
    idStability: 'pinned',
    trainingByDefault: false,
    retiresNotBefore: '2027-09-28',
  }),
  model('anthropic', {
    id: 'claude-opus-5-5',
    prices: { input: 4, output: 20 },
    source: ANTHROPIC_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: CLAUDE_EFFORT,
    defaultEffort: 'medium',
    serverFallback: true,
    idStability: 'pinned',
    trainingByDefault: false,
    retiresNotBefore: '2027-09-22',
  }),
  // Listed so a server-side fallback that lands here is charged at its real, dearer rate.
  model('anthropic', {
    id: 'claude-fable-5-1',
    prices: { input: 10, output: 50 },
    source: ANTHROPIC_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: CLAUDE_EFFORT,
    defaultEffort: 'high',
    serverFallback: true,
    idStability: 'pinned',
    trainingByDefault: false,
    retiresNotBefore: '2027-09-01',
    note: 'Covered Model: requires 30-day retention; zero data retention does not apply.',
  }),
  model('openai', {
    id: 'gpt-6-luna',
    prices: { input: 0.125, output: 0.5 },
    source: OPENAI_MODEL,
    structuredOutput: 'json_schema',
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    idStability: 'stable-name',
    trainingByDefault: false,
    note: 'List input is 0.10. Priced at the 0.125 of a cache write, on by default, because a batch rarely reuses what it writes, so short prompts are overestimated. Prompts over 272K tokens cost twice the input and 1.5x the output.',
  }),
  model('gemini', {
    id: 'gemini-2.5-flash-lite',
    prices: { input: 0.1, output: 0.4 },
    source: GEMINI_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: ['none', 'low', 'medium', 'high'],
    defaultEffort: 'none',
    idStability: 'stable-name',
    trainingByDefault: 'depends',
    newAccounts: false,
    note: 'Not offered to new users: the API answered 404 on 2026-11-05 and pointed to gemini-3.5-flash-lite. Reasoning is off unless an effort is sent. Text input price.',
  }),
  model('gemini', {
    id: 'gemini-3.1-flash-lite',
    prices: { input: 0.25, output: 1.5 },
    source: GEMINI_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: ['low', 'medium', 'high'],
    idStability: 'stable-name',
    trainingByDefault: 'depends',
    retiresNotBefore: '2027-05-07',
    note: 'Text input price.',
  }),
  // Its documented default is `minimal`, below the levels the margin knows: the default margin covers it.
  model('gemini', {
    id: 'gemini-3.5-flash-lite',
    prices: { input: 0.3, output: 2.5 },
    source: GEMINI_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: ['low', 'medium', 'high'],
    idStability: 'stable-name',
    trainingByDefault: 'depends',
  }),
  model('mistral', {
    id: 'ministral-3b-2512',
    prices: { input: 0.1, output: 0.1 },
    source: MISTRAL_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: null,
    idStability: 'pinned',
    trainingByDefault: 'depends',
  }),
  model('mistral', {
    id: 'ministral-8b-2512',
    prices: { input: 0.15, output: 0.15 },
    source: MISTRAL_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: null,
    idStability: 'pinned',
    trainingByDefault: 'depends',
  }),
  model('mistral', {
    id: 'mistral-small-2603',
    prices: { input: 0.15, output: 0.6 },
    source: MISTRAL_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: ['none', 'high'],
    idStability: 'pinned',
    trainingByDefault: 'depends',
    note: 'The low/medium/high ladder is documented only for Mistral Large 4.',
  }),
  model('xai', {
    id: 'grok-4.20-0309-non-reasoning',
    prices: { input: 1.25, output: 2.5 },
    source: XAI_PRICES,
    structuredOutput: 'json_schema',
    effortLevels: null,
    idStability: 'pinned',
    trainingByDefault: false,
    note: 'The only Grok here: on models that reason, max_completion_tokens does not bound the reasoning, so the budget would not be a ceiling.',
  }),
  model('deepseek', {
    id: 'deepseek-flash',
    prices: { input: 0.3, output: 1.2 },
    source: DEEPSEEK_PRICES,
    structuredOutput: 'json_object',
    effortLevels: ['none', 'low', 'high', 'max'],
    defaultEffort: 'high',
    idStability: 'moving-alias',
    trainingByDefault: true,
    note: 'Peak rate, so the budget stays a ceiling; off-peak is half. Served DeepSeek-V4.1-Flash-1017 when read.',
  }),
  model('deepseek', {
    id: 'deepseek-v4-pro',
    prices: { input: 1.32, output: 3.96 },
    source: DEEPSEEK_PRICES,
    structuredOutput: 'json_object',
    effortLevels: ['none', 'low', 'high', 'max'],
    defaultEffort: 'high',
    idStability: 'moving-alias',
    trainingByDefault: true,
    note: 'Peak rate, so the budget stays a ceiling; off-peak is half. Served DeepSeek-V4-Pro-0813 when read.',
  }),
  model('perplexity', {
    id: 'openai/gpt-6-luna',
    prices: { input: 0.125, output: 0.5 },
    source: PERPLEXITY_MODELS,
    structuredOutput: 'json_schema',
    effortLevels: ['low', 'medium', 'high'],
    idStability: 'stable-name',
    trainingByDefault: false,
    note: 'Two data processors: Perplexity and OpenAI. List input is 0.10. Priced at 0.125 by inference from OpenAI: the Perplexity schema has cache_creation_cost and does not document it.',
  }),
  model('perplexity', {
    id: 'perplexity/glm-5.3-flash',
    prices: { input: 0.15, output: 0.5 },
    source: PERPLEXITY_MODELS,
    structuredOutput: 'json_schema',
    effortLevels: null,
    idStability: 'stable-name',
    trainingByDefault: false,
  }),
]);

/**
 * `provider/model`, split at the first slash because a Perplexity id has a slash of its own.
 * The reference ends up in file names and reports, so it is held to a short alphabet.
 *
 * @param {string} ref
 * @returns {{provider: string, model: string}}
 */
export function parseModelRef(ref) {
  const match = typeof ref === 'string' ? /^([a-z0-9-]+)\/([A-Za-z0-9._:/-]+)$/.exec(ref) : null;
  const segments = match ? match[2].split('/') : [];
  if (!match || segments.some((segment) => segment === '' || /^\.+$/.test(segment))) {
    throw new Error(`A model reference must be provider/model, got ${JSON.stringify(ref)}`);
  }
  return { provider: match[1], model: match[2] };
}

/**
 * @param {string} ref
 * @param {readonly ModelEntry[]} [catalog]
 * @returns {ModelEntry | undefined}
 */
export function findModel(ref, catalog = CATALOG) {
  return catalog.find((entry) => entry.ref === ref);
}

/**
 * The effort to really send, and to record: a measurement must not claim a level the model was
 * never asked for. Null means no effort parameter at all, so the model's own default applies.
 *
 * @param {ModelEntry} entry
 * @param {string | null | undefined} requested
 * @returns {string | null}
 */
export function effortFor(entry, requested) {
  return requested && entry.effortLevels?.includes(requested) ? requested : null;
}

/**
 * Whether the model that answered is the one asked for: the same id, that id with a date suffix,
 * or any id under a moving alias, whose served version is expected to change. Perplexity may also
 * name a model it resells without its provider prefix.
 *
 * @param {string} ref
 * @param {string} servedId
 */
export function isExpectedServedModel(ref, servedId) {
  // Gemini names its models `models/<id>`.
  if (servedId.startsWith('models/')) return isExpectedServedModel(ref, servedId.slice('models/'.length));
  if (findModel(ref)?.idStability === 'moving-alias') return true;
  const { provider, model: id } = parseModelRef(ref);
  const names = provider === 'perplexity' ? [id, id.slice(id.indexOf('/') + 1)] : [id];
  return names.some((name) => servedId === name || (servedId.startsWith(name) && /^-(?:\d{4}-\d{2}-\d{2}|\d{8})$/.test(servedId.slice(name.length))));
}

/**
 * Cheapest first. `requireStructuredOutput` asks for a schema the provider enforces, not the
 * JSON mode. `excludeTrainingByDefault` also drops `depends`, because a key's plan cannot be
 * verified from here. A moving alias is left out unless asked for: what it measures today may
 * not be what it serves tomorrow.
 *
 * @param {readonly ModelEntry[]} catalog
 * @param {{
 *   maxInputPrice?: number,
 *   requireStructuredOutput?: boolean,
 *   excludeTrainingByDefault?: boolean,
 *   providers?: string[],
 *   allowMovingAlias?: boolean,
 * }} [filters]
 * @returns {ModelEntry[]}
 */
export function selectCandidates(
  catalog,
  { maxInputPrice, requireStructuredOutput = false, excludeTrainingByDefault = false, providers, allowMovingAlias = false } = {},
) {
  return catalog
    .filter(
      (entry) =>
        (maxInputPrice === undefined || entry.prices.input <= maxInputPrice) &&
        (!requireStructuredOutput || entry.structuredOutput === 'json_schema') &&
        (!excludeTrainingByDefault || entry.trainingByDefault === false) &&
        (providers === undefined || providers.includes(entry.provider)) &&
        (allowMovingAlias || entry.idStability !== 'moving-alias'),
    )
    .toSorted((a, b) => a.prices.input - b.prices.input || a.prices.output - b.prices.output || a.ref.localeCompare(b.ref));
}

/**
 * The table `budget.js` takes, keyed by the id that `usage.attempts[].model` reports.
 *
 * @param {readonly ModelEntry[]} [catalog]
 * @returns {Record<string, {input: number, output: number}>}
 */
export function budgetPrices(catalog = CATALOG) {
  return Object.fromEntries(catalog.map((entry) => [entry.id, { ...entry.prices }]));
}

/**
 * The prices `createManifest` records, keyed by `provider/model`, each with its source.
 *
 * @param {readonly ModelEntry[]} [catalog]
 * @returns {Record<string, {input: number, output: number, read_on: string, source: string}>}
 */
export function manifestPrices(catalog = CATALOG) {
  return Object.fromEntries(catalog.map((entry) => [entry.ref, { ...entry.prices, read_on: entry.readOn, source: entry.source }]));
}
