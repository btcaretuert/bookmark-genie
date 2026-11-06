import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runSave } from '../../extension/ui/save-flow.js';

test('the permission request is made synchronously, inside the click, before anything is written', () => {
  /** @type {string[]} */
  const calls = [];
  void runSave({
    wantsOn: true,
    request: () => (calls.push('request'), new Promise(() => {})),
    persist: async () => void calls.push('persist'),
    finalize: async () => {},
  });
  // Nothing has awaited yet: the request is already out, and it came first.
  assert.deepEqual(calls, ['request', 'persist']);
});

test('what the person typed is saved even if the dialog never answers (the page died behind it)', async () => {
  const saved = { key: false, enabled: false };
  void runSave({
    wantsOn: true,
    request: () => new Promise(() => {}),
    persist: async () => {
      saved.key = true;
    },
    finalize: async () => {
      saved.enabled = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.key, true);
  assert.equal(saved.enabled, false, '"on" is written only after the answer');
});

test('"on" is decided after both the request and the write, with the answer', async () => {
  /** @type {string[]} */
  const order = [];
  const result = await runSave({
    wantsOn: true,
    request: async () => (order.push('request'), false),
    persist: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      order.push('persist');
    },
    finalize: async (granted) => (order.push(`finalize:${granted}`), granted),
  });
  assert.deepEqual(order, ['request', 'persist', 'finalize:false']);
  assert.equal(result, false);
});

test('turning the sort off asks for nothing', async () => {
  let asked = false;
  const granted = await runSave({
    wantsOn: false,
    request: async () => ((asked = true), true),
    persist: async () => {},
    finalize: async (value) => value,
  });
  assert.equal(asked, false);
  assert.equal(granted, true);
});
