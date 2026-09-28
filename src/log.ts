import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Gitland', { log: true });
  return channel;
}

export const log = {
  info: (msg: string) => channel?.info(msg),
  warn: (msg: string) => channel?.warn(msg),
  error: (msg: string, e?: unknown) =>
    channel?.error(e === undefined ? msg : `${msg}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`),
};
