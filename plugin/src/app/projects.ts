import { chmodSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { key } from '../core/ids.ts'
import type { VerifiedGithub } from '../deployment.ts'
import type { Settings } from '../policy.ts'

export interface ProjectInitial { baseRef: string; policy: Settings['policy'] }

export interface ProjectSuspension {
  reason: 'hostStopped' | 'projectSwitched' | 'interrupted'
  at: string
  recoverable: { assignments: number; handoffs: number; effects: number }
}

export interface Project {
  id: string
  repository: string
  workspace: string
  stateDir: string
  initial?: ProjectInitial
  suspension?: ProjectSuspension
}

interface Registration {
  repository: string
  workspace: string
  legacyStorage?: boolean
  initial?: ProjectInitial
}

interface ProjectRow {
  id: string
  repository: string
  workspace: string
  legacy_storage: number
  initial: string | null
  suspension: string | null
}

function repositoryName(input: string): string {
  const name = input.trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) || name.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('GitHub repository must use owner/name')
  }
  return name
}

function canonicalWorkspace(input: string): string {
  if (!isAbsolute(input) || (process.platform === 'win32' && parse(input).root.length === 1)) {
    throw new Error('Project workspace must be an absolute directory')
  }
  const path = realpathSync.native(input)
  if (!statSync(path).isDirectory()) throw new Error('Project workspace must be a directory')
  return path
}

const workspaceKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path

function contains(parent: string, child: string): boolean {
  const fromParent = relative(parent, child)
  return !isAbsolute(fromParent) && fromParent !== '..' && !fromParent.startsWith(`..${sep}`)
}

/** Stores project bindings, the selected mount, and account and suspension records under the installation lock. */
export class ProjectCatalog {
  private readonly root: string
  private readonly db: DatabaseSync

  constructor(stateDir: string) {
    this.root = resolve(stateDir)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const path = join(this.root, 'projects.sqlite')
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS project (
          id TEXT PRIMARY KEY,
          repository TEXT NOT NULL UNIQUE COLLATE NOCASE,
          workspace TEXT NOT NULL,
          legacy_storage INTEGER NOT NULL CHECK (legacy_storage IN (0, 1)),
          initial TEXT,
          suspension TEXT
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS project_legacy_storage ON project(legacy_storage) WHERE legacy_storage = 1;
        CREATE TABLE IF NOT EXISTS installation (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          selected TEXT REFERENCES project(id),
          github_account TEXT
        ) STRICT;
        INSERT OR IGNORE INTO installation (singleton) VALUES (1);
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void { this.db.close() }

  register(input: Registration): Project {
    const repository = repositoryName(input.repository)
    const workspace = canonicalWorkspace(input.workspace)
    const legacyStorage = Number(input.legacyStorage === true)
    if (legacyStorage && input.initial) throw new Error('A legacy project cannot have initial settings')
    const initial = input.initial === undefined ? null : JSON.stringify(input.initial)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const project = this.registerBinding({ id: key('handoff-project', repository, workspace), repository, workspace,
        legacy_storage: legacyStorage, initial, suspension: null })
      this.db.exec('COMMIT')
      return project
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private registerBinding(binding: ProjectRow): Project {
    const target = workspaceKey(binding.workspace)
    for (const existing of this.rows()) {
      const current = workspaceKey(existing.workspace)
      if (existing.repository.toLowerCase() === binding.repository.toLowerCase()) {
        if (current === target && existing.legacy_storage === binding.legacy_storage
          && isDeepStrictEqual(this.initial(existing), this.initial(binding))) return this.project(existing)
        throw new Error(`GitHub repository ${existing.repository} is already registered with a different binding or initialization`)
      }
      if (contains(current, target) || contains(target, current)) throw new Error(`Project workspace overlaps ${existing.workspace}`)
      if (existing.legacy_storage && binding.legacy_storage) throw new Error('Legacy storage is already assigned to another project')
    }
    this.db.prepare('INSERT INTO project (id, repository, workspace, legacy_storage, initial) VALUES (?, ?, ?, ?, ?)')
      .run(binding.id, binding.repository, binding.workspace, binding.legacy_storage, binding.initial)
    this.db.prepare('UPDATE installation SET selected = ? WHERE selected IS NULL').run(binding.id)
    return this.project(binding)
  }

  list(): Project[] { return this.rows().map(row => this.project(row)) }

  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM project WHERE id = ?').get(id) as unknown as ProjectRow | undefined
    return row && this.project(row)
  }

  selected(): Project | undefined {
    const row = this.db.prepare('SELECT project.* FROM installation JOIN project ON project.id = installation.selected')
      .get() as unknown as ProjectRow | undefined
    return row && this.project(row)
  }

  select(id: string): Project {
    const project = this.get(id)
    if (!project) throw new Error(`Unknown project ${id}`)
    this.db.prepare('UPDATE installation SET selected = ?').run(id)
    return project
  }

  account(): VerifiedGithub | undefined {
    const row = this.db.prepare('SELECT github_account FROM installation').get()
    return typeof row?.github_account === 'string' ? JSON.parse(row.github_account) : undefined
  }

  setAccount({ cli, id, login, noreply }: VerifiedGithub): void {
    this.db.prepare('UPDATE installation SET github_account = ?').run(JSON.stringify({ cli, id, login, noreply }))
  }

  publicAccount(): Omit<VerifiedGithub, 'cli'> | undefined {
    const account = this.account()
    return account && { id: account.id, login: account.login, noreply: account.noreply }
  }

  setSuspension(id: string, snapshot: ProjectSuspension | null): void {
    const value = snapshot === null ? null : JSON.stringify(snapshot)
    const result = this.db.prepare('UPDATE project SET suspension = ? WHERE id = ?').run(value, id)
    if (!result.changes) throw new Error(`Unknown project ${id}`)
  }

  private rows(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM project ORDER BY rowid').all() as unknown as ProjectRow[]
  }

  private initial(row: ProjectRow): ProjectInitial | undefined {
    return row.initial === null ? undefined : JSON.parse(row.initial)
  }

  private project(row: ProjectRow): Project {
    const { id, repository, workspace } = row
    const initial = this.initial(row)
    return { id, repository, workspace, stateDir: row.legacy_storage ? this.root : join(this.root, 'projects', id),
      ...(initial === undefined ? {} : { initial }), ...(row.suspension === null ? {} : { suspension: JSON.parse(row.suspension) }) }
  }
}
