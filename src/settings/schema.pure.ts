/** The Settings page's groups, built from the manifest's configuration schema (no vscode import: unit-tested). */

export interface SchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  markdownDescription?: string;
}

export interface Setting {
  /** Without the "gitland." prefix, e.g. "graph.maxCommits". */
  key: string;
  title: string;
  type: 'boolean' | 'enum' | 'number' | 'string' | 'text' | 'json';
  options?: string[];
  default: unknown;
  description: string;
}

export interface SettingsGroup {
  id: string;
  title: string;
  settings: Setting[];
}

/** Page order; a key goes to the first group one of whose prefixes it starts with. */
const GROUPS: { id: string; title: string; prefixes: string[] }[] = [
  { id: 'graph', title: 'Graph', prefixes: ['graph.'] },
  { id: 'blame', title: 'Blame & CodeLens', prefixes: ['blame.', 'codeLens.'] },
  { id: 'changes', title: 'Changes & AI', prefixes: ['changes.', 'ai.'] },
  { id: 'tickets', title: 'Tickets & branches', prefixes: ['branch.', 'tickets.'] },
  { id: 'pr', title: 'Pull requests & releases', prefixes: ['pr.', 'releases.'] },
  { id: 'pipelines', title: 'Pipelines', prefixes: ['pipelines.'] },
  { id: 'avatars', title: 'Avatars', prefixes: ['avatars.'] },
  { id: 'azure', title: 'Azure DevOps', prefixes: ['azureDevOps.'] },
];

function controlType(key: string, p: SchemaProperty): Setting['type'] {
  const t = Array.isArray(p.type) ? p.type[0] : p.type;
  if (t === 'boolean') {
    return 'boolean';
  }
  if (p.enum) {
    return 'enum';
  }
  if (t === 'number' || t === 'integer') {
    return 'number';
  }
  if (t === 'string') {
    return /Instructions$/.test(key) ? 'text' : 'string';
  }
  return 'json';
}

/** "statusBar.enabled" → "Status Bar Enabled". */
function titleOf(rest: string): string {
  return rest
    .split('.')
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
    .join(' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function settingsGroups(properties: Record<string, SchemaProperty>): SettingsGroup[] {
  const groups = new Map<string, SettingsGroup>();
  for (const [full, p] of Object.entries(properties)) {
    const key = full.replace(/^gitland\./, '');
    const def = GROUPS.find((g) => g.prefixes.some((x) => key.startsWith(x)));
    const id = def?.id ?? 'other';
    const prefix = def?.prefixes.find((x) => key.startsWith(x)) ?? '';
    if (!groups.has(id)) {
      groups.set(id, { id, title: def?.title ?? 'Other', settings: [] });
    }
    groups.get(id)!.settings.push({
      key,
      title: titleOf(key.slice(prefix.length)),
      type: controlType(key, p),
      options: p.enum?.map(String),
      default: p.default,
      description: p.markdownDescription ?? p.description ?? '',
    });
  }
  const order = [...GROUPS.map((g) => g.id), 'other'];
  return [...groups.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
