// @ts-check
// Helpers shared by every Gitland webview script (loaded first): window.gl.
(function (root) {
  const esc = (/** @type {unknown} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

  const icon = (/** @type {string} */ name, /** @type {string} */ cls = '') => `<i class="codicon codicon-${name}${cls ? ` ${cls}` : ''}"></i>`;

  /** "5m ago", "3h ago", "2d ago", then the date. */
  function relTime(/** @type {number} */ ts) {
    if (!ts) return '';
    const s = (Date.now() - ts) / 1000;
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** "5m", "3h", "2d", "4mo", "2y". */
  function relShort(/** @type {number} */ ts) {
    if (!ts) return '';
    const s = (Date.now() - ts) / 1000;
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
    if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo`;
    return `${Math.floor(s / 86400 / 365)}y`;
  }

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

  /** The graph lane colours (--gl-lane-0 … 10), read through get (e.g. getComputedStyle). */
  const themeColors = (/** @type {(name: string) => string} */ get) => Array.from({ length: 11 }, (_, i) => get(`--gl-lane-${i}`));

  const gl = { esc, icon, relTime, relShort, $, themeColors };
  // @ts-ignore
  root.gl = gl;
  // @ts-ignore
  if (typeof module !== 'undefined') module.exports = gl;
})(typeof window !== 'undefined' ? window : globalThis);
