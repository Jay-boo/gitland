// Recording only (test/demo/record.mjs loads it next to Gitland): answers the Azure DevOps API of
// the fictional contoso/Atlas project from memory, so the GIFs show tickets, pull requests and
// pipelines without a real account, and offers a canned language model for ✨ Explain.
// Everything else (avatars…) goes to the network as usual.
const vscode = require('vscode');
const { execFileSync } = require('child_process');

const ME = { id: 'u-maya', displayName: 'Maya Chen', uniqueName: 'maya.chen@contoso.com' };
const P = {
  lucas: { id: 'u-lucas', displayName: 'Lucas Martin', uniqueName: 'lucas.martin@contoso.com' },
  sofia: { id: 'u-sofia', displayName: 'Sofia Alvarez', uniqueName: 'sofia.alvarez@contoso.com' },
  kenji: { id: 'u-kenji', displayName: 'Kenji Watanabe', uniqueName: 'kenji.watanabe@contoso.com' },
  tom: { id: 'u-tom', displayName: 'Tom Becker', uniqueName: 'tom.becker@contoso.com' },
  priya: { id: 'u-priya', displayName: 'Priya Raman', uniqueName: 'priya.raman@contoso.com' },
};
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

const WORK_ITEMS = [
  { id: 1262, type: 'User Story', state: 'New', title: 'Show the estimated delivery date at checkout', to: ME, points: 5,
    description: '<p>Shoppers abandon the cart when they do not know when the order arrives. Show <b>"Arrives Tue, Nov 4"</b> under the shipping method, from the carrier SLA.</p>',
    criteria: '<ul><li>Date shown for every shipping method</li><li>Weekends and public holidays skipped</li><li>Falls back to "3–5 business days" when the carrier does not answer</li></ul>' },
  { id: 1263, type: 'Bug', state: 'Active', title: 'Coupon field accepts lowercase codes but the API rejects them', to: ME, severity: '2 - High',
    repro: '<ol><li>Add any product</li><li>Type <code>autumn20</code> in the coupon field</li><li>Checkout fails with 422</li></ol>' },
  { id: 1251, type: 'User Story', state: 'Active', title: 'Pay part of an order with a gift card', to: P.lucas, points: 8 },
  { id: 1256, type: 'User Story', state: 'Resolved', title: 'Keep the cart between devices', to: P.sofia, points: 5 },
  { id: 1258, type: 'Bug', state: 'Active', title: 'Prices use the en-US format for every shopper', to: P.priya, severity: '3 - Medium' },
  { id: 1265, type: 'Task', state: 'New', title: 'Add delivery-date tests for bank holidays', to: ME },
  { id: 1270, type: 'Feature', state: 'New', title: 'Wishlists you can share', to: ME },
];

const PRS = [
  { pullRequestId: 55, title: 'Gift cards: pay part of the order (AB#1251)', sourceRefName: 'refs/heads/feature/1251-gift-cards', targetRefName: 'refs/heads/develop',
    createdBy: P.lucas, creationDate: day(1), reviewers: [{ ...ME, vote: 0, isRequired: true }, { ...P.kenji, vote: 5 }], workItems: [1251],
    description: '## What\n\nShoppers can enter a gift card code at checkout and pay the rest by card.\n\n## How to test\n\n1. Use the code `GIFT-50-DEMO`\n2. The total drops by 50 €\n\nCloses AB#1251',
    threads: [{ id: 1, status: 'active', file: '/src/checkout/cart.ts', line: 38, by: P.kenji, at: day(0.5), text: 'Should `remaining()` refuse a negative balance instead of clamping it to 0?' },
      { id: 1, by: P.lucas, at: day(0.3), text: 'Good catch, the API never sends one, but I will add a guard.' }] },
  { pullRequestId: 56, title: 'Keep the cart between devices (AB#1256)', sourceRefName: 'refs/heads/feature/1256-saved-carts', targetRefName: 'refs/heads/develop',
    createdBy: P.sofia, creationDate: day(3), reviewers: [{ ...P.kenji, vote: 10 }, { ...ME, vote: 10 }], workItems: [1256], description: 'Saves the cart in local storage and merges it with the server cart on sign-in.' },
  { pullRequestId: 54, title: 'Upgrade zod to 3.23 and drop the custom date parser', sourceRefName: 'refs/heads/chore/zod-3-23', targetRefName: 'refs/heads/develop',
    createdBy: P.tom, creationDate: day(6), reviewers: [{ ...P.priya, vote: -5 }], workItems: [], isDraft: false, description: 'Removes 120 lines.' },
];
let nextPr = 57;

const BUILDS = [
  { id: 9031, branch: 'feature/1251-gift-cards', result: 'failed', at: 0.2, pr: 55 },
  { id: 9030, branch: 'develop', result: 'succeeded', at: 0.4 },
  { id: 9029, branch: 'feature/1256-saved-carts', result: 'succeeded', at: 2, pr: 56 },
  { id: 9027, branch: 'main', result: 'succeeded', at: 9 },
];

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function workItem(w, expand) {
  const fields = {
    'System.Id': w.id, 'System.Title': w.title, 'System.State': w.state, 'System.WorkItemType': w.type, 'System.TeamProject': 'Atlas',
    'System.AssignedTo': w.to, 'System.CreatedBy': P.tom, 'System.IterationPath': 'Atlas\\Sprint 42', 'System.AreaPath': 'Atlas\\Checkout',
    'Microsoft.VSTS.Common.Priority': 2,
  };
  if (expand) {
    Object.assign(fields, {
      'System.Description': w.description, 'Microsoft.VSTS.Common.AcceptanceCriteria': w.criteria, 'Microsoft.VSTS.TCM.ReproSteps': w.repro,
      'Microsoft.VSTS.Scheduling.StoryPoints': w.points, 'Microsoft.VSTS.Common.Severity': w.severity,
    });
  }
  const relations = expand ? PRS.filter((p) => p.workItems.includes(w.id)).map((p) => ({ rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/Atlas%2Fatlas-web%2F${p.pullRequestId}`, attributes: { name: 'Pull Request' } })) : undefined;
  return { id: w.id, fields, relations };
}

function git(args) {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    return execFileSync('git', args, { cwd }).toString().trim();
  } catch {
    return '';
  }
}
function prCommits(pr) {
  const out = git(['log', '--format=%H%x1f%s%x1f%an%x1f%aI', `${pr.targetRefName.slice(11)}..${pr.sourceRefName.slice(11)}`]);
  return out ? out.split('\n').map((l) => { const [commitId, comment, name, date] = l.split('\x1f'); return { commitId, comment, author: { name, date } }; }) : [];
}

/** Answers one Azure DevOps request, or undefined to let it through. */
async function azure(url, init) {
  const u = new URL(url);
  const p = decodeURIComponent(u.pathname);
  const method = (init?.method || 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(init.body) : undefined;
  await sleep(120 + Math.random() * 180);

  if (p.endsWith('/_apis/connectionData')) {
    return json({ authenticatedUser: { id: ME.id, providerDisplayName: ME.displayName, properties: { Account: { $value: ME.uniqueName } } } });
  }
  if (u.hostname === 'vssps.dev.azure.com' || p.includes('/IdentityPicker/')) {
    return json(u.searchParams.get('identityIds') ? { value: [{ memberOf: [] }] } : { value: [], results: [{ identities: [] }] });
  }
  if (p.endsWith('/_apis/wit/wiql')) {
    const q = String(body?.query || '');
    const text = /CONTAINS '([^']*)'/.exec(q)?.[1]?.toLowerCase();
    const ids = WORK_ITEMS.filter((w) => (text ? w.title.toLowerCase().includes(text) : w.to === ME && w.state !== 'Closed')).map((w) => ({ id: w.id }));
    return json({ workItems: ids });
  }
  if (p.endsWith('/_apis/wit/workitems') && u.searchParams.get('ids')) {
    const ids = u.searchParams.get('ids').split(',').map(Number);
    return json({ value: WORK_ITEMS.filter((w) => ids.includes(w.id)).map((w) => workItem(w)) });
  }
  let m = /\/_apis\/wit\/workitems\/(\d+)$/i.exec(p);
  if (m) {
    const w = WORK_ITEMS.find((x) => x.id === Number(m[1]));
    if (!w) return json({ message: `Work item ${m[1]} does not exist.` }, 404);
    if (method === 'PATCH') {
      for (const op of body || []) if (op.path === '/fields/System.State') w.state = op.value;
    }
    return json(workItem(w, u.searchParams.get('$expand') === 'all'));
  }
  if (/\/_apis\/wit\/workItems\/\d+\/comments$/i.test(p)) {
    return json(method === 'POST' ? {} : { comments: [{ text: 'Design is in Figma, page "Checkout v3".', createdBy: P.tom, createdDate: day(4) }] });
  }
  if (/\/_apis\/wit\/workitemtypes\/[^/]+\/states$/i.test(p)) {
    return json({ value: [{ name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }, { name: 'Resolved', category: 'Resolved' }, { name: 'Closed', category: 'Completed' }] });
  }
  if (p.endsWith('/_apis/projects')) {
    return json({ value: [{ name: 'Atlas', description: 'Storefront and checkout' }, { name: 'Atlas Mobile' }] });
  }
  if (/\/_apis\/git\/repositories\/[^/]+$/.test(p)) {
    return json({ id: 'repo-atlas-web', name: 'atlas-web' });
  }
  if (p.endsWith('/pullrequests') && method === 'POST') {
    const pr = { pullRequestId: nextPr++, title: body.title, description: body.description, sourceRefName: body.sourceRefName, targetRefName: body.targetRefName,
      isDraft: body.isDraft, createdBy: ME, creationDate: new Date().toISOString(), reviewers: [], workItems: (body.workItemRefs || []).map((w) => Number(w.id)) };
    PRS.unshift(pr);
    return json(pr, 201);
  }
  if (p.endsWith('/pullrequests')) {
    return json({ value: PRS });
  }
  m = /\/pullrequests\/(\d+)(\/[a-z]+)?$/i.exec(p);
  if (m) {
    const pr = PRS.find((x) => x.pullRequestId === Number(m[1]));
    if (!pr) return json({ message: 'Not found' }, 404);
    const sub = m[2]?.toLowerCase();
    if (sub === '/workitems') return json({ value: pr.workItems.map((id) => ({ id: String(id) })) });
    if (sub === '/commits') return json({ value: prCommits(pr) });
    if (sub === '/threads') {
      const threads = new Map();
      for (const t of pr.threads || []) {
        const th = threads.get(t.id) || { id: t.id, status: t.status, threadContext: t.file ? { filePath: t.file, rightFileStart: { line: t.line } } : undefined, comments: [] };
        th.comments.push({ content: t.text, commentType: 'text', author: t.by, publishedDate: t.at });
        threads.set(t.id, th);
      }
      return json({ value: [...threads.values()] });
    }
    return json({ ...pr, status: 'active', mergeStatus: 'succeeded', lastMergeSourceCommit: { commitId: git(['rev-parse', pr.sourceRefName.slice(11)]) } });
  }
  if (/\/pullRequests\/\d+\/reviewers\//i.test(p)) {
    return json({});
  }
  if (p.endsWith('/_apis/build/builds')) {
    const branch = u.searchParams.get('branchName');
    const runs = BUILDS.filter((b) => !branch || `refs/heads/${b.branch}` === branch || `refs/pull/${b.pr}/merge` === branch);
    return json({ value: runs.map((b) => ({ id: b.id, definition: { id: 3, name: 'atlas-web CI' }, status: 'completed', result: b.result, sourceVersion: git(['rev-parse', b.branch]),
      sourceBranch: `refs/heads/${b.branch}`, startTime: day(b.at + 0.01), finishTime: day(b.at), _links: { web: { href: `https://dev.azure.com/contoso/Atlas/_build/results?buildId=${b.id}` } } })) });
  }
  m = /\/_apis\/build\/builds\/(\d+)\/timeline$/.exec(p);
  if (m) {
    const failed = BUILDS.find((b) => b.id === Number(m[1]))?.result === 'failed';
    const task = (id, name, order, result = 'succeeded') => ({ id, parentId: 'job', type: 'Task', name, state: 'completed', result, order, log: { id: order + 1 } });
    return json({ records: [
      { id: 'job', type: 'Job', name: 'Build and test', state: 'completed', result: failed ? 'failed' : 'succeeded', order: 1, log: { id: 1 } },
      task('t1', 'Checkout', 1), task('t2', 'Install Node 20', 2), task('t3', 'npm ci', 3), task('t4', 'Build', 4),
      task('t5', 'Unit tests', 5, failed ? 'failed' : 'succeeded'), task('t6', 'End-to-end tests', 6, failed ? 'skipped' : 'succeeded'),
    ] });
  }
  if (/\/logs\/\d+$/.test(p)) {
    return new Response(' ✓ src/checkout/cart.test.ts (12 tests)\n ✗ src/checkout/giftCards.test.ts > remaining() never goes below zero\n   AssertionError: expected -500 to be 0\n', { headers: { 'content-type': 'text/plain' } });
  }
  return json({ message: `demo mock: no answer for ${method} ${p}` }, 404);
}

const EXPLAIN = `1. **Aug 2026, Maya Chen** wrote the first cart model: \`total()\` simply returned the subtotal.
2. **PR 41 — Coupon codes in the cart (AB#1204), Lucas Martin** added the \`coupon\` field and the discount, skipped when the coupon has expired (\`isValid\`).
3. **PR 43 / AB#1210, Priya Raman** fixed totals like 19.999 €: money is kept in whole cents, and the discount is now rounded half-up *before* it is subtracted.

So the early \`return sub\` protects expired or missing coupons, and the \`Math.round\` is the rounding fix from AB#1210 — keep it if you touch this function.`;

const RELEASE_NOTES = `## 1.2.0 — October 2026

### New
- **Order history** in the account page, with status chips and paging (PR 49, AB#1240)
- **Dark mode** that follows the system, plus a switch in the header (PR 50, AB#1244)

### Fixed
- Sessions expired after 15 seconds instead of 15 minutes (PR 47, AB#1231)

### Under the hood
- Vite 5.4 and Vitest 2.1, npm cache in CI (PR 51)`;

const COMMIT_MSG = 'Show the estimated delivery date under each shipping method (AB#1262)';

exports.activate = function (context) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (/^https:\/\/([a-z]+\.)?dev\.azure\.com\//.test(url)) {
      return azure(url, init);
    }
    return real(input, init);
  };

  if (vscode.lm?.registerLanguageModelChatProvider) {
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider('gitland-demo', {
        provideLanguageModelChatInformation: async () => [
          { id: 'demo', name: 'Demo model', family: 'demo', version: '1', maxInputTokens: 100000, maxOutputTokens: 4000, capabilities: {} },
        ],
        provideLanguageModelChatResponse: async (_model, messages, _options, progress) => {
          const prompt = messages.map((m) => m.content.map((c) => c.value ?? '').join('')).join('\n');
          const text = /release notes|changelog/i.test(prompt) ? RELEASE_NOTES : /commit message/i.test(prompt) ? COMMIT_MSG : EXPLAIN;
          for (const word of text.match(/\S+\s*/g)) {
            progress.report(new vscode.LanguageModelTextPart(word));
            await sleep(22);
          }
        },
        provideTokenCount: async (_model, text) => Math.ceil(String(typeof text === 'string' ? text : JSON.stringify(text)).length / 4),
      }),
    );
  }
};
