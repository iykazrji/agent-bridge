import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Store } from './store.ts';
import { buildProviderCommand, extractProviderNativeId, parseProviderEvents } from './providers.ts';
import { readHead } from './git.ts';
import type { Task } from './types.ts';

function promptFor(task: Task, store: Store): string {
  const context = store.context(task.workerSessionId);
  const recent = context.tasks.slice(-8).map(item => `${item.id} ${item.status}: ${(item.result ?? item.error ?? '').slice(0, 240)}`).join('\n');
  return `Bridge assignment\nWorkflow: ${task.workflow}\nRequester session: ${task.requesterSessionId}\nTask: ${task.id}\n${task.parentTaskId ? `Related task: ${task.parentTaskId}\n` : ''}Repository: ${task.repo}\nRelated workflow sessions: ${context.relatedSessions.map(s => `${s.id} (${s.provider}/${s.role ?? 'agent'})`).join(', ') || 'none'}\nRecent related tasks:\n${recent || 'none'}\n\n${task.prompt}`;
}

function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  } else child.kill('SIGTERM');
  return new Promise(resolvePromise => setTimeout(() => {
    if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    else child.kill('SIGKILL');
    resolvePromise();
  }, 1500));
}

export async function runWorker(home: string, taskId: string): Promise<void> {
  const store = new Store(home);
  let token: string | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let timeout: NodeJS.Timeout | null = null;
  let killEscalation: Promise<void> | null = null;
  let terminationRequested = false;
  let interrupted = false;
  let stderr = '';
  let nativeId: string | undefined;
  let task: Task | null = null;
  let claimedTaskId: string | null = null;
  let terminalCommitted = false;
  let fatalMessage: string | null = null;
  const streamWriteError: { value: Error | null } = { value: null };
  try {
    store.reconcile();
    const claim = store.claimTask(taskId);
    if (!claim) throw new Error('task could not be claimed (already running, expired, or missing)');
    token = claim.token;
    task = claim.task;
    claimedTaskId = task.id;
    const activeTask = task;
    mkdirSync(activeTask.artifactDir, { recursive: true, mode: 0o700 });
    writeFileSync(activeTask.logPath, '', { mode: 0o600 });
    const fullPrompt = promptFor(activeTask, store);
    writeFileSync(`${activeTask.artifactDir}/prompt.txt`, fullPrompt, { mode: 0o600 });
    store.addEvent(activeTask.id, 'worker.started', { provider: activeTask.provider, workflow: activeTask.workflow });
    const startedHead = readHead(activeTask.repo) ?? activeTask.commitSha ?? undefined;
    const session = store.getSession(activeTask.workerSessionId)!;
    if (!session.managed) throw new Error('refusing to resume an unmanaged session');
    if (task.parentTaskId && !session.nativeId) throw new Error('follow-up requires a native provider session ID');
    const command = buildProviderCommand({ provider: activeTask.provider, model: activeTask.model, nativeId: activeTask.parentTaskId ? session.nativeId : null, prompt: activeTask.prompt });
    const prompt = fullPrompt;
    const stdout: Buffer[] = [];
    child = spawn(command.command, command.args, { cwd: activeTask.repo, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const owned = child;
    const requestTermination = () => {
      if (!terminationRequested) { terminationRequested = true; killEscalation = terminate(owned); }
    };
    let resolved = false;
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
      owned.once('error', rejectPromise);
      owned.stdout!.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
        try { appendFileSync(activeTask.logPath, chunk); }
        catch (error) { streamWriteError.value = error instanceof Error ? error : new Error(String(error)); interrupted = true; requestTermination(); }
        if (!nativeId) nativeId = extractProviderNativeId(activeTask.provider, Buffer.concat(stdout).toString('utf8'));
      });
      owned.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      owned.stdin!.on('error', () => { /* A provider may exit before consuming all prompt bytes. */ });
      owned.once('close', (code, signal) => { resolved = true; resolvePromise({ code, signal }); });
      owned.stdin!.end(prompt);
      timeout = setTimeout(() => { interrupted = true; requestTermination(); }, activeTask.timeoutMs);
      heartbeat = setInterval(() => {
        try { store.heartbeat(activeTask.id, token!); }
        catch { interrupted = true; requestTermination(); }
      }, 5000);
      const onSignal = () => { interrupted = true; requestTermination(); };
      process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
      owned.once('close', () => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); });
    });
    if (interrupted && killEscalation) await killEscalation;
    if (!resolved || interrupted) throw new Error(interrupted ? 'worker interrupted by timeout, lease loss, or signal' : 'provider process ended unexpectedly');
    const raw = Buffer.concat(stdout).toString('utf8');
    if (streamWriteError.value) throw new Error(`could not write provider event log: ${streamWriteError.value.message}`);
    nativeId = extractProviderNativeId(activeTask.provider, raw);
    store.addEvent(activeTask.id, 'provider.exited', { code: outcome.code, signal: outcome.signal, nativeId });
    if (stderr) writeFileSync(`${activeTask.artifactDir}/stderr.log`, stderr, { mode: 0o600 });
    if (outcome.code !== 0) throw new Error(`provider exited with code ${String(outcome.code)}${outcome.signal ? ` (${outcome.signal})` : ''}${stderr.trim() ? `: ${stderr.trim().slice(-3000)}` : ''}`);
    const parsed = parseProviderEvents(activeTask.provider, raw);
    nativeId = parsed.nativeId ?? nativeId;
    writeFileSync(activeTask.resultPath, parsed.result, { mode: 0o600 });
    const finishedHead = readHead(activeTask.repo) ?? startedHead;
    if (finishedHead && startedHead && finishedHead !== startedHead) appendFileSync(activeTask.logPath, `\n[bridge] Repository HEAD changed during the task: ${startedHead} -> ${finishedHead}\n`);
    const updated = store.finishTask(activeTask.id, token, { status: 'succeeded', result: parsed.result, nativeId, commitSha: startedHead, logPath: activeTask.logPath });
    terminalCommitted = true;
    store.addEvent(updated.id, 'worker.succeeded', { nativeId, startedHead, finishedHead, commitStatus: startedHead && finishedHead && startedHead === finishedHead ? 'unchanged' : 'changed-or-unavailable' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!claimedTaskId) fatalMessage = message;
    if (child?.pid && child.exitCode === null && child.signalCode === null && !terminationRequested) { terminationRequested = true; killEscalation = terminate(child); }
    if (killEscalation) await killEscalation;
    if (task && stderr) { try { writeFileSync(`${task.artifactDir}/stderr.log`, stderr, { mode: 0o600 }); } catch { /* diagnostics are best effort */ } }
    const current = store.getTask(taskId);
    if (claimedTaskId === taskId && current?.status === 'running' && token) {
      try { store.finishTask(taskId, token, { status: 'failed', error: message, nativeId, logPath: current.logPath }); terminalCommitted = true; store.addEvent(taskId, 'worker.failed', { error: message }); }
      catch { /* Lease expiry or reconciliation already fenced this worker. */ }
    }
    if (claimedTaskId === taskId && !terminalCommitted && current && current.status !== 'succeeded') {
      try { mkdirSync(dirname(current.logPath), { recursive: true, mode: 0o700 }); appendFileSync(current.logPath, `\n[bridge error] ${message}\n`); writeFileSync(current.resultPath, message, { mode: 0o600 }); } catch { /* Preserve the durable task failure. */ }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
    try { store.close(); } catch { /* already closed */ }
  }
  if (fatalMessage) throw new Error(fatalMessage);
}
