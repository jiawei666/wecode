import { execFile as execFileCallback, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import type { SessionLaunchOptions, ThreadSnapshot, ThreadSummary } from './model.js';
import { codexProcessError, spawnCodex } from './process.js';
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
    const threadConfig: Record<string, unknown> = {
      service_tier: fast ? 'fast' : null,
    };
    if (reasoningEffort) threadConfig.model_reasoning_effort = reasoningEffort;
    const params: Record<string, unknown> = {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'wecode',
      serviceTier: fast ? 'fast' : null,
      config: threadConfig,
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

  async forkThread(threadId: string, options: SessionLaunchOptions = {}): Promise<ThreadSummary> {
    await this.connect();
    const model = options.model || this.config.codexModel;
    const reasoningEffort = options.reasoningEffort || this.config.codexReasoningEffort;
    const fast = options.fast ?? this.config.codexFast;
    const threadConfig: Record<string, unknown> = {
      service_tier: fast ? 'fast' : null,
    };
    if (reasoningEffort) threadConfig.model_reasoning_effort = reasoningEffort;
    const params: Record<string, unknown> = {
      threadId,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceTier: fast ? 'fast' : null,
      config: threadConfig,
    };
    if (model) params.model = model;
    const result = await this.request<AppServerThreadResponse>('thread/fork', params);
    if (!result.thread?.id) throw new Error(`Codex thread could not be forked: ${threadId}`);
    const thread = result.thread;
    return {
      ...thread,
      cli: 'codex',
      ...(thread.sessionId ? { sessionId: thread.sessionId } : {}),
      model: thread.model || model,
      reasoningEffort: thread.reasoningEffort || reasoningEffort,
      serviceTier: thread.serviceTier ?? (fast ? 'fast' : null),
    };
  }

  async releaseExternalWriter(threadId: string): Promise<ExternalWriterRelease> {
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

    if (process.platform === 'win32') {
      return {
        attempted: false,
        released: false,
        pids: owners,
        detail: '检测到 Windows 外部 Codex 客户端持有目标锁。为避免 GPT/Codex 客户端崩溃，wecode 不会强制结束该客户端；请先完全退出客户端（包括托盘进程）后重试',
      };
    }

    // Keep every exact owner in the polling set. The process may exit between
    // discovery and the signal, in which case taskkill/process.kill can report
    // an error even though the lock is already released.
    const signaled = [...owners];
    for (const pid of owners) {
      await requestExternalWriterStop(pid);
    }

    if (await waitForLockRelease(lockPath, signaled, 2_000, this.process?.pid)) {
      return { attempted: true, released: true, pids: signaled };
    }

    for (const pid of signaled) {
      await forceStopExternalWriter(pid);
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
      const child = this.process;
      try {
        await this.waitForEndpoint(child);
      } catch (error) {
        if (this.process === child) this.process = null;
        if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
        throw error;
      }
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
    const child = spawnCodex(this.config.codexCommand, args, {
      cwd: this.config.homeDir,
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let startupStderr = '';
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim();
      startupStderr = `${startupStderr}${String(chunk)}`.slice(-8_000);
      if (message) process.stderr.write(`[codex-app-server] ${message}\n`);
    });
    this.process = child;
    try {
      await this.waitForEndpoint(child, () => startupStderr);
    } catch (error) {
      if (this.process === child) this.process = null;
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
      throw error;
    }
  }

  private async waitForEndpoint(child: ChildProcess, getStderr: () => string = () => ''): Promise<void> {
    const deadline = Date.now() + 15_000;
    let startError: unknown;
    const onError = (error: Error) => {
      startError = error;
    };
    child.once('error', onError);
    try {
      while (Date.now() < deadline) {
        if (startError) throw codexProcessError(this.config.codexCommand, startError, getStderr());
        if (child.exitCode !== null) {
          throw codexProcessError(this.config.codexCommand, { code: child.exitCode }, getStderr());
        }
        if (await endpointReady(this.config.codexEndpoint)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (startError) throw codexProcessError(this.config.codexCommand, startError, getStderr());
      throw new Error(`codex app-server endpoint was not ready: ${this.config.codexEndpoint}`);
    } finally {
      child.removeListener('error', onError);
    }
  }
}

async function externalWriterPids(lockPath: string, managedPid?: number): Promise<number[]> {
  let output = '';
  try {
    const result = process.platform === 'win32'
      ? await execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShell(WINDOWS_LOCK_OWNER_SCRIPT),
      ], {
        timeout: 8_000,
        maxBuffer: 32_000,
        windowsHide: true,
        env: { ...process.env, WECODE_LOCK_PATH: lockPath },
      })
      : await execFile('lsof', ['-t', lockPath], { timeout: 3_000, maxBuffer: 32_000 });
    output = result.stdout;
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const pid = Number(line.trim().split(/\s+/u, 1)[0]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === managedPid) continue;
    const command = await processCommand(pid);
    const normalized = command.toLowerCase();
    // App Server processes can themselves own a thread writer (notably the
    // Windows Desktop client), so only the exact managed PID is excluded.
    if (!normalized.includes('codex')) continue;
    pids.push(pid);
  }
  return [...new Set(pids)];
}

async function processCommand(pid: number): Promise<string> {
  try {
    const result = process.platform === 'win32'
      ? await execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ], { timeout: 3_000, maxBuffer: 32_000, windowsHide: true })
      : await execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 2_000, maxBuffer: 32_000 });
    return result.stdout.trim();
  } catch {
    return '';
  }
}

async function requestExternalWriterStop(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGINT');
  } catch {
    // The process may have exited between discovery and signaling.
  }
}

async function forceStopExternalWriter(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // The process may have exited while the graceful signal was pending.
  }
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const WINDOWS_LOCK_OWNER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WeCodeRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  public struct RmUniqueProcess {
    public int ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RmProcessInfo {
    public RmUniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TerminalSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint handle, int flags, StringBuilder sessionKey);

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(
    uint handle,
    uint fileCount,
    string[] files,
    uint applicationCount,
    RmUniqueProcess[] applications,
    uint serviceCount,
    string[] services);

  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(
    uint handle,
    out uint processInfoNeeded,
    ref uint processInfoCount,
    [In, Out] RmProcessInfo[] processInfo,
    ref uint rebootReasons);

  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint handle);

  public static void PrintOwners(string file) {
    uint handle;
    var key = new StringBuilder(32);
    var result = RmStartSession(out handle, 0, key);
    if (result != 0) throw new Exception("RmStartSession=" + result);
    try {
      result = RmRegisterResources(handle, 1, new[] { file }, 0, null, 0, null);
      if (result != 0) throw new Exception("RmRegisterResources=" + result);

      uint needed = 0;
      uint count = 0;
      uint reasons = 0;
      result = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (result != 0 && result != 234) throw new Exception("RmGetList=" + result);
      if (needed == 0) return;

      count = needed;
      var owners = new RmProcessInfo[count];
      result = RmGetList(handle, out needed, ref count, owners, ref reasons);
      if (result != 0) throw new Exception("RmGetList2=" + result);
      for (int index = 0; index < count; index++) {
        Console.WriteLine(owners[index].Process.ProcessId + "\t" + owners[index].AppName);
      }
    } finally {
      RmEndSession(handle);
    }
  }
}
"@
[WeCodeRestartManager]::PrintOwners($env:WECODE_LOCK_PATH)
`;

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
