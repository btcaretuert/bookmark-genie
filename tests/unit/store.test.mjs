import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHUNK_SIZE, KEEP_CHANGES, KEEP_SNAPSHOTS, createStore, withLock } from '../../extension/platform/store.js';
import { createFakeChrome } from '../helpers/fake-chrome.mjs';

const backupAt = (/** @type {string} */ createdAt) =>
  /** @type {import('../../extension/core/backup.js').Backup} */ ({ format: 'bookmark-genie-backup', schemaVersion: 1, createdAt, roots: [], nodes: [] });

const move = (/** @type {number} */ n) => ({ id: String(n), from: { parentId: '1', index: n }, to: { parentId: '2', index: n } });
const plan = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ id: String(i), from: { parentId: '1', index: i }, to: { parentId: '2' } }));

/** @param {ReturnType<typeof createStore>} store @param {string} at @param {number} moves */
async function writeChange(store, at, moves) {
  const id = await store.beginChange({ createdAt: at, origins: { 1: [] }, plan: plan(moves) });
  await store.appendMoves(id, Array.from({ length: moves }, (_, i) => move(i)), at);
  await store.endChange(id, { skipped: [], finishedAt: at });
  return id;
}

test('snapshots get distinct keys; each kind keeps its newest, so Ctrl+D traffic cannot push out a bulk one', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const first = await store.saveSnapshot(backupAt('2026-11-05T12:00:00.000Z'));
  const second = await store.saveSnapshot(backupAt('2026-11-05T12:00:00.000Z'));
  assert.notEqual(first, second);
  assert.deepEqual(await store.readSnapshot(first), backupAt('2026-11-05T12:00:00.000Z'));
  const bulk = await store.saveSnapshot(backupAt('2026-11-05T12:30:00.000Z'), { kind: 'bulk' });

  for (let i = 0; i < KEEP_SNAPSHOTS + 2; i += 1) await store.saveSnapshot(backupAt(`2026-11-06T00:00:0${i}.000Z`));
  const keys = await store.listSnapshots();
  assert.equal(keys.length, KEEP_SNAPSHOTS + 1, 'KEEP_SNAPSHOTS manual plus the bulk one');
  assert.ok(keys.includes(bulk));
  assert.equal(await store.readSnapshot(first), null, 'the oldest manual one is removed from storage, not only from the list');
  assert.deepEqual(Object.keys(await storage.local.get(null)).filter((key) => key.startsWith('snapshot:')).sort(), [...keys].sort());
});

test('a change is written as intent, then moves in chunks, then closed; empty ones leave nothing', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const id = await store.beginChange({ createdAt: '2026-11-05T10:00:00.000Z', origins: { 1: ['a', 'b'] }, plan: plan(2), label: 'x', kind: 'proposal' });
  let [header] = await store.listChanges();
  assert.deepEqual([header.status, header.planned, header.done, header.undoable], ['running', 2, 0, false]);
  assert.equal((await store.getChange(id))?.plan.length, 2, 'the plan is stored before any move');

  await store.appendMoves(id, [move(0)], '2026-11-05T10:00:01.000Z');
  await store.appendMoves(id, [move(1)], '2026-11-05T10:00:02.000Z');
  await store.endChange(id, { skipped: [{ id: '9', reason: 'moved' }], finishedAt: '2026-11-05T10:00:03.000Z' });
  [header] = await store.listChanges();
  assert.deepEqual([header.status, header.done, header.skipped, header.undoable, header.kind, header.label], ['done', 2, 1, true, 'proposal', 'x']);
  const change = await store.getChange(id);
  assert.deepEqual(change?.moves, [move(0), move(1)]);
  assert.deepEqual(change?.skipped, [{ id: '9', reason: 'moved' }]);

  const empty = await store.beginChange({ createdAt: '2026-11-05T11:00:00.000Z', origins: {}, plan: plan(1) });
  await store.endChange(empty, { skipped: [], finishedAt: '2026-11-05T11:00:01.000Z' });
  assert.deepEqual((await store.listChanges()).map((entry) => entry.id), [id]);
  assert.equal(await store.getChange(empty), null);
  assert.deepEqual(Object.keys(await storage.local.get(null)).filter((key) => key.includes('2026-11-05T11')), [], 'its keys are gone too');
});

test('moves go to storage once each, in chunks: a mass change does not rewrite the journal per move', async () => {
  const fake = createFakeChrome();
  let bytes = 0;
  const area = { ...fake.storage.local, get: fake.storage.local.get, remove: fake.storage.local.remove, set: (/** @type {any} */ items) => ((bytes += JSON.stringify(items).length), fake.storage.local.set(items)) };
  const store = createStore(/** @type {any} */ (area));
  const total = CHUNK_SIZE * 5 + 7;
  const id = await store.beginChange({ createdAt: '2026-11-05T10:00:00.000Z', origins: {}, plan: plan(total) });
  for (let at = 0; at < total; at += 25) await store.appendMoves(id, Array.from({ length: Math.min(25, total - at) }, (_, i) => move(at + i)), '2026-11-05T10:00:01.000Z');
  await store.endChange(id, { skipped: [], finishedAt: '2026-11-05T10:00:02.000Z' });
  const change = await store.getChange(id);
  assert.deepEqual(change?.moves.map((entry) => entry.id), Array.from({ length: total }, (_, i) => String(i)));
  assert.equal(change?.chunks, 6);
  const once = JSON.stringify(Array.from({ length: total }, (_, i) => move(i))).length;
  // Each flush rewrites at most the open chunk (CHUNK_SIZE moves) plus the small headers: bounded per flush, linear overall.
  assert.ok(bytes < once * 10, `wrote ${bytes} bytes for ${once} bytes of moves`);
});

test('the journal keeps the newest KEEP_CHANGES and deletes the bodies of the rest', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < KEEP_CHANGES + 3; i += 1) ids.push(await writeChange(store, `2026-11-05T10:00:${String(i).padStart(2, '0')}.000Z`, 2));
  const list = await store.listChanges(100);
  assert.equal(list.length, KEEP_CHANGES);
  assert.equal(list[0].id, ids.at(-1));
  assert.equal(await store.getChange(ids[0]), null);
  assert.equal((await store.lastChange())?.id, ids.at(-1));
  const stored = Object.keys(await storage.local.get(null)).filter((key) => key.startsWith('change:'));
  assert.equal(stored.length, KEEP_CHANGES * 2, 'one body and one chunk per kept change, none for the dropped');
  assert.equal(await store.sweepOrphans(), 0);
});

test('the 0.3.0 journal is converted without losing anything, and undo data survives', async () => {
  const { storage } = createFakeChrome();
  const moves = Array.from({ length: CHUNK_SIZE + 5 }, (_, i) => move(i));
  const legacy = [
    { id: 'change:old:1', createdAt: '2026-11-01T00:00:00.000Z', snapshotKey: 'snapshot:old:1', origins: { 1: ['0', '1'] }, moves, skipped: [{ id: 'z', reason: 'moved' }], finishedAt: '2026-11-01T00:00:01.000Z', undo: null },
    { id: 'change:old:2', createdAt: '2026-11-02T00:00:00.000Z', snapshotKey: 'snapshot:old:2', origins: {}, moves: [move(0)], skipped: [], createdFolders: ['f'], finishedAt: null, undo: null },
    { id: 'change:old:3', createdAt: '2026-11-03T00:00:00.000Z', snapshotKey: 'snapshot:old:3', origins: {}, moves: [move(1)], skipped: [], finishedAt: '2026-11-03T00:00:01.000Z', undo: { at: '2026-11-03T01:00:00.000Z', restored: ['1'], skipped: [] } },
  ];
  await storage.local.set({ journal: legacy });
  const store = createStore(storage.local);

  const list = await store.listChanges();
  assert.deepEqual(list.map((header) => [header.id, header.status, header.done, header.undoable, header.undone]), [
    ['change:old:3', 'done', 1, false, true],
    ['change:old:2', 'interrupted', 1, true, false],
    ['change:old:1', 'done', CHUNK_SIZE + 5, true, false],
  ]);
  const first = await store.getChange('change:old:1');
  assert.deepEqual(first?.moves, moves);
  assert.deepEqual(first?.origins, { 1: ['0', '1'] });
  assert.deepEqual(first?.skipped, [{ id: 'z', reason: 'moved' }]);
  assert.equal(first?.snapshotKey, 'snapshot:old:1');
  assert.deepEqual((await store.getChange('change:old:2'))?.createdFolders, ['f']);
  assert.equal((await store.getChange('change:old:3'))?.undo?.at, '2026-11-03T01:00:00.000Z');
  const again = await store.listChanges();
  assert.deepEqual(again, list, 'running the conversion twice changes nothing');
});

for (const [label, options] of /** @type {[string, any][]} */ ([['navigator.locks or the fallback, whichever the runtime has', {}], ['the in-process fallback queue', { locks: null }]])) test(`withLock serializes tasks of the same name and lets other names run: ${label}`, async () => {
  /** @type {string[]} */
  const trace = [];
  const task = (/** @type {string} */ name, /** @type {number} */ ms) => async () => {
    trace.push(`${name}+`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    trace.push(`${name}-`);
  };
  await Promise.all([withLock('a', task('1', 20), options), withLock('a', task('2', 1), options), withLock('b', task('3', 5), options)]);
  assert.ok(trace.indexOf('1-') < trace.indexOf('2+'), 'same name: the second waits for the first');
  assert.ok(trace.indexOf('3+') < trace.indexOf('1-'), 'another name does not wait');
  await assert.rejects(withLock('a', async () => { throw new Error('boom'); }, options), /boom/);
  await withLock('a', async () => trace.push('after a failure'), options);
  assert.equal(trace.at(-1), 'after a failure', 'a failed task does not jam the queue');
});

test('withLock uses navigator.locks when given, with an exclusive request', async () => {
  /** @type {unknown[]} */
  const requests = [];
  const locks = { request: async (/** @type {string} */ name, /** @type {any} */ options, /** @type {() => Promise<any>} */ callback) => (requests.push([name, options.mode]), callback()) };
  assert.equal(await withLock('journal', async () => 7, { locks }), 7);
  assert.deepEqual(requests, [['bookmark-genie:journal', 'exclusive']]);
});

test('two writers racing on the journal keep both changes complete (0.3.0 lost one in 124 of 200 runs)', async () => {
  for (let run = 0; run < 25; run += 1) {
    const { storage } = createFakeChrome();
    // Chrome's storage answers after a variable delay, which is what lets two writers interleave.
    const slow = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, Math.random() * ms));
    const area = /** @type {any} */ ({
      get: async (/** @type {any} */ keys) => (await slow(3), storage.local.get(keys)),
      set: async (/** @type {any} */ items) => (await slow(3), storage.local.set(items)),
      remove: async (/** @type {any} */ keys) => (await slow(3), storage.local.remove(keys)),
    });
    const worker = createStore(area);
    const page = createStore(area); // another context, same storage
    const write = (/** @type {ReturnType<typeof createStore>} */ store, /** @type {string} */ at) => async () => {
      const id = await store.beginChange({ createdAt: at, origins: {}, plan: plan(3) });
      for (let i = 0; i < 3; i += 1) await store.appendMoves(id, [move(i)], at);
      await store.endChange(id, { skipped: [], finishedAt: at });
    };
    await Promise.all([write(worker, '2026-11-05T10:00:00.000Z')(), write(page, '2026-11-05T10:00:00.000Z')()]);
    const list = await worker.listChanges();
    assert.equal(list.length, 2, `run ${run}`);
    assert.deepEqual(list.map((header) => [header.status, header.done]), [['done', 3], ['done', 3]], `run ${run}`);
    assert.notEqual(list[0].id, list[1].id);
  }
});

test('sweepOrphans removes change and snapshot keys nothing refers to', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  await writeChange(store, '2026-11-05T10:00:00.000Z', 2);
  await storage.local.set({ 'change:ghost:1': {}, 'change:ghost:1:m0': [], 'snapshot:ghost:1': backupAt('x') });
  assert.equal(await store.sweepOrphans(), 3);
  assert.equal((await store.listChanges()).length, 1);
});
