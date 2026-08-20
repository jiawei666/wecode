import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeCommand } from '../src/commands.js';

test('parses control, local fallback, and Chinese command aliases', () => {
  assert.deepEqual(parseBridgeCommand('/ctrl 找到我的项目'), { kind: 'control', text: '找到我的项目' });
  assert.deepEqual(parseBridgeCommand('/控制 找到我的项目'), { kind: 'control', text: '找到我的项目' });
  assert.deepEqual(parseBridgeCommand('菜单'), { kind: 'menu' });
  assert.deepEqual(parseBridgeCommand('操作：状态'), { kind: 'status' });
  assert.deepEqual(parseBridgeCommand('控制：帮我切换到 web 项目'), { kind: 'control', text: '帮我切换到 web 项目' });
  assert.deepEqual(parseBridgeCommand('状态'), { kind: 'status' });
  assert.deepEqual(parseBridgeCommand('新建 /workspace/project'), { kind: 'new', cwd: '/workspace/project' });
  assert.deepEqual(parseBridgeCommand('切换 2'), { kind: 'use', threadId: '2' });
  assert.deepEqual(parseBridgeCommand('操作：切换 web-project'), { kind: 'use', threadId: 'web-project' });
  assert.deepEqual(parseBridgeCommand('帅哥，帮我找历史会话'), { kind: 'control', text: '帮我找历史会话' });
  assert.deepEqual(parseBridgeCommand('靓仔 列出最近会话'), { kind: 'control', text: '列出最近会话' });
  assert.deepEqual(parseBridgeCommand('哥哥'), { kind: 'control', text: '' });
  assert.deepEqual(parseBridgeCommand('/new /workspace/project --model gpt-5.6-luna --no-fast'), {
    kind: 'new',
    cwd: '/workspace/project',
    model: 'gpt-5.6-luna',
    fast: false,
  });
  assert.deepEqual(parseBridgeCommand('/新建 /workspace/project'), { kind: 'new', cwd: '/workspace/project' });
  assert.deepEqual(parseBridgeCommand('/use thread-123'), { kind: 'use', threadId: 'thread-123' });
  assert.deepEqual(parseBridgeCommand('/切换 第 2 个'), { kind: 'use', threadId: '第 2 个' });
  assert.deepEqual(parseBridgeCommand('/sessions full'), { kind: 'sessions', scope: 'full' });
  assert.deepEqual(parseBridgeCommand('/会话 当前'), { kind: 'sessions', scope: 'here' });
  assert.deepEqual(parseBridgeCommand('/back'), { kind: 'back' });
  assert.deepEqual(parseBridgeCommand('/返回'), { kind: 'back' });
  assert.deepEqual(parseBridgeCommand('/stat'), { kind: 'status' });
  assert.deepEqual(parseBridgeCommand('/状态'), { kind: 'status' });
  assert.deepEqual(parseBridgeCommand('/stop'), { kind: 'stop' });
  assert.deepEqual(parseBridgeCommand('/停止'), { kind: 'stop' });
  assert.deepEqual(parseBridgeCommand('/q'), { kind: 'cancel' });
  assert.deepEqual(parseBridgeCommand('/取消'), { kind: 'cancel' });
  assert.deepEqual(parseBridgeCommand('/帮助'), { kind: 'help' });
  assert.deepEqual(parseBridgeCommand('/raw hello'), { kind: 'help' });
  assert.deepEqual(parseBridgeCommand('/操作 状态'), { kind: 'status' });
  assert.equal(parseBridgeCommand('帮我新建一个会话'), null);
  assert.equal(parseBridgeCommand('帮我切换到 web 项目'), null);
  assert.equal(parseBridgeCommand('2'), null);
  assert.equal(parseBridgeCommand('普通消息'), null);
  assert.equal(parseBridgeCommand('项目里的帅哥变量'), null);
});
