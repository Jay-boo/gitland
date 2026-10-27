// @ts-check
// Release page: one tag, like a release on the web (src/views/releasePanel.ts).
(function () {
  const { esc, icon, relTime, fullDate, listDate, displayName, loadingHtml } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));
  // Rich text: media/md.js
  // @ts-ignore
  const { markdown } = window.gitlandRich;

  /** Commits shown before "Show all". */
  const FIRST = 12;
  let showAll = false;
  let data = /** @type {any} */ (null);

  function render(m) {
    const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
    const notes = m.notes
      ? `<div class="rich">${markdown(m.notes.text)}</div><div class="r-src">${icon('book')}From ${esc(m.notes.source)}</div>`
      : m.message
        ? `<div class="rich">${markdown(m.message)}</div><div class="r-src">${icon('tag')}Tag message</div>`
        : `<div class="none">No notes: ${m.annotated ? 'the tag has no message' : 'a lightweight tag'} and no CHANGELOG section for ${esc(m.tag)}.</div>`;
    const prs = m.prs.length
      ? m.prs.map((p) => `<div class="pr-row" data-url="${esc(p.url)}" title="Open pull request ${esc(p.id)}">${icon('git-pull-request')}<span class="id">${esc(p.id)}</span><span class="s">${esc(p.title)}</span></div>`).join('')
      : '<div class="none">No pull request merged in this release.</div>';
    const list = showAll ? m.commits : m.commits.slice(0, FIRST);
    const commits = m.commits.length
      ? list.map((c) => `<div class="commit-row" data-sha="${esc(c.sha)}" title="${esc(c.subject)}\n${esc(c.author)}\nShow in the Commit Graph"><span class="sha">${esc(c.short)}</span><span class="s">${esc(c.subject)}</span><span class="who">${esc(displayName(c.author))}</span>${listDate(c.date)}</div>`).join('') +
        (m.commits.length > list.length ? `<button class="ghost more" data-act="all">${icon('chevron-down')}Show all ${m.commits.length}</button>` : '')
      : '<div class="none">No commit since the previous release.</div>';
    const side = [
      `<section><h3>Details</h3><dl>
        <dt>Commit</dt><dd><span class="link" data-sha="${esc(m.sha)}" title="Show in the Commit Graph">${icon('git-commit')} ${esc(m.short)}</span></dd>
        <dt>${m.annotated ? 'Tagged' : 'Committed'}</dt><dd title="${esc(fullDate(m.date))}">${esc(relTime(m.date))}${m.tagger ? ` by ${esc(m.tagger)}` : ''}</dd>
        <dt>Changes</dt><dd><span class="link" data-act="compare" title="Compare with the previous release">${n(m.files.count, 'file', 'files')}</span> <span class="add">+${m.files.added}</span> <span class="del">−${m.files.deleted}</span></dd>
      </dl></section>`,
      `<section><h3>Releases</h3>
        ${m.next ? `<div class="link-row" data-release="${esc(m.next)}" title="Newer release">${icon('arrow-up')}<span>${esc(m.next)}</span><span class="k">newer</span></div>` : ''}
        <div class="link-row on">${icon('tag')}<span>${esc(m.tag)}</span><span class="k">this one</span></div>
        ${m.previous ? `<div class="link-row" data-release="${esc(m.previous)}" title="Previous release">${icon('arrow-down')}<span>${esc(m.previous)}</span><span class="k">previous</span></div>` : '<div class="none">First release.</div>'}
      </section>`,
      `<section><h3>Contributors <span class="n">${m.contributors.length}</span></h3>${
        m.contributors.length
          ? m.contributors.map((p) => `<div class="r-person" title="${esc(p.email)}">${p.avatar ? `<img class="av" src="${esc(p.avatar)}" alt="">` : icon('account')}<span class="s">${esc(displayName(p.name))}</span><span class="k">${n(p.count, 'commit', 'commits')}</span></div>`).join('')
          : '<div class="none">Nobody.</div>'
      }</section>`,
    ];
    page.innerHTML = `
<header class="t-head">
  <div class="t-title">
    <div class="t-kind"><span class="glyph big g-release">${icon('tag')}</span><span>Release</span>${m.annotated ? '' : '<span class="k">lightweight tag</span>'}<span class="k" title="${esc(fullDate(m.date))}">${esc(relTime(m.date))}</span>${m.previous ? `<span class="k">since ${esc(m.previous)}</span>` : ''}</div>
    <h1>${esc(m.tag)}${m.annotated && m.message && m.message.split('\n')[0] !== m.tag ? ` <span class="r-sub">${esc(m.message.split('\n')[0])}</span>` : ''}</h1>
  </div>
</header>
<div class="t-actions">
  <button class="primary" data-act="compare" title="Files and commits since ${esc(m.previous || 'the first commit')}">${icon('git-compare')}Compare with ${esc(m.previous || 'the first commit')}</button>
  ${m.remote ? `<button data-act="openRemote" title="Open the release on ${esc(m.remoteName || 'the remote')}">${icon('link-external')}Open on ${esc(m.remoteName || 'the remote')}</button>` : ''}
  <button data-act="notes" class="gen-btn" title="Write release notes with AI">${icon('sparkle')}Release notes</button>
  <button data-act="copy" title="Copy the tag name">${icon('copy')}${esc(m.tag)}</button>
  <button data-act="checkout" title="Checkout this release (detached HEAD)">${icon('target')}Checkout</button>
  <span class="grow"></span>
  <button class="icon" data-act="refresh" title="Refresh">${icon('refresh')}</button>
</div>
<div class="t-grid"><div class="t-main">
  <section><h3>Notes</h3>${notes}</section>
  <section><h3>Pull requests <span class="n">${m.prs.length}</span></h3>${prs}</section>
  <section><h3>Commits <span class="n">${m.commits.length}</span></h3>${commits}</section>
</div><aside class="t-side">${side.join('')}</aside></div>`;
  }

  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const el = /** @type {HTMLElement | null} */ (t.closest('[data-act],[data-url],[data-sha],[data-release]'));
    if (!el) return;
    if (el.dataset.act === 'all') {
      showAll = true;
      return render(data);
    }
    if (el.dataset.act) return vscode.postMessage({ type: el.dataset.act });
    if (el.dataset.url) return vscode.postMessage({ type: 'openUrl', url: el.dataset.url });
    if (el.dataset.sha) return vscode.postMessage({ type: 'showCommit', sha: el.dataset.sha });
    if (el.dataset.release) return vscode.postMessage({ type: 'showRelease', tag: el.dataset.release });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'release') {
      data = m;
      render(m);
    } else if (m.type === 'loading' && !page.firstChild) page.innerHTML = loadingHtml('Loading the release…');
    else if (m.type === 'error') page.innerHTML = `<div class="gl-empty error">${icon('warning')}<b>Could not load the release</b><span>${esc(m.message)}</span><button data-act="refresh">${icon('refresh')}Retry</button></div>`;
  });
  vscode.postMessage({ type: 'ready' });
})();
