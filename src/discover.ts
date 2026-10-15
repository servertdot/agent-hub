import { enabledAdapters } from "./adapters/index.ts";
import { loadConfig } from "./config.ts";
import { HARNESSES, type HarnessId, type MatrixRow } from "./types.ts";

/** Build a matrix of discovered skills/MCP across enabled harnesses. */
export async function discoverMatrix(): Promise<MatrixRow[]> {
  const cfg = await loadConfig();
  const ads = enabledAdapters(cfg.harnesses);
  const skillMap = new Map<string, Partial<Record<HarnessId, boolean>>>();
  const mcpMap = new Map<string, Partial<Record<HarnessId, boolean>>>();
  const skillBasis = new Map<string, string>();
  const mcpBasis = new Map<string, string>();

  for (const ad of ads) {
    const skills = await ad.listSkills();
    for (const s of skills) {
      const flags = skillMap.get(s.name) ?? {};
      flags[ad.id] = true;
      skillMap.set(s.name, flags);
      if (!skillBasis.has(s.name)) skillBasis.set(s.name, s.path);
    }
    const mcps = await ad.listMcp();
    for (const m of mcps) {
      const flags = mcpMap.get(m.name) ?? {};
      flags[ad.id] = m.enabled;
      mcpMap.set(m.name, flags);
      if (!mcpBasis.has(m.name)) mcpBasis.set(m.name, m.source);
    }
  }

  const rows: MatrixRow[] = [];
  for (const [name, flags] of [...skillMap.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    rows.push({
      kind: "skill",
      name,
      flags,
      basis: skillBasis.get(name),
    });
  }
  for (const [name, flags] of [...mcpMap.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    rows.push({
      kind: "mcp",
      name,
      flags,
      basis: mcpBasis.get(name),
    });
  }
  return rows;
}

export function formatMatrix(rows: MatrixRow[]): string {
  const cols = HARNESSES;
  const header = ["kind", "name", ...cols].join("\t");
  const lines = rows.map((r) => {
    const cells = cols.map((h) => {
      const v = r.flags[h];
      if (v === undefined) return "-";
      return v ? "●" : "○";
    });
    return [r.kind, r.name, ...cells].join("\t");
  });
  return [header, ...lines].join("\n");
}
