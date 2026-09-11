import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { BridgeApp } from '../src/bridge.js';
import { ControlAgent } from '../src/control.js';
import type { InboundMessage } from '../src/ilink.js';
import type { SessionBinding, ThreadSnapshot } from '../src/model.js';
import { SessionManager, SessionOccupiedError, type SessionInspection } from '../src/sessions.js';
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
  let catalogCalls = 0;
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
  const fakeSessions = {
    list: async () => {
      catalogCalls += 1;
      return [];
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('帮我处理一个普通请求', 'no-session-1'));
    assert.ok(sent.some((text) => /当前没有会话，已进入会话管理模式/.test(text)));
    assert.match(sent.at(-1) || '', /会话管理 Agent 已响应/);
    assert.doesNotMatch(sent.join('\n'), /处理中……/);
    assert.doesNotMatch(sent.join('\n'), /唤醒词|帅哥/);
    assert.match(controlPrompt, /帮我处理一个普通请求/);
    assert.match(controlPrompt, /尚未加载原生会话 catalog/);
    assert.equal(catalogCalls, 0);
    assert.equal(store.getControl('user')?.sessionId, 'control-thread');

    await bridge.handle(message('再帮我处理一个普通请求', 'no-session-2'));
    assert.doesNotMatch(sent.join('\n'), /处理中……/);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('lists recent sessions through the fast path and keeps numeric selection local', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-quick-list-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const listLimits: number[] = [];
  const used: string[] = [];
  let controlRuns = 0;
  const targetCwd = path.join(directory, 'target-project');
  const sessions = [
    { id: 'old-thread', cwd: directory, preview: '旧会话', updatedAt: 1_700_000_000, cli: 'codex' as const },
    { id: 'target-thread', cwd: targetCwd, preview: '目标会话', updatedAt: 1_700_000_200, cli: 'codex' as const },
    { id: 'new-thread', cwd: directory, preview: '最新会话', updatedAt: 1_700_000_300, cli: 'codex' as const },
  ];
  const fakeControl = {
    run: async () => {
      controlRuns += 1;
      throw new Error('列出会话不应启动会话管理 Agent');
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    list: async (_cwd?: string, limit?: number) => {
      listLimits.push(limit || 0);
      return sessions;
    },
    status: async () => ({ binding: store.getBinding('user'), running: false }),
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
    await bridge.handle(message('列出最近 5 个会话', 'quick-list-1'));
    await bridge.handle(message('列出最近 5 个会话', 'quick-list-2'));
    assert.equal(controlRuns, 0);
    assert.deepEqual(listLimits, [5]);
    assert.match(sent.at(-1) || '', /2\. \*\*target-project\*\* — 目标会话（/);
    assert.match(sent.at(-1) || '', /回复序号即可切换/);

    await bridge.handle(message('2', 'quick-select-1'));
    assert.deepEqual(used, ['target-thread']);
    assert.equal(store.getBinding('user')?.threadId, 'target-thread');
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('shows active Codex work through a read-only fast path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-inspect-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  let controlRuns = 0;
  const snapshot: ThreadSnapshot = {
    id: 'active-thread',
    cwd: directory,
    updatedAt: 1_700_000_300,
    status: { type: 'active', activeFlags: ['running'] },
    turns: [{
      id: 'turn-1',
      status: 'inProgress',
      items: [{ type: 'commandExecution', command: 'npm test', status: 'inProgress' }],
    }],
  };
  const inspection: SessionInspection = {
    summary: { id: 'active-thread', cwd: directory, preview: '修复 Windows 启动问题', updatedAt: 1_700_000_300, status: snapshot.status },
    snapshot,
  };
  const fakeControl = {
    run: async () => {
      controlRuns += 1;
      throw new Error('查看活动不应启动会话管理 Agent');
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    inspect: async (limit: number, activeOnly: boolean) => {
      assert.equal(limit, 5);
      assert.equal(activeOnly, true);
      return [inspection];
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('查看活动', 'inspect-1'));
    assert.equal(controlRuns, 0);
    assert.match(sent.at(-1) || '', /当前活动 Codex 任务/);
    assert.match(sent.at(-1) || '', /执行命令：npm test/);
    assert.match(sent.at(-1) || '', /只读查看/);
    assert.equal(store.getBinding('user'), undefined);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses completed wording for historical context compaction activity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-inspect-history-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const snapshot: ThreadSnapshot = {
    id: 'historical-thread',
    cwd: directory,
    updatedAt: 1_700_000_300,
    status: { type: 'notLoaded' },
    turns: [{
      id: 'turn-1',
      status: 'completed',
      items: [{ type: 'contextCompaction', status: 'completed' }],
    }],
  };
  const inspection: SessionInspection = {
    summary: {
      id: 'historical-thread',
      cwd: directory,
      preview: '历史会话',
      updatedAt: 1_700_000_300,
      status: snapshot.status,
    },
    snapshot,
  };
  const fakeControl = {
    run: async () => { throw new Error('查看最近任务不应启动会话管理 Agent'); },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    inspect: async (limit: number, activeOnly: boolean) => {
      assert.equal(limit, 5);
      assert.equal(activeOnly, false);
      return [inspection];
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('查看最近任务', 'inspect-history-1'));
    assert.match(sent.at(-1) || '', /状态：未加载/);
    assert.match(sent.at(-1) || '', /最近动作：已整理会话上下文（已完成）/);
    assert.doesNotMatch(sent.at(-1) || '', /正在整理会话上下文/);
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

test('loads the native session catalog only for an explicit session lookup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-control-catalog-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  let catalogCalls = 0;
  let controlPrompt = '';
  let controlRuns = 0;
  const fakeControl = {
    run: async (_userId: string, prompt: string) => {
      controlRuns += 1;
      controlPrompt = prompt;
      return controlRuns === 1
        ? { action: { action: 'request_catalog' as const }, sessionId: 'control-thread' }
        : { action: { action: 'reply' as const, text: '已读取会话。' }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    list: async () => {
      catalogCalls += 1;
      return [];
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions, fakeControl);

  try {
    await bridge.handle(message('帅哥，帮我查找最近的会话', 'catalog-1'));
    assert.equal(catalogCalls, 1);
    assert.equal(controlRuns, 2);
    assert.match(controlPrompt, /原生会话 catalog 已加载/);
    assert.match(sent.at(-1) || '', /已读取会话/);
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

test('keeps deterministic local commands while honorifics enter the session-management Agent', async () => {
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

test('forks the current session with a direct local command', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-fork-command-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const forkedFrom: string[] = [];
  store.setBinding('user', {
    threadId: 'source-thread',
    cwd: directory,
    cli: 'codex',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  const fakeSessions = {
    status: async () => ({ binding: store.getBinding('user'), running: false }),
    fork: async (_userId: string, threadId: string, cwd: string) => {
      forkedFrom.push(threadId);
      const binding: SessionBinding = {
        threadId: 'forked-thread',
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
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await bridge.handle(message('分叉', 'fork-command'));
    assert.deepEqual(forkedFrom, ['source-thread']);
    assert.equal(store.getBinding('user')?.threadId, 'forked-thread');
    assert.match(sent.at(-1) || '', /已分叉新会话/);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('lets the session-management Agent fork a selected historical session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-control-fork-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  const source = { id: 'source-thread', cwd: directory, preview: '历史会话', updatedAt: 1_700_000_000, cli: 'codex' as const };
  let controlRuns = 0;
  let catalogCalls = 0;
  const fakeControl = {
    run: async () => {
      controlRuns += 1;
      return controlRuns === 1
        ? { action: { action: 'request_catalog' as const }, sessionId: 'control-thread' }
        : { action: { action: 'fork_session' as const, thread_id: source.id, cwd: source.cwd }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ running: false }),
    list: async () => {
      catalogCalls += 1;
      return [source];
    },
    resolveThreadId: async (identifier: string) => identifier,
    fork: async (_userId: string, threadId: string, cwd: string) => {
      const binding: SessionBinding = {
        threadId: `${threadId}-forked`,
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
    await bridge.handle(message('帮我复制第二个历史会话', 'control-fork-1'));
    assert.equal(controlRuns, 2);
    assert.equal(catalogCalls, 1);
    assert.equal(store.getBinding('user')?.threadId, 'source-thread-forked');
    assert.match(sent.at(-1) || '', /已分叉新会话/);
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
          action: { action: 'request_catalog' as const },
          sessionId: 'control-thread',
        }
        : runCount === 2
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
      return {
        action: { action: 'switch_session' as const, thread_id: 'occupied-thread', cwd: targetCwd, takeover: true },
        sessionId: 'control-thread',
      };
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

test('handles an idle external client that still holds the session lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-control-idle-lock-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  let forkCalls = 0;
  const targetCwd = path.join(directory, 'agency-cloud-core');
  let controlRuns = 0;
  const fakeControl = {
    run: async () => {
      controlRuns += 1;
      return {
        action: { action: 'switch_session' as const, thread_id: 'occupied-thread', cwd: targetCwd, takeover: controlRuns > 1 },
        sessionId: 'control-thread',
      };
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
      if (!takeover) throw new SessionOccupiedError('occupied-thread', targetCwd);
      throw new SessionOccupiedError(
        'occupied-thread',
        targetCwd,
        false,
        '检测到 Windows 外部 Codex 客户端持有目标锁',
        true,
      );
    },
    fork: async (_userId: string, _threadId: string, cwd: string) => {
      forkCalls += 1;
      const binding: SessionBinding = {
        threadId: 'forked-thread',
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
    await bridge.handle(message('帅哥，帮我切换到 occupied-thread', 'idle-lock-1'));
    await bridge.handle(message('确认接管', 'idle-lock-2'));
    if (process.platform === 'win32') {
      assert.equal(forkCalls, 1);
      assert.equal(store.getBinding('user')?.threadId, 'forked-thread');
      assert.match(sent.at(-1) || '', /已分叉新会话/);
    } else {
      assert.match(sent.at(-1) || '', /任务已空闲/);
      assert.match(sent.at(-1) || '', /退出外部 Codex 客户端/);
      assert.doesNotMatch(sent.at(-1) || '', /结束外部任务后重试/);
    }
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
    assert.match(sent.at(-1) || '', /已发送，执行中/);
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
