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
