export type PresentationMode = 'chat' | 'page';
export type CliKind = 'codex' | 'cc';

export interface SessionLaunchOptions {
  cli?: CliKind;
  model?: string;
  reasoningEffort?: string;
  fast?: boolean;
}

export interface SessionBinding extends SessionLaunchOptions {
  threadId: string;
  cwd: string;
  tmuxSession: string;
  /** A bridge-local label; native Codex sessions are never renamed. */
  note?: string;
  /** False only for a newly created thread before its first turn is persisted. */
  hasRollout?: boolean;
  createdAt: number;
  lastActivityAt: number;
}

export interface ControlState {
  sessionId?: string;
  startedAt: number;
  lastActivityAt: number;
  executionFeedback?: string;
  pendingTakeover?: PendingTakeover;
}

export interface PendingTakeover {
  threadId: string;
  cwd: string;
  running: boolean;
}

export interface SessionSelectionItem extends SessionLaunchOptions {
  cli: CliKind;
  threadId: string;
  cwd: string;
  name?: string;
  preview?: string;
}

export interface SessionSelection {
  createdAt: number;
  expiresAt: number;
  items: SessionSelectionItem[];
}

export interface BotState {
  version: 1;
  token: string;
  botId: string;
  baseUrl: string;
  scannedUser: string;
  cursor: string;
  contextTokens: Record<string, string>;
  bindings: Record<string, SessionBinding>;
  controls: Record<string, ControlState>;
  bindingHistory: Record<string, SessionBinding[]>;
  sessionNotes: Record<string, string>;
  selections: Record<string, SessionSelection>;
  dedup: string[];
  lastPollAt: number;
  lastError: string;
}

export interface ActionResponse {
  action:
    | 'new_session'
    | 'switch_session'
    | 'list_sessions'
    | 'status'
    | 'interrupt'
    | 'raw_input'
    | 'set_note'
    | 'reply'
    | 'ask';
  cli?: CliKind;
  cwd?: string;
  thread_id?: string;
  limit?: number;
  text?: string;
  title?: string;
  model?: string;
  reasoning_effort?: string;
  fast?: boolean;
  takeover?: boolean;
  note?: string;
  presentation?: PresentationMode;
  reason?: string;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  text: string;
  status: 'completed' | 'interrupted' | 'failed';
  presentation?: PresentationMode;
  kind?: 'plain' | 'plan' | 'diff' | 'report' | 'code';
  error?: string;
}

export interface ThreadSummary {
  id: string;
  cli?: CliKind;
  name?: string;
  preview?: string;
  cwd?: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  status?: { type?: string; activeFlags?: string[] };
}
