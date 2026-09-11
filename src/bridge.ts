import type { AppConfig } from './config.js';
import { HELP_TEXT, QUICK_GUIDE_TEXT, SESSION_ACTIVE_HINT, WELCOME_TEXT, parseBridgeCommand } from './commands.js';
import { ControlAgent } from './control.js';
import type { InboundMessage, IlinkClient } from './ilink.js';
import type {
  ActionResponse,
  ControlState,
  PendingTakeover,
  PresentationMode,
  PendingReply,
  ReplyOptions,
  ReplySource,
  SessionBinding,
  SessionLaunchOptions,
  TurnProgress,
  ThreadSummary,
  ThreadItemSummary,
  ThreadSnapshot,
  ThreadTurnSummary,
  TurnResult,
} from './model.js';
import { renderResponse, PagePublisher } from './render.js';
import { formatModel, formatTimestamp, normalizeTimestamp } from './session-display.js';
import { SessionManager, SessionOccupiedError, type SessionInspection } from './sessions.js';
import { StateStore } from './state.js';

interface TurnProgressBuffer {
  userId: string;
  text: string;
  timer?: NodeJS.Timeout;
  flushing?: Promise<unknown>;
}

const PENDING_REPLY_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000] as const;
const TURN_PROGRESS_FLUSH_DELAY_MS = 3_000;
const TURN_PROGRESS_FLUSH_LENGTH = 900;
const CONTROL_PROGRESS_DELAY_MS = 1_500;
const QUICK_SESSION_LIST_LIMIT = 20;
const QUICK_SESSION_LIST_TTL_MS = 10 * 60_000;

interface QuickSessionList {
  expiresAt: number;
  limit: number;
  sessions: ThreadSummary[];
}

export class BridgeApp {
  private readonly controlAgent: ControlAgent;
  private readonly pages: PagePublisher;
  private readonly sessions: SessionManager;
  private readonly queued = new Map<string, string[]>();
  private readonly draining = new Set<string>();
  private readonly handling = new Map<string, Promise<void>>();
  private readonly directHandling = new Map<string, Promise<void>>();
  private readonly pendingReplies = new Map<string, PendingReply[]>();
  private readonly pendingReplyTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingReplyFlushes = new Map<string, Promise<boolean>>();
  private readonly pendingReplyRefreshes = new Set<string>();
  private readonly awaitingFreshContext = new Set<string>();
  private readonly finalReplyChains = new Map<string, Promise<void>>();
  private readonly turnProgress = new Map<string, TurnProgressBuffer>();
  private readonly progressReplyChains = new Map<string, Promise<void>>();
  private readonly quickSessionLists = new Map<string, QuickSessionList>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly ilink: IlinkClient,
    sessions: SessionManager,
    controlAgent?: ControlAgent,
  ) {
    this.controlAgent = controlAgent ?? new ControlAgent(config);
    this.pages = new PagePublisher(config);
    this.sessions = sessions;
    for (const [userId, replies] of Object.entries(this.store.get().pendingReplies)) {
      const queue = replies.map((reply) => ({ ...reply, options: { ...reply.options } }));
      if (!queue.length) continue;
      this.pendingReplies.set(userId, queue);
      if (queue.some((reply) => reply.waitForFreshContext)) this.awaitingFreshContext.add(userId);
      else this.schedulePendingReplyRetry(userId, queue[0]?.attempts ?? 0);
    }
  }

  async close(): Promise<void> {
    for (const progress of this.turnProgress.values()) {
      if (progress.timer) clearTimeout(progress.timer);
    }
    this.turnProgress.clear();
    for (const timer of this.pendingReplyTimers.values()) clearTimeout(timer);
    this.pendingReplyTimers.clear();
    await this.controlAgent.close();
    await this.pages.close();
    await this.sessions.close();
    await this.store.save();
    this.quickSessionLists.clear();
  }

  async handle(message: InboundMessage): Promise<void> {
    const command = parseBridgeCommand(message.text.trim());
    const directCommand = command && command.kind !== 'control';
    if (directCommand) {
      if (command.kind === 'stop' || command.kind === 'exit') {
        await this.handleSafely(message);
        return;
      }
      const previous = this.directHandling.get(message.from) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(() => this.handleSafely(message));
      this.directHandling.set(message.from, task);
      await task;
      if (this.directHandling.get(message.from) === task) this.directHandling.delete(message.from);
      return;
    }
    const previous = this.handling.get(message.from) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.handleSafely(message));
    this.handling.set(message.from, task);
    await task;
    if (this.handling.get(message.from) === task) this.handling.delete(message.from);
  }

  private async handleSafely(message: InboundMessage): Promise<void> {
    try {
      await this.handleInternal(message);
    } catch (error) {
      process.stderr.write(`[bridge] message handling failed: ${errorMessage(error)}\n`);
      if (error instanceof SessionOccupiedError) {
        await this.offerTakeover(message.from, error).catch(() => undefined);
        return;
      }
      if (isStaleSessionError(error)) {
        await this.recoverStaleSession(message.from, message.text).catch(() => undefined);
        return;
      }
      await this.reply(message.from, userFacingError(error)).catch(() => undefined);
    }
  }

  private async handleInternal(message: InboundMessage): Promise<void> {
    const userId = message.from;
    const currentAllowed = this.config.allowedUser || this.store.get().scannedUser;
    if (currentAllowed && userId !== currentAllowed) return;

    if (message.contextToken) {
      this.store.update((state) => {
        state.contextTokens[userId] = message.contextToken;
      });
      this.awaitingFreshContext.delete(userId);
    }
    await this.flushPendingReplies(userId, Boolean(message.contextToken));
    if (this.store.seen(`${userId}|${message.messageId}|${message.timeMs}`)) return;

    const text = message.text.trim();
    if (!text) {
      await this.sendPendingWelcome(userId);
      if (message.attachments.length) await this.reply(userId, `收到 ${message.attachments.length} 个附件；当前只处理文字。`);
      return;
    }

    const existingBinding = this.store.getBinding(userId);
    if (existingBinding) this.store.setBinding(userId, { ...existingBinding, lastActivityAt: Date.now() });

    const command = parseBridgeCommand(text);
    const expired = this.controlExpired(userId);
    if (expired) this.store.clearControl(userId);
    const automaticManagement = !command && !this.store.getControl(userId) && !this.store.getBinding(userId);
    if (!automaticManagement) await this.sendPendingWelcome(userId);

    if (command?.kind === 'exit') {
      await this.exit(userId);
      return;
    }
    if (command?.kind === 'stop') {
      await this.stop(userId);
      return;
    }
    if (command?.kind === 'fork') {
      await this.forkCurrent(userId);
      return;
    }
    if (command?.kind === 'guide') {
      this.quickSessionLists.delete(userId);
      await this.reply(userId, QUICK_GUIDE_TEXT);
      return;
    }

    if (command?.kind === 'help') {
      await this.reply(userId, HELP_TEXT);
      return;
    }
    if (command?.kind === 'status') {
      await this.sendStatus(userId);
      return;
    }
    if (command?.kind === 'list_sessions') {
      await this.listSessions(userId, command.limit);
      return;
    }
    if (command?.kind === 'inspect_sessions') {
      await this.inspectSessions(userId, command.limit, command.activeOnly);
      return;
    }
    if (command?.kind === 'control') {
      await this.handleControl(userId, command.text);
      return;
    }

    const selected = this.takeQuickSessionSelection(userId, text);
    if (selected) {
      await this.switchToQuickSession(userId, selected);
      return;
    }
    if (!command && !this.quickSessionLists.has(userId)) {
      if (text === '1') {
        await this.inspectSessions(userId, 5, false);
        return;
      }
      if (text === '2') {
        await this.sendStatus(userId);
        return;
      }
      if (text === '3') {
        await this.handleControl(userId, '新建会话');
        return;
      }
      if (text === '4') {
        await this.handleControl(userId, '切换会话');
        return;
      }
      if (text === '5') {
        await this.listSessions(userId, 5);
        return;
      }
      if (text === '6') {
        await this.forkCurrent(userId);
        return;
      }
    }

    if (this.store.getControl(userId)) {
      await this.handleControl(userId, text);
      return;
    }

    const binding = this.store.getBinding(userId);
    if (!binding && !this.store.getControl(userId) && looksLikeSkillDocument(text)) {
      await this.reply(
        userId,
        '检测到这是一段技能/规则文档，不是会话管理指令。当前没有绑定 Codex 会话，请先发送“新建会话”并指定项目目录，或先切换会话；绑定后再发送这段内容。',
      );
      return;
    }
    if (!binding) {
      await this.handleControl(userId, text, 'no-session');
      return;
    }
    await this.sendToTarget(userId, text);
  }

  private async listSessions(userId: string, requestedLimit: number): Promise<void> {
    const limit = Math.min(Math.max(Math.floor(requestedLimit) || QUICK_SESSION_LIST_LIMIT, 1), QUICK_SESSION_LIST_LIMIT);
    const cached = this.quickSessionLists.get(userId);
    let sessions: ThreadSummary[];
    if (cached && cached.expiresAt > Date.now() && cached.limit >= limit) {
      sessions = cached.sessions.slice(0, limit);
    } else {
      await this.reply(userId, '正在读取最近会话……');
      sessions = (await this.sessions.list(undefined, limit))
        .sort((left, right) => (normalizeTimestamp(right.updatedAt) ?? 0) - (normalizeTimestamp(left.updatedAt) ?? 0))
        .slice(0, limit);
      this.quickSessionLists.set(userId, {
        expiresAt: Date.now() + QUICK_SESSION_LIST_TTL_MS,
        limit,
        sessions: [...sessions],
      });
    }
    await this.reply(userId, formatQuickSessionList(sessions));
  }

  private async inspectSessions(userId: string, requestedLimit: number, activeOnly: boolean): Promise<void> {
    const limit = Math.min(Math.max(Math.floor(requestedLimit) || 5, 1), 20);
    await this.reply(userId, activeOnly ? '正在读取活动任务（只读）……' : '正在读取最近任务（只读）……');
    const inspections = await this.sessions.inspect(limit, activeOnly);
    await this.reply(userId, formatSessionInspectionList(inspections, activeOnly));
  }

  private takeQuickSessionSelection(userId: string, text: string): ThreadSummary | undefined {
    const cached = this.quickSessionLists.get(userId);
    if (!cached || cached.expiresAt <= Date.now()) {
      this.quickSessionLists.delete(userId);
      return undefined;
    }
    const match = /^(?:(?:切换(?:到)?|使用|打开)\s*)?(?:第\s*)?(\d+)(?:\s*个)?(?:会话)?$/u.exec(text);
    if (!match) return undefined;
    const index = Number(match[1]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= cached.sessions.length) return undefined;
    return cached.sessions[index];
  }

  private async switchToQuickSession(userId: string, thread: ThreadSummary): Promise<void> {
    this.quickSessionLists.delete(userId);
    if (this.store.getControl(userId)) {
      await this.controlAgent.interrupt(userId).catch(() => false);
      this.store.clearControl(userId);
    }
    await this.reply(userId, '正在恢复会话……');
    await this.stopBeforeSwitch(userId);
    const result = await this.sessions.use(userId, thread.id, thread.cwd, launchOptions(thread), false, thread);
    await this.reply(userId, this.switchedText(result.binding));
  }

  private async handleControl(userId: string, text: string, automaticReason?: 'no-session' | 'stale-session'): Promise<void> {
    const alreadyInControl = Boolean(this.store.getControl(userId));
    const control = await this.ensureControl(userId);
    if (automaticReason && !alreadyInControl) {
      const welcomePending = this.store.get().welcomePending;
      const status = automaticReason === 'stale-session'
        ? '当前会话已失效，已进入会话管理模式。'
        : '当前没有会话，已进入会话管理模式。';
      const sent = await this.reply(userId, welcomePending ? `${WELCOME_TEXT}\n\n${status}` : status);
      if (sent && welcomePending) this.markWelcomeSent();
    }
    if (!text.trim()) {
      this.quickSessionLists.delete(userId);
      await this.reply(userId, QUICK_GUIDE_TEXT, { source: 'control' });
      return;
    }

    const current = this.store.getBinding(userId);
    const previous = this.store.getBindingHistory(userId)[0];
    const currentContext = current
      ? `当前绑定：cli=${current.cli ?? 'codex'}\nthread_id=${current.threadId}\ncwd=${current.cwd}\n本地备注=${current.note || this.store.getSessionNote(current.threadId) || '无'}\n模型=${formatModel(current.model, current.reasoningEffort, current.fast ? 'fast' : null)}`
      : '当前没有绑定的 Codex 会话。';
    const previousContext = previous
      ? `\n上一个绑定（用户说“返回上一个”时使用）：thread_id=${previous.threadId}\ncwd=${previous.cwd}`
      : '';
    const context = `${currentContext}${previousContext}`;
    const feedback = control.executionFeedback ? `\n上一次 wecode 系统执行结果：${control.executionFeedback}` : '';
    const pendingTakeover = control.pendingTakeover
      ? `\n待确认安全接管：thread_id=${control.pendingTakeover.threadId}\ncwd=${control.pendingTakeover.cwd}\n目标状态=${control.pendingTakeover.running ? '有活动任务' : '未确认有活动任务'}\n只有用户明确回复“确认接管”“确定接管”或“继续接管”时，才允许对同一 thread_id 执行 takeover=true。确认后会先通过 Codex App Server 中断活动 turn；Windows 若仍有外部客户端持有该 thread 锁，不会强制关闭客户端，接管失败时会自动尝试分叉新会话。`
      : '';
    const catalogState = control.sessionId
      ? '本轮未重新加载原生会话 catalog；如果之前的会话管理对话中已有适用 catalog，可以继续使用；否则返回 request_catalog。'
      : '当前尚未加载原生会话 catalog；如果本条请求需要历史会话，请返回 request_catalog。';
    const makePrompt = (catalog: string): string => `${text.trim()}\n\n[wecode 系统上下文]\n${context}\n默认搜索根目录：${this.config.searchRoots.join('、')}\n${feedback}${pendingTakeover}\n${catalog}`;
    const prompt = makePrompt(catalogState);

    // Entering management already sends a status message above. For an
    // existing control conversation, only show a progress message when the
    // Agent actually takes a while; fast requests should not produce a
    // redundant "处理中……" message on every turn.
    const enteredManagement = Boolean(automaticReason && !alreadyInControl);
    const delayedProgress = enteredManagement ? undefined : this.scheduleControlProgress(userId);
    try {
      if (control.pendingTakeover && isTakeoverConfirmation(text)) {
        const pending = control.pendingTakeover;
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '已确认，正在安全接管……');
        await this.useSession(userId, pending.threadId, {}, pending.cwd, true);
        this.store.clearControl(userId);
        return;
      }
      let result = await this.controlAgent.run(userId, prompt, control.sessionId);
      if (result.action.action === 'request_catalog') {
        const requestSessionId = result.sessionId || control.sessionId;
        this.store.setControl(userId, {
          ...control,
          ...(requestSessionId ? { sessionId: requestSessionId } : {}),
          lastActivityAt: Date.now(),
        });
        const catalog = await this.controlCatalog().catch(() => '当前暂时无法读取原生会话列表，请自行扫描默认项目根目录。');
        result = await this.controlAgent.run(userId, makePrompt(`原生会话 catalog 已加载，以下内容只供你筛选和生成展示文本，不能向用户暴露 thread_id：\n${catalog}`), requestSessionId);
        if (result.action.action === 'request_catalog') {
          throw new Error('会话管理 Agent 在 catalog 已加载后仍请求读取 catalog');
        }
      }
      const sessionId = result.sessionId || this.store.getControl(userId)?.sessionId;
      const nextControl: ControlState = {
        sessionId,
        startedAt: control.startedAt,
        lastActivityAt: Date.now(),
        ...(control.pendingTakeover ? { pendingTakeover: control.pendingTakeover } : {}),
      };
      if (result.action.action === 'ask') {
        this.store.setControl(userId, nextControl);
        await this.reply(userId, result.action.text || '还需要一些信息。', {
          title: result.action.title,
          presentation: result.action.presentation,
          cwd: current?.cwd,
          source: 'control',
        });
        return;
      }

      this.store.setControl(userId, nextControl);
      await this.executeAction(userId, result.action, { allowTakeover: isTakeoverConfirmation(text) });
      if (result.action.action === 'new_session' || result.action.action === 'switch_session' || result.action.action === 'fork_session') {
        this.store.clearControl(userId);
      }
    } catch (error) {
      process.stderr.write(`[control] ${errorMessage(error)}\n`);
      if (this.controlAgent.consumeInterrupted(userId)) return;
      const latest = this.store.getControl(userId);
      if (error instanceof SessionOccupiedError) {
        if (await this.forkAfterWindowsTakeover(userId, error)) return;
        await this.offerTakeover(userId, error);
        return;
      }
      const feedbackText = controlErrorText(error);
      if (latest) this.store.setControl(userId, { ...latest, lastActivityAt: Date.now(), executionFeedback: feedbackText });
      await this.reply(userId, `${feedbackText}\n可继续补充，或发送“退出”。`, { source: 'bridge' });
    } finally {
      if (delayedProgress) await delayedProgress.cancel();
    }
  }

  private scheduleControlProgress(userId: string): { cancel: () => Promise<void> } {
    let timer: NodeJS.Timeout | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    timer = setTimeout(() => {
      timer = undefined;
      void this.reply(userId, '处理中……').finally(resolveDone);
    }, CONTROL_PROGRESS_DELAY_MS);
    timer.unref();
    return {
      cancel: async () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
          resolveDone();
        }
        await done;
      },
    };
  }

  private async executeAction(userId: string, action: ActionResponse, options: { allowTakeover?: boolean } = {}): Promise<void> {
    if (action.cli && action.cli !== 'codex') throw new Error('当前版本还未接入 Claude Code 适配器');
    switch (action.action) {
      case 'request_catalog':
        throw new Error('会话管理 Agent 的 request_catalog 未在调用流程中处理');
      case 'new_session': {
        if (!action.cwd) throw new Error('新建会话缺少项目目录');
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '正在创建会话……');
        const result = await this.sessions.create(userId, action.cwd, launchOptions(action));
        await this.reply(userId, this.sessionCreatedText(result.binding));
        return;
      }
      case 'switch_session': {
        if (!action.thread_id) throw new Error('切换会话缺少 thread_id');
        const threadId = action.thread_id;
        if (action.takeover) {
          const pending = this.store.getControl(userId)?.pendingTakeover;
          if (!options.allowTakeover || !pending || pending.threadId !== action.thread_id) {
            // Only an exact bridge-level confirmation with a matching pending
            // target can authorize takeover=true.
            action = { ...action, takeover: false };
          }
        }
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '正在恢复会话……');
        await this.useSession(userId, threadId, launchOptions(action), action.cwd, action.takeover === true);
        return;
      }
      case 'fork_session': {
        if (!action.thread_id) throw new Error('分叉会话缺少 thread_id');
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '正在分叉会话……');
        await this.forkSession(userId, action.thread_id, launchOptions(action), action.cwd);
        return;
      }
      case 'list_sessions':
        if (!action.text?.trim()) throw new Error('会话列表缺少展示文本');
        await this.reply(userId, action.text, {
          title: action.title,
          presentation: action.presentation,
          cwd: action.cwd,
          source: 'control',
        });
        return;
      case 'status':
        await this.sendStatus(userId);
        return;
      case 'interrupt': {
        const stopped = await this.sessions.stop(userId);
        await this.reply(userId, stopped ? '任务已停止。' : '当前没有运行中的任务。');
        return;
      }
      case 'set_note': {
        const note = action.note || action.text;
        if (!note?.trim()) throw new Error('备注内容不能为空');
        const binding = await this.sessions.setNote(userId, note);
        await this.reply(userId, `已记录备注：${binding.note}`);
        return;
      }
      case 'reply':
      case 'ask':
        await this.reply(userId, action.text || '会话管理操作已完成。', {
          title: action.title,
          presentation: action.presentation,
          source: 'control',
        });
        return;
    }
  }

  private async useSession(
    userId: string,
    identifier: string,
    options: SessionLaunchOptions = {},
    requestedCwd?: string,
    takeover = false,
  ): Promise<void> {
    if (identifier.startsWith('cc:')) throw new Error('当前版本还未接入 Claude Code 适配器');
    const threadId = await this.sessions.resolveThreadId(identifier);
    const result = await this.sessions.use(userId, threadId, requestedCwd, options, takeover);
    await this.reply(userId, this.switchedText(result.binding));
  }

  private async forkSession(
    userId: string,
    identifier: string,
    options: SessionLaunchOptions = {},
    requestedCwd?: string,
  ): Promise<void> {
    if (identifier.startsWith('cc:')) throw new Error('当前版本还未接入 Claude Code 适配器');
    const threadId = await this.sessions.resolveThreadId(identifier);
    const result = await this.sessions.fork(userId, threadId, requestedCwd, options);
    await this.reply(userId, this.forkedText(result.binding));
  }

  private async forkCurrent(userId: string): Promise<void> {
    const binding = this.store.getBinding(userId);
    const pending = this.store.getControl(userId)?.pendingTakeover;
    const sourceThreadId = pending?.threadId || binding?.threadId;
    const sourceCwd = pending?.cwd || binding?.cwd;
    if (!sourceThreadId) {
      await this.reply(userId, '当前没有可分叉的会话。');
      return;
    }
    await this.stopBeforeSwitch(userId);
    await this.reply(userId, '正在分叉当前会话……');
    const result = await this.sessions.fork(userId, sourceThreadId, sourceCwd, pending ? {} : (binding ?? {}));
    this.store.clearControl(userId);
    await this.reply(userId, this.forkedText(result.binding));
  }

  private async sendToTarget(userId: string, text: string): Promise<void> {
    const status = await this.sessions.status(userId);
    const pending = this.queued.get(userId)?.length ?? 0;
    if (status.running && !this.draining.has(userId) && pending === 0) {
      try {
        const steered = await this.sessions.steer(userId, text);
        if (steered.accepted) {
          await this.reply(userId, '已追加，继续处理。');
          return;
        }
      } catch (error) {
        process.stderr.write(`[bridge] active turn steer unavailable: ${errorMessage(error)}\n`);
      }
    }
    if (status.running || this.draining.has(userId) || pending > 0) {
      const queue = this.queued.get(userId) ?? [];
      queue.push(text);
      this.queued.set(userId, queue);
      await this.reply(userId, `已排队 ${queue.length} 条，任务完成后继续。`);
      if (!status.running && !this.draining.has(userId)) {
        void this.drainQueue(userId).catch((error) => {
          process.stderr.write(`[bridge] queued turn failed: ${errorMessage(error)}\n`);
        });
      }
      return;
    }
    const result = await this.sessions.send(userId, text);
    if (!result.accepted) {
      await this.handleControl(userId, text, 'no-session');
      return;
    }
    await this.reply(userId, '已发送，执行中……');
  }

  async onTurn(result: TurnResult): Promise<void> {
    const entry = Object.entries(this.store.get().bindings).find(([, binding]) => binding.threadId === result.threadId);
    if (!entry) return;
    const [userId, binding] = entry;
    // Reserve the user's outbound turn before sending the result. A new
    // WeChat message that arrives while this reply is in flight must join the
    // queue behind messages already waiting, instead of overtaking them.
    this.draining.add(userId);
    try {
      const progressKey = turnProgressKey(result.threadId, result.turnId);
      await this.flushTurnProgress(progressKey);
      this.turnProgress.delete(progressKey);
      const progressChain = this.progressReplyChains.get(userId);
      if (progressChain) await progressChain;
      let delivered = false;
      if (result.status === 'interrupted') delivered = await this.deliverFinalReply(userId, '任务已中断。');
      else if (result.status === 'failed') {
        delivered = await this.deliverFinalReply(userId, `Codex 执行失败：${result.error || result.text || '未知错误'}`);
      } else if (result.text.trim()) {
        delivered = await this.deliverFinalReply(userId, result.text, {
          kind: result.kind,
          presentation: result.presentation,
          cwd: binding.cwd,
          source: 'codex',
        });
      } else delivered = await this.deliverFinalReply(userId, '已完成，无可展示内容。');
      if (delivered) await this.flushQueuedTurn(userId);
    } finally {
      this.draining.delete(userId);
    }
  }

  async onTurnProgress(progress: TurnProgress): Promise<void> {
    if (progress.kind !== 'preamble') return;
    const entry = Object.entries(this.store.get().bindings).find(([, binding]) => binding.threadId === progress.threadId);
    if (!entry || !progress.text.trim()) return;
    const [userId] = entry;
    const key = turnProgressKey(progress.threadId, progress.turnId);
    let buffer = this.turnProgress.get(key);
    if (!buffer) {
      buffer = { userId, text: '' };
      this.turnProgress.set(key, buffer);
    }
    buffer.text += progress.text;
    if (buffer.text.length >= TURN_PROGRESS_FLUSH_LENGTH) {
      await this.flushTurnProgress(key);
      return;
    }
    if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        void this.flushTurnProgress(key).catch((error) => {
          process.stderr.write(`[bridge] progress flush failed: ${errorMessage(error)}\n`);
        });
      }, TURN_PROGRESS_FLUSH_DELAY_MS);
      buffer.timer.unref();
    }
  }

  private async flushTurnProgress(key: string): Promise<void> {
    const buffer = this.turnProgress.get(key);
    if (!buffer) return;
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }
    if (buffer.flushing) {
      await buffer.flushing;
      if (buffer.text.trim()) await this.flushTurnProgress(key);
      return;
    }
    const text = buffer.text.trim();
    if (!text) return;
    buffer.text = '';
    const sending = this.progressReply(buffer.userId, text);
    buffer.flushing = sending;
    try {
      await sending;
    } finally {
      if (buffer.flushing === sending) buffer.flushing = undefined;
    }
    if (buffer.text.trim()) await this.flushTurnProgress(key);
  }

  private async progressReply(userId: string, text: string): Promise<boolean> {
    const previous = this.progressReplyChains.get(userId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.reply(userId, text, { source: 'codex' }));
    const settled = task.then(() => undefined, () => undefined);
    this.progressReplyChains.set(userId, settled);
    try {
      return await task;
    } finally {
      if (this.progressReplyChains.get(userId) === settled) this.progressReplyChains.delete(userId);
    }
  }

  private async deliverFinalReply(userId: string, text: string, options: ReplyOptions = {}): Promise<boolean> {
    if (this.pendingReplies.get(userId)?.length) {
      this.enqueuePendingReply(userId, text, options);
      return false;
    }
    const sent = await this.finalReply(userId, text, options);
    if (sent) return true;
    this.enqueuePendingReply(userId, text, options);
    process.stderr.write('[wechat] final response queued for retry\n');
    return false;
  }

  private enqueuePendingReply(userId: string, text: string, options: ReplyOptions): void {
    const queue = this.pendingReplies.get(userId) ?? [];
    const waitForFreshContext = this.awaitingFreshContext.has(userId);
    queue.push({ text, options, attempts: 0, ...(waitForFreshContext ? { waitForFreshContext: true } : {}) });
    this.pendingReplies.set(userId, queue);
    this.persistPendingReplies();
    if (!waitForFreshContext) this.schedulePendingReplyRetry(userId, 0);
  }

  private async flushPendingReplies(userId: string, resetAttempts = false): Promise<boolean> {
    if (resetAttempts) this.pendingReplyRefreshes.add(userId);
    const previous = this.pendingReplyFlushes.get(userId);
    if (previous) return previous;
    const task = (async () => {
      let result = true;
      while (true) {
        result = await this.flushPendingRepliesInternal(userId, this.pendingReplyRefreshes.delete(userId));
        if (!this.pendingReplyRefreshes.has(userId)) return result;
      }
    })();
    this.pendingReplyFlushes.set(userId, task);
    try {
      return await task;
    } finally {
      if (this.pendingReplyFlushes.get(userId) === task) this.pendingReplyFlushes.delete(userId);
    }
  }

  private async flushPendingRepliesInternal(userId: string, resetAttempts: boolean): Promise<boolean> {
    const queue = this.pendingReplies.get(userId);
    if (!queue?.length) return true;
    if (resetAttempts) {
      this.awaitingFreshContext.delete(userId);
      for (const pending of queue) pending.attempts = 0;
      for (const pending of queue) delete pending.waitForFreshContext;
    }
    const timer = this.pendingReplyTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.pendingReplyTimers.delete(userId);
    }
    while (queue.length) {
      const pending = queue[0];
      if (!pending) break;
      if (await this.finalReply(userId, pending.text, pending.options)) {
        queue.shift();
        this.persistPendingReplies();
        continue;
      }
      pending.attempts += 1;
      pending.waitForFreshContext = this.awaitingFreshContext.has(userId);
      this.persistPendingReplies();
      if (!pending.waitForFreshContext) this.schedulePendingReplyRetry(userId, pending.attempts);
      return false;
    }
    this.pendingReplies.delete(userId);
    this.persistPendingReplies();
    if (this.queued.get(userId)?.length && !this.draining.has(userId)) {
      void this.drainQueue(userId).catch((error) => {
        process.stderr.write(`[bridge] queued turn failed: ${errorMessage(error)}\n`);
      });
    }
    return true;
  }

  private schedulePendingReplyRetry(userId: string, attempts: number): void {
    if (this.awaitingFreshContext.has(userId)) return;
    if (this.pendingReplyTimers.has(userId)) return;
    const delayIndex = Math.min(attempts, PENDING_REPLY_RETRY_DELAYS_MS.length - 1);
    const timer = setTimeout(() => {
      this.pendingReplyTimers.delete(userId);
      void this.flushPendingReplies(userId).catch((error) => {
        process.stderr.write(`[wechat] pending final response retry failed: ${errorMessage(error)}\n`);
      });
    }, PENDING_REPLY_RETRY_DELAYS_MS[delayIndex]);
    timer.unref();
    this.pendingReplyTimers.set(userId, timer);
  }

  private async drainQueue(userId: string): Promise<void> {
    if (this.draining.has(userId)) return;
    this.draining.add(userId);
    try {
      await this.flushQueuedTurn(userId);
    } finally {
      this.draining.delete(userId);
    }
  }

  private async flushQueuedTurn(userId: string): Promise<void> {
    if (!this.store.getBinding(userId)) {
      this.queued.delete(userId);
      return;
    }
    const status = await this.sessions.status(userId);
    if (status.running) return;
    const queue = this.queued.get(userId);
    if (!queue?.length) return;
    const next = queue.shift();
    if (!queue.length) this.queued.delete(userId);
    if (!next) return;

    try {
      const result = await this.sessions.send(userId, next);
      if (!result.accepted) {
        this.queued.delete(userId);
        await this.handleControl(userId, next, 'no-session');
        return;
      }
      const remaining = this.queued.get(userId)?.length ?? 0;
      await this.reply(userId, `已继续${remaining ? `，剩余 ${remaining} 条` : ''}。`);
    } catch (error) {
      if (error instanceof SessionOccupiedError) {
        const rest = this.queued.get(userId) ?? [];
        this.queued.set(userId, [next, ...rest]);
        await this.offerTakeover(userId, error);
        return;
      }
      if (isStaleSessionError(error)) {
        this.queued.delete(userId);
        await this.recoverStaleSession(userId, next);
        return;
      }
      const rest = this.queued.get(userId) ?? [];
      this.queued.set(userId, [next, ...rest]);
      await this.reply(userId, `排队消息暂未发送：${userFacingError(error)}`);
    }
  }

  private async sendStatus(userId: string): Promise<void> {
    const status = await this.sessions.status(userId);
    const control = this.store.getControl(userId);
    const mode = control
      ? `会话管理 Agent：${this.controlAgent.isRunning(userId) ? '处理中' : '等待指令'}`
      : '目标 Codex';
    const queue = this.queued.get(userId)?.length ?? 0;
    if (!status.binding) {
      await this.reply(userId, `${mode}\n当前没有会话。`);
      return;
    }
    await this.reply(
      userId,
      `${mode}\n目录：${status.binding.cwd}\n模型：${formatModel(status.binding.model, status.binding.reasoningEffort, status.binding.fast ? 'fast' : null)}\n任务：${status.running ? '运行中' : '空闲'}\n队列：${queue}`,
    );
  }

  private async stop(userId: string): Promise<void> {
    const hasControl = Boolean(this.store.getControl(userId));
    let controlStopped = false;
    if (hasControl) controlStopped = await this.controlAgent.interrupt(userId).catch(() => false);
    this.queued.delete(userId);
    const targetStopped = await this.sessions.stop(userId);
    if (controlStopped && targetStopped) {
      await this.reply(userId, '会话管理 Agent 和 Codex 任务已停止。');
    } else if (controlStopped) {
      await this.reply(userId, '会话管理 Agent 已停止；Codex 当前空闲。');
    } else if (targetStopped) {
      await this.reply(userId, 'Codex 任务已停止。');
    } else if (hasControl) {
      await this.reply(userId, '会话管理 Agent 和 Codex 都没有运行中的任务。');
    } else {
      await this.reply(userId, '当前没有运行中的任务。');
    }
  }

  private async exit(userId: string): Promise<void> {
    this.queued.delete(userId);
    if (this.store.getControl(userId)) {
      await this.controlAgent.interrupt(userId).catch(() => false);
      this.leaveControl(userId);
      await this.reply(userId, '已退出会话管理 Agent。');
      return;
    }
    const binding = this.store.getBinding(userId);
    if (!binding) {
      await this.reply(userId, '当前没有会话管理流程或会话。');
      return;
    }
    const releaseResult = await this.sessions.release(userId);
    this.store.pushBindingHistory(userId, binding, this.config.bindingHistoryLimit);
    this.store.clearBinding(userId);
    const externalWriter = releaseResult?.externalWriter;
    if (externalWriter?.pids.length) {
      await this.reply(userId, '已退出 wecode 当前绑定；历史仍保留。\n但 GPT/Codex 客户端仍持有该会话锁；为避免客户端崩溃，wecode 没有强制关闭它。请完全退出 GPT/Codex 客户端（包括托盘进程）后再继续。');
      return;
    }
    await this.reply(userId, '已退出当前会话；历史仍保留。');
  }

  private async stopBeforeSwitch(userId: string): Promise<void> {
    const status = await this.sessions.status(userId);
    if (!status.running) return;
    await this.reply(userId, '正在停止任务……');
    this.queued.delete(userId);
    await this.sessions.stop(userId);
  }

  private async forkAfterWindowsTakeover(userId: string, error: SessionOccupiedError): Promise<boolean> {
    if (process.platform !== 'win32' || !error.takeoverAttempted || !/Windows 外部 Codex 客户端持有目标锁/.test(error.message)) {
      return false;
    }
    try {
      await this.reply(userId, 'Windows Codex Desktop 仍占用原会话，正在复制已保存历史并创建新会话……');
      const result = await this.sessions.fork(userId, error.threadId, error.cwd);
      this.store.clearControl(userId);
      await this.reply(userId, this.forkedText(result.binding));
      return true;
    } catch (forkError) {
      process.stderr.write(`[control] Windows 会话分叉失败：${errorMessage(forkError)}\n`);
      return false;
    }
  }

  private async ensureControl(userId: string): Promise<ControlState> {
    const current = this.store.getControl(userId);
    if (current) {
      const updated = { ...current, lastActivityAt: Date.now() };
      this.store.setControl(userId, updated);
      return updated;
    }
    const created = { startedAt: Date.now(), lastActivityAt: Date.now() };
    this.store.setControl(userId, created);
    return created;
  }

  private async sendPendingWelcome(userId: string): Promise<boolean> {
    if (!this.store.get().welcomePending) return false;
    const sent = await this.reply(userId, WELCOME_TEXT);
    if (sent) this.markWelcomeSent();
    return sent;
  }

  private markWelcomeSent(): void {
    this.store.update((state) => {
      state.welcomePending = false;
    });
  }

  private async recoverStaleSession(userId: string, text: string): Promise<void> {
    const binding = this.store.getBinding(userId);
    if (binding) {
      await this.sessions.release(userId).catch(() => undefined);
      this.store.pushBindingHistory(userId, binding, this.config.bindingHistoryLimit);
      this.store.clearBinding(userId);
    }
    this.queued.delete(userId);
    await this.handleControl(userId, text, 'stale-session');
  }

  private async offerTakeover(userId: string, error: SessionOccupiedError): Promise<void> {
    const current = this.store.getControl(userId);
    const now = Date.now();
    if (error.takeoverAttempted) {
      const windowsClientProtected = process.platform === 'win32' && /Windows 外部 Codex 客户端持有目标锁/.test(error.message);
      const message = error.running
        ? '安全接管失败：外部客户端仍有活动任务，未能安全释放目标会话。'
        : '安全接管失败：任务已空闲，但未能释放持有目标锁的外部客户端。';
      const nextStep = windowsClientProtected
        ? '为避免 GPT/Codex 客户端崩溃，Windows 不会自动强杀外部客户端；请先完全退出客户端（包括托盘进程）后重试，也可以发送“分叉当前会话”；'
        : error.running
          ? '请先在外部客户端停止任务并释放会话后重试；'
          : '请先退出外部 Codex 客户端或关闭该会话后重试；';
      if (current) {
        const { pendingTakeover: _pendingTakeover, ...withoutPendingTakeover } = current;
        this.store.setControl(userId, {
          ...withoutPendingTakeover,
          lastActivityAt: now,
          executionFeedback: message,
        });
      }
      await this.reply(userId, `${message}\n${nextStep}可发送“退出”。`, { source: 'bridge' });
      return;
    }

    const pending: PendingTakeover = {
      threadId: error.threadId,
      cwd: error.cwd || this.config.defaultCwd,
      running: error.running,
    };
    const control = current ?? { startedAt: now, lastActivityAt: now };
    const message = `目标会话被占用：${pending.cwd}`;
    this.store.setControl(userId, {
      ...control,
      lastActivityAt: now,
      executionFeedback: message,
      pendingTakeover: pending,
    });
    await this.reply(
      userId,
      `${message}\n回复“确认接管”进行安全接管；Windows 若仍被外部客户端（Desktop）占用，会自动复制已保存历史创建新会话，不会强制关闭客户端。\n也可以回复“分叉当前会话”；否则回复“退出”。`,
      { source: 'bridge' },
    );
  }

  private leaveControl(userId: string): void {
    this.store.clearControl(userId);
  }

  private controlExpired(userId: string): boolean {
    const control = this.store.getControl(userId);
    return Boolean(control && Date.now() - control.lastActivityAt >= this.config.controlTimeoutMs);
  }

  private async controlCatalog(): Promise<string> {
    const list = await this.sessions.list();
    if (!list.length) return '可恢复原生 Codex 会话：无';
    const entries = list.map((thread) => JSON.stringify({
      cli: thread.cli ?? 'codex',
      thread_id: thread.id,
      cwd: thread.cwd ?? null,
      name: thread.name ?? null,
      preview: thread.preview ?? null,
      created_at: formatTimestamp(thread.createdAt),
      updated_at: formatTimestamp(thread.updatedAt),
      status: thread.status?.type ?? null,
      active_flags: thread.status?.activeFlags ?? [],
    }));
    return `可恢复原生 Codex 会话原始 catalog（JSONL；只供你筛选和生成展示文本，不能向用户暴露 thread_id）：\n${entries.join('\n')}`;
  }

  private sessionCreatedText(binding: SessionBinding): string {
    return `已新建会话\n目录：${binding.cwd}\n${SESSION_ACTIVE_HINT}`;
  }

  private switchedText(binding: SessionBinding, prefix = '已切换会话'): string {
    return `${prefix}\n目录：${binding.cwd}\n${SESSION_ACTIVE_HINT}`;
  }

  private forkedText(binding: SessionBinding): string {
    return `已分叉新会话\n原会话仍保留，当前已绑定新会话\n目录：${binding.cwd}\n${SESSION_ACTIVE_HINT}`;
  }

  private async reply(
    userId: string,
    text: string,
    options: ReplyOptions = {},
  ): Promise<boolean> {
    try {
      return await this.sendReply(userId, text, options);
    } catch (error) {
      process.stderr.write(`[wechat] reply failed: ${errorMessage(error)}\n`);
      return false;
    }
  }

  private async finalReply(userId: string, text: string, options: ReplyOptions = {}): Promise<boolean> {
    const previous = this.finalReplyChains.get(userId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.sendReply(userId, text, options));
    const settled = task.then(() => undefined, () => undefined);
    this.finalReplyChains.set(userId, settled);
    try {
      return await task;
    } catch (error) {
      process.stderr.write(`[wechat] reply failed: ${errorMessage(error)}\n`);
      return false;
    } finally {
      if (this.finalReplyChains.get(userId) === settled) this.finalReplyChains.delete(userId);
    }
  }

  private async sendReply(userId: string, text: string, options: ReplyOptions): Promise<boolean> {
    const contextToken = this.store.get().contextTokens[userId] ?? '';
    if (!contextToken) {
      this.awaitingFreshContext.add(userId);
      return false;
    }
    const { source = 'bridge', ...renderOptions } = options;
    const rendered = await renderResponse({ text: decorateReply(text, source), ...renderOptions }, this.pages);
    const payload = rendered.mode === 'page' ? rendered.fallback : rendered.text;
    const result = await this.ilink.sendText(userId, payload, contextToken, this.config.chatChunkSize);
    if (!result.ok) {
      const needsFreshContext = result.needsFreshContext
        || result.code === -2
        || /prepare failed/i.test(result.errmsg || '');
      const contextWasRefreshed = this.store.get().contextTokens[userId] !== contextToken;
      if (needsFreshContext && !contextWasRefreshed) this.awaitingFreshContext.add(userId);
      const code = result.code === undefined ? '' : `ret=${result.code} `;
      const waiting = needsFreshContext && !contextWasRefreshed ? '；等待用户下一条消息刷新 context_token' : '';
      process.stderr.write(`[wechat] send failed: ${code}${result.errmsg || result.raw || 'unknown'}${waiting}\n`);
      return false;
    }
    this.awaitingFreshContext.delete(userId);
    return true;
  }

  private persistPendingReplies(): void {
    this.store.update((state) => {
      state.pendingReplies = Object.fromEntries(
        [...this.pendingReplies.entries()].filter(([, replies]) => replies.length),
      );
    });
  }
}

function formatQuickSessionList(sessions: ThreadSummary[]): string {
  if (!sessions.length) return '没有找到历史 Codex 会话。';
  const rows = sessions.map((thread, index) => [
    `${index + 1}. **${sessionDisplayName(thread)}** — ${sessionPreview(thread)}`,
    '',
    `更新时间：${formatTimestamp(thread.updatedAt)}`,
  ].join('\n'));
  return rows.join('\n') + '\n\n回复序号即可切换（10 分钟内）。';
}

function formatSessionInspectionList(inspections: SessionInspection[], activeOnly: boolean): string {
  const readOnlyHint = '\n\n本次为只读查看，不会接管或绑定会话。';
  if (!inspections.length) {
    return (activeOnly ? '当前没有检测到正在运行的 Codex 任务。' : '没有找到最近的 Codex 任务。') + readOnlyHint;
  }
  const title = activeOnly ? '当前活动 Codex 任务（只读）' : '最近 Codex 任务（只读）';
  const rows = inspections.map((inspection, index) => {
    const thread = inspection.snapshot ?? inspection.summary;
    const actionLabel = inspectionThreadIsRunning(thread) ? '当前动作' : '最近动作';
    const statusType = cleanActivityText(thread.status?.type)?.toLowerCase();
    const status = statusType === 'notloaded' ? undefined : formatInspectionStatus(thread.status);
    return [
      `${index + 1}. **${sessionDisplayName(thread)}**`,
      ...(status ? [`状态：${status}`] : []),
      `${actionLabel}：${describeInspectionActivity(inspection)}`,
      '',
      `更新时间：${formatTimestamp(inspection.summary.updatedAt ?? inspection.snapshot?.updatedAt)}`,
    ].join('\n');
  });
  return `${title}\n\n${rows.join('\n\n')}${readOnlyHint}`;
}

function describeInspectionActivity(inspection: SessionInspection): string {
  const thread = inspection.snapshot ?? inspection.summary;
  const currentlyRunning = inspectionThreadIsRunning(thread);
  const turn = latestInspectionTurn(inspection.snapshot);
  const item = latestInspectionItem(turn);
  if (item) return describeInspectionItem(item, currentlyRunning);
  if (turn?.status) return `turn ${formatInspectionItemStatus(turn.status).replace(/[（）]/gu, '') || turn.status}`;
  const preview = cleanActivityText(thread.preview || thread.name);
  if (preview) return truncateActivityText(preview);
  return currentlyRunning
    ? '会话正在运行，暂未读到最新任务项'
    : '暂无可展示的任务详情';
}

function latestInspectionTurn(snapshot?: ThreadSnapshot): ThreadTurnSummary | undefined {
  const turns = snapshot?.turns ?? [];
  return [...turns].reverse().find(isInspectionTurnRunning) ?? turns.at(-1);
}

function latestInspectionItem(turn?: ThreadTurnSummary): ThreadItemSummary | undefined {
  const items = turn?.items ?? [];
  return [...items].reverse().find(isInspectionItemRunning) ?? items.at(-1);
}

function describeInspectionItem(item: ThreadItemSummary, currentlyRunning: boolean): string {
  const type = cleanActivityText(item.type)?.toLowerCase().replace(/[^a-z0-9]/gu, '') || '';
  const suffix = formatInspectionItemStatus(item.status);
  if (type.includes('reasoning')) return `${currentlyRunning ? '正在分析任务' : '已分析任务'}${suffix}`;
  if (type.includes('contextcompaction')) return `${currentlyRunning ? '正在整理会话上下文' : '已整理会话上下文'}${suffix}`;
  if (type.includes('commandexecution')) {
    const command = cleanActivityText(item.command);
    return `执行命令${command ? `：${truncateActivityText(command, 160)}` : ''}${suffix}`;
  }
  if (type.includes('filechange')) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
      .map((change) => asActivityRecord(change))
      .map((change) => cleanActivityText(change?.path) || cleanActivityText(change?.filePath))
      .filter((value): value is string => Boolean(value));
    return `修改文件${paths.length ? `：${paths.slice(0, 4).join('、')}${paths.length > 4 ? ' 等' : ''}` : ''}${suffix}`;
  }
  if (type.includes('mcptoolcall')) {
    const server = cleanActivityText(item.server) || cleanActivityText(item.serverName);
    const tool = cleanActivityText(item.tool) || cleanActivityText(item.name);
    const name = [server, tool].filter(Boolean).join('/');
    return `调用工具${name ? `：${name}` : ''}${suffix}`;
  }
  if (type.includes('plan')) {
    const plan = cleanActivityText(item.text) || cleanActivityText(item.summary);
    return `执行计划${plan ? `：${truncateActivityText(plan)}` : ''}${suffix}`;
  }
  if (type.includes('agentmessage')) {
    const text = cleanActivityText(item.text);
    return `${item.phase === 'commentary' ? '进度' : '生成回复'}${text ? `：${truncateActivityText(text)}` : ''}${suffix}`;
  }
  if (type.includes('usermessage')) {
    const text = cleanActivityText(item.text);
    return `处理请求${text ? `：${truncateActivityText(text)}` : ''}${suffix}`;
  }
  return `${type ? `处理 ${type}` : currentlyRunning ? '正在处理任务' : '已处理任务'}${suffix}`;
}

function formatInspectionStatus(status?: ThreadSummary['status']): string {
  const type = cleanActivityText(status?.type)?.toLowerCase() || '';
  const labels: Record<string, string> = {
    active: '处理中',
    running: '处理中',
    in_progress: '处理中',
    inprogress: '处理中',
    idle: '空闲',
    notloaded: '历史会话（未加载）',
    systemerror: '系统错误',
  };
  const label = labels[type] || status?.type || (type || '状态未知');
  const flags = (status?.activeFlags ?? []).map(formatInspectionFlag).filter(Boolean);
  return flags.length ? `${label}（${flags.join('、')}）` : label;
}

function formatInspectionFlag(flag: string): string {
  const labels: Record<string, string> = {
    waitingOnApproval: '等待审批',
    waitingOnUserInput: '等待用户输入',
    waitingOnUser: '等待用户输入',
    running: '运行中',
  };
  return labels[flag] || flag;
}

function formatInspectionItemStatus(status?: string): string {
  const value = cleanActivityText(status)?.toLowerCase() || '';
  if (!value) return '';
  const labels: Record<string, string> = {
    active: '运行中',
    running: '运行中',
    in_progress: '运行中',
    inprogress: '运行中',
    started: '运行中',
    waiting: '等待中',
    waitingonapproval: '等待审批',
    waitingonuserinput: '等待用户输入',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
  };
  return `（${labels[value.replace(/[^a-z0-9]/gu, '')] || status}）`;
}

function inspectionThreadIsRunning(thread: ThreadSummary | ThreadSnapshot): boolean {
  const type = cleanActivityText(thread.status?.type)?.toLowerCase() || '';
  return ['active', 'running', 'in_progress', 'inprogress'].includes(type)
    || Boolean(thread.status?.activeFlags?.length)
    || ('turns' in thread && (thread.turns ?? []).some(isInspectionTurnRunning));
}

function isInspectionTurnRunning(turn: ThreadTurnSummary): boolean {
  const status = cleanActivityText(turn.status)?.toLowerCase() || '';
  return ['active', 'running', 'in_progress', 'inprogress', 'started'].includes(status) || /progress/u.test(status);
}

function isInspectionItemRunning(item: ThreadItemSummary): boolean {
  const status = cleanActivityText(item.status)?.toLowerCase() || '';
  return ['active', 'running', 'in_progress', 'inprogress', 'started', 'waiting'].includes(status)
    || /progress/u.test(status);
}

function asActivityRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function cleanActivityText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text || undefined;
}

function truncateActivityText(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function sessionDisplayName(thread: ThreadSummary): string {
  const cwd = thread.cwd?.trim().replace(/[\\/]+$/u, '');
  const directory = cwd?.split(/[\\/]/u).at(-1);
  return directory || thread.name?.trim() || '未命名会话';
}

function sessionPreview(thread: ThreadSummary): string {
  const value = (thread.preview || thread.name || '未命名会话').replace(/\s+/gu, ' ').trim();
  return value.length > 160 ? value.slice(0, 157) + '...' : value;
}

function launchOptions(value: {
  cli?: SessionLaunchOptions['cli'];
  model?: string;
  reasoningEffort?: string;
  reasoning_effort?: string;
  fast?: boolean;
}): SessionLaunchOptions {
  return {
    ...(value.cli ? { cli: value.cli } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...((value.reasoningEffort || value.reasoning_effort) ? { reasoningEffort: value.reasoningEffort || value.reasoning_effort } : {}),
    ...(value.fast === undefined ? {} : { fast: value.fast }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decorateReply(text: string, source: ReplySource): string {
  const value = text.trim();
  if (source === 'codex') return value;
  if (source === 'control') return `> **会话管理 Agent**\n\n${value}`;
  return `> **wecode 系统**\n\n${value}`;
}

function turnProgressKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function controlErrorText(error: unknown): string {
  const message = errorMessage(error);
  if (/interrupt|signal/i.test(message)) return '会话管理 Agent 已中断。';
  if (/no rollout found|thread not found/i.test(message)) return '会话管理 Agent 会话无法恢复；当前流程仍保留。';
  if (message.includes('reasoning_effort must not be empty') || message.includes('model_reasoning_effort')) {
    return '会话管理 Agent 配置无效：model_reasoning_effort 为空；请删除空配置或设置有效推理强度后重启。';
  }
  if (message.includes('会话管理 Agent 返回格式不正确') || message.includes('未返回有效 action JSON')) {
    return '会话管理 Agent 返回格式不正确；请先发送“退出”后重试，或先指定项目目录。';
  }
  if (/thread-store conflict|active writer|already in use|being used|occupied|locked|another client|其他 Codex 客户端|原生终端占用/i.test(message)) {
    return '目标会话被占用；回复“确认接管”安全恢复，或先结束外部任务。';
  }
  return '会话管理 Agent 暂时没有完成这次请求；请稍后重试，详细原因已记录在本地日志。';
}

function userFacingError(error: unknown): string {
  const message = errorMessage(error);
  if (/thread-store conflict|active writer|already in use|being used|occupied|locked|another client|其他 Codex 客户端|原生终端占用/i.test(message)) {
    return '目标会话被占用；回复“确认接管”，或先结束外部任务。';
  }
  if (/no rollout found|thread not found/i.test(message)) {
    return '当前会话已失效，已进入会话管理模式。';
  }
  if (/项目目录不能为空|项目目录不存在|没有当前 Codex 会话|会话 ID|Claude Code/i.test(message)) return message;
  return '处理请求时遇到内部错误，请稍后重试；详细信息已记录在本地日志。';
}

function looksLikeSkillDocument(input: string): boolean {
  const text = input.trim();
  return /<skill\b[\s\S]*?<\/skill>/i.test(text)
    || (text.length >= 2000 && /\bSKILL\.md\b/i.test(text));
}

function isStaleSessionError(error: unknown): boolean {
  return /no rollout found|thread not found/i.test(errorMessage(error));
}

function isTakeoverConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[\s\u3000“”"‘’'。.!！？?，,、]/g, '');
  return new Set(['确认接管', '确定接管', '继续接管', '同意接管', '确认', 'confirm', 'yes', 'y']).has(normalized);
}
