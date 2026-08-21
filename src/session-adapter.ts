import type { CliKind, SessionLaunchOptions, ThreadSnapshot, ThreadSummary } from './model.js';
import type { CodexNotification } from './codex.js';

export interface ExternalWriterRelease {
  attempted: boolean;
  released: boolean;
  pids: number[];
  detail?: string;
}

/**
 * The bridge owns routing and bindings; each CLI owns its native thread store.
 * A future Claude Code implementation only needs to satisfy this adapter.
 */
export interface SessionAdapter {
  readonly cli: CliKind;
  onNotification(listener: (notification: CodexNotification) => void): () => void;
  startThread(cwd: string, options?: SessionLaunchOptions): Promise<ThreadSummary>;
  resumeThread(threadId: string): Promise<ThreadSummary>;
  /** Create a new thread with a copy of the source thread's persisted history. */
  forkThread?(threadId: string, options?: SessionLaunchOptions): Promise<ThreadSummary>;
  /** Attempt to release only the external process that owns this exact thread lock. */
  releaseExternalWriter?(threadId: string): Promise<ExternalWriterRelease>;
  readThread(threadId: string): Promise<ThreadSnapshot>;
  listThreads(cwd?: string): Promise<ThreadSummary[]>;
  startTurn(threadId: string, cwd: string, text: string, options?: SessionLaunchOptions): Promise<string>;
  steerTurn(threadId: string, turnId: string, text: string): Promise<string>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  unsubscribe(threadId: string): Promise<void>;
  close(): Promise<void>;
}
