import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { marked, Renderer } from 'marked';
import type { AppConfig } from './config.js';
import type { PresentationMode } from './model.js';

const ANSI_ESCAPE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export interface RenderInput {
  text: string;
  title?: string;
  presentation?: PresentationMode;
  kind?: 'plain' | 'plan' | 'diff' | 'report' | 'code';
  cwd?: string;
}

export interface SharePageOptions {
  projectName?: string;
  kind?: RenderInput['kind'];
  description?: string;
}

export interface RenderedText {
  mode: 'chat';
  text: string;
}

export interface RenderedPage {
  mode: 'page';
  title: string;
  url: string;
  fallback: string;
}

export type RenderedResponse = RenderedText | RenderedPage;

export function normalizeWechatText(input: string): string {
  return input
    .replace(ANSI_ESCAPE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Block {
  text: string;
  code: boolean;
}

function blocksOf(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let current: string[] = [];
  let code = false;
  const flush = () => {
    const value = current.join('\n').trim();
    if (value) blocks.push({ text: value, code });
    current = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (code) {
        current.push(line);
        flush();
        code = false;
      } else {
        flush();
        code = true;
        current.push(line);
      }
      continue;
    }
    if (!code && !line.trim()) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

function hardSplit(text: string, max: number, code: boolean): string[] {
  if (Array.from(text).length <= max) return [text];
  if (code) {
    const lines = text.split('\n');
    const hasFence = lines.length >= 2 && lines[0]?.trimStart().startsWith('```') && lines.at(-1)?.trim() === '```';
    const opening = hasFence ? lines[0] || '```' : '```';
    const closing = hasFence ? lines.at(-1) || '```' : '```';
    const body = hasFence ? lines.slice(1, -1).join('\n') : text;
    const payloadMax = max - Array.from(opening).length - Array.from(closing).length - 2;
    if (payloadMax > 0 && body !== text) {
      const chars = Array.from(body);
      const result: string[] = [];
      for (let i = 0; i < chars.length; i += payloadMax) {
        result.push(`${opening}\n${chars.slice(i, i + payloadMax).join('')}\n${closing}`);
      }
      return result;
    }
  }
  const chars = Array.from(text);
  const result: string[] = [];
  for (let i = 0; i < chars.length; i += max) {
    const part = chars.slice(i, i + max).join('');
    result.push(code ? `\`\`\`\n${part}\n\`\`\`` : part);
  }
  return result;
}

/** Split on paragraph/code-block boundaries, with a hard Unicode-safe fallback. */
export function splitWechatText(input: string, max = 1200): string[] {
  const text = normalizeWechatText(input);
  if (!text) return [''];
  max = Math.max(1, Math.floor(max));
  if (Array.from(text).length <= max) return [text];

  const chunks: string[] = [];
  let current = '';
  for (const block of blocksOf(text)) {
    const pieces = hardSplit(block.text, max, block.code);
    for (const piece of pieces) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (Array.from(candidate).length <= max) current = candidate;
      else {
        if (current) chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.slice(0, max)];
}

function htmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

const MAX_PAGE_TITLE_LENGTH = 80;
const MAX_PAGE_DESCRIPTION_LENGTH = 180;

function plainPageText(value: string): string {
  return value
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncatePageText(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

function firstMarkdownHeading(markdown: string): string | undefined {
  let fenced = false;
  let secondaryHeading: string | undefined;
  for (const line of normalizeWechatText(markdown).split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s*(#{1,2})\s+(.+?)\s*$/.exec(line);
    const value = match?.[2] ? plainPageText(match[2]) : '';
    if (!value) continue;
    if (match?.[1] === '#') return value;
    secondaryHeading ??= value;
  }
  return secondaryHeading;
}

function firstMeaningfulPageLine(markdown: string): string | undefined {
  let fenced = false;
  for (const line of normalizeWechatText(markdown).split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const value = plainPageText(line);
    if (value && !/^[-*_]{3,}$/.test(value)) return value;
  }
  return undefined;
}

function fallbackPageTitle(kind: RenderInput['kind'], reportLike: boolean): string {
  if (reportLike || kind === 'report') return '项目分析';
  if (kind === 'plan') return '执行计划';
  if (kind === 'diff') return '代码变更摘要';
  if (kind === 'code') return '代码内容';
  return '分享内容';
}

function resolvePageTitle(
  markdown: string,
  requestedTitle: string | undefined,
  kind: RenderInput['kind'],
  reportLike: boolean,
): string {
  const explicit = requestedTitle ? plainPageText(requestedTitle) : '';
  if (explicit) return truncatePageText(explicit, MAX_PAGE_TITLE_LENGTH);
  const heading = firstMarkdownHeading(markdown);
  if (heading) return truncatePageText(heading, MAX_PAGE_TITLE_LENGTH);
  if (!reportLike && (!kind || kind === 'plain')) {
    const firstLine = firstMeaningfulPageLine(markdown);
    if (firstLine) return truncatePageText(firstLine, MAX_PAGE_TITLE_LENGTH);
  }
  return fallbackPageTitle(kind, reportLike);
}

function derivePageDescription(markdown: string, title: string): string {
  for (const block of blocksOf(normalizeWechatText(markdown))) {
    if (block.code) continue;
    const value = plainPageText(block.text);
    if (value && value !== title) return truncatePageText(value, MAX_PAGE_DESCRIPTION_LENGTH);
  }
  return truncatePageText(title, MAX_PAGE_DESCRIPTION_LENGTH);
}

function projectNameFromCwd(cwd?: string): string | undefined {
  const value = cwd?.trim().replace(/[\\/]+$/, '');
  if (!value) return undefined;
  const nativeName = path.basename(value);
  const name = nativeName === value ? path.win32.basename(value) : nativeName;
  if (!name || name === '.' || name === '..') return undefined;
  return truncatePageText(plainPageText(name), 48) || undefined;
}

function documentTitle(title: string, projectName?: string): string {
  const parts = [title, projectName && projectName.toLowerCase() !== 'wecode' ? projectName : undefined, 'wecode']
    .filter((value): value is string => Boolean(value));
  return truncatePageText(parts.join(' · '), 120);
}

function pageTypeLabel(kind: RenderInput['kind']): string {
  if (kind === 'report') return '项目分析';
  if (kind === 'plan') return '执行计划';
  if (kind === 'diff') return '代码变更';
  if (kind === 'code') return '代码内容';
  return '长文分享';
}

function stripLeadingTitleHeading(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  let index = 0;
  while (index < lines.length && !lines[index]?.trim()) index += 1;
  const match = /^\s*#\s+(.+?)\s*$/.exec(lines[index] ?? '');
  if (!match || plainPageText(match[1] ?? '') !== title) return markdown;
  lines.splice(index, 1);
  return lines.join('\n').replace(/^\n+/, '');
}

function safeHref(href: string): string | null {
  const value = href.trim();
  if (value.startsWith('#')) return value;
  try {
    const protocol = new URL(value).protocol;
    return ['http:', 'https:', 'mailto:'].includes(protocol) ? value : null;
  } catch {
    return null;
  }
}

function slugForHeading(text: string): string {
  const normalized = text.replace(/<[^>]+>/g, '').trim().toLowerCase();
  if (normalized === '引用文件正文') return 'attachments';
  return normalized
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function renderMarkdown(markdown: string): string {
  const renderer = new Renderer();
  renderer.html = ({ text }) => htmlEscape(text);
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    return `<h${depth} id="${htmlEscape(slugForHeading(text))}">${text}</h${depth}>`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const cleanHref = safeHref(href);
    if (!cleanHref) return text;
    const titleAttribute = title ? ` title="${htmlEscape(title)}"` : '';
    return `<a href="${htmlEscape(cleanHref)}"${titleAttribute}>${text}</a>`;
  };
  renderer.image = ({ href, title, text }) => {
    const cleanHref = safeHref(href);
    if (!cleanHref) return `<span class="media-note">${htmlEscape(text)}</span>`;
    const titleAttribute = title ? ` title="${htmlEscape(title)}"` : '';
    return `<img src="${htmlEscape(cleanHref)}" alt="${htmlEscape(text)}" loading="lazy"${titleAttribute}>`;
  };
  const rendered = marked.parse(markdown, { async: false, gfm: true, renderer });
  return typeof rendered === 'string' ? rendered : htmlEscape(markdown);
}

export function renderPageHtml(title: string, markdown: string, options: SharePageOptions = {}): string {
  const safeTitle = truncatePageText(plainPageText(title) || '分享内容', MAX_PAGE_TITLE_LENGTH);
  const projectName = options.projectName ? truncatePageText(plainPageText(options.projectName), 48) : undefined;
  const description = truncatePageText(
    plainPageText(options.description || derivePageDescription(markdown, safeTitle)) || safeTitle,
    MAX_PAGE_DESCRIPTION_LENGTH,
  );
  const body = renderMarkdown(stripLeadingTitleHeading(markdown, safeTitle));
  const titleWithBrand = documentTitle(safeTitle, projectName);
  const projectLabel = projectName ? `<span class="project-label">· ${htmlEscape(projectName)}</span>` : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0f172a">
<meta name="description" content="${htmlEscape(description)}">
<meta name="robots" content="noindex, nofollow">
<meta property="og:title" content="${htmlEscape(safeTitle)}">
<meta property="og:description" content="${htmlEscape(description)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="wecode">
<meta name="twitter:card" content="summary">
<title>${htmlEscape(titleWithBrand)}</title>
<style>
:root{color-scheme:light;--ink:#172033;--muted:#64748b;--line:#dbe3ed;--soft:#f5f8fb;--navy:#0f172a;--green:#16a34a;--code:#0b1220}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#e9eef4;color:var(--ink);font:17px/1.8 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}
.skip-link{position:absolute;left:-9999px;top:12px}.skip-link:focus{left:12px;z-index:5;padding:8px 12px;border-radius:8px;background:#fff;color:var(--navy)}
.page-shell{max-width:1024px;min-height:100vh;margin:0 auto;background:#fff;box-shadow:0 12px 40px rgba(15,23,42,.12)}
.share-hero{position:relative;overflow:hidden;padding:30px 22px 34px;background:var(--navy);color:#f8fafc}.share-hero:after{content:"";position:absolute;width:190px;height:190px;right:-60px;top:-70px;border:1px solid rgba(134,239,172,.35);border-radius:50%;box-shadow:0 0 0 24px rgba(134,239,172,.06),0 0 0 48px rgba(134,239,172,.04)}
.brand{position:relative;z-index:1;display:flex;align-items:center;gap:9px;color:#86efac;font-size:12px;font-weight:700;letter-spacing:.14em}.brand-mark{display:grid;place-items:center;width:24px;height:24px;border:1px solid #86efac;border-radius:6px;font-size:13px;letter-spacing:0}.project-label{color:#cbd5e1;font-weight:500;letter-spacing:0}
.share-hero h1{position:relative;z-index:1;max-width:780px;margin:24px 0 8px;font-size:clamp(1.75rem,6vw,2.65rem);line-height:1.18;letter-spacing:-.025em;overflow-wrap:anywhere}.share-subtitle{position:relative;z-index:1;margin:0;color:#cbd5e1;font-size:14px}
.share-content{padding:28px 22px 52px}.markdown-body{max-width:74ch;margin:0 auto}.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{color:var(--ink);line-height:1.3;scroll-margin-top:20px}.markdown-body h1{font-size:1.7rem;margin:0 0 1rem}.markdown-body h2{margin:2.2rem 0 .75rem;padding-left:12px;border-left:4px solid var(--green);font-size:1.35rem}.markdown-body h3{margin:1.7rem 0 .5rem;font-size:1.12rem}.markdown-body p{margin:0 0 1rem}.markdown-body ul,.markdown-body ol{padding-left:1.35rem}.markdown-body li+li{margin-top:.35rem}
.markdown-body a{color:#166534;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}.markdown-body a:hover{color:#14532d}.markdown-body strong{color:#0f172a}.markdown-body hr{margin:2.5rem 0;border:0;border-top:1px solid var(--line)}
.markdown-body blockquote{margin:1.25rem 0;padding:12px 16px;border-left:4px solid #94a3b8;background:var(--soft);color:#475569}.markdown-body code{padding:.15em .35em;border:1px solid #dbe3ed;border-radius:5px;background:#f1f5f9;font:0.88em ui-monospace,SFMono-Regular,Menlo,monospace}.markdown-body pre{margin:1.25rem 0;padding:16px;overflow:auto;border:1px solid #1e293b;border-radius:12px;background:var(--code);color:#e2e8f0;font:0.83em/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-overflow-scrolling:touch}.markdown-body pre code{padding:0;border:0;background:transparent;color:inherit}.markdown-body table{display:block;width:max-content;min-width:100%;max-width:100%;overflow:auto;border-collapse:collapse;margin:1.25rem 0;font-size:.92em}.markdown-body th,.markdown-body td{padding:9px 11px;border:1px solid var(--line);text-align:left;vertical-align:top}.markdown-body th{background:#f1f5f9;font-weight:700}.markdown-body img{display:block;max-width:100%;height:auto;border-radius:10px}.media-note{color:var(--muted);font-style:italic}
.share-footer{padding:18px 22px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;text-align:center}.share-footer span{color:var(--green)}
@media(min-width:700px){.share-hero{padding:48px 64px 52px}.share-content{padding:48px 64px 72px}.share-footer{padding-left:64px;padding-right:64px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{body{background:#fff}.page-shell{box-shadow:none}.share-hero{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
</style></head><body><a class="skip-link" href="#share-content">跳到正文</a><main class="page-shell"><header class="share-hero"><div class="brand"><span class="brand-mark">W</span><span>wecode</span>${projectLabel}</div><h1>${htmlEscape(safeTitle)}</h1><p class="share-subtitle">${htmlEscape(pageTypeLabel(options.kind))}</p></header><article id="share-content" class="share-content markdown-body">${body}</article><footer class="share-footer">Powered by <span>wecode</span> · 临时分享页 · 到期后失效</footer></main></body></html>`;
}

interface ReferencedMarkdownFile {
  absolutePath: string;
  relativePath: string;
  content: string;
}

const MARKDOWN_FILE_REFERENCE = /(?:\/?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.md\b|\/?[A-Za-z0-9_.-]+\.md\b)/g;
const MARKDOWN_LINK_REFERENCE = /\[([^\]]+)\]\(([^)]+)\)/g;
const MAX_ATTACHMENT_BYTES = 300_000;
const MAX_ATTACHMENT_TOTAL_BYTES = 600_000;

function attachmentPath(raw: string, cwd: string, realCwd: string): { absolutePath: string; relativePath: string } | null {
  const candidate = raw.trim().replace(/^<|>$/g, '').replace(/^file:\/\//, '');
  if (!candidate.toLowerCase().endsWith('.md')) return null;
  const absolutePath = path.resolve(path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate));
  const relativePath = path.relative(realCwd, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return { absolutePath, relativePath };
}

async function loadReferencedMarkdownFiles(markdown: string, cwd?: string): Promise<ReferencedMarkdownFile[]> {
  if (!cwd) return [];
  const realCwd = await realpath(cwd).catch(() => null);
  if (!realCwd) return [];
  const candidates = new Set(markdown.match(MARKDOWN_FILE_REFERENCE) ?? []);
  const attachments: ReferencedMarkdownFile[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const resolved = attachmentPath(candidate, cwd, realCwd);
    if (!resolved) continue;
    const realFile = await realpath(resolved.absolutePath).catch(() => null);
    if (!realFile) continue;
    const relativePath = path.relative(realCwd, realFile);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) continue;
    const content = await readFile(realFile, 'utf8').catch(() => null);
    if (content === null) continue;
    const size = Buffer.byteLength(content, 'utf8');
    if (size > MAX_ATTACHMENT_BYTES || totalBytes + size > MAX_ATTACHMENT_TOTAL_BYTES) continue;
    totalBytes += size;
    attachments.push({ absolutePath: realFile, relativePath, content });
  }
  return attachments;
}

async function includeReferencedMarkdown(markdown: string, cwd?: string): Promise<string> {
  const attachments = await loadReferencedMarkdownFiles(markdown, cwd);
  if (!attachments.length) return markdown;
  const rewritten = markdown.replace(MARKDOWN_LINK_REFERENCE, (full, label: string, target: string) => {
    const resolved = cwd ? attachmentPath(target, cwd, path.resolve(cwd)) : null;
    const attachment = resolved ? attachments.find((item) => item.relativePath === resolved.relativePath) : undefined;
    return attachment ? `[${label}](#attachments)` : full;
  });
  const body = attachments
    .map((attachment) => `### \`${attachment.relativePath}\`\n\n${attachment.content.trim()}`)
    .join('\n\n---\n\n');
  return `${rewritten}\n\n---\n\n## 引用文件正文\n\n${body}`;
}

interface PageRecord {
  html: string;
  expiresAt: number;
}

/** Owns ephemeral Markdown pages and the optional Cloudflare Quick Tunnel. */
export class PagePublisher {
  private server: ReturnType<typeof createServer> | null = null;
  private port = 0;
  private publicBaseUrl: string;
  private tunnel: ChildProcess | null = null;
  private pages = new Map<string, PageRecord>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private sharePageError = '';

  constructor(private readonly config: AppConfig) {
    this.publicBaseUrl = config.sharePageBaseUrl.replace(/\/$/, '');
  }

  unavailableMessage(): string {
    return this.sharePageError || '⚠️ 分享页暂不可用：未找到可用的 Cloudflare Tunnel。请安装 cloudflared，或配置 SHARE_PAGE_BASE_URL。';
  }

  async publish(title: string, markdown: string, options: SharePageOptions = {}): Promise<{ url: string; title: string }> {
    await this.ensureServer();
    const slug = randomBytes(12).toString('hex');
    this.pages.set(slug, { html: renderPageHtml(title, markdown, options), expiresAt: Date.now() + this.config.pageTtlMs });
    const publicBaseUrl = await this.ensureTunnel();
    return { url: `${publicBaseUrl}/p/${slug}`, title };
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.pages.clear();
    this.tunnel?.kill('SIGTERM');
    this.tunnel = null;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private async ensureServer(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => this.serve(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('page server did not expose a TCP port');
    this.port = address.port;
    this.cleanupTimer = setInterval(() => this.expirePages(), 60_000);
    this.cleanupTimer.unref();
  }

  private serve(request: IncomingMessage, response: ServerResponse): void {
    const slug = request.url?.match(/^\/p\/([a-f0-9]+)$/)?.[1];
    const page = slug ? this.pages.get(slug) : undefined;
    if (!page || page.expiresAt <= Date.now()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Page expired');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(page.html);
  }

  private expirePages(): void {
    const now = Date.now();
    for (const [slug, page] of this.pages) if (page.expiresAt <= now) this.pages.delete(slug);
  }

  private async ensureTunnel(): Promise<string> {
    if (this.publicBaseUrl) return this.publicBaseUrl;
    const localUrl = `http://127.0.0.1:${this.port}`;
    const tunnel = spawn(this.config.cloudflaredCommand, ['tunnel', '--url', localUrl, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.tunnel = tunnel;
    let buffer = '';
    const findUrl = (chunk: Buffer | string): string | undefined => {
      buffer += String(chunk);
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      return match?.[0];
    };
    const waitForUrl = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cloudflared did not provide a Quick Tunnel URL')), 20_000);
      const onData = (chunk: Buffer | string) => {
        const url = findUrl(chunk);
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      };
      tunnel.stdout?.on('data', onData);
      tunnel.stderr?.on('data', onData);
      tunnel.once('error', (error) => {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
        this.sharePageError = code === 'ENOENT'
          ? '⚠️ 分享页暂不可用：未安装 cloudflared。请安装后重试。'
          : `⚠️ 分享页暂不可用：Cloudflare Tunnel 启动失败（${error instanceof Error ? error.message : String(error)}）。`;
        clearTimeout(timer);
        reject(error);
      });
      tunnel.once('exit', (code) => {
        if (code && !this.publicBaseUrl) {
          this.sharePageError = `⚠️ 分享页暂不可用：cloudflared 退出（code ${code}）。`;
          clearTimeout(timer);
          reject(new Error(`cloudflared exited with code ${code}`));
        }
      });
    });
    try {
      this.publicBaseUrl = await waitForUrl;
      return this.publicBaseUrl;
    } catch (error) {
      if (!this.sharePageError) this.sharePageError = `⚠️ 分享页暂不可用：${error instanceof Error ? error.message : String(error)}`;
      tunnel.kill('SIGTERM');
      this.tunnel = null;
      throw error;
    }
  }
}

export async function renderResponse(input: RenderInput, pages: PagePublisher): Promise<RenderedResponse> {
  const text = normalizeWechatText(input.text);
  const length = Array.from(text).length;
  const reportLike = looksLikeReport(input.text);
  const semanticPage = input.presentation === 'page'
    || input.kind === 'report'
    || reportLike
    || ((input.kind === 'plan' || input.kind === 'diff') && length > 1500);
  const safetyPage = length > 12_000;
  if (semanticPage || safetyPage) {
    try {
      const pageMarkdown = await includeReferencedMarkdown(input.text, input.cwd);
      const title = resolvePageTitle(pageMarkdown, input.title, input.kind, reportLike);
      const pageKind = reportLike || input.kind === 'report' ? 'report' : input.kind;
      const page = await pages.publish(title, pageMarkdown, {
        projectName: projectNameFromCwd(input.cwd),
        kind: pageKind,
      });
      // Keep the URL as the complete message so WeChat can recognize it as a
      // native link instead of treating it as part of a formatted label.
      return { mode: 'page', title: page.title, url: page.url, fallback: page.url };
    } catch (error) {
      process.stderr.write(`[sharepage] ${error instanceof Error ? error.message : String(error)}\n`);
      return { mode: 'chat', text: `${pages.unavailableMessage()}\n\n${text}` };
    }
  }
  return { mode: 'chat', text };
}

function looksLikeReport(input: string): boolean {
  const length = Array.from(normalizeWechatText(input)).length;
  if (/(?:主报告|详细研究版|已完成分析并生成报告|生成了?总结报告|分析报告)/i.test(input)) return true;
  if (length < 1500) return false;
  const headings = (input.match(/^\s*#{1,6}\s+/gm) ?? []).length;
  const markers = [
    /总结|报告|结论/i,
    /建议|改进|风险/i,
    /测试|验证/i,
    /架构|目录结构|文件变更/i,
    /代码质量|问题|发现/i,
  ].filter((pattern) => pattern.test(input)).length;
  return (headings >= 2 && markers >= 2) || markers >= 4;
}
