# Agent Bridge development

Read `docs/DESIGN.md` before changing behavior. This is a standalone CLI, not an Inkine application package.

- Keep execution on demand. No listening server, persistent scheduler, or idle polling daemon. Background workers exit when their task ends. Codex invocations include `--no-daemon`.
- Use Node 24.10+ (`.nvmrc`). Runtime uses native TypeScript and SQLite; keep runtime dependencies at zero unless a concrete requirement justifies a change.
- `src/store.ts` owns durable transitions. Claims, lease checks, terminal state and result delivery must remain transactional. Never resume an interactive session merely because its native ID is known.
- Spawn provider argv without a shell. Preserve explicit model choice and read-only worker permissions. Keep prompts/results/provider logs in the state directory, outside version control.
- For persistence changes, reopen real temporary databases across advanced clocks and gaps. Verify no missed messages, repeated completion delivery, stale-owner writes, or concurrent turns in the same managed session.
- For worker changes, test with subprocess fixtures, including failures and cleanup. Automated tests must not invoke paid models. Live provider checks are separate and must report exactly what was exercised.
- Run `npm run typecheck` and `npm test` before completion claims. Keep README commands and the bundled agent skill aligned with CLI help.

`skills/agent-bridge/SKILL.md` explains using the bridge from a harness. It is separate from these development instructions.
