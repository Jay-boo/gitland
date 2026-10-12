// @ts-check
/**
 * Hover preview of a file's diff, shared by the pages that list changed files (compare, graph
 * details, Changes view). Rest the mouse on a row: the page asks the extension for the first
 * hunks ({ type: 'preview', key, ...request(row) }) and shows them in a popup; replies are cached.
 * The popup stays open while the mouse is on it: scroll inside it, click it to open the diff.
 * Once open it is sticky: crossing other rows on the way to it does not close or replace it,
 * only resting on another row for a moment does.
 */
(function () {
  const esc = (/** @type {string} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

  /**
   * @param {{ vscode: any, root: HTMLElement, selector: string, request: (row: HTMLElement) => any, reserveRight?: number }} o
   *   request: what to send for a row (null = no preview for it); its JSON is the cache key.
   *   reserveRight: width (px) of a strip on the right of the rows kept free of the popup, for row
   *   buttons (Changes view: stage / unstage). Pointing into that strip closes the popup at once.
   */
  // @ts-ignore
  window.gitlandDiffPreview = function (o) {
    const cache = new Map();
    let hovered = /** @type {HTMLElement | null} */ (null);
    let hoveredKey = '';
    let timer = 0;
    let closing = 0;
    let switching = 0;
    /** How long the open popup waits before closing (time to reach it with the mouse). */
    const GRACE = 450;
    /** Before the first preview shows, and before switching to another row the mouse rests on. */
    const OPEN_DELAY = 200;
    const SWITCH_DELAY = 300;
    const pop = document.createElement('div');
    pop.className = 'diff-pop';
    pop.hidden = true;
    document.body.appendChild(pop);

    /** One diff line; notebooks (see src/git/notebookDiff.ts) get "cell N" headers and cell markers. */
    function line(l) {
      const cell = /^@@ cell (\d+) @@$/.exec(l);
      if (cell) return `<span class="h cell">cell ${cell[1]}</span>`;
      if (l.startsWith('@@')) return `<span class="h">${esc(l.replace(/^(@@[^@]*@@).*/, '$1'))}</span>`;
      const marker = /^([+-])# %% \[(\w+)\]$/.exec(l);
      if (marker) return `<span class="${marker[1] === '+' ? 'a' : 'd'} mark">${marker[1] === '+' ? 'new' : 'removed'} ${esc(marker[2])} cell</span>`;
      return `<span class="${l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : ''}">${esc(l) || ' '}</span>`;
    }

    function show(row, p) {
      const body = p.binary
        ? '<div class="note">Binary file.</div>'
        : !p.lines.length
          ? `<div class="note">${esc(p.note || 'No textual change (renamed or mode change).')}</div>`
          : `<pre>${p.lines.map(line).join('')}</pre>${p.more ? `<div class="note">… ${p.more} more lines — click to open the diff</div>` : ''}`;
      pop.innerHTML = `<div class="diff-pop-head"><i class="codicon codicon-diff"></i><span>${esc(row.dataset.path || '')}</span></div>${body}`;
      pop.hidden = false;
      // Below the row, or above when it does not fit; never off screen.
      const r = row.getBoundingClientRect();
      const right = window.innerWidth - 8 - (o.reserveRight || 0);
      const w = Math.max(120, Math.min(640, right - 8));
      pop.style.width = `${w}px`;
      pop.style.left = `${Math.max(8, Math.min(r.left + 40, right - w))}px`;
      const h = pop.offsetHeight;
      const below = r.bottom + 4;
      const above = r.top - h - 4;
      pop.style.top = `${below + h > window.innerHeight - 8 && above > 8 ? above : Math.max(8, Math.min(below, window.innerHeight - h - 8))}px`;
    }

    function hide() {
      clearTimeout(timer);
      clearTimeout(closing);
      clearTimeout(switching);
      hovered = null;
      hoveredKey = '';
      pop.hidden = true;
    }

    // Leaving the row for the popup (or back) does not close it: a short grace delay.
    const closeSoon = () => {
      clearTimeout(closing);
      closing = setTimeout(hide, GRACE);
    };
    pop.addEventListener('mouseenter', () => {
      clearTimeout(closing);
      clearTimeout(switching);
    });
    pop.addEventListener('mouseleave', closeSoon);
    // The page may have re-rendered since: find the row by what it previews, not by element.
    const sameRow = (row) => !!row && (row === hovered || (!!hoveredKey && JSON.stringify(o.request(row)) === hoveredKey));
    const currentRow = () =>
      hovered && hovered.isConnected ? hovered : /** @type {HTMLElement[]} */ ([...o.root.querySelectorAll(o.selector)]).find(sameRow) || null;
    pop.addEventListener('click', () => {
      const row = currentRow();
      hide();
      if (row) row.click();
    });

    /** In the strip of row buttons: no preview there, and an open one gets out of the way. */
    const inButtons = (e) => !!o.reserveRight && e.clientX > o.root.getBoundingClientRect().right - o.reserveRight;
    if (o.reserveRight) {
      o.root.addEventListener('mousemove', (e) => {
        if (inButtons(e)) {
          if (hovered || !pop.hidden) hide();
        } else if (!hovered && pop.hidden) {
          // Back from the buttons to the name: preview again.
          const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest(o.selector));
          if (row) start(row, OPEN_DELAY);
        }
      });
    }

    o.root.addEventListener('mouseover', (e) => {
      if (inButtons(e)) return hide();
      const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest(o.selector));
      if (sameRow(row)) {
        hovered = row;
        clearTimeout(closing);
        clearTimeout(switching);
        return;
      }
      if (!pop.hidden) {
        // On the way to the popup: keep it, unless the mouse stays on another row.
        clearTimeout(switching);
        if (row) {
          clearTimeout(closing);
          switching = setTimeout(() => start(row, 0), SWITCH_DELAY);
        } else closeSoon();
        return;
      }
      hide();
      if (row) start(row, OPEN_DELAY);
    });

    function start(row, delay) {
      hide();
      const req = o.request(row);
      if (!req) return;
      hovered = row;
      hoveredKey = JSON.stringify(req);
      const key = hoveredKey;
      timer = setTimeout(() => {
        if (cache.has(key)) show(row, cache.get(key));
        else o.vscode.postMessage({ type: 'preview', key, ...req });
      }, delay);
    }
    o.root.addEventListener('mouseleave', () => (pop.hidden ? hide() : closeSoon()));
    o.root.addEventListener('click', hide, true);
    // Only the user scrolling the page closes it (pages re-render and restore their scroll often).
    window.addEventListener('wheel', (e) => !pop.contains(/** @type {Node} */ (e.target)) && hide(), { capture: true, passive: true });
    window.addEventListener('blur', hide);

    return {
      /** Call with every { type: 'preview' } reply from the extension. */
      receive(m) {
        cache.set(m.key, m);
        if (hovered && hoveredKey === m.key) show(hovered, m);
      },
      /** Forget the cached diffs (the files changed); an open popup stays open. */
      clear() {
        cache.clear();
      },
      hide,
    };
  };
})();
