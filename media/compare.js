// @ts-check
(function () {
  const { esc, icon, relTime, listDate, displayName, loadingHtml } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));
  const state = Object.assign({ tab: 'commits', merges: true }, vscode.getState() || {});
  /** @type {any} */
  let data = null;
  let notesText = '';
  let notesBusy = false;
  let lastPair = '';
  let viewed = new Set();
  let filter = '';
  let active = '';
  const currentNotes = () => {
    const el = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('notesText'));
    return el ? el.value : notesText;
  };


  /** "Merged PR 527: title" / "Merge pull request 524 from chore/x into dev" → PR number, branch, title. */
  function prOf(subject) {
    let m = /^Merged PR (\d+):\s*(.*)$/i.exec(subject);
    if (m) return { id: m[1], title: m[2] };
    m = /^Merge pull request #?(\d+) from (?:[\w.-]+:)?(\S+?)(?: into (\S+))?$/i.exec(subject);
    if (m) return { id: m[1], branch: m[2], into: m[3] };
    return null;
  }

  function prUrl(id) {
    return data.links ? data.links.pr.replace('{id}', id) : '';
  }

  function refChip(side, name) {
    const tagLike = /^v?\d+(\.\d+)+/.test(name);
    return `<button class="ref-pick" data-pick="${side}" title="Change">${icon(tagLike ? 'tag' : 'git-branch')}<span>${esc(name)}</span>${icon('chevron-down')}</button>`;
  }

  function header(from, to) {
    return `<header class="c-head">
  <div class="c-refs">${refChip('from', from)}<button class="icon swap" data-act="swap" title="Swap">${icon('arrow-swap')}</button>${refChip('to', to)}</div>
  <span class="grow"></span>
  <button data-act="copyNotes" title="Copy the list of changes as markdown">${icon('copy')}Copy as list</button>
  <button class="gen-btn" data-act="notes" title="Write release notes with AI, in the style of the repository's CHANGELOG">${icon('sparkle')}Release notes</button>
  ${data && data.release && data.release.url && data.release.tag === to ? `<button class="icon" data-act="openRelease" title="Open release ${esc(to)} on the remote">${icon('link-external')}</button>` : ''}
  <button class="icon" data-act="refresh" title="Refresh">${icon('refresh')}</button>
</header>`;
  }

  function commitRow(c) {
    const pr = prOf(c.subject);
    const av = (data.avatars || {})[String(c.email).toLowerCase()];
    const merge = c.parents.length > 1;
    const title = pr ? pr.title || (pr.branch ? `${pr.branch}${pr.into ? ` → ${pr.into}` : ''}` : c.subject) : c.subject;
    return `<div class="c-row${merge ? ' merge' : ''}" data-sha="${esc(c.sha)}" title="${esc(c.subject)}\n${esc(c.author)} · ${new Date(c.date).toLocaleString()}\nClick to show it in the Commit Graph">
  ${av ? `<img class="av" src="${esc(av)}" alt="">` : '<span class="av"></span>'}
  ${pr ? `<span class="pr-chip" data-url="${esc(prUrl(pr.id))}">${icon('git-pull-request')}${esc(pr.id)}</span>` : ''}
  <span class="s">${esc(title)}</span>
  <span class="a" title="${esc(c.author)}">${esc(displayName(c.author))}</span>${listDate(c.date)}<span class="sha">${esc(c.sha.slice(0, 7))}</span>
</div>`;
  }

  function commitsTab() {
    const side = (list, label, empty, tools = '') => {
      const shown = state.merges ? list : list.filter((c) => c.parents.length <= 1);
      return `<section><h3>${label} <span class="n">${list.length}</span>${tools}</h3>${shown.length ? shown.map(commitRow).join('') : `<div class="none">${empty}</div>`}</section>`;
    };
    const prs = data.ahead.map((c) => ({ c, pr: prOf(c.subject) })).filter((x) => x.pr);
    const prSection = prs.length
      ? `<section><h3>Pull requests merged <span class="n">${prs.length}</span></h3><div class="prs">${prs
          .map(({ c, pr }) => `<div class="pr-row" data-url="${esc(prUrl(pr.id))}">${icon('git-pull-request')}<span class="id">${esc(pr.id)}</span><span class="s">${esc(pr.title || pr.branch || c.subject)}</span>${pr.branch ? `<span class="br">${esc(pr.branch)}${pr.into ? ` → ${esc(pr.into)}` : ''}</span>` : ''}</div>`)
          .join('')}</div></section>`
      : '';
    const mergesToggle = `<label class="switch" title="Show the merge commits in the lists below"><input id="merges" type="checkbox"${state.merges ? ' checked' : ''}><span class="track"><span class="knob"></span></span><span>merge commits</span></label>`;
    return `${prSection}
${side(data.ahead, `In <b>${esc(data.to)}</b>, not in <b>${esc(data.from)}</b>`, 'Nothing new.', mergesToggle)}
${data.behind.length ? side(data.behind, `In <b>${esc(data.from)}</b>, not in <b>${esc(data.to)}</b>`, '') : ''}`;
  }

  function filesTab() {
    if (!data.files.length) return '<div class="none">No differences.</div>';
    return `<div class="f-tools">
  <input id="fFilter" class="f-filter" type="text" placeholder="Filter files" value="${esc(filter)}" spellcheck="false" title="Click a file to see its diff beside this list · ↑ ↓ next / previous file · v mark as viewed">
  <span class="f-progress" id="fProgress">${progress()}</span>
  <label class="switch"><input id="hideViewed" type="checkbox"${state.hideViewed ? ' checked' : ''}><span class="track"><span class="knob"></span></span><span>hide viewed</span></label>
  <button class="primary" data-act="openAll" title="Every diff in one scrollable editor">${icon('diff-multiple')}Open all changes</button>
</div>
<div id="fList">${fileList()}</div>`;
  }

  function progress() {
    const n = data.files.filter((f) => viewed.has(f.path)).length;
    return `<b>${n}</b> / ${data.files.length} viewed`;
  }

  function shownFiles() {
    const q = filter.trim().toLowerCase();
    return data.files.filter((f) => (!q || f.path.toLowerCase().includes(q)) && !(state.hideViewed && viewed.has(f.path) && f.path !== active));
  }

  function fileList() {
    const shown = shownFiles();
    if (!shown.length) return `<div class="none">${filter ? 'No file matches.' : 'All files viewed.'}</div>`;
    const byDir = new Map();
    for (const f of shown) {
      const i = f.path.lastIndexOf('/');
      const dir = i >= 0 ? f.path.slice(0, i) : '';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    return [...byDir.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([dir, files]) => `<div class="dir">${icon('folder')}<span>${esc(dir || '/')}</span></div>${files
          .map((f) => {
            const name = f.path.slice(f.path.lastIndexOf('/') + 1);
            const delta = f.added === undefined ? '' : `<span class="delta">${f.added ? `<span class="plus">+${f.added}</span>` : ''}${f.deleted ? `<span class="minus">−${f.deleted}</span>` : ''}</span>`;
            const seen = viewed.has(f.path);
            return `<div class="f-row${seen ? ' viewed' : ''}${f.path === active ? ' on' : ''}" data-path="${esc(f.path)}" data-old="${esc(f.oldPath || '')}" data-status="${f.status}" title="${esc(f.path)}${f.oldPath ? ` (from ${esc(f.oldPath)})` : ''}"><input type="checkbox" class="f-viewed" title="Viewed"${seen ? ' checked' : ''}><span class="st ${f.status}">${f.status}</span><span class="name">${esc(name)}</span>${delta}</div>`;
          })
          .join('')}`,
      )
      .join('');
  }

  function render() {
    const d = data;
    const add = d.files.reduce((n, f) => n + (f.added || 0), 0);
    const del = d.files.reduce((n, f) => n + (f.deleted || 0), 0);
    page.innerHTML = `${header(d.from, d.to)}
<div class="c-summary">
  <span><b>${d.ahead.length}</b> commit${d.ahead.length === 1 ? '' : 's'} ahead</span>
  ${d.behind.length ? `<span><b>${d.behind.length}</b> behind</span>` : ''}
  <span><b>${d.files.length}</b> file${d.files.length === 1 ? '' : 's'}</span>
  ${add ? `<span class="plus">+${add}</span>` : ''}${del ? `<span class="minus">−${del}</span>` : ''}
  ${d.mergeBase ? `<span class="base" data-sha="${esc(d.mergeBase.sha)}" title="Where they diverged: ${esc(d.mergeBase.subject)}">${icon('git-merge')} diverged at ${esc(d.mergeBase.sha.slice(0, 7))} · ${esc(relTime(d.mergeBase.date))}</span>` : ''}
</div>
<section id="notes" class="notes" ${notesText || notesBusy ? '' : 'hidden'}>
  <div class="notes-bar"><b>${icon('sparkle')} Release notes</b><span class="grow"></span>
    <button data-act="stopNotes" ${notesBusy ? '' : 'hidden'}>${icon('debug-stop')}Stop</button>
    <button data-act="copyGenerated" ${notesBusy ? 'disabled' : ''}>${icon('copy')}Copy</button>
    <button class="primary" data-act="insertChangelog" ${notesBusy ? 'disabled' : ''} title="Insert into CHANGELOG.md (opened for review, not saved)">${icon('insert')}Insert into CHANGELOG.md</button>
  </div>
  <textarea id="notesText" spellcheck="true">${esc(notesText)}</textarea>
</section>
<nav class="tabs"><span class="tab${state.tab === 'commits' ? ' on' : ''}" data-tab="commits">${icon('git-commit')}Commits</span><span class="tab${state.tab === 'files' ? ' on' : ''}" data-tab="files">${icon('files')}Files <span class="n">${d.files.length}</span></span></nav>
<div class="tab-body">${state.tab === 'files' ? filesTab() : commitsTab()}</div>`;
  }

  /** Markdown release notes: PRs first, then the other commits. */
  function releaseNotes() {
    const lines = [`## ${data.to}`, '', `Changes since ${data.from}.`, ''];
    const prs = data.ahead.filter((c) => prOf(c.subject));
    const others = data.ahead.filter((c) => !prOf(c.subject) && c.parents.length <= 1);
    if (prs.length) {
      lines.push('### Pull requests', '');
      for (const c of prs) {
        const pr = prOf(c.subject);
        lines.push(`- ${pr.title || pr.branch || c.subject} ([PR ${pr.id}](${prUrl(pr.id)}))`);
      }
      lines.push('');
    }
    if (others.length) {
      lines.push('### Commits', '');
      for (const c of others) lines.push(`- ${c.subject} (${c.sha.slice(0, 7)}, ${c.author})`);
    }
    return lines.join('\n');
  }

  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const el = /** @type {HTMLElement | null} */ (t.closest('[data-url],[data-act],[data-pick],[data-tab],[data-sha],.f-row'));
    if (!el) return;
    if (el.dataset.url) return vscode.postMessage({ type: 'openUrl', url: el.dataset.url });
    if (el.dataset.act === 'openRelease') return vscode.postMessage({ type: 'openExternal', url: data.release.url });
    if (el.dataset.act === 'copyNotes') return vscode.postMessage({ type: 'copy', text: releaseNotes() });
    if (el.dataset.act === 'copyGenerated') return vscode.postMessage({ type: 'copy', text: currentNotes() });
    if (el.dataset.act === 'insertChangelog') return vscode.postMessage({ type: 'insertChangelog', text: currentNotes() });
    if (el.dataset.act === 'notes') {
      notesBusy = true;
      notesText = '';
      render();
      return vscode.postMessage({ type: 'notes' });
    }
    if (el.dataset.act) return vscode.postMessage({ type: el.dataset.act });
    if (el.dataset.pick) return vscode.postMessage({ type: 'pick', side: el.dataset.pick });
    if (el.dataset.tab) {
      state.tab = el.dataset.tab;
      vscode.setState(state);
      return render();
    }
    if (el.dataset.sha) return vscode.postMessage({ type: 'showCommit', sha: el.dataset.sha });
    if (el.classList.contains('f-row') && !t.classList.contains('f-viewed')) return openFile(el);
  });

  function refreshFiles() {
    const list = document.getElementById('fList');
    if (list) list.innerHTML = fileList();
    const p = document.getElementById('fProgress');
    if (p) p.innerHTML = progress();
  }

  // @ts-ignore
  const preview = window.gitlandDiffPreview({ vscode, root: page, selector: '.f-row', request: (row) => ({ path: row.dataset.path, oldPath: row.dataset.old || undefined }) });

  function openFile(row) {
    preview.hide();
    active = row.dataset.path;
    page.querySelectorAll('.f-row.on').forEach((r) => r.classList.remove('on'));
    row.classList.add('on');
    row.scrollIntoView({ block: 'nearest' });
    vscode.postMessage({ type: 'openDiff', path: row.dataset.path, oldPath: row.dataset.old || undefined, status: row.dataset.status });
  }

  function setViewed(paths, on) {
    paths.forEach((p) => (on ? viewed.add(p) : viewed.delete(p)));
    vscode.postMessage({ type: 'viewed', paths, on });
    refreshFiles();
  }

  document.addEventListener('keydown', (e) => {
    if (!data || state.tab !== 'files' || /^(INPUT|TEXTAREA)$/.test(/** @type {HTMLElement} */ (e.target).tagName) && /** @type {HTMLInputElement} */ (e.target).type !== 'checkbox') return;
    const rows = /** @type {HTMLElement[]} */ ([...page.querySelectorAll('.f-row')]);
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.dataset.path === active);
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      openFile(rows[Math.min(rows.length - 1, i + 1)]);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      openFile(rows[Math.max(0, i - 1)]);
    } else if (e.key === 'v' && active) {
      setViewed([active], !viewed.has(active));
    }
  });
  page.addEventListener('input', (e) => {
    if (/** @type {HTMLElement} */ (e.target).id === 'notesText') notesText = /** @type {HTMLTextAreaElement} */ (e.target).value;
    if (/** @type {HTMLElement} */ (e.target).id === 'fFilter') {
      filter = /** @type {HTMLInputElement} */ (e.target).value;
      const list = document.getElementById('fList');
      if (list) list.innerHTML = fileList();
    }
  });
  page.addEventListener('change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.classList.contains('f-viewed')) {
      const row = /** @type {HTMLElement} */ (t.closest('.f-row'));
      return setViewed([row.dataset.path || ''], t.checked);
    }
    if (t.id === 'hideViewed') {
      state.hideViewed = t.checked;
      vscode.setState(state);
      return refreshFiles();
    }
    if (t.id === 'merges') {
      state.merges = t.checked;
      vscode.setState(state);
      render();
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'compare') {
      data = m;
      viewed = new Set(m.viewed || []);
      preview.clear();
      if (m.from + m.to !== lastPair) {
        notesText = '';
        filter = '';
        active = '';
        lastPair = m.from + m.to;
        if (m.tab) state.tab = m.tab;
      }
      render();
      if (m.autoNotes) {
        notesBusy = true;
        render();
        vscode.postMessage({ type: 'notes' });
      }
    } else if (m.type === 'preview') {
      preview.receive(m);
    } else if (m.type === 'notesStart') {
      notesBusy = true;
    } else if (m.type === 'notesText') {
      notesText = m.text;
      const el = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('notesText'));
      if (el) el.value = m.text;
      else render();
    } else if (m.type === 'notesDone') {
      notesBusy = false;
      if (typeof m.text === 'string') notesText = m.text;
      render();
    } else if (m.type === 'loading') {
      page.innerHTML = `${header(m.from, m.to)}${loadingHtml('Comparing…')}`;
    } else if (m.type === 'error') {
      page.innerHTML = `<div class="gl-empty error">${icon('warning')}<b>Could not compare</b><span>${esc(m.message)}</span><button data-act="refresh">${icon('refresh')}Retry</button></div>`;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
