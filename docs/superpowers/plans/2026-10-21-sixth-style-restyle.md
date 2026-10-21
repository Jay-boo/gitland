# Sixth-style restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every Gitland webview after Sixth AI (theme-native, rounded cards, pills, segmented switches, solid buttons, dashed separators, dense 22px lists) on a shared `base.css` + `common.js`, without changing any behaviour.

**Architecture:** A render harness first (captured real view HTML + messages, real VS Code theme variables, production CSP, headless Chromium) so every visual task is verified by screenshots in three themes. Then a shared base (tokens, components, JS helpers) that every view loads, then surface-by-surface migration.

**Tech Stack:** VS Code webviews (plain JS + CSS in `media/`), TypeScript extension (`src/`, esbuild), `node:test` for unit checks, `playwright-core` driving the cached Chromium at `~/.cache/ms-playwright/chromium-1134/chrome-linux/chrome`.

**Spec:** `docs/superpowers/specs/2026-10-21-sixth-style-restyle-design.md`

## Global Constraints

- No behaviour change: every button, menu item, hover, shortcut, drag-and-drop and message type keeps working exactly as before. Only markup classes, CSS and shared helpers change.
- Fonts: `var(--vscode-font-family)` / `var(--vscode-font-size)` for text, `var(--vscode-editor-font-family)` for SHAs, dates, counts. Geist and Geist Mono are removed.
- Colours: only `--vscode-*` variables through `--gl-*` tokens defined in `media/base.css`; each token has a hard fallback. No hex literal in any `media/*.css` other than `base.css` fallbacks.
- Radius: cards 10px, list card 10px, inputs 8px, buttons 6px, pills 999px, menu items 5px. Rows inside a list card: 22px, full-width hover.
- Branch colour mapping unchanged in meaning: main → blue, dev → green, feature → purple, fix → red (reduced mix), hotfix → red, release → yellow, chore → descriptionForeground, others → stable index.
- Engine stays `vscode ^1.85.0`; CSP string unchanged.
- Commits authored as Jay-boo, **no `Co-Authored-By: Claude` trailer** (user rule).
- Work on branch `restyle/sixth`.

## Review Focus

1. **High-contrast themes**: cards and pills have no visible surface difference there; every card, list, pop and pill must show `--vscode-contrastBorder` (1px) when it is set. Test: Task 1 renders `hc_black`; Tasks 4–8 check each screenshot shows card edges.
2. **Light themes**: 15% pill fills and the selected-row colour must keep text readable. Test: Task 1 renders `light_modern`; each visual task inspects its light screenshots.
3. **Narrow sidebar (≈220px)**: segmented switch, sync pills and composer buttons must wrap or shrink without horizontal scroll. Test: harness renders sidebar views at 220px and 320px; Task 1's `render.mjs` fails when `document.documentElement.scrollWidth > innerWidth`.
4. **Older VS Code / themes without `charts.*` or `gitDecoration.*`**: tokens fall back to sensible values. Test: `test/unit/tokens.test.js` asserts every `--gl-*` declaration in `base.css` has a fallback.
5. **Keyboard focus**: rounded components must still show `--vscode-focusBorder` on `:focus-visible`. Test: `tokens.test.js` asserts `base.css` has a `:focus-visible` rule using `--vscode-focusBorder`.

---

### Task 1: Render harness (capture + themes + screenshots)

**Files:**
- Create: `src/devCapture.ts`
- Modify: the single `post`/`postMessage` funnel in each of `src/graph/graphPanel.ts`, `src/views/{changesView,prsView,ticketsView,releasesView,prPanel,ticketPanel,newPrPanel,newReleasePanel,historyPanel,comparePanel,dashboardPanel,cleanupPanel,rebasePanel}.ts`; `src/views/webviewHtml.ts` and `graphPanel.ts`'s own HTML builder (capture the page)
- Modify: `test/suite.js`, `test/runTest.js` (pass `GITLAND_CAPTURE_DIR`)
- Create: `test/render/render.mjs`, `test/render/fixtures/` (captured), `test/render/themes/{dark_modern,light_modern,hc_black}.json`
- Modify: `package.json` (devDependency `playwright-core@1.47.2`, scripts `render`, `test:unit`), `.gitignore` (`test/render/out/`)

**Interfaces:**
- Produces: `capture(view: string, kind: 'html' | 'message', payload: unknown): void` in `src/devCapture.ts` — no-op unless `process.env.GITLAND_CAPTURE_DIR` is set; writes `<dir>/<view>.html` (last page HTML) and appends to `<dir>/<view>.jsonl`.
- Produces: `npm run render [-- --only graph,changes]` → `test/render/out/<view>-<theme>-<width>.png`, exit code 1 on horizontal overflow or page error.
- View names (used by all later tasks): `graph`, `changes`, `tickets`, `prs`, `releases`, `pr`, `ticket`, `newpr`, `newrelease`, `history`, `compare`, `dashboard`, `cleanup`, `rebase`.

- [ ] **Step 1:** Create branch `restyle/sixth`.
- [ ] **Step 2:** Implement `capture()` and call it from every funnel (`capture('<view>', 'message', message)`) and from page builders (`capture('<view>', 'html', html)`). `webviewHtml` gets the view name from `opts.title` → add an explicit `opts.view: string` field; update every caller.
- [ ] **Step 3:** Add a suite step, run only when `GITLAND_CAPTURE_DIR` is set: for each theme `Default Dark Modern`, `Default Light Modern`, `Default High Contrast` set `workbench.colorTheme`, open a throwaway webview panel whose script posts back `document.documentElement.getAttribute('style')` and `document.body.className`, and write them to `test/render/themes/<theme>.json` as `{ "bodyClass": "...", "vars": { "--vscode-…": "…" } }`. Then open each view/panel through its command (`gitland.showGraphInEditor`, `gitland.showChangesInEditor`, `gitland.dashboard`, `gitland.compare` with two refs, `gitland.fileHistory` on `package.json`, `gitland.branches.cleanup`, `gitland.rebase.interactive`, sidebar views via `workbench.view.extension.gitlandSidebar`, PR / ticket / new PR / new release via their commands) and wait 4 s each.
- [ ] **Step 4:** Run `GITLAND_CAPTURE_DIR=$PWD/test/render/fixtures node test/runTest.js /home/jayboo/projects/gitland --real`. Expected: theme JSONs plus `.html` / `.jsonl` for every view. For views that could not load (auth), write the `.jsonl` by hand from the message shapes their TS posts, with realistic content (long branch names, a 60-char ticket title, 0 and 25 files).
- [ ] **Step 5:** Write `render.mjs`: for each fixture × theme × width (sidebar views 220 and 320, tabs 1000, graph 320 and 1000): rewrite resource URIs in the captured HTML to `file://…/media/…` and the CSP `cspSource` to `file:`; add `class="<bodyClass>"` and the theme `vars` on `<html style>`; prepend a script defining `acquireVsCodeApi` (no-op `postMessage`, in-memory `getState`/`setState`); load, replay the `.jsonl` messages with `window.postMessage`, wait 300 ms, assert no `pageerror` and `scrollWidth <= innerWidth`, screenshot full page.
- [ ] **Step 6:** Run `npm run render`. Expected: 14 views × 3 themes PNGs, exit 0. Copy them to `test/render/before/` (git-ignored) as the baseline and show the user a contact sheet of the dark ones.
- [ ] **Step 7:** `npm run typecheck`, `npm test` pass. Commit `test: render harness for webviews (captured views, real theme vars)`.

### Task 2: Shared base — tokens, components, `common.js`, wiring

**Files:**
- Create: `media/base.css`, `media/common.js`, `test/unit/tokens.test.js`, `test/unit/common.test.js`
- Modify: `src/views/webviewHtml.ts`, `src/graph/graphPanel.ts` (use `webviewHtml` instead of its own builder), all 16 `media/*.js` (drop private `esc`/`icon`/`relTime`/`$`), `media/graph.css` (move tokens/reset/buttons/scrollbars out), `media/md.js`
- Delete: `media/vendor/geist.woff2`, `geist-mono.woff2`, `geist-LICENSE.txt`

**Interfaces:**
- Produces (`media/common.js`, a classic script defining `window.gl`, also `module.exports = gl` when `module` exists):
  - `gl.esc(s: string): string`
  - `gl.icon(name: string, cls?: string): string` → `<i class="codicon codicon-NAME CLS"></i>`
  - `gl.relTime(ts: number): string` — the long form now in `pr.js` ("5m ago", "3h ago", "2d ago", then a dated `day month year`)
  - `gl.relShort(ts: number): string` — the `releases.js` form ("5m", "3h", "2d", "4mo", "2y")
  - `gl.$(id: string): HTMLElement`
  - `gl.themeColors(get: (name: string) => string): string[]` — returns the 11 lane colours from `--gl-lane-0` … `--gl-lane-10`
- Produces (`media/base.css`) tokens: `--gl-font`, `--gl-mono`, `--gl-fg`, `--gl-muted`, `--gl-faint`, `--gl-bg`, `--gl-card`, `--gl-card-hover`, `--gl-line`, `--gl-border` (contrastBorder or transparent), `--gl-shadow`, `--gl-accent` (focusBorder), `--gl-main`, `--gl-dev`, `--gl-feature`, `--gl-fix`, `--gl-hotfix`, `--gl-release`, `--gl-chore`, `--gl-lane-0…10`, `--gl-added/modified/deleted/renamed/conflict`, `--gl-ai`, `--gl-ok/warn/err`. Components: `.card`, `.list` > `.row`, `.pill` (+ `.pill.c-main|c-dev|c-feature|c-fix|c-hotfix|c-release|c-chore|c-ok|c-warn|c-err|c-ai`, colour via `--c`), `.seg` > `button[aria-pressed]`, `button` / `button.primary` / `button.secondary` / `button.icon`, `.btn-pair`, `.sep` (dashed line + `.sep-act` outlined mini buttons), `.pop` + `.pop .mi` (menu item) + `.pop hr`, `.sec` (icon + bold title + `.n` count pill), `.composer`, `.empty`, `.skeleton`, `.tab-head` (`.th-title`, `.th-status`, `.th-acts`).
- Keeps: every existing class name used by view scripts still resolves (old names may become aliases of new components until their view task migrates).
- Lane mapping: `--gl-lane-0` main, `1` dev, `2` feature, `3` fix, `4` hotfix, `5` release, `6` chore, `7–10` others (orange, cyan-ish mixes of blue/green, pink mix of red/purple, yellow/green mix) — keeps `src/graph/colors.ts` indexes (`BRANCH_COLORS = 11`, `OTHER_FIRST = 7`).

- [ ] **Step 1: Write failing unit tests.** `test/unit/common.test.js`: `gl.esc('<a href="x">&</a>')` → `&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;`; `gl.relTime(Date.now() - 90e3)` → `'1m ago'`; `gl.relShort(Date.now() - 400 * 86400e3)` → `'1y'`; `gl.themeColors(n => n)` → 11 entries `'--gl-lane-0'…'--gl-lane-10'`. `test/unit/tokens.test.js`: (a) no `#[0-9a-f]{3,8}` in `media/*.css` except `base.css` and `vendor/`; (b) every `--gl-*:` declaration in `base.css` contains `var(--vscode-` with a fallback; (c) no `Gitland Geist` in `media/` or `src/`; (d) no `const esc =` / `function relTime` in `media/*.js` other than `common.js`; (e) `base.css` has `:focus-visible` using `--vscode-focusBorder`; (f) `.card`, `.list`, `.pill`, `.pop` rules include `--gl-border`.
- [ ] **Step 2:** `npm run test:unit` → FAIL (missing files, hex literals, private helpers).
- [ ] **Step 3:** Write `base.css` and `common.js`; load them first in `webviewHtml` (`styles = ['base.css', 'graph.css', ...]` for the graph, `['base.css', ...]` otherwise; script list prefixed with `common.js`); drop the `@font-face` block; switch `graphPanel` to `webviewHtml`. Replace every hex literal in `media/*.css` by the matching token. Replace private helpers in all scripts by `gl.*` (`relTime` callers in `cleanup`, `prs`, `dashboard`, `newpr`, `releases` → `gl.relShort`; `pr`, `compare`, `history` → `gl.relTime`; `graph.js` keeps its own `relTime` renamed `graphTime` because it has a "just now" / 7-day rule). Delete Geist files.
- [ ] **Step 4:** `npm run test:unit` → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5:** `npm run render`. Expected exit 0; views look the same layout as `before/` but in the VS Code font and theme colours. Commit `refactor: shared base.css tokens + common.js, theme font, drop Geist`.

### Task 3: Graph lanes from theme colours

**Files:**
- Modify: `media/graph.js` (`COLORS` at line ~13 and the branch picker swatches at ~766–769), `src/graph/colors.ts` (doc comment only)

**Interfaces:**
- Consumes: `gl.themeColors`, `--gl-lane-*` (Task 2).

- [ ] **Step 1:** Replace the literal `COLORS` with `gl.themeColors((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim())`, computed once on load and again when `document.body.className` changes (theme switch: observe `class` with a `MutationObserver`, then re-render).
- [ ] **Step 2:** `npm run render -- --only graph`. Expected: lanes and badges use theme blue/green/purple/red in dark and light; HC shows them too.
- [ ] **Step 3:** `npm run test:unit` PASS. Commit `feat(graph): lane colours follow the theme`.

### Task 4: Graph surfaces in the new style

**Files:**
- Modify: `media/graph.css` (all sections: toolbar, minimap, commit list, ref chips, hover card, details pane, context menu, responsive, stashes, PR badges, filter, compare, drag and drop, uncommitted bubble, view mode), `media/graph.js` (class names only where a component replaces a bespoke one), `src/graph/graphPanel.ts` (static body markup)

- [ ] **Step 1:** Toolbar: search as rounded input (8px), view mode All / Branch / Timeline as `.seg`, filter + branches as `button.icon` with a dot when active.
- [ ] **Step 2:** Commit list inside one `.list` card (10px, 22px rows, full-width hover/selection using `--vscode-list-hoverBackground` / `--vscode-list-activeSelectionBackground` + `-Foreground`); header row stays sticky inside the card. Ref badges, PR badges, CI marks, stash rows → `.pill` with lane `--c`. Uncommitted bubble → `.pill c-ai`.
- [ ] **Step 3:** Hover card and context menu → `.pop` (10px / 8px radius, `--vscode-editorHoverWidget-*` / `--vscode-menu-*`, `--vscode-widget-shadow`), lane accent kept as 2px left border; footer separator dashed; link chips → `.pill` using `--vscode-textLink-foreground`.
- [ ] **Step 4:** Details pane → stacked `.card`s (header card: subject, author, age, SHA pill; files `.list`; signature / release / links as pills). Minimap bars rounded 2px, today marker `--gl-accent`. Compare banner and drag-and-drop target → `.sep` style dashed outline.
- [ ] **Step 5:** `npm run render -- --only graph`. Expected exit 0. Inspect all three themes at 320 and 1000 px; check against Review Focus 1–3. Show the user before/after (dark, 1000 px and 320 px).
- [ ] **Step 6:** Commit `style(graph): Sixth-style toolbar, list card, pills, pop-overs, details cards`.

### Task 5: Changes view

**Files:**
- Modify: `media/changes.css`, `media/changes.js` (markup of sync bar, compose, group headers), `src/views/changesView.ts` (static body)

- [ ] **Step 1:** Sync bar → branch `.card`: branch name (bold, ellipsis), ticket line (`AB#1234 · title`, muted), pills for ahead (`c-main`), behind (`c-release`), up to date (`c-ok`), unpublished; pull / push / sync / fetch as `button.icon` in the card corner.
- [ ] **Step 2:** Compose → `.composer` (8px rounded input, ✨ generate inside at top-right, generating shimmer in `--gl-ai`); meta row (ticket pill, length counter, amend, sign switch, hooks pill); `.btn-pair`: `Commit` (primary) + `Commit & Push` (secondary). Keyboard shortcuts unchanged.
- [ ] **Step 3:** Groups: header = `.sec` (chevron, title, `.n` count, +/− stats) with actions on hover; each group's files in one `.list` card; conflicts group header in `--gl-err`. Operation banner (merge/rebase in progress) → `.card` with warn accent and `.btn-pair`. Hook output → `.card` with `pre` in editor font.
- [ ] **Step 4:** `npm run render -- --only changes` (fixtures: clean tree, 25 files, conflict in progress). Expected exit 0; inspect three themes at 220 / 320 px. Show the user before/after.
- [ ] **Step 5:** Commit `style(changes): branch card, composer, button pair, list cards`.

### Task 6: Sidebar lists — My Tickets, Pull Requests, Releases

**Files:**
- Modify: `media/list.css`, `media/tickets.js`, `media/prs.js`, `media/releases.js`, their `src/views/*View.ts` bodies

- [ ] **Step 1:** Group headers → `.sec`; each group in one `.list` card; item = two-line row (title, then muted meta line) at 22px per line; state/review/vote → `.pill` (`c-ok` approved, `c-warn` waiting, `c-err` rejected, `c-chore` draft); hover actions unchanged. Releases "not released yet" → `.pill c-ai`. Empty / signed-out / loading → `.empty` / `.skeleton`.
- [ ] **Step 2:** `npm run render -- --only tickets,prs,releases`. Expected exit 0; three themes at 220 / 320 px.
- [ ] **Step 3:** Commit `style(lists): tickets, PRs, releases in list cards with pills`.

### Task 7: Tabs — PR, ticket, new PR, new release

**Files:**
- Modify: `media/ticket.css`, `media/pr.css`, `media/newpr.css`, `media/{pr,ticket,newpr,newrelease}.js`, `src/views/{prPanel,ticketPanel,newPrPanel,newReleasePanel}.ts`

- [ ] **Step 1:** Each page starts with `.tab-head`: title (+ id in editor font), `.th-status` pill (PR: active / draft / completed / abandoned; ticket: state), `.th-acts` right-aligned (existing buttons, primary action as `button.primary`).
- [ ] **Step 2:** Body sections → `.card`s with `.sec` titles (description, acceptance criteria, reviewers + votes as pills, work items, commits as `.list`, discussion threads as cards with replies indented, checks with `c-ok/c-err`). Forms (new PR / new release): inputs and selects 8px rounded, template preview tabs as `.seg`, ✨ Generate as `button.secondary` with `--gl-ai` icon, submit as `.btn-pair`.
- [ ] **Step 3:** `npm run render -- --only pr,ticket,newpr,newrelease` (fixtures: long description with markdown, 3 threads, many reviewers). Expected exit 0; three themes at 1000 px.
- [ ] **Step 4:** Commit `style(tabs): PR, ticket, new PR, new release with tab-head and cards`.

### Task 8: Tabs — compare, history, dashboard, cleanup, rebase

**Files:**
- Modify: `media/{compare,history,dashboard,cleanup,rebase}.css`, the matching `media/*.js`, `src/views/{comparePanel,historyPanel,dashboardPanel,cleanupPanel,rebasePanel}.ts`, `media/diffpreview.js` (class names only)

- [ ] **Step 1:** Same `.tab-head`. Compare: two side headers as cards with ref pills, "diverged at" as `.sep`, commits / PRs / files as `.list` cards, *Copy release notes* secondary button. History: timeline entries as `.list` rows, expanded diff in a `.card`, PR / ticket pills, two-version tick → `.pill c-main` selection count. Dashboard: one `.card` per section with `.sec` title and `.list`; CI pills. Cleanup: grouped `.list` with checkboxes, protected branches as `.pill c-chore`, delete as `button.primary` with danger colour `--gl-err`. Rebase: draggable rows in a `.list` card, action selector as `.seg` (pick / reword / squash / fixup / edit / drop), pushed-commit warning `.card` with `--gl-warn`.
- [ ] **Step 2:** `npm run render -- --only compare,history,dashboard,cleanup,rebase`. Expected exit 0; three themes at 1000 px.
- [ ] **Step 3:** Commit `style(tabs): compare, history, dashboard, cleanup, rebase`.

### Task 9: Editor blame hover content

**Files:**
- Modify: `src/blame/blameController.ts` (hover `MarkdownString` builder), `src/extension.ts` (its `MarkdownString` use, if it is a hover)

- [ ] **Step 1:** Reorder to match the graph hover card: author + age line, subject bold, body, then a single line of refs (`$(git-branch)`, `$(git-pull-request) PR`, `$(issues) AB#…`, `$(tag) release`), then `+N −M` coloured with `<span style="color:var(--vscode-gitDecoration-addedResourceForeground);">` (`supportHtml = true`, `isTrusted` kept as today), then actions separated by ` · `. Remove any hard-coded hex colour.
- [ ] **Step 2:** `npm run typecheck` PASS; `npm test` PASS (existing hover step). Manual: open a file in the test VS Code (`GITLAND_TEST_HOLD=1 node test/runTest.js . --real`), hover a blamed line, compare with graph hover card.
- [ ] **Step 3:** Commit `style(blame): hover content aligned with the graph card`.

### Task 10: Final verification and package

**Files:**
- Modify: `package.json` (version bump to `0.1.0`), `README.md` (remove Geist mention if any; one line "follows your VS Code theme")

- [ ] **Step 1:** `npm run test:unit && npm run typecheck && npm test` all PASS.
- [ ] **Step 2:** `npm run render` (all views, all themes) exit 0; build a contact sheet (ffmpeg tile) of `before/` vs `out/` for the user.
- [ ] **Step 3:** `npm run package` → `gitland-0.1.0.vsix`; `code --install-extension gitland-0.1.0.vsix --force`; ask the user to reload and check: hover card, context menu, drag-and-drop, minimap click, compare, commit flow, conflict banner.
- [ ] **Step 4:** Commit `chore: release 0.1.0 — Sixth-style restyle`.
