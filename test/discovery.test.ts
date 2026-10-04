import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, copyFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { discoverSessions } from '../src/discovery.ts';
import { Store } from '../src/store.ts';

const roots: string[] = [];
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-discovery-')); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['codex', 'claude']) { copyFileSync(join(process.cwd(), 'test/fixtures/fake-discovery.js'), join(bin, name)); chmodSync(join(bin, name), 0o755); }
  symlinkSync(process.execPath, join(bin, 'node'));
  const repo = join(root, 'repo'), other = join(root, 'other'); mkdirSync(repo); mkdirSync(other);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, DISCOVERY_REPO: repo, DISCOVERY_OTHER: other, CODEX_HOME: '/caller/codex', CLAUDE_CONFIG_DIR: '/caller/claude' };
  return { root, bin, repo, other, env, home: join(root, 'bridge-home') };
}
async function cli(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(process.cwd(), 'src/cli.ts'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.setEncoding('utf8').on('data', x => out += x); child.stderr.setEncoding('utf8').on('data', x => err += x);
  return await new Promise<{ code: number; out: string; err: string }>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code: code ?? 1, out, err })); });
}

test('discovers both sources, maps statuses, and joins only matching provider plus native ID', async () => {
  const x = setup(); x.env.DISCOVERY_SPLIT = '1';
  const store = new Store(x.home); const registration = store.registerSession({ provider: 'claude', repo: x.repo, workflow: 'flow', nativeId: 'same-id' });
  const result = await discoverSessions({ home: x.home, env: x.env, registrations: store.listSessions() }); store.close();
  assert.equal(result.sessions.length, 6);
  const claudeRow = result.sessions.find(row => row.provider === 'claude' && row.nativeId === 'same-id')!;
  const codexRow = result.sessions.find(row => row.provider === 'codex' && row.nativeId === 'same-id')!;
  assert.equal(claudeRow.status, 'running'); assert.deepEqual(claudeRow.bridgeSessions, [{ id: registration.id, workflow: 'flow' }]);
  assert.equal(codexRow.status, 'unknown'); assert.deepEqual(codexRow.bridgeSessions, []); assert.equal(codexRow.nativeStatus, 'notLoaded');
  assert.equal(result.sessions.find(row => row.nativeId === 'bg-id')?.status, 'failed');
  assert.equal(result.sessions.find(row => row.nativeId === 'c2')?.status, 'idle');
});

test('filters canonical cwd before limit and active excludes unknown with clear warning', async () => {
  const x = setup();
  const result = await discoverSessions({ home: x.home, env: x.env, repo: x.repo, limit: 1 });
  assert.equal(result.sessions.length, 1); assert.equal(result.truncated, true); assert.ok(result.sessions.every(row => row.cwd === realpathSync(x.repo)));
  assert.equal(result.sessions[0]?.nativeId, 'c3');
  const active = await discoverSessions({ home: x.home, env: x.env, active: true });
  assert.ok(active.sessions.every(row => ['running', 'idle', 'waiting'].includes(row.status)));
  assert.ok(active.warnings.some(warning => /unknown sessions/.test(warning)));
  await assert.rejects(discoverSessions({ home: x.home, env: x.env, limit: 201 }), /1 to 200/);
});

test('explicit homes beat bridge config and config beats caller environment without mutating it', async () => {
  const x = setup(); mkdirSync(x.home); writeFileSync(join(x.home, 'discovery.json'), JSON.stringify({ codexHome: '/configured/codex', claudeConfigDir: '/configured/claude' }));
  x.env.DISCOVERY_EXPECT_CODEX_HOME = '/explicit/codex'; x.env.DISCOVERY_EXPECT_CLAUDE_CONFIG = '/explicit/claude';
  const before = { ...x.env };
  const result = await discoverSessions({ home: x.home, env: x.env, codexHome: '/explicit/codex', claudeConfigDir: '/explicit/claude' });
  assert.equal(result.sources.codex?.location, '/explicit/codex'); assert.equal(result.sources.claude?.location, '/explicit/claude');
  x.env.DISCOVERY_EXPECT_CODEX_HOME = '/configured/codex'; x.env.DISCOVERY_EXPECT_CLAUDE_CONFIG = '/configured/claude';
  const configured = await discoverSessions({ home: x.home, env: x.env });
  assert.equal(configured.sources.codex?.location, '/configured/codex'); assert.equal(configured.sources.claude?.location, '/configured/claude');
  assert.equal(x.env.CODEX_HOME, before.CODEX_HOME); assert.equal(x.env.CLAUDE_CONFIG_DIR, before.CLAUDE_CONFIG_DIR);
});

test('provider errors remain partial and malformed bridge config is explicit', async () => {
  const x = setup(); x.env.DISCOVERY_BAD = '1';
  const result = await discoverSessions({ provider: 'claude', home: x.home, env: x.env });
  assert.equal(result.sessions.length, 0); assert.equal(result.sources.claude?.ok, false); assert.match(result.warnings[0]!, /malformed JSON/);
  mkdirSync(x.home); writeFileSync(join(x.home, 'discovery.json'), '{');
  await assert.rejects(discoverSessions({ home: x.home, env: x.env }), /invalid .*discovery.json/);
});

test('a failing provider retains results from the other source', async () => {
  const x = setup(); x.env.DISCOVERY_BAD = '1';
  const result = await discoverSessions({ home: x.home, env: x.env });
  assert.ok(result.sessions.some(row => row.provider === 'codex'));
  assert.equal(result.sources.codex?.ok, true); assert.equal(result.sources.claude?.ok, false);
});

test('deadline kills the owned process group including a SIGTERM-ignoring descendant', async () => {
  const x = setup(); const pidFile = join(x.root, 'descendant.pid'); x.env.DISCOVERY_DESCENDANT = pidFile;
  const result = await discoverSessions({ provider: 'codex', home: x.home, env: x.env, timeoutMs: 300 });
  assert.equal(result.sources.codex?.ok, false); assert.match(result.sources.codex?.error ?? '', /timed out/);
  const pid = Number((await import('node:fs')).readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { alive = false; break; } throw error; }
  }
  assert.equal(alive, false, `descendant ${pid} remained alive`);
});

test('CLI discovery is read-only and session start shares submit behavior and native ID capture', async () => {
  const x = setup(); const env = { ...x.env, AGENT_BRIDGE_HOME: x.home };
  const registered = await cli(['session', 'register', '--provider', 'claude', '--repo', x.repo, '--workflow', 'known', '--native-id', 'same-id'], env);
  assert.equal(registered.code, 0, registered.err);
  const beforeStore = new Store(x.home); const before = beforeStore.listSessions().length; beforeStore.close();
  const discovery = await cli(['session', 'discover', '--provider', 'claude'], env);
  const afterStore = new Store(x.home); const after = afterStore.listSessions().length; afterStore.close();
  assert.equal(discovery.code, 0, discovery.err); assert.equal(after, before);
  copyFileSync(join(process.cwd(), 'test/fixtures/fake-provider.js'), join(x.bin, 'codex')); chmodSync(join(x.bin, 'codex'), 0o755);
  const started = await cli(['session', 'start', '--provider', 'codex', '--repo', x.repo, '--workflow', 'new', '--prompt', 'inspect'], { ...env, BRIDGE_FIXTURE_ARGV: join(x.root, 'argv.json') });
  assert.equal(started.code, 0, started.err); const payload = JSON.parse(started.out);
  assert.equal(payload.task.status, 'succeeded'); assert.equal(payload.task.nativeId, 'fixture-thread');
});

test('CLI rejects unknown and extra discovery arguments, invalid provider and bad start arguments', async () => {
  const x = setup(); const env = { ...x.env, AGENT_BRIDGE_HOME: x.home };
  assert.notEqual((await cli(['session', 'discover', '--wat'], env)).code, 0);
  assert.notEqual((await cli(['session', 'discover', 'extra'], env)).code, 0);
  assert.notEqual((await cli(['session', 'discover', '--provider', 'other'], env)).code, 0);
  assert.notEqual((await cli(['session', 'start', '--bad'], env)).code, 0);
  const failed = await cli(['session', 'discover', '--provider', 'claude'], { ...env, DISCOVERY_BAD: '1' });
  assert.equal(failed.code, 1); assert.equal(JSON.parse(failed.out).sources.claude.ok, false);
});
