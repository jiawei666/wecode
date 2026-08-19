import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildSessionList, formatModel } from '../src/session-display.js';

test('formats a compact numbered native session list without model or IDs', () => {
  const config = { ...loadConfig(), sessionListLimit: 20 };
  const result = buildSessionList([
    {
      id: '01234567-89ab-cdef-0123-456789abcdef',
      cwd: '/workspace/project',
      preview: '分析桥接层',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
      serviceTier: null,
      updatedAt: Date.now(),
    },
  ], config);
  assert.match(result.text, /1\. project/);
  assert.match(result.text, /分析桥接层/);
  assert.match(result.text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.doesNotMatch(result.text, /gpt-5\.6-luna|max\/normal/);
  assert.doesNotMatch(result.text, /01234567-89ab-cdef-0123-456789abcdef/);
  assert.equal(result.items[0]?.threadId, '01234567-89ab-cdef-0123-456789abcdef');
});

test('normalizes Unix seconds before formatting local session time', () => {
  const config = { ...loadConfig(), sessionListLimit: 5 };
  const result = buildSessionList([
    { id: 'seconds', cwd: '/workspace/agency-cloud-core', preview: '最近一次', updatedAt: 1_700_000_000 },
  ], config);
  assert.doesNotMatch(result.text, /1970/);
  assert.match(result.text, /agency-cloud-core/);
});

test('formats the model, reasoning level, and speed mode together', () => {
  assert.equal(formatModel('gpt-5.6-luna', 'max', null), 'gpt-5.6-luna/max/normal');
  assert.equal(formatModel('gpt-5.6-luna', 'max', 'fast'), 'gpt-5.6-luna/max/fast');
});
