import { spawn } from 'node:child_process';
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

  async kill(session: string): Promise<void> {
    await run('tmux', ['kill-session', '-t', session]);
  }
}
