import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONSENT_VERSION,
  DAILY_USD_CAP,
  DEFAULT_SETTINGS,
  candidateFolders,
  dayKey,
  errorCategory,
  errorText,
  looseSiblings,
  normalizeSettings,
  readAutoSortAnswer,
} from '../../extension/core/autosort.js';
import { estimateTokens } from '../../extension/core/batching.js';
import { worstCaseUsd } from '../../extension/core/budget.js';
import { budgetPrices } from '../../extension/core/models.js';
import { createAutoSorter } from '../../extension/platform/autosort.js';
import { createFlow } from '../../extension/platform/flow.js';
import { RetryLaterError } from '../../extension/platform/llm.js';
import { PROPOSAL_TTL_MS, createProposals } from '../../extension/platform/proposals.js';
import { getProvider } from '../../extension/platform/providers.js';
import { createSettingsStore } from '../../extension/platform/settings.js';
import { backupReminder, formatMoney, parseMaxCalls, usageLine } from '../../extension/ui/present.js';
import { createFakeChrome } from '../helpers/fake-chrome.mjs';

// Gaps found by mutating the sort lane (platform/autosort.js, core/autosort.js, platform/proposals.js,
// platform/flow.js) with the context tests and the 0.4.0 suites in place. Each test names what
// it pins: spend, privacy or the data the person keeps.

const KEY = 'test-key-not-real-1234567890';
const GEMINI_HOST = 'https://generativelanguage.googleapis.com/*';
const PAGE = 'https://cooking.example.com/recipes/bread';
const EMPTY = { folder: -1, confidence: 'low', name: '', description: '', together: [] };
/** @typedef {import('../../extension/core/types.js').CompletionRequest} CompletionRequest */
const result = (/** @type {unknown} */ data) => ({
  data,
  stopReason: 'end_turn',
  refusalCategory: null,
  servedModel: 'gemini-3.5-flash-lite',
  requestId: null,
  latencyMs: 5,
  usage: { attempts: [{ model: 'gemini-3.5-flash-lite', inputTokens: 300, outputTokens: 20, thinkingTokens: 0, kind: 'message' }], inputTokens: 300, outputTokens: 20, thinkingTokens: 0, usedFallback: false },
});
const folderNumber = (/** @type {CompletionRequest} */ request, /** @type {string} */ name) => JSON.parse(/** @type {string[]} */ (/<folders>\n(.*)\n<\/folders>/s.exec(request.user))[1]).find((/** @type {any} */ folder) => folder.name === name).f;
const existing = (/** @type {string} */ name, confidence = 'high') => (/** @type {CompletionRequest} */ request) => result({ ...EMPTY, kind: 'existing', folder: folderNumber(request, name), confidence });
const proposeNew = (/** @type {string} */ name) => () => result({ ...EMPTY, kind: 'new', confidence: 'high', name, description: `Sobre ${name}.` });

/**
 * @param {{reply?: (request: CompletionRequest) => any, settings?: object, now?: () => Date, throws?: (request: CompletionRequest) => void}} [options]
 */
async function setUp({ reply = existing('Cocina'), settings = {}, now, throws } = {}) {
  const fake = createFakeChrome({ account: true });
  const b = fake.bookmarks;
  /** @type {Record<string, string>} */
  const folders = {};
  for (const name of ['Cocina', 'Programación', 'Viajes']) folders[name] = (await b.create({ parentId: '4', title: name })).id;
  const store = createSettingsStore(fake.storage.local);
  await store.saveSettings({
    ...DEFAULT_SETTINGS,
    enabled: true,
    confirmBeforeMove: false,
    consent: { provider: 'gemini', readOn: getProvider('gemini').dataPolicy.readOn, version: CONSENT_VERSION, at: '2026-11-05T10:00:00.000Z' },
    ...settings,
  });
  await store.saveKey('gemini', KEY);
  for (const name of ['tabs', GEMINI_HOST]) fake.permissions.granted.add(name);
  /** @type {CompletionRequest[]} */
  const calls = [];
  let replyWith = reply;
  const createComplete = () => async (/** @type {CompletionRequest} */ request) => {
    calls.push(request);
    throws?.(request);
    return replyWith(request);
  };
  const common = { bookmarks: b, tabs: fake.tabs, permissions: fake.permissions, storage: fake.storage.local, action: fake.action, now, createComplete };
  const sorter = createAutoSorter({ ...common, wait: async () => {}, schedule: () => {}, deadlineMs: 20_000 });
  const flow = createFlow({ ...common, schedule: () => {} });
  const save = async (/** @type {{url?: string, title?: string, parentId?: string}} */ { url = PAGE, title = 'Pan de masa madre', parentId = '4' } = {}) => {
    fake.tabs.setActive(url);
    const node = await b.create({ parentId, title, url });
    return { node, event: /** @type {any} */ (await sorter.handleCreated(node.id, node)) };
  };
  return { fake, b, folders, store, sorter, flow, calls, save, setReply: (/** @type {any} */ next) => (replyWith = next) };
}

// --- Spend -------------------------------------------------------------------------------------

for (const [status, calls] of /** @type {[number | null, number][]} */ ([[500, 2], [502, 2], [503, 2], [408, 2], [409, 2], [null, 2], [501, 1], [429, 1], [400, 1], [401, 1], [404, 1]])) {
  test(`a failure with status ${status} is called ${calls} time(s): only server errors and conflicts are worth a second call`, async () => {
    /** @type {number[]} */
    const reservedWhenSent = [];
    /** @type {any} */
    let context;
    context = await setUp({
      reply: async () => {
        reservedWhenSent.push((await context.store.readUsage(dayKey(new Date()))).calls);
        throw new RetryLaterError('Provider said no', null, { status });
      },
    });
    const { event } = await context.save();
    assert.equal(context.calls.length, calls);
    assert.equal(event.kind, 'error');
    assert.deepEqual(reservedWhenSent, Array(calls).fill(1), 'each call is reserved against the cap before it is sent');
    // 0.4.1 (funcional P2-2): none of these could have been billed, so each reservation is given back.
    assert.equal((await context.store.readUsage(dayKey(new Date()))).calls, 0, 'a call that could not be billed does not count');
  });
}

test('a timeout and a plain error are never called again', async () => {
  for (const error of [new RetryLaterError('No answer', null, { timedOut: true }), new Error('boom')]) {
    const context = await setUp({
      throws: () => {
        throw error;
      },
    });
    const { event } = await context.save();
    assert.equal(context.calls.length, 1, error.message);
    assert.equal(event.kind, 'error');
  }
});

test('the error shown keeps its first characters, hides the key and fits 200 characters', async () => {
  for (const [make, fits] of /** @type {[(k: string) => Error, number][]} */ ([
    [(key) => new Error(`FIRST-WORD ${key} ${'x'.repeat(5000)}`), 200],
    [(key) => new RetryLaterError(`FIRST-WORD ${key}`, null, { status: 400 }), 200],
  ])) {
    const context = await setUp({
      throws: () => {
        throw make(KEY);
      },
    });
    const { event } = await context.save();
    // 0.4.1: what the person reads is the Spanish text of the category; the provider's words
    // are only the optional `detail`, and still keep their start, hide the key and fit.
    assert.equal(event.category, 'server');
    assert.equal(errorText(event.category), 'El proveedor falló o no respondió bien. Prueba de nuevo más tarde.');
    assert.equal('message' in event, false);
    assert.ok(event.detail.startsWith('FIRST-WORD'), event.detail);
    assert.ok(!event.detail.includes(KEY));
    assert.ok(event.detail.length <= fits);
  }
});

test('an error outside the provider call is logged with its first characters, cut to 200', async () => {
  const context = await setUp();
  context.b.getTree = async () => {
    throw new Error(`Zeta ${'y'.repeat(500)}`);
  };
  const { event } = await context.save();
  assert.equal(event.kind, 'error');
  assert.equal(event.category, 'server');
  assert.match(errorText(event.category), /^El proveedor falló/);
  assert.ok(event.detail.startsWith('Zeta'));
  assert.ok(event.detail.length <= 200);
});

test('the spending cap stops at the call that would reach it, not after', async () => {
  const context = await setUp({ reply: existing('Cocina', 'low'), settings: { confirmBeforeMove: true } });
  const { node } = await context.save();
  assert.equal(context.calls.length, 1);
  const worst = worstCaseUsd(context.calls[0], { model: 'gemini-3.5-flash-lite', estimateTokens, prices: budgetPrices() });
  assert.ok(worst > 0 && worst < DAILY_USD_CAP);
  // Spent such that spent + worst is exactly the cap (nudged by an ulp if the sum rounds).
  let spent = DAILY_USD_CAP - worst;
  for (let i = 0; i < 8 && spent + worst !== DAILY_USD_CAP; i += 1) spent += spent + worst < DAILY_USD_CAP ? Number.EPSILON / 8 : -Number.EPSILON / 8;
  assert.equal(spent + worst, DAILY_USD_CAP, 'the test needs the exact boundary');
  const day = dayKey(new Date());
  await context.store.updateUsage(day, (usage) => ({ usage: { ...usage, spentUsd: spent }, result: null }));
  const at = await context.sorter.reclassify(node.id);
  assert.equal(context.calls.length, 2, 'reaching the cap exactly is allowed');
  assert.notEqual(/** @type {any} */ (at).reason, 'daily-budget');
  await context.store.updateUsage(day, (usage) => ({ usage: { ...usage, spentUsd: spent + 1e-6 }, result: null }));
  const over = await context.sorter.reclassify(node.id);
  assert.equal(context.calls.length, 2, 'one microdollar over: no call');
  assert.equal(/** @type {any} */ (over).reason, 'daily-budget');
});

test('the status is paused for budget as soon as the day has spent the whole cap', async () => {
  const context = await setUp();
  await context.store.updateUsage(dayKey(new Date()), (usage) => ({ usage: { ...usage, spentUsd: DAILY_USD_CAP }, result: null }));
  const status = await context.flow.getStatus();
  assert.equal(status.state, 'paused');
  assert.equal(/** @type {any} */ (status).reason, 'daily-budget');
});

test('the daily call cap typed or stored is an integer from 1 to 1000', () => {
  for (const [value, ok] of /** @type {[unknown, boolean][]} */ ([[1, true], [1000, true], [0, false], [1001, false], [-5, false], [2.5, false], ['20', false], [null, false]])) {
    const calls = normalizeSettings({ maxCallsPerDay: value }).maxCallsPerDay;
    assert.equal(calls === value, ok, String(value));
    if (!ok) assert.equal(calls, DEFAULT_SETTINGS.maxCallsPerDay);
  }
});

// --- Privacy and what the model's answer may do ------------------------------------------------

const folder = (/** @type {number} */ n, parentId = 'p', title = `F${n}`, name = title) => ({ id: `f${n}`, name, title, parentId, examples: [] });
const loose = (/** @type {number} */ n) => ({ id: `l${n}`, title: `L${n}`, url: `https://l${n}.example.com/` });
const answered = (/** @type {object} */ data, stopReason = 'end_turn') => ({ data, stopReason });

test('an index that is not a position in the folder list is an invalid answer', () => {
  const folders = [folder(0), folder(1)];
  for (const index of [-1, 2, 1.5, '1', null, undefined, Number.NaN]) {
    const read = readAutoSortAnswer(answered({ ...EMPTY, kind: 'existing', folder: index, confidence: 'high' }), { folders, loose: [], parentId: 'p' });
    assert.deepEqual(read, { kind: 'left', reason: 'invalid-answer' }, String(index));
  }
  assert.equal(readAutoSortAnswer(answered({ ...EMPTY, kind: 'existing', folder: 1, confidence: 'HIGH' }), { folders, loose: [], parentId: 'p' }).kind, 'existing');
});

test('"together" accepts only positions of the loose list, each once', () => {
  const read = readAutoSortAnswer(answered({ ...EMPTY, kind: 'new', name: 'IA', together: [0, 1, 1, 2, -1, 0.5, '0'] }), { folders: [], loose: [loose(0), loose(1)], parentId: 'p' });
  assert.equal(read.kind, 'new');
  assert.deepEqual(/** @type {any} */ (read).together.map((/** @type {any} */ item) => item.id), ['l0', 'l1']);
});

test('a new name that matches several folders resolves to the one in the bookmark’s own parent', () => {
  const folders = [folder(0, 'other', 'Dev', 'Other/Dev'), folder(1, 'mine', 'Dev', 'Dev')];
  const read = readAutoSortAnswer(answered({ ...EMPTY, kind: 'new', name: 'dev' }), { folders, loose: [], parentId: 'mine' });
  assert.equal(/** @type {any} */ (read).folder.id, 'f1');
  const other = readAutoSortAnswer(answered({ ...EMPTY, kind: 'new', name: 'dev' }), { folders, loose: [], parentId: 'other' });
  assert.equal(/** @type {any} */ (other).folder.id, 'f0');
});

test('the description the model writes is cleaned like a title: a mail or a token in it never reaches the page', () => {
  const read = readAutoSortAnswer(answered({ ...EMPTY, kind: 'new', name: 'IA', description: 'Escribe a ana.perez@correo.example con ak3j9x2m8q7w5z1pb4n6' }), { folders: [], loose: [], parentId: 'p' });
  const description = /** @type {any} */ (read).description;
  assert.ok(!description.includes('@') && !description.includes('ak3j9'), description);
  assert.ok(description.includes('[email]'));
});

test('a folder path of exactly 100 characters is offered, one of 101 is not, and it counts as left out', async () => {
  // 0.5.1: names are whole paths, at any depth, up to 100 characters (it was 60, two levels).
  const { bookmarks } = createFakeChrome();
  await bookmarks.create({ parentId: '1', title: 'a'.repeat(100) });
  await bookmarks.create({ parentId: '1', title: 'b'.repeat(101) });
  const { folders, truncated } = candidateFolders(await bookmarks.getTree(), false);
  assert.deepEqual(folders.map((item) => item.name), ['a'.repeat(100)]);
  assert.equal(truncated, 1);
});

test('loose bookmarks: an unknown parent has none, and among equal dates the later position is the more recent', () => {
  assert.deepEqual(looseSiblings([], 'nope', 'x'), []);
  const children = Array.from({ length: 31 }, (_, i) => ({ id: `n${i}`, title: `T${i}`, url: `https://t${i}.example.com/`, dateAdded: 1000, parentId: 'bar', index: i }));
  const tree = [{ id: '0', title: '', children: [{ id: 'bar', title: 'Bar', folderType: 'bookmarks-bar', children }] }];
  const ids = looseSiblings(/** @type {any} */ (tree), 'bar', 'none').map((item) => item.id);
  assert.equal(ids.length, 30);
  assert.ok(!ids.includes('n0'), 'the first of 31 equally old ones is the one that falls');
  assert.ok(ids.includes('n30'));
});

test('errors are told apart: a 400 is a key problem only when it says so', () => {
  assert.equal(errorCategory({ status: 400, apiMessage: 'API key not valid. Please pass a valid API key.' }), 'key');
  assert.equal(errorCategory({ status: 400, apiMessage: 'Unable to process input image' }), 'server');
  assert.equal(errorCategory({ status: 401 }), 'key');
  assert.equal(errorCategory({ status: 403 }), 'key');
  assert.equal(errorCategory({ status: 404 }), 'model');
  assert.equal(errorCategory({ status: 429 }), 'quota');
  assert.equal(errorCategory({ timedOut: true, status: 429 }), 'timeout');
});

// --- What the person keeps ---------------------------------------------------------------------

test('a move that Chrome refuses is logged as an error, not as a quiet "left", and the bookmark stays', async () => {
  const context = await setUp({
    reply: (request) => {
      const picked = existing('Viajes')(request);
      context.b.move = async () => {
        throw new Error('Chrome refused');
      };
      return picked;
    },
  });
  const { event } = await context.save();
  assert.equal(event.kind, 'error');
  assert.equal((await context.b.get(event.bookmarkId))[0].parentId, '4');
});

test('"Elegir carpeta" on a missing bookmark or folder reports it and does not throw', async () => {
  const context = await setUp();
  const { node } = await context.save({ parentId: '4' });
  assert.deepEqual((await context.sorter.moveTo('9999', context.folders.Viajes)).skipped.map((item) => item.reason), ['missing']);
  assert.deepEqual((await context.sorter.moveTo(node.id, '9999')).skipped.map((item) => item.reason), ['missing']);
});

test('only correcting a move the sort made counts as "corrected"', async () => {
  const context = await setUp();
  const { node: left } = await context.save({ url: 'https://other.example.com/a' });
  assert.equal(left.parentId, '4');
  await context.b.move(left.id, { parentId: '4' });
  context.setReply(existing('Programación', 'low'));
  context.fake.tabs.setActive('https://third.example.com/c');
  const proposedNode = await context.b.create({ parentId: '4', title: 'Third', url: 'https://third.example.com/c' });
  await context.sorter.handleCreated(proposedNode.id, proposedNode);
  await context.sorter.moveTo(proposedNode.id, context.folders.Viajes);
  assert.equal((await context.flow.weeklyMetrics()).corrected, 0, 'the last thing the sort did to it was propose, not move');

  context.setReply(existing('Cocina'));
  const { node: moved } = await context.save({ url: 'https://fourth.example.com/d' });
  assert.equal((await context.b.get(moved.id))[0].parentId, context.folders.Cocina);
  await context.sorter.moveTo(moved.id, context.folders.Viajes);
  assert.equal((await context.flow.weeklyMetrics()).corrected, 1);
});

test('removing a duplicate never removes a folder, a missing id or the only copy', async () => {
  const context = await setUp();
  assert.deepEqual(await context.sorter.removeDuplicate('9999'), { removed: false, reason: 'gone' });
  assert.deepEqual(await context.sorter.removeDuplicate(context.folders.Cocina), { removed: false, reason: 'gone' });
  assert.equal((await context.b.get(context.folders.Cocina)).length, 1);
  const only = await context.b.create({ parentId: '4', title: 'Solo', url: 'https://solo.example.com/' });
  assert.deepEqual(await context.sorter.removeDuplicate(only.id), { removed: false, reason: 'not-duplicate' });
  const twin = await context.b.create({ parentId: '4', title: 'Solo otra vez', url: 'https://solo.example.com/' });
  assert.deepEqual(await context.sorter.removeDuplicate(twin.id), { removed: true });
  assert.equal((await context.b.get(only.id)).length, 1);
});

test('a log event carries only the fields that mean something, and a blocking reason raises the error badge', async () => {
  const context = await setUp();
  const { event } = await context.save();
  assert.equal(event.kind, 'moved');
  for (const field of ['reason', 'message', 'newFolder', 'category', 'duplicateOf']) assert.ok(!(field in (await context.store.readLog())[0]), `${field} is not empty-filled`);
  assert.equal(await context.store.unseenErrors(), 0, 'a move is not an error');
  await context.store.deleteKey('gemini');
  const { event: blocked } = await context.save({ url: 'https://other.example.com/b' });
  assert.equal(blocked.reason, 'no-key');
  assert.equal(blocked.category, 'no-key');
  assert.equal(await context.store.unseenErrors(), 1, 'the person must see that the sort stopped');
});

// --- Proposals ---------------------------------------------------------------------------------

/** A stored-shape proposal for a bookmark that exists. */
const proposal = (/** @type {Record<string, any>} */ over) => ({
  id: `proposal:${over.bookmark.id}`,
  createdAt: '2026-11-05T10:00:00.000Z',
  kind: 'create',
  confidence: 'high',
  newFolder: { parentId: '4', parentTitle: 'Bar', name: 'IA', description: '' },
  together: [],
  ...over,
});
const member = (/** @type {string} */ id, parentId = '4', index = 0) => ({ id, title: `T${id}`, host: 'x.example.com', parentId, index });

test('proposals keep each member’s index; creates merge only within one parent; a bookmark leaves other proposals when it gets its own', async () => {
  const fake = createFakeChrome({ account: true });
  const created = [];
  for (let i = 0; i < 4; i += 1) created.push(await fake.bookmarks.create({ parentId: '4', title: `B${i}`, url: `https://b${i}.example.com/` }));
  const proposals = createProposals({ storage: fake.storage.local, bookmarks: fake.bookmarks });
  const [a, b, c, d] = created.map((node) => node.id);
  await proposals.add(proposal({ bookmark: member(a, '4', 3), together: [member(b, '4', 5)] }));
  assert.deepEqual((await proposals.read())[0].bookmark.index, 3);
  assert.deepEqual((await proposals.read())[0].together[0].index, 5);

  // Same name under another parent does not merge.
  const other = await proposals.add(proposal({ bookmark: member(c, '5'), newFolder: { parentId: '5', parentTitle: 'Other', name: 'ia', description: '' } }));
  assert.equal(other.merged, false);
  assert.equal((await proposals.read()).length, 2);

});

test('a proposal that leaves another one’s "together" keeps the members that stay', async () => {
  const fake = createFakeChrome({ account: true });
  const nodes = [];
  for (let i = 0; i < 4; i += 1) nodes.push((await fake.bookmarks.create({ parentId: '4', title: `B${i}`, url: `https://b${i}.example.com/` })).id);
  const proposals = createProposals({ storage: fake.storage.local, bookmarks: fake.bookmarks });
  await proposals.add(proposal({ bookmark: member(nodes[0]), together: [member(nodes[1]), member(nodes[2])] }));
  await proposals.add({ ...proposal({ bookmark: member(nodes[1]), kind: 'move' }), folder: { id: '6', name: 'Otra' }, newFolder: undefined });
  const first = (await proposals.read()).find((item) => item.bookmark.id === nodes[0]);
  assert.deepEqual(first?.together.map((item) => item.id), [nodes[2]]);
});

test('a proposal expires after exactly 14 days, not one millisecond before', async () => {
  const fake = createFakeChrome({ account: true });
  const node = await fake.bookmarks.create({ parentId: '4', title: 'B', url: 'https://b.example.com/' });
  const createdAt = '2026-11-05T10:00:00.000Z';
  let now = new Date(Date.parse(createdAt) + PROPOSAL_TTL_MS - 1);
  const proposals = createProposals({ storage: fake.storage.local, bookmarks: fake.bookmarks, now: () => now });
  await proposals.add(proposal({ bookmark: member(node.id), createdAt }));
  assert.equal((await proposals.expire()).length, 0);
  now = new Date(Date.parse(createdAt) + PROPOSAL_TTL_MS);
  assert.equal((await proposals.expire()).length, 1);
  assert.equal((await proposals.read()).length, 0);
});

test('confirming with an empty name or one that holds a mail or a token creates nothing', async () => {
  const context = await setUp({ settings: { confirmBeforeMove: true }, reply: proposeNew('IA') });
  const { node } = await context.save();
  const [pending] = await context.flow.proposals.list();
  const before = (await context.b.getChildren('4')).length;
  for (const name of ['', '   ', 'Cuentas ana.perez@correo.example', 'Sesion ak3j9x2m8q7w5z1pb4n6']) {
    const done = /** @type {any} */ (await context.flow.proposals.apply(pending.id, { name }));
    assert.ok(done.error, `"${name}" must be refused`);
    assert.equal(done.moved, 0);
  }
  assert.equal((await context.b.getChildren('4')).length, before, 'no folder was created');
  assert.equal((await context.b.get(node.id))[0].parentId, '4');
  assert.equal((await context.flow.proposals.list()).length, 1, 'the proposal waits');
});

test('a confirmed proposal reports itself as applied, not stale', async () => {
  const context = await setUp({ settings: { confirmBeforeMove: true } });
  await context.save();
  const [pending] = await context.flow.proposals.list();
  const done = await context.flow.proposals.apply(pending.id);
  assert.equal(done.stale, false);
  assert.equal(done.moved, 1);
});

// --- The facade --------------------------------------------------------------------------------

test('activity messages say what happened; "Elegir carpeta" is offered only for a bookmark that still exists and did not expire', async () => {
  const context = await setUp();
  const { node, event } = await context.save();
  assert.equal(event.kind, 'moved');
  const reclassified = /** @type {any} */ (await context.flow.reclassify(node.id));
  assert.equal(typeof reclassified.messageEs, 'string');
  assert.deepEqual(reclassified.actions, []);
  assert.equal((/** @type {any} */ (await context.flow.reclassify(context.folders.Cocina))).kind, 'ignored');

  const moved = (await context.flow.listActivity(10)).find((entry) => entry.kind === 'moved');
  assert.match(moved?.messageEs ?? '', /^Movido a «Cocina»\.$/);
  assert.ok(moved?.actions.includes('choose-folder') && moved.actions.includes('undo'));

  await context.b.remove(node.id);
  const gone = (await context.flow.listActivity(10)).find((entry) => entry.kind === 'moved');
  assert.ok(!gone?.actions.includes('choose-folder'), 'the bookmark no longer exists');
});

test('a proposal’s text says whether it would create a folder or move to one', async () => {
  const context = await setUp({ settings: { confirmBeforeMove: true }, reply: proposeNew('IA') });
  await context.save();
  context.setReply(existing('Viajes', 'low'));
  await context.save({ url: 'https://viajes.example.com/x' });
  const texts = (await context.flow.listActivity(10)).filter((entry) => entry.kind === 'proposed').map((entry) => entry.messageEs);
  assert.ok(texts.some((text) => /^Propone crear «IA»\./.test(text ?? '')), String(texts));
  assert.ok(texts.some((text) => /^Propone mover a «Viajes»/.test(text ?? '')), String(texts));
});

test('a proposal expires 14 days after it was made, and the window says when', async () => {
  const context = await setUp({ settings: { confirmBeforeMove: true } });
  await context.save();
  const [pending] = await context.flow.proposals.list();
  assert.equal(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt), PROPOSAL_TTL_MS);
});

test('undoing a change that restores nothing, or discarding a proposal that is not there, is not counted', async () => {
  const context = await setUp({ settings: { confirmBeforeMove: false } });
  const { node, event } = await context.save();
  await context.b.remove(node.id);
  const undone = await context.flow.undo(event.changeId);
  assert.equal(undone.restored.length, 0);
  await context.flow.proposals.discard('proposal:ghost');
  const metrics = await context.flow.weeklyMetrics();
  assert.equal(metrics.undone, 0);
  assert.equal(metrics.discarded, 0);
});

test('saving settings with the sort on keeps the optional permissions; turning it off gives them back', async () => {
  const context = await setUp();
  const on = { ...(await context.flow.settings.get()), enabled: true };
  await context.flow.settings.save(on);
  assert.ok(context.fake.permissions.granted.has('tabs') && context.fake.permissions.granted.has(GEMINI_HOST));
  await context.flow.settings.save({ ...on, enabled: false });
  assert.ok(!context.fake.permissions.granted.has('tabs') && !context.fake.permissions.granted.has(GEMINI_HOST));
});

// --- ui/present.js boundaries ------------------------------------------------------------------

test('presentation boundaries: money under and at one dollar, backup staleness, call cap and usage line', () => {
  assert.match(formatMoney(0.5), /^US\$0[.,]5000$/);
  assert.match(formatMoney(1), /^US\$1[.,]00$/);
  const now = new Date(2026, 10, 20, 12);
  assert.equal(backupReminder(new Date(2026, 10, 7, 12).toISOString(), now).stale, false, '13 days');
  assert.equal(backupReminder(new Date(2026, 10, 6, 12).toISOString(), now).stale, true, '14 days');
  for (const [typed, ok] of /** @type {[string, boolean][]} */ ([['1', true], ['1000', true], ['0', false], ['1001', false], ['', false], ['2.5', false]])) assert.equal(parseMaxCalls(typed).ok, ok, typed);
  assert.doesNotMatch(usageLine({ calls: 1, max: 50, spentUsd: 0.01 }, false), /US\$/);
  assert.doesNotMatch(usageLine({ calls: 1, max: 50, capUsd: 0.1 }, false), /US\$/);
  assert.match(usageLine({ calls: 1, max: 50, spentUsd: 0.01, capUsd: 0.1 }, false), /US\$0[.,]0100 de US\$0[.,]1000/);
});
