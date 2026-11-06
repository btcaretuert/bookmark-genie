import { readFile } from 'node:fs/promises';

/**
 * Page titles are untrusted. A spreadsheet runs a cell that starts with one of these as a
 * formula, including the full-width forms and when preceded by whitespace.
 */
const FORMULA_START = /^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/;

/**
 * One physical line per cell and no control or format characters (bidi overrides, zero-width
 * marks), so a cell cannot hide text or break the row apart in an editor.
 *
 * @param {string} value
 */
function neutralize(value) {
  const oneLine = value.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/\p{Cf}+/gu, '');
  return FORMULA_START.test(oneLine) ? `'${oneLine}` : oneLine;
}

/** @param {string} value */
function quote(value) {
  return `"${neutralize(value).replaceAll('"', '""')}"`;
}

/**
 * @param {string[]} header
 * @param {string[][]} rows
 */
export function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(quote).join(',')).join('\n') + '\n';
}

/**
 * Reads what `toCsv` writes and what a spreadsheet saves back: BOM, CRLF, blank rows, and
 * `;` as separator (regional Excel). `;` is accepted only when the header line has no comma
 * outside quotes, so a comma file that merely contains a semicolon is not misread.
 *
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(source);
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let inQuotes = false;
  let wasQuoted = false;

  const endField = () => {
    row.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
      wasQuoted = true;
    } else if (char === '\r' && (source[i + 1] === '\n' || i + 1 === source.length)) {
      // Line ending, not data: a carriage return inside quotes never reaches this branch.
    } else if (char === delimiter) {
      endField();
    } else if (char === '\n') {
      endRow();
    } else {
      field += char;
    }
  }
  if (field !== '' || wasQuoted || row.length > 0) endRow();

  const [header = [], ...records] = rows;
  return records.map((record) => Object.fromEntries(header.map((name, i) => [name, record[i] ?? ''])));
}

/** @param {string} text */
function detectDelimiter(text) {
  let inQuotes = false;
  let semicolons = 0;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === ',') return ',';
    else if (!inQuotes && char === ';') semicolons += 1;
    else if (!inQuotes && char === '\n') break;
  }
  return semicolons > 0 ? ';' : ',';
}

/**
 * Reads a text file a person may have saved from a spreadsheet: UTF-8 when it is valid, and
 * Windows-1252 (Excel's default for CSV) when it is not, so "sí" is not turned into U+FFFD.
 *
 * @param {string} path
 */
export async function readText(path) {
  const bytes = await readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
