import { expect, test } from "bun:test";
import { createLineSplitter, createTail, cutLine, MAX_LINE_LENGTH } from "../src/lines";

function split(chunks: string[]) {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  for (const chunk of chunks) splitter.push(chunk);
  splitter.end();
  return lines;
}

test("joins lines split across chunks", () => {
  expect(split(["fi", "rst\nsec", "ond\nthird"])).toEqual(["first", "second", "third"]);
});

test("strips carriage returns and skips blank lines", () => {
  expect(split(["one\r\n\n   \ntwo\r\n"])).toEqual(["one", "two"]);
});

test("emits a line only once it is complete", () => {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  splitter.push("partial");
  expect(lines).toEqual([]);
  splitter.push(" line\n");
  expect(lines).toEqual(["partial line"]);
});

test("cuts long lines", () => {
  const [line] = split(["x".repeat(MAX_LINE_LENGTH * 3), "\n"]);
  expect(line).toBe(`${"x".repeat(MAX_LINE_LENGTH)}…`);
  expect(cutLine("short", 10)).toBe("short");
  expect(cutLine("abcdef", 3)).toBe("abc…");
});

test("tail keeps the newest lines", () => {
  const tail = createTail(2);
  tail.push("one\ntwo\nthr");
  tail.push("ee\nfour");
  expect(tail.lines()).toEqual(["three", "four"]);
});
