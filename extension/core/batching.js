import { cleanTitle } from './prompt.js';

const encoder = new TextEncoder();
/** Typical width of the batch index in the request, so the estimate is not short by its digits. */
const INDEX_PLACEHOLDER = 49;

/**
 * Conservative size estimate for budgeting and batching. It is not a token count: the
 * API's `usage` is the source of truth for cost. Bytes rather than characters so that
 * CJK text is not underestimated.
 *
 * @param {string} text
 */
export function estimateTokens(text) {
  return Math.ceil(encoder.encode(text).length / 3);
}

/**
 * Size of an item as it travels in the request: `{i, title, url}`, with the title as the
 * model sees it. The `id` and `folderPath` of the tool-side record are not sent. Anything
 * that is not a bookmark is measured as it is.
 *
 * @param {unknown} item
 */
export function estimateItemTokens(item) {
  const bookmark = /** @type {{title?: unknown, url?: unknown} | null} */ (item);
  if (typeof bookmark?.title === 'string' && typeof bookmark.url === 'string') {
    return estimateTokens(JSON.stringify({ i: INDEX_PLACEHOLDER, title: cleanTitle(bookmark.title), url: bookmark.url }));
  }
  return estimateTokens(JSON.stringify(item));
}

/**
 * Splits items into order-preserving batches. An item larger than the budget travels
 * alone rather than being truncated or dropped.
 *
 * @template T
 * @param {T[]} items
 * @param {{maxItems?: number, maxTokens?: number}} [limits]
 * @returns {T[][]}
 */
export function makeBatches(items, { maxItems = 50, maxTokens = 4000 } = {}) {
  /** @type {T[][]} */
  const batches = [];
  /** @type {T[]} */
  let current = [];
  let currentTokens = 0;

  for (const item of items) {
    const itemTokens = estimateItemTokens(item);
    if (current.length > 0 && (current.length === maxItems || currentTokens + itemTokens > maxTokens)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += itemTokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * @template T
 * @param {T[]} batch at least two items
 * @returns {[T[], T[]]}
 */
export function splitBatch(batch) {
  const middle = Math.ceil(batch.length / 2);
  return [batch.slice(0, middle), batch.slice(middle)];
}
