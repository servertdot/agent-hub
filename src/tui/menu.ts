import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { HarnessId, MatrixRow, Profile } from "../types.ts";
import { HARNESSES } from "../types.ts";
import { loadProfile, saveConfig, saveProfile } from "../config.ts";
import { formatTok, liveTokenTotal } from "../cost.ts";
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
  mainTabLabel,
  loadProfileIntoState,
  newProfileIntoState,
  setKindFlags,
  toggleCell,
  toggleHarness,
  visibleRows,
  type HarnessEnabled,
  type ViewState,
} from "./model.ts";
import type { TuiResult } from "./types.ts";
import { glyphs } from "./theme.ts";

/**
 * Numbered non-TTY fallback: list rows, toggle by number, switch profiles,
 * toggle hub harnesses, save / apply.
 */
export async function runNumberedMenu(opts: {
  rows: MatrixRow[];
  profileName?: string;
  profile?: Profile;
  profileNames?: string[];
  harnesses?: Partial<Record<HarnessId, boolean>>;
  dryRun?: boolean;
}): Promise<TuiResult> {
  const {
    rows,
    profileName = "tui-session",
    profile,
    profileNames: initialNames = [],
    harnesses,
    dryRun = false,
  } = opts;

  const initialHarness = defaultHarnessEnabled(harnesses);
  let savedHarness: HarnessEnabled = { ...initialHarness };
  let state: ViewState = {
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
  };
  let names = (() => {
    const set = new Set(initialNames);
    set.add(state.profileName);
    return [...set].sort();
  })();
  let col = 0;

  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const cols = harnessColumns(state.harnessTab, state.harnessEnabled);
      const shown = visibleRows(state);
      const liveTok = liveTokenTotal(shown);
      const counts = countByKind(state.rows);
      const harnessDirty = !harnessFlagsEqual(
        state.harnessEnabled,
        savedHarness,
      );
      const dirty = state.staged.size > 0 || harnessDirty ? "*" : "";

      output.write(
        `\nagent-hub menu  profile:${state.profileName}${dirty}  ${mainTabLabel(state.mainTab)} · ${
          state.mainTab === "harness"
            ? `${countEnabledHarnesses(state.harnessEnabled)}/${HARNESSES.length} harnesses`
            : `${shown.length} shown · ~${formatTok(liveTok)} tok · ${state.staged.size} staged`
        }${dryRun ? " · dry-run" : ""}\n`,
      );
      output.write(
        `  [1:Skills (${counts.skill})] [2:MCP (${counts.mcp})] [3:Harnesses (${countEnabledHarnesses(state.harnessEnabled)})]  sort=${state.sort}  filter=${state.query || "(none)"}  col=${cols[col] ?? "-"}\n`,
      );

      if (state.mainTab === "harness") {
        for (let i = 0; i < HARNESSES.length; i++) {
          const id = HARNESSES[i]!;
          const on = state.harnessEnabled[id] !== false;
          const g = on ? glyphs.live : glyphs.parked;
          output.write(
            `  ${String(i + 1).padStart(3)}  ${id.padEnd(12)} ${g} ${on ? "on" : "off"}\n`,
          );
        }
      } else {
        const page = shown.slice(0, 40);
        for (let i = 0; i < page.length; i++) {
          const row = page[i]!;
          const cells = cols
            .map((h) => {
              const eff = effectiveFlag(row, h, state.staged, state.profile);
              const changed = state.staged.has(cellKey(row.kind, row.name, h));
              const g =
                eff === true ? glyphs.live : eff === false ? glyphs.parked : "-";
              const mark = changed
                ? eff
                  ? glyphs.stagedOn
                  : glyphs.stagedOff
                : " ";
              const focus = h === cols[col] ? ">" : " ";
              return `${focus}${mark}${g}`;
            })
            .join("");
          const tok = formatTok(row.tokens ?? 0).padStart(5);
          output.write(
            `  ${String(i + 1).padStart(3)}  ${row.name.padEnd(28).slice(0, 28)} ${tok} ${cells}\n`,
          );
        }
        if (shown.length > 40) {
          output.write(`  … ${shown.length - 40} more (narrow with /text)\n`);
        }
      }

      output.write(
        "  n <#> toggle · e/d all · p [name] profile · w save · t/1/2/3 tabs · h col · s sort · /q filter · a apply · q quit\n> ",
      );

      const line = (await rl.question("")).trim();
      if (!line || line === "q") return { action: "cancel" };
      if (line === "a") {
        const built = buildFullProfile(state);
        if (!dryRun) {
          await saveProfile(built);
          if (harnessDirty) {
            await saveConfig({ harnesses: state.harnessEnabled });
            savedHarness = { ...state.harnessEnabled };
          }
        }
        return { action: "apply", profile: built, dryRun };
      }
      if (line === "w") {
        const built = buildFullProfile(state);
        const path = await saveProfile(built);
        if (harnessDirty) {
          await saveConfig({ harnesses: state.harnessEnabled });
          savedHarness = { ...state.harnessEnabled };
          output.write(`saved ${path} + harnesses\n`);
        } else {
          output.write(`saved ${path}\n`);
        }
        state = {
          ...state,
          profile: built,
          profileName: built.name,
          staged: new Map(),
        };
        if (!names.includes(built.name)) names = [...names, built.name].sort();
        continue;
      }
      if (line === "p" || line.startsWith("p ")) {
        const arg = line === "p" ? "" : line.slice(2).trim();
        if (!arg) {
          output.write(`profiles: ${names.join(", ") || "(none)"}\n`);
          output.write("use: p <name>  or  p new <name>\n");
          continue;
        }
        if (arg.startsWith("new ")) {
          const name = arg.slice(4).trim();
          if (!name) {
            output.write("usage: p new <name>\n");
            continue;
          }
          state = newProfileIntoState(state, name);
          if (!names.includes(name)) names = [...names, name].sort();
          output.write(`new profile ${name} (baseline = live)\n`);
          continue;
        }
        try {
          const loaded = await loadProfile(arg);
          state = loadProfileIntoState(state, loaded);
          output.write(`loaded ${arg}\n`);
        } catch (err) {
          output.write(
            `load failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        continue;
      }
      if (line === "t" || line === "1" || line === "2" || line === "3") {
        const next =
          line === "1"
            ? "skill"
            : line === "2"
              ? "mcp"
              : line === "3"
                ? "harness"
                : cycleMainTab(state.mainTab);
        state = { ...state, mainTab: next, cursor: 0 };
        col = 0;
        continue;
      }
      if (line === "E" || line === "e" || line === "D" || line === "d") {
        const enabled = line === "E" || line === "e";
        if (state.mainTab === "harness") {
          state = {
            ...state,
            harnessEnabled: enabled
              ? defaultHarnessEnabled()
              : defaultHarnessEnabled({
                  cursor: true,
                  claude: false,
                  codex: false,
                  pi: false,
                  omp: false,
                }),
          };
          output.write(
            enabled
              ? "Harnesses: all on\n"
              : "Harnesses: only cursor left on\n",
          );
        } else if (isResourceTab(state.mainTab)) {
          state = setKindFlags(state, state.mainTab, enabled, cols);
          output.write(
            `${mainTabLabel(state.mainTab)}: all ${enabled ? "on" : "off"}\n`,
          );
        }
        continue;
      }
      if (line === "h" && isResourceTab(state.mainTab)) {
        col = cols.length ? (col + 1) % cols.length : 0;
        continue;
      }
      if (line === "s" && isResourceTab(state.mainTab)) {
        state = {
          ...state,
          sort: state.sort === "name" ? "cost" : "name",
          cursor: 0,
        };
        continue;
      }
      if (line.startsWith("/") && isResourceTab(state.mainTab)) {
        state = { ...state, query: line.slice(1), cursor: 0 };
        continue;
      }
      const m = line.match(/^n\s+(\d+)$/i) || line.match(/^(\d+)$/);
      if (m) {
        const idx = Number(m[1]) - 1;
        if (state.mainTab === "harness") {
          const id = HARNESSES[idx];
          if (!id) {
            output.write("out of range\n");
            continue;
          }
          const result = toggleHarness(state, id);
          if (result.error) {
            output.write(`${result.error}\n`);
            continue;
          }
          state = result.state;
          continue;
        }
        const page = shown.slice(0, 40);
        const row = page[idx];
        if (!row) {
          output.write("out of range\n");
          continue;
        }
        const harness = cols[col];
        if (!harness) {
          output.write("no enabled harness columns\n");
          continue;
        }
        state = toggleCell(state, row, harness);
        continue;
      }
      output.write("unknown command\n");
    }
  } finally {
    rl.close();
  }
}
