#!/usr/bin/env node

import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { ensureConfigFile, loadConfig } from './config.js';
import { BridgeApp } from './bridge.js';
import { CodexAppServer } from './codex.js';
import { acquireDaemon, daemonPaths, inspectDaemon, readDaemonLogs, releaseDaemon, startDaemon, stopDaemon } from './daemon.js';
import { loginWithQr, IlinkClient } from './ilink.js';
import { SessionManager } from './sessions.js';
import { StateStore } from './state.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const background = args.includes('--background');
  const command = args.find((arg) => !arg.startsWith('-')) || 'run';
  const config = loadConfig();
  if (args.includes('--help') || args.includes('-h') || command === 'help') {
    process.stdout.write('用法：\n  wecode             首次扫码登录，之后自动后台运行\n  wecode login       重新扫码登录，完成后自动后台运行\n  wecode restart     重启后台进程，复用已有登录状态\n  wecode status      查看后台进程状态\n  wecode stop        停止后台进程\n  wecode logs        查看后台日志\n');
    return;
  }
  await ensureConfigFile(config);
  await mkdir(config.dataDir, { recursive: true });
  const store = new StateStore(config.stateFile);
  await store.init();

  if (command === 'status') {
    await printStatus(config, store);
    return;
  }

  if (command === 'stop') {
    const stopped = await stopDaemon(config);
    process.stdout.write(stopped ? 'wecode 已停止。\n' : 'wecode 当前未运行。\n');
    return;
  }

  if (command === 'logs') {
    const logs = await readDaemonLogs(config);
    process.stdout.write(logs || `暂无后台日志：${daemonPaths(config).logFile}\n`);
    return;
  }

  if (command === 'login') {
    await stopDaemon(config);
    await login(config, store);
    await launchBackground(config);
    return;
  }

  if (command === 'restart') {
    await stopDaemon(config);
    if (!store.get().token || !store.get().botId) await login(config, store, true);
    await launchBackground(config);
    return;
  }

  if (command !== 'run') {
    process.stdout.write('未知命令。执行 wecode --help 查看用法。\n');
    return;
  }

  if (background) {
    await runBridge(config, store);
    return;
  }

  if (!store.get().token || !store.get().botId) await login(config, store, true);
  await launchBackground(config);
}

async function launchBackground(config: ReturnType<typeof loadConfig>): Promise<void> {
  const result = await startDaemon(config);
  const paths = daemonPaths(config);
  if (result.started) {
    process.stdout.write(`wecode 已转入后台，PID：${result.pid}\n日志：${paths.logFile}\n`);
  } else {
    process.stdout.write(`wecode 已在后台运行，PID：${result.pid}\n日志：${paths.logFile}\n`);
  }
}

async function printStatus(config: ReturnType<typeof loadConfig>, store: StateStore): Promise<void> {
  const status = await inspectDaemon(config);
  if (status.running && status.owned) {
    process.stdout.write(`wecode 正在后台运行，PID：${status.pid}\n日志：${daemonPaths(config).logFile}\n`);
    return;
  }
  if (status.running && !status.owned) {
    process.stdout.write(`PID ${status.pid} 正在运行，但无法确认属于 wecode；未执行任何停止操作。\n`);
    return;
  }
  process.stdout.write('wecode 当前未运行。\n');
  if (store.get().token && store.get().scannedUser) process.stdout.write(`已登录微信：${store.get().scannedUser}\n`);
  if (store.get().lastError) process.stdout.write(`最近错误：${store.get().lastError}\n`);
}

async function runBridge(config: ReturnType<typeof loadConfig>, store: StateStore): Promise<void> {
  await acquireDaemon(config);
  try {
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
      await releaseDaemon(config);
    };
    process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));

    const reapTimer = setInterval(() => void sessions.reapIdle(), 60_000);
    reapTimer.unref();
    process.stdout.write(`wecode 已启动，监听 ${store.get().scannedUser || '绑定微信用户'}\n`);

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
  } finally {
    await releaseDaemon(config);
  }
}

async function login(config: ReturnType<typeof loadConfig>, store: StateStore, continueRunning = false): Promise<void> {
  if (continueRunning) process.stdout.write('\n首次启动，先完成一次微信扫码登录。\n');
  const result = await loginWithQr(config);
  store.update((state) => {
    state.token = result.token;
    state.botId = result.botId;
    state.baseUrl = result.baseUrl;
    state.scannedUser = result.scannedUser;
    state.welcomePending = true;
    state.cursor = '';
    state.lastError = '';
  });
  await store.save();
  process.stdout.write(`\n登录成功。绑定用户：${result.scannedUser || '(网关未返回用户 ID)'}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
