import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { IlinkClient } from '../src/ilink.js';
import { loadConfig } from '../src/config.js';

test('classifies iLink ret=-2 prepare failed as requiring a fresh context token', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ret: -2, errmsg: 'prepare failed' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new IlinkClient({ ...loadConfig(), apiBase: `http://127.0.0.1:${address.port}` }, 'bot-token');
    const result = await client.sendText('user', 'hello', 'context-token');
    assert.equal(result.ok, false);
    assert.equal(result.code, -2);
    assert.equal(result.needsFreshContext, true);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
