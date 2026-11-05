import { expect, test } from "bun:test";
import { startProcess, type ProcessExit } from "../src/process";

function run(command: string, options: { cwd?: string; graceMs?: number } = {}) {
  const lines: string[] = [];
  let resolveExit!: (exit: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((resolve) => (resolveExit = resolve));
  const process = startProcess({
    command,
    cwd: options.cwd ?? import.meta.dir,
    shell: "/bin/sh",
    graceMs: options.graceMs ?? 200,
    env: { MONITOR_TEST: "yes" },
    onLine: (line) => lines.push(line),
    onExit: resolveExit,
  });
  return { process, lines, exited };
}

function alive(pid: number) {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 2_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("delivers stdout lines and reports the exit code with the stderr tail", async () => {
  const { lines, exited } = run('echo one; echo "$MONITOR_TEST"; echo oops >&2; exit 3');
  const exit = await exited;
  expect(lines).toEqual(["one", "yes"]);
  expect(exit).toEqual({ code: 3, signal: null, error: undefined, stderr: ["oops"] });
});

test("keeps only the last stderr lines", async () => {
  const { exited } = run("i=0; while [ $i -lt 30 ]; do echo err-$i >&2; i=$((i+1)); done");
  const exit = await exited;
  expect(exit.stderr).toHaveLength(20);
  expect(exit.stderr.at(-1)).toBe("err-29");
});

test("reports a spawn failure", async () => {
  const { exited } = run("echo never", { cwd: "/definitely/missing/dir" });
  const exit = await exited;
  expect(exit.error).toBeDefined();
});

test("stop kills the whole process group", async () => {
  const { process, lines, exited } = run("sleep 30 & echo $!; wait");
  await waitFor(() => lines.length > 0);
  const child = Number(lines[0]);
  expect(alive(child)).toBe(true);
  await process.stop();
  const exit = await exited;
  expect(exit.signal).toBe("SIGTERM");
  expect(alive(child)).toBe(false);
});

test("stop escalates to SIGKILL when SIGTERM is ignored", async () => {
  const { process, lines, exited } = run("trap '' TERM; echo ready; while true; do sleep 1; done", { graceMs: 200 });
  await waitFor(() => lines.length > 0);
  await process.stop();
  const exit = await exited;
  expect(exit.signal).toBe("SIGKILL");
});

test("kills children left behind when the shell exits", async () => {
  const { lines, exited } = run("sleep 30 & echo $!");
  const exit = await exited;
  expect(exit.code).toBe(0);
  const child = Number(lines[0]);
  await waitFor(() => !alive(child));
});
