import { readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { AppConfig } from './config.js';
import type { ActionResponse } from './model.js';

export interface ControlResult {
  action: ActionResponse;
  sessionId?: string;
}

function controlInstructions(homeDir: string, searchRoots: string[]): string {
  return `你是 wecode 的会话管理 Agent，负责通过自然语言帮助用户查找、列出、新建、切换和管理 Codex 会话。

你是持续多轮对话 Agent，不是一次性命令解析器。必须结合之前的会话管理对话、当前绑定、待确认操作和 wecode 系统提供的原始会话 catalog 理解“刚才那个”“第 2 个”“就在这里新建”“换到另一个 core”等指代。

你可以扫描 ${homeDir} 及其子目录，优先检查这些项目搜索根目录：${searchRoots.join('、')}。用户可能只输入不完整、大小写不同或带有短横线/下划线差异的目录片段，例如 core、agency、cloud-core；必须先用 shell/find/realpath 等实际检查目录是否存在，再决定 cwd，不要要求用户记完整路径，也不要凭印象编造 cwd。跳过 node_modules、.git、dist、build、target、.cache 等依赖和构建目录。

你只负责会话管理意图和对话，不直接替用户开发项目。实际副作用由 wecode 系统执行。你返回 new_session 或 switch_session 只表示“请求执行”，不能在 text 中宣称已经绑定；只有 wecode 系统执行成功后才会完成绑定并退出会话管理流程。

只输出一个 JSON 对象，不要在 JSON 外输出 Markdown、解释或思维过程。所有 schema 字段都必须输出；不适用的字段填 null。

可用 action：
- new_session：用户明确要新建会话时使用，需要已验证的 cwd；可选 model/reasoning_effort/fast
- switch_session：用户明确要切换已有会话时使用，需要 catalog 中真实存在的 thread_id；可选 cwd/model/reasoning_effort/fast。只有 wecode 系统已经记录待确认目标，且用户明确回复“确认接管”后，才允许 takeover=true
- list_sessions：列出历史会话，需要已验证的 cwd、limit 和面向用户的 Markdown text
- status：查看当前绑定和运行状态
- interrupt：中断当前 Codex 任务
- set_note：为当前会话设置本地备注，text 为备注内容
- ask：信息不足、目录有多个候选或需要用户确认时使用，需要 text
- reply：仅作解释性回复，不代表绑定完成；需要 text

目录和会话规则：
1. 用户只说 core 之类片段时，先扫描并验证真实目录；唯一候选才继续，多个候选必须 ask 并列出完整路径，找不到就说明搜索范围并继续追问。
2. 找到目标目录后，历史会话只匹配 cwd 等于该目录本身，不包含子目录。
3. 用户说“最近 5 个”或“返回 5 个”时 limit=5；未指定数量时默认 limit=5；明确数量时使用明确数量。
4. list_sessions 的 text 会被 wecode 系统原样发送给用户。必须由你自己完成筛选、按最新更新时间排序和数量截取，格式使用 Markdown：每条只展示序号、cwd 的最后一级完整目录名、摘要和本地绝对时间（YYYY-MM-DD HH:mm）；不要展示模型、normal、service tier、完整路径或 thread_id。摘要优先使用本地备注、原生名称、preview，没有时写“未命名会话”。
5. 你可以在内部使用 catalog 中的真实 thread_id，但绝不把 ID 展示给用户。用户后续说“第 2 个”“刚才那个”“最上面那个”时，必须根据你上一轮生成的列表和原始 catalog 映射到准确 thread_id，不能重新猜顺序。
6. 用户在刚刚确认过唯一目录后说“新建一个”，直接复用该目录；没有已确认目录或仍有歧义时 ask，不要猜。
7. 如果上下文提供了“上一个绑定”，用户说“返回上一个”时直接返回 switch_session，不要重新猜目录或会话。
8. list_sessions、status、ask、reply、interrupt、set_note 都不代表绑定完成，会话管理对话继续；只有 new_session 或 switch_session 成功执行后 wecode 系统才会退出会话管理流程。
9. 如果目标 Codex 会话被其他 Codex 客户端占用，wecode 系统会先向用户提供一次安全接管确认；在用户明确回复“确认接管”前，不得输出 takeover=true，也不要反复重试。用户已经明确要求切换时，即使 catalog 显示 active，也先返回普通 switch_session，让 wecode 系统判断并发起确认，不要仅凭 catalog 状态拒绝。确认后安全接管会先通过 App Server 中断活动 turn、等待空闲；若外部客户端仍持有该 thread 锁，wecode 系统只会向精确匹配的外部 Codex 进程发出退出信号，不删除锁文件，也不触碰其他进程。
10. 如果 wecode 系统反馈上一次 action 执行失败，要基于失败原因继续和用户对话，不要假装成功。

如果用户只是想在已绑定目标会话中做项目开发，说明当前会话管理流程需要先完成或退出，不要用 reply 假装已经执行开发任务。`;
}

export class ControlAgent {
  private readonly active = new Map<string, ChildProcess>();
  private readonly interrupted = new Set<string>();

  constructor(private readonly config: AppConfig) {}

  async run(userId: string, userText: string, previousSessionId?: string): Promise<ControlResult> {
    const prompt = `${controlInstructions(this.config.homeDir, this.config.searchRoots)}\n\n当前用户会话管理请求：\n${userText.trim()}`;
    try {
      return await this.runOnce(userId, prompt, previousSessionId);
    } catch (error) {
      // Some old exec sessions contain a thread.started event without a
      // persisted rollout. Recreate only the control conversation and let the
      // bridge continue with the current request instead of losing the mode.
      if (!previousSessionId || !/no rollout found|thread not found/i.test(errorMessage(error))) throw error;
      return this.runOnce(userId, `${prompt}\n\n会话管理 Agent 会话恢复失败，请基于当前上下文继续。`, undefined);
    }
  }

  async interrupt(userId: string): Promise<boolean> {
    const child = this.active.get(userId);
    if (!child || child.killed) return false;
    this.interrupted.add(userId);
    child.kill('SIGINT');
    return true;
  }

  consumeInterrupted(userId: string): boolean {
    const interrupted = this.interrupted.has(userId);
    this.interrupted.delete(userId);
    return interrupted;
  }

  isRunning(userId: string): boolean {
    const child = this.active.get(userId);
    return Boolean(child && !child.killed);
  }

  async close(): Promise<void> {
    for (const child of this.active.values()) child.kill('SIGTERM');
    this.active.clear();
    this.interrupted.clear();
  }

  private async runOnce(userId: string, prompt: string, previousSessionId?: string): Promise<ControlResult> {
    const outputPath = path.join(this.config.dataDir, `control-${process.pid}-${randomBytes(6).toString('hex')}.json`);
    const schemaPath = path.resolve(process.cwd(), 'schemas', 'control-action.json');
    const commonArgs = [
      '--json',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputPath,
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-c',
      'service_tier=null',
      '-C',
      this.config.homeDir,
    ];
    if (this.config.controlModel) commonArgs.push('-m', this.config.controlModel);
    if (this.config.controlReasoningEffort) commonArgs.push('-c', `model_reasoning_effort="${this.config.controlReasoningEffort}"`);
    const args = previousSessionId
      ? ['exec', ...commonArgs, 'resume', previousSessionId, '-']
      : ['exec', ...commonArgs, '-'];
    const result = await runProcess(this.config.codexCommand, args, prompt, this.config.controlTimeoutMs, userId, this.active);
    let finalText = '';
    try {
      finalText = await readFile(outputPath, 'utf8');
    } catch {
      finalText = extractFinalText(result.stdout);
    } finally {
      await rm(outputPath, { force: true }).catch(() => undefined);
    }
    const action = parseAction(finalText);
    if (!action) {
      throw new Error(`会话管理 Agent 未返回有效 action JSON：${finalText.slice(0, 500) || result.stderr.slice(0, 500)}`);
    }
    return { action, ...(result.sessionId ? { sessionId: result.sessionId } : {}) };
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  sessionId?: string;
}

function runProcess(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
  userId: string,
  active: Map<string, ChildProcess>,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: { ...process.env }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      active.delete(userId);
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new Error(`会话管理 Agent 超时（${Math.round(timeoutMs / 1000)} 秒）`)));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = cap(stdout + String(chunk), 2_000_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = cap(stderr + String(chunk), 200_000);
    });
    active.set(userId, child);
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => {
      finish(() => {
        if (code !== 0) {
          const detail = (stderr.trim() || stdout.trim()).slice(-2000);
          reject(new Error(detail ? `会话管理 Agent exit ${code ?? 'signal'}: ${detail}` : `会话管理 Agent exit ${code ?? 'signal'}`));
        }
        else resolve({ stdout, stderr, sessionId: findSessionId(stdout) });
      });
    });
    child.stdin.end(input);
  });
}

function findSessionId(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
      if (typeof event.thread_id === 'string') return event.thread_id;
      const thread = event.thread;
      if (thread && typeof thread === 'object' && typeof (thread as { id?: unknown }).id === 'string') {
        return (thread as { id: string }).id;
      }
    } catch {
      // JSONL may contain diagnostics; continue to the next event.
    }
  }
  return undefined;
}

function extractFinalText(stdout: string): string {
  let last = '';
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event.item;
      if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'agent_message') {
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string') last = text;
      }
      if (event.type === 'message' && typeof event.message === 'string') last = event.message;
    } catch {
      // Ignore non-JSON diagnostics.
    }
  }
  return last;
}

export function parseAction(text: string): ActionResponse | null {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as ActionResponse;
      if (isActionResponse(value)) return withoutNullFields(value);
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

function isActionResponse(value: ActionResponse): value is ActionResponse {
  if (!value || typeof value !== 'object') return false;
  const actions = new Set<ActionResponse['action']>([
    'new_session',
    'switch_session',
    'list_sessions',
    'status',
    'interrupt',
    'set_note',
    'reply',
    'ask',
  ]);
  if (!actions.has(value.action)) return false;
  if (value.takeover !== undefined && value.takeover !== null && typeof value.takeover !== 'boolean') return false;
  if (value.action === 'new_session') return typeof value.cwd === 'string' && value.cwd.trim().length > 0;
  if (value.action === 'switch_session') return typeof value.thread_id === 'string' && value.thread_id.trim().length > 0;
  if (value.action === 'set_note' || value.action === 'reply' || value.action === 'ask') {
    return typeof value.text === 'string' && value.text.trim().length > 0;
  }
  if (value.action === 'list_sessions') {
    return typeof value.cwd === 'string'
      && value.cwd.trim().length > 0
      && Number.isInteger(value.limit)
      && (value.limit ?? 0) > 0
      && typeof value.text === 'string'
      && value.text.trim().length > 0;
  }
  return true;
}

function withoutNullFields(value: ActionResponse): ActionResponse {
  const normalized = { ...value } as ActionResponse & Record<string, unknown>;
  for (const key of ['cli', 'cwd', 'thread_id', 'limit', 'text', 'title', 'model', 'reasoning_effort', 'fast', 'takeover', 'note', 'presentation', 'reason']) {
    if (normalized[key] === null) delete normalized[key];
  }
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : value.slice(-max);
}
