import { execFile as execFileCallback } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildWindowsCommandLine } from './process.js';

const execFile = promisify(execFileCallback);

export interface CodexRuntimeInfo {
  command: string;
  resolvedCommand: string;
  version: string;
  fingerprint: string;
}

export async function inspectCodexRuntime(command: string): Promise<CodexRuntimeInfo> {
  const resolvedCommand = await resolveCommand(command);
  const version = await readVersion(command);
  const metadata = await stat(resolvedCommand).catch(() => undefined);
  const fingerprint = [
    resolvedCommand,
    version,
    metadata?.size ?? 'unknown-size',
    metadata?.mtimeMs ?? 'unknown-mtime',
  ].join('|');
  return { command, resolvedCommand, version, fingerprint };
}

export async function tryInspectCodexRuntime(command: string): Promise<CodexRuntimeInfo | undefined> {
  try {
    return await inspectCodexRuntime(command);
  } catch {
    return undefined;
  }
}

async function resolveCommand(command: string): Promise<string> {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return await realpath(command).catch(() => path.resolve(command));
  }
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = await execFile(lookup, [command], { timeout: 5_000, maxBuffer: 32_000, windowsHide: true });
  const first = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (!first) throw new Error(`无法定位 Codex CLI：${command}`);
  return await realpath(first).catch(() => first);
}

async function readVersion(command: string): Promise<string> {
  const result = process.platform === 'win32'
    ? await execFile(process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      `"${buildWindowsCommandLine(command, ['--version'])}"`,
    ], { timeout: 5_000, maxBuffer: 32_000, windowsHide: true, windowsVerbatimArguments: true })
    : await execFile(command, ['--version'], { timeout: 5_000, maxBuffer: 32_000, windowsHide: true });
  const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/u).find(Boolean)?.trim();
  if (!version) throw new Error(`Codex CLI 未返回版本：${command}`);
  return version;
}
