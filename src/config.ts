import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface AppConfig {
  dataDir: string;
  stateFile: string;
  apiBase: string;
  cdnBase: string;
  channelVersion: string;
  homeDir: string;
  defaultCwd: string;
  searchRoots: string[];
  allowedUser: string;
  codexCommand: string;
  codexModel: string;
  codexReasoningEffort: string;
  codexFast: boolean;
  controlModel: string;
  controlReasoningEffort: string;
  codexEndpoint: string;
  tmuxCodexCommand: string;
  idleTimeoutMs: number;
  pageTtlMs: number;
  sharePageBaseUrl: string;
  cloudflaredCommand: string;
  chatChunkSize: number;
  controlTimeoutMs: number;
  selectionTimeoutMs: number;
  bindingHistoryLimit: number;
  sessionListLimit: number;
  pollTimeoutMs: number;
}

function resolveFrom(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const projectRoot = path.resolve(cwd);
  const dataDir = resolveFrom(projectRoot, env.WECHATBOT_DATA_DIR?.trim() || '.data');
  const homeDir = resolveFrom(projectRoot, env.WECHATBOT_HOME?.trim() || homedir());
  const configuredRoots = env.WECHATBOT_SEARCH_ROOTS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const searchRoots = configuredRoots?.length
    ? configuredRoots.map((value) => resolveFrom(projectRoot, value))
    : [projectRoot];
  const defaultCwd = resolveFrom(projectRoot, env.WECHATBOT_DEFAULT_CWD?.trim() || projectRoot);
  const localTmux = path.join(projectRoot, 'bin', 'tmux-codex');
  const localCloudflared = path.join(projectRoot, 'bin', 'cloudflared');

  return {
    dataDir,
    stateFile: path.join(dataDir, 'state.json'),
    apiBase: env.ILINK_API_BASE?.trim() || 'https://ilinkai.weixin.qq.com',
    cdnBase: env.ILINK_CDN_BASE?.trim() || 'https://novac2c.cdn.weixin.qq.com/c2c',
    channelVersion: env.ILINK_CHANNEL_VERSION?.trim() || 'wechatbot/0.1',
    homeDir,
    defaultCwd,
    searchRoots,
    allowedUser: env.WECHATBOT_ALLOWED_USER?.trim() || '',
    codexCommand: env.CODEX_COMMAND?.trim() || 'codex',
    codexModel: env.CODEX_MODEL?.trim() || 'gpt-5.6-luna',
    codexReasoningEffort: env.CODEX_REASONING_EFFORT?.trim() || 'max',
    codexFast: booleanEnvValue(env.CODEX_FAST, false),
    controlModel: env.CONTROL_MODEL?.trim() || env.CODEX_MODEL?.trim() || 'gpt-5.6-luna',
    controlReasoningEffort: env.CONTROL_REASONING_EFFORT?.trim() || env.CODEX_REASONING_EFFORT?.trim() || 'max',
    codexEndpoint: env.CODEX_APP_ENDPOINT?.trim() || 'ws://127.0.0.1:45037',
    tmuxCodexCommand: env.TMUX_CODEX_COMMAND?.trim() || localTmux,
    idleTimeoutMs: numberEnvValue(env.WECHATBOT_IDLE_TIMEOUT_MS, 2 * 60 * 60_000),
    pageTtlMs: numberEnvValue(env.WECHATBOT_PAGE_TTL_MS, 24 * 60 * 60_000),
    sharePageBaseUrl: env.SHARE_PAGE_BASE_URL?.trim() || '',
    cloudflaredCommand:
      env.CLOUDFLARED_COMMAND?.trim() ||
      (existsSync(localCloudflared) ? localCloudflared : 'cloudflared'),
    chatChunkSize: numberEnvValue(env.WECHATBOT_CHAT_CHUNK_SIZE, 1200),
    controlTimeoutMs: numberEnvValue(env.WECHATBOT_CONTROL_TIMEOUT_MS, 30 * 60_000),
    selectionTimeoutMs: numberEnvValue(env.WECHATBOT_SELECTION_TIMEOUT_MS, 10 * 60_000),
    bindingHistoryLimit: numberEnvValue(env.WECHATBOT_BINDING_HISTORY_LIMIT, 5),
    sessionListLimit: numberEnvValue(env.WECHATBOT_SESSION_LIST_LIMIT, 5),
    pollTimeoutMs: numberEnvValue(env.WECHATBOT_POLL_TIMEOUT_MS, 35_000),
  };
}

function numberEnvValue(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanEnvValue(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}
