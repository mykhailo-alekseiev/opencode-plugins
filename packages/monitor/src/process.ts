import { spawn } from "node:child_process";
import { createLineSplitter, createTail } from "./lines";

export const STOP_GRACE_MS = 5_000;
export const STDERR_TAIL_LINES = 20;

export type ProcessExit = {
  code: number | null;
  signal: string | null;
  error?: string;
  stderr: string[];
};

export type MonitorProcess = {
  pid: number | undefined;
  stop(): Promise<void>;
};

function signalGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

export function startProcess(options: {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  shell?: string;
  graceMs?: number;
  onLine: (line: string) => void;
  onExit: (exit: ProcessExit) => void;
}): MonitorProcess {
  const shell = options.shell ?? (process.env.SHELL || "/bin/sh");
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  const child = spawn(shell, ["-c", options.command], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = createLineSplitter(options.onLine);
  const stderr = createTail(STDERR_TAIL_LINES);
  let exited = false;
  let closed = false;
  let error: string | undefined;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => (resolveClosed = resolve));
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const waitClosed = async (ms: number) => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (handle = setTimeout(resolve, ms)));
    await Promise.race([closedPromise, timeout]);
    clearTimeout(handle);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  const finish = (code: number | null, signal: string | null) => {
    if (closed) return;
    closed = true;
    if (killTimer) clearTimeout(killTimer);
    stdout.end();
    resolveClosed();
    options.onExit({ code, signal, error, stderr: stderr.lines() });
  };

  child.on("error", (cause) => {
    error = cause.message;
    if (child.pid === undefined) finish(null, null);
  });

  child.on("exit", () => {
    exited = true;
    signalGroup(child.pid, "SIGTERM");
    killTimer = setTimeout(() => {
      signalGroup(child.pid, "SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    }, graceMs);
  });

  child.on("close", (code, signal) => finish(code, signal));

  return {
    pid: child.pid,
    async stop() {
      if (closed) return;
      signalGroup(child.pid, "SIGTERM");
      await waitClosed(graceMs);
      signalGroup(child.pid, "SIGKILL");
      if (!exited) child.kill("SIGKILL");
      await waitClosed(1_000);
    },
  };
}
