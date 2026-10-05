# Session discovery implementation report

Implemented on-demand `session discover` for Claude Code and Codex metadata, plus `session start` as a direct alias of `submit`. Discovery reads native metadata without transcript bodies, joins only provider/native-ID registration matches, and never changes bridge registrations. Per-source failures remain visible alongside successful source results; a CLI call exits nonzero only when every requested source fails.

Codex uses an owned short-lived `codex --no-daemon app-server --stdio` process and only sends initialize/thread-list requests. `notLoaded` remains unknown because the query cannot establish live execution. Claude uses `claude agents --json --all`. Provider home/config selection follows explicit flags, bridge-home `discovery.json`, inherited environment, and stable home-directory defaults. Overrides apply only to child processes.

Metadata is filtered by canonical repository and active status before the limit. Results are deduplicated by provider/native ID, sorted newest-first with deterministic tie breaks, and report pagination truncation. Subprocess output and deadlines are bounded; stderr is drained; owned process groups are terminated with escalation and awaited cleanup.

Validation used hermetic provider fixtures only; no model calls or live provider commands were made.

- `npm run typecheck` — passed.
- `npm test` — 31 passed, 0 failed.
- Coverage includes both Claude row forms/statuses, Codex JSON-RPC initialization and pagination with split JSONL, filtering/deduplication/registration joins, config precedence and environment isolation, partial and total provider failures, malformed inputs, timeout cleanup of a SIGTERM-ignoring descendant, read-only discovery, and session-start native ID capture.
