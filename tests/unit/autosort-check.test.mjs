import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAutoSortRequest } from '../../extension/core/autosort.js';
import { buildCases, contextFor, excludedFolderIds, judge, recommend, summarize, wilson } from '../../tools/lib/autosort-check.mjs';
import { parseNetscapeTree } from '../../tools/lib/netscape.mjs';
import { startFakeOpenAi } from '../helpers/fake-openai.mjs';

const EVAL = fileURLToPath(new URL('../../tools/eval.mjs', import.meta.url));
const MODEL = 'gemini/gemini-3.5-flash-lite';
const KEY = 'test-key-0123456789';
const SCRUBBED = [/^ANTHROPIC_/, /^OPENAI_/, /^GEMINI_/, /^MISTRAL_/, /^XAI_/, /^DEEPSEEK_/, /^PERPLEXITY_/, /^CLAUDE_/];
/** What must never leave: private hosts and everything inside the excluded folder. */
const NEVER_SENT = ['192.168', 'nas.local', '10.0.0.5', 'clinica', 'SECRETO', 'Privado', 'Interno', 'comedor'];

/** The owner's bar: folders first (DBT is folder 0), loose AI bookmarks, a private one, an excluded folder. */
const OWNER = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Barra de marcadores</H3>
<DL><p>
<DT><H3 ADD_DATE="1700000000">DBT</H3>
<DL><p>
<DT><A HREF="https://docs.getdbt.com/docs/build/incremental-models" ADD_DATE="1700000100">Incremental models | dbt Developer Hub</A>
<DT><A HREF="https://www.getdbt.com/blog" ADD_DATE="1700000200">dbt Labs blog</A>
<DT><A HREF="https://docs.getdbt.com/reference/commands/run" ADD_DATE="1700000300">dbt run | dbt Developer Hub</A>
</DL><p>
<DT><H3 ADD_DATE="1700000000">Libros de Cocina</H3>
<DL><p>
<DT><A HREF="https://recetas.example.com/arepas" ADD_DATE="1700000400">Arepas reina pepiada</A>
<DT><A HREF="https://cocina.example.org/pan" ADD_DATE="1700000500">Pan de masa madre</A>
<DT><H3 ADD_DATE="1700000000">Interno</H3>
<DL><p>
<DT><A HREF="https://comedor.example.net/menu" ADD_DATE="1700000550">Menú del comedor</A>
</DL><p>
</DL><p>
<DT><H3 ADD_DATE="1700000000">Sitios locales</H3>
<DL><p>
<DT><A HREF="http://192.168.1.1/" ADD_DATE="1700000600">Router</A>
<DT><A HREF="http://nas.local:5000/" ADD_DATE="1700000700">NAS</A>
</DL><p>
<DT><H3 ADD_DATE="1700000000">Privado</H3>
<DL><p>
<DT><A HREF="https://clinica.example.com/resultados" ADD_DATE="1700000800">Resultados SECRETO</A>
</DL><p>
<DT><A HREF="https://claude.ai/" ADD_DATE="1700001000">Claude</A>
<DT><A HREF="https://chatgpt.com/" ADD_DATE="1700001100">ChatGPT</A>
<DT><A HREF="https://gemini.google.com/" ADD_DATE="1700001200">Gemini</A>
<DT><A HREF="https://notebooklm.google.com/" ADD_DATE="1700001300">NotebookLM</A>
<DT><A HREF="http://10.0.0.5:3000/d/x" ADD_DATE="1700001400">Grafana casa</A>
</DL><p>
<DT><H3 ADD_DATE="1700000000">Servicios</H3>
<DL><p>
<DT><A HREF="https://mail.google.com/mail/u/0/" ADD_DATE="1700000900">Gmail</A>
<DT><A HREF="https://banco.example.com/login" ADD_DATE="1700000950">Banco en línea</A>
</DL><p>
</DL><p>
`;
const EXCLUDE = ['^Privado$', 'Cocina/Interno'];

let workDir;
let ownerPath;
let onlyFolderPath;
let counter = 0;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'bookmark-genie-autosort-check-'));
  ownerPath = join(workDir, 'owner.html');
  await writeFile(ownerPath, OWNER);
  // A single folder: removing it leaves no folder, and the fake then proposes a new one.
  onlyFolderPath = join(workDir, 'only.html');
  await writeFile(
    onlyFolderPath,
    `<DL><p><DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Barra</H3><DL><p><DT><H3>IA</H3><DL><p>
    <DT><A HREF="https://claude.ai/" ADD_DATE="1">Claude</A><DT><A HREF="https://chatgpt.com/" ADD_DATE="2">ChatGPT</A>
    </DL><p></DL><p></DL><p>`,
  );
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const newOut = () => join(workDir, `out-${(counter += 1)}`);

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>}
 */
function runEval(args, env = {}) {
  return new Promise((resolve) => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !SCRUBBED.some((pattern) => pattern.test(name))));
    const child = spawn(process.execPath, [EVAL, 'autosort-check', ...args], { env: { ...inherited, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const ownerCases = (seed = 1, maxCases = 60) => {
  const parsed = parseNetscapeTree(OWNER);
  const { ids } = excludedFolderIds(parsed.tree, EXCLUDE.map((source) => new RegExp(source, 'iu')));
  return buildCases(parsed, { excludedIds: ids, context: 'full', seed, maxCases });
};

test('Wilson interval: the bounds IA-12 relies on', () => {
  const all15 = wilson(15, 15);
  assert.ok(Math.abs(all15.low - 15 / (15 + 1.96 ** 2)) < 1e-9, 'n of n has the lower bound n / (n + z²)');
  assert.equal(all15.high, 1);
  assert.ok(wilson(73, 73).low >= 0.95 && wilson(72, 72).low < 0.95, '73 clean cases are the first to reach 95 %');
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
  const half = wilson(5, 10);
  assert.ok(half.low < 0.5 && half.high > 0.5 && Math.abs(0.5 - half.low - (half.high - 0.5)) < 1e-9);
});

test('cases of the owner bar: the three kinds, with what the extension would skip', () => {
  const { cases, available, skipped } = ownerCases();
  assert.deepEqual(available, { loo: 7, ablation: 3, loose: 4 });
  assert.equal(cases.length, 14);
  assert.deepEqual(skipped, { 'loo: excluded-folder': 2, 'loo: private-host': 2, 'loose: private-host': 1, 'ablation: fewer than 2 sendable': 1 });

  const loo = /** @type {any} */ (cases.find((item) => item.type === 'loo' && item.bookmark.title === 'dbt Labs blog'));
  assert.equal(loo.parentId, '1', 'saved again in the bar, as Ctrl+D');
  assert.deepEqual(loo.expected.folderName, 'DBT');
  const dbt = loo.folders.find((/** @type {any} */ folder) => folder.name === 'DBT');
  assert.ok(!dbt.examples.includes('dbt Labs blog'), 'the bookmark is no longer an example of its folder');
  assert.deepEqual(loo.loose.map((/** @type {any} */ item) => item.title), ['Claude', 'ChatGPT', 'Gemini', 'NotebookLM']);

  const ablation = /** @type {any} */ (cases.find((item) => item.type === 'ablation' && item.expected.removedFolder === 'DBT'));
  assert.ok(!ablation.folders.some((/** @type {any} */ folder) => folder.name === 'DBT'), 'the removed folder is not offered');
  assert.equal(ablation.expected.members.length, 2, 'the other two dbt bookmarks are loose and expected together');
  for (const id of ablation.expected.members) assert.ok(ablation.loose.some((/** @type {any} */ item) => item.id === id));

  assert.ok(cases.filter((item) => item.type === 'loose').every((item) => item.expected === null && item.parentId === '1'));
  // The selection is seeded: the same seed gives the same cases.
  assert.deepEqual(ownerCases(7).cases.map((item) => item.id), ownerCases(7).cases.map((item) => item.id));
});

test('nothing private or excluded reaches a request, not even when its folder is removed', () => {
  const { cases } = ownerCases();
  const cocina = /** @type {any} */ (cases.find((item) => item.type === 'ablation' && item.expected.removedFolder === 'Libros de Cocina'));
  assert.ok(cocina, 'the folder that holds the excluded subfolder is still measured');
  for (const item of cases) {
    const { user } = buildAutoSortRequest({ bookmark: item.bookmark, folders: item.folders, loose: item.loose });
    for (const forbidden of NEVER_SENT) assert.ok(!user.includes(forbidden), `${item.id} sends ${forbidden}`);
  }
});

test('the context refuses what the extension would not send', () => {
  const parsed = parseNetscapeTree(OWNER);
  const { ids } = excludedFolderIds(parsed.tree, EXCLUDE.map((source) => new RegExp(source, 'iu')));
  const find = (/** @type {string} */ title) => {
    const pending = [...parsed.tree];
    while (pending.length > 0) {
      const node = /** @type {any} */ (pending.pop());
      if (node.title === title) return node.id;
      pending.push(...(node.children ?? []));
    }
    throw new Error(title);
  };
  assert.deepEqual(contextFor(parsed.tree, find('Resultados SECRETO'), { excludedIds: ids, context: 'full' }), { skip: 'excluded-folder' });
  assert.deepEqual(contextFor(parsed.tree, find('Grafana casa'), { excludedIds: ids, context: 'full' }), { skip: 'private-host' });
  const only = /** @type {any} */ (contextFor(parsed.tree, find('Claude'), { excludedIds: ids, context: 'bookmark-only' }));
  assert.deepEqual(only.loose, [], 'the "bookmark only" setting sends no loose ones');
  assert.ok(only.folders.every((/** @type {any} */ folder) => folder.examples.length === 0), 'and no examples');
});

test('max-cases keeps leave-one-out as the bulk and gives the rest to the other kinds', () => {
  const { cases } = ownerCases(1, 8);
  const count = (/** @type {string} */ type) => cases.filter((item) => item.type === type).length;
  assert.equal(cases.length, 8);
  assert.deepEqual([count('loo'), count('ablation'), count('loose')], [4, 2, 2]);
});

test('judging: the right folder, a forced folder, and loose ones that are not scored', () => {
  const { cases } = ownerCases();
  const loo = /** @type {any} */ (cases.find((item) => item.type === 'loo' && item.expected.folderName === 'DBT'));
  const target = loo.folders.find((/** @type {any} */ folder) => folder.name === 'DBT');
  const other = loo.folders.find((/** @type {any} */ folder) => folder.name === 'Servicios');
  assert.equal(judge(loo, { kind: 'existing', folder: target, confidence: 'high' }).correct, true);
  assert.equal(judge(loo, { kind: 'existing', folder: other, confidence: 'low' }).correct, false);
  assert.equal(judge(loo, { kind: 'new', name: 'Datos', description: '', together: [] }).correct, false);
  assert.equal(judge(loo, { kind: 'left', reason: 'no-topic' }).label, 'none');
  assert.equal(judge(loo, { kind: 'left', reason: 'truncated' }).label, 'invalid');

  const ablation = /** @type {any} */ (cases.find((item) => item.type === 'ablation'));
  assert.equal(judge(ablation, { kind: 'new', name: 'dbt', description: '', together: [] }).correct, true);
  assert.equal(judge(ablation, { kind: 'existing', folder: ablation.folders[0], confidence: 'high' }).correct, false);
  const loose = /** @type {any} */ (cases.find((item) => item.type === 'loose'));
  assert.equal(judge(loose, { kind: 'new', name: 'IA', description: '', together: [] }).correct, null);
});

/**
 * @param {string} caseId
 * @param {'loo' | 'ablation' | 'loose'} type
 * @param {any} fields
 */
const call = (caseId, type, fields, repeat = 1) => ({ case: caseId, type, repeat, latencyMs: 1000, ...fields });

test('summary and rule: a wrong high keeps confirming, few clean cases keep confirming, many activate', () => {
  /** @type {any[]} */
  const cases = [
    { id: 'loo:1', type: 'loo', expected: { folderId: 'a', folderName: 'A' } },
    { id: 'loo:2', type: 'loo', expected: { folderId: 'b', folderName: 'B' } },
    { id: 'ablation:1', type: 'ablation', expected: { removedFolder: 'IA', members: ['m1', 'm2'] } },
  ];
  const records = [
    call('loo:1', 'loo', { label: 'existing-high', folderId: 'a', correct: true }),
    call('loo:1', 'loo', { label: 'existing-high', folderId: 'a', correct: true }, 2),
    call('loo:2', 'loo', { label: 'existing-low', folderId: 'x', correct: false }),
    call('loo:2', 'loo', { label: 'existing-low', folderId: 'x', correct: false }, 2),
    call('ablation:1', 'ablation', { label: 'new', name: 'IA y LLM', together: ['m1', 'z'], correct: true }),
    call('ablation:1', 'ablation', { label: 'existing-high', folderId: 'a', correct: false }, 2),
  ];
  const summary = summarize(cases, records);
  assert.equal(summary.byLabel['existing-high'].calls, 3);
  assert.equal(summary.byLabel['existing-high'].correct, 2);
  assert.equal(summary.byLabel['existing-high'].cases, 2, 'the interval counts cases, not calls');
  assert.equal(summary.calibration.high, 2 / 3);
  assert.equal(summary.calibration.low, 0);
  assert.deepEqual([summary.forced.hits, summary.forced.calls], [1, 2]);
  assert.deepEqual([summary.newWhenRemoved.hits, summary.newWhenRemoved.calls], [1, 2]);
  assert.equal(summary.together.precision, 0.5);
  assert.equal(summary.together.recall, 0.5);
  assert.deepEqual(summary.sameName, { hits: 1, of: 1 }, 'IA is a word of the proposed name');
  const inside = summarize(cases, [call('ablation:1', 'ablation', { label: 'new', name: 'Inteligencia artificial', together: [], correct: true })]);
  assert.deepEqual(inside.sameName, { hits: 0, of: 1 }, 'a name is matched by words, not by letters inside a word');
  assert.deepEqual(summary.stability, { stable: 2, repeated: 3, unstableHigh: ['ablation:1'] });
  const wrong = recommend(summary);
  assert.equal(wrong.decision, 'keep-confirming');
  assert.match(wrong.line, /1 de 3 respuestas «existing high» fueron incorrectas/);

  const clean = summarize(cases.slice(0, 1), records.slice(0, 2));
  const few = recommend(clean);
  assert.equal(few.decision, 'keep-confirming');
  assert.match(few.line, /harían falta al menos 73 casos/);

  const many = Array.from({ length: 73 }, (_, i) => ({ id: `loo:${i}`, type: 'loo', expected: { folderId: 'a', folderName: 'A' } }));
  const activate = recommend(summarize(/** @type {any} */ (many), many.map((item) => call(item.id, 'loo', { label: 'existing-high', folderId: 'a', correct: true }))));
  assert.equal(activate.decision, 'activate');
  const thirty = many.slice(0, 30);
  const short = recommend(summarize(/** @type {any} */ (thirty), thirty.map((item) => call(item.id, 'loo', { label: 'existing-high', folderId: 'a', correct: true }))));
  assert.equal(short.decision, 'keep-confirming', '30 clean cases give a lower bound near 89 %, below the 95 % of IA-12');

  // Right every time, but a different folder on the second call: the confidence is not stable.
  const two = [{ id: 'loo:1', type: 'loo', expected: { folderId: 'a', folderName: 'A' } }];
  const wobbly = summarize(/** @type {any} */ (two), [
    call('loo:1', 'loo', { label: 'existing-high', folderId: 'a', correct: true }),
    call('loo:1', 'loo', { label: 'existing-low', folderId: 'a', correct: true }, 2),
  ]);
  assert.deepEqual(wobbly.wrongHigh, []);
  assert.match(recommend(wobbly).line, /1 caso con «high» cambió de respuesta/);
  assert.equal(recommend(summarize([], [])).decision, 'keep-confirming');
});

test('dry run: needs no key, sends nothing, writes private files and the estimate', async () => {
  const fake = await startFakeOpenAi({ dialect: 'gemini' });
  const out = newOut();
  const args = ['--input', ownerPath, '--models', MODEL, '--out', out, '--dry-run', ...EXCLUDE.flatMap((source) => ['--exclude-folder', source])];
  const { code, stdout, stderr } = await runEval(args, { GEMINI_BASE_URL: fake.baseURL });
  await fake.close();
  assert.equal(code, 0, stderr);
  assert.equal(fake.requests.length, 0);
  assert.match(stdout, /Casos: dejar uno fuera 7 de 7, quitar carpeta 3 de 3, sueltos 4 de 4\. Repeticiones: 3\. Llamadas: 42/);
  assert.match(stdout, /US\$\d+\.\d{4} a tarifa de pago/);
  assert.match(stdout, /needs your explicit consent/);
  const preview = await readFile(join(out, 'requests-preview.jsonl'), 'utf8');
  assert.equal(preview.trim().split('\n').length, 14);
  for (const forbidden of NEVER_SENT) assert.ok(!preview.includes(forbidden), forbidden);
  assert.equal((await stat(out)).mode & 0o077, 0);
  for (const name of await readdir(out)) assert.equal((await stat(join(out, name))).mode & 0o077, 0, `${name} must be private`);
});

test('a real run against the Gemini fake: the extension request, scored, with the rule and the recommendation', async () => {
  // The fake always answers folder 0 with high confidence: right for DBT, forced everywhere else.
  const fake = await startFakeOpenAi({ dialect: 'gemini', rateLimitFirst: 1, retryAfter: '0' });
  const out = newOut();
  const args = ['--input', ownerPath, '--models', MODEL, '--out', out, '--repeat', '2', '--pause', '0', '--accept-data-policy', 'gemini', ...EXCLUDE.flatMap((source) => ['--exclude-folder', source])];
  const { code, stdout, stderr } = await runEval(args, { GEMINI_BASE_URL: fake.baseURL, GEMINI_API_KEY: KEY });
  await fake.close();
  assert.equal(code, 0, stderr);

  const completions = fake.requests.filter((request) => request.url?.endsWith('/chat/completions'));
  assert.equal(completions.length, 14 * 2 + 1, 'every case twice, plus the call the 429 made repeat');
  const { system, schema } = buildAutoSortRequest({ bookmark: { title: '', url: '' }, folders: [], loose: [] });
  for (const { body } of completions) {
    assert.equal(body.model, 'gemini-3.5-flash-lite');
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.messages[0].content, system, 'the system prompt is the extension one');
    assert.deepEqual(body.response_format.json_schema.schema, schema);
    for (const forbidden of NEVER_SENT) assert.ok(!JSON.stringify(body).includes(forbidden), forbidden);
  }

  const report = await readFile(join(out, 'report.md'), 'utf8');
  assert.match(report, /\| `existing high` \| 20 \| 6 \| 10 \|/, '3 DBT cases right twice; 4 other loo and 3 ablations wrong');
  assert.match(report, /\*\*Forzadas\*\* \(`existing high` cuando la carpeta se quitó\): 6 de 6/);
  assert.match(report, /\*\*Recomendación:\*\* Seguir confirmando: 14 de 20 respuestas «existing high» fueron incorrectas/);
  assert.match(report, /\*\*Regla:\*\* Activar el modo automático solo si/);
  assert.match(stdout, /Recomendación:\*\* Seguir confirmando/);
  assert.match(stdout, /Informe: /);
  const answers = (await readFile(join(out, 'answers-gemini__gemini-3.5-flash-lite.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(answers.length, 28);
  const review = await readFile(join(out, 'review-gemini__gemini-3.5-flash-lite.csv'), 'utf8');
  assert.match(review, /^"judgment","case","type","title","url","expected","answers"\n/);
  const manifest = JSON.parse(await readFile(join(out, 'check-manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'bookmark-genie/autosort-check@1');
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.results[0].decision, 'keep-confirming');
  for (const name of await readdir(out)) assert.equal((await stat(join(out, name))).mode & 0o077, 0, `${name} must be private`);
});

test('a removed folder that leaves nothing else: the fake proposes a new folder, counted as right', async () => {
  const fake = await startFakeOpenAi({ dialect: 'gemini' });
  const out = newOut();
  const { code, stderr } = await runEval(['--input', onlyFolderPath, '--models', MODEL, '--out', out, '--repeat', '1', '--pause', '0', '--accept-data-policy', 'gemini'], { GEMINI_BASE_URL: fake.baseURL, GEMINI_API_KEY: KEY });
  await fake.close();
  assert.equal(code, 0, stderr);
  const report = await readFile(join(out, 'report.md'), 'utf8');
  assert.match(report, /\*\*Carpetas nuevas bien propuestas\*\* \(al quitar una carpeta\): 1 de 1/);
  assert.match(report, /Sueltos reunidos: precisión —, exhaustividad 0,0 % \(0 propuestos, 1 esperados\)/);
});

test('refusals before anything is sent: consent, provider the extension lacks, bad options', async () => {
  const fake = await startFakeOpenAi({ dialect: 'gemini' });
  const noConsent = await runEval(['--input', ownerPath, '--models', MODEL, '--out', newOut(), '--pause', '0'], { GEMINI_BASE_URL: fake.baseURL, GEMINI_API_KEY: KEY });
  assert.equal(noConsent.code, 1);
  assert.match(noConsent.stderr, /--accept-data-policy gemini/);
  const noKey = await runEval(['--input', ownerPath, '--models', MODEL, '--out', newOut(), '--accept-data-policy', 'gemini'], { GEMINI_BASE_URL: fake.baseURL });
  assert.equal(noKey.code, 1);
  assert.match(noKey.stderr, /GEMINI_API_KEY is not set/);
  assert.equal(fake.requests.length, 0);
  await fake.close();

  const claude = await runEval(['--input', ownerPath, '--models', 'anthropic/claude-haiku-5-5', '--dry-run']);
  assert.equal(claude.code, 1);
  assert.match(claude.stderr, /does not send to anthropic\/claude-haiku-5-5 yet/);
  const context = await runEval(['--input', ownerPath, '--models', MODEL, '--dry-run', '--context', 'some']);
  assert.match(context.stderr, /--context must be full or bookmark-only/);
  const repeat = await runEval(['--input', ownerPath, '--models', MODEL, '--dry-run', '--repeat', '0']);
  assert.match(repeat.stderr, /--repeat must be a whole number of at least 1/);
  const typo = await runEval(['--input', ownerPath, '--models', MODEL, '--out', newOut(), '--accept-data-policy', 'gemini', '--exclude-folder', 'Privadoo'], { GEMINI_API_KEY: KEY });
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /matches no folder.*Nothing was sent/);
});

test('the export as a tree: bar and Other roots, empty folders kept, dates and positions', async () => {
  const html = await readFile(fileURLToPath(new URL('../fixtures/chrome-real-export.html', import.meta.url)), 'utf8');
  const { tree, hasBar } = parseNetscapeTree(html);
  assert.equal(hasBar, true);
  const [bar, other] = /** @type {any[]} */ (tree[0].children);
  assert.deepEqual([bar.folderType, other.folderType], ['bookmarks-bar', 'other']);
  assert.deepEqual(bar.children.map((/** @type {any} */ node) => node.title), ['In the bar', 'Work']);
  assert.deepEqual(other.children.map((/** @type {any} */ node) => node.title), ['Loose in Other', 'Work', 'Phone reads', 'Loose in Mobile']);
  assert.equal(bar.children[0].dateAdded, 1_700_000_000_000);
  assert.deepEqual(other.children.map((/** @type {any} */ node) => node.index), [0, 1, 2, 3]);
  assert.equal(bar.children[1].children[0].parentId, bar.children[1].id);

  const malformed = parseNetscapeTree(await readFile(fileURLToPath(new URL('../fixtures/malformed-unclosed.html', import.meta.url)), 'utf8'));
  assert.equal(malformed.hasBar, false);
  const loose = /** @type {any[]} */ (malformed.tree[0].children?.[1].children);
  assert.deepEqual(loose.map((node) => [node.title, node.url === undefined ? (node.children ?? []).length : 'link']), [['fine', 'link'], ['no list after', 0], ['after the folder', 'link']]);
});
