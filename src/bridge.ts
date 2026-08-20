import path from 'node:path';
import type { AppConfig } from './config.js';
import { FIRST_RUN_GUIDE, HELP_TEXT, MENU_TEXT, SESSION_ROUTING_HINT, parseBridgeCommand, type BridgeCommand } from './commands.js';
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
import { buildSessionList, formatModel, formatTimestamp } from './session-display.js';
import { SessionManager, SessionOccupiedError } from './sessions.js';
import { StateStore } from './state.js';

type ReplySource = 'bridge' | 'control' | 'codex' | 'guide';

export class BridgeApp {
  private readonly controlAgent: ControlAgent;
  private readonly pages: PagePublisher;
  private readonly sessions: SessionManager;
  private readonly queued = new Map<string, string[]>();
  private readonly draining = new Set<string>();
  private readonly handling = new Map<string, Promise<void>>();
  private readonly directHandling = new Map<string, Promise<void>>();
  private readonly onboardingInFlight = new Set<string>();

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
      if (command.kind === 'stop' || command.kind === 'cancel') {
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
      await this.sendFirstRunGuide(userId);
      if (message.attachments.length) await this.reply(userId, `收到附件（${message.attachments.length} 个），当前版本先处理文字消息。`);
      return;
    }

    const firstRunGuideShown = await this.sendFirstRunGuide(userId);

    const existingBinding = this.store.getBinding(userId);
    if (existingBinding) this.store.setBinding(userId, { ...existingBinding, lastActivityAt: Date.now() });

    const command = parseBridgeCommand(text);
    const expired = this.controlExpired(userId);
    if (expired) {
      this.store.clearControl(userId);
      this.store.clearSelection(userId);
      this.store.clearMenu(userId);
      await this.reply(userId, '控制模式已过期，当前 Codex 会话未改变。');
    }

    if (command?.kind === 'cancel') {
      await this.cancel(userId);
      return;
    }
    if (command?.kind === 'stop') {
      await this.stop(userId);
      return;
    }

    if (command?.kind === 'control') {
      await this.handleControl(userId, command.text, firstRunGuideShown);
      return;
    }

    if (command) {
      // Every non-control local command must remain usable when the control
      // Agent is unavailable or stuck.
      await this.handleCommand(userId, command);
      return;
    }

    const selectionIndex = parseSelectionIndex(text);
    if (!this.store.getControl(userId) && selectionIndex !== undefined && this.store.getMenu(userId)) {
      await this.handleMenuSelection(userId, selectionIndex);
      return;
    }

    const selection = this.store.getSelection(userId);
    if (!this.store.getControl(userId) && selection && selectionIndex !== undefined) {
      await this.selectSession(userId, selectionIndex);
      return;
    }

    if (this.store.getControl(userId)) {
      await this.handleControl(userId, text);
      return;
    }

    const binding = this.store.getBinding(userId);
    if (!binding) {
      await this.handleControl(userId, text, firstRunGuideShown);
      return;
    }
    await this.sendToTarget(userId, text);
  }

  private async handleCommand(userId: string, command: BridgeCommand): Promise<void> {
    if (command.kind !== 'menu') this.store.clearMenu(userId);
    switch (command.kind) {
      case 'menu':
        await this.abandonControl(userId);
        this.store.clearSelection(userId);
        this.store.setMenu(userId, { createdAt: Date.now(), expiresAt: Date.now() + this.config.selectionTimeoutMs });
        await this.reply(userId, MENU_TEXT);
        return;
      case 'help':
        await this.reply(userId, HELP_TEXT);
        return;
      case 'new': {
        await this.abandonControl(userId);
        await this.stopBeforeSwitch(userId);
        const result = await this.sessions.create(userId, command.cwd, launchOptions(command));
        await this.reply(userId, this.sessionCreatedText(result.binding));
        return;
      }
      case 'use': {
        if (!command.threadId) {
          await this.sendSessions(userId, 'recent');
          return;
        }
        const index = parseSelectionIndex(command.threadId);
        if (index !== undefined) {
          await this.selectSession(userId, index);
          return;
        }
        await this.abandonControl(userId);
        await this.stopBeforeSwitch(userId);
        await this.useSession(userId, command.threadId, launchOptions(command));
        return;
      }
      case 'sessions':
        await this.sendSessions(userId, command.scope);
        return;
      case 'status':
        await this.sendStatus(userId);
        return;
      case 'back': {
        const previous = this.store.getBindingHistory(userId)[0];
        if (!previous) {
          await this.reply(userId, '没有可返回的上一个 Codex 会话。');
          return;
        }
        await this.abandonControl(userId);
        await this.stopBeforeSwitch(userId);
        await this.useSession(userId, previous.threadId, launchOptions(previous), previous.cwd);
        return;
      }
      case 'control':
      case 'cancel':
      case 'stop':
        return;
    }
  }

  private async handleMenuSelection(userId: string, index: number): Promise<void> {
    const menu = this.store.getMenu(userId);
    if (!menu || menu.expiresAt <= Date.now()) {
      this.store.clearMenu(userId);
      await this.reply(userId, '菜单已过期，请重新发送“菜单”。');
      return;
    }

    switch (index) {
      case 1:
        await this.handleCommand(userId, { kind: 'new' });
        return;
      case 2:
        await this.sendSessions(userId, 'recent');
        return;
      case 3:
        await this.sendSessions(userId, 'all');
        return;
      case 4:
        await this.handleCommand(userId, { kind: 'status' });
        return;
      case 5:
        await this.handleCommand(userId, { kind: 'back' });
        return;
      case 6:
        await this.stop(userId);
        return;
      case 7:
        await this.cancel(userId);
        return;
      default:
        await this.reply(userId, '菜单里没有这个选项，请回复 1 到 7。');
    }
  }

  private async selectSession(userId: string, index: number): Promise<void> {
    const selection = this.store.getSelection(userId);
    if (!selection || selection.expiresAt <= Date.now()) {
      this.store.clearSelection(userId);
      await this.reply(userId, '会话序号已过期，请重新发送“会话”或“菜单”。');
      return;
    }
    const item = selection.items[index - 1];
    if (!item) {
      await this.reply(userId, `没有第 ${index} 个会话，请重新发送“会话”。`);
      return;
    }
    if (item.cli !== 'codex') throw new Error('当前版本还未接入 Claude Code 适配器');
    await this.abandonControl(userId);
    await this.stopBeforeSwitch(userId);
    await this.reply(userId, '正在通过 Codex App Server 恢复目标会话……');
    await this.useSession(userId, item.threadId, launchOptions(item), item.cwd);
  }

  private async sendSessions(
    userId: string,
    scope: 'recent' | 'here' | 'all' | 'full',
    requestedCwd?: string,
  ): Promise<void> {
    this.store.clearMenu(userId);
    const current = this.store.getBinding(userId);
    if (scope === 'here' && !requestedCwd && !current?.cwd && !this.config.defaultCwd) {
      await this.reply(userId, '当前没有项目目录，无法查看当前项目会话。');
      return;
    }
    const cwd = requestedCwd || (scope === 'here' ? current?.cwd || this.config.defaultCwd : undefined);
    let list = await this.sessions.list(cwd);
    if (scope === 'recent') {
      list = list.filter((thread) => thread.id === current?.threadId || this.isInSearchRoots(thread.cwd));
    }
    const display = buildSessionList(list, this.config, {
      current,
      notes: this.store.get().sessionNotes,
      fullIds: scope === 'full',
      limit: scope === 'all' || scope === 'full' ? Math.max(list.length, this.config.sessionListLimit) : this.config.sessionListLimit,
    });
    if (!display.items.length) {
      this.store.clearSelection(userId);
      await this.reply(userId, display.text);
      return;
    }
    this.store.setSelection(userId, {
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.selectionTimeoutMs,
      items: display.items,
    });
    await this.reply(userId, display.text);
  }

  private isInSearchRoots(cwd?: string): boolean {
    if (!cwd) return false;
    const resolved = path.resolve(cwd);
    return this.config.searchRoots.some((root) => {
      const base = path.resolve(root);
      return resolved === base || resolved.startsWith(`${base}${path.sep}`);
    });
  }

  private async handleControl(userId: string, text: string, skipControlIntro = false): Promise<void> {
    const control = await this.ensureControl(userId, !skipControlIntro);
    if (!text.trim()) {
      await this.reply(userId, '请描述要定位、切换、新建或恢复的会话。', { source: 'control' });
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
    const feedback = control.executionFeedback ? `\n上一次桥接层执行结果：${control.executionFeedback}` : '';
    const pendingTakeover = control.pendingTakeover
      ? `\n待确认安全接管：thread_id=${control.pendingTakeover.threadId}\ncwd=${control.pendingTakeover.cwd}\n目标状态=${control.pendingTakeover.running ? '有活动任务' : '未确认有活动任务'}\n只有用户明确回复“确认接管”“确定接管”或“继续接管”时，才允许对同一 thread_id 执行 takeover=true。安全接管只会通过 Codex App Server 请求中断活动 turn、等待会话空闲并恢复，不会终止外部 CLI、IDE 或桌面客户端。`
      : '';
    const prompt = `${text.trim()}\n\n[桥接层上下文]\n${context}\n默认搜索根目录：${this.config.searchRoots.join('、')}\n${feedback}${pendingTakeover}\n${catalog}`;

    await this.reply(userId, '正在理解会话操作……');
    try {
      if (control.pendingTakeover && isTakeoverConfirmation(text)) {
        const pending = control.pendingTakeover;
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '已确认，正在通过 Codex App Server 安全接管目标会话……');
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
      if (result.action.action === 'new_session' || result.action.action === 'switch_session') {
        this.store.clearControl(userId);
      }
    } catch (error) {
      process.stderr.write(`[control] ${errorMessage(error)}\n`);
      if (this.controlAgent.consumeInterrupted(userId)) return;
      const latest = this.store.getControl(userId);
      if (error instanceof SessionOccupiedError) {
        await this.offerTakeover(userId, error);
        return;
      }
      const feedbackText = controlErrorText(error);
      if (latest) this.store.setControl(userId, { ...latest, lastActivityAt: Date.now(), executionFeedback: feedbackText });
      await this.reply(userId, `${feedbackText}\n可以继续补充信息，或发送“取消”退出。`, { source: 'bridge' });
    }
  }

  private async executeAction(userId: string, action: ActionResponse, options: { allowTakeover?: boolean } = {}): Promise<void> {
    if (action.cli && action.cli !== 'codex') throw new Error('当前版本还未接入 Claude Code 适配器');
    switch (action.action) {
      case 'new_session': {
        if (!action.cwd) throw new Error('新建会话缺少项目目录');
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '正在创建目标 Codex 会话……');
        const result = await this.sessions.create(userId, action.cwd, launchOptions(action));
        await this.reply(userId, this.sessionCreatedText(result.binding));
        return;
      }
      case 'switch_session': {
        if (!action.thread_id) throw new Error('切换会话缺少 thread_id');
        if (action.takeover) {
          const pending = this.store.getControl(userId)?.pendingTakeover;
          if (!options.allowTakeover || !pending || pending.threadId !== action.thread_id) {
            throw new Error('安全接管必须先明确确认当前待接管的目标会话');
          }
        }
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '正在通过 Codex App Server 恢复目标会话……');
        await this.useSession(userId, action.thread_id, launchOptions(action), action.cwd, action.takeover === true);
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
        await this.reply(userId, stopped ? '已中断当前 Codex 任务。' : '当前没有运行中的 Codex 任务。');
        return;
      }
      case 'set_note': {
        const note = action.note || action.text;
        if (!note?.trim()) throw new Error('备注内容不能为空');
        const binding = await this.sessions.setNote(userId, note);
        await this.reply(userId, `已记录当前会话备注：${binding.note}`);
        return;
      }
      case 'reply':
      case 'ask':
        await this.reply(userId, action.text || '控制操作已完成。', {
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
    this.store.clearSelection(userId);
    await this.reply(userId, this.switchedText(result.binding));
  }

  private async sendToTarget(userId: string, text: string): Promise<void> {
    const status = await this.sessions.status(userId);
    const pending = this.queued.get(userId)?.length ?? 0;
    if (status.running && !this.draining.has(userId) && pending === 0) {
      try {
        const steered = await this.sessions.steer(userId, text);
        if (steered.accepted) {
          await this.reply(userId, '已追加到当前任务，Codex 会结合这条消息继续处理。');
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
      await this.reply(userId, `已收到，当前任务完成后自动继续（排队 ${queue.length} 条）。`);
      if (!status.running && !this.draining.has(userId)) {
        void this.drainQueue(userId).catch((error) => {
          process.stderr.write(`[bridge] queued turn failed: ${errorMessage(error)}\n`);
        });
      }
      return;
    }
    const result = await this.sessions.send(userId, text);
    if (!result.accepted) {
      await this.reply(userId, '当前没有绑定 Codex 会话。');
      return;
    }
    await this.reply(userId, '已通过 Codex App Server 发送给 Codex，正在执行……');
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
      if (result.status === 'interrupted') await this.reply(userId, 'Codex 任务已中断。');
      else if (result.status === 'failed') await this.reply(userId, `Codex 执行失败：${result.error || result.text || '未知错误'}`);
      else if (result.text.trim()) await this.reply(userId, result.text, {
        kind: result.kind,
        presentation: result.presentation,
        cwd: binding.cwd,
        source: 'codex',
      });
      else await this.reply(userId, 'Codex 已完成，但没有返回可展示的文本。');
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
        await this.reply(userId, '排队消息未发送：当前没有绑定 Codex 会话。');
        return;
      }
      const remaining = this.queued.get(userId)?.length ?? 0;
      await this.reply(userId, `已自动继续处理排队消息${remaining ? `（剩余 ${remaining} 条）` : ''}……`);
    } catch (error) {
      const rest = this.queued.get(userId) ?? [];
      this.queued.set(userId, [next, ...rest]);
      if (error instanceof SessionOccupiedError) {
        await this.offerTakeover(userId, error);
        return;
      }
      await this.reply(userId, `排队消息暂未发送：${userFacingError(error)}`);
    }
  }

  private async sendStatus(userId: string): Promise<void> {
    const status = await this.sessions.status(userId);
    const control = this.store.getControl(userId);
    const mode = control
      ? `控制模式：${this.controlAgent.isRunning(userId) ? '处理中' : '等待你的指令'}`
      : '桥接模式：目标 Codex';
    const queue = this.queued.get(userId)?.length ?? 0;
    if (!status.binding) {
      await this.reply(userId, `${mode}\n当前没有绑定 Codex 会话。`);
      return;
    }
    await this.reply(
      userId,
      `${mode}\n控制层：Codex App Server\n目录：${status.binding.cwd}\n模型：${formatModel(status.binding.model, status.binding.reasoningEffort, status.binding.fast ? 'fast' : null)}\n任务：${status.running ? '运行中' : '空闲'}\n队列：${queue}`,
    );
  }

  private async stop(userId: string): Promise<void> {
    this.store.clearMenu(userId);
    const hasControl = Boolean(this.store.getControl(userId));
    let controlStopped = false;
    if (hasControl) controlStopped = await this.controlAgent.interrupt(userId).catch(() => false);
    this.queued.delete(userId);
    const targetStopped = await this.sessions.stop(userId);
    if (controlStopped && targetStopped) {
      await this.reply(userId, '已中断控制 Agent，并通过 Codex App Server 中断当前 Codex 任务。');
    } else if (controlStopped) {
      await this.reply(userId, '已中断控制 Agent，当前 Codex 没有运行中的任务。');
    } else if (targetStopped) {
      await this.reply(userId, '已通过 Codex App Server 中断当前 Codex 任务。');
    } else if (hasControl) {
      await this.reply(userId, '控制 Agent 当前没有运行中的任务，Codex 也没有运行中的任务。');
    } else {
      await this.reply(userId, '当前没有运行中的 Codex 任务。');
    }
  }

  private async cancel(userId: string): Promise<void> {
    this.store.clearMenu(userId);
    this.queued.delete(userId);
    if (this.store.getControl(userId)) {
      await this.controlAgent.interrupt(userId).catch(() => false);
      this.leaveControl(userId);
      await this.reply(userId, '已退出控制模式，当前 Codex 会话未改变。');
      return;
    }
    const binding = this.store.getBinding(userId);
    if (!binding) {
      await this.reply(userId, '当前没有活动的控制流程或 Codex 绑定。');
      return;
    }
    await this.sessions.release(userId);
    this.store.pushBindingHistory(userId, binding, this.config.bindingHistoryLimit);
    this.store.clearBinding(userId);
    await this.reply(userId, '已停止当前任务并退出当前 Codex 绑定。原生 Codex thread 仍保留，可通过 /ctrl 查找并恢复。');
  }

  private async stopBeforeSwitch(userId: string): Promise<void> {
    const status = await this.sessions.status(userId);
    if (!status.running) return;
    await this.reply(userId, '正在停止当前任务……');
    this.queued.delete(userId);
    await this.sessions.stop(userId);
  }

  private async ensureControl(userId: string, announce = true): Promise<ControlState> {
    const current = this.store.getControl(userId);
    if (current) {
      const updated = { ...current, lastActivityAt: Date.now() };
      this.store.setControl(userId, updated);
      return updated;
    }
    const created = { startedAt: Date.now(), lastActivityAt: Date.now() };
    this.store.setControl(userId, created);
    if (announce) await this.reply(userId, '已进入控制模式。后续普通消息会继续交给 Control Agent；发送“取消”退出。');
    return created;
  }

  private async offerTakeover(userId: string, error: SessionOccupiedError): Promise<void> {
    const current = this.store.getControl(userId);
    const now = Date.now();
    if (error.takeoverAttempted) {
      const message = '安全接管未完成：App Server 已按流程请求中断，但目标会话仍被外部 Codex 客户端占用。wecode 未终止外部进程。';
      if (current) {
        const { pendingTakeover: _pendingTakeover, ...withoutPendingTakeover } = current;
        this.store.setControl(userId, {
          ...withoutPendingTakeover,
          lastActivityAt: now,
          executionFeedback: message,
        });
      }
      await this.reply(userId, `${message}\n请先在外部 CLI、IDE 或桌面客户端中结束该会话，再重试；控制模式仍保留，也可以发送 /cancel。`, { source: 'bridge' });
      return;
    }

    const pending: PendingTakeover = {
      threadId: error.threadId,
      cwd: error.cwd || this.config.defaultCwd,
      running: error.running,
    };
    const control = current ?? { startedAt: now, lastActivityAt: now };
    const message = `目标 Codex 会话正被其他 Codex 客户端占用。目标目录：${pending.cwd}`;
    this.store.setControl(userId, {
      ...control,
      lastActivityAt: now,
      executionFeedback: message,
      pendingTakeover: pending,
    });
    await this.reply(
      userId,
      `${message}\n\n可以进行一次安全接管：wecode 会通过 Codex App Server 读取状态、请求中断活动任务、等待空闲后恢复会话；不会杀掉外部 CLI、IDE 或桌面客户端。\n\n如确认接管此目标，请只回复“确认接管”；如果不是，请回复“/cancel”。`,
      { source: 'bridge' },
    );
  }

  private leaveControl(userId: string): void {
    this.store.clearControl(userId);
    this.store.clearSelection(userId);
    this.store.clearMenu(userId);
  }

  private async abandonControl(userId: string): Promise<void> {
    if (this.store.getControl(userId)) await this.controlAgent.interrupt(userId).catch(() => false);
    this.leaveControl(userId);
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
    return `已新建 Codex 会话\n目录：${binding.cwd}\n控制层：Codex App Server。\n${SESSION_ROUTING_HINT}`;
  }

  private switchedText(binding: SessionBinding, prefix = '已切换 Codex 会话'): string {
    return `${prefix}\n目录：${binding.cwd}\n控制层：Codex App Server。\n${SESSION_ROUTING_HINT}`;
  }

  private async sendFirstRunGuide(userId: string): Promise<boolean> {
    if (this.store.hasOnboardingShown(userId)) return false;
    if (this.store.getBinding(userId)) {
      this.store.markOnboardingShown(userId);
      return false;
    }
    if (this.onboardingInFlight.has(userId)) return false;
    this.onboardingInFlight.add(userId);
    try {
      const delivered = await this.reply(userId, FIRST_RUN_GUIDE, { source: 'guide' });
      if (!delivered) return false;
      this.store.markOnboardingShown(userId);
      return true;
    } catch (error) {
      process.stderr.write(`[bridge] first-run guide failed: ${errorMessage(error)}\n`);
      return false;
    } finally {
      this.onboardingInFlight.delete(userId);
    }
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
  if (source === 'guide') return `> **wecode 使用指南**\n\n${value}`;
  if (source === 'control') return `> **控制 Agent**\n\n${value}`;
  return value
    .split('\n')
    .map((line, index) => index === 0 ? `> **桥接层** · ${line}` : `> ${line}`)
    .join('\n');
}

function controlErrorText(error: unknown): string {
  const message = errorMessage(error);
  if (/interrupt|signal/i.test(message)) return '控制 Agent 已中断。';
  if (/no rollout found|thread not found/i.test(message)) return '控制会话暂时无法恢复，但控制模式仍保留。';
  if (/thread-store conflict|active writer|already in use|being used|occupied|locked|another client|其他 Codex 客户端|原生终端占用/i.test(message)) {
    return '目标 Codex 会话正被其他 Codex 客户端占用；可以先明确回复“确认接管”，让桥接层通过 App Server 安全请求中断并恢复，或先在外部客户端结束该会话。';
  }
  return `控制 Agent 暂时没有完成这次请求：${message.slice(0, 240)}`;
}

function userFacingError(error: unknown): string {
  const message = errorMessage(error);
  if (/thread-store conflict|active writer|already in use|being used|occupied|locked|another client|其他 Codex 客户端|原生终端占用/i.test(message)) {
    return '这个 Codex 会话正被其他 Codex 客户端占用；请通过控制模式明确回复“确认接管”，或先关闭外部 Codex CLI、IDE 或桌面客户端后再重试。';
  }
  if (/no rollout found|thread not found/i.test(message)) {
    return '当前绑定的 Codex 会话已失效，请发送 /ctrl 重新创建会话或查找原生会话。';
  }
  if (/项目目录不能为空|项目目录不存在|没有当前 Codex 会话|会话 ID|Claude Code/i.test(message)) return message;
  return '处理请求时遇到内部错误，请稍后重试；详细信息已记录在本地日志。';
}

function isTakeoverConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[\s\u3000“”"‘’'。.!！？?，,、]/g, '');
  return new Set(['确认接管', '确定接管', '继续接管', '同意接管', '确认', 'confirm', 'yes', 'y']).has(normalized);
}

function parseSelectionIndex(value: string): number | undefined {
  const normalized = value.trim().replace(/[\s\u3000]/g, '');
  const numeric = /^(?:第)?(\d+)(?:个)?$/.exec(normalized)?.[1];
  if (numeric) {
    const index = Number(numeric);
    return Number.isSafeInteger(index) && index > 0 ? index : undefined;
  }
  const chinese = /^(?:第)?([一二三四五六七八九十])(?:个)?$/.exec(normalized)?.[1];
  if (!chinese) return undefined;
  const index = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[chinese];
  return index;
}
