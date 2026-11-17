import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, realpathSync } from 'node:fs';
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

mkdirSync(hooksDirectory, { recursive: true });
for (const name of ['pre-commit', 'commit-msg']) {
  const destination = join(hooksDirectory, name);
  copyFileSync(join(repositoryRoot, 'plugin', '.githooks', name), destination);
  chmodSync(destination, 0o755);
}
execFileSync('git', ['-C', repositoryRoot, 'config', '--local', 'core.hooksPath', hooksDirectory], {
  stdio: 'inherit',
});
console.log(`Git hooks enabled: ${hooksDirectory}`);
