import type { CliKind, SessionLaunchOptions, ThreadSummary } from './model.js';
import type { CodexNotification } from './codex.js';

/**
 * The bridge owns routing and bindings; each CLI owns its native thread store.
 * A future Claude Code implementation only needs to satisfy this adapter.
 */
export interface SessionAdapter {
  readonly cli: CliKind;
  onNotification(listener: (notification: CodexNotification) => void): () => void;
  startThread(cwd: string, options?: SessionLaunchOptions): Promise<ThreadSummary>;
  resumeThread(threadId: string): Promise<ThreadSummary>;
  listThreads(cwd?: string): Promise<ThreadSummary[]>;
  startTurn(threadId: string, cwd: string, text: string, options?: SessionLaunchOptions): Promise<string>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  unsubscribe(threadId: string): Promise<void>;
  close(): Promise<void>;
}
