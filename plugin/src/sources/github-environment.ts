import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { promptFile } from '../infra/prompt-file.ts'

const Variable = z.object({ key: z.string().min(1), description: z.object({ zh: z.string().min(1), en: z.string().min(1) }) })

export const githubEnvironment = {
  variables: z.array(Variable).parse(JSON.parse(promptFile('github-environment'))),
  values: ({ deployment, trigger }: { deployment: Deployment; trigger?: Trigger }): Record<string, string> => {
    const number = trigger?.threads[0]?.source === 'github' ? Number(trigger.meta.number) || 0 : 0
    return { DSH_SUPERAGENT_GITHUB_REPOSITORY: deployment.repository, DSH_SUPERAGENT_GITHUB_ACCOUNT: deployment.github.login,
      DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: deployment.github.noreply, DSH_SUPERAGENT_GITHUB_NUMBER: number ? String(number) : '',
      DSH_SUPERAGENT_GITHUB_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
  },
}
