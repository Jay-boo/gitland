// Launches a throwaway VS Code with Gitland loaded and runs test/suite.js inside it.
//   node test/runTest.js [workspace]            clean VS Code (other extensions disabled)
//   node test/runTest.js [workspace] --real     with your installed extensions (~/.vscode-server/extensions)
const path = require('path');
const { runTests } = require('@vscode/test-electron');

// Set when launched from a VS Code terminal; it would make the test VS Code start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const real = args.includes('--real');
const workspace = args.find((a) => !a.startsWith('--')) || '/home/jayboo/projects/voltalia/Infra-Toolbox-Dataplatform';
const root = path.resolve(__dirname, '..');

const launchArgs = real
  ? [workspace, '--extensions-dir', path.join(process.env.HOME, '.vscode-server/extensions'), '--user-data-dir', path.join(root, '.vscode-test/user-data-real')]
  : [workspace, '--disable-extensions', '--user-data-dir', path.join(root, '.vscode-test/user-data')];

runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(__dirname, 'suite.js'),
  launchArgs,
  extensionTestsEnv: { GITLAND_TEST_WORKSPACE: workspace, GITLAND_TEST_PYFILE: process.env.GITLAND_TEST_PYFILE, GITLAND_TEST_HOLD: process.env.GITLAND_TEST_HOLD },
}).catch((e) => {
  console.error('Tests failed', e);
  process.exit(1);
});
