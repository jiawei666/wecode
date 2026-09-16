import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.js';
import { CodexAppServer } from '../src/codex.js';
import { buildWindowsCommandLine } from '../src/process.js';
import { SessionManager } from '../src/sessions.js';
import { StateStore } from '../src/state.js';


test('quotes Windows Codex command paths and arguments', () => {
  assert.equal(
    buildWindowsCommandLine('C:\\Program Files\\nodejs\\codex.cmd', ['app-server', '-C', 'C:\\Users\\Test User\\project']),
    '"C:\\Program Files\\nodejs\\codex.cmd" app-server -C "C:\\Users\\Test User\\project"',
  );
});

test('sends the current Codex sandbox enum to thread/start', async () => {
  const httpServer = createServer((request, response) => {
    if (request.url === '/readyz') {
      response.writeHead(200);
      response.end('ok');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const websocketServer = new WebSocketServer({ server: httpServer });
  let params: Record<string, unknown> | undefined;
  let forkParams: Record<string, unknown> | undefined;
  let resumeParams: Record<string, unknown> | undefined;
  let listParams: Record<string, unknown> | undefined;
  let turnParams: Record<string, unknown> | undefined;
  let readParams: Record<string, unknown> | undefined;
  let steerParams: Record<string, unknown> | undefined;
  websocketServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.method === 'initialize' && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/start' && message.id !== undefined) {
        params = message.params;
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'test-thread' } } }));
      } else if (message.method === 'thread/fork' && message.id !== undefined) {
        forkParams = message.params;
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'forked-thread', cwd: '/workspace/project' } } }));
      } else if (message.method === 'thread/resume' && message.id !== undefined) {
        resumeParams = message.params;
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'test-thread' } } }));
      } else if (message.method === 'thread/list' && message.id !== undefined) {
        listParams = message.params;
        socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
      } else if (message.method === 'thread/read' && message.id !== undefined) {
        readParams = message.params;
        socket.send(JSON.stringify({
          id: message.id,
          result: { thread: { id: 'test-thread', status: { type: 'active' }, turns: [{ id: 'turn-1', status: 'inProgress' }] } },
        }));
      } else if (message.method === 'turn/start' && message.id !== undefined) {
        turnParams = message.params;
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } }));
      } else if (message.method === 'turn/steer' && message.id !== undefined) {
        steerParams = message.params;
        socket.send(JSON.stringify({ id: message.id, result: { turnId: 'turn-1' } }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('test server did not expose a port');

  const appServer = new CodexAppServer({ ...loadConfig(), codexEndpoint: `ws://127.0.0.1:${address.port}` });
  try {
    await appServer.startThread('/workspace/project');
    assert.equal(params?.sandbox, 'danger-full-access');
    assert.equal(params?.serviceTier, null);
    assert.equal(params?.model, undefined);
    assert.equal((params?.config as Record<string, unknown>).model_reasoning_effort, undefined);
    assert.equal((params?.config as Record<string, unknown>).model_reasoning_summary, 'detailed');
    assert.deepEqual((params?.config as Record<string, unknown>).service_tier, null);
    const forked = await appServer.forkThread('source-thread');
    assert.equal(forked.id, 'forked-thread');
    assert.equal(forkParams?.threadId, 'source-thread');
    assert.equal((forkParams?.config as Record<string, unknown>).model_reasoning_effort, undefined);
    assert.equal((forkParams?.config as Record<string, unknown>).model_reasoning_summary, 'detailed');
    const resumed = await appServer.resumeThread('test-thread');
    assert.equal(resumed.id, 'test-thread');
    assert.equal((resumeParams?.config as Record<string, unknown>).model_reasoning_summary, 'detailed');
    assert.deepEqual(await appServer.listThreads(undefined, 5), []);
    assert.equal(listParams?.archived, false);
    const snapshot = await appServer.readThread('test-thread');
    assert.equal(readParams?.threadId, 'test-thread');
    assert.equal(readParams?.includeTurns, true);
    assert.equal(snapshot.turns?.[0]?.id, 'turn-1');
    assert.equal(await appServer.startTurn('test-thread', '/workspace/project', '看看这张图', {}, ['/tmp/wecode-image.jpg']), 'turn-1');
    assert.deepEqual(turnParams?.input, [
      { type: 'text', text: '看看这张图' },
      { type: 'localImage', path: '/tmp/wecode-image.jpg' },
    ]);
    assert.equal(turnParams?.summary, 'detailed');
    assert.equal(await appServer.steerTurn('test-thread', 'turn-1', '补充要求', ['/tmp/wecode-image-2.png']), 'turn-1');
    assert.equal(steerParams?.threadId, 'test-thread');
    assert.equal(steerParams?.expectedTurnId, 'turn-1');
    assert.deepEqual(steerParams?.input, [
      { type: 'text', text: '补充要求' },
      { type: 'localImage', path: '/tmp/wecode-image-2.png' },
    ]);
  } finally {
    await appServer.close();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

test('reports a missing Codex executable instead of crashing on spawn error', async () => {
  const appServer = new CodexAppServer({
    ...loadConfig(),
    codexCommand: 'wecode-test-missing-codex-command',
    codexEndpoint: 'ws://127.0.0.1:1',
  });

  await assert.rejects(
    () => appServer.startThread('/workspace/project'),
    /找不到 Codex CLI|Codex CLI.*PATH/i,
  );
  await appServer.close();
});

test('reconnects after the Codex App Server socket closes', async () => {
  const httpServer = createServer((request, response) => {
    if (request.url === '/readyz') {
      response.writeHead(200);
      response.end('ok');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const websocketServer = new WebSocketServer({ server: httpServer });
  let threadStarts = 0;
  let resolveFirstConnectionClosed: (() => void) | undefined;
  const firstConnectionClosed = new Promise<void>((resolve) => {
    resolveFirstConnectionClosed = resolve;
  });

  websocketServer.on('connection', (socket) => {
    let startedOnThisSocket = false;
    socket.on('close', () => {
      if (startedOnThisSocket) resolveFirstConnectionClosed?.();
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string };
      if (message.method === 'initialize' && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/start' && message.id !== undefined) {
        threadStarts += 1;
        startedOnThisSocket = true;
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: `thread-${threadStarts}` } } }));
        if (threadStarts === 1) socket.close();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('test server did not expose a port');

  const appServer = new CodexAppServer({ ...loadConfig(), codexEndpoint: `ws://127.0.0.1:${address.port}` });
  try {
    assert.equal((await appServer.startThread('/workspace/project')).id, 'thread-1');
    await firstConnectionClosed;
    assert.equal((await appServer.startThread('/workspace/project')).id, 'thread-2');
  } finally {
    await appServer.close();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

test('reconnects and retries session restore when the socket closes during resume', async () => {
  const httpServer = createServer((request, response) => {
    if (request.url === '/readyz') {
      response.writeHead(200);
      response.end('ok');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const websocketServer = new WebSocketServer({ server: httpServer });
  let resumeCalls = 0;

  websocketServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string };
      if (message.method === 'initialize' && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume' && message.id !== undefined) {
        resumeCalls += 1;
        if (resumeCalls === 1) {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'restored-thread' } } }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('test server did not expose a port');

  const appServer = new CodexAppServer({ ...loadConfig(), codexEndpoint: `ws://127.0.0.1:${address.port}` });
  try {
    assert.equal((await appServer.resumeThread('restored-thread')).id, 'restored-thread');
    assert.equal(resumeCalls, 2);
  } finally {
    await appServer.close();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});


test('releases the Wecode App Server process so a local client can resume the thread', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wecode-app-server-release-'));
  const fakeAppServer = path.join(directory, 'app-server');
  const generationFile = path.join(directory, 'generation');
  const originalGenerationFile = process.env.WECODE_TEST_SERVER_GENERATION_FILE;
  process.env.WECODE_TEST_SERVER_GENERATION_FILE = generationFile;
  let portServer: ReturnType<typeof createServer> | undefined;
  let manager: SessionManager | undefined;
  let localClient: CodexAppServer | undefined;
  let store: StateStore | undefined;

  try {
    const wsModulePath = createRequire(import.meta.url).resolve('ws');
    await writeFile(generationFile, '0');
    await writeFile(fakeAppServer, `
const { readFileSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { WebSocketServer } = require(${JSON.stringify(wsModulePath)});

const generationFile = process.env.WECODE_TEST_SERVER_GENERATION_FILE;
const previousGeneration = Number(readFileSync(generationFile, 'utf8').trim() || '0');
const generation = previousGeneration + 1;
writeFileSync(generationFile, String(generation));
const endpoint = new URL(process.argv[process.argv.indexOf('--listen') + 1]);
const httpServer = createServer((request, response) => {
  if (request.url === '/readyz') {
    response.writeHead(200);
    response.end('ok');
    return;
  }
  response.writeHead(404);
  response.end();
});
const websocketServer = new WebSocketServer({ server: httpServer });
websocketServer.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id === undefined) return;
    let result = {};
    if (message.method === 'thread/start') {
      result = { thread: { id: 'thread-release-test', cwd: message.params.cwd, name: 'server-' + generation, status: { type: 'idle' } } };
    } else if (message.method === 'thread/read') {
      result = { thread: { id: message.params.threadId, cwd: process.cwd(), name: 'server-' + generation, status: { type: 'idle' }, turns: [] } };
    } else if (message.method === 'thread/resume') {
      result = { thread: { id: message.params.threadId, cwd: process.cwd(), name: 'server-' + generation, status: { type: 'idle' } } };
    }
    socket.send(JSON.stringify({ id: message.id, result }));
  });
});
httpServer.listen(Number(endpoint.port), endpoint.hostname);
process.on('SIGTERM', () => {
  websocketServer.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 1000).unref();
});
`);

    portServer = createServer();
    await new Promise<void>((resolve, reject) => {
      portServer?.once('error', reject);
      portServer?.listen(0, '127.0.0.1', resolve);
    });
    const address = portServer.address();
    if (!address || typeof address === 'string') throw new Error('test server did not expose a port');
    await new Promise<void>((resolve) => portServer?.close(() => resolve()));
    portServer = undefined;

    const config = {
      ...loadConfig(),
      codexCommand: process.execPath,
      homeDir: directory,
      codexEndpoint: `ws://127.0.0.1:${address.port}`,
    };
    store = new StateStore(path.join(directory, 'state.json'));
    await store.init();
    const appServer = new CodexAppServer(config);
    manager = new SessionManager(config, store, appServer, async () => undefined);
    const { binding } = await manager.create('user', directory);
    assert.equal(binding.threadId, 'thread-release-test');

    await manager.release('user');

    localClient = new CodexAppServer(config);
    const resumed = await localClient.resumeThread(binding.threadId);
    assert.equal(resumed.name, 'server-2');
  } finally {
    await localClient?.close();
    await manager?.close();
    await store?.save();
    if (portServer?.listening) await new Promise<void>((resolve) => portServer?.close(() => resolve()));
    if (originalGenerationFile === undefined) delete process.env.WECODE_TEST_SERVER_GENERATION_FILE;
    else process.env.WECODE_TEST_SERVER_GENERATION_FILE = originalGenerationFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not stop a matching App Server endpoint owned by another Wecode process', async (context) => {
  if (process.platform === 'win32') {
    context.skip('this test emulates endpoint process discovery with POSIX executable stubs');
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'wecode-shared-app-server-'));
  const toolsDirectory = path.join(directory, 'tools');
  const appServerScript = path.join(directory, 'codex-app-server.cjs');
  const lsof = path.join(toolsDirectory, 'lsof');
  const originalPath = process.env.PATH;
  const originalPid = process.env.WECODE_TEST_SHARED_SERVER_PID;
  let portServer: ReturnType<typeof createServer> | undefined;
  let owner: ReturnType<typeof spawn> | undefined;
  let firstClient: CodexAppServer | undefined;
  let secondClient: CodexAppServer | undefined;

  try {
    const wsModulePath = createRequire(import.meta.url).resolve('ws');
    await mkdir(toolsDirectory);
    await writeFile(lsof, `#!/usr/bin/env node
process.stdout.write(process.env.WECODE_TEST_SHARED_SERVER_PID + '\\n');
`);
    await chmod(lsof, 0o755);
    await writeFile(appServerScript, `
const { createServer } = require('node:http');
const { WebSocketServer } = require(${JSON.stringify(wsModulePath)});
const endpoint = new URL(process.argv[process.argv.indexOf('--listen') + 1]);
const httpServer = createServer((request, response) => {
  if (request.url === '/readyz') {
    response.writeHead(200);
    response.end('ok');
    return;
  }
  response.writeHead(404);
  response.end();
});
const websocketServer = new WebSocketServer({ server: httpServer });
websocketServer.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === 'initialize' && message.id !== undefined) {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    }
  });
});
httpServer.listen(Number(endpoint.port), endpoint.hostname);
process.on('SIGTERM', () => {
  websocketServer.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 1000).unref();
});
`);

    portServer = createServer();
    await new Promise<void>((resolve, reject) => {
      portServer?.once('error', reject);
      portServer?.listen(0, '127.0.0.1', resolve);
    });
    const address = portServer.address();
    if (!address || typeof address === 'string') throw new Error('test server did not expose a port');
    await new Promise<void>((resolve) => portServer?.close(() => resolve()));
    portServer = undefined;

    const endpoint = `ws://127.0.0.1:${address.port}`;
    owner = spawn(process.execPath, [
      appServerScript,
      'app-server',
      '--listen',
      endpoint,
      '--config',
      'approval_policy=never',
      '--config',
      'sandbox_mode=danger-full-access',
      '--config',
      'service_tier=null',
    ], { stdio: 'ignore' });
    const ownerPid = await new Promise<number>((resolve, reject) => {
      owner?.once('error', reject);
      owner?.once('spawn', () => resolve(owner?.pid as number));
    });
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      ready = await fetch(`http://127.0.0.1:${address.port}/readyz`)
        .then((response) => response.ok)
        .catch(() => false);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ready, true, 'the shared App Server should be ready before connecting');
    process.env.PATH = `${toolsDirectory}${path.delimiter}${originalPath || ''}`;
    process.env.WECODE_TEST_SHARED_SERVER_PID = String(ownerPid);

    const config = {
      ...loadConfig(),
      codexCommand: path.join(directory, 'missing-codex'),
      codexEndpoint: endpoint,
    };
    firstClient = new CodexAppServer(config);
    await firstClient.connect();
    await firstClient.close();

    secondClient = new CodexAppServer(config);
    await secondClient.connect();
    assert.equal(owner.exitCode, null, 'the shared App Server must remain alive after another client closes');
  } finally {
    await firstClient?.close();
    await secondClient?.close();
    if (owner?.pid && owner.exitCode === null) {
      owner.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (owner?.exitCode !== null) {
          resolve();
          return;
        }
        owner?.once('exit', () => resolve());
      });
    }
    if (portServer?.listening) await new Promise<void>((resolve) => portServer?.close(() => resolve()));
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPid === undefined) delete process.env.WECODE_TEST_SHARED_SERVER_PID;
    else process.env.WECODE_TEST_SHARED_SERVER_PID = originalPid;
    await rm(directory, { recursive: true, force: true });
  }
});

test('force takeover stops the exact Windows writer only after explicit authorization', async (context) => {
  if (process.platform === 'win32') {
    context.skip('this test emulates Windows process tools with POSIX executable stubs');
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), 'wecode-windows-writer-release-'));
  const toolsDirectory = path.join(directory, 'tools');
  const powershell = path.join(toolsDirectory, 'powershell.exe');
  const taskkill = path.join(toolsDirectory, 'taskkill.exe');
  const taskkillLog = path.join(directory, 'taskkill.log');
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalPath = process.env.PATH;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalOwnerPid = process.env.WECODE_TEST_OWNER_PID;
  const originalTaskkillLog = process.env.WECODE_TEST_TASKKILL_LOG;
  let owner: ReturnType<typeof spawn> | undefined;
  const config = loadConfig();

  try {
    await mkdir(toolsDirectory);
    await writeFile(powershell, `#!/usr/bin/env node
const ownerPid = Number(process.env.WECODE_TEST_OWNER_PID);
if (process.argv.includes('-EncodedCommand')) {
  try {
    process.kill(ownerPid, 0);
    process.stdout.write(String(ownerPid) + '\\tCodex\\n');
  } catch {}
} else {
  process.stdout.write('C:\\\\Codex\\\\codex.exe app-server\\n');
}
`);
    await writeFile(taskkill, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.WECODE_TEST_TASKKILL_LOG, JSON.stringify(args) + '\\n');
if (args.includes('/F')) {
  const pid = Number(args[args.indexOf('/PID') + 1]);
  try { process.kill(pid, 'SIGKILL'); } catch {}
}
`);
    await chmod(powershell, 0o755);
    await chmod(taskkill, 0o755);
    owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const ownerPid = await new Promise<number>((resolve, reject) => {
      owner?.once('error', reject);
      owner?.once('spawn', () => resolve(owner?.pid as number));
    });
    const ownerExited = new Promise<void>((resolve) => owner?.once('exit', () => resolve()));

    process.env.PATH = `${toolsDirectory}${path.delimiter}${originalPath || ''}`;
    process.env.CODEX_HOME = directory;
    process.env.WECODE_TEST_OWNER_PID = String(ownerPid);
    process.env.WECODE_TEST_TASKKILL_LOG = taskkillLog;
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });

    const appServer = new CodexAppServer(config);
    const regularRelease = await appServer.releaseExternalWriter('thread-force-test');
    assert.equal(regularRelease.released, false);
    assert.deepEqual(regularRelease.pids, [ownerPid]);
    await assert.rejects(() => readFile(taskkillLog, 'utf8'), { code: 'ENOENT' });

    const takeover = await appServer.releaseExternalWriter('thread-force-test', { force: true });
    assert.equal(takeover.released, true);
    assert.deepEqual(takeover.pids, [ownerPid]);
    await ownerExited;
    const commands = (await readFile(taskkillLog, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[0], ['/PID', String(ownerPid)]);
    assert.deepEqual(commands[1], ['/PID', String(ownerPid), '/F']);
  } finally {
    if (owner?.pid) {
      try {
        process.kill(owner.pid, 'SIGKILL');
      } catch {
        // The fake writer has already exited.
      }
    }
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalOwnerPid === undefined) delete process.env.WECODE_TEST_OWNER_PID;
    else process.env.WECODE_TEST_OWNER_PID = originalOwnerPid;
    if (originalTaskkillLog === undefined) delete process.env.WECODE_TEST_TASKKILL_LOG;
    else process.env.WECODE_TEST_TASKKILL_LOG = originalTaskkillLog;
    await rm(directory, { recursive: true, force: true });
  }
});
