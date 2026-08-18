import path from 'node:path';
import type { AppConfig } from './config.js';
import type { SessionBinding, SessionSelectionItem, ThreadSummary } from './model.js';

export interface DisplaySession extends ThreadSummary {
  note?: string;
  fast?: boolean;
}

export interface SessionListResult {
  text: string;
  items: SessionSelectionItem[];
}

export function buildSessionList(
  threads: ThreadSummary[],
  config: AppConfig,
  options: {
    current?: SessionBinding;
    notes?: Record<string, string>;
    fullIds?: boolean;
    limit?: number;
  } = {},
): SessionListResult {
  const notes = options.notes ?? {};
  const current = options.current;
  const merged = [...threads];
  if (current && !merged.some((thread) => thread.id === current.threadId)) {
    merged.unshift({
      id: current.threadId,
      cli: current.cli ?? 'codex',
      cwd: current.cwd,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      serviceTier: current.fast ? 'fast' : null,
      name: current.note,
    });
  }
  merged.sort((left, right) => {
    if (left.id === current?.threadId) return -1;
    if (right.id === current?.threadId) return 1;
    return (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0);
  });

  const limit = options.limit ?? config.sessionListLimit;
  const visible = merged.slice(0, limit);
  const items = visible.map((thread) => ({
    cli: thread.cli ?? 'codex',
    threadId: thread.id,
    cwd: thread.cwd || config.defaultCwd,
    ...(thread.name ? { name: thread.name } : {}),
    ...(thread.preview ? { preview: thread.preview } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.reasoningEffort ? { reasoningEffort: thread.reasoningEffort } : {}),
    ...(thread.serviceTier ? { fast: isFastTier(thread.serviceTier) } : { fast: false }),
  }));

  if (!visible.length) return { text: '没有找到 Codex 原生会话。', items: [] };
  const lines = visible.map((thread, index) => {
    const note = notes[thread.id] || thread.name;
    const title = truncate(note || thread.preview || path.basename(thread.cwd || '') || '未命名会话', 42);
    const project = thread.cwd ? path.basename(thread.cwd) : '未知目录';
    const model = formatModel(thread.model, thread.reasoningEffort, thread.serviceTier);
    const shortId = options.fullIds ? thread.id : shortIdOf(thread.id);
    const currentMark = thread.id === current?.threadId ? ' · 当前' : '';
    return `${index + 1}. [${cliLabel(thread.cli)}] ${title}${currentMark}\n   ${project} · ${relativeTime(thread.updatedAt ?? thread.createdAt)} · ${model}\n   ${shortId}`;
  });
  const scope = visible.length < merged.length ? `最近 ${visible.length}/${merged.length}` : `${visible.length}`;
  return {
    text: `Codex 会话（${scope}）:\n\n${lines.join('\n\n')}\n\n回复序号切换（${Math.round(config.selectionTimeoutMs / 60_000)} 分钟内），或发送 /use <完整 ID>。`,
    items,
  };
}

export function shortIdOf(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 8)}…${threadId.slice(-4)}` : threadId;
}

export function formatModel(model?: string, reasoningEffort?: string, serviceTier?: string | null): string {
  const modelName = model || '默认模型';
  const effort = reasoningEffort || '默认';
  const speed = isFastTier(serviceTier) ? 'fast' : 'normal';
  return `${modelName}/${effort}/${speed}`;
}

export function isFastTier(serviceTier?: string | null): boolean {
  return serviceTier === 'fast' || serviceTier === 'priority';
}

function cliLabel(cli?: ThreadSummary['cli']): string {
  return cli === 'cc' ? 'CC' : 'Codex';
}

export function relativeTime(timestamp?: number): string {
  if (!timestamp) return '时间未知';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}小时前`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)}天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
