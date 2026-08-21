import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface UserConfig {
  version?: number;
  dataDir?: string;
  homeDir?: string;
  defaultCwd?: string;
  searchRoots?: string[];
  allowedUser?: string;
  codexCommand?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  codexFast?: boolean;
  controlModel?: string;
  controlReasoningEffort?: string;
  cloudflaredCommand?: string;
  sharePageBaseUrl?: string;
  pageTtlMs?: number;
}

export interface AppConfig {
  configFile: string;
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
  idleTimeoutMs: number;
  pageTtlMs: number;
  sharePageBaseUrl: string;
  cloudflaredCommand: string;
  chatChunkSize: number;
  controlTimeoutMs: number;
  bindingHistoryLimit: number;
  pollTimeoutMs: number;
}

export interface LoadConfigOptions {
  userHome?: string;
  configFile?: string;
}

function resolveFrom(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  options: LoadConfigOptions = {},
): AppConfig {
  const projectRoot = path.resolve(cwd);
  const userHome = options.userHome || homedir();
  const configFile = options.configFile || env.WECODE_CONFIG_FILE?.trim() || path.join(userHome, '.wecode', 'config.json');
  const userConfig = readUserConfig(configFile);
  const configDir = path.dirname(configFile);
  const legacyDataDir = path.join(projectRoot, '.data');
  const configuredDataDir = firstText(userConfig.dataDir, env.WECHATBOT_DATA_DIR);
  const dataDir = configuredDataDir
    ? resolveFrom(projectRoot, configuredDataDir)
    : !existsSync(configFile) && existsSync(path.join(legacyDataDir, 'state.json'))
      ? legacyDataDir
      : configDir;
  const homeDir = resolveFrom(projectRoot, firstText(userConfig.homeDir, env.WECHATBOT_HOME) || userHome);
  const configuredRoots = env.WECHATBOT_SEARCH_ROOTS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const fileRoots = Array.isArray(userConfig.searchRoots)
    ? userConfig.searchRoots.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const defaultCwd = resolveFrom(projectRoot, firstText(userConfig.defaultCwd, env.WECHATBOT_DEFAULT_CWD) || projectRoot);
  const searchRoots = fileRoots.length
    ? fileRoots.map((value) => resolveFrom(projectRoot, value))
    : configuredRoots?.length
      ? configuredRoots.map((value) => resolveFrom(projectRoot, value))
      : [defaultCwd];
  const localCloudflared = [
    path.join(projectRoot, 'bin', 'cloudflared'),
    path.join(configDir, 'bin', 'cloudflared'),
  ].find((candidate) => existsSync(candidate));
  const codexModel = firstText(userConfig.codexModel, env.CODEX_MODEL) || '';
  const codexReasoningEffort = firstText(userConfig.codexReasoningEffort, env.CODEX_REASONING_EFFORT) || '';

  return {
    configFile,
    dataDir,
    stateFile: path.join(dataDir, 'state.json'),
    apiBase: firstText(env.ILINK_API_BASE) || 'https://ilinkai.weixin.qq.com',
    cdnBase: firstText(env.ILINK_CDN_BASE) || 'https://novac2c.cdn.weixin.qq.com/c2c',
    channelVersion: firstText(env.ILINK_CHANNEL_VERSION) || 'wechatbot/0.1',
    homeDir,
    defaultCwd,
    searchRoots,
    allowedUser: firstText(userConfig.allowedUser, env.WECHATBOT_ALLOWED_USER) || '',
    codexCommand: firstText(userConfig.codexCommand, env.CODEX_COMMAND) || 'codex',
    codexModel,
    codexReasoningEffort,
    codexFast: booleanValue(env.CODEX_FAST, userConfig.codexFast, false),
    controlModel: firstText(userConfig.controlModel, env.CONTROL_MODEL, codexModel) || '',
    controlReasoningEffort: firstText(userConfig.controlReasoningEffort, env.CONTROL_REASONING_EFFORT, codexReasoningEffort) || '',
    codexEndpoint: firstText(env.CODEX_APP_ENDPOINT) || 'ws://127.0.0.1:45037',
    idleTimeoutMs: numberValue(env.WECHATBOT_IDLE_TIMEOUT_MS, undefined, 2 * 60 * 60_000),
    pageTtlMs: numberValue(env.WECHATBOT_PAGE_TTL_MS, userConfig.pageTtlMs, 24 * 60 * 60_000),
    sharePageBaseUrl: firstText(userConfig.sharePageBaseUrl, env.SHARE_PAGE_BASE_URL) || '',
    cloudflaredCommand: firstText(userConfig.cloudflaredCommand, env.CLOUDFLARED_COMMAND) || localCloudflared || 'cloudflared',
    chatChunkSize: numberValue(env.WECHATBOT_CHAT_CHUNK_SIZE, undefined, 1200),
    controlTimeoutMs: numberValue(env.WECHATBOT_CONTROL_TIMEOUT_MS, undefined, 30 * 60_000),
    bindingHistoryLimit: numberValue(env.WECHATBOT_BINDING_HISTORY_LIMIT, undefined, 5),
    pollTimeoutMs: numberValue(env.WECHATBOT_POLL_TIMEOUT_MS, undefined, 35_000),
  };
}

/** Create the only file most users ever need to see. */
export async function ensureConfigFile(config: AppConfig): Promise<void> {
  if (existsSync(config.configFile)) return;
  await mkdir(path.dirname(config.configFile), { recursive: true });
  const initial: UserConfig = {
    version: 1,
    defaultCwd: config.defaultCwd,
    ...(config.dataDir !== path.dirname(config.configFile) ? { dataDir: config.dataDir } : {}),
  };
  try {
    await writeFile(config.configFile, `${JSON.stringify(initial, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code !== 'EEXIST') throw error;
  }
}

function readUserConfig(file: string): UserConfig {
  if (!existsSync(file)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be a JSON object');
    return value as UserConfig;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取配置文件 ${file}：${detail}`);
  }
}

function firstText(...values: Array<string | undefined | null>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function numberValue(raw: string | undefined, configured: number | undefined, fallback: number): number {
  const candidate = configured ?? raw?.trim();
  if (candidate === undefined || candidate === '') return fallback;
  const value = Number(candidate);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanValue(raw: string | undefined, configured: boolean | undefined, fallback: boolean): boolean {
  if (configured !== undefined) return configured;
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}
