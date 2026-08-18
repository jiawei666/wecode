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
    'text',
    'title',
    'model',
    'reasoning_effort',
    'fast',
    'note',
    'presentation',
    'reason',
  ]);
});

test('validates required fields for control actions after schema parsing', () => {
  assert.deepEqual(parseAction('{"action":"ask","text":"需要目录"}'), { action: 'ask', text: '需要目录' });
  assert.equal(parseAction('{"action":"new_session"}'), null);
  assert.equal(parseAction('{"action":"unknown"}'), null);
});
