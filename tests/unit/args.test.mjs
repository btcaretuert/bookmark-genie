import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCli, parseRunOptions, UsageError } from '../../tools/lib/args.mjs';

const HAIKU = 'anthropic/claude-haiku-5-5';

/** @param {string[]} extra */
const options = (...extra) => parseRunOptions(parseCli(['run', '--input', 'in.html', '--models', HAIKU, ...extra]).values);

test('defaults are the documented ones', () => {
  const run = options();
  assert.deepEqual(
    { sample: run.sample, review: run.review, seed: run.seed, maxUsd: run.maxUsd, effort: run.effort, language: run.language, dryRun: run.dryRun, fallback: run.fallback },
    { sample: 300, review: 100, seed: 1, maxUsd: 1, effort: 'low', language: 'Spanish', dryRun: false, fallback: false },
  );
  assert.deepEqual(run.models, [HAIKU]);
});

test('--max-usd takes only a positive decimal with a point', () => {
  assert.equal(options('--max-usd', '1.5').maxUsd, 1.5);
  assert.equal(options('--max-usd', '.25').maxUsd, 0.25);
  assert.equal(options('--max-usd', '2').maxUsd, 2);
  for (const bad of ['1,5', '0', '0.0', '-1', 'abc', '', '1e3', 'Infinity', 'NaN', '1.2.3']) {
    assert.throws(() => options(`--max-usd=${bad}`), UsageError, bad);
  }
});

test('--sample, --review and --seed take whole safe numbers', () => {
  assert.equal(options('--sample', '10', '--review', '5', '--seed', '0').seed, 0);
  for (const name of ['sample', 'review', 'seed']) {
    for (const bad of ['abc', '1.5', '-1', '', '1e3', '9007199254740993', ' 3']) {
      assert.throws(() => options(`--${name}=${bad}`), UsageError, `${name} ${bad}`);
    }
  }
  assert.throws(() => options('--sample', '0'), UsageError);
  assert.throws(() => options('--review', '0'), UsageError);
});

test('--effort is one of none, low, medium and high; none needs documentation in every model', () => {
  assert.equal(options('--effort', 'high').effort, 'high');
  assert.throws(() => options('--effort', 'max'), UsageError);
  assert.equal(options('--models', 'openai/gpt-6-luna', '--effort', 'none').effort, 'none');
  assert.throws(() => options('--effort', 'none'), /not documented for anthropic\/claude-haiku-5-5/);
});

test('--exclude-folder repeats, normalizes to NFC, must compile and must not be empty', () => {
  assert.ok(options('--exclude-folder', 'salud|banco').excludeFolder?.test('Mi Salud'));
  const both = options('--exclude-folder', 'salud', '--exclude-folder', 'banco');
  assert.ok(both.excludeFolder?.test('Mi Salud') && both.excludeFolder?.test('Banco'));
  assert.equal(both.excludePatterns.length, 2);
  assert.ok(options('--exclude-folder', 'Educacio\u0301n').excludeFolder?.test('Educaci\u00F3n'));
  assert.equal(options().excludeFolder, undefined);
  assert.throws(() => options('--exclude-folder', '('), UsageError);
  assert.throws(() => options('--exclude-folder', ''), UsageError);
});

test('models: required except in a dry run, known to the catalog, without repeats', () => {
  assert.throws(() => parseRunOptions(parseCli(['run', '--input', 'in.html']).values), /--models is required/);
  assert.deepEqual(parseRunOptions(parseCli(['run', '--input', 'in.html', '--dry-run']).values).models, []);
  assert.throws(() => options('--models', 'anthropic/claude-unknown'), /no known price/);
  // Copilot is excluded on purpose: the person asking for it gets the reason, not a price complaint.
  assert.throws(() => options('--models', 'copilot/gpt-6'), /Provider copilot is not available: no usable inference API/);
  assert.throws(() => options('--models', 'claude-haiku-5-5'), /provider\/model/);
  assert.throws(() => options('--models', `${HAIKU},${HAIKU}`), /repeats/);
  assert.throws(() => options('--models', 'constructor/toString'), UsageError);
  assert.deepEqual(options('--models', ` ${HAIKU} , openai/gpt-6-luna`).models, [HAIKU, 'openai/gpt-6-luna']);
});

test('--accept-data-policy repeats and names providers', () => {
  assert.deepEqual(options('--accept-data-policy', 'deepseek', '--accept-data-policy', 'gemini').acceptedPolicies, ['deepseek', 'gemini']);
  assert.throws(() => options('--accept-data-policy', 'toString'), UsageError);
});

test('--fallback only with Anthropic', () => {
  assert.equal(options('--fallback').fallback, true);
  assert.throws(() => options('--models', `${HAIKU},openai/gpt-6-luna`, '--fallback'), /only exists on Anthropic/);
});

test('subcommands and flags are parsed', () => {
  assert.deepEqual(parseCli(['blind', 'a', 'b', '--previous', 'x.csv', '--previous', 'y.csv']).positionals, ['a', 'b']);
  assert.deepEqual(parseCli(['blind', 'a', '--previous', 'x.csv', '--previous', 'y.csv']).values.previous, ['x.csv', 'y.csv']);
  assert.equal(parseCli(['-h']).values.help, true);
  assert.equal(parseCli(['models', '--provider', 'openai', '--check']).values.check, true);
  assert.throws(() => parseCli(['run', '--bogus']), /Unknown option/);
});
