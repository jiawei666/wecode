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
    await assert.rejects(agent.run('test-user', '检查状态'), /小微 exit signal SIGTERM: fake control failure/);
    const args = await readFile(argsPath, 'utf8');
    assert.doesNotMatch(args, /service_tier=null/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('allows explicit local maintenance mode without resetting the control session', () => {
  const instructions = controlInstructions('/workspace', ['/workspace/projects']);
  assert.match(instructions, /本机维护模式/);
  assert.match(instructions, /终端和文件工具/);
  assert.match(instructions, /用 reply 汇报/);
  assert.match(instructions, /历史项目索引/);
  assert.match(instructions, /不要返回会话 thread_id/);
  assert.doesNotMatch(instructions, /分叉|复制历史/);
});

test('keeps the control schema within Codex structured-output support', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/control-action.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  assert.equal('allOf' in schema, false);
  assert.deepEqual(schema.required, ['action', 'cwd', 'limit', 'text']);
  const properties = schema.properties as { action?: { enum?: string[] } };
  assert.deepEqual(properties.action?.enum, ['new_session', 'list_sessions', 'reply', 'ask']);
});

test('validates required fields for control actions after schema parsing', () => {
  assert.deepEqual(parseAction('{"action":"ask","text":"需要目录"}'), { action: 'ask', text: '需要目录' });
  assert.deepEqual(parseAction('{"action":"list_sessions","cwd":"/workspace/core","limit":5,"text":null}'), {
    action: 'list_sessions',
    cwd: '/workspace/core',
    limit: 5,
  });
  assert.deepEqual(parseAction('{"action":"list\\_sessions","cwd":null,"limit":6,"text":null}'), {
    action: 'list_sessions',
    limit: 6,
  });
  assert.deepEqual(parseAction('{"action":"new_session","cwd":"/workspace/core","limit":null,"text":null}'), {
    action: 'new_session',
    cwd: '/workspace/core',
  });
  assert.equal(parseAction('{"action":"list_sessions","cwd":"/workspace/core","limit":0,"text":null}'), null);
  assert.equal(parseAction('{"action":"new_session"}'), null);
  assert.equal(parseAction('{"action":"switch_session","thread_id":"thread"}'), null);
  assert.equal(parseAction('{"action":"fork_session","thread_id":"thread"}'), null);
  assert.equal(parseAction('{"action":"raw_input","text":"hello"}'), null);
  assert.equal(parseAction('{"action":"unknown"}'), null);
});

test('allows list requests without a model-generated display body', () => {
  assert.deepEqual(parseAction('{"action":"list_sessions","cwd":null,"limit":5,"text":null}'), {
    action: 'list_sessions',
    limit: 5,
  });
});

test('accepts nullable optional fields emitted by the structured action schema', () => {
  const raw = JSON.stringify({
    action: 'list_sessions',
    cwd: '/home/yuanjiawei/AIProject/wecode',
    limit: 5,
    text: null,
  });
  assert.deepEqual(parseAction(raw), {
    action: 'list_sessions',
    cwd: '/home/yuanjiawei/AIProject/wecode',
    limit: 5,
  });
});
