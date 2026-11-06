import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeChrome } from '../helpers/fake-chrome.mjs';

/** The rules the fake claims to copy from Chromium; if one breaks, the apply and undo tests prove less. */

async function folderWith(/** @type {number} */ count) {
  const fake = createFakeChrome();
  const folder = await fake.bookmarks.create({ parentId: '1', title: 'F' });
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < count; i += 1) ids.push((await fake.bookmarks.create({ parentId: folder.id, title: `b${i}`, url: `https://b.test/${i}` })).id);
  const order = async () => (await fake.bookmarks.getChildren(folder.id)).map((/** @type {any} */ node) => node.id);
  return { fake, folder, ids, order };
}

test('the tree has string ids, roots with folderType and syncing, and no parentId on the tree root', async () => {
  const [root] = await createFakeChrome({ account: true }).bookmarks.getTree();
  assert.equal(root.id, '0');
  assert.equal('parentId' in root, false);
  assert.deepEqual(
    /** @type {any[]} */ (root.children).map((node) => [node.id, node.parentId, node.index, node.folderType, node.syncing]),
    [
      ['1', '0', 0, 'bookmarks-bar', false],
      ['2', '0', 1, 'other', false],
      ['3', '0', 2, 'mobile', false],
      ['4', '0', 3, 'bookmarks-bar', true],
      ['5', '0', 4, 'other', true],
      ['6', '0', 5, 'mobile', true],
    ],
  );
});

test('a new node inherits syncing from its root and gets dateAdded', async () => {
  const { bookmarks } = createFakeChrome({ account: true });
  const local = await bookmarks.create({ parentId: '1', title: 'a', url: 'https://a.test/' });
  const remote = await bookmarks.create({ parentId: '4', title: 'b', url: 'https://b.test/' });
  assert.equal(local.syncing, false);
  assert.equal(remote.syncing, true);
  assert.equal(typeof local.dateAdded, 'number');
});

test('move without an index goes last', async () => {
  const { fake, folder, ids, order } = await folderWith(3);
  const other = await fake.bookmarks.create({ parentId: '2', title: 'x', url: 'https://x.test/' });
  const moved = await fake.bookmarks.move(other.id, { parentId: folder.id });
  assert.equal(moved.index, 3);
  assert.deepEqual(await order(), [...ids, other.id]);
});

test('move rejects an index above the child count, and accepts the count itself', async () => {
  const { fake, folder, ids } = await folderWith(3);
  const other = await fake.bookmarks.create({ parentId: '2', title: 'x', url: 'https://x.test/' });
  await assert.rejects(fake.bookmarks.move(other.id, { parentId: folder.id, index: 4 }), { message: 'Index out of bounds.' });
  assert.equal((await fake.bookmarks.move(other.id, { parentId: folder.id, index: 3 })).index, 3);
  assert.equal(ids.length, 3);
});

test('within one parent, the current index or the next does nothing, and a larger one is lowered by one', async () => {
  const { fake, folder, ids, order } = await folderWith(4);
  const [a, b, c, d] = ids;
  await fake.bookmarks.move(b, { parentId: folder.id, index: 1 });
  await fake.bookmarks.move(b, { parentId: folder.id, index: 2 });
  assert.deepEqual(await order(), [a, b, c, d]);
  const moved = await fake.bookmarks.move(a, { parentId: folder.id, index: 3 });
  assert.equal(moved.index, 2);
  assert.deepEqual(await order(), [b, c, a, d]);
  await fake.bookmarks.move(d, { parentId: folder.id, index: 0 });
  assert.deepEqual(await order(), [d, b, c, a]);
});

test('move rejects roots, managed nodes, a folder into itself, and unknown ids, with Chrome’s messages', async () => {
  const { bookmarks } = createFakeChrome({ managed: [{ title: 'Intranet', url: 'https://intra.test/' }] });
  const [root] = await bookmarks.getTree();
  const managedRoot = /** @type {any[]} */ (root.children).find((node) => node.folderType === 'managed');
  const managedChild = managedRoot.children[0];
  const folder = await bookmarks.create({ parentId: '1', title: 'F' });
  const inner = await bookmarks.create({ parentId: folder.id, title: 'G' });
  const loose = await bookmarks.create({ parentId: '2', title: 'x', url: 'https://x.test/' });

  assert.equal(managedChild.unmodifiable, 'managed');
  await assert.rejects(bookmarks.move('2', { parentId: '1' }), { message: "Can't modify the root bookmark folders." });
  await assert.rejects(bookmarks.move('0', { parentId: '1' }), { message: "Can't modify the root bookmark folders." });
  await assert.rejects(bookmarks.move(loose.id, { parentId: '0' }), { message: "Can't modify the root bookmark folders." });
  await assert.rejects(bookmarks.move(managedChild.id, { parentId: '1' }), { message: "Can't modify managed bookmarks." });
  await assert.rejects(bookmarks.move(loose.id, { parentId: managedRoot.id }), { message: "Can't modify managed bookmarks." });
  await assert.rejects(bookmarks.move(folder.id, { parentId: inner.id }), { message: "Can't move a folder to itself or its descendant." });
  await assert.rejects(bookmarks.move(folder.id, { parentId: folder.id }), { message: "Can't move a folder to itself or its descendant." });
  await assert.rejects(bookmarks.move(loose.id, { parentId: loose.id }), { message: "Parameter 'parentId' does not specify a folder." });
  await assert.rejects(bookmarks.move('999', { parentId: '1' }), { message: "Can't find bookmark for id." });
  await assert.rejects(bookmarks.move(loose.id, { parentId: '999' }), { message: "Can't find parent bookmark for id." });
  await assert.rejects(bookmarks.get('999'), { message: "Can't find bookmark for id." });
  await assert.rejects(bookmarks.get('abc'), { message: 'Bookmark id is invalid.' });
});

test('get, getChildren and move return nodes without children; getTree has them', async () => {
  const { bookmarks } = createFakeChrome();
  const folder = await bookmarks.create({ parentId: '1', title: 'F' });
  assert.equal('children' in (await bookmarks.get(folder.id))[0], false);
  assert.equal('children' in (await bookmarks.getChildren('1'))[0], false);
  const [root] = await bookmarks.getTree();
  assert.deepEqual(/** @type {any[]} */ (root.children)[0].children[0].children, []);
});

test('a real move updates dateGroupModified of the destination, a no-op does not', async () => {
  const { fake, folder, ids } = await folderWith(2);
  const stamp = async () => (await fake.bookmarks.get(folder.id))[0].dateGroupModified;
  await fake.bookmarks.move(ids[0], { parentId: folder.id, index: 0 });
  assert.equal(await stamp(), undefined);
  await fake.bookmarks.move(ids[0], { parentId: folder.id, index: 2 });
  assert.equal(typeof (await stamp()), 'number');
});

test('remove refuses a non-empty folder; removeTree takes it with its contents', async () => {
  const { fake, folder, ids } = await folderWith(2);
  await assert.rejects(fake.bookmarks.remove(folder.id), { message: "Can't remove non-empty folder (use recursive to force)." });
  await fake.bookmarks.removeTree(folder.id);
  await assert.rejects(fake.bookmarks.get(ids[0]), { message: "Can't find bookmark for id." });
});

test('storage.local keeps JSON copies and supports the key forms of get', async () => {
  const { storage } = createFakeChrome();
  const value = { a: [1, 2], when: new Date(0) };
  await storage.local.set({ one: value, two: 2 });
  value.a.push(3);
  assert.deepEqual(await storage.local.get('one'), { one: { a: [1, 2], when: '1970-01-01T00:00:00.000Z' } });
  assert.deepEqual(await storage.local.get(['two', 'missing']), { two: 2 });
  assert.deepEqual(await storage.local.get({ two: 0, three: 3 }), { two: 2, three: 3 });
  assert.deepEqual(Object.keys(await storage.local.get(null)), ['one', 'two']);
  await storage.local.remove(['one']);
  assert.deepEqual(await storage.local.get(null), { two: 2 });
});
