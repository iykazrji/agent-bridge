import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.ts';

const day = 86_400_000;
const execFileAsync = promisify(execFile);

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-bridge-store-'));
  let now = Date.UTC(2026, 0, 1);
  const open = () => new Store(home, () => now);
  return { home, open, advance: (ms: number) => { now += ms; }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('concurrent first opens initialize a fresh SQLite home without lock failures', async () => {
  const f = fixture();
  try {
    const script = "import { Store } from './src/store.ts'; const store = new Store(process.env.BRIDGE_TEST_HOME); store.close();";
    for (let round = 0; round < 3; round++) {
      const home = join(f.home, `fresh-${round}`);
      const opens = Array.from({ length: 8 }, () => execFileAsync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, BRIDGE_TEST_HOME: home } }));
      await Promise.all(opens);
    }
  } finally { f.cleanup(); }
});

test('durable completion and inbox delivery survive reopen and reconciliation across days', () => {
  const f = fixture();
  try {
    let store = f.open();
    const requester = store.registerSession({ provider: 'codex', repo: process.cwd(), workflow: 'review', role: 'requester' });
    const task = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'review', requesterSessionId: requester.id, prompt: 'Review this change' });
    const claim = store.claimTask(task.id);
    assert.ok(claim);
    store.finishTask(task.id, claim.token, { status: 'succeeded', result: 'No findings', nativeId: 'native-123' });
    assert.equal(store.inbox(requester.id).length, 1);
    store.close();

    f.advance(day);
    store = f.open();
    store.reconcile();
    assert.equal(store.inbox(requester.id).length, 1);
    assert.equal(store.getTask(task.id)?.result, 'No findings');
    store.close();

    f.advance(6 * day);
    store = f.open();
    assert.equal(store.ackMessage(requester.id, store.inbox(requester.id)[0]!.id), true);
    store.close();

    f.advance(33 * day);
    store = f.open();
    store.reconcile();
    assert.equal(store.inbox(requester.id).length, 0);
    assert.equal(store.getTask(task.id)?.status, 'succeeded');
    store.close();
  } finally { f.cleanup(); }
});

test('claims serialize across Store connections and expired leases interrupt exactly once', () => {
  const f = fixture();
  try {
    const a = f.open();
    const requester = a.registerSession({ provider: 'codex', repo: process.cwd(), workflow: 'serial' });
    const task = a.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'serial', requesterSessionId: requester.id, prompt: 'Work' });
    const b = f.open();
    const claim = a.claimTask(task.id);
    assert.ok(claim);
    assert.equal(b.claimTask(task.id), null);
    f.advance(31_000);
    assert.equal(b.reconcile(), 1);
    assert.equal(a.getTask(task.id)?.status, 'interrupted');
    assert.throws(() => a.finishTask(task.id, claim.token, { status: 'succeeded', result: 'late' }));
    assert.equal(b.reconcile(), 0);
    assert.equal(a.inbox(requester.id).length, 1);
    a.close(); b.close();
  } finally { f.cleanup(); }
});

test('lease deadline expires at the exact boundary and blocks heartbeat and completion', () => {
  const f = fixture();
  try {
    const store = f.open();
    const task = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'deadline', prompt: 'work' });
    const claim = store.claimTask(task.id)!;
    f.advance(claim.leaseUntil - Date.UTC(2026, 0, 1));
    assert.throws(() => store.heartbeat(task.id, claim.token));
    assert.equal(store.reconcile(), 1);
    assert.throws(() => store.finishTask(task.id, claim.token, { status: 'succeeded', result: 'late' }));
    store.close();
  } finally { f.cleanup(); }
});

test('heartbeats fence owners, native IDs are managed-only, and ack is recipient-scoped', () => {
  const f = fixture();
  try {
    const store = f.open();
    const requester = store.registerSession({ provider: 'codex', repo: process.cwd(), workflow: 'fence' });
    const manual = store.registerSession({ provider: 'claude', repo: process.cwd(), workflow: 'fence', nativeId: 'manual-native' });
    assert.equal(manual.managed, false);
    const task = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'fence', requesterSessionId: requester.id, prompt: 'Work' });
    const claim = store.claimTask(task.id)!;
    assert.throws(() => store.heartbeat(task.id, 'wrong-owner'));
    store.heartbeat(task.id, claim.token);
    store.finishTask(task.id, claim.token, { status: 'succeeded', result: 'done', nativeId: 'worker-native' });
    const worker = store.getSession(task.workerSessionId)!;
    assert.equal(worker.managed, true);
    assert.equal(worker.nativeId, 'worker-native');
    const message = store.inbox(requester.id)[0]!;
    assert.throws(() => store.ackMessage(manual.id, message.id));
    assert.equal(store.ackMessage(requester.id, message.id), true);
    assert.equal(store.ackMessage(requester.id, message.id), true);
    store.close();
  } finally { f.cleanup(); }
});

test('invalid requester and cross-workflow/repository follow-up fail before adding a task', () => {
  const f = fixture();
  try {
    const store = f.open();
    const requester = store.registerSession({ provider: 'codex', repo: process.cwd(), workflow: 'one' });
    assert.throws(() => store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'two', requesterSessionId: requester.id, prompt: 'bad' }));
    const first = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'one', requesterSessionId: requester.id, prompt: 'first' });
    assert.throws(() => store.createTask({ provider: 'claude', repo: '/tmp', workflow: 'one', requesterSessionId: requester.id, parentTaskId: first.id, prompt: 'bad follow-up' }));
    assert.equal(store.listTasks().length, 1);
    store.close();
  } finally { f.cleanup(); }
});

test('queued tasks expire once; follow-up reuses a completed managed worker and blocks duplicate queued work', () => {
  const f = fixture();
  try {
    const store = f.open();
    const requester = store.registerSession({ provider: 'codex', repo: process.cwd(), workflow: 'follow' });
    const queued = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'follow', requesterSessionId: requester.id, prompt: 'queued' });
    f.advance(30_000);
    assert.equal(store.reconcile(), 1);
    assert.equal(store.reconcile(), 0);
    assert.equal(store.getTask(queued.id)?.status, 'interrupted');

    const original = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'follow', requesterSessionId: requester.id, prompt: 'first' });
    const claim = store.claimTask(original.id)!;
    store.finishTask(original.id, claim.token, { status: 'succeeded', result: 'ok', nativeId: 'provider-thread' });
    const followup = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'follow', requesterSessionId: requester.id, parentTaskId: original.id, prompt: 'continue' });
    assert.equal(followup.workerSessionId, original.workerSessionId);
    assert.throws(() => store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'follow', requesterSessionId: requester.id, parentTaskId: original.id, prompt: 'duplicate' }));
    assert.throws(() => store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'follow', requesterSessionId: requester.id, parentTaskId: followup.id, prompt: 'premature' }));
    store.close();
  } finally { f.cleanup(); }
});

test('an interrupted later follow-up prevents resuming an older completed worker session', () => {
  const f = fixture();
  try {
    const store = f.open();
    const first = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'orphan', prompt: 'first' });
    const firstClaim = store.claimTask(first.id)!;
    store.finishTask(first.id, firstClaim.token, { status: 'succeeded', result: 'ok', nativeId: 'thread' });
    const second = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'orphan', requesterSessionId: first.requesterSessionId, parentTaskId: first.id, prompt: 'second' });
    const secondClaim = store.claimTask(second.id)!;
    f.advance(secondClaim.leaseUntil - Date.UTC(2026, 0, 1)); store.reconcile();
    assert.throws(() => store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'orphan', requesterSessionId: first.requesterSessionId, parentTaskId: first.id, prompt: 'must not resume old thread' }), /interrupted task history/);
    store.close();
  } finally { f.cleanup(); }
});

test('messages, events, and context remain scoped to workflow and canonical repository', () => {
  const f = fixture();
  try {
    const store = f.open();
    const first = store.registerSession({ provider: 'codex', repo: process.cwd(), workflow: 'shared-name' });
    const sibling = store.registerSession({ provider: 'claude', repo: process.cwd(), workflow: 'shared-name' });
    const elsewhere = store.registerSession({ provider: 'claude', repo: '/tmp', workflow: 'shared-name' });
    const task = store.createTask({ provider: 'claude', repo: process.cwd(), workflow: 'shared-name', requesterSessionId: first.id, prompt: 'event' });
    store.addEvent(task.id, 'provider_started', { nativeId: 'thread' });
    assert.equal(JSON.parse(store.events(task.id)[0]!.payload).nativeId, 'thread');
    const message = store.sendMessage(first.id, sibling.id, 'hello');
    assert.equal(message.kind, 'message');
    assert.equal(store.inbox(sibling.id)[0]?.body, 'hello');
    assert.throws(() => store.sendMessage(first.id, elsewhere.id, 'cross repository'));
    const context = store.context(first.id);
    assert.ok(context.relatedSessions.some(session => session.id === first.id));
    assert.ok(context.relatedSessions.some(session => session.id === sibling.id));
    assert.ok(context.relatedSessions.every(session => session.repo === first.repo));
    assert.ok(!context.relatedSessions.some(session => session.id === elsewhere.id));
    assert.equal(context.tasks.length, 1);
    assert.ok(store.getSession(first.id)!.lastSeenAt >= first.lastSeenAt);
    store.close();
  } finally { f.cleanup(); }
});
