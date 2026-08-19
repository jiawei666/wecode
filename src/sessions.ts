import { stat } from 'node:fs/promises';
import type { AppConfig } from './config.js';
import type { CodexNotification } from './codex.js';
import { isFastTier } from './session-display.js';
import type { BotState, PresentationMode, SessionBinding, SessionLaunchOptions, ThreadSummary, TurnResult } from './model.js';
import type { SessionAdapter } from './session-adapter.js';
import { StateStore } from './state.js';
import { TmuxManager, tmuxSessionName } from './tmux.js';

interface TurnAccumulator {
  threadId: string;
  turnId: string;
  textByItem: Map<string, string>;
  finalText?: string;
  kind: 'plain' | 'plan' | 'diff' | 'report' | 'code';
  presentation?: PresentationMode;
  diff?: string;
  startedAt: number;
}

export interface SessionStatus {
  binding?: SessionBinding;
  running: boolean;
  tmuxExists: boolean;
  attachedClients: number;
}

export class SessionOccupiedError extends Error {
  constructor(
    public readonly threadId: string,
    public readonly cwd: string,
    public readonly running: boolean,
    detail?: string,
  ) {
    super(`Codex 会话 ${threadId} 正被原生终端占用${detail ? `：${detail}` : ''}`);
    this.name = 'SessionOccupiedError';
  }
}

export class SessionManager {
  private activeTurns = new Map<string, TurnAccumulator>();
  private readonly unsubscribeNotifications: () => void;

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly appServer: SessionAdapter,
    private readonly tmux: TmuxManager,
    private readonly onTurn: (result: TurnResult) => Promise<void>,
  ) {
    this.unsubscribeNotifications = this.appServer.onNotification((notification) => this.handleNotification(notification));
  }

  async close(): Promise<void> {
    this.unsubscribeNotifications();
    await this.appServer.close();
  }

  async create(
    userId: string,
    requestedCwd?: string,
    options: SessionLaunchOptions = {},
  ): Promise<{ binding: SessionBinding; warning?: string }> {
    const cwd = await this.validCwd(requestedCwd || this.store.getBinding(userId)?.cwd || this.config.defaultCwd);
    const launch = this.defaultLaunch(options);
    const thread = await this.appServer.startThread(cwd, launch);
    const binding = this.makeBinding(thread, cwd, undefined, false, launch);
    this.bind(userId, binding);
    // A new thread has no persisted rollout yet, so `codex resume` cannot
    // attach to it. The TUI is attached after the first turn starts.
    return { binding };
  }

  async use(
    userId: string,
    threadId: string,
    requestedCwd?: string,
    options: SessionLaunchOptions = {},
    takeover = false,
  ): Promise<{ binding: SessionBinding; warning?: string }> {
    const previous = this.store.getBinding(userId);
    const thread = await this.resumeForUse(threadId, requestedCwd, takeover);
    const cwd = await this.validCwd(requestedCwd || (previous?.threadId === threadId ? previous.cwd : thread.cwd || this.config.defaultCwd));
    const inherited = previous?.threadId === threadId ? previous : undefined;
    const binding = this.makeBinding(thread, cwd, inherited, true, options);
    let tmuxResult = await this.tmux.start(binding.threadId, binding.cwd, binding.tmuxSession, binding);
    if (!tmuxResult.ok && isNativeConflict(tmuxResult.error)) {
      if (!takeover) throw new SessionOccupiedError(threadId, cwd, threadIsRunning(thread), tmuxResult.error);
      await this.releaseNativeOrThrow(threadId);
      tmuxResult = await this.tmux.start(binding.threadId, binding.cwd, binding.tmuxSession, binding);
      if (!tmuxResult.ok && isNativeConflict(tmuxResult.error)) {
        throw new SessionOccupiedError(threadId, cwd, threadIsRunning(thread), tmuxResult.error);
      }
    }
    this.bind(userId, binding);
    return tmuxResult.ok ? { binding } : { binding, warning: tmuxResult.error };
  }

  async list(cwd?: string): Promise<ThreadSummary[]> {
    return this.appServer.listThreads(cwd);
  }

  async resolveThreadId(identifier: string): Promise<string> {
    const value = identifier.trim();
    if (!value) throw new Error('会话 ID 不能为空');
    const list = await this.list();
    const exact = list.find((thread) => thread.id === value);
    if (exact) return exact.id;
    const matches = list.filter((thread) => thread.id.startsWith(value));
    if (matches.length === 1 && matches[0]) return matches[0].id;
    if (matches.length > 1) throw new Error(`会话 ID 前缀匹配到多个会话，请发送 /sessions full 查看完整 ID：${value}`);
    return value;
  }

  async send(userId: string, text: string): Promise<{ accepted: boolean; warning?: string }> {
    const binding = this.store.getBinding(userId);
    if (!binding) return { accepted: false, warning: '没有当前 Codex 会话' };
    const fresh = binding.hasRollout === false;
    if (!fresh) {
      try {
        await this.appServer.resumeThread(binding.threadId);
      } catch (error) {
        // Older bindings and threads created by the first implementation may
        // exist without a rollout. Let turn/start materialize the first one.
        if (!/no rollout found/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
    let activeBinding = binding;
    let turnId: string;
    try {
      turnId = await this.appServer.startTurn(activeBinding.threadId, activeBinding.cwd, text, activeBinding);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!fresh || !/thread not found/i.test(message)) throw error;

      // A freshly-created thread can disappear when the App Server restarts
      // before its first rollout is persisted. Recreate only this known-safe
      // case and keep the user's original working directory.
      const thread = await this.appServer.startThread(binding.cwd, binding);
      activeBinding = this.makeBinding(thread, binding.cwd, binding, false, binding);
      this.bind(userId, activeBinding);
      turnId = await this.appServer.startTurn(activeBinding.threadId, activeBinding.cwd, text, activeBinding);
    }
    if (!this.activeTurns.has(turnId)) {
      this.activeTurns.set(turnId, {
        threadId: activeBinding.threadId,
        turnId,
        textByItem: new Map(),
        kind: 'plain',
        startedAt: Date.now(),
      });
    }
    const requestedPresentation = inferTurnPresentation(text);
    if (requestedPresentation) {
      const active = this.activeTurns.get(turnId);
      if (active) {
        active.kind = requestedPresentation.kind;
        active.presentation = requestedPresentation.presentation;
      }
    }
    this.store.setBinding(userId, { ...activeBinding, hasRollout: true, lastActivityAt: Date.now() });
    const tmuxResult = await this.tmux.start(activeBinding.threadId, activeBinding.cwd, activeBinding.tmuxSession, activeBinding);
    return tmuxResult.ok ? { accepted: true } : { accepted: true, warning: tmuxResult.error };
  }

  async stop(userId: string): Promise<boolean> {
    const binding = this.store.getBinding(userId);
    if (!binding) return false;
    const active = [...this.activeTurns.values()].find((turn) => turn.threadId === binding.threadId);
    if (active) {
      await this.appServer.interrupt(active.threadId, active.turnId).catch(() => undefined);
      await this.tmux.interrupt(binding.tmuxSession);
      return true;
    }
    await this.tmux.interrupt(binding.tmuxSession);
    return false;
  }

  async release(userId: string): Promise<boolean> {
    const binding = this.store.getBinding(userId);
    if (!binding) return false;
    await this.stop(userId);
    await this.appServer.unsubscribe(binding.threadId).catch(() => undefined);
    await this.tmux.kill(binding.tmuxSession, binding.threadId).catch(() => undefined);
    return true;
  }

  async raw(userId: string, text: string): Promise<void> {
    const binding = this.store.getBinding(userId);
    if (!binding) throw new Error('没有当前 Codex 会话');
    await this.tmux.sendRaw(binding.tmuxSession, text);
    this.store.setBinding(userId, { ...binding, lastActivityAt: Date.now() });
  }

  async setNote(userId: string, note: string): Promise<SessionBinding> {
    const binding = this.store.getBinding(userId);
    if (!binding) throw new Error('没有当前 Codex 会话');
    const updated = { ...binding, note: note.trim(), lastActivityAt: Date.now() };
    this.store.setSessionNote(binding.threadId, updated.note || '');
    this.store.setBinding(userId, updated);
    return updated;
  }

  async back(userId: string): Promise<{ binding: SessionBinding; warning?: string } | undefined> {
    const previous = this.store.getBindingHistory(userId)[0];
    if (!previous) return undefined;
    return this.use(userId, previous.threadId, previous.cwd, previous);
  }

  async status(userId: string): Promise<SessionStatus> {
    const binding = this.store.getBinding(userId);
    if (!binding) return { running: false, tmuxExists: false, attachedClients: 0 };
    // Re-subscribe after a bridge restart so turns started from the local TUI
    // can still produce structured results back to WeChat.
    const thread = binding.hasRollout === false
      ? undefined
      : await this.appServer.resumeThread(binding.threadId).catch(() => undefined);
    const tmux = await this.tmux.status(binding.tmuxSession);
    const nativeRunning = threadIsRunning(thread);
    return {
      binding,
      running: nativeRunning || [...this.activeTurns.values()].some((turn) => turn.threadId === binding.threadId),
      tmuxExists: tmux.exists,
      attachedClients: tmux.attachedClients,
    };
  }

  async reapIdle(): Promise<void> {
    const now = Date.now();
    const state: BotState = this.store.get();
    for (const [userId, binding] of Object.entries(state.bindings)) {
      if (now - binding.lastActivityAt < this.config.idleTimeoutMs) continue;
      if ([...this.activeTurns.values()].some((turn) => turn.threadId === binding.threadId)) continue;
      const tmux = await this.tmux.status(binding.tmuxSession);
      if (!tmux.exists || tmux.attachedClients > 0) continue;
      await this.tmux.kill(binding.tmuxSession, binding.threadId).catch(() => undefined);
      await this.appServer.unsubscribe(binding.threadId).catch(() => undefined);
    }
  }

  private handleNotification(notification: CodexNotification): void {
    const params = notification.params;
    if (notification.method === 'turn/started') {
      const turn = asRecord(params.turn);
      const threadId = stringValue(params.threadId) || stringValue(turn?.threadId);
      const turnId = stringValue(turn?.id);
      if (threadId && turnId && !this.activeTurns.has(turnId)) {
        this.activeTurns.set(turnId, {
          threadId,
          turnId,
          textByItem: new Map(),
          kind: 'plain',
          startedAt: Date.now(),
        });
      }
      return;
    }

    const turnId = stringValue(params.turnId) || stringValue(asRecord(params.turn)?.id) || '';
    const active = turnId ? this.activeTurns.get(turnId) : undefined;
    if (!active) return;

    if (notification.method === 'item/agentMessage/delta') {
      const itemId = stringValue(params.itemId) || stringValue(params.agentMessageId) || 'agent-message';
      const delta = stringValue(params.delta) || stringValue(params.text) || '';
      active.textByItem.set(itemId, `${active.textByItem.get(itemId) ?? ''}${delta}`);
      return;
    }
    if (notification.method === 'item/completed') {
      const item = asRecord(params.item);
      const type = stringValue(item?.type);
      if (type === 'agentMessage') active.finalText = stringValue(item?.text) || active.finalText;
      if (type === 'plan') active.kind = 'plan';
      if (type === 'fileChange') active.kind = 'diff';
      return;
    }
    if (notification.method === 'turn/plan/updated') {
      active.kind = 'plan';
      return;
    }
    if (notification.method === 'turn/diff/updated') {
      active.kind = 'diff';
      active.diff = stringValue(params.diff) || active.diff;
      return;
    }
    if (notification.method === 'turn/completed') {
      const turn = asRecord(params.turn);
      const status = stringValue(turn?.status);
      const text = active.finalText || [...active.textByItem.values()].join('') || active.diff || '';
      const result: TurnResult = {
        threadId: active.threadId,
        turnId: active.turnId,
        text,
        status: status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed',
        kind: active.kind,
        presentation: active.presentation,
      };
      const error = asRecord(turn?.error);
      if (error?.message) result.error = String(error.message);
      this.activeTurns.delete(active.turnId);
      this.touchThread(active.threadId);
      void this.onTurn(result).catch((error) => process.stderr.write(`[session] turn delivery failed: ${String(error)}\n`));
    }
  }

  private touchThread(threadId: string): void {
    for (const [userId, binding] of Object.entries(this.store.get().bindings)) {
      if (binding.threadId === threadId) this.store.setBinding(userId, { ...binding, lastActivityAt: Date.now() });
    }
  }

  private makeBinding(
    thread: ThreadSummary,
    cwd: string,
    previous?: SessionBinding,
    hasRollout = true,
    options: SessionLaunchOptions = {},
  ): SessionBinding {
    const now = Date.now();
    const serviceTier = thread.serviceTier;
    const model = options.model ?? thread.model ?? previous?.model ?? this.config.codexModel;
    const reasoningEffort = options.reasoningEffort ?? thread.reasoningEffort ?? previous?.reasoningEffort ?? this.config.codexReasoningEffort;
    const fast = options.fast ?? (serviceTier === undefined ? previous?.fast ?? this.config.codexFast : isFastTier(serviceTier));
    const threadId = thread.id;
    return {
      threadId,
      cwd,
      tmuxSession: tmuxSessionName(threadId),
      cli: thread.cli ?? previous?.cli ?? this.appServer.cli,
      model,
      reasoningEffort,
      fast,
      ...(this.store.getSessionNote(threadId) || previous?.note ? { note: this.store.getSessionNote(threadId) || previous?.note } : {}),
      hasRollout: previous?.threadId === threadId ? previous.hasRollout ?? hasRollout : hasRollout,
      createdAt: previous?.createdAt ?? now,
      lastActivityAt: now,
    };
  }

  private defaultLaunch(options: SessionLaunchOptions): SessionLaunchOptions {
    return {
      cli: options.cli ?? this.appServer.cli,
      model: options.model ?? this.config.codexModel,
      reasoningEffort: options.reasoningEffort ?? this.config.codexReasoningEffort,
      fast: options.fast ?? this.config.codexFast,
    };
  }

  private bind(userId: string, binding: SessionBinding): void {
    const previous = this.store.getBinding(userId);
    if (previous && previous.threadId !== binding.threadId) {
      this.store.pushBindingHistory(userId, previous, this.config.bindingHistoryLimit);
    }
    this.store.setBinding(userId, binding);
  }

  private async validCwd(candidate: string): Promise<string> {
    const cwd = candidate.trim();
    if (!cwd) throw new Error('项目目录不能为空');
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`项目目录不存在或不是目录: ${cwd}`);
    return cwd;
  }

  private async resumeForUse(threadId: string, requestedCwd: string | undefined, takeover: boolean): Promise<ThreadSummary> {
    try {
      return await this.appServer.resumeThread(threadId);
    } catch (error) {
      if (!isNativeConflict(error)) throw error;
      if (!takeover) throw await this.occupiedError(threadId, requestedCwd, error);
      await this.releaseNativeOrThrow(threadId);
      try {
        return await this.appServer.resumeThread(threadId);
      } catch (retryError) {
        if (isNativeConflict(retryError)) throw await this.occupiedError(threadId, requestedCwd, retryError);
        throw retryError;
      }
    }
  }

  private async occupiedError(threadId: string, requestedCwd: string | undefined, cause: unknown): Promise<SessionOccupiedError> {
    let thread: ThreadSummary | undefined;
    try {
      thread = await this.appServer.listThreads().then((threads) => threads.find((candidate) => candidate.id === threadId));
    } catch {
      // The conflict itself is enough to preserve the binding and ask first.
    }
    return new SessionOccupiedError(
      threadId,
      requestedCwd || thread?.cwd || this.config.defaultCwd,
      threadIsRunning(thread),
      errorText(cause),
    );
  }

  private async releaseNativeOrThrow(threadId: string): Promise<void> {
    const result = await this.tmux.releaseNative(threadId);
    if (!result.matched) throw new Error(`未找到可安全停止的原生终端（thread_id=${threadId}），请先在原生终端退出该会话后再重试`);
    if (!result.stopped) throw new Error(`原生终端未能释放（thread_id=${threadId}），请先手动关闭该终端后再重试`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function threadIsRunning(thread?: ThreadSummary): boolean {
  return ['active', 'running', 'in_progress'].includes(thread?.status?.type ?? '') || Boolean(thread?.status?.activeFlags?.length);
}

function isNativeConflict(error: unknown): boolean {
  return /thread-store conflict|active writer|already in use|being used|occupied|原生终端/i.test(errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function inferTurnPresentation(text: string): { kind: 'report'; presentation: 'page' } | undefined {
  const normalized = text.toLowerCase();
  const explicitReport = /总结报告|分析报告|审查报告|生成报告|长报告|分享页|sharepage|\breport\b|\bsummary\b/i.test(normalized);
  const repositorySummary = /(总结|分析|审查|评估|梳理).{0,24}(仓库|项目|代码|repo|repository|codebase|架构)/i.test(normalized);
  if (explicitReport || repositorySummary) return { kind: 'report', presentation: 'page' };
  return undefined;
}
