import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Everything a run writes holds bookmark titles, and the project root can sit in a directory
 * shared with other accounts. So files are created owner-only, nothing is overwritten by
 * accident, and no write goes through a symbolic link at the final path.
 */

const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

/**
 * Creates the directory of a new run. The final directory must not exist, so a repeated run can
 * never overwrite judged reviews, and that includes a symbolic link at that path.
 *
 * @param {string} path
 * @returns {Promise<{dir: string}>} `dir` is absolute
 */
export async function createRunDir(path) {
  const dir = resolve(path);
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    throw Object.assign(new Error(`Refusing to reuse ${dir}: it already exists, and a new run would overwrite its reviews. Choose a new directory.`, { cause: error }), {
      code: 'EEXIST',
    });
  }
  return { dir };
}

/**
 * Fails if anything exists at the path, including a symbolic link, and leaves it untouched.
 *
 * @param {string} path
 * @param {string | Uint8Array} content
 */
export function writeNew(path, content) {
  return writeFile(path, content, { flag: 'wx', mode: 0o600 });
}

/**
 * For what a run rewrites as it progresses. A crash leaves the old file or the new one, never a
 * partial one. The rename replaces a symbolic link instead of writing through it, and the result
 * is owner-only whatever was there before.
 *
 * @param {string} path
 * @param {string | Uint8Array} content
 */
export async function writeAtomic(path, content) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The process can die between two calls, and every complete line stays valid; a reader only has
 * to tolerate a torn last line. `O_NOFOLLOW` refuses a symbolic link at the path.
 *
 * @param {string} path
 * @param {string} line without line breaks
 */
export async function appendLine(path, line) {
  if (/[\r\n]/.test(line)) throw new Error(`appendLine takes a single line, and this one breaks: ${path}`);
  const handle = await open(path, APPEND_FLAGS, 0o600);
  try {
    await handle.appendFile(`${line}\n`);
  } finally {
    await handle.close();
  }
}
