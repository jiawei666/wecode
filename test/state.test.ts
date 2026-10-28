import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';

test('persists rapid consecutive state updates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-state-'));
  const file = path.join(directory, 'state.json');
  try {
    const store = new StateStore(file);
    await store.init();
    store.update((state) => { state.token = 'token'; });
    store.update((state) => { state.botId = 'bot'; });
    await store.save();

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { token?: string; botId?: string };
    assert.equal(persisted.token, 'token');
    assert.equal(persisted.botId, 'bot');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists the pending welcome state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-state-welcome-'));
  const file = path.join(directory, 'state.json');
  try {
    const store = new StateStore(file);
    await store.init();
    store.update((state) => { state.welcomePending = true; });
    await store.save();

    const restored = new StateStore(file);
    await restored.init();
    assert.equal(restored.get().welcomePending, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists binding history and notes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-state-extra-'));
  const file = path.join(directory, 'state.json');
  try {
    const store = new StateStore(file);
    await store.init();
    const binding = {
      threadId: 'thread-a',
      cwd: directory,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    store.setBinding('user', binding);
    store.pushBindingHistory('user', { ...binding, threadId: 'thread-b' }, 5);
    store.setSessionNote('thread-a', '登录问题排查');
    await store.save();

    const restored = new StateStore(file);
    await restored.init();
    assert.equal(restored.getBindingHistory('user')[0]?.threadId, 'thread-b');
    assert.equal(restored.getSessionNote('thread-a'), '登录问题排查');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('clears active login state while preserving history and notes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-state-login-'));
  const file = path.join(directory, 'state.json');
  try {
    const store = new StateStore(file);
    await store.init();
    const previous = {
      threadId: 'thread-previous',
      cwd: directory,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    store.setBinding('user', previous);
    store.setControl('user', { startedAt: Date.now(), lastActivityAt: Date.now() });
    store.setSessionNote('thread-previous', '保留会话备注');
    store.update((state) => {
      state.contextTokens.user = 'old-context';
      state.pendingReplies.user = [{ text: '旧回复', options: {}, attempts: 1 }];
    });

    store.prepareForLogin(5);

    assert.deepEqual(store.get().bindings, {});
    assert.deepEqual(store.get().controls, {});
    assert.deepEqual(store.get().contextTokens, {});
    assert.deepEqual(store.get().pendingReplies, {});
    assert.equal(store.getBindingHistory('user')[0]?.threadId, previous.threadId);
    assert.equal(store.getSessionNote('thread-previous'), '保留会话备注');
    await store.save();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
