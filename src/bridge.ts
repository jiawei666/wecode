import type { AppConfig } from './config.js';
import { SESSION_ACTIVE_HINT, WELCOME_TEXT, parseBridgeCommand } from './commands.js';
import { ControlAgent } from './control.js';
import type { InboundAttachment, InboundMessage, IlinkClient } from './ilink.js';
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
  TurnResult,
} from './model.js';
import { renderResponse, PagePublisher } from './render.js';
import { formatModel, formatTimestamp, normalizeTimestamp } from './session-display.js';
import { SessionManager, SessionOccupiedError } from './sessions.js';
import { StateStore } from './state.js';

interface TurnProgressBuffer {
  userId: string;
  text: string;
  timer?: NodeJS.Timeout;
  flushing?: Promise<unknown>;
}

interface TypingIndicator {
  contextToken: string;
  timer?: NodeJS.Timeout;
  running?: Promise<boolean>;
  stopped: boolean;
}

const PENDING_REPLY_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000] as const;
const TURN_PROGRESS_FLUSH_DELAY_MS = 3_000;
const TURN_PROGRESS_FLUSH_LENGTH = 900;
const TYPING_KEEPALIVE_MS = 5_000;
const DEFAULT_SESSION_LIST_LIMIT = 5;
const MAX_SESSION_LIST_LIMIT = 20;
const HISTORY_INDEX_LIMIT = 500;
const HISTORY_CONTEXT_SESSION_LIMIT = 20;
const QUICK_SESSION_LIST_TTL_MS = 10 * 60_000;

interface QuickSessionList {
  expiresAt: number;
  limit: number;
  cwd?: string;
  sessions: ThreadSummary[];
}

interface PendingCodexTurn {
  text: string;
  imagePaths: string[];
}

interface HistoryProject {
  cwd: string;
  name: string;
  lastUpdatedAt: number;
  sessionCount: number;
}

function codexTurnForMessage(text: string, attachments: InboundAttachment[]): PendingCodexTurn {
  const usable = attachments.filter((attachment) =>
    (attachment.kind === 'image' || attachment.kind === 'file') && attachment.path,
  );
  const imagePaths = usable
    .filter((attachment) => attachment.kind === 'image')
    .flatMap((attachment) => attachment.path ? [attachment.path] : []);
  const lines = usable.map((attachment) => attachment.kind === 'image'
    ? `- 图片：${attachment.name}（已附加图片）`
    : `- 文件：${attachment.name}\n  本地路径：${attachment.path}`);
  const unsupported = attachments.filter((attachment) => !usable.includes(attachment));
  for (const attachment of unsupported) {
    const reason = attachment.error || (attachment.kind === 'image' || attachment.kind === 'file'
      ? '下载失败'
      : '暂不支持此类附件');
    lines.push(`- ${attachment.kind}：${attachment.name}（${reason}）`);
  }
  const intro = text.trim() || (usable.some((attachment) => attachment.kind === 'image')
    ? '请查看并处理我通过微信发送的图片。'
    : '请读取并处理我通过微信发送的文件。');
  const prompt = lines.length
    ? `${intro}\n\n[微信附件]\n${lines.join('\n')}`
    : intro;
  return { text: prompt, imagePaths };
}

export class BridgeApp {
  private readonly controlAgent: ControlAgent;
  private readonly pages: PagePublisher;
  private readonly sessions: SessionManager;
  private readonly queued = new Map<string, PendingCodexTurn[]>();
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
  private readonly typingIndicators = new Map<string, TypingIndicator>();
  private historySessions: ThreadSummary[] = [];
  private historyProjects: HistoryProject[] = [];

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
    await Promise.all([...this.typingIndicators.keys()].map((userId) => this.stopTyping(userId)));
    for (const timer of this.pendingReplyTimers.values()) clearTimeout(timer);
    this.pendingReplyTimers.clear();
    await this.controlAgent.close();
    await this.pages.close();
    await this.sessions.close();
    await this.store.save();
    this.quickSessionLists.clear();
    this.historySessions = [];
    this.historyProjects = [];
  }

  async initialize(): Promise<void> {
    await this.refreshHistoryIndex().catch((error) => {
      process.stderr.write(`[history] 启动时建立历史项目索引失败：${errorMessage(error)}\n`);
    });
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
      await this.stopTyping(message.from);
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
    const text = message.text.trim();
    const attachments = message.attachments;
    const command = parseBridgeCommand(text);
    const earlyBinding = this.store.getBinding(userId);
    const quickSelection = !command && this.quickSessionLists.has(userId)
      && /^(?:(?:切换(?:到)?|使用|打开)\s*)?(?:第\s*)?\d+(?:\s*个)?(?:会话)?$/u.test(text);
    const missingBindingForAttachment = attachments.length > 0 && !earlyBinding;
    const unboundSkillDocument = !earlyBinding && !this.store.getControl(userId) && looksLikeSkillDocument(text);
    const startsThinking = Boolean(text || attachments.length)
      && (!command || command.kind === 'control')
      && !quickSelection
      && !missingBindingForAttachment
      && !unboundSkillDocument;
    if (startsThinking) this.startTyping(userId);
    await this.flushPendingReplies(userId, Boolean(message.contextToken));
    if (this.store.seen(`${userId}|${message.messageId}|${message.timeMs}`)) {
      if (startsThinking) await this.stopTyping(userId);
      return;
    }

    if (!text && attachments.length === 0) {
      await this.sendPendingWelcome(userId);
      return;
    }

    if (earlyBinding) this.store.setBinding(userId, { ...earlyBinding, lastActivityAt: Date.now() });

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
    if (command?.kind === 'status') {
      await this.sendStatus(userId);
      return;
    }
    if (command?.kind === 'control' && attachments.length === 0) {
      await this.stopBeforeSwitch(userId);
      if (command.text) {
        await this.handleControl(userId, command.text);
        return;
      }
      await this.ensureControl(userId);
      this.startTyping(userId);
      try {
        await this.showDefaultSessionList(userId);
      } finally {
        await this.stopTyping(userId);
      }
      return;
    }

    const selected = this.takeQuickSessionSelection(userId, text);
    if (selected) {
      await this.switchToQuickSession(userId, selected);
      return;
    }
    const binding = this.store.getBinding(userId);
    if (attachments.length) {
      const turn = codexTurnForMessage(command?.kind === 'control' ? command.text : text, attachments);
      const hasForwardableAttachment = attachments.some((attachment) =>
        (attachment.kind === 'image' || attachment.kind === 'file') && attachment.path,
      );
      if (!hasForwardableAttachment) {
        await this.stopTyping(userId);
        await this.reply(userId, '目前只支持转发图片和文件；附件下载失败时请重新发送。');
        return;
      }
      if (!binding) {
        await this.stopTyping(userId);
        await this.reply(userId, '当前没有绑定的 Codex 会话，无法转发附件。请先新建或切换到一个会话，再重新发送图片或文件。');
        return;
      }
      const failed = attachments.filter((attachment) => !attachment.path || (attachment.kind !== 'image' && attachment.kind !== 'file'));
      if (failed.length) {
        await this.reply(userId, `有 ${failed.length} 个附件未能转发：${failed.map((attachment) => `${attachment.name}（${attachment.error || '暂不支持此类附件'}）`).join('、')}`);
      }
      await this.sendToTarget(userId, turn.text, turn.imagePaths);
      return;
    }

    if (this.store.getControl(userId)) {
      await this.handleControl(userId, text);
      return;
    }

    if (!binding && !this.store.getControl(userId) && looksLikeSkillDocument(text)) {
      await this.stopTyping(userId);
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

  private async listSessions(
    userId: string,
    requestedLimit: number,
    cwd?: string,
    showProgress = true,
    forceRefresh = false,
  ): Promise<void> {
    const limit = Math.min(
      Math.max(Math.floor(requestedLimit) || DEFAULT_SESSION_LIST_LIMIT, 1),
      MAX_SESSION_LIST_LIMIT,
    );
    const normalizedCwd = cwd?.trim() || undefined;
    const cached = this.quickSessionLists.get(userId);
    let sessions: ThreadSummary[];
    if (!forceRefresh && cached && cached.expiresAt > Date.now() && cached.limit >= limit && cached.cwd === normalizedCwd) {
      sessions = cached.sessions.slice(0, limit);
    } else {
      if (showProgress) await this.reply(userId, '正在读取最近会话……');
      sessions = orderSessionsForDisplay(
        (await this.sessions.list(normalizedCwd, limit, true))
          .sort((left, right) => (normalizeTimestamp(right.updatedAt) ?? 0) - (normalizeTimestamp(left.updatedAt) ?? 0))
          .slice(0, limit),
      );
      this.cacheSessionList(userId, sessions, limit, normalizedCwd);
    }
    await this.reply(userId, formatQuickSessionList(sessions));
  }

  private async showDefaultSessionList(userId: string): Promise<void> {
    await this.refreshHistoryIndex().catch((error) => {
      process.stderr.write(`[history] 唤醒时刷新历史项目索引失败：${errorMessage(error)}\n`);
    });
    await this.showIndexedSessions(userId, DEFAULT_SESSION_LIST_LIMIT);
  }

  private async showIndexedSessions(userId: string, requestedLimit: number): Promise<void> {
    const limit = Math.min(
      Math.max(Math.floor(requestedLimit) || DEFAULT_SESSION_LIST_LIMIT, 1),
      MAX_SESSION_LIST_LIMIT,
    );
    const sessions = orderSessionsForDisplay(this.historySessions.slice(0, limit));
    this.cacheSessionList(userId, sessions, limit, undefined);
    await this.reply(userId, formatQuickSessionList(sessions));
  }

  private cacheSessionList(
    userId: string,
    sessions: ThreadSummary[],
    limit: number,
    cwd?: string,
  ): void {
    this.quickSessionLists.set(userId, {
      expiresAt: Date.now() + QUICK_SESSION_LIST_TTL_MS,
      limit,
      cwd,
      sessions: [...sessions],
    });
  }

  private async refreshHistoryIndex(): Promise<void> {
    const sessions = await this.sessions.list(undefined, HISTORY_INDEX_LIMIT, true);
    this.historySessions = [...sessions]
      .sort((left, right) => (normalizeTimestamp(right.updatedAt) ?? 0) - (normalizeTimestamp(left.updatedAt) ?? 0));
    const projects = new Map<string, HistoryProject>();
    for (const session of this.historySessions) {
      const cwd = session.cwd?.trim();
      if (!cwd) continue;
      const updatedAt = normalizeTimestamp(session.updatedAt) ?? 0;
      const current = projects.get(cwd);
      if (current) {
        current.sessionCount += 1;
        current.lastUpdatedAt = Math.max(current.lastUpdatedAt, updatedAt);
      } else {
        projects.set(cwd, {
          cwd,
          name: sessionProjectName(session) || pathName(cwd),
          lastUpdatedAt: updatedAt,
          sessionCount: 1,
        });
      }
    }
    this.historyProjects = [...projects.values()]
      .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt);
  }

  private historyContext(): string {
    const projects = this.historyProjects.slice(0, 100).map((project) => ({
      project: project.name,
      cwd: project.cwd,
      session_count: project.sessionCount,
      last_updated_at: formatTimestamp(project.lastUpdatedAt),
    }));
    const sessions = this.historySessions.slice(0, HISTORY_CONTEXT_SESSION_LIMIT).map((session) => ({
      thread_id: session.id,
      project: sessionProjectName(session) ?? null,
      cwd: session.cwd ?? null,
      name: session.name ?? null,
      preview: session.preview ?? null,
      updated_at: formatTimestamp(session.updatedAt),
    }));
    return [
      `历史项目索引（来自 Codex App Server 历史会话 cwd，共 ${this.historyProjects.length} 个）：`,
      JSON.stringify(projects),
      `最近 ${sessions.length} 个历史会话：`,
      JSON.stringify(sessions),
    ].join('\n');
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
      await this.showDefaultSessionList(userId);
      return;
    }

    const current = this.store.getBinding(userId);
    const currentContext = current
      ? `当前绑定：thread_id=${current.threadId}\ncwd=${current.cwd}`
      : '当前没有绑定的 Codex 会话。';
    const feedback = control.executionFeedback ? `\n上一次 wecode 系统执行结果：${control.executionFeedback}` : '';
    const pendingTakeover = control.pendingTakeover
      ? `\n待确认安全接管：thread_id=${control.pendingTakeover.threadId}\ncwd=${control.pendingTakeover.cwd}\n只有用户明确回复“确认接管”时，系统才会安全接管该目标。`
      : '';

    this.startTyping(userId);
    try {
      if (control.pendingTakeover && isTakeoverConfirmation(text)) {
        const pending = control.pendingTakeover;
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '已确认，正在安全接管……');
        await this.useSession(userId, pending.threadId, {}, pending.cwd, true);
        this.store.clearControl(userId);
        return;
      }
      await this.refreshHistoryIndex().catch((error) => {
        process.stderr.write(`[history] 会话管理前刷新历史项目索引失败：${errorMessage(error)}\n`);
      });
      const prompt = `${text.trim()}\n\n[wecode 系统上下文]\n${currentContext}\n默认搜索根目录：${this.config.searchRoots.join('、')}\n${feedback}${pendingTakeover}\n${this.historyContext()}`;
      const result = await this.controlAgent.run(userId, prompt, control.sessionId);
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
          source: 'control',
        });
        return;
      }

      this.store.setControl(userId, nextControl);
      await this.executeAction(userId, result.action);
      if (result.action.action === 'new_session') {
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
      await this.stopTyping(userId);
    }
  }

  private async executeAction(userId: string, action: ActionResponse): Promise<void> {
    switch (action.action) {
      case 'new_session': {
        if (!action.cwd) throw new Error('新建会话缺少项目目录');
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '正在创建会话……');
        const result = await this.sessions.create(userId, action.cwd);
        await this.reply(userId, this.sessionCreatedText(result.binding));
        await this.refreshHistoryIndex().catch((error) => {
          process.stderr.write(`[history] 新建会话后刷新历史项目索引失败：${errorMessage(error)}\n`);
        });
        return;
      }
      case 'list_sessions':
        if (action.cwd) {
          await this.listSessions(
            userId,
            action.limit ?? DEFAULT_SESSION_LIST_LIMIT,
            action.cwd,
            false,
            true,
          );
        } else {
          await this.showIndexedSessions(userId, action.limit ?? DEFAULT_SESSION_LIST_LIMIT);
        }
        return;
      case 'reply':
      case 'ask':
        await this.reply(userId, action.text || '会话管理操作已完成。', { source: 'control' });
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

  private async sendToTarget(userId: string, text: string, imagePaths: string[] = []): Promise<void> {
    const turn: PendingCodexTurn = { text, imagePaths };
    this.startTyping(userId);
    const status = await this.sessions.status(userId);
    const pending = this.queued.get(userId)?.length ?? 0;
    if (status.running && !this.draining.has(userId) && pending === 0) {
      try {
        const steered = await this.sessions.steer(userId, text, imagePaths);
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
      queue.push(turn);
      this.queued.set(userId, queue);
      await this.reply(userId, `已排队 ${queue.length} 条，任务完成后继续。`);
      if (!status.running && !this.draining.has(userId)) {
        void this.drainQueue(userId).catch((error) => {
          process.stderr.write(`[bridge] queued turn failed: ${errorMessage(error)}\n`);
        });
      }
      return;
    }
    const result = await this.sessions.send(userId, text, imagePaths);
    if (!result.accepted) {
      await this.handleControl(userId, text, 'no-session');
      return;
    }
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
      await this.stopTyping(userId);
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

    this.startTyping(userId);
    try {
      const result = await this.sessions.send(userId, next.text, next.imagePaths);
      if (!result.accepted) {
        this.queued.delete(userId);
        await this.handleControl(userId, next.text, 'no-session');
        return;
      }
    } catch (error) {
      await this.stopTyping(userId);
      if (error instanceof SessionOccupiedError) {
        const rest = this.queued.get(userId) ?? [];
        this.queued.set(userId, [next, ...rest]);
        await this.offerTakeover(userId, error);
        return;
      }
      if (isStaleSessionError(error)) {
        this.queued.delete(userId);
        await this.recoverStaleSession(userId, next.text);
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
    await this.stopTyping(userId);
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
    await this.stopTyping(userId);
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
    this.queued.delete(userId);
    if (!this.store.getBinding(userId)) return;
    const status = await this.sessions.status(userId);
    if (!status.running) return;
    await this.reply(userId, '正在停止任务……');
    await this.sessions.stop(userId);
    await this.stopTyping(userId);
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
      const windowsTakeoverFailed = process.platform === 'win32' && /Windows 外部 Codex 客户端持有目标锁/.test(error.message);
      const message = error.running
        ? '安全接管失败：外部客户端仍有活动任务，未能安全释放目标会话。'
        : '安全接管失败：任务已空闲，但未能释放持有目标锁的外部客户端。';
      const nextStep = windowsTakeoverFailed
        ? 'wecode 已尝试结束目标锁持有进程但仍未释放；请完全退出 Codex Desktop（包括托盘进程）后重试；'
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
      `${message}\n回复“确认接管”进行安全接管；确认后，若外部客户端仍持有该会话锁，wecode 会尝试结束准确的锁持有进程，这可能关闭本地 Codex Desktop 的会话进程。仍无法释放时会自动复制已保存历史创建新会话；否则回复“退出”。`,
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

  private sessionCreatedText(binding: SessionBinding): string {
    return `已新建会话\n目录：${binding.cwd}\n${SESSION_ACTIVE_HINT}`;
  }

  private switchedText(binding: SessionBinding, prefix = '已切换会话'): string {
    return `${prefix}\n目录：${binding.cwd}\n${SESSION_ACTIVE_HINT}`;
  }

  private forkedText(binding: SessionBinding): string {
    return `已分叉新会话\n原会话仍保留，当前已绑定新会话\n目录：${binding.cwd}\n${SESSION_ACTIVE_HINT}`;
  }

  private startTyping(userId: string): void {
    const contextToken = this.store.get().contextTokens[userId] ?? '';
    if (!contextToken) return;
    const existing = this.typingIndicators.get(userId);
    if (existing?.contextToken === contextToken) return;
    if (existing) void this.stopTyping(userId);

    const indicator: TypingIndicator = { contextToken, stopped: false };
    this.typingIndicators.set(userId, indicator);
    void this.pulseTyping(userId, indicator);
  }

  private async pulseTyping(userId: string, indicator: TypingIndicator): Promise<boolean> {
    if (indicator.stopped || this.typingIndicators.get(userId) !== indicator) return false;
    if (indicator.running) return indicator.running;

    const running = this.sendTypingStatus(userId, indicator.contextToken, 1);
    indicator.running = running;
    let ok = false;
    try {
      ok = await running;
    } finally {
      if (indicator.running === running) indicator.running = undefined;
    }
    if (!ok) {
      if (this.typingIndicators.get(userId) === indicator) this.typingIndicators.delete(userId);
      return false;
    }
    if (indicator.stopped || this.typingIndicators.get(userId) !== indicator) return false;
    if (!indicator.timer) {
      indicator.timer = setInterval(() => {
        void this.pulseTyping(userId, indicator);
      }, TYPING_KEEPALIVE_MS);
      indicator.timer.unref();
    }
    return true;
  }

  private async stopTyping(userId: string): Promise<void> {
    const indicator = this.typingIndicators.get(userId);
    if (!indicator) return;
    indicator.stopped = true;
    if (indicator.timer) {
      clearInterval(indicator.timer);
      indicator.timer = undefined;
    }
    if (this.typingIndicators.get(userId) === indicator) this.typingIndicators.delete(userId);
    if (indicator.running) await indicator.running.catch(() => false);
    await this.sendTypingStatus(userId, indicator.contextToken, 2);
  }

  private async sendTypingStatus(userId: string, contextToken: string, status: number): Promise<boolean> {
    try {
      return await this.ilink.sendTyping(userId, contextToken, status);
    } catch {
      return false;
    }
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
    const indicator = this.typingIndicators.get(userId);
    if (indicator) void this.pulseTyping(userId, indicator);
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
  const ordered = orderSessionsForDisplay(sessions);
  const groups: Array<{ name: string; rows: string[] }> = [];
  let index = 0;
  for (const thread of ordered) {
    const name = sessionGroupName(thread);
    let group = groups.at(-1);
    if (!group || group.name !== name) {
      group = { name, rows: [] };
      groups.push(group);
    }
    index += 1;
    group.rows.push(`${index}. ${sessionRowTitle(thread)} · ${formatShortTimestamp(thread.updatedAt)}`);
  }
  return `${groups.map((group) => `${group.name}\n${group.rows.join('\n')}`).join('\n\n')}\n\n回复序号选择`;
}

function orderSessionsForDisplay(sessions: ThreadSummary[]): ThreadSummary[] {
  const groups = new Map<string, ThreadSummary[]>();
  for (const session of sessions) {
    const name = sessionGroupName(session);
    const group = groups.get(name) ?? [];
    group.push(session);
    groups.set(name, group);
  }
  return [...groups.values()].flat();
}

function sessionGroupName(thread: ThreadSummary): string {
  return sessionProjectName(thread) || '其他会话';
}

function sessionRowTitle(thread: ThreadSummary): string {
  const project = sessionProjectName(thread);
  const name = cleanActivityText(thread.name);
  const preview = cleanActivityText(thread.preview);
  const value = name && name !== project ? name : preview || name || '未命名会话';
  return truncateActivityText(value, 72);
}

function formatShortTimestamp(timestamp?: number | string): string {
  const milliseconds = normalizeTimestamp(timestamp);
  if (milliseconds === undefined) return '时间未知';
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pathName(cwd: string): string {
  return cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || cwd;
}

function cleanActivityText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/gu, ' ').trim();
  return text || undefined;
}

function truncateActivityText(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function sessionProjectName(thread: ThreadSummary): string | undefined {
  const cwd = thread.cwd?.trim().replace(/[\\/]+$/u, '');
  const directory = cwd?.split(/[\\/]/u).at(-1);
  return cleanActivityText(directory);
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
  if (/Codex App Server (?:socket closed|connection (?:is )?closed)/i.test(message)) {
    return 'Codex App Server 连接已断开，自动重连未成功；请再发送一次切换，或执行 wecode restart。';
  }
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
  if (/Codex App Server (?:socket closed|connection (?:is )?closed)/i.test(message)) {
    return 'Codex App Server 连接已断开，自动重连未成功；请再发送一次切换，或执行 wecode restart。';
  }
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
