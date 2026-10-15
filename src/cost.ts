import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MatrixRow, ResourceKind } from "./types.ts";

/** Tokenizer-free rule of thumb (same as agent-toggle): ±25%. */
export const CHARS_PER_TOKEN = 4;
export const HEAD_CAP = 16 * 1024;

/** MCP with unknown tool list — flat startup weight (non-deferred). */
export const MCP_FLAT_TOKENS = 1500;
/** Claude-style deferred schemas: names only. */
export const MCP_DEFERRED_FLAT_TOKENS = 20;

export const COST_FORMULA =
  "ceil(chars/4); skill=frontmatter name+description; mcp=flat 1500 (unknown tools)";

export type CostEstimate = {
  tokens: number;
  chars: number | null;
  basis: string;
  description: string;
};

export function tokensOf(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function parseFrontmatter(head: string): Record<string, string> {
  const lines = head.split(/\r?\n/);
  if (!lines[0] || lines[0].trim() !== "---") return {};
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const ln of lines.slice(1)) {
    if (ln.trim() === "---") break;
    if ((ln.startsWith(" ") || ln.startsWith("\t")) && key) {
      out[key] = `${out[key]} ${ln.trim()}`.trim();
    } else if (ln.includes(":") && !ln.trimStart().startsWith("#")) {
      const i = ln.indexOf(":");
      key = ln.slice(0, i).trim();
      let v = ln.slice(i + 1).trim();
      if (v === ">" || v === "|" || v === ">-" || v === "|-") v = "";
      else v = v.replace(/^["']|["']$/g, "");
      out[key] = v;
    }
  }
  return out;
}

export async function estimateSkill(path: string): Promise<CostEstimate> {
  let file = path;
  if (existsSync(join(path, "SKILL.md"))) file = join(path, "SKILL.md");
  if (!existsSync(file)) {
    return { tokens: 0, chars: null, basis: "file not found", description: "" };
  }
  const buf = await readFile(file);
  const head = buf.subarray(0, HEAD_CAP).toString("utf8");
  const fm = parseFrontmatter(head);
  const name = fm.name ?? "";
  const description = fm.description ?? "";
  const text = `${name}${description}`;
  const chars = text.length;
  return {
    tokens: tokensOf(chars),
    chars,
    basis: "frontmatter name+description",
    description,
  };
}

export function estimateMcp(opts?: {
  deferred?: boolean;
  toolCount?: number;
}): CostEstimate {
  if (opts?.toolCount != null && opts.toolCount > 0) {
    const per = opts.deferred ? 10 : 300;
    const tokens = opts.toolCount * per;
    return {
      tokens,
      chars: null,
      basis: `${opts.toolCount} tools × ${per}`,
      description: "",
    };
  }
  const tokens = opts?.deferred ? MCP_DEFERRED_FLAT_TOKENS : MCP_FLAT_TOKENS;
  return {
    tokens,
    chars: null,
    basis: opts?.deferred ? "mcp deferred flat" : "mcp flat (unknown tools)",
    description: "",
  };
}

export async function attachCosts(rows: MatrixRow[]): Promise<MatrixRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.kind === "skill") {
        const est = row.basis
          ? await estimateSkill(row.basis)
          : {
              tokens: 0,
              chars: null,
              basis: "no path",
              description: "",
            };
        return {
          ...row,
          tokens: est.tokens,
          chars: est.chars ?? undefined,
          description: est.description || undefined,
          costBasis: est.basis,
        };
      }
      const est = estimateMcp();
      return {
        ...row,
        tokens: est.tokens,
        costBasis: est.basis,
      };
    }),
  );
}

/** Sum tokens for rows that are live on at least one (or the given) harness. */
export function liveTokenTotal(
  rows: MatrixRow[],
  harness?: string,
): number {
  let sum = 0;
  for (const r of rows) {
    const live = harness
      ? r.flags[harness as keyof typeof r.flags] === true
      : Object.values(r.flags).some((v) => v === true);
    if (live) sum += r.tokens ?? 0;
  }
  return sum;
}

export function formatTok(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}

export function sortByCost(rows: MatrixRow[], dir: "desc" | "asc" = "desc"): MatrixRow[] {
  const mul = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const d = ((a.tokens ?? 0) - (b.tokens ?? 0)) * mul;
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });
}

export function costSummary(rows: MatrixRow[]): {
  resources: number;
  liveTokens: number;
  byKind: Record<ResourceKind, { count: number; liveTokens: number }>;
} {
  const byKind: Record<ResourceKind, { count: number; liveTokens: number }> = {
    skill: { count: 0, liveTokens: 0 },
    mcp: { count: 0, liveTokens: 0 },
  };
  for (const r of rows) {
    byKind[r.kind].count++;
    if (Object.values(r.flags).some((v) => v === true)) {
      byKind[r.kind].liveTokens += r.tokens ?? 0;
    }
  }
  return {
    resources: rows.length,
    liveTokens: liveTokenTotal(rows),
    byKind,
  };
}
