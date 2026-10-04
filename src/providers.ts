import type { Provider } from './types.ts';

export interface ProviderCommandInput {
  provider: Provider;
  prompt: string;
  model?: string | null;
  nativeId?: string | null;
}

export interface ProviderCommand { command: string; args: string[] }
export interface ProviderOutput { nativeId: string | null; result: string }

export function extractProviderNativeId(provider: Provider, raw: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, any>;
      const id = provider === 'codex'
        ? event.type === 'thread.started' ? event.thread_id : undefined
        : event.type === 'system' || event.type === 'result' ? event.session_id : undefined;
      if (typeof id === 'string' && id) return id;
    } catch { return undefined; }
  }
  return undefined;
}

export function buildProviderCommand(input: ProviderCommandInput): ProviderCommand {
  if (input.provider === 'codex') {
    const args = ['--no-daemon', '--sandbox', 'read-only', '--ask-for-approval', 'never', 'exec'];
    if (input.nativeId) args.push('resume');
    args.push('--json');
    if (input.model) args.push('--model', input.model);
    if (input.nativeId) args.push(input.nativeId);
    args.push('-');
    return { command: 'codex', args };
  }
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', 'Read,Grep,Glob'];
  if (input.model) args.push('--model', input.model);
  if (input.nativeId) args.push('--resume', input.nativeId);
  return { command: 'claude', args };
}

export function parseProviderEvents(provider: Provider, raw: string): ProviderOutput {
  const rows = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
  let nativeId: string | null = null;
  let result: string | null = null;
  let complete = false;
  for (const line of rows) {
    let event: Record<string, any>;
    try { event = JSON.parse(line) as Record<string, any>; }
    catch { throw new Error(`malformed ${provider} JSONL event`); }
    if (provider === 'codex') {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') nativeId = event.thread_id;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') result = event.item.text;
      if (event.type === 'turn.completed') complete = true;
      if (event.type === 'turn.failed' || event.type === 'error' || event.error) throw new Error(`provider error: ${String(event.message ?? event.error?.message ?? event.error ?? 'Codex turn failed')}`);
    } else {
      if (event.type === 'system' && typeof event.session_id === 'string') nativeId = event.session_id;
      if (event.type === 'result') {
        if (event.is_error || event.subtype?.includes('error')) throw new Error(`provider error: ${String(event.result ?? event.subtype ?? 'Claude turn failed')}`);
        if (typeof event.session_id === 'string') nativeId = event.session_id;
        if (typeof event.result === 'string') result = event.result;
        complete = true;
      }
      if (event.type === 'error') throw new Error(`provider error: ${String(event.error?.message ?? event.message ?? 'Claude turn failed')}`);
    }
  }
  if (!complete || !result?.trim()) throw new Error(`provider returned no final ${provider} result`);
  return { nativeId, result };
}
