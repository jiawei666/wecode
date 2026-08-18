export type BridgeCommand =
  | { kind: 'control'; text: string }
  | { kind: 'new'; cwd?: string; model?: string; reasoningEffort?: string; fast?: boolean }
  | { kind: 'use'; threadId?: string; model?: string; reasoningEffort?: string; fast?: boolean }
  | { kind: 'sessions'; scope: 'recent' | 'here' | 'all' | 'full' }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'cancel' }
  | { kind: 'back' }
  | { kind: 'raw'; text: string }
  | { kind: 'help' };

export function parseBridgeCommand(input: string): BridgeCommand | null {
  const text = input.trim();
  if (!text.startsWith('/')) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { kind: 'help' };
  const name = (match[1] ?? '').toLowerCase();
  const arg = (match[2] ?? '').trim();
  switch (name) {
    case 'ctrl':
    case 'control':
      return { kind: 'control', text: arg };
    case 'new':
      return { kind: 'new', ...parseSessionArgs(arg) };
    case 'use': {
      const parsed = parseSessionArgs(arg);
      const threadId = parsed.cwd;
      delete parsed.cwd;
      return { kind: 'use', ...(threadId ? { threadId: normalizeThreadId(threadId) } : {}), ...parsed };
    }
    case 'sessions':
    case 'session':
    case 'list':
      return { kind: 'sessions', scope: parseSessionScope(arg) };
    case 'stat':
    case 'status':
      return { kind: 'status' };
    case 'stop':
      return { kind: 'stop' };
    case 'cancel':
    case 'q':
      return { kind: 'cancel' };
    case 'back':
      return { kind: 'back' };
    case 'raw':
      return { kind: 'raw', text: arg };
    case 'help':
    case '?':
      return { kind: 'help' };
    default:
      return { kind: 'help' };
  }
}

function parseSessionScope(arg: string): 'recent' | 'here' | 'all' | 'full' {
  if (arg === 'here' || arg === 'all' || arg === 'full') return arg;
  return 'recent';
}

function parseSessionArgs(arg: string): { cwd?: string; model?: string; reasoningEffort?: string; fast?: boolean } {
  if (!arg) return {};
  const tokens = arg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const positionals: string[] = [];
  let model: string | undefined;
  let reasoningEffort: string | undefined;
  let fast: boolean | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--model' || token === '-m') {
      model = tokens[++index];
    } else if (token === '--reasoning' || token === '--effort') {
      reasoningEffort = tokens[++index];
    } else if (token === '--fast') {
      fast = true;
    } else if (token === '--no-fast') {
      fast = false;
    } else {
      positionals.push(unquote(token));
    }
  }
  const cwd = positionals.join(' ').trim();
  return {
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fast === undefined ? {} : { fast }),
  };
}

function unquote(value: string): string {
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1)
    : value;
}

function normalizeThreadId(value: string): string {
  return value.startsWith('codex:') ? value.slice('codex:'.length) : value;
}

export const HELP_TEXT = `微信 Codex 命令：
/ctrl [内容]    进入/继续控制 Agent
/new [目录]     新建会话；可带 --model/-m、--fast、--no-fast
/use [ID]       切换会话；支持会话列表序号或完整 ID
/sessions       最近会话；可用 here/all/full
/stat           查看状态
/stop           中断当前任务
/cancel         停止并退出当前绑定/取消控制流程
/back           返回上一个绑定会话
/raw [内容]     原样发送到当前 tmux TUI
/help           查看帮助`;
