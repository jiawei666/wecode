import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.js';
import { CodexAppServer } from '../src/codex.js';

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
  websocketServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.method === 'initialize' && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/start' && message.id !== undefined) {
        params = message.params;
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'test-thread' } } }));
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
    assert.equal(params?.model, 'gpt-5.6-luna');
    assert.deepEqual((params?.config as Record<string, unknown>).service_tier, null);
  } finally {
    await appServer.close();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
