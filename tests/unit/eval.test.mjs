import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../../tools/lib/csv.mjs';
import { startFakeClaude } from '../helpers/fake-claude.mjs';
import { startFakeOpenAi } from '../helpers/fake-openai.mjs';

const EVAL = fileURLToPath(new URL('../../tools/eval.mjs', import.meta.url));
const HAIKU = 'anthropic/claude-haiku-5-5';
const OPUS = 'anthropic/claude-opus-5-5';
const GPT = 'openai/gpt-6-luna';
const KEY = 'test-key-0123456789';

/** Everything that could hand the CLI a credential or a destination other than the test's. */
const SCRUBBED = [
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^GEMINI_/,
  /^MISTRAL_/,
  /^XAI_/,
  /^DEEPSEEK_/,
  /^PERPLEXITY_/,
  /^CLAUDE_/,
];

let workDir;
let exportPath;
let bigExportPath;
let counter = 0;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'bookmark-genie-eval-'));
  exportPath = join(workDir, 'bookmarks.html');
  const links = Array.from(
    { length: 60 },
    (_, i) => `<DT><A HREF="https://example.com/post-${i}?token=TOPSECRET${i}" ADD_DATE="1">Doc ${String(i).padStart(4, '0')} zeta</A>`,
  ).join('\n');
  await writeFile(
    exportPath,
    `<DL><p><DT><H3>Barra</H3><DL><p>
    <DT><H3>Libros</H3><DL><p>${links}</DL><p>
    <DT><A HREF="http://192.168.1.10/admin">Router privado</A>
    <DT><A HREF="https://laptop.tail1234.ts.net/x">Tailnet privado</A>
    <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
    </DL><p></DL><p>`,
  );
  bigExportPath = join(workDir, 'big.html');
  const many = Array.from({ length: 220 }, (_, i) => `<DT><A HREF="https://example.com/p${i}">Gran ${String(i).padStart(4, '0')} eta</A>`).join('\n');
  await writeFile(bigExportPath, `<DL><p><DT><H3>Barra</H3><DL><p><DT><H3>Cosas</H3><DL><p>${many}</DL><p></DL><p></DL><p>`);
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** @returns {string} a path that does not exist yet */
const newOut = () => join(workDir, `out-${(counter += 1)}`);

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @param {{onStderr?: (text: string, child: import('node:child_process').ChildProcess) => void}} [hooks]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>}
 */
function runEval(args, env = {}, hooks = {}) {
  return new Promise((resolve) => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !SCRUBBED.some((pattern) => pattern.test(name))));
    const child = spawn(process.execPath, [EVAL, ...args], { env: { ...inherited, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      hooks.onStderr?.(stderr, child);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** @param {{requests: {body: any}[]}} fake */
const sentText = (fake) => JSON.stringify(fake.requests.map((request) => request.body));

/** The request that asks for folders: its schema is the only one with a `folders` array. */
const isTaxonomyRequest = (/** @type {{body: any}} */ request) => /"folders":\{"type":"array"/.test(JSON.stringify(request.body));

/** @param {string} dir */
async function readJson(dir, name) {
  return JSON.parse(await readFile(join(dir, name), 'utf8'));
}

test('help lists the options and the known models; no arguments is an error', async () => {
  const help = await runEval(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--max-usd/);
  assert.match(help.stdout, /--accept-data-policy/);
  assert.match(help.stdout, /anthropic\/claude-haiku-5-5/);
  assert.equal((await runEval(['-h'])).code, 0);

  const bare = await runEval([]);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /No command given/);
});

test('dry run sends nothing, needs no key and writes a preview that holds nothing it must not', async () => {
  const fake = await startFakeClaude();
  const out = newOut();
  const { code, stdout, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out, '--dry-run'], { ANTHROPIC_BASE_URL: fake.baseURL });
  await fake.close();

  assert.equal(code, 0, stderr);
  assert.equal(fake.requests.length, 0);
  assert.match(stdout, /Never sent: 3 \(private-host: 2, unsupported-scheme: 1\)/);
  assert.match(stdout, /nothing was sent/);
  assert.match(stdout, /Anthropic: trains by default: no/);
  assert.doesNotMatch(stdout, /Exact payload/);

  const preview = await readFile(join(out, 'payload-preview.jsonl'), 'utf8');
  const rows = preview.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(rows.length > 0);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'in_review', 'in_taxonomy_sample', 'title', 'url']);
  for (const forbidden of ['TOPSECRET', '192.168', 'ts.net', 'javascript']) assert.ok(!preview.includes(forbidden), forbidden);
  assert.ok(rows.some((row) => row.in_taxonomy_sample) && rows.some((row) => row.in_review));
  assert.deepEqual(await readJson(out, 'existing-folders.json'), ['Barra/Libros']);

  const manifest = await readJson(out, 'manifest.json');
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.params.dry_run, true);
  for (const name of await readdir(out)) assert.equal((await stat(join(out, name))).mode & 0o077, 0, `${name} must be private`);
});

test('dry run without models only estimates tokens', async () => {
  const { code, stdout } = await runEval(['run', '--input', exportPath, '--out', newOut(), '--dry-run']);
  assert.equal(code, 0);
  assert.match(stdout, /Estimated tokens/);
});

test('two providers in one run, each with its own key and a private, reviewable output', async () => {
  const claude = await startFakeClaude();
  const openai = await startFakeOpenAi({ dialect: 'openai' });
  const out = newOut();
  const { code, stdout, stderr } = await runEval(
    ['run', '--input', exportPath, '--models', `${HAIKU},${GPT}`, '--out', out, '--review', '10'],
    { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: claude.baseURL, OPENAI_API_KEY: `${KEY}-openai`, OPENAI_BASE_URL: openai.baseURL },
  );
  const sent = sentText(claude) + sentText(openai);
  await claude.close();
  await openai.close();
  assert.equal(code, 0, stderr);

  assert.ok(claude.requests.length > 0 && openai.requests.length > 0);
  // The SDK may send the key as x-api-key or as a bearer token; either way it is this one.
  assert.ok(claude.requests.every((request) => (request.headers['x-api-key'] ?? request.headers.authorization).includes(KEY)));
  assert.ok(openai.requests.every((request) => request.headers.authorization === `Bearer ${KEY}-openai`));
  for (const forbidden of ['TOPSECRET', 'Router privado', 'Bookmarklet', 'Tailnet']) assert.ok(!sent.includes(forbidden), forbidden);

  const files = await readdir(out);
  for (const expected of [
    'manifest.json',
    'report.md',
    'payload-preview.jsonl',
    'existing-folders.json',
    'review-anthropic__claude-haiku-5-5.csv',
    'review-openai__gpt-6-luna.csv',
    'assignments-anthropic__claude-haiku-5-5.jsonl',
    'assignments-openai__gpt-6-luna.jsonl',
    'taxonomy-anthropic__claude-haiku-5-5.json',
    'taxonomy-openai__gpt-6-luna.json',
  ]) {
    assert.ok(files.includes(expected), `${expected} missing`);
    assert.equal((await stat(join(out, expected))).mode & 0o077, 0, `${expected} must be private`);
  }

  const haiku = parseCsv(await readFile(join(out, 'review-anthropic__claude-haiku-5-5.csv'), 'utf8'));
  const gpt = parseCsv(await readFile(join(out, 'review-openai__gpt-6-luna.csv'), 'utf8'));
  assert.equal(haiku.length, 10);
  assert.deepEqual(Object.keys(haiku[0]), ['judgment', 'id', 'title', 'url', 'original_folder', 'assigned_folder', 'confidence']);
  assert.deepEqual(haiku.map((row) => row.id), gpt.map((row) => row.id), 'both models are judged on the same bookmarks');

  const manifest = await readJson(out, 'manifest.json');
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.exit_code, 0);
  assert.deepEqual(manifest.models.map((model) => [model.requested, model.status]), [[HAIKU, 'complete'], [GPT, 'complete']]);
  assert.equal(manifest.models[0].key_suffix, KEY.slice(-4));
  assert.ok(manifest.models.every((model) => model.endpoint.startsWith('http://127.0.0.1:')));

  const report = await readFile(join(out, 'report.md'), 'utf8');
  assert.match(report, /## anthropic\/claude-haiku-5-5/);
  assert.match(report, /## openai\/gpt-6-luna/);
  assert.match(stdout, new RegExp(`Destination: ${HAIKU} -> http://127\\.0\\.0\\.1:\\d+ \\(key ending ${KEY.slice(-4)}\\)`));
  assert.match(stdout, /Total spent/);
  assert.doesNotMatch(stdout + stderr, new RegExp(KEY));
});

test('a model that fails does not stop the others, and the run exits 1', async () => {
  const claude = await startFakeClaude({ rejectModel: 'claude-haiku-5-5' });
  const openai = await startFakeOpenAi({ dialect: 'openai' });
  const out = newOut();
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', `${HAIKU},${GPT}`, '--out', out], {
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: claude.baseURL,
    OPENAI_API_KEY: `${KEY}-openai`,
    OPENAI_BASE_URL: openai.baseURL,
  });
  await claude.close();
  await openai.close();

  assert.equal(code, 1);
  assert.match(stderr, /Stopped early\. anthropic\/claude-haiku-5-5/);
  const files = await readdir(out);
  assert.ok(files.includes('review-openai__gpt-6-luna.csv'));
  assert.ok(!files.includes('review-anthropic__claude-haiku-5-5.csv'));
  const manifest = await readJson(out, 'manifest.json');
  assert.equal(manifest.status, 'stopped');
  assert.equal(manifest.exit_code, 1);
  assert.deepEqual(manifest.models.map((model) => model.status), ['stopped', 'complete']);
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /## openai\/gpt-6-luna/);
});

test('the spending cap stops the run before crossing it and keeps what was paid for', async () => {
  const claude = await startFakeClaude({ usage: { input_tokens: 1000, output_tokens: 1000 } });
  const out = newOut();
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', `${HAIKU},${OPUS}`, '--out', out, '--max-usd', '0.02'], {
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: claude.baseURL,
  });
  await claude.close();

  assert.equal(code, 2);
  assert.match(stderr, /could exceed the US\$0\.0200 cap/);
  assert.equal(claude.requests.filter((request) => request.body.model === 'claude-opus-5-5').length, 0, 'the worst case of one Opus call already exceeds this cap');
  const manifest = await readJson(out, 'manifest.json');
  assert.equal(manifest.status, 'stopped');
  assert.equal(manifest.exit_code, 2);
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /Stopped early/);
});

test('no titles of the review sample reach the folder request', async () => {
  const claude = await startFakeClaude();
  const out = newOut();
  const { code, stderr } = await runEval(['run', '--input', bigExportPath, '--models', HAIKU, '--out', out], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: claude.baseURL });
  await claude.close();
  assert.equal(code, 0, stderr);

  const preview = (await readFile(join(out, 'payload-preview.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const reviewTitles = preview.filter((row) => row.in_review).map((row) => row.title);
  const folderTitles = preview.filter((row) => row.in_taxonomy_sample).map((row) => row.title);
  assert.ok(reviewTitles.length > 0 && folderTitles.length > 0);
  const taxonomyRequests = claude.requests.filter(isTaxonomyRequest);
  assert.ok(taxonomyRequests.length > 0);
  const taxonomyText = JSON.stringify(taxonomyRequests.map((request) => request.body));
  for (const title of reviewTitles) assert.ok(!taxonomyText.includes(title), `${title} was sent for the folders`);
  for (const title of folderTitles.slice(0, 5)) assert.ok(taxonomyText.includes(title));
  assert.ok(!folderTitles.some((title) => reviewTitles.includes(title)));
});

test('SIGINT after the first model keeps its review, its answers and a stopped manifest', async () => {
  const openai = await startFakeOpenAi({ dialect: 'openai' });
  const claude = await startFakeClaude({ hangFirst: 1 });
  const out = newOut();
  let signalled = false;
  const { code, stderr } = await runEval(
    ['run', '--input', exportPath, '--models', `${GPT},${HAIKU}`, '--out', out],
    { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: claude.baseURL, OPENAI_API_KEY: `${KEY}-openai`, OPENAI_BASE_URL: openai.baseURL },
    {
      onStderr(text, child) {
        if (!signalled && text.includes(`Evaluating ${HAIKU}`)) {
          signalled = true;
          setTimeout(() => child.kill('SIGINT'), 300);
        }
      },
    },
  );
  await claude.close();
  await openai.close();

  assert.equal(code, 130, stderr);
  const files = await readdir(out);
  assert.ok(files.includes('review-openai__gpt-6-luna.csv'));
  assert.ok(files.includes('assignments-openai__gpt-6-luna.jsonl'));
  assert.ok(!files.includes('review-anthropic__claude-haiku-5-5.csv'));
  const manifest = await readJson(out, 'manifest.json');
  assert.equal(manifest.status, 'stopped');
  assert.equal(manifest.exit_code, 130);
  assert.deepEqual(manifest.models.map((model) => model.status), ['complete', 'stopped']);
  assert.match(manifest.stopped_by, /SIGINT/);
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /Stopped early/);
});

test('a credential other than the provider key is never used', async () => {
  const claude = await startFakeClaude();
  const configDir = join(workDir, 'claude-config');
  for (const env of [{ ANTHROPIC_AUTH_TOKEN: 'token-0123456789' }, { ANTHROPIC_CONFIG_DIR: configDir, ANTHROPIC_PROFILE: 'work' }]) {
    const out = newOut();
    const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out], { ...env, ANTHROPIC_BASE_URL: claude.baseURL });
    assert.equal(code, 1);
    assert.match(stderr, /ANTHROPIC_API_KEY is not set/);
  }
  assert.equal(claude.requests.length, 0);
  await claude.close();
});

test('a base URL outside loopback is refused, and a malformed key never reaches the network', async () => {
  const claude = await startFakeClaude();
  let result = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', newOut()], {
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: 'https://proxy.example.com',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /loopback/);

  result = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', newOut()], {
    ANTHROPIC_API_KEY: 'sk key with spaces and more',
    ANTHROPIC_BASE_URL: claude.baseURL,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not look like an API key/);
  assert.ok(!result.stderr.includes('sk key with spaces'));
  assert.equal(claude.requests.length, 0);
  await claude.close();
});

test('a provider that trains on API data needs explicit consent, and asks for none before spending', async () => {
  const fake = await startFakeOpenAi({ dialect: 'deepseek' });
  const env = { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: fake.baseURL };
  const out = newOut();
  let result = await runEval(['run', '--input', exportPath, '--models', 'deepseek/deepseek-flash', '--out', out], env);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /DeepSeek: trains by default: yes/);
  assert.match(result.stderr, /--accept-data-policy deepseek/);
  assert.equal(fake.requests.length, 0);
  await assert.rejects(stat(out), 'no directory is created before consent');

  result = await runEval(['run', '--input', exportPath, '--models', 'deepseek/deepseek-flash', '--out', newOut(), '--dry-run'], env);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /DeepSeek: trains by default: yes/);
  assert.match(result.stdout, /moving alias/);

  result = await runEval(['run', '--input', exportPath, '--models', 'deepseek/deepseek-flash', '--out', newOut(), '--accept-data-policy', 'deepseek', '--review', '5'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fake.requests.length > 0);
  await fake.close();
});

test('--fallback is refused for a provider that has none', async () => {
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', GPT, '--out', newOut(), '--fallback']);
  assert.equal(code, 1);
  assert.match(stderr, /only exists on Anthropic/);
});

test('an existing --out fails without touching anything', async () => {
  const claude = await startFakeClaude();
  const out = newOut();
  const first = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out, '--dry-run']);
  assert.equal(first.code, 0);
  const before = await readFile(join(out, 'manifest.json'), 'utf8');
  const names = await readdir(out);

  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: claude.baseURL });
  await claude.close();
  assert.equal(code, 1);
  assert.match(stderr, /Refusing to reuse/);
  assert.equal(claude.requests.length, 0);
  assert.deepEqual(await readdir(out), names);
  assert.equal(await readFile(join(out, 'manifest.json'), 'utf8'), before);
});

test('invalid numbers fail before reading anything or spending', async () => {
  const claude = await startFakeClaude();
  for (const [args, pattern] of [
    [['--max-usd', '1,5'], /--max-usd/],
    [['--max-usd', '0'], /--max-usd/],
    [['--max-usd', 'abc'], /--max-usd/],
    [['--sample', 'abc'], /--sample/],
    [['--review', '-3'], /--review/],
    [['--seed', 'abc'], /--seed/],
    [['--seed', '1.5'], /--seed/],
    [['--effort', 'extreme'], /--effort/],
    [['--exclude-folder', '('], /regular expression/],
    [['--accept-data-policy', 'nobody'], /provider id/],
  ]) {
    const out = newOut();
    const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out, ...args], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: claude.baseURL });
    assert.equal(code, 1, args.join(' '));
    assert.match(stderr, pattern);
    await assert.rejects(stat(out), `${args.join(' ')} must not create anything`);
  }
  assert.equal(claude.requests.length, 0);
  await claude.close();
});

test('models are required, and one without a price is refused', async () => {
  let result = await runEval(['run', '--input', exportPath, '--out', newOut()]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--models is required/);
  assert.match(result.stderr, /anthropic\/claude-haiku-5-5/);

  result = await runEval(['run', '--input', exportPath, '--models', 'anthropic/claude-unknown', '--out', newOut()]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no known price/);

  result = await runEval(['run', '--input', exportPath, '--models', 'constructor', '--out', newOut()]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /provider\/model/);
});

test('a title with a URL and a token never leaves, and --exclude-folder keeps a folder out entirely', async () => {
  const claude = await startFakeClaude();
  const path = join(workDir, 'mixed.html');
  const links = Array.from({ length: 30 }, (_, i) => `<DT><A HREF="https://example.com/a${i}">Nota ${String(i).padStart(3, '0')} beta</A>`).join('\n');
  await writeFile(
    path,
    `<DL><p><DT><H3>General</H3><DL><p>${links}
    <DT><A HREF="https://example.com/b?token=ABCDEF123456">https://example.com/b?token=ABCDEF123456SECRET</A>
    </DL><p><DT><H3>Salud privada</H3><DL><p>
    <DT><A HREF="https://clinic.example.com/x">Resultados de laboratorio de Ana</A>
    </DL><p></DL><p>`,
  );
  const out = newOut();
  const { code, stdout, stderr } = await runEval(['run', '--input', path, '--models', HAIKU, '--out', out, '--exclude-folder', 'salud'], {
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: claude.baseURL,
  });
  await claude.close();
  assert.equal(code, 0, stderr);
  const sent = sentText(claude);
  assert.ok(!sent.includes('SECRET'));
  assert.ok(!sent.includes('ABCDEF123456'));
  assert.ok(!sent.includes('laboratorio'));
  assert.match(stdout, /excluded-folder: 1/);
});

test('--taxonomy uses the given folders and asks no model for any', async () => {
  const claude = await startFakeClaude();
  const file = join(workDir, 'taxonomy.json');
  await writeFile(file, JSON.stringify({ folders: [{ name: 'Alfa', description: 'Primera.' }, { name: 'Beta', description: 'Segunda.' }] }));
  const out = newOut();
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out, '--taxonomy', file, '--review', '10'], {
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: claude.baseURL,
  });
  await claude.close();
  assert.equal(code, 0, stderr);
  assert.equal(claude.requests.filter(isTaxonomyRequest).length, 0);
  const rows = parseCsv(await readFile(join(out, 'review-anthropic__claude-haiku-5-5.csv'), 'utf8'));
  assert.ok(rows.every((row) => ['Alfa', 'Beta'].includes(row.assigned_folder)));
  const manifest = await readJson(out, 'manifest.json');
  assert.match(manifest.params.taxonomy_file_sha256, /^[0-9a-f]{64}$/);

  const bad = join(workDir, 'bad-taxonomy.json');
  await writeFile(bad, '{"folders": []}');
  const failure = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', newOut(), '--taxonomy', bad], { ANTHROPIC_API_KEY: KEY });
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /no folders/);
});

test('a model with no usable folders fails with its stop reason, and exits 1', async () => {
  const claude = await startFakeClaude();
  const path = join(workDir, 'refused.html');
  const links = Array.from({ length: 30 }, (_, i) => `<DT><A HREF="https://example.com/r${i}">REFUSE_ME ${i}</A>`).join('\n');
  await writeFile(path, `<DL><p><DT><H3>Carpeta</H3><DL><p>${links}</DL><p></DL><p>`);
  const { code, stderr } = await runEval(['run', '--input', path, '--models', HAIKU, '--out', newOut()], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: claude.baseURL });
  await claude.close();
  assert.equal(code, 1);
  assert.match(stderr, /returned no usable folders \(stop reason: refusal\)/);
});

test('the report and the console say whether anything is missing (M0 completeness)', async () => {
  const claude = await startFakeClaude();
  const path = join(workDir, 'skip.html');
  const links = Array.from({ length: 60 }, (_, i) => `<DT><A HREF="https://example.com/s${i}">${i % 10 === 0 ? 'SKIP_ME ' : ''}Tema ${String(i).padStart(3, '0')} gamma</A>`).join('\n');
  await writeFile(path, `<DL><p><DT><H3>Carpeta</H3><DL><p>${links}</DL><p></DL><p>`);
  const out = newOut();
  const { code, stdout, stderr } = await runEval(['run', '--input', path, '--models', HAIKU, '--out', out], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: claude.baseURL });
  await claude.close();
  assert.equal(code, 0, stderr);
  assert.match(stdout, /M0 completeness: FAIL \(missing=\d+, not attempted=0\)/);
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /M0 completeness: FAIL/);
  const manifest = await readJson(out, 'manifest.json');
  assert.ok(manifest.models[0].unclassified_reasons.missing > 0);
});

test('a short rate limit is waited out and the run completes', async () => {
  const claude = await startFakeClaude({ rateLimitFirst: 1, retryAfter: '1' });
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', newOut()], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: claude.baseURL });
  await claude.close();
  assert.equal(code, 0, stderr);
  assert.match(stderr, /waiting 1 s/);
});

test('a key echoed by the server never reaches the console, the report or the manifest', async () => {
  const secret = 'sk-test-ECHOED-0123456789-abcdef';
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `bad request from ${request.headers.authorization}`, type: 'invalid_request_error' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const out = newOut();
  const { code, stdout, stderr } = await runEval(['run', '--input', exportPath, '--models', GPT, '--out', out], {
    OPENAI_API_KEY: secret,
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(code, 1);
  const everything = [stdout, stderr, await readFile(join(out, 'report.md'), 'utf8'), await readFile(join(out, 'manifest.json'), 'utf8')].join('\n');
  assert.ok(!everything.includes(secret), 'the key must be redacted everywhere');
  assert.match(everything, /redacted/);
});

test('score and blind work from a real run', async () => {
  const claude = await startFakeClaude();
  const out = newOut();
  // Four folders, so that no single folder takes a share that makes acceptance meaningless.
  const folders = join(workDir, 'four-folders.json');
  await writeFile(folders, JSON.stringify({ folders: ['Uno', 'Dos', 'Tres', 'Cuatro'].map((name) => ({ name, description: name })) }));
  const run = await runEval(['run', '--input', bigExportPath, '--models', `${HAIKU},${OPUS}`, '--taxonomy', folders, '--out', out], { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: claude.baseURL });
  await claude.close();
  assert.equal(run.code, 0, run.stderr);

  /** @param {string} path @param {string} verdict */
  const judge = async (path, verdict) => {
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    const judged = lines.map((line, index) => (index === 0 ? line : line.replace(/^"[^"]*"/, `"${verdict}"`)));
    await writeFile(path, `${judged.join('\n')}\n`);
  };

  const review = join(out, 'review-anthropic__claude-haiku-5-5.csv');
  await judge(review, 'y');
  const accepted = await runEval(['score', review]);
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);

  await judge(review, 'n');
  const rejected = await runEval(['score', review]);
  assert.equal(rejected.code, 1);

  const blind = await runEval(['blind', out, '--out', join(out, 'blind.csv')]);
  assert.equal(blind.code, 0, blind.stderr);
  const files = await readdir(out);
  assert.ok(files.includes('blind.csv') && files.includes('blind.key.json'));
  const list = await readFile(join(out, 'blind.csv'), 'utf8');
  assert.ok(!list.includes('claude'), 'the list to judge must not say which model proposed what');
  await judge(join(out, 'blind.csv'), 'y');
  const scored = await runEval(['score', join(out, 'blind.csv')]);
  assert.equal(scored.code, 0, scored.stdout + scored.stderr);
});

test('models lists the catalog with prices', async () => {
  const { code, stdout } = await runEval(['models', '--provider', 'anthropic']);
  assert.equal(code, 0);
  assert.match(stdout, /claude-haiku-5-5/);
  assert.match(stdout, /Anthropic: trains by default: no/);
  assert.equal((await runEval(['models', '--provider', 'nobody'])).code, 1);
});

/**
 * Stands between the CLI and a fake, to fail, hang or watch one particular request.
 *
 * @param {string} target
 * @param {{failAt?: number, hangAt?: number, onRequest?: (number: number, body: string) => void | Promise<void>, answer?: (number: number, body: any) => object | null}} [plan]
 */
async function startProxy(target, plan = {}) {
  let count = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      count += 1;
      const number = count;
      const body = Buffer.concat(chunks);
      await plan.onRequest?.(number, body.toString('utf8'));
      if (number === plan.hangAt) return;
      if (number === plan.failAt) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'boom' } }));
        return;
      }
      const own = plan.answer?.(number, JSON.parse(body.toString('utf8')));
      if (own) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(own));
        return;
      }
      const forwarded = await fetch(`${target}${request.url}`, { method: request.method, headers: { 'content-type': 'application/json', authorization: String(request.headers.authorization ?? ''), 'anthropic-version': String(request.headers['anthropic-version'] ?? '2023-06-01') }, body });
      response.writeHead(forwarded.status, { 'content-type': 'application/json' });
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    get count() {
      return count;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** @param {string} dir @param {string} name */
const lines = async (dir, name) => (await readFile(join(dir, name), 'utf8')).trim().split('\n').filter(Boolean);

const anthropicEnv = (/** @type {string} */ baseURL) => ({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL });

test('--exclude-folder can be repeated, and a pattern that excludes nothing is reported', async () => {
  const claude = await startFakeClaude();
  const path = join(workDir, 'two-folders.html');
  const group = (name, count) => `<DT><H3>${name}</H3><DL><p>${Array.from({ length: count }, (_, i) => `<DT><A HREF="https://example.com/${name}/${i}">${name} ${String(i).padStart(3, '0')} omega</A>`).join('\n')}</DL><p>`;
  await writeFile(path, `<DL><p>${group('Banco', 12)}${group('Salud', 12)}${group('Cocina', 30)}</DL><p>`);
  const { code, stdout, stderr } = await runEval(
    ['run', '--input', path, '--models', HAIKU, '--out', newOut(), '--exclude-folder', 'banco', '--exclude-folder', 'salud'],
    anthropicEnv(claude.baseURL),
  );
  assert.equal(code, 0, stderr);
  const sent = sentText(claude);
  assert.ok(!/Banco \d{3}/.test(sent) && !/Salud \d{3}/.test(sent), 'both folders stay home');
  assert.ok(/Cocina \d{3}/.test(sent));
  assert.match(stdout, /excluded-folder: 24/);

  // A typo in a privacy filter: a dry run warns, a real run refuses before sending anything.
  const typo = ['run', '--input', path, '--models', HAIKU, '--exclude-folder', 'Saludd'];
  const dry = await runEval([...typo, '--out', newOut(), '--dry-run'], anthropicEnv(claude.baseURL));
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /--exclude-folder "Saludd" matches no folder/);
  const before = claude.requests.length;
  const out = newOut();
  const real = await runEval([...typo, '--out', out], anthropicEnv(claude.baseURL));
  await claude.close();
  assert.equal(real.code, 1);
  assert.match(real.stderr, /"Saludd" matches no folder.*Nothing was sent/);
  assert.equal(claude.requests.length, before);
  await assert.rejects(stat(out), 'no directory is created either');
});

test('a decomposed accent in the pattern still matches the folder', async () => {
  const path = join(workDir, 'accents.html');
  const links = (host, count) => Array.from({ length: count }, (_, i) => `<DT><A HREF="https://example.com/${host}${i}">Clase ${host} ${i}</A>`).join('');
  await writeFile(path, `<DL><p><DT><H3>Educación</H3><DL><p>${links('e', 6)}</DL><p><DT><H3>Otra</H3><DL><p>${links('o', 6)}</DL><p></DL><p>`);
  const { code, stdout } = await runEval(['run', '--input', path, '--models', HAIKU, '--out', newOut(), '--dry-run', '--exclude-folder', 'Educacio\u0301n']);
  assert.equal(code, 0);
  assert.match(stdout, /excluded-folder: 6/);
});

test('an answer from another model than the one asked for is warned about and counted as served', async () => {
  const claude = await startFakeClaude({ servedModel: 'claude-sonnet-5-5' });
  const out = newOut();
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out], anthropicEnv(claude.baseURL));
  await claude.close();
  assert.equal(code, 0, stderr);
  assert.match(stderr, /Warning: anthropic\/claude-haiku-5-5 was answered by claude-sonnet-5-5/);
  const manifest = await readJson(out, 'manifest.json');
  assert.ok(Object.keys(manifest.models[0].served).includes('claude-sonnet-5-5'));
  assert.equal('served_calls' in manifest.models[0], false);
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /claude-sonnet-5-5/);
});

test('console and report give the same completeness verdict, and refusals do not make it fail', async () => {
  const claude = await startFakeClaude();
  const path = join(workDir, 'one-refusal.html');
  const links = Array.from({ length: 60 }, (_, i) => `<DT><A HREF="https://example.com/q${i}">${i === 59 ? 'REFUSE_ME ' : ''}Asunto ${String(i).padStart(3, '0')} sigma</A>`).join('\n');
  await writeFile(path, `<DL><p><DT><H3>Carpeta</H3><DL><p>${links}</DL><p></DL><p>`);
  const out = newOut();
  const fixed = join(workDir, 'fixed-two.json');
  await writeFile(fixed, JSON.stringify({ folders: [{ name: 'Uno', description: 'a' }, { name: 'Dos', description: 'b' }] }));
  const { code, stdout, stderr } = await runEval(['run', '--input', path, '--models', HAIKU, '--out', out, '--sample', '60', '--taxonomy', fixed], anthropicEnv(claude.baseURL));
  await claude.close();
  assert.equal(code, 0, stderr);
  // The refused title may or may not land in the classification sample; the verdicts must agree either way.
  const consoleVerdict = /M0 completeness: (PASS|FAIL)\*{0,2} \(missing=(\d+), not attempted=(\d+)\)/.exec(stdout);
  const reportVerdict = /M0 completeness: (PASS|FAIL)\*{0,2} \(missing=(\d+), not attempted=(\d+)\)/.exec(await readFile(join(out, 'report.md'), 'utf8'));
  assert.ok(consoleVerdict && reportVerdict);
  assert.deepEqual(consoleVerdict.slice(1), reportVerdict.slice(1));
  assert.equal(consoleVerdict[1], 'PASS');
});

test('what a failed call leaves behind is kept: answers, taxonomy and totals reach the manifest', async () => {
  const claude = await startFakeClaude();
  const proxy = await startProxy(claude.baseURL, { failAt: 4 });
  const out = newOut();
  const { code, stderr } = await runEval(['run', '--input', bigExportPath, '--models', HAIKU, '--out', out], anthropicEnv(proxy.baseURL));
  await proxy.close();
  await claude.close();
  assert.equal(code, 1, stderr);

  const saved = (await lines(out, 'assignments-anthropic__claude-haiku-5-5.jsonl')).length;
  assert.ok(saved >= 100, `two batches were paid for, saw ${saved}`);
  const manifest = await readJson(out, 'manifest.json');
  assert.equal(manifest.models[0].status, 'stopped');
  assert.equal(manifest.models[0].classified, saved);
  assert.ok(manifest.models[0].taxonomy_sha256);
  assert.ok(manifest.spent_usd > 0);
  const report = await readFile(join(out, 'report.md'), 'utf8');
  assert.match(report, new RegExp(`Placed in a folder \\| ${saved} of`));
  assert.ok((await readJson(out, 'taxonomy-anthropic__claude-haiku-5-5.json')).folders.length > 0);
});

test('bookmarks the model sends to unsorted are not counted as placed', async () => {
  const proxyTarget = await startFakeClaude();
  const answer = (number, body) => {
    const user = body.messages[0].content;
    const usage = { input_tokens: 10, output_tokens: 5 };
    const message = (text) => ({ id: 'msg_x', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });
    if (body.output_config?.format?.schema?.properties?.folders) return message(JSON.stringify({ folders: [{ name: 'Uno', description: 'a' }, { name: 'Dos', description: 'b' }] }));
    const bookmarks = JSON.parse(user.match(/<bookmarks>\n(.*)\n<\/bookmarks>/s)[1]);
    return message(JSON.stringify({ assignments: bookmarks.map((bookmark) => ({ i: bookmark.i, f: -1, confidence: 'low' })) }));
  };
  const proxy = await startProxy(proxyTarget.baseURL, { answer });
  const { code, stdout, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', newOut()], anthropicEnv(proxy.baseURL));
  await proxy.close();
  await proxyTarget.close();
  assert.equal(code, 0, stderr);
  assert.match(stdout, /placed 0 of \d+, unsorted \d+, unclassified 0/);
});

test('the total spent is printed even if the disk fails at the end', async () => {
  const claude = await startFakeClaude();
  const out = newOut();
  const proxy = await startProxy(claude.baseURL, {
    // After the last answer the directory stops accepting files.
    onRequest: async (number) => {
      if (number === 3) await chmod(out, 0o500);
    },
  });
  const { code, stdout } = await runEval(['run', '--input', bigExportPath, '--models', HAIKU, '--out', out], anthropicEnv(proxy.baseURL));
  await chmod(out, 0o700);
  await proxy.close();
  await claude.close();
  assert.equal(code, 1);
  assert.match(stdout, /Total spent: US\$0\.\d{4}/);
});

test('SIGHUP stops cleanly with the manifest holding what was paid for, and says a call may still bill', async () => {
  const claude = await startFakeClaude();
  const proxy = await startProxy(claude.baseURL, { hangAt: 4 });
  const out = newOut();
  let signalled = false;
  const { code, stderr, stdout } = await runEval(
    ['run', '--input', bigExportPath, '--models', HAIKU, '--out', out],
    anthropicEnv(proxy.baseURL),
    {
      onStderr(text, child) {
        if (!signalled && /: 50\/\d+ /.test(text)) {
          signalled = true;
          setTimeout(() => child.kill('SIGHUP'), 400);
        }
      },
    },
  );
  await proxy.close();
  await claude.close();
  assert.equal(code, 130, stderr);
  const manifest = await readJson(out, 'manifest.json');
  assert.equal(manifest.status, 'stopped');
  assert.match(manifest.stopped_by, /SIGHUP.*may still be billed/);
  assert.ok(manifest.spent_usd > 0);
  assert.ok(manifest.models[0].classified >= 50);
  assert.match(stdout, /Total spent: US\$\d\.\d{4}.*may still be billed/);
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /may still be billed/);
});

test('a usage mistake is shown whole: several lines, never cut at 300 characters', async () => {
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--out', newOut()]);
  assert.equal(code, 1);
  assert.ok(stderr.length > 300);
  assert.match(stderr, /--models is required[^\n]*\n  anthropic\/claude-haiku-5-5\n/);
  assert.match(stderr, /deepseek\/deepseek-v4-pro/);
});

test('--taxonomy leaves the folder sample and the folder names out of the preview and the estimate', async () => {
  const file = join(workDir, 'fixed.json');
  await writeFile(file, JSON.stringify({ folders: [{ name: 'Alfa', description: 'a' }, { name: 'Beta', description: 'b' }] }));
  const out = newOut();
  const { code, stdout, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out, '--taxonomy', file, '--dry-run']);
  assert.equal(code, 0, stderr);
  const rows = (await lines(out, 'payload-preview.jsonl')).map((line) => JSON.parse(line));
  assert.ok(rows.length > 0 && rows.every((row) => !row.in_taxonomy_sample));
  assert.ok(!(await readdir(out)).includes('existing-folders.json'));
  assert.doesNotMatch(stdout, /Folder sample|Existing folder names/);

  const claude = await startFakeClaude();
  const full = newOut();
  const run = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', full, '--taxonomy', file], anthropicEnv(claude.baseURL));
  await claude.close();
  assert.equal(run.code, 0, run.stderr);
  const report = await readFile(join(full, 'report.md'), 'utf8');
  assert.match(report, /Taxonomy: from file [0-9a-f]{12}/);
  assert.doesNotMatch(report, /Proposed folders|built from/);
});

test('a provider that goes past max_tokens makes the run exit 2 and says the cap cannot be guaranteed', async () => {
  const claude = await startFakeClaude({ exceedMaxTokens: true });
  const out = newOut();
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out], anthropicEnv(claude.baseURL));
  await claude.close();
  assert.equal(code, 2, stderr);
  assert.match(stderr, /cap cannot be guaranteed with claude-haiku-5-5/);
  const manifest = await readJson(out, 'manifest.json');
  assert.equal(manifest.exit_code, 2);
  assert.equal(manifest.cap_broken_by.model, 'claude-haiku-5-5');
  assert.ok(manifest.cap_broken_by.output_tokens > manifest.cap_broken_by.max_tokens);
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /cap cannot be trusted/);
});

test('a tool that ran stops the whole run, not only its model', async () => {
  const perplexity = await startFakeOpenAi({ dialect: 'perplexity' });
  const claude = await startFakeClaude();
  const path = join(workDir, 'search.html');
  const links = Array.from({ length: 30 }, (_, i) => `<DT><A HREF="https://example.com/s${i}">SEARCH_ME ${i}</A>`).join('\n');
  await writeFile(path, `<DL><p><DT><H3>Carpeta</H3><DL><p>${links}</DL><p></DL><p>`);
  const out = newOut();
  const { code, stderr } = await runEval(['run', '--input', path, '--models', `perplexity/openai/gpt-6-luna,${HAIKU}`, '--out', out, '--accept-data-policy', 'perplexity'], {
    PERPLEXITY_API_KEY: KEY,
    PERPLEXITY_BASE_URL: perplexity.baseURL,
    ...anthropicEnv(claude.baseURL),
  });
  await perplexity.close();
  await claude.close();
  assert.equal(code, 1, stderr);
  assert.equal(claude.requests.length, 0, 'the next model must not run');
  assert.match(stderr, /ran a tool/);
  assert.deepEqual((await readJson(out, 'manifest.json')).models.map((model) => model.status), ['stopped', 'pending']);
});

test('gateway headers from the environment never travel with the request', async () => {
  const claude = await startFakeClaude();
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', newOut()], {
    ...anthropicEnv(claude.baseURL),
    ANTHROPIC_CUSTOM_HEADERS: 'x-corp-gateway-token: SECRET-GATEWAY',
  });
  await claude.close();
  assert.equal(code, 0, stderr);
  assert.ok(claude.requests.length > 0);
  assert.ok(claude.requests.every((request) => request.headers['x-corp-gateway-token'] === undefined));
});

test('without an effort the model confirms, the reasoning margin follows its documented default', async () => {
  const fake = await startFakeOpenAi({ dialect: 'deepseek' });
  const env = { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: fake.baseURL };
  const out = newOut();
  // DeepSeek documents no "medium", so none is sent and its own default (high) applies.
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', 'deepseek/deepseek-flash', '--out', out, '--accept-data-policy', 'deepseek', '--effort', 'medium', '--review', '5'], env);
  await fake.close();
  assert.equal(code, 0, stderr);
  const classify = fake.requests.filter((request) => !isTaxonomyRequest(request));
  assert.ok(classify.every((request) => request.body.max_tokens >= 8192), JSON.stringify(classify.map((request) => request.body.max_tokens)));
  assert.equal((await readJson(out, 'manifest.json')).models[0].effort, null);
});

test('--fallback is recorded as what really applies to each model', async () => {
  const claude = await startFakeClaude();
  const haiku = newOut();
  let result = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', haiku, '--fallback', '--dry-run'], anthropicEnv(claude.baseURL));
  assert.equal(result.code, 0);
  assert.equal((await readJson(haiku, 'manifest.json')).models[0].fallback, false);
  assert.match(result.stdout, /no server-side fallback/);

  const opus = newOut();
  result = await runEval(['run', '--input', exportPath, '--models', OPUS, '--out', opus, '--fallback', '--dry-run'], anthropicEnv(claude.baseURL));
  assert.equal((await readJson(opus, 'manifest.json')).models[0].fallback, true);
  await claude.close();
});

test('--effort none is refused, before any spending, for a model that does not document it', async () => {
  const claude = await startFakeClaude();
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', `${HAIKU},${GPT}`, '--out', newOut(), '--effort', 'none'], anthropicEnv(claude.baseURL));
  assert.equal(code, 1);
  assert.match(stderr, /--effort none is not documented for anthropic\/claude-haiku-5-5/);
  assert.doesNotMatch(stderr, /openai\/gpt-6-luna/);
  assert.equal(claude.requests.length, 0);
  await claude.close();

  const ok = await runEval(['run', '--input', exportPath, '--models', GPT, '--out', newOut(), '--effort', 'none', '--dry-run']);
  assert.equal(ok.code, 0, ok.stderr);
});

test('an overrun by the very last call still exits 2, and the manifest says so', async () => {
  const claude = await startFakeClaude({ exceedMaxTokens: true });
  const fixed = join(workDir, 'fixed-last.json');
  await writeFile(fixed, JSON.stringify({ folders: [{ name: 'Uno', description: 'a' }, { name: 'Dos', description: 'b' }] }));
  const out = newOut();
  // One batch, no folder request: nothing comes after the call that went over.
  const { code, stderr } = await runEval(['run', '--input', exportPath, '--models', HAIKU, '--out', out, '--taxonomy', fixed, '--sample', '30'], anthropicEnv(claude.baseURL));
  await claude.close();
  assert.equal(claude.requests.length, 1);
  assert.equal(code, 2, stderr);
  const manifest = await readJson(out, 'manifest.json');
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.exit_code, 2);
  assert.ok(manifest.cap_broken_by);
});

test('with a taxonomy file, the estimate follows the file and asks for no folders', async () => {
  const small = join(workDir, 'est-small.json');
  const large = join(workDir, 'est-large.json');
  await writeFile(small, JSON.stringify({ folders: [{ name: 'Uno', description: 'a' }] }));
  await writeFile(large, JSON.stringify({ folders: Array.from({ length: 25 }, (_, i) => ({ name: `Carpeta ${i}`, description: 'x'.repeat(150) })) }));
  const tokens = async (file) => {
    const { stdout } = await runEval(['run', '--input', bigExportPath, '--models', HAIKU, '--out', newOut(), '--taxonomy', file, '--dry-run']);
    const [, input, output] = /Estimated tokens, without reasoning: (\d+) in \/ (\d+) out/.exec(stdout);
    return { input: Number(input), output: Number(output) };
  };
  const one = await tokens(small);
  const many = await tokens(large);
  assert.ok(many.input > one.input + 2000, `the folders of the file are in every batch: ${one.input} vs ${many.input}`);
  assert.equal(many.output, one.output, 'no folder proposal is expected back');
});
