# Stream restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "bricky" filled-block look with the approved Sixth "stream" look: one filled card per screen, dashed section separators, outlined rows, small dark chips, Changes composer at the bottom.

**Architecture:** New components in `media/base.css` (`.gl-ck`, `.gl-orow`, `.gl-chip`, `.gl-quote`), then each view's CSS drops its filled section surfaces and adopts them; markup changes only where a section header or the Changes composer must move. A unit test enforces "few filled surfaces" so the bricks can't creep back.

**Tech Stack:** CSS/JS webviews, `node:test`, render harness `npm run render`.

**Spec:** `docs/superpowers/specs/2026-10-22-stream-restyle-design.md` (mockup alongside it).

## Global Constraints

- No behaviour change; every id, data-* attribute and message type stays.
- Filled `var(--gl-card)` backgrounds only on: `.gl-task`, Changes `.sync`, graph `#details .info` summary, `.t-head`/`.t-actions`, compare `.c-head`; floating surfaces use hover-widget/menu colours.
- Chips: radius 5px, height 18px, `--gl-chip` fill, coloured text. No `border-radius: 999px` left in `media/*.css` except switches, avatars, dots, bubbles (`.switch .track`, `.knob`, `.avatar`, `.bubble`, `.dot`, scrollbar).
- Every outlined / filled element keeps `--gl-border` for high contrast.
- Commits as Jay-boo, no Claude trailer. Branch `restyle/stream` (from `feat/batch-1`). Version `0.3.0` at the end.

## Review Focus

1. Changes composer pinned at the bottom must not hide the last file rows when the list is long. Test: render `changes@busy` at 320px with 25 files (new fixture `changes@many`) — last row visible above the composer when scrolled to the end (`scrollIntoView` check in the harness interaction).
2. Light theme: `--gl-chip` text colours (yellow on light grey) stay readable. Test: inspect light screenshots of graph, lists and PR.
3. High contrast: outlined rows / dashed separators visible. Test: inspect `hc_black` shots.
4. Narrow sidebar (220px): dashed separators with 2–3 actions must not overflow. Test: harness overflow check at 220px.
5. Hover card / menus stay readable over the now-unfilled graph list. Test: graph hover/menu shots.

---

### Task 1: Base components + "no bricks" test

**Files:** Modify `media/base.css`, `test/unit/tokens.test.js`

**Interfaces (produced):** tokens `--gl-chip`, `--gl-dash`; components:
- `.gl-task` — the one filled card (bg `--gl-card`, radius 10, padding 10px 12px, `--gl-border`).
- `.gl-ck` — flex row, 11px, `--gl-faint`; `.gl-ck .name` muted 600; `::after` dashed rule (`flex:1`, `order:1`); `.gl-ck .act` (`order:2`, dashed 1px `--gl-dash` outline, radius 4, height 18, transparent, muted, hover → fg + solid).
- `.gl-orow` — flex row, gap 8, 1px solid `--gl-line` (+ HC `--gl-border` wins via `border-color: var(--vscode-contrastBorder, var(--gl-line))`), radius 8, padding 6px 10px, margin-bottom 6px, hover bg `--gl-hover`, `.sel` selected colours.
- `.gl-chip` — inline-flex, height 18, padding 0 7px, radius 5, bg `--gl-chip`, color `--c` (default muted), 11px; modifiers `.c-main|c-dev|c-feature|c-fix|c-hotfix|c-release|c-chore|c-ok|c-warn|c-err|c-ai|c-link` set `--c`. `.gl-pill` becomes an alias of `.gl-chip`.
- `.gl-quote` — left rule 2px `--gl-dash`, padding-left 12px, margin 10px 0.
- `.gl-list` / `.gl-card` lose their fill (`.gl-list`: transparent, no border; `.gl-card` kept only as alias of `.gl-task`).

- [ ] **Step 1: Failing tests** in `tokens.test.js`:
  - `'filled surfaces are rare'`: across `media/*.css` (excluding `base.css`, `vendor/`), count declarations `background: var(--gl-card)` / `var(--surface-2)` / `var(--surface)`; assert the set of selectors using them ⊆ `['.sync', '#details .info', '.t-head', '.t-actions', '.c-head', '.preview']`.
  - `'chips are square-ish'`: no `border-radius: 999px` in `media/*.css` other than in rules whose selector contains `switch`, `knob`, `track`, `avatar`, `bubble`, `dot`, `scrollbar`, or in `base.css` `.gl-seg`/`.gl-skeleton`.
  - `'stream components exist with HC borders'`: `.gl-task`, `.gl-orow`, `.gl-ck .act`, `.gl-chip` rules exist in base.css and include `--gl-border` or `contrastBorder`.
- [ ] **Step 2:** `npm run test:unit` → the 3 tests FAIL.
- [ ] **Step 3:** Implement the base.css changes above. (View CSS still fails test 1/2 until Tasks 2–5; keep those two tests failing and note it — they are the acceptance tests for the whole plan. Test 3 passes.)
- [ ] **Step 4:** Commit `style(base): stream components (task card, checkpoint separators, outlined rows, chips)`.

### Task 2: Changes view

**Files:** Modify `src/views/changesView.ts` (`CHANGES_BODY`: move `<section class="compose">…</section>` after `<main id="groups"></main>`), `media/changes.css`, `media/changes.js` (group header markup → `.gl-ck`), `test/render/static/changes@many.jsonl` (25 files)

- [ ] **Step 1:** Body becomes a flex column (`min-height: 100%`): sync card, busy, op banner, hook output, groups (flex 1), compose sticky at the bottom (`position: sticky; bottom: 0; background: var(--gl-bg); padding-top: 8px; box-shadow: 0 -8px 8px var(--gl-bg)`).
- [ ] **Step 2:** Group header (`.gh`) → `.gl-ck` look: chevron + name + count in `.name`, `+/−` stats faint, actions (`.ga` buttons) shown as dashed `.act` buttons, always visible (not only on hover) for Stage all / Unstage all / Discard all; selection actions keep their current behaviour. Files (`.gb .file`) → outlined rows; `.gb` loses its card.
- [ ] **Step 3:** Chips: `.ab > span`, `.ticket`, `.hook-chip` → chip look. Op banner and hook output → outlined (not filled) blocks with a coloured left rule.
- [ ] **Step 4:** Render `changes` + variants (`@clean`, `@busy`, `@conflict`, `@many`) at 220/320 in three themes; harness interaction for `changes@many`: scroll to bottom, assert last `.file` bottom ≤ composer top (fails the render otherwise). Inspect.
- [ ] **Step 5:** Commit `style(changes): stream layout, composer at the bottom`.

### Task 3: Graph

**Files:** Modify `media/graph.css`, `media/graph.js` (details pane markup: "Selected" `.gl-ck` line with the action buttons, summary in a `.gl-task`, files as `.gl-orow`), `src/graph/graphPanel.ts` (minimap as a `.gl-ck`-styled strip if markup needed)

- [ ] **Step 1:** `#main > #list` loses its card (transparent, no border); header row bottom rule dashed; rows unchanged (22px).
- [ ] **Step 2:** Refs, PR badges, merged chips, rel/CI/sig chips, link chips, toolbar branch → chip look (`--gl-chip`, coloured text by lane `--c`). Current branch ref: chip with `--c` text + 1px solid `--c` outline.
- [ ] **Step 3:** Details pane: no outer card; top line `◉ Selected · <sha>` as `.gl-ck` with the existing action buttons restyled as `.act`; left: summary `.gl-task` (subject, author/date, chips); right: files as `.gl-orow`. Existing buttons keep their ids/data-attributes.
- [ ] **Step 4:** Minimap: no card; sits on a dashed baseline. Keys card, notice, hover card, menu, picker: unchanged surfaces (floating).
- [ ] **Step 5:** Render graph with all interactions in three themes, 320/1000; inspect. Commit `style(graph): stream details, chips, unfilled list`.

### Task 4: Sidebar lists

**Files:** Modify `media/list.css`, `media/pipelines.css` (and `.js` only if group header markup must change)

- [ ] **Step 1:** `.grp > .gh` → `.gl-ck` look; `.gb` loses its card; `.item` → outlined row (radius 8, margin-bottom 6, padding 6px 10px); `.item.current` → outline in `--gl-link` instead of fill.
- [ ] **Step 2:** `.pill` / state pills → chips; `.glyph` stays (small tinted square — it's an icon, not a block); `.state` empty states lose their card (centered text only); `.unreleased` → dashed outline, no fill.
- [ ] **Step 3:** Pipelines: runs as outlined rows; expanded jobs inside the row's outline (row becomes a column), log block keeps `--gl-inset`.
- [ ] **Step 4:** Render tickets, prs, releases, pipelines (+expand) 220/320 three themes; inspect. Commit `style(lists): stream rows and checkpoints`.

### Task 5: Tab pages

**Files:** Modify `media/ticket.css`, `media/pr.css`, `media/newpr.css`, `media/compare.css`, `media/history.css`, `media/dashboard.css`, `media/cleanup.css`, `media/rebase.css`, `media/settings.css`; JS only where a section title must become a `.gl-ck` line (`h3` → keep element, restyle via CSS: `.t-main h3, .t-side h3, .tab-body h3, .dcard h3, .cl-group h3, .set-group h3` get the checkpoint look with `::after` dashed rule)

- [ ] **Step 1:** Section containers (`.t-main section`, `.t-side section`, `.tab-body section`, `.dcard`, `.cl-group`, `.set-group`, `.review-bar`, `.notes`, `.explain`) lose fill and border; spacing only. Their `h3` → checkpoint line.
- [ ] **Step 2:** Comments (`.comment`, `.thread`) → `.gl-quote` look; reply indent kept. `.pr-row`, `.link-row`, `.rb-row`, `.cl-row`, `.drow` → outlined rows where they are short clickable lists (pr-row, link-row, rb-row, drow); `.cl-row`/`.c-row`/`.tl-head`/`.commit-row` stay plain rows.
- [ ] **Step 3:** All pills/tags/sums/hchips/pr-chips → chips. `.ref-pick` (compare) → chip-styled button. Rebase `.rb-acts` keeps the segmented control.
- [ ] **Step 4:** Render pr, ticket, newpr, newrelease, compare, history, dashboard, cleanup, rebase, settings (1000px, three themes); inspect. `npm run test:unit` → the Task 1 tests "filled surfaces are rare" and "chips are square-ish" now PASS. Commit `style(tabs): stream sections, quotes and chips`.

### Task 6: Final verification and install

- [ ] **Step 1:** `npm run test:unit && npm run typecheck && npm test && npm run render` all pass.
- [ ] **Step 2:** Before/after contact sheet (0.2.0 `test/render/before` vs now) for Changes, graph, a list, PR tab.
- [ ] **Step 3:** Version `0.3.0` (edit the line only); `npm run package`; `code --install-extension gitland-0.3.0.vsix --force`. Commit `chore: release 0.3.0 — stream restyle`.
