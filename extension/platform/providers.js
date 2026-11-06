/**
 * What differs between providers, as data. Everything was read in each provider's documentation
 * on 2026-11-05 and nothing was tried against a real API: docs/proveedores.md has the sources for
 * every line.
 *
 * Copilot is absent on purpose; see EXCLUDED_PROVIDERS.
 *
 * @typedef {'anthropic-sdk' | 'chat-completions' | 'responses'} AdapterKind
 * @typedef {'end_turn' | 'max_tokens' | 'refusal' | 'retry'} NeutralStop
 *   `retry`: the provider gave up partway through, which says nothing about the bookmarks.
 * @typedef {{
 *   trainingByDefault: boolean | 'depends',
 *   training: string,
 *   retention: string,
 *   zeroRetention: string,
 *   region: string,
 *   accountCheck: string | null,
 *   source: string,
 *   readOn: string,
 * }} DataPolicy
 *   `accountCheck`: what only the owner can confirm, in the provider's console.
 * @typedef {{
 *   id: string,
 *   name: string,
 *   keyEnv: string,
 *   baseUrlEnv: string,
 *   baseURL: string,
 *   adapter: AdapterKind,
 *   completionPath: string | null,
 *   maxTokensParam: string | null,
 *   structuredOutput: 'json_schema' | 'json_object',
 *   finishReasons: Record<string, NeutralStop>,
 *   requestIdHeader: string | null,
 *   quotaErrors: string[],
 *   extraBody: Record<string, unknown>,
 *   listing: {path: string, idPrefix: string, headers: Record<string, string>},
 *   dataPolicy: DataPolicy,
 * }} Provider
 *   `quotaErrors`: `error.code`, `error.type` or `error.status` values of a 429 that waiting
 *   will not fix, such as an exhausted balance.
 */

const READ_ON = '2026-11-05';

/**
 * The values of the OpenAI contract. Not every provider documents all three, and Gemini's
 * compatibility layer documents none; a value outside its provider's map is an error.
 */
const BASE_FINISH_REASONS = /** @type {const} */ ({ stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal' });

/**
 * Providers the project cannot use, and why. They stay out of PROVIDERS so nothing can route
 * bookmarks to them; the entry only turns a dead end into an explanation.
 *
 * @type {Record<string, string>}
 */
export const EXCLUDED_PROVIDERS = {
  copilot:
    'no usable inference API: GitHub Models was retired on 2026-07-30, GitHub Copilot only offers an SDK that drives a local CLI, Microsoft Copilot documents no API, and Microsoft 365 Copilot needs an enterprise license per user and has no schema or model choice',
};

/** @type {Record<string, Provider>} */
export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    baseURL: 'https://api.anthropic.com',
    adapter: 'anthropic-sdk',
    completionPath: null,
    maxTokensParam: null,
    structuredOutput: 'json_schema',
    finishReasons: {},
    requestIdHeader: 'request-id',
    quotaErrors: [],
    extraBody: {},
    listing: { path: '/v1/models?limit=1000', idPrefix: '', headers: { 'anthropic-version': '2026-10-21' } },
    dataPolicy: {
      trainingByDefault: false,
      training: 'Commercial and API data is not used for training by default.',
      retention: 'Sources disagree: the privacy center says deleted within 30 days, the API docs say not retained by default. Flagged content: up to 2 years.',
      zeroRetention: 'By agreement. Fable and Mythos require 30-day retention.',
      region: 'Global by default; inference_geo "us" costs 1.1x.',
      accountCheck: 'Create the key for a single workspace: a key not scoped to one needs the anthropic-workspace-id header, which this tool does not send.',
      source: 'https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training',
      readOn: READ_ON,
    },
  },

  openai: {
    id: 'openai',
    name: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    baseURL: 'https://api.openai.com/v1',
    adapter: 'chat-completions',
    completionPath: '/chat/completions',
    maxTokensParam: 'max_completion_tokens',
    structuredOutput: 'json_schema',
    finishReasons: BASE_FINISH_REASONS,
    requestIdHeader: 'x-request-id',
    quotaErrors: [
      'insufficient_quota',
      'credit_balance_exhausted',
      'organization_spend_limit_exceeded',
      'project_spend_limit_exceeded',
      'organization_usage_limit_exceeded',
    ],
    // false is the documented default; stated anyway because it decides whether the bookmarks stay.
    extraBody: { store: false },
    listing: { path: '/models', idPrefix: '', headers: {} },
    dataPolicy: {
      trainingByDefault: false,
      training: 'API data is not used for training unless the organization opts in to sharing.',
      retention: 'Abuse-monitoring logs, which can hold prompts and responses, for up to 30 days.',
      zeroRetention: 'With approval, through sales.',
      region: 'Per-project residency through sales, 10% more on recent models.',
      accountCheck: 'Confirm that data sharing is off in the organization settings.',
      source: 'https://developers.openai.com/api/docs/guides/your-data',
      readOn: READ_ON,
    },
  },

  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_BASE_URL',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    adapter: 'chat-completions',
    completionPath: '/chat/completions',
    // The compatibility page names no token cap; from memory, unverified: check on the first call.
    maxTokensParam: 'max_tokens',
    structuredOutput: 'json_schema',
    finishReasons: BASE_FINISH_REASONS,
    requestIdHeader: null,
    quotaErrors: ['quota_exceeded'],
    extraBody: {},
    listing: { path: '/models', idPrefix: 'models/', headers: {} },
    dataPolicy: {
      trainingByDefault: 'depends',
      training: 'Free tier: used to improve products, and human reviewers may read it. Paid tier: not used. Paid means a Cloud project with active billing.',
      retention: 'Logged for abuse detection; the usage policy says 55 days.',
      zeroRetention: 'Not on this API: the documentation points to Vertex AI.',
      region: 'May be stored in any country where Google operates.',
      accountCheck: 'Confirm the key belongs to a project with active billing. No API reports this, and a free key works the same way. Restrict the key to the Gemini API: unrestricted standard keys are rejected.',
      source: 'https://aistudio.google.com/docs/terms',
      readOn: READ_ON,
    },
  },

  mistral: {
    id: 'mistral',
    name: 'Mistral',
    keyEnv: 'MISTRAL_API_KEY',
    baseUrlEnv: 'MISTRAL_BASE_URL',
    baseURL: 'https://api.mistral.ai/v1',
    adapter: 'chat-completions',
    completionPath: '/chat/completions',
    maxTokensParam: 'max_tokens',
    structuredOutput: 'json_schema',
    finishReasons: { ...BASE_FINISH_REASONS, model_length: 'max_tokens', error: 'retry' },
    requestIdHeader: null,
    quotaErrors: [],
    extraBody: {},
    listing: { path: '/models', idPrefix: '', headers: {} },
    dataPolicy: {
      trainingByDefault: 'depends',
      training: 'Free mode: may train. Pay-as-you-go: the customer can opt out, but the default is undocumented. Labs and Preview models always train, whatever the settings.',
      retention: '30 rolling days for abuse monitoring.',
      zeroRetention: 'Pay-as-you-go only, on request, at their discretion. Does not cover Labs or Preview models.',
      region: 'EU by default; some features may transfer data temporarily.',
      accountCheck: 'Turn off "Anonymous improvement data" under Privacy in the admin panel, and confirm the account is on pay-as-you-go.',
      source: 'https://legal.mistral.ai/terms/commercial-terms-of-service/',
      readOn: READ_ON,
    },
  },

  xai: {
    id: 'xai',
    name: 'xAI',
    keyEnv: 'XAI_API_KEY',
    baseUrlEnv: 'XAI_BASE_URL',
    baseURL: 'https://api.x.ai/v1',
    adapter: 'chat-completions',
    completionPath: '/chat/completions',
    maxTokensParam: 'max_completion_tokens',
    structuredOutput: 'json_schema',
    finishReasons: { ...BASE_FINISH_REASONS, end_turn: 'end_turn' },
    requestIdHeader: null,
    quotaErrors: [],
    extraBody: {},
    listing: { path: '/models', idPrefix: '', headers: {} },
    dataPolicy: {
      trainingByDefault: false,
      training: 'Never trains on API inputs or outputs without explicit permission.',
      retention: '30 days, encrypted, for auditing.',
      zeroRetention: 'Self-service per team in the console; each response reports it in x-zero-data-retention.',
      region: 'No guarantee on the default endpoint; the US endpoint costs 1.1x and only serves grok-4.7 and grok-4.6.',
      accountCheck: null,
      source: 'https://docs.x.ai/developers/faq/security',
      readOn: READ_ON,
    },
  },

  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    baseURL: 'https://api.deepseek.com',
    adapter: 'chat-completions',
    completionPath: '/chat/completions',
    maxTokensParam: 'max_tokens',
    structuredOutput: 'json_object',
    finishReasons: { ...BASE_FINISH_REASONS, insufficient_system_resource: 'retry', aborted: 'retry' },
    requestIdHeader: null,
    quotaErrors: [],
    extraBody: {},
    listing: { path: '/models', idPrefix: '', headers: {} },
    dataPolicy: {
      trainingByDefault: true,
      training: 'The privacy policy lists training as a purpose, with opt-out by email to privacy@deepseek.com. No document exempts the API.',
      retention: 'For as long as the account exists.',
      zeroRetention: 'Undocumented.',
      region: "Stored in the People's Republic of China, under its law.",
      accountCheck: 'Ask privacy@deepseek.com to opt out before sending anything.',
      source: 'https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html',
      readOn: READ_ON,
    },
  },

  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    keyEnv: 'PERPLEXITY_API_KEY',
    baseUrlEnv: 'PERPLEXITY_BASE_URL',
    baseURL: 'https://api.perplexity.ai',
    adapter: 'responses',
    completionPath: '/v1/agent',
    maxTokensParam: 'max_output_tokens',
    structuredOutput: 'json_schema',
    finishReasons: {},
    requestIdHeader: 'x-request-id',
    quotaErrors: [],
    extraBody: { store: false },
    listing: { path: '/v1/models', idPrefix: '', headers: {} },
    dataPolicy: {
      trainingByDefault: false,
      training: 'Customer Content is not used to train generative models, nor may third parties. Third-party models are also subject to their providers\' terms.',
      retention: 'No published period: it varies by API, model and account.',
      zeroRetention: 'Eligible customers only, by written agreement; not every model supports it.',
      region: 'Undocumented.',
      accountCheck: null,
      source: 'https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service',
      readOn: READ_ON,
    },
  },
};

/**
 * @param {string} id
 * @returns {Provider}
 */
export function getProvider(id) {
  if (Object.hasOwn(PROVIDERS, id)) return PROVIDERS[id];
  if (Object.hasOwn(EXCLUDED_PROVIDERS, id)) throw new Error(`Provider ${id} is not available: ${EXCLUDED_PROVIDERS[id]}`);
  throw new Error(`Unknown provider ${JSON.stringify(id)}. Known providers: ${Object.keys(PROVIDERS).join(', ')}`);
}

/**
 * Whether sending anything needs an explicit choice. `depends` counts: the code cannot see the
 * account's plan, and the wrong guess hands the bookmarks to a service that trains on them.
 *
 * @param {Provider} provider
 */
export function requiresTrainingConsent(provider) {
  return provider.dataPolicy.trainingByDefault !== false;
}

/**
 * What to show before spending: the policy, its source and how old the reading is.
 *
 * @param {Provider} provider
 * @returns {string[]} lines of text
 */
export function describeDataPolicy({ name, dataPolicy }) {
  const trains = dataPolicy.trainingByDefault === 'depends' ? 'depends on the account' : dataPolicy.trainingByDefault ? 'yes' : 'no';
  return [
    `${name}: trains by default: ${trains}. ${dataPolicy.training}`,
    `  Retention: ${dataPolicy.retention}`,
    `  Zero retention: ${dataPolicy.zeroRetention}`,
    `  Region: ${dataPolicy.region}`,
    ...(dataPolicy.accountCheck ? [`  Only you can check: ${dataPolicy.accountCheck}`] : []),
    `  Source: ${dataPolicy.source} (read ${dataPolicy.readOn})`,
  ];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * Where the key and the bookmarks go: the registry's fixed host, or a local test server. Any
 * other override is refused rather than ignored, so an inherited proxy setting cannot pass
 * unnoticed.
 *
 * @param {Provider} provider
 * @param {string} [override]
 * @returns {string} without a trailing slash
 */
export function resolveBaseURL(provider, override) {
  if (!override) return provider.baseURL;
  /** @type {URL | null} */
  let url = null;
  try {
    url = new URL(override);
  } catch {
    // Refused below, without quoting a value that might carry credentials.
  }
  const isLoopback = url !== null && (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password;
  if (!url || !isLoopback) {
    throw new Error(`A base URL for ${provider.id} must be a loopback address, for tests. Destinations are fixed by the provider registry.`);
  }
  return override.replace(/\/+$/, '');
}

/**
 * The same policies in Spanish, for the extension's pages: three lines that answer what the
 * person needs (does it train, how long it keeps the data, what only they can check), and the
 * full reading. A translation of `dataPolicy`, read on the same date; the source stays in English.
 *
 * @type {Record<string, {summary: [string, string, string], training: string, retention: string, zeroRetention: string, region: string, accountCheck: string | null}>}
 */
const POLICY_ES = {
  anthropic: {
    summary: ['No entrena con datos de la API por omisión.', 'Retención: hasta 30 días según el centro de privacidad; contenido señalado, hasta 2 años.', 'Crea la clave para un solo espacio de trabajo.'],
    training: 'Los datos comerciales y de la API no se usan para entrenar por omisión.',
    retention: 'Las fuentes no coinciden: el centro de privacidad dice que se borran en 30 días y la documentación de la API, que no se conservan por omisión. El contenido señalado se guarda hasta 2 años.',
    zeroRetention: 'Por acuerdo. Fable y Mythos exigen 30 días de retención.',
    region: 'Global por omisión; inference_geo "us" cuesta 1,1 veces.',
    accountCheck: 'Crea la clave para un solo espacio de trabajo: una clave sin uno necesita la cabecera anthropic-workspace-id, que esta herramienta no envía.',
  },
  openai: {
    summary: ['No entrena con datos de la API, salvo que la organización lo active.', 'Retención: registros de abuso con los mensajes, hasta 30 días.', 'Comprueba que compartir datos esté apagado en la organización.'],
    training: 'Los datos de la API no se usan para entrenar, salvo que la organización active compartirlos.',
    retention: 'Registros de control de abuso, que pueden contener mensajes y respuestas, hasta 30 días.',
    zeroRetention: 'Con aprobación, a través de ventas.',
    region: 'Residencia por proyecto a través de ventas, con un 10 % más en modelos recientes.',
    accountCheck: 'Confirma que compartir datos esté apagado en los ajustes de la organización.',
  },
  gemini: {
    summary: [
      'Plan gratuito: Google usa lo enviado para mejorar sus productos y personas pueden leerlo. Plan de pago: no.',
      'Retención: se registra para detectar abuso, unos 55 días.',
      'Solo tú puedes comprobar si tu proyecto tiene facturación activa; restringe la clave a la API de Gemini.',
    ],
    training: 'Plan gratuito: se usa para mejorar productos, y revisores humanos pueden leerlo. Plan de pago: no se usa. De pago significa un proyecto de Cloud con facturación activa.',
    retention: 'Se registra para detectar abuso; la política de uso dice 55 días.',
    zeroRetention: 'No en esta API: la documentación remite a Vertex AI.',
    region: 'Puede guardarse en cualquier país donde opere Google.',
    accountCheck: 'Confirma que la clave pertenece a un proyecto con facturación activa: ninguna API lo informa, y una clave gratuita funciona igual. Restringe la clave a la API de Gemini: las claves estándar sin restricción se rechazan.',
  },
  mistral: {
    summary: ['Modo gratuito: puede entrenar. Pago por uso: se puede desactivar.', 'Retención: 30 días para control de abuso.', 'Apaga «Anonymous improvement data» en la privacidad del panel.'],
    training: 'Modo gratuito: puede entrenar. Pago por uso: el cliente puede desactivarlo, pero el valor por omisión no está documentado. Los modelos Labs y Preview siempre entrenan.',
    retention: '30 días móviles para control de abuso.',
    zeroRetention: 'Solo pago por uso, a pedido y a su criterio. No cubre modelos Labs ni Preview.',
    region: 'UE por omisión; algunas funciones pueden transferir datos de forma temporal.',
    accountCheck: 'Apaga «Anonymous improvement data» en Privacidad del panel y confirma que la cuenta es de pago por uso.',
  },
  xai: {
    summary: ['Nunca entrena con la API sin permiso explícito.', 'Retención: 30 días, cifrado, para auditoría.', 'La retención cero se activa por equipo en la consola.'],
    training: 'Nunca entrena con entradas ni salidas de la API sin permiso explícito.',
    retention: '30 días, cifrado, para auditoría.',
    zeroRetention: 'Autoservicio por equipo en la consola; cada respuesta lo informa en x-zero-data-retention.',
    region: 'Sin garantía en el punto de acceso por omisión; el de EE. UU. cuesta 1,1 veces y solo sirve grok-4.7 y grok-4.6.',
    accountCheck: null,
  },
  deepseek: {
    summary: ['Entrena por omisión: su política lo incluye y no exime a la API.', 'Retención: mientras exista la cuenta; datos guardados en China.', 'Pide la exclusión a privacy@deepseek.com antes de enviar nada.'],
    training: 'La política de privacidad incluye el entrenamiento como fin, con exclusión por correo a privacy@deepseek.com. Ningún documento exime a la API.',
    retention: 'Mientras exista la cuenta.',
    zeroRetention: 'No documentada.',
    region: 'Se guarda en la República Popular China, bajo su ley.',
    accountCheck: 'Pide la exclusión a privacy@deepseek.com antes de enviar nada.',
  },
  perplexity: {
    summary: ['No entrena modelos con el contenido del cliente.', 'Retención: sin plazo publicado; varía por API, modelo y cuenta.', 'Los modelos de terceros siguen también las condiciones de su proveedor.'],
    training: 'El contenido del cliente no se usa para entrenar modelos generativos, ni pueden hacerlo terceros. Los modelos de terceros también siguen las condiciones de sus proveedores.',
    retention: 'Sin plazo publicado: varía según la API, el modelo y la cuenta.',
    zeroRetention: 'Solo clientes elegibles, por acuerdo escrito; no todos los modelos lo admiten.',
    region: 'No documentada.',
    accountCheck: null,
  },
};

/**
 * Three lines in Spanish for the settings page.
 *
 * @param {Provider} provider
 * @returns {string[]}
 */
export function policySummaryEs(provider) {
  return [...(POLICY_ES[provider.id]?.summary ?? describeDataPolicy(provider).slice(0, 3))];
}

/**
 * The whole policy in Spanish, with its source and reading date.
 *
 * @param {Provider} provider
 * @returns {string[]}
 */
export function policyFullEs(provider) {
  const es = POLICY_ES[provider.id];
  if (!es) return describeDataPolicy(provider);
  const { trainingByDefault, source, readOn } = provider.dataPolicy;
  const trains = trainingByDefault === 'depends' ? 'depende de la cuenta' : trainingByDefault ? 'sí' : 'no';
  return [
    `${provider.name}: entrena por omisión: ${trains}. ${es.training}`,
    `Retención: ${es.retention}`,
    `Retención cero: ${es.zeroRetention}`,
    `Región: ${es.region}`,
    ...(es.accountCheck ? [`Solo tú puedes comprobar: ${es.accountCheck}`] : []),
    `Fuente: ${source} (leída el ${readOn}, en inglés)`,
  ];
}
