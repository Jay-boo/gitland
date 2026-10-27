// @ts-check
(function () {
  const { esc, icon, relTime, listDate, loadingHtml, stateClass } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));


  function kind(type) {
    const t = String(type).toLowerCase();
    if (t.includes('bug')) return ['bug', 'bug'];
    if (t.includes('task')) return ['task', 'check'];
    if (t.includes('story') || t.includes('backlog') || t.includes('requirement')) return ['story', 'bookmark'];
    if (t.includes('feature')) return ['feature', 'star-empty'];
    if (t.includes('epic')) return ['epic', 'layers'];
    return ['issue', 'circle-large-outline'];
  }


  // Rich text: media/md.js
  // @ts-ignore
  const { sanitize, markdown } = window.gitlandRich;

  const rich = (format, body) => (format === 'html' ? sanitize(body) : markdown(body));

  // ---------- page ----------

  function render(m) {
    const d = m.details;
    const t = d.ticket;
    const [cls, ic] = kind(t.type);
    const current = m.current && m.branches.includes(m.current);
    const ref = `${m.prefix}${t.id}`;
    const side = [];
    if (d.fields.length || t.assignee) {
      side.push(`<section><h3>Details</h3><dl>
        ${t.assignee ? `<dt>Assigned to</dt><dd>${icon('account')} ${esc(t.assignee)}</dd>` : ''}
        ${d.fields.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}
        ${t.project ? `<dt>Project</dt><dd>${esc(t.project)}</dd>` : ''}
      </dl></section>`);
    }
    if (d.tags.length) side.push(`<section><h3>Tags</h3><div class="tags">${d.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div></section>`);
    if (d.pullRequests.length) {
      side.push(`<section><h3>Pull requests</h3>${d.pullRequests.map((p) => `<div class="link-row" data-url="${esc(p.url)}">${icon('git-pull-request')}<span>PR ${esc(p.id)}</span>${icon('link-external')}</div>`).join('')}</section>`);
    }
    side.push(`<section><h3>In this repository</h3>
      ${m.branches.length ? m.branches.map((b) => `<div class="link-row${b === m.current ? ' on' : ''}" ${b === m.current ? '' : `data-checkout="${esc(b)}" title="Check out ${esc(b)}"`}>${icon('git-branch')}<span>${esc(b)}</span>${b === m.current ? '<span class="cur-chip">● current</span>' : ''}</div>`).join('') : ''}
      ${m.commits.length ? m.commits.map((c) => `<div class="commit-row" data-sha="${esc(c.sha)}" title="${esc(c.subject)}\nShow in the Commit Graph"><span class="sha">${esc(c.short)}</span><span class="s">${esc(c.subject)}</span>${listDate(c.date)}</div>`).join('') : ''}
      ${!m.branches.length && !m.commits.length ? `<div class="none">No branch or commit mentions ${esc(ref)} yet.</div>` : ''}
    </section>`);
    if (d.related.length) {
      side.push(`<section><h3>Related</h3>${d.related.map((r) => `<div class="link-row" data-ticket="${esc(r.id)}">${icon('link')}<span>${esc(r.kind)} #${esc(r.id)}</span></div>`).join('')}</section>`);
    }
    const body = [
      d.description ? `<section class="rich">${rich(d.format, d.description)}</section>` : `<section class="rich none">No description.</section>`,
      ...d.sections.map((s) => `<section><h3>${esc(s.title)}</h3><div class="rich">${rich(d.format, s.body)}</div></section>`),
      `<section><h3>Comments <span class="n">${d.comments.length}</span></h3>${
        d.comments.length
          ? d.comments.map((c) => `<div class="comment"><div class="ch"><b>${esc(c.author)}</b><span>${esc(relTime(c.date))}</span></div><div class="rich">${rich(d.format, c.body)}</div></div>`).join('')
          : '<div class="none">No comments.</div>'
      }${
        m.canComment
          ? `<div class="new-comment"><textarea id="newComment" rows="3" placeholder="Write a comment · Ctrl+Enter to send"></textarea><div class="rb-bar"><span class="grow"></span><button class="primary" data-send="1">${icon('comment')}Comment</button></div></div>`
          : ''
      }</section>`,
    ];
    page.innerHTML = `
<header class="t-head">
  <div class="t-title">
    <div class="t-kind"><span class="glyph big g-${cls}">${icon(ic)}</span><span>${esc(t.type)}</span><span class="id">#${esc(t.id)}</span><span class="pill p-${stateClass(t.state)}">${esc(t.state)}</span>${d.changed ? `<span class="k">updated ${esc(relTime(d.changed))}</span>` : ''}</div>
    <h1>${esc(t.title)}</h1>
  </div>
</header>
<div class="t-actions">
  ${current ? `<span class="cur-chip big">${icon('git-branch')} you are working on it</span>` : `<button class="primary" data-act="start">${icon('git-branch')}Start work</button>`}
  <button data-act="open">${icon('link-external')}Open in the browser</button>
  <button data-act="copy" title="Copy ${esc(ref)}">${icon('copy')}${esc(ref)}</button>
  ${m.states && m.states.length ? `<label class="state-pick" title="Change the state">${icon('circle-large-outline')}<select id="state">${(m.states.includes(t.state) ? m.states : [t.state, ...m.states]).map((x) => `<option${x === t.state ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>${icon('chevron-down')}</label>` : ''}
  ${m.canAssign ? `<button data-act="assign" title="Assign the ${esc(m.noun || 'ticket')} to you">${icon('person-add')}Assign to me</button>` : ''}
  <span class="grow"></span>
  <button class="icon" data-act="refresh" title="Refresh">${icon('refresh')}</button>
</div>
<div class="t-grid"><div class="t-main">${body.join('')}</div><aside class="t-side">${side.join('')}</aside></div>`;
  }

  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const el = /** @type {HTMLElement | null} */ (t.closest('[data-act],[data-url],[data-sha],[data-checkout],[data-ticket],[data-send]'));
    if (!el) return;
    if (el.dataset.act) return vscode.postMessage({ type: el.dataset.act });
    if (el.dataset.send) return sendComment();
    if (el.dataset.url) return vscode.postMessage({ type: 'openUrl', url: el.dataset.url });
    if (el.dataset.sha) return vscode.postMessage({ type: 'showCommit', sha: el.dataset.sha });
    if (el.dataset.checkout) return vscode.postMessage({ type: 'checkout', branch: el.dataset.checkout });
    if (el.dataset.ticket) return vscode.postMessage({ type: 'showTicket', id: el.dataset.ticket });
  });

  function sendComment() {
    const box = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('newComment'));
    if (!box || !box.value.trim()) return;
    vscode.postMessage({ type: 'comment', text: box.value });
    box.disabled = true;
  }
  page.addEventListener('change', (e) => {
    const t = /** @type {HTMLSelectElement} */ (e.target);
    if (t.id === 'state') vscode.postMessage({ type: 'setState', state: t.value });
  });
  page.addEventListener('keydown', (e) => {
    if (/** @type {HTMLElement} */ (e.target).id === 'newComment' && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      sendComment();
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'details') render(m);
    else if (m.type === 'loading' && !page.firstChild) page.innerHTML = loadingHtml('Loading the ticket…');
    else if (m.type === 'error') page.innerHTML = `<div class="gl-empty error">${icon('warning')}<b>Could not load the ticket</b><span>${esc(m.message)}</span><button data-act="refresh">${icon('refresh')}Retry</button></div>`;
  });
  vscode.postMessage({ type: 'ready' });
})();
