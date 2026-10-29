// Builds the fictional "atlas-web" repository the README GIFs are recorded on: six authors, four
// months of feature / fix / hotfix / release branches merged through Azure DevOps-style pull
// requests, tags, open branches, a stash and uncommitted changes. Deterministic (fixed dates).
//   node test/demo/make-repo.mjs [dir]      default: test/demo/out/atlas-web
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] || path.join(here, 'out/atlas-web'));

const PEOPLE = {
  maya: ['Maya Chen', 'maya.chen@contoso.com'],
  lucas: ['Lucas Martin', 'lucas.martin@contoso.com'],
  priya: ['Priya Raman', 'priya.raman@contoso.com'],
  tom: ['Tom Becker', 'tom.becker@contoso.com'],
  sofia: ['Sofia Alvarez', 'sofia.alvarez@contoso.com'],
  kenji: ['Kenji Watanabe', 'kenji.watanabe@contoso.com'],
};

let clock = Date.parse('2026-08-03T09:12:00+02:00');
/** Moves the clock forward by `days` (fractional) and a pseudo-random part of a working day. */
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function later(days = 2.1) {
  clock += days * 86400000 + Math.floor(rnd() * 5 * 3600000);
  const d = new Date(clock);
  if (d.getUTCDay() === 6) clock += 2 * 86400000;
  if (d.getUTCDay() === 0) clock += 86400000;
  return new Date(clock).toISOString();
}

function git(args, env = {}) {
  return execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
function as(who, days) {
  const [name, email] = PEOPLE[who];
  const date = later(days);
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

// ---- files are built from named blocks so each commit can add or rewrite one of them ----
const files = {};
function block(file, name, text) {
  (files[file] ??= new Map()).set(name, text.replace(/^\n/, ''));
  const out = [...files[file].values()].join('\n');
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), out.endsWith('\n') ? out : out + '\n');
}
function commit(who, msg, edit, days) {
  edit();
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg], as(who, days));
}
const checkout = (b) => git(['checkout', '-q', b]);
const branch = (b, from) => git(['checkout', '-q', '-b', b, from]);
function merge(b, into, who, pr, title) {
  checkout(into);
  git(['merge', '-q', '--no-ff', b, '-m', `Merged PR ${pr}: ${title}`], as(who, 0.2));
}
const tag = (t, msg, who) => git(['tag', '-a', t, '-m', msg], as(who, 0));

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'Maya Chen']);
git(['config', 'user.email', 'maya.chen@contoso.com']);
git(['remote', 'add', 'origin', 'https://dev.azure.com/contoso/Atlas/_git/atlas-web']);

const pkg = (v) => `{
  "name": "atlas-web",
  "version": "${v}",
  "private": true,
  "scripts": { "dev": "vite", "build": "tsc && vite build", "test": "vitest run" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1", "zod": "^3.23.8" },
  "devDependencies": { "typescript": "^5.6.3", "vite": "^5.4.10", "vitest": "^2.1.4" }
}`;

// ---------------------------------------------------------------- v1.0.0 on main
commit('maya', 'Initial commit: Vite + React shop skeleton', () => {
  block('package.json', 'all', pkg('1.0.0'));
  block('README.md', 'intro', `# Atlas Web\n\nThe Contoso Atlas storefront: catalogue, cart and checkout.\n`);
  block('src/main.tsx', 'all', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { App } from './App';\n\ncreateRoot(document.getElementById('root')!).render(<App />);`);
  block('src/App.tsx', 'all', `import { Catalogue } from './catalogue/Catalogue';\nimport { CartDrawer } from './checkout/CartDrawer';\n\nexport function App() {\n  return (\n    <>\n      <Catalogue />\n      <CartDrawer />\n    </>\n  );\n}`);
}, 0);
commit('maya', 'Add the cart model', () => {
  block('src/checkout/cart.ts', 'head', `import { Money, money, add, multiply } from '../shared/money';\n`);
  block('src/checkout/cart.ts', 'types', `
export interface CartLine {
  sku: string;
  name: string;
  unitPrice: Money;
  quantity: number;
}

export interface Cart {
  lines: CartLine[];
  currency: string;
}
`);
  block('src/checkout/cart.ts', 'addLine', `
/** Adds a product, or raises the quantity when it is already in the cart. */
export function addLine(cart: Cart, line: CartLine): Cart {
  const existing = cart.lines.find((l) => l.sku === line.sku);
  if (existing) {
    return { ...cart, lines: cart.lines.map((l) => (l.sku === line.sku ? { ...l, quantity: l.quantity + line.quantity } : l)) };
  }
  return { ...cart, lines: [...cart.lines, line] };
}
`);
  block('src/checkout/cart.ts', 'subtotal', `
export function subtotal(cart: Cart): Money {
  return cart.lines.reduce((sum, l) => add(sum, multiply(l.unitPrice, l.quantity)), money(0, cart.currency));
}
`);
  block('src/checkout/cart.ts', 'total', `
export function total(cart: Cart): Money {
  return subtotal(cart);
}
`);
  block('src/shared/money.ts', 'all', `export interface Money {\n  cents: number;\n  currency: string;\n}\n\nexport const money = (amount: number, currency: string): Money => ({ cents: amount * 100, currency });\nexport const add = (a: Money, b: Money): Money => ({ cents: a.cents + b.cents, currency: a.currency });\nexport const multiply = (a: Money, n: number): Money => ({ cents: a.cents * n, currency: a.currency });`);
});
commit('tom', 'Set up CI pipeline and lint rules', () => {
  block('azure-pipelines.yml', 'all', `trigger:\n  branches:\n    include: [main, develop, release/*]\n\npool:\n  vmImage: ubuntu-latest\n\nsteps:\n  - task: NodeTool@0\n    inputs: { versionSpec: '20.x' }\n  - script: npm ci && npm run build && npm test\n    displayName: Build and test`);
  block('.eslintrc.json', 'all', `{ "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"] }`);
});
commit('kenji', 'Catalogue page with product grid', () => {
  block('src/catalogue/Catalogue.tsx', 'all', `import { useProducts } from '../api/client';\nimport { ProductCard } from './ProductCard';\n\nexport function Catalogue() {\n  const products = useProducts();\n  return (\n    <section className="grid">\n      {products.map((p) => <ProductCard key={p.sku} product={p} />)}\n    </section>\n  );\n}`);
  block('src/api/client.ts', 'head', `const BASE = import.meta.env.VITE_API_URL ?? '/api';\n`);
  block('src/api/client.ts', 'get', `
export async function get<T>(path: string): Promise<T> {
  const res = await fetch(\`\${BASE}\${path}\`, { credentials: 'include' });
  if (!res.ok) throw new Error(\`GET \${path}: \${res.status}\`);
  return res.json() as Promise<T>;
}
`);
});
commit('maya', 'Session handling with refresh tokens', () => {
  block('src/auth/session.ts', 'all', `const IDLE_TIMEOUT_MS = 15 * 60 * 1000;\n\nlet lastActivity = Date.now();\n\nexport function touch() {\n  lastActivity = Date.now();\n}\n\nexport function isExpired(now = Date.now()) {\n  return now - lastActivity > IDLE_TIMEOUT_MS;\n}`);
});
tag('v1.0.0', 'Atlas Web 1.0.0', 'maya');

// ---------------------------------------------------------------- develop + v1.1
branch('develop', 'main');
commit('tom', 'Add develop branch policies to the pipeline', () => {
  block('azure-pipelines.yml', 'pr', `\npr:\n  branches:\n    include: [develop]`);
});

branch('feature/1204-coupon-codes', 'develop');
commit('lucas', 'Coupon model and validation (AB#1204)', () => {
  block('src/checkout/coupons.ts', 'all', `import { z } from 'zod';\n\nexport const Coupon = z.object({\n  code: z.string().regex(/^[A-Z0-9]{4,12}$/),\n  percentOff: z.number().min(1).max(90),\n  expiresAt: z.string().datetime(),\n});\nexport type Coupon = z.infer<typeof Coupon>;\n\nexport function isValid(c: Coupon, now = new Date()) {\n  return new Date(c.expiresAt) > now;\n}`);
});
commit('lucas', 'Apply the coupon to the cart total (AB#1204)', () => {
  block('src/checkout/cart.ts', 'head', `import { Money, money, add, multiply } from '../shared/money';\nimport { Coupon, isValid } from './coupons';\n`);
  block('src/checkout/cart.ts', 'types', `
export interface CartLine {
  sku: string;
  name: string;
  unitPrice: Money;
  quantity: number;
}

export interface Cart {
  lines: CartLine[];
  currency: string;
  coupon?: Coupon;
}
`);
  block('src/checkout/cart.ts', 'total', `
/** Subtotal minus the coupon discount, when the coupon is still valid. */
export function total(cart: Cart): Money {
  const sub = subtotal(cart);
  if (!cart.coupon || !isValid(cart.coupon)) {
    return sub;
  }
  return { ...sub, cents: sub.cents - (sub.cents * cart.coupon.percentOff) / 100 };
}
`);
});
commit('lucas', 'Coupon field in the cart drawer (AB#1204)', () => {
  block('src/checkout/CartDrawer.tsx', 'all', `import { useState } from 'react';\n\nexport function CartDrawer() {\n  const [code, setCode] = useState('');\n  return (\n    <aside className="cart">\n      <input placeholder="Coupon code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />\n    </aside>\n  );\n}`);
});
branch('fix/1210-rounding', 'develop');
commit('priya', 'Fix rounding of discounted totals to whole cents (AB#1210)', () => {
  block('src/shared/money.ts', 'all', `export interface Money {\n  cents: number;\n  currency: string;\n}\n\nexport const money = (amount: number, currency: string): Money => ({ cents: Math.round(amount * 100), currency });\nexport const add = (a: Money, b: Money): Money => ({ cents: a.cents + b.cents, currency: a.currency });\nexport const multiply = (a: Money, n: number): Money => ({ cents: Math.round(a.cents * n), currency: a.currency });`);
});
merge('feature/1204-coupon-codes', 'develop', 'maya', 41, 'Coupon codes in the cart');
merge('fix/1210-rounding', 'develop', 'lucas', 42, 'Round money to whole cents');
branch('fix/1210-coupon-rounding', 'develop');
commit('priya', 'Round the coupon discount half-up (AB#1210)', () => {
  block('src/checkout/cart.ts', 'total', `
/** Subtotal minus the coupon discount, when the coupon is still valid. */
export function total(cart: Cart): Money {
  const sub = subtotal(cart);
  if (!cart.coupon || !isValid(cart.coupon)) {
    return sub;
  }
  const discount = Math.round((sub.cents * cart.coupon.percentOff) / 100);
  return { ...sub, cents: sub.cents - discount };
}
`);
});
merge('fix/1210-coupon-rounding', 'develop', 'lucas', 43, 'Round coupon discounts half-up');

branch('feature/1215-apple-pay', 'develop');
commit('sofia', 'Payment request API wrapper (AB#1215)', () => {
  block('src/checkout/payment.ts', 'all', `export async function payWithWallet(totalCents: number, currency: string) {\n  const request = new PaymentRequest(\n    [{ supportedMethods: 'https://apple.com/apple-pay' }],\n    { total: { label: 'Atlas', amount: { currency, value: (totalCents / 100).toFixed(2) } } },\n  );\n  const response = await request.show();\n  await response.complete('success');\n  return response;\n}`);
});
commit('sofia', 'Show the wallet button when the browser supports it (AB#1215)', () => {
  block('src/checkout/WalletButton.tsx', 'all', `export function WalletButton({ onPay }: { onPay: () => void }) {\n  if (!('PaymentRequest' in window)) return null;\n  return <button className="wallet" onClick={onPay}>Pay</button>;\n}`);
});
commit('sofia', 'Handle cancelled wallet payments (AB#1215)', () => {
  block('src/checkout/payment.ts', 'cancel', `\nexport const isCancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';`);
});
merge('feature/1215-apple-pay', 'develop', 'maya', 44, 'Apple Pay and Google Pay at checkout');

branch('release/1.1', 'develop');
commit('maya', 'Bump version to 1.1.0', () => {
  block('package.json', 'all', pkg('1.1.0'));
  block('CHANGELOG.md', 'v110', `# Changelog\n\n## 1.1.0\n\n- Coupon codes in the cart\n- Apple Pay and Google Pay at checkout\n- Totals rounded to whole cents\n`);
});
merge('release/1.1', 'main', 'maya', 45, 'Release 1.1.0');
tag('v1.1.0', 'Atlas Web 1.1.0', 'maya');
merge('main', 'develop', 'maya', 46, 'Merge main back into develop');

// ---------------------------------------------------------------- hotfix v1.1.1
branch('hotfix/1231-session-timeout', 'main');
commit('tom', 'Hotfix: sessions expired after 15 seconds instead of 15 minutes (AB#1231)', () => {
  block('src/auth/session.ts', 'all', `/** Idle time before the user is signed out (15 minutes). */\nconst IDLE_TIMEOUT_MS = 15 * 60_000;\n\nlet lastActivity = Date.now();\n\nexport function touch() {\n  lastActivity = Date.now();\n}\n\nexport function isExpired(now = Date.now()) {\n  return now - lastActivity > IDLE_TIMEOUT_MS;\n}`);
}, 1);
merge('hotfix/1231-session-timeout', 'main', 'maya', 47, 'Hotfix: session timeout');
tag('v1.1.1', 'Atlas Web 1.1.1', 'maya');
merge('main', 'develop', 'tom', 48, 'Merge hotfix 1.1.1 into develop');

// ---------------------------------------------------------------- v1.2
branch('feature/1240-order-history', 'develop');
commit('kenji', 'Orders endpoint client (AB#1240)', () => {
  block('src/api/client.ts', 'orders', `
export interface Order {
  id: string;
  placedAt: string;
  totalCents: number;
  status: 'paid' | 'shipped' | 'delivered' | 'refunded';
}

export const listOrders = (page = 1) => get<Order[]>(\`/orders?page=\${page}\`);
`);
});
commit('kenji', 'Order history page with paging (AB#1240)', () => {
  block('src/account/OrderHistory.tsx', 'all', `import { useEffect, useState } from 'react';\nimport { listOrders, Order } from '../api/client';\n\nexport function OrderHistory() {\n  const [orders, setOrders] = useState<Order[]>([]);\n  const [page, setPage] = useState(1);\n  useEffect(() => { listOrders(page).then(setOrders); }, [page]);\n  return (\n    <table>\n      <tbody>{orders.map((o) => <tr key={o.id}><td>{o.id}</td><td>{o.status}</td></tr>)}</tbody>\n    </table>\n  );\n}`);
});
checkout('develop');
branch('feature/1244-dark-mode', 'develop');
commit('maya', 'Theme tokens and dark palette (AB#1244)', () => {
  block('src/theme.css', 'all', `:root {\n  --bg: #ffffff;\n  --fg: #1d2129;\n  --accent: #3b6cf6;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #14161b;\n    --fg: #e8eaf0;\n  }\n}`);
});
checkout('feature/1240-order-history');
commit('kenji', 'Status chips on orders (AB#1240)', () => {
  block('src/account/StatusChip.tsx', 'all', `export const StatusChip = ({ status }: { status: string }) => <span className={\`chip chip-\${status}\`}>{status}</span>;`);
});
merge('feature/1240-order-history', 'develop', 'sofia', 49, 'Order history in the account page');
checkout('feature/1244-dark-mode');
commit('maya', 'Theme switch in the header (AB#1244)', () => {
  block('src/theme.css', 'switch', `\n:root[data-theme='dark'] {\n  --bg: #14161b;\n  --fg: #e8eaf0;\n}`);
});
merge('feature/1244-dark-mode', 'develop', 'kenji', 50, 'Dark mode');
branch('chore/deps-october', 'develop');
commit('tom', 'Update Vite to 5.4 and Vitest to 2.1', () => {
  block('azure-pipelines.yml', 'cache', `\n  - task: Cache@2\n    inputs:\n      key: npm | package-lock.json\n      path: ~/.npm`);
});
merge('chore/deps-october', 'develop', 'priya', 51, 'October dependency updates');

branch('release/1.2', 'develop');
commit('maya', 'Bump version to 1.2.0', () => {
  block('package.json', 'all', pkg('1.2.0'));
  block('CHANGELOG.md', 'v120', `\n## 1.2.0\n\n- Order history in the account page\n- Dark mode\n`);
});
merge('release/1.2', 'main', 'maya', 52, 'Release 1.2.0');
tag('v1.2.0', 'Atlas Web 1.2.0', 'maya');
merge('main', 'develop', 'maya', 53, 'Merge main back into develop');

// ---------------------------------------------------------------- work in progress
checkout('develop');
commit('priya', 'Log checkout errors with the cart id', () => {
  block('src/checkout/payment.ts', 'log', `\nexport function reportFailure(cartId: string, e: unknown) {\n  console.error('[checkout]', cartId, e);\n}`);
});
branch('feature/1251-gift-cards', 'develop');
commit('lucas', 'Gift card balance lookup (AB#1251)', () => {
  block('src/checkout/giftCards.ts', 'all', `import { get } from '../api/client';\n\nexport const balance = (code: string) => get<{ cents: number }>(\`/gift-cards/\${encodeURIComponent(code)}\`);`);
});
commit('lucas', 'Pay part of the order with a gift card (AB#1251)', () => {
  block('src/checkout/cart.ts', 'giftcard', `
/** What is left to pay once a gift card balance is applied. */
export function remaining(cart: Cart, giftCardCents: number): Money {
  const t = total(cart);
  return { ...t, cents: Math.max(0, t.cents - giftCardCents) };
}
`);
});
checkout('develop');
branch('feature/1256-saved-carts', 'develop');
commit('sofia', 'Persist the cart in local storage (AB#1256)', () => {
  block('src/checkout/persist.ts', 'all', `import type { Cart } from './cart';\n\nconst KEY = 'atlas.cart';\n\nexport const save = (cart: Cart) => localStorage.setItem(KEY, JSON.stringify(cart));\nexport const load = (): Cart | undefined => JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? undefined;`);
});
commit('sofia', 'Restore the saved cart on sign-in (AB#1256)', () => {
  block('src/checkout/persist.ts', 'merge', `\nexport function mergeCarts(local: Cart, server: Cart): Cart {\n  return { ...server, lines: [...server.lines, ...local.lines.filter((l) => !server.lines.some((s) => s.sku === l.sku))] };\n}`);
});
checkout('develop');
commit('tom', 'Run the e2e tests on pull requests', () => {
  block('azure-pipelines.yml', 'e2e', `\n  - script: npx playwright test\n    displayName: End-to-end tests`);
});
branch('fix/1258-currency-format', 'develop');
commit('priya', 'Format prices with the shopper locale (AB#1258)', () => {
  block('src/shared/format.ts', 'all', `export const formatPrice = (cents: number, currency: string, locale = navigator.language) =>\n  new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);`);
});

// Remote-tracking branches: everything pushed except the newest gift card commit and the local fix.
for (const b of git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n')) {
  if (b === 'fix/1258-currency-format') continue;
  git(['update-ref', `refs/remotes/origin/${b}`, b === 'feature/1251-gift-cards' ? `${b}~1` : b]);
  git(['config', `branch.${b}.remote`, 'origin']);
  git(['config', `branch.${b}.merge`, `refs/heads/${b}`]);
}
git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
// Pushes go to a local bare repository; the fetch URL (what Gitland reads) stays on Azure DevOps.
const bare = `${dir}-remote.git`;
fs.rmSync(bare, { recursive: true, force: true });
execFileSync('git', ['init', '-q', '--bare', bare]);
git(['config', 'remote.origin.pushurl', bare]);
// Fetching would reach the real dev.azure.com: send it to a closed local port so it fails at once.
git(['config', 'http.proxy', 'http://127.0.0.1:9']);
// Short-lived branches were deleted after their pull request, as on Azure DevOps.
for (const b of ['feature/1204-coupon-codes', 'fix/1210-rounding', 'fix/1210-coupon-rounding', 'feature/1215-apple-pay', 'release/1.1', 'hotfix/1231-session-timeout', 'feature/1240-order-history', 'feature/1244-dark-mode', 'chore/deps-october', 'release/1.2']) {
  git(['branch', '-q', '-D', b]);
  git(['update-ref', '-d', `refs/remotes/origin/${b}`]);
}

git(['push', '-q', bare, 'refs/remotes/origin/*:refs/heads/*', '--tags']);
git(['--git-dir', bare, 'update-ref', '-d', 'refs/heads/HEAD']);

checkout('develop');
// A stash and some uncommitted work for the Changes view and the graph.
fs.appendFileSync(path.join(dir, 'README.md'), '\n## Development\n\n```sh\nnpm install\nnpm run dev\n```\n');
git(['stash', 'push', '-q', '-m', 'WIP: README dev section'], as('maya', 0.1));
fs.appendFileSync(path.join(dir, 'src/checkout/CartDrawer.tsx'), '\n// TODO: show the coupon error under the field\n');
fs.writeFileSync(path.join(dir, 'src/checkout/shipping.ts'), `export const FREE_SHIPPING_FROM_CENTS = 50_00;\n`);
console.log(`atlas-web ready in ${dir}: ${git(['rev-list', '--all', '--count'])} commits, HEAD on develop`);
