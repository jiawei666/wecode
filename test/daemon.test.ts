import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { backgroundArguments, daemonPaths, stopDaemon } from '../src/daemon.js';

test('removes lifecycle commands before starting the background bridge', () => {
  assert.deepEqual(
    backgroundArguments(['/usr/bin/node', '/workspace/wecode/src/index.ts', 'restart', '--background', '--trace-warnings']),
    ['/workspace/wecode/src/index.ts', '--trace-warnings', '--background'],
  );
});

test('stops a detached Wecode process group so its App Server child releases the thread lock', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Windows stops the daemon through taskkill process-tree handling');
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'wecode-daemon-stop-'));
  const daemonScript = path.join(directory, 'wecode-daemon-fixture.js');
  const childPidFile = path.join(directory, 'app-server.pid');
  const childReadyFile = path.join(directory, 'app-server.ready');
  const childStoppedFile = path.join(directory, 'app-server.stopped');
  const config = { ...loadConfig(), dataDir: directory };
  let daemon: ReturnType<typeof spawn> | undefined;

  try {
    const childCode = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(childStoppedFile)}, 'stopped');
        process.exit(0);
      });
      fs.writeFileSync(${JSON.stringify(childReadyFile)}, 'ready');
      setInterval(() => {}, 1000);
    `;
    await writeFile(daemonScript, `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    daemon = spawn(process.execPath, [daemonScript], { detached: true, stdio: 'ignore' });
    const daemonPid = await new Promise<number>((resolve, reject) => {
      daemon?.once('error', reject);
      daemon?.once('spawn', () => resolve(daemon?.pid as number));
    });

    let childPidText = '';
    for (let attempt = 0; attempt < 100 && !childPidText; attempt += 1) {
      childPidText = await readFile(childPidFile, 'utf8').catch(() => '');
      if (!childPidText) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const childPid = Number(childPidText);
    assert.ok(Number.isInteger(childPid) && childPid > 0, 'fixture App Server child should start');
    let childReady = false;
    for (let attempt = 0; attempt < 100 && !childReady; attempt += 1) {
      await access(childReadyFile).then(() => { childReady = true; }, () => undefined);
      if (!childReady) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(childReady, true, 'fixture App Server child should register its signal handler');
    await writeFile(daemonPaths(config).pidFile, JSON.stringify({ pid: daemonPid }));

    assert.equal(await stopDaemon(config), true);

    let childStopped = false;
    for (let attempt = 0; attempt < 100 && !childStopped; attempt += 1) {
      await access(childStoppedFile).then(() => { childStopped = true; }, () => undefined);
      if (!childStopped) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(childStopped, true, `App Server child ${childPid} should receive the daemon stop signal`);
  } finally {
    if (daemon?.pid) {
      try {
        process.kill(-daemon.pid, 'SIGKILL');
      } catch {
        // The fixture process group has already exited.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses Windows taskkill tree handling to stop the Wecode App Server child', async (context) => {
  if (process.platform === 'win32') {
    context.skip('this test emulates taskkill with POSIX executable stubs');
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'wecode-windows-daemon-stop-'));
  const toolsDirectory = path.join(directory, 'tools');
  const daemonScript = path.join(directory, 'wecode-daemon-fixture.js');
  const childPidFile = path.join(directory, 'app-server.pid');
  const childStoppedFile = path.join(directory, 'app-server.stopped');
  const powershell = path.join(toolsDirectory, 'powershell.exe');
  const taskkill = path.join(toolsDirectory, 'taskkill.exe');
  const taskkillLog = path.join(directory, 'taskkill.log');
  const config = { ...loadConfig(), dataDir: directory };
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalPath = process.env.PATH;
  const originalTaskkillLog = process.env.WECODE_TEST_TASKKILL_LOG;
  let daemon: ReturnType<typeof spawn> | undefined;

  try {
    await mkdir(toolsDirectory);
    await writeFile(powershell, `#!/usr/bin/env node
process.stdout.write('C:\\\\wecode.exe --background\\n');
`);
    await writeFile(taskkill, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.WECODE_TEST_TASKKILL_LOG, JSON.stringify(args) + '\\n');
const pid = Number(args[args.indexOf('/PID') + 1]);
try { process.kill(-pid, args.includes('/F') ? 'SIGKILL' : 'SIGTERM'); } catch {}
`);
    await chmod(powershell, 0o755);
    await chmod(taskkill, 0o755);
    const childCode = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(childStoppedFile)}, 'stopped');
        process.exit(0);
      });
      setInterval(() => {}, 1000);
    `;
    await writeFile(daemonScript, `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    daemon = spawn(process.execPath, [daemonScript], { detached: true, stdio: 'ignore' });
    const daemonPid = await new Promise<number>((resolve, reject) => {
      daemon?.once('error', reject);
      daemon?.once('spawn', () => resolve(daemon?.pid as number));
    });
    let childPidText = '';
    for (let attempt = 0; attempt < 100 && !childPidText; attempt += 1) {
      childPidText = await readFile(childPidFile, 'utf8').catch(() => '');
      if (!childPidText) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const childPid = Number(childPidText);
    assert.ok(Number.isInteger(childPid) && childPid > 0, 'fixture App Server child should start');
    await writeFile(daemonPaths(config).pidFile, JSON.stringify({ pid: daemonPid }));

    process.env.PATH = `${toolsDirectory}${path.delimiter}${originalPath || ''}`;
    process.env.WECODE_TEST_TASKKILL_LOG = taskkillLog;
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });

    assert.equal(await stopDaemon(config), true);
    await access(childStoppedFile);
    const commands = (await readFile(taskkillLog, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(commands, [['/PID', String(daemonPid), '/T']]);
  } finally {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTaskkillLog === undefined) delete process.env.WECODE_TEST_TASKKILL_LOG;
    else process.env.WECODE_TEST_TASKKILL_LOG = originalTaskkillLog;
    if (daemon?.pid) {
      try {
        process.kill(-daemon.pid, 'SIGKILL');
      } catch {
        // The fixture process group has already exited.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
