import * as vscode from 'vscode';
import { BlameCommit, UNCOMMITTED_SHA } from '../git/repo';
import { config, timeAgo } from '../util';
import { BlameController, BlameResult } from './blameController';

const CONTAINER_KINDS = new Set([
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Package,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
]);

const BLOCK_KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);

class BlameLens extends vscode.CodeLens {
  constructor(range: vscode.Range, readonly doc: vscode.TextDocument, readonly kind: 'recent' | 'authors', readonly scope: vscode.Range) {
    super(range);
  }
}

/**
 * GitLens-style code lenses: "Author, 3 days ago" (most recent change) and "N authors (X and others)"
 * at the top of the file and above classes / functions.
 */
export class BlameCodeLensProvider implements vscode.CodeLensProvider<BlameLens> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly blame: BlameController) {
    blame.onDidChangeBlame(() => this.emitter.fire());
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitland.codeLens')) {
        this.emitter.fire();
      }
    });
  }

  async provideCodeLenses(doc: vscode.TextDocument, token: vscode.CancellationToken): Promise<BlameLens[]> {
    if (!config('codeLens.enabled', true) || doc.uri.scheme !== 'file') {
      return [];
    }
    // Only produce lenses for files git knows about.
    const blame = await this.blame.getBlame(doc);
    if (!blame || token.isCancellationRequested) {
      return [];
    }
    const scopes = config<string[]>('codeLens.scopes', ['document', 'containers', 'blocks']);
    const ranges: vscode.Range[] = [];
    if (scopes.includes('document')) {
      ranges.push(new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0));
    }
    if (scopes.includes('containers') || scopes.includes('blocks')) {
      let symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
      try {
        symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
      } catch {
        symbols = undefined;
      }
      const visit = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], depth: number) => {
        for (const s of list) {
          const range = 'range' in s ? s.range : s.location.range;
          const wanted =
            (scopes.includes('containers') && CONTAINER_KINDS.has(s.kind)) || (scopes.includes('blocks') && BLOCK_KINDS.has(s.kind));
          // Skip one-liners and the symbol that spans the whole file (already covered by 'document').
          if (wanted && range.end.line > range.start.line && !(range.start.line === 0 && ranges.length)) {
            ranges.push(range);
          }
          if ('children' in s && depth < 3) {
            visit(s.children, depth + 1);
          }
        }
      };
      visit(symbols ?? [], 0);
    }
    const lenses: BlameLens[] = [];
    for (const scope of ranges.slice(0, 300)) {
      const anchor = new vscode.Range(scope.start.line, 0, scope.start.line, 0);
      lenses.push(new BlameLens(anchor, doc, 'recent', scope), new BlameLens(anchor, doc, 'authors', scope));
    }
    return lenses;
  }

  async resolveCodeLens(lens: BlameLens): Promise<BlameLens> {
    const blame = await this.blame.getBlame(lens.doc);
    const commits = blame ? commitsIn(blame, lens.scope) : [];
    if (!blame || commits.length === 0) {
      lens.command = { title: '', command: '' };
      return lens;
    }
    if (lens.kind === 'recent') {
      const recent = commits.reduce((a, b) => (b.sha === UNCOMMITTED_SHA || (a.sha !== UNCOMMITTED_SHA && b.date > a.date) ? b : a));
      const author = this.blame.authorName(recent, blame.me);
      lens.command =
        recent.sha === UNCOMMITTED_SHA
          ? { title: '$(pencil) You, uncommitted changes', command: '' }
          : {
              title: `$(history) ${author}, ${timeAgo(recent.date)}`,
              tooltip: `${recent.summary}\n\n${recent.sha.slice(0, 8)} · click to show in the graph`,
              command: 'gitland.showGraph',
              arguments: [{ repoRoot: blame.repo.root, sha: recent.sha }],
            };
    } else {
      const counts = new Map<string, number>();
      for (let i = lens.scope.start.line; i <= lens.scope.end.line && i < blame.lines.length; i++) {
        const name = this.blame.authorName(blame.lines[i], blame.me);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const sorted = [...counts].sort((a, b) => b[1] - a[1]);
      const n = sorted.length;
      const title = n === 1 ? `$(person) 1 author (${sorted[0][0]})` : `$(organization) ${n} authors (${sorted[0][0]} and ${n - 1} other${n > 2 ? 's' : ''})`;
      const total = sorted.reduce((s, [, c]) => s + c, 0);
      lens.command = {
        title,
        tooltip: sorted.map(([a, c]) => `${a}: ${Math.round((c / total) * 100)}%`).join('\n') + '\n\nClick to toggle file blame',
        command: 'gitland.toggleFileBlame',
      };
    }
    return lens;
  }
}

function commitsIn(blame: BlameResult, scope: vscode.Range): BlameCommit[] {
  const seen = new Map<string, BlameCommit>();
  for (let i = scope.start.line; i <= scope.end.line && i < blame.lines.length; i++) {
    const c = blame.lines[i];
    seen.set(c.sha, c);
  }
  return [...seen.values()];
}
