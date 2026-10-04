# Agent Bridge

Delegate review and research between Claude Code and Codex from your terminal or an agent's shell tool. SQLite keeps workflows, sessions, results, and inbox messages between runs.

**No persistent server.** Commands run on demand. A background worker exists only while its task runs, then exits. Codex workers also use `--no-daemon`.

## Requirements

- Node.js 24.10 or newer (native TypeScript and `node:sqlite`).
- The `codex` and/or `claude` CLI on PATH, already authenticated. The bridge uses their normal authentication; it does not store credentials.
- macOS or Linux for detached workers and process-group cleanup.

Run from this checkout:

```sh
nvm use
node src/cli.ts doctor
node src/cli.ts --help
```

If you don't use nvm, select Node 24.10+ with your version manager. `node --version` must report the selected version; this machine also has an older system Node installation.

There are no runtime npm dependencies. For development:

```sh
npm ci
npm run typecheck
npm test
```

## Give it to your agent

Tell Claude or Codex:

> Read `skills/agent-bridge/SKILL.md` in this checkout. Register this conversation for my current workflow, then use the bridge to delegate the review to Codex with model `gpt-6-astra`. Retrieve the review and show me the findings.

Use the absolute path to this checkout in another repository. The portable skill is bundled, not installed into your global agent configuration automatically.

## Sessions and workflows

A workflow groups related assignments in one repository. A session is a conversation. A task is one assignment in that conversation. Delegation records both the requesting session and its worker session so results have a destination.

Register your initiating conversation and retain its returned ID:

```sh
node src/cli.ts session register \
  --provider claude --repo /absolute/path/to/repo \
  --workflow pr-142 --role implementer
```

Manually registered sessions are **last-seen records**, not proof of a live process. A native session ID is optional; it does not authorize the bridge to resume that interactive conversation. Only workers created by the bridge can be resumed through `follow-up`.

Submit a review using the returned session ID:

```sh
node src/cli.ts submit \
  --provider codex --model gpt-6-astra \
  --repo /absolute/path/to/repo --from SESSION_ID \
  --prompt 'Review the current checkout. Report concrete bugs with file and line references. Do not edit files or post comments.'
```

Submission waits by default. Add `--background` to receive a task ID immediately. Use `--prompt-file /path/to/request.md` instead of `--prompt` for a longer brief.

Use task and session IDs from JSON responses:

```sh
node src/cli.ts status TASK_ID
node src/cli.ts result TASK_ID
node src/cli.ts list --active
node src/cli.ts context --session SESSION_ID
node src/cli.ts inbox --session SESSION_ID
node src/cli.ts ack --session SESSION_ID --message MESSAGE_ID
node src/cli.ts send --from SESSION_ID --to PEER_SESSION_ID --message 'Please check the retry behavior.'
node src/cli.ts follow-up TASK_ID --prompt 'Explain the first finding in more detail.'
```

The inbox retains messages until explicit acknowledgment; reading it never discards results. Follow-ups reuse the managed conversation, workflow, and original requester. They cannot run concurrently in the same worker session. An interrupted worker session cannot be resumed through an older task either; start a new assignment after checking the interruption.

Commands return JSON (help is text). Waiting submission returns one final JSON document; background submission returns one task document immediately. `result` and `status` include `currentHead` and `commitReviewStatus` (`current`, `changed`, or `unavailable`) to compare the checkout against the reviewed commit. Use `--timeout 120000` for a two-minute task deadline; values are milliseconds. Append `--home PATH` after the command to select a state directory for that invocation.

`doctor` checks Node, SQLite initialization, and provider executable versions. It does not call a model or verify model access. Node 24 may print its experimental SQLite warning on stderr; JSON remains on stdout.

## What persists

State defaults to `~/.local/share/agent-bridge`. Set `AGENT_BRIDGE_HOME` or use `--home` to choose another location. Both harnesses must use the same location to discover each other's bridge workflows.

SQLite stores session relationships, task states, events, and inbox messages. Task artifacts include prompts, provider event logs, diagnostics, and results. Keep this directory private; it may contain your source code or research. It is separate from the Git repository and is not uploaded by the bridge.

Workers maintain leases while running. After an interruption, the next bridge inspection reconciles expired work once; it does not restart providers automatically. A late worker cannot overwrite an interrupted task as successful. A task has a finite timeout, with a 20-minute default.

## First-version boundaries

- Background completion does not wake an idle conversation. The initiating agent checks at workflow checkpoints or waits for its result.
- Discovery covers registered bridge sessions. It does not scan all desktop/cloud chats.
- The caller prepares the checkout for a review. The bridge records commit metadata; it does not fetch a PR or create an isolated worktree. Avoid changing the checkout during a review. Uncommitted edits are not uniquely identified by a commit SHA.
- Workers are configured for read-only work. Codex uses its read-only sandbox. Claude exposes Read/Grep/Glob through its harness; trusted local configuration and hooks still apply. This is not an OS sandbox for untrusted repositories.
- Documents, images, web access, and connectors depend on the worker's configured tools. Desktop-tool parity is not implied.
- No automatic GitHub comments, fixes, merges, retries, or model substitutions.

See [design](docs/DESIGN.md), [implementation plan](docs/PLAN.md), [provider contracts](docs/PROVIDERS.md), and [verification results](docs/VERIFICATION.md).
