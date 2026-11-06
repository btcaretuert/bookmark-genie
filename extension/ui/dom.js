/** Tiny DOM helpers shared by the pages. Text always goes in through `textContent`. */

/** @param {string} id */
export const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @param {string} tag
 * @param {string} [text]
 * @param {string} [className]
 */
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * @param {string} text
 * @param {() => void | Promise<void>} onClick
 * @param {string} [className]
 */
export function button(text, onClick, className) {
  const node = /** @type {HTMLButtonElement} */ (el('button', text, className));
  node.type = 'button';
  node.addEventListener('click', () => {
    node.disabled = true;
    Promise.resolve(onClick()).finally(() => {
      node.disabled = false;
    });
  });
  return node;
}

/** @param {unknown} error */
export const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Calls `task` at most once per `ms`, after the last request: bursts of storage events become one redraw.
 *
 * @param {() => void} task
 * @param {number} [ms]
 */
export function debounce(task, ms = 250) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(task, ms);
  };
}
