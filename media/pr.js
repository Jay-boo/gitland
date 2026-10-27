// @ts-check
(function () {
  const { esc, icon, relTime, listDate, loadingHtml } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { markdown } = window.gitlandRich;
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));


  const REVIEW = {
    draft: ['draft', 'git-pull-request-draft', 'draft'],
    approved: ['approved', 'pass', 'approved'],
    changes: ['changes', 'request-changes', 'changes requested'],
    waiting: ['waiting', 'git-pull-request', 'in review'],
  };
  const VOTE = {
    approved: ['approved', 'pass-filled', 'approved'],
    suggestions: ['approved', 'pass', 'approved with suggestions'],
    waiting: ['changes', 'watch', 'waiting for author'],
    rejected: ['changes', 'error', 'rejected'],
    none: ['draft', 'circle-large-outline', 'no vote yet'],
  };

  const CHECK = { succeeded: ['approved', 'pass-filled'], partial: ['task', 'warning'], failed: ['changes', 'error'], canceled: ['draft', 'circle-slash'], running: ['waiting', 'sync codicon-modifier-spin'], queued: ['draft', 'clock'] };
  let checks = /** @type {any[] | null} */ (null);
  let last = /** @type {any} */ (null);

  function checksHtml() {
    if (!checks) return '<div class="none">loading…</div>';
    if (!checks.length) return '<div class="none">No pipeline run for this pull request.</div>';
    // Latest run per pipeline.
    const seen = new Set();
    return checks
      .filter((r) => !seen.has(r.name) && seen.add(r.name))
      .map((r) => {
        const [cls, ic] = CHECK[r.state] || CHECK.queued;
        return `<div class="link-row check" data-url="${esc(r.url)}" title="${esc(r.name)}: ${r.state}"><span class="glyph small g-${cls}">${icon(ic)}</span><span>${esc(r.name)}</span><span class="k">${esc(r.state)}</span></div>`;
      })
      .join('');
  }

  function threadHtml(t, can) {
    const resolved = t.status && !/^(active|pending)$/i.test(t.status);
    return `<div class="comment thread${resolved ? ' resolved' : ''}" data-thread="${esc(t.id)}">
  ${t.file ? `<div class="th-file">${icon('file')} ${esc(t.file.replace(/^\//, ''))}${t.line ? `:${t.line}` : ''}</div>` : ''}
  ${t.comments.map((c, i) => `<div class="${i ? 'reply' : ''}"><div class="ch"><b>${esc(c.author)}</b><span>${esc(relTime(c.date))}</span>${i === 0 && t.status ? `<span class="pill ${resolved ? 'p-done' : 'p-active'}">${esc(t.status)}</span>` : ''}</div><div class="rich">${markdown(c.body)}</div></div>`).join('')}
  <div class="th-acts">
    ${can.comment ? `<span class="link" data-reply="${esc(t.id)}">${icon('reply')}Reply</span>` : ''}
    ${can.resolve ? `<span class="link" data-resolve="${esc(t.id)}" data-to="${resolved ? '0' : '1'}">${icon(resolved ? 'debug-restart' : 'check')}${resolved ? 'Reactivate' : 'Resolve'}</span>` : ''}
  </div>
  <div class="reply-box" hidden><textarea rows="3" placeholder="Reply (markdown)"></textarea><div class="rb-bar"><span class="grow"></span><button data-cancel>Cancel</button><button class="primary" data-send="${esc(t.id)}">${icon('send')}Reply</button></div></div>
</div>`;
  }

  function reviewHtml(d, can) {
    if (!can.vote || /completed|merged|abandoned|closed/.test(d.status)) return '';
    const votes = can.kind === 'github'
      ? [['approve', 'pass-filled', 'Approve', 'approved'], ['reject', 'request-changes', 'Request changes', 'changes']]
      : can.kind === 'gitlab'
      ? [['approve', 'pass-filled', 'Approve', 'approved'], ['reset', 'circle-large-outline', 'Revoke approval', 'draft']]
      : [['approve', 'pass-filled', 'Approve', 'approved'], ['suggestions', 'pass', 'Approve with suggestions', 'approved'], ['wait', 'watch', 'Wait for author', 'changes'], ['reject', 'error', 'Reject', 'changes'], ['reset', 'circle-large-outline', 'Reset', 'draft']];
    const mine = d.myVote && d.myVote !== 'none' ? `your vote: <b>${esc(d.myVote)}</b>` : d.amReviewer ? 'waiting for your review' : 'you are not a reviewer';
    const ask = !d.amReviewer && d.pr.group !== 'mine' && can.requestReview
      ? `<button data-act="requestReview" title="Add me as a reviewer: the pull request moves to &quot;to review&quot;">${icon('person-add')}<span>Add me as reviewer</span></button>`
      : '';
    return `<div class="review-bar"><span class="k">${mine}</span>${ask}<span class="grow"></span>${votes
      .map(([v, ic, label, cls]) => `<button class="vote v-${cls}${d.myVote === ({ approve: 'approved', suggestions: 'suggestions', wait: 'waiting', reject: 'rejected', reset: 'none' })[v] ? ' on' : ''}" data-vote="${v}" title="${label}">${icon(ic)}<span>${label}</span></button>`)
      .join('')}</div>`;
  }

  function render(m) {
    last = m;
    const d = m.details;
    const p = d.pr;
    const done = /completed|merged/.test(d.status);
    const closed = /abandoned|closed/.test(d.status);
    const r = done ? ['approved', 'git-merge', 'merged'] : closed ? ['draft', 'circle-slash', d.status] : REVIEW[p.isDraft ? 'draft' : p.review || 'waiting'];
    const onBranch = m.current === p.sourceBranch;
    const conflicts = /conflict|dirty/i.test(d.mergeStatus || '');
    const side = [];
    side.unshift(`<section><h3>Checks</h3><div id="checks">${checksHtml()}</div></section>`);
    side.push(`<section><h3>Reviewers</h3>${
      d.reviewers.length
        ? d.reviewers
            .map((x) => {
              const v = VOTE[x.vote] || VOTE.none;
              return `<div class="rev"><span class="glyph small g-${v[0]}">${icon(v[1])}</span><span class="nm">${esc(x.name)}${x.required ? '<span class="req"> · required</span>' : ''}</span><span class="k">${v[2]}</span></div>`;
            })
            .join('')
        : '<div class="none">No reviewers.</div>'
    }</section>`);
    if (d.workItems.length) {
      side.push(`<section><h3>Work items</h3>${d.workItems.map((w) => `<div class="link-row" data-ticket="${esc(w.id)}" title="See the ticket">${icon('issues')}<span>${esc(m.prefix)}${esc(w.id)}</span></div>`).join('')}</section>`);
    }
    side.push(`<section><h3>Details</h3><dl>
      <dt>Author</dt><dd>${icon('account')} ${esc(p.author)}</dd>
      ${p.created ? `<dt>Opened</dt><dd>${esc(relTime(p.created))}</dd>` : ''}
      <dt>Status</dt><dd>${esc(d.status)}${d.mergeStatus ? ` · ${esc(d.mergeStatus)}` : ''}</dd>
    </dl></section>`);
    side.push(`<section><h3>Commits <span class="n">${d.commits.length}</span></h3>${
      d.commits.length
        ? d.commits
            .map((c) => `<div class="commit-row" data-sha="${esc(c.sha)}" title="${esc(c.subject)}\n${esc(c.author)}\nShow in the Commit Graph"><span class="sha">${esc(c.sha.slice(0, 7))}</span><span class="s">${esc(c.subject)}</span>${listDate(c.date)}</div>`)
            .join('')
        : '<div class="none">No commits.</div>'
    }</section>`);
    const can = m.can || {};
    const threads = d.threads || d.comments.map((c, i) => ({ id: String(i), comments: [c], file: c.file }));
    const discussion =
      (threads.length ? threads.map((t) => threadHtml(t, can)).join('') : '<div class="none">No comments yet.</div>') +
      (can.comment ? `<div class="new-comment"><textarea id="newComment" rows="3" placeholder="Write a comment (markdown)"></textarea><div class="rb-bar"><span class="grow"></span><button class="primary" data-send="">${icon('comment')}Comment</button></div></div>` : '');
    const comments = d.comments.length
      ? d.comments
          .map((c) => `<div class="comment"><div class="ch"><b>${esc(c.author)}</b><span>${esc(relTime(c.date))}</span>${c.file ? `<span class="file">${icon('file')} ${esc(c.file.replace(/^\//, ''))}</span>` : ''}</div><div class="rich">${markdown(c.body)}</div></div>`)
          .join('')
      : '<div class="none">No comments.</div>';
    page.innerHTML = `
<header class="t-head">
  <div class="t-title">
    <div class="t-kind"><span class="glyph big g-${r[0]}">${icon(r[1])}</span><span class="id">${esc(p.label)}</span><span class="pill p-${r[0]}">${esc(r[2])}</span>${conflicts ? `<span class="pill p-changes">${icon('warning')} conflicts</span>` : ''}<span class="br">${icon('git-branch')} ${esc(p.sourceBranch)} ${icon('arrow-right')} ${esc(p.targetBranch)}</span></div>
    <h1>${esc(p.title)}</h1>
  </div>
</header>
<div class="t-actions">
  ${onBranch ? `<span class="cur-chip big">${icon('git-branch')} you are on this branch</span>` : `<button class="primary" data-act="checkout">${icon('git-branch')}Checkout</button>`}
  <button data-act="files">${icon('diff-multiple')}Files changed</button>
  ${can.update && p.isDraft && /active/.test(d.status) ? `<button data-act="publish">${icon('rocket')}Publish</button>` : ''}
  ${can.update && /active|open/.test(d.status) && !p.isDraft ? `<button class="complete-btn" data-act="complete"${conflicts ? ' disabled title="Resolve the conflicts first"' : ''}>${icon('git-merge')}Complete…</button>` : ''}
  <button data-act="open">${icon('link-external')}Open in the browser</button>
  <button data-act="copy">${icon('copy')}Copy link</button>
  <span class="grow"></span>
  ${can.update && /active|open/.test(d.status) ? `<button class="icon" data-act="abandon" title="Abandon the pull request">${icon('circle-slash')}</button>` : ''}
  <button class="icon" data-act="refresh" title="Refresh">${icon('refresh')}</button>
</div>
${reviewHtml(d, can)}
<div class="t-grid">
  <div class="t-main">
    ${d.description ? `<section class="rich">${markdown(d.description)}</section>` : '<section class="rich none">No description.</section>'}
    <section><h3>Discussion <span class="n">${threads.length}</span></h3>${discussion}</section>
  </div>
  <aside class="t-side">${side.join('')}</aside>
</div>`;
  }

  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const vote = /** @type {HTMLElement | null} */ (t.closest('[data-vote]'));
    if (vote) return vscode.postMessage({ type: 'vote', vote: vote.dataset.vote });
    const reply = /** @type {HTMLElement | null} */ (t.closest('[data-reply]'));
    if (reply) {
      const box = /** @type {HTMLElement} */ (reply.closest('.thread')).querySelector('.reply-box');
      box.hidden = false;
      box.querySelector('textarea').focus();
      return;
    }
    if (t.closest('[data-cancel]')) {
      /** @type {HTMLElement} */ (t.closest('.reply-box')).hidden = true;
      return;
    }
    const send = /** @type {HTMLElement | null} */ (t.closest('[data-send]'));
    if (send) {
      const area = /** @type {HTMLTextAreaElement} */ ((send.closest('.reply-box, .new-comment')).querySelector('textarea'));
      if (!area.value.trim()) return area.focus();
      /** @type {HTMLButtonElement} */ (send).disabled = true;
      return vscode.postMessage({ type: 'comment', text: area.value, threadId: send.dataset.send || undefined });
    }
    const resolve = /** @type {HTMLElement | null} */ (t.closest('[data-resolve]'));
    if (resolve) return vscode.postMessage({ type: 'resolve', threadId: resolve.dataset.resolve, resolved: resolve.dataset.to === '1' });
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-act],[data-url],[data-sha],[data-ticket]'));
    if (!el) return;
    if (el.dataset.act) return vscode.postMessage({ type: el.dataset.act });
    if (el.dataset.url) return vscode.postMessage({ type: 'openUrl', url: el.dataset.url });
    if (el.dataset.sha) return vscode.postMessage({ type: 'showCommit', sha: el.dataset.sha });
    if (el.dataset.ticket) return vscode.postMessage({ type: 'showTicket', id: el.dataset.ticket });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'details') {
      checks = checks && last && last.details.pr.id === m.details.pr.id ? checks : null;
      render(m);
    } else if (m.type === 'checks') {
      checks = m.runs;
      const el = document.getElementById('checks');
      if (el) el.innerHTML = checksHtml();
    }
    else if (m.type === 'loading' && !page.firstChild) page.innerHTML = loadingHtml('Loading the pull request…');
    else if (m.type === 'error') page.innerHTML = `<div class="gl-empty error">${icon('warning')}<b>Could not load the pull request</b><span>${esc(m.message)}</span><button data-act="refresh">${icon('refresh')}Retry</button></div>`;
  });
  vscode.postMessage({ type: 'ready' });
})();
