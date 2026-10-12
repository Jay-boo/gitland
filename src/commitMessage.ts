import * as vscode from 'vscode';
import { Repo } from './git/repo';
import { config } from './util';

/** Minimal typing of the Language Model API (VS Code 1.90+; @types/vscode here is older). */
interface ChatModel {
  readonly name: string;
  readonly vendor: string;
  readonly family: string;
  sendRequest(messages: unknown[], options: object, token: vscode.CancellationToken): Promise<{ text: AsyncIterable<string> }>;
}
interface LmApi {
  selectChatModels(selector?: { vendor?: string; family?: string }): Promise<ChatModel[]>;
}
interface ChatMessageFactory {
  User(content: string): unknown;
}

const MAX_DIFF = 14000;

/**
 * Writes a commit message from the changes with the editor's language model (GitHub Copilot or any
 * other provider), like the ✨ button of the Source Control view. `onText` receives the text as it comes.
 */
export async function generateCommitMessage(
  repo: Repo,
  ticket: { id: string; title?: string; prefix: string } | undefined,
  onText: (text: string) => void,
  token: vscode.CancellationToken,
): Promise<string> {
  const lm = (vscode as unknown as { lm?: LmApi }).lm;
  const Msg = (vscode as unknown as { LanguageModelChatMessage?: ChatMessageFactory }).LanguageModelChatMessage;
  if (!lm || !Msg) {
    throw new Error('This VS Code has no language model API: update VS Code to generate commit messages.');
  }
  const model = await pickModel(lm);
  if (!model) {
    throw new Error('No language model available. Install and sign in to GitHub Copilot (or another model provider) to generate commit messages.');
  }

  // What is committed: the staged changes, else everything (that is what Commit would stage).
  const staged = await repo.exec(['diff', '--cached', '--stat', '--patch', '-M', '--no-color', '--no-ext-diff']);
  let diff = staged;
  if (!staged.trim()) {
    const [work, untracked] = await Promise.all([
      repo.exec(['diff', '--stat', '--patch', '-M', '--no-color', '--no-ext-diff']),
      repo.exec(['ls-files', '--others', '--exclude-standard']),
    ]);
    diff = work + (untracked.trim() ? `\n\nNew untracked files:\n${untracked}` : '');
  }
  if (!diff.trim()) {
    throw new Error('No changes to describe.');
  }
  if (diff.length > MAX_DIFF) {
    diff = diff.slice(0, MAX_DIFF) + `\n\n[… diff truncated, ${diff.length - MAX_DIFF} more characters]`;
  }
  const [recent, branch] = await Promise.all([
    repo.exec(['log', '-12', '--no-merges', '--format=%s']).catch(() => ''),
    repo.currentBranch(),
  ]);

  const extra = config('changes.commitMessageInstructions', '').trim();
  const prompt = [
    'Write the git commit message for the changes below.',
    '- First line: a short summary in the imperative mood, at most 72 characters, no trailing period.',
    '- Then, only if it helps, a blank line and a short body (what and why, not how), wrapped at 72 columns; use "- " bullets for several points.',
    '- Follow the style of the recent commit messages of this repository (language, prefixes such as "feat:" / "fix:", capitalization).',
    ticket ? `- The work is for ticket ${ticket.prefix}${ticket.id}${ticket.title ? ` "${ticket.title}"` : ''}: end the first line with ${ticket.prefix}${ticket.id}.` : '',
    extra ? `- ${extra}` : '',
    '- Answer with the commit message only: no code fences, no quotes, no explanations.',
    '',
    branch ? `Branch: ${branch}` : '',
    recent.trim() ? `Recent commit messages:\n${recent.trim()}` : '',
    '',
    `Changes:\n${diff}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  const res = await model.sendRequest([Msg.User(prompt)], { justification: 'Gitland writes a commit message from your changes.' }, token);
  let text = '';
  for await (const chunk of res.text) {
    text += chunk;
    onText(clean(text));
  }
  return clean(text);
}

/**
 * Title and description of a pull request from its commits and diff, with the language model.
 * When the repository has a PR template, the description keeps its structure (headings, checklists)
 * and fills it in.
 */
export async function generatePullRequestText(
  repo: Repo,
  o: {
    base: string;
    head: string;
    source: string;
    target: string;
    template?: string;
    ticket?: { id: string; title?: string; prefix: string };
  },
  onText: (parts: { title: string; description: string }) => void,
  token: vscode.CancellationToken,
): Promise<{ title: string; description: string }> {
  const lm = (vscode as unknown as { lm?: LmApi }).lm;
  const Msg = (vscode as unknown as { LanguageModelChatMessage?: ChatMessageFactory }).LanguageModelChatMessage;
  if (!lm || !Msg) {
    throw new Error('This VS Code has no language model API: update VS Code to generate pull request descriptions.');
  }
  const model = await pickModel(lm);
  if (!model) {
    throw new Error('No language model available. Install and sign in to GitHub Copilot (or another model provider).');
  }
  const range = `${o.base}...${o.head}`;
  const [commits, stat, patch] = await Promise.all([
    repo.exec(['log', '--no-merges', '--format=- %s%n%w(0,2,2)%b', `${o.base}..${o.head}`]).catch(() => ''),
    repo.exec(['diff', '--stat', range]).catch(() => ''),
    repo.exec(['diff', '-M', '--no-color', '--no-ext-diff', range]).catch(() => ''),
  ]);
  if (!commits.trim() && !patch.trim()) {
    throw new Error(`No changes between ${o.target} and ${o.source}.`);
  }
  const diff = patch.length > MAX_DIFF ? patch.slice(0, MAX_DIFF) + `\n\n[… diff truncated, ${patch.length - MAX_DIFF} more characters]` : patch;
  const extra = config('pr.descriptionInstructions', '').trim();
  const prompt = [
    `Write the title and the description of a pull request that merges "${o.source}" into "${o.target}".`,
    '- Line 1: the title only (short, imperative, at most 80 characters). Line 2: empty. Then the description in markdown.',
    o.template
      ? '- The repository has a pull request TEMPLATE (below). The description MUST follow it: keep every heading, section and checklist of the template in the same order, and fill each section from the changes. Tick a checklist box ("- [x]") only when the changes clearly satisfy it; leave the others unticked. The HTML comments (<!-- -->) of the template are instructions for the author: follow them and replace them with the content, do not keep them.'
      : '- Description: a short summary of what changes and why, then the main changes as "- " bullets, then anything reviewers should check.',
    '- Be factual: describe what the diff and commits show, no invented tests, numbers or links.',
    o.ticket ? `- It implements ticket ${o.ticket.prefix}${o.ticket.id}${o.ticket.title ? ` "${o.ticket.title}"` : ''}: mention it where the template asks for it (else at the end).` : '',
    extra ? `- ${extra}` : '',
    '- Answer with the title and description only: no code fences around the whole answer, no explanations.',
    '',
    o.template ? `TEMPLATE:\n${o.template.trim()}\n` : '',
    `COMMITS:\n${commits.trim() || '(none)'}`,
    '',
    `FILES:\n${stat.trim()}`,
    '',
    `DIFF:\n${diff}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
  const res = await model.sendRequest([Msg.User(prompt)], { justification: 'Gitland writes a pull request description from your changes.' }, token);
  let text = '';
  const split = (t: string) => {
    const c = t.replace(/^\s*```[\w-]*\n?/, '').replace(/\n?```\s*$/, '').replace(/^\s*(title:\s*)/i, '');
    const nl = c.indexOf('\n');
    return { title: (nl < 0 ? c : c.slice(0, nl)).replace(/^#+\s*/, '').replace(/^"|"$/g, '').trim(), description: nl < 0 ? '' : c.slice(nl + 1).replace(/^\s*\n/, '').replace(/^(description:\s*)/i, '') };
  };
  for await (const chunk of res.text) {
    text += chunk;
    onText(split(text));
  }
  return split(text);
}

/** CHANGELOG.md (any case) at a ref, else in the working tree. */
export async function readChangelog(repo: Repo, ref = 'HEAD'): Promise<{ path: string; text: string } | undefined> {
  const files = (await repo.exec(['ls-tree', '--name-only', ref]).catch(() => repo.exec(['ls-files']).catch(() => ''))).split('\n');
  const file = files.find((f) => /^changelog(\.md)?$/i.test(f.trim()))?.trim();
  if (!file) {
    return undefined;
  }
  const text = await repo.exec(['show', `${ref}:${file}`]).catch(() => undefined);
  return text ? { path: file, text } : undefined;
}

/**
 * Release notes for the changes from `from` to `to` (e.g. two tags), in the style of the
 * repository's CHANGELOG.md when there is one: its headings, categories and bullet style.
 */
export async function generateReleaseNotes(
  repo: Repo,
  o: { from: string; to: string; version: string; ticketPrefix: string },
  onText: (text: string) => void,
  token: vscode.CancellationToken,
): Promise<string> {
  const lm = (vscode as unknown as { lm?: LmApi }).lm;
  const Msg = (vscode as unknown as { LanguageModelChatMessage?: ChatMessageFactory }).LanguageModelChatMessage;
  if (!lm || !Msg) {
    throw new Error('This VS Code has no language model API: update VS Code to generate release notes.');
  }
  const model = await pickModel(lm);
  if (!model) {
    throw new Error('No language model available. Install and sign in to GitHub Copilot (or another model provider).');
  }
  const range = `${o.from}..${o.to}`;
  const [commits, merges, stat, changelog] = await Promise.all([
    repo.exec(['log', '--no-merges', '--format=- %s (%h, %an)%n%w(0,2,2)%b', range]).catch(() => ''),
    repo.exec(['log', '--merges', '--format=- %s', range]).catch(() => ''),
    repo.exec(['diff', '--stat', range]).catch(() => ''),
    readChangelog(repo, o.to),
  ]);
  if (!commits.trim() && !merges.trim()) {
    throw new Error(`No changes between ${o.from} and ${o.to}.`);
  }
  // A sample of the existing changelog: its title and the latest sections.
  const sample = changelog ? changelog.text.split('\n').slice(0, 80).join('\n') : '';
  const extra = config('releases.notesInstructions', '').trim();
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '\n[…]' : t);
  const prompt = [
    `Write the release notes of version ${o.version} (changes from ${o.from} to ${o.to}).`,
    sample
      ? '- Follow the style of the repository CHANGELOG below exactly: the same version heading format (with today\'s date if the others have dates), the same categories and their order (e.g. Added / Changed / Fixed), the same bullet style and language.'
      : '- Start with a "## <version> - <today>" heading, then group the changes under "### Features", "### Fixes" and "### Other" (only the non-empty ones).',
    '- One bullet per user-visible change, in plain words; merge duplicates; leave out merge commits, version bumps and changelog-only commits.',
    `- Keep ticket references (${o.ticketPrefix}1234) and pull request numbers when the commits have them.`,
    '- Be factual: only what the commits and pull requests show.',
    extra ? `- ${extra}` : '',
    '- Answer with the section only (starting with its heading): no code fences, no explanations.',
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    '',
    sample ? `EXISTING CHANGELOG (${changelog!.path}):\n${sample}\n` : '',
    `PULL REQUESTS MERGED:\n${merges.trim() || '(none)'}`,
    '',
    `COMMITS:\n${clip(commits.trim(), MAX_DIFF)}`,
    '',
    `FILES:\n${clip(stat.trim(), 3000)}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
  const res = await model.sendRequest([Msg.User(prompt)], { justification: 'Gitland writes release notes from the commits.' }, token);
  let text = '';
  const clean = (t: string) => t.replace(/^\s*```[\w-]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  for await (const chunk of res.text) {
    text += chunk;
    onText(clean(text));
  }
  return clean(text);
}

/**
 * Inserts a release section into CHANGELOG.md, above the latest version section (after the title
 * and an "Unreleased" section if any), and shows it in the editor — not saved, so it can be reviewed.
 */
export async function insertIntoChangelog(repo: Repo, section: string): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const names = await fs.readdir(repo.root);
  const name = names.find((n) => /^changelog(\.md)?$/i.test(n)) ?? 'CHANGELOG.md';
  const uri = vscode.Uri.file(path.join(repo.root, name));
  const exists = names.includes(name);
  if (!exists) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from('# Changelog\n\n'));
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const lines = doc.getText().split('\n');
  // Above the first version heading ("## [1.2.3]", "## 1.2.3", "## v1.2.3"), below "Unreleased".
  let at = lines.findIndex((l) => /^##\s+\[?v?\d+\.\d+/.test(l));
  if (at < 0) {
    at = lines.length;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(at, 0), section.trim() + '\n\n');
  await vscode.workspace.applyEdit(edit);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  editor.revealRange(new vscode.Range(at, 0, at, 0), vscode.TextEditorRevealType.AtTop);
  editor.selection = new vscode.Selection(at, 0, at, 0);
}

/** Sends one prompt to the editor's language model and streams the cleaned answer. */
async function streamModel(prompt: string, justification: string, onText: (text: string) => void, token: vscode.CancellationToken): Promise<string> {
  const lm = (vscode as unknown as { lm?: LmApi }).lm;
  const Msg = (vscode as unknown as { LanguageModelChatMessage?: ChatMessageFactory }).LanguageModelChatMessage;
  if (!lm || !Msg) {
    throw new Error('This VS Code has no language model API: update VS Code to use the AI features.');
  }
  const model = await pickModel(lm);
  if (!model) {
    throw new Error('No language model available. Install and sign in to GitHub Copilot (or another model provider).');
  }
  const res = await model.sendRequest([Msg.User(prompt)], { justification }, token);
  let text = '';
  const clean = (t: string) => t.replace(/^\s*```(?:markdown|md)?\n/, '').replace(/\n?```\s*$/, '').trim();
  for await (const chunk of res.text) {
    text += chunk;
    onText(clean(text));
  }
  return clean(text);
}

export interface ExplainInput {
  kind: 'commit' | 'lines' | 'file';
  /** e.g. "src/app.ts:40-52", "src/app.ts", "commit 1a2b3c4". */
  subject: string;
  commits: { sha: string; author: string; date: number; subject: string; body?: string }[];
  /** Diffs, newest first (truncated by the caller or here). */
  patches?: string;
  /** Titles of the tickets / PRs mentioned, when known. */
  context?: string[];
  /** Current content of the lines being explained. */
  code?: string;
}

/**
 * "Explain this": why the code is the way it is — from the commits, their diffs and the tickets /
 * pull requests they mention. Markdown, streamed.
 */
export function explainHistory(i: ExplainInput, onText: (text: string) => void, token: vscode.CancellationToken): Promise<string> {
  const extra = config('ai.explainInstructions', '').trim();
  const commits = i.commits
    .slice(0, 60)
    .map((c) => `- ${c.sha.slice(0, 7)} ${new Date(c.date).toISOString().slice(0, 10)} ${c.author}: ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, '\n  ').slice(0, 600)}` : ''}`)
    .join('\n');
  const task = {
    commit: 'Explain this commit: what it changes, why (from its message, the tickets and pull requests it mentions), and what a reviewer should know.',
    lines: 'Explain why these lines of code are the way they are today: how they evolved, which commit introduced each important part and why, the tickets / pull requests behind them, and anything surprising.',
    file: 'Summarize the history of this file: what it is for, the main stages of its evolution (grouped, not commit by commit), who worked on it, and the tickets / pull requests behind the big changes.',
  }[i.kind];
  const prompt = [
    `${task} Subject: ${i.subject}.`,
    '- Answer in markdown: a one-paragraph summary first, then short sections or bullets. Mention commits by their short SHA (7 characters) and tickets / PRs by their number.',
    '- Be factual: only what the commits, diffs and ticket titles show; say when the reason is not recorded.',
    '- Be concise (at most ~250 words).',
    extra ? `- ${extra}` : '',
    '',
    i.code ? `CURRENT CODE:\n${i.code.slice(0, 4000)}\n` : '',
    i.context?.length ? `TICKETS / PULL REQUESTS:\n${i.context.join('\n')}\n` : '',
    `COMMITS (newest first):\n${commits}`,
    '',
    i.patches ? `DIFFS (newest first):\n${i.patches.slice(0, MAX_DIFF)}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return streamModel(prompt, 'Gitland explains the history of your code.', onText, token);
}

async function pickModel(lm: LmApi): Promise<ChatModel | undefined> {
  const wanted = config('changes.commitMessageModel', '').trim();
  if (wanted) {
    const [m] = await lm.selectChatModels({ family: wanted });
    if (m) {
      return m;
    }
  }
  const copilot = await lm.selectChatModels({ vendor: 'copilot' });
  // Small and fast models are enough for a commit message.
  const prefer = ['gpt-4o-mini', 'gpt-4.1', 'gpt-4o', 'claude-sonnet'];
  for (const family of prefer) {
    const m = copilot.find((x) => x.family.startsWith(family));
    if (m) {
      return m;
    }
  }
  return copilot[0] ?? (await lm.selectChatModels())[0];
}

/** Strips what models add despite the instructions (fences, quotes, "Commit message:"). */
function clean(text: string): string {
  return text
    .replace(/^\s*```[\w-]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\s*(commit message:?\s*)/i, '')
    .replace(/^"([\s\S]*)"$/, '$1')
    .replace(/^\s+/, '');
}
