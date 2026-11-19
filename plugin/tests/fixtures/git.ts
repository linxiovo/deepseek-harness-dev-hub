import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { GIT_LOCATION } from '../../src/infra/environment.ts'

/**
 * The process environment with `extra`, and without the variables that tell git which repository to act on (`GIT_LOCATION`):
 * the tests run inside `git rebase --exec` inherit GIT_DIR, and a `git init` there would reinitialize the repository under test.
 */
export const gitEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> =>
  ({ ...process.env, ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])), ...extra })

/** Local repository and pinned starting point, with commands isolated from operator Git configuration. */
export interface GitRepository {
  repository: string
  base: { ref: string; sha: string }
  git(...args: string[]): string
  worktree(directory: string, branch: string, sha?: string): void
}

/** A real local repository whose initial commit can be pinned independently for each ticket worktree. */
export function gitRepository(root: string): GitRepository {
  const repository = join(root, 'repository')
  // Git for Windows rejects `os.devNull` (`\\.\nul`) as GIT_CONFIG_GLOBAL, so an empty file isolates the operator's global configuration instead.
  const globalConfig = join(root, 'gitconfig')
  writeFileSync(globalConfig, '')
  const env = gitEnv({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
  execFileSync('git', ['init', '-q', '-b', 'main', repository], { env })
  const git = (...args: string[]): string => execFileSync('git', ['-C', repository, ...args], { env, encoding: 'utf8' }).trim()
  git('config', 'user.name', 'Worktree Test')
  git('config', 'user.email', 'worktree-test@example.test')
  git('config', 'commit.gpgSign', 'false')
  git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
  writeFileSync(join(repository, 'shared.txt'), 'baseline\n')
  git('add', 'shared.txt')
  git('commit', '-q', '-m', 'initial base')
  const base = { ref: 'refs/heads/main', sha: git('rev-parse', 'HEAD') }
  const worktree = (directory: string, branch: string, sha = base.sha): void => {
    git('worktree', 'add', '-q', '-b', branch, directory, sha)
  }
  return { repository, base, git, worktree }
}
