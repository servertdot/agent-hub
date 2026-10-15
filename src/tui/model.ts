import type { HarnessId, MatrixRow, ResourceKind } from "../types.ts";
import { HARNESSES } from "../types.ts";

export type CellKey = `${ResourceKind}:${string}:${HarnessId}`;

export type StageMap = Map<CellKey, boolean>;

export function cellKey(
  kind: ResourceKind,
  name: string,
  harness: HarnessId,
): CellKey {
  return `${kind}:${name}:${harness}`;
}

export type SortMode = "name" | "cost";

export type ViewState = {
  rows: MatrixRow[];
  /** Staged desired flags; absent = use live flags. */
  staged: StageMap;
  cursor: number;
  harnessTab: "all" | HarnessId;
  kindFilter: "all" | ResourceKind;
  query: string;
  sort: SortMode;
};

export function effectiveFlag(
  row: MatrixRow,
  harness: HarnessId,
  staged: StageMap,
): boolean | undefined {
  const k = cellKey(row.kind, row.name, harness);
  if (staged.has(k)) return staged.get(k);
  return row.flags[harness];
}

export function toggleCell(
  state: ViewState,
  row: MatrixRow,
  harness: HarnessId,
): ViewState {
  const live = row.flags[harness];
  if (live === undefined && !state.staged.has(cellKey(row.kind, row.name, harness))) {
    // unknown cell — stage to true
    const staged = new Map(state.staged);
    staged.set(cellKey(row.kind, row.name, harness), true);
    return { ...state, staged };
  }
  const current = effectiveFlag(row, harness, state.staged) ?? false;
  const next = !current;
  const staged = new Map(state.staged);
  const k = cellKey(row.kind, row.name, harness);
  if (next === live) staged.delete(k);
  else staged.set(k, next);
  return { ...state, staged };
}

export function visibleRows(state: ViewState): MatrixRow[] {
  const q = state.query.trim().toLowerCase();
  const filtered = state.rows.filter((r) => {
    if (state.kindFilter !== "all" && r.kind !== state.kindFilter) return false;
    if (state.harnessTab !== "all" && r.flags[state.harnessTab] === undefined) {
      // still show if staged for that harness
      if (!state.staged.has(cellKey(r.kind, r.name, state.harnessTab))) return false;
    }
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || r.kind.includes(q);
  });
  if (state.sort === "cost") {
    return [...filtered].sort((a, b) => {
      const d = (b.tokens ?? 0) - (a.tokens ?? 0);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }
  return [...filtered].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.name.localeCompare(b.name);
  });
}

/** Build a profile-shaped patch from staged cells. */
export function stagedToProfileMaps(state: ViewState): {
  skills: Record<string, Partial<Record<HarnessId, boolean>>>;
  mcp: Record<string, Partial<Record<HarnessId, boolean>>>;
} {
  const skills: Record<string, Partial<Record<HarnessId, boolean>>> = {};
  const mcp: Record<string, Partial<Record<HarnessId, boolean>>> = {};
  for (const [key, value] of state.staged) {
    const [kind, name, harness] = key.split(":") as [
      ResourceKind,
      string,
      HarnessId,
    ];
    const bucket = kind === "skill" ? skills : mcp;
    bucket[name] ??= {};
    bucket[name]![harness] = value;
  }
  return { skills, mcp };
}

export function harnessColumns(tab: ViewState["harnessTab"]): HarnessId[] {
  return tab === "all" ? [...HARNESSES] : [tab];
}
