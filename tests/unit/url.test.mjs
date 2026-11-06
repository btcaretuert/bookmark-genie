import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeForLlm, selectSendable } from '../../extension/core/url.js';

test('keeps host and readable path', () => {
  assert.deepEqual(sanitizeForLlm('https://Example.com/blog/how-to-bake-sourdough-bread/'), {
    sendable: true,
    url: 'example.com/blog/how-to-bake-sourdough-bread',
  });
});

test('keeps short identifiers and handles that say what a page is', () => {
  for (const [input, expected] of [
    ['https://github.com/anthropics/anthropic-sdk-typescript', 'github.com/anthropics/anthropic-sdk-typescript'],
    ['https://docs.python.org/3/library/asyncio.html', 'docs.python.org/3/library/asyncio.html'],
    ['https://www.youtube.com/@channelname', 'www.youtube.com/@channelname'],
    ['https://es.wikipedia.org/wiki/Educaci%C3%B3n', 'es.wikipedia.org/wiki/Educación'],
    ['https://www.typescriptlang.org/docs/handbook/JavaScript', 'www.typescriptlang.org/docs/handbook/JavaScript'],
    ['https://example.jp/記事/パン作り', 'example.jp/記事/パン作り'],
  ]) {
    assert.deepEqual(sanitizeForLlm(input), { sendable: true, url: expected });
  }
});

test('drops query, fragment, credentials and port', () => {
  const { url } = sanitizeForLlm('https://user:hunter2@example.com:8443/page?token=SECRET&a=1#frag-SECRET');
  assert.equal(url, 'example.com/page');
});

const SECRETS = [
  ['google doc id', 'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit', '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'],
  ['uuid', 'https://app.example.com/invoices/550e8400-e29b-41d4-a716-446655440000', '550e8400'],
  ['hex token', 'https://example.com/confirm/a1b2c3d4e5f67890', 'a1b2c3d4e5f67890'],
  ['token inside a slug', 'https://example.com/reset-password-abc123def456ghi', 'abc123def456ghi'],
  ['long numeric id', 'https://example.com/orders/20240113998877', '20240113998877'],
  ['letters-only random token', 'https://example.com/s/qwrtpsdfghjklzxcvbnm', 'qwrtpsdfghjklzxcvbnm'],
  ['mixed-case random token', 'https://example.com/k/AbCdEfGhIjKlMnOpQr', 'AbCdEfGhIjKlMnOpQr'],
  ['base64url with separators', 'https://example.com/t/dGhpcyBpcy1h_c2VjcmV0', 'dGhpcyBpcy1h'],
  ['email in path', 'https://example.com/users/ana.perez@example.org/profile', 'ana.perez'],
  ['encoded query in path', 'https://example.com/go%3Fsecret%3Dhunter2', 'hunter2'],
  ['short encoded query', 'https://example.com/p%3Dhunter2', 'hunter2'],
  ['matrix parameter', 'https://example.com/app;jsessionid=shortsecret', 'shortsecret'],
  ['short matrix parameter', 'https://example.com/app;pw=abc', 'abc'],
  ['encoded slash', 'https://example.com/a%2Fshortsecret', 'shortsecret'],
];

for (const [name, input, secret] of SECRETS) {
  test(`never sends a ${name}`, () => {
    const result = sanitizeForLlm(input);
    assert.equal(result.sendable, true);
    assert.ok(!result.url.includes(secret), `leaked in ${result.url}`);
  });
}

test('drops generated subdomains but keeps the site recognizable', () => {
  for (const [input, expected] of [
    ['https://my-app-abc123def456.vercel.app/dashboard', 'vercel.app/dashboard'],
    ['https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com/prod', 'execute-api.us-east-1.amazonaws.com/prod'],
    ['https://docs.python.org/', 'docs.python.org'],
    ['https://news.ycombinator.com/', 'news.ycombinator.com'],
    ['https://www.bbc.co.uk/', 'www.bbc.co.uk'],
  ]) {
    assert.equal(sanitizeForLlm(input).url, expected);
  }
});

test('a site name that looks like an identifier is never removed', () => {
  for (const [input, expected] of [
    ['https://www.365datascience.com/courses', 'www.365datascience.com/courses'],
    ['https://www.sitio37.com/guia', 'www.sitio37.com/guia'],
    ['https://win10tools.com/', 'win10tools.com'],
    ['https://a1b2c3d4e5f6.win10tools.com/', 'win10tools.com'],
  ]) {
    assert.equal(sanitizeForLlm(input).url, expected);
  }
});

test('keeps the readable segments around a dropped identifier', () => {
  assert.equal(
    sanitizeForLlm('https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit').url,
    'docs.google.com/document/d/edit',
  );
});

test('malformed percent-encoding is dropped rather than sent raw', () => {
  assert.equal(sanitizeForLlm('https://example.com/ok/%E0%A4%A/also-ok').url, 'example.com/ok/also-ok');
});

test('limits depth and length', () => {
  assert.equal(sanitizeForLlm('https://example.com/a/b/c/d/e/f').url, 'example.com/a/b/c/d');
  assert.ok(sanitizeForLlm(`https://example.com/${'word-'.repeat(15)}x/${'more-'.repeat(15)}y`).url.length <= 120);
  assert.equal(sanitizeForLlm(`https://example.com/${'word-'.repeat(30)}x`).url, 'example.com');
});

const PRIVATE_HOSTS = [
  'http://localhost:3000/admin',
  'http://LOCALHOST./admin',
  'http://app.localhost/',
  'http://hpsrv/grafana',
  'http://printer.local/',
  'https://vault.corp/',
  'https://git.internal/repo',
  'https://laptop.tail1234.ts.net/',
  'http://router.lan/',
  'http://192.168.1.10/',
  'http://10.0.0.5/',
  'http://172.16.3.1/',
  'http://127.0.0.1:8000/',
  'http://2130706433/',
  'http://0x7f.0.0.1/',
  'http://8.8.8.8/',
  'http://[::1]/',
  'http://[fe80::1]/',
  'http://[::ffff:10.0.0.1]/',
];

for (const input of PRIVATE_HOSTS) {
  test(`never sends ${input}`, () => {
    assert.deepEqual(sanitizeForLlm(input), { sendable: false, reason: 'private-host' });
  });
}

for (const input of ['file:///home/me/notes.html', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'ftp://example.com/file']) {
  test(`never sends scheme of ${input}`, () => {
    assert.deepEqual(sanitizeForLlm(input), { sendable: false, reason: 'unsupported-scheme' });
  });
}

test('rejects text that is not a URL', () => {
  assert.deepEqual(sanitizeForLlm('not a url'), { sendable: false, reason: 'invalid-url' });
});

test('selectSendable reduces URLs and counts what is excluded by reason', () => {
  const bookmark = (id, url) => ({ id, title: `t${id}`, url, folderPath: 'F' });
  const { sendable, excluded } = selectSendable([
    bookmark('a', 'https://example.com/post?token=SECRET'),
    bookmark('b', 'http://192.168.1.10/admin'),
    bookmark('c', 'https://nas.local/x'),
    bookmark('d', 'javascript:alert(1)'),
  ]);
  assert.deepEqual(sendable, [{ id: 'a', title: 'ta', url: 'example.com/post', folderPath: 'F' }]);
  assert.deepEqual(excluded, { 'private-host': 2, 'unsupported-scheme': 1 });
});

// --- Corpus of the security audit. Frozen: changing it to improve a number defeats its purpose. ---

const CORPUS_SECRETS = [
  // --- Bearer-like tokens in the path: losing them is the real incident.
  ['token:otp-numeric', 'https://bank.example.com/verify/482913', ['482913']],
  ['token:otp-numeric', 'https://example.com/confirm/7301254', ['7301254']],
  ['token:short-alnum', 'https://example.com/invite/kX9mQ2', ['kX9mQ2']],
  ['token:short-alnum', 'https://app.example.com/i/AbCd3Fg', ['AbCd3Fg']],
  ['token:short-alnum', 'https://discord.gg/aB3dE7x', ['aB3dE7x']],
  ['token:short-alnum', 'https://bit.ly/3abcDEF', ['3abcDEF']],
  ['token:lowercase', 'https://example.com/magic/qmzxtplkwvrh', ['qmzxtplkwvrh']],
  ['token:lowercase', 'https://example.com/unsubscribe/lqmvxotibacuzdwe', ['lqmvxotibacuzdwe']],
  ['token:lowercase', 'https://example.com/reset/oviqatemuzyrelonixad', ['oviqatemuzyrelonixad']],
  ['token:uppercase', 'https://pay.example.com/pay/QMZXTPLKWV', ['QMZXTPLKWV']],
  ['token:uppercase', 'https://example.com/booking/PQRSTUVWXYZA', ['PQRSTUVWXYZA']],
  ['token:chunked', 'https://example.com/login/token/x7k2-m9p4-q1w8-z3r6', ['x7k2']],
  ['token:chunked', 'https://example.com/confirm/ABCD-EFGH-JKLM-NPQR', ['ABCD']],
  ['token:chunked', 'https://example.com/recovery/7f3a_9c2e_4b1d_8f60', ['7f3a']],
  ['token:chunked', 'https://license.example.com/activate/A1B2C-D3E4F-G5H6I-J7K8L', ['A1B2C']],
  ['token:passphrase', 'https://example.com/auth/magic/correct-horse-battery-staple', ['correct-horse']],
  ['token:passphrase', 'https://whereby.com/secret-board-room-acme', ['secret-board']],
  ['token:passphrase', 'https://meet.jit.si/AcmeLayoffsPlanning', ['AcmeLayoffs']],
  ['token:django-uid', 'https://example.com/accounts/reset/MQ/set-password', ['MQ']],
  ['token:meet-code', 'https://meet.google.com/abc-defg-hij', ['abc-defg-hij']],
  ['token:meet-code', 'https://zoom.us/my/ana.perez', ['ana.perez']],
  ['token:double-encoded', 'https://example.com/p%253Dabc', ['abc']],
  ['token:double-encoded', 'https://example.com/pw%253Dhunter', ['hunter']],
  ['token:double-encoded', 'https://example.com/a%252Fshortsecret', ['shortsecret']],
  ['token:unicode', 'https://example.com/k/a1b2c3d4e5f6a7b8é', ['a1b2c3d4e5f6a7b8']],
  ['token:unicode', 'https://example.com/k/%EF%BD%94%EF%BD%8B%EF%BD%8E%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96%EF%BC%97%EF%BC%98', ['ｔｋｎ']],
  // --- Tokens the heuristic should catch (control group).
  ['token:control', 'https://example.com/reset-password/7f3a9c2e4b1d8f60', ['7f3a9c2e4b1d8f60']],
  ['token:control', 'https://example.com/magic/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl', ['eyJhbGci', 'eyJzdWIi', 'c2lnbmF0']],
  ['token:control', 'https://example.com/auth/550e8400-e29b-41d4-a716-446655440000/done', ['550e8400', '446655440000']],
  ['token:control', 'https://hooks.slack.com/' + 'services/T024BE7LH/B0A1B2C3D/a1B2c3D4e5F6g7H8i9J0k1L2', ['T024BE7LH', 'B0A1B2C3D', 'a1B2c3D4']],
  ['token:control', 'https://api.telegram.org/' + 'bot123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCrZvVVw/getMe', ['123456789', 'AAEhBOweik']],
  ['token:control', 'https://discord.com/api/' + 'webhooks/123456789012345678/AbC-dEf_GhIjKlMnOpQrStUvWxYz012345', ['123456789012345678', 'GhIjKlMnOp']],
  ['token:control', 'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit', ['1BxiMVs0']],
  ['token:control', 'https://drive.google.com/file/d/0B1a2B3c4D5e6F7g8H9i0J/view?usp=sharing', ['0B1a2B3c']],
  ['token:control', 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345', ['1AbCdEfG']],
  ['token:control', 'https://docs.google.com/forms/d/e/1FAIpQLSdAbCdEfGhIjKlMnOpQrStUvWxYz012/viewform', ['1FAIpQL']],
  ['token:control', 'https://us02web.zoom.us/j/81234567890?pwd=abcDEF123', ['81234567890', 'abcDEF123']],
  ['token:control', 'https://acme.zoom.us/rec/share/AbC123dEf456GhI789', ['AbC123dEf']],
  ['token:control', 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmFrZQ%40thread.v2/0?context=x', ['meeting_ZmFrZQ']],
  ['token:control', 'https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4e5F6g7H8', ['cs_live_a1B2']],
  ['token:control', 'https://s3.amazonaws.com/bucket/f.pdf?X-Amz-Signature=abc123&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE', ['X-Amz', 'AKIAIOSFODNN7EXAMPLE', 'abc123']],
  ['token:control', 'https://acct.blob.core.windows.net/c/f.pdf?sv=2022-11-02&sig=abc%3D&se=2030', ['sig=', 'abc%3D']],
  ['token:control', 'https://storage.googleapis.com/b/f.pdf?X-Goog-Signature=deadbeef', ['X-Goog', 'deadbeef']],
  ['token:control', 'https://d111111abcdef8.cloudfront.net/f.pdf?Signature=xyz&Policy=abc', ['d111111abcdef8', 'Signature', 'xyz']],
  ['token:control', 'https://user:hunter2@example.com/x', ['hunter2', 'user']],
  ['token:control', 'https://ghp_abcdef1234567890@github.com/o/r', ['ghp_abcdef']],
  ['token:control', 'https://example.com/#access_token=abc123', ['access_token', 'abc123']],
  ['token:control', 'https://example.com/go%3Fsecret%3Dhunter2', ['hunter2']],
  ['token:control', 'https://example.com/app;jsessionid=shortsecret', ['shortsecret']],
  ['token:control', 'https://example.com/(S(lit3py55t21z5v55vlm25s55))/default.aspx', ['lit3py55']],
  ['token:control', 'https://example.com/%73%65%63%72%65%74%31%32%33%34', ['secret1234']],
  ['token:control', 'https://example.com/card/4111111111111111', ['4111111111111111']],
  ['token:control', 'https://wa.me/56912345678', ['56912345678']],
  // --- Personal or corporate identity in host or path. Passing is by design today; counted apart.
  ['id:person-host', 'https://ana-perez.github.io/notas', ['ana-perez']],
  ['id:person-host', 'https://anaperez.notion.site/Plan', ['anaperez']],
  ['id:person-host', 'https://anaperez.substack.com/', ['anaperez']],
  ['id:person-host', 'https://ana.perez.wordpress.com/', ['ana.perez']],
  ['id:person-path', 'https://www.linkedin.com/in/ana-perez-1a2b3c', ['ana-perez']],
  ['id:person-path', 'https://calendly.com/ana-perez/30min', ['ana-perez']],
  ['id:person-path', 'https://acme-my.sharepoint.com/personal/ana_perez_acme_com/Documents/Salaries.xlsx', ['ana_perez']],
  ['id:person-path', 'https://example.com/~anaperez/private/', ['anaperez']],
  ['id:person-path', 'https://www.facebook.com/ana.perez.12345', ['ana.perez']],
  ['id:company-host', 'https://acme-corp.slack.com/archives/C01ABCDEF/p1699999999000100', ['acme-corp']],
  ['id:company-host', 'https://acme.atlassian.net/browse/ACME-123', ['acme.atlassian']],
  ['id:company-host', 'https://acme.okta.com/app/UserHome', ['acme.okta']],
  ['id:company-host', 'https://acme.zendesk.com/agent/tickets/4711', ['acme.zendesk']],
  ['id:company-host', 'https://acme.sharepoint.com/:x:/r/sites/Finance/Shared%20Documents/Bonus%202026.xlsx?d=abc', ['acme.sharepoint']],
  ['id:company-host', 'https://acme-payroll.s3.us-east-1.amazonaws.com/2026/nomina.pdf?X-Amz-Signature=abc', ['acme-payroll']],
  ['id:company-host', 'https://acmeprod.blob.core.windows.net/contracts/nda.pdf?sig=abc', ['acmeprod']],
  ['id:company-path', 'https://join.slack.com/t/acme-corp/shared_invite/zt-1abcd2efg-HiJkLmNoPqRsTuV', ['acme-corp']],
  ['id:doc-name', 'https://www.dropbox.com/scl/fi/abc123xyz/Contrato-Ana-Perez.pdf?rlkey=abc&dl=0', ['Contrato-Ana-Perez']],
  ['id:doc-name', 'https://www.figma.com/file/AbC123dEf456/Acme-Confidential-Roadmap', ['Acme-Confidential']],
  ['id:doc-name', 'https://acme.atlassian.net/wiki/spaces/HR/pages/123456789/Salary+Bands', ['Salary+Bands']],
  ['id:doc-name', 'https://s3.amazonaws.com/acme-payroll/2026/nomina-ana-perez.pdf?X-Amz-Signature=abc', ['nomina-ana-perez']],
  ['id:national-id', 'https://example.com/clientes/12.345.678-9/ficha', ['12.345.678-9']],
  ['id:national-id', 'https://example.com/tel/+56-9-1234-5678', ['1234-5678']],
  ['id:card', 'https://example.com/card/4111-1111-1111-1111', ['4111-1111']],
  ['id:invoice', 'https://pay.example.com/invoice/INV-2026-00123', ['INV-2026-00123']],
  ['id:email-variant', 'https://example.com/u/ana(at)example.org', ['ana(at)example']],
  ['id:email-variant', 'https://example.com/u/ana_at_example.org', ['ana_at_example']],
  ['id:email-variant', 'https://example.com/u/ana%EF%BC%A0example.org', ['example.org']],
  ['id:email-control', 'https://example.com/u/ana%40example.org', ['ana']],
  ['id:email-control', 'https://mail.google.com/mail/u/ana.perez@gmail.com/#inbox', ['ana.perez']],
  ['id:email-control', 'https://example.com/u/ana%2540example.org', ['ana%40']],
];

const CORPUS_PRIVATE = [
  ['control', 'http://localhost:3000/a'], ['control', 'http://LOCALHOST./a'], ['control', 'http://127.0.0.1/'],
  ['control', 'http://2130706433/'], ['control', 'http://0x7f.1/'], ['control', 'http://0177.0.0.1/'], ['control', 'http://127.1/'],
  ['control', 'http://0/'], ['control', 'http://[::1]/'], ['control', 'http://[::ffff:10.0.0.1]/'], ['control', 'http://１２７．０．０．１/'],
  ['control', 'http://①②⑦.⓪.⓪.①/'], ['control', 'http://ｌｏｃａｌｈｏｓｔ/'], ['control', 'http://printer。local/'], ['control', 'http://printer%2Elocal/'],
  ['control', 'http://printer.LOCAL./'], ['control', 'http://hpsrv./'], ['control', 'http://nas.home.arpa/'], ['control', 'https://app.tail1234.ts.net/'],
  ['control', 'http://svc.ns.svc.cluster.local/'], ['control', 'http://x.corp/'], ['control', 'http://x.INTERNAL/'], ['control', 'http://127.0.0.1./'],
  ['known', 'http://printer.local../'], ['known', 'http://localhost../'], ['known', 'http://127.0.0.1../'], ['known', 'http://10.0.0.5.nip.io/'], ['known', 'http://10-0-0-5.sslip.io/'],
  ['mid-label', 'https://jira.corp.acme.com/browse/X-1'], ['mid-label', 'https://git.internal.acme.com/team/repo'], ['mid-label', 'https://wiki.intranet.acme.com/rrhh'],
  ['mid-label', 'https://grafana.lan.acme.net/d/x'], ['mid-label', 'https://intranet.acme.com/rrhh'], ['mid-label', 'https://vpn.acme.com/'], ['mid-label', 'https://jenkins.prod.acme.cloud/job/x'],
  ['suffix', 'http://router.localdomain/'], ['suffix', 'http://fritz.box/'], ['suffix', 'http://pi.hole/admin'], ['suffix', 'http://speedport.ip/'], ['suffix', 'https://vault.service.consul/'],
  ['suffix', 'http://grafana.monitoring.svc/'], ['suffix', 'http://srv.intra/'], ['suffix', 'http://srv.private/'], ['suffix', 'http://srv.priv/'], ['suffix', 'http://srv.example/'],
  ['suffix', 'http://srv.invalid/'], ['suffix', 'http://abc.onion/'], ['suffix', 'http://abc.i2p/'], ['suffix', 'http://srv.alt/'], ['suffix', 'http://nas.workgroup/'], ['suffix', 'http://dc01.acme.ad/'],
  ['suffix', 'https://host.beta.tailscale.net/'], ['suffix', 'https://host.zt/'],
  ['loopback-dns', 'http://localtest.me/'], ['loopback-dns', 'http://app.lvh.me/'], ['loopback-dns', 'http://x.vcap.me/'], ['loopback-dns', 'http://x.traefik.me/'], ['loopback-dns', 'http://x.127.0.0.1.xip.io/'],
];

const CORPUS_BENIGN = [
  ['https://en.wikipedia.org/wiki/Claude_Shannon', 'Claude_Shannon'],
  ['https://en.wikipedia.org/wiki/Python_(programming_language)', 'Python_('],
  ['https://en.wikipedia.org/wiki/Bogot%C3%A1', 'Bogotá'],
  ['https://en.wikipedia.org/wiki/Base64', 'Base64'],
  ['https://en.wikipedia.org/wiki/Windows_10', 'Windows_10'],
  ['https://github.com/torvalds/linux', 'torvalds/linux'],
  ['https://github.com/apache/iceberg/blob/main/README.md', 'apache/iceberg'],
  ['https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster', 'why-is-processing'],
  ['https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', 'docs/Web'],
  ['https://www.nytimes.com/2024/01/13/technology/ai-chatbots.html', '2024/01/13'],
  ['https://www.bbc.com/news/world-europe-12345678', 'world-europe'],
  ['https://www.amazon.com/Clean-Code-Handbook-Software-Craftsmanship/dp/0132350882', 'Clean-Code'],
  ['https://www.reddit.com/r/programming/comments/abc123/some_title/', 'programming'],
  ['https://arxiv.org/abs/2301.12345', '2301.12345'],
  ['https://arxiv.org/pdf/2301.12345v2', 'arxiv.org/pdf'],
  ['https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html', 'AmazonS3'],
  ['https://aws.amazon.com/ec2/instance-types/', 'instance-types'],
  ['https://cloud.google.com/bigquery/docs/partitioned-tables', 'partitioned-tables'],
  ['https://spark.apache.org/docs/3.5.1/sql-ref.html', '3.5.1'],
  ['https://www.postgresql.org/docs/16/sql-select.html', 'sql-select'],
  ['https://iceberg.apache.org/docs/1.5.0/', 'iceberg'],
  ['https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-messagebox', 'windows/win32'],
  ['https://www.apple.com/iphone-15-pro/', 'iphone-15-pro'],
  ['https://www.apple.com/iphone15/', 'iphone15'],
  ['https://www.python.org/downloads/release/python-3120/', 'python-3120'],
  ['https://pypi.org/project/numpy/', 'numpy'],
  ['https://www.npmjs.com/package/@anthropic-ai/sdk', 'anthropic-ai'],
  ['https://hub.docker.com/_/postgres', 'postgres'],
  ['https://www.goodreads.com/book/show/5907.The_Hobbit', 'The_Hobbit'],
  ['https://medium.com/@ana/how-i-built-my-first-etl-pipeline-1a2b3c4d5e6f', 'etl-pipeline'],
  ['https://towardsdatascience.com/some-article-about-spark-abcdef123456', 'about-spark'],
  ['https://dev.to/ana/building-a-data-lake-4k2j', 'data-lake'],
  ['https://www.recetasgratis.net/receta-de-pan-de-masa-madre-12345.html', 'pan-de-masa'],
  ['https://www.mercadolibre.com.ar/notebook-lenovo-ideapad-3/p/MLA12345678', 'notebook-lenovo'],
  ['https://www.lanacion.com.ar/politica/titulo-sobre-economia-nid13012024/', 'titulo-sobre'],
  ['https://www.emol.com/noticias/Economia/2024/01/13/1234567/titulo.html', 'Economia'],
  ['https://www.kaggle.com/datasets/ana/covid19-global-forecasting', 'covid19-global'],
  ['https://huggingface.co/meta-llama/Llama-3.1-8B', 'Llama-3.1-8B'],
  ['https://huggingface.co/mistralai/Mistral-7B-v0.1', 'Mistral-7B'],
  ['https://ollama.com/library/llama3', 'llama3'],
  ['https://example.com/blog/2024-review', '2024-review'],
  ['https://example.com/blog/python311-whats-new', 'whats-new'],
  ['https://example.com/blog/ubuntu2204-install', 'install'],
  ['https://example.com/guides/office365-migration', 'migration'],
  ['https://example.com/blog/windows10-install-guide', 'install-guide'],
  ['https://example.com/s3-bucket-policy-examples', 'bucket-policy'],
  ['https://example.com/h264-vs-h265', 'h264'],
  ['https://example.com/x86_64-assembly', 'assembly'],
  ['https://example.com/ipv6-addressing', 'ipv6'],
  ['https://example.com/utf8-everywhere', 'utf8'],
  ['https://example.com/oauth2-explained', 'oauth2'],
  ['https://www.w3.org/TR/html52/', 'html52'],
  ['https://datatracker.ietf.org/doc/html/rfc9110', 'rfc9110'],
  ['https://docs.docker.com/engine/reference/commandline/compose_up/', 'commandline'],
  ['https://kubernetes.io/docs/concepts/workloads/', 'workloads'],
  ['https://airflow.apache.org/docs/apache-airflow/2.8.1/tutorial/index.html', 'apache-airflow'],
  ['https://support.google.com/mail/answer/56256', 'mail/answer'],
  ['https://www.nature.com/articles/s41586-021-03819-2', 'articles'],
  ['https://www.imdb.com/title/tt0111161/', 'imdb.com/title'],
  ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', 'track'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube.com/watch'],
  ['https://es.wikipedia.org/wiki/Educaci%C3%B3n', 'Educación'],
  ['https://example.jp/記事/パン作り', 'パン作り'],
  ['https://www.bbc.co.uk/news/technology', 'bbc.co.uk'],
  ['https://www.365datascience.co.uk/courses', '365datascience'],
  ['https://win10tools.com.ar/guia', 'win10tools'],
];

/** @param {string} family */
function leaksOf(family) {
  return CORPUS_SECRETS.filter(([name]) => name === family || (family.endsWith(':') && name.startsWith(family) && name !== 'token:control')).filter(([, url, secrets]) => {
    const result = sanitizeForLlm(url);
    return result.sendable && secrets.some((secret) => result.url.toLowerCase().includes(secret.toLowerCase()));
  });
}

/**
 * Limits are what the audit measured after its fixes. They only ever go down. These numbers are
 * in-sample, since the rules were written with this corpus in view; the fuzzing below is not.
 */
for (const [family, limit] of [
  ['token:', 0],
  ['token:control', 0],
  ['id:email-control', 0],
  ['id:company-host', 0],
  ['id:company-path', 0],
  ['id:national-id', 0],
  ['id:card', 0],
  ['id:invoice', 0],
  ['id:person-host', 4],
  ['id:person-path', 4],
  ['id:doc-name', 2],
  ['id:email-variant', 2],
]) {
  test(`corpus: ${family} leaks at most ${limit}`, () => {
    const leaked = leaksOf(family).map(([, url]) => url);
    assert.ok(leaked.length <= limit, `${leaked.length} leaked:\n${leaked.join('\n')}`);
  });
}

for (const [family, limit] of [
  ['control', 0],
  ['known', 0],
  ['mid-label', 1],
  ['suffix', 1],
  ['loopback-dns', 0],
]) {
  test(`corpus: private hosts of family ${family} sent at most ${limit}`, () => {
    const sent = CORPUS_PRIVATE.filter(([name, url]) => name === family && sanitizeForLlm(url).sendable).map(([, url]) => url);
    assert.ok(sent.length <= limit, `${sent.length} sent:\n${sent.join('\n')}`);
  });
}

test('corpus: benign pages keep their topic, with at most 7 of 66 false positives', () => {
  const lost = CORPUS_BENIGN.filter(([url, keep]) => {
    const result = sanitizeForLlm(url);
    return !result.sendable || !result.url.toLowerCase().includes(keep.toLowerCase());
  }).map(([url]) => url);
  assert.ok(lost.length <= 7, `${lost.length} lost:\n${lost.join('\n')}`);
});

// --- Fuzzing with a fixed seed, so a change in these numbers is a change in url.js. ---

/** @param {number} seed */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGIT = '0123456789';
const FUZZ_SAMPLES = 1000;

/** @param {() => number} random @param {string} alphabet @param {number} length */
function randomToken(random, alphabet, length) {
  return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
}

/** @param {(random: () => number) => string} make percent of generated values with something left */
function survivalRate(make) {
  const random = createRandom(20261105);
  let survived = 0;
  for (let i = 0; i < FUZZ_SAMPLES; i += 1) {
    const { url } = sanitizeForLlm(`https://example.com/t/${encodeURIComponent(make(random))}`);
    if (url.split('/t/')[1]) survived += 1;
  }
  return (survived / FUZZ_SAMPLES) * 100;
}

// Percent of random tokens that survive, at most. Under 8 characters every alphabet survives, by
// design: see the comment at the top of url.js. Before the audit: letters 100 % up to 12
// characters, 37 % at 16 and 18 % at 43.
for (const [alphabetName, alphabet, limits] of [
  ['hex', '0123456789abcdef', { 8: 1, 12: 0, 16: 0, 24: 0, 32: 0, 43: 0 }],
  ['base32', `${LOWER}234567`, { 8: 46, 12: 25, 16: 1, 24: 0, 32: 0, 43: 0 }],
  ['base36', LOWER + DIGIT, { 8: 28, 12: 11, 16: 1, 24: 0, 32: 0, 43: 0 }],
  ['base62', LOWER + UPPER + DIGIT, { 8: 36, 12: 8, 16: 1, 24: 0, 32: 0, 43: 0 }],
  ['base64url', `${LOWER}${UPPER}${DIGIT}-_`, { 8: 50, 12: 20, 16: 8, 24: 2, 32: 0, 43: 0 }],
  ['lowercase letters', LOWER, { 8: 57, 12: 32, 16: 17, 24: 7, 32: 0, 43: 0 }],
  ['uppercase letters', UPPER, { 8: 57, 12: 32, 16: 17, 24: 7, 32: 0, 43: 0 }],
  ['digits', DIGIT, { 8: 0, 12: 0, 16: 0, 24: 0, 32: 0, 43: 0 }],
]) {
  for (const [length, limit] of Object.entries(limits)) {
    test(`fuzz: random ${alphabetName} of ${length} survives at most ${limit} %`, () => {
      const rate = survivalRate((random) => randomToken(random, alphabet, Number(length)));
      assert.ok(rate <= limit, `${rate} %`);
    });
  }
}

/** @param {() => number} random @param {string} alphabet @param {number} size @param {number} count */
const chunks = (random, alphabet, size, count, separator = '-') =>
  Array.from({ length: count }, () => randomToken(random, alphabet, size)).join(separator);

// All of these survived 100 % before the audit, except the UUID. A Meet-style code (letters 3-4-3)
// and word-word-digits still do: no shape tells them from a slug.
for (const [name, limit, make] of [
  ['UUID v4', 0, (random) => [8, 4, 4, 4, 12].map((size) => randomToken(random, '0123456789abcdef', size)).join('-')],
  ['card number', 0, (random) => chunks(random, DIGIT, 4, 4)],
  ['license key', 0, (random) => chunks(random, UPPER + DIGIT, 5, 5)],
  ['recovery code', 0, (random) => chunks(random, '0123456789abcdef', 4, 4, '_')],
  ['base32 groups', 0, (random) => chunks(random, `${LOWER}234567`, 4, 4)],
  ['base62 groups', 0, (random) => chunks(random, LOWER + UPPER + DIGIT, 6, 3)],
]) {
  test(`fuzz: ${name} survives at most ${limit} %`, () => {
    const rate = survivalRate(make);
    assert.ok(rate <= limit, `${rate} %`);
  });
}

test('fuzz: hostile paths never throw and never leave query syntax, emails or invisible characters', () => {
  const pieces = ['%0A', '%00', '%E2%80%AE', '%F3%A0%81%81', '%E2%80%8B', '%3C', '%3E', '%22', '%60', '%7C', '%3D', '%3F', '%26', '%23', '%40', '%2F', '%25', '%253D', '%252F', 'a', 'B', '1', '-', '_', '.', '~', '%', '@', ':', ';', '=', '?', '#', '&', '/', '\\', ' ', 'é', '日本', '％', '＠', '／', '＝'];
  const random = createRandom(7);
  for (let i = 0; i < 20000; i += 1) {
    const path = Array.from({ length: 1 + Math.floor(random() * 8) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    const result = sanitizeForLlm(`https://example.com/${path}`);
    assert.equal(result.sendable, true, path);
    for (const segment of result.url.split('/').slice(1)) {
      assert.doesNotMatch(segment, /[?#&=<>"`|\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]|[^\s@]@[^\s@]|%[0-9a-f]{2}/iu, path);
    }
  }
});

// --- A case on each side of every threshold (QA-2). ---

/** Readable text of exactly `length` characters, with no chunk rule in play. */
const readableOf = (length) => 'lorem-ipsum-dolor-sit-amet-consectetur-adipiscing-elit-sed-do-eiusmod-tempor-incididunt-ut-labore'.slice(0, length).replace(/-$/, 'a');

for (const [rule, segment, isKept] of [
  ['digits only, under the length', '1234567', true],
  ['digits only, at the length', '12345678', false],
  ['letters and 2 digits, under the length', 'abcde12', true],
  ['letters and 2 digits, at the length', 'abcdef12', false],
  ['letters and 1 digit, at the length', 'abeduc1a', true],
  ['4 case flips, under the length', 'aEiOuAe', true],
  ['3 case flips, at the length', 'aeIOuaEI', true],
  ['4 case flips, at the length', 'aeIOuAei', false],
  ['consonant run of 4, at the length', 'anghtelo', true],
  ['consonant run of 5, at the length', 'ngsthelo', false],
  ['consonant run of 5, under the length', 'ngsthel', true],
  ['few vowels, under the long length', 'bcdabcdabcdabcd', true],
  ['few vowels, at the long length', 'bcdabcdebcdibcdf', false],
  ['vowel ratio at the limit', 'bcdabcdebcdibcdo', true],
  ['vowel ratio just under the limit', 'bcdabcdebcdibcdobcdf', false],
  ['readable long word', 'internationalization', true],
  ['long word at the limit', 'bae'.repeat(10), true],
  ['long word past the limit', `${'bae'.repeat(10)}b`, false],
  ['7 digits across chunks', '123-4567', true],
  ['8 digits across chunks', '1234-5678', false],
  ['8 digits outnumbered by letters', 'abcdefghi-1234-5678', true],
  ['8 digits as many as the letters', 'abcdefgh-1234-5678', false],
  ['digits and punctuation', '123!456!78', false],
  ['a date', '2024-01-13', true],
  ['a date heading a slug', '2024-01-13-some-title', true],
  ['2 mixed chunks', 'a1-b2-cde', true],
  ['3 mixed chunks', 'a1-b2-c3', false],
  ['2 equal machine-like chunks', 'ABCD-EFGH', true],
  ['3 equal words', 'node-java-rust', true],
  ['3 equal chunks, 1 machine-like', 'ABCD-java-rust', true],
  ['3 equal chunks, 2 machine-like', 'ABCD-EFGH-rust', false],
  ['4 equal chunks', 'node-java-rust-bash', false],
  ['4 unequal chunks', 'node-java-rusty-bash', true],
  ['4 equal chunks of 3', 'abc-def-ghi-jkl', true],
  ['cyrillic slug', 'пример-длинной-статьи', true],
  ['CJK slug', 'パン作りの基本と応用についての詳しい解説', true],
  ['an accent next to a token', 'a1b2c3d4e5f6a7b8é', false],
  ['an accent inside a word', 'educación', true],
  ['a handle', '@channel', true],
  ['an address without a domain', 'ana@', false],
  ['a doubled at sign', 'a@@b', false],
  ['fullwidth token', '１２３４５６７８', false],
  ['still encoded', 'p%3Dabc', false],
  ['markup', '<script>', false],
]) {
  test(`threshold: ${rule} (${segment}) ${isKept ? 'stays' : 'goes'}`, () => {
    const expected = isKept ? `example.com/${segment}` : 'example.com';
    assert.equal(sanitizeForLlm(`https://example.com/${encodeURIComponent(segment)}`).url, expected);
  });
}

test('threshold: a segment of 80 characters stays and one of 81 goes', () => {
  const at = readableOf(80);
  const past = readableOf(81);
  assert.equal(at.length, 80);
  assert.equal(past.length, 81);
  assert.equal(sanitizeForLlm(`https://example.com/${at}`).url, `example.com/${at}`);
  assert.equal(sanitizeForLlm(`https://example.com/${past}`).url, 'example.com');
});

test('threshold: a URL of 120 characters stays and one of 121 loses its last segment', () => {
  const first = readableOf(50);
  const prefix = `example.com/${first}/`;
  const fits = readableOf(120 - prefix.length);
  const overflows = readableOf(121 - prefix.length);
  assert.equal(`${prefix}${fits}`.length, 120);
  assert.equal(sanitizeForLlm(`https://${prefix}${fits}`).url, `${prefix}${fits}`);
  assert.equal(sanitizeForLlm(`https://${prefix}${overflows}`).url, `example.com/${first}`);
});

test('threshold: 4 path segments stay and a fifth goes', () => {
  assert.equal(sanitizeForLlm('https://example.com/a/b/c/d').url, 'example.com/a/b/c/d');
  assert.equal(sanitizeForLlm('https://example.com/a/b/c/d/e').url, 'example.com/a/b/c/d');
});

test('threshold: a reduced host of 80 characters stays, and past it the outer labels go', () => {
  const labels = `${'banana.'.repeat(9)}`;
  const fits = `abcde.${labels}example.com`;
  assert.equal(fits.length, 80);
  assert.equal(sanitizeForLlm(`https://${fits}/`).url, fits);
  assert.equal(sanitizeForLlm(`https://abcdef.${labels}example.com/`).url, `${labels}example.com`);
});

test('threshold: a site name past 120 characters is not a URL worth sending', () => {
  const at = `${'a'.repeat(116)}.com`;
  assert.deepEqual(sanitizeForLlm(`https://${at}/`), { sendable: true, url: at });
  assert.deepEqual(sanitizeForLlm(`https://a${at}/`), { sendable: false, reason: 'invalid-url' });
});

// --- Known defect 2 and private hosts. ---

for (const input of [
  'http://printer.local../',
  'http://printer.local.../',
  'https://example.com../',
  'http://localhost../',
  'http://127.0.0.1../',
  'http://10.0.0.5.nip.io/',
  'http://10-0-0-5.sslip.io/',
  'http://ip-10-0-0-5.example.com/',
  'http://printer..local/',
  'http://a..example.com/',
  'https://git.internal.acme.com/team/repo',
  'https://jira.corp.acme.co.uk/browse/X-1',
  'https://intranet.acme.com/rrhh',
  'https://vpn.acme.com/',
  'http://abc.onion/',
]) {
  test(`never sends ${input} (private)`, () => {
    assert.deepEqual(sanitizeForLlm(input), { sendable: false, reason: 'private-host' });
  });
}

test('a public site named like an internal label is still public', () => {
  for (const host of ['corp.com', 'www.local.com', 'lan.com', 'intranet.co.uk', 'vpn.com']) {
    assert.equal(sanitizeForLlm(`https://${host}/x`).url, `${host}/x`);
  }
});

// --- Site names under suffixes of several labels. ---

test('the site name survives under a suffix of two labels', () => {
  for (const [input, expected] of [
    ['https://www.365datascience.co.uk/courses', 'www.365datascience.co.uk/courses'],
    ['https://win10tools.com.ar/guia', 'win10tools.com.ar/guia'],
    ['https://a1b2c3d4e5f6.win10tools.com.ar/', 'win10tools.com.ar'],
    ['https://a1b2c3d4e5f6.sitio.gob.cl/', 'sitio.gob.cl'],
    ['https://www.bbc.co.uk/news', 'www.bbc.co.uk/news'],
    ['https://www.gov.uk/guidance', 'www.gov.uk/guidance'],
    ['https://com.ar/', 'com.ar'],
    ['https://t.co', 't.co'],
    ['https://a1b2c3d4e5f6.org.app/', 'org.app'],
  ]) {
    assert.equal(sanitizeForLlm(input).url, expected);
  }
});

test('outside those suffixes the last two labels still name the site', () => {
  assert.equal(sanitizeForLlm('https://a1b2c3d4e5f6.vercel.app/').url, 'vercel.app');
  assert.equal(sanitizeForLlm('https://a1b2c3d4e5f6.example.io/').url, 'example.io');
});

// --- Contextual rules. ---

test('a tenant host says which service it is and nothing else', () => {
  for (const [input, expected] of [
    ['https://acme.okta.com/app/UserHome', 'okta.com'],
    ['https://acme.atlassian.net/wiki/spaces/HR/pages/1/Salary+Bands', 'atlassian.net'],
    ['https://acme-my.sharepoint.com/personal/ana_perez_acme_com/Documents/Salaries.xlsx', 'sharepoint.com'],
    ['https://acmeprod.blob.core.windows.net/contracts/nda.pdf?sig=abc', 'blob.core.windows.net'],
    ['https://acme-payroll.s3.us-east-1.amazonaws.com/2026/nomina.pdf', 's3.us-east-1.amazonaws.com'],
    ['https://s3.amazonaws.com/acme-payroll/2026/nomina.pdf', 's3.amazonaws.com'],
    ['https://www.okta.com/blog/post', 'www.okta.com/blog/post'],
    ['https://slack.com/help/articles', 'slack.com/help/articles'],
    ['https://www.slack.com/help/articles', 'www.slack.com/help/articles'],
    ['https://www.acme.atlassian.net/wiki/spaces/ENG/pages/123/Title', 'atlassian.net'],
    ['https://my-bucket.storage.googleapis.com/secret/informe-medico.pdf', 'storage.googleapis.com'],
  ]) {
    assert.equal(sanitizeForLlm(input).url, expected);
  }
});

test('hosts whose path is a secret lose all of it', () => {
  for (const [input, expected] of [
    ['https://meet.google.com/abc-defg-hij', 'meet.google.com'],
    ['https://zoom.us/my/ana.perez', 'zoom.us'],
    ['https://www.zoom.us/my/ana.perez', 'www.zoom.us'],
    ['https://discord.gg/aB3dE7x', 'discord.gg'],
    ['https://bit.ly/3abcDEF', 'bit.ly'],
    ['https://storage.googleapis.com/acme/report.pdf', 'storage.googleapis.com'],
    ['https://storage.cloud.google.com/my-bucket/informe-medico.pdf', 'storage.cloud.google.com'],
  ]) {
    assert.equal(sanitizeForLlm(input).url, expected);
  }
});

test('nothing goes after a segment that announces a one-time value', () => {
  for (const [input, expected] of [
    ['https://example.com/verify/482913', 'example.com/verify'],
    ['https://example.com/auth/magic/correct-horse-battery-staple', 'example.com/auth/magic'],
    ['https://example.com/INVITE/kX9mQ2', 'example.com/INVITE'],
    ['https://example.com/password_reset/kX9mQ2', 'example.com/password_reset'],
    ['https://www.linkedin.com/in/ana-perez-1a2b3c4d', 'www.linkedin.com/in'],
    ['https://example.com/reset-password/abc/more', 'example.com/reset-password'],
  ]) {
    assert.equal(sanitizeForLlm(input).url, expected);
  }
});

// --- Only the opaque chunk goes when the rest of the slug is readable. ---

test('a slug loses the id at either end and keeps its words', () => {
  for (const [input, expected] of [
    ['https://medium.com/@ana/how-i-built-my-first-etl-pipeline-1a2b3c4d5e6f', 'medium.com/@ana/how-i-built-my-first-etl-pipeline'],
    ['https://example.com/some-article-about-spark-abcdef123456', 'example.com/some-article-about-spark'],
    ['https://example.com/titulo-sobre-economia-nid13012024/', 'example.com/titulo-sobre-economia'],
    ['https://example.com/12345678-pastel-de-choclo', 'example.com/pastel-de-choclo'],
    ['https://example.com/some-article-about-spark-abcdef123456.html', 'example.com/some-article-about-spark'],
    ['https://example.com/How-I-Built-It-abcdef123456', 'example.com/How-I-Built-It'],
    ['https://example.com/t%C3%ADtulo-sobre-econom%C3%ADa-abcdef123456', 'example.com/título-sobre-economía'],
  ]) {
    assert.equal(sanitizeForLlm(input).url, expected);
  }
});

test('the rest of the segment must read as a slug for the id to be cut alone', () => {
  for (const segment of [
    'world-europe-12345678', // two words: a person's name has this shape
    'ana-perez-1a2b3c4d',
    'how-to-a1b2c3d4-do-this', // id in the middle
    'a1b2c3d4-how-to-do-this-e5f6a7b8', // two ids
    'AbC-dEf-ghi-Xy12Zk98Qw76', // fragments of a token
    'ab-cd-ef-Xy12Zk98Qw76', // too few letters
    'bcd-fgh-jkl-Xy12Zk98Qw76', // no vowels
    'abc123def456-how-to-do-qmzxtplkwvrh', // two ids, and one of them is all letters
    'abceefgh-idklmeop-qastuvax-a1b2c3d4', // equal groups of a long value
    `${readableOf(70)}-abc123def456`, // the whole segment is over the limit
  ]) {
    assert.equal(sanitizeForLlm(`https://example.com/${segment}`).url, 'example.com', segment);
  }
});

test('fuzz: the id cut from a slug never leaves, and random tokens are not reopened', () => {
  const random = createRandom(99);
  for (let i = 0; i < 2000; i += 1) {
    const id = randomToken(random, '0123456789abcdef', 12);
    if (!/\d.*\d/.test(id) || !/[a-f]/.test(id)) continue;
    const { url } = sanitizeForLlm(`https://example.com/t/how-to-${randomToken(random, LOWER, 6)}-${id}`);
    assert.ok(!url.includes(id), url);
  }
});

// --- selectSendable with an excluded folder. ---

test('selectSendable leaves out the folders the person excluded, before looking at their URLs', () => {
  const bookmark = (id, folderPath, url = 'https://example.com/post') => ({ id, title: `t${id}`, url, folderPath });
  const bookmarks = [
    bookmark('a', 'Salud/Exámenes'),
    bookmark('b', 'Cocina'),
    bookmark('c', 'SALUD'),
    bookmark('d', 'Salud', 'http://192.168.1.10/'),
    bookmark('e', 'Cocina', 'http://192.168.1.10/'),
  ];
  for (const excludeFolder of [/salud/i, /salud/gi]) {
    const { sendable, excluded } = selectSendable(bookmarks, { excludeFolder });
    assert.deepEqual(sendable.map(({ id }) => id), ['b']);
    assert.deepEqual(excluded, { 'excluded-folder': 3, 'private-host': 1 });
  }
});

test('selectSendable excludes nothing by default and matches what the name really says', () => {
  const bookmark = (id, folderPath) => ({ id, title: 't', url: 'https://example.com/', folderPath });
  assert.equal(selectSendable([bookmark('a', 'Salud')]).sendable.length, 1);
  assert.equal(selectSendable([bookmark('a', 'Salud')], {}).sendable.length, 1);
  assert.equal(selectSendable([bookmark('a', 'Salud')], { excludeFolder: null }).sendable.length, 1);
  // A zero width space or a decomposed accent must not let a folder escape the exclusion.
  assert.equal(selectSendable([bookmark('a', 'Sa\u200Blud')], { excludeFolder: /salud/i }).sendable.length, 0);
  assert.equal(selectSendable([bookmark('a', 'Me\u0301dico')], { excludeFolder: /Médico/i }).sendable.length, 0);
});

// --- Second corpus, written and frozen before the rules above existed, and evaluated once. Its
// result, not the 0 of 26 of the first corpus, is the honest estimate of what still leaks. Before
// the audit it gave 21 of 34, 14 of 23 and 2 of 45. Do not add rules to fit its failures. ---

const HOLDOUT_SECRETS = [
  ['https://www.notion.so/invite/Ab3xY9', ['Ab3xY9']],
  ['https://accounts.example.org/activate/ZKQ93T', ['ZKQ93T']],
  ['https://portal.example.org/passwordreset/q8w7e6r5t4', ['q8w7e6r5t4']],
  ['https://example.net/email/confirm/2f9c4ab1', ['2f9c4ab1']],
  ['https://example.net/email/confirm/mxqvbnkplzrt', ['mxqvbnkplzrt']],
  ['https://shop.example.com/orders/track/TRK-88213-99102', ['88213-99102']],
  ['https://example.com/download/tk_9sdf8-23kj4-lkj23', ['9sdf8']],
  ['https://share.example.com/f/Jq2LmN', ['Jq2LmN']],
  ['https://app.example.io/shared/quiet-lake-2931', ['quiet-lake']],
  ['https://gamma.app/docs/Strategy-Deck-abc123xyz456', ['abc123xyz456']],
  ['https://www.canva.com/design/DAFxyz12345/AbC123xyz_Dk/edit', ['DAFxyz12345', 'AbC123xyz']],
  ['https://miro.com/app/board/uXjVN1a2b3c=/', ['uXjVN1a2b3c']],
  ['https://pastebin.com/raw/x8Kd2LpQ', ['x8Kd2LpQ']],
  ['https://gist.github.com/anaperez/4f8b2c1d9e7a', ['4f8b2c1d9e7a']],
  ['https://docs.google.com/spreadsheets/d/e/2PACX-1vRabc123def456/pubhtml', ['1vRabc123def456']],
  ['https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ1abcDEF', ['AcZssZ1abcDEF']],
  ['https://www.dropbox.com/s/q9w8e7r6t5y4u3i/notes.txt?dl=0', ['q9w8e7r6t5y4u3i']],
  ['https://wetransfer.com/downloads/8f7e6d5c4b3a29187f6e5d4c3b2a1908/20260101/abc123', ['8f7e6d5c4b3a', 'abc123']],
  ['https://app.hubspot.com/contacts/1234567/contact/987654321', ['987654321']],
  ['https://app.slack.com/client/T01ABC234/C02DEF567', ['T01ABC234', 'C02DEF567']],
  ['https://tickets.example.com/v/AB12CD', ['AB12CD']],
  ['https://example.com/magic-link/vermillion-otter-sings', ['vermillion-otter']],
  ['https://example.com/u/7741/reset', ['7741']],
  ['https://secure.example.com/pay/INV7731', ['INV7731']],
  ['https://example.com/recover/TWVzc2FnZQ', ['TWVzc2FnZQ']],
  ['https://example.com/confirm/a-b-c-d-e-f-1-2-3-4', ['a-b-c-d']],
  ['https://example.com/k/ZmFrZS10b2tlbg', ['ZmFrZS10b2tlbg']],
  ['https://example.com/ticket/ZX81-QW22-PL09', ['ZX81']],
  ['https://example.com/join/hqzkvmwpxt', ['hqzkvmwpxt']],
  ['https://example.com/approve/wqpxmzkv-tlrnbsdf', ['wqpxmzkv']],
  ['https://example.com/auth/v1/verify/83625', ['83625']],
  ['https://example.com/access/rVq9Zt', ['rVq9Zt']],
  ['https://example.com/gift/SUMMER-XK29-PQ71', ['XK29']],
  ['https://example.com/claim/JHGFDSAQWERT', ['JHGFDSAQWERT']],
];

const HOLDOUT_PRIVATE = [
  'https://confluence.internal.example.org/x', 'https://gitlab.corp.example.net/y', 'https://sharepoint.intranet.example.cl/z', 'https://nas.localdomain:5001/',
  'http://openwrt.lan/', 'http://unifi.home/', 'https://kibana.svc.cluster.local/', 'https://argocd.default.svc/', 'http://tv.local../', 'http://192.168.0.1.sslip.io/',
  'http://172-16-0-1.nip.io/', 'https://proxmox.internal./', 'http://abcdefghijklmnop.onion/login', 'http://wiki.i2p/', 'http://printer.home.arpa./', 'https://vpn.example.org/',
  'https://grafana.lan.example.org/', 'http://example.invalid/', 'http://dsm.synology.local/', 'https://mail.corp/', 'https://it.intra.example.com/', 'http://[fd00::1]/', 'http://0300.0250.0.1/',
];

const HOLDOUT_BENIGN = [
  ['https://www.elmostrador.cl/noticias/pais/2024/03/15/nuevo-ministro-asume-cartera/', 'noticias/pais'],
  ['https://www.latercera.com/politica/noticia/gobierno-anuncia-reforma-tributaria/ABCDEFGHIJKLMNOPQRSTUVWXYZ/', 'gobierno-anuncia'],
  ['https://docs.python.org/3.12/library/itertools.html', 'itertools'],
  ['https://docs.rs/tokio/1.37.0/tokio/', 'tokio'],
  ['https://pandas.pydata.org/docs/user_guide/merging.html', 'merging'],
  ['https://www.databricks.com/glossary/medallion-architecture', 'medallion'],
  ['https://duckdb.org/docs/sql/functions/window_functions', 'docs/sql'],
  ['https://www.snowflake.com/en/data-cloud/workloads/data-lake/', 'data-cloud'],
  ['https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/mergetree', 'engines'],
  ['https://github.com/duckdb/duckdb/issues/1234', 'duckdb/duckdb'],
  ['https://github.com/vercel/next.js/tree/canary/examples', 'vercel/next.js'],
  ['https://gitlab.com/gitlab-org/gitlab', 'gitlab-org'],
  ['https://www.coursera.org/learn/machine-learning', 'machine-learning'],
  ['https://www.udemy.com/course/python-for-data-science-and-machine-learning-bootcamp/', 'python-for-data'],
  ['https://www.khanacademy.org/math/algebra', 'math/algebra'],
  ['https://www.mayoclinic.org/diseases-conditions/diabetes/symptoms-causes/syc-20371444', 'diabetes'],
  ['https://www.bbc.com/mundo/articles/c0k1l2m3n4o', 'bbc.com/mundo'],
  ['https://elpais.com/internacional/2024-03-15/el-titular-de-la-noticia.html', 'internacional'],
  ['https://www.theguardian.com/world/2024/mar/15/some-headline-here', 'world/2024'],
  ['https://www.reuters.com/technology/ai-regulation-eu-2024-03-15/', 'ai-regulation'],
  ['https://www.wired.com/story/how-to-fix-your-wifi/', 'how-to-fix'],
  ['https://martinfowler.com/articles/microservices.html', 'microservices'],
  ['https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/', 'chocolate-chip'],
  ['https://cookpad.com/cl/recetas/12345678-pastel-de-choclo', 'pastel-de-choclo'],
  ['https://www.booking.com/hotel/cl/santiago-centro.es.html', 'santiago-centro'],
  ['https://www.tripadvisor.com/Restaurants-g294305-Santiago.html', 'Santiago'],
  ['https://www.imdb.com/list/ls012345678/', 'imdb.com/list'],
  ['https://www.rottentomatoes.com/m/the_godfather', 'the_godfather'],
  ['https://store.steampowered.com/app/570/Dota_2/', 'Dota_2'],
  ['https://www.ikea.com/cl/es/p/billy-estanteria-blanco-00263850/', 'billy-estanteria'],
  ['https://www.tienda-ejemplo.com/tienda-cl/product/123456789/Notebook-Lenovo-IdeaPad/123456789', 'Notebook-Lenovo'],
  ['https://www.sii.cl/servicios_online/1039-1183.html', 'servicios_online'],
  ['https://www.gob.cl/noticias/presidente-anuncia-plan/', 'presidente-anuncia'],
  ['https://www.bcentral.cl/web/banco-central/areas/estadisticas', 'banco-central'],
  ['https://www.uchile.cl/noticias/123456/estudio-sobre-clima', 'estudio-sobre'],
  ['https://www.mercadolibre.cl/ofertas', 'ofertas'],
  ['https://developer.chrome.com/docs/extensions/reference/api/bookmarks', 'docs/extensions'],
  ['https://react.dev/reference/react/useState', 'useState'],
  ['https://tailwindcss.com/docs/flex-direction', 'flex-direction'],
  ['https://www.typescriptlang.org/tsconfig/strict.html', 'tsconfig'],
  ['https://nodejs.org/docs/latest/api/test.html', 'api/test.html'],
  ['https://www.rust-lang.org/learn/get-started', 'get-started'],
  ['https://www.example.co.jp/news/2024-spring', 'example.co.jp'],
  ['https://www.sitio.com.mx/guia/viajes', 'sitio.com.mx'],
  ['https://www.university.ac.uk/courses/physics', 'university.ac.uk'],
];

test('holdout: at most 8 of 34 secrets leak', () => {
  const leaked = HOLDOUT_SECRETS.filter(([url, secrets]) => {
    const result = sanitizeForLlm(url);
    return result.sendable && secrets.some((secret) => result.url.toLowerCase().includes(secret.toLowerCase()));
  }).map(([url]) => url);
  assert.ok(leaked.length <= 8, `${leaked.length} leaked:\n${leaked.join('\n')}`);
});

test('holdout: no private host is sent', () => {
  assert.deepEqual(HOLDOUT_PRIVATE.filter((url) => sanitizeForLlm(url).sendable), []);
});

test('holdout: benign pages keep their topic', () => {
  assert.deepEqual(HOLDOUT_BENIGN.filter(([url, keep]) => !sanitizeForLlm(url).url?.toLowerCase().includes(keep.toLowerCase())), []);
});
