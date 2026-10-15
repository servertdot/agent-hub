import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { HarnessId, MatrixRow, Profile } from "../types.ts";
import { HARNESSES } from "../types.ts";
import { loadProfile, saveConfig, saveProfile } from "../config.ts";
import { discoverMatrix } from "../discover.ts";
import { formatTok, liveTokenTotal } from "../cost.ts";
import { glyphs, roles } from "./theme.ts";
import type { TuiResult } from "./types.ts";
import {
  buildFullProfile,
  cellKey,
  countByKind,
  countEnabledHarnesses,
  cycleMainTab,
  defaultHarnessEnabled,
  effectiveFlag,
  harnessColumns,
  harnessFlagsEqual,
  isResourceTab,
  MAIN_TABS,
  mainTabLabel,
  loadProfileIntoState,
  newProfileIntoState,
  setAllHarnesses,
  setKindFlags,
  toggleCell,
  toggleHarness,
  visibleRows,
  type HarnessEnabled,
  type MainTab,
  type ViewState,
} from "./model.ts";
import { scrollToKeepCursor, windowSlice } from "./viewport.ts";
import {
  hitHarnessRow,
  hitKindBulk,
  hitMainTab,
  hitSidebar,
  kindBulkOffChrome,
  kindBulkOnChrome,
  kindSectionHits,
  mainTabChrome,
} from "./mouse.ts";
import { useMouse } from "./useMouse.ts";
import {
  BODY_TOP,
  MAIN_LIST_CHROME,
  PROFILE_LIST_TOP,
  SIDEBAR_WIDTH,
  bodyHeight,
  mainListPage,
} from "./layout.ts";

export type { TuiResult };

const NAME_WIDTH = 28;
const LIST_TOP = BODY_TOP + MAIN_LIST_CHROME;

type Mode = "main" | "search" | "newName";
type FocusPane = "sidebar" | "main";

type Props = {
  rows: MatrixRow[];
  profileName?: string;
  profile?: Profile;
  profileNames?: string[];
  /** Hub harness flags from config.yaml */
  harnesses?: Partial<Record<HarnessId, boolean>>;
  dryRun?: boolean;
  onDone: (result: TuiResult) => void;
};

export function App({
  rows,
  profileName = "tui-session",
  profile,
  profileNames: initialNames = [],
  harnesses,
  dryRun = false,
  onDone,
}: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const initialHarness = defaultHarnessEnabled(harnesses);
  const [termRows, setTermRows] = useState(stdout?.rows ?? 24);
  const [scrollTop, setScrollTop] = useState(0);
  const [savedHarness, setSavedHarness] =
    useState<HarnessEnabled>(initialHarness);
  const [state, setState] = useState<ViewState>({
    rows,
    staged: new Map(),
    cursor: 0,
    harnessTab: "all",
    mainTab: "skill",
    query: "",
    sort: "name",
    profileName: profile?.name ?? profileName,
    profile,
    harnessEnabled: initialHarness,
  });
  const [mode, setMode] = useState<Mode>("main");
  const [focus, setFocus] = useState<FocusPane>("main");
  const [names, setNames] = useState(() => {
    const set = new Set(initialNames);
    set.add(profile?.name ?? profileName);
    return [...set].sort();
  });
  const [sideCursor, setSideCursor] = useState(() => {
    const list = [...new Set(initialNames)].sort();
    const current = profile?.name ?? profileName;
    if (!list.includes(current)) list.push(current);
    list.sort();
    return Math.max(0, list.indexOf(current));
  });
  const [newName, setNewName] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const [col, setCol] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onResize = () => setTermRows(stdout?.rows ?? 24);
    stdout?.on?.("resize", onResize);
    return () => {
      stdout?.off?.("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [flash]);

  const shown = useMemo(() => visibleRows(state), [state]);
  const cols = harnessColumns(state.harnessTab, state.harnessEnabled);
  const stagedCount = state.staged.size;
  const harnessDirty = !harnessFlagsEqual(state.harnessEnabled, savedHarness);
  const dirty = stagedCount > 0 || harnessDirty;
  const page = mainListPage(termRows);
  const bodyH = bodyHeight(termRows);

  useEffect(() => {
    setScrollTop((top) =>
      scrollToKeepCursor(state.cursor, top, page, shown.length),
    );
  }, [
    state.cursor,
    page,
    shown.length,
    state.harnessTab,
    state.mainTab,
    state.query,
    state.sort,
  ]);

  const { slice, start, end } = windowSlice(shown, scrollTop, page);

  const liveTok = useMemo(() => {
    const harness =
      state.harnessTab === "all" ? undefined : state.harnessTab;
    return liveTokenTotal(shown, harness);
  }, [shown, state.harnessTab]);

  const moveCursor = (next: number, max: number) => {
    const clamped = Math.max(0, Math.min(max, next));
    setState((s) => ({ ...s, cursor: clamped }));
  };

  const counts = useMemo(() => countByKind(state.rows), [state.rows]);
  const sectionCounts = useMemo(
    () => ({
      ...counts,
      harness: countEnabledHarnesses(state.harnessEnabled),
    }),
    [counts, state.harnessEnabled],
  );
  const sectionHits = useMemo(
    () => kindSectionHits(sectionCounts, SIDEBAR_WIDTH),
    [sectionCounts],
  );

  const applyKindFlags = (kind: "skill" | "mcp", enabled: boolean) => {
    const harnessesCols = harnessColumns(state.harnessTab, state.harnessEnabled);
    const scope =
      state.harnessTab === "all" ? "enabled harnesses" : state.harnessTab;
    setState((s) => {
      const next = setKindFlags(s, kind, enabled, harnessesCols);
      return kind === s.mainTab ? next : { ...next, mainTab: kind, cursor: 0 };
    });
    setFlash(
      `${mainTabLabel(kind)}: all ${enabled ? "on" : "off"} (${scope})`,
    );
  };

  const applyHarnessToggle = (id: HarnessId) => {
    let error: string | undefined;
    let label = "";
    setState((s) => {
      const result = toggleHarness(s, id);
      error = result.error;
      if (error) return s;
      label = `${id}: ${result.state.harnessEnabled[id] ? "on" : "off"}`;
      return result.state;
    });
    setFlash(error ?? label);
  };

  const selectProfile = async (name: string) => {
    if (busy) return;
    if (name === state.profileName && !dirty) {
      setFocus("main");
      return;
    }
    setBusy(true);
    try {
      const loaded = await loadProfile(name);
      const nextRows = await discoverMatrix({ profileName: name });
      setState((s) => loadProfileIntoState(s, loaded, nextRows));
      setSideCursor(Math.max(0, names.indexOf(name)));
      setFlash(
        dirty
          ? `loaded ${name} (${nextRows.filter((r) => r.kind === "skill").length} skills, discarded edits)`
          : `loaded ${name} (${nextRows.filter((r) => r.kind === "skill").length} skills)`,
      );
      setFocus("main");
      setMode("main");
    } catch (err) {
      setFlash(
        `load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const persistAll = async (): Promise<Profile> => {
    const built = buildFullProfile(state);
    await saveProfile(built);
    if (!harnessFlagsEqual(state.harnessEnabled, savedHarness)) {
      await saveConfig({ harnesses: state.harnessEnabled });
      setSavedHarness({ ...state.harnessEnabled });
    }
    setState((s) => ({
      ...s,
      profile: built,
      profileName: built.name,
      staged: new Map(),
    }));
    setNames((prev) =>
      prev.includes(built.name) ? prev : [...prev, built.name].sort(),
    );
    return built;
  };

  const startNewProfile = () => {
    setNewName("");
    setMode("newName");
    setFocus("sidebar");
  };

  const switchTab = (tab: MainTab) => {
    setState((s) => ({ ...s, mainTab: tab, cursor: 0 }));
    setCol(0);
    setFocus("main");
  };

  useMouse((click) => {
    if (mode === "newName" || mode === "search" || busy) return;

    const side = hitSidebar(click.column, click.row, names, {
      width: SIDEBAR_WIDTH,
      listTop: PROFILE_LIST_TOP,
    });
    if (side) {
      setFocus("sidebar");
      if (side.type === "new") {
        startNewProfile();
        return;
      }
      setSideCursor(side.index);
      void selectProfile(side.name);
      return;
    }

    if (click.column < SIDEBAR_WIDTH) {
      setFocus("sidebar");
      return;
    }

    setFocus("main");
    const bulk = hitKindBulk(
      click.column,
      click.row,
      sectionHits.bulk,
      BODY_TOP,
    );
    if (bulk) {
      applyKindFlags(bulk.kind, bulk.enabled);
      return;
    }
    const tab = hitMainTab(
      click.column,
      click.row,
      sectionHits.tabs,
      BODY_TOP,
    );
    if (tab && tab !== state.mainTab) {
      switchTab(tab);
      return;
    }

    if (state.mainTab === "harness") {
      const idx = hitHarnessRow(click.column, click.row, {
        sidebarWidth: SIDEBAR_WIDTH,
        listTop: LIST_TOP,
        count: HARNESSES.length,
      });
      if (idx !== null) {
        setState((s) => ({ ...s, cursor: idx }));
        applyHarnessToggle(HARNESSES[idx]!);
      }
    }
  });

  useInput((input, key) => {
    if (busy) return;

    if (mode === "search") {
      if (key.escape || key.return) {
        setMode("main");
        return;
      }
      if (key.backspace || key.delete) {
        setState((s) => ({ ...s, query: s.query.slice(0, -1), cursor: 0 }));
        return;
      }
      if (input && !key.ctrl) {
        setState((s) => ({ ...s, query: s.query + input, cursor: 0 }));
      }
      return;
    }

    if (mode === "newName") {
      if (key.escape) {
        setMode("main");
        setNewName("");
        return;
      }
      if (key.return) {
        const name = newName.trim();
        if (!name) return;
        setState((s) => newProfileIntoState(s, name));
        setNames((prev) => {
          const next = prev.includes(name) ? prev : [...prev, name].sort();
          setSideCursor(next.indexOf(name));
          return next;
        });
        setFlash(`new profile ${name} (from live)`);
        setNewName("");
        setMode("main");
        setFocus("main");
        return;
      }
      if (key.backspace || key.delete) {
        setNewName((n) => n.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && /^[a-zA-Z0-9._-]$/.test(input)) {
        setNewName((n) => n + input);
      }
      return;
    }

    if (input === "[" || (input === "p" && focus === "main")) {
      setFocus("sidebar");
      setSideCursor((c) => {
        const idx = names.indexOf(state.profileName);
        return idx >= 0 ? idx : c;
      });
      return;
    }
    if (input === "]") {
      setFocus("main");
      return;
    }

    if (focus === "sidebar") {
      if (key.escape) {
        setFocus("main");
        return;
      }
      if (input === "n") {
        startNewProfile();
        return;
      }
      const maxIdx = names.length;
      if (key.upArrow || input === "k") {
        setSideCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSideCursor((c) => Math.min(maxIdx, c + 1));
        return;
      }
      if (key.return || key.rightArrow) {
        if (sideCursor >= names.length) {
          startNewProfile();
          return;
        }
        const name = names[sideCursor];
        if (name) void selectProfile(name);
        return;
      }
      if (input === "w") {
        void (async () => {
          setBusy(true);
          try {
            const built = await persistAll();
            setFlash(
              harnessDirty
                ? `saved ${built.name} + harnesses`
                : `saved ${built.name}`,
            );
          } catch (err) {
            setFlash(
              `save failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            setBusy(false);
          }
        })();
        return;
      }
      if (key.ctrl && input === "c") {
        onDone({ action: "cancel" });
        exit();
      }
      return;
    }

    // main pane
    if (key.escape || (key.ctrl && input === "c")) {
      onDone({ action: "cancel" });
      exit();
      return;
    }

    if (key.return) {
      void (async () => {
        setBusy(true);
        try {
          const built = dryRun
            ? buildFullProfile(state)
            : await persistAll();
          onDone({ action: "apply", profile: built, dryRun });
          exit();
        } catch (err) {
          setFlash(
            `save failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          setBusy(false);
        }
      })();
      return;
    }

    if (input === "w") {
      void (async () => {
        setBusy(true);
        try {
          const built = await persistAll();
          setFlash(
            harnessDirty
              ? `saved ${built.name} + harnesses`
              : `saved ${built.name}`,
          );
        } catch (err) {
          setFlash(
            `save failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          setBusy(false);
        }
      })();
      return;
    }

    if (input === "/" && isResourceTab(state.mainTab)) {
      setMode("search");
      return;
    }

    if (key.tab || input === " ") {
      if (state.mainTab === "harness") {
        const id = HARNESSES[state.cursor];
        if (id) applyHarnessToggle(id);
        return;
      }
      const row = shown[state.cursor];
      if (!row) return;
      const harness = cols[col] ?? cols[0];
      if (!harness) return;
      setState((s) => toggleCell(s, row, harness));
      return;
    }

    if (key.leftArrow) {
      if (state.mainTab === "harness" || col === 0) {
        setFocus("sidebar");
        return;
      }
      setCol((c) => c - 1);
      return;
    }
    if (key.rightArrow) {
      if (state.mainTab === "harness") return;
      if (cols.length === 0) return;
      setCol((c) => (c + 1) % cols.length);
      return;
    }

    const maxCursor =
      state.mainTab === "harness" ? HARNESSES.length - 1 : shown.length - 1;

    if (key.pageUp) {
      moveCursor(state.cursor - page, maxCursor);
      return;
    }
    if (key.pageDown) {
      moveCursor(state.cursor + page, maxCursor);
      return;
    }
    if (key.upArrow || input === "k") {
      moveCursor(state.cursor - 1, maxCursor);
      return;
    }
    if (key.downArrow || input === "j") {
      moveCursor(state.cursor + 1, maxCursor);
      return;
    }
    if (key.ctrl && input === "u") {
      moveCursor(state.cursor - Math.max(1, Math.floor(page / 2)), maxCursor);
      return;
    }
    if (key.ctrl && input === "d") {
      moveCursor(state.cursor + Math.max(1, Math.floor(page / 2)), maxCursor);
      return;
    }

    if (
      input === "t" ||
      input === "1" ||
      input === "2" ||
      input === "3"
    ) {
      const next: MainTab =
        input === "1"
          ? "skill"
          : input === "2"
            ? "mcp"
            : input === "3"
              ? "harness"
              : cycleMainTab(state.mainTab);
      switchTab(next);
      return;
    }

    if (input === "E" || input === "e") {
      if (state.mainTab === "harness") {
        setState((s) => setAllHarnesses(s, true));
        setFlash("Harnesses: all on");
        return;
      }
      if (isResourceTab(state.mainTab)) {
        applyKindFlags(state.mainTab, true);
      }
      return;
    }
    if (input === "D" || input === "d") {
      if (state.mainTab === "harness") {
        setState((s) => setAllHarnesses(s, false));
        setFlash("Harnesses: only cursor left on");
        return;
      }
      if (isResourceTab(state.mainTab)) {
        applyKindFlags(state.mainTab, false);
      }
      return;
    }

    if (input === "h" && isResourceTab(state.mainTab)) {
      const enabled = enabledOrder(state.harnessEnabled);
      const order: Array<"all" | HarnessId> = ["all", ...enabled];
      setState((s) => {
        const i = order.indexOf(s.harnessTab);
        const next = order[(i < 0 ? 0 : i + 1) % order.length]!;
        return { ...s, harnessTab: next, cursor: 0 };
      });
      setCol(0);
      return;
    }

    if (input === "s" && isResourceTab(state.mainTab)) {
      setState((s) => ({
        ...s,
        sort: s.sort === "name" ? "cost" : "name",
        cursor: 0,
      }));
      return;
    }

    if (key.home || input === "g") {
      moveCursor(0, maxCursor);
      return;
    }
    if (key.end || input === "G") {
      moveCursor(maxCursor, maxCursor);
      return;
    }
  });

  const title = `agent-hub  ${state.profileName}${dirty ? "*" : ""}  ${
    state.mainTab === "harness"
      ? `${countEnabledHarnesses(state.harnessEnabled)}/${HARNESSES.length} harnesses`
      : `${shown.length} ${mainTabLabel(state.mainTab).toLowerCase()} · ~${formatTok(liveTok)} tok · ${stagedCount} staged`
  }${harnessDirty ? " · harness*" : ""}${dryRun ? " · dry-run" : ""}`;

  const rangeLabel =
    state.mainTab === "harness"
      ? `${state.cursor + 1}/${HARNESSES.length}`
      : shown.length === 0
        ? "0/0"
        : `${state.cursor + 1}/${shown.length}  ${start + 1}-${end}`;

  const sideItems: Array<{ key: string; label: string; kind: "profile" | "new" }> =
    [
      ...names.map((name) => ({
        key: name,
        label: name,
        kind: "profile" as const,
      })),
      { key: "__new__", label: "+ new", kind: "new" as const },
    ];

  return (
    <Box flexDirection="column" height={termRows}>
      <Text bold color={roles.title}>
        {title}
      </Text>

      <Box flexDirection="row" height={bodyH}>
        <Box flexDirection="column" width={SIDEBAR_WIDTH - 1} height={bodyH}>
          <Text
            bold
            color={focus === "sidebar" ? roles.pending : roles.muted}
          >
            Profiles
          </Text>
          {mode === "newName" ? (
            <Text color={roles.pending}>
              {`>${newName.slice(0, SIDEBAR_WIDTH - 4)}█`}
            </Text>
          ) : null}
          {sideItems.map((item, i) => {
            if (mode === "newName" && item.kind === "new") return null;
            const selected = i === sideCursor;
            const editing =
              item.kind === "profile" && item.label === state.profileName;
            const mark = editing && dirty ? "*" : editing ? "·" : " ";
            const text = `${item.label}${mark === " " ? "" : mark}`.slice(
              0,
              SIDEBAR_WIDTH - 4,
            );
            return (
              <Text
                key={item.key}
                color={
                  selected && focus === "sidebar"
                    ? roles.cursor
                    : editing
                      ? roles.title
                      : roles.muted
                }
                inverse={selected && focus === "sidebar"}
                bold={editing}
              >
                {selected && focus === "sidebar" ? `${glyphs.pointer} ` : "  "}
                {text}
              </Text>
            );
          })}
        </Box>
        <Box width={1} height={bodyH} flexDirection="column">
          {Array.from({ length: bodyH }, (_, i) => (
            <Text
              key={i}
              color={focus === "sidebar" ? roles.pending : roles.muted}
            >
              │
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" flexGrow={1} height={bodyH}>
          {/* flexShrink=0: long Skills lists must not crush the tab strip */}
          <Box flexShrink={0}>
            {MAIN_TABS.map((tab, i) => {
              const active = state.mainTab === tab;
              const count =
                tab === "harness"
                  ? sectionCounts.harness
                  : sectionCounts[tab];
              const label = mainTabChrome(tab, i, count);
              return (
                <React.Fragment key={tab}>
                  <Text
                    color={active ? roles.title : roles.muted}
                    inverse={active}
                    bold={active}
                  >
                    {label}
                  </Text>
                  {isResourceTab(tab) ? (
                    <>
                      <Text color={roles.live}>{kindBulkOnChrome()}</Text>
                      <Text color={roles.parked}>{kindBulkOffChrome()}</Text>
                    </>
                  ) : null}
                </React.Fragment>
              );
            })}
          </Box>

          {state.mainTab === "harness" ? (
            <>
              <Box flexShrink={0}>
                <Text color={roles.muted}>
                  {"  "}
                  {"harness".padEnd(NAME_WIDTH)}
                  {"status".padStart(8)}
                  {"  "}
                  {rangeLabel}
                </Text>
              </Box>
              {HARNESSES.map((id, i) => {
                const on = state.harnessEnabled[id] !== false;
                const selected = i === state.cursor && focus === "main";
                const changed =
                  (savedHarness[id] !== false) !== on;
                return (
                  <Box key={id} flexShrink={0}>
                    <Text
                      color={selected ? roles.cursor : undefined}
                      inverse={selected}
                    >
                      {selected ? `${glyphs.pointer} ` : "  "}
                      {id.padEnd(NAME_WIDTH)}
                    </Text>
                    <Text color={on ? roles.live : roles.parked}>
                      {`${changed ? (on ? glyphs.stagedOn : glyphs.stagedOff) : " "}${on ? glyphs.live : glyphs.parked} ${on ? "on" : "off"}`.padStart(8)}
                    </Text>
                  </Box>
                );
              })}
              <Box flexShrink={0}>
                <Text color={roles.muted}>
                  {"  "}Tab/Space/click toggle · w saves to config.yaml · Enter apply
                </Text>
              </Box>
            </>
          ) : (
            <>
              <Box flexShrink={0}>
                <Text color={roles.muted}>
                  {"  "}
                  {"".padEnd(NAME_WIDTH)}
                  {"tok".padStart(6)}
                  {cols.map((h) => h.slice(0, 6).padStart(7)).join("")}
                  {"  "}
                  {`h:${state.harnessTab}  `}
                  {rangeLabel}
                  {mode === "search"
                    ? `  /${state.query}█`
                    : state.query
                      ? `  filter:${state.query}`
                      : ""}
                </Text>
              </Box>
              <Box flexDirection="column" flexGrow={1} overflow="hidden">
                {start > 0 ? (
                  <Text color={roles.muted}>  ↑ {start} more</Text>
                ) : null}
                {slice.map((row, i) => {
                  const abs = start + i;
                  return (
                    <RowView
                      key={`${row.kind}:${row.name}`}
                      row={row}
                      cols={cols}
                      activeCol={col}
                      selected={abs === state.cursor && focus === "main"}
                      staged={state.staged}
                      profile={state.profile}
                    />
                  );
                })}
                {end < shown.length ? (
                  <Text color={roles.muted}>
                    {"  "}↓ {shown.length - end} more
                  </Text>
                ) : null}
              </Box>
            </>
          )}
        </Box>
      </Box>

      <Box>
        <Text color={roles.muted}>
          {flash
            ? flash
            : "[ ] panes  1/2/3 tabs  click [●]/[○]  e/d all  w save  Enter apply  Tab toggle  Esc"}
        </Text>
      </Box>
    </Box>
  );
}

function enabledOrder(flags: HarnessEnabled): HarnessId[] {
  return HARNESSES.filter((id) => flags[id] !== false);
}

function RowView({
  row,
  cols,
  activeCol,
  selected,
  staged,
  profile,
}: {
  row: MatrixRow;
  cols: HarnessId[];
  activeCol: number;
  selected: boolean;
  staged: ViewState["staged"];
  profile: Profile | undefined;
}) {
  const label = row.name.slice(0, NAME_WIDTH).padEnd(NAME_WIDTH);
  const tok = formatTok(row.tokens ?? 0).padStart(6);
  return (
    <Box>
      <Text color={selected ? roles.cursor : undefined} inverse={selected}>
        {selected ? `${glyphs.pointer} ` : "  "}
        {label}
      </Text>
      <Text color={roles.muted}>{tok}</Text>
      {cols.map((h, i) => {
        const live = row.flags[h];
        const eff = effectiveFlag(row, h, staged, profile);
        const changed = staged.has(cellKey(row.kind, row.name, h));
        let glyph = "-";
        let color: string | undefined = roles.muted;
        if (eff === true) {
          glyph = glyphs.live;
          color = roles.live;
        } else if (eff === false) {
          glyph = glyphs.parked;
          color = roles.parked;
        } else if (live === undefined) {
          glyph = "-";
          color = roles.muted;
        }
        const mark = changed ? (eff ? glyphs.stagedOn : glyphs.stagedOff) : " ";
        const focusCell = selected && i === activeCol;
        return (
          <Text
            key={h}
            color={focusCell ? roles.pending : color}
            inverse={focusCell}
          >
            {` ${mark}${glyph} `.padStart(7)}
          </Text>
        );
      })}
    </Box>
  );
}
