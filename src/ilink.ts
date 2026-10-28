import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { splitWechatText } from './render.js';

export interface IlinkMedia {
  full_url?: string;
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface IlinkMsgItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { media?: IlinkMedia; text?: string };
  image_item?: { media?: IlinkMedia; thumb_media?: IlinkMedia; aeskey?: string; mid_size?: number };
  file_item?: { media?: IlinkMedia; file_name?: string; len?: string; md5?: string };
  video_item?: { media?: IlinkMedia; thumb_media?: IlinkMedia; video_size?: number };
  ref_msg?: { message_item?: IlinkMsgItem; title?: string };
}

export interface IlinkMessage {
  seq?: number;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: IlinkMsgItem[];
  context_token?: string;
}

interface UpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
}

interface TypingConfigResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface InboundMessage {
  from: string;
  messageId: string;
  timeMs: number;
  text: string;
  attachments: InboundAttachment[];
  contextToken: string;
  raw: IlinkMessage;
}

export interface InboundAttachment {
  kind: 'image' | 'file' | 'video' | 'audio';
  name: string;
  /** Absolute path to the decrypted file in dataDir/incoming-media. */
  path?: string;
  /** Short user-facing reason when this attachment could not be downloaded. */
  error?: string;
}

export interface PollResult {
  messages: InboundMessage[];
  cursor?: string;
  sessionExpired: boolean;
  error?: string;
}

export interface SendResult {
  ok: boolean;
  code?: number;
  errmsg?: string;
  raw?: string;
  needsFreshContext?: boolean;
}

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const SESSION_EXPIRED = -14;
const TYPING_CONFIG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INCOMING_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_INCOMING_MESSAGE_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_INCOMING_MESSAGE_MEDIA_COUNT = 5;
const MAX_INCOMING_POLL_MEDIA_TIME_MS = 30_000;
const MAX_INCOMING_MEDIA_DOWNLOAD_TIME_MS = 30_000;
const INCOMING_MEDIA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const INCOMING_MEDIA_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const incomingMediaDirectorySetup = new Map<string, { promise: Promise<void>; checkedAt: number }>();

function randomUin(): string {
  const value = Math.floor(Math.random() * 0xffffffff) >>> 0;
  return Buffer.from(String(value)).toString('base64');
}

function randomHex(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`invalid JSON response: ${text.slice(0, 300)}`);
  }
}

function aesKeyFromBase64(value: string | undefined): Buffer | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value.trim(), 'base64');
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) {
      return Buffer.from(decoded.toString('ascii'), 'hex');
    }
  } catch {
    // Ignore malformed media keys.
  }
  return null;
}

function decryptEcb(cipher: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}

function aesKeyFromHex(value: string | undefined): Buffer | null {
  const normalized = value?.trim();
  if (!normalized || !/^[0-9a-f]{32}$/i.test(normalized)) return null;
  return Buffer.from(normalized, 'hex');
}

function mediaDownloadUrl(media: IlinkMedia, cdnBase: string): string | null {
  const fullUrl = media.full_url?.trim();
  if (fullUrl) {
    try {
      const parsed = new URL(fullUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      const configuredOrigin = new URL(cdnBase).origin;
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      const isWechatCdn = parsed.protocol === 'https:'
        && (host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com'));
      if (parsed.origin !== configuredOrigin && !isWechatCdn) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }
  const encryptedQuery = media.encrypt_query_param?.trim();
  if (!encryptedQuery) return null;
  try {
    const base = new URL(`${cdnBase.replace(/\/+$/, '')}/download`);
    if (!['http:', 'https:'].includes(base.protocol)) return null;
    base.searchParams.set('encrypted_query_param', encryptedQuery);
    return base.toString();
  } catch {
    return null;
  }
}

function safeAttachmentName(rawName: string, kind: 'image' | 'file'): string {
  const normalized = rawName.replace(/\\/g, '/').split('/').at(-1)?.trim() ?? '';
  const safe = normalized
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._() -]/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  if (safe && safe !== '.' && safe !== '..') return safe;
  return kind === 'image' ? 'image.jpg' : 'file';
}

function outputFileName(name: string): string {
  const extension = path.extname(name).slice(0, 12);
  const stem = path.basename(name, extension).slice(0, 80) || 'attachment';
  const safeExtension = /^\.[\p{L}\p{N}]{1,10}$/u.test(extension) ? extension : '';
  return `${stem}-${randomBytes(8).toString('hex')}${safeExtension}`;
}

async function ensureIncomingMediaDirectory(dataDir: string): Promise<string> {
  const mediaDir = path.resolve(dataDir, 'incoming-media');
  let setup = incomingMediaDirectorySetup.get(mediaDir);
  const now = Date.now();
  if (!setup || now - setup.checkedAt >= INCOMING_MEDIA_CLEANUP_INTERVAL_MS) {
    const promise = (async () => {
      await mkdir(mediaDir, { recursive: true });
      const cutoff = Date.now() - INCOMING_MEDIA_RETENTION_MS;
      const entries = await readdir(mediaDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(mediaDir, entry.name);
        const details = await stat(filePath).catch(() => null);
        if (details && details.mtimeMs < cutoff) await rm(filePath, { force: true }).catch(() => undefined);
      }
    })();
    setup = { promise, checkedAt: now };
    incomingMediaDirectorySetup.set(mediaDir, setup);
  }
  try {
    await setup.promise;
  } catch (error) {
    if (incomingMediaDirectorySetup.get(mediaDir) === setup) incomingMediaDirectorySetup.delete(mediaDir);
    throw error;
  }
  return mediaDir;
}

function declaredMediaSize(value: number | string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset, null);
    if (bytesWritten <= 0) throw new Error('unable to write attachment');
    offset += bytesWritten;
  }
}

async function downloadAndDecrypt(
  media: IlinkMedia,
  key: Buffer | null,
  cdnBase: string,
  dataDir: string,
  name: string,
  maxPlainBytes: number,
  onPlainBytes: (bytes: number) => void,
  expectedMd5?: string,
  deadlineMs = Date.now() + MAX_INCOMING_MEDIA_DOWNLOAD_TIME_MS,
): Promise<{ path: string; size: number }> {
  if (!key) throw new Error('missing or invalid encryption key');
  if (expectedMd5 !== undefined && !/^[0-9a-f]{32}$/i.test(expectedMd5.trim())) {
    throw new Error('invalid expected MD5 checksum');
  }
  const url = mediaDownloadUrl(media, cdnBase);
  if (!url) throw new Error('missing or invalid media URL');

  const timeoutMs = Math.min(MAX_INCOMING_MEDIA_DOWNLOAD_TIME_MS, deadlineMs - Date.now());
  if (timeoutMs <= 0) throw new Error('media download deadline exceeded');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`media server returned HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INCOMING_MEDIA_BYTES + 16) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('attachment exceeds size limit');
    }
    if (!response.body) throw new Error('empty media response');

    const mediaDir = await ensureIncomingMediaDirectory(dataDir);
    const finalPath = path.join(mediaDir, outputFileName(name));
    const tempPath = `${finalPath}.part`;
    const file = await open(tempPath, 'wx', 0o600);
    let encryptedBytes = 0;
    let decryptedBytes = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const decipher = createDecipheriv('aes-128-ecb', key, null);
      const digest = createHash('md5');
      decipher.setAutoPadding(true);
      reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          encryptedBytes += chunk.length;
          if (encryptedBytes > MAX_INCOMING_MEDIA_BYTES + 16) throw new Error('attachment exceeds per-file size limit');
          const clear = decipher.update(chunk);
          decryptedBytes += clear.length;
          if (decryptedBytes > MAX_INCOMING_MEDIA_BYTES) throw new Error('attachment exceeds per-file size limit');
          if (decryptedBytes > maxPlainBytes) throw new Error('attachment exceeds per-message size limit');
          if (clear.length) {
            digest.update(clear);
            onPlainBytes(clear.length);
            await writeAll(file, clear);
          }
        }
      } finally {
        reader.releaseLock();
      }
      const last = decipher.final();
      decryptedBytes += last.length;
      if (decryptedBytes > MAX_INCOMING_MEDIA_BYTES) throw new Error('attachment exceeds per-file size limit');
      if (decryptedBytes > maxPlainBytes) throw new Error('attachment exceeds per-message size limit');
      if (last.length) {
        digest.update(last);
        onPlainBytes(last.length);
        await writeAll(file, last);
      }
      if (expectedMd5 && digest.digest('hex') !== expectedMd5.trim().toLowerCase()) {
        throw new Error('MD5 checksum mismatch');
      }
      await file.close();
      await rename(tempPath, finalPath);
      return { path: finalPath, size: decryptedBytes };
    } catch (error) {
      await reader?.cancel().catch(() => undefined);
      await file.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseText(items: IlinkMsgItem[]): string {
  for (const item of items) {
    if (item.type === ITEM_TEXT) {
      const text = (item.text_item?.text ?? '').trim();
      const ref = item.ref_msg;
      if (!ref) return text;
      const refType = ref.message_item?.type ?? 0;
      if ([ITEM_IMAGE, ITEM_FILE, ITEM_VIDEO, ITEM_VOICE].includes(refType)) return text;
      const quoted = ref.message_item ? parseText([ref.message_item]) : '';
      const prefix = [ref.title?.trim(), quoted].filter(Boolean).join(' | ');
      return prefix ? `[引用: ${prefix}]\n${text}` : text;
    }
    if (item.type === ITEM_VOICE && item.voice_item?.text?.trim()) return item.voice_item.text.trim();
  }
  return '';
}

async function parseAttachments(
  items: IlinkMsgItem[],
  cdnBase: string,
  dataDir: string,
  deadlineMs: number,
): Promise<InboundMessage['attachments']> {
  const result: Array<InboundAttachment | undefined> = items.map((item) => {
    if (item.type === ITEM_VIDEO && item.video_item?.media) return { kind: 'video', name: 'video' };
    if (item.type === ITEM_VOICE && item.voice_item?.media && !item.voice_item.text) return { kind: 'audio', name: 'voice' };
    return undefined;
  });
  const candidates: Array<{
    index: number;
    kind: 'image' | 'file';
    name: string;
    media: IlinkMedia;
    key: Buffer;
    sizeHint: number | null;
    expectedMd5?: string;
    actualBytes: number;
    accountedBytes: number;
  }> = [];
  let downloadedMediaCount = 0;
  let totalMediaBytes = 0;

  for (const [index, item] of items.entries()) {
    if (item.type !== ITEM_IMAGE && item.type !== ITEM_FILE) continue;
    const isImage = item.type === ITEM_IMAGE;
    const media = isImage ? item.image_item?.media : item.file_item?.media;
    if (!media) continue;
    const kind = isImage ? 'image' : 'file';
    const name = safeAttachmentName(isImage ? 'image.jpg' : item.file_item?.file_name || 'file', kind);
    const key = isImage
      ? aesKeyFromHex(item.image_item?.aeskey) ?? aesKeyFromBase64(media.aes_key)
      : aesKeyFromBase64(media.aes_key);
    const sizeHint = declaredMediaSize(isImage ? item.image_item?.mid_size : item.file_item?.len);
    const expectedMd5 = isImage ? undefined : item.file_item?.md5;

    const fail = (error: unknown): void => {
      result[index] = { kind, name, error: safeDownloadError(error) };
    };
    try {
      if (!key) throw new Error('missing or invalid encryption key');
      if (!mediaDownloadUrl(media, cdnBase)) throw new Error('missing or invalid media URL');
      if (expectedMd5 !== undefined && !/^[0-9a-f]{32}$/i.test(expectedMd5.trim())) {
        throw new Error('invalid expected MD5 checksum');
      }
      if (sizeHint !== null && sizeHint > MAX_INCOMING_MEDIA_BYTES) {
        throw new Error('attachment exceeds per-file size limit');
      }
      const remainingBytes = MAX_INCOMING_MESSAGE_MEDIA_BYTES - totalMediaBytes;
      if (sizeHint !== null && sizeHint > remainingBytes) {
        throw new Error('attachment exceeds per-message size limit');
      }
      if (downloadedMediaCount >= MAX_INCOMING_MESSAGE_MEDIA_COUNT) {
        throw new Error('message media count limit exceeded');
      }

      downloadedMediaCount += 1;
      const accountedBytes = sizeHint ?? 0;
      totalMediaBytes += accountedBytes;
      candidates.push({ index, kind, name, media, key, sizeHint, expectedMd5, actualBytes: 0, accountedBytes });
    } catch (error) {
      fail(error);
    }
  }

  await Promise.all(candidates.map(async (candidate) => {
    try {
      const attachment = await downloadAndDecrypt(
        candidate.media,
        candidate.key,
        cdnBase,
        dataDir,
        candidate.name,
        MAX_INCOMING_MEDIA_BYTES,
        (bytes) => {
          const nextActualBytes = candidate.actualBytes + bytes;
          const nextAccountedBytes = Math.max(candidate.sizeHint ?? 0, nextActualBytes);
          const delta = nextAccountedBytes - candidate.accountedBytes;
          if (totalMediaBytes + delta > MAX_INCOMING_MESSAGE_MEDIA_BYTES) {
            throw new Error('attachment exceeds per-message size limit');
          }
          candidate.actualBytes = nextActualBytes;
          candidate.accountedBytes = nextAccountedBytes;
          totalMediaBytes += delta;
        },
        candidate.expectedMd5,
        deadlineMs,
      );
      result[candidate.index] = { kind: candidate.kind, name: candidate.name, path: attachment.path };
    } catch (error) {
      result[candidate.index] = { kind: candidate.kind, name: candidate.name, error: safeDownloadError(error) };
    }
  }));

  return result.filter((attachment): attachment is InboundAttachment => Boolean(attachment));
}

function safeDownloadError(error: unknown): string {
  if (error instanceof Error && /per-file size limit/i.test(error.message)) return '附件超过单个 25 MiB 接收限制';
  if (error instanceof Error && /per-message size limit/i.test(error.message)) return '单条消息附件总大小超过 50 MiB 限制';
  if (error instanceof Error && /media count limit/i.test(error.message)) return '单条消息最多接收 5 个图片或文件';
  if (error instanceof Error && /size limit/i.test(error.message)) return '附件超过大小限制';
  if (error instanceof Error && /encryption key/i.test(error.message)) return '缺少或无效的解密密钥';
  if (error instanceof Error && /media URL/i.test(error.message)) return '附件下载地址无效';
  if (error instanceof Error && /deadline exceeded|timeout|aborted|abort/i.test(error.message)) return '附件下载超时，请重新发送';
  if (error instanceof Error && /HTTP (\d{3})/i.test(error.message)) return `附件服务器返回 HTTP ${error.message.match(/HTTP (\d{3})/i)?.[1]}`;
  if (error instanceof Error && /decrypt|wrong final block|bad decrypt/i.test(error.message)) return '附件解密失败';
  if (error instanceof Error && /MD5 checksum|expected MD5/i.test(error.message)) return '附件完整性校验失败';
  return '附件下载失败';
}

export class IlinkClient {
  private readonly typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  private readonly typingTicketRequests = new Map<string, Promise<string | null>>();

  constructor(private readonly config: AppConfig, private readonly token: string) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomUin(),
      Authorization: `Bearer ${this.token}`,
    };
  }

  private url(path: string): string {
    return `${this.config.apiBase.replace(/\/$/, '')}/${path}`;
  }

  async poll(cursor: string): Promise<PollResult> {
    try {
      const response = await request(
        this.url('ilink/bot/getupdates'),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            get_updates_buf: cursor,
            base_info: { channel_version: this.config.channelVersion },
          }),
        },
        this.config.pollTimeoutMs + 10_000,
      );
      const payload = await jsonResponse<UpdatesResponse>(response);
      if (payload.errcode === SESSION_EXPIRED) return { messages: [], sessionExpired: true };
      const code = payload.errcode ?? payload.ret ?? 0;
      if (code !== 0) return { messages: [], sessionExpired: false, error: payload.errmsg || `iLink getupdates failed: ${code}` };
      const messages: InboundMessage[] = [];
      const mediaDeadlineMs = Date.now() + MAX_INCOMING_POLL_MEDIA_TIME_MS;
      for (const raw of payload.msgs ?? []) {
        if (raw.message_type === MSG_TYPE_BOT) continue;
        if (raw.message_type !== undefined && raw.message_type !== 0 && raw.message_type !== MSG_TYPE_USER) continue;
        const from = (raw.from_user_id ?? '').trim();
        if (!from) continue;
        const items = raw.item_list ?? [];
        const text = parseText(items);
        const attachments = await parseAttachments(items, this.config.cdnBase, this.config.dataDir, mediaDeadlineMs);
        const contextToken = raw.context_token?.trim() ?? '';
        if (!text && attachments.length === 0 && !contextToken) continue;
        messages.push({
          from,
          messageId: String(raw.message_id ?? raw.create_time_ms ?? Date.now()),
          timeMs: raw.create_time_ms ?? Date.now(),
          text,
          attachments,
          contextToken,
          raw,
        });
      }
      const next = payload.get_updates_buf?.trim();
      return next ? { messages, cursor: next, sessionExpired: false } : { messages, sessionExpired: false };
    } catch (error) {
      if (error instanceof Error && /aborted|abort|timeout/i.test(error.message)) {
        return { messages: [], sessionExpired: false };
      }
      return { messages: [], sessionExpired: false, error: String(error) };
    }
  }

  async sendText(
    to: string,
    text: string,
    contextToken: string,
    chunkSize = this.config.chatChunkSize,
  ): Promise<SendResult> {
    if (!contextToken.trim()) {
      return {
        ok: false,
        errmsg: 'missing context_token; send a message to the bot first',
        needsFreshContext: true,
      };
    }
    const chunks = splitWechatText(text, chunkSize);
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) await sleep(100);
      const result = await this.sendOneText(to, chunks[index] ?? '', contextToken);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  private async sendOneText(to: string, text: string, contextToken: string): Promise<SendResult> {
    const normalizedContextToken = contextToken.trim();
    const response = await request(
      this.url('ilink/bot/sendmessage'),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          msg: {
            from_user_id: '',
            to_user_id: to,
            client_id: `wcb-${randomHex(8)}`,
            message_type: MSG_TYPE_BOT,
            message_state: MSG_STATE_FINISH,
            item_list: [{ type: ITEM_TEXT, text_item: { text } }],
            ...(normalizedContextToken ? { context_token: normalizedContextToken } : {}),
          },
          base_info: { channel_version: this.config.channelVersion },
        }),
      },
      15_000,
    );
    const raw = await response.text();
    if (!response.ok) return { ok: false, errmsg: `HTTP ${response.status}: ${raw.slice(0, 300)}`, raw };
    try {
      const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string };
      const code = parsed.ret ?? parsed.errcode;
      const errmsg = parsed.errmsg || undefined;
      const needsFreshContext = code === -2 || /prepare failed/i.test(errmsg || '');
      return {
        ok: (code ?? 0) === 0 && !errmsg,
        ...(code === undefined ? {} : { code }),
        ...(errmsg ? { errmsg } : {}),
        raw: raw.slice(0, 300),
        ...(needsFreshContext ? { needsFreshContext: true } : {}),
      };
    } catch {
      return { ok: true, raw: raw.slice(0, 300) };
    }
  }

  async prepareTyping(to: string, contextToken: string): Promise<boolean> {
    return Boolean(await this.typingTicket(to, contextToken));
  }

  async sendTyping(to: string, contextToken: string, status = 1): Promise<boolean> {
    const ticket = await this.typingTicket(to, contextToken);
    if (!ticket) return false;
    try {
      const response = await request(
        this.url('ilink/bot/sendtyping'),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            ilink_user_id: to,
            typing_ticket: ticket,
            status,
            base_info: { channel_version: this.config.channelVersion },
          }),
        },
        10_000,
      );
      const raw = await response.text();
      if (!response.ok) {
        this.typingTickets.delete(to);
        return false;
      }
      if (!raw.trim()) return true;
      try {
        const parsed = JSON.parse(raw) as { ret?: number; errcode?: number };
        const code = parsed.ret ?? parsed.errcode ?? 0;
        if (code !== 0) this.typingTickets.delete(to);
        return code === 0;
      } catch {
        return true;
      }
    } catch {
      this.typingTickets.delete(to);
      return false;
    }
  }

  private async typingTicket(to: string, contextToken: string): Promise<string | null> {
    const cached = this.typingTickets.get(to);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;
    if (!contextToken.trim()) return null;

    const pending = this.typingTicketRequests.get(to);
    if (pending) return pending;
    const requestTicket = this.fetchTypingTicket(to, contextToken);
    this.typingTicketRequests.set(to, requestTicket);
    try {
      return await requestTicket;
    } finally {
      if (this.typingTicketRequests.get(to) === requestTicket) this.typingTicketRequests.delete(to);
    }
  }

  private async fetchTypingTicket(to: string, contextToken: string): Promise<string | null> {
    try {
      const response = await request(
        this.url('ilink/bot/getconfig'),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            ilink_user_id: to,
            context_token: contextToken,
            base_info: { channel_version: this.config.channelVersion },
          }),
        },
        10_000,
      );
      const payload = await jsonResponse<TypingConfigResponse>(response);
      const code = payload.ret ?? payload.errcode ?? 0;
      const ticket = payload.typing_ticket?.trim() ?? '';
      if (code !== 0 || !ticket) return null;
      this.typingTickets.set(to, { ticket, expiresAt: Date.now() + TYPING_CONFIG_TTL_MS });
      return ticket;
    } catch {
      return null;
    }
  }
}

export interface LoginResult {
  token: string;
  botId: string;
  baseUrl: string;
  scannedUser: string;
}

export async function loginWithQr(config: AppConfig): Promise<LoginResult> {
  const qrResponse = await request(`${config.apiBase}/ilink/bot/get_bot_qrcode?bot_type=3`, {}, 20_000);
  const qr = await jsonResponse<{ qrcode?: string; qrcode_img_content?: string }>(qrResponse);
  const key = qr.qrcode?.trim();
  const content = qr.qrcode_img_content?.trim();
  if (!key || !content) throw new Error('get_bot_qrcode response did not contain a QR code');

  process.stdout.write('\n请使用微信扫描二维码：\n');
  try {
    const qrcode = await import('qrcode');
    process.stdout.write(await qrcode.toString(content, { type: 'terminal', small: true }));
  } catch {
    process.stdout.write(`二维码内容：${content}\n`);
  }
  process.stdout.write(`\n二维码链接：${content}\n`);

  const deadline = Date.now() + 8 * 60_000;
  let printedScan = false;
  while (Date.now() < deadline) {
    const response = await request(
      `${config.apiBase}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(key)}`,
      { headers: { 'iLink-App-ClientVersion': '1' } },
      40_000,
    );
    const status = await jsonResponse<{
      status?: string;
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
    }>(response);
    if (status.status === 'scaned' && !printedScan) {
      printedScan = true;
      process.stdout.write('已扫码，请在微信中确认……\n');
    }
    if (status.status === 'confirmed') {
      if (!status.bot_token || !status.ilink_bot_id) throw new Error('QR login confirmed without bot credentials');
      return {
        token: status.bot_token,
        botId: status.ilink_bot_id,
        baseUrl: status.baseurl?.trim() || config.apiBase,
        scannedUser: status.ilink_user_id?.trim() || '',
      };
    }
    if (status.status === 'expired') throw new Error('二维码已过期，请重新执行 login');
    await sleep(500);
  }
  throw new Error('二维码登录超时');
}

export function md5Hex(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

export function encryptMedia(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function decryptMedia(data: Buffer, key: Buffer): Buffer {
  return decryptEcb(data, key);
}

export { aesKeyFromBase64 };
