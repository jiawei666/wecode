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
  return `你是 wecode 的控制 Agent。你只负责理解控制意图并返回 action JSON，不直接替用户完成项目开发。

你可以扫描 ${homeDir} 及其子目录，查找项目和 Codex 原生 thread。默认项目根目录是：${searchRoots.join('、')}。你拥有完整权限，但必须把实际项目工作交给目标 Codex thread。

只输出一个 JSON 对象，不要 Markdown，不要解释，不要输出思维过程。所有字段都必须输出；不适用的字段填 null。可用 action：
- new_session: 创建新 Codex 会话，需要 cwd；可选 model/reasoning_effort/fast
- switch_session: 切换已有 Codex 会话，需要 thread_id，可选 cwd/model/reasoning_effort/fast
- list_sessions: 列出 Codex 会话，可选 cwd
- status: 查看当前绑定和运行状态
- interrupt: 中断当前 Codex 任务
- raw_input: 将 text 原样发送给当前 tmux TUI
- set_note: 为当前会话设置本地备注，text 为备注内容
- ask: 信息不足时向用户提问，需要 text；不要猜项目目录或会话
- reply: 控制操作完成后回复用户，需要 text，可选 title/presentation

如果用户只是要做项目开发，不要返回 reply；在有当前会话时由路由层直接发送给目标 Codex。多个候选会话时返回 list_sessions，不要猜。控制意图完成后，优先返回明确的 action JSON。`;
}

export class ControlAgent {
  private readonly active = new Map<string, ChildProcess>();
  private readonly interrupted = new Set<string>();

  constructor(private readonly config: AppConfig) {}

  async run(userId: string, userText: string, previousSessionId?: string): Promise<ControlResult> {
    const prompt = `${controlInstructions(this.config.homeDir, this.config.searchRoots)}\n\n当前用户控制请求：\n${userText.trim()}`;
    try {
      return await this.runOnce(userId, prompt, previousSessionId);
    } catch (error) {
      // Some old exec sessions contain a thread.started event without a
      // persisted rollout. Recreate only the control conversation and let the
      // bridge continue with the current request instead of losing the mode.
      if (!previousSessionId || !/no rollout found|thread not found/i.test(errorMessage(error))) throw error;
      return this.runOnce(userId, `${prompt}\n\n控制会话恢复失败，请基于当前上下文继续。`, undefined);
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
      throw new Error(`控制 Agent 未返回有效 action JSON：${finalText.slice(0, 500) || result.stderr.slice(0, 500)}`);
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
      finish(() => reject(new Error(`控制 Agent 超时（${Math.round(timeoutMs / 1000)} 秒）`)));
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
          reject(new Error(detail ? `控制 Agent exit ${code ?? 'signal'}: ${detail}` : `控制 Agent exit ${code ?? 'signal'}`));
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
    'raw_input',
    'set_note',
    'reply',
    'ask',
  ]);
  if (!actions.has(value.action)) return false;
  if (value.action === 'new_session') return typeof value.cwd === 'string' && value.cwd.trim().length > 0;
  if (value.action === 'switch_session') return typeof value.thread_id === 'string' && value.thread_id.trim().length > 0;
  if (value.action === 'raw_input' || value.action === 'set_note' || value.action === 'reply' || value.action === 'ask') {
    return typeof value.text === 'string' && value.text.trim().length > 0;
  }
  return true;
}

function withoutNullFields(value: ActionResponse): ActionResponse {
  const normalized = { ...value } as ActionResponse & Record<string, unknown>;
  for (const key of ['cli', 'cwd', 'thread_id', 'text', 'title', 'model', 'reasoning_effort', 'fast', 'note', 'presentation', 'reason']) {
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
