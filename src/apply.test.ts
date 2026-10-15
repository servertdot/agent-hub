import { describe, expect, test } from "bun:test";
import {
  formatResults,
  isNoopResult,
  summarizeResults,
} from "./apply.ts";
import type { OpResult } from "./types.ts";

const sample: OpResult[] = [
  {
    harness: "cursor",
    kind: "skill",
    name: "tdd",
    action: "noop",
    status: "ok",
    detail: "already present",
  },
  {
    harness: "claude",
    kind: "skill",
    name: "tdd",
    action: "would-enable",
    status: "planned",
    detail: "symlink",
  },
  {
    harness: "codex",
    kind: "mcp",
    name: "fff",
    action: "disable",
    status: "ok",
  },
  {
    harness: "pi",
    kind: "mcp",
    name: "x",
    action: "enable",
    status: "skipped",
    detail: "missing",
  },
];

describe("formatResults", () => {
  test("hides noop by default and prints summary", () => {
    const out = formatResults(sample);
    expect(out).not.toContain("noop — already present");
    expect(out).toContain("would-enable");
    expect(out).toContain("disable");
    expect(out).toContain("4 checked");
    expect(out).toContain("1 planned");
    expect(out).toContain("1 changed");
    expect(out).toContain("1 skipped");
    expect(out).toContain("1 noop");
  });

  test("verbose shows noop rows", () => {
    const out = formatResults(sample, { verbose: true });
    expect(out).toContain("already present");
  });

  test("all-noop is a short message", () => {
    const out = formatResults([sample[0]!]);
    expect(out.startsWith("(no changes)")).toBe(true);
    expect(out).toContain("1 noop");
  });
});

describe("summarizeResults", () => {
  test("counts buckets", () => {
    expect(summarizeResults(sample)).toEqual({
      total: 4,
      noop: 1,
      planned: 1,
      changed: 1,
      skipped: 1,
      error: 0,
    });
    expect(isNoopResult(sample[0]!)).toBe(true);
  });
});
