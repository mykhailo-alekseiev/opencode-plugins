export const MAX_LINE_LENGTH = 4_096;

export function cutLine(line: string, max = MAX_LINE_LENGTH): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function createLineSplitter(onLine: (line: string) => void) {
  let pending = "";

  const emit = (line: string) => {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (clean.trim()) onLine(cutLine(clean));
  };

  return {
    push(chunk: string) {
      const parts = (pending + chunk).split("\n");
      pending = (parts.pop() ?? "").slice(0, MAX_LINE_LENGTH + 1);
      for (const part of parts) emit(part);
    },
    end() {
      if (pending) emit(pending);
      pending = "";
    },
  };
}

export function createTail(size: number) {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => {
    lines.push(line);
    if (lines.length > size) lines.shift();
  });

  return {
    push: splitter.push,
    lines() {
      splitter.end();
      return [...lines];
    },
  };
}
