/**
 * The pure part of «Ordenar sueltos»: which loose bookmarks of a folder may go out, what the
 * confirmation says before anything is sent, and how the answers become proposals grouped by
 * destination. The prompts are M0's: `core/taxonomy.js` proposes folders (reusing existing names
 * unchanged) and `core/classify.js` files each bookmark in batches of 50. Nothing here sends.
 *
 * Only loose bookmarks directly in the chosen folder are sorted. One whose URL may not leave (a
 * private host, a non-web scheme), one inside an excluded folder, or one already waiting in a
 * proposal is left out and listed with its reason.
 *
 * @typedef {import('./tree.js').TreeNode} TreeNode
 * @typedef {import('./autosort.js').CandidateFolder} CandidateFolder
 * @typedef {{id: string, title: string, url: string, host: string, parentId: string, index: number}} LooseItem
 *   `url` reduced by `sanitizeForLlm`, as sent; `title` as stored (the prompts clean it)
 * @typedef {{id: string, title: string, host: string, reason: 'excluded-folder' | 'private-host' | 'unsupported-scheme' | 'invalid-url' | 'pending'}} OmittedItem
 * @typedef {{kind: 'move', folder: {id: string, name: string}, members: string[], confidence: 'high' | 'low'}
 *   | {kind: 'create', parentId: string, name: string, description: string, members: string[], confidence: 'high' | 'low'}} LooseGroup
 */

import { folderKey, describeForLog } from './autosort.js';
import { UNSORTED } from './classify.js';
import { cleanText, cutText } from './prompt.js';
import { indexTree, isFolder } from './tree.js';
import { sanitizeForLlm } from './url.js';

export const BATCH_SIZE = 50;
/** As in M0: the taxonomy sees at most this many bookmarks. */
export const TAXONOMY_SAMPLE = 150;
const MAX_TITLE = 80;

/**
 * The loose bookmarks directly in `folderId`, split into what may be sent and what is left out.
 *
 * @param {TreeNode[]} tree
 * @param {string} folderId
 * @param {{excluded?: Set<string>, pending?: Set<string>}} [options]
 *   `excluded`: from `excludedSet`; `pending`: bookmarks already in a proposal
 * @returns {{folder: TreeNode | undefined, sendable: LooseItem[], omitted: OmittedItem[]}}
 */
export function looseToSort(tree, folderId, { excluded = new Set(), pending = new Set() } = {}) {
  const folder = indexTree(tree).get(folderId);
  /** @type {LooseItem[]} */
  const sendable = [];
  /** @type {OmittedItem[]} */
  const omitted = [];
  for (const child of folder?.children ?? []) {
    if (isFolder(child)) continue;
    const { title, host } = describeForLog(child);
    const shown = { id: child.id, title: cutText(cleanText(title), MAX_TITLE), host };
    if (excluded.has(child.id) || excluded.has(folderId)) {
      omitted.push({ ...shown, reason: 'excluded-folder' });
      continue;
    }
    if (pending.has(child.id)) {
      omitted.push({ ...shown, reason: 'pending' });
      continue;
    }
    const url = sanitizeForLlm(child.url ?? '');
    if (!url.sendable) {
      omitted.push({ ...shown, reason: url.reason });
      continue;
    }
    sendable.push({ id: child.id, title: child.title, url: url.url, host: url.url.split('/')[0], parentId: folderId, index: /** @type {number} */ (child.index) });
  }
  return { folder, sendable, omitted };
}

/**
 * How many calls the sort will make at least: one for the folders, one per batch of 50.
 *
 * @param {number} count sendable bookmarks
 */
export function estimatedCalls(count) {
  return count === 0 ? 0 : 1 + Math.ceil(count / BATCH_SIZE);
}

/**
 * The taxonomy's sample: all of them, or the most recent TAXONOMY_SAMPLE.
 *
 * @param {LooseItem[]} items
 * @param {Map<string, TreeNode>} byId
 */
export function taxonomySample(items, byId) {
  if (items.length <= TAXONOMY_SAMPLE) return items;
  return [...items].sort((a, b) => (byId.get(b.id)?.dateAdded ?? 0) - (byId.get(a.id)?.dateAdded ?? 0)).slice(0, TAXONOMY_SAMPLE);
}

/**
 * The folders the classification chooses from: every existing candidate, plus the taxonomy's
 * new ones. A taxonomy name equal to an existing folder, ignoring case and accents, is that
 * folder. Names stay unique, because the answer comes back as a name.
 *
 * @param {CandidateFolder[]} existing
 * @param {{name: string, description?: string}[]} proposed
 * @returns {{folders: {name: string, description?: string}[], existingByName: Map<string, CandidateFolder>}}
 */
export function classificationFolders(existing, proposed) {
  /** @type {Map<string, CandidateFolder>} */
  const byKey = new Map();
  for (const folder of existing) {
    for (const key of [folderKey(folder.name), folderKey(folder.title)]) if (!byKey.has(key)) byKey.set(key, folder);
  }
  /** @type {{name: string, description?: string}[]} */
  const folders = [];
  /** @type {Map<string, CandidateFolder>} */
  const existingByName = new Map();
  /** @type {Set<string>} */
  const used = new Set();
  for (const folder of existing) {
    const description = proposed.find((entry) => byKey.get(folderKey(entry.name)) === folder)?.description;
    folders.push(description ? { name: folder.name, description } : { name: folder.name });
    existingByName.set(folder.name, folder);
    used.add(folderKey(folder.name));
  }
  for (const entry of proposed) {
    const key = folderKey(entry.name);
    if (used.has(key) || byKey.has(key)) continue;
    used.add(key);
    folders.push({ name: entry.name, ...(entry.description ? { description: entry.description } : {}) });
  }
  return { folders, existingByName };
}

/**
 * Groups the answers by destination. An existing folder becomes a `move`; a new name a `create`
 * in the sorted folder, or inside the existing parent its name points to ("Parent/Child"). What
 * the model left without a folder, or put back in the folder being sorted, stays where it is.
 *
 * @param {{id: string, folder: string, confidence: 'high' | 'low'}[]} assignments
 * @param {{folders: {name: string, description?: string}[], existingByName: Map<string, CandidateFolder>}} choices
 * @param {string} sortedFolderId
 * @returns {{groups: LooseGroup[], unsorted: string[]}}
 */
export function groupAssignments(assignments, { folders, existingByName }, sortedFolderId) {
  /** @type {Map<string, LooseGroup>} */
  const groups = new Map();
  /** @type {string[]} */
  const unsorted = [];
  for (const answer of assignments) {
    if (answer.folder === UNSORTED) {
      unsorted.push(answer.id);
      continue;
    }
    if (existingByName.get(answer.folder)?.id === sortedFolderId) {
      unsorted.push(answer.id);
      continue;
    }
    let group = groups.get(answer.folder);
    if (!group) {
      const existing = existingByName.get(answer.folder);
      if (existing) {
        group = { kind: 'move', folder: { id: existing.id, name: existing.name }, members: [], confidence: 'high' };
      } else {
        const description = folders.find((folder) => folder.name === answer.folder)?.description ?? '';
        const segments = answer.folder.split('/').map((segment) => segment.trim()).filter(Boolean);
        const parent = segments.length > 1 ? [...existingByName.values()].find((folder) => folderKey(folder.name) === folderKey(segments.slice(0, -1).join('/')) || folderKey(folder.title) === folderKey(segments[0])) : undefined;
        group = { kind: 'create', parentId: parent?.id ?? sortedFolderId, name: segments.at(-1) ?? answer.folder, description, members: [], confidence: 'high' };
      }
      groups.set(answer.folder, group);
    }
    group.members.push(answer.id);
    if (answer.confidence === 'low') group.confidence = 'low';
  }
  return { groups: [...groups.values()], unsorted };
}
