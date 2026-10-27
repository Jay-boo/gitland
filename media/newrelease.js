// @ts-check
(function () {
  const { esc, icon, loadingHtml, listDate } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { markdown } = window.gitlandRich;
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  /** @type {any} */
  let init = null;
  let generating = false;
  let tab = 'write';

  function render() {
    const rec = init.options.find((o) => o.kind === init.bump) || init.options[0];
    page.innerHTML = `
<header class="t-head">
  <div class="t-title">
    <div class="t-kind"><span class="glyph big g-task">${icon('tag')}</span><span>New release</span><span class="k" title="${esc(init.target.subject)}">from ${esc(init.target.ref)} · <span class="mono">${esc(init.target.sha.slice(0, 7))}</span> · ${init.latest ? `latest ${esc(init.latest)}` : 'first release'}</span></div>
    <h1 id="relTitle">Release ${esc(rec.version)}</h1>
  </div>
</header>
<div class="t-grid">
  <div class="t-main">
    <div class="ver-row">
      <input id="version" class="pr-title ver-input" value="${esc(rec.version)}" spellcheck="false" />
      <div class="ver-chips">${init.options
        .map((o) => `<span class="type${o.version === rec.version ? ' on' : ''}" data-version="${esc(o.version)}" title="${o.kind}${o.kind === init.bump ? ' (suggested from the commits)' : ''}">${esc(o.version)} <em>${o.kind}</em></span>`)
        .join('')}</div>
    </div>
    <div class="ed-bar">
      <span class="tab${tab === 'write' ? ' on' : ''}" data-tab="write">${icon('edit')}Notes</span>
      <span class="tab${tab === 'preview' ? ' on' : ''}" data-tab="preview">${icon('eye')}Preview</span>
      <span class="grow"></span>
      <button id="btnGen" class="gen-btn" title="Write the release notes from the commits (AI), in the style of the CHANGELOG">${icon('sparkle')}<span>Generate</span></button>
    </div>
    <div class="ed-wrap">
      <textarea id="desc" spellcheck="true" placeholder="Release notes (markdown) — also the tag message"></textarea>
      <div id="preview" class="rich preview" hidden></div>
    </div>
  </div>
  <aside class="t-side">
    <section><h3>Options</h3>
      <label class="switch"><input id="push" type="checkbox" checked><span class="track"><span class="knob"></span></span><span>Push the tag</span></label>
      <div style="height:8px"></div>
      <label class="switch" title="Adds the notes to CHANGELOG.md, commits it (chore: release …), then tags that commit"><input id="changelog" type="checkbox"><span class="track"><span class="knob"></span></span><span>Add to CHANGELOG.md &amp; commit</span></label>
    </section>
    <section><h3>Since ${esc(init.latest || 'the start')} <span class="n">${init.commits.length}</span></h3>
      ${(init.log || init.commits.map((/** @type {string} */ s) => ({ subject: s })))
        .slice(0, 40)
        .map((/** @type {any} */ c) => `<div class="commit-row" title="${esc(c.subject)}">${c.sha ? `<span class="sha">${esc(c.sha.slice(0, 7))}</span>` : ''}<span class="s">${esc(c.subject)}</span>${c.date ? listDate(c.date) : ''}</div>`)
        .join('') || '<div class="none">No commit since the latest release.</div>'}
    </section>
  </aside>
</div>
<div class="create-bar"><span class="k">${icon('info')} Annotated tag on ${esc(init.target.sha.slice(0, 7))}, with the notes as its message</span><span class="grow"></span>
  <button id="btnCreate" class="primary big">${icon('tag')}<span id="createLabel"></span></button></div>`;
    $('version').addEventListener('input', update);
    page.querySelectorAll('[data-version]').forEach((c) =>
      c.addEventListener('click', () => {
        $('version').value = /** @type {HTMLElement} */ (c).dataset.version;
        update();
      }),
    );
    page.querySelectorAll('[data-tab]').forEach((t) =>
      t.addEventListener('click', () => {
        tab = /** @type {HTMLElement} */ (t).dataset.tab || 'write';
        page.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === t));
        $('preview').hidden = tab !== 'preview';
        $('desc').hidden = tab === 'preview';
        if (tab === 'preview') $('preview').innerHTML = markdown($('desc').value || '_No notes yet._');
      }),
    );
    $('btnGen').addEventListener('click', () => vscode.postMessage(generating ? { type: 'stopGenerate' } : { type: 'generate', version: $('version').value.trim() }));
    $('btnCreate').addEventListener('click', create);
    $('desc').addEventListener('input', autosize);
    update();
  }

  function autosize() {
    const d = $('desc');
    d.style.height = 'auto';
    d.style.height = `${Math.max(240, d.scrollHeight + 2)}px`;
  }

  function update() {
    const v = $('version').value.trim();
    page.querySelectorAll('[data-version]').forEach((c) => c.classList.toggle('on', /** @type {HTMLElement} */ (c).dataset.version === v));
    $('createLabel').textContent = v ? `Create release ${v}` : 'Create release';
    $('relTitle').textContent = v ? `Release ${v}` : 'New release';
    $('btnCreate').disabled = !v || generating;
  }

  function create() {
    if ($('btnCreate').disabled) return;
    vscode.postMessage({ type: 'create', version: $('version').value.trim(), notes: $('desc').value, push: $('push').checked, changelog: $('changelog').checked });
  }

  function setGenerating(on) {
    generating = on;
    const b = $('btnGen');
    b.classList.toggle('on', on);
    b.innerHTML = on ? `${icon('debug-stop')}<span>Stop</span>` : `${icon('sparkle')}<span>Generate</span>`;
    $('desc').readOnly = on;
    document.body.classList.toggle('is-generating', on);
    update();
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
      init = m;
      render();
    } else if (m.type === 'genStart') setGenerating(true);
    else if (m.type === 'genText') {
      $('desc').value = m.text;
      autosize();
    } else if (m.type === 'genDone') {
      setGenerating(false);
      if (typeof m.text === 'string' && m.text) $('desc').value = m.text;
      if (tab === 'preview') $('preview').innerHTML = markdown($('desc').value);
      autosize();
    } else if (m.type === 'creating') {
      $('btnCreate').disabled = m.on;
      $('createLabel').textContent = m.on ? 'Releasing…' : `Create release ${$('version').value.trim()}`;
    }
  });
  page.innerHTML = loadingHtml('Loading…');
  vscode.postMessage({ type: 'ready' });
})();
