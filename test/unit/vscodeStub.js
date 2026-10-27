// Just enough of the vscode module for unit tests of provider code (tests set globalThis.__sources).
module.exports = {
  window: { createInputBox() { throw new Error('prompted'); }, showInformationMessage() {} },
  env: { openExternal() {} },
  Uri: { parse: (s) => s, file: (s) => s },
  ThemeIcon: class {},
  workspace: { getConfiguration: () => ({ get: (k, d) => (k === 'tickets.sources' ? globalThis.__sources ?? d : d) }) },
};
