import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { CodexAppServer } from '../src/codex.js';
import { inferTurnPresentation, SessionManager, SessionOccupiedError } from '../src/sessions.js';
import { StateStore } from '../src/state.js';
import { TmuxManager } from '../src/tmux.js';

test('infers a share page for repository report requests', () => {
  assert.deepEqual(inferTurnPresentation('请分析这个仓库代码并生成总结报告'), { kind: 'report', presentation: 'page' });
  assert.equal(inferTurnPresentation('你现在是什么模型'), undefined);
});

test('starts a fresh thread turn before attaching tmux or resuming it', async () => {
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
  const fakeTmux = {
    start: async () => {
      events.push('tmux');
      return { ok: true };
    },
  } as unknown as TmuxManager;
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, fakeTmux, async () => undefined);

  try {
    await manager.create('user');
    assert.deepEqual(events, ['thread']);
    await manager.send('user', '你现在是什么模型');
    assert.deepEqual(events, ['thread', 'turn', 'tmux']);
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
  const fakeTmux = {
    start: async (threadId: string) => {
      events.push(`tmux:${threadId}`);
      return { ok: true };
    },
  } as unknown as TmuxManager;
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  store.setBinding('user', {
    threadId: 'stale-thread',
    cwd: directory,
    tmuxSession: 'codex-stale-thread',
    hasRollout: false,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, fakeTmux, async () => undefined);

  try {
    const result = await manager.send('user', '你好');
    assert.equal(result.accepted, true);
    assert.deepEqual(events, ['turn:stale-thread', 'thread:new', 'turn:new-thread', 'tmux:new-thread']);
    assert.equal(store.getBinding('user')?.threadId, 'new-thread');
    assert.equal(store.getBinding('user')?.hasRollout, true);
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not bind an occupied native session until explicit takeover retries tmux', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-occupied-session-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  let starts = 0;
  let releases = 0;
  const fakeAppServer = {
    onNotification: () => () => undefined,
    resumeThread: async () => ({ id: 'occupied-thread', cwd: directory, status: { type: 'active' } }),
    listThreads: async () => [{ id: 'occupied-thread', cwd: directory, status: { type: 'active' } }],
    close: async () => undefined,
  } as unknown as CodexAppServer;
  const fakeTmux = {
    start: async () => {
      starts += 1;
      return starts % 2 === 1 ? { ok: false, error: 'thread-store conflict: active writer' } : { ok: true };
    },
    releaseNative: async () => {
      releases += 1;
      return { matched: true, stopped: true, pids: [1234] };
    },
  } as unknown as TmuxManager;
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, fakeTmux, async () => undefined);

  try {
    await assert.rejects(
      manager.use('user', 'occupied-thread', directory),
      (error: unknown) => error instanceof SessionOccupiedError && error.running,
    );
    assert.equal(store.getBinding('user'), undefined);

    starts = 0;
    await manager.use('user', 'occupied-thread', directory, {}, true);
    assert.equal(releases, 1);
    assert.equal(starts, 2);
    assert.equal(store.getBinding('user')?.threadId, 'occupied-thread');
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test('releases tmux and App Server ownership before a binding is cancelled', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-release-session-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const events: string[] = [];
  const fakeAppServer = {
    onNotification: () => () => undefined,
    unsubscribe: async (threadId: string) => { events.push(`unsubscribe:${threadId}`); },
    close: async () => undefined,
  } as unknown as CodexAppServer;
  const fakeTmux = {
    interrupt: async () => { events.push('interrupt'); },
    kill: async (session: string, threadId?: string) => { events.push(`kill:${session}:${threadId}`); },
  } as unknown as TmuxManager;
  store.setBinding('user', {
    threadId: 'release-thread',
    cwd: directory,
    tmuxSession: 'codex-release-thread',
    hasRollout: true,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
  const manager = new SessionManager(loadConfig(), store, fakeAppServer, fakeTmux, async () => undefined);

  try {
    await manager.release('user');
    assert.deepEqual(events, ['interrupt', 'unsubscribe:release-thread', 'kill:codex-release-thread:release-thread']);
  } finally {
    await manager.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});
