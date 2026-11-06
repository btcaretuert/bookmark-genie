import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startFakeClaude } from '../helpers/fake-claude.mjs';

// Retry limits of the runner: they bound how many paid-for attempts a run makes.

const EVAL = fileURLToPath(new URL('../../tools/eval.mjs', import.meta.url));
const HAIKU = 'anthropic/claude-haiku-5-5';
const KEY = 'test-key-0123456789';

let workDir;
let exportPath;
let counter = 0;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'bookmark-genie-limits-'));
  exportPath = join(workDir, 'bookmarks.html');
  const links = Array.from({ length: 40 }, (_, i) => `<DT><A HREF="https://example.com/p${i}">Doc ${String(i).padStart(3, '0')} zeta</A>`).join('\n');
  await writeFile(exportPath, `<DL><p><DT><H3>Barra</H3><DL><p><DT><H3>Libros</H3><DL><p>${links}</DL><p></DL><p></DL><p>`);
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** @param {string} baseURL */
function run(baseURL, extra = [], outDir = join(workDir, `out-${(counter += 1)}`)) {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ANTHROPIC|OPENAI|GEMINI|MISTRAL|XAI|DEEPSEEK|PERPLEXITY|CLAUDE)_/.test(name)));
    const args = [EVAL, 'run', '--input', exportPath, '--models', HAIKU, '--sample', '20', '--review', '5', '--out', outDir, ...extra];
    const child = spawn(process.execPath, args, { env: { ...env, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseURL } });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('a rate limit is retried up to 5 attempts of one call, and the sixth refusal stops the model', async () => {
  const recovers = await startFakeClaude({ rateLimitFirst: 4, retryAfterMs: '5' });
  const ok = await run(recovers.baseURL);
  await recovers.close();
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal((ok.stderr.match(/waiting/g) ?? []).length, 4, ok.stderr);

  const never = await startFakeClaude({ rateLimitFirst: 100, retryAfterMs: '5' });
  const stopped = await run(never.baseURL);
  const attempts = never.requests.length;
  await never.close();
  assert.equal(stopped.code, 1, stopped.stderr);
  assert.equal(attempts, 5, 'exactly 5 attempts, not 4 and not 6');
});

test('a last call whose real input exceeds the estimate crosses the cap: exit 2 without a broken max_tokens', async () => {
  const fake = await startFakeClaude({ inflateInput: { request: 2, inputTokens: 1_000_000 } });
  const out = join(workDir, `out-${(counter += 1)}`);
  const result = await run(fake.baseURL, ['--max-usd', '0.05'], out);
  const total = fake.requests.length;
  await fake.close();
  assert.equal(total, 2, 'taxonomy plus one classification batch: the cap is crossed by the last call');
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /The spending cap was crossed/);
  assert.doesNotMatch(result.stderr, /cannot be guaranteed/);
  assert.doesNotMatch(result.stderr, /Next call could exceed/);
});
