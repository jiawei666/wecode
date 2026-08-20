export type BridgeCommand =
  | { kind: 'control'; text: string }
  | { kind: 'menu' }
  | { kind: 'new'; cwd?: string; model?: string; reasoningEffort?: string; fast?: boolean }
  | { kind: 'use'; threadId?: string; model?: string; reasoningEffort?: string; fast?: boolean }
  | { kind: 'sessions'; scope: 'recent' | 'here' | 'all' | 'full' }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'cancel' }
  | { kind: 'back' }
  | { kind: 'help' };

export function parseBridgeCommand(input: string): BridgeCommand | null {
  const text = input.trim();
  const controlInvocation = parseControlInvocation(text);
  if (controlInvocation) return controlInvocation;
  if (!text.startsWith('/')) return parsePlainCommand(text);
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { kind: 'help' };
  const name = (match[1] ?? '').toLowerCase();
  const arg = (match[2] ?? '').trim();
  switch (name) {
    case 'ctrl':
    case 'control':
    case '控制':
    case '控制a':
      return { kind: 'control', text: arg };
    case 'menu':
    case '菜单':
    case '操作':
    case '控制台':
      return arg ? parsePlainCommand(arg, true) ?? { kind: 'help' } : { kind: 'menu' };
    case 'new':
    case '新建':
    case '新建会话':
    case '新会话':
      return { kind: 'new', ...parseSessionArgs(arg) };
    case 'use': {
      const parsed = parseSessionArgs(arg);
      const threadId = parsed.cwd;
      delete parsed.cwd;
      return { kind: 'use', ...(threadId ? { threadId: normalizeThreadId(threadId) } : {}), ...parsed };
    }
    case '切换':
    case '切换会话': {
      const parsed = parseSessionArgs(arg);
      const threadId = parsed.cwd;
      delete parsed.cwd;
      return { kind: 'use', ...(threadId ? { threadId: normalizeThreadId(threadId) } : {}), ...parsed };
    }
    case 'sessions':
    case 'session':
    case 'list':
    case '会话':
    case '会话列表':
    case '列表':
    case '列出会话':
      return { kind: 'sessions', scope: parseSessionScope(arg) };
    case 'stat':
    case 'status':
    case '状态':
    case '查看状态':
      return { kind: 'status' };
    case 'stop':
    case '停止':
    case '中断':
      return { kind: 'stop' };
    case 'cancel':
    case 'q':
    case '取消':
    case '退出':
    case '解除绑定':
      return { kind: 'cancel' };
    case 'back':
    case '返回':
    case '上一个':
      return { kind: 'back' };
    case 'help':
    case '?':
    case '帮助':
    case '说明':
      return { kind: 'help' };
    default:
      return { kind: 'help' };
  }
}

function parsePlainCommand(input: string, explicit = false): BridgeCommand | null {
  const text = input.trim();
  if (!text) return null;

  const operation = /^(?:操作|控制台)(?:\s*[：:]\s*|\s+)([\s\S]*)$/u.exec(text);
  if (operation) return parsePlainCommand(operation[1] ?? '', true) ?? { kind: 'help' };

  switch (text) {
    case '菜单':
    case '操作':
    case '控制台':
      return { kind: 'menu' };
    case '控制':
    case '控制A':
      return { kind: 'control', text: '' };
    case '帮助':
      return { kind: 'help' };
    case '状态':
      return { kind: 'status' };
    case '会话':
      return { kind: 'sessions', scope: 'recent' };
    case '返回':
      return { kind: 'back' };
    case '停止':
      return { kind: 'stop' };
    case '取消':
      return { kind: 'cancel' };
    case '新建':
      return { kind: 'new' };
  }

  const control = /^(?:控制A?|控制代理)(?:\s*[：:]\s*|\s+)([\s\S]*)$/u.exec(text);
  if (control) return { kind: 'control', text: (control[1] ?? '').trim() };

  const newMatch = /^(?:新建)(?:\s+|[：:])([\s\S]+)$/u.exec(text);
  if (newMatch) {
    const arg = (newMatch[1] ?? '').trim();
    if (explicit || isPathLike(arg) || isSessionOption(arg)) return { kind: 'new', ...parseSessionArgs(arg) };
    return null;
  }

  const useMatch = /^(?:切换)(?:\s+|[：:])([\s\S]+)$/u.exec(text);
  if (useMatch) {
    const arg = (useMatch[1] ?? '').trim();
    if (!explicit && !isSelectionLike(arg) && !isThreadIdLike(arg)) return null;
    const parsed = parseSessionArgs(arg);
    const threadId = parsed.cwd;
    delete parsed.cwd;
    return { kind: 'use', ...(threadId ? { threadId: normalizeThreadId(threadId) } : {}), ...parsed };
  }

  return null;
}

function parseControlInvocation(input: string): BridgeCommand | null {
  const match = /^(小哥哥|帅哥|靓仔|哥哥|大哥|老哥)(?:[\s，,、。！!：:；;]*)?([\s\S]*)$/u.exec(input);
  if (!match) return null;
  return { kind: 'control', text: (match[2] ?? '').trim() };
}

function parseSessionScope(arg: string): 'recent' | 'here' | 'all' | 'full' {
  const value = arg.trim().toLowerCase();
  if (['here', '当前', '本项目', '当前项目'].includes(value)) return 'here';
  if (['all', '全部', '所有'].includes(value)) return 'all';
  if (['full', '完整', '详细'].includes(value)) return 'full';
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

function isPathLike(value: string): boolean {
  return /^(?:[~/]|\.\.?[\\/]|[A-Za-z]:[\\/]|\\\\)/u.test(value);
}

function isSessionOption(value: string): boolean {
  return /^(?:--model\s+\S+|-m\s+\S+|--reasoning\s+\S+|--effort\s+\S+|--fast|--no-fast)(?:\s|$)/u.test(value);
}

function isSelectionLike(value: string): boolean {
  return /^(?:第\s*)?\d+(?:\s*个)?$/u.test(value.replace(/[\s\u3000]/g, ''))
    || /^(?:第\s*)?[一二三四五六七八九十](?:\s*个)?$/u.test(value.replace(/[\s\u3000]/g, ''));
}

function isThreadIdLike(value: string): boolean {
  return /^(?:codex:)?[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/u.test(value);
}

export const SESSION_ROUTING_HINT = '普通消息 → 当前 Codex；执行中可继续发消息；复杂会话需求用“控制：……”；斜杠命令保留作故障兜底。';

export const MENU_TEXT = `🧭 会话操作

1. 新建会话
2. 切换最近会话
3. 查看全部会话
4. 查看状态
5. 返回上一个
6. 停止任务
7. 取消/解除绑定

回复序号即可；例如回复 2 查看并选择会话。
复杂操作请发送“控制：帮我切换到 web 项目”。`;

export const FIRST_RUN_GUIDE = `👋 欢迎使用 wecode！

常用操作很简单：
• 有当前会话时，直接发消息：发送给当前 Codex
• 执行中继续发消息：会即时追加，必要时自动排队
• 发送“菜单”：查看新建、切换、状态、停止等操作
• 复杂会话操作：发送“控制：……”

首次还没有会话？发送“新建”，或发送“新建 /项目目录”。
需要故障兜底时，发送 /help。`;

export const STARTUP_HINT = '首次使用：发送“菜单”查看操作；普通消息发给当前 Codex；复杂会话操作使用“控制：……”；斜杠命令可作故障兜底。';

export const HELP_TEXT = `微信 Codex 快捷操作：

菜单 / 操作       显示操作菜单
新建 [目录]       新建会话
切换 [序号/ID]    切换会话
会话              列出最近会话
状态              查看当前状态
返回              返回上一个会话
停止              立即中断任务
取消              退出控制或解除绑定
帮助              查看本说明
控制：<需求>       交给 Control Agent 处理复杂会话操作
执行中继续发消息   自动追加到当前任务，必要时按顺序排队

参数较复杂时使用明确格式：操作：新建 <目录>、操作：切换 <序号/ID>。
复杂会话操作发送：控制：帮我找到 web 项目并切换。

故障兜底（本地直达，不经过控制 Agent）：
/new /use /sessions /stat /back /stop /cancel /help
以上命令的中文斜杠别名仍支持；Raw 原始输入功能已移除。`;
