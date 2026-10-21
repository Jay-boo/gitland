// @ts-check
(function () {
  const { esc, icon, relShort } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { markdown } = window.gitlandRich;
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));
  /** @type {any} */
  let init = null;
  /** @type {any} */
  let info = null;
  let tab = 'write';
  let generating = false;
  let edited = false; // the user typed in the description: don't replace it with the template

  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));


  function renderPage() {
    page.innerHTML = `
<header class="t-head">
  <span class="glyph big g-waiting">${icon('git-pull-request-create')}</span>
  <div class="t-title">
    <div class="t-kind"><span>New pull request</span></div>
    <div class="branches"><span class="src">${icon('git-branch')} ${esc(init.source)}</span>${icon('arrow-right')}
      <select id="target">${init.targets.map((t) => `<option value="${esc(t)}"${info && t === info.target ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
  </div>
</header>
<div class="t-grid">
  <div class="t-main">
    <input id="title" class="pr-title" placeholder="Title" spellcheck="true" />
    <div class="ed-bar">
      <span class="tab${tab === 'write' ? ' on' : ''}" data-tab="write">${icon('edit')}Write</span>
      <span class="tab${tab === 'preview' ? ' on' : ''}" data-tab="preview">${icon('eye')}Preview</span>
      <span class="grow"></span>
      <span id="tpl" class="tpl"></span>
      <button id="btnReset" class="ghost" title="Start again from the template">${icon('discard')}Template</button>
      <button id="btnGen" class="gen-btn" title="Write the title and description from the commits and the diff (AI), following the repository's template">${icon('sparkle')}<span>Generate</span></button>
    </div>
    <div class="ed-wrap">
      <textarea id="desc" spellcheck="true" placeholder="Description (markdown)"></textarea>
      <div id="preview" class="rich preview" hidden></div>
    </div>
  </div>
  <aside class="t-side">
    <section id="ticketBox"></section>
    <section><h3>Options</h3>
      <label class="switch"><input id="draft" type="checkbox"${init.draft ? ' checked' : ''}><span class="track"><span class="knob"></span></span><span>Create as draft</span></label>
    </section>
    <section id="summary"></section>
  </aside>
</div>
<div class="create-bar">
  <span id="pushInfo" class="k"></span>
  <span class="grow"></span>
  <button id="btnCreate" class="primary big">${icon('git-pull-request-create')}<span id="createLabel">Create pull request</span></button>
</div>`;
    $('target').addEventListener('change', () => vscode.postMessage({ type: 'target', target: $('target').value }));
    $('title').addEventListener('input', updateCreate);
    $('desc').addEventListener('input', () => {
      edited = true;
      autosize();
    });
    $('draft').addEventListener('change', updateCreate);
    $('btnGen').addEventListener('click', () => vscode.postMessage(generating ? { type: 'stopGenerate' } : { type: 'generate', target: $('target').value }));
    $('btnReset').addEventListener('click', () => {
      $('desc').value = info && info.template ? info.template.text : '';
      edited = false;
      autosize();
    });
    $('btnCreate').addEventListener('click', create);
    page.querySelectorAll('[data-tab]').forEach((t) =>
      t.addEventListener('click', () => {
        tab = /** @type {HTMLElement} */ (t).dataset.tab || 'write';
        page.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === t));
        $('preview').hidden = tab !== 'preview';
        $('desc').hidden = tab === 'preview';
        if (tab === 'preview') $('preview').innerHTML = markdown($('desc').value || '_Nothing yet._');
      }),
    );
  }

  function applyInfo(first) {
    if (!info) return;
    const title = $('title');
    if (first || !title.value.trim()) title.value = info.defaultTitle || '';
    if (!edited) {
      $('desc').value = info.template ? info.template.text : info.commits.map((c) => `- ${c.subject}`).join('\n');
    }
    $('tpl').innerHTML = info.template ? `${icon('file-code')}<span title="Pull request template of the repository">${esc(info.template.path)}</span>` : '<span class="muted">no template in the repo</span>';
    const ts = info.tickets || [];
    const fromCommits = ts.filter((t) => t.from === 'commits').length;
    $('ticketBox').innerHTML = `<h3>Linked ${esc(init.noun)}s${ts.length ? ` <span class="n">${ts.length}</span>` : ''}</h3>${
      ts.length
        ? ts
            .map(
              (t) =>
                `<label class="switch" title="${esc(t.from === 'commits' ? `Mentioned in the commits to merge into ${info.target}` : 'Ticket of the branch')}"><input class="link-ticket" data-id="${esc(t.id)}" type="checkbox" checked><span class="track"><span class="knob"></span></span><span class="tk"><b>${esc(t.prefix)}${esc(t.id)}</b> ${esc(t.title || '')}</span></label>`,
            )
            .join('') + (fromCommits ? `<div class="none">${fromCommits} found in the commits to merge</div>` : '')
        : `<div class="none">None: start work from a ticket to link it.</div>`
    }`;
    $('summary').innerHTML = `<h3>Changes <span class="n">${info.commits.length} commit${info.commits.length === 1 ? '' : 's'}</span></h3>
      <div class="stats"><span>${info.files} file${info.files === 1 ? '' : 's'}</span>${info.added ? `<span class="plus">+${info.added}</span>` : ''}${info.deleted ? `<span class="minus">−${info.deleted}</span>` : ''}</div>
      ${info.commits.slice(0, 30).map((c) => `<div class="commit-row" title="${esc(c.subject)}"><span class="sha">${esc(c.sha.slice(0, 7))}</span><span class="s">${esc(c.subject)}</span><span class="k">${esc(relShort(c.date))}</span></div>`).join('')}
      ${info.commits.length ? '' : `<div class="none">No commit ahead of ${esc(info.target)}.</div>`}`;
    $('pushInfo').innerHTML = info.needsPush ? `${icon('cloud-upload')} ${esc(init.source)} will be pushed first` : `${icon('check')} ${esc(init.source)} is pushed`;
    autosize();
    updateCreate();
  }

  function autosize() {
    const d = $('desc');
    d.style.height = 'auto';
    d.style.height = `${Math.max(260, d.scrollHeight + 2)}px`;
  }

  function updateCreate() {
    const ok = !!$('title').value.trim() && info && info.commits.length > 0 && !generating;
    $('btnCreate').disabled = !ok;
    $('createLabel').textContent = $('draft').checked ? 'Create draft pull request' : 'Create pull request';
  }

  function create() {
    if ($('btnCreate').disabled) return;
    vscode.postMessage({
      type: 'create',
      target: $('target').value,
      title: $('title').value,
      description: $('desc').value,
      draft: $('draft').checked,
      ticketIds: [...page.querySelectorAll('.link-ticket')].filter((c) => c.checked).map((c) => c.dataset.id),
    });
  }

  function setGenerating(on) {
    generating = on;
    const b = $('btnGen');
    b.classList.toggle('on', on);
    b.innerHTML = on ? `${icon('debug-stop')}<span>Stop</span>` : `${icon('sparkle')}<span>Generate</span>`;
    $('desc').readOnly = on;
    $('title').readOnly = on;
    document.body.classList.toggle('is-generating', on);
    updateCreate();
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') create();
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
      init = m;
      info = m.info;
      renderPage();
      applyInfo(true);
    } else if (m.type === 'info') {
      info = m.info;
      applyInfo(false);
    } else if (m.type === 'genStart') {
      setGenerating(true);
    } else if (m.type === 'genText') {
      if (m.title) $('title').value = m.title;
      $('desc').value = m.description || '';
      edited = true;
      autosize();
    } else if (m.type === 'genDone') {
      setGenerating(false);
      if (m.title) $('title').value = m.title;
      if (typeof m.description === 'string' && m.description.trim()) $('desc').value = m.description.trim() + '\n';
      if (tab === 'preview') $('preview').innerHTML = markdown($('desc').value);
      autosize();
      updateCreate();
    } else if (m.type === 'creating') {
      $('btnCreate').disabled = m.on;
      $('createLabel').textContent = m.on ? 'Creating…' : 'Create pull request';
    }
  });
  page.innerHTML = '<div class="skeleton"><div></div><div></div><div></div></div>';
  vscode.postMessage({ type: 'ready' });
})();
