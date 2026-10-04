# Agent Bridge Implementation Plan

> For agentic workers: implement the assigned task only; use tests first and report evidence. User requested Luna implementers and coordinator review. Do not spawn further agents.

**Goal:** A locally runnable, daemon-free Claude/Codex delegation CLI with durable workflow/session management.

**Architecture:** TypeScript scripts launch provider CLIs. SQLite records relationships, leases, results and inbox delivery. Background workers exist only during tasks.

**Tech stack:** Node >=24.10, TypeScript 5.9, node:sqlite, node:test; no runtime dependencies.

**Spec:** [DESIGN.md](DESIGN.md)

## Global constraints

- No persistent server or automatic wake-up; waiting/default and detached/background runs only.
- Codex initial and resume commands include global `--no-daemon` before `exec`.
- No shell interpolation, approval bypass, silent model fallback, automatic retries or uncontrolled resumption of interactive sessions.
- Default workers are read-only. Record commit metadata; don't modify caller checkout.
- Task lease: 30 seconds; heartbeat: 5 seconds; default timeout: 1,200 seconds.
- Durable transitions and inbox delivery are transactional and fenced by owner token. Only bridge-managed sessions can resume.
- All implementation stays in this standalone repository. Runtime state and credentials must never be committed.
- Run tests with injected clock across database reopen, consecutive days, gaps and stale leases. One-shot tests are insufficient.

## Task 1: Registry and durable state

Owner: first Luna implementer. Files: package.json, package-lock.json, tsconfig.json, src/types.ts, src/store.ts, test/store.test.ts. Add helpers only in owned scope.

Provide exported `Store` with constructor `(home: string, now?: () => number)`, `close()`, and typed methods for registerSession, getSession, listSessions, createTask, getTask, listTasks, claimTask, heartbeat, finishTask, reconcile, sendMessage, inbox, ackMessage, context. Write exact signatures/types in src/types.ts or exported store types; runtime implementer consumes them. IDs use UUIDs. Managed session marker must not be inferred from native ID. createTask atomically creates/reuses a managed worker session and validates requester workflow/repository; follow-up points to prior task. claimTask returns a unique lease token or rejects and serializes work per worker session. finishTask atomically updates terminal status and inserts one requester inbox message; reject late/foreign owner. Native ID updates must also be fenced.

- [ ] Write and run failing behavioral tests on temporary on-disk databases.
- [ ] Implement schema and typed methods, validation, repository canonicalization, workflow isolation, strict terminal transitions and ack ownership.
- [ ] Test two Store connections competing for claims; only one succeeds. Reopen across simulated days; completed tasks stay completed, inbox messages survive until ack, repeated reconciliation/delivery cannot duplicate messages. Move clock beyond lease: interrupt once; late completion is rejected. Validate invalid references before mutation.
- [ ] Run `npm test` and `npm run typecheck`; commit only owned files and report commands/results in docs/task-1-report.md.

Core test intent:
```ts
// Each run opens the same DB with an advanced injected clock.
// Day 1: create requester/task, claim, complete; one unread message.
// Day 2: reopen/reconcile; same message, no extra delivery.
// Day 7: reopen/ack; no unread messages, result still available.
// Day 40: reopen/reconcile; no repeated jobs or delivery.
```

## Task 2: CLI, provider adapters and temporary workers

Owner: second Luna implementer. Files: src/cli.ts, src/worker.ts, src/providers.ts, test/cli.test.ts, test/providers.test.ts, test/fixtures/*; package.json scripts/bin if needed. Consume Task 1 exported Store/types; don't invent parallel persistence. Small store corrections allowed only after coordinating.

- [ ] Read Task 1 interfaces and installed `codex exec --help`, `codex exec resume --help`, `claude --help` to derive exact argv.
- [ ] Write failing subprocess tests with fixture executables on temporary PATH. Fixture streams realistic JSONL events and records invocation/native resume ID. No network or real provider calls in automated tests.
- [ ] Implement strict CLI parsing using node:util parseArgs, commands from DESIGN.md, JSON stdout and useful exit codes. Reject unknown/missing/conflicting args before spawning. Prompt text/file mutual exclusion. `--home` and AGENT_BRIDGE_HOME select shared storage. `--from` propagates workflow and validates repo.
- [ ] Implement provider adapters (argv, stream parser, native thread/session ID and final result); reject provider-level error even with process exit zero. Preserve stderr as diagnostics. Use stdin for prompt and drain all pipes. Bound runtime and terminate owned process group on cancellation/timeout with escalation.
- [ ] Implement `submit` wait and background paths; detached worker invokes same Node executable and absolute script path, redirects stdio to task artifacts, unrefs parent. Failed worker startup is recorded; queued startup tasks expire on reconciliation. Finishing or error closes DB/timers and exits. Handle signals while waiting so children do not leak.
- [ ] Implement follow-up retaining managed worker session/native ID, source workflow and original requester. Fail if session already busy or native ID absent; never resume a manually registered session. Result includes artifact path and current-versus-reviewed commit status.
- [ ] Tests: default wait success + session capture, background eventual result, follow-up native resume, error/nonzero/invalid-output/missing executable, timeout, lease conflict, workflow isolation and inbox ack. Run `npm test` and `npm run typecheck`; commit owned files; report docs/task-2-report.md.

CLI acceptance shape:
```sh
node src/cli.ts doctor
node src/cli.ts session register --provider claude --repo /path/to/repo --workflow example --role implementer
node src/cli.ts submit --provider codex --model gpt-6-astra --repo /path/to/repo --from SESSION_ID --prompt 'Review this checkout; report findings only.'
node src/cli.ts context --session SESSION_ID
node src/cli.ts follow-up TASK_ID --prompt 'Explain finding one.'
```

## Task 3: Agent instructions, independent review and release

Owner: coordinator, with Luna review/documentation help. Files: README.md, skills/agent-bridge/SKILL.md, docs/VERIFICATION.md, scoped fixes.

- [ ] Write install/run instructions and exact runnable examples covering register, submit, background, status, result, context, inbox, ack and follow-up. Document last-seen versus running, no wake-ups, native ID ownership, no isolated checkout guarantee, and read-only default.
- [ ] Review code against DESIGN.md; request fixes with regression tests for concrete findings.
- [ ] Run full automated checks. Exercise a bounded live Codex task then follow-up using isolated bridge storage; try Claude if configured. Record actual evidence and unavailable capabilities.
- [ ] Verify git contains no state/logs/secrets, create private GitHub repository, push reviewed commits, verify visibility, and provide local path/repo URL/first-run command to user.
