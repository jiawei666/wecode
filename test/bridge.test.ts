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

test('keeps slash session lists selectable without exposing model or IDs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  let releaseCalls = 0;
  const binding: SessionBinding = {
    threadId: '01234567-89ab-cdef-0123-456789abcdef',
    cwd: directory,
    tmuxSession: 'codex-test',
    cli: 'codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
    fast: false,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  store.setBinding('user', binding);
  const fakeSessions = {
    status: async () => ({ binding: store.getBinding('user'), running: false, tmuxExists: true, attachedClients: 0 }),
    list: async () => [{ id: binding.threadId, cwd: directory, preview: '测试会话', updatedAt: Date.now(), cli: 'codex' }],
    stop: async () => false,
    release: async () => { releaseCalls += 1; },
    use: async (_userId: string, threadId: string) => {
      const next = { ...binding, threadId, lastActivityAt: Date.now() };
      store.setBinding('user', next);
      return { binding: next };
    },
    close: async () => undefined,
  } as unknown as SessionManager;
  const fakeIlink = { sendText: async (_to: string, text: string) => { sent.push(text); return { ok: true }; } } as never;
  const config = { ...loadConfig(), dataDir: directory, stateFile: path.join(directory, 'state.json') };
  const bridge = new BridgeApp(config, store, fakeIlink, fakeSessions);

  try {
    await bridge.handle(message('/sessions', '1'));
    assert.match(sent.at(-1) || '', /1\. /);
    assert.doesNotMatch(sent.at(-1) || '', /gpt-5\.6-luna|01234567-89ab-cdef-0123-456789abcdef/);
    assert.ok(store.getSelection('user'));

    await bridge.handle(message('1', '2'));
    assert.match(sent.at(-1) || '', /已切换 Codex 会话/);
    assert.equal(store.getControl('user'), undefined);
    assert.equal(store.getSelection('user'), undefined);

    await bridge.handle(message('/cancel', '4'));
    assert.equal(store.getBinding('user'), undefined);
    assert.equal(releaseCalls, 1);
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
    status: async () => ({ running: false, tmuxExists: false, attachedClients: 0 }),
    list: async () => [other, target],
    resolveThreadId: async (identifier: string) => identifier,
    use: async (_userId: string, threadId: string, cwd?: string) => {
      const binding: SessionBinding = {
        threadId,
        cwd: cwd || target.cwd,
        tmuxSession: 'codex-target',
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

test('keeps control mode and asks before taking over an occupied native session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-control-takeover-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
  let runCount = 0;
  let useCount = 0;
  const targetCwd = path.join(directory, 'agency-cloud-core');
  const fakeControl = {
    run: async () => {
      runCount += 1;
      return runCount === 1
        ? { action: { action: 'switch_session' as const, thread_id: 'occupied-thread', cwd: targetCwd }, sessionId: 'control-thread' }
        : { action: { action: 'switch_session' as const, thread_id: 'occupied-thread', cwd: targetCwd, takeover: true }, sessionId: 'control-thread' };
    },
    interrupt: async () => false,
    consumeInterrupted: () => false,
    isRunning: () => false,
    close: async () => undefined,
  } as unknown as ControlAgent;
  const fakeSessions = {
    status: async () => ({ running: false, tmuxExists: false, attachedClients: 0 }),
    list: async () => [{ id: 'occupied-thread', cwd: targetCwd, preview: '空闲会话', updatedAt: 1_700_000_000, cli: 'codex' as const }],
    resolveThreadId: async (identifier: string) => identifier,
    use: async () => {
      useCount += 1;
      if (useCount === 1) throw new SessionOccupiedError('occupied-thread', targetCwd, false);
      const binding: SessionBinding = {
        threadId: 'occupied-thread',
        cwd: targetCwd,
        tmuxSession: 'codex-occupied',
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
    await bridge.handle(message('/ctrl 切换到 occupied-thread', 'takeover-1'));
    assert.match(sent.at(-1) || '', /空闲状态/);
    assert.match(sent.at(-1) || '', /是否继续/);
    assert.ok(store.getControl('user')?.pendingTakeover);
    assert.equal(store.getBinding('user'), undefined);

    await bridge.handle(message('继续接管', 'takeover-2'));
    assert.equal(store.getBinding('user')?.threadId, 'occupied-thread');
    assert.equal(store.getControl('user'), undefined);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});
