// The release page's notes: one version's section of a CHANGELOG (src/changelogSection.pure.ts).
const test = require('node:test');
const assert = require('node:assert');
const { changelogSection } = require('../../out/unit/changelogSection.js');

const LOG = `# Changelog

## [0.4.0] - 2026-09-01
### Added
- Colored logger

## [0.3.10] - 2026-08-20
- Fix 10

## [0.3.1] - 2026-08-01
- Fix 1

## v0.2.0
- Old
`;

test('takes the section of the version, without its heading', () => {
  assert.strictEqual(changelogSection(LOG, '0.4.0'), '### Added\n- Colored logger');
  assert.strictEqual(changelogSection(LOG, 'v0.2.0'), '- Old');
});

test('does not mistake 0.3.1 for 0.3.10', () => {
  assert.strictEqual(changelogSection(LOG, '0.3.1'), '- Fix 1');
  assert.strictEqual(changelogSection(LOG, '0.3.10'), '- Fix 10');
});

test('undefined when the version is not in the changelog', () => {
  assert.strictEqual(changelogSection(LOG, '9.9.9'), undefined);
});
