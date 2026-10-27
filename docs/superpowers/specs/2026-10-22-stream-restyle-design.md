# Gitland restyle v2 — Sixth "stream" — design

Date: 2026-10-22
Status: approved by the user from the mockup ("We are good")
Mockup: `docs/superpowers/specs/2026-10-22-stream-restyle-mockup.html` (open in a browser)

## Why

The v0.1/0.2 restyle filled every section with a rounded block (header block, input block, button blocks,
list blocks, section cards on tab pages). The user finds it "too bricky". Direction C, chosen from four
mockups, follows Sixth's own sidebar more closely. All features and behaviour stay; this is CSS plus a few markup moves.

## Rules

1. **One filled card per screen** (`--gl-card` background), Sixth's "Task" card:
   - Changes view: the branch header (`.sync`).
   - Graph: the selected commit's summary in the details pane.
   - Tab pages (PR, ticket, new PR, new release, history, compare, dashboard, cleanup, rebase, settings): the title
     header (`.t-head` + `.t-actions`, or the page's header equivalent).
   - Floating things (hover card, menus, pickers, diff preview) keep the hover-widget surface: they float, they are not bricks.
   Sidebar lists (tickets, PRs, releases, pipelines) have no filled card.
2. **Sections are dashed "checkpoint" separators**, not boxes: `⚑ Staged · 2 - - - - - [Unstage all]`. Name in muted
   bold at the left, dashed rule, then small dashed-outline action buttons (`.gl-ck`, `.gl-ck .act`).
3. **Short clickable lists are outlined rows** (`.gl-orow`: 1px `--gl-line` border, radius 8, transparent, 6px 10px,
   6px apart): changed files in Changes and in the graph details, tickets, PRs, releases, pipeline runs, work items,
   PR checks list stays plain rows.
4. **Long lists stay plain dense rows**: the commit graph (22px), compare/history commit lists, settings rows.
5. **Chips, not pills**: small square-ish (`radius 5`, height 18), dark neutral fill (`--gl-chip`), coloured **text**
   for meaning (branch/tag/PR/state). Replaces every round tinted pill (`.gl-pill`, `.pill`, `.ref`, `.pr-badge`,
   `.merged-chip`, `.rel-chip`, `.ci-label`, `.sig-chip`, `.hchip`, `.pr-chip`, `.tag`, `.sum`, `.ab > span`,
   `.ticket`, `.hook-chip`, `.chip`, `.link-chip`).
6. **Comments are quote lines** (2px dashed-colour left rule, no box), replies indented.
7. **Changes view composer at the bottom**: the message box, its meta row (ticket chip, Amend, Sign, hooks, counter) and
   Commit / Commit & Push stick to the bottom of the view (`position: sticky; bottom: 0` on the sidebar background),
   below the file groups. Op banner (merge/rebase in progress) and hook output stay above the groups.
8. Unchanged: theme-native tokens, VS Code font, 22px graph rows, all behaviour and message types, high-contrast borders
   (`--gl-border` on every outlined/filled element), focus outlines.

## Tokens

- `--gl-chip`: `color-mix(in srgb, var(--gl-fg) 12%, var(--gl-bg))` (dark grey on dark, light grey on light).
- `--gl-dash`: `color-mix(in srgb, var(--gl-fg) 22%, transparent)` for dashed rules and dashed action outlines.
- `--gl-card` stays the one filled surface; `--gl-inset` remains only for inputs and code/log blocks.

## Out of scope

New features, behaviour changes, the inline PR comments design.
