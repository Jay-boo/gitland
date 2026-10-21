// @ts-check
// Keyboard navigation of the commit graph (pure logic; media/graph.js wires it): window.glKeys.
(function (root) {
  /** @type {Record<string, string>} */
  const KEYS = {
    ArrowDown: 'down',
    j: 'down',
    ArrowUp: 'up',
    k: 'up',
    Home: 'home',
    End: 'end',
    PageDown: 'pageDown',
    PageUp: 'pageUp',
    Enter: 'toggleDetails',
    ' ': 'toggleDetails',
    ArrowLeft: 'parent',
    ArrowRight: 'child',
    m: 'mergeBase',
    c: 'compare',
    '?': 'help',
  };

  /**
   * The action of a key press, or null (typing in a field, a modifier held, an unknown key).
   * @param {{ key: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean, shiftKey: boolean }} e
   * @param {boolean} inInput typing in a field: no key is taken
   * @param {boolean} [onButton] a focused button / link: Enter and Space press it
   */
  function keyAction(e, inInput, onButton = false) {
    if (inInput || e.ctrlKey || e.altKey || e.metaKey) return null;
    if (onButton && (e.key === 'Enter' || e.key === ' ')) return null;
    return KEYS[e.key] ?? null;
  }

  /**
   * Row to select after a move. index -1 = nothing selected yet: any move starts at the top.
   * @param {string} action @param {number} index @param {number} count @param {number} pageRows
   */
  function moveIndex(action, index, count, pageRows) {
    if (count <= 0) return -1;
    if (index < 0) return 0;
    const page = Math.max(1, pageRows);
    const next =
      action === 'down' ? index + 1
      : action === 'up' ? index - 1
      : action === 'pageDown' ? index + page
      : action === 'pageUp' ? index - page
      : action === 'home' ? 0
      : action === 'end' ? count - 1
      : index;
    return Math.min(count - 1, Math.max(0, next));
  }

  /** Row of the first parent of commits[index], or -1 when it is not loaded. @param {{sha: string, parents: string[]}[]} commits @param {number} index */
  function parentIndex(commits, index) {
    const c = commits[index];
    if (!c || !c.parents.length) return -1;
    return commits.findIndex((x) => x.sha === c.parents[0]);
  }

  /** Nearest row above commits[index] that has it as a parent, or -1. @param {{sha: string, parents: string[]}[]} commits @param {number} index */
  function childIndex(commits, index) {
    const c = commits[index];
    if (!c) return -1;
    for (let i = index - 1; i >= 0; i--) {
      if (commits[i].parents.includes(c.sha)) return i;
    }
    return -1;
  }

  const glKeys = { keyAction, moveIndex, parentIndex, childIndex };
  // @ts-ignore
  root.glKeys = glKeys;
  // @ts-ignore
  if (typeof module !== 'undefined') module.exports = glKeys;
})(typeof window !== 'undefined' ? window : globalThis);
