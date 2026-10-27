// @ts-check
(function () {
  const { esc, icon, listDate, displayName, loadingHtml } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { markdown } = window.gitlandRich;
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));
  /** @type {any} */
  let init = null;
  const open = new Set();
  const patches = new Map();
  const selected = /** @type {string[]} */ ([]);
  let explainText = '';
  let explaining = false;

  /** Commit body without trailers (Co-Authored-By, Signed-off-by…). */
  const clean = (t) => String(t || '').replace(/^(?:[\w-]+-by|Related work items): .*$/gim, '').trim();


  function chips(e) {
    const L = init.links;
    if (!L) return '';
    const text = `${e.subject}\n${e.body}`;
    const out = [];
    const seen = new Set();
    for (const m of text.matchAll(/\b(?:Merged PR|Merge pull request|pull request) #?(\d+)/gi)) if (!seen.has('p' + m[1])) seen.add('p' + m[1]), out.push(`<span class="hchip pr" data-url="${esc(L.pr.replace('{id}', m[1]))}">${icon('git-pull-request')}${m[1]}</span>`);
    if (L.ticketKeys) {
      const alt = Object.keys(L.ticketKeys).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      for (const m of text.matchAll(new RegExp(`(?<![\\w/-])(${alt || '(?!)'})-\\d+\\b`, 'g'))) if (!seen.has('t' + m[0])) seen.add('t' + m[0]), out.push(`<span class="hchip tk" data-url="${esc(`${L.ticketKeys[m[1]]}/browse/${m[0]}`)}">${icon('issues')}${esc(m[0])}</span>`);
      return out.join('');
    }
    for (const m of text.matchAll(/(?:^|[\s(\[,;])(?:AB)?#(\d+)\b/g)) if (!seen.has('p' + m[1]) && !seen.has('t' + m[1])) seen.add('t' + m[1]), out.push(`<span class="hchip tk" data-url="${esc(L.ticket.replace('{id}', m[1]))}">${icon('issues')}${m[1]}</span>`);
    return out.join('');
  }

  /** Unified diff → colored lines (headers hidden, hunks kept). */
  function diffHtml(patch) {
    if (!patch) return '<div class="none">No textual change (binary or rename only).</div>';
    const lines = patch.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |similarity index|rename (from|to)|new file mode|deleted file mode)/.test(l));
    return `<pre class="diff">${lines
      .map((l) => {
        const cls = l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : 'c';
        return `<span class="${cls}">${esc(l) || ' '}</span>`;
      })
      .join('')}</pre>`;
  }

  function render() {
    const lines = !!init.range;
    const title = lines ? `${init.rel}:${init.range.start}${init.range.end !== init.range.start ? `–${init.range.end}` : ''}` : init.rel;
    const authors = new Set(init.entries.map((e) => e.author)).size;
    page.innerHTML = `
<header class="t-head">
  <div class="t-title">
    <div class="t-kind"><span class="glyph big g-story">${icon(lines ? 'list-selection' : 'history')}</span><span>${lines ? 'Line history' : 'File history'}</span><span class="k">${init.entries.length} commit${init.entries.length === 1 ? '' : 's'} · ${authors} author${authors === 1 ? '' : 's'}</span></div>
    <h1 class="mono">${esc(title)}</h1>
  </div>
</header>
<div class="t-actions">
  <button class="gen-btn" data-act="explain">${icon(explaining ? 'debug-stop' : 'sparkle')}${explaining ? 'Stop' : lines ? 'Why are these lines like this?' : 'Explain this file’s history'}</button>
  <button data-act="compare"${selected.length === 2 ? '' : ' disabled'} title="Tick two versions to compare them">${icon('git-compare')}Compare selected${selected.length ? ` (${selected.length}/2)` : ''}</button>
</div>
<section id="explain" class="explain"${explainText || explaining ? '' : ' hidden'}><div class="ex-h">${icon('sparkle')} Explanation</div><div class="rich" id="explainBody">${explainText ? markdown(explainText) : '<span class="gl-skel"></span>'}</div></section>
<div class="tl">${init.entries
      .map((e, i) => {
        const av = (init.avatars || {})[String(e.email).toLowerCase()];
        const isOpen = open.has(e.sha);
        const body = isOpen ? (lines ? diffHtml(e.patch) : patches.has(e.sha) ? diffHtml(patches.get(e.sha)) : '<span class="gl-skel"></span>') : '';
        return `<div class="tl-row${isOpen ? ' open' : ''}" data-sha="${esc(e.sha)}" data-path="${esc(e.path)}">
  <div class="tl-rail"><span class="dot"></span></div>
  <div class="tl-main">
    <div class="tl-head" data-toggle="1">
      <input type="checkbox" data-pick="${esc(e.sha)}"${selected.includes(e.sha) ? ' checked' : ''} title="Select to compare">
      ${av ? `<img class="av" src="${esc(av)}" alt="">` : '<span class="av"></span>'}
      <span class="s">${esc(e.subject)}</span>${chips(e)}
      <span class="grow"></span>
      ${e.added !== undefined ? `<span class="delta">${e.added ? `<span class="plus">+${e.added}</span>` : ''}${e.deleted ? `<span class="minus">−${e.deleted}</span>` : ''}</span>` : ''}
      <span class="a" title="${esc(e.author)}">${esc(displayName(e.author))}</span>${listDate(e.date)}<span class="sha">${esc(e.sha.slice(0, 7))}</span>
      <span class="acts">
        <button class="icon" data-do="diffPrevious" title="Diff with the previous version">${icon('diff')}</button>
        <button class="icon" data-do="diffWorking" title="Diff with the working tree">${icon('file')}</button>
        <button class="icon" data-do="openAt" title="Open the file at this version">${icon('go-to-file')}</button>
        <button class="icon" data-do="showCommit" title="Show in the Commit Graph">${icon('git-commit')}</button>
      </span>
      ${icon(isOpen ? 'chevron-down' : 'chevron-right')}
    </div>
    ${e.path !== init.rel ? `<div class="renamed">${icon('arrow-right')} was <span class="mono">${esc(e.path)}</span></div>` : ''}
    ${isOpen ? `<div class="tl-body">${clean(e.body) ? `<div class="rich msg">${markdown(clean(e.body))}</div>` : ''}${body}</div>` : ''}
  </div>
</div>`;
      })
      .join('')}</div>`;
  }

  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest('input[data-pick]')) return;
    const url = /** @type {HTMLElement | null} */ (t.closest('[data-url]'));
    if (url) return vscode.postMessage({ type: 'openUrl', url: url.dataset.url });
    const row = /** @type {HTMLElement | null} */ (t.closest('.tl-row'));
    const doBtn = /** @type {HTMLElement | null} */ (t.closest('[data-do]'));
    if (doBtn && row) return vscode.postMessage({ type: doBtn.dataset.do, sha: row.dataset.sha, path: row.dataset.path });
    const act = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
    if (act) {
      if (act.dataset.act === 'explain') {
        if (explaining) return vscode.postMessage({ type: 'stopExplain' });
        explaining = true;
        explainText = '';
        render();
        return vscode.postMessage({ type: 'explain' });
      }
      if (act.dataset.act === 'compare' && selected.length === 2) {
        const get = (sha) => ({ sha, path: init.entries.find((x) => x.sha === sha).path });
        return vscode.postMessage({ type: 'compare', a: get(selected[0]), b: get(selected[1]) });
      }
      return;
    }
    if (row && t.closest('[data-toggle]')) {
      const sha = /** @type {string} */ (row.dataset.sha);
      if (open.has(sha)) {
        open.delete(sha);
      } else {
        open.add(sha);
        if (!init.range && !patches.has(sha)) vscode.postMessage({ type: 'patch', sha, path: row.dataset.path });
      }
      render();
    }
  });
  page.addEventListener('change', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (!t.dataset.pick) return;
    const i = selected.indexOf(t.dataset.pick);
    if (t.checked && i < 0) selected.push(t.dataset.pick);
    if (!t.checked && i >= 0) selected.splice(i, 1);
    while (selected.length > 2) selected.shift();
    render();
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
      init = m;
      if (!m.entries.length) {
        page.innerHTML = `<div class="gl-empty">${icon('history')}<b>No history</b><span>${esc(m.rel)} has no commit yet.</span></div>`;
        return;
      }
      if (m.entries[0]) {
        open.add(m.entries[0].sha);
        if (!m.range) vscode.postMessage({ type: 'patch', sha: m.entries[0].sha, path: m.entries[0].path });
      }
      render();
      if (m.autoExplain) {
        explaining = true;
        render();
        vscode.postMessage({ type: 'explain' });
      }
    } else if (m.type === 'patch') {
      patches.set(m.sha, m.patch);
      render();
    } else if (m.type === 'explainStart') {
      explaining = true;
    } else if (m.type === 'explainText') {
      explainText = m.text;
      const el = document.getElementById('explainBody');
      if (el) el.innerHTML = markdown(explainText);
      const box = document.getElementById('explain');
      if (box) box.hidden = false;
    } else if (m.type === 'explainDone') {
      explaining = false;
      if (typeof m.text === 'string') explainText = m.text;
      render();
    }
  });
  page.innerHTML = loadingHtml('Loading history…');
  vscode.postMessage({ type: 'ready' });
})();
