import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { ControlAgent, controlInstructions, parseAction } from '../src/control.js';

test('omits a null service tier and reports the signal that ended the control Agent', async (context) => {
  if (process.platform === 'win32') {
    context.skip('the fake CLI terminates itself with a POSIX signal');
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'wecode-control-signal-'));
  const command = path.join(directory, 'fake-codex');
  const argsPath = path.join(directory, 'args.txt');
  const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

  try {
    const script = [
      '#!/bin/sh',
      'cat >/dev/null',
      `printf '%s\\n' "$@" > ${quoteShell(argsPath)}`,
      "printf 'fake control failure\\n' >&2",
      'kill -TERM $$',
      '',
    ].join('\n');
    await writeFile(command, script);
    await chmod(command, 0o755);

    const agent = new ControlAgent({
      ...loadConfig(),
      codexCommand: command,
      dataDir: directory,
      homeDir: directory,
      searchRoots: [],
      controlTimeoutMs: 5_000,
    });
    await assert.rejects(agent.run('test-user', '检查状态'), /会话管理 Agent exit signal SIGTERM: fake control failure/);
    const args = await readFile(argsPath, 'utf8');
    assert.doesNotMatch(args, /service_tier=null/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('allows explicit local maintenance mode without resetting the control session', () => {
  const instructions = controlInstructions('/workspace', ['/workspace/projects']);
  assert.match(instructions, /本机维护模式/);
  assert.match(instructions, /终端、文件和进程工具/);
  assert.match(instructions, /不要主动清除或重建会话管理 Agent 的 Codex 会话/);
  assert.match(instructions, /action=reply/);
  assert.match(instructions, /查看最近任务/);
  assert.match(instructions, /只读查看/);
  assert.match(instructions, /不要写成长段/);
});

test('keeps the control schema within Codex structured-output support', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/control-action.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  assert.equal('allOf' in schema, false);
  assert.deepEqual(schema.required, [
    'action',
    'cli',
    'cwd',
    'thread_id',
    'limit',
    'text',
    'title',
    'model',
    'reasoning_effort',
    'fast',
    'takeover',
    'note',
    'presentation',
    'reason',
  ]);
  const properties = schema.properties as { action?: { enum?: string[] } };
  assert.ok(properties.action?.enum?.includes('request_catalog'));
});

test('validates required fields for control actions after schema parsing', () => {
  assert.deepEqual(parseAction('{"action":"ask","text":"需要目录"}'), { action: 'ask', text: '需要目录' });
  assert.deepEqual(parseAction('{"action":"request_catalog"}'), { action: 'request_catalog' });
  assert.deepEqual(parseAction('{"action":"list_sessions","cwd":"/workspace/core","limit":5,"text":"## 最近 5 个会话"}'), {
    action: 'list_sessions',
    cwd: '/workspace/core',
    limit: 5,
    text: '## 最近 5 个会话',
  });
  assert.deepEqual(parseAction('{"action":"list\\_sessions","cwd":null,"limit":6,"text":"## 最近 6 个会话"}'), {
    action: 'list_sessions',
    limit: 6,
    text: '## 最近 6 个会话',
  });
  assert.deepEqual(parseAction('{"action":"fork_session","thread_id":"source-thread"}'), {
    action: 'fork_session',
    thread_id: 'source-thread',
  });
  assert.equal(parseAction('{"action":"list_sessions","cwd":"/workspace/core","limit":0,"text":"列表"}'), null);
  assert.equal(parseAction('{"action":"new_session"}'), null);
  assert.equal(parseAction('{"action":"raw_input","text":"hello"}'), null);
  assert.equal(parseAction('{"action":"unknown"}'), null);
});

test('rejects a session list without a limit or display text', () => {
  assert.equal(parseAction('{"action":"list_sessions","cwd":null,"text":"列表"}'), null);
  assert.equal(parseAction('{"action":"list_sessions","cwd":null,"limit":5}'), null);
});

test('accepts nullable optional fields emitted by the structured action schema', () => {
  const raw = JSON.stringify({
    action: 'list_sessions',
    cli: 'codex',
    cwd: '/home/yuanjiawei/AIProject/wecode',
    thread_id: null,
    limit: 5,
    text: '1. wecode · 摘要 · 2026-08-19 14:09',
    title: null,
    model: null,
    reasoning_effort: null,
    fast: null,
    takeover: null,
    note: null,
    presentation: 'chat',
    reason: null,
  });
  assert.deepEqual(parseAction(raw), {
    action: 'list_sessions',
    cli: 'codex',
    cwd: '/home/yuanjiawei/AIProject/wecode',
    limit: 5,
    text: '1. wecode · 摘要 · 2026-08-19 14:09',
    presentation: 'chat',
  });
});
