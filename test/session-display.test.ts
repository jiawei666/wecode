import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildSessionList, formatModel, formatTimestamp } from '../src/session-display.js';

test('builds a compact local fallback list with selectable items', () => {
  const result = buildSessionList([
    { id: 'thread-a', cwd: '/workspace/project', preview: '分析桥接层', updatedAt: 1_700_000_000, cli: 'codex' },
  ], { ...loadConfig(), sessionListLimit: 5 });
  assert.match(result.text, /1\. project/);
  assert.match(result.text, /分析桥接层/);
  assert.match(result.text, /回复序号切换/);
  assert.equal(result.items[0]?.threadId, 'thread-a');
});

test('normalizes Unix seconds before formatting local session time', () => {
  const result = formatTimestamp(1_700_000_000);
  assert.doesNotMatch(result, /1970/);
  assert.match(result, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

test('formats the model, reasoning level, and speed mode together', () => {
  assert.equal(formatModel('gpt-5.6-luna', 'max', null), 'gpt-5.6-luna/max/normal');
  assert.equal(formatModel('gpt-5.6-luna', 'max', 'fast'), 'gpt-5.6-luna/max/fast');
});
