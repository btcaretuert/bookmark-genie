import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { estimateTokens, makeBatches } from '../../extension/core/batching.js';
import { BudgetExceededError, costOf, createBudget, formatUsd, withBudget } from '../../extension/core/budget.js';
import { buildClassifyRequest, classifyBatch, DEFAULT_REASONING_ALLOWANCE, reasoningAllowanceFor, UNCLASSIFIED, UNSORTED } from '../../extension/core/classify.js';
import { budgetPrices, effortFor, findModel, isExpectedServedModel, manifestPrices, parseModelRef } from '../../extension/core/models.js';
import { cleanText, cleanTitle } from '../../extension/core/prompt.js';
import { summarizeQuality } from '../../extension/core/quality.js';
import { planRun } from '../../extension/core/sampling.js';
import { buildTaxonomyRequest, parseTaxonomyFile, proposeTaxonomy } from '../../extension/core/taxonomy.js';
import { selectSendable } from '../../extension/core/url.js';
import { RetryLaterError } from '../../extension/platform/llm.js';
import { createComplete } from '../../extension/platform/complete-factory.js';
import { ProviderRequestError } from '../../extension/platform/openai-compatible.js';
import { describeDataPolicy, getProvider, requiresTrainingConsent, resolveBaseURL } from '../../extension/platform/providers.js';
import { UsageError } from './args.mjs';
import { toCsv } from './csv.mjs';
import { assessCompleteness, createManifest, describeTool, keySuffix, modelFileStem, sha256, summarizeModel, updateManifest, writeManifest } from './manifest.mjs';
import { parseNetscapeBookmarks } from './netscape.mjs';
import { appendLine, createRunDir, writeAtomic, writeNew } from './output.mjs';
import { renderReport } from './report.mjs';
import { redact } from './safe-text.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_RETRY_ATTEMPTS = 5;
const MAX_RETRY_WAIT_MS = 5 * 60 * 1000;
/** A timed-out call may have been billed in full, so a second one is the limit. */
const MAX_TIMEOUTS = 2;
/** Rough answer size per bookmark for the pre-flight estimate. Reasoning is not included. */
const ESTIMATED_OUTPUT_TOKENS_PER_ITEM = 15;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 512;

/** @typedef {import('../../extension/core/types.js').Complete} Complete */
/** @typedef {import('../../extension/core/types.js').ModelResult} ModelResult */
/** @typedef {import('../../extension/core/types.js').ModelMetrics} ModelMetrics */
/** @typedef {import('./args.mjs').RunOptions} RunOptions */
/** @typedef {import('../../extension/core/budget.js').Budget} Budget */
/** @typedef {{id: string, title: string, url: string, folderPath: string}} Sendable */
/**
 * @typedef {{
 *   taxonomySample: Sendable[], classificationSample: Sendable[], reviewItems: Sendable[],
 *   maxFolders: number, existingFolders: string[],
 * }} Plan `planRun` is generic over its items, but its return type does not carry them
 */

/** The run was stopped by a signal. Nothing is wrong with the model. */
export class InterruptedError extends Error {}

/** A model failed in a way that is about the model, not about this program. */
class ModelFailure extends Error {}

/**
 * @param {unknown} error
 * @returns {boolean} whether the message alone explains it, so no stack is worth printing
 */
function isExpected(error) {
  const failure = /** @type {{status?: unknown} | null} */ (error);
  return (
    error instanceof RetryLaterError ||
    error instanceof ProviderRequestError ||
    error instanceof BudgetExceededError ||
    error instanceof ModelFailure ||
    // APIError of the Anthropic SDK: it carries the HTTP status.
    (error instanceof Error && typeof failure?.status === 'number')
  );
}

/** @param {{system: string, user: string, schema: object}} request */
function estimateRequestTokens({ system, user, schema }) {
  return estimateTokens(system + user + JSON.stringify(schema));
}

/** @returns {ModelMetrics} */
function newMetrics() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    maxThinkingTokens: 0,
    latencies: [],
    fallbacks: 0,
    waits: 0,
    failedCalls: 0,
    spentUsd: 0,
    lostUsd: 0,
    servedModels: {},
  };
}

/**
 * What a run needs to know about each model before spending: where the key goes, which key, which
 * effort really travels. Nothing here reads the environment except the two variables of the
 * provider itself, so no other credential or destination can come in.
 *
 * @param {string} ref
 * @param {RunOptions} options
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveModel(ref, options, env) {
  const { provider: providerId } = parseModelRef(ref);
  const provider = getProvider(providerId);
  const entry = /** @type {NonNullable<ReturnType<typeof findModel>>} */ (findModel(ref));
  const apiKey = env[provider.keyEnv] ?? '';
  const baseOverride = env[provider.baseUrlEnv] || undefined;
  const baseURL = resolveBaseURL(provider, baseOverride);
  const effort = effortFor(entry, options.effort);
  // Without an effort to send, the margin follows what the model does by itself, if documented.
  const reasoningEffort = effort ?? entry.defaultEffort;
  const reasoningAllowance = reasoningEffort === null ? DEFAULT_REASONING_ALLOWANCE : reasoningAllowanceFor(reasoningEffort);
  const fallback = options.fallback && entry.serverFallback;
  return { ref, provider, entry, apiKey, baseOverride, baseURL, effort, reasoningAllowance, fallback };
}

/**
 * @param {ReturnType<typeof resolveModel>} model
 */
export function assertKeyShape({ provider, apiKey }) {
  if (apiKey === '') throw new Error(`${provider.keyEnv} is not set. Nothing else is used as a credential.`);
  // A key with a space or a line break fails inside the HTTP library, which quotes it back.
  if (apiKey.length < MIN_KEY_LENGTH || apiKey.length > MAX_KEY_LENGTH || !/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new Error(`${provider.keyEnv} does not look like an API key (no spaces or control characters, ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} characters).`);
  }
}

/**
 * @param {ModelMetrics} metrics
 * @param {import('../../extension/core/types.js').CompletionResult} result
 */
function recordUsage(metrics, result) {
  metrics.inputTokens += result.usage.inputTokens;
  metrics.outputTokens += result.usage.outputTokens;
  metrics.thinkingTokens += result.usage.thinkingTokens;
  metrics.maxThinkingTokens = Math.max(metrics.maxThinkingTokens, result.usage.thinkingTokens);
  metrics.latencies.push(result.latencyMs);
  if (result.usage.usedFallback) metrics.fallbacks += 1;
  // What answered is the model the response names; the attempts only set the price.
  metrics.servedModels[result.servedModel] = (metrics.servedModels[result.servedModel] ?? 0) + 1;
}

/**
 * Wraps a model's `complete` with the budget, the usage accounting and the retry policy. The budget
 * sits inside the loop so every attempt is checked against its own worst case.
 *
 * @param {Complete} complete
 * @param {{
 *   ref: string,
 *   model: string,
 *   budget: Budget,
 *   mayFallback: boolean,
 *   signal: AbortSignal,
 *   interruption: Promise<never>,
 *   log: (line: string) => void,
 * }} context
 */
export function instrument(complete, { ref, model, budget, mayFallback, signal, interruption, log }) {
  const metrics = newMetrics();
  const warnedServed = new Set();
  const budgeted = withBudget(complete, { model, budget, estimateTokens, mayFallback, prices: budgetPrices() });

  /** @type {Complete} */
  async function instrumented(request) {
    let timeouts = 0;
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) throw new InterruptedError('interrupted');
      const spentBefore = budget.spentUsd;
      const lostBefore = budget.lostUsd;
      try {
        const pending = budgeted(request);
        // If the race is lost to a signal, the call may still fail later and nobody is listening.
        pending.catch(() => {});
        const result = await Promise.race([pending, interruption]);
        metrics.spentUsd += budget.spentUsd - spentBefore;
        metrics.lostUsd += budget.lostUsd - lostBefore;
        recordUsage(metrics, result);
        if (!isExpectedServedModel(ref, result.servedModel) && !warnedServed.has(result.servedModel)) {
          warnedServed.add(result.servedModel);
          log(`Warning: ${ref} was answered by ${result.servedModel}, not by the model asked for. The answers are of that model.`);
        }
        return result;
      } catch (error) {
        metrics.spentUsd += budget.spentUsd - spentBefore;
        metrics.lostUsd += budget.lostUsd - lostBefore;
        if (!(error instanceof RetryLaterError)) throw error;
        metrics.failedCalls += 1;
        if (error.timedOut) timeouts += 1;
        if (attempt === MAX_RETRY_ATTEMPTS || timeouts >= MAX_TIMEOUTS) throw error;
        const waitMs = error.retryAfterMs ?? 2 ** attempt * 1000;
        if (waitMs > MAX_RETRY_WAIT_MS) throw error;
        metrics.waits += 1;
        log(`  ${error.message}: waiting ${Math.ceil(waitMs / 1000)} s`);
        await sleep(waitMs, undefined, { signal }).catch(() => {
          throw new InterruptedError('interrupted');
        });
      }
    }
  }
  return { complete: instrumented, metrics };
}

/**
 * Previews the size of a run. Reasoning tokens cannot be known in advance, so this is not a
 * limit: the real protection is the per-call ceiling of `withBudget`.
 *
 * @param {Plan} plan
 * @param {string} language
 * @param {import('../../extension/core/types.js').Folder[] | null} fixedFolders given folders: no taxonomy request will be made
 */
function estimateTokensOfRun(plan, language, fixedFolders) {
  const placeholderFolders = fixedFolders ?? Array.from({ length: plan.maxFolders }, (_, i) => ({
    name: `Folder name ${i}`,
    description: 'A short description of what this folder holds.',
  }));
  const taxonomyTokens = fixedFolders !== null
    ? 0
    : estimateRequestTokens(buildTaxonomyRequest({ existingFolders: plan.existingFolders, sample: plan.taxonomySample, maxFolders: plan.maxFolders, language }));
  const batches = makeBatches(plan.classificationSample);
  const inputTokens =
    taxonomyTokens +
    batches.reduce((sum, batch) => sum + estimateRequestTokens(buildClassifyRequest(batch, placeholderFolders)), 0);
  const outputTokens = plan.classificationSample.length * ESTIMATED_OUTPUT_TOKENS_PER_ITEM + (fixedFolders ? 0 : placeholderFolders.length * 40);
  return { inputTokens, outputTokens, batchCount: batches.length };
}

/** @param {Record<string, number>} counts */
const summarizeCounts = (counts) =>
  Object.entries(counts)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ') || 'none';

/**
 * Installs the first SIGINT/SIGTERM/SIGHUP (a closed terminal) as a request to stop and exits at once on the second.
 *
 * @param {AbortController} controller
 * @param {{name: string | null}} received
 */
export function listenForSignals(controller, received) {
  /** @param {NodeJS.Signals} name */
  const handler = (name) => {
    if (received.name !== null) process.exit(130);
    received.name = name;
    controller.abort();
  };
  const names = /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']);
  const listeners = names.map((name) => /** @type {const} */ ([name, () => handler(name)]));
  for (const [name, listener] of listeners) process.on(name, listener);
  return () => {
    for (const [name, listener] of listeners) process.off(name, listener);
  };
}

/**
 * Runs one model through the whole sample. Whatever is paid for reaches the disk as it arrives:
 * the folders as each attempt starts, the answers of each response before the next call.
 *
 * @param {{
 *   model: ReturnType<typeof resolveModel>,
 *   plan: Plan,
 *   options: RunOptions,
 *   fixedFolders: import('../../extension/core/types.js').Folder[] | null,
 *   budget: Budget,
 *   Anthropic: any,
 *   dir: string,
 *   signal: AbortSignal,
 *   interruption: Promise<never>,
 *   result: ModelResult,
 *   checkpoint: () => Promise<void>,
 *   log: (line: string) => void,
 * }} input `result` is filled in place, so a failure leaves what had been learned
 */
async function evaluateModel({ model, plan, options, fixedFolders, budget, Anthropic, dir, signal, interruption, result, checkpoint, log }) {
  const { ref, entry, apiKey, baseOverride, reasoningAllowance } = model;
  const stem = modelFileStem(ref);
  const raw = createComplete({ ref, apiKey, baseURL: baseOverride, Anthropic, effort: options.effort, fallback: model.fallback });
  const { complete, metrics } = instrument(raw, { ref, model: entry.id, budget, mayFallback: model.fallback, signal, interruption, log });
  result.metrics = metrics;
  const taxonomyPath = join(dir, `taxonomy-${stem}.json`);
  /** @param {string} source */
  const taxonomyFile = (source) =>
    `${JSON.stringify({ folders: result.folders, dropped: result.dropped, built_from: result.taxonomyBuiltFrom, source }, null, 2)}\n`;

  if (fixedFolders) {
    result.folders = fixedFolders;
    result.fixedTaxonomy = true;
    result.taxonomySpentUsd = 0;
    await writeNew(taxonomyPath, taxonomyFile('file'));
  } else {
    /** @param {import('../../extension/core/taxonomy.js').TaxonomyProgress} progress */
    const keep = (progress) => {
      result.folders = progress.folders;
      result.dropped = progress.dropped;
      result.taxonomyAttempts = progress.attempts;
      result.taxonomyBuiltFrom = progress.builtFrom;
      result.taxonomyRefusals = progress.refusals;
      result.taxonomyTruncations = progress.truncations;
    };
    let taxonomy;
    try {
      taxonomy = await proposeTaxonomy(complete, {
        existingFolders: plan.existingFolders,
        sample: plan.taxonomySample,
        maxFolders: plan.maxFolders,
        language: options.language,
        reasoningAllowance,
        // A later attempt can fail after an earlier one paid for a usable taxonomy.
        onProgress: async (progress) => {
          keep(progress);
          if (progress.folders.length > 0) await writeAtomic(taxonomyPath, taxonomyFile('model'));
        },
      });
    } finally {
      result.taxonomySpentUsd = metrics.spentUsd - metrics.lostUsd;
    }
    keep(taxonomy);
    if (taxonomy.folders.length === 0) {
      throw new ModelFailure(`${ref} returned no usable folders (stop reason: ${taxonomy.lastStopReason})`);
    }
    await writeAtomic(taxonomyPath, taxonomyFile('model'));
  }
  await checkpoint();

  const assignmentsPath = join(dir, `assignments-${stem}.jsonl`);
  const total = plan.classificationSample.length;
  for (const batch of makeBatches(plan.classificationSample)) {
    await classifyBatch(complete, batch, result.folders, {
      reasoningAllowance,
      stats: result.totals,
      // Kept in the result only once on disk, so a failure of a later call loses nothing that was paid for.
      onResolved: async ({ assignments, unclassified }) => {
        for (const { id, folder, confidence, servedModel, requestId } of assignments) {
          await appendLine(assignmentsPath, JSON.stringify({ id, folder, confidence, served_model: servedModel, request_id: requestId }));
        }
        for (const { id, reason, refusalCategory } of unclassified) {
          await appendLine(assignmentsPath, JSON.stringify({ id, unclassified: reason, refusal_category: refusalCategory }));
        }
        result.assignments.push(...assignments);
        result.unclassified.push(...unclassified);
      },
    });
    await checkpoint();
    log(`  ${ref}: ${result.assignments.length + result.unclassified.length}/${total} (${formatUsd(budget.spentUsd)} spent)`);
  }
}

/**
 * @param {RunOptions} options
 * @param {{env?: NodeJS.ProcessEnv}} [context]
 * @returns {Promise<number>} exit code
 */
export async function run(options, { env = process.env } = {}) {
  const startedAt = new Date().toISOString();
  const inputBytes = await readFile(options.input);
  const bookmarks = parseNetscapeBookmarks(inputBytes.toString('utf8'));
  const { sendable, excluded } = selectSendable(bookmarks, { excludeFolder: options.excludeFolder });
  if (sendable.length === 0) throw new Error(`No sendable bookmarks found in ${options.input}`);

  const plan = /** @type {Plan} */ (planRun(sendable, { seed: options.seed, sample: options.sample, review: options.review }));
  if (plan.classificationSample.length === 0) throw new Error('The collection is too small: nothing is left to classify after the folder sample.');
  const quality = summarizeQuality({ bookmarks, sendable });

  const fixedFolders = options.taxonomy ? parseTaxonomyFile(await readFile(options.taxonomy, 'utf8')) : null;
  const taxonomyFileSha = options.taxonomy ? sha256(await readFile(options.taxonomy)) : null;

  const models = options.models.map((ref) => resolveModel(ref, options, env));
  const providers = [...new Map(models.map((model) => [model.provider.id, model.provider])).values()];
  const secrets = models.map((model) => model.apiKey);
  /** @param {unknown} message */
  const safe = (message) => redact(message, secrets);
  /** @param {string} line */
  const log = (line) => console.error(safe(line));

  if (!options.dryRun) {
    for (const model of models) assertKeyShape(model);
  }

  // What the person is agreeing to goes on screen before anything leaves, also in a dry run.
  for (const provider of providers) {
    for (const line of describeDataPolicy(provider)) console.log(line);
  }
  const needConsent = providers.filter((provider) => requiresTrainingConsent(provider) && !options.acceptedPolicies.includes(provider.id));
  if (needConsent.length > 0) {
    const names = needConsent.map((provider) => provider.id).join(', ');
    const message = `The data policy of ${names} needs your explicit consent: add ${needConsent.map((provider) => `--accept-data-policy ${provider.id}`).join(' ')}.`;
    if (!options.dryRun) throw new Error(message);
    console.log(`Dry run: ${message}`);
  }
  for (const model of models) {
    if (model.entry.idStability === 'moving-alias') {
      console.log(`Warning: ${model.ref} is a moving alias. What it serves can change, so this measurement may not be reproducible; the served model is recorded for each answer.`);
    }
    if (model.effort === null) console.log(`Note: ${model.ref} has no confirmed "${options.effort}" effort level, so none is sent and the model's own default applies.`);
  }

  for (const pattern of options.excludePatterns) {
    if (!bookmarks.some((bookmark) => pattern.test(cleanText(bookmark.folderPath).normalize('NFC')))) {
      const message = `--exclude-folder ${JSON.stringify(pattern.source)} matches no folder, so it excludes nothing. Check it for a typo.`;
      // A typo in a privacy filter must not end in a send. A dry run only looks, so it only warns.
      if (!options.dryRun) throw new UsageError(`${message} Nothing was sent.`);
      console.log(`Warning: ${message}`);
    }
  }
  if (options.fallback) {
    for (const model of models.filter((item) => !item.fallback)) console.log(`Note: ${model.ref} has no server-side fallback, so --fallback does nothing for it.`);
  }

  const { dir } = await createRunDir(options.out ?? join(PROJECT_ROOT, 'eval-out', startedAt.replaceAll(':', '-')));

  const previewPath = join(dir, 'payload-preview.jsonl');
  const taxonomyIds = new Set(plan.taxonomySample.map((item) => item.id));
  const reviewIds = new Set(plan.reviewItems.map((item) => item.id));
  // With a given taxonomy no folder request is made, so that sample and the folder names stay home.
  const previewItems = fixedFolders ? plan.classificationSample : [...plan.taxonomySample, ...plan.classificationSample];
  await writeNew(
    previewPath,
    `${previewItems.map((item) => JSON.stringify({ id: item.id, title: cleanTitle(item.title), url: item.url, in_taxonomy_sample: taxonomyIds.has(item.id), in_review: reviewIds.has(item.id) })).join('\n')}\n`,
  );
  const foldersPath = join(dir, 'existing-folders.json');
  if (!fixedFolders) await writeNew(foldersPath, `${JSON.stringify(plan.existingFolders, null, 2)}\n`);

  const estimate = estimateTokensOfRun(plan, options.language, fixedFolders);

  /** @type {import('./manifest.mjs').Manifest | null} */
  let manifest = null;
  if (models.length > 0) {
    const emptyClassify = (/** @type {number} */ allowance) => buildClassifyRequest([], [], { reasoningAllowance: allowance });
    manifest = createManifest({
      startedAt,
      tool: await describeTool(),
      inputBytes,
      bookmarks: bookmarks.length,
      sendable: sendable.length,
      excluded,
      params: {
        seed: options.seed,
        sample: options.sample,
        review: options.review,
        language: options.language,
        max_usd: options.maxUsd,
        effort: options.effort,
        fallback: options.fallback,
        dry_run: options.dryRun,
        max_folders: plan.maxFolders,
        exclude_folder: options.excludeFolder?.source ?? null,
        taxonomy_file_sha256: taxonomyFileSha,
      },
      models: models.map((model) => ({
        ref: model.ref,
        endpoint: model.baseURL,
        keySuffix: keySuffix(model.apiKey),
        dataPolicy: model.provider.dataPolicy,
        effort: model.effort,
        fallback: model.fallback,
        prompts: {
          classify: emptyClassify(model.reasoningAllowance),
          taxonomy: fixedFolders
            ? null
            : buildTaxonomyRequest({ existingFolders: [], sample: [], maxFolders: 0, language: options.language, reasoningAllowance: model.reasoningAllowance }),
        },
      })),
      prices: manifestPrices(),
      taxonomySampleIds: plan.taxonomySample.map((item) => item.id),
      sampleIds: plan.classificationSample.map((item) => item.id),
      reviewIds: plan.reviewItems.map((item) => item.id),
      quality,
    });
    await writeManifest(dir, manifest);
  }

  console.log(`Bookmarks in export: ${bookmarks.length}`);
  console.log(`Never sent: ${bookmarks.length - sendable.length} (${summarizeCounts(excluded)})`);
  console.log(
    `Data quality (counts): exact duplicates ${quality.exactDuplicates}, empty titles ${quality.emptyTitles}, title equal to URL ${quality.titleIsUrl}, URL reduced to the host ${quality.hostOnlyUrls}`,
  );
  console.log(
    `${fixedFolders ? '' : `Folder sample: ${plan.taxonomySample.length}. `}Classification sample: ${plan.classificationSample.length} in ${estimate.batchCount} batches. To review: ${plan.reviewItems.length}.`,
  );
  console.log(`Estimated tokens, without reasoning: ${estimate.inputTokens} in / ${estimate.outputTokens} out`);
  for (const model of models) {
    console.log(`  ${model.ref}: about ${formatUsd(costOf(model.entry.id, estimate.inputTokens, estimate.outputTokens, budgetPrices()))}`);
  }
  console.log(`Spending cap: ${formatUsd(options.maxUsd)}`);
  console.log(`Preview of the titles and URLs that would leave, as the model would see them: ${previewPath}`);
  if (!fixedFolders) console.log(`Existing folder names that would leave: ${foldersPath}`);
  console.log('The preview is not the literal request: the request adds the prompt, the folder list and the schema.');
  for (const model of models) {
    console.log(`Destination: ${model.ref} -> ${model.baseURL}${keySuffix(model.apiKey) ? ` (key ending ${keySuffix(model.apiKey)})` : ''}`);
  }

  if (options.dryRun) {
    if (manifest) {
      manifest = updateManifest(manifest, { status: 'complete', finishedAt: new Date().toISOString(), exitCode: 0 });
      await writeManifest(dir, manifest);
    }
    console.log('Dry run: nothing was sent.');
    return 0;
  }
  if (!manifest) throw new Error('A run needs at least one model');

  // The key is explicit, so the SDK has no reason to look for another credential. Remove the
  // ones it would otherwise add to the request, so none can travel with this one.
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_PROFILE;
  // Gateway settings that carry their own credentials would travel with every request.
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  const Anthropic = models.some((model) => model.provider.adapter === 'anthropic-sdk') ? (await import('@anthropic-ai/sdk')).default : null;

  const budget = /** @type {Budget} */ (createBudget(options.maxUsd));
  const controller = new AbortController();
  const received = { name: /** @type {string | null} */ (null) };
  const stopListening = listenForSignals(controller, received);
  /** @type {Promise<never>} */
  const interruption = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new InterruptedError('interrupted')), { once: true });
  });
  interruption.catch(() => {});

  /** @type {ModelResult[]} */
  const results = [];
  const failures = /** @type {string[]} */ ([]);
  let spendingStop = false;
  let haltRun = false;
  let interrupted = false;

  /** @param {Parameters<typeof updateManifest>[1]} update */
  const save = async (update) => {
    const broken = budget.capBrokenBy;
    manifest = updateManifest(/** @type {import('./manifest.mjs').Manifest} */ (manifest), {
      spentUsd: budget.spentUsd,
      lostUsd: budget.lostUsd,
      ...(broken ? { capBrokenBy: { model: broken.model, max_tokens: broken.maxTokens, output_tokens: broken.outputTokens } } : {}),
      ...update,
    });
    await writeManifest(dir, manifest);
  };

  try {
    for (const model of models) {
      if (spendingStop || haltRun || interrupted) break;
      console.error(`Evaluating ${model.ref}`);
      /** @type {ModelResult} */
      const result = {
        model: model.ref,
        status: 'running',
        effort: model.effort,
        folders: [],
        dropped: [],
        taxonomyAttempts: 0,
        taxonomyBuiltFrom: 0,
        taxonomyRefusals: 0,
        taxonomyTruncations: 0,
        assignments: [],
        unclassified: [],
        totals: { calls: 0, retries: 0, splits: 0, refusals: 0, truncations: 0, invalidEntries: 0 },
        metrics: newMetrics(),
      };
      results.push(result);
      await save({ model: { requested: model.ref, status: 'running' } });

      let stoppedBy = null;
      try {
        await evaluateModel({
          model,
          plan,
          options,
          fixedFolders,
          budget,
          Anthropic,
          dir,
          signal: controller.signal,
          interruption,
          result,
          checkpoint: () => save({ model: summarizeModel({ ...result, model: model.ref, metrics: result.metrics }) }),
          log,
        });
        result.status = 'complete';
      } catch (error) {
        result.status = 'stopped';
        if (error instanceof InterruptedError) {
          interrupted = true;
          stoppedBy = `interrupted by ${received.name ?? 'a signal'}; a call in flight may still be billed`;
        } else {
          if (error instanceof BudgetExceededError) spendingStop = true;
          if (/** @type {{stopsRun?: unknown}} */ (error)?.stopsRun === true) haltRun = true;
          stoppedBy = `${model.ref}: ${safe(/** @type {Error} */ (error).message)}`;
          if (!isExpected(error)) console.error(safe(/** @type {Error} */ (error).stack ?? String(error)));
          failures.push(stoppedBy);
        }
      }

      if (result.status === 'complete') {
        const reviewById = new Map(result.assignments.map((assignment) => [assignment.id, assignment]));
        const rows = plan.reviewItems.map((item) => {
          const assignment = reviewById.get(item.id);
          return ['', item.id, cleanTitle(item.title), item.url, item.folderPath, assignment?.folder ?? UNCLASSIFIED, assignment?.confidence ?? ''];
        });
        await writeNew(
          join(dir, `review-${modelFileStem(model.ref)}.csv`),
          toCsv(['judgment', 'id', 'title', 'url', 'original_folder', 'assigned_folder', 'confidence'], rows),
        );
      }
      await save({ model: { ...summarizeModel({ ...result, model: model.ref, metrics: result.metrics }), stopped_by: stoppedBy } });
      if (stoppedBy && interrupted) break;
    }
  } finally {
    stopListening();
    // Whatever happens to the disk after this, what was spent is said.
    console.log(`Total spent: ${formatUsd(budget.spentUsd)}${budget.lostUsd > 0 ? ` (${formatUsd(budget.lostUsd)} charged for calls that gave no usable answer)` : ''}${interrupted ? ' (a call in flight may still be billed)' : ''}`);
    if (budget.spentUsd > budget.maxUsd) console.error(`The spending cap was crossed: ${formatUsd(budget.spentUsd)} of ${formatUsd(budget.maxUsd)}.`);
    if (budget.capBrokenBy) {
      const broken = budget.capBrokenBy;
      console.error(`The cap cannot be guaranteed with ${broken.model}: it returned ${broken.outputTokens} output tokens for a maximum of ${broken.maxTokens}. Try --effort none if the model allows it.`);
    }
  }

  const overCap = budget.spentUsd > budget.maxUsd;
  const broken = budget.capBrokenBy;
  const exitCode = interrupted ? 130 : spendingStop || overCap || broken ? 2 : failures.length > 0 ? 1 : 0;
  const allComplete = results.length === models.length && results.every((result) => result.status === 'complete');
  const interruptedBy = `interrupted by ${received.name ?? 'a signal'}; a call in flight may still be billed`;
  const stopReason = interrupted ? interruptedBy : failures.length > 0 ? failures.join('; ') : allComplete ? null : 'not every model ran';
  await save({
    status: allComplete ? 'complete' : 'stopped',
    finishedAt: new Date().toISOString(),
    exitCode,
    ...(allComplete ? {} : { stoppedBy: safe(stopReason) }),
  });
  await writeNew(join(dir, 'report.md'), renderReport({ manifest: /** @type {any} */ ({ ...manifest, taxonomy_sha256: taxonomyFileSha }), results }));
  console.log(`Report: ${join(dir, 'report.md')}`);
  console.log(`Manifest: ${join(dir, 'manifest.json')}`);
  const expected = plan.classificationSample.length;
  for (const result of results) {
    if (result.status === 'complete') console.log(`Review: ${join(dir, `review-${modelFileStem(result.model)}.csv`)}`);
    const { missing, notAttempted, complete } = assessCompleteness(/** @type {any} */ (summarizeModel({ ...result, metrics: result.metrics })), expected);
    const placed = result.assignments.filter((assignment) => assignment.folder !== UNSORTED).length;
    console.log(`${result.model}: ${result.status}, placed ${placed} of ${expected}, unsorted ${result.assignments.length - placed}, unclassified ${result.unclassified.length}`);
    console.log(`  M0 completeness: ${result.status === 'complete' && complete ? 'PASS' : 'FAIL'} (missing=${missing}, not attempted=${notAttempted})`);
  }
  if (!allComplete) console.error(`Stopped early. ${safe(stopReason)}`);
  return exitCode;
}
