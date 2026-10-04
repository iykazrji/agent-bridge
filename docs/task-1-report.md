# Task 1 implementation report

The registry uses a private SQLite database at `<home>/bridge.sqlite`, with WAL, foreign keys, a 5-second busy timeout, and full synchronous commits. Session/task/message/event writes that must remain consistent use `BEGIN IMMEDIATE` transactions. Repositories are resolved to existing canonical directories. Session `managed` is stored explicitly and is never inferred from a native provider ID.

## Exported API for Task 2

`Store` is exported from `src/store.ts`; public data types are exported from `src/types.ts`.

```ts
new Store(home: string, now?: () => number): Store
close(): void
registerSession(input: RegisterSessionInput): Session
getSession(id: string): Session | null
listSessions(filter?: { workflow?: string; repo?: string }): Session[]
createTask(input: CreateTaskInput): Task
getTask(id: string): Task | null
listTasks(filter?: { workflow?: string; repo?: string; sessionId?: string; status?: TaskStatus }): Task[]
claimTask(id: string): Claim | null
heartbeat(id: string, token: string): number // updated lease deadline
finishTask(id: string, token: string, finish: FinishTaskInput): Task
reconcile(): number // number of queued/running tasks interrupted
sendMessage(senderSessionId: string, recipientSessionId: string, body: string): InboxMessage
inbox(sessionId: string): InboxMessage[] // unread only; reading never acknowledges
ackMessage(sessionId: string, messageId: string): boolean // recipient-scoped and repeatable
context(sessionId: string): SessionContext
addEvent(taskId: string, type: string, payload: string | Record<string, unknown>): void
events(taskId: string): TaskEvent[]
```

`CreateTaskInput` requires `provider`, `repo`, `workflow`, and `prompt`; it accepts `requesterSessionId`, `role`, `model`, `timeoutMs`, `parentTaskId`, and initial `commitSha`. Without a requester ID, a requester session is created in the same transaction. A new task gets its own managed worker session. A follow-up can reuse its parent's managed worker session only if the parent succeeded or failed and has a native provider ID; follow-ups retain the original requester, workflow, and canonical repository. Creation fails if that worker already has queued/running work.

`Task` includes `commitSha`, `artifactDir`, `resultPath`, and `logPath`; paths are deterministic below `<home>/artifacts/<task-id>/` (`result.txt`, `events.jsonl`). `finishTask` may update those values and commit SHA along with the terminal result. A successful/failed/interrupted terminal transition inserts exactly one requester inbox message. Lease ownership is checked transactionally; expired leases cannot heartbeat or finish. `reconcile()` expires running leases and queued tasks that did not start within 30 seconds.

`context()` updates the selected session's last-seen timestamp and returns tasks plus sessions scoped to the exact workflow and canonical repository. Inbox messages sent directly between sessions have `kind: 'message'`, `taskId: null`, and a sender session ID. Task notifications have a task ID and no sender session ID.

## Verification

Using the installed Node 24.10.0 binary (the login shell default was Node 18.16.0):

- `PATH=/Users/iyk/.nvm/versions/node/v24.10.0/bin:$PATH npm test` — 6 tests passed, 0 failed.
- `PATH=/Users/iyk/.nvm/versions/node/v24.10.0/bin:$PATH npm run typecheck` — passed.

Tests use temporary on-disk databases and injected clocks. They cover completion/inbox persistence through day 1/day 2/day 7/day 40 reopens, acknowledgement retention, two-connection claim competition, heartbeat and late-finish fencing, one-time lease and queued-startup expiry, managed-session native ID updates, follow-up reuse/busy rejection, recipient-only acknowledgement, workflow/repository validation and context isolation, direct messages, and persisted events.
