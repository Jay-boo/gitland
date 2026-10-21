// @ts-check
(function () {
  const { esc, icon } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { markdown } = window.gitlandRich;
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));
  /** @type {any} */
  let data = null;
  let filter = '';

  const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  function control(/** @type {any} */ s, /** @type {unknown} */ v) {
    const id = `s-${s.key}`;
    switch (s.type) {
      case 'boolean':
        return `<label class="switch"><input id="${esc(id)}" type="checkbox" data-key="${esc(s.key)}"${v ? ' checked' : ''}><span class="track"><span class="knob"></span></span><span>${v ? 'On' : 'Off'}</span></label>`;
      case 'enum':
        return `<select id="${esc(id)}" class="gl-input" data-key="${esc(s.key)}">${s.options.map((/** @type {string} */ o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      case 'number':
        return `<input id="${esc(id)}" class="gl-input num" type="number" data-key="${esc(s.key)}" value="${esc(v ?? '')}">`;
      case 'text':
        return `<div class="gl-composer"><textarea id="${esc(id)}" rows="2" data-key="${esc(s.key)}" placeholder="(none)">${esc(v ?? '')}</textarea></div>`;
      case 'string':
        return `<input id="${esc(id)}" class="gl-input" type="text" data-key="${esc(s.key)}" value="${esc(v ?? '')}" spellcheck="false">`;
      default:
        return `<button class="secondary" data-json="${esc(s.key)}">${icon('json')}Edit in settings.json</button>`;
    }
  }

  function render() {
    if (!data) return;
    const q = filter.toLowerCase();
    const groups = data.groups
      .map((/** @type {any} */ g) => ({ ...g, settings: g.settings.filter((/** @type {any} */ s) => !q || `${s.key} ${s.title} ${s.description}`.toLowerCase().includes(q)) }))
      .filter((/** @type {any} */ g) => g.settings.length);
    page.innerHTML = `
<header class="t-head">
  <span class="glyph big g-story">${icon('settings-gear')}</span>
  <div class="t-title"><div class="t-kind"><span>Gitland</span><span class="k">saved to your user settings</span></div><h1>Settings</h1></div>
</header>
<div class="t-actions"><label class="search set-filter"><i class="codicon codicon-filter"></i><input id="setFilter" type="search" placeholder="Filter settings" value="${esc(filter)}" spellcheck="false"></label></div>
${groups
  .map(
    (/** @type {any} */ g) => `<section class="gl-card set-group"><h3>${esc(g.title)} <span class="n">${g.settings.length}</span></h3>${g.settings
      .map((/** @type {any} */ s) => {
        const v = data.values[s.key];
        const changed = !same(v, s.default);
        return `<div class="set-row${changed ? ' changed' : ''}">
  <div class="set-text"><div class="set-title">${esc(s.title)}${changed ? `<span class="link" data-reset="${esc(s.key)}" title="Back to the default (${esc(JSON.stringify(s.default))})">${icon('discard')}Reset</span>` : ''}<span class="link key" data-json="${esc(s.key)}" title="Open in VS Code's settings">gitland.${esc(s.key)}</span></div>
    <div class="set-desc rich">${markdown(s.description || '')}</div></div>
  <div class="set-ctl">${control(s, v)}</div>
</div>`;
      })
      .join('')}</section>`,
  )
  .join('') || '<div class="state">No setting matches.</div>'}`;
    const f = /** @type {HTMLInputElement | null} */ (document.getElementById('setFilter'));
    if (f && filter) {
      f.focus();
      f.setSelectionRange(filter.length, filter.length);
    }
  }

  function commit(/** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ el) {
    const key = el.dataset.key;
    if (!key) return;
    if (el instanceof HTMLInputElement && el.type === 'number' && (el.value.trim() === '' || !Number.isFinite(Number(el.value)))) {
      // An emptied number goes back to the default instead of becoming 0.
      return vscode.postMessage({ type: 'reset', key });
    }
    const value =
      el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked
      : el instanceof HTMLInputElement && el.type === 'number' ? Number(el.value)
      : el.value;
    vscode.postMessage({ type: 'set', key, value });
  }

  page.addEventListener('change', (e) => {
    const el = /** @type {any} */ (e.target);
    if (el.id !== 'setFilter') commit(el);
  });
  page.addEventListener('input', (e) => {
    const el = /** @type {HTMLInputElement} */ (e.target);
    if (el.id === 'setFilter') {
      filter = el.value;
      render();
    }
  });
  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const reset = /** @type {HTMLElement | null} */ (t.closest('[data-reset]'));
    if (reset) return vscode.postMessage({ type: 'reset', key: reset.dataset.reset });
    const json = /** @type {HTMLElement | null} */ (t.closest('[data-json]'));
    if (json) return vscode.postMessage({ type: 'openJson', key: json.dataset.json });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type !== 'settings') return;
    // Don't re-render under the cursor of a field being edited.
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    data = m;
    if (active && active.dataset && active.dataset.key && (active.tagName === 'TEXTAREA' || (active instanceof HTMLInputElement && active.type === 'text'))) return;
    render();
  });
  vscode.postMessage({ type: 'ready' });
})();
