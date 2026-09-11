export type BridgeCommand =
  | { kind: 'control'; text: string }
  | { kind: 'list_sessions'; limit: number }
  | { kind: 'inspect_sessions'; limit: number; activeOnly: boolean }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'fork' }
  | { kind: 'exit' }
  | { kind: 'guide' }
  | { kind: 'help' };

export const CONTROL_WAKE_WORDS = ['帅哥', '靓仔', '小哥哥', '哥哥', '大哥', '老哥'] as const;
export const CONTROL_WAKE_WORDS_TEXT = CONTROL_WAKE_WORDS.join('、');
const CONTROL_INVOCATION = new RegExp(
  `^(${CONTROL_WAKE_WORDS.join('|')})(?:[\\s，,、。！!：:；;]*)?([\\s\\S]*)$`,
  'u',
);

export function parseBridgeCommand(input: string): BridgeCommand | null {
  const text = input.trim();
  const controlInvocation = parseControlInvocation(text);
  if (controlInvocation) return controlInvocation;
  return parsePlainCommand(text);
}

function parsePlainCommand(input: string): BridgeCommand | null {
  const activity = parseActivityCommand(input);
  if (activity) return activity;
  if (/^(?:你好|您好|嗨|哈喽|hello|hi|有哪些功能|你能做什么)[！!，,。\.\s～~]*$/iu.test(input)) {
    return { kind: 'guide' };
  }
  if (input === '会话列表') return { kind: 'list_sessions', limit: 20 };
  const listMatch = /^(?:列出|查看)\s*(?:最近\s*)?(?:的\s*)?(?:(\d+)\s*个\s*)?会话$/u.exec(input);
  if (listMatch) {
    const requestedLimit = Number(listMatch[1] || 20);
    return { kind: 'list_sessions', limit: Math.min(Math.max(requestedLimit, 1), 20) };
  }
  switch (input.trim()) {
    case '状态':
      return { kind: 'status' };
    case '停止':
      return { kind: 'stop' };
    case '分叉':
    case '复制会话':
      return { kind: 'fork' };
    case '退出':
      return { kind: 'exit' };
    case '帮助':
      return { kind: 'help' };
    default:
      return null;
  }
}

function parseActivityCommand(input: string): BridgeCommand | null {
  if (['查看活动', '查看活动会话', '活动会话', '当前任务', '查看当前任务'].includes(input)) {
    return { kind: 'inspect_sessions', limit: 5, activeOnly: true };
  }
  if (['查看最近任务', '最近任务', '查看最近的任务'].includes(input)) {
    return { kind: 'inspect_sessions', limit: 5, activeOnly: false };
  }
  const activeMatch = /^(?:查看|查询|显示|列出)\s*(?:(\d+)\s*个\s*)?(?:活动(?:会话|任务)|当前任务)$/u.exec(input);
  if (activeMatch) {
    return { kind: 'inspect_sessions', limit: Math.min(Math.max(Number(activeMatch[1] || 5), 1), 20), activeOnly: true };
  }
  const recentMatch = /^(?:查看|查询|显示|列出)\s*(?:最近\s*)?(?:(\d+)\s*个\s*)?任务$/u.exec(input);
  if (recentMatch) {
    return { kind: 'inspect_sessions', limit: Math.min(Math.max(Number(recentMatch[1] || 5), 1), 20), activeOnly: false };
  }
  if (/^(?:看看?|查看|查询)\s*(?:最近\s*)?(?:agent|代理|智能体).*(?:处理|做什么|任务|活)/iu.test(input)) {
    return { kind: 'inspect_sessions', limit: 5, activeOnly: true };
  }
  return null;
}

function parseControlInvocation(input: string): BridgeCommand | null {
  const match = CONTROL_INVOCATION.exec(input);
  if (!match) return null;
  return { kind: 'control', text: (match[2] ?? '').trim() };
}

export const SESSION_ACTIVE_HINT = '后续普通消息将发送到当前 Codex 会话。';

export const SESSION_ROUTING_HINT = '普通消息→当前 Codex；输入唤醒词唤醒会话管理 Agent，输入“帮助”查看帮助。';

export const NO_SESSION_HINT = `当前没有会话。\n唤醒词（任选一个）：${CONTROL_WAKE_WORDS_TEXT}\n试试说“帅哥，帮我在项目名新建一个会话”。`;

export const FIRST_RUN_GUIDE = `👋 欢迎使用 wecode！

唤醒词（任选一个）：${CONTROL_WAKE_WORDS_TEXT}
唤醒后进入会话管理 Agent。

示例：
帅哥，帮我在“wecode”项目新建一个会话
靓仔，帮我查找“wecode”项目最新的 5 个会话
小哥哥，帮我切换到刚才那个会话
分叉

查看活动｜查看最近任务｜状态｜停止｜分叉｜退出｜帮助`;

export const STARTUP_HINT = `唤醒词（任选一个）：${CONTROL_WAKE_WORDS_TEXT}；例如“帅哥，帮我查找项目最新的 5 个会话”。查看活动、查看最近任务、状态、停止、分叉、退出、帮助可直接使用。`;

export const WELCOME_TEXT = '👋 欢迎使用 wecode！\n\n💬 直接发送任务即可。';

export const QUICK_GUIDE_TEXT = `我可以帮你：
• 新建、切换、列出、分叉 Codex 会话
• 查看活动任务和最近任务（只读）
• 查看状态、停止任务、退出会话

开始：发送“新建会话”或“切换会话”。
列出会话后，回复“1”“2”或“第 2 个”即可切换。
发送“帮助”查看完整说明。`;

export const HELP_TEXT = `主要入口：
唤醒词（任选一个）：${CONTROL_WAKE_WORDS_TEXT}

示例：
“帅哥，帮我在‘wecode’项目新建一个会话”
“靓仔，帮我查找‘wecode’项目最新的 5 个会话”
“小哥哥，帮我切换到刚才那个会话”
“分叉”或“复制会话”：从当前会话复制历史并新建对话

无需唤醒词即可使用：
“列出最近 5 个会话”：列出历史会话，随后直接回复“1”“2”或“第 2 个”切换
“查看活动”：只读查看当前正在处理的 Codex 任务，不接管会话
“查看最近任务”：只读查看最近 Codex 任务，不绑定或接管会话
“状态”：查看当前绑定、任务运行状态和队列
“停止”：停止当前运行中的任务
“分叉”：复制当前会话并新建对话
“退出”：退出当前绑定或会话管理模式

注意：“查看活动”和“查看最近任务”只是观察，回复其中的序号不会切换；需要进入历史会话时，请先使用“列出最近 5 个会话”。

唤醒后可查找、新建、切换和管理会话。

需要处理本机代码、测试、打包、部署或重启 wecode 时，发送：
“帅哥，进入本机维护模式，帮我检查并重启服务”
维护模式会在当前会话中直接使用终端和文件权限执行，不会自动重建会话管理 Agent。

查看活动｜查看最近任务｜状态｜停止｜分叉｜退出｜帮助
这些词可直接使用，不需要斜杠。`;
