import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dayKey, weekKey } from '../../extension/core/autosort.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// The daily cap and the weekly metrics follow the local calendar. A test that reads them back
// through a UTC date fails for hours every day in any zone but UTC (it did, at UTC-3, from 21:00
// to 24:00), so the pattern is banned: read with `dayKey`/`weekKey` and a fixed `now`.
test('no test derives a usage day or week from a UTC date string', () => {
  const offenders = [];
  for (const name of readdirSync(HERE).filter((file) => file.endsWith('.mjs') && file !== 'clock.test.mjs')) {
    readFileSync(join(HERE, name), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/\.at\.slice\(0,\s*10\)|toISOString\(\)\.(slice|substring)\(0,\s*10\)|toISOString\(\)\.split\('T'\)/.test(line)) offenders.push(`${name}:${index + 1}`);
      });
  }
  assert.deepEqual(offenders, []);
});

test('the day and the week change at local midnight, whatever the process zone', () => {
  assert.equal(dayKey(new Date(2026, 10, 5, 23, 59, 59)), '2026-11-05');
  assert.equal(dayKey(new Date(2026, 10, 6, 0, 0, 0)), '2026-11-06');
  assert.equal(dayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.equal(dayKey(new Date(2027, 0, 1, 0, 0)), '2027-01-01');
  assert.notEqual(weekKey(new Date(2026, 10, 8, 23, 59)), weekKey(new Date(2026, 10, 9, 0, 0)), 'Sunday night and Monday morning are different weeks');
});
