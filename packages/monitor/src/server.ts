import { Plugin } from "@opencode/plugin";
import { createBatcher } from "./batcher";
import { formatDuration } from "./duration";
import { createRegistry, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type MonitorInfo } from "./monitors";
import type { Notice } from "./notice";
import { MonitorRpc, type MonitorSummary } from "./rpc";

export const MONITOR_DESCRIPTION = `Start a background monitor: run a shell command and wake this session with each line it prints to stdout.

Use it when the user asks you to babysit, watch, monitor, or wait for something (CI checks, a pull request, a deploy, a log, a long build), or when instructions say to poll for a result. Do not write sleep loops in the shell tool instead. After starting a monitor you can keep working or end your turn; new output arrives later as a notice in this session.

How it works:
- The command runs with $SHELL -c in the session directory. Each non-empty stdout line is one event. stderr is not delivered; its last lines are included when the command exits.
- Lines that arrive close together are batched into one notice. While you are busy, notices wait until your turn ends.
- The monitor ends when the command exits (you get the exit code), when timeout_ms passes (you get one notice and can start it again), or when you call monitor_stop.
- The command does its own polling. Print only lines worth waking for and drop repeats, for example by piping through awk '!seen[$0]++ {print; fflush()}' or grep --line-buffered. Exit when the watch is done.
- Start long watches from the main session. Monitors started by a subagent stop when the subagent finishes.

Example: wake when a pull request check fails, and stop when the pull request closes.
while true; do
  gh pr checks 123 --json name,bucket,link --jq '.[] | select(.bucket == "fail") | "check failed: \\(.name) \\(.link)"'
  state=$(gh pr view 123 --json state --jq .state)
  if [ "$state" != OPEN ]; then echo "pull request $state"; break; fi
  sleep 60
done | awk '!seen[$0]++ {print; fflush()}'`;

export const MONITOR_STOP_DESCRIPTION = "Stop a running monitor started with the monitor tool. No notice is sent.";

const EXECUTION_ENDED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function requiredString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function summarize(monitor: MonitorInfo): MonitorSummary {
  return {
    id: monitor.id,
    sessionID: monitor.sessionID,
    description: monitor.description,
    command: monitor.command,
    startedAt: monitor.startedAt,
    expiresAt: monitor.expiresAt,
  };
}

function noticeDescription(notice: Notice) {
  const [first] = notice.monitors;
  if (notice.monitors.length === 1 && first) return `monitor ${first.id} · ${first.description}`;
  return `${notice.monitors.length} monitors`;
}

export default Plugin.define({
  id: "mykhailo.monitor",
  async setup(ctx) {
    const subagents = new Set<string>();

    const batcher = createBatcher({
      send: async (sessionID, notice) => {
        await ctx.session.synthetic({
          sessionID,
          text: notice.text,
          description: noticeDescription(notice),
          metadata: { monitors: notice.monitors.map((monitor) => monitor.id) },
          delivery: subagents.has(sessionID) ? "steer" : "queue",
        });
      },
      onError: (error) => console.error("[monitor] failed to deliver notice", error),
    });

    const registry = createRegistry({
      emit: (sessionID, entry) => batcher.add(sessionID, entry),
    });

    const release = async (sessionID: string) => {
      subagents.delete(sessionID);
      batcher.forget(sessionID);
      await registry.stopSession(sessionID);
    };

    const handle = (event: { type: string; data?: unknown }) => {
      const data = record(event.data);
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
      if (!sessionID || !(registry.hasSession(sessionID) || batcher.tracks(sessionID))) return;

      if (event.type === "session.deleted") return void release(sessionID);
      if (subagents.has(sessionID)) {
        if (event.type === "session.idle" || EXECUTION_ENDED.has(event.type)) void release(sessionID);
        return;
      }
      if (event.type === "session.execution.started") return batcher.setBusy(sessionID, true);
      if (EXECUTION_ENDED.has(event.type)) batcher.setBusy(sessionID, false);
    };

    const controller = new AbortController();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) handle(event);
        } catch (error) {
          if (controller.signal.aborted) return;
          console.error("[monitor] event stream failed", error);
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    })();

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "monitor",
        description: MONITOR_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Short label shown with every notice, for example 'PR 123 checks'.",
            },
            command: {
              type: "string",
              description: "Shell command to run. Each stdout line wakes this session.",
            },
            timeout_ms: {
              type: "number",
              description: `Stop the monitor after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS} (${formatDuration(DEFAULT_TIMEOUT_MS)}), maximum ${MAX_TIMEOUT_MS} (${formatDuration(MAX_TIMEOUT_MS)}). Pass a larger value for long watches such as a pull request.`,
            },
          },
          required: ["description", "command"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const args = record(input);
          const description = requiredString(args, "description");
          const command = requiredString(args, "command");
          const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;

          const session = await ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined);
          const cwd = session?.location.directory ?? ctx.location.directory;
          const subagent = Boolean(session?.parentID);

          if (subagent) subagents.add(context.sessionID);
          batcher.track(context.sessionID, { busy: true, hold: !subagent });
          const monitor = registry.start({ sessionID: context.sessionID, description, command, cwd, timeoutMs, subagent });

          return {
            content: `Monitor ${monitor.id} started; it stops after ${formatDuration(monitor.timeoutMs)}. Its stdout lines will arrive as notices in this session. Stop it early with monitor_stop.`,
            metadata: { taskId: monitor.id, timeoutMs: monitor.timeoutMs },
          };
        },
      });

      editor.add({
        name: "monitor_stop",
        description: MONITOR_STOP_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Monitor id returned by the monitor tool." },
          },
          required: ["taskId"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input) => {
          const taskId = requiredString(record(input), "taskId");
          if (!(await registry.stop(taskId))) throw new Error(`No running monitor ${taskId}`);
          return { content: `Monitor ${taskId} stopped.` };
        },
      });
    });

    const rpc = await ctx.rpc.register(MonitorRpc, {
      list: async (input) => {
        const sessionIDs = record(input).sessionIDs;
        const ids = Array.isArray(sessionIDs) ? sessionIDs.filter((id): id is string => typeof id === "string") : [];
        return { monitors: registry.list(ids).map(summarize) };
      },
      stop: async (input) => ({ stopped: await registry.stop(requiredString(record(input), "id")) }),
    });

    return async () => {
      controller.abort();
      batcher.dispose();
      await Promise.all([tools.dispose(), rpc.dispose()]);
      await registry.dispose();
    };
  },
});
