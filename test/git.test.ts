import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHead } from '../src/git.ts';

function executable(path: string, content: string): void { writeFileSync(path, content); chmodSync(path, 0o755); }

test('falls back to the system Git only when PATH Git cannot launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-git-'));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const repo = join(root, 'repo'); mkdirSync(repo);
    executable(join(bin, 'git'), '#!/missing/bridge-test-interpreter\nexit 1\n');
    const fallback = join(root, 'system-git'); executable(fallback, '#!/bin/sh\nprintf fallback-head\n');
    assert.equal(readHead(repo, { path: bin, platform: 'darwin', systemGitPath: fallback }), 'fallback-head');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a normal non-repository Git exit returns null without trying the fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-git-'));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const repo = join(root, 'repo'); mkdirSync(repo);
    executable(join(bin, 'git'), '#!/bin/sh\nexit 128\n');
    const fallback = join(root, 'system-git'); executable(fallback, '#!/bin/sh\nprintf should-not-run\n');
    assert.equal(readHead(repo, { path: bin, platform: 'darwin', systemGitPath: fallback }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('returns null for an ordinary non-git directory on the host platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-git-'));
  try { assert.equal(readHead(root), null); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
