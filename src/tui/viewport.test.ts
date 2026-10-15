import { describe, expect, test } from "bun:test";
import { pageSize, scrollToKeepCursor, windowSlice } from "./viewport.ts";

describe("viewport", () => {
  test("pageSize leaves chrome room", () => {
    expect(pageSize(24, 7)).toBe(17);
    expect(pageSize(10, 7)).toBe(5); // floor
  });

  test("scroll follows cursor down and up", () => {
    expect(scrollToKeepCursor(0, 0, 10, 100)).toBe(0);
    expect(scrollToKeepCursor(15, 0, 10, 100)).toBe(6); // 15 - 10 + 1
    expect(scrollToKeepCursor(3, 6, 10, 100)).toBe(3);
    expect(scrollToKeepCursor(99, 0, 10, 100)).toBe(90);
  });

  test("windowSlice", () => {
    const items = [...Array(20)].map((_, i) => i);
    const { slice, start, end } = windowSlice(items, 5, 10);
    expect(start).toBe(5);
    expect(end).toBe(15);
    expect(slice).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
});
