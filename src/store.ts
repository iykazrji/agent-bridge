import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Claim, CreateTaskInput, FinishTaskInput, InboxMessage, Provider, RegisterSessionInput, Session, SessionContext, Task } from './types.ts';

const LEASE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 1_200_000;
const PROVIDERS = new Set<Provider>(['codex', 'claude']);

function required(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value.trim();
}

function repoPath(value: string): string {
  const absolute = resolve(required(value, 'repo'));
  try {
    const canonical = realpathSync(absolute);
    if (!statSync(canonical).isDirectory()) throw new TypeError(`repo must be a directory: ${absolute}`);
    return canonical;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`repo does not exist: ${absolute}`);
  }
}

function provider(value: Provider): Provider {
  if (!PROVIDERS.has(value)) throw new TypeError(`unsupported provider: ${String(value)}`);
  return value;
}

function rowToSession(row: Record<string, unknown> | undefined): Session | null {
  if (!row) return null;
  return { id: String(row.id), provider: row.provider as Provider, repo: String(row.repo), workflow: String(row.workflow), role: row.role === null ? null : String(row.role), nativeId: row.native_id === null ? null : String(row.native_id), managed: Number(row.managed) === 1, createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at) };
}

function rowToTask(row: Record<string, unknown> | undefined): Task | null {
  if (!row) return null;
  return { id: String(row.id), requesterSessionId: String(row.requester_session_id), workerSessionId: String(row.worker_session_id), workflow: String(row.workflow), repo: String(row.repo), provider: row.provider as Provider, prompt: String(row.prompt), model: row.model === null ? null : String(row.model), parentTaskId: row.parent_task_id === null ? null : String(row.parent_task_id), status: row.status as Task['status'], result: row.result === null ? null : String(row.result), error: row.error === null ? null : String(row.error), ownerToken: row.owner_token === null ? null : String(row.owner_token), leaseUntil: row.lease_until === null ? null : Number(row.lease_until), timeoutMs: Number(row.timeout_ms), createdAt: Number(row.created_at), startedAt: row.started_at === null ? null : Number(row.started_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at), nativeId: row.native_id === null ? null : String(row.native_id), commitSha: row.commit_sha === null ? null : String(row.commit_sha), artifactDir: String(row.artifact_dir), resultPath: String(row.result_path), logPath: String(row.log_path) };
}

function rowToMessage(row: Record<string, unknown>): InboxMessage {
  return { id: String(row.id), recipientSessionId: String(row.recipient_session_id), senderSessionId: row.sender_session_id === null ? null : String(row.sender_session_id), taskId: row.task_id === null ? null : String(row.task_id), kind: row.kind as InboxMessage['kind'], body: String(row.body), createdAt: Number(row.created_at), acknowledgedAt: row.acknowledged_at === null ? null : Number(row.acknowledged_at) };
}

export class Store {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #home: string;
  #closed = false;

  constructor(home: string, now: () => number = Date.now) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.#home = resolve(home);
    this.#now = now;
    this.#db = new DatabaseSync(join(home, 'bridge.sqlite'));
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, repo TEXT NOT NULL, workflow TEXT NOT NULL,
        role TEXT, native_id TEXT, managed INTEGER NOT NULL CHECK (managed IN (0,1)),
        created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_scope ON sessions(workflow, repo, created_at);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, requester_session_id TEXT NOT NULL REFERENCES sessions(id),
        worker_session_id TEXT NOT NULL REFERENCES sessions(id), workflow TEXT NOT NULL, repo TEXT NOT NULL,
        provider TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT, parent_task_id TEXT REFERENCES tasks(id),
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','interrupted')),
        result TEXT, error TEXT, owner_token TEXT, lease_until INTEGER, timeout_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, native_id TEXT,
        commit_sha TEXT, artifact_dir TEXT NOT NULL, result_path TEXT NOT NULL, log_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_session ON tasks(worker_session_id, status);
      CREATE INDEX IF NOT EXISTS tasks_requester ON tasks(requester_session_id, created_at);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, recipient_session_id TEXT NOT NULL REFERENCES sessions(id), sender_session_id TEXT REFERENCES sessions(id), task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
        kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient_session_id, acknowledged_at, created_at);
      CREATE TABLE IF NOT EXISTS direct_messages (
        id TEXT PRIMARY KEY, sender_session_id TEXT NOT NULL REFERENCES sessions(id), recipient_session_id TEXT NOT NULL REFERENCES sessions(id),
        body TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, created_at);
    `);
  }

  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }

  #assertOpen(): void { if (this.#closed) throw new Error('store is closed'); }
  #transaction<T>(operation: () => T): T {
    this.#assertOpen();
    this.#db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.#db.exec('COMMIT'); return value; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  #session(id: string): Session | null { return rowToSession(this.#db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Record<string, unknown> | undefined); }
  #task(id: string): Task | null { return rowToTask(this.#db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined); }

  registerSession(input: RegisterSessionInput): Session {
    this.#assertOpen();
    const p = provider(input.provider), repo = repoPath(input.repo), workflow = required(input.workflow, 'workflow'), time = this.#now();
    const id = randomUUID();
    this.#db.prepare('INSERT INTO sessions(id,provider,repo,workflow,role,native_id,managed,created_at,last_seen_at) VALUES(?,?,?,?,?,?,0,?,?)').run(id, p, repo, workflow, input.role?.trim() || null, input.nativeId?.trim() || null, time, time);
    return this.#session(id)!;
  }

  getSession(id: string): Session | null { this.#assertOpen(); return this.#session(id); }

  listSessions(filter: { workflow?: string; repo?: string } = {}): Session[] {
    this.#assertOpen();
    const clauses: string[] = [], values: string[] = [];
    if (filter.workflow) { clauses.push('workflow=?'); values.push(filter.workflow); }
    if (filter.repo) { clauses.push('repo=?'); values.push(repoPath(filter.repo)); }
    const rows = this.#db.prepare(`SELECT * FROM sessions ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at`).all(...values) as Record<string, unknown>[];
    return rows.map(row => rowToSession(row)!);
  }

  createTask(input: CreateTaskInput): Task {
    return this.#transaction(() => {
      const p = provider(input.provider), repo = repoPath(input.repo), workflow = required(input.workflow, 'workflow'), prompt = required(input.prompt, 'prompt');
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive safe integer');
      let requester: Session | null;
      if (input.requesterSessionId) {
        requester = this.#session(input.requesterSessionId);
        if (!requester) throw new Error('requester session not found');
        if (requester.workflow !== workflow || requester.repo !== repo) throw new Error('requester workflow and repository must match task');
      } else {
        const id = randomUUID(), time = this.#now();
        this.#db.prepare('INSERT INTO sessions(id,provider,repo,workflow,role,native_id,managed,created_at,last_seen_at) VALUES(?,?,?,?,?,NULL,0,?,?)').run(id, p, repo, workflow, 'requester', time, time);
        requester = this.#session(id);
      }
      let worker: Session;
      if (input.parentTaskId) {
        const parent = this.#task(input.parentTaskId);
        if (!parent) throw new Error('parent task not found');
        if (parent.workflow !== workflow || parent.repo !== repo || parent.requesterSessionId !== requester!.id) throw new Error('follow-up must remain in the original workflow, repository, and requester session');
        if (parent.status !== 'succeeded' && parent.status !== 'failed') throw new Error('follow-up requires a completed parent task');
        if (!parent.nativeId) throw new Error('follow-up requires a native provider session ID');
        const parentWorker = this.#session(parent.workerSessionId);
        if (!parentWorker?.managed) throw new Error('parent task has no managed worker session');
        if (parentWorker.provider !== p) throw new Error('follow-up provider must match worker session');
        worker = parentWorker;
      } else {
        const id = randomUUID(), time = this.#now();
        this.#db.prepare('INSERT INTO sessions(id,provider,repo,workflow,role,native_id,managed,created_at,last_seen_at) VALUES(?,?,?,?,?,NULL,1,?,?)').run(id, p, repo, workflow, input.role?.trim() || 'worker', time, time);
        worker = this.#session(id)!;
      }
      const pending = this.#db.prepare("SELECT 1 FROM tasks WHERE worker_session_id=? AND status IN ('queued','running') LIMIT 1").get(worker.id);
      if (pending) throw new Error('worker session already has a queued or running task');
      const id = randomUUID(), now = this.#now();
      const artifactDir = join(this.#home, 'artifacts', id);
      this.#db.prepare("INSERT INTO tasks(id,requester_session_id,worker_session_id,workflow,repo,provider,prompt,model,parent_task_id,status,timeout_ms,created_at,commit_sha,artifact_dir,result_path,log_path) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?)").run(id, requester!.id, worker.id, workflow, repo, p, prompt, input.model?.trim() || null, input.parentTaskId ?? null, timeoutMs, now, input.commitSha ?? null, artifactDir, join(artifactDir, 'result.txt'), join(artifactDir, 'events.jsonl'));
      return this.#task(id)!;
    });
  }

  getTask(id: string): Task | null { this.#assertOpen(); return this.#task(id); }

  listTasks(filter: { workflow?: string; repo?: string; sessionId?: string; status?: Task['status'] } = {}): Task[] {
    this.#assertOpen();
    const clauses: string[] = [], values: (string | number)[] = [];
    if (filter.workflow) { clauses.push('workflow=?'); values.push(filter.workflow); }
    if (filter.repo) { clauses.push('repo=?'); values.push(repoPath(filter.repo)); }
    if (filter.sessionId) { clauses.push('(requester_session_id=? OR worker_session_id=?)'); values.push(filter.sessionId, filter.sessionId); }
    if (filter.status) { clauses.push('status=?'); values.push(filter.status); }
    const rows = this.#db.prepare(`SELECT * FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at`).all(...values) as Record<string, unknown>[];
    return rows.map(row => rowToTask(row)!);
  }

  claimTask(id: string): Claim | null {
    return this.#transaction(() => {
      const task = this.#task(id);
      if (!task || task.status !== 'queued') return null;
      const busy = this.#db.prepare("SELECT 1 FROM tasks WHERE worker_session_id=? AND status='running' LIMIT 1").get(task.workerSessionId);
      if (busy) return null;
      const token = randomUUID(), now = this.#now(), leaseUntil = now + LEASE_MS;
      const result = this.#db.prepare("UPDATE tasks SET status='running',owner_token=?,lease_until=?,started_at=? WHERE id=? AND status='queued'").run(token, leaseUntil, now, id);
      if (Number(result.changes) !== 1) return null;
      return { task: this.#task(id)!, token, leaseUntil };
    });
  }

  heartbeat(id: string, token: string): number {
    return this.#transaction(() => {
      const now = this.#now(), leaseUntil = now + LEASE_MS;
      const result = this.#db.prepare("UPDATE tasks SET lease_until=? WHERE id=? AND status='running' AND owner_token=? AND lease_until>=?").run(leaseUntil, id, token, now);
      if (Number(result.changes) !== 1) throw new Error('task lease is expired or owned by another worker');
      return leaseUntil;
    });
  }

  finishTask(id: string, token: string, finish: FinishTaskInput): Task {
    return this.#transaction(() => {
      const task = this.#task(id), now = this.#now();
      if (!task || task.status !== 'running' || task.ownerToken !== token || task.leaseUntil === null || task.leaseUntil < now) throw new Error('task lease is expired or owned by another worker');
      const result = finish.result ?? null, error = finish.error ?? null;
      this.#db.prepare('UPDATE tasks SET status=?,result=?,error=?,finished_at=?,owner_token=NULL,lease_until=NULL,native_id=?,commit_sha=COALESCE(?,commit_sha),artifact_dir=COALESCE(?,artifact_dir),result_path=COALESCE(?,result_path),log_path=COALESCE(?,log_path) WHERE id=? AND owner_token=?').run(finish.status, result, error, now, finish.nativeId ?? null, finish.commitSha ?? null, finish.artifactDir ?? null, finish.resultPath ?? null, finish.logPath ?? null, id, token);
      if (finish.nativeId) this.#db.prepare('UPDATE sessions SET native_id=?,last_seen_at=? WHERE id=? AND managed=1').run(finish.nativeId, now, task.workerSessionId);
      this.#insertMessage(task, finish.status === 'succeeded' ? 'task_succeeded' : 'task_failed', finish.status === 'succeeded' ? (result ?? 'Task completed.') : (error ?? 'Task failed.'), now);
      return this.#task(id)!;
    });
  }

  #insertMessage(task: Task, kind: InboxMessage['kind'], body: string, now: number): void {
    this.#db.prepare('INSERT OR IGNORE INTO messages(id,recipient_session_id,sender_session_id,task_id,kind,body,created_at) VALUES(?,?,NULL,?,?,?,?)').run(randomUUID(), task.requesterSessionId, task.id, kind, body, now);
  }

  reconcile(): number {
    return this.#transaction(() => {
      const now = this.#now();
      const expired = this.#db.prepare("SELECT * FROM tasks WHERE (status='running' AND lease_until<=?) OR (status='queued' AND created_at+?<=?)").all(now, LEASE_MS, now) as Record<string, unknown>[];
      let count = 0;
      for (const row of expired) {
        const task = rowToTask(row)!;
        const changed = this.#db.prepare("UPDATE tasks SET status='interrupted',error=?,finished_at=?,owner_token=NULL,lease_until=NULL WHERE id=? AND ((status='running' AND lease_until<=?) OR (status='queued' AND created_at+?<=?))").run(task.status === 'queued' ? 'Worker did not start before startup lease expired' : 'Worker lease expired', now, task.id, now, LEASE_MS, now);
        if (Number(changed.changes) === 1) {
          this.#insertMessage(task, 'task_interrupted', 'Task interrupted because its worker lease expired.', now);
          count++;
        }
      }
      return count;
    });
  }

  sendMessage(senderSessionId: string, recipientSessionId: string, body: string): InboxMessage {
    return this.#transaction(() => {
      const sender = this.#session(senderSessionId), recipient = this.#session(recipientSessionId);
      if (!sender || !recipient) throw new Error('session not found');
      if (sender.workflow !== recipient.workflow || sender.repo !== recipient.repo) throw new Error('message sessions must share workflow and repository');
      const text = required(body, 'message');
      const id = randomUUID(), now = this.#now();
      this.#db.prepare('INSERT INTO direct_messages(id,sender_session_id,recipient_session_id,body,created_at) VALUES(?,?,?,?,?)').run(id, senderSessionId, recipientSessionId, text, now);
      return { id, senderSessionId, recipientSessionId, taskId: null, kind: 'message', body: text, createdAt: now, acknowledgedAt: null };
    });
  }

  inbox(sessionId: string): InboxMessage[] {
    this.#assertOpen();
    if (!this.#session(sessionId)) throw new Error('session not found');
    const taskRows = this.#db.prepare('SELECT * FROM messages WHERE recipient_session_id=? AND acknowledged_at IS NULL').all(sessionId) as Record<string, unknown>[];
    const directRows = this.#db.prepare('SELECT id,recipient_session_id,sender_session_id,NULL AS task_id,\'message\' AS kind,body,created_at,acknowledged_at FROM direct_messages WHERE recipient_session_id=? AND acknowledged_at IS NULL').all(sessionId) as Record<string, unknown>[];
    return [...taskRows, ...directRows].map(rowToMessage).sort((a,b) => a.createdAt-b.createdAt);
  }

  ackMessage(sessionId: string, messageId: string): boolean {
    return this.#transaction(() => {
      const message = this.#db.prepare('SELECT recipient_session_id,acknowledged_at FROM messages WHERE id=? UNION ALL SELECT recipient_session_id,acknowledged_at FROM direct_messages WHERE id=? LIMIT 1').get(messageId, messageId) as Record<string, unknown> | undefined;
      if (!message) throw new Error('message not found');
      if (message.recipient_session_id !== sessionId) throw new Error('message belongs to another session');
      if (message.acknowledged_at === null) {
        const updateTask = this.#db.prepare('UPDATE messages SET acknowledged_at=? WHERE id=? AND recipient_session_id=?');
        const result = updateTask.run(this.#now(), messageId, sessionId);
        if (Number(result.changes) === 0) this.#db.prepare('UPDATE direct_messages SET acknowledged_at=? WHERE id=? AND recipient_session_id=?').run(this.#now(), messageId, sessionId);
      }
      return true;
    });
  }

  context(sessionId: string): SessionContext {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('session not found');
    this.#db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(this.#now(), sessionId);
    const tasks = this.listTasks({ workflow: session.workflow, repo: session.repo });
    const messages = this.inbox(sessionId);
    return { session: this.getSession(sessionId)!, relatedSessions: this.listSessions({ workflow: session.workflow, repo: session.repo }), tasks, messages };
  }

  addEvent(taskId: string, type: string, payload: string | Record<string, unknown>): void {
    this.#transaction(() => {
      if (!this.#task(taskId)) throw new Error('task not found');
      const eventType = required(type, 'event type');
      const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
      this.#db.prepare('INSERT INTO events(id,task_id,type,payload,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), taskId, eventType, content, this.#now());
    });
  }

  events(taskId: string): import('./types.ts').TaskEvent[] {
    this.#assertOpen();
    const rows = this.#db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY created_at').all(taskId) as Record<string, unknown>[];
    return rows.map(row => ({ id: String(row.id), taskId: String(row.task_id), type: String(row.type), payload: String(row.payload), createdAt: Number(row.created_at) }));
  }
}
