import { createNoticeBuffer, type Notice, type NoticeEntry } from "./notice";

export const QUIET_MS = 1_000;
export const MAX_WAIT_MS = 5_000;

export type Timer = {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export const systemTimer: Timer = {
  now: () => Date.now(),
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type SessionState = {
  buffer: ReturnType<typeof createNoticeBuffer>;
  busy: boolean;
  hold: boolean;
  firstAt?: number;
  handle?: unknown;
};

export function createBatcher(options: {
  send: (sessionID: string, notice: Notice) => Promise<void>;
  onError?: (error: unknown) => void;
  timer?: Timer;
  quietMs?: number;
  maxWaitMs?: number;
}) {
  const timer = options.timer ?? systemTimer;
  const quietMs = options.quietMs ?? QUIET_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const sessions = new Map<string, SessionState>();

  const state = (sessionID: string) => {
    let current = sessions.get(sessionID);
    if (!current) {
      current = { buffer: createNoticeBuffer(), busy: false, hold: true };
      sessions.set(sessionID, current);
    }
    return current;
  };

  const cancel = (current: SessionState) => {
    if (current.handle !== undefined) timer.clear(current.handle);
    current.handle = undefined;
  };

  const flush = (sessionID: string) => {
    const current = sessions.get(sessionID);
    if (!current) return;
    cancel(current);
    current.firstAt = undefined;
    const notice = current.buffer.take();
    if (!notice) return;
    current.busy = true;
    options.send(sessionID, notice).catch((error) => {
      current.busy = false;
      options.onError?.(error);
    });
  };

  const schedule = (sessionID: string, current: SessionState) => {
    if ((current.busy && current.hold) || current.buffer.empty) return;
    const now = timer.now();
    current.firstAt ??= now;
    cancel(current);
    const delay = Math.max(0, Math.min(quietMs, current.firstAt + maxWaitMs - now));
    current.handle = timer.set(() => flush(sessionID), delay);
  };

  return {
    add(sessionID: string, entry: NoticeEntry) {
      const current = state(sessionID);
      current.buffer.push(entry);
      schedule(sessionID, current);
    },
    setBusy(sessionID: string, busy: boolean) {
      const current = sessions.get(sessionID);
      if (!current) return;
      current.busy = busy;
      if (!current.hold) return;
      if (busy) {
        cancel(current);
        current.firstAt = undefined;
        return;
      }
      flush(sessionID);
    },
    track(sessionID: string, options: { busy: boolean; hold?: boolean }) {
      const current = state(sessionID);
      current.busy = options.busy;
      current.hold = options.hold ?? true;
    },
    forget(sessionID: string) {
      const current = sessions.get(sessionID);
      if (!current) return;
      cancel(current);
      sessions.delete(sessionID);
    },
    tracks(sessionID: string) {
      return sessions.has(sessionID);
    },
    dispose() {
      for (const current of sessions.values()) cancel(current);
      sessions.clear();
    },
  };
}
