import { cleanText, cutText } from '../../extension/core/prompt.js';

const MAX_MESSAGE_LENGTH = 300;
const REDACTED = '[redacted]';

/** Backslash-escaped: enough to stop emphasis, code, links, images, tables and math. */
const MARKDOWN_SPECIAL = /[\\`*_[\]!|~$#]/g;

/**
 * Text that came from a page or a model, made inert for a Markdown report: one line, no
 * controls, and no markup that a viewer would render or fetch. `maxLength` counts visible
 * characters, so the escaped result can be longer.
 *
 * Bare URLs stay as text. A viewer may linkify them, which needs a click; escaping cannot
 * prevent it because linkifiers run after unescaping.
 *
 * @param {string} text
 * @param {number} [maxLength]
 */
export function safeInline(text, maxLength = 200) {
  const clean = cleanText(text);
  const visible = clean.length > maxLength ? `${cutText(clean, maxLength - 1)}…` : clean;
  return visible
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(MARKDOWN_SPECIAL, '\\$&')
    .replace(/^[-+=]/, '\\$&')
    .replace(/^(\d+)([.)])/, '$1\\$2');
}

/**
 * The forms a secret takes inside an error message. A key with a stray line break fails in
 * `Headers.append`, which quotes it raw; a proxy that echoes the request quotes it as JSON.
 *
 * @param {string} secret
 */
function secretForms(secret) {
  const forms = [secret, JSON.stringify(secret).slice(1, -1)];
  // Pieces around a line break survive cleaning as separate words.
  const pieces = secret.split(/[\s\p{Cc}]+/u).filter((piece) => piece.length >= 8);
  return [...forms, ...pieces];
}

/**
 * An error message that is safe to print and to store: one line, at most 300 characters,
 * without the given secrets or anything shaped like a credential.
 *
 * @param {unknown} message
 * @param {(string | null | undefined)[]} [secrets]
 */
export function redact(message, secrets = []) {
  let text = String(message);
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of secretForms(secret)) text = text.replaceAll(form, REDACTED);
  }
  text = text
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-ant-[\w-]+/g, REDACTED)
    .replace(/\b((?:proxy-)?authorization|x-api-key|api-key)(["'\s:=]+)[^"',}]+/gi, `$1$2${REDACTED}`)
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, `//${REDACTED}@`);
  return cutText(cleanText(text), MAX_MESSAGE_LENGTH);
}
