import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPlan, readTree, recoverInterrupted, takeSnapshot, undoChange } from '../../extension/platform/bookmarks.js';
import { createStore } from '../../extension/platform/store.js';
import { createFakeChrome, normalForm } from '../helpers/fake-chrome.mjs';

/** @typedef {ReturnType<typeof createFakeChrome>['bookmarks']} FakeBookmarks */

/**
 * Local bar: Dev (8 bookmarks and a Tools subfolder with 2), News (5), 2 loose bookmarks.
 * Local other: Read later (4), empty Archive. Account bar: Work (4) and empty Projects.
 */
async function setUp() {
  const fake = createFakeChrome({ account: true });
  const b = fake.bookmarks;
  /** @type {Record<string, string>} */
  const ids = {};
  /** @param {string} parentId @param {string} title @param {number} count */
  const fill = async (parentId, title, count) => {
    for (let i = 0; i < count; i += 1) {
      const node = await b.create({ parentId, title: `${title} ${i}`, url: `https://${title.toLowerCase().replaceAll(' ', '-')}.test/${i}` });
      ids[`${title}${i}`] = node.id;
    }
  };
  /** @param {string} parentId @param {string} title */
  const folder = async (parentId, title) => (ids[title] = (await b.create({ parentId, title })).id);

  await fill(await folder('1', 'Dev'), 'dev', 8);
  await fill(await folder(ids.Dev, 'Tools'), 'tool', 2);
  await fill(await folder('1', 'News'), 'news', 5);
  await fill('1', 'loose', 2);
  await fill(await folder('2', 'Read later'), 'read', 4);
  await folder('2', 'Archive');
  await fill(await folder('4', 'Work'), 'work', 4);
  await folder('4', 'Projects');

  const store = createStore(fake.storage.local);
  return { fake, bookmarks: b, store, ids };
}

/**
 * A plan as the extension would build it: origin and index read from the tree now.
 *
 * @param {FakeBookmarks} bookmarks
 * @param {[string, string][]} pairs node id and destination folder id
 */
async function planOf(bookmarks, pairs) {
  return Promise.all(
    pairs.map(async ([id, parentId]) => {
      const [node] = await bookmarks.get(id);
      return { id, from: { parentId: node.parentId, index: node.index }, to: { parentId } };
    }),
  );
}

/** @param {FakeBookmarks} bookmarks */
const snapshot = async (bookmarks) => normalForm(await readTree(bookmarks));

/**
 * Every original node still present is in its original folder, keeps its fields, and sits in
 * the same order relative to the other survivors.
 *
 * @param {ReturnType<typeof normalForm>} before
 * @param {ReturnType<typeof normalForm>} after
 */
function assertSurvivorsInPlace(before, after) {
  const afterById = new Map(after.map((node) => [node.id, node]));
  const originalIds = new Set(before.map((node) => node.id));
  /** @param {ReturnType<typeof normalForm>} list @param {string} parentId */
  const childIds = (list, parentId) =>
    list
      .filter((node) => node.parentId === parentId)
      .sort((x, y) => /** @type {number} */ (x.index) - /** @type {number} */ (y.index))
      .map((node) => node.id);

  for (const node of before) {
    const now = afterById.get(node.id);
    if (!now) continue;
    assert.deepEqual({ ...now, index: undefined }, { ...node, index: undefined }, `node ${node.id} keeps folder and fields`);
  }
  for (const parentId of new Set(before.map((node) => node.parentId).filter((id) => id !== undefined))) {
    const expected = childIds(before, /** @type {string} */ (parentId)).filter((id) => afterById.has(id));
    const actual = childIds(after, /** @type {string} */ (parentId)).filter((id) => originalIds.has(id));
    assert.deepEqual(actual, expected, `survivors of folder ${parentId} keep their order`);
  }
}

/** @param {any} bookmarks @param {string} parentId */
const childrenOf = async (bookmarks, parentId) => (await bookmarks.getChildren(parentId)).map((/** @type {any} */ node) => node.id);

test('apply moves each node, and undo leaves (id, parentId, index, title, url, dateAdded) identical', async () => {
  const { bookmarks, store, ids } = await setUp();
  const before = await snapshot(bookmarks);
  const plan = await planOf(bookmarks, [
    [ids.dev0, ids.News], // first of its folder
    [ids.dev3, ids.Archive],
    [ids.dev4, ids.Archive], // adjacent to the previous one
    [ids.dev7, ids['Read later']], // last of its folder
    [ids.Tools, ids.Archive], // a folder, with its contents
    [ids.news2, ids.Dev], // into a folder that is also an origin
    [ids.loose1, ids.Archive], // a bookmark directly under a root
    [ids.work1, ids.Projects], // account storage
  ]);

  const change = await applyPlan(plan, { bookmarks, store });
  assert.deepEqual(change.skipped, []);
  assert.equal(change.moves.length, plan.length);
  for (const move of plan) assert.equal((await bookmarks.get(move.id))[0].parentId, move.to.parentId);
  assert.notDeepEqual(await snapshot(bookmarks), before);

  const undo = await undoChange(change, { bookmarks, store });
  assert.deepEqual(undo.skipped, []);
  assert.deepEqual(undo.restored, plan.map((move) => move.id).reverse());
  assert.deepEqual(await snapshot(bookmarks), before);
});

test('with bookmarks added to the origins in between, undo keeps the survivors in order', async () => {
  const { bookmarks, store, ids } = await setUp();
  const before = await snapshot(bookmarks);
  const plan = await planOf(bookmarks, [
    [ids.dev1, ids.Archive],
    [ids.dev2, ids.Archive],
    [ids.dev5, ids.News],
    [ids.read0, ids.Archive],
  ]);
  const change = await applyPlan(plan, { bookmarks, store });

  const added = [
    (await bookmarks.create({ parentId: ids.Dev, index: 0, title: 'new first', url: 'https://new.test/1' })).id,
    (await bookmarks.create({ parentId: ids.Dev, index: 3, title: 'new middle', url: 'https://new.test/2' })).id,
    (await bookmarks.create({ parentId: ids.Dev, title: 'new last', url: 'https://new.test/3' })).id,
    (await bookmarks.create({ parentId: ids['Read later'], index: 0, title: 'new read', url: 'https://new.test/4' })).id,
  ];
  const undo = await undoChange(change, { bookmarks, store });

  assert.deepEqual(undo.skipped, []);
  assertSurvivorsInPlace(before, await snapshot(bookmarks));
  for (const id of added) assert.ok((await bookmarks.get(id))[0], 'what the person added stays');
});

test('with bookmarks removed from the origins in between, undo keeps the survivors in order', async () => {
  const { bookmarks, store, ids } = await setUp();
  const before = await snapshot(bookmarks);
  const plan = await planOf(bookmarks, [
    [ids.dev1, ids.Archive],
    [ids.dev3, ids.Archive],
    [ids.dev6, ids.News],
    [ids.read2, ids.Archive],
  ]);
  const change = await applyPlan(plan, { bookmarks, store });

  // The nearest predecessor of three moved nodes, and the first of each origin.
  for (const id of [ids.dev0, ids.dev2, ids.dev5, ids.read0, ids.read1]) await bookmarks.remove(id);
  const undo = await undoChange(change, { bookmarks, store });

  assert.deepEqual(undo.skipped, []);
  const after = await snapshot(bookmarks);
  assertSurvivorsInPlace(before, after);
  assert.deepEqual(await childrenOf(bookmarks, ids.Dev), [ids.dev1, ids.dev3, ids.dev4, ids.dev6, ids.dev7, ids.Tools]);
  assert.deepEqual(await childrenOf(bookmarks, ids['Read later']), [ids.read2, ids.read3]);
});

test('with an origin emptied by the person, undo puts the moved nodes back in order', async () => {
  const { bookmarks, store, ids } = await setUp();
  const plan = await planOf(bookmarks, [
    [ids.news1, ids.Archive],
    [ids.news3, ids.Archive],
  ]);
  const change = await applyPlan(plan, { bookmarks, store });
  for (const id of [ids.news0, ids.news2, ids.news4]) await bookmarks.remove(id);
  const added = (await bookmarks.create({ parentId: ids.News, title: 'only one', url: 'https://only.test/' })).id;

  await undoChange(change, { bookmarks, store });
  assert.deepEqual(await childrenOf(bookmarks, ids.News), [ids.news1, ids.news3, added]);
});

test('a node the person moved between the plan and the apply is skipped and reported', async () => {
  const { bookmarks, store, ids } = await setUp();
  const plan = await planOf(bookmarks, [
    [ids.dev1, ids.Archive],
    [ids.dev2, ids.Archive],
    [ids.news0, ids.Archive],
  ]);
  await bookmarks.move(ids.dev2, { parentId: ids.News }); // the person, after the preview
  await bookmarks.remove(ids.news0);
  const before = await snapshot(bookmarks);

  const change = await applyPlan(plan, { bookmarks, store });
  assert.deepEqual(change.skipped, [
    { id: ids.dev2, title: 'dev 2', reason: 'moved' },
    { id: ids.news0, title: undefined, reason: 'missing' },
  ]);
  assert.deepEqual(change.moves.map((move) => move.id), [ids.dev1]);
  assert.equal((await bookmarks.get(ids.dev2))[0].parentId, ids.News, 'the person’s move wins');

  await undoChange(change, { bookmarks, store });
  assert.deepEqual(await snapshot(bookmarks), before);
});

test('undo skips and reports a node the person moved out of the destination, and restores the rest', async () => {
  const { bookmarks, store, ids } = await setUp();
  const before = await snapshot(bookmarks);
  const plan = await planOf(bookmarks, [
    [ids.dev1, ids.Archive],
    [ids.dev2, ids.Archive],
    [ids.dev3, ids.Archive],
  ]);
  const change = await applyPlan(plan, { bookmarks, store });
  await bookmarks.move(ids.dev2, { parentId: ids['Read later'], index: 0 });
  await bookmarks.removeTree(ids.dev3);

  const undo = await undoChange(change, { bookmarks, store });
  assert.deepEqual(undo.restored, [ids.dev1]);
  assert.deepEqual(undo.skipped, [
    { id: ids.dev3, title: undefined, reason: 'missing' },
    { id: ids.dev2, title: 'dev 2', reason: 'moved' },
  ]);
  assert.equal((await bookmarks.get(ids.dev2))[0].parentId, ids['Read later']);
  assertSurvivorsInPlace(
    before.filter((node) => node.id !== ids.dev2),
    (await snapshot(bookmarks)).filter((node) => node.id !== ids.dev2),
  );
});

test('moves that fail the checks are reported and never sent to the API', async () => {
  const { bookmarks, store, ids } = await setUp();
  /** @type {string[]} */
  const sent = [];
  const spy = { ...bookmarks, move: (/** @type {string} */ id, /** @type {any} */ to) => (sent.push(id), bookmarks.move(id, to)) };
  const plan = [
    { id: '1', from: { parentId: '0', index: 0 }, to: { parentId: '2' } },
    { id: ids.dev0, from: { parentId: ids.Dev, index: 0 }, to: { parentId: ids.Work } },
    { id: ids.dev1, from: { parentId: ids.Dev, index: 1 }, to: { parentId: ids.Archive } },
    { id: ids.dev1, from: { parentId: ids.Dev, index: 1 }, to: { parentId: ids.News } },
  ];
  const change = await applyPlan(plan, { bookmarks: spy, store });
  assert.deepEqual(sent, [ids.dev1]);
  assert.deepEqual(
    change.skipped.map((skipped) => skipped.reason),
    ['root', 'cross-storage', 'duplicate'],
  );
});

test('a move Chrome rejects is reported with its message, and the others go on', async () => {
  const { bookmarks, store, ids } = await setUp();
  const before = await snapshot(bookmarks);
  // Each is valid against the tree, but after the first, the second is a folder into its own descendant.
  const plan = await planOf(bookmarks, [
    [ids.News, ids.Tools],
    [ids.Dev, ids.News],
    [ids.read0, ids.Archive],
  ]);
  const change = await applyPlan(plan, { bookmarks, store });
  assert.deepEqual(change.skipped, [{ id: ids.Dev, title: 'Dev', reason: 'error', message: "Can't move a folder to itself or its descendant." }]);
  assert.deepEqual(change.moves.map((move) => move.id), [ids.News, ids.read0]);

  await undoChange(change, { bookmarks, store });
  assert.deepEqual(await snapshot(bookmarks), before);
});

test('with `snapshot: true` the bulk snapshot is stored before the first move', async () => {
  const { bookmarks, store, ids, fake } = await setUp();
  const before = await snapshot(bookmarks);
  /** @type {unknown[]} */
  const seenAtFirstMove = [];
  const spy = {
    ...bookmarks,
    move: async (/** @type {string} */ id, /** @type {any} */ to) => {
      if (seenAtFirstMove.length === 0) {
        const { snapshots } = await fake.storage.local.get('snapshots');
        seenAtFirstMove.push((await store.readSnapshot(/** @type {string[]} */ (snapshots)[0]))?.nodes.length);
      }
      return bookmarks.move(id, to);
    },
  };
  const change = await applyPlan(await planOf(bookmarks, [[ids.dev0, ids.Archive]]), { bookmarks: spy, store, snapshot: true });
  assert.deepEqual(seenAtFirstMove, [before.length - 1], 'every node but the tree root');
  const stored = await store.readSnapshot(/** @type {string} */ (change.snapshotKey));
  assert.deepEqual(
    stored?.nodes.find((node) => node.id === ids.dev0),
    { id: ids.dev0, parentId: ids.Dev, index: 0, title: 'dev 0', url: 'https://dev.test/0', dateAdded: before.find((node) => node.id === ids.dev0)?.dateAdded, syncing: false },
  );
});

test('an apply that stops halfway leaves a running change that recoverInterrupted reconciles and undo reverts', async () => {
  const { bookmarks, store, ids, fake } = await setUp();
  const before = await snapshot(bookmarks);
  /** @type {() => void} */
  let stalled = () => {};
  const reachedThird = new Promise((resolve) => (stalled = () => resolve(undefined)));
  let calls = 0;
  const dying = {
    ...bookmarks,
    // The page closes during the third move: it never returns.
    move: (/** @type {string} */ id, /** @type {any} */ to) => ((calls += 1) === 3 ? (stalled(), new Promise(() => {})) : bookmarks.move(id, to)),
  };
  const plan = await planOf(bookmarks, [
    [ids.dev1, ids.Archive],
    [ids.dev4, ids.News],
    [ids.dev6, ids.Archive],
  ]);
  void applyPlan(plan, { bookmarks: dying, store });
  await reachedThird;

  // The intent is already stored; the two moves are still in the worker's buffer (FLUSH_EVERY).
  const [header] = await store.listChanges();
  assert.equal(header.status, 'running');
  assert.equal(header.planned, 3);
  assert.equal(header.done, 0);

  // Fresh: another context may still be running it, so it is left alone.
  const now = () => new Date(Date.parse(header.touchedAt) + 5000);
  assert.deepEqual(await recoverInterrupted({ bookmarks, store, now }), []);
  const later = () => new Date(Date.parse(header.touchedAt) + 120_000);
  assert.deepEqual(await recoverInterrupted({ bookmarks, store, now: later }), [header.id]);

  const change = /** @type {import('../../extension/platform/store.js').Change} */ (await store.getChange(header.id));
  assert.equal(change.status, 'interrupted');
  assert.deepEqual(change.moves.map((move) => move.id), [ids.dev1, ids.dev4]);
  assert.equal(change.undoable, true);
  void fake;
  await undoChange(header.id, { bookmarks, store });
  assert.deepEqual(await snapshot(bookmarks), before);
});

test('undo of a still-running stale change reconciles it first', async () => {
  const { bookmarks, store, ids } = await setUp();
  const before = await snapshot(bookmarks);
  let calls = 0;
  const dying = { ...bookmarks, move: (/** @type {string} */ id, /** @type {any} */ to) => ((calls += 1) === 2 ? new Promise(() => {}) : bookmarks.move(id, to)) };
  void applyPlan(await planOf(bookmarks, [[ids.dev1, ids.Archive], [ids.dev2, ids.Archive]]), { bookmarks: dying, store });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [header] = await store.listChanges();
  await undoChange(header.id, { bookmarks, store });
  assert.deepEqual(await snapshot(bookmarks), before);
});

test('a plan that moves nothing leaves no change, and does not hide the real one before it', async () => {
  const { bookmarks, store, ids } = await setUp();
  const first = await applyPlan(await planOf(bookmarks, [[ids.dev0, ids.Archive]]), { bookmarks, store });
  const folder = await bookmarks.create({ parentId: '1', title: 'Made for nothing' });
  await bookmarks.move(ids.dev1, { parentId: ids.News }); // moved by the person after the plan
  const plan = [{ id: ids.dev1, from: { parentId: ids.Dev, index: 0 }, to: { parentId: folder.id } }];
  const empty = await applyPlan(plan, { bookmarks, store, createdFolders: [folder.id] });
  assert.equal(empty.changeId, null);
  assert.deepEqual(empty.removedFolders, [folder.id]);
  assert.deepEqual((await store.listChanges()).map((header) => header.id), [first.changeId]);
  assert.equal((await store.lastChange())?.id, first.changeId);
});

test('listChanges is newest first, undoable only until undone, and an undone change does not hide an older one', async () => {
  const { bookmarks, store, ids } = await setUp();
  const a = await applyPlan(await planOf(bookmarks, [[ids.dev0, ids.Archive]]), { bookmarks, store, label: 'A', kind: 'proposal', now: () => new Date('2026-11-05T10:00:00Z') });
  const b = await applyPlan(await planOf(bookmarks, [[ids.dev1, ids.Archive]]), { bookmarks, store, label: 'B', now: () => new Date('2026-11-05T11:00:00Z') });
  await undoChange(b.changeId ?? '', { bookmarks, store });
  const list = await store.listChanges(20);
  assert.deepEqual(list.map((header) => [header.label, header.kind, header.undoable]), [['B', 'sort', false], ['A', 'proposal', true]]);
  await undoChange(/** @type {string} */ (a.changeId), { bookmarks, store });
  assert.equal((await store.listChanges(1)).length, 1);
  await assert.rejects(undoChange(/** @type {string} */ (a.changeId), { bookmarks, store }), /already undone/);
  await assert.rejects(undoChange('change:nope', { bookmarks, store }), /does not exist/);
});

test('two undos at once: the second is refused instead of running twice', async () => {
  const { bookmarks, store, ids } = await setUp();
  const change = await applyPlan(await planOf(bookmarks, [[ids.dev0, ids.Archive], [ids.dev1, ids.Archive]]), { bookmarks, store });
  const results = await Promise.allSettled([undoChange(/** @type {string} */ (change.changeId), { bookmarks, store }), undoChange(/** @type {string} */ (change.changeId), { bookmarks, store })]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
});

test('undo reads each origin folder once, however many nodes it restores', async () => {
  const fake = createFakeChrome();
  const b = fake.bookmarks;
  const store = createStore(fake.storage.local);
  const source = await b.create({ parentId: '1', title: 'Source' });
  const target = await b.create({ parentId: '1', title: 'Target' });
  /** @type {string[]} */
  const nodes = [];
  for (let i = 0; i < 300; i += 1) nodes.push((await b.create({ parentId: source.id, title: `n${i}`, url: `https://n.test/${i}` })).id);
  const before = normalForm(await b.getTree());
  const plan = nodes.filter((_, i) => i % 2 === 0).map((id, i) => ({ id, from: { parentId: source.id, index: i * 2 }, to: { parentId: target.id } }));
  const change = await applyPlan(plan, { bookmarks: b, store });
  assert.equal(change.done.length, 150);

  let reads = 0;
  const counting = { ...b, getChildren: (/** @type {string} */ id) => ((reads += 1), b.getChildren(id)) };
  await undoChange(/** @type {string} */ (change.changeId), { bookmarks: counting, store });
  assert.equal(reads, 1, 'one getChildren for the one origin folder');
  assert.deepEqual(normalForm(await b.getTree()), before);
});

test('a change is undone only once', async () => {
  const { bookmarks, store, ids } = await setUp();
  const change = await applyPlan(await planOf(bookmarks, [[ids.dev0, ids.Archive]]), { bookmarks, store });
  await undoChange(change, { bookmarks, store });
  await assert.rejects(undoChange(change, { bookmarks, store }), /already undone/);
  const stored = await store.lastChange();
  assert.deepEqual(stored?.undo?.restored, [ids.dev0]);
});

test('takeSnapshot stores the tree without moving anything', async () => {
  const { bookmarks, store } = await setUp();
  const before = await snapshot(bookmarks);
  const { key, backup } = await takeSnapshot({ bookmarks, store, now: () => new Date('2026-11-05T12:00:00Z') });
  assert.equal(key, 'snapshot:2026-11-05T12:00:00.000Z:1');
  assert.deepEqual(await store.readSnapshot(key), backup);
  assert.deepEqual(await snapshot(bookmarks), before);
});

/** Deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function random(/** @type {number} */ seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: random plans, then random additions and removals in the origins, undo keeps survivors in order', async () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const next = random(seed);
    const pick = (/** @type {any[]} */ list) => list[Math.floor(next() * list.length)];
    const fake = createFakeChrome();
    const b = fake.bookmarks;
    const store = createStore(fake.storage.local);
    /** @type {string[]} */
    const folders = [];
    for (let f = 0; f < 6; f += 1) {
      const folder = await b.create({ parentId: f < 4 ? '1' : '2', title: `F${f}` });
      folders.push(folder.id);
      const size = 3 + Math.floor(next() * 8);
      for (let i = 0; i < size; i += 1) await b.create({ parentId: folder.id, title: `F${f}-${i}`, url: `https://f${f}.test/${i}` });
    }
    const before = normalForm(await b.getTree());
    const leaves = before.filter((node) => node.url !== undefined);
    const moved = leaves.filter(() => next() < 0.4);
    const plan = moved.map((node) => ({
      id: node.id,
      from: { parentId: /** @type {string} */ (node.parentId), index: /** @type {number} */ (node.index) },
      to: { parentId: pick(folders.filter((id) => id !== node.parentId)) },
    }));
    const change = await applyPlan(plan, { bookmarks: b, store });
    assert.equal(change.moves.length, plan.length, `seed ${seed}`);

    const movedIds = new Set(moved.map((node) => node.id));
    for (const origin of new Set(plan.map((move) => move.from.parentId))) {
      const kept = (await b.getChildren(origin)).filter((/** @type {any} */ node) => !movedIds.has(node.id));
      for (const node of kept) if (next() < 0.3) await b.remove(node.id);
      const adds = Math.floor(next() * 3);
      for (let i = 0; i < adds; i += 1) {
        const count = (await b.getChildren(origin)).length;
        await b.create({ parentId: origin, index: Math.floor(next() * (count + 1)), title: `added ${i}`, url: `https://added.test/${seed}/${i}` });
      }
    }

    const undo = await undoChange(change, { bookmarks: b, store });
    assert.deepEqual(undo.skipped, [], `seed ${seed}`);
    assertSurvivorsInPlace(before, normalForm(await b.getTree()));
  }
});
