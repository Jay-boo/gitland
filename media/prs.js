// @ts-check
(function () {
  const { esc, icon, relShort } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const listEl = $('list');
  const filterEl = /** @type {HTMLInputElement} */ ($('filter'));
  const state = Object.assign({ collapsed: {} }, vscode.getState() || {});
  /** @type {any} */
  let data = null;

  const GROUPS = [
    { key: 'current', label: 'Current branch', icon: 'git-branch' },
    { key: 'mine', label: 'Created by me', icon: 'account' },
    { key: 'review', label: 'Waiting for my review', icon: 'eye' },
    { key: 'other', label: 'All other active', icon: 'organization' },
  ];
  const REVIEW = {
    draft: ['draft', 'git-pull-request-draft', 'draft'],
    approved: ['approved', 'pass', 'approved'],
    changes: ['changes', 'request-changes', 'changes requested'],
    waiting: ['waiting', 'git-pull-request', 'in review'],
  };


  function render() {
    if (!data) return;
    const q = filterEl.value.trim().toLowerCase();
    const prs = data.prs.filter((p) => !q || `${p.label} ${p.title} ${p.sourceBranch} ${p.targetBranch} ${p.author}`.toLowerCase().includes(q));
    if (!data.prs.length) {
      listEl.innerHTML = `<div class="state done">${icon('git-pull-request')}<b>No active pull requests</b><span>in this repository</span>
        <button data-act="create">${icon('git-pull-request-create')}Create pull request…</button></div>`;
      return;
    }
    const html = GROUPS.map((g) => {
      // A PR waiting for my vote is listed there too, even when it is mine or on the current branch.
      const list =
        g.key === 'current' ? prs.filter((p) => p.sourceBranch === data.current)
        : g.key === 'review' ? prs.filter((p) => p.needsMyReview || (p.group === 'review' && p.sourceBranch !== data.current))
        : prs.filter((p) => p.group === g.key && p.sourceBranch !== data.current);
      if (!list.length && (g.key === 'current' || g.key === 'other')) return '';
      const collapsed = !!state.collapsed[g.key];
      return `<div class="grp${collapsed ? ' collapsed' : ''}">
  <div class="gh" data-toggle="${g.key}">${icon(collapsed ? 'chevron-right' : 'chevron-down')}<span class="gt">${g.label}</span><span class="n">${list.length}</span></div>
  <div class="gb">${list.length ? list.map(item).join('') : `<div class="state"><span>none</span></div>`}</div>
</div>`;
    }).join('');
    listEl.innerHTML =
      html + `<div class="foot"><button class="ghost" data-act="create">${icon('git-pull-request-create')}Create pull request…</button></div>`;
  }

  function item(p) {
    const r = REVIEW[p.isDraft ? 'draft' : p.review || 'waiting'];
    const current = p.sourceBranch === data.current;
    return `<div class="item${current ? ' current' : ''}" data-id="${esc(p.id)}" title="${esc(p.label)} ${esc(p.title)}\n${esc(p.sourceBranch)} → ${esc(p.targetBranch)}\nby ${esc(p.author)} — ${r[2]}\nClick to see the pull request">
  <span class="glyph g-${r[0]}">${icon(r[1])}</span>
  <div class="body"><div class="title">${esc(p.title)}</div>
    <div class="meta"><span class="id">${esc(p.label)}</span><span class="pill p-${r[0]}">${r[2]}</span><span class="br">${esc(p.sourceBranch)} ${icon('arrow-right')} ${esc(p.targetBranch)}</span></div></div>
  <span class="acts">
    <button class="icon" data-act="checkout" title="Check out the branch">${icon('git-branch')}</button>
    <button class="icon" data-act="open" title="Open in the browser">${icon('link-external')}</button>
  </span>
  <span class="age side">${current ? '<span class="cur-chip" title="Your current branch">●</span>' : esc(relShort(p.created))}</span>
</div>`;
  }

  function showState(m) {
    const ic = { signin: 'account', error: 'warning', empty: 'info' }[m.state] || 'info';
    const btn =
      m.state === 'signin'
        ? `<button class="primary" data-act="signIn">${icon('sign-in')}Sign in</button>`
        : m.state === 'error'
          ? `<button data-act="refresh">${icon('refresh')}Retry</button>`
          : '';
    listEl.innerHTML = `<div class="state ${m.state}">${icon(ic)}<b>${esc(m.title)}</b><span>${esc(m.text || '')}</span>${btn}</div>`;
  }

  listEl.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const toggle = /** @type {HTMLElement | null} */ (t.closest('[data-toggle]'));
    if (toggle) {
      const k = /** @type {string} */ (toggle.dataset.toggle);
      state.collapsed[k] = !state.collapsed[k];
      vscode.setState(state);
      return render();
    }
    const act = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
    const row = /** @type {HTMLElement | null} */ (t.closest('.item'));
    if (act) return vscode.postMessage({ type: act.dataset.act, id: row && row.dataset.id });
    if (row) vscode.postMessage({ type: 'show', id: row.dataset.id });
  });
  filterEl.addEventListener('input', render);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'prs') {
      data = m;
      render();
    } else if (m.type === 'state') {
      data = null;
      showState(m);
    } else if (m.type === 'loading' && !data) {
      listEl.innerHTML = '<div class="skeleton"><div></div><div></div><div></div></div>';
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
