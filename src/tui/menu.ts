import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { HarnessId, MatrixRow, Profile } from "../types.ts";
import { HARNESSES } from "../types.ts";
import { formatTok, liveTokenTotal } from "../cost.ts";
import {
  cellKey,
  effectiveFlag,
  stagedToProfileMaps,
  toggleCell,
  visibleRows,
  type ViewState,
} from "./model.ts";
import type { TuiResult } from "./types.ts";
import { glyphs } from "./theme.ts";

/**
 * Numbered non-TTY fallback (agent-toggle style): list rows, toggle by number,
 * apply / quit. Staging only — caller runs apply after return.
 */
export async function runNumberedMenu(opts: {
  rows: MatrixRow[];
  profileName?: string;
  dryRun?: boolean;
}): Promise<TuiResult> {
  const { rows, profileName = "tui-session", dryRun = false } = opts;
  let state: ViewState = {
    rows,
    staged: new Map(),
    cursor: 0,
    harnessTab: "all",
    kindFilter: "all",
    query: "",
    sort: "name",
  };
  let col = 0;
  const cols: HarnessId[] = [...HARNESSES];

  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const shown = visibleRows(state);
      const liveTok = liveTokenTotal(shown);
      output.write(
        `\nagent-hub menu  ${shown.length} shown · ~${formatTok(liveTok)} tok live · ${state.staged.size} staged${
          dryRun ? " · dry-run" : ""
        }\n`,
      );
      output.write(
        `  type=${state.kindFilter}  sort=${state.sort}  filter=${state.query || "(none)"}  col=${cols[col]}\n`,
      );
      const page = shown.slice(0, 40);
      for (let i = 0; i < page.length; i++) {
        const row = page[i]!;
        const cells = cols
          .map((h) => {
            const eff = effectiveFlag(row, h, state.staged);
            const changed = state.staged.has(cellKey(row.kind, row.name, h));
            const g =
              eff === true ? glyphs.live : eff === false ? glyphs.parked : "-";
            const mark = changed ? (eff ? glyphs.stagedOn : glyphs.stagedOff) : " ";
            const focus = h === cols[col] ? ">" : " ";
            return `${focus}${mark}${g}`;
          })
          .join("");
        const tok = formatTok(row.tokens ?? 0).padStart(5);
        output.write(
          `  ${String(i + 1).padStart(3)}  ${row.kind.slice(0, 2)} ${row.name.padEnd(28).slice(0, 28)} ${tok} ${cells}\n`,
        );
      }
      if (shown.length > 40) {
        output.write(`  … ${shown.length - 40} more (narrow with /text)\n`);
      }
      output.write(
        "  n <#> toggle · h col · t type · s sort · /q filter · a apply · q quit\n> ",
      );

      const line = (await rl.question("")).trim();
      if (!line || line === "q") return { action: "cancel" };
      if (line === "a") {
        const maps = stagedToProfileMaps(state);
        const profile: Profile = {
          name: profileName,
          description: "Applied from numbered menu",
          skills: maps.skills as Profile["skills"],
          mcp: maps.mcp as Profile["mcp"],
        };
        return { action: "apply", profile, dryRun };
      }
      if (line === "t") {
        state = {
          ...state,
          kindFilter:
            state.kindFilter === "all"
              ? "skill"
              : state.kindFilter === "skill"
                ? "mcp"
                : "all",
          cursor: 0,
        };
        continue;
      }
      if (line === "h") {
        col = (col + 1) % cols.length;
        continue;
      }
      if (line === "s") {
        state = {
          ...state,
          sort: state.sort === "name" ? "cost" : "name",
          cursor: 0,
        };
        continue;
      }
      if (line.startsWith("/")) {
        state = { ...state, query: line.slice(1), cursor: 0 };
        continue;
      }
      const m = line.match(/^n\s+(\d+)$/i) || line.match(/^(\d+)$/);
      if (m) {
        const idx = Number(m[1]) - 1;
        const row = page[idx];
        if (!row) {
          output.write("out of range\n");
          continue;
        }
        const harness = cols[col]!;
        state = toggleCell(state, row, harness);
        continue;
      }
      output.write("unknown command\n");
    }
  } finally {
    rl.close();
  }
}
