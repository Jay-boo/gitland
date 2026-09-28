// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const LANE = 16;
  const COLORS = ['#4dabf7', '#f76707', '#37b24d', '#e64980', '#fab005', '#7950f2', '#15aabf', '#f03e3e', '#82c91e', '#be4bdb'];
  const WORKTREE = 'WORKTREE';

  /** @type {any} */
  let data = null;
  let selected = /** @type {string | null} */ (null);
  let matches = /** @type {number[]} */ ([]);
  let matchIndex = -1;

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const rowsEl = $('rows');
  const listEl = $('list');
  const detailsEl = $('details');
  const menuEl = $('menu');
  const searchEl = /** @type {HTMLInputElement} */ ($('search'));

  const esc = (/** @type {string} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  const color = (/** @type {number} */ i) => COLORS[i % COLORS.length];
  const rowH = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 28;

  // ---------- rendering ----------

  function svgFor(commit, h) {
    const g = commit.graph;
    const w = (data.width + 1) * LANE;
    const cx = (/** @type {number} */ l) => LANE / 2 + l * LANE + 4;
    let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
    for (const seg of g.segments) {
      const x1 = cx(seg.x1), x2 = cx(seg.x2), y1 = seg.y1 * h, y2 = seg.y2 * h;
      const c = color(seg.color);
      const dash = commit.sha === WORKTREE && seg.y1 === 0.5 ? ' stroke-dasharray="3 3"' : '';
      if (x1 === x2) {
        s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="2"${dash}/>`;
      } else {
        const my = (y1 + y2) / 2;
        s += `<path d="M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}" fill="none" stroke="${c}" stroke-width="2"${dash}/>`;
      }
    }
    const x = cx(g.lane), y = h / 2, c = color(g.color);
    if (commit.sha === WORKTREE) {
      s += `<circle cx="${x}" cy="${y}" r="5" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="2" stroke-dasharray="2 2"/>`;
    } else if (commit.sha === data.head) {
      s += `<circle cx="${x}" cy="${y}" r="6.5" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="2.5"/>`;
      s += `<circle cx="${x}" cy="${y}" r="3" fill="${c}"/>`;
    } else if (commit.parents.length > 1) {
      s += `<circle cx="${x}" cy="${y}" r="4" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="2"/>`;
    } else {
      s += `<circle cx="${x}" cy="${y}" r="4.5" fill="${c}" stroke="var(--vscode-editor-background)" stroke-width="1.5"/>`;
    }
    return s + '</svg>';
  }

  /** Merge "main" + "origin/main" into one badge when they point at the same commit. */
  function refBadges(commit) {
    const refs = commit.refs || [];
    const locals = new Set(refs.filter((r) => r.type === 'branch').map((r) => r.name));
    const synced = new Set();
    const out = [];
    for (const r of refs) {
      if (r.type === 'remote') {
        const local = r.name.slice(r.name.indexOf('/') + 1);
        if (locals.has(local)) {
          synced.add(local);
          continue;
        }
      }
      out.push(r);
    }
    const c = color(commit.graph.color);
    out.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
    return out
      .map((r) => {
        const cls = ['ref', r.type, r.current ? 'current' : ''].join(' ');
        const icon = r.type === 'tag' ? '◆ ' : r.current ? '✓ ' : r.type === 'remote' ? '☁ ' : '';
        const cloud = synced.has(r.name) ? ' <span class="cloud" title="In sync with remote">☁</span>' : '';
        return `<span class="${cls}" style="--c:${c}" data-ref="${esc(r.name)}" data-reftype="${r.type}" title="${esc(r.type)}: ${esc(r.name)}">${icon}${esc(r.name)}${cloud}</span>`;
      })
      .join('');
  }

  function render() {
    if (!data) return;
    const h = rowH();
    document.documentElement.style.setProperty('--graph-w', `${Math.min((data.width + 1) * LANE + 12, 420)}px`);
    $('repoName').textContent = data.repoName;
    $('branchName').textContent = data.branch ? `⎇ ${data.branch}` : 'detached HEAD';
    $('remoteName').textContent = data.remote || '';
    const html = data.commits
      .map(
        (c, i) => `<div class="row commit${c.sha === WORKTREE ? ' worktree' : ''}${c.sha === selected ? ' selected' : ''}" data-i="${i}" data-sha="${c.sha}">
  <div class="c-graph">${svgFor(c, h)}</div>
  <div class="c-msg">${refBadges(c)}<span class="subject" title="${esc(c.subject)}">${esc(c.subject)}</span></div>
  <div class="c-author" title="${esc(c.email)}">${esc(c.author)}</div>
  <div class="c-date">${esc(c.date)}</div>
  <div class="c-sha">${esc(c.short)}</div>
</div>`,
      )
      .join('');
    rowsEl.innerHTML = html;
    $('more').innerHTML = data.hasMore ? '<button id="btnMore">Load more commits…</button>' : `<span class="muted">${data.commits.length} commits</span>`;
    applySearch(false);
  }

  // ---------- details ----------

  function showDetails(sha, d) {
    if (sha !== selected) return;
    const isWt = sha === WORKTREE;
    const lines = (d.message || '').split('\n');
    const subject = lines[0];
    const body = lines.slice(1).join('\n').trim();
    const parents = (d.parents || [])
      .map((p) => `<span class="link" data-goto="${p}">${p.slice(0, 7)}</span>`)
      .join('');
    const commit = data.commits.find((c) => c.sha === sha);
    const files = (d.files || [])
      .map((f) => {
        const idx = f.path.lastIndexOf('/');
        const name = f.path.slice(idx + 1);
        const dir = idx >= 0 ? f.path.slice(0, idx) : '';
        const renamed = f.oldPath ? ` ← ${esc(f.oldPath)}` : '';
        return `<div class="file" data-path="${esc(f.path)}" data-old="${esc(f.oldPath || '')}" data-status="${f.status}" title="${esc(f.path)}${renamed}">
  <span class="st ${f.status}">${f.status}</span><span class="name">${esc(name)}</span><span class="dir">${esc(dir)}${renamed}</span></div>`;
      })
      .join('');
    detailsEl.innerHTML = `
<div class="resizer"></div>
<button class="close" title="Close (Esc)">✕</button>
<div class="info">
  <h2>${esc(subject)}</h2>
  ${commit && commit.refs.length ? `<div class="refs">${refBadges(commit)}</div>` : ''}
  ${
    isWt
      ? ''
      : `<div class="meta">
    <span class="k">Commit</span><span><code>${esc(d.sha)}</code> <span class="link" data-act="copySha">copy</span></span>
    <span class="k">Author</span><span>${esc(d.author)} &lt;${esc(d.email)}&gt;</span>
    <span class="k">Date</span><span>${esc(d.authorDate)}</span>
    ${d.committer && d.committer !== d.author ? `<span class="k">Committer</span><span>${esc(d.committer)} · ${esc(d.commitDate)}</span>` : ''}
    <span class="k">Parents</span><span>${parents || '<span class="muted">none</span>'}</span>
  </div>`
  }
  ${body ? `<div class="body">${esc(body)}</div>` : ''}
  ${
    isWt
      ? ''
      : `<div class="actions">
    <button class="primary" data-act="createBranch">⎇ Branch here</button>
    <button data-act="checkoutCommit">Checkout</button>
    <button data-act="cherryPick">Cherry-pick</button>
    <button data-act="revert">Revert</button>
    <button data-act="openRemote">Open on remote ↗</button>
  </div>`
  }
</div>
<div class="files"><h3>${(d.files || []).length} file${(d.files || []).length === 1 ? '' : 's'} changed</h3>${files || '<span class="muted">No file changes</span>'}</div>`;
    detailsEl.hidden = false;
  }

  function select(sha, scroll) {
    selected = sha;
    rowsEl.querySelectorAll('.commit.selected').forEach((el) => el.classList.remove('selected'));
    const row = rowsEl.querySelector(`.commit[data-sha="${sha}"]`);
    if (row) {
      row.classList.add('selected');
      if (scroll) row.scrollIntoView({ block: 'center' });
    }
    vscode.postMessage({ type: 'select', sha });
    vscode.setState({ selected });
  }

  function closeDetails() {
    detailsEl.hidden = true;
    selected = null;
    rowsEl.querySelectorAll('.commit.selected').forEach((el) => el.classList.remove('selected'));
  }

  // ---------- search ----------

  function applySearch(jump) {
    const q = searchEl.value.trim().toLowerCase();
    matches = [];
    const rows = rowsEl.children;
    data.commits.forEach((c, i) => {
      const hay = `${c.subject}\n${c.author}\n${c.email}\n${c.sha}\n${c.refs.map((r) => r.name).join(' ')}`.toLowerCase();
      const hit = !!q && hay.includes(q);
      if (hit) matches.push(i);
      rows[i].classList.toggle('match', hit);
      rows[i].classList.toggle('dim', !!q && !hit);
    });
    $('searchCount').textContent = q ? `${matches.length ? matchIndex + 1 : 0}/${matches.length}` : '';
    if (jump && matches.length) {
      matchIndex = (matchIndex + 1) % matches.length;
      $('searchCount').textContent = `${matchIndex + 1}/${matches.length}`;
      select(data.commits[matches[matchIndex]].sha, true);
    }
  }

  // ---------- context menu ----------

  function showMenu(x, y, items) {
    menuEl.innerHTML = items
      .map((it) =>
        it === '-'
          ? '<div class="sep"></div>'
          : it.label && !it.act
            ? `<div class="label">${esc(it.label)}</div>`
            : `<div class="item${it.danger ? ' danger' : ''}" data-act="${it.act}" data-sha="${it.sha || ''}" data-ref="${esc(it.ref || '')}" data-reftype="${it.refType || ''}">${esc(it.label)}</div>`,
      )
      .join('');
    menuEl.hidden = false;
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
    menuEl.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
  }

  function commitMenu(sha) {
    return [
      { label: '⎇  Create branch here…', act: 'createBranch', sha },
      { label: '◆  Create tag here…', act: 'createTag', sha },
      { label: 'Checkout (detached)', act: 'checkoutCommit', sha },
      '-',
      { label: 'Cherry-pick onto current branch', act: 'cherryPick', sha },
      { label: 'Revert commit', act: 'revert', sha },
      { label: 'Reset current branch to here…', act: 'reset', sha, danger: true },
      '-',
      { label: 'Copy SHA', act: 'copySha', sha },
      { label: 'Copy message', act: 'copyMessage', sha },
      { label: 'Open on remote ↗', act: 'openRemote', sha },
    ];
  }

  function refMenu(ref, refType) {
    if (refType === 'tag') {
      return [{ label: `tag ${ref}` }, { label: 'Copy name', act: 'copyRef', ref }, { label: 'Delete tag', act: 'deleteTag', ref, danger: true }];
    }
    const isCurrent = ref === data.branch;
    const items = [{ label: `${refType === 'remote' ? 'remote branch' : 'branch'} ${ref}` }];
    if (!isCurrent) items.push({ label: 'Checkout', act: 'checkoutBranch', ref, refType });
    if (refType === 'branch') {
      items.push({ label: '⇡  Push', act: 'push', ref, refType });
      items.push({ label: '⇄  Create pull request…', act: 'createPr', ref, refType });
    }
    if (!isCurrent && data.branch) {
      items.push('-', { label: `Merge into ${data.branch}`, act: 'merge', ref, refType }, { label: `Rebase ${data.branch} onto this`, act: 'rebase', ref, refType });
    }
    items.push('-', { label: 'Open on remote ↗', act: 'openBranchRemote', ref, refType }, { label: 'Copy name', act: 'copyRef', ref, refType });
    if (!isCurrent) items.push({ label: 'Delete branch…', act: 'deleteBranch', ref, refType, danger: true });
    return items;
  }

  // ---------- events ----------

  rowsEl.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const row = /** @type {HTMLElement | null} */ (t.closest('.commit'));
    if (row) select(row.dataset.sha, false);
  });

  rowsEl.addEventListener('dblclick', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const ref = /** @type {HTMLElement | null} */ (t.closest('.ref'));
    if (ref && ref.dataset.reftype !== 'tag') {
      vscode.postMessage({ type: 'action', action: 'checkoutBranch', ref: ref.dataset.ref, refType: ref.dataset.reftype });
    }
  });

  rowsEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = /** @type {HTMLElement} */ (e.target);
    const ref = /** @type {HTMLElement | null} */ (t.closest('.ref'));
    const row = /** @type {HTMLElement | null} */ (t.closest('.commit'));
    if (!row || row.dataset.sha === WORKTREE) return;
    if (ref) showMenu(e.clientX, e.clientY, refMenu(ref.dataset.ref, ref.dataset.reftype));
    else showMenu(e.clientX, e.clientY, commitMenu(row.dataset.sha));
  });

  detailsEl.addEventListener('contextmenu', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const ref = /** @type {HTMLElement | null} */ (t.closest('.ref'));
    if (ref) {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, refMenu(ref.dataset.ref, ref.dataset.reftype));
    }
  });

  menuEl.addEventListener('click', (e) => {
    const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.item'));
    if (!item) return;
    menuEl.hidden = true;
    vscode.postMessage({
      type: 'action',
      action: item.dataset.act,
      sha: item.dataset.sha || undefined,
      ref: item.dataset.ref || undefined,
      refType: item.dataset.reftype || undefined,
    });
  });

  document.addEventListener('click', (e) => {
    if (!menuEl.contains(/** @type {Node} */ (e.target))) menuEl.hidden = true;
  });
  window.addEventListener('blur', () => (menuEl.hidden = true));

  detailsEl.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('.close')) return closeDetails();
    const file = /** @type {HTMLElement | null} */ (t.closest('.file'));
    if (file) {
      vscode.postMessage({ type: 'openDiff', sha: selected, path: file.dataset.path, oldPath: file.dataset.old || undefined, status: file.dataset.status });
      return;
    }
    const go = t.dataset.goto;
    if (go) return select(go, true);
    const act = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
    if (act) vscode.postMessage({ type: 'action', action: act.dataset.act, sha: selected });
  });

  // Drag to resize the details pane.
  detailsEl.addEventListener('mousedown', (e) => {
    if (!(/** @type {HTMLElement} */ (e.target).classList.contains('resizer'))) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = detailsEl.getBoundingClientRect().height;
    const move = (/** @type {MouseEvent} */ ev) => (detailsEl.style.height = `${Math.max(120, startH - (ev.clientY - startY))}px`);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  $('more').addEventListener('click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).id === 'btnMore') vscode.postMessage({ type: 'loadMore' });
  });
  $('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('btnFetch').addEventListener('click', () => vscode.postMessage({ type: 'action', action: 'fetch' }));

  searchEl.addEventListener('input', () => {
    matchIndex = -1;
    applySearch(false);
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applySearch(true);
    if (e.key === 'Escape') {
      searchEl.value = '';
      applySearch(false);
      listEl.focus();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === searchEl) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
      return;
    }
    if (e.key === 'Escape') {
      menuEl.hidden = true;
      closeDetails();
      return;
    }
    if (!data || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const i = data.commits.findIndex((c) => c.sha === selected);
    const next = Math.max(0, Math.min(data.commits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    const row = rowsEl.children[next];
    select(data.commits[next].sha, false);
    row && row.scrollIntoView({ block: 'nearest' });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'data') {
      $('error').hidden = true;
      const scroll = listEl.scrollTop;
      data = m;
      if (m.select) selected = m.select;
      if (selected && !data.commits.some((c) => c.sha === selected)) {
        detailsEl.hidden = true;
        selected = null;
      }
      render();
      if (m.select) select(m.select, true);
      else {
        listEl.scrollTop = scroll;
        if (selected) vscode.postMessage({ type: 'select', sha: selected });
      }
    } else if (m.type === 'details') {
      showDetails(m.sha, m.details);
    } else if (m.type === 'error') {
      $('error').hidden = false;
      $('error').textContent = m.message;
    }
  });

  const saved = vscode.getState();
  if (saved && saved.selected) selected = saved.selected;
  vscode.postMessage({ type: 'ready' });
})();
