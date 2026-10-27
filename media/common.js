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

  /** Full date and time, for the tooltip of a short list date. */
  function fullDate(/** @type {number} */ ts) {
    return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  /** Short date for lists: "5m", "8h", "3d" within a week, then "Aug 26" this year, "Feb 2025" before. */
  function shortDate(/** @type {number} */ ts, now = Date.now()) {
    if (!ts) return '';
    if (now - ts < 7 * 86400e3) return relShort(ts);
    const d = new Date(ts);
    return d.getFullYear() === new Date(now).getFullYear()
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }

  /** A short list date (shortDate), with the full date as its tooltip. */
  const listDate = (/** @type {number} */ ts, cls = 'k') => `<span class="${cls}" title="${esc(fullDate(ts))}">${esc(shortDate(ts))}</span>`;

  /** Display name of an author: an e-mail shows as the part before "@"; a trailing "(EXT)"-style note is dropped. */
  function displayName(/** @type {string} */ name) {
    const n = String(name || '');
    if (/^[^\s@]+@[^\s@]+$/.test(n)) return n.split('@')[0];
    return n.replace(/\s*\([^)]*\)\s*$/, '') || n;
  }

  /** The empty / error / sign-in block of every view: icon, title, optional detail, optional button (HTML). */
  const STATE_ICON = { signin: 'account', error: 'warning', empty: 'info', done: 'check-all' };
  function stateHtml(/** @type {{ state?: string, icon?: string, title: string, text?: string }} */ m, button = '') {
    return `<div class="gl-empty ${esc(m.state || '')}">${icon(m.icon || STATE_ICON[/** @type {keyof typeof STATE_ICON} */ (m.state)] || 'info')}<b>${esc(m.title)}</b>${m.text ? `<span>${esc(m.text)}</span>` : ''}${button}</div>`;
  }

  /** Quiet loading state: a spinning codicon and one line. */
  const loadingHtml = (text = 'Loading…') => `<div class="gl-empty is-loading">${icon('loading', 'codicon-modifier-spin')}<span>${esc(text)}</span></div>`;

  /** What a middle ellipsis keeps of a branch name: its type and first token ("feature/18342-", "fix/88-"),
   *  or the first word when there is no slash. */
  function branchHead(/** @type {string} */ name) {
    const m = /^[^/]+\/[^-_/]+[-_]?/.exec(name) || /^[^-_/]+[-_]?/.exec(name);
    return m ? m[0] : name.slice(0, 6);
  }

  /** Name shortened in the middle: the head, "…", then the last `tail` characters; unchanged when short enough. */
  function middleName(/** @type {string} */ name, /** @type {number} */ tail) {
    const head = branchHead(name);
    return head.length + tail + 1 >= name.length ? name : `${head}…${name.slice(-tail)}`;
  }

  /** Work item state → chip colour class (p-new / p-active / p-blocked / p-done). */
  function stateClass(/** @type {string} */ s) {
    const t = String(s).toLowerCase();
    if (/(done|closed|resolved|completed|merged)/.test(t)) return 'done';
    if (/(block|impediment)/.test(t)) return 'blocked';
    if (/(active|progress|doing|committed|review|open|approved)/.test(t)) return 'active';
    return 'new';
  }

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

  /** The graph lane colours (--gl-lane-0 … 10), read through get (e.g. getComputedStyle). */
  const themeColors = (/** @type {(name: string) => string} */ get) => Array.from({ length: 11 }, (_, i) => get(`--gl-lane-${i}`));

  const gl = { esc, icon, relTime, relShort, shortDate, fullDate, listDate, displayName, stateHtml, loadingHtml, stateClass, branchHead, middleName, $, themeColors };
  // @ts-ignore
  root.gl = gl;
  // @ts-ignore
  if (typeof module !== 'undefined') module.exports = gl;
})(typeof window !== 'undefined' ? window : globalThis);
