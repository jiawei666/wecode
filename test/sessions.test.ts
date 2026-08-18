import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { CodexAppServer } from '../src/codex.js';
import { inferTurnPresentation, SessionManager } from '../src/sessions.js';
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
