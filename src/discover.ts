import { join } from "node:path";
import { enabledAdapters } from "./adapters/index.ts";
import { listSkillDirs } from "./adapters/fs-skills.ts";
import { loadConfig } from "./config.ts";
import { home, harnessPaths } from "./paths.ts";
import { HARNESSES, type HarnessId, type MatrixRow } from "./types.ts";

/** Harness-owned skills dir (not the shared ~/.agents pool). */
function ownedSkillsDir(id: HarnessId): string {
  return harnessPaths(id).skills[0]!;
}

/**
 * Build matrix:
 * - skill names = union of shared + all harness skill dirs
 * - flags[h] = skill present in that harness's *owned* dir only
 * - mcp flags from each adapter's MCP file
 */
export async function discoverMatrix(): Promise<MatrixRow[]> {
  const cfg = await loadConfig();
  const ads = enabledAdapters(cfg.harnesses);

  const sharedRoot = join(home(), ".agents", "skills");
  const allSkillRoots = [
    sharedRoot,
    ...HARNESSES.map((id) => ownedSkillsDir(id)),
  ];
  const universe = await listSkillDirs(allSkillRoots, "universe");

  const ownedByHarness = new Map<HarnessId, Set<string>>();
  for (const ad of ads) {
    const owned = await listSkillDirs([ownedSkillsDir(ad.id)], ad.id);
    ownedByHarness.set(ad.id, new Set(owned.map((s) => s.name)));
  }

  const skillMap = new Map<string, Partial<Record<HarnessId, boolean>>>();
  const skillBasis = new Map<string, string>();
  for (const s of universe) {
    const flags: Partial<Record<HarnessId, boolean>> = {};
    for (const ad of ads) {
      flags[ad.id] = ownedByHarness.get(ad.id)?.has(s.name) ?? false;
    }
    skillMap.set(s.name, flags);
    skillBasis.set(s.name, s.path);
  }

  const mcpMap = new Map<string, Partial<Record<HarnessId, boolean>>>();
  const mcpBasis = new Map<string, string>();
  for (const ad of ads) {
    const mcps = await ad.listMcp();
    for (const m of mcps) {
      const flags = mcpMap.get(m.name) ?? {};
      flags[ad.id] = m.enabled;
      mcpMap.set(m.name, flags);
      if (!mcpBasis.has(m.name)) mcpBasis.set(m.name, m.source);
    }
    // Fill false for harnesses that don't list this MCP at all — done below
  }

  // Ensure every known MCP name has an explicit boolean per enabled harness
  for (const [name, flags] of mcpMap) {
    for (const ad of ads) {
      if (flags[ad.id] === undefined) flags[ad.id] = false;
    }
    mcpMap.set(name, flags);
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
