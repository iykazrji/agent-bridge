# Task 2 implementation report

Implemented the daemon-free CLI, Codex/Claude adapters, and temporary workers. Wait-mode and background submissions share the same worker implementation; follow-ups only resume a bridge-managed worker session with its captured native ID. Worker prompts include workflow/task/requester identifiers and related workflow context. The CLI supports session registration/discovery, task status/result/list, context, inbox/ack, direct messages, follow-up, and provider health checks. It emits JSON on stdout for command results and rejects unknown, conflicting, or inapplicable options before provider launch.

Codex commands use the local documented global read-only/approval flags before `exec` and explicitly pass a requested model without fallback. Claude runs with `Read,Grep,Glob`, `dontAsk`, and no permission-prompt handler. Provider JSONL is streamed into private task artifacts; stderr is retained separately. Workers heartbeat every five seconds, use a finite task timeout, fence results through the Store lease, and terminate the owned process group with TERM then KILL escalation. Result/status output reports whether current repository HEAD matches the reviewed commit when both are available.

The Store initialization now installs `busy_timeout` before requesting WAL mode and retries transient SQLite busy/locked responses while enabling WAL. Follow-ups reject worker sessions with interrupted history, and lease heartbeat/completion use an exclusive deadline consistent with reconciliation. Internal worker claims cannot overwrite existing artifacts; an unclaimable worker reports an error. Context and inbox inspection reconcile expired work, and task output compares current HEAD with the recorded review commit.

Commit metadata uses a shared bounded Git helper. If PATH resolves to a Git executable that cannot launch on macOS, it retries with `/usr/bin/git`; normal Git errors such as a non-repository result do not trigger fallback. It does not modify PATH.

## Verification

Run under Node 24.10 because the login-shell default is Node 18:

- `npm test` — 23 passed, 0 failed. This includes hermetic fake-provider subprocesses for wait/background/resume, provider and process errors, missing executables, timeout and descendant cleanup, CLI validation, Git fallback/non-repository behavior, 24 concurrent fresh database opens, lease boundaries, follow-up fencing, durable inbox behavior, and duplicate-worker artifact preservation.
- `npm run typecheck` — passed with `noUnusedLocals` and `noUnusedParameters` enabled.

No live-provider smoke test was run as part of this task; the coordinator owns that check. Doctor checks bounded CLI version availability and explicitly leaves authentication unchecked.

## Test harness incident

An earlier version of the fake-provider harness created non-executable symlinks. PATH then fell through to the installed authenticated Claude CLI during two background test cases. Both unintended calls used the prompt `work` against empty temporary repositories and completed with a request for more context; they made no repository changes. The task IDs were `eb59fe1f-ade8-4c97-bb98-9103fa92a846` and `51c24ccb-a61a-4872-bff1-c68aea846305`, in temporary homes `agent-bridge-cli-HY4jjB/home` and `agent-bridge-cli-F5OWV2/home` under the system temp directory. The harness now copies executable fixtures into an isolated PATH containing only those fixtures, Node, and `/usr/bin:/bin`. Both temporary homes were removed, and no bridge worker from these tests remains running.
