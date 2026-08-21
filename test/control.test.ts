import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAction } from '../src/control.js';

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
});

test('validates required fields for control actions after schema parsing', () => {
  assert.deepEqual(parseAction('{"action":"ask","text":"需要目录"}'), { action: 'ask', text: '需要目录' });
  assert.deepEqual(parseAction('{"action":"list_sessions","cwd":"/workspace/core","limit":5,"text":"## 最近 5 个会话"}'), {
    action: 'list_sessions',
    cwd: '/workspace/core',
    limit: 5,
    text: '## 最近 5 个会话',
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
