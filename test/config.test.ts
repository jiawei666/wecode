import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('resolves machine-specific paths and model settings from the supplied environment', () => {
  const projectRoot = '/workspace/wechatbot';
  const config = loadConfig({
    WECHATBOT_DATA_DIR: '.runtime-data',
    WECHATBOT_HOME: '/tmp/example-home',
    WECHATBOT_SEARCH_ROOTS: 'projects, /srv/shared',
    WECHATBOT_DEFAULT_CWD: 'projects/demo',
    CODEX_MODEL: 'portable-model',
    CODEX_REASONING_EFFORT: 'high',
    CONTROL_MODEL: 'control-model',
    CONTROL_REASONING_EFFORT: 'medium',
  }, projectRoot);

  assert.equal(config.dataDir, path.join(projectRoot, '.runtime-data'));
  assert.equal(config.homeDir, '/tmp/example-home');
  assert.deepEqual(config.searchRoots, [path.join(projectRoot, 'projects'), '/srv/shared']);
  assert.equal(config.defaultCwd, path.join(projectRoot, 'projects/demo'));
  assert.equal(config.codexModel, 'portable-model');
  assert.equal(config.codexReasoningEffort, 'high');
  assert.equal(config.controlModel, 'control-model');
  assert.equal(config.controlReasoningEffort, 'medium');
});

test('uses the repository directory as the portable discovery default', () => {
  const projectRoot = '/workspace/wechatbot';
  const config = loadConfig({}, projectRoot);

  assert.deepEqual(config.searchRoots, [projectRoot]);
  assert.equal(config.defaultCwd, projectRoot);
});
