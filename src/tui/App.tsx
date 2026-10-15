import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { HarnessId, MatrixRow, Profile } from "../types.ts";
import { HARNESSES } from "../types.ts";
import { glyphs, roles } from "./theme.ts";
import type { TuiResult } from "./types.ts";
import {
  cellKey,
  effectiveFlag,
  harnessColumns,
  stagedToProfileMaps,
  toggleCell,
  visibleRows,
  type ViewState,
} from "./model.ts";

export type { TuiResult };

type Props = {
  rows: MatrixRow[];
  profileName?: string;
  dryRun?: boolean;
  onDone: (result: TuiResult) => void;
};

export function App({ rows, profileName = "tui-session", dryRun = false, onDone }: Props) {
  const { exit } = useApp();
  const [state, setState] = useState<ViewState>({
    rows,
    staged: new Map(),
    cursor: 0,
    harnessTab: "all",
    kindFilter: "all",
    query: "",
  });
  const [searching, setSearching] = useState(false);
  const [col, setCol] = useState(0);

  const shown = useMemo(() => visibleRows(state), [state]);
  const cols = harnessColumns(state.harnessTab);
  const stagedCount = state.staged.size;

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setSearching(false);
        return;
      }
      if (key.return) {
        setSearching(false);
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

    if (key.escape || (key.ctrl && input === "c")) {
      onDone({ action: "cancel" });
      exit();
      return;
    }

    if (key.return) {
      const maps = stagedToProfileMaps(state);
      // Merge staged onto empty profile — apply only staged cells
      const profile: Profile = {
        name: profileName,
        description: "Applied from TUI session",
        skills: maps.skills as Profile["skills"],
        mcp: maps.mcp as Profile["mcp"],
      };
      onDone({ action: "apply", profile, dryRun });
      exit();
      return;
    }

    if (input === "/") {
      setSearching(true);
      return;
    }

    if (key.tab) {
      const row = shown[state.cursor];
      if (!row) return;
      const harness = cols[col] ?? cols[0];
      if (!harness) return;
      setState((s) => toggleCell(s, row, harness));
      return;
    }

    if (key.leftArrow) {
      setCol((c) => (c - 1 + cols.length) % cols.length);
      return;
    }
    if (key.rightArrow) {
      setCol((c) => (c + 1) % cols.length);
      return;
    }
    if (key.upArrow) {
      setState((s) => ({
        ...s,
        cursor: Math.max(0, s.cursor - 1),
      }));
      return;
    }
    if (key.downArrow) {
      setState((s) => ({
        ...s,
        cursor: Math.min(shown.length - 1, s.cursor + 1),
      }));
      return;
    }

    if (input === "t") {
      setState((s) => ({
        ...s,
        kindFilter:
          s.kindFilter === "all"
            ? "skill"
            : s.kindFilter === "skill"
              ? "mcp"
              : "all",
        cursor: 0,
      }));
      return;
    }

    if (input === "h") {
      const order: Array<"all" | HarnessId> = ["all", ...HARNESSES];
      setState((s) => {
        const i = order.indexOf(s.harnessTab);
        const next = order[(i + 1) % order.length]!;
        return { ...s, harnessTab: next, cursor: 0 };
      });
      setCol(0);
      return;
    }
  });

  const title = `agent-hub  ${shown.length} resources · ${stagedCount} staged${
    dryRun ? " · dry-run" : ""
  }`;

  return (
    <Box flexDirection="column">
      <Text bold color={roles.title}>
        {title}
      </Text>
      <Text color={roles.muted}>
        tab:{state.harnessTab}  type:{state.kindFilter} {" "}
        {searching ? `search> ${state.query}█` : state.query ? `filter:${state.query}` : ""}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={roles.muted}>
          {"  "}
          {"".padEnd(18)}
          {cols.map((h) => h.slice(0, 6).padStart(7)).join("")}
        </Text>
        {shown.slice(0, 30).map((row, i) => (
          <RowView
            key={`${row.kind}:${row.name}`}
            row={row}
            cols={cols}
            activeCol={col}
            selected={i === state.cursor}
            staged={state.staged}
          />
        ))}
        {shown.length > 30 ? (
          <Text color={roles.muted}>… {shown.length - 30} more</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={roles.muted}>
          ↑↓ move  ←→ harness  Tab toggle  / search  t type  h tab  Enter apply  Esc cancel
        </Text>
      </Box>
    </Box>
  );
}

function RowView({
  row,
  cols,
  activeCol,
  selected,
  staged,
}: {
  row: MatrixRow;
  cols: HarnessId[];
  activeCol: number;
  selected: boolean;
  staged: ViewState["staged"];
}) {
  const label = `${row.kind === "skill" ? "sk" : "mc"} ${row.name}`.slice(0, 18).padEnd(18);
  return (
    <Box>
      <Text color={selected ? roles.cursor : undefined} inverse={selected}>
        {selected ? `${glyphs.pointer} ` : "  "}
        {label}
      </Text>
      {cols.map((h, i) => {
        const live = row.flags[h];
        const eff = effectiveFlag(row, h, staged);
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
        const focus = selected && i === activeCol;
        return (
          <Text key={h} color={focus ? roles.pending : color} inverse={focus}>
            {` ${mark}${glyph} `.padStart(7)}
          </Text>
        );
      })}
    </Box>
  );
}
