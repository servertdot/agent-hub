import type { ResourceKind } from "../types.ts";
import {
  MAIN_TABS,
  isResourceTab,
  mainTabLabel,
  type MainTab,
} from "./model.ts";
import { glyphs } from "./theme.ts";

/** Button-event + SGR reporting (xterm / iTerm / Kitty / Apple Terminal). */
export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";

export type MouseClick = {
  /** 0-based column from the left edge of the terminal. */
  column: number;
  /** 0-based row from the top edge of the terminal. */
  row: number;
};

/**
 * Extract completed SGR mouse reports from a stdin chunk.
 * Only left-button presses (`…M` with button code 0) become clicks.
 * Incomplete trailing escapes stay in `pending`.
 */
export function consumeSgrMouse(
  chunk: string,
  pending = "",
): { clicks: MouseClick[]; pending: string } {
  const input = pending + chunk;
  const clicks: MouseClick[] = [];
  let i = 0;
  let carryFrom = -1;

  while (i < input.length) {
    const esc = input.indexOf("\x1b[<", i);
    if (esc === -1) break;

    let j = esc + 3;
    while (j < input.length) {
      const c = input.charCodeAt(j);
      if (c === 0x4d /* M */ || c === 0x6d /* m */) break;
      j += 1;
    }
    if (j >= input.length) {
      carryFrom = esc;
      break;
    }

    const terminator = input[j]!;
    const body = input.slice(esc + 3, j);
    const [codeRaw, colRaw, rowRaw] = body.split(";");
    const code = Number.parseInt(codeRaw ?? "", 10);
    const col = Number.parseInt(colRaw ?? "", 10);
    const row = Number.parseInt(rowRaw ?? "", 10);
    if (
      terminator === "M" &&
      Number.isFinite(code) &&
      Number.isFinite(col) &&
      Number.isFinite(row) &&
      (code & 64) === 0 &&
      (code & 32) === 0 &&
      (code & 3) === 0
    ) {
      clicks.push({ column: col - 1, row: row - 1 });
    }
    i = j + 1;
  }

  return {
    clicks,
    pending: carryFrom >= 0 ? input.slice(carryFrom) : "",
  };
}

export type TabHit = {
  tab: MainTab;
  startCol: number;
  endCol: number;
};

export type BulkHit = {
  kind: ResourceKind;
  enabled: boolean;
  startCol: number;
  endCol: number;
};

export function mainTabChrome(
  tab: MainTab,
  index: number,
  count: number,
): string {
  return ` ${index + 1}:${mainTabLabel(tab)} (${count}) `;
}

/** @deprecated use mainTabChrome */
export function kindTabChrome(
  kind: ResourceKind,
  index: number,
  count: number,
): string {
  return mainTabChrome(kind, index, count);
}

export function kindBulkOnChrome(): string {
  return `[${glyphs.live}]`;
}

export function kindBulkOffChrome(): string {
  return `[${glyphs.parked}]`;
}

export type KindSectionHits = {
  tabs: TabHit[];
  bulk: BulkHit[];
};

/**
 * Hit boxes for Skills / MCP / Harnesses tabs.
 * Skills & MCP also get `[●][○]` bulk controls after the label.
 */
export function kindSectionHits(
  counts: Record<ResourceKind, number> & { harness: number },
  offsetCol = 0,
): KindSectionHits {
  let col = offsetCol;
  const tabs: TabHit[] = [];
  const bulk: BulkHit[] = [];
  const onChrome = kindBulkOnChrome();
  const offChrome = kindBulkOffChrome();

  for (const [index, tab] of MAIN_TABS.entries()) {
    const count =
      tab === "harness" ? counts.harness : counts[tab];
    const label = mainTabChrome(tab, index, count);
    tabs.push({ tab, startCol: col, endCol: col + label.length });
    col += label.length;

    if (isResourceTab(tab)) {
      bulk.push({
        kind: tab,
        enabled: true,
        startCol: col,
        endCol: col + onChrome.length,
      });
      col += onChrome.length;
      bulk.push({
        kind: tab,
        enabled: false,
        startCol: col,
        endCol: col + offChrome.length,
      });
      col += offChrome.length;
    }
  }

  return { tabs, bulk };
}

export function kindTabHits(
  counts: Record<ResourceKind, number> & { harness?: number },
  offsetCol = 0,
): TabHit[] {
  return kindSectionHits(
    { skill: counts.skill, mcp: counts.mcp, harness: counts.harness ?? 0 },
    offsetCol,
  ).tabs;
}

export function hitMainTab(
  column: number,
  row: number,
  hits: TabHit[],
  tabRow = 1,
): MainTab | null {
  if (row !== tabRow) return null;
  for (const hit of hits) {
    if (column >= hit.startCol && column < hit.endCol) return hit.tab;
  }
  return null;
}

/** @deprecated use hitMainTab */
export function hitKindTab(
  column: number,
  row: number,
  hits: TabHit[],
  tabRow = 1,
): MainTab | null {
  return hitMainTab(column, row, hits, tabRow);
}

export function hitKindBulk(
  column: number,
  row: number,
  hits: BulkHit[],
  tabRow = 1,
): BulkHit | null {
  if (row !== tabRow) return null;
  for (const hit of hits) {
    if (column >= hit.startCol && column < hit.endCol) return hit;
  }
  return null;
}

/** Hit a row in the harness editor list (main panel). */
export function hitHarnessRow(
  column: number,
  row: number,
  opts: {
    sidebarWidth: number;
    listTop: number;
    count: number;
  },
): number | null {
  if (column < opts.sidebarWidth) return null;
  const index = row - opts.listTop;
  if (index < 0 || index >= opts.count) return null;
  return index;
}

export type SidebarHit =
  | { type: "profile"; name: string; index: number }
  | { type: "new" };

export function hitSidebar(
  column: number,
  row: number,
  names: string[],
  opts: { width: number; listTop: number },
): SidebarHit | null {
  if (column < 0 || column >= opts.width) return null;
  const index = row - opts.listTop;
  if (index < 0) return null;
  if (index < names.length) {
    return { type: "profile", name: names[index]!, index };
  }
  if (index === names.length) return { type: "new" };
  return null;
}
