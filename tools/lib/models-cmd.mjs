import { CATALOG, selectCandidates } from '../../extension/core/models.js';
import { cleanText, cutText } from '../../extension/core/prompt.js';
import { describeDataPolicy, getProvider, PROVIDERS, resolveBaseURL } from '../../extension/platform/providers.js';
import { redact } from './safe-text.mjs';

const LISTING_TIMEOUT_MS = 30_000;
const MAX_NEW_MODELS_SHOWN = 40;

/**
 * @typedef {import('../../extension/core/models.js').ModelEntry} ModelEntry
 * @typedef {import('../../extension/platform/providers.js').Provider} Provider
 * @typedef {(line: string) => void} Write
 */

/**
 * What a listing says about a model's end, whichever field its provider uses. Anthropic has
 * `lifecycle` and `retires_at`, OpenAI `shutdown_date`, Mistral `deprecation` and `archived`.
 *
 * @param {any} listed
 * @param {string} today
 * @returns {string | null}
 */
function retirementInListing(listed, today) {
  if (listed.archived === true) return 'archived';
  if (listed.lifecycle === 'retired') return 'retired';
  const date = [listed.retires_at, listed.shutdown_date, listed.deprecation].find((value) => typeof value === 'string' && value !== '');
  if (date) {
    const day = cutText(cleanText(date), 10);
    return `${day <= today ? 'retired' : 'retiring'} ${day}`;
  }
  return listed.lifecycle === 'deprecated' ? 'deprecated' : null;
}

/**
 * @param {Provider} provider
 * @param {string} apiKey
 * @param {string | undefined} baseOverride
 * @returns {Promise<Map<string, any>>} listed models by id, as the catalog writes it
 */
async function fetchListing(provider, apiKey, baseOverride) {
  const response = await fetch(`${resolveBaseURL(provider, baseOverride)}${provider.listing.path}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...provider.listing.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
  });
  const text = await response.text();
  /** @type {any} */
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Reported below by what is missing from it.
  }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message;
    throw new Error(`status ${response.status}${typeof message === 'string' ? `: ${message}` : ''}`);
  }
  if (!Array.isArray(body?.data)) throw new Error(`status ${response.status}, but the listing has no data array`);

  const listed = new Map();
  for (const item of body.data) {
    if (typeof item?.id !== 'string') continue;
    const id = item.id.startsWith(provider.listing.idPrefix) ? item.id.slice(provider.listing.idPrefix.length) : item.id;
    listed.set(cutText(cleanText(id), 120), item);
  }
  return listed;
}

/**
 * @param {Provider} provider
 * @param {NodeJS.ProcessEnv} env
 * @param {string} today
 * @param {Write} write
 * @returns {Promise<'ok' | 'stale' | 'skipped' | 'failed'>}
 */
async function checkProvider(provider, env, today, write) {
  const apiKey = env[provider.keyEnv];
  if (!apiKey) {
    write(`${provider.id}: skipped, ${provider.keyEnv} is not set`);
    return 'skipped';
  }

  /** @type {Map<string, any>} */
  let listed;
  try {
    listed = await fetchListing(provider, apiKey, env[provider.baseUrlEnv]);
  } catch (error) {
    write(`${provider.id}: the listing failed: ${redact(/** @type {Error} */ (error).message, [apiKey])}`);
    return 'failed';
  }

  const entries = CATALOG.filter((entry) => entry.provider === provider.id);
  const known = new Set(entries.map((entry) => entry.id));
  const added = [...listed.keys()].filter((id) => !known.has(id));
  const missing = entries.filter((entry) => !listed.has(entry.id)).map((entry) => entry.id);
  const retired = entries.flatMap((entry) => {
    const state = listed.has(entry.id) && retirementInListing(listed.get(entry.id), today);
    return state ? [`${entry.id} (${state})`] : [];
  });

  write(`${provider.id}: ${listed.size} listed, ${added.length} new, ${missing.length} missing, ${retired.length} retiring or retired`);
  if (added.length > 0) {
    const shown = added.slice(0, MAX_NEW_MODELS_SHOWN).join(', ');
    write(`  new: ${shown}${added.length > MAX_NEW_MODELS_SHOWN ? `, and ${added.length - MAX_NEW_MODELS_SHOWN} more` : ''}`);
  }
  if (missing.length > 0) write(`  missing from the listing: ${missing.join(', ')}`);
  if (retired.length > 0) write(`  retiring or retired: ${retired.join(', ')}`);
  return missing.length > 0 || retired.length > 0 ? 'stale' : 'ok';
}

/** @param {ModelEntry} entry */
function trainingLabel(entry) {
  if (entry.trainingByDefault === 'depends') return 'depends on account';
  return entry.trainingByDefault ? 'yes' : 'no';
}

/**
 * @param {ModelEntry[]} entries
 * @param {Write} write
 */
function writeTable(entries, write) {
  const rows = entries.map((entry) => [
    entry.ref,
    `${entry.prices.input} / ${entry.prices.output}`,
    entry.structuredOutput === 'json_schema' ? 'schema' : 'json only',
    entry.effortLevels?.join(',') ?? '-',
    trainingLabel(entry),
    entry.idStability,
    entry.retiresNotBefore ? `not before ${entry.retiresNotBefore}` : '-',
  ]);
  const header = ['model', 'in / out USD/MTok', 'output', 'effort', 'trains by default', 'id', 'retirement'];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  for (const row of [header, ...rows]) write(row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd());
  const notes = entries.filter((entry) => entry.note);
  if (notes.length > 0) write('');
  for (const entry of notes) write(`${entry.ref}: ${entry.note}`);
}

/**
 * Lists the catalog and, with `check`, compares it against what each provider lists for the key
 * in the environment. Without that key the provider is skipped and nothing is sent to it. Only
 * this command calls a listing, and only the owner runs it.
 *
 * Returns 0, or 1 when a check failed, found a catalog model missing or retiring, or could not
 * check anything at all. New models are reported without failing: they appear all the time and
 * call for no action.
 *
 * @param {{
 *   provider?: string,
 *   check?: boolean,
 *   candidates?: boolean | Omit<NonNullable<Parameters<typeof selectCandidates>[1]>, 'providers'>,
 *   env?: NodeJS.ProcessEnv,
 *   write?: Write,
 *   today?: string,
 * }} options
 *   `candidates`: true applies the privacy-first filters; an object gives its own.
 * @returns {Promise<number>} exit code
 */
export async function runModels({ provider, check = false, candidates = false, env = process.env, write = console.log, today = new Date().toISOString().slice(0, 10) }) {
  /** @type {Provider[]} */
  let scope;
  try {
    scope = provider ? [getProvider(provider)] : Object.values(PROVIDERS);
  } catch (error) {
    write(/** @type {Error} */ (error).message);
    return 1;
  }

  const providers = scope.map((item) => item.id);
  const filters = candidates === true ? { requireStructuredOutput: true, excludeTrainingByDefault: true } : candidates || null;
  const entries = filters ? selectCandidates(CATALOG, { ...filters, providers }) : CATALOG.filter((entry) => providers.includes(entry.provider));

  if (filters) write(`Candidates for ${JSON.stringify(filters)}. A moving alias only appears with allowMovingAlias.`);
  writeTable(entries, write);
  write('');
  write('Data policies: no API reports them, and "--check" cannot notice a change. Reread them from time to time.');
  for (const line of scope.filter((item) => entries.some((entry) => entry.provider === item.id)).flatMap(describeDataPolicy)) write(line);

  if (!check) return 0;

  write('');
  const results = [];
  for (const item of scope) results.push(await checkProvider(item, env, today, write));
  if (results.every((result) => result === 'skipped')) {
    write('Nothing was checked: no provider key is in the environment.');
    return 1;
  }
  return results.includes('stale') || results.includes('failed') ? 1 : 0;
}
