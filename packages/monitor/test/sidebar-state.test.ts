import { expect, test } from "bun:test";
import type { MonitorSummary } from "../src/rpc";
import { createSidebarFeed, type SidebarState } from "../src/sidebar-state";

const monitor: MonitorSummary = {
  id: "mon_aaaa0001",
  sessionID: "ses_1",
  description: "PR checks",
  command: "gh pr checks 123 --watch",
  startedAt: 1_000,
  expiresAt: 61_000,
};

test("refreshes active monitors and removes completed or stopped monitors", async () => {
  const states: SidebarState[] = [];
  let monitors = [monitor];
  const feed = createSidebarFeed(async () => monitors, (state) => states.push(state));
  await feed.refresh();
  monitors = [];
  await feed.refresh();
  expect(states).toEqual([
    { monitors: [monitor], error: false },
    { monitors: [], error: false },
  ]);
});

test("does not overlap slow requests", async () => {
  let resolve!: (value: MonitorSummary[]) => void;
  let calls = 0;
  const feed = createSidebarFeed(
    () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    () => {},
  );
  const first = feed.refresh();
  await feed.refresh();
  expect(calls).toBe(1);
  resolve([monitor]);
  await first;
});

test("ignores late replies after a session switch or sidebar disposal", async () => {
  const states: SidebarState[] = [];
  let resolve!: (value: MonitorSummary[]) => void;
  const feed = createSidebarFeed(
    () => new Promise((done) => {
      resolve = done;
    }),
    (state) => states.push(state),
  );
  const pending = feed.refresh();
  feed.dispose();
  resolve([monitor]);
  await pending;
  await feed.refresh();
  expect(states).toEqual([]);
});

test("clears stale monitors on failure and recovers on the next refresh", async () => {
  const states: SidebarState[] = [];
  let fail = false;
  const feed = createSidebarFeed(
    async () => {
      if (fail) throw new Error("RPC unavailable");
      return [monitor];
    },
    (state) => states.push(state),
  );
  await feed.refresh();
  fail = true;
  await feed.refresh();
  fail = false;
  await feed.refresh();
  expect(states).toEqual([
    { monitors: [monitor], error: false },
    { monitors: [], error: true },
    { monitors: [monitor], error: false },
  ]);
});

test("an unavailable list is not presented as an empty successful refresh", async () => {
  const states: SidebarState[] = [];
  const feed = createSidebarFeed(async () => undefined, (state) => states.push(state));
  await feed.refresh();
  expect(states).toEqual([{ monitors: [], error: true }]);
});
