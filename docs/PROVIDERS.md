# Provider integration reference

Checked against local Codex 0.160.0 and Claude Code 2.1.289 on 2026-10-04.

## Codex

Use global options before `exec` so they also apply on resume:

```text
codex --no-daemon --sandbox read-only --ask-for-approval never exec --json --model MODEL -
codex --no-daemon --sandbox read-only --ask-for-approval never exec resume --json --model MODEL NATIVE_ID -
```

Set subprocess cwd to repository. Send prompt via stdin. Capture `thread.started.thread_id`; collect `item.completed` where item.type is `agent_message`, preferring final-phase messages if provided; require `turn.completed` and a nonempty result. `turn.failed`, top-level `error`, nonzero exit and missing final message are failures. Store JSONL raw log to inspect version differences.

`--no-daemon` prevents use of Codex's own shared daemon. `never` denies approval requests; it does not bypass the read-only sandbox. Existing authenticated CLI configuration remains in use. Do not set fallback models.

Official reference: https://learn.chatgpt.com/docs/non-interactive-mode

## Claude Code

```text
claude -p --output-format stream-json --verbose --permission-mode dontAsk --permission-prompts none --tools Read,Grep,Glob --model MODEL
claude -p --output-format stream-json --verbose --permission-mode dontAsk --permission-prompts none --tools Read,Grep,Glob --model MODEL --resume NATIVE_ID
```

Omit --model if unspecified. Prompt via stdin; cwd is repository. Capture `session_id` from init/result events; result event text is `result`. Reject `is_error: true`, error subtype, nonzero exit, malformed stream or missing final result. A tool restriction is a harness-level configuration, not an OS sandbox; local hooks/plugins are trusted configuration. Do not claim that this is an isolation boundary for untrusted repositories.

Read/Grep/Glob permits inspection without granting shell or edit tools. A future explicitly authorized profile can broaden capabilities. Avoid --bare for this first version because it changes authentication and skips user/project context. Follow-ups use captured native session ID rather than --continue/--last.

Official reference: https://code.claude.com/docs/en/headless
