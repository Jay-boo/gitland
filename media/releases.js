// @ts-check
(function () {
  const { esc, icon, relShort } = /** @type {any} */ (window).gl;
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
      listEl.innerHTML = `<div class="state done">${icon('tag')}<b>No release yet</b><span>Tags show up here.</span><button class="primary" data-act="newRelease">${icon('tag')}Create the first release…</button></div>`;
      return;
    }
    listEl.innerHTML =
      unreleased +
      list
        .map((r, i) => {
          const pre = /-/.test(r.name);
          return `<div class="item rel${i === 0 && !q ? ' latest' : ''}" data-tag="${esc(r.name)}" title="${esc(r.name)}${r.subject ? ` — ${esc(r.subject)}` : ''}\n${new Date(r.date).toLocaleString()} · ${esc(r.author)}\nClick to compare with ${esc(r.previous || 'the start')}">
  <span class="glyph ${pre ? 'g-draft' : 'g-task'}">${icon('tag')}</span>
  <div class="body">
    <div class="title"><span class="ver">${esc(r.name)}</span>${i === 0 && !q ? '<span class="cur-chip">latest</span>' : ''}${pre ? '<span class="pill p-draft">pre-release</span>' : ''}</div>
    <div class="meta"><span>${plural(r.commits, 'commit')}</span>${r.pullRequests ? `<span>${icon('git-pull-request')} ${r.pullRequests}</span>` : ''}${r.previous ? `<span>since ${esc(r.previous)}</span>` : ''}</div>
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
      listEl.innerHTML = '<div class="skeleton"><div></div><div></div><div></div></div>';
    } else if (m.type === 'state') {
      listEl.innerHTML = `<div class="state ${m.state}">${icon(m.state === 'error' ? 'warning' : 'info')}<b>${esc(m.title)}</b><span>${esc(m.text || '')}</span></div>`;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
