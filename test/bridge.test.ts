import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { BridgeApp } from '../src/bridge.js';
import { ControlAgent } from '../src/control.js';
import type { InboundMessage } from '../src/ilink.js';
import type { SessionBinding } from '../src/model.js';
import { SessionManager, SessionOccupiedError } from '../src/sessions.js';
import { StateStore } from '../src/state.js';

function message(text: string, id: string): InboundMessage {
  return {
    from: 'user',
    messageId: id,
    timeMs: Date.now(),
    text,
    attachments: [],
    contextToken: 'context',
    raw: {},
  };
}

test('sends the post-login welcome once and merges it with automatic management', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-welcome-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  store.update((state) => { state.welcomePending = true; });
  const sent: string[] = [];
  const fakeControl = {
    run: async () => ({ action: { action: 'reply' as const, text: '会话管理 Agent 已响应。' }, sessionId: 'control-thread' }),
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = { list: async () => [], close: async () => undefined } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('帮我处理一个普通请求', 'welcome-1'));
    assert.match(sent[0] || '', /欢迎使用 wecode/);
    assert.match(sent[0] || '', /小微是你的会话管理助手/);
    assert.match(sent[0] || '', /想继续已有会话，或在不同项目中新建会话/);
    assert.match(sent[0] || '', /成功接入会话后，直接发送消息就能和 Codex 对话/);
    assert.match(sent[0] || '', /查看最近 5 个会话，回复序号直接切换/);
    assert.match(sent[0] || '', /「小微，在 wecode 项目新建会话」/);
    assert.match(sent[0] || '', /「小微，查找 Rambo 最近的会话」/);
    assert.match(sent[0] || '', /再呼唤「小微」即可/);
    assert.match(sent[0] || '', /常用命令：状态｜停止｜退出/);
    assert.match(sent[0] || '', /进入本机维护模式/);
    assert.doesNotMatch(sent[0] || '', /帮助|查看活动|查看最近任务|分叉|列出最近 20 个/);
    assert.match(sent[0] || '', /当前没有会话，已进入会话管理模式/);
    assert.equal(sent.filter((text) => text.includes('欢迎使用 wecode')).length, 1);
    assert.equal(store.get().welcomePending, false);

    await bridge.handle(message('帮助', 'welcome-2'));
    assert.equal(sent.filter((text) => text.includes('欢迎使用 wecode')).length, 1);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not echo raw Agent output when control action parsing fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-control-error-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const leakedSkill = '<skill>\\nname: ai-tester-test\\n内容不应回显\\n</skill>';
  const fakeControl = {
    run: async () => {
      throw new Error('会话管理 Agent 未返回有效 action JSON：' + leakedSkill);
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = { close: async () => undefined } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('为什么刚才报错了', 'control-error-1'));
    const visible = sent.join('\\n');
    assert.match(visible, /返回格式不正确/);
    assert.doesNotMatch(visible, /<skill>|ai-tester-test|内容不应回显/);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not route an unbound skill document into session management', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-skill-input-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  let controlRuns = 0;
  const fakeControl = {
    run: async () => {
      controlRuns += 1;
      return { action: { action: 'reply' as const, text: '不应调用' }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = { close: async () => undefined } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('<skill>\\nname: ai-tester-test\\n</skill>', 'skill-input-1'));
    assert.equal(controlRuns, 0);
    assert.match(sent.at(-1) || '', /技能\/规则文档/);
    assert.equal(store.getControl('user'), undefined);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('automatically enters session management when the current session is stale', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-stale-session-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  store.setBinding('user', {
    threadId: 'stale-thread',
    cwd: directory,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  const sent: string[] = [];
  let controlPrompt = '';
  let released = false;
  const fakeControl = {
    run: async (_userId: string, prompt: string) => {
      controlPrompt = prompt;
      return { action: { action: 'reply' as const, text: '已准备恢复会话。' }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ binding: store.getBinding('user'), running: false }),
    send: async () => { throw new Error('thread not found'); },
    release: async () => { released = true; return true; },
    list: async () => [],
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('继续处理刚才的任务', 'stale-session-1'));
    assert.ok(sent.some((text) => /当前会话已失效，已进入会话管理模式/.test(text)));
    assert.doesNotMatch(sent.join('\n'), /唤醒词|小微|小薇/);
    assert.match(controlPrompt, /继续处理刚才的任务/);
    assert.equal(store.getBinding('user'), undefined);
    assert.equal(store.getControl('user')?.sessionId, 'control-thread');
    assert.equal(released, true);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('interrupts an active Codex turn before entering session management through Xiaowei', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-wake-interrupt-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const binding: SessionBinding = {
    threadId: 'active-thread',
    cwd: directory,
    cli: 'codex',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  store.setBinding('user', binding);
  const sent: string[] = [];
  const calls: string[] = [];
  const fakeControl = {
    run: async () => {
      calls.push('control');
      return { action: { action: 'reply' as const, text: '会话管理 Agent 已接管。' }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ binding, running: true }),
    stop: async () => {
      calls.push('stop');
      return true;
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('小微，帮我切换到另一个会话', 'wake-interrupt-1'));
    assert.deepEqual(calls, ['stop', 'control']);
    assert.match(sent[0] || '', /正在停止任务/);
    assert.match(sent.at(-1) || '', /会话管理 Agent 已接管/);
    assert.equal(store.getControl('user')?.sessionId, 'control-thread');
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('accepts continuous WeChat input and drains it in order after each turn', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-continuous-input-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const turnInputs: string[] = [];
  let running = false;
  let holdResultReply = true;
  let releaseResultReply: (() => void) | undefined;
  let resolveResultReplyStarted: (() => void) | undefined;
  const resultReplyStarted = new Promise<void>((resolve) => { resolveResultReplyStarted = resolve; });
  const binding: SessionBinding = {
    threadId: 'continuous-thread',
    cwd: directory,
    cli: 'codex',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  store.setBinding('user', binding);
  const fakeControl = {
    run: async () => { throw new Error('Session-management Agent should not receive target messages'); },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ binding: store.getBinding('user'), running }),
    steer: async () => ({ accepted: false }),
    send: async (_userId: string, text: string) => {
      turnInputs.push(text);
      running = true;
      return { accepted: true };
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = {
    sendText: async (_to: string, text: string) => {
      sent.push(text);
      if (text === '第一步完成' && holdResultReply) {
        holdResultReply = false;
        resolveResultReplyStarted?.();
        await new Promise<void>((resolve) => { releaseResultReply = resolve; });
      }
      return { ok: true };
    },
  } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('第一步', 'continuous-1'));
    await bridge.handle(message('补充 A', 'continuous-2'));
    running = false;

    const firstCompletion = bridge.onTurn({
      threadId: binding.threadId,
      turnId: 'turn-1',
      text: '第一步完成',
      status: 'completed',
    });
    await resultReplyStarted;
    await bridge.handle(message('补充 B', 'continuous-3'));
    assert.deepEqual(turnInputs, ['第一步']);
    assert.ok(releaseResultReply);
    releaseResultReply();
    await firstCompletion;
    assert.deepEqual(turnInputs, ['第一步', '补充 A']);

    running = false;
    await bridge.onTurn({
      threadId: binding.threadId,
      turnId: 'turn-2',
      text: '补充 A 完成',
      status: 'completed',
    });
    assert.deepEqual(turnInputs, ['第一步', '补充 A', '补充 B']);
    assert.equal(sent.at(-1), '补充 A 完成');
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('steers the active Codex turn before falling back to the queue', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-steer-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const steered: string[] = [];
  const binding: SessionBinding = {
    threadId: 'steer-thread',
    cwd: directory,
    cli: 'codex',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  store.setBinding('user', binding);
  const fakeControl = {
    run: async () => { throw new Error('Session-management Agent should not receive target messages'); },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ binding: store.getBinding('user'), running: true }),
    steer: async (_userId: string, text: string) => {
      steered.push(text);
      return { accepted: true };
    },
    send: async () => { throw new Error('A steerable turn should not start a new turn'); },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('补充：优先修复测试失败', 'steer-1'));
    assert.deepEqual(steered, ['补充：优先修复测试失败']);
    assert.match(sent.at(-1) || '', /已追加，继续处理/);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('forwards WeChat images and file paths to Codex and keeps attachments in the queue', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-media-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const turns: Array<{ text: string; images: string[] }> = [];
  let running = false;
  const binding: SessionBinding = {
    threadId: 'media-thread',
    cwd: directory,
    cli: 'codex',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  store.setBinding('user', binding);
  const fakeControl = {
    run: async () => { throw new Error('Session-management Agent should not receive attachment turns'); },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ binding: store.getBinding('user'), running }),
    steer: async () => ({ accepted: false }),
    send: async (_userId: string, text: string, images: string[] = []) => {
      turns.push({ text, images });
      running = true;
      return { accepted: true };
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('先准备好', 'media-first'));
    const mediaMessage = {
      ...message('请查看这张图并读取这份报告', 'media-second'),
      attachments: [
        { kind: 'image' as const, name: '工位.png', path: path.join(directory, 'image.png') },
        { kind: 'file' as const, name: '报告.pdf', path: path.join(directory, 'report.pdf') },
      ],
    };
    await bridge.handle(mediaMessage);
    assert.match(sent.at(-1) || '', /已排队 1 条/);

    running = false;
    await bridge.onTurn({
      threadId: binding.threadId,
      turnId: 'turn-1',
      text: '第一条已完成',
      status: 'completed',
    });

    assert.equal(turns.length, 2);
    assert.equal(turns[1]?.text.startsWith('请查看这张图并读取这份报告'), true);
    assert.match(turns[1]?.text || '', /报告\.pdf/);
    assert.ok(turns[1]?.text.includes(path.join(directory, 'report.pdf')));
    assert.deepEqual(turns[1]?.images, [path.join(directory, 'image.png')]);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sends spoken Codex progress without a label and then the final response', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-final-response-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const binding: SessionBinding = {
    threadId: 'final-response-thread',
    cwd: directory,
    cli: 'codex',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  store.setBinding('user', binding);
  store.update((state) => {
    state.contextTokens.user = 'context-token';
  });
  const sent: string[] = [];
  const fakeSessions = { status: async () => ({ binding, running: false }), close: async () => undefined } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await bridge.onTurnProgress({
      threadId: binding.threadId,
      turnId: 'turn-1',
      kind: 'reasoning',
      text: 'Preparing to analyze collections code',
    });
    const progressText = '我先查看两张截图，确认问题具体混在了哪里。';
    await bridge.onTurnProgress({
      threadId: binding.threadId,
      turnId: 'turn-1',
      kind: 'preamble',
      text: progressText,
    });
    await bridge.onTurn({
      threadId: binding.threadId,
      turnId: 'turn-1',
      text: '这是最终返回给用户的内容。',
      status: 'completed',
    });

    assert.deepEqual(sent, [progressText, '这是最终返回给用户的内容。']);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses the iLink typing indicator instead of sending an execution receipt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-typing-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const binding: SessionBinding = {
    threadId: 'typing-thread',
    cwd: directory,
    cli: 'codex',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  store.setBinding('user', binding);
  store.update((state) => {
    state.contextTokens.user = 'context-token';
  });
  const sent: string[] = [];
  const typing: Array<{ userId: string; contextToken: string; status: number }> = [];
  const fakeSessions = {
    status: async () => ({ binding, running: false }),
    send: async () => ({ accepted: true }),
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = {
    sendText: async (_to: string, text: string) => {
      sent.push(text);
      return { ok: true };
    },
    sendTyping: async (userId: string, contextToken: string, status: number) => {
      typing.push({ userId, contextToken, status });
      return true;
    },
  } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await bridge.handle(message('执行一个任务', 'typing-1'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(typing, [{ userId: 'user', contextToken: 'context', status: 1 }]);
    assert.deepEqual(sent, []);

    await bridge.onTurn({
      threadId: binding.threadId,
      turnId: 'typing-turn-1',
      text: '任务完成。',
      status: 'completed',
    });

    assert.deepEqual(typing.map((entry) => entry.status), [1, 2]);
    assert.deepEqual(sent, ['任务完成。']);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps a failed final response and retries it after a new context token arrives', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-retry-final-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const binding: SessionBinding = {
    threadId: 'retry-final-thread',
    cwd: directory,
    cli: 'codex',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  store.setBinding('user', binding);
  const sent: string[] = [];
  let acceptingReplies = false;
  const fakeSessions = {
    status: async () => ({ binding, running: false }),
    send: async () => ({ accepted: true }),
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = {
    sendText: async (_to: string, text: string) => {
      if (!acceptingReplies) return { ok: false, errmsg: 'prepare failed' };
      sent.push(text);
      return { ok: true };
    },
  } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await bridge.onTurn({
      threadId: binding.threadId,
      turnId: 'turn-1',
      text: '任务已完成，这是不能丢失的最终结果。',
      status: 'completed',
    });
    assert.deepEqual(sent, []);

    acceptingReplies = true;
    await bridge.handle(message('？', 'retry-final-1'));

    assert.equal(sent[0], '任务已完成，这是不能丢失的最终结果。');
    assert.equal(sent.length, 1);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps a failed final response across a bridge restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-persist-final-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const binding: SessionBinding = {
    threadId: 'persist-final-thread',
    cwd: directory,
    cli: 'codex',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  store.setBinding('user', binding);
  store.update((state) => {
    state.contextTokens.user = 'expired-context';
  });
  const sent: string[] = [];
  const fakeSessions = {
    status: async () => ({ binding, running: false }),
    send: async () => ({ accepted: true }),
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = {
    sendText: async (_to: string, text: string, contextToken: string) => {
      if (contextToken !== 'fresh-context') return { ok: false, errmsg: 'prepare failed', needsFreshContext: true };
      sent.push(text);
      return { ok: true };
    },
  } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const firstBridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await firstBridge.onTurn({
      threadId: binding.threadId,
      turnId: 'turn-persist-final',
      text: '重启后也不能丢失的最终结果。',
      status: 'completed',
    });
    await firstBridge.close();

    const reloadedStore = new StateStore(path.join(directory, 'state.json'));
    await reloadedStore.init();
    const secondBridge = new BridgeApp(config, reloadedStore, fakeIlink, fakeSessions);
    try {
      await secondBridge.handle({
        ...message('？', 'persist-final-1'),
        contextToken: 'fresh-context',
      });
      assert.equal(sent[0], '重启后也不能丢失的最终结果。');
    } finally {
      await secondBridge.close();
    }
  } finally {
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('bare Xiaowei lists the global recent five grouped by project without calling the Agent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-indexed-list-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const used: string[] = [];
  const wecode = path.join(directory, 'wecode');
  const rambo = path.join(directory, 'Rambo');
  const sessions = [
    { id: 'w3', cwd: wecode, preview: '调整账号 Tab', updatedAt: 1_700_000_006, cli: 'codex' as const },
    { id: 'r1', cwd: rambo, preview: '修改设置页', updatedAt: 1_700_000_010, cli: 'codex' as const },
    { id: 'w1', cwd: wecode, preview: '修复登录接口', updatedAt: 1_700_000_009, cli: 'codex' as const },
    { id: 'r2', cwd: rambo, preview: '修复模型选择', updatedAt: 1_700_000_008, cli: 'codex' as const },
    { id: 'w2', cwd: wecode, preview: '调整消息队列', updatedAt: 1_700_000_007, cli: 'codex' as const },
    { id: 'old', cwd: wecode, preview: '不应出现', updatedAt: 1_700_000_001, cli: 'codex' as const },
  ];
  let listCalls = 0;
  let controlRuns = 0;
  const fakeControl = {
    run: async () => {
      controlRuns += 1;
      throw new Error('裸唤醒不应调用会话管理 Agent');
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    list: async () => {
      listCalls += 1;
      return sessions;
    },
    use: async (_userId: string, threadId: string, cwd?: string) => {
      used.push(threadId);
      const binding: SessionBinding = {
        threadId,
        cwd: cwd || directory,
        cli: 'codex',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      store.setBinding('user', binding);
      return { binding };
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('小薇', 'indexed-wake'));
    const output = sent.at(-1) || '';
    assert.equal(controlRuns, 0);
    assert.equal(listCalls, 1);
    assert.match(output, /Rambo\n1\. 修改设置页 · 11-\d{2} \d{2}:\d{2}\n2\. 修复模型选择/);
    assert.match(output, /\n\nwecode\n3\. 修复登录接口.*\n4\. 调整消息队列.*\n5\. 调整账号 Tab/s);
    assert.doesNotMatch(output, /不应出现|https?:\/\/|target-thread|1\. \*\*/);
    assert.match(output, /回复序号选择$/);
    assert.ok(store.getControl('user'));

    await bridge.handle(message('3', 'indexed-select'));
    assert.deepEqual(used, ['w1']);
    assert.equal(store.getBinding('user')?.threadId, 'w1');
    assert.equal(store.getControl('user'), undefined);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('preloads the project index at startup and refreshes it on wake', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-index-refresh-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  let listCalls = 0;
  const project = path.join(directory, 'current-project');
  const fakeSessions = {
    list: async () => {
      listCalls += 1;
      return [{ id: `thread-${listCalls}`, cwd: project, preview: '最近会话', updatedAt: 1_700_000_000, cli: 'codex' as const }];
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await bridge.initialize();
    assert.equal(listCalls, 1);
    await bridge.handle(message('小微', 'refresh-wake'));
    assert.equal(listCalls, 2);
    assert.match(sent.at(-1) || '', /current-project\n1\. 最近会话/);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('natural-language project lookup returns one flat local list and supports numeric selection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-project-list-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const used: string[] = [];
  const project = path.join(directory, 'agency-cloud-core');
  const other = path.join(directory, 'Rambo');
  const target = { id: 'target-thread', cwd: project, preview: '目标会话', updatedAt: 1_700_000_009, cli: 'codex' as const };
  const historical = [
    target,
    { id: 'other-thread', cwd: other, preview: '其他项目', updatedAt: 1_700_000_010, cli: 'codex' as const },
  ];
  const listCalls: Array<string | undefined> = [];
  let controlPrompt = '';
  const fakeControl = {
    run: async (_userId: string, prompt: string) => {
      controlPrompt = prompt;
      return {
        action: { action: 'list_sessions' as const, cwd: project, limit: 5 },
        sessionId: 'control-thread',
      };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    list: async (cwd?: string) => {
      listCalls.push(cwd);
      return cwd ? historical.filter((session) => session.cwd === cwd) : historical;
    },
    use: async (_userId: string, threadId: string, cwd?: string) => {
      used.push(threadId);
      const binding: SessionBinding = {
        threadId,
        cwd: cwd || project,
        cli: 'codex',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      store.setBinding('user', binding);
      return { binding };
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('小薇，查找 agency-cloud-core 最近 5 个会话', 'project-list'));
    assert.match(controlPrompt, /历史项目索引/);
    assert.match(controlPrompt, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(listCalls, [undefined, project]);
    assert.match(sent.at(-1) || '', /agency-cloud-core\n1\. 目标会话/);
    assert.doesNotMatch(sent.at(-1) || '', /Rambo|other-thread|\*\*agency-cloud-core/);

    await bridge.handle(message('第 1 个', 'project-select'));
    assert.deepEqual(used, ['target-thread']);
    assert.equal(store.getBinding('user')?.threadId, 'target-thread');
    assert.equal(store.getControl('user'), undefined);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('natural-language project creation uses the indexed cwd and refreshes the index', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-project-create-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const project = path.join(directory, 'wecode');
  let listCalls = 0;
  let createdCwd = '';
  const fakeControl = {
    run: async () => ({
      action: { action: 'new_session' as const, cwd: project },
      sessionId: 'control-thread',
    }),
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    list: async () => {
      listCalls += 1;
      return [{ id: 'history-thread', cwd: project, preview: '历史会话', updatedAt: 1_700_000_000, cli: 'codex' as const }];
    },
    create: async (_userId: string, cwd: string) => {
      createdCwd = cwd;
      const binding: SessionBinding = {
        threadId: 'new-thread',
        cwd,
        cli: 'codex',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      store.setBinding('user', binding);
      return { binding };
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('小薇，在 wecode 项目新建一个会话', 'project-create'));
    assert.equal(createdCwd, project);
    assert.equal(store.getBinding('user')?.threadId, 'new-thread');
    assert.equal(store.getControl('user'), undefined);
    assert.equal(listCalls, 2);
    assert.match(sent.at(-1) || '', /已新建会话/);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a local numeric selection keeps safe takeover confirmation for occupied sessions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-local-takeover-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const project = path.join(directory, 'occupied-project');
  let useCalls = 0;
  let controlRuns = 0;
  const fakeControl = {
    run: async () => {
      controlRuns += 1;
      return { action: { action: 'reply' as const, text: '不应调用' }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    list: async () => [{ id: 'occupied-thread', cwd: project, preview: '被占用会话', updatedAt: 1_700_000_000, cli: 'codex' as const }],
    resolveThreadId: async (identifier: string) => identifier,
    use: async (_userId: string, threadId: string, cwd?: string, _options?: unknown, takeover = false) => {
      useCalls += 1;
      if (!takeover) throw new SessionOccupiedError(threadId, cwd || project);
      const binding: SessionBinding = {
        threadId,
        cwd: cwd || project,
        cli: 'codex',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      store.setBinding('user', binding);
      return { binding };
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('小威', 'takeover-wake'));
    await bridge.handle(message('1', 'takeover-select'));
    assert.match(sent.at(-1) || '', /确认接管/);
    assert.equal(store.getControl('user')?.pendingTakeover?.threadId, 'occupied-thread');

    await bridge.handle(message('确认接管', 'takeover-confirm'));
    assert.equal(useCalls, 2);
    assert.equal(store.getBinding('user')?.threadId, 'occupied-thread');
    assert.equal(store.getControl('user'), undefined);
    assert.equal(controlRuns, 0);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});
