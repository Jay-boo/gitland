import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { getProvider } from '../providers';
import { AzureDevOpsProvider } from '../providers/azureDevOps';
import { hostOf } from '../providers/ticketOverlay';
import { JiraTickets, jiraSources, jiraTokenKey, promptJiraToken } from '../providers/jira';
import { isJiraSource, normalizeSite } from '../providers/jiraMap.pure';
import { TicketSource } from '../providers/types';
import { errorMessage } from '../util';

type SourceItem = vscode.QuickPickItem & { source?: TicketSource; target?: vscode.ConfigurationTarget; add?: 'azure' | 'jira' };

const REMOVE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove this ticket source' };

/**
 * "Gitland: Ticket Sources…": the projects the tickets come from, when they live elsewhere than the code:
 * another Azure DevOps project (a shared backlog), or Jira projects (for any code host; Jira tickets then
 * replace the host's). Stored in gitland.tickets.sources.
 */
export async function manageTicketSources(repos: RepoManager, secrets: vscode.SecretStorage): Promise<boolean> {
  const repo = await repos.activeRepo(false);
  // The code host, also when the tickets come from Jira.
  const provider = hostOf(repo && (await getProvider(repo, secrets)));
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
        if (isJiraSource(source)) {
          items.push({
            label: `$(issues) Jira · ${source.project}`,
            description: `${source.site} · ${where}`,
            detail: source.jql ? `JQL: ${source.jql}` : undefined,
            source,
            target,
            buttons: [REMOVE],
          });
          continue;
        }
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
    items.push({ label: '$(add) Add a ticket source…', description: 'another Azure DevOps project, e.g. your backlog', add: 'azure', alwaysShow: true });
    items.push({ label: '$(add) Add a Jira project…', description: 'Jira Cloud or Server / Data Center', add: 'jira', alwaysShow: true });

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
    if (await (pick.add === 'jira' ? addJiraSource(secrets) : addSource(secrets, repoOrg))) {
      changed = true;
    }
  }
}

/** Where a new source is saved. */
async function pickScope(name: string, step: string): Promise<vscode.ConfigurationTarget | undefined> {
  const scope = await vscode.window.showQuickPick(
    [
      { label: 'This workspace', description: 'saved in .vscode/settings.json', target: vscode.ConfigurationTarget.Workspace },
      { label: 'All workspaces', description: 'user settings', target: vscode.ConfigurationTarget.Global },
    ],
    { title: `Add a ticket source (${step})`, placeHolder: `Use ${name} for…` },
  );
  return scope?.target;
}

function sourcesAt(target: vscode.ConfigurationTarget): TicketSource[] {
  const info = vscode.workspace.getConfiguration('gitland').inspect<TicketSource[]>('tickets.sources');
  return (target === vscode.ConfigurationTarget.Global ? info?.globalValue : info?.workspaceValue) ?? [];
}

async function addJiraSource(secrets: vscode.SecretStorage): Promise<boolean> {
  const known = [...new Set(jiraSources().map((s) => normalizeSite(s.site)))];
  const input = (
    await vscode.window.showInputBox({
      title: 'Add a Jira project (1/3)',
      prompt: 'Jira site',
      value: known[0] ?? '',
      placeHolder: 'https://your-company.atlassian.net, or https://jira.your-company.com',
      ignoreFocusOut: true,
    })
  )?.trim();
  if (!input) {
    return false;
  }
  let site: string;
  try {
    site = normalizeSite(input);
  } catch {
    vscode.window.showWarningMessage(`Gitland: "${input}" is not a site address.`);
    return false;
  }
  if (!(await secrets.get(jiraTokenKey(site))) && !(await promptJiraToken(site, secrets))) {
    return false;
  }
  const projects = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Loading the Jira projects of ${site}…` },
    () => new JiraTickets([], secrets).listProjects(site).catch((e) => e as Error),
  );
  let project: string | undefined;
  if (projects instanceof Error) {
    vscode.window.showWarningMessage(`Could not list the Jira projects of ${site}: ${errorMessage(projects)}`);
    project = (await vscode.window.showInputBox({ title: 'Add a Jira project (2/3)', prompt: 'Project key, e.g. DATA' }))?.trim().toUpperCase();
  } else {
    project = (
      await vscode.window.showQuickPick(
        projects.map((p) => ({ label: p.key, description: p.name })),
        { title: 'Add a Jira project (2/3)', placeHolder: `Jira project that holds your tickets`, matchOnDescription: true },
      )
    )?.label;
  }
  if (!project) {
    return false;
  }
  const target = await pickScope(project, '3/3');
  if (target === undefined) {
    return false;
  }
  const current = sourcesAt(target);
  if (!current.some((s) => isJiraSource(s) && normalizeSite(s.site) === site && s.project.toUpperCase() === project)) {
    await vscode.workspace.getConfiguration('gitland').update('tickets.sources', [...current, { type: 'jira', site, project }], target);
  }
  vscode.window.setStatusBarMessage(`Gitland: tickets now come from Jira ${project}`, 4000);
  return true;
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
  const target = await pickScope(project, '3/3');
  if (target === undefined) {
    return false;
  }
  const current = sourcesAt(target);
  if (!current.some((s) => !isJiraSource(s) && s.organization === org && s.project === project)) {
    await vscode.workspace.getConfiguration('gitland').update('tickets.sources', [...current, { organization: org, project }], target);
  }
  vscode.window.setStatusBarMessage(`Gitland: tickets now also come from ${project}`, 4000);
  return true;
}

async function removeSource(source: TicketSource, target: vscode.ConfigurationTarget): Promise<void> {
  const same = (s: TicketSource) =>
    isJiraSource(s) || isJiraSource(source)
      ? isJiraSource(s) && isJiraSource(source) && s.site === source.site && s.project === source.project
      : s.organization === source.organization && s.project === source.project;
  const next = sourcesAt(target).filter((s) => !same(s));
  await vscode.workspace.getConfiguration('gitland').update('tickets.sources', next.length ? next : undefined, target);
}
