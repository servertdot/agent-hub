import { describe, expect, test } from "bun:test";
import {
  baselineFlag,
  buildFullProfile,
  cellKey,
  cycleMainTab,
  cycleProfileName,
  defaultHarnessEnabled,
  effectiveFlag,
  harnessColumns,
  loadProfileIntoState,
  newProfileIntoState,
  setKindFlags,
  toggleCell,
  toggleHarness,
  visibleRows,
  type ViewState,
} from "./model.ts";
import type { MatrixRow, Profile } from "../types.ts";

const row: MatrixRow = {
  kind: "skill",
  name: "tdd",
  flags: { cursor: true, claude: false, codex: false, pi: false, omp: false },
};

function base(over: Partial<ViewState> = {}): ViewState {
  return {
    rows: [row],
    staged: new Map(),
    cursor: 0,
    harnessTab: "all",
    mainTab: "skill",
    query: "",
    sort: "name",
    profileName: "tui-session",
    harnessEnabled: defaultHarnessEnabled(),
    ...over,
  };
}

describe("tui model", () => {
  test("toggle stages then clears when back to live", () => {
    let s = base();
    s = toggleCell(s, row, "cursor");
    expect(effectiveFlag(row, "cursor", s.staged, s.profile)).toBe(false);
    expect(s.staged.has(cellKey("skill", "tdd", "cursor"))).toBe(true);
    s = toggleCell(s, row, "cursor");
    expect(s.staged.size).toBe(0);
    expect(effectiveFlag(row, "cursor", s.staged, s.profile)).toBe(true);
  });

  test("profile baseline overrides live until staged", () => {
    const profile: Profile = {
      name: "lab",
      skills: {
        tdd: {
          cursor: false,
          claude: true,
          codex: false,
          pi: false,
          omp: false,
        },
      },
      mcp: {},
    };
    expect(baselineFlag(row, "cursor", profile)).toBe(false);
    expect(baselineFlag(row, "claude", profile)).toBe(true);
    expect(effectiveFlag(row, "cursor", new Map(), profile)).toBe(false);
    let s = base({ profile, profileName: "lab" });
    s = toggleCell(s, row, "cursor");
    expect(effectiveFlag(row, "cursor", s.staged, s.profile)).toBe(true);
    expect(s.staged.has(cellKey("skill", "tdd", "cursor"))).toBe(true);
    s = toggleCell(s, row, "cursor");
    expect(s.staged.size).toBe(0);
  });

  test("buildFullProfile writes complete matrix from effective flags", () => {
    const profile: Profile = {
      name: "lab",
      skills: {
        tdd: {
          cursor: false,
          claude: true,
          codex: false,
          pi: false,
          omp: true,
        },
      },
      mcp: {},
    };
    const s = base({ profile, profileName: "lab" });
    const built = buildFullProfile(s, "test");
    expect(built.name).toBe("lab");
    expect(built.skills.tdd).toEqual({
      cursor: false,
      claude: true,
      codex: false,
      pi: false,
      omp: true,
    });
  });

  test("new profile starts empty (no inherited rows)", () => {
    const s = newProfileIntoState(base(), "clean");
    expect(s.profileName).toBe("clean");
    expect(s.rows).toEqual([]);
    expect(s.profile?.skills).toEqual({});
    expect(s.profile?.mcp).toEqual({});
    const built = buildFullProfile(s);
    expect(built.skills).toEqual({});
    expect(built.mcp).toEqual({});
  });

  test("loadProfileIntoState resets staged", () => {
    let s = base();
    s = toggleCell(s, row, "cursor");
    expect(s.staged.size).toBe(1);
    const profile: Profile = {
      name: "stable",
      skills: {
        tdd: {
          cursor: true,
          claude: false,
          codex: false,
          pi: false,
          omp: false,
        },
      },
      mcp: {},
    };
    s = loadProfileIntoState(s, profile);
    expect(s.profileName).toBe("stable");
    expect(s.staged.size).toBe(0);
    expect(s.profile?.name).toBe("stable");
  });

  test("cycleProfileName", () => {
    expect(cycleProfileName(["a", "b", "c"], "b", 1)).toBe("c");
    expect(cycleProfileName(["a", "b", "c"], "c", 1)).toBe("a");
    expect(cycleProfileName(["a", "b", "c"], "missing", 0)).toBe("a");
    expect(cycleProfileName([], "x", 1)).toBeUndefined();
  });

  test("kind tab isolates skills from mcp", () => {
    const rows: MatrixRow[] = [
      row,
      { kind: "mcp", name: "fff", flags: { cursor: true } },
      { kind: "skill", name: "review", flags: { cursor: true } },
    ];
    expect(visibleRows(base({ rows, mainTab: "skill" })).map((r) => r.name)).toEqual([
      "review",
      "tdd",
    ]);
    expect(visibleRows(base({ rows, mainTab: "mcp" })).map((r) => r.name)).toEqual([
      "fff",
    ]);
    expect(visibleRows(base({ rows, mainTab: "harness" }))).toEqual([]);
  });

  test("filter by query within kind tab", () => {
    const rows: MatrixRow[] = [
      row,
      { kind: "mcp", name: "fff", flags: { cursor: true } },
      { kind: "skill", name: "find-skills", flags: { cursor: true } },
    ];
    const s = base({ rows, mainTab: "skill", query: "find" });
    expect(visibleRows(s).map((r) => r.name)).toEqual(["find-skills"]);
  });

  test("sort by cost desc", () => {
    const rows: MatrixRow[] = [
      { kind: "skill", name: "tiny", flags: { cursor: true }, tokens: 10 },
      { kind: "skill", name: "heavy", flags: { cursor: true }, tokens: 1500 },
      { kind: "skill", name: "mid", flags: { cursor: true }, tokens: 100 },
    ];
    const s = base({ rows, mainTab: "skill", sort: "cost" });
    expect(visibleRows(s).map((r) => r.name)).toEqual(["heavy", "mid", "tiny"]);
  });

  test("cycleMainTab", () => {
    expect(cycleMainTab("skill")).toBe("mcp");
    expect(cycleMainTab("mcp")).toBe("harness");
    expect(cycleMainTab("harness")).toBe("skill");
  });

  test("setKindFlags enables/disables a whole section", () => {
    const rows: MatrixRow[] = [
      row,
      {
        kind: "skill",
        name: "review",
        flags: {
          cursor: false,
          claude: false,
          codex: false,
          pi: false,
          omp: false,
        },
      },
      {
        kind: "mcp",
        name: "fff",
        flags: {
          cursor: true,
          claude: true,
          codex: false,
          pi: false,
          omp: false,
        },
      },
    ];
    let s = base({ rows });
    s = setKindFlags(s, "skill", true, ["cursor"]);
    expect(effectiveFlag(rows[0]!, "cursor", s.staged, s.profile)).toBe(true);
    expect(effectiveFlag(rows[1]!, "cursor", s.staged, s.profile)).toBe(true);
    expect(effectiveFlag(rows[2]!, "cursor", s.staged, s.profile)).toBe(true);
    expect(s.staged.has(cellKey("mcp", "fff", "cursor"))).toBe(false);

    s = setKindFlags(s, "skill", false, ["cursor"]);
    expect(effectiveFlag(rows[0]!, "cursor", s.staged, s.profile)).toBe(false);
    expect(effectiveFlag(rows[1]!, "cursor", s.staged, s.profile)).toBe(false);
  });

  test("toggleHarness and harnessColumns respect enabled flags", () => {
    let s = base();
    const off = toggleHarness(s, "claude");
    expect(off.error).toBeUndefined();
    s = off.state;
    expect(s.harnessEnabled.claude).toBe(false);
    expect(harnessColumns("all", s.harnessEnabled)).toEqual([
      "cursor",
      "codex",
      "pi",
      "omp",
    ]);

    // cannot disable the last harness
    s = {
      ...s,
      harnessEnabled: defaultHarnessEnabled({
        cursor: true,
        claude: false,
        codex: false,
        pi: false,
        omp: false,
      }),
    };
    const blocked = toggleHarness(s, "cursor");
    expect(blocked.error).toBeTruthy();
    expect(blocked.state.harnessEnabled.cursor).toBe(true);
  });
});
