import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { AzureDevOpsProvider } from '../providers/azureDevOps';
import { TicketSource } from '../providers/types';
import { errorMessage } from '../util';

type SourceItem = vscode.QuickPickItem & { source?: TicketSource; target?: vscode.ConfigurationTarget; add?: boolean };

const REMOVE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove this ticket source' };

/**
 * "Gitland: Ticket Sources…": the Azure DevOps projects the tickets come from, when they live in
 * another project than the code (a shared backlog). Stored in gitland.tickets.sources.
 */
export async function manageTicketSources(repos: RepoManager, secrets: vscode.SecretStorage): Promise<boolean> {
  const repo = await repos.activeRepo(false);
  const provider = repo && (await getProvider(repo, secrets));
  const repoOrg = provider instanceof AzureDevOpsProvider ? provider.organization : undefined;
  let changed = false;

  for (;;) {
    const cfg = vscode.workspace.getConfiguration('gitland').inspect<TicketSource[]>('tickets.sources');
    const items: SourceItem[] = [];
    for (const [list, target, where] of [
      [cfg?.workspaceValue, vscode.ConfigurationTarget.Workspace, 'this workspace'],
      [cfg?.globalValue, vscode.ConfigurationTarget.Global, 'all workspaces'],
    ] as const) {
      for (const source of list ?? []) {
        items.push({
          label: `$(project) ${source.project}`,
          description: `${source.organization} · ${where}`,
          detail: source.wiql ? `WIQL: ${source.wiql}` : undefined,
          source,
          target,
          buttons: [REMOVE],
        });
      }
    }
    if (!items.length && provider instanceof AzureDevOpsProvider) {
      items.push({ label: `$(repo) ${provider.ticketSources[0].project}`, description: 'the repository’s project (default)', alwaysShow: true });
    }
    items.push({ label: '$(add) Add a ticket source…', description: 'another Azure DevOps project, e.g. your backlog', add: true, alwaysShow: true });

    const pick = await new Promise<SourceItem | 'removed' | undefined>((resolve) => {
      const qp = vscode.window.createQuickPick<SourceItem>();
      qp.title = 'Gitland: Ticket Sources';
      qp.placeholder = 'Projects your tickets are read from';
      qp.items = items;
      qp.onDidTriggerItemButton(async (e) => {
        qp.hide();
        await removeSource(e.item.source!, e.item.target!);
        resolve('removed');
      });
      qp.onDidAccept(() => {
        resolve(qp.selectedItems[0]);
        qp.hide();
      });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    if (pick === 'removed') {
      changed = true;
      continue;
    }
    if (!pick?.add) {
      return changed;
    }
    if (await addSource(secrets, repoOrg)) {
      changed = true;
    }
  }
}

async function addSource(secrets: vscode.SecretStorage, repoOrg?: string): Promise<boolean> {
  const org = (
    await vscode.window.showInputBox({
      title: 'Add a ticket source (1/3)',
      prompt: 'Azure DevOps organization of the tickets',
      value: repoOrg ?? '',
      placeHolder: 'my-organization (from https://dev.azure.com/my-organization)',
    })
  )
    ?.trim()
    .replace(/^https:\/\/dev\.azure\.com\//, '')
    .replace(/\/.*$/, '');
  if (!org) {
    return false;
  }
  const api = new AzureDevOpsProvider(org, '', '', secrets);
  const projects = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Loading the projects of ${org}…` },
    () => api.listProjects(org).catch((e) => e as Error),
  );
  let project: string | undefined;
  if (projects instanceof Error) {
    vscode.window.showWarningMessage(`Could not list the projects of ${org}: ${errorMessage(projects)}`);
    project = (await vscode.window.showInputBox({ title: 'Add a ticket source (2/3)', prompt: `Project name in ${org}` }))?.trim();
  } else {
    project = (
      await vscode.window.showQuickPick(
        projects.map((p) => ({ label: p.name, detail: p.description })),
        { title: 'Add a ticket source (2/3)', placeHolder: `Project of ${org} that holds the tickets`, matchOnDetail: true },
      )
    )?.label;
  }
  if (!project) {
    return false;
  }
  const scope = await vscode.window.showQuickPick(
    [
      { label: 'This workspace', description: 'saved in .vscode/settings.json', target: vscode.ConfigurationTarget.Workspace },
      { label: 'All workspaces', description: 'user settings', target: vscode.ConfigurationTarget.Global },
    ],
    { title: 'Add a ticket source (3/3)', placeHolder: `Use ${project} for…` },
  );
  if (!scope) {
    return false;
  }
  const cfg = vscode.workspace.getConfiguration('gitland');
  const current = (scope.target === vscode.ConfigurationTarget.Global ? cfg.inspect<TicketSource[]>('tickets.sources')?.globalValue : cfg.inspect<TicketSource[]>('tickets.sources')?.workspaceValue) ?? [];
  if (!current.some((s) => s.organization === org && s.project === project)) {
    await cfg.update('tickets.sources', [...current, { organization: org, project }], scope.target);
  }
  vscode.window.setStatusBarMessage(`Gitland: tickets now also come from ${project}`, 4000);
  return true;
}

async function removeSource(source: TicketSource, target: vscode.ConfigurationTarget): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitland');
  const info = cfg.inspect<TicketSource[]>('tickets.sources');
  const list = (target === vscode.ConfigurationTarget.Global ? info?.globalValue : info?.workspaceValue) ?? [];
  const next = list.filter((s) => !(s.organization === source.organization && s.project === source.project));
  await cfg.update('tickets.sources', next.length ? next : undefined, target);
}
