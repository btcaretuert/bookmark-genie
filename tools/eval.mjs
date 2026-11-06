#!/usr/bin/env node
/**
 * Measures how well models sort a real bookmark export (milestone M0). Run `eval.mjs --help`.
 *
 *   npm run eval -- run --input bookmarks.html --models anthropic/claude-haiku-5-5 --dry-run
 *   npm run eval -- run --input bookmarks.html --models anthropic/claude-haiku-5-5
 *   npm run eval -- blind eval-out/<run>
 *   npm run eval -- score eval-out/<run>/blind.csv
 *   npm run eval -- autosort-check --input bookmarks.html --models gemini/gemini-3.5-flash-lite --dry-run
 *
 * --dry-run sends nothing and needs no API key.
 */

// Keep in step with "engines" in package.json.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Node 20.12 or newer is required (this is ${process.versions.node}). Run it with "npm run eval --".`);
  process.exit(1);
}

const { HELP, parseCheckOptions, parseCli, parseRunOptions, UsageError } = await import('./lib/args.mjs');
const { redact } = await import('./lib/safe-text.mjs');

/** @param {ReturnType<typeof parseCli>} cli */
async function dispatch({ command, positionals, values }) {
  if (values.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (command === 'run') {
    const { run } = await import('./lib/runner.mjs');
    return run(parseRunOptions(values));
  }
  if (command === 'score' && positionals.length > 0) {
    const { runScore } = await import('./lib/score.mjs');
    return runScore(positionals);
  }
  if (command === 'blind' && positionals.length > 0) {
    const { runBlind } = await import('./lib/blind.mjs');
    const seed = Number(values.seed);
    if (!Number.isSafeInteger(seed) || seed < 0) throw new UsageError(`--seed must be a whole number, got ${JSON.stringify(values.seed)}`);
    return runBlind(positionals, { out: values.out, seed, previous: values.previous });
  }
  if (command === 'autosort-check') {
    const { runAutosortCheck } = await import('./lib/autosort-check.mjs');
    return runAutosortCheck(parseCheckOptions(values));
  }
  if (command === 'models') {
    const { runModels } = await import('./lib/models-cmd.mjs');
    return runModels({ provider: values.provider, check: values.check, candidates: values.candidates });
  }
  throw new UsageError(`${command === undefined ? 'No command given' : `Cannot use "${command}" like that`}.\n\n${HELP}`);
}

try {
  process.exitCode = await dispatch(parseCli(process.argv.slice(2)));
  // After a signal, a call in flight may keep a socket open for minutes; nothing is left to wait for.
  if (process.exitCode === 130) process.exit(130);
} catch (error) {
  const failure = /** @type {Error & {code?: string}} */ (error);
  // A mistake in what was typed, or in the options node parses, needs no stack; a bug does.
  const isUsage = failure instanceof UsageError || (typeof failure.code === 'string' && failure.code.startsWith('ERR_PARSE_ARGS'));
  // What was typed is not a secret and its help text is long and multi-line: print it whole.
  console.error(isUsage ? failure.message : redact(failure.message));
  if (!isUsage && !(failure.code === 'ENOENT' || failure.code === 'EEXIST') && !failure.message.includes('\n')) {
    // Unexpected errors keep their location; expected ones are explained by the message.
    if (failure instanceof TypeError || failure instanceof RangeError || failure instanceof ReferenceError) console.error(failure.stack);
  }
  process.exitCode = 1;
}
