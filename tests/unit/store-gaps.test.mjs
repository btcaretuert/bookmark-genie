import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHUNK_SIZE, KEEP_SNAPSHOTS, STALE_MS, createStore } from '../../extension/platform/store.js';
import { createFakeChrome } from '../helpers/fake-chrome.mjs';

// Gaps found by mutating platform/store.js: the 0.3.0 journal migration, retention by kind, the
// undo claim and its stale lock, and the "an empty change is not undoable" rule.

const backupAt = (/** @type {string} */ createdAt) =>
  /** @type {import('../../extension/core/backup.js').Backup} */ ({ format: 'bookmark-genie-backup', schemaVersion: 1, createdAt, roots: [], nodes: [] });
const move = (/** @type {number} */ n) => ({ id: String(n), from: { parentId: '1', index: n }, to: { parentId: '2', index: n } });
const plan = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ id: String(i), from: { parentId: '1', index: i }, to: { parentId: '2' } }));
const AT = '2026-11-05T10:00:00.000Z';
const later = (/** @type {number} */ ms) => new Date(Date.parse(AT) + ms).toISOString();

/** @param {ReturnType<typeof createStore>} store @param {number} moves */
async function writeChange(store, moves, createdAt = AT) {
  const id = await store.beginChange({ createdAt, origins: { 1: [] }, plan: plan(moves) });
  await store.appendMoves(id, Array.from({ length: moves }, (_, i) => move(i)), createdAt);
  await store.endChange(id, { skipped: [], finishedAt: createdAt });
  return id;
}
const keysOf = async (/** @type {any} */ storage, /** @type {string} */ prefix) => Object.keys(await storage.local.get(null)).filter((key) => key.startsWith(prefix)).sort();

test('0.3.0 journal: each entry becomes a v2 change with its status, counts and undo state', async () => {
  const { storage } = createFakeChrome();
  const moves = Array.from({ length: 3 }, (_, i) => move(i));
  await storage.local.set({
    journal: [
      { id: 'a', createdAt: AT, finishedAt: later(1000), moves, skipped: [{ id: '9', reason: 'moved' }], origins: { 1: ['0', '1', '2'] } },
      { id: 'b', createdAt: AT, moves: moves.slice(0, 1), skipped: [] },
      { id: 'c', createdAt: AT, finishedAt: later(1000), moves, skipped: [], undo: { at: later(5000) } },
      null,
      'junk',
      [],
    ],
  });
  const store = createStore(storage.local);
  const changes = Object.fromEntries((await store.listChanges()).map((change) => [change.id, change]));
  assert.deepEqual(Object.keys(changes).sort(), ['a', 'b', 'c'], 'null, strings and arrays are dropped');
  assert.equal(changes.a.status, 'done');
  assert.equal(changes.a.finishedAt, later(1000));
  assert.equal(changes.a.planned, 4, 'moves plus skipped');
  assert.equal(changes.a.done, 3);
  assert.equal(changes.a.skipped, 1);
  assert.equal(changes.a.undoable, true);
  assert.equal(changes.b.status, 'interrupted');
  assert.equal(changes.b.finishedAt, null);
  assert.equal(changes.c.undone, true);
  assert.equal(changes.c.undoAt, later(5000));
  assert.equal(changes.c.undoable, false);
  const full = await store.getChange('a');
  assert.deepEqual(full?.moves, moves);
  assert.deepEqual(full?.origins, { 1: ['0', '1', '2'] });
});

test('0.3.0 journal: a change that fills whole chunks gets no extra empty chunk', async () => {
  const { storage } = createFakeChrome();
  const moves = Array.from({ length: CHUNK_SIZE * 2 }, (_, i) => move(i));
  await storage.local.set({ journal: [{ id: 'big', createdAt: AT, finishedAt: AT, moves, skipped: [], origins: [] }] });
  const store = createStore(storage.local);
  const [header] = await store.listChanges();
  assert.equal(header.chunks, 2);
  assert.equal((await keysOf(storage, 'big:m')).length, 2);
  assert.deepEqual((await store.getChange('big'))?.origins, {}, 'an array is not a map of origins');
});

test('two changes begun in the same millisecond get different ids', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const first = await store.beginChange({ createdAt: AT, origins: {}, plan: plan(1) });
  const second = await store.beginChange({ createdAt: AT, origins: {}, plan: plan(1) });
  const third = await store.beginChange({ createdAt: AT, origins: {}, plan: plan(1) });
  assert.equal(new Set([first, second, third]).size, 3);
  assert.equal((await store.listChanges()).length, 3);
});

test('bulk and ordinary snapshots are counted apart: a run of bulk ones does not push out the manual one', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const manual = await store.saveSnapshot(backupAt('2026-11-01T00:00:00.000Z'));
  /** @type {string[]} */
  const bulk = [];
  for (let i = 0; i < KEEP_SNAPSHOTS + 1; i += 1) bulk.push(await store.saveSnapshot(backupAt(`2026-11-02T00:00:0${i}.000Z`), { kind: 'bulk' }));
  const keys = await store.listSnapshots();
  assert.ok(keys.includes(manual), 'the manual snapshot stays');
  assert.ok(!keys.includes(bulk[0]), 'the oldest bulk one goes');
  assert.equal(await store.readSnapshot(bulk[0]), null);
  assert.equal(keys.length, KEEP_SNAPSHOTS + 1);
  assert.deepEqual(await keysOf(storage, 'snapshot:'), [...keys].sort());
});

test('removeChange takes out that change and its chunks, and no other', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const keep = await writeChange(store, 1, later(0));
  const drop = await writeChange(store, CHUNK_SIZE * 2 + 1, later(1000));
  await store.removeChange(drop);
  assert.deepEqual((await store.listChanges()).map((change) => change.id), [keep]);
  assert.equal((await keysOf(storage, keep)).length, 2, 'its body and its chunk');
  assert.deepEqual(await keysOf(storage, drop), []);
  await store.removeChange('change:unknown');
  assert.equal((await store.listChanges()).length, 1);
});

test('a change with no moves is not undoable, is not "the last change" and leaves nothing behind when closed', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const real = await writeChange(store, 2, later(0));
  const empty = await store.beginChange({ createdAt: later(1000), origins: {}, plan: plan(1) });
  const [running] = await store.listChanges();
  assert.equal(running.id, empty);
  assert.equal(running.undoable, false);
  assert.equal((await store.getChange(empty))?.undoable, false);
  assert.equal((await store.lastChange())?.id, real, 'an empty running change does not hide the real one');
  assert.equal((await store.readJournal()).find((change) => change.id === empty)?.undoable, false);
  await store.endChange(empty, { skipped: [], finishedAt: later(2000) });
  assert.deepEqual((await store.listChanges()).map((change) => change.id), [real]);
  assert.deepEqual(await keysOf(storage, empty), []);
});

test('an undone change is not undoable even with moves, and the claim is single-use', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const id = await writeChange(store, 2);
  assert.equal(await store.claimUndo(id, later(1000)), true);
  await store.finishUndo(id, { at: later(1500), restored: [], skipped: [] });
  const header = (await store.listChanges())[0];
  assert.equal(header.done, 2);
  assert.equal(header.undone, true);
  assert.equal(header.undoable, false);
  assert.equal((await store.getChange(id))?.undoable, false);
  assert.equal(await store.claimUndo(id, later(999_999)), false, 'already undone');
});

test('claiming an undo: refused for an empty change, refused while another claim is fresh, allowed once it is stale', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const empty = await store.beginChange({ createdAt: AT, origins: {}, plan: plan(1) });
  assert.equal(await store.claimUndo(empty, later(1)), false, 'nothing to undo');
  const id = await writeChange(store, 2, later(10));
  assert.equal(await store.claimUndo(id, later(1000)), true);
  assert.equal(await store.claimUndo(id, later(1000 + STALE_MS - 1)), false, 'a claim younger than STALE_MS holds');
  assert.equal(await store.claimUndo(id, later(1000 + STALE_MS)), true, 'at STALE_MS the lock is stale');
});

test('reconciling an interrupted change rewrites its chunks, drops the extra ones and keeps nothing for an empty one', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const id = await writeChange(store, CHUNK_SIZE * 2 + 1);
  assert.equal((await keysOf(storage, `${id}:m`)).length, 3);
  await store.reconcileChange(id, Array.from({ length: CHUNK_SIZE }, (_, i) => move(i)), later(5000));
  const [header] = await store.listChanges();
  assert.equal(header.chunks, 1);
  assert.equal(header.done, CHUNK_SIZE);
  assert.equal(header.status, 'interrupted');
  assert.equal(header.undoable, true);
  assert.equal((await keysOf(storage, `${id}:m`)).length, 1, 'no extra empty chunk, no stale one');

  await store.reconcileChange(id, [], later(6000));
  const [none] = await store.listChanges();
  assert.equal(none.done, 0);
  assert.equal(none.undoable, false, 'nothing left to undo');

  const lost = await store.beginChange({ createdAt: later(7000), origins: {}, plan: plan(1) });
  await store.reconcileChange(lost, [], later(8000));
  assert.ok(!(await store.listChanges()).some((change) => change.id === lost));
  assert.deepEqual(await keysOf(storage, lost), []);
});

test('appending moves in pieces fills chunks to CHUNK_SIZE before starting another', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const id = await store.beginChange({ createdAt: AT, origins: {}, plan: plan(1) });
  await store.appendMoves(id, Array.from({ length: CHUNK_SIZE - 1 }, (_, i) => move(i)), AT);
  await store.appendMoves(id, [move(900), move(901), move(902)], AT);
  await store.appendMoves(id, Array.from({ length: CHUNK_SIZE - 1 }, (_, i) => move(1000 + i)), AT);
  const [header] = await store.listChanges();
  assert.equal(header.done, CHUNK_SIZE * 2 + 1);
  assert.equal(header.chunks, 3);
  const full = await store.getChange(id);
  assert.equal(full?.moves.length, CHUNK_SIZE * 2 + 1);
  assert.deepEqual(full?.moves.slice(CHUNK_SIZE - 1, CHUNK_SIZE + 1).map((entry) => entry.id), ['900', '901']);
});

test('sweeping orphans removes change and snapshot keys that nothing refers to, and only those', async () => {
  const { storage } = createFakeChrome();
  const store = createStore(storage.local);
  const id = await writeChange(store, 2);
  const snapshot = await store.saveSnapshot(backupAt(AT));
  await storage.local.set({ 'change:ghost:body': {}, 'snapshot:ghost': {}, other: 1 });
  assert.equal(await store.sweepOrphans(), 2);
  assert.equal(await store.sweepOrphans(), 0);
  assert.ok((await store.getChange(id)) && (await store.readSnapshot(snapshot)));
  assert.equal((await storage.local.get('other')).other, 1);
});
