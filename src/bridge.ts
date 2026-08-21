import type { AppConfig } from './config.js';
import { HELP_TEXT, SESSION_ACTIVE_HINT, WELCOME_TEXT, parseBridgeCommand } from './commands.js';
import { ControlAgent } from './control.js';
import type { InboundMessage, IlinkClient } from './ilink.js';
import type {
  ActionResponse,
  ControlState,
  PendingTakeover,
  PresentationMode,
  SessionBinding,
  SessionLaunchOptions,
  TurnResult,
} from './model.js';
import { renderResponse, PagePublisher } from './render.js';
import { formatModel, formatTimestamp } from './session-display.js';
import { SessionManager, SessionOccupiedError } from './sessions.js';
import { StateStore } from './state.js';

type ReplySource = 'bridge' | 'control' | 'codex';

export class BridgeApp {
  private readonly controlAgent: ControlAgent;
  private readonly pages: PagePublisher;
  private readonly sessions: SessionManager;
  private readonly queued = new Map<string, string[]>();
  private readonly draining = new Set<string>();
  private readonly handling = new Map<string, Promise<void>>();
  private readonly directHandling = new Map<string, Promise<void>>();

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
  }

  async close(): Promise<void> {
    await this.controlAgent.close();
    await this.pages.close();
    await this.sessions.close();
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
    }
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

    if (command?.kind === 'help') {
      await this.reply(userId, HELP_TEXT);
      return;
    }
    if (command?.kind === 'status') {
      await this.sendStatus(userId);
      return;
    }
    if (command?.kind === 'control') {
      await this.handleControl(userId, command.text);
      return;
    }

    if (this.store.getControl(userId)) {
      await this.handleControl(userId, text);
      return;
    }

    const binding = this.store.getBinding(userId);
    if (!binding) {
      await this.handleControl(userId, text, 'no-session');
      return;
    }
    await this.sendToTarget(userId, text);
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
      await this.reply(userId, '请描述要查找、新建或切换的会话。', { source: 'control' });
      return;
    }

    const current = this.store.getBinding(userId);
    const catalog = await this.controlCatalog().catch(() => '当前暂时无法读取原生会话列表，请自行扫描默认项目根目录。');
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
    const prompt = `${text.trim()}\n\n[wecode 系统上下文]\n${context}\n默认搜索根目录：${this.config.searchRoots.join('、')}\n${feedback}${pendingTakeover}\n${catalog}`;

    await this.reply(userId, '处理中……');
    try {
      if (control.pendingTakeover && isTakeoverConfirmation(text)) {
        const pending = control.pendingTakeover;
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '已确认，正在安全接管……');
        await this.useSession(userId, pending.threadId, {}, pending.cwd, true);
        this.store.clearControl(userId);
        return;
      }
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
    }
  }

  private async executeAction(userId: string, action: ActionResponse, options: { allowTakeover?: boolean } = {}): Promise<void> {
    if (action.cli && action.cli !== 'codex') throw new Error('当前版本还未接入 Claude Code 适配器');
    switch (action.action) {
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
            // The control model can occasionally return takeover=true before
            // the application has established a pending confirmation. Never
            // honor that model output; fall back to an ordinary resume so an
            // occupied target creates the proper confirmation flow.
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
      if (result.status === 'interrupted') await this.reply(userId, '任务已中断。');
      else if (result.status === 'failed') await this.reply(userId, `Codex 执行失败：${result.error || result.text || '未知错误'}`);
      else if (result.text.trim()) await this.reply(userId, result.text, {
        kind: result.kind,
        presentation: result.presentation,
        cwd: binding.cwd,
        source: 'codex',
      });
      else await this.reply(userId, '已完成，无可展示内容。');
      await this.flushQueuedTurn(userId);
    } finally {
      this.draining.delete(userId);
    }
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
    options: { title?: string; presentation?: PresentationMode; kind?: TurnResult['kind']; cwd?: string; source?: ReplySource } = {},
  ): Promise<boolean> {
    const contextToken = this.store.get().contextTokens[userId] ?? '';
    if (!contextToken) return false;
    const { source = 'bridge', ...renderOptions } = options;
    const rendered = await renderResponse({ text: decorateReply(text, source), ...renderOptions }, this.pages);
    const payload = rendered.mode === 'page' ? rendered.fallback : rendered.text;
    const result = await this.ilink.sendText(userId, payload, contextToken, this.config.chatChunkSize);
    if (!result.ok) {
      process.stderr.write(`[wechat] send failed: ${result.errmsg || result.raw || 'unknown'}\n`);
      return false;
    }
    return true;
  }
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

function controlErrorText(error: unknown): string {
  const message = errorMessage(error);
  if (/interrupt|signal/i.test(message)) return '会话管理 Agent 已中断。';
  if (/no rollout found|thread not found/i.test(message)) return '会话管理 Agent 会话无法恢复；当前流程仍保留。';
  if (/thread-store conflict|active writer|already in use|being used|occupied|locked|another client|其他 Codex 客户端|原生终端占用/i.test(message)) {
    return '目标会话被占用；回复“确认接管”安全恢复，或先结束外部任务。';
  }
  return `会话管理 Agent 暂时没有完成这次请求：${message.slice(0, 240)}`;
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

function isStaleSessionError(error: unknown): boolean {
  return /no rollout found|thread not found/i.test(errorMessage(error));
}

function isTakeoverConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[\s\u3000“”"‘’'。.!！？?，,、]/g, '');
  return new Set(['确认接管', '确定接管', '继续接管', '同意接管', '确认', 'confirm', 'yes', 'y']).has(normalized);
}
