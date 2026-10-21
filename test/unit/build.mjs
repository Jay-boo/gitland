// Bundles the pure (vscode-free) TypeScript modules for the unit tests: src/**/<name>.pure.ts → out/unit/<name>.js
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const entries = walk(path.join(root, 'src')).filter((f) => f.endsWith('.pure.ts'));
for (const f of entries) {
  await esbuild.build({ entryPoints: [f], bundle: true, format: 'cjs', platform: 'node', target: 'node18', outfile: path.join(root, 'out/unit', `${path.basename(f, '.pure.ts')}.js`), logLevel: 'error' });
}
