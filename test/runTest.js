// Launches a throwaway VS Code with Gitland loaded and runs test/suite.js inside it.
const path = require('path');
const { runTests } = require('@vscode/test-electron');

// Set when launched from a VS Code terminal; it would make the test VS Code start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const workspace = process.argv[2] || '/home/jayboo/projects/voltalia/Infra-Toolbox-Dataplatform';

runTests({
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.resolve(__dirname, 'suite.js'),
  launchArgs: [workspace, '--disable-extensions', '--user-data-dir', path.resolve(__dirname, '../.vscode-test/user-data')],
  extensionTestsEnv: { GITLAND_TEST_WORKSPACE: workspace, GITLAND_TEST_PYFILE: process.env.GITLAND_TEST_PYFILE },
}).catch((e) => {
  console.error('Tests failed', e);
  process.exit(1);
});
