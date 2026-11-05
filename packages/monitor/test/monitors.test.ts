import { expect, test } from "bun:test";
import { formatDuration } from "../src/duration";
import {
  clampTimeout,
  createRegistry,
  DEFAULT_TIMEOUT_MS,
  describeExit,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "../src/monitors";
import type { NoticeEntry } from "../src/notice";
import type { ProcessExit } from "../src/process";

type Spawned = {
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  onLine: (line: string) => void;
  onExit: (exit: ProcessExit) => void;
  stops: number;
};

function setup() {
  const emitted: { sessionID: string; entry: NoticeEntry }[] = [];
  const spawned: Spawned[] = [];
  const registry = createRegistry({
    emit: (sessionID, entry) => emitted.push({ sessionID, entry }),
    spawn: (options) => {
      const record: Spawned = { ...options, stops: 0 };
      spawned.push(record);
      return {
        pid: 1,
        async stop() {
          record.stops++;
        },
      };
    },
  });
  return { registry, emitted, spawned };
}

const start = (registry: ReturnType<typeof setup>["registry"], overrides: { sessionID?: string; timeoutMs?: number; subagent?: boolean } = {}) =>
  registry.start({
    sessionID: overrides.sessionID ?? "ses_1",
    description: "pull request checks",
    command: "watch-checks",
    cwd: "/repo",
    timeoutMs: overrides.timeoutMs,
    subagent: overrides.subagent,
  });

test("starts a monitor with an id and the monitor env", () => {
  const { registry, spawned } = setup();
  const monitor = start(registry);
  expect(monitor.id).toMatch(/^mon_[0-9a-f]{8}$/);
  expect(monitor.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  expect(monitor.expiresAt - monitor.startedAt).toBe(DEFAULT_TIMEOUT_MS);
  expect(spawned[0]).toMatchObject({ command: "watch-checks", cwd: "/repo", env: { OPENCODE_MONITOR_ID: monitor.id } });
  expect(registry.list().map((item) => item.id)).toEqual([monitor.id]);
  registry.dispose();
});

test("emits each line and one end notice when the process exits", () => {
  const { registry, emitted, spawned } = setup();
  const monitor = start(registry);
  spawned[0]!.onLine("check failed: lint");
  spawned[0]!.onExit({ code: 1, signal: null, stderr: ["boom"] });
  spawned[0]!.onLine("ignored after exit");
  expect(emitted.map((item) => [item.sessionID, item.entry.kind, item.entry.text])).toEqual([
    ["ses_1", "line", "check failed: lint"],
    ["ses_1", "end", "Monitor exited with code 1.\nLast stderr lines:\n  boom"],
  ]);
  expect(emitted[0]!.entry.monitor.id).toBe(monitor.id);
  expect(registry.get(monitor.id)).toBeUndefined();
});

test("stop is silent and kills the process", async () => {
  const { registry, emitted, spawned } = setup();
  const monitor = start(registry);
  expect(await registry.stop(monitor.id)).toBe(true);
  spawned[0]!.onExit({ code: null, signal: "SIGTERM", stderr: [] });
  expect(spawned[0]!.stops).toBe(1);
  expect(emitted).toEqual([]);
  expect(await registry.stop(monitor.id)).toBe(false);
});

test("stopSession stops only the matching monitors", async () => {
  const { registry, spawned } = setup();
  const main = start(registry);
  const sub = start(registry, { subagent: true });
  const other = start(registry, { sessionID: "ses_2" });
  expect(await registry.stopSession("ses_1", (monitor) => monitor.subagent)).toBe(1);
  expect(registry.list().map((item) => item.id)).toEqual([main.id, other.id]);
  expect(registry.list(["ses_2"]).map((item) => item.id)).toEqual([other.id]);
  expect(registry.hasSession("ses_1")).toBe(true);
  expect(spawned.map((item) => item.stops)).toEqual([0, 1, 0]);
  expect(sub.subagent).toBe(true);
  await registry.dispose();
  expect(registry.list()).toEqual([]);
});

test("ends with a timeout notice at the deadline", async () => {
  const { registry, emitted, spawned } = setup();
  const monitor = start(registry, { timeoutMs: MIN_TIMEOUT_MS });
  await new Promise((resolve) => setTimeout(resolve, MIN_TIMEOUT_MS + 100));
  expect(emitted.map((item) => item.entry)).toEqual([
    {
      monitor: expect.objectContaining({ id: monitor.id }),
      kind: "end",
      text: "Monitor timed out after 1s. Start it again if it is still needed.",
    },
  ]);
  expect(spawned[0]!.stops).toBe(1);
  expect(registry.get(monitor.id)).toBeUndefined();
});

test("clamps the timeout", () => {
  expect(clampTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
  expect(clampTimeout(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
  expect(clampTimeout(10)).toBe(MIN_TIMEOUT_MS);
  expect(clampTimeout(MAX_TIMEOUT_MS * 2)).toBe(MAX_TIMEOUT_MS);
});

test("describes how a process ended", () => {
  expect(describeExit({ code: 0, signal: null, stderr: [] })).toBe("Monitor exited with code 0.");
  expect(describeExit({ code: null, signal: "SIGKILL", stderr: [] })).toBe("Monitor was killed by SIGKILL.");
  expect(describeExit({ code: null, signal: null, error: "spawn ENOENT", stderr: [] })).toBe(
    "Monitor failed to run: spawn ENOENT",
  );
  expect(describeExit({ code: 2, signal: null, stderr: ["x".repeat(400)] })).toBe(
    `Monitor exited with code 2.\nLast stderr lines:\n  ${"x".repeat(300)}…`,
  );
});

test("formats durations", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(61_000)).toBe("1m 1s");
  expect(formatDuration(5 * 60 * 1_000)).toBe("5m");
  expect(formatDuration(MAX_TIMEOUT_MS)).toBe("24h");
});
