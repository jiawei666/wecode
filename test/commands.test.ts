import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeCommand } from '../src/commands.js';

test('keeps only deterministic status, stop, and exit commands', () => {
  assert.deepEqual(parseBridgeCommand('状态'), { kind: 'status' });
  assert.deepEqual(parseBridgeCommand('停止'), { kind: 'stop' });
  assert.deepEqual(parseBridgeCommand('退出'), { kind: 'exit' });
  assert.equal(parseBridgeCommand('帮助'), null);
  assert.equal(parseBridgeCommand('列出最近 5 个会话'), null);
  assert.equal(parseBridgeCommand('查看活动'), null);
  assert.equal(parseBridgeCommand('分叉'), null);
});

test('supports Xiaowei wake words and common speech-to-text variants', () => {
  assert.deepEqual(parseBridgeCommand('小微，帮我在 wecode 新建会话'), {
    kind: 'control',
    text: '帮我在 wecode 新建会话',
  });
  assert.deepEqual(parseBridgeCommand('小微 帮我查找会话'), {
    kind: 'control',
    text: '帮我查找会话',
  });
  assert.deepEqual(parseBridgeCommand('小威呀'), { kind: 'control', text: '' });
  for (const wakeWord of ['小薇', '小唯', '小伟', '小巍', '晓薇', '晓微', '晓威', '晓唯', '晓伟', '小 薇']) {
    assert.deepEqual(parseBridgeCommand(`${wakeWord}，帮我查看历史`), {
      kind: 'control',
      text: '帮我查看历史',
    });
  }
  assert.equal(parseBridgeCommand('帅哥，帮我查看历史'), null);
  assert.equal(parseBridgeCommand('靓仔，帮我查看历史'), null);
});

test('does not reserve natural-language session operations locally', () => {
  assert.equal(parseBridgeCommand('新建 /workspace/project'), null);
  assert.equal(parseBridgeCommand('切换 2'), null);
  assert.equal(parseBridgeCommand('/status'), null);
  assert.equal(parseBridgeCommand('项目里的小微变量'), null);
});
