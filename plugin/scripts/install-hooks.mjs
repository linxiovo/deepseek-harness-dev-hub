import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

const gitOutput = (...args) =>
  execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).replace(/\r?\n$/, '');
const commonDirectory = realpathSync(resolve(repositoryRoot, gitOutput('rev-parse', '--git-common-dir')));
const hooksDirectory = join(commonDirectory, 'dsh-superagent-hooks');

const configuredPaths = [];
for (const scope of [[], ['--local']]) {
  try {
    configuredPaths.push(gitOutput('config', ...scope, '--get', 'core.hooksPath'));
  } catch (error) {
    if (error.status !== 1) throw error;
  }
}
const comparable = (value) => process.platform === 'win32'
  ? normalize(value).toLowerCase()
  : normalize(value);
if (configuredPaths.some((value) => comparable(value) !== comparable(hooksDirectory))) {
  throw new Error(`Refusing to replace an existing core.hooksPath: ${configuredPaths.join(', ')}`);
}

const dispatcher = [
  '#!/bin/sh',
  'set -eu',
  'repo_root=$(git rev-parse --show-toplevel)',
  'cd "$repo_root"',
  'exec sh "plugin/.githooks/${0##*/}" "$@"',
  '',
].join('\n');

mkdirSync(hooksDirectory, { recursive: true });
const stagingDirectory = mkdtempSync(join(hooksDirectory, '.install-'));
try {
  for (const name of ['pre-commit', 'commit-msg']) {
    const staged = join(stagingDirectory, name);
    writeFileSync(staged, dispatcher);
    chmodSync(staged, 0o755);
    renameSync(staged, join(hooksDirectory, name));
  }
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
}
execFileSync('git', ['-C', repositoryRoot, 'config', '--local', 'core.hooksPath', hooksDirectory], {
  stdio: 'inherit',
});
console.log(`Git hooks enabled: ${hooksDirectory}`);
