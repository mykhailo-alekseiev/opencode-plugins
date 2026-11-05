import { expect, test } from "bun:test";
import { createBatcher, MAX_WAIT_MS, QUIET_MS, type Timer } from "../src/batcher";
import type { Notice, NoticeEntry } from "../src/notice";

const checks = { id: "mon_aaaa0001", description: "pull request checks" };
const logs = { id: "mon_bbbb0002", description: "build log" };

const line = (monitor: NoticeEntry["monitor"], text: string): NoticeEntry => ({ monitor, kind: "line", text });

function createFakeTimer() {
  let now = 0;
  let nextID = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();

  const timer: Timer = {
    now: () => now,
    set(callback, ms) {
      const id = ++nextID;
      tasks.set(id, { at: now + ms, callback });
      return id;
    },
    clear(handle) {
      tasks.delete(handle as number);
    },
  };

  return {
    timer,
    advance(ms: number) {
      const target = now + ms;
      while (true) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
  };
}

function setup(send?: (sessionID: string, notice: Notice) => Promise<void>) {
  const clock = createFakeTimer();
  const sent: { sessionID: string; notice: Notice; at: number }[] = [];
  const errors: unknown[] = [];
  const batcher = createBatcher({
    timer: clock.timer,
    onError: (error) => errors.push(error),
    send:
      send ??
      (async (sessionID, notice) => {
        sent.push({ sessionID, notice, at: clock.timer.now() });
      }),
  });
  return { clock, sent, errors, batcher };
}

test("flushes an idle session after a quiet second", () => {
  const { clock, sent, batcher } = setup();
  batcher.track("ses_1", { busy: false });
  batcher.add("ses_1", line(checks, "one"));
  clock.advance(QUIET_MS - 1);
  expect(sent).toHaveLength(0);
  clock.advance(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.notice.text).toBe("[monitor mon_aaaa0001 · pull request checks]\none");
});

test("flushes a steady stream after the max wait", () => {
  const { clock, sent, batcher } = setup();
  batcher.track("ses_1", { busy: false });
  for (let at = 0; at < MAX_WAIT_MS; at += 800) {
    batcher.add("ses_1", line(checks, `tick ${at}`));
    clock.advance(800);
  }
  expect(sent).toHaveLength(1);
  expect(sent[0]!.at).toBe(MAX_WAIT_MS);
  expect(sent[0]!.notice.text.split("\n")).toHaveLength(8);
});

test("holds lines while the session is busy and flushes when it goes idle", () => {
  const { clock, sent, batcher } = setup();
  batcher.track("ses_1", { busy: true });
  batcher.add("ses_1", line(checks, "one"));
  batcher.add("ses_1", line(logs, "two"));
  clock.advance(60_000);
  expect(sent).toHaveLength(0);
  batcher.setBusy("ses_1", false);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.notice.monitors).toEqual([checks, logs]);
});

test("treats the session as busy after a flush until it goes idle again", () => {
  const { clock, sent, batcher } = setup();
  batcher.track("ses_1", { busy: false });
  batcher.add("ses_1", line(checks, "one"));
  clock.advance(QUIET_MS);
  batcher.add("ses_1", line(checks, "two"));
  clock.advance(MAX_WAIT_MS * 2);
  expect(sent).toHaveLength(1);
  batcher.setBusy("ses_1", false);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.notice.text).toContain("two");
});

test("a busy event cancels a pending flush", () => {
  const { clock, sent, batcher } = setup();
  batcher.track("ses_1", { busy: false });
  batcher.add("ses_1", line(checks, "one"));
  batcher.setBusy("ses_1", true);
  clock.advance(MAX_WAIT_MS);
  expect(sent).toHaveLength(0);
  batcher.setBusy("ses_1", false);
  expect(sent).toHaveLength(1);
});

test("does not hold lines for a session that never holds", () => {
  const { clock, sent, batcher } = setup();
  batcher.track("ses_sub", { busy: true, hold: false });
  batcher.add("ses_sub", line(checks, "one"));
  clock.advance(QUIET_MS);
  expect(sent).toHaveLength(1);
  batcher.add("ses_sub", line(checks, "two"));
  clock.advance(QUIET_MS);
  expect(sent).toHaveLength(2);
});

test("keeps sessions apart", () => {
  const { clock, sent, batcher } = setup();
  batcher.track("ses_1", { busy: false });
  batcher.track("ses_2", { busy: true });
  batcher.add("ses_1", line(checks, "one"));
  batcher.add("ses_2", line(logs, "two"));
  clock.advance(QUIET_MS);
  expect(sent.map((item) => item.sessionID)).toEqual(["ses_1"]);
});

test("forget drops pending lines", () => {
  const { clock, sent, batcher } = setup();
  batcher.track("ses_1", { busy: false });
  batcher.add("ses_1", line(checks, "one"));
  batcher.forget("ses_1");
  clock.advance(MAX_WAIT_MS);
  expect(sent).toHaveLength(0);
  expect(batcher.tracks("ses_1")).toBe(false);
});

test("a failed send reports the error and marks the session idle", async () => {
  const failure = new Error("offline");
  const { clock, errors, batcher } = setup(async () => {
    throw failure;
  });
  batcher.track("ses_1", { busy: false });
  batcher.add("ses_1", line(checks, "one"));
  clock.advance(QUIET_MS);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(errors).toEqual([failure]);
  batcher.add("ses_1", line(checks, "two"));
  clock.advance(QUIET_MS);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(errors).toEqual([failure, failure]);
});
