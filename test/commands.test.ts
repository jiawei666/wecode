import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeCommand } from '../src/commands.js';

test('keeps only deterministic local commands and honorific wake words', () => {
  assert.deepEqual(parseBridgeCommand('状态'), { kind: 'status' });
  assert.deepEqual(parseBridgeCommand('停止'), { kind: 'stop' });
  assert.deepEqual(parseBridgeCommand('退出'), { kind: 'exit' });
  assert.deepEqual(parseBridgeCommand('帮助'), { kind: 'help' });

  assert.deepEqual(parseBridgeCommand('帅哥，帮我切换到 web 项目'), {
    kind: 'control',
    text: '帮我切换到 web 项目',
  });
  assert.deepEqual(parseBridgeCommand('靓仔 帮我新建一个会话'), {
    kind: 'control',
    text: '帮我新建一个会话',
  });
  assert.deepEqual(parseBridgeCommand('小哥哥'), { kind: 'control', text: '' });
  for (const wakeWord of ['哥哥', '大哥', '老哥']) {
    assert.deepEqual(parseBridgeCommand(`${wakeWord}，帮我查看历史`), {
      kind: 'control',
      text: '帮我查看历史',
    });
  }
});

test('does not reserve natural-language session operations or legacy aliases locally', () => {
  assert.equal(parseBridgeCommand('菜单'), null);
  assert.equal(parseBridgeCommand('新建 /workspace/project'), null);
  assert.equal(parseBridgeCommand('切换 2'), null);
  assert.equal(parseBridgeCommand('控制：帮我切换'), null);
  assert.equal(parseBridgeCommand('控制A 帮我切换'), null);
  assert.equal(parseBridgeCommand('/status'), null);
  assert.equal(parseBridgeCommand('/stop'), null);
  assert.equal(parseBridgeCommand('/exit'), null);
  assert.equal(parseBridgeCommand('/help'), null);
  assert.equal(parseBridgeCommand('/ctrl 帮我切换'), null);
  assert.equal(parseBridgeCommand('/new /workspace/project'), null);
  assert.equal(parseBridgeCommand('/sessions'), null);
  assert.equal(parseBridgeCommand('/状态'), null);
  assert.equal(parseBridgeCommand('/取消'), null);
  assert.equal(parseBridgeCommand('/raw hello'), null);
  assert.equal(parseBridgeCommand('项目里的帅哥变量'), null);
});
