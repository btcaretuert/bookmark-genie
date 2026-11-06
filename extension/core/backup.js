/**
 * The `backup@1.json` format: a full snapshot of the tree, for Bookmark Genie's own restore. The
 * Netscape HTML is the copy Chrome can import; this one keeps what that format loses: ids, the
 * root of each node and whether it is local or in the account (`syncing`).
 *
 * `roots` lists the top-level folder ids in order. `nodes` holds every node but the tree root, in
 * depth-first order, so a parent always comes before its children. Managed nodes are included: a
 * snapshot records the tree as it was, and a restore has to skip them anyway.
 *
 * Adding a field keeps version 1; removing or redefining one needs `schemaVersion` 2.
 *
 * @typedef {import('./tree.js').TreeNode} TreeNode
 * @typedef {import('./tree.js').FolderType} FolderType
 * @typedef {{
 *   id: string,
 *   parentId: string,
 *   index: number,
 *   title: string,
 *   url?: string,
 *   dateAdded?: number,
 *   folderType?: FolderType,
 *   syncing: boolean,
 * }} BackupNode
 * @typedef {{format: typeof BACKUP_FORMAT, schemaVersion: 1, createdAt: string, roots: string[], nodes: BackupNode[]}} Backup
 */

import { rootsOf } from './tree.js';

export const BACKUP_FORMAT = 'bookmark-genie-backup';
export const BACKUP_SCHEMA_VERSION = 1;
const FOLDER_TYPES = new Set(['bookmarks-bar', 'other', 'mobile', 'managed']);

/** The reason a backup was rejected, phrased for the person who picked the file. */
export class BackupError extends Error {
  name = 'BackupError';
}

/**
 * @param {TreeNode[]} tree what `getTree()` resolves to
 * @param {string} createdAt ISO 8601
 * @returns {Backup}
 */
export function toBackup(tree, createdAt) {
  const roots = rootsOf(tree);
  /** @type {BackupNode[]} */
  const nodes = [];
  /** @param {TreeNode} node */
  const visit = (node) => {
    /** @type {BackupNode} */
    const entry = {
      id: node.id,
      parentId: /** @type {string} */ (node.parentId),
      index: /** @type {number} */ (node.index),
      title: node.title,
      syncing: Boolean(node.syncing),
    };
    if (node.url !== undefined) entry.url = node.url;
    if (node.dateAdded !== undefined) entry.dateAdded = node.dateAdded;
    if (node.folderType !== undefined) entry.folderType = node.folderType;
    nodes.push(entry);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return { format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA_VERSION, createdAt, roots: roots.map((root) => root.id), nodes };
}

/** @param {Backup} backup */
export function serializeBackup(backup) {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

/**
 * @param {string} text the content of a `backup@1.json` file
 * @returns {Backup}
 */
export function parseBackup(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new BackupError(`The backup is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
  return validateBackup(value);
}

/**
 * Checks shape and integrity: unique ids, each parent a folder listed earlier, sibling indexes
 * 0..n-1 in order, and `folderType` exactly on the roots.
 *
 * @param {unknown} value
 * @returns {Backup}
 */
export function validateBackup(value) {
  const fail = (/** @type {string} */ message) => {
    throw new BackupError(`Invalid backup: ${message}`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('it is not a JSON object');
  const backup = /** @type {Record<string, unknown>} */ (value);

  if (backup.format !== BACKUP_FORMAT) fail(`"format" is ${JSON.stringify(backup.format)}, expected "${BACKUP_FORMAT}"`);
  if (backup.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    fail(`"schemaVersion" is ${JSON.stringify(backup.schemaVersion)}; this version only reads ${BACKUP_SCHEMA_VERSION}`);
  }
  if (typeof backup.createdAt !== 'string' || Number.isNaN(Date.parse(backup.createdAt))) fail('"createdAt" is not a date');
  if (!Array.isArray(backup.roots) || !backup.roots.every((id) => typeof id === 'string' && id !== '')) {
    fail('"roots" is not a list of ids');
  }
  if (!Array.isArray(backup.nodes)) fail('"nodes" is not a list');

  const roots = new Set(/** @type {string[]} */ (backup.roots));
  if (roots.size !== /** @type {string[]} */ (backup.roots).length) fail('"roots" repeats an id');
  /** @type {Map<string, boolean>} id to whether it is a folder */
  const seen = new Map();
  /** @type {Map<string, number>} parent id to the number of children seen so far */
  const childCount = new Map();
  /** @type {string | undefined} */
  let treeRootId;

  /** @type {unknown[]} */ (backup.nodes).forEach((raw, position) => {
    const where = `nodes[${position}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`${where} is not an object`);
    const node = /** @type {Record<string, unknown>} */ (raw);
    if (typeof node.id !== 'string' || node.id === '') fail(`${where}.id is not a non-empty string`);
    const id = /** @type {string} */ (node.id);
    const label = `${where} (id ${id})`;
    if (seen.has(id)) fail(`${label} repeats an id`);
    if (typeof node.parentId !== 'string') fail(`${label}.parentId is not a string`);
    const parentId = /** @type {string} */ (node.parentId);
    if (!Number.isInteger(node.index) || /** @type {number} */ (node.index) < 0) fail(`${label}.index is not a non-negative integer`);
    if (typeof node.title !== 'string') fail(`${label}.title is not a string`);
    if (node.url !== undefined && typeof node.url !== 'string') fail(`${label}.url is not a string`);
    if (node.dateAdded !== undefined && !Number.isFinite(node.dateAdded)) fail(`${label}.dateAdded is not a number`);
    if (typeof node.syncing !== 'boolean') fail(`${label}.syncing is not true or false`);

    if (roots.has(id)) {
      if (!FOLDER_TYPES.has(/** @type {string} */ (node.folderType))) fail(`${label} is a root without a known folderType`);
      if (node.url !== undefined) fail(`${label} is a root with a url`);
      if (treeRootId !== undefined && parentId !== treeRootId) fail(`${label} is a root under ${parentId}, the others under ${treeRootId}`);
      treeRootId = parentId;
    } else {
      if (node.folderType !== undefined) fail(`${label} has a folderType but is not in "roots"`);
      if (seen.get(parentId) !== true) fail(`${label}.parentId ${parentId} is not a folder listed before it`);
    }

    // Roots only need to be in order: Chrome hides empty permanent folders, and where that
    // visibility rule is off, the index of a root still counts the hidden ones.
    const expected = childCount.get(parentId) ?? 0;
    const index = /** @type {number} */ (node.index);
    if (roots.has(id) ? index < expected : index !== expected) {
      fail(`${label}.index is ${index}, expected ${roots.has(id) ? `${expected} or more` : expected} under parent ${parentId}`);
    }
    childCount.set(parentId, index + 1);
    seen.set(id, node.url === undefined);
  });

  for (const id of roots) if (!seen.has(id)) fail(`root ${id} is not in "nodes"`);
  if (treeRootId !== undefined && seen.has(treeRootId)) fail(`the tree root ${treeRootId} is listed as a node`);
  return /** @type {Backup} */ (value);
}
