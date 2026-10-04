#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawn } from 'node:child_process';

const provider = basename(process.argv[1]);
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write(`fake-${provider} 1.0.0\n`); process.exit(0); }
if (process.env.BRIDGE_FIXTURE_ARGV) writeFileSync(process.env.BRIDGE_FIXTURE_ARGV, JSON.stringify({ provider, argv }));
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.BRIDGE_FIXTURE_PROMPT) writeFileSync(process.env.BRIDGE_FIXTURE_PROMPT, prompt);
if (process.env.BRIDGE_FIXTURE_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.BRIDGE_FIXTURE_DELAY)));
const mode = process.env.BRIDGE_FIXTURE_MODE ?? 'success';
if (mode === 'descendant') {
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  if (process.env.BRIDGE_FIXTURE_DESCENDANT) writeFileSync(process.env.BRIDGE_FIXTURE_DESCENDANT, String(descendant.pid));
  setInterval(() => {}, 1000);
}
if (mode === 'stderr') process.stderr.write('fake diagnostic\n');
if (mode === 'nonzero') process.exit(17);
if (mode === 'malformed') { process.stdout.write('{bad json\n'); process.exit(0); }
if (provider === 'codex') {
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: process.env.BRIDGE_FIXTURE_NATIVE ?? 'fixture-thread' })}\n`);
  if (mode === 'provider-error') process.stdout.write(`${JSON.stringify({ type: 'turn.failed', message: 'fixture refused' })}\n`);
  else process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture answer' } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ type: 'system', session_id: process.env.BRIDGE_FIXTURE_NATIVE ?? 'fixture-session' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'result', result: mode === 'provider-error' ? 'refused' : 'fixture answer', is_error: mode === 'provider-error' })}\n`);
}
