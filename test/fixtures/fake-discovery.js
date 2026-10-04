#!/usr/bin/env node
import { basename } from 'node:path';
const provider = basename(process.argv[1]);
if (provider === 'codex' && process.env.DISCOVERY_DESCENDANT) {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  writeFileSync(process.env.DISCOVERY_DESCENDANT, String(child.pid));
  await new Promise(() => {});
}
if (provider === 'codex' && process.env.DISCOVERY_EXPECT_CODEX_HOME && process.env.CODEX_HOME !== process.env.DISCOVERY_EXPECT_CODEX_HOME) { process.stderr.write('incorrect CODEX_HOME'); process.exit(19); }
if (provider === 'claude' && process.env.DISCOVERY_EXPECT_CLAUDE_CONFIG && process.env.CLAUDE_CONFIG_DIR !== process.env.DISCOVERY_EXPECT_CLAUDE_CONFIG) { process.stderr.write('incorrect CLAUDE_CONFIG_DIR'); process.exit(19); }
if (provider === 'claude') {
  if (process.env.DISCOVERY_HANG) { setInterval(() => {}, 1000); }
  if (process.env.DISCOVERY_BAD) { process.stdout.write('{bad'); process.exit(0); }
  process.stdout.write(JSON.stringify([
    { sessionId: 'same-id', cwd: process.env.DISCOVERY_REPO, name: 'Interactive', kind: 'interactive', startedAt: '2026-01-01', status: 'busy' },
    { sessionId: 'bg-id', cwd: process.env.DISCOVERY_REPO, name: 'Background', kind: 'background', startedAt: '2026-01-02', state: 'failed' },
    { sessionId: 'done-id', cwd: process.env.DISCOVERY_OTHER, name: 'Done', state: 'completed' }
  ]));
  process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  const lines = input.split('\n'); input = lines.pop() ?? '';
  for (const line of lines) {
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'fixture' } } });
    if (request.method === 'thread/list') {
      const expectedKinds = ['cli', 'vscode', 'appServer', 'exec', 'unknown', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'];
      if (JSON.stringify(request.params.sourceKinds) !== JSON.stringify(expectedKinds)) { send({ jsonrpc: '2.0', id: request.id, error: { message: 'invalid sourceKinds' } }); continue; }
      const page = request.params.cursor ? 2 : 1;
      const result = page === 1
        ? { data: [{ id: 'same-id', name: 'Codex title', cwd: process.env.DISCOVERY_REPO, updatedAt: '2026-02-01', status: { type: 'notLoaded' } }, { id: 'c2', preview: 'private preview', cwd: process.env.DISCOVERY_OTHER, status: { type: 'idle' } }], nextCursor: 'page2' }
        : { data: [{ id: 'c3', name: null, cwd: process.env.DISCOVERY_REPO, updatedAt: '2026-03-01T00:00:00Z', status: { type: 'notLoaded' } }] };
      const serialized = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
      if (process.env.DISCOVERY_SPLIT) { const mid = Math.floor(serialized.length / 2); process.stdout.write(serialized.slice(0, mid)); setTimeout(() => process.stdout.write(`${serialized.slice(mid)}\n`), 5); }
      else send(JSON.parse(serialized));
    }
  }
}
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
