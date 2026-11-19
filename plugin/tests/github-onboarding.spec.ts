import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { environmentLines, environmentOf, ticketEnvironment } from '../src/app/execution-environment.ts'
import { Installation } from '../src/app/installation.ts'
import { Setup } from '../src/app/setup.ts'
import type { Deployment, VerifiedGithub } from '../src/deployment.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testMachine } from './fixtures/deployment.ts'
import { gitRepository } from './fixtures/git.ts'

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

it('keeps legacy onboarding ready when repository setup fails, but refuses adoption under a different account', async () => {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'legacy-onboarding-'))
  const checkout = gitRepository(directory)
  const stateDir = join(directory, 'state')
  const alternate = join(directory, `alternate${process.platform === 'win32' ? '.exe' : ''}`)
  writeFileSync(alternate, '', { mode: 0o755 })
  const machine = testMachine({ stateDir })
  const settings = SettingsSchema.parse({ sources: { github: { enabled: false, config: { cli: process.execPath, repository: 'acme/widgets' } } },
    executor: { repository: checkout.repository, baseRef: checkout.base.ref } })
  const context = new Context()
  let sourceId = account.id
  let alternateId = 18
  let push = false
  let paused = false
  const githubAnswer = (argv: string[]) => argv[2] === 'user'
    ? JSON.stringify({ id: argv[0] === alternate ? alternateId : sourceId, login: account.login })
    : JSON.stringify({ name: 'acme/widgets', push })
  const spawn = vi.fn(({ argv }: { argv: string[] }) => {
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const stdout = argv[0] === 'git' ? `file:${workerGitConfig(stateDir)}\0${credentialHelper(account.cli)}\0` : githubAnswer(argv)
    return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: reader(stdout), stderr: reader('') } }
  })
  context.reflect.provide('subprocess', { spawn })
  const restart = vi.fn()
  const signal = new AbortController().signal
  const installation = new Installation({ machine, signal, probe: async argv => githubAnswer(argv), restart,
    configured: () => setup.configured(), paused: () => paused, recoveryPending: () => false,
    recoverable: () => ({ assignments: 0, handoffs: 0, effects: 0 }), settings: () => settings,
    legacyHubId: () => 'legacy-hub', legacyHandoffsMatch: () => true })
  const setup: Setup = new Setup({ context, machine, lifetime: signal, restart }, {
    legacy: () => installation.legacyGithub, verifyLegacy: cli => installation.verifyLegacyGithub(cli),
  })
  const ready = { status: 'ready', identity: { id: account.id, login: account.login, noreply: account.noreply } }
  try {
    await installation.initialize()
    expect(await setup.run(settings)).toBe(false)
    expect(setup.problem?.code).toBe('repositoryReadOnly')
    installation.finishStartup()
    expect(installation.onboarding()).toEqual(ready)
    expect(installation.runtime()).toMatchObject({ projectId: null, status: 'paused', reason: 'projectSetupRequired' })
    expect(() => installation.assertNewWork()).toThrow(/project setup/i)
    expect(await installation.verifyGithub({ cli: alternate })).toMatchObject({ status: 'blocked', problem: { code: 'agentAccountChanged' } })
    expect(installation.onboarding()).toEqual(ready)
    const candidate = SettingsSchema.parse({ ...settings, sources: { github: { ...settings.sources.github, config: { ...settings.sources.github!.config, cli: alternate } } } })
    await expect(setup.checkAccounts('source:github', candidate)).rejects.toMatchObject({ code: 'agentAccountChanged' })
    alternateId = account.id
    expect(await installation.verifyGithub({ cli: alternate })).toEqual(ready)
    expect(restart).not.toHaveBeenCalled()

    push = true
    expect(await setup.run(settings)).toBe(true)
    expect(installation.runtime()).toMatchObject({ projectId: null, status: 'ready', reason: null })
    expect(() => installation.assertNewWork()).not.toThrow()
    paused = true
    expect(installation.runtime()).toMatchObject({ projectId: null, status: 'paused', reason: 'operatorPaused' })
    expect(() => installation.assertNewWork()).toThrow(/resume processing/i)

    push = false
    expect(await setup.run(settings)).toBe(false)
    push = true
    const input = { repository: 'acme/widgets', workspace: checkout.repository, baseRef: checkout.base.ref }
    sourceId = 18
    await expect(installation.createProject(input)).rejects.toMatchObject({ status: 409, code: 'legacyProjectMismatch' })
    expect(installation.projects().projects).toEqual([])
    expect(installation.onboarding()).toMatchObject({ status: 'blocked', problem: { code: 'agentAccountChanged' } })
    expect(() => installation.assertNewWork()).toThrow(/verify github/i)
  } finally {
    setup.restore()
    installation.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each((['uninstalled', 'disabled', 'enabled'] as const).flatMap(source =>
  (['managed', 'legacy'] as const).map(mode => ({ source, mode }))))('renders verified $mode GitHub context for Hub and Worker with the Source $source', ({ source, mode }) => {
  const deployment: Deployment = { ...testMachine(), repository: 'Canonical/Widgets', github: { ...account, cli: '/private/not-for-prompts' },
    ...(mode === 'managed' && { managed: true }) }
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
