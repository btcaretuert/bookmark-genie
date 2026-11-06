/**
 * Counts that say, before any money is spent, how much of the collection gives the model
 * little to work with. Counts only: no title or URL leaves this function.
 */

/** @param {string} text */
function comparable(text) {
  const bare = text.trim().toLowerCase().replace(/^https?:\/\//, '');
  // A loop rather than /\/+$/, which is quadratic on a long run of slashes followed by text.
  let end = bare.length;
  while (end > 0 && bare[end - 1] === '/') end -= 1;
  return bare.slice(0, end);
}

/**
 * @param {{
 *   bookmarks: {title: string, url: string}[],
 *   sendable: {title: string, url: string}[],
 * }} input bookmarks as parsed; sendable after URL reduction
 * @returns {{
 *   total: number, sendable: number, emptyTitles: number, titleIsUrl: number,
 *   hostOnlyUrls: number, exactDuplicates: number, duplicatesAfterReduction: number,
 * }}
 */
export function summarizeQuality({ bookmarks, sendable }) {
  /** @param {{title: string, url: string}[]} items */
  const duplicates = (items) => {
    const seen = new Set();
    let repeated = 0;
    for (const { title, url } of items) {
      const key = JSON.stringify([comparable(url), title.trim()]);
      if (seen.has(key)) repeated += 1;
      else seen.add(key);
    }
    return repeated;
  };

  return {
    total: bookmarks.length,
    sendable: sendable.length,
    emptyTitles: sendable.filter(({ title }) => title.trim() === '').length,
    titleIsUrl: sendable.filter(({ title, url }) => comparable(title) === comparable(url) || /^https?:\/\//i.test(title.trim())).length,
    hostOnlyUrls: sendable.filter(({ url }) => !url.includes('/')).length,
    exactDuplicates: duplicates(bookmarks),
    duplicatesAfterReduction: duplicates(sendable),
  };
}
