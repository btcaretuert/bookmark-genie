/**
 * Settings, API keys, daily usage, the visible log, the error flag, weekly metrics and the last
 * request preview of the automatic sort, in `chrome.storage.local`
 * (https://developer.chrome.com/docs/extensions/reference/api/storage). The key is stored
 * unencrypted in the profile; the main control is a low-value key with a small spending limit.
 * Nothing here leaves the machine.
 *
 * Keys: `autosort` (settings), `apiKey:<provider>` (one per provider, so saving needs no read;
 * `apiKeys` is the 0.3.0 map, still read), `autosortUsage`, `autosortLog` (newest first),
 * `autosortErrors` (unseen errors for the badge), `autosortMetrics` and `autosortLastSent`.
 *
 * Settings and keys are written in the first statement of `saveSettings` and `saveKey`, with no
 * await before: a page can then ask for permissions in the same click, and what was typed is
 * stored even if the permission dialog closes the popup. Read-modify-write of usage, log, errors
 * and metrics goes through `withLock`, shared with the worker.
 *
 * @typedef {import('../core/autosort.js').AutoSortSettings} AutoSortSettings
 * @typedef {import('../core/autosort.js').ErrorCategory} ErrorCategory
 * @typedef {{day: string, calls: number, spentUsd: number, lostUsd: number}} Usage
 * @typedef {{
 *   id: string,
 *   at: string,
 *   kind: 'moved' | 'proposed' | 'left' | 'error' | 'expired' | 'duplicate' | 'sorted',
 *   reason?: string,
 *   category?: ErrorCategory,
 *   detail?: string,
 *   title: string,
 *   host: string,
 *   folder?: string,
 *   newFolder?: boolean,
 *   bookmarkId?: string,
 *   changeId?: string,
 *   duplicateOf?: string,
 *   ms?: number,
 *   accepted?: boolean,
 *   origin?: 'sort-loose',
 *   truncation?: {sent: number, total: number},
 *   counts?: {sent: number, groups: number, filed: number, unsorted: number, unclassified: number, omitted: number},
 * }} LogEvent `detail`: the provider's own words, kept for diagnosis; pages show `errorText(category)`.
 *   `accepted`: a proposal the person confirmed; the event was `proposed` until then.
 * @typedef {{at: string, kind: 'applied' | 'undone' | 'moved' | 'removed-duplicate' | 'reclassified' | 'sorted', messageEs: string, changeId?: string}} LastResult
 * @typedef {'moved' | 'accepted' | 'discarded' | 'undone' | 'corrected' | 'expired' | 'filed' | 'undoneBookmarks' | 'looseAccepted' | 'looseDiscarded' | 'looseFiled'} MetricName
 *   `loose*`: «Ordenar sueltos» counts apart, so it does not decide when Ctrl+D goes automatic
 * @typedef {Record<MetricName, number>} WeekCounts
 * @typedef {{weeks: Record<string, WeekCounts>, totals: {accepted: number, corrected: number}}} Metrics
 * @typedef {{
 *   at: string, folders: number, examples: number, loose: number, truncatedFolders: number, chars: number, titles: string[],
 *   sent: {bookmark: {title: string, host: string}, folders: {name: string, examples: string[]}[], loose: {title: string, host: string}[]},
 * }} SentPreview what left in the last request: clean titles, hosts and folder names, never a URL
 */

import { MAX_LOG_ENTRIES, normalizeSettings, weekKey } from '../core/autosort.js';
import { withLock } from './store.js';

const SETTINGS_KEY = 'autosort';
const KEY_PREFIX = 'apiKey:';
const LEGACY_KEYS_KEY = 'apiKeys';
const USAGE_KEY = 'autosortUsage';
const LOG_KEY = 'autosortLog';
const ERRORS_KEY = 'autosortErrors';
const METRICS_KEY = 'autosortMetrics';
const LAST_SENT_KEY = 'autosortLastSent';
const LAST_RESULT_KEY = 'autosortLastResult';
const KEEP_WEEKS = 12;
/** @type {MetricName[]} */
export const METRIC_NAMES = ['moved', 'accepted', 'discarded', 'undone', 'corrected', 'expired', 'filed', 'undoneBookmarks', 'looseAccepted', 'looseDiscarded', 'looseFiled'];

/**
 * The host permission a provider needs, as `optional_host_permissions` declares it.
 *
 * @param {{baseURL: string}} provider
 */
export function hostPermissionFor(provider) {
  return `${new URL(provider.baseURL).origin}/*`;
}

/**
 * What the sort asks Chrome for when it is turned on: the active tab's URL and the provider.
 *
 * @param {{baseURL: string}} provider
 */
export function permissionsFor(provider) {
  return { permissions: ['tabs'], origins: [hostPermissionFor(provider)] };
}

/**
 * The last four characters, which is all a page ever shows of a key.
 *
 * @param {string} key
 */
export const keyHint = (key) => `…${key.slice(-4)}`;

/** @returns {WeekCounts} */
const emptyWeek = () => ({ moved: 0, accepted: 0, discarded: 0, undone: 0, corrected: 0, expired: 0, filed: 0, undoneBookmarks: 0, looseAccepted: 0, looseDiscarded: 0, looseFiled: 0 });

/**
 * @param {chrome.storage.StorageArea} [area]
 * @param {{locks?: LockManager | null}} [lockOptions] for tests, as in `withLock`
 */
export function createSettingsStore(area = chrome.storage.local, lockOptions = {}) {
  /** @param {string} key */
  const read = async (key) => (await area.get(key))[key];
  /**
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} task
   */
  const locked = (name, task) => withLock(name, task, lockOptions);

  /** @param {string} provider */
  const dropLegacyKey = (provider) =>
    locked('settings', async () => {
      const legacy = /** @type {Record<string, string> | undefined} */ (await read(LEGACY_KEYS_KEY));
      if (legacy && Object.hasOwn(legacy, provider)) {
        const { [provider]: _, ...rest } = legacy;
        await area.set({ [LEGACY_KEYS_KEY]: rest });
      }
    });

  const store = {
    /** @returns {Promise<AutoSortSettings>} */
    async readSettings() {
      return normalizeSettings(await read(SETTINGS_KEY));
    },

    /**
     * The whole settings object, normalized, written in the first statement.
     *
     * @param {AutoSortSettings} settings
     * @returns {Promise<AutoSortSettings>}
     */
    saveSettings(settings) {
      const normalized = normalizeSettings(settings);
      return area.set({ [SETTINGS_KEY]: normalized }).then(() => normalized);
    },

    /**
     * @param {string} provider
     * @returns {Promise<string | null>}
     */
    async readKey(provider) {
      const stored = await area.get([`${KEY_PREFIX}${provider}`, LEGACY_KEYS_KEY]);
      const key = stored[`${KEY_PREFIX}${provider}`] ?? /** @type {Record<string, unknown> | undefined} */ (stored[LEGACY_KEYS_KEY])?.[provider];
      return typeof key === 'string' && key !== '' ? key : null;
    },

    /**
     * Written in the first statement, under its own storage key; then the 0.3.0 copy goes.
     *
     * @param {string} provider
     * @param {string} key
     */
    saveKey(provider, key) {
      const written = area.set({ [`${KEY_PREFIX}${provider}`]: key });
      return written.then(() => dropLegacyKey(provider));
    },

    /**
     * Removes the provider's key, from the 0.3.0 map as well.
     *
     * @param {string} provider
     */
    async deleteKey(provider) {
      await area.remove(`${KEY_PREFIX}${provider}`);
      await dropLegacyKey(provider);
    },

    /**
     * Today's usage; a record from another day counts as none.
     *
     * @param {string} day
     * @returns {Promise<Usage>}
     */
    async readUsage(day) {
      const usage = /** @type {Partial<Usage> | undefined} */ (await read(USAGE_KEY));
      if (usage?.day !== day) return { day, calls: 0, spentUsd: 0, lostUsd: 0 };
      return { day, calls: Number(usage.calls) || 0, spentUsd: Number(usage.spentUsd) || 0, lostUsd: Number(usage.lostUsd) || 0 };
    },

    /**
     * Changes today's usage under the `usage` lock. `change` returns the new usage, or null to
     * leave it as it is; whatever it returns besides is passed back.
     *
     * @template T
     * @param {string} day
     * @param {(usage: Usage) => {usage: Usage | null, result: T}} change
     * @returns {Promise<T>}
     */
    updateUsage(day, change) {
      return locked('usage', async () => {
        const current = await store.readUsage(day);
        const { usage, result } = change(current);
        if (usage) await area.set({ [USAGE_KEY]: usage });
        return result;
      });
    },

    /** @param {LogEvent} event */
    appendLog(event) {
      return locked('log', async () => {
        const log = /** @type {LogEvent[] | undefined} */ (await read(LOG_KEY));
        await area.set({ [LOG_KEY]: [event, ...(Array.isArray(log) ? log : [])].slice(0, MAX_LOG_ENTRIES) });
      });
    },

    /**
     * Rewrites the events `match` picks, under the `log` lock.
     *
     * @param {(event: LogEvent) => boolean} match
     * @param {(event: LogEvent) => LogEvent} change
     */
    rewriteLog(match, change) {
      return locked('log', async () => {
        const log = /** @type {LogEvent[] | undefined} */ (await read(LOG_KEY));
        if (!Array.isArray(log)) return;
        await area.set({ [LOG_KEY]: log.map((event) => (match(event) ? change(event) : event)) });
      });
    },

    /** @param {LastResult} result */
    saveLastResult(result) {
      return area.set({ [LAST_RESULT_KEY]: result });
    },

    /** @returns {Promise<LastResult | null>} */
    async readLastResult() {
      const result = await read(LAST_RESULT_KEY);
      return result && typeof result === 'object' ? /** @type {LastResult} */ (result) : null;
    },

    clearLastResult() {
      return area.remove(LAST_RESULT_KEY);
    },

    /** @returns {Promise<LogEvent[]>} newest first */
    async readLog() {
      const log = await read(LOG_KEY);
      return Array.isArray(log) ? log.map((event, position) => ({ id: `log:${event.at}:${position}`, ...event })) : [];
    },

    /**
     * Counts an error the person has not seen yet: the badge shows «!» until a page acks it.
     *
     * @param {ErrorCategory} category
     * @param {string} at
     */
    noteError(category, at) {
      return locked('log', async () => {
        const errors = /** @type {{count?: number} | undefined} */ (await read(ERRORS_KEY));
        await area.set({ [ERRORS_KEY]: { count: (errors?.count ?? 0) + 1, category, at } });
      });
    },

    /** @returns {Promise<number>} */
    async unseenErrors() {
      const errors = /** @type {{count?: number} | undefined} */ (await read(ERRORS_KEY));
      return errors?.count ?? 0;
    },

    ackErrors() {
      return area.remove(ERRORS_KEY);
    },

    /**
     * @param {MetricName} name
     * @param {Date} date
     * @param {number} [count]
     */
    bumpMetric(name, date, count = 1) {
      return locked('metrics', async () => {
        const metrics = await store.readMetrics();
        const week = weekKey(date);
        const counts = { ...emptyWeek(), ...metrics.weeks[week] };
        counts[name] += count;
        const weeks = Object.fromEntries(
          Object.entries({ ...metrics.weeks, [week]: counts })
            .sort(([a], [b]) => (a < b ? 1 : -1))
            .slice(0, KEEP_WEEKS),
        );
        const totals = { ...metrics.totals };
        if (name === 'accepted' || name === 'corrected') totals[name] += count;
        await area.set({ [METRICS_KEY]: { weeks, totals } });
      });
    },

    /** @returns {Promise<Metrics>} */
    async readMetrics() {
      const metrics = /** @type {Partial<Metrics> | undefined} */ (await read(METRICS_KEY));
      return {
        weeks: metrics?.weeks && typeof metrics.weeks === 'object' ? metrics.weeks : {},
        totals: { accepted: Number(metrics?.totals?.accepted) || 0, corrected: Number(metrics?.totals?.corrected) || 0 },
      };
    },

    /** @param {SentPreview} preview */
    saveLastSent(preview) {
      return area.set({ [LAST_SENT_KEY]: preview });
    },

    /** @returns {Promise<SentPreview | null>} */
    async readLastSent() {
      const preview = await read(LAST_SENT_KEY);
      return preview && typeof preview === 'object' ? /** @type {SentPreview} */ (preview) : null;
    },
  };
  return store;
}

/** @typedef {ReturnType<typeof createSettingsStore>} SettingsStore */
