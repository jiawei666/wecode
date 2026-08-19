import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import type { AppConfig } from './config.js';
import type { SessionLaunchOptions } from './model.js';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], timeoutMs = 10_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: null, stdout, stderr: `${stderr}\ncommand timed out` });
    }, timeoutMs);
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => finish({ code, stdout, stderr }));
  });
}

export function tmuxSessionName(threadId: string): string {
  return `codex-${threadId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'session'}`;
}

export interface TmuxStatus {
  exists: boolean;
  attachedClients: number;
}

export interface NativeReleaseResult {
  matched: boolean;
  stopped: boolean;
  pids: number[];
}

export class TmuxManager {
  constructor(private readonly config: AppConfig) {}

  async start(
    threadId: string,
    cwd: string,
    session = tmuxSessionName(threadId),
    options: SessionLaunchOptions = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const args = [
      '--cwd',
      cwd,
      '--thread-id',
      threadId,
      '--endpoint',
      this.config.codexEndpoint,
      '--session',
      session,
      '--detached',
      ...(options.model ? ['--model', options.model] : []),
      ...(options.reasoningEffort ? ['--reasoning', options.reasoningEffort] : []),
      ...(options.fast === true ? ['--fast'] : options.fast === false ? ['--no-fast'] : []),
    ];
    let result = await run(this.config.tmuxCodexCommand, args);
    if (result.code !== 0) result = await run(this.config.tmuxCodexCommand, args);
    if (result.code === 0) return { ok: true };
    return { ok: false, error: (result.stderr || result.stdout || `exit ${result.code}`).trim() };
  }

  async status(session: string): Promise<TmuxStatus> {
    const exists = (await run('tmux', ['has-session', '-t', session])).code === 0;
    if (!exists) return { exists: false, attachedClients: 0 };
    const clients = await run('tmux', ['list-clients', '-t', session, '-F', '#{client_name}']);
    const attachedClients = clients.code === 0 ? clients.stdout.split('\n').filter(Boolean).length : 0;
    return { exists: true, attachedClients };
  }

  async interrupt(session: string): Promise<void> {
    await run('tmux', ['send-keys', '-t', session, 'C-c']);
  }

  async sendRaw(session: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error('raw input is empty');
    const status = await this.status(session);
    if (!status.exists) throw new Error(`tmux session does not exist: ${session}`);
    const literal = await run('tmux', ['send-keys', '-t', session, '-l', '--', text]);
    if (literal.code !== 0) throw new Error(literal.stderr || 'tmux send-keys failed');
    await run('tmux', ['send-keys', '-t', session, 'Enter']);
  }

  async kill(session: string, threadId?: string): Promise<void> {
    const managed = threadId ? await this.status(session) : undefined;
    await run('tmux', ['kill-session', '-t', session]);
    if (!threadId || !managed?.exists) return;
    if (await waitForNativeGone(threadId, 1_500)) return;
    await this.releaseNative(threadId);
  }

  /**
   * Stops only a native Codex TUI whose argv contains the exact target thread.
   * We deliberately do not use a broad pkill: the bridge must never terminate
   * an unrelated Codex or control-agent process.
   */
  async releaseNative(threadId: string): Promise<NativeReleaseResult> {
    const pids = await nativeCodexPids(threadId);
    if (!pids.length) return { matched: false, stopped: false, pids: [] };

    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGINT');
      } catch {
        // The process may have exited between discovery and signalling.
      }
    }
    for (const pid of pids) await waitForExit(pid, 1_500);

    const remaining = pids.filter(isAlive);
    for (const pid of remaining) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // The process may have exited between the checks.
      }
    }
    for (const pid of remaining) await waitForExit(pid, 1_500);
    return { matched: true, stopped: pids.every((pid) => !isAlive(pid)), pids };
  }
}

async function nativeCodexPids(threadId: string): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  const entries = await readdir('/proc').catch(() => [] as string[]);
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    const args = (await readFile(`/proc/${entry}/cmdline`).catch(() => Buffer.from('')))
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const executable = args[0]?.split('/').at(-1) ?? '';
    const isCodexProcess = ['codex', 'codex.exe'].includes(executable)
      || args.some((arg) => /(?:^|[/\\])codex(?:\.js|\.mjs)$/.test(arg));
    if (!isCodexProcess) continue;
    if (!args.includes('resume') || args.includes('exec') || !args.includes(threadId)) continue;
    pids.push(pid);
  }
  return pids;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as { code?: string }).code !== 'ESRCH';
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForNativeGone(threadId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await nativeCodexPids(threadId)).length) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await nativeCodexPids(threadId)).length === 0;
}
