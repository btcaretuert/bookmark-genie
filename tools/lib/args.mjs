import { parseArgs } from 'node:util';

import { CATALOG, findModel, parseModelRef } from '../../extension/core/models.js';
import { EXCLUDED_PROVIDERS, PROVIDERS } from '../../extension/platform/providers.js';

export const EFFORTS = ['none', 'low', 'medium', 'high'];

/** A mistake in what the person typed: the message is the whole story, no stack. */
export class UsageError extends Error {}

export const HELP = `Usage:
  eval.mjs run --input <bookmarks.html> --models <provider/model,...> [options]
  eval.mjs blind <run-dir>... [--out file] [--seed 1] [--previous judged.csv]...
  eval.mjs score <review.csv | judged-list.csv>...
  eval.mjs models [--provider <id>] [--check] [--candidates]
  eval.mjs autosort-check --input <bookmarks.html> --models <provider/model> [options]
  eval.mjs --help

run options:
  --input <file>              Chrome bookmarks export (HTML). Required.
  --models <a,b>              provider/model references; required, except with --dry-run.
  --dry-run                   Send nothing: write the preview and print the estimate.
  --sample <n>                Bookmarks to classify (default 300).
  --review <n>                Bookmarks to judge by hand (default 100).
  --seed <n>                  Seed of every random choice (default 1).
  --language <name>           Language of folder names (default Spanish).
  --max-usd <amount>          Spending cap across all models, a decimal with a point (default 1).
  --effort none|low|medium|high
                              Reasoning effort, sent only where the catalog confirms it (default low).
                              "none" is refused for a model that does not document it.
  --taxonomy <file.json>      Use these folders instead of asking each model for them.
  --exclude-folder <regex>    Never send bookmarks whose folder path matches (case-insensitive); repeatable.
  --accept-data-policy <id>   Accept that provider's data policy; repeat per provider. Required for
                              providers that train on API data by default or may, per account.
  --fallback                  Anthropic only: allow server-side refusal fallback to another model.
  --out <dir>                 New run directory (default <project>/eval-out/<timestamp>); must not exist.

autosort-check (IA-12): measures the extension's Ctrl+D prompt on the export, with the extension's
own context builder: a bookmark taken out of its folder, a whole folder removed, loose bookmarks.
It takes --input, --models, --dry-run, --seed, --max-usd, --effort, --exclude-folder,
--accept-data-policy and --out from run, and:
  --repeat <n>                Calls per case (default 3); Gemini 3 ignores temperature.
  --max-cases <n>             Cases to measure (default 60).
  --pause <seconds>           Wait between calls, for free-tier rate limits (default 4).
  --context full|bookmark-only
                              The extension's context setting (default full).

Keys come from each provider's own variable (${Object.values(PROVIDERS).map((provider) => provider.keyEnv).join(', ')}).
Nothing else is read as a credential.

Exit codes of run: 0 finished, 1 a model failed or an error, 2 spending cap, 130 interrupted.

Known models:
${CATALOG.map((entry) => `  ${entry.ref}`).join('\n')}
`;

/**
 * @param {string[]} argv
 * @returns {{command: string | undefined, positionals: string[], values: Record<string, any>}}
 */
export function parseCli(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      input: { type: 'string' },
      out: { type: 'string' },
      models: { type: 'string' },
      sample: { type: 'string', default: '300' },
      review: { type: 'string', default: '100' },
      seed: { type: 'string', default: '1' },
      language: { type: 'string', default: 'Spanish' },
      'max-usd': { type: 'string', default: '1' },
      effort: { type: 'string', default: 'low' },
      taxonomy: { type: 'string' },
      'exclude-folder': { type: 'string', multiple: true, default: [] },
      'accept-data-policy': { type: 'string', multiple: true, default: [] },
      previous: { type: 'string', multiple: true, default: [] },
      provider: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      fallback: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      candidates: { type: 'boolean', default: false },
      repeat: { type: 'string', default: '3' },
      'max-cases': { type: 'string', default: '60' },
      pause: { type: 'string', default: '4' },
      context: { type: 'string', default: 'full' },
    },
  });
  return { command: positionals[0], positionals: positionals.slice(1), values };
}

/**
 * @param {string} name
 * @param {string} text
 * @param {number} min
 */
function toInteger(name, text, min) {
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < min) throw new UsageError(`--${name} must be a whole number of at least ${min}, got ${JSON.stringify(text)}`);
  return value;
}

/**
 * Validates what a run is about to spend money on, before anything is read or sent. A wrong
 * `--max-usd` is the dangerous one: NaN compares false against everything and would disable the cap.
 *
 * @param {Record<string, any>} values
 */
export function parseRunOptions(values) {
  if (!values.input) throw new UsageError('Missing --input <bookmarks.html>');

  const maxText = String(values['max-usd']);
  const maxUsd = /^(\d+\.?\d*|\.\d+)$/.test(maxText) ? Number(maxText) : NaN;
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    throw new UsageError(`--max-usd must be a positive amount with a decimal point, such as 1.5; got ${JSON.stringify(maxText)}`);
  }

  if (!EFFORTS.includes(values.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}, got ${JSON.stringify(values.effort)}`);

  // NFC, like the folder paths it is matched against, or an accented pattern would miss them.
  const excludePatterns = /** @type {string[]} */ (values['exclude-folder']).map((source) => {
    if (source === '') throw new UsageError('--exclude-folder is empty, and an empty pattern would exclude everything');
    try {
      return new RegExp(source.normalize('NFC'), 'iu');
    } catch {
      throw new UsageError(`--exclude-folder is not a valid regular expression: ${JSON.stringify(source)}`);
    }
  });
  const excludeFolder = excludePatterns.length === 0 ? undefined : new RegExp(excludePatterns.map((pattern) => `(?:${pattern.source})`).join('|'), 'iu');

  /** @type {string[]} */
  const models = values.models === undefined ? [] : values.models.split(',').map((/** @type {string} */ ref) => ref.trim());
  if (models.length === 0 && !values['dry-run']) {
    throw new UsageError(`--models is required, as provider/model references. Known models:\n${CATALOG.map((entry) => `  ${entry.ref}`).join('\n')}`);
  }
  if (new Set(models).size !== models.length) throw new UsageError('--models repeats a model');
  for (const ref of models) {
    let provider;
    try {
      ({ provider } = parseModelRef(ref));
    } catch (error) {
      throw new UsageError(/** @type {Error} */ (error).message);
    }
    if (Object.hasOwn(EXCLUDED_PROVIDERS, provider)) {
      throw new UsageError(`Provider ${provider} is not available: ${EXCLUDED_PROVIDERS[/** @type {keyof typeof EXCLUDED_PROVIDERS} */ (provider)]}`);
    }
    // Without a catalog entry there is no price, so the cap would not be a ceiling.
    if (!findModel(ref)) {
      throw new UsageError(`Unknown model ${ref}: it has no known price, so the spending cap could not hold. Known models:\n${CATALOG.map((entry) => `  ${entry.ref}`).join('\n')}`);
    }
  }

  if (values.effort === 'none') {
    const without = models.filter((ref) => !findModel(ref)?.effortLevels?.includes('none'));
    if (without.length > 0) {
      throw new UsageError(`--effort none is not documented for ${without.join(', ')}, and sending another level would measure something else. Choose other models or another effort.`);
    }
  }

  const accepted = /** @type {string[]} */ (values['accept-data-policy']);
  for (const id of accepted) {
    if (!Object.hasOwn(PROVIDERS, id)) throw new UsageError(`--accept-data-policy needs a provider id (${Object.keys(PROVIDERS).join(', ')}), got ${JSON.stringify(id)}`);
  }

  if (values.fallback) {
    const others = models.filter((ref) => parseModelRef(ref).provider !== 'anthropic');
    if (others.length > 0) throw new UsageError(`--fallback only exists on Anthropic, and this run has ${others.join(', ')}`);
  }

  return {
    input: /** @type {string} */ (values.input),
    out: /** @type {string | undefined} */ (values.out),
    models,
    sample: toInteger('sample', String(values.sample), 1),
    review: toInteger('review', String(values.review), 1),
    seed: toInteger('seed', String(values.seed), 0),
    language: /** @type {string} */ (values.language),
    maxUsd,
    effort: /** @type {string} */ (values.effort),
    taxonomy: /** @type {string | undefined} */ (values.taxonomy),
    excludeFolder,
    excludePatterns,
    acceptedPolicies: accepted,
    fallback: Boolean(values.fallback),
    dryRun: Boolean(values['dry-run']),
  };
}

/** @typedef {ReturnType<typeof parseRunOptions>} RunOptions */

/**
 * The options of `autosort-check`: those of `run` that apply, validated the same way, and its own.
 *
 * @param {Record<string, any>} values
 */
export function parseCheckOptions(values) {
  if (values.taxonomy !== undefined) throw new UsageError('autosort-check uses the existing folders of the export; --taxonomy does not apply');
  if (values.fallback) throw new UsageError('autosort-check measures what the extension sends, and it has no --fallback');
  const base = parseRunOptions(values);
  if (base.models.length === 0) throw new UsageError('autosort-check needs --models, also with --dry-run, because the request depends on the model');
  const pending = base.models.filter((ref) => PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (parseModelRef(ref).provider)]?.adapter === 'anthropic-sdk');
  if (pending.length > 0) throw new UsageError(`The extension does not send to ${pending.join(', ')} yet, so there is nothing of it to measure`);
  if (!['full', 'bookmark-only'].includes(values.context)) throw new UsageError(`--context must be full or bookmark-only, got ${JSON.stringify(values.context)}`);
  const pauseText = String(values.pause);
  const pause = /^(\d+\.?\d*|\.\d+)$/.test(pauseText) ? Number(pauseText) : NaN;
  if (!Number.isFinite(pause) || pause > 600) throw new UsageError(`--pause must be a number of seconds from 0 to 600, got ${JSON.stringify(pauseText)}`);
  return {
    ...base,
    repeat: toInteger('repeat', String(values.repeat), 1),
    maxCases: toInteger('max-cases', String(values['max-cases']), 1),
    pauseMs: Math.round(pause * 1000),
    context: /** @type {'full' | 'bookmark-only'} */ (values.context),
  };
}

/** @typedef {ReturnType<typeof parseCheckOptions>} CheckOptions */
