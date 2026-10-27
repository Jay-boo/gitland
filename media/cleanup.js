// @ts-check
(function () {
  const { esc, icon, listDate, displayName, loadingHtml } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));
  /** @type {any} */
  let data = null;
  const checked = new Set();


  function groups() {
    const b = data.branches;
    return [
      { key: 'merged', title: `Merged into ${data.base}`, hint: 'safe to delete: their commits are in the default branch', list: b.filter((x) => !x.remote && x.merged), icon: 'git-merge', cls: 'g-approved' },
      { key: 'gone', title: 'Remote branch deleted', hint: 'the server copy is gone (usually after the PR was completed)', list: b.filter((x) => !x.remote && !x.merged && x.gone), icon: 'cloud', cls: 'g-waiting' },
      { key: 'stale', title: `No commit for ${data.staleDays}+ days`, hint: 'not merged: check before deleting', list: b.filter((x) => !x.remote && !x.merged && !x.gone && x.stale), icon: 'history', cls: 'g-task' },
      { key: 'remote', title: `Remote branches merged into ${data.base}`, hint: `deleted on ${data.remote} for everyone`, list: b.filter((x) => x.remote && x.merged), icon: 'cloud', cls: 'g-changes' },
    ];
  }

  function render() {
    const gs = groups();
    const total = gs.reduce((n, g) => n + g.list.length, 0);
    page.innerHTML = `
<header class="t-head">
  <div class="t-title"><div class="t-kind"><span class="glyph big g-approved">${icon('trash')}</span><span>Branch cleanup</span></div><h1>${total ? `${total} branch${total > 1 ? 'es' : ''} could go` : 'Nothing to clean up'}</h1></div>
</header>
<div class="t-actions"><button data-act="prune" title="git fetch --all --prune: forget the remote branches deleted on the server">${icon('cloud-download')}Fetch &amp; prune</button>
  <span class="grow"></span><span class="k">main, dev, release/* and the current branch are never listed</span></div>
${gs
  .filter((g) => g.list.length)
  .map(
    (g) => `<section class="cl-group"><h3><span class="glyph small ${g.cls}">${icon(g.icon)}</span>${esc(g.title)} <span class="n">${g.list.length}</span><span class="grow"></span>
      <button class="ghost" data-all="${g.key}">${icon(g.list.every((b) => checked.has(b.name)) ? 'clear-all' : 'check-all')}${g.list.every((b) => checked.has(b.name)) ? 'Unselect all' : 'Select all'}</button></h3>
    <div class="hint">${esc(g.hint)}</div>
    ${g.list
      .map(
        (b) => `<label class="cl-row"><input type="checkbox" data-name="${esc(b.name)}"${checked.has(b.name) ? ' checked' : ''}>
      <span class="nm">${icon(b.remote ? 'cloud' : 'git-branch')}${esc(b.name)}</span>
      ${b.upstream && !b.remote ? `<span class="up">${b.gone ? `${esc(b.upstream)} (deleted)` : esc(b.upstream)}</span>` : ''}
      <span class="grow"></span><span class="a" title="${esc(b.author)}">${esc(displayName(b.author))}</span>${listDate(b.date)}</label>`,
      )
      .join('')}
  </section>`,
  )
  .join('')}
${total ? `<div class="create-bar"><span class="k">${checked.size} selected</span><span class="grow"></span><button class="${checked.size ? 'primary big danger-btn' : 'big'}" data-act="delete"${checked.size ? '' : ' disabled'}>${icon('trash')}Delete ${checked.size || ''} branch${checked.size === 1 ? '' : 'es'}</button></div>` : `<div class="gl-empty done">${icon('check-all')}<b>All tidy</b><span>No merged, gone or stale branch.</span></div>`}`;
  }

  page.addEventListener('change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (!t.dataset.name) return;
    t.checked ? checked.add(t.dataset.name) : checked.delete(t.dataset.name);
    render();
  });
  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const all = /** @type {HTMLElement | null} */ (t.closest('[data-all]'));
    if (all) {
      const g = groups().find((x) => x.key === all.dataset.all);
      const every = g.list.every((b) => checked.has(b.name));
      g.list.forEach((b) => (every ? checked.delete(b.name) : checked.add(b.name)));
      return render();
    }
    const act = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
    if (!act) return;
    if (act.dataset.act === 'prune') return vscode.postMessage({ type: 'prune' });
    if (act.dataset.act === 'delete') {
      const list = data.branches.filter((b) => checked.has(b.name)).map((b) => ({ name: b.name, remote: b.remote, force: !b.remote && !b.merged }));
      vscode.postMessage({ type: 'delete', branches: list });
    }
  });
  window.addEventListener('message', (e) => {
    if (e.data.type === 'branches') {
      data = e.data;
      for (const n of [...checked]) if (!data.branches.some((b) => b.name === n)) checked.delete(n);
      render();
    }
  });
  page.innerHTML = loadingHtml('Looking for branches…');
  vscode.postMessage({ type: 'ready' });
})();
