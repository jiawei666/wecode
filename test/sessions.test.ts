import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { CodexAppServer } from '../src/codex.js';
import { inferTurnPresentation, SessionManager, SessionOccupiedError } from '../src/sessions.js';
import { StateStore } from '../src/state.js';

test('infers a share page for repository report requests', () => {
  assert.deepEqual(inferTurnPresentation('请分析这个仓库代码并生成总结报告'), { kind: 'report', presentation: 'page' });
  assert.deepEqual(inferTurnPresentation('请把这段内容生成分享页'), { kind: 'plain', presentation: 'page' });
  assert.equal(inferTurnPresentation('你现在是什么模型'), undefined);
});

test('starts a fresh thread turn through the App Server', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-session-'));
  const events: string[] = [];
  const fakeAppServer = {
    onNotification: () => () => undefined,
    startThread: async () => {
      events.push('thread');
      return { id: 'fresh-thread' };
    },
    resumeThread: async () => {
      events.push('resume');
      throw new Error('no rollout found');
    },
    startTurn: async () => {
      events.push('turn');
      return 'turn-1';
    },
    close: async () => undefined,
  } as unknown as CodexAppServer;
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, async () => undefined);

  try {
    await manager.create('user');
    assert.deepEqual(events, ['thread']);
    await manager.send('user', '你现在是什么模型');
    assert.deepEqual(events, ['thread', 'turn']);
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('steers the active turn through the App Server', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-session-steer-'));
  const events: string[] = [];
  const fakeAppServer = {
    onNotification: () => () => undefined,
    startThread: async () => ({ id: 'steer-thread' }),
    startTurn: async () => 'turn-1',
    steerTurn: async (threadId: string, turnId: string, text: string) => {
      events.push(`${threadId}|${turnId}|${text}`);
      return turnId;
    },
    close: async () => undefined,
  } as unknown as CodexAppServer;
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, async () => undefined);

  try {
    await manager.create('user');
    await manager.send('user', '先开始');
    const result = await manager.steer('user', '补充要求');
    assert.equal(result.accepted, true);
    assert.deepEqual(events, ['steer-thread|turn-1|补充要求']);
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('recreates a stale fresh binding before sending its first turn', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-stale-session-'));
  const events: string[] = [];
  const fakeAppServer = {
    onNotification: () => () => undefined,
    startThread: async () => {
      events.push('thread:new');
      return { id: 'new-thread' };
    },
    resumeThread: async () => {
      events.push('resume');
      throw new Error('Codex thread not found: stale-thread');
    },
    startTurn: async (threadId: string) => {
      events.push(`turn:${threadId}`);
      if (threadId === 'stale-thread') throw new Error('Codex thread not found: stale-thread');
      return 'turn-1';
    },
    close: async () => undefined,
  } as unknown as CodexAppServer;
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  store.setBinding('user', {
    threadId: 'stale-thread',
    cwd: directory,
    hasRollout: false,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, async () => undefined);

  try {
    const result = await manager.send('user', '你好');
    assert.equal(result.accepted, true);
    assert.deepEqual(events, ['turn:stale-thread', 'thread:new', 'turn:new-thread']);
    assert.equal(store.getBinding('user')?.threadId, 'new-thread');
    assert.equal(store.getBinding('user')?.hasRollout, true);
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not bind a session occupied by another Codex client', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-session-conflict-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  let resumes = 0;
  const fakeAppServer = {
    onNotification: () => () => undefined,
    resumeThread: async () => {
      resumes += 1;
      throw new Error('thread-store conflict: active writer');
    },
    close: async () => undefined,
  } as unknown as CodexAppServer;
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, async () => undefined);

  try {
    await assert.rejects(
      manager.use('user', 'occupied-thread', directory),
      (error: unknown) => error instanceof SessionOccupiedError && /其他 Codex 客户端/.test(error.message),
    );
    assert.equal(resumes, 1);
    assert.equal(store.getBinding('user'), undefined);
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('safely interrupts an active external turn before resuming its session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-session-takeover-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  let resumeCalls = 0;
  let readCalls = 0;
  let interrupted: { threadId: string; turnId: string } | undefined;
  const fakeAppServer = {
    onNotification: () => () => undefined,
    resumeThread: async () => {
      resumeCalls += 1;
      if (resumeCalls === 1) {
        throw new Error('thread-store conflict: active writer');
      }
      return { id: 'occupied-thread', cwd: directory, status: { type: 'idle' } };
    },
    readThread: async () => {
      readCalls += 1;
      return readCalls === 1
        ? { id: 'occupied-thread', cwd: directory, status: { type: 'active' }, turns: [{ id: 'turn-1', status: 'inProgress' }] }
        : { id: 'occupied-thread', cwd: directory, status: { type: 'idle' }, turns: [] };
    },
    interrupt: async (threadId: string, turnId: string) => {
      interrupted = { threadId, turnId };
    },
    close: async () => undefined,
  } as unknown as CodexAppServer;
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, async () => undefined);

  try {
    const result = await manager.use('user', 'occupied-thread', directory, {}, true);
    assert.equal(result.binding.threadId, 'occupied-thread');
    assert.deepEqual(interrupted, { threadId: 'occupied-thread', turnId: 'turn-1' });
    assert.equal(resumeCalls, 2);
    assert.equal(readCalls, 2);
    assert.equal(store.getBinding('user')?.threadId, 'occupied-thread');
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('releases an idle external writer after confirmed takeover', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-session-idle-takeover-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  let resumeCalls = 0;
  let releaseCalls = 0;
  const fakeAppServer = {
    onNotification: () => () => undefined,
    resumeThread: async () => {
      resumeCalls += 1;
      if (releaseCalls === 0) throw new Error('thread-store conflict: active writer');
      return { id: 'idle-occupied-thread', cwd: directory, status: { type: 'idle' } };
    },
    readThread: async () => ({ id: 'idle-occupied-thread', cwd: directory, status: { type: 'idle' }, turns: [] }),
    releaseExternalWriter: async () => {
      releaseCalls += 1;
      return { released: true, pids: [1234] };
    },
    close: async () => undefined,
  } as unknown as CodexAppServer;
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, async () => undefined);

  try {
    const result = await manager.use('user', 'idle-occupied-thread', directory, {}, true);
    assert.equal(result.binding.threadId, 'idle-occupied-thread');
    assert.equal(releaseCalls, 1);
    assert.ok(resumeCalls > 1);
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('releases App Server ownership before a binding is cancelled', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-release-session-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const events: string[] = [];
  const fakeAppServer = {
    onNotification: () => () => undefined,
    unsubscribe: async (threadId: string) => { events.push(`unsubscribe:${threadId}`); },
    close: async () => undefined,
  } as unknown as CodexAppServer;
  store.setBinding('user', {
    threadId: 'release-thread',
    cwd: directory,
    hasRollout: true,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, async () => undefined);

  try {
    await manager.release('user');
    assert.deepEqual(events, ['unsubscribe:release-thread']);
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});
