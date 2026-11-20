import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'

const skills = ['dsh-worker-implement', 'dsh-worker-test-scope', 'dsh-worker-tdd']
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const tests = {
  focused: {
    scope: 'focused', files: ['seats'], cases: ['clamp seats at zero', 'independent health check'],
    source: { 'seats.mjs': 'export const seats = count => count' },
    body: ["import { seats } from '../seats.mjs'\nassert.equal(seats(-1), 0, 'worker-smoke regression')"],
  },
  consumers: {
    scope: 'consumers', files: ['quote', 'checkout', 'invoice'],
    cases: ['quote exposes cents', 'checkout displays the quote', 'invoice bills the quote'],
    source: {
      'quote.mjs': 'export const quote = amount => ({ total: amount })',
      'checkout.mjs': "import { quote } from './quote.mjs'\nexport const display = amount => (quote(amount).total / 100).toFixed(2)",
      'invoice.mjs': "import { quote } from './quote.mjs'\nexport const bill = amount => quote(amount).total + 25",
    },
    body: [
      "import { quote } from '../quote.mjs'\nassert.deepEqual(quote(275), { cents: 275 }, 'worker-smoke regression')",
      "import { display } from '../checkout.mjs'\nassert.equal(display(275), '2.75')",
      "import { bill } from '../invoice.mjs'\nassert.equal(bill(275), 300)",
    ],
  },
  full: {
    scope: 'full', files: [], cases: ['all discovered adapters normalize keys', 'independent health check'],
    source: {
      'normalize.mjs': 'export const normalize = key => key.toLowerCase()',
      'adapters/catalog.mjs': "export { normalize as lookup } from '../normalize.mjs'",
      'adapters/cache.mjs': "export { normalize as lookup } from '../normalize.mjs'",
      'registry.mjs': `import { readdirSync } from 'node:fs'
export async function lookupAll(key, directory = new URL('./adapters/', import.meta.url)) {
  const files = readdirSync(directory).filter(file => file.endsWith('.mjs')).sort()
  return Promise.all(files.map(async file => (await import(new URL(file, directory))).lookup(key)))
}`,
    },
    body: ["import { lookupAll } from '../registry.mjs'\nassert.deepEqual(await lookupAll(' Example '), ['example', 'example'], 'worker-smoke regression')"],
  },
  fallback: {
    scope: 'focused', files: [], cases: ['base charge is nonnegative', 'independent health check'],
    source: { 'charge.mjs': 'export const charge = cents => cents' },
    body: ["import { charge } from '../charge.mjs'\nassert.equal(charge(-25), 0, 'worker-smoke regression')"],
  },
}

function requireFact(ok, message) {
  if (!ok) throw new Error(message)
}

function runner(names = []) {
  return ['node --test --test-reporter=tap', ...names.map(name => `test/${name}.test.mjs`)].join(' ')
}

function shellCommand(shell, names) {
  return shell === 'bash'
    ? `code=0; ${runner(names)} || code=$?; printf '\\nworker-smoke exit %s\\n' "$code"; exit "$code"`
    : `${runner(names)}; $code = $LASTEXITCODE; Write-Output "worker-smoke exit $code"; exit $code`
}

// The fixture records the checkout even during an ordinary dirty green feedback run.
const stamp = `import { execFileSync } from 'node:child_process'
export function revision() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
  const head = git('rev-parse', 'HEAD')
  const dirty = git('status', '--porcelain=v1', '--untracked-files=all')
  console.log('worker-smoke head ' + head + ' ' + (dirty ? 'dirty' : 'clean'))
}
`

function seed(name, spec, requested) {
  const absolute = resolve(requested)
  // Resolve symlinks/junctions before the ancestry check; mkdir is exclusive.
  const parent = realpathSync(dirname(absolute))
  const directory = join(parent, basename(absolute))
  for (let path = parent; ; path = dirname(path)) {
    requireFact(!existsSync(join(path, '.git')) && !(existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects'))),
      'Seed destination must be outside any Git checkout or Git directory')
    if (dirname(path) === path) break
  }
  // Git configuration overrides, templates, hooks and index paths inherited from
  // the caller must not redirect writes or run anything in another checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Worker Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
    GIT_COMMITTER_NAME: 'Worker Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  })
  mkdirSync(directory, { mode: 0o700 })
  function git(...args) {
    const run = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: directory, env, encoding: 'utf8' })
    requireFact(!run.error && run.status === 0, `Local git ${args[0]} failed in the new seed directory`)
    return run.stdout.trim()
  }
  function put(path, contents) {
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents, { flag: 'wx' })
  }
  git('init', '--quiet', '--template=', '--object-format=sha1', '--initial-branch=main')
  put('.gitattributes', '* text eol=lf\n')
  put('lib/stamp.mjs', stamp)
  for (const [path, source] of Object.entries(spec.source)) put(path, `${source}\n`)
  const names = spec.files.length ? spec.files : ['regression']
  for (const [index, body] of spec.body.entries()) {
    const lines = body.split('\n')
    put(`test/${names[index]}.test.mjs`, `import assert from 'node:assert/strict'
import test from 'node:test'
${index === 0 ? "import { revision } from '../lib/stamp.mjs'\n" : ''}${lines[0]}
${index === 0 ? 'revision()\n' : ''}test('${spec.cases[index]}', async () => {
  ${lines[1]}
})
`)
  }
  if (spec.body.length < spec.cases.length) {
    put('health.mjs', "export const health = () => 'ready'\n")
    put('test/health.test.mjs', "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { health } from '../health.mjs'\ntest('independent health check', () => assert.equal(health(), 'ready'))\n")
  }
  if (name !== 'fallback') {
    put('package.json', `${JSON.stringify({ private: true, scripts: {
      test: runner(), ...spec.files.length ? { [`test:${spec.scope}`]: runner(spec.files) } : {},
    } }, null, 2)}\n`)
  }
  git('add', '--all')
  git('commit', '--quiet', '-m', '新增 Worker 验证种子')
  return { case: name, directory, base: git('rev-parse', 'HEAD'), scope: spec.scope, runner: runner(spec.files),
    shell: { bash: shellCommand('bash', spec.files), pwsh: shellCommand('pwsh', spec.files) } }
}

function json(text, label) {
  try { return JSON.parse(text) } catch { throw new Error(`Invalid JSON in ${label}`) }
}

// Harness Web Download session log: the root session.v4.jsonl, not a replay,
// Markdown transcript, PTC dispatch stream, or handwritten report.
function readLog(text, ticket) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  requireFact(lines.pop() === '', 'Expected complete newline-terminated Harness JSONL')
  const header = json(lines.shift(), 'Session header')
  requireFact(header?.type === 'session' && header.version === 4 && header.id === `worker-${ticket}`
    && header.isSeeded === false && !header.parentSession && !header.origin && header.delegationDepth === 0
    && header.agentPreset === 'dsh-superagent-worker'
    && typeof header.cwd === 'string' && (win32.isAbsolute(header.cwd) || posix.isAbsolute(header.cwd)),
  'Expected a version 4, unforked Worker Session for exactly this Ticket, with a worktree directory')
  const calls = new Map()
  const results = new Map()
  const retained = new Set(['skill', 'bash', 'pwsh', 'orchestrator_test_evidence'])
  for (const [seq, line] of lines.entries()) {
    const event = json(line, `event ${seq}`)
    requireFact(event?.seq === seq && typeof event.type === 'string', 'Missing or unordered Harness events')
    if (event.type === 'tool/call' && retained.has(event.data?.name)) calls.set(seq, event.data)
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') continue
    const [source] = event.sourceEventSeqs ?? []
    const call = calls.get(source)
    const message = event.data?.message
    // Forked histories are refused above. A synthetic repair must never supply a successful run.
    if (event.sourceEventSeqs?.length !== 1 || !call || message?.role !== 'tool'
      || call.callId !== message.toolCallId || event.data.turn !== call.turn || event.data.step !== call.step) continue
    requireFact(!results.has(source), 'Ambiguous Harness tool result linkage')
    results.set(source, { seq, message, error: event.data.error })
  }
  return { cwd: header.cwd, calls: [...calls].map(([seq, call]) => ({ seq, call, result: results.get(seq) })) }
}

const argsOf = entry => json(entry.call.arguments, `tool call ${entry.seq}`)
const succeeded = entry => entry.result && entry.result.message.isError === false && !entry.result.error
const ref = entry => ({ call_seq: entry.seq, result_seq: entry.result.seq })

function resultText(entry) {
  const blocks = entry.result?.message.content
  requireFact(Array.isArray(blocks) && blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string',
    `Expected one complete text block in tool result ${entry.result?.seq}`)
  return blocks[0].text
}

function sameDirectory(left, right) {
  if (typeof left !== 'string') return false
  if (/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(right)) {
    return win32.isAbsolute(left) && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
  }
  return posix.isAbsolute(left) && posix.normalize(left) === posix.normalize(right)
}

function shellRun(entry, spec, cwd) {
  const shell = entry.call.name
  const args = argsOf(entry)
  if (args?.command !== shellCommand(shell, spec.files) || !sameDirectory(args.workdir, cwd)
    || args.run_in_background === true || !succeeded(entry)) return undefined
  const lines = resultText(entry).replace(/\r\n/g, '\n').trimEnd().split('\n')
  const marker = prefix => lines.filter(line => line.startsWith(prefix))
  const head = marker('# worker-smoke head ')
  if (head.length === 0) return undefined
  requireFact(head.length === 1, 'Ambiguous shell HEAD observations')
  const identity = /^# worker-smoke head ([a-f0-9]+) (clean|dirty)$/.exec(head[0])
  requireFact(identity && commit.test(identity[1]), 'Malformed shell HEAD observation')
  if (identity[2] !== 'clean') return undefined
  const exits = marker('worker-smoke exit ')
  const shellExit = marker('[exit code: ')
  requireFact(exits.length === 1 && /^worker-smoke exit [01]$/.test(exits[0]) && shellExit.length <= 1
    && !lines.some(line => /^\[(?:timed out|killed by signal|stopped|shell |Command finished|output truncated)|^started background job/i.test(line)),
  'Missing or ambiguous foreground runner result')
  const exit = Number(exits[0].at(-1))
  requireFact(lines.at(exit === 1 ? -2 : -1) === exits[0]
    && (exit === 0 ? shellExit.length === 0 : lines.at(-1) === '[exit code: 1]'), 'Runner exit disagrees with Harness shell result')
  const rows = lines.flatMap(line => {
    const match = /^(ok|not ok) \d+ - (.+)$/.exec(line)
    return match ? [{ name: match[2], passed: match[1] === 'ok' }] : []
  })
  const expected = spec.files.length ? spec.cases.slice(0, spec.files.length) : spec.cases
  requireFact(lines.includes('TAP version 13') && lines.includes(`# tests ${expected.length}`)
    && lines.includes('# skipped 0') && lines.includes('# cancelled 0') && lines.includes('# todo 0')
    && rows.length === expected.length && expected.every((name, index) => rows.filter(row => row.name === name
      && row.passed === (exit === 0 || index > 0)).length === 1)
    && (exit === 0 || (/^  error: ['"]worker-smoke regression['"]$/m.test(lines.join('\n'))
      || /^  error: \|-\n    worker-smoke regression$/m.test(lines.join('\n')))
      && lines.some(line => /^\s+code: ['"]ERR_ASSERTION['"]$/.test(line))), 'Shell run did not record the expected fixture assertions')
  return { ...ref(entry), shell, command: args.command, directory: '.', revision: identity[1], checkout: 'clean',
    runner_exit: exit, runner_exit_source: 'shell-wrapper-output', harness_nonzero_exit_marker: exit === 1 ? 1 : null,
    assertions: rows, ...(exit === 1 ? { failure_code: 'ERR_ASSERTION' } : {}) }
}

function exportEvidence(text, name, spec, ticket, base, candidate) {
  requireFact(/^[a-f0-9]{32}$/.test(ticket) && commit.test(base) && commit.test(candidate) && base !== candidate,
    'Expected an exact Ticket ID, pinned base and distinct full candidate SHA')
  const { cwd, calls } = readLog(text, ticket)
  const evidence = calls.filter(entry => entry.call?.name === 'orchestrator_test_evidence').flatMap(entry => {
    const args = argsOf(entry)
    return succeeded(entry) ? [{ entry, args, value: json(resultText(entry), `evidence result ${entry.result.seq}`) }] : []
  })
  const matches = evidence.filter(({ args, value }) => args?.candidate === candidate || value?.candidate === candidate)
  requireFact(matches.length === 1, 'Missing or ambiguous candidate evidence for the exact SHA')
  const { entry, args, value } = matches[0]
  requireFact(args?.candidate === candidate && value?.candidate === candidate && value.base === base
    && value.source === 'worker' && value.result === 'reported_passed' && args.scope === spec.scope
    && value.scope === spec.scope && typeof args.reason === 'string' && args.reason.trim() && value.reason === args.reason,
  'Candidate evidence does not match the requested base, SHA, scope, or reported outcome')
  requireFact([args.red, args.checks, value.red, value.checks].every(runs => Array.isArray(runs) && runs.length === 1),
    'Expected one seed-base red and one candidate check for the complete fixture scope')
  const [red] = args.red
  const [check] = args.checks
  requireFact(red?.revision === base && red.directory === '.' && check?.directory === '.' && check.status === 'passed'
    && red.command === check.command && ['bash', 'pwsh'].some(shell => check.command === shellCommand(shell, spec.files))
    && [red, check].every(run => typeof run.observed === 'string' && run.observed.trim())
    && ['revision', 'directory', 'command', 'observed'].every(field => value.red[0]?.[field] === red[field])
    && ['directory', 'command', 'observed', 'status'].every(field => value.checks[0]?.[field] === check[field]),
  'Worker declarations do not match the canonical fixture command, required consumers, or recorded result')
  const after = evidence.reduce((last, other) => other.entry.result.seq < entry.seq ? Math.max(last, other.entry.result.seq) : last, -1)
  const before = calls.filter(item => item.seq > after && item.result?.seq < entry.seq)
  const runs = before.filter(item => ['bash', 'pwsh'].includes(item.call?.name) && argsOf(item)?.command === check.command)
    .map(item => shellRun(item, spec, cwd)).filter(Boolean)
  const reds = runs.filter(run => run.revision === base && run.runner_exit === 1)
  const greens = runs.filter(run => run.revision === candidate && run.runner_exit === 0)
  requireFact(reds.length === 1 && greens.length === 1 && reds[0].result_seq < greens[0].call_seq,
    'Missing, ambiguous or out-of-order red/green shell evidence for the exact base and candidate')
  const loaded = before.filter(item => item.call?.name === 'skill' && succeeded(item) && item.result.seq < reds[0].call_seq)
    .map(item => ({ name: argsOf(item)?.name, ...ref(item) })).filter(item => skills.includes(item.name))
  requireFact(skills.every(skill => loaded.some(item => item.name === skill)), 'Missing successful Worker skill invocations before red')
  return { format: 'worker-smoke/v1', ticket, session: `worker-${ticket}`, case: name, base, candidate,
    assessment: 'recorded_fixture_evidence_not_attestation', skills: loaded, shell_runs: { red: reds[0], green: greens[0] },
    worker_reported: { ...ref(entry), source: 'worker', scope: spec.scope, result: value.result, check_status: check.status,
      tool: 'orchestrator_test_evidence', red_revision: red.revision, directory: '.', command: check.command } }
}

async function selfTest() {
  const { test } = await import('node:test')
  const ticket = 'a'.repeat(32), base = 'b'.repeat(40), candidate = 'c'.repeat(40)
  const spec = tests.consumers, cwd = '/disposable/worktree'
  function snapshot({ selected = ticket, target = candidate, ran = candidate, files = spec.files, skipSkill = false } = {}) {
    const command = shellCommand('bash', files)
    const events = []
    const record = (type, data, extra) => events.push({ type, data, seq: events.length, time: events.length, ...extra })
    function tool(name, args, text) {
      const seq = events.length
      const callId = `call-${seq}`
      record('tool/call', { turn: 1, step: seq, callId, name, arguments: JSON.stringify(args) })
      record('tool/result', { turn: 1, step: seq, message: { role: 'tool', toolCallId: callId, isError: false,
        content: [{ type: 'text', text }] } }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
    }
    record('user/message', { unrelated: 'private fixture credential' })
    for (const name of skipSkill ? skills.slice(1) : skills) tool('skill', { name }, 'private skill contents')
    function run(sha, exit) {
      tool('bash', { command, workdir: cwd }, ['TAP version 13', `# worker-smoke head ${sha} clean`,
        ...spec.cases.map((name, i) => `${i === 0 && exit ? 'not ok' : 'ok'} ${i + 1} - ${name}`),
        ...(exit ? ['  error: |-', '    worker-smoke regression', '', '    -1 !== 0', "  code: 'ERR_ASSERTION'"] : []),
        '# tests 3', '# skipped 0', '# cancelled 0', '# todo 0', `worker-smoke exit ${exit}`,
        ...(exit ? ['[exit code: 1]'] : [])].join('\n'))
    }
    run(base, 1)
    run(ran, 0)
    const runArgs = { directory: '.', command, observed: 'private Worker observations' }
    const args = { scope: 'consumers', candidate: target, reason: 'private Worker rationale',
      checks: [{ ...runArgs, status: 'passed' }], red: [{ ...runArgs, revision: base }] }
    tool('orchestrator_test_evidence', args, JSON.stringify({ ...args, base, source: 'worker', result: 'reported_passed' }))
    return [JSON.stringify({ type: 'session', version: 4, id: `worker-${selected}`, cwd,
      agentPreset: 'dsh-superagent-worker', isSeeded: false, delegationDepth: 0 }),
      ...events.map(event => JSON.stringify(event)), ''].join('\n')
  }
  const extract = (text, sha = candidate) => exportEvidence(text, 'consumers', spec, ticket, base, sha)
  test('exports scoped run references, but not raw tool output or Worker prose', () => {
    const result = extract(snapshot())
    assert.equal(result.skills.length, 3)
    assert.equal(result.shell_runs.red.runner_exit, 1)
    assert.equal(result.shell_runs.green.runner_exit, 0)
    assert.equal(result.shell_runs.green.harness_nonzero_exit_marker, null)
    assert.equal(result.worker_reported.result, 'reported_passed')
    assert.doesNotMatch(JSON.stringify(result), /private/)
  })
  test('refuses another Ticket and a provider-only run', () => {
    assert.throws(() => extract(snapshot({ selected: 'f'.repeat(32) })), /exactly this Ticket/)
    assert.throws(() => extract(snapshot({ files: ['quote'] })), /required consumers/)
  })
  test('refuses both old bindings and old shell runs after HEAD changes', () => {
    const fresh = 'd'.repeat(40)
    assert.throws(() => extract(snapshot(), fresh), /exact SHA/)
    assert.throws(() => extract(snapshot({ target: fresh }), fresh), /red\/green shell evidence/)
  })
  test('refuses missing or ambiguous event evidence', () => {
    assert.throws(() => extract(snapshot({ skipSkill: true })), /Missing successful Worker skill/)
    assert.throws(() => extract(snapshot().trimEnd()), /complete newline-terminated/)
    const duplicate = snapshot().trimEnd().split('\n')
    const repeat = json(duplicate.at(-1), 'test copy')
    duplicate.push(JSON.stringify({ ...repeat, seq: repeat.seq + 1 }))
    assert.throws(() => extract(`${duplicate.join('\n')}\n`), /Ambiguous Harness tool result/)
  })
}

const usage = `Usage:
  node scripts/worker-smoke.mjs seed <focused|consumers|full|fallback> <new-directory>
  node scripts/worker-smoke.mjs export <case> <ticket-id> <base-sha> <candidate-sha> <session.v4.jsonl>
  node scripts/worker-smoke.mjs self-test`

async function main(argv) {
  const [operation, name, ...args] = argv
  if (operation === 'self-test' && argv.length === 1) return selfTest()
  if (argv.length === 0 || argv.length === 1 && operation === '--help') return console.log(usage)
  requireFact(Object.hasOwn(tests, name), usage)
  const spec = tests[name]
  let value
  if (operation === 'seed' && args.length === 1) value = seed(name, spec, args[0])
  else if (operation === 'export' && args.length === 4) {
    const [ticket, base, candidate, file] = args
    const input = statSync(file, { throwIfNoEntry: false })
    requireFact(input?.isFile() && input.size <= 64 * 1024 * 1024, 'Expected a regular Harness JSONL file no larger than 64 MiB')
    value = exportEvidence(readFileSync(file, 'utf8'), name, spec, ticket, base, candidate)
  } else throw new Error(usage)
  console.log(JSON.stringify(value, null, 2))
}

try { await main(process.argv.slice(2)) } catch (error) {
  // JSONL and tool output may contain secrets; never echo an unparsable line or error stack.
  console.error(`worker-smoke: ${error instanceof Error ? error.message : 'unexpected failure'}`)
  process.exitCode = 1
}
