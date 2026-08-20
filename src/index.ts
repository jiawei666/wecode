import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { STARTUP_HINT } from './commands.js';
import { loadConfig } from './config.js';
import { BridgeApp } from './bridge.js';
import { CodexAppServer } from './codex.js';
import { loginWithQr, IlinkClient } from './ilink.js';
import { SessionManager } from './sessions.js';
import { StateStore } from './state.js';

async function main(): Promise<void> {
  const command = process.argv[2] || 'run';
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });
  const store = new StateStore(config.stateFile);
  await store.init();

  if (command === 'login') {
    const result = await loginWithQr(config);
    store.update((state) => {
      state.token = result.token;
      state.botId = result.botId;
      state.baseUrl = result.baseUrl;
      state.scannedUser = result.scannedUser;
      state.cursor = '';
      state.lastError = '';
    });
    await store.save();
    process.stdout.write(`\n登录成功。绑定用户：${result.scannedUser || '(网关未返回用户 ID)'}\n`);
    return;
  }

  if (command !== 'run') {
    process.stdout.write('用法：npm run dev -- login | run\n');
    return;
  }

  if (!store.get().token || !store.get().botId) {
    throw new Error('尚未登录，请先执行：npm run dev -- login');
  }
  const token = store.get().token;
  const ilink = new IlinkClient({ ...config, apiBase: store.get().baseUrl || config.apiBase }, token);
  const appServer = new CodexAppServer(config);
  let bridge: BridgeApp | undefined;
  const sessions = new SessionManager(config, store, appServer, async (result) => {
    if (bridge) await bridge.onTurn(result);
  });
  bridge = new BridgeApp(config, store, ilink, sessions);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await bridge?.close();
  };
  process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));

  const reapTimer = setInterval(() => void sessions.reapIdle(), 60_000);
  reapTimer.unref();
  process.stdout.write(`wecode 已启动，监听 ${store.get().scannedUser || '绑定微信用户'}\n${STARTUP_HINT}\n`);

  let backoff = 1000;
  while (!stopping) {
    const result = await ilink.poll(store.get().cursor);
    if (result.sessionExpired) {
      store.update((state) => {
        state.lastError = 'iLink session expired';
      });
      process.stderr.write('iLink session 已过期，请重新执行 login。\n');
      break;
    }
    if (result.error) {
      store.update((state) => {
        state.lastError = result.error || '';
      });
      process.stderr.write(`[ilink] ${result.error}\n`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    backoff = 1000;
    store.update((state) => {
      state.lastPollAt = Date.now();
      state.lastError = '';
      if (result.cursor) state.cursor = result.cursor;
    });
    for (const message of result.messages) void bridge.handle(message);
  }
  clearInterval(reapTimer);
  await stop();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
