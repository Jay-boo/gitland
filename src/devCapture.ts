import * as fs from 'fs';
import * as path from 'path';

/**
 * Dev only: when GITLAND_CAPTURE_DIR is set (test/runTest.js), records each webview's page and the
 * messages sent to it, so test/render/render.mjs can replay them in headless Chromium.
 */
export function capture(view: string, kind: 'html' | 'message', payload: unknown): void {
  const dir = process.env.GITLAND_CAPTURE_DIR;
  if (!dir) {
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (kind === 'html') {
      fs.writeFileSync(path.join(dir, `${view}.html`), String(payload));
      // A new page starts a new message log.
      fs.writeFileSync(path.join(dir, `${view}.jsonl`), '');
    } else {
      fs.appendFileSync(path.join(dir, `${view}.jsonl`), `${JSON.stringify(payload)}\n`);
    }
  } catch {
    // capture must never break the extension
  }
}
