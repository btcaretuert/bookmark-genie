import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROVIDERS } from '../../extension/platform/providers.js';

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '../../extension');
const read = (/** @type {string} */ path) => readFileSync(join(EXTENSION, path), 'utf8');

/** Every key and permission is deliberate; adding one means changing this list on purpose. */
const ALLOWED_KEYS = [
  'manifest_version',
  'name',
  'version',
  'description',
  'minimum_chrome_version',
  'permissions',
  'optional_permissions',
  'optional_host_permissions',
  'background',
  'action',
  'options_ui',
];
const ALLOWED_PERMISSIONS = ['bookmarks', 'storage', 'unlimitedStorage'];
/** `tabs` reads the active tab's URL for Ctrl+D; asked for only when the person turns the sort on. */
const OPTIONAL_PERMISSIONS = ['tabs'];
/** One host per provider the extension can call: every one with a fetch adapter, none fixed. */
const PROVIDER_HOSTS = Object.values(PROVIDERS)
  .filter((provider) => provider.adapter !== 'anthropic-sdk')
  .map((provider) => `${new URL(provider.baseURL).origin}/*`);

test('the manifest is valid JSON, Manifest V3, version 0.5.1', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Bookmark Genie');
  assert.ok(manifest.name.length <= 75, 'https://developer.chrome.com/docs/extensions/reference/manifest: at most 75 characters');
  assert.equal(manifest.version, '0.5.1');
  // syncing and folderType, which the plan checks rely on, exist since Chrome 134.
  assert.equal(manifest.minimum_chrome_version, '134');
});

test('the manifest asks for no permission outside the list, and nothing that widens its reach', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(Object.keys(manifest).filter((key) => !ALLOWED_KEYS.includes(key)), []);
  assert.deepEqual([...manifest.permissions].sort(), [...ALLOWED_PERMISSIONS].sort());
  assert.deepEqual(manifest.optional_permissions, OPTIONAL_PERMISSIONS);
  assert.deepEqual([...manifest.optional_host_permissions].sort(), [...PROVIDER_HOSTS].sort());
  assert.ok(!manifest.optional_host_permissions.some((/** @type {string} */ host) => /anthropic|<all_urls>|\*:\/\/\*/.test(host)));
  for (const key of ['host_permissions', 'content_scripts', 'web_accessible_resources', 'externally_connectable', 'content_security_policy']) {
    assert.equal(key in manifest, false, `${key} is absent`);
  }
});

test('the service worker is a module that exists', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.background, { service_worker: 'sw.js', type: 'module' });
  assert.ok(existsSync(join(EXTENSION, manifest.background.service_worker)));
});

test('the action opens ui/manager.html, which loads only local module scripts', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.action.default_popup, 'ui/manager.html');
  const html = read('ui/manager.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, attributes, body] of scripts) {
    // MV3 forbids inline and remote code: script-src 'self'.
    assert.equal(body.trim(), '', 'no inline script');
    const src = /\bsrc="([^"]+)"/.exec(attributes)?.[1];
    assert.ok(src && !/^[a-z]+:|^\/\//i.test(src), `local script: ${src}`);
    assert.ok(existsSync(join(EXTENSION, 'ui', src)), `${src} exists`);
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /\b(?:src|href)="(?:https?:)?\/\//i, 'nothing remote');
});

test('the extension pages and modules never write HTML from strings', () => {
  /** @param {string} dir @returns {string[]} */
  const files = (dir) =>
    readdirSync(join(EXTENSION, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : [],
    );
  const checked = ['sw.js', ...files('ui'), ...files('core'), ...files('platform')];
  assert.ok(checked.includes(join('ui', 'manager.js')) && checked.includes(join('ui', 'autosort.js')));
  for (const file of checked) {
    assert.doesNotMatch(read(file), /\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|createContextualFragment|\beval\(|new Function\(/, file);
  }
});

test('every module the manager and the worker import exists', () => {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} file */
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(existsSync(join(EXTENSION, file)), `${file} exists`);
    for (const [, specifier] of read(file).matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(specifier.startsWith('.'), `${file} imports only relative files, not ${specifier}`);
      visit(join(dirname(file), specifier));
    }
  };
  visit(join('ui', 'manager.js'));
  visit(join('ui', 'options.js'));
  visit('sw.js');
  assert.ok(seen.has(join('platform', 'bookmarks.js')) && seen.has(join('platform', 'autosort.js')));
});

test('the settings page opens in a tab, loads only local module scripts and no inline code', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.options_ui, { page: 'ui/options.html', open_in_tab: true });
  const html = read('ui/options.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, attributes, body] of scripts) {
    assert.equal(body.trim(), '', 'no inline script');
    const src = /\bsrc="([^"]+)"/.exec(attributes)?.[1];
    assert.ok(src && existsSync(join(EXTENSION, 'ui', src)), `${src} exists`);
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /\b(?:src|href)="(?:https?:)?\/\//i, 'nothing remote');
  assert.doesNotMatch(html, /<style/i, 'styles come from ui.css');
});
