// @ts-check
// Shared by the ticket, pull request and new pull request pages: safe rich text rendering.
(function () {
  const esc = (/** @type {string} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  // ---------- rich text ----------

  const ALLOWED = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'UL', 'OL', 'LI', 'A', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'HR', 'DIV', 'SPAN', 'SUB', 'SUP']);

  /** Keeps a whitelist of tags without attributes (except https links): Azure DevOps HTML fields. */
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const clean = (/** @type {Node} */ node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const el = /** @type {HTMLElement} */ (child);
          if (el.tagName === 'IMG') {
            // Attachments need authentication: show a link instead of a broken picture.
            const src = el.getAttribute('src') || '';
            const span = doc.createElement('span');
            span.className = 'img-ref';
            span.textContent = '🖼 image';
            if (/^https:\/\//.test(src)) span.setAttribute('data-url', src);
            el.replaceWith(span);
            continue;
          }
          if (!ALLOWED.has(el.tagName)) {
            if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(el.tagName)) el.remove();
            else {
              clean(el);
              el.replaceWith(...el.childNodes);
            }
            continue;
          }
          const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
          for (const a of [...el.attributes]) el.removeAttribute(a.name);
          if (href && /^https:\/\//.test(href)) el.setAttribute('data-url', href);
          clean(el);
        }
      }
    };
    const root = /** @type {HTMLElement} */ (doc.body.firstChild);
    clean(root);
    return root.innerHTML;
  }

  /** Small markdown renderer (GitHub issues): escaped first, a few constructs recognized. */
  function markdown(text) {
    const inline = (t) =>
      t
        .split(/(`[^`]+`)/g)
        .map((p, i) =>
          i % 2
            ? `<code>${p.slice(1, -1)}</code>`
            : p
                .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
                .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
                .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a data-url="$2">$1</a>')
                .replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, '$1<a data-url="$2">$2</a>'),
        )
        .join('');
    let html = '';
    let list = '';
    let para = [];
    const flush = () => {
      if (para.length) html += `<p>${inline(para.join(' '))}</p>`;
      para = [];
    };
    const endList = () => {
      if (list) html += `</${list}>`;
      list = '';
    };
    const lines = esc(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if (/^\s*```/.test(line)) {
        flush();
        endList();
        const code = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
        html += `<pre><code>${code.join('\n')}</code></pre>`;
      } else if ((m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x)\]\s+)?(.*)$/i.exec(line))) {
        flush();
        const kindOf = /^\s*\d/.test(line) ? 'ol' : 'ul';
        if (list !== kindOf) {
          endList();
          html += `<${kindOf}>`;
          list = kindOf;
        }
        html += `<li>${m[1] !== undefined ? (m[1].toLowerCase() === 'x' ? '☑ ' : '☐ ') : ''}${inline(m[2])}</li>`;
      } else if ((m = /^#{1,6}\s+(.*)$/.exec(line))) {
        flush();
        endList();
        html += `<h4>${inline(m[1])}</h4>`;
      } else if ((m = /^&gt;\s?(.*)$/.exec(line))) {
        flush();
        endList();
        html += `<blockquote>${inline(m[1])}</blockquote>`;
      } else if (!line.trim()) {
        flush();
        endList();
      } else {
        endList();
        para.push(line.trim());
      }
    }
    flush();
    endList();
    return html;
  }

  // @ts-ignore
  window.gitlandRich = { sanitize, markdown, render: (format, body) => (format === 'html' ? sanitize(body) : markdown(body)) };
})();
