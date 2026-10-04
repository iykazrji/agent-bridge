import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, chmodSync, readFileSync, accessSync, constants, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const tempRoots: string[] = [];
test.after(() => { for (const root of tempRoots) rmSync(root, { recursive: true, force: true }); });

const cli = join(process.cwd(), 'src/cli.ts');
function setup(mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-cli-'));
  tempRoots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const fixture = join(process.cwd(), 'test/fixtures/fake-provider.js');
  chmodSync(fixture, 0o755);
  copyFileSync(fixture, join(bin, 'codex')); copyFileSync(fixture, join(bin, 'claude')); chmodSync(join(bin, 'codex'), 0o755); chmodSync(join(bin, 'claude'), 0o755); symlinkSync(process.execPath, join(bin, 'node'));
  accessSync(join(bin, 'codex'), constants.X_OK); accessSync(join(bin, 'claude'), constants.X_OK);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const home = join(root, 'home');
  const promptFile = join(root, 'prompt.txt'), argvFile = join(root, 'argv.json');
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, AGENT_BRIDGE_HOME: home, BRIDGE_FIXTURE_MODE: mode, BRIDGE_FIXTURE_PROMPT: promptFile, BRIDGE_FIXTURE_ARGV: argvFile };
  return { root, bin, repo, home, promptFile, argvFile, env };
}
async function run(args: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.setEncoding('utf8').on('data', part => out += part); child.stderr.setEncoding('utf8').on('data', part => err += part);
    child.once('error', reject); child.once('close', code => resolve({ code: code ?? 1, out, err }));
  });
}

test('default submit waits, captures provider session, and sends workflow/task context on stdin', async () => {
  const x = setup();
  const result = await run(['submit', '--provider', 'codex', '--repo', x.repo, '--workflow', 'review', '--model', 'gpt-6-astra', '--prompt', 'inspect this'], x.env);
  assert.equal(result.code, 0, result.err); const payload = JSON.parse(result.out.trim());
  assert.equal(payload.task.status, 'succeeded'); assert.equal(payload.task.nativeId, 'fixture-thread'); assert.equal(payload.result, 'fixture answer');
  assert.equal(payload.commitReviewStatus, 'unavailable');
  const artifact = readFileSync(payload.task.resultPath, 'utf8');
  const duplicate = await run(['worker', payload.task.id], x.env); assert.notEqual(duplicate.code, 0); assert.equal(readFileSync(payload.task.resultPath, 'utf8'), artifact);
  const prompt = readFileSync(x.promptFile, 'utf8'); assert.match(prompt, new RegExp(payload.task.id)); assert.match(prompt, /Workflow: review/); assert.match(prompt, /inspect this/);
  const invocation = JSON.parse(readFileSync(x.argvFile, 'utf8')); assert.deepEqual(invocation.argv.slice(0, 6), ['--no-daemon', '--sandbox', 'read-only', '--ask-for-approval', 'never', 'exec']); assert.ok(invocation.argv.includes('gpt-6-astra'));
});

test('background submit returns promptly and eventually stores one result', async () => {
  const x = setup(); x.env.BRIDGE_FIXTURE_DELAY = '200';
  const submitted = await run(['submit', '--provider', 'claude', '--repo', x.repo, '--workflow', 'bg', '--prompt', 'work', '--background'], x.env);
  assert.equal(submitted.code, 0, submitted.err); const taskId = JSON.parse(submitted.out).task.id;
  for (let i = 0; i < 30; i++) { const status = await run(['status', taskId], x.env); if (JSON.parse(status.out).status === 'succeeded') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  const result = await run(['result', taskId], x.env); assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).result, 'fixture answer');
});

test('follow-up resumes only the managed provider session with captured native ID', async () => {
  const x = setup();
  const first = await run(['submit', '--provider', 'claude', '--repo', x.repo, '--workflow', 'flow', '--prompt', 'first'], x.env);
  const task = JSON.parse(first.out).task; const follow = await run(['follow-up', task.id, '--prompt', 'second'], x.env);
  assert.equal(follow.code, 0, follow.err); const followTask = JSON.parse(follow.out).task; assert.equal(followTask.status, 'succeeded');
  const invocation = JSON.parse(readFileSync(x.argvFile, 'utf8')); assert.ok(invocation.argv.includes('--resume')); assert.ok(invocation.argv.includes('fixture-session'));
});

test('strict parsing rejects unknown/conflicting/missing args before provider launch', async () => {
  const x = setup();
  const unknown = await run(['submit', '--bogus', 'x'], x.env); assert.notEqual(unknown.code, 0); assert.match(unknown.err, /unknown option/i);
  const conflicting = await run(['submit', '--provider', 'codex', '--repo', x.repo, '--workflow', 'w', '--prompt', 'x', '--prompt-file', x.promptFile], x.env); assert.notEqual(conflicting.code, 0); assert.match(conflicting.err, /exactly one/);
  const listed = await run(['list'], x.env); assert.equal(listed.code, 0, listed.err); assert.deepEqual(JSON.parse(listed.out), []);
  const mixed = await run(['list', '--active', '--status', 'failed'], x.env); assert.notEqual(mixed.code, 0);
  const session = await run(['session', 'register', '--provider', 'claude', '--repo', x.repo, '--workflow', 'other'], x.env); const requester = JSON.parse(session.out);
  const wrongScope = await run(['submit', '--provider', 'codex', '--repo', x.repo, '--from', requester.id, '--workflow', 'different', '--prompt', 'x'], x.env); assert.notEqual(wrongScope.code, 0);
  const wrongFollowup = await run(['follow-up', 'missing-task', '--provider', 'codex', '--prompt', 'x'], x.env); assert.notEqual(wrongFollowup.code, 0);
  assert.throws(() => readFileSync(x.argvFile));
});

test('provider error, malformed output, and nonzero exit become durable failures', async () => {
  for (const mode of ['provider-error', 'malformed', 'nonzero']) {
    const x = setup(mode); const result = await run(['submit', '--provider', 'codex', '--repo', x.repo, '--workflow', 'w', '--prompt', 'x'], x.env);
    assert.notEqual(result.code, 0, mode); assert.equal(JSON.parse(result.out.trim()).task.status, 'failed', mode);
    if (mode === 'provider-error') assert.equal(JSON.parse(result.out.trim()).task.nativeId, 'fixture-thread');
  }
});

test('timeout and missing provider executable fail without leaving running work', async () => {
  const x = setup(); x.env.BRIDGE_FIXTURE_DELAY = '1500';
  const result = await run(['submit', '--provider', 'codex', '--repo', x.repo, '--workflow', 'w', '--prompt', 'x', '--timeout', '100'], x.env);
  assert.notEqual(result.code, 0); assert.equal(JSON.parse(result.out.trim()).task.status, 'failed');
  const y = setup(); y.env.PATH = '/usr/bin:/bin';
  const missing = await run(['submit', '--provider', 'codex', '--repo', y.repo, '--workflow', 'w', '--prompt', 'x'], y.env);
  assert.notEqual(missing.code, 0); assert.match(JSON.parse(missing.out.trim()).task.error, /ENOENT|spawn/i);
});

test('timeout kills an owned descendant that ignores SIGTERM before returning', async () => {
  const x = setup('descendant'); const pidFile = join(x.root, 'descendant.pid'); x.env.BRIDGE_FIXTURE_DESCENDANT = pidFile;
  const result = await run(['submit', '--provider', 'codex', '--repo', x.repo, '--workflow', 'tree', '--prompt', 'x', '--timeout', '700'], x.env);
  assert.notEqual(result.code, 0); assert.ok(readFileSync(pidFile, 'utf8'));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('inbox is explicitly acknowledged and invalid command exits nonzero', async () => {
  const x = setup(); const reg = await run(['session', 'register', '--provider', 'claude', '--repo', x.repo, '--workflow', 'w'], x.env); const session = JSON.parse(reg.out);
  assert.equal((await run(['not-a-command'], x.env)).code, 2);
  const inbox = await run(['inbox', '--session', session.id], x.env); assert.deepEqual(JSON.parse(inbox.out), []);
  const doctor = await run(['doctor'], x.env); assert.equal(doctor.code, 0, doctor.err + doctor.out);
  const duplicateContextSelector = await run(['context', '--session', session.id, 'other'], x.env); assert.notEqual(duplicateContextSelector.code, 0);
  const duplicateAckSelector = await run(['ack', '--session', session.id, '--message', 'one', 'two'], x.env); assert.notEqual(duplicateAckSelector.code, 0);
});
