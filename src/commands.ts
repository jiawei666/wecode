export type BridgeCommand =
  | { kind: 'control'; text: string }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'exit' }
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
  switch (input.trim()) {
    case '状态':
      return { kind: 'status' };
    case '停止':
      return { kind: 'stop' };
    case '退出':
      return { kind: 'exit' };
    case '帮助':
      return { kind: 'help' };
    default:
      return null;
  }
}

function parseControlInvocation(input: string): BridgeCommand | null {
  const match = CONTROL_INVOCATION.exec(input);
  if (!match) return null;
  return { kind: 'control', text: (match[2] ?? '').trim() };
}

export const SESSION_ROUTING_HINT = `普通消息→当前 Codex；唤醒词（${CONTROL_WAKE_WORDS_TEXT}）+需求→会话管理 Agent。`;

export const NO_SESSION_HINT = `当前没有会话。\n唤醒词（任选一个）：${CONTROL_WAKE_WORDS_TEXT}\n试试说“帅哥，帮我在项目名新建一个会话”。`;

export const FIRST_RUN_GUIDE = `👋 欢迎使用 wecode！

唤醒词（任选一个）：${CONTROL_WAKE_WORDS_TEXT}
唤醒后进入会话管理 Agent。

示例：
帅哥，帮我在“wecode”项目新建一个会话
靓仔，帮我查找“wecode”项目最新的 5 个会话
小哥哥，帮我切换到刚才那个会话

状态｜停止｜退出｜帮助`;

export const STARTUP_HINT = `唤醒词（任选一个）：${CONTROL_WAKE_WORDS_TEXT}；例如“帅哥，帮我查找项目最新的 5 个会话”。状态、停止、退出、帮助可直接使用。`;

export const HELP_TEXT = `主要入口：
唤醒词（任选一个）：${CONTROL_WAKE_WORDS_TEXT}

示例：
“帅哥，帮我在‘wecode’项目新建一个会话”
“靓仔，帮我查找‘wecode’项目最新的 5 个会话”
“小哥哥，帮我切换到刚才那个会话”

唤醒后可查找、新建、切换和管理会话。

状态｜停止｜退出｜帮助
这四个词可直接使用，不需要斜杠。`;
