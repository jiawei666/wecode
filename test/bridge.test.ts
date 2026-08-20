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

test('shows the first-run guide once without swallowing the initial command', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-onboarding-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const fakeSessions = { close: async () => undefined } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await bridge.handle(message('/help', 'onboarding-1'));
    assert.match(sent[0] || '', /欢迎使用 wecode/);
    assert.match(sent[0] || '', /wecode 使用指南/);
    assert.match(sent[0] || '', /直接发消息：发送给当前 Codex/);
    assert.match(sent.at(-1) || '', /微信 Codex 快捷操作/);
    assert.equal(store.get().onboardingShown.user, true);

    await bridge.handle(message('/help', 'onboarding-2'));
    assert.equal(sent.filter((text) => text.includes('欢迎使用 wecode')).length, 1);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('retries the first-run guide when its delivery fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-onboarding-retry-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  let attempts = 0;
  const fakeSessions = { close: async () => undefined } as unknown as SessionManager;
  const fakeIlink = {
    sendText: async (_to: string, _text: string) => {
      attempts += 1;
      return { ok: attempts > 1 };
    },
  } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await bridge.handle(message('/help', 'onboarding-retry-1'));
    assert.equal(store.hasOnboardingShown('user'), false);

    await bridge.handle(message('/help', 'onboarding-retry-2'));
    assert.equal(store.hasOnboardingShown('user'), true);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('runs legacy and Chinese session commands locally without the control Agent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-local-command-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const fakeControl = {
    run: async () => { throw new Error('Control Agent should not receive local commands'); },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const first = { id: 'first-thread', cwd: directory, preview: '第一个摘要', updatedAt: 1_700_000_100, cli: 'codex' as const };
  const second = { id: 'second-thread', cwd: directory, preview: '第二个摘要', updatedAt: 1_700_000_000, cli: 'codex' as const };
  const fakeSessions = {
    list: async () => [first, second],
    status: async (userId: string) => ({ binding: store.getBinding(userId), running: false }),
    resolveThreadId: async (identifier: string) => identifier,
    use: async (userId: string, threadId: string, cwd?: string) => {
      const binding: SessionBinding = {
        threadId,
        cwd: cwd || directory,
        cli: 'codex',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      store.setBinding(userId, binding);
      return { binding };
    },
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
    await bridge.handle(message('/sessions', '1'));
    assert.match(sent.at(-1) || '', /Codex 会话/);
    assert.match(sent.at(-1) || '', /第一个摘要/);
    assert.equal(store.getControl('user'), undefined);

    await bridge.handle(message('/切换 2', '2'));
    assert.equal(store.getBinding('user')?.threadId, 'second-thread');
    assert.match(sent.at(-1) || '', /已切换 Codex 会话/);

    await bridge.handle(message('菜单', 'menu-1'));
    assert.match(sent.at(-1) || '', /1\. 新建会话/);
    assert.ok(store.getMenu('user'));

    await bridge.handle(message('2', 'menu-2'));
    assert.match(sent.at(-1) || '', /Codex 会话/);
    assert.equal(store.getMenu('user'), undefined);
    assert.ok(store.getSelection('user'));
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
    run: async () => { throw new Error('Control Agent should not receive target messages'); },
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
    assert.match(sent.at(-1) || '', /已自动继续处理排队消息/);
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
    run: async () => { throw new Error('Control Agent should not receive target messages'); },
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
    assert.match(sent.at(-1) || '', /已追加到当前任务/);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('lets the control Agent format lists and resolves a natural-language selection', async () => {
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
    await bridge.handle(message('/ctrl 找 agency-cloud-core 最近 5 个会话', 'control-1'));
    assert.match(sent.at(-1) || '', /> \*\*控制 Agent\*\*/);
    assert.match(sent.at(-1) || '', /第一个摘要/);
    assert.doesNotMatch(sent.at(-1) || '', /target-thread|gpt-5/);
    assert.ok(store.getControl('user'));

    await bridge.handle(message('第 2 个', 'control-2'));
    assert.match(sent.at(-1) || '', /已切换 Codex 会话/);
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
    await bridge.handle(message('/ctrl 切换到 occupied-thread', 'conflict-1'));
    assert.match(sent.at(-1) || '', /其他 Codex 客户端/);
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
