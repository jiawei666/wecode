import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import type { SessionLaunchOptions, ThreadSnapshot, ThreadSummary } from './model.js';
import type { ExternalWriterRelease } from './session-adapter.js';

const execFile = promisify(execFileCallback);

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

async function endpointReady(endpoint: string): Promise<boolean> {
  try {
    const url = new URL(endpoint);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/readyz`;
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

class JsonRpcConnection {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationListeners = new Set<(notification: CodexNotification) => void>();

  static connect(endpoint: string): Promise<JsonRpcConnection> {
    return new Promise((resolve, reject) => {
      const connection = new JsonRpcConnection();
      const socket = new WebSocket(endpoint);
      socket.once('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
      socket.once('open', () => {
        connection.attach(socket);
        resolve(connection);
      });
    });
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 90_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex App Server connection is closed'));
    const id = this.nextId++;
    const message = { method, id, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify(message));
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Codex App Server connection is closed');
    socket.send(JSON.stringify({ method, params }));
  }

  close(): void {
    this.socket?.close();
    this.socket?.terminate();
    this.socket = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex App Server connection closed'));
      this.pending.delete(id);
    }
  }

  private attach(socket: WebSocket): void {
    this.socket = socket;
    socket.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString();
      for (const line of text.split('\n')) this.handleLine(line);
    });
    socket.on('close', () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Codex App Server socket closed'));
        this.pending.delete(id);
      }
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || `Codex RPC error ${message.error.code ?? ''}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      if (typeof message.id === 'number') this.handleServerRequest(message).catch(() => undefined);
      else {
        const notification: CodexNotification = { method: message.method, params: message.params ?? {} };
        for (const listener of this.notificationListeners) listener(notification);
      }
    }
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    // Target turns are started with never + dangerFullAccess. These responses are
    // defensive fallbacks for a managed config that still asks for approval.
    if (message.method?.endsWith('/requestApproval')) {
      this.socket?.send(JSON.stringify({ id: message.id, result: { decision: 'accept' } }));
      return;
    }
    this.socket?.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } }));
  }
}

interface AppServerThreadResponse {
  thread?: ThreadSummary & { sessionId?: string };
}

interface AppServerThreadReadResponse {
  thread?: ThreadSnapshot;
}

interface AppServerListResponse {
  data?: ThreadSummary[];
  nextCursor?: string | null;
}

export class CodexAppServer {
  readonly cli = 'codex' as const;
  private process: ChildProcess | null = null;
  private connection: JsonRpcConnection | null = null;
  private notificationListeners = new Set<(notification: CodexNotification) => void>();

  constructor(private readonly config: AppConfig) {}

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async connect(): Promise<void> {
    await this.ensureProcess();
    if (this.connection) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.connection = await JsonRpcConnection.connect(this.config.codexEndpoint);
        this.connection.onNotification((notification) => {
          for (const listener of this.notificationListeners) listener(notification);
        });
        await this.connection.request('initialize', {
          clientInfo: { name: 'wecode', title: 'WeCode Bridge', version: '0.1.0' },
        });
        this.connection.notify('initialized', {});
        return;
      } catch (error) {
        lastError = error;
        this.connection?.close();
        this.connection = null;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async close(): Promise<void> {
    this.connection?.close();
    this.connection = null;
    if (this.process && !this.process.killed) this.process.kill('SIGTERM');
    this.process = null;
    // The App Server owns persisted threads; only our child process is stopped.
  }

  async startThread(cwd: string, options: SessionLaunchOptions = {}): Promise<ThreadSummary> {
    await this.connect();
    const model = options.model || this.config.codexModel;
    const reasoningEffort = options.reasoningEffort || this.config.codexReasoningEffort;
    const fast = options.fast ?? this.config.codexFast;
    const params: Record<string, unknown> = {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'wecode',
      serviceTier: fast ? 'fast' : null,
      config: {
        model_reasoning_effort: reasoningEffort,
        service_tier: fast ? 'fast' : null,
      },
    };
    if (model) params.model = model;
    const result = await this.request<AppServerThreadResponse>('thread/start', params);
    const thread = result.thread;
    if (!thread?.id) throw new Error('Codex App Server did not return a thread id');
    return {
      ...thread,
      cli: 'codex',
      ...(thread.sessionId ? { sessionId: thread.sessionId } : {}),
      model: thread.model || model,
      reasoningEffort: thread.reasoningEffort || reasoningEffort,
      serviceTier: thread.serviceTier ?? (fast ? 'fast' : null),
    };
  }

  async resumeThread(threadId: string): Promise<ThreadSummary> {
    await this.connect();
    const result = await this.request<AppServerThreadResponse>('thread/resume', {
      threadId,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    if (!result.thread?.id) throw new Error(`Codex thread not found: ${threadId}`);
    return { ...result.thread, cli: 'codex' };
  }

  async releaseExternalWriter(threadId: string): Promise<ExternalWriterRelease> {
    if (process.platform === 'win32') {
      return {
        attempted: false,
        released: false,
        pids: [],
        detail: '当前平台无法安全识别持有 thread 锁的外部进程',
      };
    }

    const codexHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
    const lockPath = path.resolve(codexHome, 'thread-writer-locks', `${threadId}.lock`);
    const owners = await externalWriterPids(lockPath, this.process?.pid);
    if (!owners.length) {
      return {
        attempted: false,
        released: false,
        pids: [],
        detail: '未找到可安全释放的外部 Codex 锁持有进程',
      };
    }

    const signaled: number[] = [];
    for (const pid of owners) {
      try {
        process.kill(pid, 'SIGINT');
        signaled.push(pid);
      } catch {
        // The process may have exited between lsof and kill; polling below
        // decides whether the exact lock was actually released.
      }
    }

    if (await waitForLockRelease(lockPath, signaled, 2_000, this.process?.pid)) {
      return { attempted: true, released: true, pids: signaled };
    }

    for (const pid of signaled) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // The process may have exited while the graceful signal was pending.
      }
    }
    const released = await waitForLockRelease(lockPath, signaled, 3_000, this.process?.pid);
    return {
      attempted: true,
      released,
      pids: signaled,
      ...(released ? {} : { detail: '外部 Codex 客户端未在安全退出窗口内释放锁' }),
    };
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    await this.connect();
    const result = await this.request<AppServerThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: true,
    });
    if (!result.thread?.id) throw new Error(`Codex thread not found: ${threadId}`);
    return { ...result.thread, cli: 'codex' };
  }

  async listThreads(cwd?: string): Promise<ThreadSummary[]> {
    await this.connect();
    const threads: ThreadSummary[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, unknown> = {
        limit: 100,
        sortKey: 'recency_at',
        sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'appServer'],
      };
      if (cwd) params.cwd = cwd;
      if (cursor) params.cursor = cursor;
      const result = await this.request<AppServerListResponse>('thread/list', params);
      threads.push(...(result.data ?? []).map((thread) => ({ ...thread, cli: 'codex' as const })));
      cursor = result.nextCursor || undefined;
    } while (cursor && threads.length < 500);
    return threads;
  }

  async startTurn(threadId: string, cwd: string, text: string, options: SessionLaunchOptions = {}): Promise<string> {
    await this.connect();
    const fast = options.fast ?? this.config.codexFast;
    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text }],
      cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      serviceTier: fast ? 'fast' : null,
    };
    if (options.model || this.config.codexModel) params.model = options.model || this.config.codexModel;
    if (options.reasoningEffort || this.config.codexReasoningEffort) params.effort = options.reasoningEffort || this.config.codexReasoningEffort;
    const result = await this.request<{ turn?: { id?: string } }>('turn/start', params);
    const turnId = result.turn?.id;
    if (!turnId) throw new Error('Codex App Server did not return a turn id');
    return turnId;
  }

  async steerTurn(threadId: string, turnId: string, text: string): Promise<string> {
    await this.connect();
    const result = await this.request<{ turnId?: string }>('turn/steer', {
      threadId,
      input: [{ type: 'text', text }],
      expectedTurnId: turnId,
    });
    return result.turnId || turnId;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.connect();
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async unsubscribe(threadId: string): Promise<void> {
    if (!this.connection) return;
    await this.request('thread/unsubscribe', { threadId });
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.connection) throw new Error('Codex App Server is not connected');
    return this.connection.request<T>(method, params);
  }

  private async ensureProcess(): Promise<void> {
    // A separately managed App Server is valid too. This lets the bridge share
    // one endpoint with other Codex clients without owning their UI process.
    if (await endpointReady(this.config.codexEndpoint)) return;

    if (this.process && !this.process.killed && this.process.exitCode === null) {
      await this.waitForEndpoint(this.process);
      return;
    }

    const args = [
      'app-server',
      '--listen',
      this.config.codexEndpoint,
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="danger-full-access"',
      '-c',
      'service_tier=null',
    ];
    const child = spawn(this.config.codexCommand, args, {
      cwd: this.config.homeDir,
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) process.stderr.write(`[codex-app-server] ${message}\n`);
    });
    this.process = child;
    await this.waitForEndpoint(child);
  }

  private async waitForEndpoint(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`codex app-server exited with code ${child.exitCode}`);
      if (await endpointReady(this.config.codexEndpoint)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`codex app-server endpoint was not ready: ${this.config.codexEndpoint}`);
  }
}

async function externalWriterPids(lockPath: string, managedPid?: number): Promise<number[]> {
  let output = '';
  try {
    const result = await execFile('lsof', ['-t', lockPath], { timeout: 3_000, maxBuffer: 32_000 });
    output = result.stdout;
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === managedPid) continue;
    const command = await processCommand(pid);
    const normalized = command.toLowerCase();
    if (!normalized.includes('codex') || normalized.includes('app-server')) continue;
    pids.push(pid);
  }
  return [...new Set(pids)];
}

async function processCommand(pid: number): Promise<string> {
  try {
    const result = await execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 2_000, maxBuffer: 32_000 });
    return result.stdout.trim();
  } catch {
    return '';
  }
}

async function waitForLockRelease(lockPath: string, pids: number[], timeoutMs: number, managedPid?: number): Promise<boolean> {
  if (!pids.length) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = await externalWriterPids(lockPath, managedPid);
    if (!remaining.some((pid) => pids.includes(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const remaining = await externalWriterPids(lockPath, managedPid);
  return !remaining.some((pid) => pids.includes(pid));
}
