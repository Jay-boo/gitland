import * as vscode from 'vscode';
import { errorMessage } from '../util';
import { createPanel, webviewHtml, webviewOptions, pageIcon } from './webviewHtml';
import { capture } from '../devCapture';
import { SchemaProperty, settingsGroups } from '../settings/schema.pure';

type Message = { type: 'ready' } | { type: 'set'; key: string; value: unknown } | { type: 'reset' | 'openJson'; key: string };

/** "Gitland: Settings": every gitland.* setting, grouped by feature, written to the user settings. */
export class SettingsPanel {
  private static current?: SettingsPanel;

  static show(context: vscode.ExtensionContext): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = createPanel('gitland.settings', 'Gitland Settings', vscode.ViewColumn.Active, webviewOptions(context.extensionUri));
    panel.iconPath = pageIcon(context.extensionUri, 'settings');
    SettingsPanel.current = new SettingsPanel(context, panel);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
  ) {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      view: 'settings',
      title: 'Gitland Settings',
      body: '<main id="page"></main>',
      script: ['md.js', 'settings.js'],
      styles: ['list.css', 'ticket.css', 'settings.css'],
      bodyClass: 'ticket-page',
      restore: { kind: 'settings' },
    });
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(`Gitland: ${errorMessage(e)}`)));
    // Changes made elsewhere (settings.json, the Settings editor) show up here.
    const sub = vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gitland') && this.send());
    panel.onDidDispose(() => {
      sub.dispose();
      SettingsPanel.current = undefined;
    });
  }

  private post(m: unknown): void {
    capture('settings', 'message', m);
    this.panel.webview.postMessage(m);
  }

  private send(): void {
    const properties = (this.context.extension.packageJSON.contributes?.configuration?.properties ?? {}) as Record<string, SchemaProperty>;
    const groups = settingsGroups(properties);
    const cfg = vscode.workspace.getConfiguration('gitland');
    const values: Record<string, unknown> = {};
    for (const s of groups.flatMap((g) => g.settings)) {
      values[s.key] = cfg.get(s.key);
    }
    this.post({ type: 'settings', groups, values });
  }

  private async onMessage(m: Message): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitland');
    switch (m.type) {
      case 'ready':
        return this.send();
      case 'set':
        await cfg.update(m.key, m.value, vscode.ConfigurationTarget.Global);
        return;
      case 'reset':
        await cfg.update(m.key, undefined, vscode.ConfigurationTarget.Global);
        return;
      case 'openJson':
        await vscode.commands.executeCommand('workbench.action.openSettings', `gitland.${m.key}`);
        return;
    }
  }
}
