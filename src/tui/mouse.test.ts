import { describe, expect, test } from "bun:test";
import {
  consumeSgrMouse,
  hitHarnessRow,
  hitKindBulk,
  hitMainTab,
  hitSidebar,
  kindBulkOffChrome,
  kindBulkOnChrome,
  kindSectionHits,
  mainTabChrome,
} from "./mouse.ts";
import { SIDEBAR_WIDTH } from "./layout.ts";

describe("consumeSgrMouse", () => {
  test("parses left-button press", () => {
    const { clicks, pending } = consumeSgrMouse("\x1b[<0;5;2M");
    expect(pending).toBe("");
    expect(clicks).toEqual([{ column: 4, row: 1 }]);
  });

  test("ignores button release and wheel", () => {
    expect(consumeSgrMouse("\x1b[<0;5;2m").clicks).toEqual([]);
    expect(consumeSgrMouse("\x1b[<64;5;2M").clicks).toEqual([]);
  });

  test("carries incomplete escape across chunks", () => {
    const a = consumeSgrMouse("\x1b[<0;12;");
    expect(a.clicks).toEqual([]);
    expect(a.pending).toBe("\x1b[<0;12;");
    const b = consumeSgrMouse("3M", a.pending);
    expect(b.pending).toBe("");
    expect(b.clicks).toEqual([{ column: 11, row: 2 }]);
  });
});

describe("main tab hit testing", () => {
  test("maps columns to Skills / MCP / Harnesses", () => {
    const counts = { skill: 12, mcp: 3, harness: 5 };
    const { tabs } = kindSectionHits(counts);
    const skill = mainTabChrome("skill", 0, 12);
    const mcp = mainTabChrome("mcp", 1, 3);
    const harness = mainTabChrome("harness", 2, 5);
    const bulkW = kindBulkOnChrome().length + kindBulkOffChrome().length;
    const mcpStart = skill.length + bulkW;
    const harnessStart = mcpStart + mcp.length + bulkW;

    expect(tabs[0]).toEqual({
      tab: "skill",
      startCol: 0,
      endCol: skill.length,
    });
    expect(tabs[1]).toEqual({
      tab: "mcp",
      startCol: mcpStart,
      endCol: mcpStart + mcp.length,
    });
    expect(tabs[2]).toEqual({
      tab: "harness",
      startCol: harnessStart,
      endCol: harnessStart + harness.length,
    });

    expect(hitMainTab(0, 1, tabs)).toBe("skill");
    expect(hitMainTab(mcpStart, 1, tabs)).toBe("mcp");
    expect(hitMainTab(harnessStart, 1, tabs)).toBe("harness");
    expect(hitMainTab(skill.length - 1, 1, tabs)).toBe("skill");
    expect(hitMainTab(0, 0, tabs)).toBeNull();
    expect(hitMainTab(harnessStart + harness.length, 1, tabs)).toBeNull();
  });

  test("respects main-panel column offset", () => {
    const { tabs } = kindSectionHits(
      { skill: 1, mcp: 1, harness: 2 },
      SIDEBAR_WIDTH,
    );
    expect(tabs[0]!.startCol).toBe(SIDEBAR_WIDTH);
    expect(hitMainTab(SIDEBAR_WIDTH, 1, tabs)).toBe("skill");
    expect(hitMainTab(0, 1, tabs)).toBeNull();
  });

  test("bulk on/off only on Skills and MCP", () => {
    const { tabs, bulk } = kindSectionHits({ skill: 2, mcp: 1, harness: 5 });
    const skillTab = mainTabChrome("skill", 0, 2);
    const on = kindBulkOnChrome();
    const off = kindBulkOffChrome();

    expect(tabs[0]).toEqual({
      tab: "skill",
      startCol: 0,
      endCol: skillTab.length,
    });
    expect(bulk).toHaveLength(4);
    expect(bulk[0]).toEqual({
      kind: "skill",
      enabled: true,
      startCol: skillTab.length,
      endCol: skillTab.length + on.length,
    });
    expect(bulk[1]).toEqual({
      kind: "skill",
      enabled: false,
      startCol: skillTab.length + on.length,
      endCol: skillTab.length + on.length + off.length,
    });
    expect(hitKindBulk(skillTab.length, 1, bulk)?.enabled).toBe(true);
    expect(
      hitKindBulk(skillTab.length + on.length, 1, bulk)?.enabled,
    ).toBe(false);
  });

  test("hitHarnessRow maps list rows", () => {
    const opts = { sidebarWidth: SIDEBAR_WIDTH, listTop: 3, count: 5 };
    expect(hitHarnessRow(SIDEBAR_WIDTH, 3, opts)).toBe(0);
    expect(hitHarnessRow(SIDEBAR_WIDTH + 2, 5, opts)).toBe(2);
    expect(hitHarnessRow(SIDEBAR_WIDTH, 8, opts)).toBeNull();
    expect(hitHarnessRow(0, 3, opts)).toBeNull();
  });
});

describe("sidebar hit testing", () => {
  test("maps rows to profiles and + new", () => {
    const names = ["lab", "stable"];
    const opts = { width: SIDEBAR_WIDTH, listTop: 2 };
    expect(hitSidebar(0, 2, names, opts)).toEqual({
      type: "profile",
      name: "lab",
      index: 0,
    });
    expect(hitSidebar(5, 3, names, opts)).toEqual({
      type: "profile",
      name: "stable",
      index: 1,
    });
    expect(hitSidebar(0, 4, names, opts)).toEqual({ type: "new" });
    expect(hitSidebar(SIDEBAR_WIDTH, 2, names, opts)).toBeNull();
    expect(hitSidebar(0, 1, names, opts)).toBeNull();
  });
});
