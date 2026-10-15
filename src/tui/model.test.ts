import { describe, expect, test } from "bun:test";
import {
  cellKey,
  effectiveFlag,
  toggleCell,
  visibleRows,
  type ViewState,
} from "./model.ts";
import type { MatrixRow } from "../types.ts";

const row: MatrixRow = {
  kind: "skill",
  name: "tdd",
  flags: { cursor: true, claude: false },
};

function base(over: Partial<ViewState> = {}): ViewState {
  return {
    rows: [row],
    staged: new Map(),
    cursor: 0,
    harnessTab: "all",
    kindFilter: "all",
    query: "",
    ...over,
  };
}

describe("tui model", () => {
  test("toggle stages then clears when back to live", () => {
    let s = base();
    s = toggleCell(s, row, "cursor");
    expect(effectiveFlag(row, "cursor", s.staged)).toBe(false);
    expect(s.staged.has(cellKey("skill", "tdd", "cursor"))).toBe(true);
    s = toggleCell(s, row, "cursor");
    expect(s.staged.size).toBe(0);
    expect(effectiveFlag(row, "cursor", s.staged)).toBe(true);
  });

  test("filter by query and kind", () => {
    const rows: MatrixRow[] = [
      row,
      { kind: "mcp", name: "fff", flags: { cursor: true } },
    ];
    const s = base({ rows, query: "ff", kindFilter: "mcp" });
    expect(visibleRows(s).map((r) => r.name)).toEqual(["fff"]);
  });
});
