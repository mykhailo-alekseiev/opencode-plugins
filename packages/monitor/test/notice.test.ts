import { expect, test } from "bun:test";
import { createNoticeBuffer, formatNotice, type NoticeEntry } from "../src/notice";

const checks = { id: "mon_aaaa0001", description: "pull request checks" };
const logs = { id: "mon_bbbb0002", description: "build log" };

const line = (monitor: NoticeEntry["monitor"], text: string): NoticeEntry => ({ monitor, kind: "line", text });

test("groups lines by monitor in arrival order", () => {
  const notice = formatNotice([line(checks, "one"), line(logs, "two"), line(checks, "three")]);
  expect(notice.text).toBe(
    ["[monitor mon_aaaa0001 · pull request checks]", "one", "three", "", "[monitor mon_bbbb0002 · build log]", "two"].join(
      "\n",
    ),
  );
  expect(notice.monitors).toEqual([checks, logs]);
});

test("drops the oldest lines past the size cap and reports how many", () => {
  const buffer = createNoticeBuffer(20);
  for (const text of ["line-1", "line-2", "line-3", "line-4"]) buffer.push(line(checks, text));
  const notice = buffer.take();
  expect(notice?.text).toBe(["… 2 earlier lines dropped", "", "[monitor mon_aaaa0001 · pull request checks]", "line-3", "line-4"].join("\n"));
});

test("never drops end entries", () => {
  const buffer = createNoticeBuffer(10);
  buffer.push({ monitor: checks, kind: "end", text: "Monitor exited with code 1." });
  buffer.push(line(checks, "late"));
  expect(buffer.take()?.text).toBe(
    ["… 1 earlier line dropped", "", "[monitor mon_aaaa0001 · pull request checks]", "Monitor exited with code 1."].join("\n"),
  );
});

test("take empties the buffer", () => {
  const buffer = createNoticeBuffer();
  expect(buffer.take()).toBeUndefined();
  buffer.push(line(checks, "one"));
  expect(buffer.empty).toBe(false);
  expect(buffer.take()).toBeDefined();
  expect(buffer.empty).toBe(true);
  expect(buffer.take()).toBeUndefined();
});
