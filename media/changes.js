// @ts-check
(function () {
  const { esc, icon, middleName } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const msgEl = /** @type {HTMLTextAreaElement} */ ($('msg'));
  const amendEl = /** @type {HTMLInputElement} */ ($('amend'));
  const groupsEl = $('groups');
  /** Persisted: draft message, collapsed groups, tree/list. */
  const state = Object.assign({ draft: '', collapsed: {} }, vscode.getState() || {});
  const save = () => vscode.setState(state);
  const SYNC_IDS = ['btnSync', 'btnPush', 'btnPull', 'btnFetch'];
  /** @type {any} */
  let data = null;
  let draftBeforeAmend = '';
  /** Selected files ("group\npath"): Ctrl/Cmd-click toggles, Shift-click extends; actions apply to all. */
  let sel = new Set();
  /** @type {string | null} last row clicked, start of a Shift-click range */
  let anchor = null;
  const selKey = (/** @type {string} */ group, /** @type {string} */ path) => `${group}\n${path}`;
  const selected = (/** @type {string} */ group) => [...sel].filter((k) => k.startsWith(`${group}\n`)).map((k) => k.slice(group.length + 1));

  const STATUS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'untracked', T: 'type changed', '!': 'conflict' };

  msgEl.value = state.draft;

  // ---------- rendering ----------

  function render() {
    const s = data.status;
    $('branch').innerHTML = `${icon('git-branch')}<span class="bn">${esc(s.branch || 'detached HEAD')}</span>`;
    $('branch').title = s.upstream ? `${s.branch} → ${s.upstream}` : `${s.branch} · no upstream: the first push will publish this branch`;
    $('ab').innerHTML = s.upstream
      ? `${s.ahead ? `<span class="up" title="${s.ahead} commit(s) to push">${icon('arrow-up')}${s.ahead}</span>` : ''}${s.behind ? `<span class="down" title="${s.behind} commit(s) to pull">${icon('arrow-down')}${s.behind}</span>` : ''}${!s.ahead && !s.behind ? `<span class="ok" title="Up to date with ${esc(s.upstream)}">${icon('check')}</span>` : ''}`
      : `<span class="pub" title="Not published yet">${icon('cloud-upload')}<span class="pub-t">unpublished</span></span>`;
    $('btnPush').classList.toggle('hot', s.ahead > 0 || !s.upstream);
    $('btnPull').classList.toggle('hot', s.behind > 0);
    // One sync action stays visible (the one the branch needs); the others are under "…".
    const primary = s.upstream && s.ahead && s.behind ? 'btnSync' : s.ahead || !s.upstream ? 'btnPush' : s.behind ? 'btnPull' : 'btnSync';
    for (const id of SYNC_IDS) $(id).hidden = id !== primary;

    // Ticket linked to the branch: click to add its reference to the message.
    const t = data.ticket;
    const ticketEl = $('ticket');
    ticketEl.hidden = !t;
    if (t) {
      const ref = `${data.ticketPrefix}${t.id}`;
      const inMsg = msgEl.value.includes(ref);
      ticketEl.className = `ticket${inMsg ? ' on' : ''}`;
      ticketEl.innerHTML = `${icon(inMsg ? 'pass-filled' : 'link')}<span class="ref-id">${esc(ref)}</span>${t.title ? `<span class="tt">${esc(t.title)}</span>` : ''}`;
      ticketEl.title = inMsg ? `${ref} is in the message` : `Add ${ref} to the message (links the commit to the ticket)`;
    }

    const total = s.staged.length + s.unstaged.length + s.conflicts.length;
    const groups = [
      { key: 'conflicts', title: 'Merge conflicts', files: s.conflicts, staged: false },
      { key: 'staged', title: 'Staged', files: s.staged, staged: true },
      { key: 'unstaged', title: 'Changes', files: s.unstaged, staged: false },
    ].filter((g) => g.files.length);
    // Drop selected files that moved group or went away.
    const live = new Set(groups.flatMap((g) => g.files.map((f) => selKey(g.key, f.path))));
    sel = new Set([...sel].filter((k) => live.has(k)));
    groupsEl.innerHTML = operationHtml(data.operation, s) + (total
      ? groups.map(groupHtml).join('')
      : `<div class="gl-empty done">${icon('check-all')}<b>Working tree clean</b><span><span class="nw">Nothing to commit</span>${s.ahead ? `<span class="sep"> · </span><span class="nw">${s.ahead} commit${s.ahead > 1 ? 's' : ''} to push</span>` : ''}</span></div>`);
    updateCommitButton();
    // Hooks and signing, next to Amend.
    const hooks = data.hooks || [];
    $('hooks').innerHTML = hooks.length ? `<span class="hook-chip" title="These hooks run on commit: ${esc(hooks.join(', '))}">${icon('shield')}<span class="hk-name">${esc(hooks[0])}</span>${hooks.length > 1 ? `<span class="hk-more">+${hooks.length - 1}</span>` : ''}</span>` : '';
    const sg = data.signing || {};
    const signEl = $('signBox');
    signEl.hidden = !sg.available && !sg.always;
    if (!signEl.dataset.init) {
      /** @type {HTMLInputElement} */ ($('sign')).checked = !!sg.always;
      signEl.dataset.init = '1';
    }
  }

  function groupHtml(g) {
    const st = g.files.reduce((a, f) => ({ add: a.add + (f.added || 0), del: a.del + (f.deleted || 0) }), { add: 0, del: 0 });
    const collapsed = !!state.collapsed[g.key];
    const nSel = selected(g.key).length;
    const actions = nSel
      ? `<span class="selc">${nSel} selected</span>${g.key === 'staged'
          ? `<button class="icon" data-act="unstageSel" title="Unstage the ${nSel} selected">${icon('remove')}</button>`
          : g.key === 'unstaged'
            ? `<button class="icon" data-act="discardSel" title="Discard the ${nSel} selected">${icon('discard')}</button><button class="icon" data-act="stageSel" title="Stage the ${nSel} selected">${icon('add')}</button>`
            : ''}<button class="icon" data-act="clearSel" title="Clear the selection (Esc)">${icon('close')}</button>`
      : g.key === 'staged'
        ? `<button class="icon" data-act="unstageAll" title="Unstage all">${icon('remove')}</button>`
        : g.key === 'unstaged'
          ? `<button class="icon" data-act="discardAll" title="Discard all changes">${icon('discard')}</button><button class="icon" data-act="stageAll" title="Stage all">${icon('add')}</button>`
          : '';
    return `<div class="group ${g.key}${collapsed ? ' collapsed' : ''}${nSel ? ' has-sel' : ''}" data-group="${g.key}">
  <div class="gh" data-toggle="${g.key}">${icon(collapsed ? 'chevron-right' : 'chevron-down')}<span class="gt">${g.title}</span><span class="n">${g.files.length}</span>
    <span class="gs">${st.add ? `<span class="plus">+${st.add}</span>` : ''}${st.del ? `<span class="minus">−${st.del}</span>` : ''}</span>
    <span class="grow"></span><span class="ga">${actions}</span></div>
  <div class="gb">${g.files.map((f) => fileHtml(f, g)).join('')}</div>
</div>`;
  }

  /** Banner of a merge / rebase / cherry-pick / revert in progress. */
  function operationHtml(op, s) {
    if (!op) return '';
    const what =
      op.kind === 'rebase'
        ? `Rebasing <b>${esc(op.branch || 'HEAD')}</b>${op.onto ? ` onto <b>${esc(op.onto)}</b>` : ''}${op.total ? ` · step ${op.step}/${op.total}` : ''}`
        : op.kind === 'merge'
          ? `Merging${op.title ? ` · ${esc(op.title)}` : ''}`
          : op.kind === 'cherry-pick'
            ? 'Cherry-picking'
            : 'Reverting';
    const n = s.conflicts.length;
    return `<div class="op-banner${n ? ' conflicted' : ''}">
  <div class="op-top">${icon(n ? 'warning' : 'debug-pause')}<span>${what}</span></div>
  <div class="op-sub">${n ? `${n} conflict${n > 1 ? 's' : ''} to resolve` : 'No conflicts left: continue when ready'}</div>
  <div class="op-acts">
    <button class="primary" data-act="op:continue"${n ? ' disabled' : ''}>${icon('debug-continue')}Continue</button>
    ${op.kind === 'rebase' || op.kind === 'cherry-pick' ? `<button data-act="op:skip" title="Drop this commit and go on">${icon('debug-step-over')}Skip</button>` : ''}
    <button data-act="op:abort">${icon('close')}Abort</button>
  </div>
</div>`;
  }

  function fileHtml(f, g) {
    const i = f.path.lastIndexOf('/');
    const name = f.path.slice(i + 1);
    const dir = i >= 0 ? f.path.slice(0, i) : '';
    const rebase = data.operation && data.operation.kind === 'rebase';
    const actions = g.key === 'conflicts'
      ? `<button class="icon" data-act="resolve:editor" title="Open the merge editor">${icon('git-merge')}</button>
         <button class="icon" data-act="resolve:ours" title="${rebase ? 'Keep the upstream version (ours during a rebase)' : 'Keep the current branch version (ours)'}">${icon('arrow-left')}</button>
         <button class="icon" data-act="resolve:theirs" title="${rebase ? 'Keep your commit version (theirs during a rebase)' : 'Keep the incoming version (theirs)'}">${icon('arrow-right')}</button>
         <button class="icon" data-act="resolve:mark" title="Mark resolved (stage the file)">${icon('check')}</button>`
      : g.staged
      ? `<button class="icon" data-act="unstage" title="Unstage">${icon('remove')}</button>`
      : `<button class="icon" data-act="discard" title="Discard changes">${icon('discard')}</button><button class="icon" data-act="stage" title="Stage">${icon('add')}</button>`;
    const delta =
      f.added === undefined ? '' : `<span class="delta">${f.added ? `<span class="plus">+${f.added}</span>` : ''}${f.deleted ? `<span class="minus">−${f.deleted}</span>` : ''}</span>`;
    return `<div class="file st-${f.status}${sel.has(selKey(g.key, f.path)) ? ' sel' : ''}" data-group="${g.key}" data-path="${esc(f.path)}" data-old="${esc(f.oldPath || '')}" data-status="${f.status}" data-staged="${g.staged ? 1 : 0}" title="${esc(f.path)} — ${STATUS[f.status] || f.status}${f.oldPath ? ` (from ${esc(f.oldPath)})` : ''}">
  <span class="st ${f.status === '!' ? 'X' : f.status}">${f.status}</span><span class="name">${esc(name)}</span><span class="dir">${esc(dir)}</span>${delta}<span class="fa"><button class="icon" data-act="openFile" title="Open file">${icon('go-to-file')}</button>${actions}</span></div>`;
  }

  function updateCommitButton() {
    if (!data) return;
    const s = data.status;
    const amend = amendEl.checked;
    const n = s.staged.length || s.unstaged.length;
    $('commitLabel').textContent = amend ? 'Amend' : s.staged.length ? `Commit ${s.staged.length}` : n ? `Commit all ${n}` : 'Commit';
    const can = amend || (!!msgEl.value.trim() && n > 0 && !s.conflicts.length);
    /** @type {HTMLButtonElement} */ ($('btnCommit')).disabled = !can;
    /** @type {HTMLButtonElement} */ ($('btnCommitPush')).disabled = !can;
    // Behind the upstream: the second half pulls first (sync); a new branch gets published.
    const sync = s.behind > 0 && !amend;
    $('pushIcon').className = `codicon codicon-${sync ? 'sync' : s.upstream ? 'arrow-up' : 'cloud-upload'}`;
    $('pushLabel').textContent = sync ? 'Sync' : s.upstream ? 'Push' : 'Publish';
    $('btnCommitPush').setAttribute('aria-label', `Commit and ${sync ? 'sync' : s.upstream ? 'push' : 'publish'}`);
    $('btnCommitPush').title = sync
      ? `Commit, pull the ${s.behind} new commit${s.behind > 1 ? 's' : ''}, then push (Ctrl+Shift+Enter)`
      : s.upstream
        ? 'Commit, then push (Ctrl+Shift+Enter)'
        : 'Commit, then publish the branch (Ctrl+Shift+Enter)';
    renderCounter();
  }

  /** Subject length: calm under 50, amber up to 72, red beyond (git conventions). */
  function renderCounter() {
    const subject = msgEl.value.split('\n')[0];
    const n = subject.length;
    const el = $('counter');
    el.textContent = n ? `${n}/72` : '';
    el.className = `counter${n > 72 ? ' over' : n > 50 ? ' long' : ''}`;
  }

  function toggleTicket() {
    const t = data && data.ticket;
    if (!t) return;
    const ref = `${data.ticketPrefix}${t.id}`;
    if (msgEl.value.includes(ref)) {
      msgEl.value = msgEl.value.replace(new RegExp(`\\s*${ref.replace('#', '\\#')}\\b`), '');
    } else if (!msgEl.value.trim() && t.title) {
      // Empty message: start from the ticket title.
      msgEl.value = `feat: ${t.title} ${ref}`;
    } else {
      const lines = msgEl.value.split('\n');
      lines[0] = `${lines[0].trimEnd()} ${ref}`;
      msgEl.value = lines.join('\n');
    }
    onInput();
    render();
  }

  function onInput() {
    autosize();
    state.draft = amendEl.checked ? state.draft : msgEl.value;
    save();
    updateCommitButton();
    const t = data && data.ticket;
    if (t) $('ticket').classList.toggle('on', msgEl.value.includes(`${data.ticketPrefix}${t.id}`));
  }

  function autosize() {
    msgEl.style.height = 'auto';
    msgEl.style.height = `${Math.min(160, Math.max(30, msgEl.scrollHeight + 2))}px`;
  }

  function commit(push, noVerify = false) {
    if (/** @type {HTMLButtonElement} */ ($('btnCommit')).disabled) return;
    const sign = /** @type {HTMLInputElement | null} */ (document.getElementById('sign'));
    $('hookOut').hidden = true;
    vscode.postMessage({ type: 'commit', message: msgEl.value, amend: amendEl.checked, push, sign: !!(sign && sign.checked), noVerify });
  }

  // ---------- events ----------

  msgEl.addEventListener('input', onInput);
  $('hookOut').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-hook]'));
    if (!b) return;
    const push = $('hookOut').dataset.push === '1';
    if (b.dataset.hook === 'close') $('hookOut').hidden = true;
    else commit(push, b.dataset.hook === 'skip');
  });
  msgEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      $('btnGen').click();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      commit(e.shiftKey);
    }
  });
  amendEl.addEventListener('change', () => {
    if (amendEl.checked) {
      draftBeforeAmend = msgEl.value;
      vscode.postMessage({ type: 'lastMessage' });
    } else {
      msgEl.value = draftBeforeAmend;
      onInput();
    }
    updateCommitButton();
  });
  // ✨ generate / stop
  let generating = false;
  let beforeGen = '';
  $('btnGen').addEventListener('click', () => {
    if (generating) return vscode.postMessage({ type: 'stopGenerate' });
    beforeGen = msgEl.value;
    vscode.postMessage({ type: 'generate' });
  });
  function setGenerating(on) {
    generating = on;
    const btn = $('btnGen');
    btn.classList.toggle('on', on);
    btn.innerHTML = icon(on ? 'debug-stop' : 'sparkle');
    btn.title = on ? 'Stop generating' : 'Generate the commit message from the changes (AI)';
    msgEl.readOnly = on;
    document.body.classList.toggle('is-generating', on);
  }
  $('ticket').addEventListener('click', toggleTicket);
  $('btnCommit').addEventListener('click', () => commit(false));
  $('btnCommitPush').addEventListener('click', () => commit(true));
  for (const [id, action] of [['btnFetch', 'fetch'], ['btnPull', 'pull'], ['btnPush', 'push'], ['btnSync', 'sync']]) {
    $(id).addEventListener('click', () => vscode.postMessage({ type: 'git', action }));
  }

  // "…" of the branch card: the sync actions that are not shown, in the shared menu style (base.css .gl-pop.menu).
  const syncMenu = $('syncMenu');
  const closeSyncMenu = () => (syncMenu.hidden = true);
  $('btnSyncMore').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!syncMenu.hidden) return closeSyncMenu();
    syncMenu.innerHTML = SYNC_IDS.filter((id) => $(id).hidden)
      .map((id) => `<div class="gl-mi" role="menuitem" tabindex="-1" data-btn="${id}">${$(id).innerHTML}<span>${esc($(id).title)}</span></div>`)
      .join('');
    syncMenu.hidden = false;
    const r = $('btnSyncMore').getBoundingClientRect();
    syncMenu.style.top = `${r.bottom + 4}px`;
    syncMenu.style.left = `${Math.max(6, Math.min(r.right - syncMenu.offsetWidth, window.innerWidth - syncMenu.offsetWidth - 6))}px`;
    if (e.detail === 0) /** @type {HTMLElement | null} */ (syncMenu.querySelector('.gl-mi'))?.focus();
  });
  syncMenu.addEventListener('click', (e) => {
    const it = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-btn]'));
    if (!it) return;
    closeSyncMenu();
    $(/** @type {string} */ (it.dataset.btn)).click();
  });
  syncMenu.addEventListener('keydown', (e) => {
    const its = /** @type {HTMLElement[]} */ ([...syncMenu.querySelectorAll('.gl-mi')]);
    const i = its.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      its[(i + (e.key === 'ArrowDown' ? 1 : its.length - 1)) % its.length]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (i >= 0) its[i].click();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeSyncMenu();
      $('btnSyncMore').focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!syncMenu.contains(/** @type {Node} */ (e.target))) closeSyncMenu();
  });
  window.addEventListener('blur', closeSyncMenu);

  groupsEl.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const btn = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
    const file = /** @type {HTMLElement | null} */ (t.closest('.file'));
    if (btn) {
      e.stopPropagation();
      const act = /** @type {string} */ (btn.dataset.act);
      if (act.startsWith('op:')) return vscode.postMessage({ type: 'operation', action: act.slice(3) });
      if (act.startsWith('resolve:')) return vscode.postMessage({ type: 'resolve', path: file && file.dataset.path, side: act.slice(8) });
      if (act.endsWith('All')) return vscode.postMessage({ type: act });
      if (act === 'clearSel') return clearSelection();
      if (act.endsWith('Sel')) {
        const group = /** @type {HTMLElement} */ (btn.closest('[data-group]')).dataset.group || '';
        const paths = selected(group);
        clearSelection();
        return paths.length && vscode.postMessage({ type: act.slice(0, -3), paths });
      }
      if (act === 'openFile') return vscode.postMessage({ type: 'openFile', path: file && file.dataset.path });
      // On a selected row, the button acts on the whole selection of its group.
      const group = (file && file.dataset.group) || '';
      const path = (file && file.dataset.path) || '';
      const paths = sel.has(selKey(group, path)) ? selected(group) : [path];
      if (paths.length > 1) clearSelection();
      return vscode.postMessage({ type: act, paths });
    }
    const toggle = /** @type {HTMLElement | null} */ (t.closest('[data-toggle]'));
    if (toggle) {
      const k = /** @type {string} */ (toggle.dataset.toggle);
      state.collapsed[k] = !state.collapsed[k];
      save();
      return render();
    }
    if (file && (e.ctrlKey || e.metaKey || e.shiftKey)) return select(file, e.shiftKey);
    if (file) {
      if (sel.size) clearSelection();
      anchor = selKey(file.dataset.group || '', file.dataset.path || '');
      vscode.postMessage({ type: 'open', path: file.dataset.path, oldPath: file.dataset.old || undefined, status: file.dataset.status, staged: file.dataset.staged === '1' });
    }
  });
  /** Ctrl/Cmd-click: toggle the row. Shift-click: select from the last clicked row (same group). */
  function select(/** @type {HTMLElement} */ file, /** @type {boolean} */ range) {
    const group = file.dataset.group || '';
    const key = selKey(group, file.dataset.path || '');
    const rows = /** @type {HTMLElement[]} */ ([...groupsEl.querySelectorAll(`.file[data-group="${group}"]`)]);
    const keys = rows.map((r) => selKey(group, r.dataset.path || ''));
    const from = anchor ? keys.indexOf(anchor) : -1;
    if (range && from >= 0) {
      const to = keys.indexOf(key);
      for (const k of keys.slice(Math.min(from, to), Math.max(from, to) + 1)) sel.add(k);
    } else {
      if (sel.has(key)) sel.delete(key);
      else sel.add(key);
      anchor = key;
    }
    // One group at a time: staging and unstaging do not mix.
    sel = new Set([...sel].filter((k) => k.startsWith(`${group}\n`)));
    render();
  }
  function clearSelection() {
    if (!sel.size) return;
    sel.clear();
    if (data) render();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sel.size && document.activeElement !== msgEl) clearSelection();
  });

  // Double-click a file: stage / unstage it.
  groupsEl.addEventListener('dblclick', (e) => {
    const file = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.file'));
    if (!file || /** @type {HTMLElement} */ (e.target).closest('[data-act]') || file.dataset.status === '!') return;
    vscode.postMessage({ type: file.dataset.staged === '1' ? 'unstage' : 'stage', paths: [file.dataset.path] });
  });

  // Hover a file: preview of its staged or unstaged diff.
  // @ts-ignore
  const diffPreview = window.gitlandDiffPreview({
    vscode,
    root: groupsEl,
    selector: '.file',
    // Keep the stage / unstage / discard buttons reachable: the popup never covers them.
    reserveRight: 76,
    request: (row) => ({ path: row.dataset.path, oldPath: row.dataset.old || undefined, status: row.dataset.status, staged: row.dataset.staged === '1' }),
  });

  // ---------- branch card fit (content-driven) ----------

  /** Shorten a name in the middle (gl.middleName): keeps "feature/18342-" and as much of the tail as fits. */
  function middleEllipsis(/** @type {HTMLElement} */ el, /** @type {string} */ full) {
    el.textContent = full;
    if (el.scrollWidth <= el.clientWidth) return;
    let lo = 2;
    let hi = full.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      el.textContent = middleName(full, mid);
      if (el.scrollWidth <= el.clientWidth) lo = mid;
      else hi = mid - 1;
    }
    el.textContent = middleName(full, lo);
  }

  /** The branch name wins: first the "unpublished" label goes icon-only, then counts and buttons drop to a
   *  second row, and only then is the name shortened in the middle. Wraps only when the content needs it. */
  function fitBranch() {
    const card = /** @type {HTMLElement | null} */ (document.querySelector('.sync'));
    const el = /** @type {HTMLElement | null} */ (document.querySelector('#branch .bn'));
    if (!card || !el || !data) return;
    const full = data.status.branch || 'detached HEAD';
    card.classList.remove('ab-icon', 'stacked');
    el.textContent = full;
    const over = () => el.scrollWidth > el.clientWidth + 0.5;
    if (over()) card.classList.add('ab-icon');
    if (over()) {
      card.classList.remove('ab-icon');
      card.classList.add('stacked');
    }
    middleEllipsis(el, full);
  }

  /** A line above the composer only while the file list scrolls under it. */
  function updateLift() {
    const sc = document.body;
    document.body.classList.toggle('lifted', sc.scrollHeight > sc.clientHeight + 1 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1);
  }
  new ResizeObserver(() => {
    fitBranch();
    updateLift();
  }).observe(document.body);
  document.body.addEventListener('scroll', updateLift, { passive: true });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'preview') return diffPreview.receive(m);
    if (m.type === 'status') {
      diffPreview.clear();
      $('error').hidden = true;
      data = m;
      render();
      fitBranch();
      updateLift();
      showBusy(m.busy ? '…' : '');
    } else if (m.type === 'busy') {
      showBusy(m.title);
    } else if (m.type === 'hookFailed') {
      const box = $('hookOut');
      box.hidden = false;
      box.innerHTML = `<div class="ho-h">${icon('error')}<b>${esc(m.hooks.join(', '))} stopped the commit</b></div><pre>${esc(m.output)}</pre>
        <div class="ho-acts"><button data-hook="retry">${icon('refresh')}Retry</button><button data-hook="skip" title="git commit --no-verify">${icon('debug-step-over')}Commit anyway (skip hooks)</button><button class="ghost" data-hook="close">${icon('close')}</button></div>`;
      box.dataset.push = m.push ? '1' : '';
    } else if (m.type === 'committed') {
      msgEl.value = '';
      amendEl.checked = false;
      state.draft = '';
      save();
      onInput();
    } else if (m.type === 'genStart') {
      setGenerating(true);
      msgEl.value = '';
      onInput();
    } else if (m.type === 'genText') {
      msgEl.value = m.text;
      onInput();
      msgEl.scrollTop = msgEl.scrollHeight;
    } else if (m.type === 'genDone') {
      setGenerating(false);
      if (typeof m.text === 'string' && m.text.trim()) msgEl.value = m.text.trim();
      else if (!msgEl.value.trim()) msgEl.value = beforeGen; // failed or stopped before any text
      onInput();
      if (data) render();
      msgEl.focus();
    } else if (m.type === 'lastMessage') {
      if (amendEl.checked) {
        msgEl.value = m.message;
        onInput();
      }
    } else if (m.type === 'error') {
      $('error').hidden = false;
      $('error').textContent = m.message;
    }
  });

  function showBusy(title) {
    const el = $('busy');
    el.hidden = !title;
    el.innerHTML = title ? `<i class="codicon codicon-loading codicon-modifier-spin"></i>${esc(title)}` : '';
    document.body.classList.toggle('is-busy', !!title);
  }

  autosize();
  vscode.postMessage({ type: 'ready' });
})();
