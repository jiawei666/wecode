import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import type { AppConfig } from './config.js';
import { splitWechatText } from './render.js';

export interface IlinkMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface IlinkMsgItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { media?: IlinkMedia; text?: string };
  image_item?: { media?: IlinkMedia; thumb_media?: IlinkMedia; aeskey?: string; mid_size?: number };
  file_item?: { media?: IlinkMedia; file_name?: string; len?: string };
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

export interface InboundMessage {
  from: string;
  messageId: string;
  timeMs: number;
  text: string;
  attachments: Array<{ kind: 'image' | 'file' | 'video' | 'audio'; name: string }>;
  contextToken: string;
  raw: IlinkMessage;
}

export interface PollResult {
  messages: InboundMessage[];
  cursor?: string;
  sessionExpired: boolean;
  error?: string;
}

export interface SendResult {
  ok: boolean;
  errmsg?: string;
  raw?: string;
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

async function parseAttachments(items: IlinkMsgItem[], cdnBase: string): Promise<InboundMessage['attachments']> {
  // The first vertical slice keeps the message metadata but does not copy media to disk.
  // A later adapter can pass decrypted localImage paths to Codex without changing routing.
  void cdnBase;
  const result: InboundMessage['attachments'] = [];
  for (const item of items) {
    if (item.type === ITEM_IMAGE && item.image_item?.media) result.push({ kind: 'image', name: 'image' });
    if (item.type === ITEM_FILE && item.file_item?.media) result.push({ kind: 'file', name: item.file_item.file_name || 'file' });
    if (item.type === ITEM_VIDEO && item.video_item?.media) result.push({ kind: 'video', name: 'video' });
    if (item.type === ITEM_VOICE && item.voice_item?.media && !item.voice_item.text) result.push({ kind: 'audio', name: 'voice' });
  }
  return result;
}

export class IlinkClient {
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
      for (const raw of payload.msgs ?? []) {
        if (raw.message_type === MSG_TYPE_BOT) continue;
        if (raw.message_type !== undefined && raw.message_type !== 0 && raw.message_type !== MSG_TYPE_USER) continue;
        const from = (raw.from_user_id ?? '').trim();
        if (!from) continue;
        const items = raw.item_list ?? [];
        const text = parseText(items);
        const attachments = await parseAttachments(items, this.config.cdnBase);
        if (!text && attachments.length === 0) continue;
        messages.push({
          from,
          messageId: String(raw.message_id ?? raw.create_time_ms ?? Date.now()),
          timeMs: raw.create_time_ms ?? Date.now(),
          text,
          attachments,
          contextToken: raw.context_token?.trim() ?? '',
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

  async sendText(to: string, text: string, contextToken: string, chunkSize = this.config.chatChunkSize): Promise<SendResult> {
    if (!contextToken.trim()) return { ok: false, errmsg: 'missing context_token; send a message to the bot first' };
    const chunks = splitWechatText(text, chunkSize);
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) await sleep(100);
      const result = await this.sendOneText(to, chunks[index] ?? '', contextToken);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  private async sendOneText(to: string, text: string, contextToken: string): Promise<SendResult> {
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
            context_token: contextToken,
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
      const ok = (parsed.ret ?? parsed.errcode ?? 0) === 0 && !parsed.errmsg;
      return { ok, errmsg: parsed.errmsg, raw: raw.slice(0, 300) };
    } catch {
      return { ok: true, raw: raw.slice(0, 300) };
    }
  }

  async sendTyping(_to: string, _contextToken: string, _status = 1): Promise<void> {
    // iLink deployments differ on the typing endpoint. Final replies are stable;
    // keep this seam for a later capability-detected implementation.
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
