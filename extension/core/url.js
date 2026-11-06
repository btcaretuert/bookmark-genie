/**
 * URL reduction for anything that leaves the machine.
 *
 * The LLM only needs enough of a URL to tell what a page is about. Query strings,
 * fragments, credentials and identifier-like path segments are dropped because they
 * routinely carry tokens. Hosts that are not public never leave at all. When a segment
 * is ambiguous the rule errs towards dropping it: losing context costs a little
 * classification quality, leaking a token cannot be undone.
 *
 * What the shape of a URL cannot settle, so these still pass and only the preview and
 * --exclude-folder can stop them:
 * - Values under 8 characters: `/invite/kX9mQ2` looks like `/docs/react19`. They are stopped
 *   only after a segment in SECRET_FOLLOWS or on a host in SECRET_PATH_HOSTS.
 * - Words used as a secret: `/quiet-lake-sings`, `correct-horse-battery-staple`.
 * - Random letters that happen to read like a word, more likely the shorter they are.
 * - Random chunks of 3 characters or fewer, and unequal chunks with few digits.
 * - Names of people and companies in a readable path, and document names.
 * - Private names under a public domain with no telling label: `jenkins.prod.acme.cloud`.
 */

import { cleanText } from './prompt.js';

const NON_PUBLIC_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.intra',
  '.lan',
  '.home',
  '.home.arpa',
  '.corp',
  '.private',
  '.priv',
  '.workgroup',
  // Reserved names (RFC 6761, 7686, 9476).
  '.test',
  '.example',
  '.invalid',
  '.onion',
  '.alt',
  '.i2p',
  // Mesh networks.
  '.ts.net',
  '.beta.tailscale.net',
  '.zt',
  // Service discovery and home appliances.
  '.svc',
  '.consul',
  '.box',
  '.hole',
  '.ip',
  // Public names that resolve to a loopback or private address.
  '.nip.io',
  '.sslip.io',
  '.xip.io',
  '.lvh.me',
  '.localtest.me',
  '.vcap.me',
  '.traefik.me',
];

/** A subdomain with one of these names points inside an organization, whatever follows it. */
const NON_PUBLIC_LABELS = new Set(['corp', 'internal', 'intranet', 'intra', 'lan', 'local', 'localdomain', 'vpn']);

const EMBEDDED_IP = /(?:^|[.-])\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}(?:[.-]|$)/;

/**
 * Multi-tenant services: the subdomain names the customer and the path is that customer's
 * data, while saying "this is Slack" is all the classification needs.
 */
const TENANT_DOMAINS = ['slack.com', 'atlassian.net', 'okta.com', 'zendesk.com', 'sharepoint.com', 'zoom.us', 'blob.core.windows.net', 'storage.googleapis.com'];
const S3_HOST = /^(?:[^.]+\.)?(s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com)$/;

/** Hosts whose whole path is a shared secret or an opaque pointer. */
const SECRET_PATH_HOSTS = new Set([
  'meet.google.com',
  'meet.jit.si',
  'whereby.com',
  'zoom.us',
  'discord.gg',
  'wa.me',
  'storage.googleapis.com',
  'storage.cloud.google.com',
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'forms.gle',
  '1drv.ms',
]);

/** Whatever follows one of these path segments is usually a one-time value. */
const SECRET_FOLLOWS = new Set([
  'reset',
  'reset-password',
  'password-reset',
  'password',
  'magic',
  'verify',
  'verificar',
  'confirm',
  'confirmar',
  'confirmation',
  'activate',
  'activar',
  'activation',
  'invite',
  'invitation',
  'invitacion',
  'unsubscribe',
  'token',
  'tokens',
  'otp',
  'recovery',
  'recuperar',
  'restablecer',
  'login',
  'signin',
  'sso',
  'share',
  'shared',
  'pay',
  'pago',
  'payment',
  'invoice',
  'factura',
  'booking',
  'reserva',
  'card',
  'i',
  's',
  'j',
  // Profile pages: what follows is a person's name.
  'in',
  'profile',
  'users',
]);

/** Second-level labels of public suffixes such as co.uk, com.ar or gob.cl. */
const PUBLIC_SECOND_LEVEL_LABELS = new Set(['ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'mil', 'ne', 'net', 'nom', 'or', 'org']);

const MAX_SEGMENTS = 4;
const MAX_SEGMENT_LENGTH = 80;
const MAX_URL_LENGTH = 120;
const MAX_HOST_LENGTH = 80;

const MIN_OPAQUE_TOKEN_LENGTH = 8;
const MIN_OPAQUE_DIGITS = 2;
const MIN_OPAQUE_CASE_FLIPS = 4;
const MIN_OPAQUE_CONSONANT_RUN = 5;
const LONG_TOKEN_LENGTH = 16;
const MAX_WORD_LENGTH = 30;
const MIN_WORD_VOWEL_RATIO = 0.25;

const MIN_CHUNKED_DIGITS = 8;
const MIN_MIXED_CHUNKS = 3;
const MIN_EQUAL_CHUNKS = 3;
const MIN_EQUAL_CHUNK_LENGTH = 4;
const ALWAYS_OPAQUE_EQUAL_CHUNKS = 4;
const MIN_MACHINE_CHUNKS = 2;

const MIN_SLUG_WORDS = 3;
const MIN_SLUG_LETTERS = 8;

const CHUNK_SEPARATORS = /[-_.~+,:;\s]+/;
const CHUNK_SEPARATORS_AT_ENDS = /^[-_.~+,:;\s]+|[-_.~+,:;\s]+$/g;

/** Non-ASCII text splits tokens too: one accent must not launder the ASCII token next to it. */
const TOKEN_SEPARATORS = /[-_.~+,:;\s]+|[^\x00-\x7F]+/;
/** A leading @ is a handle, as in `/@channel`. Any other is an address or close enough to one. */
const EMAIL_LIKE = /\S@/;

/**
 * Query syntax, an encoded slash, and what no readable slug needs: markup, invisible
 * characters and controls, including those that percent-decoding brings back.
 */
const UNSAFE_SEGMENT = /[?&=#/\\<>"`{}|^\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;

/** Still percent-encoded after one decoding: double encoding hides separators and values. */
const STILL_ENCODED = /%[0-9a-f]{2}/i;

const LEADING_DATE = /^\d{4}[-_.]\d{1,2}[-_.]\d{1,2}(?:[-_.]|$)/;
const PLAIN_WORD = /^(?:\p{Lu}\p{Ll}*|\p{Ll}+|\p{Lo}+|\d{1,4})$/u;
const PAGE_EXTENSION = /\.(?:html?|shtml|php|aspx?|jsp)$/i;

/**
 * @typedef {{sendable: true, url: string} | {sendable: false, reason: 'invalid-url' | 'unsupported-scheme' | 'private-host'}} SanitizedUrl
 */

/**
 * @param {string} rawUrl
 * @returns {SanitizedUrl}
 */
export function sanitizeForLlm(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { sendable: false, reason: 'invalid-url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { sendable: false, reason: 'unsupported-scheme' };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (isNonPublicHost(host)) {
    return { sendable: false, reason: 'private-host' };
  }

  const tenantDomain = findTenantDomain(host);
  if (tenantDomain) return { sendable: true, url: tenantDomain };

  let url = reduceHost(host);
  if (url.length > MAX_URL_LENGTH) return { sendable: false, reason: 'invalid-url' };
  if (SECRET_PATH_HOSTS.has(host.replace(/^www\./, ''))) return { sendable: true, url };

  let kept = 0;
  for (const rawSegment of parsed.pathname.split('/')) {
    if (rawSegment === '') continue;
    const decoded = decodeSegment(rawSegment);
    const segment = decoded === null ? null : readablePart(decoded);
    if (segment === null) continue;
    const candidate = `${url}/${segment}`;
    if (candidate.length > MAX_URL_LENGTH) break;
    url = candidate;
    kept += 1;
    if (kept === MAX_SEGMENTS || SECRET_FOLLOWS.has(segment.toLowerCase().replaceAll('_', '-'))) break;
  }
  return { sendable: true, url };
}

/**
 * Applies `sanitizeForLlm` to a collection and keeps only what may leave the machine. A
 * folder the person excluded goes first: nothing in it is even looked at.
 *
 * @param {{id: string, title: string, url: string, folderPath: string}[]} bookmarks
 * @param {{excludeFolder?: RegExp | null}} [options] matched against the whole folder path
 * @returns {{sendable: {id: string, title: string, url: string, folderPath: string}[], excluded: Record<string, number>}}
 */
export function selectSendable(bookmarks, { excludeFolder } = {}) {
  const excludedFolder = toFolderPattern(excludeFolder);
  /** @type {{id: string, title: string, url: string, folderPath: string}[]} */
  const sendable = [];
  /** @type {Record<string, number>} */
  const excluded = {};
  const exclude = (/** @type {string} */ reason) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };

  for (const bookmark of bookmarks) {
    if (excludedFolder?.test(cleanText(bookmark.folderPath).normalize('NFC'))) {
      exclude('excluded-folder');
      continue;
    }
    const sanitized = sanitizeForLlm(bookmark.url);
    if (sanitized.sendable) {
      sendable.push({ id: bookmark.id, title: bookmark.title, url: sanitized.url, folderPath: bookmark.folderPath });
    } else {
      exclude(sanitized.reason);
    }
  }
  return { sendable, excluded };
}

/**
 * `g` and `y` would make `test` remember its position between folders.
 *
 * @param {RegExp | null | undefined} pattern
 * @returns {RegExp | null}
 */
function toFolderPattern(pattern) {
  if (!pattern) return null;
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
}

/**
 * Every IP literal counts as non-public: an address says nothing about the topic of a
 * page, so there is no classification value that would justify sending one.
 *
 * @param {string} host lowercased hostname without its trailing dot
 */
function isNonPublicHost(host) {
  if (host.startsWith('[')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  const labels = host.split('.');
  if (labels.length < 2 || labels.includes('')) return true;
  if (EMBEDDED_IP.test(host)) return true;
  if (labels.slice(0, -siteLabelCount(labels)).some((label) => NON_PUBLIC_LABELS.has(label))) return true;
  const dottedHost = `.${host}`;
  return NON_PUBLIC_HOST_SUFFIXES.some((suffix) => dottedHost.endsWith(suffix));
}

/**
 * How many trailing labels name the site: two, or three under a suffix like co.uk.
 *
 * @param {string[]} labels
 */
function siteLabelCount(labels) {
  const [secondLevel, topLevel] = labels.slice(-2);
  return topLevel.length === 2 && PUBLIC_SECOND_LEVEL_LABELS.has(secondLevel) ? 3 : 2;
}

/**
 * @param {string} host
 * @returns {string | undefined} the domain that replaces the whole URL
 */
function findTenantDomain(host) {
  const bucketHost = host.match(S3_HOST)?.[1];
  if (bucketHost) return bucketHost;
  // A leading www. must not hide the tenant, but www.slack.com is still the public site.
  const bare = host.replace(/^(?:www\.)+/, '');
  return TENANT_DOMAINS.find((domain) => bare.endsWith(`.${domain}`));
}

/**
 * Generated subdomains can identify a private deployment or bucket, so they get the same
 * treatment as path segments. The labels that name the site always stay: removing the site's
 * own name would turn www.365datascience.com into www.com, which is a different site.
 *
 * @param {string} host
 */
function reduceHost(host) {
  const labels = host.split('.');
  const siteLabels = siteLabelCount(labels);
  let reduced = labels.slice(-siteLabels).join('.');
  const subdomains = labels.slice(0, -siteLabels).filter((label) => !isOpaqueSegment(label));
  for (const label of subdomains.reverse()) {
    const candidate = `${label}.${reduced}`;
    if (candidate.length > MAX_HOST_LENGTH) break;
    reduced = candidate;
  }
  return reduced;
}

/** @param {string} segment */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The part of a decoded segment that may leave: all of it, the words of a slug that carries
 * one id at either end, or nothing.
 *
 * @param {string} rawSegment
 * @returns {string | null}
 */
function readablePart(rawSegment) {
  if (!isOpaqueSegment(rawSegment)) return rawSegment;
  if (rawSegment.length > MAX_SEGMENT_LENGTH) return null;

  const segment = rawSegment.normalize('NFKC');
  if (hasUnsafeForm(segment) || isChunkedToken(segment)) return null;

  const base = segment.replace(PAGE_EXTENSION, '');
  const tokens = base.split(TOKEN_SEPARATORS).filter(Boolean);
  const opaque = tokens.filter(isOpaqueToken);
  if (opaque.length !== 1) return null;

  let rest;
  if (opaque[0] === tokens.at(-1)) rest = base.slice(0, base.lastIndexOf(opaque[0]));
  else if (opaque[0] === tokens[0]) rest = base.slice(base.indexOf(opaque[0]) + opaque[0].length);
  else return null;
  rest = rest.replace(CHUNK_SEPARATORS_AT_ENDS, '');
  return isReadableSlug(rest) ? rest : null;
}

/** @param {string} text */
function isReadableSlug(text) {
  const words = text.split(CHUNK_SEPARATORS).filter(Boolean);
  if (words.length < MIN_SLUG_WORDS || !words.every((word) => PLAIN_WORD.test(word))) return false;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const withVowel = words.filter((word) => /[aeiouy\P{ASCII}]/iu.test(word) || /^\d+$/.test(word)).length;
  return letters >= MIN_SLUG_LETTERS && withVowel >= words.length - 1;
}

/** @param {string} segment NFKC-normalized */
function hasUnsafeForm(segment) {
  return UNSAFE_SEGMENT.test(segment) || EMAIL_LIKE.test(segment) || STILL_ENCODED.test(segment);
}

/** @param {string} rawSegment percent-decoded path segment, or a host label */
function isOpaqueSegment(rawSegment) {
  if (rawSegment.length > MAX_SEGMENT_LENGTH) return true;
  const segment = rawSegment.normalize('NFKC');
  if (hasUnsafeForm(segment) || isChunkedToken(segment)) return true;
  return segment.split(TOKEN_SEPARATORS).some(isOpaqueToken);
}

/**
 * Separators cut a long value into chunks below every threshold of `isOpaqueToken`: card
 * numbers, license keys, recovery codes. So the segment is also judged as a whole.
 *
 * @param {string} segment
 */
function isChunkedToken(segment) {
  const rest = segment.replace(LEADING_DATE, '');
  const digits = (rest.match(/\d/g) ?? []).length;
  const letters = (rest.match(/\p{L}/gu) ?? []).length;
  if (digits >= MIN_CHUNKED_DIGITS && digits >= letters) return true;

  const chunks = rest.split(CHUNK_SEPARATORS).filter(Boolean);
  const mixed = chunks.filter((chunk) => /\d/.test(chunk) && /[a-z]/i.test(chunk));
  if (mixed.length >= MIN_MIXED_CHUNKS) return true;

  const isEqualLength =
    chunks.length >= MIN_EQUAL_CHUNKS &&
    chunks[0].length >= MIN_EQUAL_CHUNK_LENGTH &&
    chunks.every((chunk) => chunk.length === chunks[0].length);
  if (!isEqualLength) return false;
  const machineChunks = chunks.filter((chunk) => !PLAIN_WORD.test(chunk)).length;
  return chunks.length >= ALWAYS_OPAQUE_EQUAL_CHUNKS || machineChunks >= MIN_MACHINE_CHUNKS;
}

/** @param {string} token ASCII only */
function isOpaqueToken(token) {
  const digits = (token.match(/\d/g) ?? []).length;
  const isAllLetters = /^[a-z]*$/i.test(token);

  if (digits >= MIN_OPAQUE_DIGITS && token.length >= MIN_OPAQUE_TOKEN_LENGTH) return true;
  if (token.length >= MIN_OPAQUE_TOKEN_LENGTH && countCaseFlips(token) >= MIN_OPAQUE_CASE_FLIPS) return true;
  if (isAllLetters && token.length >= MIN_OPAQUE_TOKEN_LENGTH && longestConsonantRun(token) >= MIN_OPAQUE_CONSONANT_RUN) return true;

  if (token.length >= LONG_TOKEN_LENGTH) {
    const isWordLike = isAllLetters && token.length <= MAX_WORD_LENGTH && vowelRatio(token) >= MIN_WORD_VOWEL_RATIO;
    return !isWordLike;
  }
  return false;
}

/** @param {string} token */
function longestConsonantRun(token) {
  return Math.max(...token.split(/[aeiouy]+/i).map((run) => run.length));
}

/** @param {string} token */
function countCaseFlips(token) {
  let flips = 0;
  for (let i = 1; i < token.length; i += 1) {
    const previousIsUpper = /[A-Z]/.test(token[i - 1]);
    const previousIsLower = /[a-z]/.test(token[i - 1]);
    const currentIsUpper = /[A-Z]/.test(token[i]);
    const currentIsLower = /[a-z]/.test(token[i]);
    if ((previousIsUpper && currentIsLower) || (previousIsLower && currentIsUpper)) flips += 1;
  }
  return flips;
}

/** @param {string} token */
function vowelRatio(token) {
  return (token.match(/[aeiou]/gi) ?? []).length / token.length;
}
