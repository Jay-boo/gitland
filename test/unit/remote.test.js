// Remote URL parsing (src/providers/remote.ts), including SSH host aliases.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const esbuild = require('esbuild');

const entry = path.join(__dirname, '../../src/providers/remote.ts');
const { outputFiles } = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false });
const mod = new Module(entry);
mod._compile(outputFiles[0].text, entry);
const { parseRemoteUrl, resolveRemoteUrl } = mod.exports;

const aliases = { 'github-perso': 'github.com', 'ado-work': 'ssh.dev.azure.com' };
const fakeResolve = async (alias) => aliases[alias];

test('parseRemoteUrl: plain GitHub and Azure DevOps remotes', () => {
  assert.deepStrictEqual(parseRemoteUrl('git@github.com:Jay-boo/gitland.git'), { kind: 'github', owner: 'Jay-boo', repo: 'gitland' });
  assert.deepStrictEqual(parseRemoteUrl('https://dev.azure.com/org/proj/_git/repo'), { kind: 'azure', org: 'org', project: 'proj', repo: 'repo' });
  assert.strictEqual(parseRemoteUrl('git@github-perso:Jay-boo/gitland.git'), undefined);
});

test('resolveRemoteUrl: scp-style SSH alias to GitHub', async () => {
  assert.deepStrictEqual(await resolveRemoteUrl('git@github-perso:Jay-boo/gitland.git', fakeResolve), { kind: 'github', owner: 'Jay-boo', repo: 'gitland' });
});

test('resolveRemoteUrl: ssh:// alias with port', async () => {
  assert.deepStrictEqual(await resolveRemoteUrl('ssh://git@github-perso:22/Jay-boo/gitland', fakeResolve), { kind: 'github', owner: 'Jay-boo', repo: 'gitland' });
});

test('resolveRemoteUrl: SSH alias to Azure DevOps', async () => {
  assert.deepStrictEqual(await resolveRemoteUrl('git@ado-work:v3/org/proj/repo', fakeResolve), { kind: 'azure', org: 'org', project: 'proj', repo: 'repo' });
});

test('resolveRemoteUrl: unknown host and https stay unresolved', async () => {
  assert.strictEqual(await resolveRemoteUrl('git@unknown-host:a/b.git', fakeResolve), undefined);
  assert.strictEqual(await resolveRemoteUrl('https://gitlab.com/a/b.git', fakeResolve), undefined);
});

test('resolveRemoteUrl: real ~/.ssh/config alias via ssh -G', { skip: !process.env.GITLAND_SSH_ALIAS }, async () => {
  const info = await resolveRemoteUrl(`git@${process.env.GITLAND_SSH_ALIAS}:owner/repo.git`);
  assert.strictEqual(info && info.kind, 'github');
});
