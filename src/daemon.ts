import { closeSync, openSync } from 'node:fs';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from './config.js';

const execFile = promisify(execFileCallback);
const STOP_TIMEOUT_MS = 5_000;
const MAX_LOG_BYTES = 64_000;

export interface DaemonPaths {
  pidFile: string;
  logFile: string;
}

export interface DaemonStatus {
  running: boolean;
  owned: boolean;
  pid?: number;
  command?: string;
  stale?: boolean;
}

export interface StartResult {
  started: boolean;
  pid: number;
}

export function daemonPaths(config: AppConfig): DaemonPaths {
  return {
    pidFile: path.join(config.dataDir, 'wecode.pid'),
    logFile: path.join(config.dataDir, 'wecode.log'),
  };
}

export function backgroundArguments(argv: string[] = process.argv): string[] {
  const args = argv.slice(1).filter((arg) => !['login', 'restart', 'run', '--background'].includes(arg));
  return [...args, '--background'];
}

export async function inspectDaemon(config: AppConfig): Promise<DaemonStatus> {
  const paths = daemonPaths(config);
  const record = await readPidRecord(paths.pidFile);
  if (!record) return { running: false, owned: false };

  if (!isProcessAlive(record.pid)) {
    return { running: false, owned: false, pid: record.pid, stale: true };
  }

  const command = await processCommand(record.pid);
  const owned = Boolean(command && isWecodeCommand(command));
  return { running: true, owned, pid: record.pid, ...(command ? { command } : {}) };
}

export async function startDaemon(config: AppConfig): Promise<StartResult> {
  const current = await inspectDaemon(config);
  if (current.running) {
    if (!current.owned) throw new Error(`PID ${current.pid} 正在运行，但无法确认它属于 wecode；已停止启动以避免误杀其他进程。`);
    return { started: false, pid: current.pid as number };
  }
  if (current.pid) await rm(daemonPaths(config).pidFile, { force: true });

  const paths = daemonPaths(config);
  await mkdir(config.dataDir, { recursive: true });
  const logFd = openSync(paths.logFile, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [...process.execArgv, ...backgroundArguments()], {
      cwd: process.cwd(),
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve(child.pid as number));
    });
    child.unref();
    return { started: true, pid };
  } finally {
    closeSync(logFd);
  }
}

export async function acquireDaemon(config: AppConfig): Promise<void> {
  const paths = daemonPaths(config);
  await mkdir(config.dataDir, { recursive: true });
  const record = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
  try {
    await writeFile(paths.pidFile, record, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code !== 'EEXIST') throw error;
  }

  const current = await inspectDaemon(config);
  if (current.running) {
    if (!current.owned) throw new Error(`PID ${current.pid} 正在运行，但无法确认它属于 wecode。`);
    throw new Error(`wecode 已在后台运行（PID ${current.pid}）。`);
  }
  await rm(paths.pidFile, { force: true });
  await writeFile(paths.pidFile, record, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

export async function releaseDaemon(config: AppConfig): Promise<void> {
  const paths = daemonPaths(config);
  const record = await readPidRecord(paths.pidFile);
  if (record?.pid === process.pid) await rm(paths.pidFile, { force: true });
}

export async function stopDaemon(config: AppConfig): Promise<boolean> {
  const current = await inspectDaemon(config);
  if (!current.pid) return false;
  if (!current.running) {
    await rm(daemonPaths(config).pidFile, { force: true });
    return false;
  }
  if (!current.owned) throw new Error(`PID ${current.pid} 正在运行，但无法确认它属于 wecode；未发送停止信号。`);

  process.kill(current.pid, 'SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(current.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(current.pid)) {
    try {
      process.kill(current.pid, 'SIGKILL');
    } catch {
      // The process may have exited between the check and the signal.
    }
  }
  if (isProcessAlive(current.pid)) throw new Error(`wecode（PID ${current.pid}）未能在 ${STOP_TIMEOUT_MS / 1000} 秒内退出。`);
  await rm(daemonPaths(config).pidFile, { force: true });
  return true;
}

export async function readDaemonLogs(config: AppConfig): Promise<string> {
  try {
    const text = await readFile(daemonPaths(config).logFile, 'utf8');
    return text.length <= MAX_LOG_BYTES ? text : `…（仅显示最后 ${MAX_LOG_BYTES} 字节）…\n${text.slice(-MAX_LOG_BYTES)}`;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code === 'ENOENT') return '';
    throw error;
  }
}

async function readPidRecord(file: string): Promise<{ pid: number } | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown };
    return typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 ? { pid: value.pid } : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && String((error as { code?: unknown }).code) === 'EPERM';
  }
}

async function processCommand(pid: number): Promise<string> {
  try {
    if (process.platform === 'win32') {
      const result = await execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
      ], { timeout: 3_000, maxBuffer: 32_000 });
      return result.stdout.trim();
    }
    const result = await execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3_000, maxBuffer: 32_000 });
    return result.stdout.trim();
  } catch {
    return '';
  }
}

function isWecodeCommand(command: string): boolean {
  return /wecode|dist[\\/]src[\\/]index\.js/i.test(command);
}
