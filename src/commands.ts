export type BridgeCommand =
  | { kind: 'control'; text: string }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'exit' };

const CONTROL_WAKE_PREFIXES = ['小', '晓'] as const;
const CONTROL_WAKE_NAMES = ['薇', '微', '威', '唯', '伟', '巍'] as const;
export const CONTROL_WAKE_WORDS = CONTROL_WAKE_PREFIXES.flatMap((prefix) =>
  CONTROL_WAKE_NAMES.map((name) => `${prefix}${name}`),
);
export const CONTROL_WAKE_WORDS_TEXT = '小微（语音输入兼容：小薇、小威、小唯、小伟、小巍、晓微等）';
const CONTROL_WAKE_PATTERN = '(?:小|晓)\\s*(?:薇|微|威|唯|伟|巍)';
const CONTROL_INVOCATION = new RegExp(
  `^(${CONTROL_WAKE_PATTERN})(?:[\\s，,、。！!：:；;～~]*(?:啊|呀|呢|哈)?[\\s，,、。！:；;～~]*)?([\\s\\S]*)$`,
  'u',
);

export function parseBridgeCommand(input: string): BridgeCommand | null {
  const text = input.trim();
  const controlInvocation = parseControlInvocation(text);
  if (controlInvocation) return controlInvocation;
  switch (text) {
    case '状态':
      return { kind: 'status' };
    case '停止':
      return { kind: 'stop' };
    case '退出':
      return { kind: 'exit' };
    default:
      return null;
  }
}

function parseControlInvocation(input: string): BridgeCommand | null {
  const match = CONTROL_INVOCATION.exec(input);
  if (!match) return null;
  return { kind: 'control', text: (match[2] ?? '').trim() };
}

export const SESSION_ACTIVE_HINT = '后续普通消息将发送到当前 Codex 会话。';

export const WELCOME_TEXT = `👋 欢迎使用 wecode

小微是你的会话管理助手。想继续已有会话，或在不同项目中新建会话，都可以先呼唤「小微」。

成功接入会话后，直接发送消息就能和 Codex 对话；之后需要切换或新建会话时，再呼唤「小微」即可。

你可以这样说：
• 「小微」：查看最近 5 个会话，回复序号直接切换
• 「小微，在 wecode 项目新建会话」
• 「小微，查找 Rambo 最近的会话」
• 「小微，进入本机维护模式」

常用命令：状态｜停止｜退出
语音输入说成“小薇”“小威”等也能识别。`;
