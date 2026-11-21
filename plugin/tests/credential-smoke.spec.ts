import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/credential-smoke.mjs', import.meta.url))
const project = 'a'.repeat(32)
const actions = '/orchestrator/api/attention/credentials'
const id = 'b'.repeat(32)
const entry = `${actions}/${id}`
const verify = `${entry}/verify`
const privateOutput = 'synthetic-private-verifier-output'

function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>()
  execFile(process.execPath, [script, ...args], { timeout: 5_000 }, (error, stdout, stderr) => {
    if (!error) resolve({ code: 0, stdout, stderr })
    else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
    else reject(error)
  })
  return promise
}

it('gates verification on an explicit, scoped request and reports only the expected live transition', async () => {
  let state = { status: 'awaiting', verification: 'not-checked' }
  let actionId = id
  let reply: 'normal' | 'wrongAction' | 'interrupted' | 'redirect' | 'pass' = 'normal'
  const requests: Array<{ method: string | undefined; path: string | undefined; headers: IncomingHttpHeaders; body: string }> = []
  const host = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => {
      requests.push({ method: req.method, path: req.url, headers: req.headers, body })
      if (req.headers['x-orchestrator-project-id'] !== project) {
        res.writeHead(409).end(privateOutput)
        return
      }
      if (req.method === 'POST' && req.url === `${actions}/${actionId}/verify`) {
        if (reply === 'interrupted') { res.destroy(); return }
        if (reply === 'redirect') { res.writeHead(307, { location: `${entry}/trap` }).end(privateOutput); return }
        state = reply === 'pass' ? { status: 'verified', verification: 'passed' } : { status: 'awaiting', verification: 'failed' }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({
        id: reply === 'wrongAction' ? 'c'.repeat(32) : actionId,
        projectId: project, verifierConfigured: true, ...state, diagnostic: privateOutput,
      }))
    })
  })
  host.listen(0, '127.0.0.1')
  try {
    await once(host, 'listening')
    const { port } = host.address() as AddressInfo
    const url = `http://127.0.0.1:${port}`
    const scope = ['--url', url, '--project', project, '--action', entry]
    const attempt = async (paths: string[], ...args: string[]) => {
      const result = await run(...args)
      expect(result.stdout + result.stderr).not.toContain(privateOutput)
      expect(requests.splice(0).map(req => {
        expect(req.headers['x-orchestrator-request']).toBe('1')
        expect(req.headers.authorization).toBeUndefined()
        expect(req.headers.cookie).toBeUndefined()
        if (req.method === 'POST') expect(req.headers['content-type']).toBe('application/json')
        return `${req.method} ${req.path} ${req.body}`.trimEnd()
      })).toEqual(paths)
      return result
    }
    const get = `GET ${entry}`, post = `POST ${verify} {}`
    expect(await attempt([], '--help')).toMatchObject({ code: 0, stdout: expect.stringContaining('Only verify sends POST') })
    expect(await attempt([get], ...scope)).toEqual({ code: 0, stdout: 'awaiting / not-checked\n', stderr: '' })
    expect(await attempt([], 'verify', ...scope)).toMatchObject({ code: 2, stdout: '' })
    for (const badUrl of [`http://example.invalid:${port}`, `http://${privateOutput}@127.0.0.1:${port}`, `${url}/path`]) {
      expect(await attempt([], 'verify', '--expect', 'failed', '--url', badUrl, ...scope.slice(2)))
        .toMatchObject({ code: 2, stdout: '' })
    }
    expect(await attempt([], 'verify', '--expect', 'failed', ...scope.slice(0, -1), `${entry}/verify`))
      .toMatchObject({ code: 2, stdout: '' })
    expect(await attempt([get], 'verify', '--expect', 'failed', ...scope.slice(0, 3), 'd'.repeat(32), ...scope.slice(4)))
      .toMatchObject({ code: 1, stdout: '' })
    reply = 'wrongAction'
    expect(await attempt([get], 'verify', '--expect', 'failed', ...scope)).toMatchObject({ code: 1, stdout: '' })
    reply = 'normal'
    expect(await attempt([get], 'verify', '--expect', 'passed', ...scope)).toMatchObject({ code: 1, stdout: '' })
    expect(await attempt([get, post], 'verify', '--expect', 'failed', ...scope))
      .toEqual({ code: 0, stdout: 'awaiting / failed\n', stderr: '' })
    reply = 'interrupted'
    expect(await attempt([get, post], 'verify', '--expect', 'passed', ...scope)).toMatchObject({ code: 1, stdout: '' })
    reply = 'redirect'
    expect(await attempt([get, post], 'verify', '--expect', 'passed', ...scope)).toMatchObject({ code: 1, stdout: '' })
    reply = 'pass'
    expect(await attempt([get, post], 'verify', '--expect', 'passed', ...scope))
      .toEqual({ code: 0, stdout: 'verified / passed\n', stderr: '' })
    expect(await attempt([get], 'verify', '--expect', 'passed', ...scope)).toMatchObject({ code: 1, stdout: '' })
    expect(await attempt([get], ...scope)).toEqual({ code: 0, stdout: 'verified / passed\n', stderr: '' })
    // A different blocked Ticket unexpectedly passes while failure is expected.
    actionId = 'e'.repeat(32)
    state = { status: 'awaiting', verification: 'not-checked' }
    const otherEntry = `${actions}/${actionId}`
    expect(await attempt([`GET ${otherEntry}`, `POST ${otherEntry}/verify {}`],
      'verify', '--expect', 'failed', ...scope.slice(0, -1), otherEntry)).toMatchObject({ code: 1, stdout: '' })
  } finally {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    host.close(error => { if (error) reject(error); else resolve() })
    await promise
  }
}, 20_000)
