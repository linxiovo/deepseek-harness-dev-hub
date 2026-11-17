import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ISSUES = join(ROOT, 'meta', '.scratch', 'super-agent-implementation', 'issues')
const GITHUB = 'https://github.com/linxiovo/deepseek-harness-dev-hub/issues/'

// Local filename numbers and GitHub issue numbers are distinct identifiers, not an offset rule.
const expectedGitHubNumbers: Record<string, number> = {
  '01-hub-tool-boundary.md': 2,
  '02-harness-handoff-spec.md': 3,
  '03-ticket-worktree.md': 4,
  '04-session-meter.md': 5,
  '05-actions-evidence.md': 6,
  '06-spec-to-plan.md': 7,
  '07-doc-impact.md': 8,
  '08-scoped-tdd.md': 9,
  '09-frontier-claims.md': 10,
  '10-dual-review.md': 11,
  '11-plan-meter.md': 12,
  '12-rotate-hub.md': 13,
  '13-scoped-attention.md': 14,
  '14-run-limits.md': 15,
  '15-retro-evidence.md': 16,
  '16-merge-baseline.md': 17,
  '17-close-unlock.md': 18,
  '18-integrated-artifact.md': 19,
  '19-authorized-release.md': 20,
  '20-autonomous-replan.md': 21,
  '21-rule-pinning.md': 22,
  '22-scoped-control.md': 23,
  '23-feishu-binding.md': 24,
  '24-focus-dag.md': 25,
  '25-doc-tree-preview.md': 26,
  '26-stage-two-events.md': 27,
  '27-confirmed-settings.md': 28,
  '28-idle-inspection.md': 29,
  '29-inspection-repair.md': 30,
  '30-multi-project-onboarding-runtime.md': 31,
  '31-model-routing-and-custom-skills.md': 32,
  '32-panel-api-contracts.md': 33,
  '33-frontend-hub-shell-onboarding.md': 34,
  '34-frontend-chat-workspace.md': 35,
  '35-frontend-settings-meter.md': 36,
}

const tickets = readdirSync(ISSUES).filter(name => /^\d{2}-[a-z0-9-]+\.md$/.test(name)).sort()
const anchorsByFile = new Map<string, Set<string>>()

function anchors(file: string): Set<string> {
  const cached = anchorsByFile.get(file)
  if (cached) return cached
  const text = readFileSync(file, 'utf8')
  const found = new Set([...text.matchAll(/<a\s+(?:id|name)=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]!))
  const repeats = new Map<string, number>()
  for (const [, heading] of text.matchAll(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?$/gm)) {
    const slug = heading!.replace(/<[^>]+>/g, '').toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').trim().replace(/\s+/g, '-')
    const count = repeats.get(slug) ?? 0
    found.add(count ? `${slug}-${count}` : slug)
    repeats.set(slug, count + 1)
  }
  anchorsByFile.set(file, found)
  return found
}

describe('local implementation tickets', () => {
  it('maps every local filename to its own title and declared GitHub issue URL', () => {
    expect(tickets).toEqual(Object.keys(expectedGitHubNumbers).sort())
    const declared = new Set<number>()
    for (const name of tickets) {
      const body = readFileSync(join(ISSUES, name), 'utf8')
      const githubNumber = expectedGitHubNumbers[name]!
      expect(body.match(/^# (\d{2}):/m)?.[1], name).toBe(name.slice(0, 2))
      expect(body.split(/\r?\n/).filter(line => line.startsWith('**GitHub 实施票：**')), name)
        .toEqual([`**GitHub 实施票：** [#${githubNumber}](${GITHUB}${githubNumber})`])
      declared.add(githubNumber)
    }
    expect(declared.size).toBe(tickets.length)
  })

  it('resolves every local relative link and its anchor, with matching local ticket labels', () => {
    const problems: string[] = []
    for (const name of tickets) {
      const source = join(ISSUES, name)
      const body = readFileSync(source, 'utf8')
      for (const [, label, target] of body.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
        if (/^[a-z][a-z\d+.-]*:/i.test(target!) || target!.startsWith('//')) continue
        const hash = target!.indexOf('#')
        const relativePath = hash < 0 ? target! : target!.slice(0, hash)
        const fragment = hash < 0 ? '' : decodeURIComponent(target!.slice(hash + 1))
        const destination = resolve(dirname(source), decodeURIComponent(relativePath))
        if (!existsSync(destination)) {
          problems.push(`${name} → ${target}: target does not exist`)
          continue
        }
        if (fragment && (!statSync(destination).isFile() || !anchors(destination).has(fragment))) {
          problems.push(`${name} → ${target}: anchor does not exist`)
        }
        const localNumber = dirname(destination) === ISSUES ? /^(\d{2})-[a-z0-9-]+\.md$/.exec(basename(destination))?.[1] : undefined
        if (localNumber && label!.match(/^(\d{2})(?=\D|$)/)?.[1] !== localNumber) {
          problems.push(`${name} → ${target}: label ${label} does not match local ticket ${localNumber}`)
        }
        const specNumber = /^S(\d{2})$/.exec(label!)?.[1]
        if (specNumber && fragment !== `s${specNumber}`) {
          problems.push(`${name} → ${target}: label ${label} does not match anchor ${fragment}`)
        }
      }
    }
    expect(problems).toEqual([])
  })
})
