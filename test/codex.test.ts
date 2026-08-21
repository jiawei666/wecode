import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.js';
import { CodexAppServer } from '../src/codex.js';
import { buildWindowsCommandLine } from '../src/process.js';

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
      } else if (message.method === 'thread/read' && message.id !== undefined) {
        readParams = message.params;
        socket.send(JSON.stringify({
          id: message.id,
          result: { thread: { id: 'test-thread', status: { type: 'active' }, turns: [{ id: 'turn-1', status: 'inProgress' }] } },
        }));
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
    assert.deepEqual((params?.config as Record<string, unknown>).service_tier, null);
    const snapshot = await appServer.readThread('test-thread');
    assert.equal(readParams?.threadId, 'test-thread');
    assert.equal(readParams?.includeTurns, true);
    assert.equal(snapshot.turns?.[0]?.id, 'turn-1');
    assert.equal(await appServer.steerTurn('test-thread', 'turn-1', '补充要求'), 'turn-1');
    assert.equal(steerParams?.threadId, 'test-thread');
    assert.equal(steerParams?.expectedTurnId, 'turn-1');
    assert.deepEqual(steerParams?.input, [{ type: 'text', text: '补充要求' }]);
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
