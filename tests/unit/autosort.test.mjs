import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAutoSorter } from '../../extension/platform/autosort.js';
import { CONSENT_VERSION, DEFAULT_SETTINGS, dayKey } from '../../extension/core/autosort.js';
import { undoChange } from '../../extension/platform/bookmarks.js';
import { createComplete as createProviderComplete } from '../../extension/platform/complete-factory.js';
import { MAX_PROPOSALS, createProposals } from '../../extension/platform/proposals.js';
import { RetryLaterError } from '../../extension/platform/llm.js';
import { ProviderRequestError } from '../../extension/platform/openai-compatible.js';
import { getProvider } from '../../extension/platform/providers.js';
import { createSettingsStore } from '../../extension/platform/settings.js';
import { createStore } from '../../extension/platform/store.js';
import { createFakeChrome, normalForm } from '../helpers/fake-chrome.mjs';
import { startFakeOpenAi } from '../helpers/fake-openai.mjs';

const KEY = 'test-key-not-real-1234567890';
const GEMINI_HOST = 'https://generativelanguage.googleapis.com/*';
const PAGE = 'https://cooking.example.com/recipes/bread?utm_source=x&session=abc123';

/** @typedef {import('../../extension/core/types.js').CompletionRequest} CompletionRequest */

/** The folder number the request gives `name`, as the model would read it. */
function folderNumber(/** @type {CompletionRequest} */ request, /** @type {string} */ name) {
  const folders = JSON.parse(/** @type {string[]} */ (/<folders>\n(.*)\n<\/folders>/s.exec(request.user))[1]);
  return folders.find((/** @type {{name: string}} */ folder) => folder.name === name).f;
}

/** A provider result carrying `data`, as the adapter returns it. */
const result = (/** @type {unknown} */ data) => ({
  data,
  stopReason: 'end_turn',
  refusalCategory: null,
  servedModel: 'gemini-3.5-flash-lite',
  requestId: null,
  latencyMs: 5,
  usage: { attempts: [{ model: 'gemini-3.5-flash-lite', inputTokens: 300, outputTokens: 20, thinkingTokens: 0, kind: 'message' }], inputTokens: 300, outputTokens: 20, thinkingTokens: 0, usedFallback: false },
});
const EMPTY = { folder: -1, confidence: 'low', name: '', description: '', together: [] };

/**
 * The model files the bookmark in existing folder `name` with `confidence`, or answers none.
 *
 * @param {string | null} name
 * @param {'high' | 'low'} [confidence]
 */
const answer = (name, confidence = 'high') => (/** @type {CompletionRequest} */ request) =>
  result(name === null ? { ...EMPTY, kind: 'none' } : { ...EMPTY, kind: 'existing', folder: folderNumber(request, name), confidence });

/**
 * The model proposes a new folder `name`, with the loose bookmarks titled `titles`.
 *
 * @param {string} name
 * @param {string[]} [titles]
 */
const propose = (name, titles = []) => (/** @type {CompletionRequest} */ request) => {
  const loose = JSON.parse(/** @type {string[]} */ (/<loose_bookmarks>\n(.*)\n<\/loose_bookmarks>/s.exec(request.user))[1]);
  const together = loose.filter((/** @type {{title: string}} */ item) => titles.includes(item.title)).map((/** @type {{j: number}} */ item) => item.j);
  return result({ ...EMPTY, kind: 'new', confidence: 'high', name, description: `Todo sobre ${name}.`, together });
};

/**
 * The owner's shape: account roots, folders in the account bar, one local folder that must never
 * be offered. Auto-sort on, Gemini with key, consent and permissions, unless overridden.
 *
 * @param {{
 *   reply?: (request: CompletionRequest) => any,
 *   settings?: object,
 *   key?: string | null,
 *   grant?: string[],
 *   wait?: (ms: number) => Promise<void>,
 *   createComplete?: any,
 *   now?: () => Date,
 *   deadlineMs?: number,
 *   loose?: {title: string, url: string}[],
 * }} [options]
 *   `loose`: bookmarks left unfiled in the account bar, where Ctrl+D saves.
 */
async function setUp({ reply = answer('Cocina'), settings = {}, key = KEY, grant = ['tabs', GEMINI_HOST], wait, createComplete, now, deadlineMs = 500, loose = [] } = {}) {
  const fake = createFakeChrome({ account: true });
  const b = fake.bookmarks;
  /** @type {Record<string, string>} */
  const folders = {};
  for (const name of ['Cocina', 'Programación', 'Viajes']) folders[name] = (await b.create({ parentId: '4', title: name })).id;
  folders.Local = (await b.create({ parentId: '1', title: 'Solo local' })).id;
  /** @type {Record<string, string>} */
  const looseIds = {};
  for (const item of loose) looseIds[item.title] = (await b.create({ parentId: '4', ...item })).id;
  const settingsStore = createSettingsStore(fake.storage.local);
  await settingsStore.saveSettings({
    ...DEFAULT_SETTINGS,
    enabled: true,
    // Automatic mode: what M2 tested. «Confirmar antes de mover», the default, has its own tests.
    confirmBeforeMove: false,
    ref: 'gemini/gemini-3.5-flash-lite',
    maxCallsPerDay: 50,
    consent: { provider: 'gemini', readOn: getProvider('gemini').dataPolicy.readOn, version: CONSENT_VERSION, at: '2026-11-05T10:00:00.000Z' },
    ...settings,
  });
  if (key) await settingsStore.saveKey('gemini', key);
  for (const name of grant) fake.permissions.granted.add(name);

  /** @type {CompletionRequest[]} */
  const calls = [];
  /** @type {any[]} */
  const adapterOptions = [];
  const sorter = createAutoSorter({
    bookmarks: b,
    tabs: fake.tabs,
    permissions: fake.permissions,
    storage: fake.storage.local,
    action: fake.action,
    createComplete:
      createComplete ??
      ((/** @type {any} */ options) => {
        adapterOptions.push(options);
        return async (/** @type {CompletionRequest} */ request) => {
          calls.push(request);
          return reply(request);
        };
      }),
    wait: wait ?? (async () => {}),
    schedule: () => {},
    now,
    deadlineMs,
  });

  /**
   * Ctrl+D on the active tab: the page is the active tab, and the bookmark lands in `parentId`.
   *
   * @param {{url?: string, title?: string, parentId?: string, activeUrl?: string | null}} [page]
   */
  const save = async ({ url = PAGE, title = 'Pan de masa madre', parentId = '4', activeUrl = url } = {}) => {
    fake.tabs.setActive(activeUrl);
    const node = await b.create({ parentId, title, url });
    return { node, event: await sorter.handleCreated(node.id, node) };
  };
  const parentOf = async (/** @type {string} */ id) => (await b.get(id))[0].parentId;
  const proposals = createProposals({ storage: fake.storage.local, bookmarks: b, action: fake.action });
  return { fake, b, folders, looseIds, settingsStore, sorter, calls, adapterOptions, save, parentOf, proposals };
}

test('a bookmark of the active tab goes to the folder the model picks; the log and the badge say so', async () => {
  const { save, parentOf, folders, calls, adapterOptions, settingsStore, fake } = await setUp();
  const { node, event } = await save();
  assert.equal(event.kind, 'moved');
  assert.equal(await parentOf(node.id), folders.Cocina);
  assert.equal(calls.length, 1);
  // What leaves: the reduced URL and the account folders, never the query or the local folder.
  assert.match(calls[0].user, /cooking\.example\.com\/recipes\/bread/);
  assert.doesNotMatch(calls[0].user, /utm_source|session|abc123|Solo local/);
  assert.deepEqual(adapterOptions[0], { ref: 'gemini/gemini-3.5-flash-lite', apiKey: KEY, timeoutMs: adapterOptions[0].timeoutMs, effort: 'low' });
  assert.ok(adapterOptions[0].timeoutMs <= 500);

  const [logged] = await settingsStore.readLog();
  const { kind, title, host, folder, bookmarkId } = logged;
  assert.deepEqual({ kind, title, host, folder, bookmarkId }, { kind: 'moved', title: 'Pan de masa madre', host: 'cooking.example.com', folder: 'Cocina', bookmarkId: node.id });
  assert.ok(logged.changeId, 'the event points to its change, for «Deshacer»');
  assert.doesNotMatch(JSON.stringify(await settingsStore.readLog()), /recipes|utm_source/);
  assert.deepEqual(fake.action.badges, ['✓']);
  const usage = await settingsStore.readUsage(dayKey(new Date(logged.at)));
  assert.equal(usage.calls, 1);
  assert.ok(usage.spentUsd > 0, 'charged at the paid rate');
});

test('undo puts the bookmark back where Ctrl+D left it', async () => {
  const { save, parentOf, b, fake } = await setUp();
  await b.create({ parentId: '4', title: 'before', url: 'https://before.test/' });
  const { node } = await save();
  const change = /** @type {any} */ (await createStore(fake.storage.local).lastChange());
  assert.deepEqual(change.moves.map((/** @type {any} */ move) => move.id), [node.id]);
  await undoChange(change.id, { bookmarks: b, store: createStore(fake.storage.local) });
  assert.equal(await parentOf(node.id), '4');
  assert.equal((await b.get(node.id))[0].index, node.index);
});

test('a bookmark that is not the active tab is left alone: sync, imports, other extensions', async () => {
  const { save, parentOf, calls, settingsStore } = await setUp();
  const { node, event } = await save({ activeUrl: 'https://another-page.example.com/' });
  assert.deepEqual(event, { kind: 'ignored', reason: 'not-active-tab' });
  const none = await save({ url: 'https://phone-news.com/', activeUrl: null });
  assert.deepEqual(none.event, { kind: 'ignored', reason: 'not-active-tab' });
  assert.equal(await parentOf(node.id), '4');
  assert.equal(calls.length, 0);
  assert.deepEqual(await settingsStore.readLog(), [], 'arrivals by sync do not flood the log');
});

test('nothing happens to bookmarks created during an import, even the active tab’s', async () => {
  const { fake, sorter, calls } = await setUp();
  await new Promise((resolve) => setTimeout(resolve, 0)); // the set-up's own creations
  /** @type {Promise<any>[]} */
  const handled = [];
  fake.bookmarks.onCreated.addListener((id, node) => handled.push(sorter.handleCreated(id, node)));
  fake.bookmarks.onImportBegan.addListener(() => sorter.importBegan());
  fake.bookmarks.onImportEnded.addListener(() => sorter.importEnded());
  fake.tabs.setActive(PAGE);
  await fake.importBookmarks([{ parentId: '4', title: 'Pan', url: PAGE }, { parentId: '4', title: 'Otro', url: 'https://other.example.com/' }]);
  assert.deepEqual(
    (await Promise.all(handled)).map((event) => event.reason),
    ['import', 'import'],
  );
  assert.equal(calls.length, 0);
});

test('a folder created with Ctrl+D or the manager is not sorted', async () => {
  const { b, sorter, calls } = await setUp();
  const folder = await b.create({ parentId: '4', title: 'Nueva' });
  assert.deepEqual(await sorter.handleCreated(folder.id, folder), { kind: 'ignored', reason: 'folder' });
  assert.equal(calls.length, 0);
});

test('the person picks a folder during the wait: their choice stands, and nothing is sent', async () => {
  /** @type {() => Promise<void>} */
  let personMoves = async () => {};
  const context = await setUp({ wait: async (ms) => (assert.equal(ms, 8000), personMoves()) });
  personMoves = async () => {
    const [created] = await context.b.getChildren('4').then((children) => children.filter((child) => child.url === PAGE));
    await context.b.move(created.id, { parentId: context.folders.Viajes });
  };
  const { node, event } = await context.save();
  assert.equal(event.kind, 'left');
  assert.equal(/** @type {any} */ (event).reason, 'chosen-by-person');
  assert.equal(await context.parentOf(node.id), context.folders.Viajes);
  assert.equal(context.calls.length, 0);
});

test('the person moves it while the model answers: the move is skipped and their folder stays', async () => {
  /** @type {any} */
  let context;
  context = await setUp();
  const realGet = context.b.get;
  let movedByPerson = false;
  context.b.get = async (/** @type {string} */ id) => {
    // Right before the apply reads the node, the person files it elsewhere.
    if (context.calls.length === 1 && !movedByPerson) {
      movedByPerson = true;
      await context.b.move(id, { parentId: context.folders.Programación });
    }
    return realGet(id);
  };
  const { node, event } = await context.save();
  assert.equal(event.reason, 'chosen-by-person');
  assert.equal(await context.parentOf(node.id), context.folders.Programación);
});

test('the person deletes it during the wait: nothing is sent', async () => {
  /** @type {any} */
  let context;
  context = await setUp({
    wait: async () => {
      const [created] = (await context.b.getChildren('4')).filter((/** @type {any} */ child) => child.url === PAGE);
      await context.b.remove(created.id);
    },
  });
  const { event } = await context.save();
  assert.equal(event.reason, 'gone');
  assert.equal(context.calls.length, 0);
});

for (const [name, reply, kind, reason] of /** @type {[string, (request: CompletionRequest) => any, string, string][]} */ ([
  ['no clear topic', answer(null), 'left', 'no-topic'],
  ['an invalid answer', () => result({ ...EMPTY, kind: 'existing', folder: 99, confidence: 'high' }), 'left', 'invalid-answer'],
  ['a refusal', (request) => ({ ...answer('Cocina')(request), data: null, stopReason: 'refusal' }), 'left', 'refused'],
  [
    'an API error',
    () => {
      throw new ProviderRequestError('Google Gemini rejected the request (status 400)', { status: 400, requestId: null, apiMessage: null });
    },
    'error',
    'error',
  ],
]))
  test(`${name}: the bookmark stays where it is and the reason is logged`, async () => {
    const { save, parentOf, calls, settingsStore } = await setUp({ reply });
    const { node, event } = await save();
    assert.equal(event.kind, kind);
    assert.equal(/** @type {any} */ (event).reason, reason);
    assert.equal(await parentOf(node.id), '4');
    assert.equal(calls.length, 1);
    assert.equal((await settingsStore.readLog())[0].reason, reason);
  });

test('no answer within the deadline: the bookmark stays, the timeout is logged and charged at worst case', async () => {
  const { save, parentOf, calls, settingsStore } = await setUp({ reply: () => new Promise(() => {}), deadlineMs: 60 });
  const { node, event } = await save();
  assert.equal(event.kind, 'error');
  assert.equal(/** @type {any} */ (event).reason, 'timeout');
  assert.equal(await parentOf(node.id), '4');
  assert.equal(calls.length, 1);
  const usage = await settingsStore.readUsage(dayKey(new Date(/** @type {any} */ (event).at)));
  assert.ok(usage.lostUsd > 0 && usage.lostUsd === usage.spentUsd);
});

test('a provider that asks to retry later gets one more call within the deadline', async () => {
  let first = true;
  const { save, parentOf, folders, calls, settingsStore } = await setUp({
    deadlineMs: 20_000,
    reply: (request) => {
      if (first) {
        first = false;
        throw new RetryLaterError('Server error 503', 0, { status: 503 });
      }
      return answer('Viajes')(request);
    },
  });
  const { node, event } = await save();
  assert.equal(event.kind, 'moved');
  assert.equal(await parentOf(node.id), folders.Viajes);
  assert.equal(calls.length, 2);
  // 0.4.1: the 503 could not have been billed, so only the call that answered counts.
  assert.equal((await settingsStore.readUsage(dayKey(new Date(/** @type {any} */ (event).at)))).calls, 1);
});

for (const url of ['http://192.168.1.20/router', 'http://localhost:3000/admin', 'https://nas.local/files', 'file:///home/usuario/notas.html']) {
  test(`a private or non-web address is never sent: ${url}`, async () => {
    const { save, parentOf, calls } = await setUp();
    const { node, event } = await save({ url });
    assert.equal(event.kind, 'left');
    assert.match(/** @type {any} */ (event).reason, /^(private-host|unsupported-scheme)$/);
    assert.equal(await parentOf(node.id), '4');
    assert.equal(calls.length, 0);
  });
}

for (const [name, options, reason] of /** @type {[string, any, string][]} */ ([
  ['no consent', { settings: { consent: null } }, 'no-consent'],
  ['consent to an older reading of the policy', { settings: { consent: { provider: 'gemini', readOn: '2026-01-01', at: '2026-01-01T00:00:00Z' } } }, 'no-consent'],
  ['no key', { key: null }, 'no-key'],
  ['no tabs permission', { grant: [GEMINI_HOST] }, 'no-permission'],
  ['no host permission', { grant: ['tabs'] }, 'no-permission'],
  ['an Anthropic model', { settings: { ref: 'anthropic/claude-haiku-5-5' }, grant: ['tabs', 'https://api.anthropic.com/*'] }, 'provider-pending'],
]))
  test(`${name}: nothing is sent`, async () => {
    const { save, calls, adapterOptions } = await setUp(options);
    const { event } = await save();
    assert.equal(/** @type {any} */ (event).reason, reason);
    assert.equal(calls.length + adapterOptions.length, 0);
  });

test('off by default: with no settings saved, nothing is sent', async () => {
  const fake = createFakeChrome({ account: true });
  let built = 0;
  const sorter = createAutoSorter({ ...fake, storage: fake.storage.local, createComplete: () => ((built += 1), async () => answer(null)(/** @type {any} */ ({}))) });
  fake.tabs.setActive(PAGE);
  const node = await fake.bookmarks.create({ parentId: '4', title: 'x', url: PAGE });
  assert.deepEqual(await sorter.handleCreated(node.id, node), { kind: 'ignored', reason: 'disabled' });
  assert.equal(built, 0);
});

test('the daily cap: call 51 does not happen, and the next day it resumes', async () => {
  let day = new Date(2026, 10, 5, 10);
  const { save, calls, settingsStore } = await setUp({ now: () => day });
  for (let i = 0; i < 50; i += 1) assert.equal((await save({ url: `https://cooking.example.com/${i}` })).event.kind, 'moved');
  const { event } = await save({ url: 'https://cooking.example.com/51' });
  assert.equal(/** @type {any} */ (event).reason, 'daily-calls');
  assert.equal(calls.length, 50);
  assert.equal((await settingsStore.readUsage('2026-11-05')).calls, 50);
  day = new Date(2026, 10, 6, 0, 1);
  assert.equal((await save({ url: 'https://cooking.example.com/52' })).event.kind, 'moved');
  assert.equal(calls.length, 51);
});

test('the daily spending cap stops before the call that could cross it', async () => {
  const { save, calls, settingsStore } = await setUp({ now: () => new Date(2026, 10, 5, 10) });
  await settingsStore.updateUsage('2026-11-05', () => ({ usage: { day: '2026-11-05', calls: 3, spentUsd: 0.099, lostUsd: 0 }, result: null }));
  const { event } = await save();
  assert.equal(/** @type {any} */ (event).reason, 'daily-budget');
  assert.equal(calls.length, 0);
});

test('D2: a bookmark saved inside a folder stays there, without a call', async () => {
  const { save, parentOf, folders, calls, fake } = await setUp({ reply: answer('Viajes') });
  const { node, event } = await save({ parentId: folders.Cocina });
  assert.equal(/** @type {any} */ (event).reason, 'saved-in-folder');
  assert.equal(await parentOf(node.id), folders.Cocina);
  assert.equal(calls.length, 0);
  assert.equal(await createStore(fake.storage.local).lastChange(), null);
});

test('D2: a Ctrl+Shift+D group is not taken apart', async () => {
  const { b, sorter, calls, fake } = await setUp();
  const group = await b.create({ parentId: '4', title: 'Pestañas' });
  fake.tabs.setActive(PAGE);
  const member = await b.create({ parentId: group.id, title: 'Pan', url: PAGE });
  assert.deepEqual([(await sorter.handleCreated(group.id, group)).reason, (await sorter.handleCreated(member.id, member)).reason], ['folder', 'saved-in-folder']);
  assert.equal(calls.length, 0);
});

test('reclassify of a bookmark already in the folder the model picks moves nothing', async () => {
  const { b, sorter, folders, fake, parentOf } = await setUp({ reply: answer('Cocina') });
  const node = await b.create({ parentId: folders.Cocina, title: 'Pan', url: PAGE });
  const event = await sorter.reclassify(node.id);
  assert.equal(/** @type {any} */ (event).reason, 'already-there');
  assert.equal(await parentOf(node.id), folders.Cocina);
  assert.equal(await createStore(fake.storage.local).lastChange(), null);
});

test('through the real Gemini adapter against a local stand-in, the bookmark is moved', async (t) => {
  const server = await startFakeOpenAi({ dialect: 'gemini', servedModel: 'gemini-3.5-flash-lite' });
  t.after(() => server.close());
  const { save, parentOf, folders } = await setUp({
    deadlineMs: 20_000,
    createComplete: (/** @type {any} */ options) => createProviderComplete({ ...options, baseURL: server.baseURL }),
  });
  const { node, event } = await save();
  assert.equal(event.kind, 'moved');
  // The stand-in answers folder 0, the first candidate.
  assert.equal(await parentOf(node.id), folders.Cocina);
  const [sent] = server.requests;
  assert.equal(sent.url, '/chat/completions');
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent.body.model, 'gemini-3.5-flash-lite');
  assert.equal(sent.body.reasoning_effort, 'low');
  assert.doesNotMatch(JSON.stringify(sent.body), /utm_source|session=/);
});

// --- M2.1: proposals instead of forcing or giving up ---

const AI_LOOSE = [
  { title: 'Claude', url: 'https://claude.ai/new' },
  { title: 'ChatGPT', url: 'https://chatgpt.com/' },
  { title: 'NotebookLM', url: 'https://notebooklm.google.com/' },
  { title: 'Banco', url: 'https://www.bank.example.com/login' },
  { title: 'Router', url: 'http://192.168.1.1/' },
];
const RANKING = { url: 'https://sevenlab.ai/es/llm-ranking', title: 'Clasificación IA 2026: mejores LLM clasificados a diario' };

test('a new topic becomes a proposal: nothing is created or moved until the person confirms', async () => {
  const context = await setUp({ loose: AI_LOOSE, reply: propose('IA', ['Claude', 'ChatGPT', 'NotebookLM']) });
  const before = normalForm(await context.b.getTree());
  const { node, event } = await context.save(RANKING);
  assert.deepEqual({ kind: event.kind, folder: /** @type {any} */ (event).folder, newFolder: /** @type {any} */ (event).newFolder }, { kind: 'proposed', folder: 'IA', newFolder: true });
  const after = normalForm(await context.b.getTree());
  assert.deepEqual(after.filter((entry) => entry.id !== node.id), before, 'no folder created, nothing moved');
  const [proposal] = await context.proposals.read();
  assert.equal(proposal.kind, 'create');
  assert.deepEqual(proposal.newFolder, { parentId: '4', parentTitle: 'Bookmarks bar', name: 'IA', description: 'Todo sobre IA.' });
  assert.deepEqual(proposal.together.map((member) => member.title), ['Claude', 'ChatGPT', 'NotebookLM']);
  assert.equal(context.fake.action.badges.at(-1), '1');
});

test('confirming creates the folder in the same parent and moves the ticked ones; undo reverts it all and removes the folder', async () => {
  const context = await setUp({ loose: AI_LOOSE, reply: propose('IA', ['Claude', 'ChatGPT', 'NotebookLM']) });
  const { node } = await context.save(RANKING);
  const before = normalForm(await context.b.getTree());
  const [proposal] = await context.proposals.read();
  const applied = await context.proposals.apply(proposal.id, { memberIds: [context.looseIds.Claude, context.looseIds.ChatGPT] });

  const [folder] = (await context.b.getChildren('4')).filter((child) => child.title === 'IA' && child.url === undefined);
  assert.ok(folder, 'created in the account bar');
  assert.deepEqual((await context.b.getChildren(folder.id)).map((child) => child.title), [RANKING.title, 'Claude', 'ChatGPT']);
  assert.equal(await context.parentOf(context.looseIds.NotebookLM), '4', 'unticked stays');
  assert.deepEqual(await context.proposals.read(), []);
  assert.equal(context.fake.action.badges.at(-1), '');

  assert.equal(applied.createdFolder, folder.id);
  const undo = await undoChange(/** @type {string} */ (applied.changeId), { bookmarks: context.b, store: createStore(context.fake.storage.local) });
  assert.deepEqual(undo.removedFolders, [folder.id]);
  assert.deepEqual(normalForm(await context.b.getTree()), before);
  assert.equal(await context.parentOf(node.id), '4');
});

test('undo keeps a created folder the person added something to, and says so', async () => {
  const context = await setUp({ loose: AI_LOOSE, reply: propose('IA', ['Claude']) });
  await context.save(RANKING);
  const [proposal] = await context.proposals.read();
  const applied = await context.proposals.apply(proposal.id);
  const folderId = /** @type {string} */ (applied.createdFolder);
  await context.b.create({ parentId: folderId, title: 'Mine', url: 'https://mine.example.com/' });
  const undo = await undoChange(/** @type {string} */ (applied.changeId), { bookmarks: context.b, store: createStore(context.fake.storage.local) });
  assert.deepEqual(undo.keptFolders, [{ id: folderId, items: 1 }]);
  assert.deepEqual(undo.removedFolders, []);
  assert.equal(await context.parentOf(context.looseIds.Claude), '4');
});

test('"Mover solo este" creates the folder with only the saved bookmark', async () => {
  const context = await setUp({ loose: AI_LOOSE, reply: propose('IA', ['Claude', 'ChatGPT']) });
  const { node } = await context.save(RANKING);
  const [proposal] = await context.proposals.read();
  const applied = await context.proposals.apply(proposal.id, { memberIds: [] });
  const change = await createStore(context.fake.storage.local).getChange(/** @type {string} */ (applied.changeId));
  assert.deepEqual(change?.moves.map((move) => move.id), [node.id]);
  assert.equal(await context.parentOf(context.looseIds.Claude), '4');
});

test('existing folder with low confidence: nothing moves until the person confirms', async () => {
  const context = await setUp({ reply: answer('Programación', 'low') });
  const { node, event } = await context.save(RANKING);
  assert.equal(event.kind, 'proposed');
  assert.equal(await context.parentOf(node.id), '4');
  assert.equal(await createStore(context.fake.storage.local).lastChange(), null);
  const [proposal] = await context.proposals.read();
  assert.deepEqual({ kind: proposal.kind, folder: proposal.folder }, { kind: 'move', folder: { id: context.folders.Programación, name: 'Programación' } });
  await context.proposals.apply(proposal.id);
  assert.equal(await context.parentOf(node.id), context.folders.Programación);
});

test('a proposed new name equal to an existing folder, ignoring case and accents, is treated as that folder', async () => {
  const context = await setUp({ loose: AI_LOOSE, reply: propose('programacion', ['Claude']) });
  const { node } = await context.save(RANKING);
  const [proposal] = await context.proposals.read();
  assert.equal(proposal.kind, 'move');
  assert.equal(proposal.folder?.id, context.folders.Programación);
  await context.proposals.apply(proposal.id);
  assert.equal(await context.parentOf(node.id), context.folders.Programación);
  assert.deepEqual(
    (await context.b.getChildren('4')).filter((child) => /programaci/i.test(child.title) && child.url === undefined).map((child) => child.id),
    [context.folders.Programación],
    'no duplicate folder in the bar',
  );
});

test('the person moves or deletes the bookmark before confirming: the proposal is dropped and nothing runs', async () => {
  const context = await setUp({ loose: AI_LOOSE, reply: propose('IA', ['Claude']) });
  const { node } = await context.save(RANKING);
  const [proposal] = await context.proposals.read();
  await context.b.move(node.id, { parentId: context.folders.Viajes });
  assert.equal((await context.proposals.prune()).length, 1);
  assert.deepEqual(await context.proposals.read(), []);
  assert.equal(context.fake.action.badges.at(-1), '');
  const applied = await context.proposals.apply(proposal.id);
  assert.deepEqual(applied, { changeId: null, moved: 0, skipped: [], stale: true });
  assert.equal((await context.b.getChildren('4')).some((child) => child.title === 'IA'), false);

  const second = await setUp({ reply: answer('Cocina', 'low') });
  const saved = await second.save(RANKING);
  await second.b.remove(saved.node.id);
  await second.proposals.prune();
  assert.deepEqual(await second.proposals.read(), []);
});

test('the worker drops a proposal when the bookmark moves, through onMoved', async () => {
  const context = await setUp({ reply: answer('Cocina', 'low') });
  context.fake.bookmarks.onMoved.addListener(() => void context.sorter.prune());
  const { node } = await context.save(RANKING);
  assert.equal((await context.proposals.read()).length, 1);
  await context.b.move(node.id, { parentId: context.folders.Viajes });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await context.proposals.read(), []);
});

test('the context sends neighbors and folder examples, but never one with a private host', async () => {
  const context = await setUp({ loose: AI_LOOSE, reply: answer(null) });
  await context.b.create({ parentId: context.folders.Cocina, title: 'Receta del NAS', url: 'http://nas.local/recetas' });
  await context.b.create({ parentId: context.folders.Cocina, title: 'Pan de campo', url: 'https://bread.example.com/campo' });
  await context.save(RANKING);
  const [request] = context.calls;
  assert.match(request.user, /"name":"Cocina","examples":\["Pan de campo"\]/);
  for (const title of ['Claude', 'ChatGPT', 'NotebookLM', 'Banco']) assert.ok(request.user.includes(`"title":"${title}"`), title);
  assert.doesNotMatch(request.user, /Router|192\.168|Receta del NAS|nas\.local/);
});

test('at most 50 proposals wait; the oldest fall, and each one is logged as expired', async () => {
  const context = await setUp({ reply: answer('Cocina', 'low'), settings: { maxCallsPerDay: 100 } });
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < MAX_PROPOSALS + 2; i += 1) ids.push((await context.save({ url: `https://cooking.example.com/p${i}` })).node.id);
  const pending = await context.proposals.read();
  assert.equal(pending.length, MAX_PROPOSALS);
  assert.deepEqual(pending.map((proposal) => proposal.bookmark.id), ids.slice(2));
  assert.equal(context.fake.action.badges.at(-1), String(MAX_PROPOSALS));
  const expired = (await context.settingsStore.readLog()).filter((event) => event.kind === 'expired');
  assert.deepEqual(expired.map((event) => event.bookmarkId).sort(), ids.slice(0, 2).sort());
});

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '../../extension');

test('the worker’s modules use no Node API, so the adapter path runs in Chrome as tested here', () => {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} file */
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(join(EXTENSION, file), 'utf8');
    for (const [, specifier] of code.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `${file} imports ${specifier}`);
      visit(join(dirname(file), specifier));
    }
    // JSDoc mentions `import('...')` types and comments may say "process"; only code counts.
    const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bimport\s*\(/.test(bare), `${file}: no dynamic import, which a service worker forbids`);
    const nodeOnly = /\bprocess\.(?:env|argv|exit|cwd|nextTick|versions|platform|stdout|stderr|hrtime)\b|\bBuffer\.|\brequire\(|__dirname|__filename|\bglobal\./.exec(bare);
    assert.equal(nodeOnly, null, `${file} uses ${nodeOnly?.[0]}`);
  };
  visit('sw.js');
  for (const file of ['platform/autosort.js', 'platform/openai-compatible.js', 'platform/complete-factory.js', 'core/classify.js', 'core/url.js']) {
    assert.ok(seen.has(file), `${file} is on the worker path`);
  }
});

test('sw.js registers its listeners at the top level and restricts storage to trusted contexts', async (t) => {
  const fake = createFakeChrome({ account: true });
  /** @type {string[]} */
  const registered = [];
  const watch = (/** @type {string} */ name, /** @type {any} */ target) => ({ addListener: (/** @type {any} */ listener) => (registered.push(name), target.addListener(listener)) });
  /** @type {any} */ (globalThis).chrome = {
    bookmarks: {
      ...fake.bookmarks,
      ...Object.fromEntries(['onCreated', 'onMoved', 'onRemoved', 'onImportBegan', 'onImportEnded'].map((name) => [name, watch(name, /** @type {any} */ (fake.bookmarks)[name])])),
    },
    tabs: fake.tabs,
    permissions: fake.permissions,
    storage: fake.storage,
    action: fake.action,
    runtime: { ...fake.runtime, onInstalled: watch('onInstalled', fake.runtime.onInstalled), onStartup: watch('onStartup', fake.runtime.onStartup), onMessage: watch('onMessage', fake.runtime.onMessage) },
  };
  t.after(() => delete (/** @type {any} */ (globalThis).chrome));
  await import(`../../extension/sw.js?${Date.now()}`);
  assert.deepEqual(registered.sort(), ['onCreated', 'onImportBegan', 'onImportEnded', 'onInstalled', 'onMessage', 'onMoved', 'onRemoved', 'onStartup']);
  assert.equal(fake.storage.local.accessLevel, 'TRUSTED_CONTEXTS');
});

afterEach(() => {
  delete (/** @type {any} */ (globalThis).chrome);
});
