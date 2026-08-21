import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

test('reads the small user config file without requiring environment variables', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'wecode-config-'));
  const configFile = path.join(home, '.wecode', 'config.json');
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({
    version: 1,
    defaultCwd: '/workspace/projects/demo',
    searchRoots: ['/workspace/projects'],
    allowedUser: 'wx-user',
  }));

  const config = loadConfig({}, '/workspace/wechatbot', { userHome: home });

  assert.equal(config.configFile, configFile);
  assert.equal(config.dataDir, path.join(home, '.wecode'));
  assert.equal(config.defaultCwd, '/workspace/projects/demo');
  assert.deepEqual(config.searchRoots, ['/workspace/projects']);
  assert.equal(config.allowedUser, 'wx-user');
});
