import { stat } from 'node:fs/promises';
import type { AppConfig } from './config.js';
import type { CodexNotification } from './codex.js';
import { isFastTier } from './session-display.js';
import type {
  BotState,
  PresentationMode,
  SessionBinding,
  SessionLaunchOptions,
  ThreadSnapshot,
  ThreadSummary,
  ThreadTurnSummary,
  TurnResult,
} from './model.js';
import type { ExternalWriterRelease, SessionAdapter } from './session-adapter.js';
import { StateStore } from './state.js';

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

const TAKEOVER_IDLE_POLL_ATTEMPTS = 20;
const TAKEOVER_RETRY_ATTEMPTS = 12;
const TAKEOVER_RETRY_DELAY_MS = 250;

export interface SessionStatus {
  binding?: SessionBinding;
  running: boolean;
}

export interface SessionReleaseResult {
  released: boolean;
  externalWriter?: ExternalWriterRelease;
}

export class SessionOccupiedError extends Error {
  readonly threadId: string;
  readonly cwd: string;
  readonly running: boolean;
  readonly takeoverAttempted: boolean;

  constructor(threadId: string, detail?: string);
  constructor(threadId: string, cwd: string, running: boolean, detail?: string, takeoverAttempted?: boolean);
  constructor(threadId: string, cwdOrDetail = '', running?: boolean, detail?: string, takeoverAttempted = false) {
    const legacyDetail = running === undefined ? cwdOrDetail : detail;
    super(`Codex 会话 ${threadId} 正被其他 Codex 客户端占用${legacyDetail ? `：${legacyDetail}` : ''}`);
    this.threadId = threadId;
    this.cwd = running === undefined ? '' : cwdOrDetail;
    this.running = running ?? false;
    this.takeoverAttempted = takeoverAttempted;
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
  ): Promise<{ binding: SessionBinding }> {
    const cwd = await this.validCwd(requestedCwd || this.store.getBinding(userId)?.cwd || this.config.defaultCwd);
    const launch = this.defaultLaunch(options);
    const thread = await this.appServer.startThread(cwd, launch);
    const binding = this.makeBinding(thread, cwd, undefined, false, launch);
    this.bind(userId, binding);
    return { binding };
  }

  async use(
    userId: string,
    threadId: string,
    requestedCwd?: string,
    options: SessionLaunchOptions = {},
    takeover = false,
  ): Promise<{ binding: SessionBinding }> {
    const previous = this.store.getBinding(userId);
    const fallbackCwd = previous?.threadId === threadId ? previous.cwd : undefined;
    const thread = await this.resumeForUse(threadId, requestedCwd || fallbackCwd, takeover);
    const cwd = await this.validCwd(requestedCwd || (previous?.threadId === threadId ? previous.cwd : thread.cwd || this.config.defaultCwd));
    const inherited = previous?.threadId === threadId ? previous : undefined;
    const binding = this.makeBinding(thread, cwd, inherited, true, options);
    this.bind(userId, binding);
    return { binding };
  }

  async fork(
    userId: string,
    sourceThreadId: string,
    requestedCwd?: string,
    options: SessionLaunchOptions = {},
  ): Promise<{ binding: SessionBinding }> {
    if (!this.appServer.forkThread) throw new Error('当前 Codex 适配器不支持分叉会话');
    const previous = this.store.getBinding(userId);
    const launch = this.defaultLaunch(options);
    const thread = await this.appServer.forkThread(sourceThreadId, launch);
    if (previous?.threadId === sourceThreadId) await this.appServer.unsubscribe(sourceThreadId).catch(() => undefined);
    const cwd = await this.validCwd(
      requestedCwd
        || thread.cwd
        || (previous?.threadId === sourceThreadId ? previous.cwd : undefined)
        || this.config.defaultCwd,
    );
    const binding = this.makeBinding(thread, cwd, undefined, true, launch);
    this.bind(userId, binding);
    return { binding };
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
    if (matches.length > 1) throw new Error(`会话 ID 前缀匹配到多个会话，请发送 /会话 full 查看完整 ID：${value}`);
    return value;
  }

  async send(userId: string, text: string): Promise<{ accepted: boolean }> {
    const binding = this.store.getBinding(userId);
    if (!binding) return { accepted: false };
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
    return { accepted: true };
  }

  async steer(userId: string, text: string): Promise<{ accepted: boolean }> {
    const binding = this.store.getBinding(userId);
    if (!binding) return { accepted: false };
    const active = [...this.activeTurns.values()].find((turn) => turn.threadId === binding.threadId);
    if (!active) return { accepted: false };
    await this.appServer.steerTurn(active.threadId, active.turnId, text);
    return { accepted: true };
  }

  async stop(userId: string): Promise<boolean> {
    const binding = this.store.getBinding(userId);
    if (!binding) return false;
    const active = [...this.activeTurns.values()].find((turn) => turn.threadId === binding.threadId);
    if (active) {
      await this.appServer.interrupt(active.threadId, active.turnId).catch(() => undefined);
      return true;
    }
    return false;
  }

  async release(userId: string): Promise<SessionReleaseResult> {
    const binding = this.store.getBinding(userId);
    if (!binding) return { released: false };
    await this.stop(userId);
    await this.appServer.unsubscribe(binding.threadId).catch(() => undefined);
    const externalWriter = process.platform === 'win32' && this.appServer.releaseExternalWriter
      ? await this.appServer.releaseExternalWriter(binding.threadId).catch(() => undefined)
      : undefined;

    // `thread/unsubscribe` releases this connection's subscription, but the
    // long-lived App Server can still retain its thread-store ownership. Once
    // the last local binding is gone, recycle our own connection/process so a
    // later `use` starts from a clean ownership state. If another binding is
    // active, keep the shared App Server alive for it.
    if (this.canRecycleAppServer(userId, binding.threadId)) {
      await this.appServer.close().catch((error) => {
        process.stderr.write(`[session] failed to recycle App Server after release: ${errorText(error)}\n`);
      });
    }
    return { released: true, ...(externalWriter ? { externalWriter } : {}) };
  }

  async setNote(userId: string, note: string): Promise<SessionBinding> {
    const binding = this.store.getBinding(userId);
    if (!binding) throw new Error('没有当前 Codex 会话');
    const updated = { ...binding, note: note.trim(), lastActivityAt: Date.now() };
    this.store.setSessionNote(binding.threadId, updated.note || '');
    this.store.setBinding(userId, updated);
    return updated;
  }

  async status(userId: string): Promise<SessionStatus> {
    const binding = this.store.getBinding(userId);
    if (!binding) return { running: false };
    // Re-subscribe after a bridge restart so turns started through the App
    // Server can still produce structured results back to WeChat.
    const thread = binding.hasRollout === false
      ? undefined
      : await this.appServer.resumeThread(binding.threadId).catch(() => undefined);
    const nativeRunning = threadIsRunning(thread);
    return {
      binding,
      running: nativeRunning || [...this.activeTurns.values()].some((turn) => turn.threadId === binding.threadId),
    };
  }

  async reapIdle(): Promise<void> {
    const now = Date.now();
    const state: BotState = this.store.get();
    for (const [userId, binding] of Object.entries(state.bindings)) {
      if (now - binding.lastActivityAt < this.config.idleTimeoutMs) continue;
      if ([...this.activeTurns.values()].some((turn) => turn.threadId === binding.threadId)) continue;
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

  private canRecycleAppServer(userId: string, threadId: string): boolean {
    const hasOtherBinding = Object.keys(this.store.get().bindings).some((otherUserId) => otherUserId !== userId);
    if (hasOtherBinding) return false;
    return ![...this.activeTurns.values()].some((turn) => turn.threadId !== threadId);
  }

  private async validCwd(candidate: string): Promise<string> {
    const cwd = candidate.trim();
    if (!cwd) throw new Error('项目目录不能为空');
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`项目目录不存在或不是目录: ${cwd}`);
    return cwd;
  }

  private async resumeForUse(threadId: string, requestedCwd?: string, takeover = false): Promise<ThreadSummary> {
    // `thread/read` is deliberately non-owning. Check it first so an active
    // client is never silently joined just because `thread/resume` happens to
    // succeed. This is also the cross-platform replacement for detecting an
    // external terminal: ownership is decided by App Server state, not a
    // process, shell, or terminal implementation.
    const initialSnapshot = await this.readOccupiedThread(threadId);
    if (initialSnapshot && threadIsRunning(initialSnapshot)) {
      const cwd = requestedCwd || initialSnapshot.cwd || this.config.defaultCwd;
      if (!takeover) throw new SessionOccupiedError(threadId, cwd, true, '目标会话当前仍有活动任务');
      return this.safeTakeover(threadId, cwd, true, initialSnapshot);
    }

    let resumed: ThreadSummary;
    try {
      resumed = await this.appServer.resumeThread(threadId);
    } catch (error) {
      if (isSessionConflict(error)) {
        const snapshot = await this.readOccupiedThread(threadId);
        const cwd = requestedCwd || snapshot?.cwd || this.config.defaultCwd;
        const running = threadIsRunning(snapshot);
        if (!takeover) throw new SessionOccupiedError(threadId, cwd, running, errorText(error));
        return this.safeTakeover(threadId, cwd, running, snapshot);
      }
      throw error;
    }

    // A race may start a turn after the non-owning read but before resume.
    // Release only our subscription, inspect again, and fail closed unless
    // the caller explicitly confirmed takeover.
    if (threadIsRunning(resumed)) {
      await this.releaseCurrentSubscription(threadId);
      const snapshot = await this.readOccupiedThread(threadId);
      const cwd = requestedCwd || snapshot?.cwd || resumed.cwd || this.config.defaultCwd;
      const running = threadIsRunning(resumed) || threadIsRunning(snapshot);
      if (!takeover) throw new SessionOccupiedError(threadId, cwd, running, '恢复后仍显示有活动任务');
      return this.safeTakeover(threadId, cwd, running, snapshot);
    }
    return resumed;
  }

  private async readOccupiedThread(threadId: string): Promise<ThreadSnapshot | undefined> {
    try {
      return await this.appServer.readThread(threadId);
    } catch {
      // A legacy adapter may not expose thread/read yet. The caller still
      // receives an occupied error and the bridge fails closed.
      return undefined;
    }
  }

  private async releaseCurrentSubscription(threadId: string): Promise<void> {
    try {
      await this.appServer.unsubscribe(threadId);
    } catch {
      // Releasing our own subscription is best effort. It never disconnects
      // or terminates the external client that caused the occupied state.
    }
  }

  private async safeTakeover(
    threadId: string,
    cwd: string,
    running: boolean,
    initialSnapshot?: ThreadSnapshot,
  ): Promise<ThreadSummary> {
    let snapshot = initialSnapshot;
    if (!snapshot) {
      try {
        snapshot = await this.appServer.readThread(threadId);
      } catch (error) {
        throw new SessionOccupiedError(threadId, cwd, running, `无法读取 thread 状态：${errorText(error)}`, true);
      }
    }

    const activeTurn = activeTurnOf(snapshot);
    if (threadIsRunning(snapshot) && !activeTurn) {
      throw new SessionOccupiedError(threadId, cwd, true, '无法确认活动 turn，已停止接管', true);
    }
    if (activeTurn) {
      try {
        await this.appServer.interrupt(threadId, activeTurn.id);
      } catch (error) {
        throw new SessionOccupiedError(threadId, cwd, true, `App Server 无法中断当前任务：${errorText(error)}`, true);
      }
      await this.waitForIdle(threadId, cwd);
    }

    return this.resumeAfterTakeover(threadId, cwd, Boolean(activeTurn));
  }

  private async resumeAfterTakeover(threadId: string, cwd: string, interruptedTurn: boolean): Promise<ThreadSummary> {
    const firstResume = await this.retryResume(threadId);
    if (firstResume) return firstResume;

    let releaseDetail = '';
    if (this.appServer.releaseExternalWriter) {
      try {
        const release = await this.appServer.releaseExternalWriter(threadId);
        releaseDetail = release.detail || '';
        if (release.released) {
          const resumed = await this.retryResume(threadId);
          if (resumed) return resumed;
        }
      } catch (error) {
        releaseDetail = `释放外部客户端失败：${errorText(error)}`;
      }
    }

    const latest = await this.readOccupiedThread(threadId);
    const running = interruptedTurn && threadIsRunning(latest);
    const detail = releaseDetail || (running
      ? '已请求中断活动任务，但外部客户端仍占用该会话'
      : '目标任务已空闲，但外部客户端仍保持会话占用');
    throw new SessionOccupiedError(threadId, cwd, running, detail, true);
  }

  private async retryResume(threadId: string): Promise<ThreadSummary | undefined> {
    for (let attempt = 0; attempt < TAKEOVER_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.appServer.resumeThread(threadId);
      } catch (error) {
        if (!isSessionConflict(error)) throw error;
        if (attempt + 1 < TAKEOVER_RETRY_ATTEMPTS) await delay(TAKEOVER_RETRY_DELAY_MS);
      }
    }
    return undefined;
  }

  private async waitForIdle(threadId: string, cwd: string): Promise<void> {
    for (let attempt = 0; attempt < TAKEOVER_IDLE_POLL_ATTEMPTS; attempt += 1) {
      let snapshot: ThreadSnapshot;
      try {
        snapshot = await this.appServer.readThread(threadId);
      } catch (error) {
        throw new SessionOccupiedError(threadId, cwd, true, `无法确认中断结果：${errorText(error)}`, true);
      }
      if (!threadIsRunning(snapshot)) return;
      await delay(250);
    }
    throw new SessionOccupiedError(threadId, cwd, true, '中断请求尚未完成，未执行恢复', true);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function threadIsRunning(thread?: ThreadSummary | ThreadSnapshot): boolean {
  return ['active', 'running', 'in_progress'].includes(thread?.status?.type ?? '')
    || Boolean(thread?.status?.activeFlags?.length)
    || threadTurns(thread).some(isTurnRunning);
}

function activeTurnOf(thread: ThreadSnapshot): ThreadTurnSummary | undefined {
  return [...(thread.turns ?? [])].reverse().find(isTurnRunning);
}

function isTurnRunning(turn: ThreadTurnSummary): boolean {
  const status = turn.status?.toLowerCase() ?? '';
  return ['active', 'running', 'in_progress', 'inprogress', 'started'].includes(status) || /progress/.test(status);
}

function threadTurns(thread?: ThreadSummary | ThreadSnapshot): ThreadTurnSummary[] {
  if (!thread || !('turns' in thread)) return [];
  return thread.turns ?? [];
}

function isSessionConflict(error: unknown): boolean {
  return /thread-store conflict|active writer|already in use|being used|occupied|locked|another client|原生终端|其他 Codex 客户端/i.test(errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function inferTurnPresentation(text: string): { kind: 'report' | 'plain'; presentation: 'page' } | undefined {
  const normalized = text.toLowerCase();
  const explicitReport = /总结报告|分析报告|审查报告|生成报告|长报告|\breport\b|\bsummary\b/i.test(normalized);
  const explicitShare = /分享页|sharepage/i.test(normalized);
  const repositorySummary = /(总结|分析|审查|评估|梳理).{0,24}(仓库|项目|代码|repo|repository|codebase|架构)/i.test(normalized);
  if (explicitReport || repositorySummary) return { kind: 'report', presentation: 'page' };
  if (explicitShare) return { kind: 'plain', presentation: 'page' };
  return undefined;
}
