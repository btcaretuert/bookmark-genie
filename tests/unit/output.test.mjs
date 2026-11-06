import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { appendLine, createRunDir, writeAtomic, writeNew } from '../../tools/lib/output.mjs';

const permissions = async (/** @type {string} */ path) => (await lstat(path)).mode & 0o7777;

let base;
let count = 0;
/** A fresh private directory per test. */
async function workDir() {
  count += 1;
  const dir = join(base, `t${count}`);
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'bookmark-genie-output-'));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

test('createRunDir makes a private directory and its missing parents', async () => {
  const dir = await workDir();
  const { dir: created } = await createRunDir(join(dir, 'eval-out', 'deep', 'run'));

  assert.equal(created, join(dir, 'eval-out', 'deep', 'run'));
  for (const path of [created, join(dir, 'eval-out'), join(dir, 'eval-out', 'deep')]) {
    assert.equal(await permissions(path), 0o700, path);
  }
});

test('createRunDir returns an absolute path for a relative one', async () => {
  const dir = await workDir();
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const { dir: created } = await createRunDir(join('relative', 'run'));
    assert.equal(created, join(process.cwd(), 'relative', 'run'));
    assert.equal(await permissions(created), 0o700);
  } finally {
    process.chdir(previous);
  }
});

test('createRunDir refuses an existing run, so judged reviews survive a repeated command', async () => {
  const dir = await workDir();
  const { dir: run } = await createRunDir(join(dir, 'run'));
  const review = join(run, 'review.csv');
  await writeNew(review, 'y,already judged\n');

  await assert.rejects(createRunDir(run), (/** @type {any} */ error) => {
    assert.equal(error.code, 'EEXIST');
    assert.match(error.message, /Refusing to reuse .*Choose a new directory/);
    return true;
  });
  assert.equal(await readFile(review, 'utf8'), 'y,already judged\n');
});

test('createRunDir keeps refusing with a trailing slash', async () => {
  const dir = await workDir();
  await createRunDir(join(dir, 'run'));
  await assert.rejects(createRunDir(`${join(dir, 'run')}/`), { code: 'EEXIST' });
});

test('createRunDir does not loosen or reuse an existing permissive directory', async () => {
  const dir = await workDir();
  const open = join(dir, 'open');
  await mkdir(open);
  await chmod(open, 0o755);

  await assert.rejects(createRunDir(open), { code: 'EEXIST' });
  assert.equal(await permissions(open), 0o755);
});

test('createRunDir does not follow a symbolic link at the final path', async () => {
  const dir = await workDir();
  const target = join(dir, 'target');
  await mkdir(target);
  await symlink(target, join(dir, 'to-directory'));
  await symlink(join(dir, 'missing'), join(dir, 'dangling'));

  await assert.rejects(createRunDir(join(dir, 'to-directory')), { code: 'EEXIST' });
  await assert.rejects(createRunDir(join(dir, 'dangling')), { code: 'EEXIST' });
  await assert.rejects(stat(join(dir, 'missing')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(target), []);
});

test('createRunDir refuses a file at the final path', async () => {
  const dir = await workDir();
  await writeFile(join(dir, 'file'), 'data');
  await assert.rejects(createRunDir(join(dir, 'file')), { code: 'EEXIST' });
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'data');
});

test('writeNew creates an owner-only file', async () => {
  const dir = await workDir();
  const path = join(dir, 'report.md');
  await writeNew(path, 'títulos privados');
  assert.equal(await readFile(path, 'utf8'), 'títulos privados');
  assert.equal(await permissions(path), 0o600);
});

test('writeNew keeps an existing file and its mode, which closes the known --out defect', async () => {
  const dir = await workDir();
  const path = join(dir, 'review.csv');
  await writeFile(path, 'judged');
  await chmod(path, 0o644);

  await assert.rejects(writeNew(path, 'new'), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), 'judged');
  assert.equal(await permissions(path), 0o644);
});

test('writeNew does not write through a symbolic link, even a dangling one', async () => {
  const dir = await workDir();
  const victim = join(dir, 'victim');
  await writeFile(victim, 'untouched');
  await symlink(victim, join(dir, 'link'));
  await symlink(join(dir, 'planted'), join(dir, 'dangling'));

  await assert.rejects(writeNew(join(dir, 'link'), 'x'), { code: 'EEXIST' });
  await assert.rejects(writeNew(join(dir, 'dangling'), 'x'), { code: 'EEXIST' });
  assert.equal(await readFile(victim, 'utf8'), 'untouched');
  await assert.rejects(stat(join(dir, 'planted')), { code: 'ENOENT' });
});

test('a replaced run directory with a planted file does not get overwritten', async () => {
  // SEG-4: another account swaps the run directory for an open one with files ready to read.
  const dir = await workDir();
  const swapped = join(dir, 'run');
  await mkdir(swapped);
  await chmod(swapped, 0o777);
  await writeFile(join(swapped, 'report.md'), '');
  await chmod(join(swapped, 'report.md'), 0o666);
  await writeFile(join(swapped, 'assignments.jsonl'), '');
  await chmod(join(swapped, 'assignments.jsonl'), 0o666);

  await assert.rejects(writeNew(join(swapped, 'report.md'), 'títulos'), { code: 'EEXIST' });
  assert.equal(await readFile(join(swapped, 'report.md'), 'utf8'), '');

  // With nothing planted, the files still land owner-only: an open directory cannot read them.
  await writeNew(join(swapped, 'review.csv'), 'títulos');
  assert.equal(await permissions(join(swapped, 'review.csv')), 0o600);
});

test('writeAtomic creates, replaces and tightens the mode without leaving temporaries', async () => {
  const dir = await workDir();
  const path = join(dir, 'manifest.json');
  await writeAtomic(path, '{"status":"running"}');
  assert.equal(await permissions(path), 0o600);

  await chmod(path, 0o644);
  await writeAtomic(path, '{"status":"complete"}');
  assert.equal(await readFile(path, 'utf8'), '{"status":"complete"}');
  assert.equal(await permissions(path), 0o600);
  assert.deepEqual(await readdir(dir), ['manifest.json']);
});

test('writeAtomic replaces a symbolic link and leaves its target alone', async () => {
  const dir = await workDir();
  const victim = join(dir, 'victim');
  await writeFile(victim, 'untouched');
  const link = join(dir, 'manifest.json');
  await symlink(victim, link);

  await writeAtomic(link, 'new');
  assert.equal(await readFile(victim, 'utf8'), 'untouched');
  assert.equal(await readFile(link, 'utf8'), 'new');
  assert.ok((await lstat(link)).isFile());
  await assert.rejects(readlink(link), { code: 'EINVAL' });
});

test('writeAtomic keeps the previous file and removes its temporary when it cannot finish', async () => {
  const dir = await workDir();
  const directoryInTheWay = join(dir, 'taken');
  await mkdir(directoryInTheWay);
  await writeFile(join(directoryInTheWay, 'inside'), 'kept');

  await assert.rejects(writeAtomic(directoryInTheWay, 'new'));
  assert.deepEqual(await readdir(dir), ['taken']);
  assert.equal(await readFile(join(directoryInTheWay, 'inside'), 'utf8'), 'kept');
});

test('concurrent writeAtomic calls leave one complete version', async () => {
  const dir = await workDir();
  const path = join(dir, 'manifest.json');
  const versions = Array.from({ length: 20 }, (_, i) => String(i).repeat(5000));
  await Promise.all(versions.map((version) => writeAtomic(path, version)));
  assert.ok(versions.includes(await readFile(path, 'utf8')));
  assert.deepEqual(await readdir(dir), ['manifest.json']);
});

test('appendLine creates an owner-only file and keeps every line', async () => {
  const dir = await workDir();
  const path = join(dir, 'assignments.jsonl');
  await appendLine(path, '{"id":"b0"}');
  await appendLine(path, '{"id":"b1"}');
  assert.equal(await readFile(path, 'utf8'), '{"id":"b0"}\n{"id":"b1"}\n');
  assert.equal(await permissions(path), 0o600);
});

test('concurrent appendLine calls do not tear lines', async () => {
  const dir = await workDir();
  const path = join(dir, 'assignments.jsonl');
  const ids = Array.from({ length: 100 }, (_, i) => i);
  await Promise.all(ids.map((id) => appendLine(path, JSON.stringify({ id, title: 'x'.repeat(2000) }))));
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
  assert.deepEqual(lines.map((line) => JSON.parse(line).id).sort((a, b) => a - b), ids);
});

test('appendLine does not follow a symbolic link', async () => {
  const dir = await workDir();
  const victim = join(dir, 'victim');
  await writeFile(victim, 'untouched');
  await chmod(victim, 0o600);
  await symlink(victim, join(dir, 'link'));
  await symlink(join(dir, 'planted'), join(dir, 'dangling'));

  await assert.rejects(appendLine(join(dir, 'link'), 'x'), { code: 'ELOOP' });
  await assert.rejects(appendLine(join(dir, 'dangling'), 'x'), { code: 'ELOOP' });
  assert.equal(await readFile(victim, 'utf8'), 'untouched');
  await assert.rejects(stat(join(dir, 'planted')), { code: 'ENOENT' });
});

test('appendLine refuses text that would break the one-record-per-line format', async () => {
  const dir = await workDir();
  const path = join(dir, 'assignments.jsonl');
  await assert.rejects(appendLine(path, 'one\ntwo'), /single line/);
  await assert.rejects(appendLine(path, 'one\rtwo'), /single line/);
  assert.deepEqual(await readdir(dir), []);
});
