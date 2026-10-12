// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));
  const esc = (/** @type {string} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  const icon = (/** @type {string} */ n) => `<i class="codicon codicon-${n}"></i>`;
  /** @type {any} */
  let init = null;
  /** Steps in order (oldest first): { sha, short, message, action, edited } */
  let steps = /** @type {any[]} */ ([]);
  const ACTIONS = [
    ['pick', 'check', 'keep the commit'],
    ['reword', 'edit', 'keep it, change the message'],
    ['squash', 'fold-up', 'meld into the previous commit, keep both messages'],
    ['fixup', 'fold', 'meld into the previous commit, drop this message'],
    ['edit', 'debug-pause', 'stop after it to amend it'],
    ['drop', 'trash', 'remove the commit'],
  ];

  function render() {
    const pushedTouched = steps.some((s, i) => s.pushed && (s.action !== 'pick' || steps.findIndex((x) => x.sha === s.sha) !== init.commits.findIndex((c) => c.sha === s.sha)));
    const warn = [];
    if (init.merges) warn.push(`${init.merges} merge commit${init.merges > 1 ? 's' : ''} in the range will be flattened (their changes are kept).`);
    if (pushedTouched) warn.push(`Some rewritten commits are already on ${esc(init.upstream)}: pushing will need a force push.`);
    if (steps[0] && (steps[0].action === 'squash' || steps[0].action === 'fixup')) warn.push('The first commit cannot be squashed / fixed up.');
    const count = (a) => steps.filter((s) => s.action === a).length;
    page.innerHTML = `
<header class="t-head">
  <span class="glyph big g-story">${icon('git-compare')}</span>
  <div class="t-title">
    <div class="t-kind"><span>Interactive rebase</span><span class="id">${esc(init.branch || 'HEAD')}</span></div>
    <h1>${steps.length} commit${steps.length === 1 ? '' : 's'} after <span class="mono">${esc(init.base.short)}</span> <span class="muted small">${esc(init.base.subject)}</span></h1>
  </div>
</header>
${warn.map((w) => `<div class="rb-warn">${icon('warning')}<span>${w}</span></div>`).join('')}
<div class="rb-help">${icon('info')} Oldest first. Drag the ${icon('gripper')} handle to reorder.</div>
<div id="steps">${steps
      .map(
        (s, i) => `<div class="rb-row a-${s.action}" draggable="true" data-i="${i}">
  <span class="grip">${icon('gripper')}</span>
  <div class="rb-acts">${ACTIONS.map(([a, ic, tip]) => `<button class="icon${s.action === a ? ' on' : ''}" data-action="${a}" title="${a}: ${tip}">${icon(ic)}</button>`).join('')}</div>
  <span class="rb-name">${s.action}</span>
  <span class="sha">${esc(s.short)}</span>
  <div class="rb-msg">${
    s.action === 'reword'
      ? `<textarea data-msg="${i}" rows="${Math.min(8, Math.max(2, s.message.split('\n').length + 1))}">${esc(s.message)}</textarea>`
      : `<span class="s">${esc(s.message.split('\n')[0])}</span>`
  }</div>
  ${s.pushed ? `<span class="pushed" title="Already pushed to ${esc(init.upstream)}">${icon('cloud')}</span>` : ''}
</div>`,
      )
      .join('')}</div>
<div class="create-bar">
  <span class="k">${['reword', 'squash', 'fixup', 'edit', 'drop'].filter(count).map((a) => `${count(a)} ${a}`).join(' · ') || 'nothing changed yet'}</span>
  <span class="grow"></span>
  <button data-act="reset">${icon('discard')}Reset</button>
  <button class="primary big" data-act="start"${steps[0] && /squash|fixup/.test(steps[0].action) ? ' disabled' : ''}>${icon('play')}Start rebase</button>
</div>`;
  }

  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const a = /** @type {HTMLElement | null} */ (t.closest('[data-action]'));
    if (a) {
      const row = /** @type {HTMLElement} */ (a.closest('.rb-row'));
      steps[Number(row.dataset.i)].action = a.dataset.action;
      return render();
    }
    const act = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
    if (act && act.dataset.act === 'reset') {
      steps = init.commits.map((c) => ({ ...c, action: 'pick' }));
      return render();
    }
    if (act && act.dataset.act === 'start') {
      vscode.postMessage({ type: 'start', steps: steps.map((s) => ({ sha: s.sha, action: s.action, message: s.action === 'reword' ? s.message : undefined })) });
    }
  });
  page.addEventListener('input', (e) => {
    const t = /** @type {HTMLTextAreaElement} */ (e.target);
    if (t.dataset.msg !== undefined) steps[Number(t.dataset.msg)].message = t.value;
  });

  // Drag to reorder
  let from = -1;
  page.addEventListener('dragstart', (e) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.rb-row'));
    if (!row) return;
    from = Number(row.dataset.i);
    row.classList.add('dragging');
    e.dataTransfer && (e.dataTransfer.effectAllowed = 'move');
  });
  page.addEventListener('dragover', (e) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.rb-row'));
    if (!row || from < 0) return;
    e.preventDefault();
    page.querySelectorAll('.rb-row.over').forEach((r) => r !== row && r.classList.remove('over'));
    row.classList.add('over');
  });
  page.addEventListener('drop', (e) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.rb-row'));
    if (!row || from < 0) return;
    e.preventDefault();
    const to = Number(row.dataset.i);
    const [moved] = steps.splice(from, 1);
    steps.splice(to, 0, moved);
    from = -1;
    render();
  });
  page.addEventListener('dragend', () => {
    from = -1;
    page.querySelectorAll('.rb-row').forEach((r) => r.classList.remove('over', 'dragging'));
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
      init = m;
      steps = m.commits.map((c) => ({ ...c, action: 'pick' }));
      if (!steps.length) {
        page.innerHTML = `<div class="state">${icon('info')}<b>No commit to rebase</b><span>after ${esc(m.base.short)}</span></div>`;
        return;
      }
      render();
    }
  });
  page.innerHTML = '<div class="skeleton"><div></div><div></div><div></div></div>';
  vscode.postMessage({ type: 'ready' });
})();
