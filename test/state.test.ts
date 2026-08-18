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

test('persists binding history, notes, and numbered selections', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-state-extra-'));
  const file = path.join(directory, 'state.json');
  try {
    const store = new StateStore(file);
    await store.init();
    const binding = {
      threadId: 'thread-a',
      cwd: directory,
      tmuxSession: 'codex-thread-a',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    store.setBinding('user', binding);
    store.pushBindingHistory('user', { ...binding, threadId: 'thread-b' }, 5);
    store.setSessionNote('thread-a', '登录问题排查');
    store.setSelection('user', { createdAt: Date.now(), expiresAt: Date.now() + 60_000, items: [{ cli: 'codex', threadId: 'thread-a', cwd: directory }] });
    await store.save();

    const restored = new StateStore(file);
    await restored.init();
    assert.equal(restored.getBindingHistory('user')[0]?.threadId, 'thread-b');
    assert.equal(restored.getSessionNote('thread-a'), '登录问题排查');
    assert.equal(restored.getSelection('user')?.items[0]?.threadId, 'thread-a');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
