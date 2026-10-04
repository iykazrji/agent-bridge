#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.ts';
import { runWorker } from './worker.ts';
import { readHead } from './git.ts';
import type { Provider } from './types.ts';

const defaultHome = join(homedir(), '.local', 'share', 'agent-bridge');
const bool = { type: 'boolean' as const };
const str = { type: 'string' as const };
const common = { home: str };
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function homeOf(values: Record<string, unknown>, env: NodeJS.ProcessEnv): string { return resolve(String(values.home ?? env.AGENT_BRIDGE_HOME ?? defaultHome)); }
function promptOf(values: Record<string, unknown>): string {
  const hasText = typeof values.prompt === 'string', hasFile = typeof values['prompt-file'] === 'string';
  if (hasText === hasFile) throw new TypeError('provide exactly one of --prompt or --prompt-file');
  return hasText ? String(values.prompt) : readFileSync(String(values['prompt-file']), 'utf8');
}
function providerOf(value: unknown): Provider {
  if (value !== 'codex' && value !== 'claude') throw new TypeError('--provider must be codex or claude');
  return value;
}
function parse(args: string[], options: Record<string, typeof bool | typeof str>) {
  return parseArgs({ args, options: { ...common, ...options }, strict: true, allowPositionals: true }) as { values: Record<string, unknown>; positionals: string[] };
}
function requireValue(values: Record<string, unknown>, name: string): string {
  if (typeof values[name] !== 'string' || !String(values[name]).trim()) throw new TypeError(`--${name} is required`);
  return String(values[name]).trim();
}
function noPositionals(parsed: { positionals: string[] }, command: string): void { if (parsed.positionals.length) throw new TypeError(`${command} does not accept positional arguments: ${parsed.positionals.join(' ')}`); }
function exactlyOnePositional(parsed: { positionals: string[] }, command: string): string { if (parsed.positionals.length !== 1) throw new TypeError(`${command} requires exactly one task ID`); return parsed.positionals[0]!; }
function currentHead(repo: string): string | null {
  return readHead(repo);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  try {
    const [command, subcommand, ...tail] = argv;
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(`agent-bridge commands (Node 24.10+)

  session register --provider codex|claude --repo PATH --workflow NAME [--role ROLE] [--native-id ID]
  session list [--workflow NAME] [--repo PATH]
  submit --provider codex|claude --repo PATH (--from SESSION | --workflow NAME) (--prompt TEXT | --prompt-file PATH) [--model NAME] [--timeout MS] [--background]
  follow-up TASK_ID (--prompt TEXT | --prompt-file PATH) [--model NAME] [--timeout MS] [--background]
  status TASK_ID | result TASK_ID | list [--active] [--workflow NAME] [--repo PATH] [--session ID] [--status STATE]
  context --session ID | inbox --session ID
  send --from SESSION --to SESSION --message TEXT | ack --session SESSION --message MESSAGE_ID
  doctor

  --home PATH overrides AGENT_BRIDGE_HOME for any command.

Examples:
  agent-bridge session register --provider claude --repo . --workflow release --role requester
  agent-bridge submit --provider codex --repo . --workflow release --prompt 'Review the current changes'
  agent-bridge submit --provider claude --repo . --from SESSION_ID --prompt-file ./task.txt --background
  agent-bridge follow-up TASK_ID --prompt 'Explain the first finding'
`);
      return 0;
    }
    if (command === 'worker') {
      const parsed = parse(argv.slice(1), {});
      const id = exactlyOnePositional(parsed, 'worker');
      await runWorker(homeOf(parsed.values, env), id); return 0;
    }
    if (command === 'doctor') {
      const parsed = parse(argv.slice(1), {});
      if (Number(process.versions.node.split('.')[0]) < 24 || (Number(process.versions.node.split('.')[0]) === 24 && Number(process.versions.node.split('.')[1]) < 10)) throw new Error('Node 24.10 or newer is required');
      const home = homeOf(parsed.values, env); const store = new Store(home); store.reconcile();
      const providers = Object.fromEntries((['codex', 'claude'] as const).map(name => {
        try { return [name, { available: true, version: execFileSync(name, ['--version'], { encoding: 'utf8', timeout: 2500, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }]; }
        catch (error) { return [name, { available: false, error: error instanceof Error ? error.message : String(error) }]; }
      }));
      const ok = Object.values(providers as Record<string, { available: boolean }>).some(provider => provider.available);
      output({ ok, node: process.version, home, providers, authentication: 'not checked; doctor does not make model calls', sessions: store.listSessions().length, tasks: store.listTasks().length }); store.close(); return ok ? 0 : 1;
    }
    if (command === 'session' && subcommand === 'register') {
      const parsed = parse(tail, { provider: str, repo: str, workflow: str, role: str, 'native-id': str });
      noPositionals(parsed, 'session register');
      const store = new Store(homeOf(parsed.values, env));
      try { output(store.registerSession({ provider: providerOf(parsed.values.provider), repo: requireValue(parsed.values, 'repo'), workflow: requireValue(parsed.values, 'workflow'), role: parsed.values.role as string | undefined, nativeId: parsed.values['native-id'] as string | undefined })); }
      finally { store.close(); } return 0;
    }
    if (command === 'session' && subcommand === 'list') {
      const parsed = parse(tail, { workflow: str, repo: str }); const store = new Store(homeOf(parsed.values, env));
      noPositionals(parsed, 'session list');
      try { output(store.listSessions({ workflow: parsed.values.workflow as string | undefined, repo: parsed.values.repo as string | undefined })); } finally { store.close(); } return 0;
    }
    if (command === 'submit' || command === 'follow-up') {
      const positionalTask = command === 'follow-up' ? subcommand : undefined;
      const opts: Record<string, typeof bool | typeof str> = command === 'follow-up'
        ? { model: str, prompt: str, 'prompt-file': str, background: bool, timeout: str }
        : { provider: str, repo: str, workflow: str, from: str, model: str, prompt: str, 'prompt-file': str, background: bool, timeout: str, role: str };
      const parsed = parse(command === 'follow-up' ? tail : [subcommand, ...tail].filter((part): part is string => part !== undefined), opts);
      noPositionals(parsed, command);
      const prompt = promptOf(parsed.values); const store = new Store(homeOf(parsed.values, env));
      let createdTaskId = '';
      try {
        const requester = parsed.values.from as string | undefined;
        if (requester && parsed.values.workflow && store.getSession(requester)?.workflow !== parsed.values.workflow) throw new Error('--workflow must match the requesting session workflow');
        const parent = positionalTask;
        if (parent && !store.getTask(parent)) throw new Error('parent task not found');
        const ref = parent ? store.getTask(parent)! : null;
        const provider = parent ? ref!.provider : providerOf(parsed.values.provider);
        const repo = parent ? ref!.repo : requireValue(parsed.values, 'repo');
        const workflow = parent ? ref!.workflow : (requester ? store.getSession(requester)?.workflow : parsed.values.workflow as string | undefined) ?? requireValue(parsed.values, 'workflow');
        const timeoutMs = parsed.values.timeout === undefined ? undefined : Number(parsed.values.timeout);
        if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new TypeError('--timeout must be a positive integer in milliseconds');
        const task = store.createTask({ provider, repo, workflow, prompt, requesterSessionId: parent ? ref!.requesterSessionId : requester, model: (parsed.values.model as string | undefined) ?? (parent ? ref!.model ?? undefined : undefined), timeoutMs, parentTaskId: parent, role: parsed.values.role as string | undefined });
        createdTaskId = task.id;
        if (parsed.values.background) {
          const script = resolve(process.argv[1]!);
          mkdirSync(task.artifactDir, { recursive: true, mode: 0o700 });
          const logFd = openSync(join(task.artifactDir, 'worker.log'), 'a', 0o600);
          const worker = spawn(process.execPath, [...process.execArgv, script, 'worker', task.id, '--home', homeOf(parsed.values, env)], { detached: true, stdio: ['ignore', logFd, logFd], cwd: task.repo, env });
          closeSync(logFd);
          worker.once('error', error => { const s = new Store(homeOf(parsed.values, env)); const claim = s.claimTask(task.id); if (claim) s.finishTask(task.id, claim.token, { status: 'failed', error: `worker startup failed: ${error.message}` }); s.close(); });
          worker.unref(); output({ task, background: true }); return 0;
        }
      } finally { store.close(); }
      await runWorker(homeOf(parsed.values, env), createdTaskId);
      return await waitForTask(homeOf(parsed.values, env), createdTaskId);
    }
    if (command === 'status' || command === 'result') {
      const parsed = parse(argv.slice(1), {}); const id = exactlyOnePositional(parsed, command.toUpperCase());
      const store = new Store(homeOf(parsed.values, env));
      try { const task = store.getTask(id); if (!task) throw new Error('task not found'); store.reconcile(); const refreshed = store.getTask(id)!; const current = currentHead(refreshed.repo); const commitReviewStatus = !refreshed.commitSha || !current ? 'unavailable' : refreshed.commitSha === current ? 'current' : 'changed'; if (command === 'result' && refreshed.status !== 'succeeded') { output({ task: refreshed, currentHead: current, commitReviewStatus }); return 1; } output(command === 'result' ? { task: refreshed, result: refreshed.result, currentHead: current, commitReviewStatus } : { ...refreshed, currentHead: current, commitReviewStatus }); return refreshed.status === 'failed' || refreshed.status === 'interrupted' ? 1 : 0; } finally { store.close(); }
    }
    if (command === 'list') {
      const parsed = parse(argv.slice(1), { workflow: str, repo: str, session: str, status: str, active: bool }); noPositionals(parsed, 'list');
      if (parsed.values.active && parsed.values.status) throw new TypeError('--active cannot be combined with --status');
      const store = new Store(homeOf(parsed.values, env));
      try { store.reconcile(); output(store.listTasks({ workflow: parsed.values.workflow as string | undefined, repo: parsed.values.repo as string | undefined, sessionId: parsed.values.session as string | undefined, status: parsed.values.status as any }).filter(task => !parsed.values.active || task.status === 'queued' || task.status === 'running')); } finally { store.close(); } return 0;
    }
    if (command === 'context' || command === 'inbox') {
      const parsed = parse(argv.slice(1), { session: str }); if (parsed.positionals.length > 1) throw new TypeError(`${command} accepts at most one session ID`); if (parsed.values.session && parsed.positionals.length) throw new TypeError(`${command} accepts either --session or a positional session ID`); const id = (parsed.values.session as string | undefined) ?? parsed.positionals[0]; if (!id) throw new TypeError(`${command} requires --session or a session ID`);
      const store = new Store(homeOf(parsed.values, env)); try { store.reconcile(); output(command === 'context' ? store.context(id) : store.inbox(id)); } finally { store.close(); } return 0;
    }
    if (command === 'ack') {
      const parsed = parse(argv.slice(1), { session: str, message: str }); if (parsed.positionals.length > 1) throw new TypeError('ack accepts at most one message ID'); if (parsed.values.message && parsed.positionals.length) throw new TypeError('ack accepts either --message or a positional message ID'); const id = requireValue(parsed.values, 'session'), message = parsed.values.message as string | undefined ?? parsed.positionals[0]; if (!message) throw new TypeError('ack requires --message or message ID'); const store = new Store(homeOf(parsed.values, env)); try { output({ acknowledged: store.ackMessage(id, message) }); } finally { store.close(); } return 0;
    }
    if (command === 'send') {
      const parsed = parse(argv.slice(1), { from: str, to: str, message: str }); noPositionals(parsed, 'send'); const store = new Store(homeOf(parsed.values, env)); try { output(store.sendMessage(requireValue(parsed.values, 'from'), requireValue(parsed.values, 'to'), requireValue(parsed.values, 'message'))); } finally { store.close(); } return 0;
    }
    throw new TypeError(`unknown command or incomplete command: ${String(command)}${subcommand ? ` ${subcommand}` : ''}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function waitForTask(home: string, taskId: string): Promise<number> {
  if (!taskId) return 2;
  for (;;) {
    const store = new Store(home);
    try {
      store.reconcile(); const task = store.getTask(taskId);
      if (!task) throw new Error('task not found');
      if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'interrupted') {
        const current = currentHead(task.repo);
        const commitReviewStatus = !task.commitSha || !current ? 'unavailable' : task.commitSha === current ? 'current' : 'changed';
        output({ task, result: task.result, currentHead: current, commitReviewStatus });
        return task.status === 'succeeded' ? 0 : 1;
      }
    } finally { store.close(); }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().then(code => { process.exitCode = code; });
}
