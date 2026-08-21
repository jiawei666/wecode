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

test('does not send an automatic first-run guide before explicit help', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-guide-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const fakeSessions = { close: async () => undefined } as unknown as SessionManager;
  const sent: string[] = [];
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await bridge.handle(message('帮助', 'help-1'));
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0] || '', /欢迎使用 wecode|wecode 使用指南/);
    assert.match(sent[0] || '', /主要入口/);
    assert.match(sent[0] || '', /^> \*\*wecode 系统\*\*\n\n主要入口/);
    assert.doesNotMatch(sent[0] || '', /wecode 系统\*\* ·/);

    await bridge.handle(message('帮助', 'help-2'));
    assert.equal(sent.length, 2);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test('automatically enters session management when a plain message has no session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-no-session-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  let controlPrompt = '';
  const fakeControl = {
    run: async (_userId: string, prompt: string) => {
      controlPrompt = prompt;
      return { action: { action: 'reply' as const, text: '会话管理 Agent 已响应。' }, sessionId: 'control-thread' };
    },
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
    await bridge.handle(message('帮我处理一个普通请求', 'no-session-1'));
    assert.ok(sent.some((text) => /当前没有会话，已进入会话管理模式/.test(text)));
    assert.match(sent.at(-1) || '', /会话管理 Agent 已响应/);
    assert.doesNotMatch(sent.join('\n'), /唤醒词|帅哥/);
    assert.match(controlPrompt, /帮我处理一个普通请求/);
    assert.equal(store.getControl('user')?.sessionId, 'control-thread');
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
    assert.doesNotMatch(sent.join('\n'), /唤醒词|帅哥/);
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

test('keeps four local commands while honorifics enter the session-management Agent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-local-command-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const localCalls: string[] = [];
  let controlRuns = 0;
  const fakeControl = {
    run: async () => {
      controlRuns += 1;
      return { action: { action: 'reply' as const, text: '会话管理 Agent 已响应。' }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    list: async () => [],
    status: async (userId: string) => ({ binding: store.getBinding(userId), running: false }),
    stop: async () => { localCalls.push('stop'); return false; },
    release: async () => { localCalls.push('release'); },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = {
    ...loadConfig(),
    dataDir: directory,
    stateFile: path.join(directory, 'state.json'),
    defaultCwd: directory,
    searchRoots: [directory],
  };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('帮助', 'local-help'));
    await bridge.handle(message('状态', 'local-status'));
    await bridge.handle(message('停止', 'local-stop'));
    assert.deepEqual(localCalls, ['stop']);
    assert.equal(store.getControl('user'), undefined);

    store.setBinding('user', {
      threadId: 'thread-a',
      cwd: directory,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    await bridge.handle(message('退出', 'local-exit'));
    assert.deepEqual(localCalls, ['stop', 'release']);
    assert.equal(store.getBinding('user'), undefined);

    const beforeAutoManagement = sent.length;
    await bridge.handle(message('帮我新建一个会话', 'ordinary-without-session'));
    const autoManagementReplies = sent.slice(beforeAutoManagement).join('\n');
    assert.match(autoManagementReplies, /已进入会话管理模式/);
    assert.doesNotMatch(autoManagementReplies, /唤醒词/);
    assert.equal(controlRuns, 1);

    await bridge.handle(message('帅哥，帮我列出会话', 'wake-control'));
    assert.match(sent.at(-1) || '', /会话管理 Agent/);
    assert.equal(store.getControl('user')?.sessionId, 'control-thread');
    assert.equal(controlRuns, 2);
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
    assert.match(sent.at(-1) || '', /已继续/);
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

test('lets the session-management Agent format lists and resolve a natural-language selection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-control-list-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const target = { id: 'target-thread', cwd: path.join(directory, 'agency-cloud-core'), preview: '第二个摘要', updatedAt: 1_700_000_000, cli: 'codex' as const };
  const other = { id: 'other-thread', cwd: path.join(directory, 'agency-cloud-core'), preview: '第一个摘要', updatedAt: 1_700_000_100, cli: 'codex' as const };
  let runCount = 0;
  const fakeControl = {
    run: async () => {
      runCount += 1;
      return runCount === 1
        ? {
          action: {
            action: 'list_sessions' as const,
            cwd: target.cwd,
            limit: 5,
            text: '## 最近 2 个会话\n\n1. **agency-cloud-core**\n   第一个摘要 · 2023-11-14 22:15\n\n2. **agency-cloud-core**\n   第二个摘要 · 2023-11-14 22:13',
          },
          sessionId: 'control-thread',
        }
        : { action: { action: 'switch_session' as const, thread_id: 'target-thread', cwd: target.cwd }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ running: false }),
    list: async () => [other, target],
    resolveThreadId: async (identifier: string) => identifier,
    use: async (_userId: string, threadId: string, cwd?: string) => {
      const binding: SessionBinding = {
        threadId,
        cwd: cwd || target.cwd,
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
    await bridge.handle(message('帅哥，帮我找 agency-cloud-core 最近 5 个会话', 'control-1'));
    assert.match(sent.at(-1) || '', /> \*\*会话管理 Agent\*\*/);
    assert.match(sent.at(-1) || '', /第一个摘要/);
    assert.doesNotMatch(sent.at(-1) || '', /target-thread|gpt-5/);
    assert.ok(store.getControl('user'));

    await bridge.handle(message('第 2 个', 'control-2'));
    assert.match(sent.at(-1) || '', /已切换会话/);
    assert.match(sent.at(-1) || '', /后续普通消息/);
    assert.doesNotMatch(sent.at(-1) || '', /唤醒词/);
    assert.equal(store.getBinding('user')?.threadId, 'target-thread');
    assert.equal(store.getControl('user'), undefined);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires explicit confirmation before safely taking over an occupied Codex session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-control-conflict-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const targetCwd = path.join(directory, 'agency-cloud-core');
  let useCount = 0;
  const fakeControl = {
    run: async () => {
      return { action: { action: 'switch_session' as const, thread_id: 'occupied-thread', cwd: targetCwd }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ running: false }),
    list: async () => [{ id: 'occupied-thread', cwd: targetCwd, preview: '空闲会话', updatedAt: 1_700_000_000, cli: 'codex' as const }],
    resolveThreadId: async (identifier: string) => identifier,
    use: async (_userId: string, _threadId: string, _cwd?: string, _options?: unknown, takeover = false) => {
      useCount += 1;
      if (!takeover) throw new SessionOccupiedError('occupied-thread', targetCwd);
      const binding: SessionBinding = {
        threadId: 'occupied-thread',
        cwd: targetCwd,
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
    await bridge.handle(message('帅哥，帮我切换到 occupied-thread', 'conflict-1'));
    assert.match(sent.at(-1) || '', /外部客户端/);
    assert.match(sent.at(-1) || '', /安全接管/);
    assert.match(sent.at(-1) || '', /确认接管/);
    assert.equal(store.getControl('user')?.pendingTakeover?.threadId, 'occupied-thread');
    assert.ok(store.getControl('user'));
    assert.equal(store.getBinding('user'), undefined);

    await bridge.handle(message('确认接管', 'conflict-2'));
    assert.equal(useCount, 2);
    assert.equal(store.getBinding('user')?.threadId, 'occupied-thread');
    assert.equal(store.getControl('user'), undefined);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('explains when an idle external client still holds the session lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-control-idle-lock-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const targetCwd = path.join(directory, 'agency-cloud-core');
  const fakeControl = {
    run: async () => ({
      action: { action: 'switch_session' as const, thread_id: 'occupied-thread', cwd: targetCwd },
      sessionId: 'control-thread',
    }),
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ running: false }),
    list: async () => [{ id: 'occupied-thread', cwd: targetCwd, preview: '空闲会话', updatedAt: 1_700_000_000, cli: 'codex' as const }],
    resolveThreadId: async (identifier: string) => identifier,
    use: async (_userId: string, _threadId: string, _cwd?: string, _options?: unknown, takeover = false) => {
      if (!takeover) throw new SessionOccupiedError('occupied-thread', targetCwd);
      throw new SessionOccupiedError(
        'occupied-thread',
        targetCwd,
        false,
        '目标任务已空闲，但外部客户端仍保持会话占用',
        true,
      );
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('帅哥，帮我切换到 occupied-thread', 'idle-lock-1'));
    await bridge.handle(message('确认接管', 'idle-lock-2'));
    assert.match(sent.at(-1) || '', /任务已空闲/);
    assert.match(sent.at(-1) || '', /退出外部 Codex 客户端/);
    assert.doesNotMatch(sent.at(-1) || '', /结束外部任务后重试/);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});
