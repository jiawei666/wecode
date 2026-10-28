import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encryptMedia, IlinkClient } from '../src/ilink.js';
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

test('keeps an empty post-login event when it carries a context token', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ret: 0,
      msgs: [{
        message_type: 1,
        from_user_id: 'wx-user',
        message_id: 'bind-event',
        context_token: 'binding-context',
      }],
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new IlinkClient({ ...loadConfig(), apiBase: `http://127.0.0.1:${address.port}` }, 'bot-token');
    const result = await client.poll('');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.text, '');
    assert.equal(result.messages[0]?.contextToken, 'binding-context');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('prefetches and caches the typing ticket before sending typing status', async () => {
  const configBodies: Array<Record<string, unknown>> = [];
  const typingBodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as Record<string, unknown>;
    if (request.url === '/ilink/bot/getconfig') {
      configBodies.push(payload);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ret: 0, typing_ticket: 'typing-ticket' }));
      return;
    }
    if (request.url === '/ilink/bot/sendtyping') {
      typingBodies.push(payload);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ret: 0 }));
      return;
    }
    response.writeHead(404);
    response.end('missing');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new IlinkClient({ ...loadConfig(), apiBase: `http://127.0.0.1:${address.port}` }, 'bot-token');

    assert.equal(await client.prepareTyping('wx-user', 'context-token'), true);
    assert.equal(await client.sendTyping('wx-user', 'context-token', 1), true);
    assert.equal(await client.sendTyping('wx-user', 'context-token', 1), true);
    assert.equal(await client.sendTyping('wx-user', 'context-token', 2), true);

    assert.equal(configBodies.length, 1);
    assert.equal(configBodies[0]?.ilink_user_id, 'wx-user');
    assert.equal(configBodies[0]?.context_token, 'context-token');
    assert.deepEqual(typingBodies.map((body) => body.status), [1, 1, 2]);
    assert.ok(typingBodies.every((body) => body.typing_ticket === 'typing-ticket'));
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('downloads and decrypts inbound images and files while keeping attachment failures isolated', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wecode-ilink-media-'));
  const key = Buffer.from('0123456789abcdef');
  const imageBytes = Buffer.from('decrypted image payload');
  const fileBytes = Buffer.from('decrypted file payload');
  const legacyImageBytes = Buffer.from('legacy image payload');
  const encryptedImage = encryptMedia(imageBytes, key);
  const encryptedFile = encryptMedia(fileBytes, key);
  const encryptedLegacyImage = encryptMedia(legacyImageBytes, key);
  const mediaDir = path.join(dataDir, 'incoming-media');
  await mkdir(mediaDir, { recursive: true });
  const expiredFile = path.join(mediaDir, 'expired.bin');
  await writeFile(expiredFile, 'expired');
  const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  await utimes(expiredFile, expiredAt, expiredAt);
  const requestedPaths: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requestedPaths.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/ilink/bot/getupdates') {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        msgs: [{
          message_type: 1,
          from_user_id: 'wx-user',
          item_list: [
            {
              type: 2,
              image_item: {
                aeskey: key.toString('hex'),
                media: {
                  full_url: `${baseUrl}/media/full?signature=private`,
                  encrypt_query_param: 'should-not-be-used',
                  aes_key: 'invalid-fallback-key',
                },
              },
            },
            {
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: 'legacy-image',
                  aes_key: Buffer.from(key.toString('hex')).toString('base64'),
                },
              },
            },
            {
              type: 4,
              file_item: {
                file_name: '../../unsafe report.txt',
                media: { encrypt_query_param: 'file-query', aes_key: key.toString('base64') },
                md5: createHash('md5').update(fileBytes).digest('hex'),
              },
            },
            {
              type: 4,
              file_item: {
                file_name: 'checksum-failure.txt',
                media: { encrypt_query_param: 'bad-md5', aes_key: key.toString('base64') },
                md5: '00000000000000000000000000000000',
              },
            },
            {
              type: 4,
              file_item: {
                file_name: 'broken.dat',
                media: { encrypt_query_param: 'broken', aes_key: 'not-a-key' },
              },
            },
          ],
        }],
        get_updates_buf: 'next-cursor',
      }));
      return;
    }
    if (url.pathname === '/media/full') {
      response.writeHead(200);
      response.end(encryptedImage);
      return;
    }
    if (url.pathname === '/c2c/download' && url.searchParams.get('encrypted_query_param') === 'legacy-image') {
      response.writeHead(200);
      response.end(encryptedLegacyImage);
      return;
    }
    if (url.pathname === '/c2c/download' && url.searchParams.get('encrypted_query_param') === 'file-query') {
      response.writeHead(200);
      response.end(encryptedFile);
      return;
    }
    if (url.pathname === '/c2c/download' && url.searchParams.get('encrypted_query_param') === 'bad-md5') {
      response.writeHead(200);
      response.end(encryptedFile);
      return;
    }
    response.writeHead(404);
    response.end('missing');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new IlinkClient({
      ...loadConfig(),
      apiBase: baseUrl,
      cdnBase: `${baseUrl}/c2c`,
      dataDir,
    }, 'bot-token');
    const result = await client.poll('');

    assert.equal(result.error, undefined);
    assert.equal(result.messages.length, 1);
    const attachments = result.messages[0]?.attachments ?? [];
    assert.equal(attachments.length, 5);
    assert.deepEqual(await readFile(attachments[0]?.path ?? ''), imageBytes);
    assert.deepEqual(await readFile(attachments[1]?.path ?? ''), legacyImageBytes);
    assert.deepEqual(await readFile(attachments[2]?.path ?? ''), fileBytes);
    assert.equal(attachments[0]?.kind, 'image');
    assert.equal(attachments[2]?.kind, 'file');
    assert.equal(attachments[3]?.path, undefined);
    assert.equal(attachments[3]?.error, '附件完整性校验失败');
    assert.equal(attachments[4]?.path, undefined);
    assert.equal(attachments[4]?.error, '缺少或无效的解密密钥');
    const absoluteMediaDir = path.resolve(dataDir, 'incoming-media');
    for (const attachment of attachments.slice(0, 3)) {
      assert.equal(path.dirname(attachment.path ?? ''), absoluteMediaDir);
      assert.equal(path.isAbsolute(attachment.path ?? ''), true);
    }
    assert.equal((await readdir(mediaDir)).length, 3, 'expired and checksum-failed files should not remain');
    assert.doesNotMatch(attachments[2]?.name ?? '', /[/\\]/);
    assert.ok(requestedPaths.includes('/media/full?signature=private'));
    assert.ok(requestedPaths.includes('/c2c/download?encrypted_query_param=legacy-image'));
    assert.ok(requestedPaths.includes('/c2c/download?encrypted_query_param=file-query'));
    assert.ok(requestedPaths.includes('/c2c/download?encrypted_query_param=bad-md5'));
    assert.ok(!requestedPaths.some((value) => value.includes('should-not-be-used')));
  } finally {
    server.close();
    await once(server, 'close');
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('limits each message to five media downloads and 50 MiB of declared or actual media', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wecode-ilink-limits-'));
  const key = Buffer.from('0123456789abcdef');
  const encrypted = encryptMedia(Buffer.from('small attachment'), key);
  const requestedMedia: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/ilink/bot/getupdates') {
      const sizeItems = ['sized-1', 'sized-2', 'sized-over'].map((id, index) => ({
        type: 4,
        file_item: {
          file_name: `${id}.txt`,
          ...(index < 2 ? { len: String(25 * 1024 * 1024) } : { len: '1' }),
          media: { encrypt_query_param: id, aes_key: key.toString('base64') },
        },
      }));
      const countItems = Array.from({ length: 6 }, (_unused, index) => ({
        type: 4,
        file_item: {
          file_name: `count-${index + 1}.txt`,
          media: { encrypt_query_param: `count-${index + 1}`, aes_key: key.toString('base64') },
        },
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        msgs: [
          { message_type: 1, from_user_id: 'wx-user', item_list: sizeItems },
          { message_type: 1, from_user_id: 'wx-user', item_list: countItems },
        ],
      }));
      return;
    }
    if (url.pathname === '/c2c/download') {
      const id = url.searchParams.get('encrypted_query_param') ?? '';
      requestedMedia.push(id);
      response.writeHead(200);
      response.end(encrypted);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new IlinkClient({
      ...loadConfig(),
      apiBase: baseUrl,
      cdnBase: `${baseUrl}/c2c`,
      dataDir,
    }, 'bot-token');
    const result = await client.poll('');

    assert.equal(result.error, undefined);
    assert.equal(result.messages.length, 2);
    const sizeAttachments = result.messages[0]?.attachments ?? [];
    assert.equal(sizeAttachments.length, 3);
    assert.ok(sizeAttachments[0]?.path);
    assert.ok(sizeAttachments[1]?.path);
    assert.equal(sizeAttachments[2]?.path, undefined);
    assert.equal(sizeAttachments[2]?.error, '单条消息附件总大小超过 50 MiB 限制');

    const countAttachments = result.messages[1]?.attachments ?? [];
    assert.equal(countAttachments.length, 6);
    assert.ok(countAttachments.slice(0, 5).every((attachment) => attachment.path));
    assert.equal(countAttachments[5]?.path, undefined);
    assert.equal(countAttachments[5]?.error, '单条消息最多接收 5 个图片或文件');
    assert.deepEqual(requestedMedia, [
      'sized-1', 'sized-2', 'count-1', 'count-2', 'count-3', 'count-4', 'count-5',
    ]);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('downloads a message attachments concurrently', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wecode-ilink-parallel-'));
  const key = Buffer.from('0123456789abcdef');
  const clear = Buffer.from('small concurrent attachment');
  const encrypted = encryptMedia(clear, key);
  let activeDownloads = 0;
  let maxActiveDownloads = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/ilink/bot/getupdates') {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        msgs: [{
          message_type: 1,
          from_user_id: 'wx-user',
          item_list: Array.from({ length: 5 }, (_unused, index) => ({
            type: 4,
            file_item: {
              file_name: `parallel-${index}.txt`,
              len: String(clear.length),
              media: { full_url: `${baseUrl}/media/${index}`, aes_key: key.toString('base64') },
            },
          })),
        }],
      }));
      return;
    }
    if (url.pathname.startsWith('/media/')) {
      activeDownloads += 1;
      maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
      setTimeout(() => {
        activeDownloads -= 1;
        response.writeHead(200);
        response.end(encrypted);
      }, 40);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new IlinkClient({
      ...loadConfig(),
      apiBase: baseUrl,
      cdnBase: `${baseUrl}/c2c`,
      dataDir,
    }, 'bot-token');
    const result = await client.poll('');

    const attachments = result.messages[0]?.attachments ?? [];
    assert.equal(attachments.length, 5);
    assert.ok(attachments.every((attachment) => attachment.path));
    assert.equal(maxActiveDownloads, 5);
    for (const attachment of attachments) assert.deepEqual(await readFile(attachment.path ?? ''), clear);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('rejects media URLs outside the configured or WeChat CDN and blocks redirects', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wecode-ilink-url-guard-'));
  const key = Buffer.from('0123456789abcdef');
  let untrustedRequests = 0;
  const untrustedServer = createServer((_request, response) => {
    untrustedRequests += 1;
    response.writeHead(200);
    response.end(encryptMedia(Buffer.from('should not be fetched'), key));
  });
  untrustedServer.listen(0, '127.0.0.1');
  await once(untrustedServer, 'listening');

  const trustedPaths: string[] = [];
  const trustedServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    trustedPaths.push(url.pathname);
    if (url.pathname === '/ilink/bot/getupdates') {
      const address = trustedServer.address();
      const untrustedAddress = untrustedServer.address();
      assert.ok(address && typeof address !== 'string');
      assert.ok(untrustedAddress && typeof untrustedAddress !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const untrustedUrl = `http://127.0.0.1:${untrustedAddress.port}/direct`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        msgs: [{
          message_type: 1,
          from_user_id: 'wx-user',
          item_list: [
            {
              type: 4,
              file_item: {
                file_name: 'redirect.txt',
                media: { full_url: `${baseUrl}/redirect`, aes_key: key.toString('base64') },
              },
            },
            {
              type: 4,
              file_item: {
                file_name: 'external.txt',
                media: { full_url: untrustedUrl, aes_key: key.toString('base64') },
              },
            },
          ],
        }],
      }));
      return;
    }
    if (url.pathname === '/redirect') {
      const untrustedAddress = untrustedServer.address();
      assert.ok(untrustedAddress && typeof untrustedAddress !== 'string');
      response.writeHead(302, { location: `http://127.0.0.1:${untrustedAddress.port}/redirected` });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  trustedServer.listen(0, '127.0.0.1');
  await once(trustedServer, 'listening');

  try {
    const trustedAddress = trustedServer.address();
    assert.ok(trustedAddress && typeof trustedAddress !== 'string');
    const baseUrl = `http://127.0.0.1:${trustedAddress.port}`;
    const client = new IlinkClient({
      ...loadConfig(),
      apiBase: baseUrl,
      cdnBase: `${baseUrl}/c2c`,
      dataDir,
    }, 'bot-token');
    const result = await client.poll('');

    const attachments = result.messages[0]?.attachments ?? [];
    assert.equal(attachments.length, 2);
    assert.ok(attachments.every((attachment) => attachment.error));
    assert.equal(untrustedRequests, 0, 'neither direct URLs nor redirects may reach an untrusted host');
    assert.ok(trustedPaths.includes('/redirect'));
  } finally {
    trustedServer.close();
    untrustedServer.close();
    await Promise.all([once(trustedServer, 'close'), once(untrustedServer, 'close')]);
    await rm(dataDir, { recursive: true, force: true });
  }
});
