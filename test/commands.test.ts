import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeCommand } from '../src/commands.js';

test('parses the compact bridge commands', () => {
  assert.deepEqual(parseBridgeCommand('/ctrl 找到我的项目'), { kind: 'control', text: '找到我的项目' });
  assert.deepEqual(parseBridgeCommand('/new /workspace/project'), { kind: 'new', cwd: '/workspace/project' });
  assert.deepEqual(parseBridgeCommand('/use thread-123'), { kind: 'use', threadId: 'thread-123' });
  assert.deepEqual(parseBridgeCommand('/new /workspace/project --model gpt-5.6-luna --no-fast'), {
    kind: 'new',
    cwd: '/workspace/project',
    model: 'gpt-5.6-luna',
    fast: false,
  });
  assert.deepEqual(parseBridgeCommand('/sessions full'), { kind: 'sessions', scope: 'full' });
  assert.deepEqual(parseBridgeCommand('/back'), { kind: 'back' });
  assert.deepEqual(parseBridgeCommand('/stat'), { kind: 'status' });
  assert.deepEqual(parseBridgeCommand('/stop'), { kind: 'stop' });
  assert.deepEqual(parseBridgeCommand('/q'), { kind: 'cancel' });
  assert.equal(parseBridgeCommand('普通消息'), null);
});
