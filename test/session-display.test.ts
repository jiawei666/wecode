import test from 'node:test';
import assert from 'node:assert/strict';
import { formatModel, formatTimestamp } from '../src/session-display.js';

test('normalizes Unix seconds before formatting local session time', () => {
  const result = formatTimestamp(1_700_000_000);
  assert.doesNotMatch(result, /1970/);
  assert.match(result, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

test('formats the model, reasoning level, and speed mode together', () => {
  assert.equal(formatModel('gpt-5.6-luna', 'max', null), 'gpt-5.6-luna/max/normal');
  assert.equal(formatModel('gpt-5.6-luna', 'max', 'fast'), 'gpt-5.6-luna/max/fast');
});
