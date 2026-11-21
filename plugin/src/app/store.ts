/** SQLite persistence for domain aggregates, key-value state, settings history, and the channel outbox. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { key, threadKey, type ChannelRef, type Decision, type OutboundMessage, type ReplyStatus, type Repositories, type Thread, type ThreadFact,
  type ThreadFacts, type Ticket, type Trigger, type TriggerDisposition } from '../core/index.ts'
import { KV, type Family, type Key } from '../kv.ts'
import { SettingsSchema, type Settings, type SettingsOrigin, type SettingsSave } from '../policy.ts'
import { OLDEST_SCHEMA, SCHEMA_VERSION, migrateTo11, tooOld } from './migration.ts'
import { Versions } from './versions.ts'
import { storeReads } from './store-read.ts'

/** A Trigger's position on its thread timeline, ordered by timestamp and then `id` as tie-breaker. */
export interface TimelinePlace { at: string; id: string }
/** Why a message was dropped: its conversation can never receive it (`channelGone`), or its Source no longer listens to it (`channelIgnored`). */
export type DropReason = 'channelGone' | 'channelIgnored'
/** Outbound message receipt tracked in the outbox from the moment it is queued (`pending`, `sent`, or `dropped`); delivery attempt counts live on its `reply` effect. */
export interface Receipt extends OutboundMessage { status: ReplyStatus; dropped?: { at: string; reason: DropReason } }
/** A dropped outbound message receipt, with the timestamp and reason it was dropped. */
export type Dropped = Receipt & { dropped: { at: string; reason: DropReason } }
/** Saved settings snapshot with the policy version and ticket notifications it produced (`internal` saves have no origin). */
export interface SettingsVersion {
  revision: number; savedAt: string; source: SettingsOrigin | 'internal'; block?: SettingsSave
  policyVersion: string; policyChanged: boolean; notified: string[]; settings: Settings
}
/**
 * Generated columns and partial indexes defining active working sets so passes scan only active rows.
 * Older databases missing a column get it added on open and populated by SQLite from stored JSON rows.
 */
const SETS: Record<string, Record<string, string>> = {
  ticket: {
    open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
    // Only the latest assignment can be pending or running because the Engine closes one before adding the next.
    active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`,
  },
  thread: {
    active: "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
    subscribed: "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
  },
  // Composite key (ticketId + thread) used to preserve per-conversation reply order.
  outbox: { dropped: "TEXT AS (value ->> '$.dropped.at')", pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)` },
}

/** Resolve missing worktree targets through their nearest existing parent, including any symlinks. */
function canonicalTarget(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Worktree ownership requires absolute paths')
  let parent = resolve(path)
  const missing: string[] = []
  for (;;) {
    try { return resolve(realpathSync.native(parent), ...missing.reverse()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error
      missing.push(basename(parent)); parent = dirname(parent)
    }
  }
}
const sameDirectory = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
export { SCHEMA_VERSION }
/**
 * SQLite backing store implementing domain `Repositories`, view read queries, versioned settings, outbox receipts, and key-value state.
 * The Runtime opens it after locking the state directory and automatically migrates supported older schemas on startup.
 * The Engine mutates domain aggregates inside `atomic` transactions while Sources, views, and the Outbox read state or update their own records.
 */
export class Store implements Repositories {
  readonly db: DatabaseSync
  /**
   * Opens or creates the SQLite database at `path`, migrating schema 10 to schema 11 in a single transaction.
   * @param report - Receives errors thrown by `afterCommit` callbacks without failing the committed transaction.
   * @throws When the database schema is older than `OLDEST_SCHEMA` (10), newer than `SCHEMA_VERSION` (11), or when migration fails; in every case the database file is left unchanged and the SQLite handle is closed so a later attempt in the same process can open it.
   */
  constructor(path: string, private readonly report: (error: unknown) => void = () => {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.read = storeReads(this.db)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const version = this.get(KV.store.schema)
      if (version !== undefined && version > SCHEMA_VERSION) throw new Error(`Unsupported orchestrator database version ${version}`)
      if (version !== undefined && version < OLDEST_SCHEMA) throw new Error(tooOld(version))
      const migrating = version !== undefined && version < SCHEMA_VERSION
      try {
        this.atomic(() => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
              PRIMARY KEY (thread, id));
            CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
              generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
              since TEXT NOT NULL, PRIMARY KEY (kind, key));
            CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
            CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
            CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
            CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
            CREATE UNIQUE INDEX IF NOT EXISTS ticket_worktree_owner
              ON ticket((value ->> '$.execution.ownership.identity.worktree') COLLATE NOCASE)
              WHERE value ->> '$.execution.ownership.identity.worktree' IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS ticket_worktree_session_writer
              ON ticket((value ->> '$.execution.active_writer.session'))
              WHERE value ->> '$.execution.active_writer.session' IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS ticket_worktree_branch_owner
              ON ticket((value ->> '$.execution.ownership.identity.commonDir') COLLATE NOCASE,
                (value ->> '$.execution.ownership.identity.branch'))
              WHERE value ->> '$.execution.ownership.identity.commonDir' IS NOT NULL;
          `)
          this.addColumns()
          if (migrating) migrateTo11(this)
          if (version !== SCHEMA_VERSION) this.set(KV.store.schema, SCHEMA_VERSION)
        })
      } catch (error) {
        if (!migrating) throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`The orchestrator database is unchanged at schema ${version}: its migration to schema ${SCHEMA_VERSION} failed: ${reason}`, { cause: error })
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  /** Reconciles generated working-set columns and indexes when opening databases created by earlier versions. */
  private addColumns(): void {
    const columns = (table: string) => new Set(this.db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table).map(row => String(row.name)))
    for (const [table, definitions] of Object.entries(SETS)) {
      // Drop generated columns whose definition changed or that were removed, along with their index, before adding current ones.
      const sql = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? '')
      const generated = this.db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)').all(table).map(row => String(row.name))
      for (const name of generated) {
        if (definitions[name] && sql.includes(`${name} ${definitions[name]}`)) continue
        this.db.exec(`DROP INDEX IF EXISTS ${table}_${name}; ALTER TABLE ${table} DROP COLUMN ${name}`)
      }
      const existing = columns(table)
      for (const [name, definition] of Object.entries(definitions)) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL`)
      }
    }
    if (!columns('effect').has('generation')) this.db.exec('ALTER TABLE effect ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
  }
  /** Closes the underlying SQLite database connection. */
  close(): void { this.db.close() }
  /** Parses JSON `value` columns returned by `sql`. */
  private values<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  }
  /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
  private indexThreads(trigger: Trigger): void {
    this.db.prepare('DELETE FROM trigger_thread WHERE id=?').run(trigger.id)
    const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)')
    for (const ref of trigger.threads) insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
  }
  private depth = 0
  /** Callbacks queued to run once the outermost transaction commits, indexed by savepoint level; rolling back a level discards its callbacks. */
  private readonly committed: (() => void)[][] = []
  /**
   * Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
   * Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
   */
  atomic<T>(operation: () => T): T {
    const level = this.depth++
    const name = `orchestrator_atomic_${level}`
    this.committed[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try { value = operation(); this.db.exec(`RELEASE ${name}`) }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
    const actions = this.committed.splice(level)[0]!
    if (level) this.committed[level - 1]!.push(...actions)
    else for (const action of actions) { try { action() } catch (error) { this.report(error) } }
    return value
  }
  /**
   * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
   * callbacks queued inside a transaction that rolls back are discarded and never run.
   * Use `afterCommit` for immediate in-memory follow-ups to a committed write (such as refreshing health or cancelling an in-memory turn) that cannot wait for the effect queue and need not survive a restart; use `Effects` for durable side effects that must survive a crash.
   */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }
  /** Reads a typed KV record by its key in `KV`. */
  get<V>(name: Key<V>): V | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(name)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as V
  }
  /** Writes a typed KV record under `name`. */
  set<V>(name: Key<V>, value: V): void {
    this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  }
  /** Deletes the KV record at `name`. */
  delete(name: string): void { this.db.prepare('DELETE FROM kv WHERE key=?').run(name) }
  /** Returns all KV keys belonging to `family` or starting with `prefix`. */
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  keys(family: string | { prefix: string }): string[] {
    const prefix = typeof family === 'string' ? family : family.prefix
    const pattern = `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return this.db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'").all(pattern).map(row => String(row.key))
  }

  /** Versioned settings snapshots; the current settings are the snapshot of the latest revision. */
  private readonly settingsVersions = new Versions<SettingsVersion>(this, KV.settings.revision, KV.settings.version)
  /** Current validated settings. */
  settings(): Settings { return SettingsSchema.parse(this.settingsVersions.current()?.settings ?? {}) }
  /** Revision of one settings block; each configuration page saves against its own block for optimistic concurrency. */
  blockRevision(block: SettingsSave): number { return this.get(KV.settings.block(block)) ?? 0 }
  /** Saves settings as the next revision (making it current) and increments `record.block`'s revision counter when present. */
  saveSettings(value: unknown, record: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'> = { source: 'internal', policyVersion: '', policyChanged: false, notified: [] }): Settings {
    const settings = SettingsSchema.parse(value)
    return this.atomic(() => {
      this.settingsVersions.save(revision => ({ ...record, revision, savedAt: new Date().toISOString(), settings }))
      if (record.block) this.set(KV.settings.block(record.block), this.blockRevision(record.block) + 1)
      return settings
    })
  }
  /** Saved settings revisions, newest first; revisions predating settings history are absent. */
  settingsHistory(limit = 20): SettingsVersion[] { return this.settingsVersions.list(limit) }

  readonly triggers = {
    get: (id: string): Trigger | undefined => { const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Trigger : undefined },
    save: (trigger: Trigger): void => this.atomic(() => {
      this.db.prepare('INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at').run(trigger.id, JSON.stringify(trigger), trigger.at)
      this.indexThreads(trigger)
    }),
    disposition: (id: string): TriggerDisposition | undefined => { const row = this.db.prepare('SELECT value FROM disposition WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as TriggerDisposition : undefined },
    saveDisposition: (id: string, value: TriggerDisposition): void => { this.db.prepare('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)) },
  }
  readonly threads = {
    get: (keyValue: string): Thread | undefined => { const row = this.db.prepare('SELECT value FROM thread WHERE key=?').get(keyValue); return row ? JSON.parse(String(row.value)) as Thread : undefined },
    save: (thread: Thread): void => { this.db.prepare('INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(thread.key, JSON.stringify(thread)) },
    list: (): Thread[] => this.db.prepare('SELECT value FROM thread ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Thread),
    active: (): Thread[] => this.values('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
    /** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
    describe: (keyValue: string, patch: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const facts: ThreadFacts = { ...(thread.meta.facts as ThreadFacts | undefined) }
      for (const [id, fact] of Object.entries(patch.facts ?? {})) { if (fact) facts[id] = fact; else delete facts[id] }
      const meta = { ...thread.meta, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.url === undefined ? {} : { url: patch.url }), facts }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    },
    /** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
    patchMeta: (keyValue: string, patch: Record<string, unknown>): void => this.atomic(() => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const meta = { ...thread.meta }
      for (const [name, value] of Object.entries(patch)) { if (value === undefined) delete meta[name]; else meta[name] = value }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    }),
  }
  readonly tickets = {
    get: (id: string): Ticket | undefined => { const row = this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Ticket : undefined },
    save: (ticket: Ticket): void => this.atomic(() => {
      const stored = this.tickets.get(ticket.id)
      const before = stored?.execution?.ownership
      const after = ticket.execution?.ownership
      if (before) {
        const a = before.identity, b = after?.identity
        if (!after || after.ticket !== before.ticket || after.generation < before.generation || before.verified && !after.verified
          || !b || a.repository !== b.repository || a.commonDir !== b.commonDir || a.worktree !== b.worktree
          || a.branch !== b.branch || a.base.ref !== b.base.ref) {
          throw new Error('Ticket worktree ownership and its pinned base cannot be removed, reassigned or overwritten by a stale generation')
        }
        if (a.base.sha !== b.base.sha) {
          const repair = ticket.inputs.at(-1), writer = stored.assignments.at(-1)?.writer
          if (!before.verified || stored.ended || ticket.ended || stored.execution?.active_writer || ticket.execution?.active_writer
            || writer?.state !== 'idle' || writer.generation !== before.generation || after.generation !== before.generation
            || repair?.kind !== 'mainline-repair' || repair.generation !== before.generation || repair.ref !== a.base.ref
            || repair.previousBase !== a.base.sha || repair.base !== b.base.sha || !ticket.undelivered.includes(repair.id)
            || ticket.inputs.length !== stored.inputs.length + 1 || stored.inputs.some(input => input.id === repair.id)) {
            throw new Error('Changing a verified base requires an atomic repair Input for the confirmed idle generation')
          }
        }
      }
      for (const previous of stored?.assignments ?? []) {
        const writer = previous.writer
        if (!writer) continue
        const next = ticket.assignments.find(item => item.id === previous.id)?.writer
        if (!next || next.generation < writer.generation || next.generation === writer.generation && writer.session && next.session !== writer.session
          || writer.state !== 'idle' && next.generation !== writer.generation
          || writer.state === 'idle' && next.generation === writer.generation && next.state !== 'idle'
          || writer.state === 'stopping' && next.state !== 'stopping' && next.state !== 'idle'
          || writer.state === 'active' && next.state === 'preparing') {
          throw new Error('A persisted writer cannot be removed, rebound or revived by a stale ticket save')
        }
        if (after && before && after.generation > before.generation && writer.state !== 'idle') {
          throw new Error('A new generation cannot replace a writer before it is confirmed idle')
        }
      }
      if (after && after.ticket !== ticket.id) throw new Error('A worktree reservation must belong to its ticket')
      if (!after && ticket.execution?.active_writer) throw new Error('An unverified execution cannot claim an active writer')
      if (after) {
        const held = ticket.assignments.filter(item => item.writer && item.writer.state !== 'idle')
        const holder = held[0]
        const active = ticket.execution?.active_writer
        const mismatched = holder?.writer?.session
          ? !active || active.assignment !== holder.id || active.session !== holder.writer.session
          : !!active
        if (!Number.isSafeInteger(after.generation) || after.generation < 1 || held.length > 1
          || holder && holder.writer!.generation !== after.generation || mismatched) {
          throw new Error('Execution metadata must identify exactly its fenced active writer')
        }
        if (after.verified) {
          const execution = ticket.execution!
          const identity = after.identity
          if (execution.repository !== identity.repository || execution.worktree !== identity.worktree
            || execution.branch !== identity.branch || execution.base?.ref !== identity.base.ref
            || execution.base?.sha !== identity.base.sha) {
            throw new Error('A verified execution must preserve its public repository, worktree, branch and pinned base')
          }
        }
      }
      // The executor supplies the identity; the Store is the final atomic authority over physical paths and branches.
      // Check again when verification or a writer grant changes, not on unrelated ticket/status saves.
      if (after && (!before || after.generation > before.generation || after.verified && !before.verified
        || ticket.execution?.active_writer && !stored?.execution?.active_writer)) {
        const { repository, commonDir, worktree, branch } = after.identity
        const directory = ticket.execution!.directory
        const canonical = canonicalTarget(worktree)
        if (!branch || !sameDirectory(canonical, worktree)
          || !sameDirectory(canonicalTarget(repository), repository)
          || !sameDirectory(canonicalTarget(commonDir), commonDir)
          || !isAbsolute(directory) || !sameDirectory(resolve(directory), worktree)
          || !sameDirectory(canonicalTarget(directory), canonical)) {
          throw new Error('Execution ownership requires the canonical repository, common directory and ticket worktree paths')
        }
        // Older stored identities or public worktree paths may predate the canonical indexes. Resolve them too:
        // a symlink alias or Windows drive-name casing must not grant a second ticket the same writer.
        for (const other of this.tickets.list()) {
          if (other.id === ticket.id) continue
          const owned = other.execution?.ownership?.identity
          const previousPath = owned?.worktree ?? other.execution?.worktree
            ?? (other.assignments.some(item => item.startedAt && !item.writer) ? other.execution?.directory : undefined)
          if (previousPath && isAbsolute(previousPath) && sameDirectory(canonicalTarget(previousPath), canonical)) {
            throw new Error(`The worktree directory is owned by ticket ${other.id}`)
          }
          if (owned?.commonDir && isAbsolute(owned.commonDir)
            && sameDirectory(canonicalTarget(owned.commonDir), commonDir) && owned.branch === branch) {
            throw new Error(`The repository branch is owned by ticket ${other.id}`)
          }
        }
      }
      this.db.prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id, JSON.stringify(ticket))
    }),
    /** Newest first. */
    list: (): Ticket[] => this.values('SELECT value FROM ticket ORDER BY rowid DESC'),
    /** Newest first. */
    open: (): Ticket[] => this.values('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC'),
    /** Newest first. */
    active: (): Ticket[] => this.values('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC'),
  }
  readonly decisions = {
    get: (id: string): Decision | undefined => { const row = this.db.prepare('SELECT value FROM decision WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as Decision : undefined },
    save: (decision: Decision): void => { this.db.prepare('INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread').run(decision.id, decision.threadKey, JSON.stringify(decision)) },
    byThread: (threadKeyValue: string): Decision[] => this.db.prepare('SELECT value FROM decision WHERE thread=? ORDER BY rowid').all(threadKeyValue).map(row => JSON.parse(String(row.value)) as Decision),
  }
  /** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
  readonly read: ReturnType<typeof storeReads>

  /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
  replyStatus(id: string): ReplyStatus | undefined { return this.receipts.get(id)?.status }
  /** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
  readonly receipts = {
    get: (id: string): Receipt | undefined => this.values<Receipt>('SELECT value FROM outbox WHERE id = ?', id)[0],
    /** Pending message receipts, oldest first. */
    waiting: (): Receipt[] => this.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
    /** True if an earlier message for the same ticket and conversation is still pending with fewer than `failures` consecutive failed `reply` effect attempts. */
    behind: (id: string, failures: number): boolean => !!this.db.prepare(`SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ? LIMIT 1`).get(id, failures),
    /**
     * Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
     * @returns Whether the message ID was newly recorded.
     */
    add: (message: OutboundMessage): boolean => {
      const receipt: Receipt = { ...message, status: 'pending' }
      return Number(this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)').run(message.id, JSON.stringify(receipt)).changes) > 0
    },
    /**
     * Marks a pending receipt as sent or dropped (with drop reason and timestamp), recreating the receipt if the message
     * was withdrawn while being sent so its ID cannot be queued again.
     */
    settle: (message: OutboundMessage, outcome: 'sent' | DropReason): void => {
      const settled = outcome === 'sent' ? { status: 'sent' } : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } }
      const { id, channel, text, kind, ticketId } = message
      const updated = this.db.prepare("UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'")
        .run(JSON.stringify(settled), id)
      if (!Number(updated.changes)) this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
        .run(id, JSON.stringify({ id, channel, text, kind, ...ticketId ? { ticketId } : {}, ...settled }))
    },
    /**
     * Withdraws a pending message that has not yet been sent.
     * @returns Whether a pending message with `id` was waiting and removed.
     */
    withdraw: (id: string): boolean =>
      Number(this.db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id).changes) > 0,
  }
}
export { key, threadKey }
export type { ChannelRef }
