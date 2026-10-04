# Session discovery verification — 2026-10-04

Implementation reviewed: `0ad6aa0`. Coordinator reviewed the integration and subprocess lifecycle; a separate Luna reviewer reported no remaining concrete correctness finding.

## Automated checks

- Node 24.10.0: `npm run typecheck` passed.
- Node 24.10.0: `npm test` passed all 31 tests, including 8 discovery/creation integration tests.
- Shared skill validator and `git diff --check` passed.
- Independent fixture-backed CLI smoke: `session start --provider codex` and `session start --provider claude` each completed and captured the expected native ID. No model calls were made.

Fixtures use a restricted PATH and exercise both Claude row shapes, native status mapping, provider-aware deduplication and registry joins, canonical repository filtering, newest-first limiting, JSON-RPC initialization/pagination/split output, source configuration precedence, partial/total failures, invalid inputs, and owned-process cleanup including a descendant that ignores SIGTERM.

## Live read-only discovery

Both inherited `CODEX_HOME` and `CLAUDE_CONFIG_DIR` were removed from the test caller's environment. The bridge-local `discovery.json` still selected the intended installed provider directories, demonstrating that discovery doesn't depend on being invoked from the Codex harness.

- `session discover --limit 200` returned 133 records: 125 Codex and 8 Claude at the time of the check, without truncation.
- Both providers reported successful queries. Codex explicitly reported unavailable live status; its stored records were marked unknown. Claude reported 1 running, 2 idle, 4 waiting and 1 failed session.
- A repository-scoped active query returned 6 records for Inkine and included the warning that unknown Codex records are excluded by the active filter.
- Bridge registrations were identical before and after discovery.
- No temporary Codex metadata process or fake-discovery process remained after completion. The pre-existing user-owned runtime was not stopped or restarted.

Only metadata was queried. No model/turn/start/resume request, full transcript retrieval, automatic registration, or takeover of an external conversation occurred during live discovery.

## Limits

Claude's listing covers active interactive sessions and active/completed background sessions, not every historical interactive chat. Codex listing covers stored threads in the selected home and cannot prove whether another runtime is executing them. Results are bounded and include truncation/source diagnostics. Different profiles can be inspected with the provider-home override flags. Session creation starts managed worker conversations, not desktop windows; external conversations remain outside the bridge's resume ownership.

The bridge-local source configuration is local runtime state and is not committed to Git.
