# Verification — 2026-10-04

Reviewed implementation: `33e6c85`, with final documentation and ignore-rule updates following it. Two Luna implementers built the registry and CLI/worker layers. The coordinator reviewed the implementation; a separate Luna reviewer checked the design, registry invariants, and CLI behavior.

## Automated checks

Using Node 24.10.0 selected through PATH:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed; strict typing and unused-local/parameter checks enabled |
| `npm test` | 23 passed, 0 failed |
| `git diff --check` | Passed |
| Bundled skill validator | Passed |

Tests cover real SQLite persistence across reopened databases and advanced clocks, acknowledgment ownership, workflow isolation, lease fencing, queued-startup expiry, concurrent first database opens, interrupted-session resumption, provider subprocess success/failure, background completion, native session resumption, strict arguments, duplicate-worker artifact protection, Git executable fallback, and forced cleanup of a descendant that ignores SIGTERM.

An independent concurrency probe originally reproduced 5 failed first opens in 24 attempts. Installing the SQLite busy timeout before journal initialization fixed the reproduced race; the subprocess regression now passes.

## Live provider checks

Used an isolated temporary Git repository and bridge state directory, not a product checkout. Providers used their existing authenticated CLI sessions.

| Check | Observed result |
| --- | --- |
| `doctor` | Codex 0.160.0 and Claude Code 2.1.289 available |
| Codex `gpt-6-astra` waiting task | Read the fixture README and returned `BRIDGE_READ_OK` |
| Codex follow-up | Same native thread ID; returned the remembered token `ORCHID-71` without re-reading files |
| Claude background task | Submission returned immediately; worker read README and returned `CLAUDE_READ_OK` |
| Claude follow-up | Same native session ID; returned the remembered token `CEDAR-42` without re-reading files |
| Session context | One initiating session and two related worker sessions; all four tasks succeeded |
| Inbox | Four completion messages; repeated reads preserved them; repeated acknowledgment did not duplicate or drop other messages |
| Direct messaging | Worker-to-requester message delivered and acknowledged |
| Commit metadata | Recorded reviewed HEAD; after a new fixture commit, `result` reported `commitReviewStatus: changed` |
| Idle cleanup | `list --active` returned `[]`; no bridge worker or fake-provider process remained |

The first Codex smoke checks exposed an old Intel `/usr/local/bin/git` that Node ARM could not launch. A scoped macOS fallback to `/usr/bin/git` now provides commit metadata without modifying the user's PATH or Git installation. The subsequent Claude task and current/changed result checks verified the fix on this machine.

Two unintended Claude calls occurred during early fixture development because the original test PATH could fall through to the installed provider. They ran only against empty temporary repositories and made no repository changes. The harness now uses executable copied fixtures and a restricted PATH. Details are retained in `task-2-report.md`.

## Limits of this verification

This verifies transport, persistence, session continuation, and lifecycle behavior. It does not establish review quality on a particular PR, support for every CLI version, or parity with desktop image/document/connector tools. The first version uses caller-prepared checkouts, read-only worker profiles, and explicit inbox checks; it does not wake arbitrary open conversations or create isolated PR worktrees. It was exercised on macOS; Linux was not exercised on a separate machine.

No runtime databases, prompts, provider logs, or credentials are committed to this repository.
