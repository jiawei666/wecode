import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { BridgeApp } from '../src/bridge.js';
import type { InboundMessage } from '../src/ilink.js';
import type { SessionBinding } from '../src/model.js';
import { SessionManager } from '../src/sessions.js';
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

test('keeps control status/list commands in control mode and selects a compact list by number', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechatbot-bridge-'));
  const store = new StateStore(path.join(directory, 'state.json'));
  await store.init();
  const sent: string[] = [];
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
    store.setControl('user', { startedAt: Date.now(), lastActivityAt: Date.now() });
    await bridge.handle(message('/stat', '1'));
    assert.match(sent.at(-1) || '', /控制 Agent/);
    assert.ok(store.getControl('user'));

    await bridge.handle(message('/sessions', '2'));
    assert.match(sent.at(-1) || '', /1\. \[Codex\]/);
    assert.ok(store.getSelection('user'));
    assert.ok(store.getControl('user'));

    await bridge.handle(message('1', '3'));
    assert.match(sent.at(-1) || '', /已切换 Codex 会话/);
    assert.equal(store.getControl('user'), undefined);
    assert.equal(store.getSelection('user'), undefined);

    await bridge.handle(message('/cancel', '4'));
    assert.equal(store.getBinding('user'), undefined);
  } finally {
    await bridge.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});
