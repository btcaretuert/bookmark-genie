const MAX_TITLE_LENGTH = 150;

/**
 * Patterns run on at most this much text: a title longer than the cut cannot reach the model
 * past it, and the lookaheads below are quadratic on a single huge word.
 */
const MAX_SCANNED_LENGTH = 1000;

/**
 * What a person cannot see but a model can read: format controls (zero width, bidi, BOM), the
 * tag block used for ASCII smuggling, variation selectors, blank fillers and lone surrogates.
 * They vanish without a trace, so `pass\u200Bword` becomes `password`.
 * `Default_Ignorable_Code_Point` includes U+E0000 to U+E0FFF.
 */
const INVISIBLE = /[\p{Cs}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]+/gu;

/** Controls and line separators do separate words, so they turn into a single space. */
const WORD_BREAKS = /[\p{Cc}\s]+/gu;

const WHOLE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/\S*|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/\S*)$/i;

/**
 * A URL inside a title. Without a scheme it needs a sign of being a real path (a second
 * slash, a digit or query characters), so that `Node.js/Express` is left alone.
 */
const URL_IN_TEXT = new RegExp(
  [
    String.raw`\S*:\/\/\S*`,
    String.raw`(?<![a-z0-9-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/(?=\S*[\/\d?=%&#])\S*`,
    String.raw`\blocalhost(?::\d+\S*|\/\S*)`,
    String.raw`(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+\S*|\/\S*)`,
    String.raw`[?&][a-z][a-z0-9_-]+=\S+`,
  ].join('|'),
  'gi',
);

const EMAIL_IN_TEXT = /(?:[^\s@<>()[\]]+@)+[^\s@<>()[\]]+\.[a-z]{2,}/gi;

/** Past 13 digits, so that card numbers go and an ISBN-13 stays. Separators do not hide it. */
const LONG_NUMBER = /\b\d(?:[ -]?\d){13,}\b/g;

const LONG_WORD = /[\w.~+:;,-]{16,}/g;
const WORD_SEPARATORS = /[-_.~+,:;]+/;
const MIN_TOKEN_CHUNK_LENGTH = 12;
const MIN_TOKEN_CHUNK_DIGITS = 2;

/**
 * A long word with a chunk that only a machine would write: letters and digits together.
 *
 * @param {string} word
 */
function hasTokenChunk(word) {
  return word.split(WORD_SEPARATORS).some((chunk) => {
    const digits = (chunk.match(/\d/g) ?? []).length;
    return chunk.length >= MIN_TOKEN_CHUNK_LENGTH && digits >= MIN_TOKEN_CHUNK_DIGITS && digits < chunk.length;
  });
}

/** @param {string} text already clean */
function maskTitle(text) {
  if (WHOLE_URL.test(text)) return '';
  const masked = text
    .replace(URL_IN_TEXT, '[url]')
    .replace(EMAIL_IN_TEXT, '[email]')
    .replace(LONG_NUMBER, '[id]')
    .replace(LONG_WORD, (word) => (hasTokenChunk(word) ? '[id]' : word));
  return cutText(masked, MAX_TITLE_LENGTH);
}

/**
 * JSON for embedding inside prompt tags. `<` is escaped so that a page title cannot close
 * the surrounding tag and pose as instructions.
 *
 * @param {unknown} value
 */
export function toPromptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/**
 * Removes what no reader should get: invisible characters, controls and line breaks. The
 * result is well-formed, on one line and trimmed. It is not cut.
 *
 * @param {string} text
 */
export function cleanText(text) {
  return text.replace(INVISIBLE, '').replace(WORD_BREAKS, ' ').trim();
}

/**
 * Cuts at a UTF-16 length without leaving half of a surrogate pair behind.
 *
 * @param {string} text
 * @param {number} maxLength
 */
export function cutText(text, maxLength) {
  if (text.length <= maxLength) return text;
  const last = text.charCodeAt(maxLength - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? maxLength - 1 : maxLength;
  return text.slice(0, end).trimEnd();
}

/**
 * A page title for the model. A title is copied from the page, and Chrome falls back to the
 * URL when a page has none, so without this a token dropped by `sanitizeForLlm` would leave
 * through the title. A title that is only a URL goes empty: the reduced URL already says it.
 *
 * Names of people, clients and health or financial context pass: no pattern tells them apart
 * from ordinary words. `--exclude-folder` and the preview are the control for those.
 *
 * Idempotent. The placeholders are inert to every pattern, but the cut can expose a match that
 * the rest of the title was hiding, such as a URL with nothing after it, so it runs until stable.
 *
 * @param {string} title
 */
export function cleanTitle(title) {
  let current = cutText(cleanText(title), MAX_SCANNED_LENGTH);
  for (;;) {
    const next = maskTitle(current);
    if (next === current) return current;
    current = next;
  }
}
