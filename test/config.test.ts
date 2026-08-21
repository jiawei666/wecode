import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { backgroundArguments, daemonPaths } from '../src/daemon.js';

test('resolves machine-specific paths and model settings from the supplied environment', () => {
  const filesystemRoot = path.parse(process.cwd()).root;
  const projectRoot = path.join(filesystemRoot, 'workspace', 'wechatbot');
  const exampleHome = path.join(filesystemRoot, 'tmp', 'example-home');
  const sharedRoot = path.join(filesystemRoot, 'srv', 'shared');
  const config = loadConfig({
    WECHATBOT_DATA_DIR: '.runtime-data',
    WECHATBOT_HOME: exampleHome,
    WECHATBOT_SEARCH_ROOTS: `projects, ${sharedRoot}`,
    WECHATBOT_DEFAULT_CWD: 'projects/demo',
    CODEX_MODEL: 'portable-model',
    CODEX_REASONING_EFFORT: 'high',
    CONTROL_MODEL: 'control-model',
    CONTROL_REASONING_EFFORT: 'medium',
  }, projectRoot, { configFile: path.join(projectRoot, '.config-test-missing.json') });

  assert.equal(config.dataDir, path.join(projectRoot, '.runtime-data'));
  assert.equal(config.homeDir, exampleHome);
  assert.deepEqual(config.searchRoots, [path.join(projectRoot, 'projects'), sharedRoot]);
  assert.equal(config.defaultCwd, path.join(projectRoot, 'projects/demo'));
  assert.equal(config.codexModel, 'portable-model');
  assert.equal(config.codexReasoningEffort, 'high');
  assert.equal(config.controlModel, 'control-model');
  assert.equal(config.controlReasoningEffort, 'medium');
});

test('uses the repository directory as the portable discovery default', () => {
  const projectRoot = path.join(path.parse(process.cwd()).root, 'workspace', 'wechatbot');
  const config = loadConfig({}, projectRoot, { configFile: path.join(projectRoot, '.config-test-missing.json') });

  assert.deepEqual(config.searchRoots, [projectRoot]);
  assert.equal(config.defaultCwd, projectRoot);
});

test('reads the small user config file without requiring environment variables', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'wecode-config-'));
  const configFile = path.join(home, '.wecode', 'config.json');
  const projectRoot = path.join(path.parse(process.cwd()).root, 'workspace', 'wechatbot');
  const defaultCwd = path.join(path.parse(process.cwd()).root, 'workspace', 'projects', 'demo');
  const searchRoot = path.join(path.parse(process.cwd()).root, 'workspace', 'projects');
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({
    version: 1,
    defaultCwd,
    searchRoots: [searchRoot],
    allowedUser: 'wx-user',
  }));

  const config = loadConfig({}, projectRoot, { userHome: home });

  assert.equal(config.configFile, configFile);
  assert.equal(config.dataDir, path.join(home, '.wecode'));
  assert.equal(config.defaultCwd, defaultCwd);
  assert.deepEqual(config.searchRoots, [searchRoot]);
  assert.equal(config.allowedUser, 'wx-user');
});

test('prepares a detached invocation without replaying login commands', () => {
  assert.deepEqual(
    backgroundArguments(['/usr/bin/node', '/opt/wecode/index.js', 'login', '--background']),
    ['/opt/wecode/index.js', '--background'],
  );
});

test('stores daemon runtime files beside the user state', () => {
  const userHome = path.join(path.parse(process.cwd()).root, 'tmp', 'wecode-home');
  const config = loadConfig({}, path.join(path.parse(process.cwd()).root, 'workspace', 'wecode'), { userHome });
  assert.deepEqual(daemonPaths(config), {
    pidFile: path.join(userHome, '.wecode', 'wecode.pid'),
    logFile: path.join(userHome, '.wecode', 'wecode.log'),
  });
});
