import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// This adapter can only write to the fixture target under the temporary host directory.
assert.deepEqual(process.argv.slice(3), ['--request-stdin'])
const { request, artifactPath } = JSON.parse(readFileSync(0, 'utf8'))
const { id: requestId, target } = request
assert.deepEqual(target, { environment: 'sandbox', target: 'widgets-local', scope: 'label service' })
const deployed = join(process.cwd(), 'deployed-label-service.tgz')
const checksum = bytes => createHash('sha256').update(bytes).digest('hex')
const identity = bytes => ({ sha: bytes.toString().split('-')[0], sha256: checksum(bytes) })
const expected = { sha: request.version.sha, sha256: request.artifact.sha256 }
const command = process.argv[2]

if (command === 'credential-check') {
  console.log('ready')
} else if (command === 'publish') {
  const bytes = readFileSync(artifactPath)
  assert.deepEqual(identity(bytes), expected)
  writeFileSync(deployed, bytes, { flag: 'wx' })
  writeFileSync(`${deployed}.json`, JSON.stringify({ requestId, at: new Date().toISOString() }), { flag: 'wx' })
  // The environment write succeeded, but the host never received its publication response.
  process.exitCode = 1
} else if (command === 'observe') {
  const receipt = JSON.parse(readFileSync(`${deployed}.json`, 'utf8'))
  assert.equal(receipt.requestId, requestId)
  const actual = identity(readFileSync(deployed))
  assert.deepEqual(actual, expected)
  const id = `deployment-${requestId}`
  console.log(JSON.stringify({ requestId, target, status: 'published', deployment: { id, at: receipt.at, ...actual },
    verification: { status: 'passed', deploymentId: id, at: new Date().toISOString(), ...actual } }))
} else {
  throw new Error(`Unexpected fixture command ${command}`)
}
