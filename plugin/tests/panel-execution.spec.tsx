// @vitest-environment jsdom
// The Execution status, a Ticket, and the Execution settings.
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { PlanIntegrationView } from '../src/core/plan-integration.ts'
import { projectNavigation, ticketNavigationLink } from '../src/navigation.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { MEMBER, server, ticketSummary, threadSummary } from './fixtures/panel-server.ts'

usePanel()
it('lists Tickets under Execution by who they wait on, with the Executor state and its pause as an action', async () => {
  server.tickets.open = [ticketSummary(), ticketSummary({ id: 't2', title: '执行中的工单', threads: [{ key: 'github:7',
    source: 'github', title: '#7 x', facts: { number: { value: '#7' }, autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' },
      value: { zh: '已开启', en: 'on' } } } }] })]
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=20')).toBe(true)
  expect(text()).toContain(zh.executorRunning)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('GitHub#7自动合并已开启')
  await click(zh.idleLabel)
  expect(server.requests.some(request => request.path === 'tickets?state=idle&limit=20')).toBe(true)
  expect(text()).toContain('执行器结束了当前回合')
  await click(zh['ticket.ended'])
  expect(text()).toContain('旧工单')
  expect(text()).toContain(zh['outcome.stopped'])
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['执行中 2 / 3', '排队 0'])
  // The pause is its own action: an Execution settings draft started before it still saves.
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
  await type(field<HTMLInputElement>(zh.maxWorkers), '4')
  await click(tab(zh['tab.execution']))
  await click(zh.pauseProcessing)
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: true } })
  expect(text()).toContain(zh.processingPaused)
  expect(find(zh.resumeProcessing).textContent).toBe(zh.resumeProcessing)
  await click(tab(zh['tab.settings']))
  await click(zh.save)
  expect(server.settings).toMatchObject({ paused: true, executor: { maxWorkers: 4 } })
})

it('stops an open Ticket from its page after confirmation', async () => {
  await mount()
  await click(zh.stop)
  expect(server.requests.some(request => request.path.endsWith('/stop'))).toBe(false)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('停止“修复回归”')
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toBe(true)
})

it('shows a Ticket with its stage, its Mandate details with the Trigger and Decision behind it, its Threads, and the rest behind disclosures', async () => {
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  // Progress is in the Channels and the Session, so the page has no report section.
  expect(all('.dt-section-title').map(title => title.querySelector('.dt-section-name')?.textContent)).toEqual(['授权详情', '未送达的输入', '订阅的线程'])
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh.executingLabel)
  expect(document.querySelector('.dt-status-line .dt-stage .dt-spinner')).not.toBeNull()
  // A Thread this Ticket follows reads as subscribed on its page, though no other Ticket follows it.
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).toContain(zh.threadSubscribed)
  expect(all('.dt-list .dt-ticket .dt-stage').map(stage => stage.textContent)).not.toContain(zh.threadUnsubscribed)
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['授权 明确', '发起 飞书 · Alice', expect.stringMatching(/^更新 /)])
  for (const expected of ['修复登录页回归', '点名方式@ 智能体', '名单里的人明确请求，由主 Session 接单', '未送达：等待派工运行',
    'Alice：顺便改标题']) expect(text()).toContain(expected)
  expect(all('.dt-chip').map(chip => chip.textContent)).toContain('飞书团队群')
  await click(zh['term.channel'])
  expect(all('.dt-disclosure-body a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['飞书消息',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1'], ['GitHub #42', 'https://github.com/acme/widgets/issues/42']])
  await click(zh['term.environment'])
  expect(all('.dt-disclosure-body .dt-table tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR/w/t1',
    'DSH_SUPERAGENT_GITHUB_NUMBER—'])
  await click(document.querySelector<HTMLElement>('.dt-trigger-link')!)
  expect(tab(zh['tab.trigger']).getAttribute('aria-selected')).toBe('true')
})

it('opens a delivered Ticket from a project-scoped Harness link', async () => {
  const projectId = 'a'.repeat(32), ticketId = 'b'.repeat(32)
  server.projectId = projectId
  server.ticketDetails[ticketId] = { ...server.ticketDetails.t1!, id: ticketId, planId: 'plan-a' }
  const view: PlanIntegrationView = { planId: 'plan-a', status: 'delivered',
    version: { repository: 'acme/widgets', ref: 'refs/heads/main', sha: 'a'.repeat(40), context: 'b'.repeat(64), workflowId: '44',
      configuration: 'plugin-check-v1', environment: 'hosted-v1' },
    run: { id: 12, attempt: 1, url: 'https://github.com/acme/widgets/actions/runs/12', checks: [] },
    artifact: { id: 19, name: 'plugin-bundle', url: 'https://github.com/acme/widgets/actions/runs/12/artifacts/19',
      fileName: 'dsh-superagent-0.1.0.tgz', contentType: 'application/gzip', size: 128, sha256: 'c'.repeat(64) },
    verifiedAt: '2026-11-23T00:00:00Z' }
  server.planDeliveries['plan-a'] = view
  const deliveryUrl = ticketNavigationLink('http://127.0.0.1:3082', projectId, ticketId)
  window.history.replaceState({}, '', new URL(deliveryUrl).pathname + new URL(deliveryUrl).search)
  try {
    await mount()
    expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
    const target = projectNavigation(window.location.search)
    expect(target).toMatchObject({ projectId, ticketId, view: 'project' })
    expect(text()).toContain(zh['planDelivery.status.delivered'])
    expect(text()).toContain('dsh-superagent-0.1.0.tgz')
  } finally { window.history.replaceState({}, '', '/') }
})
it('shows the exact release hold and downloads its verified Plan package', async () => {
  server.projectId = 'a'.repeat(32)
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, planId: 'plan-a' }
  const view: PlanIntegrationView = { planId: 'plan-a', status: 'awaiting-release-verification',
    version: { repository: 'acme/widgets', ref: 'refs/heads/main', sha: 'a'.repeat(40), context: 'b'.repeat(64), workflowId: '44',
      configuration: 'plugin-check-v1', environment: 'hosted-v1' },
    run: { id: 12, attempt: 2, url: 'https://github.com/acme/widgets/actions/runs/12',
      checks: [{ name: 'integration-identity', status: 'completed', conclusion: 'success', url: 'https://github.com/acme/widgets/job/1' }] },
    artifact: { id: 19, name: 'plugin-bundle', url: 'https://github.com/acme/widgets/actions/runs/12/artifacts/19',
      fileName: 'dsh-superagent-0.1.0.tgz', contentType: 'application/gzip', size: 128, sha256: 'c'.repeat(64) }, verifiedAt: '2026-11-23T00:00:00Z' }
  server.planDeliveries['plan-a'] = view
  server.planArtifacts['plan-a'] = new Blob(['verified package'])
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(text()).toContain(zh['planDelivery.status.awaiting-release-verification'])
  expect(text()).toContain('dsh-superagent-0.1.0.tgz')
  const originalCreateUrl = URL.createObjectURL, originalRevokeUrl = URL.revokeObjectURL
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:verified-package' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
  let downloadedName = ''
  const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloadedName = this.download
  })
  try {
    await click(zh['planDelivery.download'])
    expect(server.requests.some(request => request.path === 'plans/plan-a/artifact' && request.method === 'GET')).toBe(true)
    expect(downloadedName).toBe('dsh-superagent-0.1.0.tgz')
  } finally {
    anchor.mockRestore()
    if (originalCreateUrl) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateUrl })
    else Reflect.deleteProperty(URL, 'createObjectURL')
    if (originalRevokeUrl) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeUrl })
    else Reflect.deleteProperty(URL, 'revokeObjectURL')
  }
})


it('displays verified worktree identity and actual writer, then names a rejected preparation without inventing Git facts', async () => {
  const t1 = server.ticketDetails.t1!
  const execution = { name: 'fix-regression', directory: '/w/t1', repository: '/srv/widgets', worktree: '/w/t1',
    branch: 'ticket/fix-regression', base: { ref: 'refs/heads/main', sha: '0123456789abcdef0123456789abcdef01234567' },
    session: 'actual-session-19',
    active_writer: { assignment: 'a1', session: 'actual-session-19' }, preparation: { state: 'verified' as const } }
  server.ticketDetails.t1 = { ...t1, execution }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line')?.textContent).toContain(zh['preparation.verified'])
  await click(zh.identifiers)
  const rows = () => all('.dt-disclosure-body .dt-kv > div').map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
  expect(rows()).toEqual(expect.arrayContaining([[zh.workerSession, 'actual-session-19'], [zh.executionRepository, '/srv/widgets'],
    [zh.executionWorktree, '/w/t1'], [zh.executionBranch, 'ticket/fix-regression'], [zh.executionBaseRef, 'refs/heads/main'],
    [zh.executionBaseSha, '0123456789abcdef0123456789abcdef01234567'], [zh.activeWriter, 'a1 · actual-session-19'],
    [zh.preparationState, zh['preparation.verified']]]))

  const reason = 'Wrong base; existing files were preserved.'
  server.ticketDetails.t1 = { ...t1, execution: { name: 'fix-regression', directory: '/w/t1', active_writer: null,
    preparation: { state: 'rejected', reason } } }
  await remount(en)
  expect(document.querySelector('.dt-status-line')?.textContent).toContain(en['preparation.rejected'])
  expect(document.querySelector('.dt-banner.dt-danger.dt-mono')?.textContent).toBe(`${en.preparationRejectedPrefix}${reason}`)
  await click(en.identifiers)
  expect(rows()).toEqual(expect.arrayContaining([[en.activeWriter, en.activeWriterNone], [en.preparationState, en['preparation.rejected']]]))
  expect(rows().map(([label]) => label)).not.toContain(en.executionRepository)
  expect(rows().map(([label]) => label)).not.toContain(en.executionBaseSha)
})

it('shows the observed mainline separately from the reviewed baseline and preserves queue integration across intent states', async () => {
  const base = 'a'.repeat(40), candidate = 'b'.repeat(40), actual = 'c'.repeat(40), integration = 'd'.repeat(40)
  const atTime = '2026-09-22T00:00:00Z'
  server.ticketDetails.t1!.mainline = { id: 'intent-1', ticket_id: 't1', status: 'verified', queued_at: atTime,
    target: { repository: '/srv/widgets', slug: 'acme/widgets', ref: 'refs/heads/main' },
    assignment: 'a1', generation: 1, base, candidate, actual, integration,
    verification: { status: 'passed', method: 'integration_on_target', at: atTime } }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(text()).toContain(zh['mainline.verified'])
  expect(all('.dt-kv > div').map(row => row.textContent)).toEqual(expect.arrayContaining([
    `${zh.executionBaseSha}${base}`, `${zh.mainlineCandidate}${candidate}`, `${zh.mainlineActual}${actual}`,
    `${zh.mainlineIntegration}${integration}`,
  ]))

  const withoutActual = { ...server.ticketDetails.t1!.mainline! }
  delete withoutActual.actual
  server.ticketDetails.t1!.mainline = { ...withoutActual, status: 'applying' }
  await remount()
  expect(all('.dt-kv > div').map(row => row.textContent)).toContain(`${zh.mainlineActual}${zh.empty}`)
  expect(all('.dt-kv > div').map(row => row.textContent)).toContain(`${zh.mainlineIntegration}${integration}`)

  server.ticketDetails.t1!.mainline = { ...withoutActual, status: 'waiting', actual: candidate }
  delete server.ticketDetails.t1!.mainline.integration
  await remount(en)
  expect(all('.dt-kv > div').map(row => row.textContent)).toContain(`${en.mainlineActual}${candidate}`)
  expect(all('.dt-kv > div').map(row => row.textContent)).toContain(`${en.mainlineIntegration}${en.empty}`)
  expect(all('.dt-kv > div').map(row => row.textContent)).not.toContain(`${en.mainlineIntegration}${candidate}`)
})

it('marks an old directory-only Ticket unverified without guessing repository, branch, or writer', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, execution: { name: 'old-ticket', directory: '/w/t1', preparation: { state: 'unverified' } } }
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(zh.identifiers)
  const rows = all('.dt-disclosure-body .dt-kv > div').map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
  expect(rows).toContainEqual([zh.preparationState, zh.unverified])
  for (const label of [zh.executionRepository, zh.executionWorktree, zh.executionBranch, zh.executionBaseRef,
    zh.executionBaseSha, zh.activeWriter]) expect(rows.map(([name]) => name)).not.toContain(label)
})

it('reports a missing Ticket instead of rendering an empty page', async () => {
  at({ page: 'execution', id: 'missing' })
  await mount()
  expect(document.querySelector('.dt-hint')?.textContent).toBe(zh.ticketNotFound)
})

it('links a question to its Channel, folds consecutive automated messages among Inputs, and shows field explanations in a hover tooltip',
  async () => {
  const ci = (id: string, at: string, failed: number) => ({ id, kind: 'trigger' as const, triggerId: `c${id}`, at, delivered: true,
    trigger: { id: `c${id}`, actor: { source: 'github', id: '' }, human: false,
      preview: `CI of PR #42 at abc1234: 10 checks, ${failed} failed, 0 running.`, thread: 'github:42' } })
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'answer', attention: { id: 'q1', question: '需要确认按钮颜色' }, inputs: [ci('i3',
    '2026-09-22T00:06:00Z', 1), ci('i2', '2026-09-22T00:05:00Z', 0)] }
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(all('.dt-banner a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  await click('已送达的输入 · 2')
  expect(all('.dt-disclosure-body .dt-row-title').map(title => title.textContent)).toEqual(['自动通知：CI of PR #42 at abc1234: 10 checks, 1 failed, 0 running.'])
  await click('同一发送者之前还有 1 条自动消息')
  expect(text()).toContain('CI of PR #42 at abc1234: 10 checks, 0 failed, 0 running.')
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(text()).not.toContain('到期后记为未完成')
  const tip = field(zh.evalTimeout).closest('.dt-field')!.querySelector<HTMLElement>('.dt-info')!
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('到期后记为未完成')
  expect(tip.closest('.dt-field')!.textContent).not.toContain('到期后记为未完成')
  await act(async () => { tip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('offers a Ticket awaiting review its review place and Session in the page head', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'review', threads: [threadSummary(),
    { ...threadSummary({ key: 'github:42', source: 'github', title: '#42 Fix login' }), url: 'https://github.com/acme/widgets/pull/42' }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.review'])
  expect(all('.dt-page-head a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['打开 GitHub 原文',
    'https://github.com/acme/widgets/pull/42']])
})

it('keeps what a person types in the Execution settings, converting it once on save', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const blocked = () => field<HTMLInputElement>(zh.blockedCommands), root = () => field<HTMLInputElement>(zh.executionDirectory),
    workers = () => field<HTMLInputElement>(zh.maxWorkers)
  // A separator typed before the next command, a space inside a path and a cleared number stay as typed.
  await type(blocked(), 'gh-personal ')
  expect(blocked().value).toBe('gh-personal ')
  await type(blocked(), 'gh-personal, gh-other')
  await type(root(), '/srv/my work ')
  expect(root().value).toBe('/srv/my work ')
  await type(workers(), '')
  expect(workers().value).toBe('')
  await type(workers(), '2')
  await click(zh.save)
  expect(server.requests.find(request => request.path === 'settings/executor')?.body).toMatchObject({ value: { blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work ', maxWorkers: 2 } })
  expect(server.settings.executor).toMatchObject({ blockedCommands: ['gh-personal', 'gh-other'], directory: '/srv/my work', maxWorkers: 2 })
})

it('says why an Input was not delivered on its Ticket\'s page, in either language', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, stage: 'person', action: 'delivery', deliveryError: 'feishu: message recalled' }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${zh.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(zh.inputRetryHint)
  expect(text()).not.toContain(zh.inputWaitingHint)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/9月\d+日/)
  await remount(en)
  expect(document.querySelector('.dt-status-line')?.textContent).toMatch(/Sep \d+/)
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(en['stage.delivery'])
  expect(document.querySelector('.dt-banner.dt-danger')?.textContent).toBe(`${en.deliveryFailedPrefix}feishu: message recalled`)
  expect(text()).toContain(en.inputRetryHint)
})

it('tells a Ticket or Thread that does not exist from a dsh-superagent that is not answering', async () => {
  at({ page: 'execution', id: 't9' })
  await mount()
  expect(text()).toContain(zh.ticketNotFound)
  // While dsh-superagent restarts, DSH's web server answers every route with an empty 404.
  at({ page: 'execution', id: 't1' })
  server.down = true
  await remount()
  expect(text()).not.toContain(zh.ticketNotFound)
  expect(text()).toContain(zh.hostNotRunning)
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await remount()
  expect(text()).not.toContain(zh.threadNotFound)
  expect(text()).toContain(zh.hostNotRunning)
})

it('gives a Ticket a bot\'s message started its basis, marks a Thread it follows for context, and an Input it handed back', async () => {
  const t1 = server.ticketDetails.t1!
  server.ticketDetails.t1 = { ...t1, mandate: { ...t1.mandate, strength: 'inferred', basis: { via: 'bot', sender: '评审机器人',
    observation: { mode: 'auto' } } },
  basis: { facts: [{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'mode', value: 'auto' }], legacy: false },
  threads: [threadSummary(), { ...threadSummary({ key: 'github:7', title: '#7 相关 Issue' }), context: true }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: true, trigger: { id: 'e2',
    actor: { source: 'feishu', id: MEMBER, name: { zh: 'Alice', en: 'Alice' } }, human: true, preview: '顺便加一个页面',
    thread: 'feishu:oc_1:om_root', handback: { reason: 'Asks for a new page', at: '2026-09-22T00:05:00Z' } } }] }
  at({ page: 'execution', id: 't1' })
  await mount()
  const facts = () => all('.dt-kv > div').map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
  expect(facts()).toEqual(expect.arrayContaining([[zh['basis.sender'], '评审机器人'], [zh['basis.bot'], zh.yes], [zh['basis.mode'], zh['mode.auto']]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, zh.contextOnly])
  await click(zh.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('已交回评估：Asks for a new page')
  await remount(en)
  expect(facts()).toEqual(expect.arrayContaining([[en['basis.bot'], en.yes]]))
  expect(all('.dt-list .dt-ticket').map(row => row.querySelector('.dt-tag')?.textContent)).toEqual([undefined, en.contextOnly])
  await click(en.deliveredInputs.replace('{count}', '1'))
  expect(text()).toContain('Handed back for an Eval: Asks for a new page')
})

it('words an ended Ticket by its outcome, on its row and its page, with a person\'s reason after it', async () => {
  const fields = { id: 't3', title: '已合并的工单', state: 'ended' as const, actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const } }
  server.tickets.ended = [ticketSummary(fields, { stage: 'ended' }), ...server.tickets.ended]
  server.ticketDetails.t3 = { ...server.ticketDetails.t1!, ...fields, stage: 'ended' }
  await mount()
  await click(zh['tab.execution'])
  await click(zh['ticket.ended'])
  expect(all('.dt-ticket-stage').map(stage => stage.textContent)).toEqual([zh['outcome.merged'], zh['outcome.stopped']])
  await click('已合并的工单')
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe(zh['outcome.merged'])
  expect(text()).toContain(zh['outcome.merged'])
  expect(text()).not.toContain('执行器结束')
  server.ticketDetails.t3 = { ...server.ticketDetails.t3, ended: { at: '2026-09-21T00:00:00Z', by: 'human', outcome: 'stopped',
    reason: '不需要了' } }
  await remount(en)
  expect(all('.dt-hint').map(hint => hint.textContent).find(line => line?.includes(en['outcome.stopped']))).toMatch(/Stopped by a person: 不需要了$/)
})

it('sends one stop for a double click on Confirm', async () => {
  at({ page: 'execution', id: 't1' })
  await mount()
  await click(zh.stop)
  const confirm = find(zh.confirm)
  await act(async () => { confirm.click(); confirm.click() })
  expect(server.requests.filter(request => request.path === 'tickets/t1/stop')).toHaveLength(1)
})
