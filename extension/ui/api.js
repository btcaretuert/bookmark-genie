/**
 * The only door between the pages (popup, settings) and the rest of the extension: it adapts the
 * sort lane's facade (`platform/flow.js`) and the journal's `takeSnapshot` to the plain shapes
 * `present.js` expects. A page calls `init()` once; after that `permissionsFor`, `saveSettings`
 * and `saveKey` start their work in the caller's own turn, as the permission dialog requires.
 *
 * @typedef {import('./present.js').Status} Status
 * @typedef {import('./present.js').ActivityEntry} ActivityEntry
 */

import { CATALOG, parseModelRef } from '../core/models.js';
import { createFlow } from '../platform/flow.js';
import { getProvider, requiresTrainingConsent } from '../platform/providers.js';
import { createStore } from '../platform/store.js';

/** The separator the facade puts between a folder and its parents. */
export const PATH_SEPARATOR = ' › ';

export const store = createStore();
// «Ordenar sueltos» runs in the worker, so closing the popup does not cut it short.
const flow = createFlow({ worker: chrome.runtime });
/** @type {Awaited<ReturnType<typeof flow.settings.get>> | null} */
let cachedSettings = null;
/** @type {Map<string, unknown>} */
const consentObjects = new Map();

export async function init() {
  cachedSettings = await flow.settings.get();
}

/** @param {string} ref */
export const permissionsFor = (ref) => flow.permissionsFor(ref);

/** @returns {Promise<Status>} */
export async function getStatus() {
  const status = await flow.getStatus();
  return { ...status, errorMessage: status.messageEs, action: status.action === 'wait-tomorrow' ? undefined : status.action };
}

/** @param {number} count */
export const listActivity = (count) => flow.listActivity(count);

/** @param {string} changeId */
export const undo = (changeId) => flow.undo(changeId);

/** @param {string} bookmarkId */
export async function retry(bookmarkId) {
  const entry = await flow.reclassify(bookmarkId);
  if (entry?.kind === 'error') throw new Error(entry.messageEs || 'Falló la llamada.');
  return entry;
}

/**
 * @param {string} bookmarkId
 * @param {string} folderId
 * @returns {Promise<{moved: number, skipped: any[], changeId: string | null, stale: boolean}>}
 */
export async function chooseFolder(bookmarkId, folderId) {
  const result = await flow.moveTo(bookmarkId, folderId);
  return { moved: result.changeId ? 1 : 0, skipped: result.skipped ?? [], changeId: result.changeId ?? null, stale: false };
}

/** @param {string} bookmarkId */
export async function removeDuplicate(bookmarkId) {
  const result = await flow.removeDuplicate(bookmarkId);
  if (!result.removed) throw new Error(result.reason === 'gone' ? 'El marcador ya no existe.' : 'Ya no es un duplicado.');
}

/** Folders for the pickers and the exclusion list, with their depth for indenting. */
export async function getFolders() {
  const choices = await flow.folderChoices();
  return choices.map((choice) => ({ id: choice.id, path: choice.path, depth: choice.path.split(PATH_SEPARATOR).length - 1 }));
}

export const getFolderTree = () => chrome.bookmarks.getTree();

export const listProposals = () => flow.proposals.list();

/** The facade reports folders by id; the strip names them. @param {string | undefined} id */
async function folderTitle(id) {
  if (!id) return undefined;
  try {
    return (await chrome.bookmarks.get(id))[0]?.title;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} id
 * @param {{name?: string, targetFolderId?: string, memberIds?: string[], includeMain?: boolean}} options
 */
export async function applyProposal(id, options) {
  const result = await flow.proposals.apply(id, options);
  return { ...result, createdFolder: await folderTitle(result.createdFolder), reusedFolder: await folderTitle(result.reusedFolder) };
}

/**
 * Accepts every pending proposal with one destination name, as one result for the strip.
 *
 * @param {string} name
 */
export async function acceptGroup(name) {
  const result = await flow.proposals.acceptGroup(name);
  return { ...result, createdFolder: await folderTitle(result.createdFolders?.[0] ?? result.createdFolder), reusedFolder: await folderTitle(result.reusedFolder) };
}

/** @param {string} id */
export const discardProposal = (id) => flow.proposals.discard(id);

/**
 * «Aceptar todas» for the groups of «Ordenar sueltos»: one change for all of them.
 */
export const acceptAllSorted = () => flow.proposals.acceptAll('sort-loose');

/** Folders with loose bookmarks, for «Ordenar sueltos». */
export const looseFolders = () => flow.looseFolders();

/** What «Ordenar sueltos» would send, before sending. @param {string} folderId */
export const previewLoose = (folderId) => flow.previewLoose(folderId);

/** «Ordenar sueltos», once confirmed. @param {string} folderId */
export const sortLoose = (folderId) => flow.sortLoose(folderId);

export const weeklyMetrics = () => flow.weeklyMetrics();

/** Clears the red "!" badge; the popup calls it on opening. */
export const acknowledgeErrors = () => flow.ackErrors();

export const lastSentPreview = () => flow.lastSentPreview();

// 0.4.1 facade members, read through `any` so the page still loads while the lane catches up.
const lane = /** @type {any} */ (flow);

/** The persisted outcome of the last action, or null. */
export const lastResult = async () => (typeof lane.lastResult === 'function' ? lane.lastResult() : null);

export const dismissLastResult = async () => {
  if (typeof lane.dismissLastResult === 'function') await lane.dismissLastResult();
};

/**
 * One minimal call with the saved key; counts against the daily cap.
 *
 * @returns {Promise<{ok: boolean, category?: string, messageEs: string, ms?: number, servedModel?: string}>}
 */
export async function testProvider() {
  if (typeof lane.testProvider !== 'function') return { ok: false, messageEs: 'La prueba de la clave aún no está disponible.' };
  return lane.testProvider();
}

export async function readSettings() {
  cachedSettings = await flow.settings.get();
  return cachedSettings;
}

/**
 * Not `async` on purpose: the write starts in the caller's own turn, so it survives a permission
 * dialog that closes the page. The facade wants the whole object: this merges `partial` into the
 * last one read. `consentAccepted` becomes the v2 consent object `readProviderView` fetched.
 *
 * @param {Record<string, unknown>} partial
 */
export function saveSettings(partial) {
  const { consentAccepted, ...rest } = partial;
  const base = /** @type {NonNullable<typeof cachedSettings>} */ (cachedSettings);
  /** @type {any} */
  const next = { ...base, ...rest };
  if (consentAccepted !== undefined) {
    const providerId = parseModelRef(String(next.ref)).provider;
    next.consent = consentAccepted ? (consentObjects.get(providerId) ?? next.consent) : requiresTrainingConsent(getProvider(providerId)) ? null : base.consent;
  }
  cachedSettings = next;
  return flow.settings.save(next).then((saved) => (cachedSettings = saved));
}

/** Not `async`, for the same reason as `saveSettings`. @param {string} providerId @param {string} key */
export const saveKey = (providerId, key) => flow.settings.saveKey(providerId, key);

/** @param {string} providerId */
export const deleteKey = (providerId) => flow.settings.deleteKey(providerId);

/** Everything the settings page needs about one provider. @param {string} ref */
export async function readProviderView(ref) {
  const provider = getProvider(parseModelRef(ref).provider);
  const settings = await flow.settings.get();
  const consentObject = await flow.consentFor(provider.id);
  consentObjects.set(provider.id, consentObject);
  return {
    provider,
    needsConsent: requiresTrainingConsent(provider),
    consented: await flow.consentCovers(settings, provider.id),
    keyHint: await flow.settings.keyHint(provider.id),
    policySummary: /** @type {string[]} */ ([await flow.policySummary(provider.id)].flat()),
    policyFull: /** @type {string[]} */ ([await flow.policyFull(provider.id)].flat()),
    consentText: /** @type {string[]} */ ([await flow.consentText(provider.id)].flat()).join(' '),
  };
}

export async function readUsage() {
  const status = await flow.getStatus();
  const capped = status.state === 'paused' && (status.reason === 'daily-calls' || status.reason === 'daily-budget');
  return { usage: status.usage, capped };
}

export const models = () => CATALOG.map((entry) => ({ ref: entry.ref, id: entry.id, provider: getProvider(entry.provider), unavailable: entry.newAccounts === false }));
