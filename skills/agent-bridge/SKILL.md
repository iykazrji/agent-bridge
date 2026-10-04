---
name: agent-bridge
description: Discover local Claude and Codex sessions, start a worker in either harness, delegate review or research, retrieve results, and continue a managed conversation through the local agent bridge.
---

# Agent bridge

Use the bridge when the user requests work from the other harness or when continuing an existing bridge workflow. It runs on demand; there is no server and no automatic inbox wake-up.

## Locate and register

Find the bridge checkout from the user's supplied path or `AGENT_BRIDGE_ROOT`. Check `node --version` first: the bridge requires Node 24.10+. If a shell resolves an older system Node, select the checkout's `.nvmrc` version with the available version manager; retain that Node executable's absolute path for later calls, since separate shell invocations may reset PATH. Run that Node executable with `/absolute/path/to/agent-bridge/src/cli.ts --help` for the installed command contract. Both harnesses must use the same `AGENT_BRIDGE_HOME` (default `~/.local/share/agent-bridge`). Run `doctor` if setup is uncertain.

Register your conversation with your provider, canonical repository path, an explicit workflow name (such as `pr-142`), and role. Keep the returned bridge session ID in your working context. Supply a native conversation ID only if the harness actually exposes it; otherwise leave it unset. Reuse your bridge session ID on continuation rather than creating a new identity at every checkpoint.

Use the same workflow for explicitly related assignments. Sharing a repository does not establish workflow membership. Registered interactive sessions are last-seen records; registration does not give the bridge ownership of their processes.

## Discover and choose a session

Use `session discover --repo REPO_PATH` to see relevant local Claude/Codex conversation metadata, including sessions started outside the bridge. Use `session list` for bridge registrations and `context --session SESSION_ID` for your registered workflow. Check the returned per-provider source diagnostics and truncation indicators. Codex stored threads with unknown live status are not evidence of an idle or stopped conversation; `--active` includes only confirmed active states. Claude discovery covers active interactive and active/completed background sessions, not its entire chat archive.

If the two harnesses inherit different provider homes, use the bridge's `discovery.json` configuration or the discovery source override flags from CLI help. Discovery leaves conversations externally owned. A matching repository or title does not authorize resuming somebody else's interactive session.

When a relevant bridge-managed worker already exists, use its bridge session ID with `list --session ID` to find a task for `follow-up`. Otherwise create a new worker with `session start` (an alias for `submit`). Both Claude and Codex can invoke either provider; these commands create worker conversations, not desktop windows.

## Delegate

Pass the requesting session using `--from`, requested provider/model, repository, and prompt. Include the task's outcome, relevant decisions, exact review commit/base, and output expectations. For a review, have the caller prepare the intended checkout first; the bridge records HEAD but does not create an isolated PR checkout. Include any relevant review-skill path and whether findings should stay local. Sending a task does not grant permission to post comments or change the repository.

Use a prompt file for substantial context. Default submission waits and returns the result. Use `--background` when other work can continue, retain the task ID, and retrieve status/result at the next useful checkpoint. Match the requested model exactly; surface access failures instead of substituting another model.

Workers are configured for read-only tasks. Implementation/fixes remain with the initiating agent. Do not promise document/image tools or connectors merely because they exist in a desktop session.

## Receive and continue

Check `context --session SESSION_ID` on resumption, after a substantial step, and before declaring the workflow complete. Read your inbox; acknowledge each message only after incorporating it into your work or explicitly recording its disposition. A read is not an acknowledgment.

Check the reviewed commit against the current checkout before acting on findings. Keep stale findings attached to their original commit; request another review when changes invalidate them.

Use `follow-up TASK_ID` for another turn in a bridge-managed worker's conversation. It preserves the worker session and workflow. Manually registered interactive conversations cannot be resumed by this command. A busy session should be allowed to finish before follow-up.

An interrupted/failed task is not a successful empty review. Inspect its diagnostics and report the cause. Start a replacement only after deciding the prior run is no longer active; the bridge does not retry automatically. Background completion is durable but does not wake an idle conversation. Retrieve it explicitly.
