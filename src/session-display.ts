import path from 'node:path';
import type { AppConfig } from './config.js';
import type { SessionBinding, SessionSelectionItem, ThreadSummary } from './model.js';

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
    return (normalizeTimestamp(right.updatedAt ?? right.createdAt) ?? 0) - (normalizeTimestamp(left.updatedAt ?? left.createdAt) ?? 0);
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

  if (!visible.length) return { text: '没有找到会话。', items: [] };
  const lines = visible.map((thread, index) => {
    const note = notes[thread.id] || thread.name;
    const title = truncate(note || thread.preview || '未命名会话', 60);
    const project = thread.cwd ? path.basename(thread.cwd) || '未知目录' : '未知目录';
    const currentMark = thread.id === current?.threadId ? ' · 当前' : '';
    const id = options.fullIds ? `\n   ID：${thread.id}` : '';
    return `${index + 1}. ${project}${currentMark}\n   ${title} · ${formatTimestamp(thread.updatedAt ?? thread.createdAt)}${id}`;
  });
  const scope = visible.length < merged.length ? `最近 ${visible.length}/${merged.length}` : `${visible.length}`;
  return {
    text: `Codex 会话（${scope}）：\n\n${lines.join('\n\n')}\n\n回复序号切换（${Math.round(config.selectionTimeoutMs / 60_000)} 分钟内）。`,
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

export function normalizeTimestamp(timestamp?: number | string): number | undefined {
  const raw = typeof timestamp === 'string' ? timestamp.trim() : timestamp;
  const numeric = typeof raw === 'string' ? Number(raw) : raw;
  const value = Number.isFinite(numeric)
    ? numeric
    : typeof raw === 'string' && raw
      ? Date.parse(raw)
      : undefined;
  if (!Number.isFinite(value) || !value || (value ?? 0) < 0) return undefined;
  const milliseconds = (value ?? 0) < 100_000_000_000 ? (value ?? 0) * 1000 : value ?? 0;
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

export function formatTimestamp(timestamp?: number | string): string {
  const milliseconds = normalizeTimestamp(timestamp);
  if (milliseconds === undefined) return '时间未知';
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
