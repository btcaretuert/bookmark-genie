import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createManifest,
  describeTool,
  hashCodeTree,
  hashIds,
  assessCompleteness,
  hashTaxonomy,
  keySuffix,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  modelFileStem,
  promptHash,
  readManifest,
  sha256,
  summarizeModel,
  updateManifest,
  writeManifest,
} from '../../tools/lib/manifest.mjs';

const HAIKU = 'anthropic/claude-haiku-5-5';
const OTHER = 'someprovider/some-model-2026-01-01';
const CLASSIFY = { system: 'Sort.', user: '<folders>\n[]\n</folders>', schema: { type: 'object' }, maxTokens: 2048 };
const TAXONOMY = { system: 'Design.', user: 'Language: ', schema: { type: 'object' }, maxTokens: 4096 };

/** @param {Record<string, any>} [overrides] */
function input(overrides = {}) {
  return {
    startedAt: '2026-11-05T13:40:02.123Z',
    tool: { code_sha256: 'c'.repeat(64), node: '26.13.0', anthropic_sdk: '1.5.0' },
    inputBytes: Buffer.from('<DL><p>export</DL>'),
    bookmarks: 10,
    sendable: 8,
    excluded: { 'private-host': 2 },
    params: { seed: 1, sample: 4, review: 2, language: 'Spanish', max_usd: 1, effort: 'low', fallback: false, dry_run: false },
    models: [
      {
        ref: HAIKU,
        endpoint: 'https://api.example.test',
        keySuffix: 'wxyz',
        dataPolicy: { trains_by_default: false, source: 'https://example.test/policy' },
        effort: 'low',
        fallback: false,
        prompts: { classify: CLASSIFY, taxonomy: TAXONOMY },
      },
      {
        ref: OTHER,
        endpoint: 'https://other.example.test',
        keySuffix: 'abcd',
        dataPolicy: { trains_by_default: true, source: 'https://other.example.test/policy' },
        prompts: { classify: { ...CLASSIFY, maxTokens: 1024 }, taxonomy: null },
      },
    ],
    prices: { [HAIKU]: { input: 0.1, output: 0.5 }, [OTHER]: { input: 1, output: 2 } },
    taxonomySampleIds: ['b7', 'b8'],
    sampleIds: ['b0', 'b1', 'b2', 'b3'],
    reviewIds: ['b1', 'b3'],
    ...overrides,
  };
}

const FINISHED = { finishedAt: '2026-11-05T13:50:00.000Z', exitCode: 0 };

let base;
before(async () => {
  base = await mkdtemp(join(tmpdir(), 'bookmark-genie-manifest-'));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

test('sha256 is plain SHA-256 and accepts text or bytes', () => {
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(sha256('abc'), abc);
  assert.equal(sha256(Buffer.from('abc')), abc);
});

test('hashIds is the review_sha256 contract: the set of rows, in any order', () => {
  // Written out so that changing the definition breaks here: score.mjs depends on it.
  const expected = createHash('sha256').update('b1\nb10\nb2').digest('hex');
  assert.equal(hashIds(['b1', 'b10', 'b2']), expected);
  assert.equal(hashIds(['b2', 'b1', 'b10']), expected, 'sorting the CSV must not invalidate a review');
  assert.equal(hashIds(new Set(['b10', 'b2', 'b1'])), expected);
  assert.notEqual(hashIds(['b1', 'b2']), expected, 'a deleted row must be noticed');
  assert.notEqual(hashIds(['b1', 'b10', 'b2', 'b2']), expected, 'a repeated row must be noticed');
});

test('promptHash moves with anything that defines the prompt', () => {
  const hash = promptHash(CLASSIFY);
  assert.equal(promptHash({ ...CLASSIFY }), hash);
  assert.notEqual(promptHash({ ...CLASSIFY, system: 'Sort, carefully.' }), hash);
  assert.notEqual(promptHash({ ...CLASSIFY, user: '<carpetas></carpetas>' }), hash);
  assert.notEqual(promptHash({ ...CLASSIFY, schema: { type: 'array' } }), hash);
  assert.notEqual(promptHash({ ...CLASSIFY, maxTokens: 1 }), hash);
});

test('hashTaxonomy follows names, descriptions and order, and nothing else', () => {
  const folders = [{ name: 'Cocina', description: 'Recetas' }, { name: 'Dev' }];
  const hash = hashTaxonomy(folders);
  assert.equal(hashTaxonomy([{ name: 'Cocina', description: 'Recetas', extra: 1 }, { name: 'Dev', description: '' }]), hash);
  assert.notEqual(hashTaxonomy([{ name: 'Cocina', description: 'Platos' }, { name: 'Dev' }]), hash);
  assert.notEqual(hashTaxonomy([{ name: 'Dev' }, { name: 'Cocina', description: 'Recetas' }]), hash);
});

test('keySuffix keeps four characters and never a whole secret', () => {
  assert.equal(keySuffix('sk-ant-api03-1234567890abcdef'), 'cdef');
  assert.equal(keySuffix('test-key'), '-key');
  for (const value of ['', 'abcd', 'short12', undefined, null]) assert.equal(keySuffix(value), null);
});

test('modelFileStem makes a reference safe as part of a file name', () => {
  assert.equal(modelFileStem('anthropic/claude-haiku-5-5'), 'anthropic__claude-haiku-5-5');
  assert.equal(modelFileStem('someprovider/vendor/model:free'), 'someprovider__vendor__model__free');
  assert.ok(!modelFileStem('provider/../../etc/passwd').includes('/'));
  assert.equal(modelFileStem('a//b'), 'a__b');
});

test('createManifest builds the contract other modules read', () => {
  const manifest = createManifest(input());

  assert.deepEqual(Object.keys(manifest), [
    'schema',
    'run_id',
    'status',
    'started_at',
    'finished_at',
    'exit_code',
    'stopped_by',
    'tool',
    'input',
    'params',
    'sample_size',
    'sample_sha256',
    'review_size',
    'review_sha256',
    'taxonomy_sample_size',
    'taxonomy_sample_sha256',
    'quality',
    'prices_usd_per_mtok',
    'spent_usd',
    'lost_usd',
    'cap_broken_by',
    'models',
  ]);
  assert.equal(manifest.schema, 'bookmark-genie/run-manifest@1');
  assert.equal(manifest.status, 'running');
  assert.equal(manifest.run_id, '2026-11-05T13-40-02.123Z');
  assert.equal(manifest.started_at, '2026-11-05T13:40:02.123Z');
  assert.equal(manifest.finished_at, null);
  assert.equal(manifest.exit_code, null);
  assert.equal(manifest.input.sha256, sha256('<DL><p>export</DL>'));
  assert.equal(manifest.input.bytes, 18);
  assert.deepEqual(manifest.input.excluded, { 'private-host': 2 });
  assert.equal(manifest.input.bookmarks, 10);
  assert.equal(manifest.input.sendable, 8);
  assert.deepEqual(manifest.params.models, [HAIKU, OTHER]);
  assert.equal(manifest.params.max_usd, 1);
  assert.equal(manifest.sample_size, 4);
  assert.equal(manifest.sample_sha256, hashIds(['b0', 'b1', 'b2', 'b3']));
  assert.equal(manifest.review_size, 2);
  assert.equal(manifest.review_sha256, hashIds(['b3', 'b1']));
  assert.equal(manifest.taxonomy_sample_sha256, hashIds(['b7', 'b8']));
  assert.deepEqual(manifest.prices_usd_per_mtok[HAIKU], { input: 0.1, output: 0.5 });
  assert.equal(manifest.spent_usd, 0);
});

test('each model records its own provider, credential, destination, policy and prompts', () => {
  const [first, second] = createManifest(input()).models;

  assert.deepEqual(first, {
    requested: HAIKU,
    provider: 'anthropic',
    status: 'pending',
    endpoint: 'https://api.example.test',
    key_suffix: 'wxyz',
    data_policy: { trains_by_default: false, source: 'https://example.test/policy' },
    effort: 'low',
    fallback: false,
    prompts: { classify_sha256: promptHash(CLASSIFY), taxonomy_sha256: promptHash(TAXONOMY) },
    served: {},
    answered_by: {},
    taxonomy_sha256: null,
    dropped: {},
    classified: 0,
    unclassified: 0,
    unclassified_reasons: {},
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    spent_usd: 0,
    lost_usd: 0,
    stopped_by: null,
  });
  assert.equal(second.provider, 'someprovider');
  assert.equal(second.key_suffix, 'abcd');
  assert.equal(second.effort, null, 'a provider without effort must not inherit the command-line value');
  assert.equal(second.prompts.taxonomy_sha256, null, 'a taxonomy from a file has no prompt');
  assert.notEqual(second.prompts.classify_sha256, first.prompts.classify_sha256);
});

test('only the first slash separates the provider, because model names may hold one', () => {
  const ref = 'someprovider/vendor/model-1';
  const manifest = createManifest(input({ models: [{ ref, prompts: { classify: null, taxonomy: null } }], prices: { [ref]: { input: 1, output: 1 } } }));
  assert.equal(manifest.models[0].provider, 'someprovider');
  assert.equal(manifest.models[0].requested, ref);
});

test('the endpoint keeps only the origin, never credentials, paths or queries', () => {
  const manifest = createManifest(
    input({
      models: [{ ref: HAIKU, endpoint: 'http://user:secret@127.0.0.1:8123/v1/chat?key=SECRETKEY', prompts: { classify: null, taxonomy: null } }],
      prices: { [HAIKU]: { input: 1, output: 1 } },
    }),
  );
  assert.equal(manifest.models[0].endpoint, 'http://127.0.0.1:8123');
  assert.ok(!JSON.stringify(manifest).includes('SECRET'));
  assert.ok(!JSON.stringify(manifest).includes('secret'));
});

test('a dry run needs no key or endpoint', () => {
  const manifest = createManifest(
    input({
      params: { seed: 1, sample: 4, review: 2, language: 'Spanish', max_usd: 1, dry_run: true },
      models: [{ ref: HAIKU, prompts: { classify: CLASSIFY, taxonomy: TAXONOMY } }],
      prices: { [HAIKU]: { input: 1, output: 1 } },
    }),
  );
  assert.equal(manifest.models[0].endpoint, null);
  assert.equal(manifest.models[0].key_suffix, null);
  assert.equal(manifest.models[0].data_policy, null);
});

test('createManifest is pure', () => {
  const given = input({ inputBytes: 'text as read' });
  const original = structuredClone(given);
  assert.deepEqual(createManifest(given), createManifest(given));
  assert.deepEqual(given, original);
});

test('a run cannot repeat a model', () => {
  const twice = { ref: HAIKU, prompts: { classify: null, taxonomy: null } };
  assert.throws(() => createManifest(input({ models: [twice, twice], prices: { [HAIKU]: {} } })), /cannot repeat a model/);
});

test('the runs a report could not tell apart have different fingerprints', () => {
  // ARQ-1: another prompt, and the same bookmarks exported in another order, gave the same report.md.
  const base = createManifest(input());
  const otherPrompt = createManifest(
    input({
      models: input().models.map((model) => ({ ...model, prompts: { ...model.prompts, classify: { ...CLASSIFY, system: 'Sort. Never use -1.' } } })),
    }),
  );
  const reordered = createManifest(input({ inputBytes: Buffer.from('<DL><p>reordered</DL>'), sampleIds: ['b4', 'b1', 'b2', 'b3'], reviewIds: ['b4', 'b3'] }));

  assert.notEqual(otherPrompt.models[0].prompts.classify_sha256, base.models[0].prompts.classify_sha256);
  assert.equal(otherPrompt.input.sha256, base.input.sha256);
  assert.notEqual(reordered.input.sha256, base.input.sha256);
  assert.notEqual(reordered.sample_sha256, base.sample_sha256);
  assert.notEqual(reordered.review_sha256, base.review_sha256);
  assert.equal(reordered.models[0].prompts.classify_sha256, base.models[0].prompts.classify_sha256);
});

test('updateManifest returns a new state and leaves the previous one intact', () => {
  const manifest = createManifest(input());
  const snapshot = structuredClone(manifest);
  const next = updateManifest(manifest, { spentUsd: 0.25, lostUsd: 0.01, model: { requested: HAIKU, status: 'running' } });

  assert.deepEqual(manifest, snapshot);
  assert.equal(next.spent_usd, 0.25);
  assert.equal(next.lost_usd, 0.01);
  assert.equal(next.status, 'running');
  assert.equal(next.models[0].status, 'running');
  assert.equal(next.models[1].status, 'pending');
});

test('a run completes only when every model did', () => {
  let manifest = createManifest(input());
  manifest = updateManifest(manifest, { model: { requested: HAIKU, status: 'complete' } });
  assert.throws(() => updateManifest(manifest, { status: 'complete', ...FINISHED }), /every model complete/);

  manifest = updateManifest(manifest, { model: { requested: OTHER, status: 'complete' } });
  assert.throws(() => updateManifest(manifest, { status: 'complete' }), /needs finishedAt and exitCode/);
  const done = updateManifest(manifest, { status: 'complete', ...FINISHED });
  assert.equal(done.status, 'complete');
  assert.equal(done.finished_at, FINISHED.finishedAt);
  assert.equal(done.exit_code, 0);
});

test('a stopped run says why, and a finished run accepts nothing else', () => {
  const manifest = createManifest(input());
  assert.throws(() => updateManifest(manifest, { status: 'stopped', finishedAt: FINISHED.finishedAt, exitCode: 2 }), /needs the reason/);

  const stopped = updateManifest(manifest, {
    status: 'stopped',
    finishedAt: FINISHED.finishedAt,
    exitCode: 2,
    stoppedBy: `${HAIKU}: cap reached`,
    model: { requested: HAIKU, status: 'stopped', stopped_by: 'cap reached' },
  });
  assert.equal(stopped.exit_code, 2);
  assert.equal(stopped.stopped_by, `${HAIKU}: cap reached`);
  assert.equal(stopped.models[0].stopped_by, 'cap reached');
  assert.equal(stopped.models[1].status, 'pending', 'a model the stop kept from running stays pending');

  assert.throws(() => updateManifest(stopped, { status: 'running' }), /already finished as stopped/);
  assert.throws(() => updateManifest(stopped, { spentUsd: 9 }), /already finished/);
});

test('exit code 0 survives the update, since it is falsy', () => {
  let manifest = createManifest(input({ models: [{ ref: HAIKU, prompts: { classify: null, taxonomy: null } }], prices: { [HAIKU]: {} } }));
  manifest = updateManifest(manifest, { model: { requested: HAIKU, status: 'complete' } });
  assert.equal(updateManifest(manifest, { status: 'complete', finishedAt: 'now', exitCode: 0 }).exit_code, 0);
});

test('a dry run completes without calling any model', () => {
  const manifest = createManifest(input({ params: { seed: 1, sample: 4, review: 2, language: 'Spanish', max_usd: 1, dry_run: true } }));
  assert.equal(updateManifest(manifest, { status: 'complete', ...FINISHED }).status, 'complete');
});

test('an update for a model that is not in the manifest is refused', () => {
  assert.throws(() => updateManifest(createManifest(input()), { model: { requested: 'anthropic/unknown' } }), /not in this manifest/);
});

test('summarizeModel turns a ModelResult into the update for its entry', () => {
  const folders = [{ name: 'Cocina', description: 'Recetas' }];
  const patch = summarizeModel({
    model: HAIKU,
    status: 'stopped',
    folders,
    dropped: [{ name: 'A/B/C', reason: 'too_deep' }, { name: 'D/E/F', reason: 'too_deep' }, { name: 'x', reason: 'duplicate' }],
    assignments: [
      { id: 'b0', folder: 'Cocina', confidence: 'high', servedModel: 'claude-haiku-5-5', requestId: 'req_1' },
      { id: 'b1', folder: 'Cocina', confidence: 'low', servedModel: 'claude-haiku-5-5', requestId: 'req_1' },
      { id: 'b2', folder: 'Cocina', confidence: 'high', servedModel: 'fallback-model', requestId: 'req_2' },
    ],
    unclassified: [{ id: 'b3', reason: 'refusal' }, { id: 'b4', reason: 'missing' }, { id: 'b5', reason: 'missing' }],
    metrics: { inputTokens: 100, outputTokens: 50, thinkingTokens: 7, spentUsd: 0.5, lostUsd: 0.25, servedModels: { 'claude-haiku-5-5': 3, 'fallback-model': 1 } },
  });
  assert.deepEqual(patch, {
    requested: HAIKU,
    status: 'stopped',
    served: { 'claude-haiku-5-5': 2, 'fallback-model': 1 },
    answered_by: { 'claude-haiku-5-5': 3, 'fallback-model': 1 },
    taxonomy_sha256: hashTaxonomy(folders),
    dropped: { too_deep: 2, duplicate: 1 },
    classified: 3,
    unclassified: 3,
    unclassified_reasons: { refusal: 1, missing: 2 },
    input_tokens: 100,
    output_tokens: 50,
    thinking_tokens: 7,
    spent_usd: 0.5,
    lost_usd: 0.25,
  });

  const next = updateManifest(createManifest(input()), { model: patch });
  assert.equal(next.models[0].classified, 3);
  assert.equal(next.models[0].unclassified_reasons.missing, 2);
});

test('summarizeModel handles a model stopped before it had folders', () => {
  const patch = summarizeModel({
    model: HAIKU,
    status: 'stopped',
    folders: [],
    dropped: [],
    assignments: [],
    unclassified: [],
    metrics: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, spentUsd: 0 },
  });
  assert.equal(patch.taxonomy_sha256, null);
  assert.deepEqual(patch.served, {});
  assert.deepEqual(updateManifest(createManifest(input()), { model: patch }).models[0].dropped, {});
});

test('folder and model names cannot pollute a prototype', () => {
  const patch = summarizeModel({
    model: HAIKU,
    status: 'complete',
    folders: [],
    dropped: [{ reason: '__proto__' }],
    assignments: [{ servedModel: '__proto__' }],
    unclassified: [],
    metrics: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, spentUsd: 0 },
  });
  assert.equal(Object.getOwnPropertyDescriptor(patch.served, '__proto__').value, 1);
  assert.equal(Object.getPrototypeOf(patch.served), Object.prototype);
});

test('hashCodeTree follows content and names, and matches what sha256sum prints', async () => {
  const root = await mkdtemp(join(base, 'code-'));
  await mkdir(join(root, 'tools', 'lib'), { recursive: true });
  await mkdir(join(root, 'extension', 'core'), { recursive: true });
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'tools', 'eval.mjs'), 'eval');
  await writeFile(join(root, 'tools', 'lib', 'a.mjs'), 'a');
  await writeFile(join(root, 'extension', 'core', 'b.js'), 'b');
  // Listed before core/ when a directory is read level by level, and sorted after it.
  await writeFile(join(root, 'extension', 'manifest.json'), 'm');
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'tests', 'ignored.mjs'), 'tests are not what runs');

  const line = (content, path) => `${sha256(content)}  ${path}\n`;
  const expected = sha256(
    [
      line('b', 'extension/core/b.js'),
      line('m', 'extension/manifest.json'),
      line('{}', 'package-lock.json'),
      line('eval', 'tools/eval.mjs'),
      line('a', 'tools/lib/a.mjs'),
    ].join(''),
  );
  const hash = await hashCodeTree(root);
  assert.equal(hash, expected);

  // The verification command its comment promises.
  const shell = "find extension package-lock.json tools -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1";
  assert.equal(execFileSync('sh', ['-c', shell], { cwd: root, encoding: 'utf8' }).trim(), hash);

  await writeFile(join(root, 'tests', 'ignored.mjs'), 'changed');
  assert.equal(await hashCodeTree(root), hash, 'tests do not change what ran');

  await writeFile(join(root, 'tools', 'lib', 'a.mjs'), 'edited');
  const edited = await hashCodeTree(root);
  assert.notEqual(edited, hash);

  await writeFile(join(root, 'tools', 'lib', 'a.mjs'), 'a');
  assert.equal(await hashCodeTree(root), hash);
  await rm(join(root, 'tools', 'lib', 'a.mjs'));
  await writeFile(join(root, 'tools', 'lib', 'renamed.mjs'), 'a');
  assert.notEqual(await hashCodeTree(root), hash, 'a rename is a change');

  await rm(join(root, 'tools', 'lib', 'renamed.mjs'));
  await writeFile(join(root, 'tools', 'lib', 'a.mjs'), 'a');
  await symlink('/nonexistent/secret', join(root, 'tools', 'link'));
  assert.equal(await hashCodeTree(root), hash, 'a symbolic link is not followed');
});

test('hashCodeTree tolerates a missing entry', async () => {
  const root = await mkdtemp(join(base, 'code-'));
  await mkdir(join(root, 'tools'));
  await writeFile(join(root, 'tools', 'eval.mjs'), 'eval');
  assert.equal(await hashCodeTree(root), sha256(`${sha256('eval')}  tools/eval.mjs\n`));
});

test('describeTool reads versions instead of assuming them', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const tool = await describeTool();
  const { version } = JSON.parse(await readFile(join(root, 'node_modules/@anthropic-ai/sdk/package.json'), 'utf8'));
  assert.equal(tool.anthropic_sdk, version);
  assert.equal(tool.node, process.versions.node);
  assert.match(tool.code_sha256, /^[0-9a-f]{64}$/);

  const empty = await mkdtemp(join(base, 'no-sdk-'));
  assert.equal((await describeTool(empty)).anthropic_sdk, null);
});

test('a manifest survives a round trip on disk, owner-only and rewritable', async () => {
  const dir = await mkdtemp(join(base, 'run-'));
  const manifest = createManifest(input({ quality: { total: 10 } }));
  await writeManifest(dir, manifest);

  const path = join(dir, MANIFEST_FILE);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readManifest(path), manifest);
  assert.ok((await readFile(path, 'utf8')).endsWith('}\n'));

  const next = updateManifest(manifest, { spentUsd: 0.5 });
  await writeManifest(dir, next);
  assert.equal((await readManifest(path)).spent_usd, 0.5);
  assert.equal((await readManifest(path)).schema, MANIFEST_SCHEMA);
});

test('readManifest refuses what is not a manifest of this version', async () => {
  const dir = await mkdtemp(join(base, 'run-'));
  const other = join(dir, 'other.json');
  await writeFile(other, JSON.stringify({ schema: 'bookmark-genie/run-manifest@2' }));
  await assert.rejects(readManifest(other), /is not a bookmark-genie\/run-manifest@1 file \(schema: "bookmark-genie\/run-manifest@2"\)/);
  await writeFile(other, '[]');
  await assert.rejects(readManifest(other), /is not a/);
  await writeFile(other, 'null');
  await assert.rejects(readManifest(other), /is not a/);
  await writeFile(other, '{broken');
  await assert.rejects(readManifest(other), SyntaxError);
  await assert.rejects(readManifest(join(dir, 'missing.json')), { code: 'ENOENT' });
});

test('nothing in a manifest can hold more than the end of a key', () => {
  const key = 'sk-ant-api03-THISISTHEWHOLESECRETKEY0123';
  const manifest = createManifest(
    input({ models: [{ ref: HAIKU, keySuffix: keySuffix(key), prompts: { classify: null, taxonomy: null } }], prices: { [HAIKU]: {} } }),
  );
  assert.equal(manifest.models[0].key_suffix, '0123');
  assert.ok(!JSON.stringify(manifest).includes('THISISTHEWHOLESECRET'));
});

test('assessCompleteness: only missing indices and unattempted rows block M0', () => {
  const entry = (/** @type {number} */ classified, /** @type {number} */ unclassified, /** @type {Record<string, number>} */ reasons) => ({
    classified,
    unclassified,
    unclassified_reasons: reasons,
  });
  assert.deepEqual(assessCompleteness(entry(100, 0, {}), 100), { missing: 0, notAttempted: 0, unclassifiedShare: 0, complete: true });
  // Refusals and truncations are a share for `score` to weigh, not a missing index.
  assert.deepEqual(assessCompleteness(entry(98, 2, { refusal: 1, truncated: 1 }), 100), { missing: 0, notAttempted: 0, unclassifiedShare: 0.02, complete: true });
  assert.deepEqual(assessCompleteness(entry(97, 3, { missing: 1, refusal: 2 }), 100), { missing: 1, notAttempted: 0, unclassifiedShare: 0.03, complete: false });
  assert.deepEqual(assessCompleteness(entry(40, 0, {}), 100), { missing: 0, notAttempted: 60, unclassifiedShare: 0, complete: false });
  assert.deepEqual(assessCompleteness(entry(0, 0, {}), 0), { missing: 0, notAttempted: 0, unclassifiedShare: 0, complete: true });
});

test('the budget facts of a run reach the manifest: lost money per model, and a broken cap', () => {
  const broken = { model: HAIKU, max_tokens: 100, output_tokens: 5000 };
  const next = updateManifest(createManifest(input()), { capBrokenBy: broken, model: { requested: HAIKU, lost_usd: 0.3 } });
  assert.deepEqual(next.cap_broken_by, broken);
  assert.equal(next.models[0].lost_usd, 0.3);
  assert.equal(createManifest(input()).cap_broken_by, null);
  assert.deepEqual(updateManifest(next, { spentUsd: 1 }).cap_broken_by, broken);
});
