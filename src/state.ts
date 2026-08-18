import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BotState, ControlState, SessionBinding, SessionSelection } from './model.js';

const KEEP_DEDUP = 500;

function emptyState(): BotState {
  return {
    version: 1,
    token: '',
    botId: '',
    baseUrl: '',
    scannedUser: '',
    cursor: '',
    contextTokens: {},
    bindings: {},
    controls: {},
    bindingHistory: {},
    sessionNotes: {},
    selections: {},
    dedup: [],
    lastPollAt: 0,
    lastError: '',
  };
}

export class StateStore {
  private state: BotState;
  private savePending: Promise<void> | null = null;
  private saveRequested = false;

  constructor(private readonly file: string) {
    this.state = emptyState();
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const loaded = JSON.parse(raw) as Partial<BotState>;
      this.state = {
        ...emptyState(),
        ...loaded,
        contextTokens: loaded.contextTokens ?? {},
        bindings: loaded.bindings ?? {},
        controls: Object.fromEntries(
          Object.entries(loaded.controls ?? {}).map(([userId, control]) => [
            userId,
            { ...control, lastActivityAt: control?.lastActivityAt ?? control?.startedAt ?? Date.now() },
          ]),
        ),
        bindingHistory: loaded.bindingHistory ?? {},
        sessionNotes: loaded.sessionNotes ?? {},
        selections: loaded.selections ?? {},
        dedup: loaded.dedup ?? [],
      };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code?: string }).code) : '';
      if (code !== 'ENOENT') process.stderr.write(`[state] ignoring unreadable state: ${String(error)}\n`);
    }
  }

  get(): BotState {
    return this.state;
  }

  update(mutator: (state: BotState) => void): void {
    mutator(this.state);
    void this.save();
  }

  async save(): Promise<void> {
    this.saveRequested = true;
    if (this.savePending) return this.savePending;
    this.savePending = (async () => {
      while (this.saveRequested) {
        this.saveRequested = false;
        await this.writeAtomically();
      }
    })().finally(() => {
      this.savePending = null;
      if (this.saveRequested) void this.save();
    });
    return this.savePending;
  }

  seen(key: string): boolean {
    if (this.state.dedup.includes(key)) return true;
    this.state.dedup.push(key);
    if (this.state.dedup.length > KEEP_DEDUP) this.state.dedup = this.state.dedup.slice(-KEEP_DEDUP);
    void this.save();
    return false;
  }

  setBinding(userId: string, binding: SessionBinding): void {
    this.state.bindings[userId] = binding;
    void this.save();
  }

  pushBindingHistory(userId: string, binding: SessionBinding, limit: number): void {
    const history = this.state.bindingHistory[userId] ?? [];
    if (history[0]?.threadId === binding.threadId) return;
    this.state.bindingHistory[userId] = [binding, ...history.filter((item) => item.threadId !== binding.threadId)].slice(0, limit);
    void this.save();
  }

  getBindingHistory(userId: string): SessionBinding[] {
    return this.state.bindingHistory[userId] ?? [];
  }

  getBinding(userId: string): SessionBinding | undefined {
    return this.state.bindings[userId];
  }

  clearBinding(userId: string): void {
    delete this.state.bindings[userId];
    void this.save();
  }

  setControl(userId: string, control: ControlState): void {
    this.state.controls[userId] = control;
    void this.save();
  }

  setSelection(userId: string, selection: SessionSelection): void {
    this.state.selections[userId] = selection;
    void this.save();
  }

  getSelection(userId: string): SessionSelection | undefined {
    return this.state.selections[userId];
  }

  clearSelection(userId: string): void {
    delete this.state.selections[userId];
    void this.save();
  }

  setSessionNote(threadId: string, note: string): void {
    if (note.trim()) this.state.sessionNotes[threadId] = note.trim();
    else delete this.state.sessionNotes[threadId];
    void this.save();
  }

  getSessionNote(threadId: string): string | undefined {
    return this.state.sessionNotes[threadId];
  }

  getControl(userId: string): ControlState | undefined {
    return this.state.controls[userId];
  }

  clearControl(userId: string): void {
    delete this.state.controls[userId];
    void this.save();
  }

  private async writeAtomically(): Promise<void> {
    const tmp = `${this.file}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    try {
      await chmod(this.file, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  }
}
