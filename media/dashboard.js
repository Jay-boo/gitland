// @ts-check
(function () {
  const { esc, icon, relShort } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const page = /** @type {HTMLElement} */ (document.getElementById('page'));
  /** @type {any} */
  let local = null;
  /** @type {any} */
  let remote = null;

  function kind(type) {
    const t = String(type).toLowerCase();
    if (t.includes('bug')) return ['bug', 'bug'];
    if (t.includes('task')) return ['task', 'check'];
    if (t.includes('story') || t.includes('backlog')) return ['story', 'bookmark'];
    if (t.includes('feature')) return ['feature', 'star-empty'];
    if (t.includes('epic')) return ['epic', 'layers'];
    return ['issue', 'circle-large-outline'];
  }
  const active = (s) => /(active|progress|doing|committed|review|open)/i.test(s);
  const CI = { succeeded: ['ok', 'pass-filled'], failed: ['bad', 'error'], partial: ['warn', 'warning'], running: ['run', 'sync codicon-modifier-spin'], queued: ['off', 'clock'], canceled: ['off', 'circle-slash'] };
  const ciHtml = (r) => (r ? `<span class="ci ci-${CI[r.state][0]}" data-url="${esc(r.url)}" title="${esc(r.name)}: ${r.state}">${icon(CI[r.state][1])}</span>` : '');
  const REV = { approved: ['approved', 'pass', 'approved'], changes: ['changes', 'request-changes', 'changes requested'], waiting: ['waiting', 'git-pull-request', 'in review'] };

  function card(title, ic, count, body, extra = '') {
    return `<section class="dcard"><h3>${icon(ic)}<span>${title}</span>${count !== undefined ? `<span class="n">${count}</span>` : ''}<span class="grow"></span>${extra}</h3>${body}</section>`;
  }

  function render() {
    if (!local) return;
    const b = local.branches;
    const notPushed = b.filter((x) => !x.upstream || x.gone || x.ahead > 0);
    const behind = b.filter((x) => x.behind > 0);
    const mergedB = b.filter((x) => x.merged && !x.current);
    const r = remote;
    const mine = r ? r.prs.filter((p) => p.group === 'mine') : [];
    const review = r ? r.prs.filter((p) => p.group === 'review' || p.needsMyReview) : [];
    const inProgress = r ? r.tickets.filter((t) => active(t.state)) : [];
    const todo = r ? r.tickets.filter((t) => !active(t.state)) : [];
    const failing = r ? r.prs.filter((p) => p.group === 'mine' && p.ci && p.ci.state === 'failed').length + Object.values(r.branchCi).filter((x) => x.state === 'failed').length : 0;
    const summary = [
      review.length && `<span class="sum warn">${icon('eye')}<b>${review.length}</b> PR${review.length > 1 ? 's' : ''} to review</span>`,
      failing && `<span class="sum bad">${icon('error')}<b>${failing}</b> CI failing</span>`,
      mine.filter((p) => p.review === 'changes').length && `<span class="sum bad">${icon('request-changes')}<b>${mine.filter((p) => p.review === 'changes').length}</b> PR with changes requested</span>`,
      notPushed.length && `<span class="sum">${icon('cloud-upload')}<b>${notPushed.length}</b> branch${notPushed.length > 1 ? 'es' : ''} not pushed</span>`,
      inProgress.length && `<span class="sum ok">${icon('issues')}<b>${inProgress.length}</b> ticket${inProgress.length > 1 ? 's' : ''} in progress</span>`,
    ].filter(Boolean);

    const ticketRow = (t) => {
      const [cls, ic] = kind(t.type);
      return `<div class="drow" data-ticket="${esc(t.id)}" data-org="${esc(t.org || '')}"><span class="glyph g-${cls}">${icon(ic)}</span><div class="body"><div class="title">${esc(t.title)}</div><div class="meta"><span class="id">#${esc(t.id)}</span><span>${esc(t.state)}</span>${t.project ? `<span>${esc(t.project)}</span>` : ''}</div></div>
        <span class="acts"><button class="icon" data-start="${esc(t.id)}" title="Start work (branch)">${icon('git-branch')}</button></span></div>`;
    };
    const prRow = (p) => {
      const rv = REV[p.isDraft ? 'waiting' : p.review || 'waiting'];
      return `<div class="drow" data-pr="${esc(p.id)}"><span class="glyph g-${p.isDraft ? 'draft' : rv[0]}">${icon(p.isDraft ? 'git-pull-request-draft' : rv[1])}</span><div class="body"><div class="title">${esc(p.title)}</div>
        <div class="meta"><span class="id">${esc(p.label)}</span><span class="pill p-${p.isDraft ? 'draft' : rv[0]}">${p.isDraft ? 'draft' : rv[2]}</span><span>${esc(p.sourceBranch)} → ${esc(p.targetBranch)}</span>${p.group === 'review' ? `<span>${icon('account')} ${esc(p.author)}</span>` : ''}</div></div>${ciHtml(p.ci)}<span class="k">${p.created ? esc(relShort(p.created)) : ''}</span></div>`;
    };
    const branchRow = (x) => {
      const flags = [
        !x.upstream && `<span class="flag warn" title="Never pushed">${icon('cloud-upload')}not pushed</span>`,
        x.gone && `<span class="flag off" title="The remote branch was deleted">${icon('cloud')}remote deleted</span>`,
        x.ahead > 0 && `<span class="flag warn" title="Commits to push">${icon('arrow-up')}${x.ahead}</span>`,
        x.behind > 0 && `<span class="flag run" title="Commits to pull">${icon('arrow-down')}${x.behind}</span>`,
        x.merged && `<span class="flag ok" title="Merged into the default branch">${icon('git-merge')}merged</span>`,
      ].filter(Boolean);
      const pr = r && r.prs.find((p) => p.sourceBranch === x.name);
      return `<div class="drow branch${x.current ? ' current' : ''}"><span class="glyph g-story">${icon('git-branch')}</span><div class="body"><div class="title mono">${esc(x.name)}${x.current ? ' <span class="cur-chip">● current</span>' : ''}</div>
        <div class="meta">${flags.join('')}${x.ticket ? `<span class="link-t" data-ticket="${esc(x.ticket)}">${icon('issues')}#${esc(x.ticket)}</span>` : ''}${pr ? `<span class="link-t" data-pr="${esc(pr.id)}">${icon('git-pull-request')}${esc(pr.label)}</span>` : ''}<span>${esc(x.subject)}</span></div></div>
        ${r ? ciHtml(r.branchCi[x.name]) : ''}<span class="k">${esc(relShort(x.date))}</span>
        <span class="acts">${x.current ? '' : `<button class="icon" data-branch="checkout" data-name="${esc(x.name)}" title="Checkout">${icon('check')}</button>`}
          ${!x.upstream || x.ahead > 0 ? `<button class="icon" data-branch="push" data-name="${esc(x.name)}" title="Push">${icon('arrow-up')}</button>` : ''}
          ${!pr && !x.merged && !x.isDefault ? `<button class="icon" data-branch="pr" data-name="${esc(x.name)}" title="Create a pull request">${icon('git-pull-request-create')}</button>` : ''}
          ${x.merged && !x.current ? `<button class="icon" data-branch="delete" data-name="${esc(x.name)}" title="Delete (merged)">${icon('trash')}</button>` : ''}</span></div>`;
    };
    const loadingOr = (html) => (r ? html : local.signedIn ? '<div class="skeleton"><div></div><div></div></div>' : `<div class="none">Sign in to see it. <span class="link-t" data-act="signIn">Sign in</span></div>`);
    page.innerHTML = `
<header class="t-head">
  <span class="glyph big g-story">${icon('dashboard')}</span>
  <div class="t-title"><div class="t-kind"><span>Dashboard</span><span class="k">${esc(local.repoName)}${local.remote ? ` · ${esc(local.remote)}` : ''}</span></div>
  <h1>${summary.length ? 'What needs you' : 'All clear'}</h1></div>
  <span class="grow"></span><button class="icon" data-act="refresh" title="Refresh">${icon('refresh')}</button>
</header>
<div class="summary">${summary.join('') || `<span class="sum ok">${icon('check-all')}Nothing waiting for you</span>`}</div>
<div class="dgrid">
  ${card('Waiting for my review', 'eye', r ? review.length : undefined, loadingOr(review.map(prRow).join('') || '<div class="none">Nothing to review.</div>'))}
  ${card('My pull requests', 'git-pull-request', r ? mine.length : undefined, loadingOr(mine.map(prRow).join('') || '<div class="none">No open pull request.</div>'), `<button class="ghost" data-act="newPr">${icon('add')}New</button>`)}
  ${card('Tickets in progress', 'issues', r ? inProgress.length : undefined, loadingOr(inProgress.map(ticketRow).join('') || '<div class="none">Nothing in progress.</div>') + (r && todo.length ? `<div class="sub">To do · ${todo.length}</div>${todo.slice(0, 6).map(ticketRow).join('')}` : ''))}
  ${card('My branches', 'git-branch', b.length, b.map(branchRow).join('') || '<div class="none">No local branch.</div>', mergedB.length ? `<span class="k">${mergedB.length} merged</span>` : '')}
</div>`;
  }

  page.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const el = /** @type {HTMLElement | null} */ (t.closest('[data-url],[data-act],[data-start],[data-branch],[data-ticket],[data-pr]'));
    if (!el) return;
    if (el.dataset.url) return vscode.postMessage({ type: 'openUrl', url: el.dataset.url });
    if (el.dataset.act) return vscode.postMessage({ type: el.dataset.act });
    if (el.dataset.start) return vscode.postMessage({ type: 'startWork', id: el.dataset.start });
    if (el.dataset.branch) return vscode.postMessage({ type: 'branch', action: el.dataset.branch, name: el.dataset.name });
    if (el.dataset.ticket) return vscode.postMessage({ type: 'ticket', id: el.dataset.ticket, org: el.dataset.org || undefined });
    if (el.dataset.pr) return vscode.postMessage({ type: 'pr', id: el.dataset.pr });
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'local') {
      local = m;
      render();
    } else if (m.type === 'remote') {
      remote = m;
      render();
    } else if (m.type === 'error') {
      page.innerHTML = `<div class="state error">${icon('warning')}<b>${esc(m.message)}</b></div>`;
    }
  });
  page.innerHTML = '<div class="skeleton"><div></div><div></div><div></div></div>';
  vscode.postMessage({ type: 'ready' });
})();
