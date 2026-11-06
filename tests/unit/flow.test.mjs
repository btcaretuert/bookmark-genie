import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONSENT_VERSION,
  DEADLINE_MS,
  DEFAULT_SETTINGS,
  WAIT_MS,
  consentText,
  dayKey,
  errorCategory,
  errorText,
  weekKey,
} from '../../extension/core/autosort.js';
import { findModel } from '../../extension/core/models.js';
import { createFlow } from '../../extension/platform/flow.js';
import { RetryLaterError } from '../../extension/platform/llm.js';
import { ProviderRequestError } from '../../extension/platform/openai-compatible.js';
import { PROPOSAL_TTL_MS, createProposals } from '../../extension/platform/proposals.js';
import { getProvider } from '../../extension/platform/providers.js';
import { createSettingsStore } from '../../extension/platform/settings.js';
import { createStore } from '../../extension/platform/store.js';
import { createFakeChrome } from '../helpers/fake-chrome.mjs';

const KEY = 'test-key-not-real-1234567890';
const GEMINI_HOST = 'https://generativelanguage.googleapis.com/*';
const PAGE = 'https://cooking.example.com/recipes/bread?utm_source=x';
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
/** @param {CompletionRequest} request @param {string} name */
const folderNumber = (request, name) => JSON.parse(/** @type {string[]} */ (/<folders>\n(.*)\n<\/folders>/s.exec(request.user))[1]).find((/** @type {any} */ folder) => folder.name === name).f;
const existing = (/** @type {string} */ name, confidence = 'high') => (/** @type {CompletionRequest} */ request) => result({ ...EMPTY, kind: 'existing', folder: folderNumber(request, name), confidence });
const proposeNew = (/** @type {string} */ name) => () => result({ ...EMPTY, kind: 'new', confidence: 'high', name, description: `Sobre ${name}.` });

/**
 * Account bar with Cocina, Programación and Viajes; the sort on, Gemini ready. `settings`
 * overrides; by default the mode is the new default, «Confirmar antes de mover».
 *
 * @param {{reply?: (request: CompletionRequest) => any, settings?: object, key?: string | null, grant?: string[], now?: () => Date, schedule?: (callback: () => void, ms: number) => void}} [options]
 */
async function setUp({ reply = existing('Cocina'), settings = {}, key = KEY, grant = ['tabs', GEMINI_HOST], now, schedule = () => {} } = {}) {
  const fake = createFakeChrome({ account: true });
  const b = fake.bookmarks;
  /** @type {Record<string, string>} */
  const folders = {};
  for (const name of ['Cocina', 'Programación', 'Viajes']) folders[name] = (await b.create({ parentId: '4', title: name })).id;
  const store = createSettingsStore(fake.storage.local);
  await store.saveSettings({
    ...DEFAULT_SETTINGS,
    enabled: true,
    consent: { provider: 'gemini', readOn: getProvider('gemini').dataPolicy.readOn, version: CONSENT_VERSION, at: '2026-11-05T10:00:00.000Z' },
    ...settings,
  });
  if (key) await store.saveKey('gemini', key);
  for (const name of grant) fake.permissions.granted.add(name);
  /** @type {CompletionRequest[]} */
  const calls = [];
  let replyWith = reply;
  const flow = createFlow({
    storage: fake.storage.local,
    bookmarks: b,
    tabs: fake.tabs,
    permissions: fake.permissions,
    action: fake.action,
    now,
    schedule,
    createComplete: () => async (/** @type {CompletionRequest} */ request) => {
      calls.push(request);
      return replyWith(request);
    },
  });
  // The worker's own instance: the same storage, so what it writes the page reads.
  const { createAutoSorter } = await import('../../extension/platform/autosort.js');
  const sorter = createAutoSorter({
    bookmarks: b,
    tabs: fake.tabs,
    permissions: fake.permissions,
    storage: fake.storage.local,
    action: fake.action,
    now,
    wait: async () => {},
    schedule: () => {},
    createComplete: () => async (/** @type {CompletionRequest} */ request) => {
      calls.push(request);
      return replyWith(request);
    },
  });
  /** @param {{url?: string, title?: string, parentId?: string}} [page] */
  const save = async ({ url = PAGE, title = 'Pan de masa madre', parentId = '4' } = {}) => {
    fake.tabs.setActive(url);
    const node = await b.create({ parentId, title, url });
    return { node, event: /** @type {any} */ (await sorter.handleCreated(node.id, node)) };
  };
  const parentOf = async (/** @type {string} */ id) => (await b.get(id))[0].parentId;
  return { fake, b, folders, store, flow, sorter, calls, save, parentOf, setReply: (/** @type {any} */ next) => (replyWith = next) };
}

// --- D1: confirm before moving ---

test('D1: by default a sure answer is a proposal with one «Mover», and nothing moves until then', async () => {
  const { save, parentOf, flow, folders, store } = await setUp();
  const { node, event } = await save();
  assert.equal(event.kind, 'proposed');
  assert.equal(await parentOf(node.id), '4');
  const [proposal] = await flow.proposals.list();
  assert.deepEqual({ kind: proposal.kind, confidence: proposal.confidence, folder: proposal.folder, members: proposal.members }, { kind: 'move', confidence: 'high', folder: { id: folders.Cocina, name: 'Cocina' }, members: 1 });
  const applied = await flow.proposals.apply(proposal.id);
  assert.equal(applied.moved, 1);
  assert.equal(await parentOf(node.id), folders.Cocina);
  assert.equal((await store.readMetrics()).totals.accepted, 1);
  assert.equal((await flow.getStatus()).state, 'confirm');
});

test('D1: automatic mode is suggested after 20 accepted as they came and at most 1 corrected', async () => {
  const { flow, store } = await setUp();
  for (let i = 0; i < 19; i += 1) await store.bumpMetric('accepted', new Date());
  assert.equal((await flow.getStatus()).suggestAutomatic, false);
  await store.bumpMetric('accepted', new Date());
  await store.bumpMetric('corrected', new Date());
  assert.equal((await flow.getStatus()).suggestAutomatic, true);
  await store.bumpMetric('corrected', new Date());
  assert.equal((await flow.getStatus()).suggestAutomatic, false);
});

// --- D3: already saved ---

test('D3: a URL already saved is not sent; the log offers to remove the new copy, and only that one goes', async () => {
  const { save, b, folders, calls, flow } = await setUp();
  const old = await b.create({ parentId: folders.Cocina, title: 'Pan viejo', url: PAGE });
  const { node, event } = await save();
  assert.deepEqual({ kind: event.kind, folder: event.folder, duplicateOf: event.duplicateOf }, { kind: 'duplicate', folder: 'Cocina', duplicateOf: old.id });
  assert.equal(calls.length, 0);
  const [entry] = await flow.listActivity();
  assert.equal(entry.messageEs, 'Ya lo tenías en «Cocina».');
  assert.ok(entry.actions.includes('remove-duplicate'));
  assert.deepEqual(await flow.removeDuplicate(node.id), { removed: true });
  await assert.rejects(b.get(node.id));
  assert.equal((await b.get(old.id))[0].parentId, folders.Cocina);
  assert.deepEqual(await flow.removeDuplicate(old.id), { removed: false, reason: 'not-duplicate' });
});

// --- D7: proposals without duplicates or losses ---

test('D7: two new-folder proposals with the same name merge, and confirming makes one folder with both', async () => {
  const { save, flow, b, setReply } = await setUp({ reply: proposeNew('Inteligencia Artificial') });
  const first = await save({ url: 'https://ai.example.com/one', title: 'Uno' });
  setReply(proposeNew('inteligencia artificial'));
  const second = await save({ url: 'https://ai.example.com/two', title: 'Dos' });
  const list = await flow.proposals.list();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].together.map((member) => member.id), [second.node.id]);
  assert.equal(list[0].members, 2);
  const applied = await flow.proposals.apply(list[0].id);
  assert.equal(applied.moved, 2);
  const created = (await b.getChildren('4')).filter((child) => child.url === undefined && /inteligencia/i.test(child.title));
  assert.equal(created.length, 1);
  assert.deepEqual((await b.getChildren(created[0].id)).map((child) => child.id), [first.node.id, second.node.id]);
});

test('D7: applying reuses a sibling folder with the same name made meanwhile', async () => {
  const { save, flow, b } = await setUp({ reply: proposeNew('IA') });
  const { node } = await save();
  const mine = await b.create({ parentId: '4', title: 'ia' });
  const [proposal] = await flow.proposals.list();
  const applied = await flow.proposals.apply(proposal.id);
  assert.equal(applied.reusedFolder, mine.id);
  assert.equal(applied.createdFolder, undefined);
  assert.equal((await b.get(node.id))[0].parentId, mine.id);
  assert.equal((await b.getChildren('4')).filter((child) => child.url === undefined && child.title.toLowerCase() === 'ia').length, 1);
});

test('D7: when applying fails after the folder exists, the folder goes and the proposal stays', async () => {
  const { save, flow, b, fake } = await setUp({ reply: proposeNew('IA') });
  await save();
  const [proposal] = await flow.proposals.list();
  const failing = createProposals({ storage: fake.storage.local, bookmarks: { ...b, move: async () => Promise.reject(new Error('disk full')), getTree: async () => { throw new Error('disk full'); } }, action: fake.action });
  const applied = await failing.apply(proposal.id);
  assert.equal(applied.error?.category, 'server');
  assert.equal((await b.getChildren('4')).some((child) => child.title === 'IA'), false, 'no orphan folder');
  assert.equal((await flow.proposals.list()).length, 1, 'the proposal is not lost');
});

test('D7: a name edited by the person is used, and counts as a correction', async () => {
  const { save, flow, b, store } = await setUp({ reply: proposeNew('IA') });
  const { node } = await save();
  const [proposal] = await flow.proposals.list();
  const applied = await flow.proposals.apply(proposal.id, { name: '  Inteligencia\nartificial ' });
  assert.equal((await b.get(/** @type {string} */ (applied.createdFolder)))[0].title, 'Inteligencia artificial');
  assert.equal((await b.get(node.id))[0].parentId, applied.createdFolder);
  assert.deepEqual((await store.readMetrics()).totals, { accepted: 0, corrected: 1 });
});

test('D7: another existing folder can be chosen instead of creating one', async () => {
  const { save, flow, folders, b } = await setUp({ reply: proposeNew('IA') });
  const { node } = await save();
  const [proposal] = await flow.proposals.list();
  const applied = await flow.proposals.apply(proposal.id, { targetFolderId: folders.Programación });
  assert.equal(applied.createdFolder, undefined);
  assert.equal((await b.get(node.id))[0].parentId, folders.Programación);
});

test('D7: «Aceptar todas las de X» applies every pending proposal for that folder', async () => {
  const { save, flow, folders, parentOf } = await setUp({ reply: existing('Cocina', 'low') });
  const one = await save({ url: 'https://a.example.com/1' });
  const two = await save({ url: 'https://a.example.com/2' });
  const result = await flow.proposals.acceptGroup('cocina');
  // 0.5.1: one change for the whole group, undone at once.
  assert.deepEqual({ moved: result.moved, groups: result.groups }, { moved: 2, groups: 2 });
  assert.deepEqual([await parentOf(one.node.id), await parentOf(two.node.id)], [folders.Cocina, folders.Cocina]);
  assert.deepEqual(await flow.proposals.list(), []);
});

test('D7: proposals expire after 14 days, logged and counted', async () => {
  let clock = new Date(2026, 10, 5, 10);
  const { save, sorter, flow, store } = await setUp({ reply: existing('Cocina', 'low'), now: () => clock });
  await save();
  clock = new Date(clock.getTime() + PROPOSAL_TTL_MS + 1000);
  await sorter.expire();
  assert.deepEqual(await flow.proposals.list(), []);
  const [entry] = await flow.listActivity();
  assert.deepEqual({ kind: entry.kind, reason: entry.reason }, { kind: 'expired', reason: 'expired' });
  assert.equal((await flow.weeklyMetrics()).expired, 1);
  assert.equal((await store.readMetrics()).weeks[weekKey(clock)].expired, 1);
});

test('D7: concurrent proposals are all kept (the proposals lock)', async () => {
  const { flow, b, fake } = await setUp();
  const proposals = createProposals({ storage: fake.storage.local, bookmarks: b, action: fake.action });
  const nodes = await Promise.all([1, 2, 3, 4].map((i) => b.create({ parentId: '4', title: `n${i}`, url: `https://n${i}.example.com/` })));
  await Promise.all(
    nodes.map((node, i) =>
      proposals.add({ id: `p${i}`, createdAt: new Date().toISOString(), kind: 'move', confidence: 'low', bookmark: { id: node.id, title: node.title, host: '', parentId: '4', index: /** @type {number} */ (node.index) }, folder: { id: '5', name: 'x' }, together: [] }),
    ),
  );
  assert.equal((await flow.proposals.list()).length, 4);
});

// --- D8: visible errors ---

for (const [name, error, category, calls] of /** @type {[string, Error, string, number][]} */ ([
  ['an invalid key (401)', new ProviderRequestError('rejected (status 401)', { status: 401, requestId: null, apiMessage: 'API key not valid' }), 'key', 1],
  ['a key rejected as 400 with that message', new ProviderRequestError('rejected (status 400)', { status: 400, requestId: null, apiMessage: 'API key not valid. Please pass a valid API key.' }), 'key', 1],
  ['a model the account cannot use (404)', new ProviderRequestError('rejected (status 404)', { status: 404, requestId: null, apiMessage: null }), 'model', 1],
  ['a 429, which is not retried', new RetryLaterError('Rate limited', 30_000, { status: 429 }), 'quota', 1],
  ['a quota 429 marked permanent', new ProviderRequestError('rejected (status 429)', { status: 429, requestId: null, apiMessage: 'Quota exceeded' }), 'quota', 1],
  ['a 503 twice, retried once', new RetryLaterError('Server error 503', null, { status: 503 }), 'server', 2],
]))
  test(`D8: ${name} is logged as «${category}», the bookmark stays, the badge shows «!» until the window opens`, async () => {
    const { save, parentOf, calls: sent, flow, fake } = await setUp({
      settings: { confirmBeforeMove: false },
      reply: () => {
        throw error;
      },
    });
    const { node, event } = await save();
    assert.deepEqual({ kind: event.kind, category: event.category }, { kind: 'error', category });
    assert.equal(sent.length, calls);
    assert.equal(await parentOf(node.id), '4');
    assert.equal(fake.action.badges.at(-1), '!');
    const [entry] = await flow.listActivity();
    assert.equal(entry.messageEs, errorText(category));
    assert.ok(entry.actions.includes('retry'));
    await flow.ackErrors();
    assert.equal(fake.action.badges.at(-1), '');
  });

test('D8: a key that shows up in an error message is masked in the log', async () => {
  const { save, store } = await setUp({
    reply: () => {
      throw new ProviderRequestError(`rejected key ${KEY}`, { status: 400, requestId: null, apiMessage: null });
    },
  });
  await save();
  assert.doesNotMatch(JSON.stringify(await store.readLog()), new RegExp(KEY));
});

test('D8: every category has a Spanish text with what to do', () => {
  for (const category of ['key', 'quota', 'server', 'timeout', 'model', 'permission', 'no-key', 'daily-cap']) {
    const text = errorText(category);
    assert.match(text, /[.]$/);
    assert.doesNotMatch(text, /\b(the|error|failed|request)\b/i, `${category} is Spanish`);
  }
  assert.equal(errorCategory({ timedOut: true }), 'timeout');
  assert.equal(errorCategory(new Error('fetch failed')), 'server');
});

test('D8: a retry, the badge count and the error color', async () => {
  const { save, flow, fake, setReply, parentOf, folders } = await setUp({
    settings: { confirmBeforeMove: false },
    reply: () => {
      throw new RetryLaterError('Rate limited', null, { status: 429 });
    },
  });
  const { node } = await save();
  setReply(existing('Viajes'));
  const retried = /** @type {any} */ (await flow.reclassify(node.id));
  assert.equal(retried.kind, 'moved');
  assert.equal(await parentOf(node.id), folders.Viajes);
  assert.ok(fake.action.badges.includes('!'));
});

// --- D9: consent v2, exclusions, context mode ---

test('D9: a version 1 consent no longer covers, and nothing is sent', async () => {
  const { save, calls } = await setUp({ settings: { consent: { provider: 'gemini', readOn: getProvider('gemini').dataPolicy.readOn, version: 1, at: 'x' } } });
  const { event } = await save();
  assert.equal(event.reason, 'no-consent');
  assert.equal(calls.length, 0);
});

test('D9: the consent text says what leaves, and flow builds a version 2 consent', async () => {
  const { flow } = await setUp();
  const text = (await flow.consentText('gemini')).join('\n');
  for (const piece of ['Google Gemini', 'nombres de tus carpetas', 'hasta 5 títulos de ejemplo', 'hasta 30 títulos', 'carpeta excluida', 'solo el marcador']) assert.ok(text.includes(piece), piece);
  assert.deepEqual(text, consentText(getProvider('gemini')).join('\n'));
  const consent = await flow.consentFor('gemini');
  assert.equal(consent.version, CONSENT_VERSION);
  assert.equal(flow.consentCovers({ ...DEFAULT_SETTINGS, consent }, 'gemini'), true);
  assert.equal((await flow.policySummary('gemini')).length, 3);
  assert.match((await flow.policySummary('gemini'))[0], /Plan gratuito/);
  assert.match((await flow.policyFull('gemini')).join('\n'), /Fuente: https:\/\/aistudio\.google\.com\/docs\/terms/);
});

test('D9: an excluded folder is never sent, not its name nor its bookmarks, and a save into an excluded root is left', async () => {
  const context = await setUp({ settings: { confirmBeforeMove: false } });
  const excludedId = context.folders.Viajes;
  const inner = await context.b.create({ parentId: excludedId, title: 'Médico' });
  await context.b.create({ parentId: inner.id, title: 'Resultados de laboratorio', url: 'https://lab.example.com/results' });
  await context.b.create({ parentId: excludedId, title: 'Viaje a Cusco', url: 'https://cusco.example.com/' });
  await context.b.create({ parentId: context.folders.Cocina, title: 'Arepas', url: 'https://arepas.example.com/' });
  await context.store.saveSettings({ ...(await context.store.readSettings()), excludedFolderIds: [excludedId, '5'] });
  await context.save();
  const [request] = context.calls;
  assert.doesNotMatch(request.user, /Viajes|Médico|Resultados|Cusco/);
  assert.match(request.user, /"name":"Cocina","examples":\["Arepas"\]/);
  const intoExcluded = await context.save({ parentId: '5', url: 'https://other.example.com/' });
  assert.equal(intoExcluded.event.reason, 'excluded-folder');
  assert.equal(context.calls.length, 1);
  const choices = await context.flow.folderChoices();
  assert.deepEqual(choices.filter((choice) => choice.excluded).map((choice) => choice.id).sort(), [excludedId, inner.id, '5'].sort());
});

test('D9: «Contexto: solo el marcador» sends folder names but no examples and no loose bookmarks', async () => {
  const context = await setUp({ settings: { contextMode: 'bookmark-only' } });
  await context.b.create({ parentId: context.folders.Cocina, title: 'Arepas', url: 'https://arepas.example.com/' });
  await context.b.create({ parentId: '4', title: 'Claude', url: 'https://claude.ai/' });
  await context.save();
  const [request] = context.calls;
  assert.match(request.user, /"name":"Cocina","examples":\[\]/);
  assert.match(request.user, /<loose_bookmarks>\n\[\]\n<\/loose_bookmarks>/);
  assert.doesNotMatch(request.user, /Arepas|Claude/);
  const preview = await context.flow.lastSentPreview();
  assert.deepEqual({ folders: preview?.folders, examples: preview?.examples, loose: preview?.loose }, { folders: 3, examples: 0, loose: 0 });
});

test('the last request preview counts what left, with clean titles and no full URL', async () => {
  const context = await setUp();
  await context.b.create({ parentId: '4', title: 'Claude', url: 'https://claude.ai/chat/abc?token=1' });
  await context.save();
  const preview = await context.flow.lastSentPreview();
  assert.equal(preview?.loose, 1);
  assert.deepEqual(preview?.titles.slice(0, 2), ['Pan de masa madre', 'Claude']);
  assert.doesNotMatch(JSON.stringify(preview), /utm_source|token|https:/);
});

// --- Settings, keys and permissions (D11, D14) ---

test('settings.save writes before any await, so a permission dialog cannot lose it', async () => {
  const { flow, fake } = await setUp();
  /** @type {unknown[]} */
  const writes = [];
  const realSet = fake.storage.local.set;
  fake.storage.local.set = (items) => (writes.push(items), realSet(items));
  const pending = flow.settings.save({ ...DEFAULT_SETTINGS, enabled: true, maxCallsPerDay: 7 });
  const keyPending = flow.settings.saveKey('gemini', ' new-key-not-real-9876 ');
  assert.equal(writes.length, 2, 'both writes left in the same turn');
  await Promise.all([pending, keyPending]);
  assert.equal((await flow.settings.get()).maxCallsPerDay, 7);
  assert.equal(await flow.settings.keyHint('gemini'), '…9876');
});

test('turning the sort off gives the permissions back; deleteKey removes the key, the 0.3.0 map too', async () => {
  const { flow, fake } = await setUp();
  await fake.storage.local.set({ apiKeys: { gemini: 'old-key-not-real-5555', openai: 'other-not-real-1111' } });
  await flow.settings.save({ ...(await flow.settings.get()), enabled: false });
  assert.equal(fake.permissions.granted.has('tabs'), false);
  assert.equal(fake.permissions.granted.has(GEMINI_HOST), false);
  await flow.settings.deleteKey('gemini');
  assert.equal(await flow.settings.keyHint('gemini'), null);
  assert.equal(await flow.settings.keyHint('openai'), '…1111');
  assert.deepEqual(flow.permissionsFor('gemini/gemini-3.5-flash-lite'), { permissions: ['tabs'], origins: [GEMINI_HOST] });
});

test('getStatus says why it is paused, and never throws', async () => {
  const cases = /** @type {[string, any, string, string | undefined][]} */ ([
    ['off', { settings: { enabled: false } }, 'off', undefined],
    ['no permission', { grant: [] }, 'paused', 'no-permission'],
    ['no key', { key: null }, 'paused', 'no-key'],
    ['no consent', { settings: { consent: null } }, 'paused', 'no-consent'],
    ['automatic', { settings: { confirmBeforeMove: false } }, 'active', undefined],
    ['confirm', {}, 'confirm', undefined],
    ['unknown model', { settings: { ref: 'gemini/nope' } }, 'paused', 'unknown-model'],
  ]);
  for (const [name, options, state, reason] of cases) {
    const { flow } = await setUp(options);
    const status = await flow.getStatus();
    assert.deepEqual([status.state, status.reason], [state, reason], name);
  }
  const { flow, store } = await setUp({ settings: { maxCallsPerDay: 2 } });
  await store.updateUsage(dayKey(new Date()), (usage) => ({ usage: { ...usage, calls: 2 }, result: null }));
  const capped = await flow.getStatus();
  assert.deepEqual([capped.state, capped.reason, capped.action], ['paused', 'daily-calls', 'wait-tomorrow']);
});

// --- Activity, undo and metrics (D13) ---

test('activity carries the change and its actions; undo through flow counts it', async () => {
  const { save, flow, parentOf, folders } = await setUp({ settings: { confirmBeforeMove: false } });
  const { node } = await save();
  const [entry] = await flow.listActivity();
  assert.equal(entry.kind, 'moved');
  assert.deepEqual(entry.actions.sort(), ['choose-folder', 'undo']);
  await flow.undo(/** @type {string} */ (entry.changeId));
  assert.equal(await parentOf(node.id), '4');
  const [after] = await flow.listActivity();
  assert.deepEqual(after.actions, ['choose-folder'], 'no undo twice');
  assert.equal((await flow.weeklyMetrics()).undone, 1);
  await flow.moveTo(node.id, folders.Viajes);
  assert.equal(await parentOf(node.id), folders.Viajes);
});

test('weekly metrics count moves, corrections, discards and the loose bookmarks in the bar, without titles', async () => {
  const { save, flow, store, folders, setReply } = await setUp({ settings: { confirmBeforeMove: false } });
  const moved = await save();
  await flow.moveTo(moved.node.id, folders.Viajes);
  await store.saveSettings({ ...(await store.readSettings()), confirmBeforeMove: true });
  setReply(existing('Cocina', 'low'));
  await save({ url: 'https://b.example.com/' });
  const [proposal] = await flow.proposals.list();
  await flow.proposals.discard(proposal.id);
  const metrics = await flow.weeklyMetrics();
  assert.deepEqual(
    { moved: metrics.moved, corrected: metrics.corrected, discarded: metrics.discarded, looseInBar: metrics.looseInBar },
    { moved: 1, corrected: 1, discarded: 1, looseInBar: 1 },
  );
  assert.equal(metrics.week, weekKey(new Date()));
  assert.doesNotMatch(JSON.stringify(await store.readMetrics()), /Pan|cooking/);
});

// --- Worker start-up and limits ---

test('a new install opens the settings; an update does not', async (t) => {
  const fake = createFakeChrome({ account: true });
  /** @type {any} */ (globalThis).chrome = { ...fake, storage: fake.storage };
  t.after(() => delete (/** @type {any} */ (globalThis).chrome));
  await import(`../../extension/sw.js?install-${Date.now()}`);
  fake.runtime.onInstalled.dispatch({ reason: 'update', previousVersion: '0.3.0' });
  assert.equal(fake.runtime.optionsOpened, 0);
  fake.runtime.onInstalled.dispatch({ reason: 'install' });
  assert.equal(fake.runtime.optionsOpened, 1);
});

test('limits that the worker relies on', () => {
  // The wait comes before the call, so only the call's deadline counts against the 30 s fetch limit.
  assert.ok(DEADLINE_MS <= 25_000, 'a margin under the 30 s a fetch may take');
  assert.ok(WAIT_MS < 30_000);
  const model = findModel(DEFAULT_SETTINGS.ref);
  assert.ok(model, 'the default model is in the catalog');
  assert.notEqual(model?.newAccounts, false, 'the default works for new accounts');
  assert.equal(findModel('gemini/gemini-2.5-flash-lite')?.newAccounts, false);
});

const HERE = dirname(fileURLToPath(import.meta.url));

test('the Ctrl+D suites pass in other time zones (UTC+14 and UTC-11)', () => {
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const run = spawnSync(process.execPath, ['--test', '--test-timeout=60000', join(HERE, 'autosort.test.mjs'), join(HERE, 'autosort-core.test.mjs')], {
      env: { ...process.env, TZ: zone },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(run.status, 0, `${zone}:\n${run.stdout.split('\n').filter((line) => line.startsWith('✖')).join('\n')}`);
  }
});

test('day and week keys follow the local calendar', () => {
  assert.equal(dayKey(new Date(2026, 10, 5, 0, 1)), '2026-11-05');
  assert.equal(dayKey(new Date(2026, 10, 5, 23, 59)), '2026-11-05');
  assert.equal(weekKey(new Date(2026, 10, 5, 23, 59)), '2026-W45');
  assert.equal(weekKey(new Date(2026, 0, 1, 0, 1)), '2026-W01');
  assert.equal(weekKey(new Date(2027, 0, 3, 12)), '2026-W53');
});

test('an applied proposal is a change of kind «proposal» in the journal, undoable', async () => {
  // The journal of datos is the one the proposals use: an applied proposal is undoable from it.
  const { save, flow, fake } = await setUp({ reply: proposeNew('IA') });
  await save();
  const [proposal] = await flow.proposals.list();
  const applied = await flow.proposals.apply(proposal.id);
  const header = (await createStore(fake.storage.local).listChanges(5)).find((change) => change.id === applied.changeId);
  assert.equal(header?.kind, 'proposal');
  assert.equal(header?.undoable, true);
});

// --- 0.4.1 ---

test('0.4.1 UX N1: what was accepted shows as moved, with its change to undo, and the result persists', async () => {
  const { save, flow, folders, parentOf } = await setUp();
  const { node } = await save();
  const [proposal] = await flow.proposals.list();
  const applied = await flow.proposals.apply(proposal.id);
  const [entry] = await flow.listActivity();
  assert.deepEqual({ kind: entry.kind, accepted: entry.accepted, changeId: entry.changeId, folder: entry.folder }, { kind: 'moved', accepted: true, changeId: applied.changeId, folder: 'Cocina' });
  assert.ok(entry.actions.includes('undo'));
  const remembered = await flow.lastResult();
  assert.deepEqual({ kind: remembered?.kind, changeId: remembered?.changeId, undoable: remembered?.undoable }, { kind: 'applied', changeId: applied.changeId, undoable: true });
  assert.equal(remembered?.messageEs, '1 marcador movido a «Cocina».');
  await flow.undo(/** @type {string} */ (entry.changeId));
  assert.equal(await parentOf(node.id), '4');
  assert.equal((await flow.lastResult())?.kind, 'undone');
  await flow.dismissLastResult();
  assert.equal(await flow.lastResult(), null);
  assert.equal(folders.Cocina.length > 0, true);
});

test('0.4.1 UX N1: a discarded proposal leaves its row as «discarded», with no folder to choose', async () => {
  const { save, flow } = await setUp();
  await save();
  const [proposal] = await flow.proposals.list();
  await flow.proposals.discard(proposal.id);
  const [entry] = await flow.listActivity();
  assert.deepEqual({ kind: entry.kind, reason: entry.reason }, { kind: 'left', reason: 'discarded' });
  assert.ok(!entry.actions.includes('retry'));
});

test('0.4.1 UX N2: a move proposal says why it waits', async () => {
  const sure = await setUp();
  await sure.save();
  assert.equal((await sure.flow.proposals.list())[0].reason, 'confirm-mode');
  const unsure = await setUp({ reply: existing('Cocina', 'low') });
  await unsure.save();
  assert.equal((await unsure.flow.proposals.list())[0].reason, 'low-confidence');
});

test('0.4.1 UX N3: the week counts bookmarks filed by any path, and those undone', async () => {
  const { save, flow, b, folders, setReply } = await setUp({ reply: proposeNew('IA') });
  await b.create({ parentId: '4', title: 'Claude', url: 'https://claude.ai/' });
  setReply((/** @type {CompletionRequest} */ request) => result({ ...EMPTY, kind: 'new', confidence: 'high', name: 'IA', together: [0] }));
  await save();
  const [proposal] = await flow.proposals.list();
  const applied = await flow.proposals.apply(proposal.id);
  const other = await b.create({ parentId: '4', title: 'Mapa', url: 'https://map.example.com/' });
  await flow.moveTo(other.id, folders.Viajes);
  await flow.undo(/** @type {string} */ (applied.changeId));
  const week = await flow.weeklyMetrics();
  assert.deepEqual({ filed: week.filed, undoneBookmarks: week.undoneBookmarks, accepted: week.accepted, moved: week.moved }, { filed: 3, undoneBookmarks: 2, accepted: 1, moved: 0 });
});

test('0.4.1 P2-1: an error row shows its Spanish text; the provider’s words are only a detail', async () => {
  const { save, flow } = await setUp({
    reply: () => {
      throw new RetryLaterError('Rate limited', null, { status: 429 });
    },
  });
  await save();
  const [entry] = await flow.listActivity();
  assert.equal(entry.messageEs, errorText('quota'));
  assert.equal(entry.detail, 'Rate limited');
  assert.equal('message' in entry, false);
});

for (const [name, error, counted] of /** @type {[string, Error, number][]} */ ([
  ['a 429', new RetryLaterError('Rate limited', null, { status: 429 }), 0],
  ['a 401', new ProviderRequestError('rejected (status 401)', { status: 401, requestId: null, apiMessage: null }), 0],
  ['a 400', new ProviderRequestError('rejected (status 400)', { status: 400, requestId: null, apiMessage: null }), 0],
  ['a timeout', new RetryLaterError('Request timed out', null, { timedOut: true }), 1],
  // Retried once, as a connection failure: both attempts may have reached the provider.
  ['a cut after sending', new RetryLaterError('Connection failed', null, { mayHaveBilled: true }), 2],
]))
  test(`0.4.1 P2-2: ${name} ${counted ? 'counts' : 'does not count'} against the daily cap`, async () => {
    const { save, store } = await setUp({
      reply: () => {
        throw error;
      },
    });
    await save();
    assert.equal((await store.readUsage(dayKey(new Date()))).calls, counted);
  });

test('0.4.1 H11: when the context was cut, the row says how many folders went', async () => {
  const { save, flow, b } = await setUp({ reply: existing('Cocina', 'low') });
  for (let i = 0; i < 100; i += 1) await b.create({ parentId: '4', title: `Carpeta ${i}` });
  await save();
  const [entry] = await flow.listActivity();
  assert.deepEqual(entry.truncation, { sent: 100, total: 103 });
  assert.match(entry.messageEs, /Se enviaron 100 de 103 carpetas\.$/);
});

test('0.4.1 security N1: the preview lists what left, and is not written when nothing did', async () => {
  const blocked = await setUp({ settings: { maxCallsPerDay: 1 } });
  await blocked.store.updateUsage(dayKey(new Date()), (usage) => ({ usage: { ...usage, calls: 1 }, result: null }));
  await blocked.save();
  assert.equal(await blocked.flow.lastSentPreview(), null, 'the daily cap stopped it: nothing left');

  const { save, flow, b, folders } = await setUp();
  await b.create({ parentId: folders.Cocina, title: 'Arepas', url: 'https://arepas.example.com/receta?x=1' });
  await b.create({ parentId: '4', title: 'Claude', url: 'https://claude.ai/chat/abc' });
  await save();
  const preview = await flow.lastSentPreview();
  assert.deepEqual(preview?.sent.bookmark, { title: 'Pan de masa madre', host: 'cooking.example.com' });
  assert.deepEqual(preview?.sent.folders.find((folder) => folder.name === 'Cocina'), { name: 'Cocina', examples: ['Arepas'] });
  assert.deepEqual(preview?.sent.loose, [{ title: 'Claude', host: 'claude.ai' }]);
  assert.doesNotMatch(JSON.stringify(preview), /https?:|chat\/abc|receta/);
});

test('0.4.1 security N2: a new key removes the 0.3.0 copy', async () => {
  const { flow, fake } = await setUp();
  await fake.storage.local.set({ apiKeys: { gemini: 'old-key-not-real-5555', openai: 'other-not-real-1111' } });
  await flow.settings.saveKey('gemini', 'new-key-not-real-9999');
  const { apiKeys } = await fake.storage.local.get('apiKeys');
  assert.deepEqual(apiKeys, { openai: 'other-not-real-1111' });
  assert.equal(await flow.settings.keyHint('gemini'), '…9999');
});

test('0.4.1 security N3: switching provider gives the old host back', async () => {
  const { flow, fake } = await setUp();
  fake.permissions.granted.add('https://api.openai.com/*');
  await flow.settings.save({ ...(await flow.settings.get()), ref: 'openai/gpt-6-luna' });
  assert.equal(fake.permissions.granted.has(GEMINI_HOST), false);
  assert.equal(fake.permissions.granted.has('https://api.openai.com/*'), true);
  assert.equal(fake.permissions.granted.has('tabs'), true, 'still on: tabs stays');
});

test('0.4.1 security N4: an exclusion keeps its path; a recreated folder stays excluded, and both cases warn', async () => {
  const { flow, b, folders, calls, save } = await setUp({ settings: { confirmBeforeMove: false } });
  const medico = await b.create({ parentId: folders.Viajes, title: 'Médico' });
  await flow.settings.save({ ...(await flow.settings.get()), excludedFolderIds: [medico.id] });
  assert.deepEqual((await flow.settings.get()).excludedFolders, [{ id: medico.id, path: ['Bookmarks bar', 'Viajes', 'Médico'] }]);
  await b.removeTree(medico.id);
  const again = await b.create({ parentId: folders.Viajes, title: 'Médico' });
  await b.create({ parentId: again.id, title: 'Resultados', url: 'https://lab.example.com/' });
  const status = await flow.getStatus();
  assert.deepEqual(status.exclusionWarnings, [{ path: 'Bookmarks bar › Viajes › Médico', status: 'changed' }]);
  assert.equal(status.messageEs, 'Una carpeta excluida cambió: revísala en Ajustes.');
  await save();
  assert.doesNotMatch(calls[0].user, /Médico|Resultados/);
  await b.removeTree(again.id);
  assert.deepEqual((await flow.getStatus()).exclusionWarnings, [{ path: 'Bookmarks bar › Viajes › Médico', status: 'missing' }]);
});

test('0.4.1 UX P2-5: «Probar la clave» makes one minimal call, with nothing of the person, and says how it went', async () => {
  const { flow, calls, store, setReply } = await setUp({ reply: () => result({ ...EMPTY, kind: 'none' }) });
  const ok = await flow.testProvider();
  assert.equal(ok.ok, true);
  assert.match(ok.messageEs, /^La clave funciona: Google Gemini respondió con gemini-3\.5-flash-lite en \d+,\d s\.$/);
  assert.match(calls[0].user, /Prueba de conexión/);
  assert.match(calls[0].user, /<folders>\n\[\]\n<\/folders>/);
  assert.equal((await store.readUsage(dayKey(new Date()))).calls, 1);
  setReply(() => {
    throw new ProviderRequestError('rejected (status 401)', { status: 401, requestId: null, apiMessage: null });
  });
  const failed = await flow.testProvider();
  assert.deepEqual({ ok: failed.ok, category: failed.category, messageEs: failed.messageEs }, { ok: false, category: 'key', messageEs: errorText('key') });
  assert.equal((await store.readUsage(dayKey(new Date()))).calls, 1, 'a 401 does not count');
  assert.equal(await flow.lastSentPreview(), null, 'the test is not a send of your data');
});

test('0.4.1 UX N4: no «retry» where it would repeat itself, no «choose folder» on a proposal row', async () => {
  const { save, flow, setReply } = await setUp({ reply: () => result({ ...EMPTY, kind: 'none' }) });
  await save();
  const [none] = await flow.listActivity();
  assert.equal(none.reason, 'no-topic');
  assert.ok(!none.actions.includes('retry'));
  assert.ok(none.actions.includes('choose-folder'));
  setReply(existing('Cocina', 'low'));
  await save({ url: 'https://other.example.com/' });
  const [proposed] = await flow.listActivity();
  assert.equal(proposed.kind, 'proposed');
  assert.deepEqual(proposed.actions, []);
});

test('0.4.1 QA: createFlow passes its schedule to the worker, so no real 15 s timer', async () => {
  /** @type {number[]} */
  const scheduled = [];
  const { b, flow } = await setUp({ settings: { confirmBeforeMove: false }, schedule: (_, ms) => void scheduled.push(ms) });
  const node = await b.create({ parentId: '4', title: 'Pan', url: PAGE });
  const event = /** @type {any} */ (await flow.reclassify(node.id));
  assert.equal(event.kind, 'moved');
  assert.deepEqual(scheduled, [15_000]);
});
