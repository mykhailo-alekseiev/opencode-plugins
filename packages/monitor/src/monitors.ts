import { randomBytes } from "node:crypto";
import { formatDuration } from "./duration";
import { cutLine } from "./lines";
import type { NoticeEntry } from "./notice";
import { startProcess, type MonitorProcess, type ProcessExit } from "./process";

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_DESCRIPTION_LENGTH = 120;
export const MAX_STDERR_LINE_LENGTH = 300;

export type MonitorInfo = {
  id: string;
  sessionID: string;
  description: string;
  command: string;
  cwd: string;
  startedAt: number;
  expiresAt: number;
  timeoutMs: number;
  subagent: boolean;
};

export type StartInput = {
  sessionID: string;
  description: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
  subagent?: boolean;
};

type Spawn = (options: Parameters<typeof startProcess>[0]) => MonitorProcess;

type Running = MonitorInfo & {
  process: MonitorProcess;
  deadline: ReturnType<typeof setTimeout>;
  ending: boolean;
};

export function clampTimeout(timeoutMs: number | undefined) {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)));
}

export function describeExit(exit: ProcessExit) {
  const status = exit.error
    ? `Monitor failed to run: ${exit.error}`
    : exit.signal
      ? `Monitor was killed by ${exit.signal}.`
      : `Monitor exited with code ${exit.code}.`;
  if (exit.stderr.length === 0) return status;
  const stderr = exit.stderr.map((line) => `  ${cutLine(line, MAX_STDERR_LINE_LENGTH)}`);
  return [status, "Last stderr lines:", ...stderr].join("\n");
}

export function createMonitorId() {
  return `mon_${randomBytes(4).toString("hex")}`;
}

export function createRegistry(options: {
  emit: (sessionID: string, entry: NoticeEntry) => void;
  spawn?: Spawn;
  now?: () => number;
}) {
  const spawn = options.spawn ?? startProcess;
  const now = options.now ?? Date.now;
  const monitors = new Map<string, Running>();

  const info = (monitor: Running): MonitorInfo => ({
    id: monitor.id,
    sessionID: monitor.sessionID,
    description: monitor.description,
    command: monitor.command,
    cwd: monitor.cwd,
    startedAt: monitor.startedAt,
    expiresAt: monitor.expiresAt,
    timeoutMs: monitor.timeoutMs,
    subagent: monitor.subagent,
  });

  const end = (monitor: Running, text: string) => {
    options.emit(monitor.sessionID, { monitor, kind: "end", text });
  };

  const halt = async (monitor: Running) => {
    monitor.ending = true;
    clearTimeout(monitor.deadline);
    monitors.delete(monitor.id);
    await monitor.process.stop();
  };

  return {
    start(input: StartInput): MonitorInfo {
      const id = createMonitorId();
      const timeoutMs = clampTimeout(input.timeoutMs);
      const startedAt = now();
      const description = cutLine(input.description.trim() || "monitor", MAX_DESCRIPTION_LENGTH);
      const monitor = {
        id,
        sessionID: input.sessionID,
        description,
        command: input.command,
        cwd: input.cwd,
        startedAt,
        expiresAt: startedAt + timeoutMs,
        timeoutMs,
        subagent: input.subagent ?? false,
        ending: false,
      } as Running;

      monitor.process = spawn({
        command: input.command,
        cwd: input.cwd,
        env: { OPENCODE_MONITOR_ID: id },
        onLine: (line) => {
          if (monitor.ending) return;
          options.emit(monitor.sessionID, { monitor, kind: "line", text: line });
        },
        onExit: (exit) => {
          if (monitor.ending) return;
          monitor.ending = true;
          clearTimeout(monitor.deadline);
          monitors.delete(id);
          end(monitor, describeExit(exit));
        },
      });

      if (!monitor.ending) {
        monitor.deadline = setTimeout(() => {
          end(monitor, `Monitor timed out after ${formatDuration(timeoutMs)}. Start it again if it is still needed.`);
          void halt(monitor);
        }, timeoutMs);
        monitors.set(id, monitor);
      }
      return info(monitor);
    },
    async stop(id: string) {
      const monitor = monitors.get(id);
      if (!monitor) return false;
      await halt(monitor);
      return true;
    },
    async stopSession(sessionID: string, filter: (monitor: MonitorInfo) => boolean = () => true) {
      const matching = [...monitors.values()].filter((monitor) => monitor.sessionID === sessionID && filter(monitor));
      await Promise.all(matching.map(halt));
      return matching.length;
    },
    get(id: string) {
      const monitor = monitors.get(id);
      return monitor ? info(monitor) : undefined;
    },
    list(sessionIDs?: readonly string[]) {
      return [...monitors.values()]
        .filter((monitor) => !sessionIDs || sessionIDs.includes(monitor.sessionID))
        .map(info);
    },
    hasSession(sessionID: string) {
      return [...monitors.values()].some((monitor) => monitor.sessionID === sessionID);
    },
    async dispose() {
      await Promise.all([...monitors.values()].map(halt));
    },
  };
}
