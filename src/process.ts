import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export function spawnCodex(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (process.platform !== 'win32') return spawn(command, args, options);

  const comSpec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const commandLine = buildWindowsCommandLine(command, args);
  return spawn(comSpec, ['/d', '/s', '/c', commandLine], {
    ...options,
    windowsVerbatimArguments: true,
    windowsHide: true,
  });
}

export function buildWindowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsCommandPart).join(' ');
}

export function codexProcessError(command: string, error: unknown, stderr = ''): Error {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  const detail = stderr.trim();
  if (
    code === 'ENOENT'
    || code === '9009'
    || /not recognized as an internal or external command/i.test(detail)
    || /不是内部或外部命令/i.test(detail)
    // cmd.exe may emit the localized message in the system code page while
    // Node decodes stderr as UTF-8, leaving replacement characters behind.
    || (process.platform === 'win32' && detail.includes('\uFFFD'))
  ) {
    return new Error(`找不到 Codex CLI（${command}）。请先确认 Codex CLI 已安装，并让 codex/codex.cmd 在 PATH 中；Windows 也可以在 ~/.wecode/config.json 中填写 codexCommand 的绝对路径。`);
  }
  if (detail) return new Error(`Codex CLI 启动失败（${command}）：${detail.slice(-2000)}`);
  return new Error(`Codex CLI 启动失败（${command}，${code || '未知错误'}）`);
}

function quoteWindowsCommandPart(value: string): string {
  if (!/[\s&|<>^]/u.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}
