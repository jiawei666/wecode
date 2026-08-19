import path from 'node:path';
import type { AppConfig } from './config.js';
import { parseBridgeCommand, HELP_TEXT, type BridgeCommand } from './commands.js';
import { ControlAgent } from './control.js';
import type { InboundMessage, IlinkClient } from './ilink.js';
import type { ActionResponse, ControlState, PendingTakeover, PresentationMode, SessionBinding, SessionLaunchOptions, SessionSelectionItem, TurnResult } from './model.js';
import { renderResponse, PagePublisher } from './render.js';
import { buildSessionList, formatModel, formatTimestamp } from './session-display.js';
import { SessionManager, SessionOccupiedError } from './sessions.js';
import { StateStore } from './state.js';

type ReplySource = 'bridge' | 'control' | 'codex';

export class BridgeApp {
  private readonly controlAgent: ControlAgent;
  private readonly pages: PagePublisher;
  private readonly sessions: SessionManager;
  private readonly queued = new Map<string, string[]>();
  private readonly handling = new Map<string, Promise<void>>();

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
    const interruptCommand = /^\/(?:stop|cancel|q)(?:\s|$)/i.test(message.text.trim());
    if (interruptCommand) {
      await this.handleSafely(message);
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
      if (message.attachments.length) await this.reply(userId, `收到附件（${message.attachments.length} 个），当前版本先处理文字消息。`);
      return;
    }

    const existingBinding = this.store.getBinding(userId);
    if (existingBinding) this.store.setBinding(userId, { ...existingBinding, lastActivityAt: Date.now() });

    const command = parseBridgeCommand(text);
    const expired = this.controlExpired(userId);
    if (expired) {
      this.store.clearControl(userId);
      this.store.clearSelection(userId);
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

    const selection = this.store.getSelection(userId);
    if (!this.store.getControl(userId) && !command && /^\d+$/.test(text) && selection) {
      await this.selectSession(userId, Number(text));
      return;
    }
    if (!this.store.getControl(userId) && command?.kind === 'use' && command.threadId && /^\d+$/.test(command.threadId) && selection) {
      await this.selectSession(userId, Number(command.threadId));
      return;
    }

    if (command?.kind === 'control') {
      await this.handleControl(userId, command.text);
      return;
    }

    // Slash commands are explicit escape hatches. They remain usable while
    // the control Agent is waiting for an answer.
    if (command) {
      await this.handleCommand(userId, command);
      return;
    }

    if (this.store.getControl(userId)) {
      await this.handleControl(userId, text);
      return;
    }

    const binding = this.store.getBinding(userId);
    if (!binding) {
      await this.handleControl(userId, text);
      return;
    }
    await this.sendToTarget(userId, text);
  }

  private async handleCommand(userId: string, command: BridgeCommand): Promise<void> {
    switch (command.kind) {
      case 'help':
        await this.reply(userId, HELP_TEXT);
        return;
      case 'new': {
        if (!command.cwd && !this.store.getBinding(userId)) {
          await this.handleControl(userId, '请定位一个项目目录，然后新建 Codex 会话。');
          return;
        }
        this.leaveControl(userId);
        await this.stopBeforeSwitch(userId);
        const result = await this.sessions.create(userId, command.cwd, launchOptions(command));
        await this.reply(userId, this.sessionCreatedText(result.binding, result.warning));
        return;
      }
      case 'use': {
        if (!command.threadId) {
          await this.sendSessions(userId, 'recent');
          return;
        }
        this.leaveControl(userId);
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
        this.leaveControl(userId);
        await this.stopBeforeSwitch(userId);
        const result = await this.sessions.back(userId);
        if (!result) {
          await this.reply(userId, '没有可返回的上一个 Codex 会话。');
          return;
        }
        await this.reply(userId, this.switchedText(result.binding, result.warning, '已返回 Codex 会话'));
        return;
      }
      case 'raw':
        this.leaveControl(userId);
        try {
          await this.sessions.raw(userId, command.text);
          await this.reply(userId, '已原样发送到当前 tmux TUI。');
        } catch (error) {
          await this.reply(userId, `原始输入失败：${errorMessage(error)}`);
        }
        return;
      case 'control':
      case 'cancel':
      case 'stop':
        return;
    }
  }

  private async handleControl(userId: string, text: string): Promise<void> {
    const control = await this.ensureControl(userId);
    if (!text.trim()) {
      await this.reply(userId, '请描述要定位、切换、新建或恢复的会话。', { source: 'control' });
      return;
    }

    const current = this.store.getBinding(userId);
    const catalog = await this.controlCatalog().catch(() => '当前暂时无法读取原生会话列表，请自行扫描默认项目根目录。');
    const context = current
      ? `当前绑定：cli=${current.cli ?? 'codex'}\nthread_id=${current.threadId}\ncwd=${current.cwd}\n本地备注=${current.note || this.store.getSessionNote(current.threadId) || '无'}\n模型=${formatModel(current.model, current.reasoningEffort, current.fast ? 'fast' : null)}`
      : '当前没有绑定的 Codex 会话。';
    const feedback = control.executionFeedback ? `\n上一次桥接层执行结果：${control.executionFeedback}` : '';
    const pending = control.pendingTakeover
      ? `\n待确认接管：thread_id=${control.pendingTakeover.threadId} cwd=${control.pendingTakeover.cwd} 状态=${control.pendingTakeover.running ? '运行中' : '空闲'}。只有用户明确同意时，才返回同一 thread_id 且 takeover=true 的 switch_session。`
      : '';
    const prompt = `${text.trim()}\n\n[桥接层上下文]\n${context}\n默认搜索根目录：${this.config.searchRoots.join('、')}\n${feedback}${pending}\n${catalog}`;

    await this.reply(userId, '正在理解会话操作……');
    try {
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
      await this.executeAction(userId, result.action);
      if (result.action.action === 'new_session' || result.action.action === 'switch_session') {
        this.store.clearControl(userId);
      }
    } catch (error) {
      process.stderr.write(`[control] ${errorMessage(error)}\n`);
      if (this.controlAgent.consumeInterrupted(userId)) return;
      const latest = this.store.getControl(userId);
      if (error instanceof SessionOccupiedError) {
        const pendingTakeover: PendingTakeover = {
          threadId: error.threadId,
          cwd: error.cwd,
          running: error.running,
        };
        const message = occupiedText(error);
        if (latest) {
          this.store.setControl(userId, {
            ...latest,
            lastActivityAt: Date.now(),
            executionFeedback: message,
            pendingTakeover,
          });
        }
        await this.reply(userId, message, { source: 'bridge' });
        return;
      }
      const feedbackText = controlErrorText(error);
      if (latest) this.store.setControl(userId, { ...latest, lastActivityAt: Date.now(), executionFeedback: feedbackText });
      await this.reply(userId, `${feedbackText}\n可以继续补充信息或发送 /cancel。`, { source: 'bridge' });
    }
  }

  private async executeAction(userId: string, action: ActionResponse): Promise<void> {
    if (action.cli && action.cli !== 'codex') throw new Error('当前版本还未接入 Claude Code 适配器');
    switch (action.action) {
      case 'new_session': {
        if (!action.cwd) throw new Error('新建会话缺少项目目录');
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '正在创建目标 Codex 会话……');
        const result = await this.sessions.create(userId, action.cwd, launchOptions(action));
        await this.reply(userId, this.sessionCreatedText(result.binding, result.warning));
        return;
      }
      case 'switch_session': {
        if (!action.thread_id) throw new Error('切换会话缺少 thread_id');
        if (action.takeover) {
          const pending = this.store.getControl(userId)?.pendingTakeover;
          if (!pending || pending.threadId !== action.thread_id) throw new Error('接管确认目标已变化，请重新查找并选择会话');
        }
        await this.stopBeforeSwitch(userId);
        await this.reply(userId, '正在恢复目标 tmux……');
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
      case 'raw_input':
        if (!action.text) throw new Error('raw_input 缺少 text');
        await this.sessions.raw(userId, action.text);
        await this.reply(userId, '已原样发送到当前 tmux TUI。');
        return;
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
    await this.reply(userId, this.switchedText(result.binding, result.warning));
  }

  private async selectSession(userId: string, index: number): Promise<void> {
    const selection = this.store.getSelection(userId);
    if (!selection || selection.expiresAt <= Date.now()) {
      this.store.clearSelection(userId);
      await this.reply(userId, '会话序号已过期，请重新发送 /sessions。');
      return;
    }
    const item = selection.items[index - 1];
    if (!item) {
      await this.reply(userId, `没有第 ${index} 个会话，请重新发送 /sessions。`);
      return;
    }
    if (item.cli !== 'codex') throw new Error('当前版本还未接入 Claude Code 适配器');
    await this.stopBeforeSwitch(userId);
    await this.reply(userId, '正在恢复目标 tmux……');
    const result = await this.sessions.use(userId, item.threadId, item.cwd, item);
    this.store.clearSelection(userId);
    await this.reply(userId, this.switchedText(result.binding, result.warning));
  }

  private async sendToTarget(userId: string, text: string): Promise<void> {
    const status = await this.sessions.status(userId);
    if (status.running) {
      const queue = this.queued.get(userId) ?? [];
      queue.push(text);
      this.queued.set(userId, queue);
      await this.reply(userId, `当前任务仍在执行，已排队（${queue.length} 条）。`);
      return;
    }
    const result = await this.sessions.send(userId, text);
    if (!result.accepted) {
      await this.reply(userId, result.warning || '发送失败。');
      return;
    }
    await this.reply(userId, result.warning ? `已发送给 Codex。\n⚠️ ${result.warning}` : '已发送给 Codex，正在执行……');
  }

  async onTurn(result: TurnResult): Promise<void> {
    const entry = Object.entries(this.store.get().bindings).find(([, binding]) => binding.threadId === result.threadId);
    if (!entry) return;
    const [userId, binding] = entry;
    if (result.status === 'interrupted') await this.reply(userId, 'Codex 任务已中断。');
    else if (result.status === 'failed') await this.reply(userId, `Codex 执行失败：${result.error || result.text || '未知错误'}`);
    else if (result.text.trim()) await this.reply(userId, result.text, {
      kind: result.kind,
      presentation: result.presentation,
      cwd: binding.cwd,
      source: 'codex',
    });
    else await this.reply(userId, 'Codex 已完成，但没有返回可展示的文本。');
    await this.drainQueue(userId);
  }

  private async drainQueue(userId: string): Promise<void> {
    const queue = this.queued.get(userId);
    if (!queue?.length) return;
    const next = queue.shift();
    if (!queue.length) this.queued.delete(userId);
    if (next) await this.sendToTarget(userId, next);
  }

  private async sendSessions(
    userId: string,
    scope: 'recent' | 'here' | 'all' | 'full',
    _fromControl = false,
    requestedCwd?: string,
  ): Promise<void> {
    const current = this.store.getBinding(userId);
    if (scope === 'here' && !requestedCwd && !current?.cwd) {
      await this.reply(userId, '当前没有项目目录，无法使用 /sessions here。');
      return;
    }
    const cwd = requestedCwd || (scope === 'here' ? current?.cwd : undefined);
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
      await this.reply(userId, '没有找到 Codex 原生会话。');
      return;
    }
    this.store.setSelection(userId, {
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.selectionTimeoutMs,
      items: display.items,
    });
    await this.reply(userId, display.text);
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
      `${mode}\n目录：${status.binding.cwd}\n模型：${formatModel(status.binding.model, status.binding.reasoningEffort, status.binding.fast ? 'fast' : null)}\n任务：${status.running ? '运行中' : '空闲'}\ntmux：${status.tmuxExists ? '存在' : '已回收'}${status.attachedClients ? `（本地连接 ${status.attachedClients}）` : ''}\n队列：${queue}`,
    );
  }

  private async stop(userId: string): Promise<void> {
    if (this.store.getControl(userId)) {
      if (await this.controlAgent.interrupt(userId)) {
        await this.reply(userId, '已发送中断，控制模式仍保留。');
      } else {
        await this.reply(userId, '当前正在等待你的回复，没有运行中的控制任务；当前 Codex 会话未中断。');
      }
      return;
    }
    this.queued.delete(userId);
    const stopped = await this.sessions.stop(userId);
    await this.reply(userId, stopped ? '已发送 Ctrl-C，中断当前 Codex 任务。' : '当前没有运行中的 Codex 任务。');
  }

  private async cancel(userId: string): Promise<void> {
    if (this.store.getControl(userId)) {
      await this.controlAgent.interrupt(userId);
      this.leaveControl(userId);
      await this.reply(userId, '已退出控制模式，当前 Codex 会话未改变。');
      return;
    }
    const binding = this.store.getBinding(userId);
    if (!binding) {
      await this.reply(userId, '当前没有活动的控制流程或 Codex 绑定。');
      return;
    }
    this.queued.delete(userId);
    await this.sessions.release(userId);
    this.store.pushBindingHistory(userId, binding, this.config.bindingHistoryLimit);
    this.store.clearBinding(userId);
    this.store.clearSelection(userId);
    await this.reply(userId, '已停止当前任务并退出当前 Codex 绑定。bridge tmux 已释放，原生会话仍保留，可用 /sessions 查找恢复。');
  }

  private async stopBeforeSwitch(userId: string): Promise<void> {
    const status = await this.sessions.status(userId);
    if (!status.running) return;
    await this.reply(userId, '正在停止当前任务……');
    this.queued.delete(userId);
    await this.sessions.stop(userId);
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
    await this.reply(userId, '已进入控制模式。后续普通消息会继续交给控制 Agent；发送 /cancel 退出。');
    return created;
  }

  private leaveControl(userId: string): void {
    this.store.clearControl(userId);
    this.store.clearSelection(userId);
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

  private isInSearchRoots(cwd?: string): boolean {
    if (!cwd) return false;
    const resolved = path.resolve(cwd);
    return this.config.searchRoots.some((root) => {
      const base = path.resolve(root);
      return resolved === base || resolved.startsWith(`${base}${path.sep}`);
    });
  }

  private sessionCreatedText(binding: SessionBinding, warning?: string): string {
    return `已新建 Codex 会话\n目录：${binding.cwd}\n首条消息发送后启动 tmux TUI。${warning ? `\n⚠️ tmux 未能启动：${warning}` : ''}`;
  }

  private switchedText(binding: SessionBinding, warning?: string, prefix = '已切换 Codex 会话'): string {
    return `${prefix}\n目录：${binding.cwd}${warning ? `\n⚠️ ${warning}` : ''}`;
  }

  private async reply(
    userId: string,
    text: string,
    options: { title?: string; presentation?: PresentationMode; kind?: TurnResult['kind']; cwd?: string; source?: ReplySource } = {},
  ): Promise<void> {
    const contextToken = this.store.get().contextTokens[userId] ?? '';
    if (!contextToken) return;
    const { source = 'bridge', ...renderOptions } = options;
    const rendered = await renderResponse({ text: decorateReply(text, source), ...renderOptions }, this.pages);
    const payload = rendered.mode === 'page' ? rendered.fallback : rendered.text;
    const result = await this.ilink.sendText(userId, payload, contextToken, this.config.chatChunkSize);
    if (!result.ok) process.stderr.write(`[wechat] send failed: ${result.errmsg || result.raw || 'unknown'}\n`);
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
  if (source === 'control') return `> **控制 Agent**\n\n${value}`;
  return value
    .split('\n')
    .map((line, index) => index === 0 ? `> **桥接层** · ${line}` : `> ${line}`)
    .join('\n');
}

function occupiedText(error: SessionOccupiedError): string {
  if (error.running) {
    return '目标会话正在执行任务，同时被原生终端占用；如果继续接管，将先中断当前任务、停止原生终端，再用 tmux 启动。是否继续？';
  }
  return '目标会话当前处于空闲状态，但仍被原生终端占用；如果继续接管，将停止原生终端，再用 tmux 启动。是否继续？';
}

function controlErrorText(error: unknown): string {
  const message = errorMessage(error);
  if (/interrupt|signal/i.test(message)) return '控制 Agent 已中断。';
  if (/no rollout found|thread not found/i.test(message)) return '控制会话暂时无法恢复，但控制模式仍保留。';
  if (/未找到可安全停止/.test(message)) return '没有找到可安全停止的原生终端；请先在原生终端退出该会话后再重试，控制模式仍保留。';
  if (/原生终端未能释放/.test(message)) return '原生终端没有成功释放；请先手动关闭该终端后再重试，控制模式仍保留。';
  return `控制 Agent 暂时没有完成这次请求：${message.slice(0, 240)}`;
}

function userFacingError(error: unknown): string {
  const message = errorMessage(error);
  if (/thread-store conflict|active writer|原生终端占用|未找到可安全停止|原生终端未能释放/i.test(message)) {
    if (/未找到可安全停止/.test(message)) return '没有找到可安全停止的原生终端，请先在原生终端退出该会话后再重试。';
    if (/原生终端未能释放/.test(message)) return '原生终端没有成功释放，请先手动关闭该终端后再重试。';
    return '这个 Codex 会话正被另一个原生终端占用，桥接层暂时不能接管；请先结束那个终端中的会话，或改用通过 tmux-codex 启动的会话。';
  }
  if (/no rollout found|thread not found/i.test(message)) {
    return '当前绑定的 Codex 会话已失效，请发送 /new 重新创建会话，或发送 /sessions 查找原生会话。';
  }
  if (/项目目录不能为空|项目目录不存在|没有当前 Codex 会话|raw input is empty|会话 ID|Claude Code/i.test(message)) return message;
  return '处理请求时遇到内部错误，请稍后重试；详细信息已记录在本地日志。';
}
