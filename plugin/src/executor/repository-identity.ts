/** Verify the configured local clone's origin identifies the ticket's target GitHub repository. */
import type { Commands } from '../infra/commands.ts'
import { CliError } from '../infra/commands.ts'
import { WorktreeRejected } from './worktree.ts'

/** Only direct GitHub transport URLs are eligible; do not accept lookalike hosts, URL rewrites or extra path segments. */
const githubOrigin = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|git:\/\/github\.com\/)([a-z0-9-]+)\/([a-z0-9._-]+)$/i
const githubSlug = /^([a-z0-9-]+)\/([a-z0-9._-]+)$/i

/**
 * Read the clone's local origin configuration without fetching, modifying Git config or writing the clone.
 * Reject absent or duplicate origin URLs, unsupported transports/hosts, and a GitHub owner/repository other
 * than `expectedSlug`. Only the transport URL's optional `.git` suffix and GitHub's case-insensitive names
 * are normalized. All refusals are `WorktreeRejected` with code `wrong-repository` and a human-readable reason.
 */
export async function validateRepositoryIdentity(
  commands: Pick<Commands, 'git'>, clonePath: string, expectedSlug: string,
): Promise<void> {
  const target = githubSlug.exec(expectedSlug)
  if (!target) throw new WorktreeRejected('wrong-repository', `Target GitHub repository ${expectedSlug} must be an owner/name slug.`)

  let configured: string
  try { configured = await commands.git(['config', '--local', '--null', '--get-all', 'remote.origin.url'], clonePath) }
  catch (error) {
    if (error instanceof CliError && error.exitCode === 1) {
      throw new WorktreeRejected('wrong-repository', `Configured repository ${clonePath} has no origin URL for ${expectedSlug}.`)
    }
    throw new WorktreeRejected('wrong-repository', `Cannot inspect origin of configured repository ${clonePath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const origins = configured.split('\0')
  if (origins.at(-1) === '') origins.pop()
  if (origins.length !== 1 || !origins[0]) {
    throw new WorktreeRejected('wrong-repository', `Configured repository ${clonePath} must have exactly one remote.origin.url for ${expectedSlug}.`)
  }

  const match = githubOrigin.exec(origins[0])
  if (!match) {
    throw new WorktreeRejected('wrong-repository', `Configured repository ${clonePath} origin must be a direct github.com HTTPS, SSH, or Git URL for ${expectedSlug}.`)
  }
  const [, owner = '', remoteName = ''] = match
  const [, expectedOwner = '', expectedName = ''] = target
  const name = remoteName.replace(/\.git$/i, '')
  if (!name || owner.toLowerCase() !== expectedOwner.toLowerCase() || name.toLowerCase() !== expectedName.toLowerCase()) {
    throw new WorktreeRejected('wrong-repository', `Configured repository ${clonePath} origin does not match target GitHub repository ${expectedSlug}.`)
  }
}
