import * as vscode from 'vscode';

/**
 * Page of a Gitland webview: graph.css tokens + fonts + codicons, then the view's own
 * stylesheet(s) and script (all from media/).
 */
export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  opts: { title: string; body: string; script: string | string[]; styles?: string[]; bodyClass?: string; restore?: RestoreInfo },
): string {
  const media = vscode.Uri.joinPath(extensionUri, 'media');
  const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
  const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p));
  const styles = ['graph.css', ...(opts.styles ?? [])].map((s) => `<link rel="stylesheet" href="${uri(s)}">`).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('vendor', 'codicon.css')}">
${styles}
<style>
@font-face { font-family: 'Gitland Geist'; font-weight: 100 900; font-display: block; src: url('${uri('vendor', 'geist.woff2')}') format('woff2'); }
@font-face { font-family: 'Gitland Geist Mono'; font-weight: 100 900; font-display: block; src: url('${uri('vendor', 'geist-mono.woff2')}') format('woff2'); }
</style>
<title>${opts.title}</title>
</head>
<body class="${opts.bodyClass ?? ''}">
${opts.body}
${opts.restore ? restoreScript(opts.restore, nonce) : ''}
${(Array.isArray(opts.script) ? opts.script : [opts.script]).map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n')}
</body>
</html>`;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
}

/** Editor-tab icon of a page: media/icons/<name>-light.svg / -dark.svg (tabs show images, not codicons). */
export function pageIcon(extensionUri: vscode.Uri, name: string): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${name}-light.svg`),
    dark: vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${name}-dark.svg`),
  };
}

/** How to reopen a page after a window reload: its kind and the arguments of its show(). */
export interface RestoreInfo {
  kind: string;
  [arg: string]: unknown;
}

/**
 * Saves `restore` in the page's state (where VS Code keeps it across reloads), whatever the page
 * itself saves: acquireVsCodeApi is wrapped so every setState keeps it. The serializers registered
 * in extension.ts read it back to reopen the page.
 */
export function restoreScript(restore: RestoreInfo, nonce: string): string {
  const json = JSON.stringify(restore).replace(/</g, '\\u003c');
  return `<script nonce="${nonce}">(function () {
  var restore = ${json};
  var acquire = window.acquireVsCodeApi;
  var api;
  window.acquireVsCodeApi = function () {
    if (!api) {
      api = acquire();
      var set = api.setState.bind(api);
      api.setState = function (s) { return set(Object.assign({}, s || {}, { __restore: restore })); };
      set(Object.assign({}, api.getState() || {}, { __restore: restore }));
    }
    return api;
  };
  window.acquireVsCodeApi();
  // The extension can change it (e.g. the compare page switching refs): { type: '__restore', restore }.
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === '__restore') {
      restore = e.data.restore;
      api.setState(api.getState());
    }
  });
})();</script>`;
}

let adopted: vscode.WebviewPanel | undefined;

/** The next createPanel of the same type reuses this tab (restored by VS Code) instead of opening one. */
export function adoptRestoredPanel(panel: vscode.WebviewPanel | undefined): void {
  adopted = panel;
}

/** createWebviewPanel, or the restored tab being brought back (same place among the tabs). */
export function createPanel(
  viewType: string,
  title: string,
  column: vscode.ViewColumn,
  options: vscode.WebviewPanelOptions & vscode.WebviewOptions,
): vscode.WebviewPanel {
  const panel = adopted?.viewType === viewType ? adopted : undefined;
  adopted = undefined;
  if (panel) {
    panel.title = title;
    panel.webview.options = options;
    return panel;
  }
  return vscode.window.createWebviewPanel(viewType, title, column, options);
}
