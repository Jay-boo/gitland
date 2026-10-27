// @ts-check
(function () {
  const { esc, icon, relShort, shortDate, fullDate, displayName, stateHtml } = /** @type {any} */ (window).gl;
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // Report webview errors to the "Gitland" output channel.
  window.addEventListener('error', (e) => vscode.postMessage({ type: 'log', level: 'error', message: `${e.message} (${e.filename}:${e.lineno})` }));
  window.addEventListener('unhandledrejection', (e) => vscode.postMessage({ type: 'log', level: 'error', message: String(e.reason) }));
  let LANE = 14;
  let AVATAR = 16;
  /** Narrow view (sidebar): compact lanes and one badge per row, like GitLens. */
  const isCompact = () => window.innerWidth < 600;
  // Same order as src/graph/colors.ts: main, dev, feature, fix, hotfix, release, chore, then other names.
  // Lane colours from the theme (--gl-lane-* in base.css), resolved to rgb() so SVG attributes can use them.
  const probe = document.createElement('i');
  probe.hidden = true;
  document.documentElement.appendChild(probe);
  const laneColors = () =>
    /** @type {any} */ (window).gl.themeColors((/** @type {string} */ n) => {
      probe.style.color = `var(${n})`;
      return getComputedStyle(probe).color;
    });
  let COLORS = laneColors();
  const WORKTREE = 'WORKTREE';

  /** @type {any} */
  let data = null;
  let selected = /** @type {string | null} */ (null);
  let matches = /** @type {number[]} */ ([]);
  let matchIndex = -1;
  /** Persisted per view: selection, column widths, minimap visibility. */
  const state = Object.assign({ selected: null, cols: {}, minimap: true }, vscode.getState() || {});
  const saveState = () => vscode.setState(state);
  /** Commit details already fetched (hover card and details pane). */
  const detailsCache = new Map();

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const rowsEl = $('rows');
  const listEl = $('list');
  const detailsEl = $('details');
  const menuEl = $('menu');
  const cardEl = $('card');
  const searchEl = /** @type {HTMLInputElement} */ ($('search'));

  const color = (/** @type {number} */ i) => COLORS[i % COLORS.length];
  const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  /** "just now", "5m ago", "3h ago", "2d ago", then "Sep 21" / "Sep 21, 2024". */
  function graphTime(ts) {
    if (!ts) return '';
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
    const d = new Date(ts);
    const opts = /** @type {Intl.DateTimeFormatOptions} */ ({ month: 'short', day: 'numeric' });
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  /** Five-block +/- bar, like GitHub. */
  function diffBar(added, deleted) {
    const total = added + deleted;
    if (!total) return '<span class="bar"><i></i><i></i><i></i><i></i><i></i></span>';
    const a = Math.round((added / total) * 5);
    const d = Math.min(5 - a, Math.round((deleted / total) * 5));
    return `<span class="bar">${'<i class="a"></i>'.repeat(a)}${'<i class="d"></i>'.repeat(d)}${'<i></i>'.repeat(5 - a - d)}</span>`;
  }

  function fileStats(files) {
    let added = 0, deleted = 0;
    for (const f of files || []) {
      added += f.added || 0;
      deleted += f.deleted || 0;
    }
    return { added, deleted };
  }

  /**
   * Pull requests and work items mentioned in a commit message:
   * "Merged PR 527", "Merge pull request 522 / #12", "(#12)", "AB#1234", "#1234".
   */
  function linksIn(text) {
    const L = data && data.links;
    if (!L || !text) return [];
    const out = [];
    const seen = new Set();
    const add = (kind, id) => {
      const key = kind + id;
      if (seen.has(key) || seen.has('pr' + id)) return;
      seen.add(key);
      out.push({ kind, id, url: (kind === 'pr' ? L.pr : L.ticket).replace('{id}', id) });
    };
    for (const m of text.matchAll(/\b(?:Merged PR|Merge pull request|pull request) #?(\d+)/gi)) add('pr', m[1]);
    if (L.kind === 'github') for (const m of text.split('\n')[0].matchAll(/\(#(\d+)\)/g)) add('pr', m[1]);
    for (const m of text.matchAll(/(?:^|[\s(\[,;])(?:AB)?#(\d+)\b/g)) add('ticket', m[1]);
    return out;
  }

  function linkChips(links) {
    const noun = data.links && data.links.kind === 'github' ? 'Issue' : 'Work item';
    return links
      .map((l) =>
        l.kind === 'pr'
          ? `<span class="link-chip" data-url="${esc(l.url)}" title="Open pull request ${l.id}">${icon('git-pull-request')}PR ${l.id}</span>`
          : `<span class="link-chip" data-url="${esc(l.url)}" title="Open ${noun.toLowerCase()} ${l.id}">${icon('issues')}${noun} ${l.id}</span>`,
      )
      .join('');
  }

  // ---------- markdown (commit messages) ----------

  /** Inline markdown on already-escaped text: `code`, **bold**, *italic*, links, PR / work item refs. */
  function mdInline(t, links = true) {
    return t
      .split(/(`[^`]+`)/g)
      .map((part, i) => {
        if (i % 2) return `<code>${part.slice(1, -1)}</code>`;
        if (!links) return part;
        return part
          .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
          .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
          .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<span class="md-link" data-url="$2" title="$2">$1</span>')
          .replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, '$1<span class="md-link" data-url="$2">$2</span>')
          .replace(/(^|[\s(\[,;])((?:AB)?#(\d+))\b/g, (m, pre, label, id) => {
            const l = data && data.links;
            return l ? `${pre}<span class="md-link" data-url="${esc(l.ticket.replace('{id}', id))}">${label}</span>` : m;
          })
          .replace(/\b((?:Merged PR|Merge pull request) #?(\d+))/g, (m, label, id) => {
            const l = data && data.links;
            return l ? `<span class="md-link" data-url="${esc(l.pr.replace('{id}', id))}">${label}</span>` : m;
          });
      })
      .join('');
  }

  /** Small, safe markdown renderer: everything is escaped first, only a few constructs are recognized. */
  function markdown(text) {
    const lines = esc(text).split('\n');
    let html = '';
    let para = [];
    let list = /** @type {string | null} */ (null);
    const flush = () => {
      if (para.length) html += `<p>${mdInline(para.join(' '))}</p>`;
      para = [];
    };
    const endList = () => {
      if (list) html += `</${list}>`;
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if (/^\s*```/.test(line)) {
        flush();
        endList();
        const code = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
        html += `<pre><code>${code.join('\n')}</code></pre>`;
      } else if ((m = /^\s*[-*+•]\s+(.*)$/.exec(line)) || (m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flush();
        const kind = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (list !== kind) {
          endList();
          html += `<${kind}>`;
          list = kind;
        }
        html += `<li>${mdInline(m[1])}</li>`;
      } else if ((m = /^#{1,6}\s+(.*)$/.exec(line))) {
        flush();
        endList();
        html += `<h4>${mdInline(m[1])}</h4>`;
      } else if ((m = /^&gt;\s?(.*)$/.exec(line))) {
        flush();
        endList();
        html += `<blockquote>${mdInline(m[1])}</blockquote>`;
      } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flush();
        endList();
        html += '<hr>';
      } else if (!line.trim()) {
        flush();
        endList();
      } else if (list && /^\s{2,}\S/.test(line)) {
        html = html.replace(/<\/li>$/, ` ${mdInline(line.trim())}</li>`);
      } else {
        endList();
        para.push(line.trim());
      }
    }
    flush();
    endList();
    return html;
  }

  /** Commit body without trailers (Co-Authored-By, Signed-off-by…) and Azure's "Related work items" line. */
  const cleanBody = (/** @type {string} */ t) => t.replace(/^(?:[\w-]+-by|Related work items): .*$/gim, '').trim();

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
      const dash = (commit.sha === WORKTREE || isStash(commit)) && seg.y1 === 0.5 ? ' stroke-dasharray="3 3"' : '';
      if (x1 === x2) {
        s += `<line data-c="${seg.color}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="1.5"${dash}/>`;
      } else {
        const my = (y1 + y2) / 2;
        s += `<path data-c="${seg.color}" d="M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}" fill="none" stroke="${c}" stroke-width="1.5"${dash}/>`;
      }
    }
    const x = cx(g.lane), y = h / 2, c = color(g.color);
    s += `<g data-c="${g.color}">`;
    if (avatarNode(commit)) {
      // Ring in the lane color; the author picture is an <img> laid over it (see avatarImg).
      const ring = commit.sha === data.head ? 2 : 1.5;
      s += `<circle cx="${x}" cy="${y}" r="${AVATAR / 2 + ring / 2}" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="${ring}"/>`;
    } else if (isStash(commit)) {
      s += `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="2" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="1.5"/>`;
    } else if (commit.sha === WORKTREE) {
      s += `<circle cx="${x}" cy="${y}" r="4" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="1.5" stroke-dasharray="2 2"/>`;
    } else if (commit.sha === data.head) {
      s += `<circle cx="${x}" cy="${y}" r="5" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="1.5"/>`;
      s += `<circle cx="${x}" cy="${y}" r="2.5" fill="${c}"/>`;
    } else if (commit.parents.length > 1) {
      s += `<circle cx="${x}" cy="${y}" r="3" fill="var(--vscode-editor-background)" stroke="${c}" stroke-width="1.5"/>`;
    } else {
      s += `<circle cx="${x}" cy="${y}" r="3.5" fill="${c}"/>`;
    }
    return s + '</g></svg>';
  }

  const isStash = (c) => c.refs.some((r) => r.type === 'stash');

  /** Commits drawn with the author picture (merges stay small dots, like GitLens). */
  function avatarNode(commit) {
    return data.showAvatars && commit.sha !== WORKTREE && !isStash(commit) && commit.parents.length <= 1 && !!commit.email;
  }

  function avatarUrl(email) {
    return (data.avatars || {})[String(email).toLowerCase()];
  }

  function initials(name) {
    const parts = String(name || '?').replace(/[^\p{L}\p{N} ._-]/gu, '').split(/[ ._-]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  /** <img> for an author; falls back to initials when the picture cannot be loaded (offline…). */
  function avatarImg(email, name, size, cls, style, lane) {
    const url = avatarUrl(email);
    const common = `class="avatar ${cls}"${lane === undefined ? '' : ` data-c="${lane}"`} data-email="${esc(String(email).toLowerCase())}" data-initials="${esc(initials(name))}" style="width:${size}px;height:${size}px;${style || ''}"`;
    return url
      ? `<img ${common} src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span ${common}>${esc(initials(name))}</span>`;
  }

  function graphAvatar(commit, h) {
    if (!avatarNode(commit)) return '';
    const left = LANE / 2 + commit.graph.lane * LANE + 4 - AVATAR / 2;
    const top = h / 2 - AVATAR / 2;
    return avatarImg(commit.email, commit.author, AVATAR, 'node', `left:${left}px;top:${top}px;--c:${color(commit.graph.color)}`, commit.graph.color);
  }

  /** "Uncommitted · 4" on the uncommitted changes row; the breakdown ("2 modified · 1 added") is its tooltip. */
  function changesBubble() {
    const n = data.changes || 0;
    const st = data.changeStats || {};
    const names = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', U: 'untracked', C: 'copied' };
    const tip = Object.keys(names).filter((k) => st[k]).map((k) => `${st[k]} ${names[k]}`).join(' · ');
    return `<span class="subject" title="${esc(tip || `${n} uncommitted change${n === 1 ? '' : 's'}`)}">Uncommitted</span><span class="gl-chip wt-n">${n}</span>`;
  }

  /** Signature of a commit (git %G?): verified, untrusted key, key not available, bad… */
  function sigChip(sig) {
    if (!sig) return '';
    const who = sig.signer ? ` · ${esc(sig.signer)}` : '';
    const [cls, ic, label, tip] = {
      G: ['ok', 'verified-filled', 'signed', 'Good signature'],
      U: ['warn', 'verified', 'signed', 'Good signature, but the key is not trusted'],
      X: ['warn', 'verified', 'signed', 'Good signature, expired signature'],
      Y: ['warn', 'verified', 'signed', 'Good signature made by an expired key'],
      R: ['bad', 'unverified', 'revoked key', 'Signed with a revoked key'],
      E: ['off', 'verified', 'signed', 'Signed, but the key is not available here to check it'],
      B: ['bad', 'unverified', 'bad signature', 'The signature does not match'],
    }[sig.status] || ['off', 'verified', 'signed', 'Signed'];
    return `<span class="sig-chip ci-${cls}" title="${tip}${sig.key ? ` (key ${esc(sig.key)})` : ''}">${icon(ic)}${label}${who}</span>`;
  }

  /** CI runs by commit (filled by a 'ci' message): the latest run of each pipeline. */
  let ci = /** @type {Map<string, any[]>} */ (new Map());
  const CI_ICON = { succeeded: ['pass-filled', 'ok'], partial: ['warning', 'warn'], failed: ['error', 'bad'], canceled: ['circle-slash', 'off'], running: ['sync codicon-modifier-spin', 'run'], queued: ['clock', 'off'] };

  /** Overall state of the runs of a commit: failed > running > partial > succeeded. */
  function ciState(runs) {
    const order = ['failed', 'running', 'queued', 'partial', 'canceled', 'succeeded'];
    return order.find((s) => runs.some((r) => r.state === s)) || 'succeeded';
  }

  function ciDot(sha) {
    const runs = ci.get(sha);
    if (!runs) return '';
    const st = ciState(runs);
    const [ic, cls] = CI_ICON[st];
    return `<span class="ci ci-${cls}" data-url="${esc(runs[0].url)}" title="${runs.map((r) => `${r.name}: ${r.state}`).join('\n')}">${icon(ic)}</span>`;
  }

  /** Open pull requests by source branch (filled by a 'prs' message). */
  let prs = /** @type {Map<string, any>} */ (new Map());

  function prBadge(r) {
    if ((r.type !== 'branch' && r.type !== 'remote') || r.noPr) return '';
    const name = r.type === 'remote' ? r.name.slice(r.name.indexOf('/') + 1) : r.name;
    const pr = prs.get(name);
    if (!pr) return '';
    const state = pr.draft ? 'draft' : pr.review || 'waiting';
    const label = { draft: 'draft', waiting: 'in review', approved: 'approved', changes: 'changes requested' }[state];
    const ic = { draft: 'git-pull-request-draft', waiting: 'git-pull-request', approved: 'pass', changes: 'request-changes' }[state];
    return `<span class="pr-badge ${state}" data-url="${esc(pr.url)}" title="PR ${esc(pr.id)} → ${esc(pr.target)}: ${esc(pr.title)} (${label})">${icon(ic)}${esc(pr.id)}</span>`;
  }

  /** Merge "main" + "origin/main" into one badge when they point at the same commit. */
  function refBadges(commit, limit) {
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
    out.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || (a.type === 'tag' ? 1 : 0) - (b.type === 'tag' ? 1 : 0));
    // A PR badge on the remote copy only when there is no local branch of that name.
    for (const r of out) if (r.type === 'remote' && locals.has(r.name.slice(r.name.indexOf('/') + 1))) r.noPr = true;
    let more = '';
    if (limit && out.length > limit) {
      const hidden = out.splice(limit);
      more = `<span class="ref more" style="--c:${c}" title="${esc(hidden.map((r) => r.name).join('\n'))}">+${hidden.length}</span>`;
    }
    return out
      .map((r) => {
        const cls = ['ref', r.type, r.current ? 'current' : ''].join(' ');
        const ic = icon(r.type === 'tag' ? 'tag' : r.type === 'stash' ? 'archive' : r.type === 'remote' ? 'cloud' : r.current ? 'check' : 'git-branch');
        const sync = synced.has(r.name) ? `<span class="sync" title="In sync with remote">${icon('cloud')}</span>` : '';
        const kind = r.type === 'remote' ? 'remote branch' : r.type;
        const drag = r.type === 'branch' || r.type === 'remote' ? ' draggable="true"' : '';
        const rc = r.color === undefined ? c : color(r.color);
        return `<span class="${cls}" style="--c:${rc}"${drag} data-ref="${esc(r.name)}" data-reftype="${r.type}" title="${esc(kind)}: ${esc(r.name)}${sync ? ' (in sync with remote)' : ''}${drag ? ' — drag onto another branch to merge / rebase' : ''}">${ic}<span class="nm">${esc(r.name)}</span>${sync}</span>${prBadge(r)}`;
      })
      .join('') + more;
  }

  // VS Code swaps the theme variables and the body class (vscode-dark / -light / -high-contrast) together.
  // Only the class is watched: the graph itself writes --graph-w / --w-* on <html style> while rendering
  // and resizing columns.
  const themeWatch = new MutationObserver(() => {
    const next = laneColors();
    if (next.join() === COLORS.join()) return;
    COLORS = next;
    if (data) render();
  });
  themeWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  function render() {
    if (!data) return;
    const compact = isCompact();
    document.body.classList.toggle('compact', compact);
    AVATAR = compact ? 14 : 16;
    LANE = data.showAvatars ? (compact ? 16 : 18) : compact ? 10 : 13;
    const h = rowH();
    const graphPx = (data.width + 1) * LANE + (compact ? 8 : 12);
    const autoW = Math.min(graphPx, compact ? Math.round(window.innerWidth * 0.4) : 420);
    document.documentElement.style.setProperty('--graph-w', `${!compact && state.cols.graph ? state.cols.graph : autoW}px`);
    $('repoName').textContent = data.repoName;
    $('branchName').innerHTML = `${icon('git-branch')}<span>${esc(data.branch || 'detached HEAD')}</span>${icon('chevron-down', 'chev')}`;
    const remote = String(data.remote || '');
    $('remoteName').innerHTML = remote ? `${icon(/github/i.test(remote) ? 'github' : 'azure-devops')}<span>${esc(remote)}</span>` : '';
    const html = data.commits
      .map(
        (c, i) => `<div class="row commit${c.sha === WORKTREE ? ' worktree' : ''}${c.parents.length > 1 ? ' merge' : ''}${isStash(c) ? ' stash' : ''}${c.sha === selected ? ' selected' : ''}" style="--lane:${color(c.graph.color)}" data-i="${i}" data-sha="${c.sha}">
  <div class="c-graph">${svgFor(c, h)}${graphAvatar(c, h)}</div>
  <div class="c-msg">${c.sha === WORKTREE ? changesBubble() : `${refBadges(c, compact ? 1 : 0)}${c.mergedFrom ? `<span class="merged-chip" style="--c:${color(c.mergedColor ?? 6)}" data-merge="${c.sha}" title="Merge of ${esc(c.mergedFrom)} — click to see what it brought">${icon('git-merge')}${esc(c.mergedFrom)}</span>` : ''}<span class="subject${c.mergedTitle ? ' mtitle' : ''}">${mdInline(esc(c.mergedTitle || c.subject), false)}</span>`}</div>
  <div class="c-author">${c.sha === WORKTREE || !data.showAvatars ? '' : avatarImg(c.email, c.author, 16, 'small')}<span title="${esc(c.author)}${c.email && c.email !== c.author ? ` <${esc(c.email)}>` : ''}">${esc(displayName(c.author))}</span></div>
  <div class="c-date" title="${esc(fullDate(c.ts))}">${esc(shortDate(c.ts))}</div>
  <div class="c-sha">${ciDot(c.sha)}${esc(c.short)}</div>
</div>`,
      )
      .join('');
    rowsEl.innerHTML = html;
    $('more').innerHTML = data.hasMore
      ? `<button id="btnMore">${icon('chevron-down')}Load more commits</button>`
      : `<span>${icon('pass')} ${plural(data.commits.length, 'commit')}</span>`;
    applySearch(false);
    applyFocus();
    renderScope();
    renderFilterButton();
    renderMinimap();
    vscode.postMessage({ type: 'log', level: 'info', message: `graph rendered ${data.commits.length} commits, ${data.width} lanes, list height ${listEl.clientHeight}px` });
  }

  // ---------- details ----------

  function fileRows(files) {
    return (files || [])
      .map((f) => {
        const idx = f.path.lastIndexOf('/');
        const name = f.path.slice(idx + 1);
        const dir = idx >= 0 ? f.path.slice(0, idx) : '';
        const renamed = f.oldPath ? ` ← ${esc(f.oldPath)}` : '';
        const delta =
          f.added === undefined
            ? ''
            : `<span class="delta">${f.added ? `<span class="plus">+${f.added}</span>` : ''}${f.deleted ? `<span class="minus">−${f.deleted}</span>` : ''}${diffBar(f.added, f.deleted)}</span>`;
        return `<div class="file" data-path="${esc(f.path)}" data-old="${esc(f.oldPath || '')}" data-status="${f.status}" title="${esc(f.path)}${renamed}">
  <span class="st ${f.status}">${f.status}</span><span class="name">${esc(name)}</span><span class="dir">${esc(dir)}${renamed}</span>${delta}</div>`;
      })
      .join('');
  }

  function showDetails(sha, d) {
    if (sha !== selected) return;
    const isWt = sha === WORKTREE;
    const lines = (d.message || '').split('\n');
    const subject = lines[0];
    const body = cleanBody(lines.slice(1).join('\n'));
    const commit = data.commits.find((c) => c.sha === sha);
    const lane = commit ? color(commit.graph.color) : '';
    const parents = (d.parents || [])
      .map((p) => `<span class="chip" data-goto="${p}" title="Go to parent ${p}">${icon('git-commit')}${p.slice(0, 7)}</span>`)
      .join('');
    const files = d.files || [];
    const st = fileStats(files);
    detailsEl.style.setProperty('--lane', lane);
    detailsEl.innerHTML = `
<div class="resizer"></div>
<div class="sel-line gl-ck"><span class="name">${icon('circle-filled')}${isWt ? 'Uncommitted changes' : `Selected · <span class="mono">${esc(d.sha.slice(0, 7))}</span>`}</span>${
    isWt
      ? ''
      : `<button class="act" data-act="checkoutCommit" title="Check out this commit">${icon('target')}Checkout</button><button class="act" data-act="cherryPick" title="Cherry-pick onto the current branch">${icon('git-pull-request-go-to-changes')}Cherry-pick</button><button class="act gen-btn" data-act="explainCommit" title="What this commit does and why (AI)">${icon('sparkle')}Explain</button><button class="act" data-act="selMore" title="More: branch here, revert, open on remote" aria-haspopup="menu">${icon('ellipsis')}</button>`
  }<button class="act close" title="Close (Esc)">${icon('close')}</button></div>
<div class="info">
  ${
    isWt
      ? ''
      : `<div class="author">${data.showAvatars ? avatarImg(d.email, d.author, 26, '') : ''}<div class="who"><b title="${esc(d.author)}">${esc(displayName(d.author))}</b><span>${esc(d.email)}</span></div></div>`
  }
  <h2>${mdInline(esc(subject))}</h2>
  ${commit && commit.refs.length ? `<div class="refs">${refBadges(commit)}</div>` : ''}
  ${isWt ? '' : ((l) => (l.length ? `<div class="links">${linkChips(l)}</div>` : ''))(linksIn(d.message))}
  ${
    isWt
      ? ''
      : `<div class="shas">
    <span><span class="k">commit</span><span class="chip" data-act="copySha" title="Copy ${esc(d.sha)}">${d.sha.slice(0, 10)}${icon('copy')}</span></span>
    ${parents ? `<span><span class="k">${d.parents.length > 1 ? 'parents' : 'parent'}</span>${parents}</span>` : ''}
    <span title="${esc(graphTime(d.authorTs))}">${esc(d.authorDate)}</span>
    ${ci.has(d.sha) ? ci.get(d.sha).map((r) => `<span class="ci-label ci-${CI_ICON[r.state][1]}" data-url="${esc(r.url)}" title="Open the run">${icon(CI_ICON[r.state][0])}${esc(r.name)}</span>`).join('') : ''}
    ${sigChip(d.signature)}
    <span class="rel-chip${d.release ? '' : ' none'}"${d.release ? ` data-release="${esc(d.release)}"` : ''} title="${d.release ? `First release that contains this commit: ${esc(d.release)} — open it` : 'Not in any release (tag) yet'}">${d.release ? `${icon('tag')}${esc(d.release)}` : 'not released yet'}</span>
    ${d.committer && d.committer !== d.author ? `<span>committed by ${esc(d.committer)}</span>` : ''}
  </div>`
  }
  ${body ? `<div class="body md">${markdown(body)}</div>` : ''}
  ${
    isWt
      ? ''
      : `<div class="explain-card" id="explainCard" hidden><div class="ex-h">${icon('sparkle')} Explanation<span class="grow"></span><span class="ex-stop" data-act="stopExplain">${icon('debug-stop')}</span></div><div class="md" id="explainBody"></div></div>`
  }
</div>
<div class="files"><h3 class="gl-ck"><span class="name">${icon('diff')}${plural(files.length, 'file')} changed</span>${st.added ? `<span class="plus act-stat">+${st.added}</span>` : ''}${st.deleted ? `<span class="minus act-stat">−${st.deleted}</span>` : ''}</h3>${fileRows(files) || '<span class="muted">No file changes</span>'}</div>`;
    detailsEl.hidden = false;
  }

  // ---------- hover card ----------

  let cardSha = /** @type {string | null} */ (null);
  let cardTimer = 0;
  let cardY = 0;
  let cardX = 0;

  function cardHtml(c, d) {
    const lane = color(c.graph.color);
    const isWt = c.sha === WORKTREE;
    const msg = d ? d.message || '' : c.subject;
    const nl = msg.indexOf('\n');
    const subject = nl < 0 ? msg : msg.slice(0, nl);
    const body = nl < 0 ? '' : cleanBody(msg.slice(nl + 1));
    let stats = '<span class="gl-skel"></span>';
    if (d) {
      const files = d.files || [];
      const st = fileStats(files);
      stats = `<span>${plural(files.length, 'file')}</span>${st.added ? `<span class="plus">+${st.added}</span>` : ''}${st.deleted ? `<span class="minus">−${st.deleted}</span>` : ''}${st.added + st.deleted ? diffBar(st.added, st.deleted) : ''}`;
    }
    cardEl.style.setProperty('--lane', lane);
    const head = isWt
      ? `<div class="hd"><div class="who"><b>${icon('edit')} Working tree</b><span>Changes not committed yet</span></div></div>`
      : `<div class="hd">${data.showAvatars ? avatarImg(c.email, c.author, 28, '') : ''}<div class="who"><b title="${esc(c.author)}">${esc(displayName(c.author))}</b><span>${esc(c.email)}</span></div><div class="when"><b>${esc(graphTime(c.ts))}</b><span>${esc(c.date)}</span></div></div>`;
    return `${head}
<div class="msg"><div class="s">${mdInline(esc(subject))}</div>${body ? `<div class="b md">${markdown(body)}</div>` : ''}</div>
${c.refs.length ? `<div class="refs">${refBadges(c)}</div>` : ''}
${((l) => (l.length ? `<div class="links">${linkChips(l)}</div>` : ''))(linksIn(msg))}
<div class="ft">${isWt ? '' : `<span class="sha-chip">${esc(c.short)}</span>`}${stats}${ci.has(c.sha) ? `<span class="ci-label ci-${CI_ICON[ciState(ci.get(c.sha))][1]}">${icon(CI_ICON[ciState(ci.get(c.sha))][0])}${ciState(ci.get(c.sha))}</span>` : ''}${d && !isWt && !isStash(c) ? (d.release ? `<span class="rel-chip" data-release="${esc(d.release)}" title="Open release ${esc(d.release)}">${icon('tag')}${esc(d.release)}</span>` : '<span class="rel-chip none">unreleased</span>') : ''}<span class="grow"></span><span class="hint">${c.parents.length > 1 ? 'merge' : ''}</span></div>`;
  }

  function placeCard() {
    const r = cardEl.getBoundingClientRect();
    const rowEl = rowsEl.querySelector(`.commit[data-sha="${cardSha}"]`);
    const rr = rowEl ? rowEl.getBoundingClientRect() : { top: cardY, bottom: cardY };
    let top = rr.bottom + 2;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, rr.top - r.height - 2);
    const left = Math.max(8, Math.min(cardX + 14, window.innerWidth - r.width - 8));
    cardEl.style.left = `${left}px`;
    cardEl.style.top = `${top}px`;
  }

  function showCard(sha) {
    const c = data && data.commits.find((x) => x.sha === sha);
    if (!c) return;
    cardSha = sha;
    cardEl.innerHTML = cardHtml(c, detailsCache.get(sha));
    cardEl.hidden = false;
    placeCard();
    requestAnimationFrame(() => cardEl.classList.add('show'));
    if (!detailsCache.has(sha)) vscode.postMessage({ type: 'hover', sha });
  }

  let hideTimer = 0;
  /** Leaves time to move the pointer into the card (it has clickable links). */
  function hideCardSoon() {
    clearTimeout(cardTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCard, 220);
  }

  function hideCard() {
    clearTimeout(cardTimer);
    clearTimeout(hideTimer);
    cardSha = null;
    cardEl.classList.remove('show');
    cardEl.hidden = true;
  }

  function select(sha, scroll) {
    endCompare();
    selected = sha;
    rowsEl.querySelectorAll('.commit.selected').forEach((el) => el.classList.remove('selected'));
    const row = rowsEl.querySelector(`.commit[data-sha="${sha}"]`);
    if (row) {
      row.classList.add('selected');
      if (scroll) row.scrollIntoView({ block: 'center' });
    }
    vscode.postMessage({ type: 'select', sha });
    state.selected = sha;
    saveState();
  }

  function closeDetails() {
    endCompare();
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
    hideCard();
    menuEl.innerHTML = items
      .map((it) =>
        it === '-'
          ? '<div class="sep"></div>'
          : it.label && !it.act
            ? `<div class="label">${esc(it.label)}</div>`
            : `<div class="item${it.danger ? ' danger' : ''}" role="menuitem" tabindex="-1" data-act="${it.act}" data-sha="${it.sha || ''}" data-ref="${esc(it.ref || '')}" data-reftype="${it.refType || ''}">${icon(it.icon || 'blank')}${esc(it.label)}</div>`,
      )
      .join('');
    menuEl.hidden = false;
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
    menuEl.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
  }

  function stashMenu(name) {
    return [
      { label: name },
      { label: 'Apply stash', icon: 'check', act: 'stashApply', ref: name },
      { label: 'Pop stash (apply and drop)', icon: 'arrow-up', act: 'stashPop', ref: name },
      { label: 'Create branch from stash…', icon: 'git-branch', act: 'stashBranch', ref: name },
      '-',
      { label: 'Drop stash', icon: 'trash', act: 'stashDrop', ref: name, danger: true },
    ];
  }

  function commitMenu(sha) {
    const cmp = selected && selected !== sha && selected !== WORKTREE ? [{ label: `Compare with ${selected.slice(0, 7)}`, icon: 'git-compare', act: 'compare', sha }, '-'] : [];
    const c = data.commits.find((x) => x.sha === sha);
    const merge = c && (c.parents.length > 1 || c.mergedFrom) ? [{ label: 'Show what this merge brought', icon: 'git-merge', act: 'compareRefs', ref: `${sha}^1`, sha }] : [];
    return [
      ...cmp,
      ...merge,
      { label: 'Compare with a branch or tag…', icon: 'git-compare', act: 'compareWith', sha },
      { label: 'Create release here…', icon: 'tag', act: 'createRelease', sha },
      { label: 'Interactive rebase from here…', icon: 'list-ordered', act: 'rebaseFrom', sha },
      '-',
      { label: 'Create branch here…', icon: 'git-branch', act: 'createBranch', sha },
      { label: 'Create tag here…', icon: 'tag', act: 'createTag', sha },
      { label: 'Checkout (detached)', icon: 'target', act: 'checkoutCommit', sha },
      '-',
      { label: 'Cherry-pick onto current branch', icon: 'git-pull-request-go-to-changes', act: 'cherryPick', sha },
      { label: 'Revert commit', icon: 'discard', act: 'revert', sha },
      { label: 'Reset current branch to here…', icon: 'history', act: 'reset', sha, danger: true },
      '-',
      { label: 'Copy SHA', icon: 'copy', act: 'copySha', sha },
      { label: 'Copy message', icon: 'note', act: 'copyMessage', sha },
      { label: 'Open on remote', icon: 'link-external', act: 'openRemote', sha },
    ];
  }

  function refMenu(ref, refType) {
    const focusItem = focus && focus.name === ref ? { label: 'Show all branches', icon: 'list-flat', act: 'unfocus' } : { label: 'Focus on this', icon: 'eye', act: 'focus', ref, refType };
    const compare = [
      ...(refType === 'tag' ? [{ label: 'Compare with the previous tag', icon: 'git-compare', act: 'comparePrevious', ref }] : []),
      { label: 'Compare with…', icon: 'git-compare', act: 'compareWith', ref },
    ];
    if (refType === 'tag') {
      return [{ label: `tag ${ref}` }, { label: 'Show release', icon: 'tag', act: 'showRelease', ref }, focusItem, ...compare, '-', { label: 'Copy name', icon: 'copy', act: 'copyRef', ref }, { label: 'Delete tag', icon: 'trash', act: 'deleteTag', ref, danger: true }];
    }
    const isCurrent = ref === data.branch;
    const items = [{ label: `${refType === 'remote' ? 'remote branch' : 'branch'} ${ref}` }, focusItem, ...compare, '-'];
    if (!isCurrent) items.push({ label: 'Checkout', icon: 'check', act: 'checkoutBranch', ref, refType });
    if (refType === 'branch') {
      items.push({ label: 'Push', icon: 'arrow-up', act: 'push', ref, refType });
      items.push({ label: 'Create pull request…', icon: 'git-pull-request', act: 'createPr', ref, refType });
    }
    if (!isCurrent && data.branch) {
      items.push(
        '-',
        { label: `Merge into ${data.branch}`, icon: 'git-merge', act: 'merge', ref, refType },
        { label: `Rebase ${data.branch} onto this`, icon: 'git-compare', act: 'rebase', ref, refType },
      );
    }
    items.push('-', { label: 'Open in a new worktree', icon: 'window', act: 'worktree', ref, refType });
    items.push({ label: 'Open on remote', icon: 'link-external', act: 'openBranchRemote', ref, refType }, { label: 'Copy name', icon: 'copy', act: 'copyRef', ref, refType });
    if (!isCurrent) items.push({ label: 'Delete branch…', icon: 'trash', act: 'deleteBranch', ref, refType, danger: true });
    return items;
  }

  // ---------- branch focus ----------

  /** Branch / tag the graph is focused on: its history stays bright, the rest fades. */
  let focus = /** @type {{ name: string, type: string } | null} */ (null);

  /** All loaded commits reachable from `sha` (the history of a branch). */
  function history(sha) {
    const bySha = new Map(data.commits.map((c) => [c.sha, c]));
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const s = /** @type {string} */ (stack.pop());
      if (seen.has(s)) continue;
      const c = bySha.get(s);
      if (!c) continue;
      seen.add(s);
      stack.push(...c.parents);
    }
    return seen;
  }

  function refCommit(name) {
    return data.commits.find((c) => c.refs.some((r) => r.name === name));
  }

  function applyFocus() {
    const c = focus && refCommit(focus.name);
    if (focus && !c) focus = null;
    const set = c ? history(c.sha) : null;
    if (set && focus && focus.name === data.branch) set.add(WORKTREE);
    const rows = rowsEl.children;
    data.commits.forEach((x, i) => rows[i] && rows[i].classList.toggle('off', !!set && !set.has(x.sha)));
    document.querySelectorAll('.ref').forEach((el) => el.classList.toggle('focused', !!focus && /** @type {HTMLElement} */ (el).dataset.ref === focus.name));
    const btn = $('btnBranches');
    btn.classList.toggle('on', !!focus);
    $('branchesLabel').textContent = focus ? focus.name : 'Branches';
    btn.title = focus ? `Focused on ${focus.name} — click to change, Esc to show all` : 'Pick a branch to focus on';
  }

  /** Focus a branch: select its commit, scroll to it, fade what is not in its history. Again = clear. */
  function focusRef(name, type) {
    if (focus && focus.name === name) {
      clearFocus();
      return;
    }
    focus = { name, type };
    if (data.scope && data.scope !== 'all' && type !== 'tag' && type !== 'stash' && name !== data.scopeRef) {
      return setScope(data.scope, name);
    }
    applyFocus();
    const c = refCommit(name);
    if (c) select(c.sha, true);
  }

  function clearFocus() {
    focus = null;
    applyFocus();
  }

  // ---------- branch picker ----------

  const pickerEl = $('picker');
  const pickerInput = /** @type {HTMLInputElement} */ ($('pickerInput'));
  let pickIndex = 0;

  /** Every ref of the repository (from git, see 'listRefs'), plus stashes of the loaded graph. */
  let repoRefs = /** @type {any[] | null} */ (null);

  function allRefs() {
    const loaded = new Map();
    data.commits.forEach((c) => c.refs.forEach((r) => loaded.set(r.name, { ...r, sha: c.sha, ts: c.ts, color: color(r.color ?? c.graph.color), loaded: true })));
    const out = [...loaded.values()];
    for (const r of repoRefs || []) {
      if (!loaded.has(r.name)) out.push({ ...r, ts: r.date, color: 'var(--faint)', loaded: false });
    }
    const order = { branch: 0, remote: 1, tag: 2, stash: 3 };
    return out.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || order[a.type] - order[b.type] || b.ts - a.ts);
  }

  function renderPicker() {
    const q = pickerInput.value.trim().toLowerCase();
    const refs = allRefs().filter((r) => !q || r.name.toLowerCase().includes(q));
    const groups = { branch: 'Local branches', remote: 'Remote branches', tag: 'Tags', stash: 'Stashes' };
    let html = focus && !q ? `<div class="pick all" data-i="-1">${icon('list-flat')}<span class="nm">Show all branches</span><span class="k">Esc</span></div>` : '';
    let last = '';
    refs.forEach((r, i) => {
      if (r.type !== last) {
        html += `<div class="grp">${groups[r.type]}</div>`;
        last = r.type;
      }
      const ic = r.type === 'tag' ? 'tag' : r.type === 'stash' ? 'archive' : r.type === 'remote' ? 'cloud' : 'git-branch';
      const on = focus && focus.name === r.name ? ' focused' : '';
      const off = r.loaded ? '' : ' unloaded';
      html += `<div class="pick${on}${off}" data-i="${i}" data-ref="${esc(r.name)}" data-reftype="${r.type}" data-sha="${esc(r.sha)}" data-loaded="${r.loaded ? 1 : 0}" style="--c:${r.color}" title="${r.loaded ? '' : 'Older than the loaded commits: picking it loads more history'}">${icon(ic)}<span class="nm">${esc(r.name)}</span>${r.current ? '<span class="cur">current</span>' : ''}${r.loaded ? '' : `<span class="cur">${icon('cloud-download')}</span>`}<span class="k" title="${esc(fullDate(r.ts))}">${esc(relShort(r.ts))}</span></div>`;
    });
    const legend = ['main', 'dev', 'feature', 'fix', 'hotfix', 'release', 'chore']
      .map((n, i) => `<span><i style="background:${COLORS[i]}"></i>${n}</span>`)
      .join('');
    $('pickerList').innerHTML =
      `<div class="legend">${legend}</div>` +
      (html || '<div class="grp">No branch matches</div>') +
      `<div class="pick-foot"><span class="pick-link" data-tool="cleanup">${icon('trash')}Clean up branches…</span><span class="pick-link" data-tool="worktrees">${icon('window')}Worktrees…</span></div>`;
    pickIndex = Math.min(pickIndex, Math.max(0, pickerEl.querySelectorAll('.pick').length - 1));
    markPick();
  }

  function markPick() {
    const items = pickerEl.querySelectorAll('.pick');
    items.forEach((el, i) => el.classList.toggle('active', i === pickIndex));
    items[pickIndex] && items[pickIndex].scrollIntoView({ block: 'nearest' });
  }

  function openPicker(/** @type {HTMLElement | undefined} */ from) {
    hideCard();
    menuEl.hidden = true;
    // Anchored to what opened it: the branch chip, the Branches button (shown while a branch is focused) or "…".
    const anchor = from || ($('btnBranches').offsetParent ? $('btnBranches') : $('btnOverflow'));
    const r = anchor.getBoundingClientRect();
    pickerEl.hidden = false;
    pickerEl.style.top = `${r.bottom + 4}px`;
    pickerEl.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - pickerEl.offsetWidth - 6))}px`;
    pickerInput.value = '';
    pickIndex = 0;
    renderPicker();
    pickerInput.focus();
    vscode.postMessage({ type: 'listRefs' });
  }

  function closePicker() {
    pickerEl.hidden = true;
  }

  function pick(el) {
    closePicker();
    if (!el || el.classList.contains('all')) return clearFocus();
    if (el.dataset.loaded === '0') {
      $('branchesLabel').textContent = `Loading ${el.dataset.ref}…`;
      return vscode.postMessage({ type: 'reveal', ref: el.dataset.ref, sha: el.dataset.sha });
    }
    focusRef(/** @type {string} */ (el.dataset.ref), /** @type {string} */ (el.dataset.reftype));
  }

  $('btnBranches').addEventListener('click', (e) => {
    e.stopPropagation();
    pickerEl.hidden ? openPicker() : closePicker();
  });
  // The header branch chip opens the same picker.
  $('branchName').addEventListener('click', (e) => {
    e.stopPropagation();
    pickerEl.hidden ? openPicker($('branchName')) : closePicker();
  });
  pickerInput.addEventListener('input', () => {
    pickIndex = 0;
    renderPicker();
  });
  pickerInput.addEventListener('keydown', (e) => {
    const items = pickerEl.querySelectorAll('.pick');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pickIndex = Math.max(0, Math.min(items.length - 1, pickIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      markPick();
    } else if (e.key === 'Enter') {
      pick(/** @type {HTMLElement} */ (items[pickIndex]));
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closePicker();
      listEl.focus();
    }
  });
  pickerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const tool = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-tool]'));
    if (tool) {
      closePicker();
      return vscode.postMessage({ type: 'action', action: tool.dataset.tool });
    }
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.pick'));
    if (el) pick(el);
  });
  pickerEl.addEventListener('dblclick', (e) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.pick'));
    if (el && el.dataset.ref && el.dataset.reftype !== 'tag') {
      vscode.postMessage({ type: 'action', action: 'checkoutBranch', ref: el.dataset.ref, refType: el.dataset.reftype });
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!pickerEl.hidden && !pickerEl.contains(/** @type {Node} */ (e.target)) && !$('btnBranches').contains(/** @type {Node} */ (e.target)) && !$('branchName').contains(/** @type {Node} */ (e.target))) closePicker();
  });

  // ---------- scope: all branches / one branch / timeline ----------

  function renderScope() {
    const scope = data.scope || 'all';
    document.querySelectorAll('#scope button').forEach((b) => b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.scope === scope));
    if (scope !== 'all' && !focus) {
      $('branchesLabel').textContent = data.scopeRef || 'Branches';
      $('btnBranches').classList.add('on');
    }
  }

  function setScope(scope, ref) {
    const f = { ...(data.filters || {}), scope, ref: scope === 'all' ? undefined : ref };
    sendFilters(f);
  }

  $('scope').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-scope]'));
    if (b) setScope(b.dataset.scope, focus && focus.type !== 'tag' ? focus.name : (data.filters || {}).ref);
  });
  $('btnCompare').addEventListener('click', () => vscode.postMessage({ type: 'compareRefs' }));

  // ---------- compare two commits ----------

  let comparing = /** @type {{ a: string, b: string } | null} */ (null);

  function startCompare(a, b) {
    comparing = { a, b };
    rowsEl.querySelectorAll('.commit.cmp').forEach((el) => el.classList.remove('cmp'));
    for (const sha of [a, b]) rowsEl.querySelector(`.commit[data-sha="${sha}"]`)?.classList.add('cmp');
    detailsEl.hidden = false;
    detailsEl.innerHTML = `<div class="sel-line gl-ck"><span class="name">Comparing ${a.slice(0, 7)} ↔ ${b.slice(0, 7)}…</span><button class="act close" title="Close (Esc)">${icon('close')}</button></div>`;
    vscode.postMessage({ type: 'compare', a, b });
  }

  function showCompare(m) {
    if (!comparing) return;
    comparing = { a: m.a, b: m.b };
    const ca = data.commits.find((c) => c.sha === m.a);
    const cb = data.commits.find((c) => c.sha === m.b);
    const st = fileStats(m.files);
    const side = (c, sha) =>
      `<div class="cmp-side"><span class="chip" data-goto="${sha}">${icon('git-commit')}${sha.slice(0, 7)}</span><span class="cmp-msg">${c ? mdInline(esc(c.subject), false) : ''}</span><span class="k">${c ? esc(graphTime(c.ts)) : ''}</span></div>`;
    detailsEl.style.setProperty('--lane', 'var(--accent)');
    detailsEl.innerHTML = `
<div class="resizer"></div>
<div class="sel-line gl-ck"><span class="name">${icon('git-compare')}Compare · <span class="mono">${esc(m.a.slice(0, 7))}..${esc(m.b.slice(0, 7))}</span></span><button class="act" data-act="swapCompare" title="Swap the two commits">${icon('arrow-swap')}Swap</button><button class="act close" title="Close (Esc)">${icon('close')}</button></div>
<div class="info">
  ${side(ca, m.a)}
  <div class="cmp-arrow">${icon('arrow-down')} <span>${plural(m.onlyNewer, 'commit')} ahead${m.onlyOlder ? `, ${plural(m.onlyOlder, 'commit')} behind` : ''}</span></div>
  ${side(cb, m.b)}
</div>
<div class="files"><h3 class="gl-ck"><span class="name">${icon('diff')}${plural(m.files.length, 'file')} changed</span>${st.added ? `<span class="plus act-stat">+${st.added}</span>` : ''}${st.deleted ? `<span class="minus act-stat">−${st.deleted}</span>` : ''}</h3>${fileRows(m.files) || '<span class="muted">No differences</span>'}</div>`;
    detailsEl.hidden = false;
  }

  function endCompare() {
    comparing = null;
    rowsEl.querySelectorAll('.commit.cmp').forEach((el) => el.classList.remove('cmp'));
  }

  // ---------- filters ----------

  const PERIODS = [7, 30, 90, 365];

  function filterMenu() {
    const f = data.filters || {};
    const check = (on) => (on ? 'check' : 'blank');
    const items = [
      { label: 'Filter commits' },
      { label: 'Only my commits', icon: check(f.mine), act: 'filter', ref: 'mine' },
      { label: 'Hide merge commits', icon: check(f.noMerges), act: 'filter', ref: 'noMerges' },
      '-',
      { label: 'Period' },
      ...PERIODS.map((d) => ({ label: d === 365 ? 'Last year' : `Last ${d} days`, icon: check(f.sinceDays === d), act: 'filter', ref: `since:${d}` })),
      '-',
      { label: 'Author' },
      ...(data.authors || []).slice(0, 12).map((a) => ({ label: `${a.name}  (${a.count})`, icon: check(f.author === a.email), act: 'filter', ref: `author:${a.email}` })),
    ];
    if (Object.keys(f).some((k) => f[k])) items.push('-', { label: 'Clear all filters', icon: 'clear-all', act: 'filter', ref: 'clear' });
    return items;
  }

  function toggleFilter(key) {
    const f = { ...(data.filters || {}) };
    if (key === 'clear') return sendFilters({ scope: f.scope, ref: f.ref }); // keep the view mode
    if (key === 'mine' || key === 'noMerges') f[key] = !f[key];
    else if (key.startsWith('since:')) f.sinceDays = f.sinceDays === Number(key.slice(6)) ? undefined : Number(key.slice(6));
    else if (key.startsWith('author:')) f.author = f.author === key.slice(7) ? undefined : key.slice(7);
    sendFilters(f);
  }

  function sendFilters(f) {
    state.filters = f;
    saveState();
    vscode.postMessage({ type: 'filters', filters: f });
  }

  function renderFilterButton() {
    const f = data.filters || {};
    const n = ['mine', 'noMerges', 'author', 'sinceDays'].filter((k) => f[k]).length;
    const btn = $('btnFilter');
    btn.classList.toggle('on', n > 0);
    $('filterCount').textContent = n ? String(n) : '';
    btn.title = n ? `${n} filter${n > 1 ? 's' : ''} on — ${data.commits.length} of ${data.scanned} commits shown` : 'Filter commits';
  }

  $('btnFilter').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = $('btnFilter').getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, filterMenu());
  });

  // ---------- drag a branch onto another: merge / rebase ----------

  let dragged = /** @type {{ ref: string, type: string } | null} */ (null);

  rowsEl.addEventListener('dragstart', (e) => {
    const ref = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.ref[draggable]'));
    if (!ref || !e.dataTransfer) return;
    hideCard();
    dragged = { ref: /** @type {string} */ (ref.dataset.ref), type: /** @type {string} */ (ref.dataset.reftype) };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged.ref);
    document.body.classList.add('dragging');
  });
  rowsEl.addEventListener('dragend', () => {
    document.body.classList.remove('dragging');
    rowsEl.querySelectorAll('.drop').forEach((el) => el.classList.remove('drop'));
  });
  rowsEl.addEventListener('dragover', (e) => {
    const ref = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.ref[draggable]'));
    rowsEl.querySelectorAll('.drop').forEach((el) => el !== ref && el.classList.remove('drop'));
    if (!dragged || !ref || ref.dataset.ref === dragged.ref) return;
    e.preventDefault();
    ref.classList.add('drop');
  });
  rowsEl.addEventListener('drop', (e) => {
    const ref = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.ref[draggable]'));
    if (!dragged || !ref || ref.dataset.ref === dragged.ref) return;
    e.preventDefault();
    ref.classList.remove('drop');
    const target = /** @type {string} */ (ref.dataset.ref);
    const items = [{ label: `${dragged.ref} → ${target}` }];
    if (ref.dataset.reftype === 'branch') items.push({ label: `Merge ${dragged.ref} into ${target}`, icon: 'git-merge', act: 'dropMerge', ref: target });
    if (dragged.type === 'branch') items.push({ label: `Rebase ${dragged.ref} onto ${target}`, icon: 'git-compare', act: 'dropRebase', ref: target });
    if (items.length === 1) items.push({ label: 'Drop onto a local branch to merge into it' });
    showMenu(e.clientX, e.clientY, items);
  });

  // ---------- activity minimap ----------

  const minimapEl = $('minimap');
  /** @type {{ start: number, end: number, first: number, count: number }[]} */
  let buckets = [];

  function renderMinimap() {
    const btn = $('btnMinimap');
    const on = state.minimap && !isCompact();
    btn.classList.toggle('on', on);
    minimapEl.hidden = !on;
    buckets = [];
    const commits = data.commits.filter((c) => c.sha !== WORKTREE && c.ts);
    if (!on || !commits.length) return;
    const DAY = 86400e3;
    const newest = Math.max(...commits.map((c) => c.ts));
    const oldest = Math.min(...commits.map((c) => c.ts));
    // Hourly bars for a short history, daily (or wider) otherwise.
    const unit = newest - oldest < 3 * DAY ? 3600e3 : DAY;
    const end = unit === DAY ? new Date(newest).setHours(24, 0, 0, 0) : new Date(newest).setMinutes(60, 0, 0);
    const units = Math.ceil((end - oldest) / unit);
    const maxBars = Math.max(20, Math.floor((minimapEl.clientWidth - 24) / 4));
    const size = unit * Math.max(1, Math.ceil(units / maxBars));
    const n = Math.ceil((end - oldest) / size);
    for (let i = n - 1; i >= 0; i--) buckets.push({ start: end - (i + 1) * size, end: end - i * size, first: -1, count: 0 });
    data.commits.forEach((c, i) => {
      if (c.sha === WORKTREE || !c.ts) return;
      const b = buckets[Math.min(buckets.length - 1, Math.max(0, n - 1 - Math.floor((end - c.ts) / size)))];
      b.count++;
      if (b.first < 0) b.first = i;
    });
    const max = Math.max(...buckets.map((b) => b.count));
    const headTs = (data.commits.find((c) => c.sha === data.head) || {}).ts;
    minimapEl.innerHTML =
      buckets
        .map((b, i) => {
          const h = b.count ? Math.max(10, Math.round(Math.sqrt(b.count / max) * 100)) : 4;
          const head = headTs && headTs >= b.start && headTs < b.end ? ' head' : '';
          return `<div class="day${b.count ? '' : ' empty'}${head}" data-b="${i}"><i style="height:${h}%"></i></div>`;
        })
        .join('') + '<div class="tip" hidden></div>';
    markMinimapView();
  }

  function markMinimapView() {
    if (minimapEl.hidden || !buckets.length) return;
    const h = rowH();
    const top = Math.floor(listEl.scrollTop / h);
    const bottom = Math.min(data.commits.length - 1, Math.ceil((listEl.scrollTop + listEl.clientHeight) / h));
    const tNew = (data.commits[Math.max(0, top)] || {}).ts || Infinity;
    const tOld = (data.commits[bottom] || {}).ts || 0;
    minimapEl.querySelectorAll('.day').forEach((el, i) => {
      const b = buckets[i];
      el.classList.toggle('inview', b.count > 0 && b.end > tOld && b.start <= tNew);
    });
  }

  let mmFrame = 0;
  listEl.addEventListener('scroll', () => {
    cancelAnimationFrame(mmFrame);
    mmFrame = requestAnimationFrame(markMinimapView);
  }, { passive: true });

  minimapEl.addEventListener('mousemove', (e) => {
    const day = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.day'));
    const tip = /** @type {HTMLElement} */ (minimapEl.querySelector('.tip'));
    if (!day || !tip) return;
    const b = buckets[Number(day.dataset.b)];
    const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const hour = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const span =
      b.end - b.start > 86400e3 ? `${fmt(b.start)} – ${fmt(b.end - 1)}` : b.end - b.start < 86400e3 ? `${fmt(b.start)} ${hour(b.start)}–${hour(b.end)}` : fmt(b.start);
    tip.textContent = `${span} · ${plural(b.count, 'commit')}`;
    tip.hidden = false;
    const r = minimapEl.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(e.clientX - r.left + 10, r.width - tip.offsetWidth - 4))}px`;
  });
  minimapEl.addEventListener('mouseleave', () => {
    const tip = /** @type {HTMLElement | null} */ (minimapEl.querySelector('.tip'));
    if (tip) tip.hidden = true;
  });
  minimapEl.addEventListener('click', (e) => {
    const day = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.day'));
    const b = day && buckets[Number(day.dataset.b)];
    if (b && b.first >= 0) select(data.commits[b.first].sha, true);
  });
  $('btnMinimap').addEventListener('click', () => {
    state.minimap = !state.minimap;
    saveState();
    renderMinimap();
  });

  // ---------- column resizing ----------

  const COL_MIN = { graph: 40, author: 60, date: 50, sha: 50 };
  function applyCols() {
    for (const k of ['author', 'date', 'sha']) {
      if (state.cols[k]) document.documentElement.style.setProperty(`--w-${k}`, `${state.cols[k]}px`);
    }
  }

  $('header').addEventListener('mousedown', (e) => {
    const grip = /** @type {HTMLElement} */ (e.target);
    if (!grip.classList.contains('grip')) return;
    e.preventDefault();
    const col = /** @type {string} */ (grip.dataset.col);
    const dir = Number(grip.dataset.dir);
    const cell = /** @type {HTMLElement} */ (grip.parentElement);
    const startX = e.clientX;
    const startW = cell.getBoundingClientRect().width;
    grip.classList.add('drag');
    document.body.classList.add('resizing');
    const move = (/** @type {MouseEvent} */ ev) => {
      const w = Math.round(Math.max(COL_MIN[col], Math.min(700, startW + (ev.clientX - startX) * dir)));
      state.cols[col] = w;
      document.documentElement.style.setProperty(col === 'graph' ? '--graph-w' : `--w-${col}`, `${w}px`);
    };
    const up = () => {
      grip.classList.remove('drag');
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      saveState();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  // Double-click a grip: back to the default width.
  $('header').addEventListener('dblclick', (e) => {
    const grip = /** @type {HTMLElement} */ (e.target);
    if (!grip.classList.contains('grip')) return;
    const col = /** @type {string} */ (grip.dataset.col);
    delete state.cols[col];
    saveState();
    if (col !== 'graph') document.documentElement.style.removeProperty(`--w-${col}`);
    render();
  });

  // ---------- events ----------

  /** Click on a branch / tag badge anywhere: focus it; "+N" lists the hidden ones. */
  function onRefClick(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    const ciEl = /** @type {HTMLElement | null} */ (t.closest('.ci[data-url]'));
    if (ciEl) {
      e.stopPropagation();
      vscode.postMessage({ type: 'openUrl', url: ciEl.dataset.url });
      return true;
    }
    const mergedEl = /** @type {HTMLElement | null} */ (t.closest('.merged-chip'));
    if (mergedEl) {
      e.stopPropagation();
      vscode.postMessage({ type: 'compareRefs', from: `${mergedEl.dataset.merge}^1`, to: mergedEl.dataset.merge });
      return true;
    }
    const prEl = /** @type {HTMLElement | null} */ (t.closest('.pr-badge'));
    if (prEl) {
      e.stopPropagation();
      vscode.postMessage({ type: 'openUrl', url: prEl.dataset.url });
      return true;
    }
    const more = /** @type {HTMLElement | null} */ (t.closest('.ref.more'));
    if (more) {
      e.stopPropagation();
      const row = /** @type {HTMLElement | null} */ (more.closest('.commit'));
      const c = row && data.commits[Number(row.dataset.i)];
      if (c) {
        showMenu(e.clientX, e.clientY, [
          { label: 'Focus on' },
          ...c.refs.map((r) => ({ label: r.name, icon: r.type === 'tag' ? 'tag' : r.type === 'remote' ? 'cloud' : 'git-branch', act: 'focus', ref: r.name, refType: r.type })),
        ]);
      }
      return true;
    }
    const ref = /** @type {HTMLElement | null} */ (t.closest('.ref'));
    if (!ref) return false;
    e.stopPropagation();
    if (e.detail > 1) return true; // second click of a double-click (= checkout)
    focusRef(/** @type {string} */ (ref.dataset.ref), /** @type {string} */ (ref.dataset.reftype));
    return true;
  }

  rowsEl.addEventListener('click', (e) => {
    if (onRefClick(e)) return;
    const t = /** @type {HTMLElement} */ (e.target);
    const row = /** @type {HTMLElement | null} */ (t.closest('.commit'));
    if (!row) return;
    // Ctrl/Cmd+click a second commit: compare the two.
    if ((e.ctrlKey || e.metaKey) && selected && selected !== row.dataset.sha && row.dataset.sha !== WORKTREE && selected !== WORKTREE) {
      return startCompare(selected, /** @type {string} */ (row.dataset.sha));
    }
    if (compareArm && compareArm !== row.dataset.sha && row.dataset.sha !== WORKTREE) {
      const a = compareArm;
      compareArm = null;
      return startCompare(a, /** @type {string} */ (row.dataset.sha));
    }
    select(row.dataset.sha, false);
  });

  rowsEl.addEventListener('mouseover', (e) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.commit'));
    if (!row || !menuEl.hidden) return;
    const sha = /** @type {string} */ (row.dataset.sha);
    clearTimeout(hideTimer);
    if (sha === cardSha) return;
    clearTimeout(cardTimer);
    // Wait before the first card; follow the pointer quickly once one is shown.
    cardTimer = setTimeout(() => showCard(sha), cardSha ? 250 : 450);
  });
  rowsEl.addEventListener('mousemove', (e) => {
    cardX = e.clientX;
    cardY = e.clientY;
  });
  rowsEl.addEventListener('mouseleave', hideCardSoon);
  // Pointer in the card: keep it (and don't switch to the row crossed on the way).
  cardEl.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    clearTimeout(cardTimer);
  });
  cardEl.addEventListener('mouseleave', hideCardSoon);
  cardEl.addEventListener('click', (e) => {
    if (onRefClick(e)) return hideCard();
    const rel = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-release]'));
    if (rel) return vscode.postMessage({ type: 'action', action: 'showRelease', ref: rel.dataset.release });
    const link = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-url]'));
    if (link) vscode.postMessage({ type: 'openUrl', url: link.dataset.url });
  });
  listEl.addEventListener('scroll', hideCard, { passive: true });
  rowsEl.addEventListener('mousedown', hideCard);

  rowsEl.addEventListener('dblclick', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const ref = /** @type {HTMLElement | null} */ (t.closest('.ref'));
    if (ref && ref.dataset.reftype === 'tag') {
      vscode.postMessage({ type: 'action', action: 'showRelease', ref: ref.dataset.ref });
    } else if (ref) {
      vscode.postMessage({ type: 'action', action: 'checkoutBranch', ref: ref.dataset.ref, refType: ref.dataset.reftype });
    }
  });

  rowsEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = /** @type {HTMLElement} */ (e.target);
    const ref = /** @type {HTMLElement | null} */ (t.closest('.ref'));
    const row = /** @type {HTMLElement | null} */ (t.closest('.commit'));
    if (!row || row.dataset.sha === WORKTREE) return;
    const c = data.commits[Number(row.dataset.i)];
    if (isStash(c)) showMenu(e.clientX, e.clientY, stashMenu(c.refs[0].name));
    else if (ref) showMenu(e.clientX, e.clientY, refMenu(ref.dataset.ref, ref.dataset.reftype));
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
    // Toolbar overflow ("…"): press the hidden toolbar button, so every action keeps its one handler.
    if (item.dataset.act && item.dataset.act.startsWith('tb:')) {
      e.stopPropagation();
      return $(item.dataset.act.slice(3)).click();
    }
    if (item.dataset.act === 'focus') return focusRef(/** @type {string} */ (item.dataset.ref), /** @type {string} */ (item.dataset.reftype));
    if (item.dataset.act === 'unfocus') return clearFocus();
    if (item.dataset.act === 'compareRefs') return vscode.postMessage({ type: 'compareRefs', from: item.dataset.ref, to: item.dataset.sha });
    if (item.dataset.act === 'compareWith') return vscode.postMessage({ type: 'compareRefs', to: item.dataset.ref || item.dataset.sha });
    if (item.dataset.act === 'comparePrevious') return vscode.postMessage({ type: 'compareRefs', to: item.dataset.ref, previous: true });
    if (item.dataset.act === 'compare') return startCompare(/** @type {string} */ (selected), /** @type {string} */ (item.dataset.sha));
    if (item.dataset.act === 'filter') return toggleFilter(/** @type {string} */ (item.dataset.ref));
    if (item.dataset.act === 'dropMerge' || item.dataset.act === 'dropRebase') {
      return vscode.postMessage({ type: 'action', action: item.dataset.act === 'dropMerge' ? 'mergeInto' : 'rebaseOnto', ref: dragged && dragged.ref, target: item.dataset.ref });
    }
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
    if (onRefClick(e)) return;
    if (t.closest('[data-act="swapCompare"]') && comparing) return startCompare(comparing.b, comparing.a);
    const file = /** @type {HTMLElement | null} */ (t.closest('.file'));
    if (file && comparing) {
      vscode.postMessage({ type: 'openCompareDiff', a: comparing.a, b: comparing.b, path: file.dataset.path, oldPath: file.dataset.old || undefined, status: file.dataset.status });
      return;
    }
    if (file) {
      vscode.postMessage({ type: 'openDiff', sha: selected, path: file.dataset.path, oldPath: file.dataset.old || undefined, status: file.dataset.status });
      return;
    }
    const link = /** @type {HTMLElement | null} */ (t.closest('[data-url]'));
    if (link) return vscode.postMessage({ type: 'openUrl', url: link.dataset.url });
    const rel = /** @type {HTMLElement | null} */ (t.closest('[data-release]'));
    if (rel) return vscode.postMessage({ type: 'action', action: 'showRelease', ref: rel.dataset.release });
    const go = /** @type {HTMLElement | null} */ (t.closest('[data-goto]'))?.dataset.goto;
    if (go) return select(go, true);
    const act = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
    if (act && act.dataset.act === 'selMore') {
      // Less frequent commit actions: the same 'action' messages, from the shared menu.
      e.stopPropagation();
      const r = act.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        { label: 'Create a branch here…', icon: 'git-branch', act: 'createBranch', sha: selected },
        { label: 'Revert this commit', icon: 'discard', act: 'revert', sha: selected },
        '-',
        { label: 'Open on remote', icon: 'link-external', act: 'openRemote', sha: selected },
      ]);
      if (e.detail === 0) /** @type {HTMLElement | null} */ (menuEl.querySelector('.item'))?.focus();
      return;
    }
    if (act && act.dataset.act === 'explainCommit') return vscode.postMessage({ type: 'explain', sha: selected });
    if (act && act.dataset.act === 'stopExplain') return vscode.postMessage({ type: 'stopExplain' });
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
    hideCard();
    if (e.target === searchEl || e.target === pickerInput) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
      return;
    }
    if (e.key === 'Escape') {
      if (compareArm) {
        compareArm = null;
        return notice('Compare cancelled.');
      }
      if (!$('keysCard').hidden) $('keysCard').hidden = true;
      else if (!menuEl.hidden) menuEl.hidden = true;
      else if (!pickerEl.hidden) closePicker();
      else if (focus) clearFocus();
      else closeDetails();
      return;
    }
    if (!data) return;
    const t = /** @type {HTMLElement} */ (e.target);
    const inInput = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    const onButton = !!t && !!t.closest && !!t.closest('button, a, [role="button"]');
    const action = keys.keyAction(e, inInput, onButton);
    if (!action) return;
    e.preventDefault();
    onKeyAction(action);
  });

  // ---------- keyboard navigation (media/graphKeys.js) ----------

  // @ts-ignore
  const keys = window.glKeys;
  /** Commit picked with "c": the next commit chosen (click or Enter) is compared with it. */
  let compareArm = /** @type {string | null} */ (null);

  function goTo(/** @type {number} */ i) {
    if (i < 0) return false;
    const sha = data.commits[i].sha;
    select(sha, false);
    const row = rowsEl.querySelector(`.commit[data-sha="${sha}"]`);
    row && row.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function onKeyAction(/** @type {string} */ action) {
    const commits = data.commits;
    const i = commits.findIndex((/** @type {any} */ c) => c.sha === selected);
    switch (action) {
      case 'help':
        return toggleKeysCard();
      case 'parent':
        if (i >= 0 && !goTo(keys.parentIndex(commits, i))) notice('The parent is not loaded: scroll down to load more history.');
        return;
      case 'child':
        if (i >= 0 && !goTo(keys.childIndex(commits, i))) notice('No child of this commit in the graph.');
        return;
      case 'mergeBase':
        if (selected && selected !== WORKTREE) vscode.postMessage({ type: 'mergeBase', sha: selected });
        return;
      case 'compare':
        if (!selected || selected === WORKTREE) return;
        compareArm = selected;
        notice('Compare: pick the second commit (click it, or move to it and press Enter).');
        return;
      case 'toggleDetails':
        if (!selected) return void goTo(0);
        if (compareArm && compareArm !== selected) {
          const a = compareArm;
          compareArm = null;
          return startCompare(a, selected);
        }
        if (!detailsEl.hidden) detailsEl.hidden = true;
        else select(selected, false);
        return;
      default:
        goTo(keys.moveIndex(action, i, commits.length, Math.floor(listEl.clientHeight / rowH())));
    }
  }

  /** Short message over the list (a target that is not loaded, compare mode…). */
  let noticeTimer = 0;
  function notice(/** @type {string} */ text) {
    const el = $('notice');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = /** @type {any} */ (setTimeout(() => (el.hidden = true), 3000));
  }

  function toggleKeysCard() {
    const card = $('keysCard');
    card.hidden = !card.hidden;
  }
  $('btnKeys').addEventListener('click', toggleKeysCard);

  // ---------- toolbar overflow ("…") ----------

  function moreMenu() {
    return [
      { label: focus ? `Focus: ${focus.name}…` : 'Focus on a branch…', icon: 'git-branch', act: 'tb:btnBranches' },
      { label: 'Compare branches or tags…', icon: 'git-compare', act: 'tb:btnCompare' },
      ...(isCompact() ? [] : [{ label: state.minimap ? 'Hide activity chart' : 'Show activity chart', icon: 'pulse', act: 'tb:btnMinimap' }]),
      '-',
      { label: 'Refresh', icon: 'refresh', act: 'tb:btnRefresh' },
      { label: 'Keyboard shortcuts (?)', icon: 'keyboard', act: 'tb:btnKeys' },
    ];
  }
  $('btnOverflow').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menuEl.hidden) return void (menuEl.hidden = true);
    closePicker();
    const r = $('btnOverflow').getBoundingClientRect();
    showMenu(r.right - 220, r.bottom + 4, moreMenu());
    // Opened from the keyboard: focus the first item (arrows move, Enter runs, Esc closes).
    if (e.detail === 0) /** @type {HTMLElement | null} */ (menuEl.querySelector('.item'))?.focus();
  });
  menuEl.addEventListener('keydown', (e) => {
    const its = /** @type {HTMLElement[]} */ ([...menuEl.querySelectorAll('.item')]);
    const i = its.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      its[(i + (e.key === 'ArrowDown' ? 1 : its.length - 1)) % its.length]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (i >= 0) its[i].click();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      menuEl.hidden = true;
      $('btnOverflow').focus();
    }
  });
  $('keysCard').addEventListener('click', () => ($('keysCard').hidden = true));

  // Hover a changed file in the details pane: preview of its diff (in this commit, or between the compared commits).
  // @ts-ignore
  const diffPreview = window.gitlandDiffPreview({
    vscode,
    root: detailsEl,
    selector: '.file',
    request: (row) =>
      comparing
        ? { a: comparing.a, b: comparing.b, path: row.dataset.path, oldPath: row.dataset.old || undefined }
        : selected
          ? { sha: selected, path: row.dataset.path, oldPath: row.dataset.old || undefined, status: row.dataset.status }
          : null,
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'preview') {
      diffPreview.receive(m);
      return;
    }
    if (m.type === 'data') {
      document.body.classList.remove('no-data');
      diffPreview.clear();
      // No commit yet (new repository): one empty state instead of an empty list.
      const empty = !m.commits.some((/** @type {any} */ c) => c.sha !== WORKTREE);
      $('state').hidden = !empty;
      if (empty) $('state').outerHTML = `<div id="state">${stateHtml({ state: 'empty', icon: 'git-commit', title: 'No commit yet', text: 'Make the first commit from the Changes view.' })}</div>`;
      const scroll = listEl.scrollTop;
      data = m;
      detailsCache.clear();
      hideCard();
      if (m.select) selected = m.select;
      if (selected && !data.commits.some((c) => c.sha === selected)) {
        detailsEl.hidden = true;
        selected = null;
      }
      render();
      if (m.select) select(m.select, true);
      if (m.focus) {
        focus = { name: m.focus, type: '' };
        applyFocus();
      }
      else {
        listEl.scrollTop = scroll;
        if (selected) vscode.postMessage({ type: 'select', sha: selected });
      }
    } else if (m.type === 'avatars') {
      data && (data.avatars = { ...(data.avatars || {}), ...m.avatars });
      for (const [email, url] of Object.entries(m.avatars)) {
        document.querySelectorAll(`.avatar[data-email="${CSS.escape(email)}"]`).forEach((el) => {
          if (el instanceof HTMLImageElement) {
            el.src = url;
          } else {
            const img = document.createElement('img');
            for (const a of el.attributes) img.setAttribute(a.name, a.value);
            img.src = url;
            el.replaceWith(img);
          }
        });
      }
    } else if (m.type === 'explainStart' || m.type === 'explainText' || m.type === 'explainDone') {
      if (m.sha !== selected) return;
      const card = document.getElementById('explainCard');
      const body = document.getElementById('explainBody');
      if (!card || !body) return;
      card.hidden = false;
      card.classList.toggle('busy', m.type !== 'explainDone');
      if (m.type === 'explainStart') body.innerHTML = '<span class="gl-skel"></span>';
      else if (typeof m.text === 'string') body.innerHTML = markdown(m.text);
    } else if (m.type === 'ci') {
      ci = new Map();
      const seen = new Set();
      for (const r of m.runs) {
        const key = r.sha + r.name;
        if (seen.has(key)) continue; // runs are newest first: keep the latest per pipeline
        seen.add(key);
        ci.set(r.sha, [...(ci.get(r.sha) || []), r]);
      }
      const scroll = listEl.scrollTop;
      render();
      listEl.scrollTop = scroll;
    } else if (m.type === 'prs') {
      prs = new Map(m.prs.map((p) => [p.branch, p]));
      const scroll = listEl.scrollTop;
      render();
      listEl.scrollTop = scroll;
    } else if (m.type === 'refs') {
      repoRefs = m.refs;
      if (!pickerEl.hidden) renderPicker();
    } else if (m.type === 'compare') {
      showCompare(m);
    } else if (m.type === 'details' || m.type === 'hover') {
      detailsCache.set(m.sha, m.details);
      if (m.type === 'details') showDetails(m.sha, m.details);
      if (m.sha === cardSha) {
        const c = data.commits.find((x) => x.sha === m.sha);
        if (c) {
          cardEl.innerHTML = cardHtml(c, m.details);
          placeCard();
        }
      }
    } else if (m.type === 'jump') {
      const i = data ? data.commits.findIndex((/** @type {any} */ c) => c.sha === m.sha) : -1;
      if (i >= 0) {
        select(m.sha, true);
        notice(`Merge base with HEAD: ${m.sha.slice(0, 7)}`);
      } else notice(`Merge base ${m.sha.slice(0, 7)} is older than the loaded commits.`);
    } else if (m.type === 'notice') {
      notice(m.text);
    } else if (m.type === 'error') {
      $('state').hidden = false;
      $('state').outerHTML = `<div id="state">${stateHtml({ state: 'error', title: m.message })}</div>`;
    }
  });

  // Picture failed to load (offline, blocked…): show the author's initials instead.
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains('avatar')) return;
      const span = document.createElement('span');
      for (const a of img.attributes) if (a.name !== 'src') span.setAttribute(a.name, a.value);
      span.textContent = img.dataset.initials || '?';
      img.replaceWith(span);
    },
    true,
  );

  let resizeTimer;
  let wasCompact = isCompact();
  // The narrow layout follows the width from the start (loading, empty repository and error states too), not only data renders.
  document.body.classList.toggle('compact', isCompact());
  document.body.classList.add('no-data');
  window.addEventListener('resize', () => {
    document.body.classList.toggle('compact', isCompact());
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (data) renderMinimap();
      if (data && isCompact() !== wasCompact) {
        wasCompact = isCompact();
        const scroll = listEl.scrollTop;
        render();
        listEl.scrollTop = scroll;
      }
    }, 120);
  });

  if (state.selected) selected = state.selected;
  applyCols();
  vscode.postMessage({ type: 'ready', filters: state.filters || {} });
})();
