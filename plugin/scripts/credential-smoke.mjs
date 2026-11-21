import { request } from 'node:http'

const pathPrefix = '/orchestrator/api/attention/credentials/'
const isId = value => value?.length === 32 && /^[a-f0-9]{32}$/.test(value)
const defaultUrl = 'http://127.0.0.1:3082'
const help = `Usage:
  pnpm credential:smoke --project ID --action PATH [--url URL]
  pnpm credential:smoke verify --project ID --action PATH --expect failed|passed [--url URL]

ID is the selected project ID. PATH is the current action's configuration path:
  ${pathPrefix}<action-id>
URL is an HTTP loopback origin with an explicit port (default ${defaultUrl}).
The default command only reads status. Only verify sends POST (empty JSON object).
A passing check requires an awaiting/failed action; stored verified receipts do not count.
Use only with a dedicated test account on the candidate host. Never supply credentials.
Exit 0: status read or expected check result; 1: check refused, incomplete or unexpected;
     2: invalid arguments. See docs/015-scoped-attention.md for the live procedure.`

class SmokeError extends Error {
  constructor(message, code = 1) { super(message); this.code = code }
}

function parse(args) {
  const verify = args[0] === 'verify'
  const flags = new Map()
  for (let i = verify ? 1 : 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]]
    if (!['--url', '--project', '--action', '--expect'].includes(flag) || flags.has(flag) || !value) {
      throw new SmokeError('Invalid arguments; see --help.', 2)
    }
    flags.set(flag, value)
  }
  const project = flags.get('--project')
  const action = flags.get('--action')
  const id = action?.slice(pathPrefix.length)
  if (!isId(project) || !isId(id) || action !== pathPrefix + id) {
    throw new SmokeError('Specify --project with the selected project ID and --action with the configuration path.', 2)
  }
  const expect = flags.get('--expect')
  if (verify ? expect !== 'failed' && expect !== 'passed' : expect !== undefined) {
    throw new SmokeError('Only verify accepts --expect and it requires failed or passed.', 2)
  }
  const url = flags.get('--url') ?? defaultUrl
  // Check the raw authority before URL normalization can accept alternate IP spellings,
  // userinfo, or path traversal. Port 80 is valid even though URL.port normalizes it away.
  const origin = /^http:\/\/((?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4}))\/?$/.exec(url)
  if (!origin || origin[0] !== url || Number(origin[2]) > 65535) {
    throw new SmokeError('Use an HTTP 127.0.0.1 or localhost URL with an explicit port (no credentials, path, query or fragment).', 2)
  }
  return { host: origin[1], port: Number(origin[2]), project, action, id, expect }
}

async function readAction({ host, port, project, action, id }, verify = false) {
  const method = verify ? 'POST' : 'GET'
  const headers = { Host: host, 'x-orchestrator-request': '1', 'x-orchestrator-project-id': project,
    ...(verify && { 'content-type': 'application/json', 'content-length': '2' }) }
  try {
    const { promise, resolve, reject } = Promise.withResolvers()
    // The management listener is IPv4 loopback. Preserve the accepted Host header but
    // never resolve localhost through DNS, use an ambient proxy, or follow a redirect.
    const req = request({ hostname: '127.0.0.1', port, path: verify ? `${action}/verify` : action,
      method, headers, agent: false, signal: AbortSignal.timeout(verify ? 45_000 : 5_000) }, resolve)
    req.on('error', reject)
    req.end(verify ? '{}' : undefined)
    const res = await promise
    if (res.statusCode >= 300 && res.statusCode < 400) {
      res.destroy()
      throw new SmokeError(`${method} redirect refused.`)
    }
    if (res.statusCode !== 200) {
      res.destroy()
      throw new SmokeError(`${method} refused (HTTP ${res.statusCode}).`)
    }
    if (res.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      res.destroy()
      throw new SmokeError(`${method} did not return a JSON action receipt.`)
    }
    let bytes = 0
    const chunks = []
    for await (const chunk of res) {
      bytes += chunk.length
      if (bytes > 128 * 1024) throw new SmokeError(`${method} action receipt exceeded the size limit.`)
      chunks.push(chunk)
    }
    if (!res.complete) throw new SmokeError(`${method} action receipt did not complete.`)
    let receipt
    try { receipt = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new SmokeError(`${method} returned an invalid JSON action receipt.`) }
    if (receipt?.projectId !== project || receipt.id !== id) {
      throw new SmokeError(`${method} action receipt does not match the selected project and action.`)
    }
    const { status, verification, verifierConfigured } = receipt
    if (!(status === 'awaiting' && (verification === 'not-checked' || verification === 'failed')
      || status === 'verified' && verification === 'passed')) {
      throw new SmokeError(`${method} returned an invalid action state.`)
    }
    return { status, verification, verifierConfigured: verifierConfigured === true }
  } catch (error) {
    // Do not propagate request errors or host text (even diagnostics) to the terminal.
    if (error instanceof SmokeError) throw error
    throw new SmokeError(`${method} request did not complete.`)
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return }
  const target = parse(args)
  const current = await readAction(target)
  if (target.expect === undefined) { console.log(`${current.status} / ${current.verification}`); return }
  if (current.status === 'verified') throw new SmokeError('Action is already verified; its stored receipt is not a new check.')
  if (!current.verifierConfigured) throw new SmokeError('The current action has no configured test-account verifier.')
  if (target.expect === 'passed' && current.verification !== 'failed') {
    throw new SmokeError('A passing check requires an awaiting / failed action; check the failing provider state first.')
  }
  let result
  try { result = await readAction(target, true) }
  catch (error) {
    throw new SmokeError(`${error.message} No successful check recorded; read status before attempting another verification.`)
  }
  if (!result.verifierConfigured || result.verification !== target.expect) {
    throw new SmokeError(`Expected ${target.expect}; observed ${result.status} / ${result.verification}. No successful check recorded.`)
  }
  console.log(`${result.status} / ${result.verification}`)
}

try { await main(process.argv.slice(2)) }
catch (error) {
  console.error(`credential smoke: ${error instanceof SmokeError ? error.message : 'Unexpected CLI failure.'}`)
  process.exitCode = error instanceof SmokeError ? error.code : 1
}
