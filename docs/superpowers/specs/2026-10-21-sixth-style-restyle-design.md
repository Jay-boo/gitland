# Gitland restyle — Sixth-inspired, theme-native

Date: 2026-10-21
Status: approved in brainstorming, awaiting spec review

## Goal

The user doesn't like Gitland's current look. Restyle every Gitland webview after
[Sixth AI](https://marketplace.visualstudio.com/items?itemName=Sixth.sixth-ai): native to the
VS Code theme, rounded cards, pill chips, segmented switches, solid buttons, dashed separators.
Lists stay dense (22px rows). **No feature is removed or changed in behavior** — this is a visual
and code-structure change only.

This is part 1 of 4. Later parts, each with its own spec: (2) README + screenshots,
(3) split `graph.js` / `graphPanel.ts` + unit tests, (4) new features (inline PR comments,
graph keyboard nav, pipelines view, work-item quick actions, branch↔ticket nudge, settings UI).

## Decisions (from the user)

| Question | Choice |
|---|---|
| Colours / font | Follow the VS Code theme (theme variables + VS Code font), like Sixth |
| Density | Sixth cards for headers, composer, details; lists in one rounded card with 22px rows |
| Branch colours | Theme chart colours (`--vscode-charts-*`), same semantic mapping as today |
| Existing features | All kept; every surface (hover card, menus, minimap…) gets the new look |

## Visual language

- **Font**: `var(--vscode-font-family)` / `var(--vscode-font-size)` for text;
  `var(--vscode-editor-font-family)` for SHAs, dates, counts. Bundled Geist / Geist Mono are
  removed from `media/vendor/` and from `webviewHtml.ts`.
- **Surfaces**: page background = the host's (`--vscode-sideBar-background` in views,
  `--vscode-editor-background` in tabs). Cards = background mixed ~4% towards foreground.
  Floating cards (hover, menus, dropdowns) = `--vscode-editorHoverWidget-*` / `--vscode-menu-*`
  with a soft shadow (`--vscode-widget-shadow`).
- **Radius**: cards 10px, list card 10px, file/row hover 0 (full-width inside the card),
  inputs 8px, buttons 6px, pills 999px, menu items 5px.
- **Buttons**: primary = `--vscode-button-background/foreground`; secondary =
  `--vscode-button-secondaryBackground/Foreground`; icon buttons stay transparent.
- **Pills**: `color: X; background: color-mix(in srgb, X 15%, transparent)`; neutral pills use the
  card surface darkened.
- **Separators**: dashed `1px` line in `--vscode-widget-border` / faint foreground, with tiny
  outlined actions on it (Sixth's "Checkpoint · Compare · Restore").
- **Colour tokens** (all hex literals in `media/*.css` replaced):
  - `--gl-main` → `--vscode-charts-blue`, `--gl-dev` → `charts-green`, `--gl-feature` →
    `charts-purple`, `--gl-fix` → `charts-red` at reduced mix, `--gl-hotfix` → `charts-red`,
    `--gl-release` → `charts-yellow`, `--gl-chore` → `descriptionForeground`; "other" names keep a
    stable index into a list built from these + `charts-orange`.
  - `--gl-added/modified/deleted/renamed/conflict` → `--vscode-gitDecoration-*`.
  - `--gl-ai` (today's `#c6ab6e` sparkle/generation colour) → `charts-yellow`.
  - `--gl-ok/warn/err` → `--vscode-testing-iconPassed`, `editorWarning-foreground`,
    `errorForeground`.
  - Every token has a hard fallback so the page renders outside VS Code (headless harness).
- Graph lanes read colours from the same tokens (the `COLORS` array in `media/graph.js` becomes a
  read of computed CSS variables), so the SVG follows the theme.

## Code structure

- **`media/base.css`** (new): tokens, reset, typography, scrollbars, and the components:
  `.card`, `.list` + `.row`, `.pill` (+ colour modifiers), `.seg`, `button` / `.primary` /
  `.secondary` / `.icon`, `.sep`, `.pop` (floating card + menu items), `.sec` (section header with
  icon), `.composer` (rounded input with inline action), `.empty`, `.skeleton`, `.tab-head`
  (title, status pill, right-aligned actions).
- **`media/graph.css`**: graph-only rules on top of base.css.
- **`media/list.css`, `changes.css`, `ticket.css`, …**: keep only view-specific layout; restyled to
  use base components.
- **`media/common.js`** (new, loaded before each view script): `esc`, `icon`, relative time,
  `post(type, data)` / `on(type, fn)` message bridge, `$` helper. The 16 private copies are removed.
- **`src/views/webviewHtml.ts`**: loads `base.css` + `common.js` first, drops the Geist
  `@font-face`. `graphPanel.ts` builds its own HTML today — it switches to `webviewHtml` too.
- CSP unchanged; no inline `style=""` (dynamic colours set through `element.style.setProperty`
  or classes, as today).

## Surfaces to migrate (all)

1. **Graph** (view, panel, editor tab): toolbar (search, view-mode `.seg`, filter, branches
   dropdown), activity minimap, commit rows, ref badges, PR / CI badges, stash rows, uncommitted
   bubble, hover card, details pane (files, signature, release, links), context menus, compare
   mode, drag-and-drop feedback, responsive compact mode, focus/fade mode.
2. **Changes** (view, panel, editor): sync bar → branch card with ahead/behind pills; composer
   (AI generate, ticket chip, length counter, amend, sign switch); Commit / Commit & Push button
   pair; staged / changes / conflicts groups as `.sep` headers over `.list` cards; operation
   banner; hook output.
3. **Sidebar lists**: My Tickets, Pull Requests, Releases.
4. **Tabs**: PR, ticket, new PR, new release, compare, file/line history, dashboard, cleanup,
   interactive rebase — all with `.tab-head`.
5. **Editor blame hovers** (VS Code MarkdownString, not stylable by CSS): align content only —
   same codicons, theme-coloured spans where `supportHtml` allows, consistent ordering with the
   graph hover card.

## Testing

- Headless Chromium harness (playwright-core, as before) renders every webview with real repo data
  **with the production CSP**, in three themes: Dark Modern, Light Modern, High Contrast Dark
  (theme variables injected from captured values). Before/after screenshots shown to the user per
  surface group.
- `npm run typecheck` and `npm test` (VS Code suite) pass.
- Manual check after install: hover card, context menu, drag-and-drop, minimap click, compare,
  commit flow, conflict banner.

## Out of scope

README, graph refactor, unit tests for layout, new features (parts 2–4). No behaviour changes.
