import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BackupError, parseBackup, serializeBackup, toBackup, validateBackup } from '../../extension/core/backup.js';
import { createFakeChrome } from '../helpers/fake-chrome.mjs';

const CREATED_AT = '2026-11-05T12:00:00.000Z';

async function sample() {
  const { bookmarks } = createFakeChrome({ account: true, managed: [{ title: 'Intranet', url: 'https://intra.test/' }] });
  const dev = await bookmarks.create({ parentId: '1', title: 'Dev' });
  await bookmarks.create({ parentId: dev.id, title: 'a', url: 'https://a.test/' });
  await bookmarks.create({ parentId: dev.id, title: 'b', url: 'https://b.test/' });
  await bookmarks.create({ parentId: '1', title: 'loose', url: 'https://loose.test/' });
  await bookmarks.create({ parentId: '4', title: 'account', url: 'https://account.test/' });
  const tree = await bookmarks.getTree();
  return { tree, backup: toBackup(tree, CREATED_AT) };
}

test('a backup records schema, date, roots and every node with its fields', async () => {
  const { tree, backup } = await sample();
  assert.equal(backup.format, 'bookmark-genie-backup');
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.createdAt, CREATED_AT);
  assert.deepEqual(backup.roots, ['1', '2', '3', '4', '5', '6', '7']);
  const dev = tree[0].children[0].children[0];
  assert.deepEqual(backup.nodes.slice(0, 3), [
    { id: '1', parentId: '0', index: 0, title: 'Bookmarks bar', dateAdded: tree[0].children[0].dateAdded, folderType: 'bookmarks-bar', syncing: false },
    { id: dev.id, parentId: '1', index: 0, title: 'Dev', dateAdded: dev.dateAdded, syncing: false },
    { id: dev.children[0].id, parentId: dev.id, index: 0, title: 'a', url: 'https://a.test/', dateAdded: dev.children[0].dateAdded, syncing: false },
  ]);
  assert.equal(backup.nodes.find((node) => node.title === 'account')?.syncing, true);
  assert.equal(backup.nodes.find((node) => node.title === 'Intranet')?.parentId, '7', 'managed nodes are recorded');
});

test('serialize and parse give back the same backup', async () => {
  const { backup } = await sample();
  assert.deepEqual(parseBackup(serializeBackup(backup)), backup);
});

test('a root index may skip hidden roots, but must not go back', async () => {
  const { backup } = await sample();
  const hidden = structuredClone(backup);
  const mobile = hidden.nodes.findIndex((node) => node.id === '3');
  hidden.nodes.splice(mobile, 1);
  hidden.roots = hidden.roots.filter((id) => id !== '3');
  assert.doesNotThrow(() => validateBackup(hidden));
  /** @type {any} */ (hidden.nodes.find((node) => node.id === '4')).index = 1;
  assert.throws(() => validateBackup(hidden), /nodes\[\d+\] \(id 4\)\.index is 1, expected 2 or more under parent 0/);
});

/** @type {[string, (backup: any) => unknown, RegExp][]} */
const CORRUPT = [
  ['not an object', () => [], /it is not a JSON object/],
  ['another format', (b) => ({ ...b, format: 'netscape' }), /"format" is "netscape", expected "bookmark-genie-backup"/],
  ['a newer schema', (b) => ({ ...b, schemaVersion: 2 }), /"schemaVersion" is 2; this version only reads 1/],
  ['no date', (b) => ({ ...b, createdAt: 'yesterday' }), /"createdAt" is not a date/],
  ['no nodes', (b) => ({ ...b, nodes: undefined }), /"nodes" is not a list/],
  ['roots that are not ids', (b) => ({ ...b, roots: [1] }), /"roots" is not a list of ids/],
  ['a repeated root', (b) => ({ ...b, roots: [...b.roots, '1'] }), /"roots" repeats an id/],
  ['a repeated id', (b) => ({ ...b, nodes: [...b.nodes, { ...b.nodes.at(-1), index: b.nodes.at(-1).index + 1 }] }), /repeats an id/],
  ['an orphan', (b) => ({ ...b, nodes: b.nodes.map((/** @type {any} */ n) => (n.title === 'a' ? { ...n, parentId: '999' } : n)) }), /\(id \d+\)\.parentId 999 is not a folder listed before it/],
  ['a bookmark as parent', (b) => ({ ...b, nodes: b.nodes.map((/** @type {any} */ n, /** @type {number} */ i, /** @type {any[]} */ all) => (n.title === 'b' ? { ...n, parentId: all.find((x) => x.title === 'a').id, index: 0 } : n)) }), /is not a folder listed before it/],
  ['a gap in the indexes', (b) => ({ ...b, nodes: b.nodes.map((/** @type {any} */ n) => (n.title === 'b' ? { ...n, index: 5 } : n)) }), /\.index is 5, expected 1 under parent/],
  ['a negative index', (b) => ({ ...b, nodes: b.nodes.map((/** @type {any} */ n) => (n.title === 'a' ? { ...n, index: -1 } : n)) }), /\.index is not a non-negative integer/],
  ['syncing as text', (b) => ({ ...b, nodes: b.nodes.map((/** @type {any} */ n) => (n.title === 'a' ? { ...n, syncing: 'yes' } : n)) }), /\.syncing is not true or false/],
  ['a url that is not text', (b) => ({ ...b, nodes: b.nodes.map((/** @type {any} */ n) => (n.title === 'a' ? { ...n, url: 42 } : n)) }), /\.url is not a string/],
  ['a folderType off the roots', (b) => ({ ...b, nodes: b.nodes.map((/** @type {any} */ n) => (n.title === 'Dev' ? { ...n, folderType: 'other' } : n)) }), /has a folderType but is not in "roots"/],
  ['a root without folderType', (b) => ({ ...b, nodes: b.nodes.map((/** @type {any} */ n) => (n.id === '2' ? { ...n, folderType: undefined } : n)) }), /\(id 2\) is a root without a known folderType/],
  ['a root missing from nodes', (b) => ({ ...b, roots: [...b.roots, '42'] }), /root 42 is not in "nodes"/],
  ['a node that is not an object', (b) => ({ ...b, nodes: [...b.nodes, 'x'] }), /nodes\[\d+\] is not an object/],
];

for (const [name, corrupt, message] of CORRUPT) {
  test(`a backup with ${name} is rejected with a readable error`, async () => {
    const { backup } = await sample();
    const text = JSON.stringify(corrupt(structuredClone(backup)));
    assert.throws(() => parseBackup(text), (error) => error instanceof BackupError && /^Invalid backup: /.test(error.message) && message.test(error.message));
  });
}

test('a file that is not JSON is rejected with a readable error', () => {
  assert.throws(() => parseBackup('{"format": "bookmark-genie-backup",'), (error) => error instanceof BackupError && /^The backup is not valid JSON: /.test(error.message));
});
