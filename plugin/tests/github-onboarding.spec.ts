import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { environmentLines, environmentOf, ticketEnvironment } from '../src/app/execution-environment.ts'
import { Setup } from '../src/app/setup.ts'
import type { Deployment, VerifiedGithub } from '../src/deployment.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testMachine } from './fixtures/deployment.ts'

const account: VerifiedGithub = { cli: process.execPath, id: 17, login: 'project-agent', noreply: '17+project-agent@users.noreply.github.com' }

it('waits for the verified binding and only checks its repository, never legacy Source identity', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'managed-setup-'))
  const machine = testMachine({ stateDir })
  const settings = SettingsSchema.parse({ sources: { github: { enabled: false, config: { cli: 'unrelated-cli', repository: 'other/repo' } } } })
  const context = new Context()
  let binding: { repository: string; github: VerifiedGithub } | undefined
  let push = true
  let switchAccount = false
  const spawn = vi.fn(({ argv }: { argv: string[] }) => {
    const git = argv[0] === 'git'
    if (git) expect(process.env.GH_HOST).toBe('github.com')
    else expect(argv.slice(1, 3)).toEqual(['api', 'repos/acme/widgets'])
    if (!git && switchAccount) binding = { repository: 'acme/widgets', github: { ...account, id: 18 } }
    const output = git ? `file:${workerGitConfig(stateDir)}\0${credentialHelper(account.cli)}\0`
      : JSON.stringify({ name: 'Canonical/Widgets', push })
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: reader(output), stderr: reader('') } }
  })
  context.reflect.provide('subprocess', { spawn })
  const setup = new Setup({ context, machine, lifetime: new AbortController().signal, restart: vi.fn() },
    { managed: () => binding })
  try {
    expect(await setup.run(settings)).toBe(false)
    expect(setup.problem?.code).toBe('agentCliUnset')
    expect(spawn).not.toHaveBeenCalled()
    binding = { repository: 'acme/widgets', github: account }
    expect(await setup.run(settings)).toBe(true)
    expect(setup.problem).toBeUndefined()
    expect(setup.deployment).toMatchObject({ repository: 'Canonical/Widgets', managed: true, github: account })
    expect(setup.commandEnvironment.GH_HOST).toBe('github.com')
    expect(spawn.mock.calls.map(([spec]) => spec.argv).flat()).toContain('repos/acme/widgets')
    expect(spawn.mock.calls.map(([spec]) => spec.argv).flat()).not.toContain('repos/other/repo')
    push = false
    expect(await setup.run(settings)).toBe(false)
    expect(setup.configured()).toBe(false)
    expect(setup.problem).toMatchObject({ code: 'repositoryReadOnly', values: { repository: 'Canonical/Widgets' } })
    push = true
    switchAccount = true
    expect(await setup.run(settings)).toBe(false)
    expect(setup.configured()).toBe(false)
    expect(setup.problem?.code).toBe('agentAccountChanged')
  } finally {
    setup.restore()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

it.each(['uninstalled', 'disabled', 'enabled'])('renders verified GitHub facts in managed Hub and Worker context with the Source %s', source => {
  const deployment: Deployment = { ...testMachine(), repository: 'Canonical/Widgets', github: { ...account, cli: '/private/not-for-prompts' }, managed: true }
  const settings = SettingsSchema.parse({ sources: { github: { enabled: source !== 'disabled', config: { repository: 'other/repo' } } } })
  const sources = new SourceRegistry(() => settings)
  const unregister = source === 'uninstalled' ? undefined : sources.register(githubKind)
  try {
    const input = { deployment, settings, sources }
    const hub = environmentOf(input)
    const worker = ticketEnvironment({ ...input, ticket: { id: 'ticket-31' } as Parameters<typeof ticketEnvironment>[0]['ticket'] })
    for (const variables of [hub, worker]) {
      const prompt = environmentLines(variables)
      expect(prompt.match(/DSH_SUPERAGENT_GITHUB_REPOSITORY = "Canonical\/Widgets"/g)).toHaveLength(1)
      expect(prompt).toContain('DSH_SUPERAGENT_GITHUB_ACCOUNT = "project-agent"')
      expect(prompt).toContain('DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL = "17+project-agent@users.noreply.github.com"')
      expect(prompt).not.toContain('other/repo')
      expect(prompt).not.toContain('/private/not-for-prompts')
    }
    expect(environmentLines(worker)).toContain('DSH_SUPERAGENT_TICKET = "ticket-31"')
  } finally { unregister?.() }
})
