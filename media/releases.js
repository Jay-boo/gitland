// @ts-check
(function () {
  const { esc, icon, relShort, loadingHtml, stateHtml } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const listEl = /** @type {HTMLElement} */ (document.getElementById('list'));
  const filterEl = /** @type {HTMLInputElement} */ (document.getElementById('filter'));
  /** @type {any} */
  let data = null;


  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function render() {
    if (!data) return;
    const q = filterEl.value.trim().toLowerCase();
    const list = data.releases.filter((r) => !q || `${r.name} ${r.subject} ${r.author}`.toLowerCase().includes(q));
    const unreleased =
      data.latest !== undefined && data.unreleased
        ? `<div class="unreleased" data-act="compareUnreleased" title="Compare ${esc(data.latest)} with ${esc(data.branch || 'HEAD')}">
  <span class="glyph g-task">${icon('rocket')}</span>
  <div class="body"><div class="title"><b>${plural(data.unreleased, 'commit')}</b> not released yet</div>
    <div class="meta"><span>on ${esc(data.branch || 'HEAD')} since ${esc(data.latest)}</span></div></div>
  <button class="primary" data-act="newRelease">${icon('tag')}Release…</button>
</div>`
        : '';
    if (!data.releases.length) {
      listEl.innerHTML = `<div class="gl-empty empty">${icon('tag')}<b>No release yet</b><span>Tags show up here.</span><button class="primary" data-act="newRelease">${icon('tag')}New release…</button></div>`;
      return;
    }
    listEl.innerHTML =
      unreleased +
      '<div class="gb">' +
      list
        .map((r, i) => {
          const pre = /-/.test(r.name);
          return `<div class="item rel${i === 0 && !q ? ' latest' : ''}" data-tag="${esc(r.name)}" title="${esc(r.name)}${r.subject ? ` — ${esc(r.subject)}` : ''}\n${new Date(r.date).toLocaleString()} · ${esc(r.author)}\nClick to compare with ${esc(r.previous || 'the start')}">
  <span class="glyph ${pre ? 'g-draft' : 'g-task'}">${icon('tag')}</span>
  <div class="body">
    <div class="title"><span class="ver">${esc(r.name)}</span>${i === 0 && !q ? '<span class="cur-chip">latest</span>' : ''}${pre ? '<span class="pill p-draft">pre-release</span>' : ''}</div>
    <div class="meta"><span>${plural(r.commits, 'commit')}</span>${r.pullRequests ? `<span>${icon('git-pull-request')} ${r.pullRequests}</span>` : ''}${r.previous ? `<span class="since">since ${esc(r.previous)}</span>` : ''}</div>
  </div>
  <span class="age side">${esc(relShort(r.date))}</span>
  <span class="acts">
    <button class="icon" data-act="notes" title="Release notes (AI)">${icon('sparkle')}</button>
    <button class="icon" data-act="checkout" title="Checkout this release">${icon('target')}</button>
    <button class="icon" data-act="copy" title="Copy the tag name">${icon('copy')}</button>
    <button class="icon" data-act="delete" title="Delete the tag…">${icon('trash')}</button>
  </span>
</div>`;
        })
        .join('') +
      '</div>' +
      `<div class="foot"><button class="ghost" data-act="newRelease">${icon('add')}New release…</button></div>`;
  }

  listEl.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const act = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
    const row = /** @type {HTMLElement | null} */ (t.closest('[data-tag]'));
    if (act) return vscode.postMessage({ type: act.dataset.act, tag: row && row.dataset.tag });
    if (row) vscode.postMessage({ type: 'compare', tag: row.dataset.tag });
  });
  filterEl.addEventListener('input', render);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'releases') {
      data = m;
      render();
    } else if (m.type === 'loading' && !data) {
      listEl.innerHTML = loadingHtml('Loading releases…');
    } else if (m.type === 'state') {
      listEl.innerHTML = stateHtml(m);
    }
  });
  // No data yet (loading, empty, sign-in, error): hide the filter box above the state block.
  const noData = () => document.body.classList.toggle('no-data', !!listEl.querySelector(':scope > .gl-empty') && !(/** @type {HTMLInputElement | null} */ (document.querySelector('.lv-head input'))?.value));
  new MutationObserver(noData).observe(listEl, { childList: true });
  noData();
  vscode.postMessage({ type: 'ready' });
})();
