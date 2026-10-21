// @ts-check
(function () {
  const { esc, icon } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const listEl = $('list');
  const filterEl = /** @type {HTMLInputElement} */ ($('filter'));
  const state = Object.assign({ collapsed: {} }, vscode.getState() || {});
  /** @type {any} */
  let data = null;

  /** Work item type → glyph class + icon. */
  function kind(type) {
    const t = String(type).toLowerCase();
    if (t.includes('bug')) return ['bug', 'bug'];
    if (t.includes('task')) return ['task', 'check'];
    if (t.includes('story') || t.includes('backlog') || t.includes('requirement')) return ['story', 'bookmark'];
    if (t.includes('feature')) return ['feature', 'star-empty'];
    if (t.includes('epic')) return ['epic', 'layers'];
    return ['issue', 'circle-large-outline'];
  }

  /** Work item state → pill color. */
  function stateClass(s) {
    const t = String(s).toLowerCase();
    if (/(done|closed|resolved|completed|merged)/.test(t)) return 'done';
    if (/(block|impediment)/.test(t)) return 'blocked';
    if (/(active|progress|doing|committed|review|open|approved)/.test(t)) return 'active';
    return 'new';
  }

  function render() {
    if (!data) return;
    const q = filterEl.value.trim().toLowerCase();
    const tickets = data.tickets.filter((t) => !q || `${t.id} ${t.title} ${t.type} ${t.state} ${t.assignee || ''}`.toLowerCase().includes(q));
    // The ticket of the current branch first, then in progress, new, the rest.
    const rank = { active: 0, blocked: 1, new: 2, done: 3 };
    tickets.sort((a, b) => (b.id === data.currentId ? 1 : 0) - (a.id === data.currentId ? 1 : 0) || rank[stateClass(a.state)] - rank[stateClass(b.state)]);
    const noun = data.noun || 'ticket';
    if (!data.tickets.length) {
      listEl.innerHTML = `<div class="state done">${icon('check-all')}<b>No open ${noun}s assigned to you</b><span>${esc(data.source)}</span>
        <button data-act="startById">${icon('search')}Find a ${noun}…</button></div>`;
      return;
    }
    // Group by type when there are several kinds, else a flat list.
    const groups = new Map();
    for (const t of tickets) {
      // Groups only when the tickets come from several projects.
      const k = data.multiSource ? t.project || '' : '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const label = { bug: 'Bugs', task: 'Tasks', story: 'Stories', feature: 'Features', epic: 'Epics', issue: 'Other' };
    const html = [...groups.entries()]
      .map(([k, list]) => {
        const collapsed = !!state.collapsed[k];
        const head = groups.size > 1 ? `<div class="gh" data-toggle="${esc(k)}">${icon(collapsed ? 'chevron-right' : 'chevron-down')}<span class="gt">${esc(label[k] || k)}</span><span class="n">${list.length}</span></div>` : '';
        return `<div class="grp${collapsed && groups.size > 1 ? ' collapsed' : ''}">${head}<div class="gb">${list.map(item).join('')}</div></div>`;
      })
      .join('');
    listEl.innerHTML =
      (html || `<div class="state"><b>No match</b></div>`) +
      `<div class="foot"><button class="ghost" data-act="startById">${icon('search')}Find a ${noun}…</button><span class="grow"></span><button class="ghost icon" data-act="sources" title="Ticket sources">${icon('settings')}</button></div>`;
  }

  function item(t) {
    const [cls, ic] = kind(t.type);
    const current = t.id === data.currentId;
    return `<div class="item${current ? ' current' : ''}" data-id="${esc(t.id)}" title="${esc(t.type)} #${esc(t.id)} — ${esc(t.title)}${t.project ? `\n${esc(t.project)}` : ''}\nClick to see the ticket">
  <span class="glyph g-${cls}">${icon(ic)}</span>
  <div class="body"><div class="title">${esc(t.title)}</div>
    <div class="meta"><span class="id">#${esc(t.id)}</span><span class="pill p-${stateClass(t.state)}">${esc(t.state)}</span>${current ? '<span class="cur-chip">● current branch</span>' : `<span>${esc(t.type)}</span>`}</div></div>
  <span class="acts">
    <button class="icon" data-act="start" title="Start work (creates / switches the branch)">${icon('git-branch')}</button>
    <button class="icon" data-act="copy" title="Copy ID">${icon('copy')}</button>
    <button class="icon" data-act="open" title="Open in the browser">${icon('link-external')}</button>
  </span>
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
    if (m.type === 'tickets') {
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
