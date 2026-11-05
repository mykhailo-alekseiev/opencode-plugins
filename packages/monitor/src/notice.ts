export const MAX_NOTICE_LENGTH = 16 * 1_024;

export type MonitorRef = {
  id: string;
  description: string;
};

export type NoticeEntry = {
  monitor: MonitorRef;
  kind: "line" | "end";
  text: string;
};

export type Notice = {
  text: string;
  monitors: MonitorRef[];
};

export function header(monitor: MonitorRef) {
  return `[monitor ${monitor.id} · ${monitor.description}]`;
}

export function createNoticeBuffer(max = MAX_NOTICE_LENGTH) {
  let entries: NoticeEntry[] = [];
  let size = 0;
  let dropped = 0;

  const measure = (entry: NoticeEntry) => entry.text.length + 1;

  return {
    get empty() {
      return entries.length === 0;
    },
    push(entry: NoticeEntry) {
      entries.push(entry);
      size += measure(entry);
      while (size > max) {
        const index = entries.findIndex((item) => item.kind === "line");
        if (index === -1) break;
        const [removed] = entries.splice(index, 1);
        size -= measure(removed!);
        dropped++;
      }
    },
    take(): Notice | undefined {
      if (entries.length === 0) return undefined;
      const notice = formatNotice(entries, dropped);
      entries = [];
      size = 0;
      dropped = 0;
      return notice;
    },
    clear() {
      entries = [];
      size = 0;
      dropped = 0;
    },
  };
}

export function formatNotice(entries: readonly NoticeEntry[], dropped = 0): Notice {
  const groups = new Map<string, { monitor: MonitorRef; texts: string[] }>();
  for (const entry of entries) {
    const group = groups.get(entry.monitor.id) ?? { monitor: entry.monitor, texts: [] };
    group.texts.push(entry.text);
    groups.set(entry.monitor.id, group);
  }

  const blocks = [...groups.values()].map((group) => [header(group.monitor), ...group.texts].join("\n"));
  if (dropped > 0) blocks.unshift(`… ${dropped} earlier ${dropped === 1 ? "line" : "lines"} dropped`);

  return {
    text: blocks.join("\n\n"),
    monitors: [...groups.values()].map((group) => group.monitor),
  };
}
