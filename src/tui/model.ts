import type { HarnessId, MatrixRow, Profile, ResourceKind } from "../types.ts";
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

/** Top-level editor tabs: resource matrices + hub harness toggles. */
export type MainTab = ResourceKind | "harness";

export type HarnessEnabled = Record<HarnessId, boolean>;

export type ViewState = {
  rows: MatrixRow[];
  /** Staged overrides on top of profile baseline (or live when no profile). */
  staged: StageMap;
  cursor: number;
  harnessTab: "all" | HarnessId;
  /** Active top tab — skills, MCP, or harness enable list. */
  mainTab: MainTab;
  query: string;
  sort: SortMode;
  /** Working profile name (saved / applied under this name). */
  profileName: string;
  /** Loaded profile desired flags; undefined = baseline is live discovery. */
  profile?: Profile;
  /** Working hub harness on/off flags (from config.yaml). */
  harnessEnabled: HarnessEnabled;
};

export const MAIN_TABS: MainTab[] = ["skill", "mcp", "harness"];

/** Resource-only tabs (have bulk on/off). */
export const KIND_TABS: ResourceKind[] = ["skill", "mcp"];

export function isResourceTab(tab: MainTab): tab is ResourceKind {
  return tab === "skill" || tab === "mcp";
}

export function mainTabLabel(tab: MainTab): string {
  if (tab === "skill") return "Skills";
  if (tab === "mcp") return "MCP";
  return "Harnesses";
}

/** @deprecated alias — prefer mainTabLabel */
export function kindTabLabel(kind: ResourceKind): string {
  return mainTabLabel(kind);
}

export function defaultHarnessEnabled(
  flags?: Partial<Record<HarnessId, boolean>>,
): HarnessEnabled {
  return {
    cursor: flags?.cursor !== false,
    claude: flags?.claude !== false,
    codex: flags?.codex !== false,
    pi: flags?.pi !== false,
    omp: flags?.omp !== false,
  };
}

export function enabledHarnessIds(flags: HarnessEnabled): HarnessId[] {
  return HARNESSES.filter((id) => flags[id] !== false);
}

export function countEnabledHarnesses(flags: HarnessEnabled): number {
  return enabledHarnessIds(flags).length;
}

export function countByKind(
  rows: MatrixRow[],
): Record<ResourceKind, number> {
  return {
    skill: rows.filter((r) => r.kind === "skill").length,
    mcp: rows.filter((r) => r.kind === "mcp").length,
  };
}

/** Desired flag from a saved profile, if present. */
export function profileDesired(
  profile: Profile | undefined,
  kind: ResourceKind,
  name: string,
  harness: HarnessId,
): boolean | undefined {
  if (!profile) return undefined;
  const bucket = kind === "skill" ? profile.skills : profile.mcp;
  return bucket[name]?.[harness];
}

/** Baseline before local staged edits: profile entry, else live discovery. */
export function baselineFlag(
  row: MatrixRow,
  harness: HarnessId,
  profile: Profile | undefined,
): boolean | undefined {
  const fromProfile = profileDesired(profile, row.kind, row.name, harness);
  if (fromProfile !== undefined) return fromProfile;
  return row.flags[harness];
}

export function effectiveFlag(
  row: MatrixRow,
  harness: HarnessId,
  staged: StageMap,
  profile?: Profile,
): boolean | undefined {
  const k = cellKey(row.kind, row.name, harness);
  if (staged.has(k)) return staged.get(k);
  return baselineFlag(row, harness, profile);
}

export function toggleCell(
  state: ViewState,
  row: MatrixRow,
  harness: HarnessId,
): ViewState {
  const base = baselineFlag(row, harness, state.profile);
  const k = cellKey(row.kind, row.name, harness);
  if (base === undefined && !state.staged.has(k)) {
    const staged = new Map(state.staged);
    staged.set(k, true);
    return { ...state, staged };
  }
  const current = effectiveFlag(row, harness, state.staged, state.profile) ?? false;
  const next = !current;
  const staged = new Map(state.staged);
  if (next === (base ?? false)) staged.delete(k);
  else staged.set(k, next);
  return { ...state, staged };
}

/**
 * Enable or disable every resource of `kind` across the given harnesses
 * (defaults to all harnesses). Stages only cells that differ from baseline.
 */
export function setKindFlags(
  state: ViewState,
  kind: ResourceKind,
  enabled: boolean,
  harnesses: readonly HarnessId[] = HARNESSES,
): ViewState {
  const staged = new Map(state.staged);
  for (const row of state.rows) {
    if (row.kind !== kind) continue;
    for (const h of harnesses) {
      const base = baselineFlag(row, h, state.profile);
      const k = cellKey(row.kind, row.name, h);
      if (enabled === (base ?? false)) staged.delete(k);
      else staged.set(k, enabled);
    }
  }
  return { ...state, staged };
}

/** Toggle a hub harness. Refuses to turn off the last enabled one. */
export function toggleHarness(
  state: ViewState,
  id: HarnessId,
): { state: ViewState; error?: string } {
  const currently = state.harnessEnabled[id] !== false;
  if (currently && countEnabledHarnesses(state.harnessEnabled) <= 1) {
    return { state, error: "keep at least one harness enabled" };
  }
  return {
    state: {
      ...state,
      harnessEnabled: {
        ...state.harnessEnabled,
        [id]: !currently,
      },
    },
  };
}

export function setAllHarnesses(
  state: ViewState,
  enabled: boolean,
): ViewState {
  if (!enabled) {
    // leave cursor on so apply still has a target
    const next = defaultHarnessEnabled({
      cursor: true,
      claude: false,
      codex: false,
      pi: false,
      omp: false,
    });
    return { ...state, harnessEnabled: next };
  }
  return { ...state, harnessEnabled: defaultHarnessEnabled() };
}

export function harnessFlagsEqual(a: HarnessEnabled, b: HarnessEnabled): boolean {
  return HARNESSES.every((id) => (a[id] !== false) === (b[id] !== false));
}

export function visibleRows(state: ViewState): MatrixRow[] {
  if (!isResourceTab(state.mainTab)) return [];
  const kind = state.mainTab;
  const q = state.query.trim().toLowerCase();
  const filtered = state.rows.filter((r) => {
    if (r.kind !== kind) return false;
    if (state.harnessTab !== "all" && r.flags[state.harnessTab] === undefined) {
      const h = state.harnessTab;
      if (
        !state.staged.has(cellKey(r.kind, r.name, h)) &&
        profileDesired(state.profile, r.kind, r.name, h) === undefined
      ) {
        return false;
      }
    }
    if (!q) return true;
    return r.name.toLowerCase().includes(q);
  });
  if (state.sort === "cost") {
    return [...filtered].sort((a, b) => {
      const d = (b.tokens ?? 0) - (a.tokens ?? 0);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }
  return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
}

export function cycleMainTab(current: MainTab): MainTab {
  const i = MAIN_TABS.indexOf(current);
  return MAIN_TABS[(i + 1) % MAIN_TABS.length]!;
}

/** @deprecated use cycleMainTab */
export function cycleKindTab(current: ResourceKind): ResourceKind {
  return current === "skill" ? "mcp" : "skill";
}

/** Build a profile-shaped patch from staged cells only (sparse). */
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

/**
 * Full boolean matrix for the working profile (every discovered row × harness).
 * Keeps profile entries that are not in the current row list (so a stale/partial
 * discover cannot wipe skills on save).
 */
export function buildFullProfile(state: ViewState, description?: string): Profile {
  const skills: Profile["skills"] = { ...(state.profile?.skills ?? {}) };
  const mcp: Profile["mcp"] = { ...(state.profile?.mcp ?? {}) };

  for (const row of state.rows) {
    const flags = {} as Record<HarnessId, boolean>;
    for (const h of HARNESSES) {
      flags[h] =
        effectiveFlag(row, h, state.staged, state.profile) === true;
    }
    if (row.kind === "skill") skills[row.name] = flags;
    else mcp[row.name] = flags;
  }

  return {
    name: state.profileName,
    description:
      description ??
      state.profile?.description ??
      `Edited in TUI at ${new Date().toISOString()}`,
    skills,
    mcp,
  };
}

/** Switch editor to another profile; drops local staged edits. */
export function loadProfileIntoState(
  state: ViewState,
  profile: Profile,
  rows?: MatrixRow[],
): ViewState {
  return {
    ...state,
    profileName: profile.name,
    profile,
    rows: rows ?? state.rows,
    staged: new Map(),
    cursor: 0,
  };
}

/** Start a brand-new empty profile (no skills/MCP, no inherited discover rows). */
export function newProfileIntoState(
  state: ViewState,
  name: string,
): ViewState {
  return {
    ...state,
    profileName: name,
    profile: {
      name,
      description: `Empty profile created ${new Date().toISOString()}`,
      skills: {},
      mcp: {},
    },
    rows: [],
    staged: new Map(),
    cursor: 0,
  };
}

export function cycleProfileName(
  names: string[],
  current: string,
  delta: number,
): string | undefined {
  if (names.length === 0) return undefined;
  const i = names.indexOf(current);
  const from = i < 0 ? 0 : i;
  const next = (from + delta + names.length * 8) % names.length;
  return names[next];
}

/** Matrix columns: enabled hub harnesses, optionally narrowed by harnessTab. */
export function harnessColumns(
  tab: ViewState["harnessTab"],
  harnessEnabled: HarnessEnabled = defaultHarnessEnabled(),
): HarnessId[] {
  const enabled = enabledHarnessIds(harnessEnabled);
  if (tab === "all") return enabled;
  return enabled.includes(tab) ? [tab] : [];
}
