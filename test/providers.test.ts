import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderCommand, parseProviderEvents } from '../src/providers.ts';

test('builds restricted Codex initial and resumed argv with no model fallback', () => {
  const first = buildProviderCommand({ provider: 'codex', model: 'gpt-6-astra', prompt: 'p' });
  assert.deepEqual(first.args, ['--no-daemon', '--sandbox', 'read-only', '--ask-for-approval', 'never', 'exec', '--json', '--model', 'gpt-6-astra', '-']);
  const resume = buildProviderCommand({ provider: 'codex', prompt: 'p', nativeId: 'thread-1' });
  assert.deepEqual(resume.args, ['--no-daemon', '--sandbox', 'read-only', '--ask-for-approval', 'never', 'exec', 'resume', '--json', 'thread-1', '-']);
});

test('builds restricted Claude argv and omits unspecified model', () => {
  const cmd = buildProviderCommand({ provider: 'claude', prompt: 'p', nativeId: 'sess-1' });
  assert.deepEqual(cmd.args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', 'Read,Grep,Glob', '--resume', 'sess-1']);
});

test('parses successful provider events and rejects error/missing-final streams', () => {
  const codex = parseProviderEvents('codex', [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n'));
  assert.equal(codex.nativeId, 't1');
  assert.equal(codex.result, 'answer');
  assert.throws(() => parseProviderEvents('codex', '{bad'), /malformed/);
  assert.throws(() => parseProviderEvents('claude', JSON.stringify({ type: 'result', is_error: true, result: 'denied' })), /provider error/);
});
