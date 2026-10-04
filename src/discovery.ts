import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Provider, Session } from './types.ts';

export type NativeStatus = 'running' | 'idle' | 'waiting' | 'completed' | 'failed' | 'unknown';
export interface DiscoveryRecord {
  provider: Provider; nativeId: string; title: string | null; preview: string | null;
  repo: string | null; cwd: string | null; status: NativeStatus; nativeStatus: string | null;
  statusSource: string; timestamp: number | null; bridgeSessions: Array<{ id: string; workflow: string }>;
}
export interface DiscoveryResult { sessions: DiscoveryRecord[]; sources: Record<string, { ok: boolean; error?: string; limitation?: string; truncated?: boolean; location?: string }>; warnings: string[]; truncated: boolean }
export interface DiscoverOptions { provider?: Provider; repo?: string; active?: boolean; limit?: number; home?: string; codexHome?: string; claudeConfigDir?: string; env?: NodeJS.ProcessEnv; registrations?: Session[]; timeoutMs?: number; pageCap?: number }

const MAX_OUTPUT = 2 * 1024 * 1024;
const STATUS_MAP: Record<string, NativeStatus> = { busy: 'running', running: 'running', idle: 'idle', blocked: 'waiting', waiting: 'waiting', completed: 'completed', stopped: 'completed', exited: 'completed', failed: 'failed', error: 'failed', notloaded: 'unknown' };
function mapStatus(value: unknown): NativeStatus {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as any).type === 'string' ? (value as any).type : null;
  return raw ? STATUS_MAP[raw.toLowerCase()] ?? 'unknown' : 'unknown';
}
function canonical(path: string | null | undefined): string | null {
  if (!path) return null;
  try { return realpathSync(resolve(path)); } catch { return resolve(path); }
}
function bounded(value: unknown, max = 240): string | null { return typeof value === 'string' && value ? value.slice(0, max) : null; }
function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 100_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}
function fail(message: string): Error { return new Error(message); }

function runJson(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let resolveClose!: () => void;
    const closed = new Promise<void>(resolveClosed => { resolveClose = resolveClosed; });
    let stdout = '', stderr = '', settled = false;
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolvePromise(value); };
    child.stdout.setEncoding('utf8').on('data', (part: string) => { stdout += part; if (stdout.length > MAX_OUTPUT) void terminate().finally(() => finish(fail('output exceeded limit'))); });
    child.stderr.setEncoding('utf8').on('data', (part: string) => { if (stderr.length < 8192) stderr += part.slice(0, 8192 - stderr.length); });
    child.once('error', error => finish(error));
    child.once('close', code => {
      resolveClose();
      if (settled) return;
      if (code !== 0) return finish(fail(`exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}`));
      try { finish(undefined, JSON.parse(stdout)); } catch { finish(fail('malformed JSON response')); }
    });
    const terminate = async () => {
      if (!child.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch {}
      await Promise.race([closed, new Promise(resolveDelay => setTimeout(resolveDelay, 100))]);
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {}
      if (child.exitCode === null) await closed;
    };
    const timer = setTimeout(() => { void terminate().finally(() => finish(fail(`timed out after ${timeoutMs}ms`))); }, timeoutMs);
  });
}

async function claude(env: NodeJS.ProcessEnv, timeout: number): Promise<DiscoveryRecord[]> {
  const data = await runJson('claude', ['agents', '--json', '--all'], env, timeout);
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray((data as any).agents) ? (data as any).agents : null);
  if (!rows) throw fail('malformed response: expected agent rows');
  return rows.map((row: any) => {
    if (!row || typeof row.sessionId !== 'string' || !row.sessionId || (row.cwd !== undefined && row.cwd !== null && typeof row.cwd !== 'string') || (row.name !== undefined && row.name !== null && typeof row.name !== 'string') || (row.status !== undefined && typeof row.status !== 'string') || (row.state !== undefined && typeof row.state !== 'string')) throw fail('malformed response: invalid agent row');
    const nativeStatus = typeof row.status === 'string' ? row.status : typeof row.state === 'string' ? row.state : null;
    return { provider: 'claude' as const, nativeId: row.sessionId, title: bounded(row.name), preview: null, repo: canonical(row.cwd), cwd: canonical(row.cwd), status: mapStatus(nativeStatus), nativeStatus, statusSource: 'claude agents metadata', timestamp: timestamp(row.startedAt), bridgeSessions: [] };
  });
}

async function codex(env: NodeJS.ProcessEnv, timeout: number, pageCap: number): Promise<{ rows: DiscoveryRecord[]; truncated: boolean }> {
  const child = spawn('codex', ['--no-daemon', 'app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const closed = new Promise<void>(resolveClosed => child.once('close', () => resolveClosed()));
  let stdout = '', stderr = '', nextId = 1, buffer = '', done = false, cursor: string | null = null, pages = 0, truncated = false;
  const rows: DiscoveryRecord[] = [];
  const pending = new Map<number, { resolve: (message: any) => void; reject: (error: Error) => void }>();
  const cursors = new Set<string>();
  let stopPromise: Promise<void> | null = null;
  const rejectPending = (error: Error) => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  const stop = () => stopPromise ??= (async () => {
    if (!child.pid) return;
    rejectPending(fail('app-server process closed'));
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL'); } catch {}
    await closed;
  })();
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolvePromise, reject) => {
    const id = nextId++; pending.set(id, { resolve: resolvePromise, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => { if (error) { pending.delete(id); reject(error); } });
  });
  const timer = setTimeout(() => { rejectOuter(fail(`timed out after ${timeout}ms`)); }, timeout);
  let rejectOuter: (error: Error) => void = () => {};
  try {
    await new Promise<void>((resolvePromise, reject) => {
      rejectOuter = reject;
      child.stdin.on('error', reject);
      child.stdout.setEncoding('utf8').on('data', async (part: string) => {
        stdout += part; if (stdout.length > MAX_OUTPUT) { stop(); reject(fail('output exceeded limit')); return; }
        buffer += part;
        for (;;) {
          const idx = buffer.indexOf('\n'); if (idx < 0) break;
          const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1); if (!line) continue;
          let msg: any; try { msg = JSON.parse(line); } catch { reject(fail('malformed JSON-RPC line')); return; }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { reject(fail('malformed JSON-RPC message')); return; }
          if (msg.method === 'initialized') continue;
          if (msg.id !== undefined && pending.has(msg.id)) {
            const pendingCall = pending.get(msg.id)!; pending.delete(msg.id);
            if (msg.error) { reject(fail(`JSON-RPC ${msg.error.message ?? 'error'}`)); return; }
            pendingCall.resolve(msg.result);
          }
        }
      });
      child.stderr.setEncoding('utf8').on('data', (part: string) => { if (stderr.length < 8192) stderr += part.slice(0, 8192 - stderr.length); });
      child.once('error', reject); child.once('close', code => { if (!done) { const error = fail(`app-server exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}`); rejectPending(error); reject(error); } });
      (async () => {
        try {
          const init = await rpc('initialize', { clientInfo: { name: 'agent_bridge_discovery', version: '0.1.0' } });
          if (!init || typeof init !== 'object') throw fail('malformed initialize response');
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
          do {
            const result = await rpc('thread/list', { cursor, limit: 50, sortKey: 'updated_at', useStateDbOnly: true, sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] });
            if (!result || !Array.isArray(result.data)) throw fail('malformed thread/list response');
            for (const row of result.data) {
              if (!row || typeof row.id !== 'string' || !row.id || (row.cwd !== undefined && row.cwd !== null && typeof row.cwd !== 'string') || (row.name !== undefined && row.name !== null && typeof row.name !== 'string') || (row.preview !== undefined && row.preview !== null && typeof row.preview !== 'string') || (row.status !== undefined && typeof row.status !== 'string' && (!row.status || typeof row.status !== 'object' || typeof row.status.type !== 'string'))) throw fail('malformed thread/list row');
              const nativeStatus = typeof row.status === 'string' ? row.status : row.status && typeof row.status.type === 'string' ? row.status.type : null;
              rows.push({ provider: 'codex', nativeId: row.id, title: bounded(row.name), preview: bounded(row.preview), repo: canonical(row.cwd), cwd: canonical(row.cwd), status: mapStatus(row.status), nativeStatus, statusSource: 'app-server thread/list (live status unavailable)', timestamp: timestamp(row.updatedAt), bridgeSessions: [] });
            }
            const next = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
            pages++; if (next && cursors.has(next)) throw fail('repeated pagination cursor'); if (next) cursors.add(next);
            cursor = next;
            if (cursor && pages >= pageCap) { truncated = true; break; }
          } while (cursor);
          done = true; await stop(); resolvePromise();
        } catch (error) { await stop(); reject(error); }
      })();
    });
    return { rows, truncated };
  } finally { clearTimeout(timer); await stop(); child.stdin.destroy(); }
}

export async function discoverSessions(options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const env = options.env ?? process.env, selected: Provider[] = options.provider ? [options.provider] : ['codex', 'claude'];
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('--limit must be an integer from 1 to 200');
  const timeout = options.timeoutMs ?? 5000, pageCap = options.pageCap ?? 10;
  let config: { codexHome?: string; claudeConfigDir?: string } = {};
  const configPath = options.home ? join(options.home, 'discovery.json') : undefined;
  if (configPath && existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.codexHome !== undefined && (typeof parsed.codexHome !== 'string' || !parsed.codexHome.trim())) || (parsed.claudeConfigDir !== undefined && (typeof parsed.claudeConfigDir !== 'string' || !parsed.claudeConfigDir.trim()))) throw new Error('expected object with non-empty string codexHome/claudeConfigDir fields');
      config = parsed;
    } catch (error) { throw new Error(`invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const resolveLocation = (explicit: string | undefined, configured: string | undefined, inherited: string | undefined, fallback: string) => {
    if (explicit) return resolve(explicit);
    if (configured) return resolve(configPath ? dirname(configPath) : process.cwd(), configured);
    return inherited ? resolve(inherited) : fallback;
  };
  const codexHome = resolveLocation(options.codexHome, config.codexHome, env.CODEX_HOME, join(homedir(), '.codex'));
  const claudeConfigDir = resolveLocation(options.claudeConfigDir, config.claudeConfigDir, env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude'));
  const sources: DiscoveryResult['sources'] = {}, warnings: string[] = [];
  let codexTruncated = false;
  const all: DiscoveryRecord[] = [];
  await Promise.all(selected.map(async provider => {
    try {
      if (provider === 'claude') { const childEnv = { ...env, CLAUDE_CONFIG_DIR: claudeConfigDir }; all.push(...await claude(childEnv, timeout)); sources.claude = { ok: true, location: claudeConfigDir }; }
      else { const childEnv = { ...env, CODEX_HOME: codexHome }; const result = await codex(childEnv, timeout, pageCap); all.push(...result.rows); codexTruncated = result.truncated; sources.codex = { ok: true, limitation: 'live status unavailable from app-server metadata query', truncated: result.truncated, location: codexHome }; }
    } catch (error) { const message = error instanceof Error ? error.message : String(error); sources[provider] = { ok: false, error: message }; warnings.push(`${provider}: ${message}`); }
  }));
  const byNative = new Map<string, DiscoveryRecord>();
  for (const row of all) {
    const key = `${row.provider}\0${row.nativeId}`;
    const prior = byNative.get(key);
    if (prior) { if ((row.timestamp ?? -Infinity) > (prior.timestamp ?? -Infinity)) byNative.set(key, row); }
    else byNative.set(key, row);
  }
  const repo = options.repo ? canonical(options.repo) : null;
  const registrations = options.registrations ?? [];
  const filtered = [...byNative.values()].filter(row => !repo || row.cwd === repo).map(row => {
    row.bridgeSessions = registrations.filter(session => session.provider === row.provider && session.nativeId === row.nativeId).map(session => ({ id: session.id, workflow: session.workflow }));
    return row;
  }).filter(row => !options.active || ['running', 'idle', 'waiting'].includes(row.status)).sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity) || a.provider.localeCompare(b.provider) || a.nativeId.localeCompare(b.nativeId));
  const truncated = codexTruncated || filtered.length > limit;
  if (selected.includes('codex') && sources.codex?.ok && options.active) warnings.push('Codex active filter excludes unknown sessions; app-server metadata cannot confirm live status.');
  const sessions = filtered.slice(0, limit);
  return { sessions, sources, warnings, truncated };
}
