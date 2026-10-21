// @ts-check
(function () {
  const { esc, icon, relShort } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const listEl = $('list');
  const filterEl = /** @type {HTMLInputElement} */ ($('filter'));
  /** @type {any} */
  let data = null;
  /** Expanded run id → its jobs message. @type {Record<string, any>} */
  const expanded = {};

  /** Run / job state → [glyph class, codicon, label]. */
  const STATE = {
    succeeded: ['approved', 'pass-filled', 'succeeded'],
    partial: ['task', 'warning', 'partial'],
    failed: ['changes', 'error', 'failed'],
    running: ['waiting', 'sync codicon-modifier-spin', 'running'],
    queued: ['draft', 'clock', 'queued'],
    canceled: ['draft', 'circle-slash', 'canceled'],
  };
  const PILL = { succeeded: 'p-done', partial: 'p-waiting', failed: 'p-blocked', running: 'p-active', queued: 'p-new', canceled: 'p-draft' };

  function render() {
    if (!data) return;
    const q = filterEl.value.trim().toLowerCase();
    const runs = data.runs.filter((/** @type {any} */ r) => !q || `${r.name} ${r.sha || ''} ${r.state}`.toLowerCase().includes(q));
    if (!data.runs.length) {
      listEl.innerHTML = `<div class="state done">${icon('rocket')}<b>No pipeline run</b><span>for ${esc(data.branch || 'this branch')}</span></div>`;
      return;
    }
    listEl.innerHTML =
      `<div class="grp"><div class="gh">${icon('git-branch')}<span class="gt">${esc(data.branch || 'detached HEAD')}</span><span class="n">${data.runs.length}</span></div>` +
      `<div class="gb">${runs.length ? runs.map(item).join('') : '<div class="state"><span>No match</span></div>'}</div></div>` +
      `<div class="foot"><button class="ghost" data-act="refresh">${icon('refresh')}Refresh</button></div>`;
  }

  function item(/** @type {any} */ r) {
    const [cls, ic, label] = STATE[/** @type {keyof typeof STATE} */ (r.state)] || STATE.queued;
    const live = r.state === 'running' || r.state === 'queued';
    const open = expanded[r.id];
    return `<div class="item run${open ? ' open' : ''}" data-id="${esc(r.id)}" title="${esc(r.name)} — ${label}\nClick to see the jobs">
  <span class="glyph g-${cls}">${icon(ic)}</span>
  <div class="body"><div class="title">${esc(r.name)}</div>
    <div class="meta"><span class="pill ${PILL[/** @type {keyof typeof PILL} */ (r.state)] || 'p-new'}">${label}</span>${r.sha ? `<span class="id">${esc(r.sha.slice(0, 7))}</span>` : ''}${r.duration ? `<span>${icon('watch')} ${esc(r.duration)}</span>` : ''}</div></div>
  <span class="acts">
    ${data.canRerun && !live ? `<button class="icon" data-act="rerun" title="Run again">${icon('debug-rerun')}</button>` : ''}
    ${data.canCancel && live ? `<button class="icon" data-act="cancel" title="Cancel">${icon('debug-stop')}</button>` : ''}
    <button class="icon" data-act="open" title="Open in the browser">${icon('link-external')}</button>
  </span>
  <span class="age side">${esc(relShort(r.started || r.finished || 0))}</span>
</div>${open ? jobsHtml(open) : ''}`;
  }

  function jobsHtml(/** @type {any} */ m) {
    if (m.loading) return '<div class="jobs"><div class="skeleton"><div></div></div></div>';
    if (!m.jobs.length) return '<div class="jobs"><div class="none">No job details.</div></div>';
    const row = (/** @type {any} */ j, /** @type {boolean} */ step) => {
      const [cls, ic] = STATE[/** @type {keyof typeof STATE} */ (j.state)] || STATE.queued;
      return `<div class="job${step ? ' step' : ''}${j.id === m.failed ? ' failed' : ''}"><span class="glyph small g-${cls}">${icon(ic)}</span><span class="nm">${esc(j.name)}</span></div>`;
    };
    return `<div class="jobs">${m.jobs.map((/** @type {any} */ j) => row(j, false) + (j.steps || []).map((/** @type {any} */ s) => row(s, true)).join('')).join('')}${
      m.failedLog ? `<pre class="log">${esc(m.failedLog)}</pre>` : ''
    }</div>`;
  }

  function showState(/** @type {any} */ m) {
    const ic = { signin: 'account', error: 'warning', empty: 'info' }[/** @type {'signin'} */ (m.state)] || 'info';
    const btn =
      m.state === 'signin' ? `<button class="primary" data-act="signIn">${icon('sign-in')}Sign in</button>`
      : m.state === 'error' ? `<button data-act="refresh">${icon('refresh')}Retry</button>`
      : '';
    listEl.innerHTML = `<div class="state ${m.state}">${icon(ic)}<b>${esc(m.title)}</b><span>${esc(m.text || '')}</span>${btn}</div>`;
  }

  listEl.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const act = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
    const row = /** @type {HTMLElement | null} */ (t.closest('.run'));
    const id = row && row.dataset.id;
    if (act) return vscode.postMessage({ type: act.dataset.act, id });
    if (!id) return;
    if (expanded[id]) delete expanded[id];
    else {
      expanded[id] = { loading: true };
      vscode.postMessage({ type: 'expand', id });
    }
    render();
  });
  filterEl.addEventListener('input', render);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'runs') {
      data = m;
      // Keep expanded runs open (and refresh their jobs) across polls.
      for (const id of Object.keys(expanded)) {
        if (data.runs.some((/** @type {any} */ r) => r.id === id)) vscode.postMessage({ type: 'expand', id });
        else delete expanded[id];
      }
      render();
    } else if (m.type === 'jobs') {
      if (expanded[m.id]) {
        expanded[m.id] = m;
        render();
      }
    } else if (m.type === 'loading' && !data) {
      listEl.innerHTML = '<div class="skeleton"><div></div><div></div><div></div></div>';
    } else if (m.type === 'state') {
      data = null;
      showState(m);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
