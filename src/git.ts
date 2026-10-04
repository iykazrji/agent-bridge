import { execFileSync } from 'node:child_process';

export interface ReadHeadOptions {
  /** Injection seams for tests; production callers should use the defaults. */
  path?: string;
  platform?: NodeJS.Platform;
  systemGitPath?: string;
}

function invokeGit(executable: string, repo: string, path?: string): string | null {
  try {
    return execFileSync(executable, ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 2000,
      env: path === undefined ? process.env : { ...process.env, PATH: path },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && (error as { status: number | null }).status !== null) return null;
    throw error;
  }
}

function isLaunchFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const fields = error as { code?: unknown; errno?: unknown; status?: unknown };
  if (fields.status !== null && fields.status !== undefined) return false;
  return fields.code === 'ENOENT' || fields.code === 'EACCES' || fields.code === 'ENOEXEC' || fields.errno === -86;
}

export function readHead(repo: string, options: ReadHeadOptions = {}): string | null {
  try { return invokeGit('git', repo, options.path); }
  catch (error) {
    if (!isLaunchFailure(error) || (options.platform ?? process.platform) !== 'darwin') return null;
    const fallback = options.systemGitPath ?? '/usr/bin/git';
    if (fallback === 'git') return null;
    try { return invokeGit(fallback, repo, options.path); }
    catch { return null; }
  }
}
