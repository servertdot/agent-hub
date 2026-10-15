import { existsSync } from "node:fs";
import { join } from "node:path";
import { enabledAdapters } from "./adapters/index.ts";
import { listSkillDirs } from "./adapters/fs-skills.ts";
import { getActiveProfile, loadConfig, loadProfile } from "./config.ts";
import {
  attachCosts,
  COST_FORMULA,
  costSummary,
  formatTok,
  liveTokenTotal,
} from "./cost.ts";
import {
  harnessSkillDir,
  hubLibrarySkillsDir,
  hubWorkspaceMcpPath,
  hubWorkspaceSkillsDir,
} from "./paths.ts";
import { loadWorkspaceMcpCatalog } from "./profile-mcp.ts";
import { HARNESSES, type HarnessId, type MatrixRow } from "./types.ts";

/**
 * Build matrix for a profile workspace:
 * - skill names = that profile's workspace ∪ profile YAML keys (via library)
 * - flags[h] = present in harness owned dir (live projection)
 * - mcp names = profile workspace catalog ∪ profile YAML mcp keys
 * - mcp flags = enabled state from harness MCP files (for names in universe only)
 *
 * Live harness installs that are not in the profile are ignored (sync/apply
 * absorbs them into the active profile separately).
 */
export async function discoverMatrix(opts?: {
  withCosts?: boolean;
  /** Profile whose workspace defines the skill/MCP universe (default: active). */
  profileName?: string;
}): Promise<MatrixRow[]> {
  const withCosts = opts?.withCosts !== false;
  const cfg = await loadConfig();
  const ads = enabledAdapters(cfg.harnesses);
  const profileName =
    opts?.profileName ?? (await getActiveProfile()) ?? undefined;

  const allSkillRoots = [
    ...(profileName ? [hubWorkspaceSkillsDir(profileName)] : []),
    ...(cfg.catalog.skillRoots ?? []),
  ];
  const universe = await listSkillDirs(allSkillRoots, "universe");

  // Profile YAML may reference skills still only in library (e.g. after a bad save).
  let profileDoc: Awaited<ReturnType<typeof loadProfile>> | undefined;
  if (profileName) {
    try {
      profileDoc = await loadProfile(profileName);
      const seen = new Set(universe.map((s) => s.name));
      for (const name of Object.keys(profileDoc.skills)) {
        if (seen.has(name)) continue;
        const lib = join(hubLibrarySkillsDir(), name);
        const ws = join(hubWorkspaceSkillsDir(profileName), name);
        const path = existsSync(join(ws, "SKILL.md"))
          ? ws
          : existsSync(join(lib, "SKILL.md"))
            ? lib
            : undefined;
        if (!path) continue;
        universe.push({ name, path, source: `profile:${profileName}` });
        seen.add(name);
      }
    } catch {
      // no profile file yet
    }
  }

  const ownedByHarness = new Map<HarnessId, Set<string>>();
  for (const ad of ads) {
    const owned = await listSkillDirs([harnessSkillDir(ad.id)], ad.id);
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

  if (profileName) {
    const local = await loadWorkspaceMcpCatalog(profileName);
    for (const name of Object.keys(local.mcpServers)) {
      const flags: Partial<Record<HarnessId, boolean>> = {};
      for (const ad of ads) flags[ad.id] = false;
      mcpMap.set(name, flags);
      mcpBasis.set(name, hubWorkspaceMcpPath(profileName));
    }
    for (const name of Object.keys(profileDoc?.mcp ?? {})) {
      if (mcpMap.has(name)) continue;
      const flags: Partial<Record<HarnessId, boolean>> = {};
      for (const ad of ads) flags[ad.id] = false;
      mcpMap.set(name, flags);
      mcpBasis.set(name, `profile:${profileName}`);
    }
  }

  // Fill flags only for MCP names already in this profile's universe.
  for (const ad of ads) {
    const mcps = await ad.listMcp();
    for (const m of mcps) {
      if (!mcpMap.has(m.name)) continue;
      const flags = mcpMap.get(m.name)!;
      flags[ad.id] = m.enabled;
      mcpMap.set(m.name, flags);
    }
  }

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
  return withCosts ? attachCosts(rows) : rows;
}

export function formatMatrix(rows: MatrixRow[]): string {
  const cols = HARNESSES;
  const header = ["kind", "name", "tok", ...cols].join("\t");
  const lines = rows.map((r) => {
    const cells = cols.map((h) => {
      const v = r.flags[h];
      if (v === undefined) return "-";
      return v ? "●" : "○";
    });
    const tok = r.tokens != null ? String(r.tokens) : "-";
    return [r.kind, r.name, tok, ...cells].join("\t");
  });
  return [header, ...lines].join("\n");
}

export function formatMatrixFooter(rows: MatrixRow[]): string {
  const s = costSummary(rows);
  return [
    `${s.resources} resources · ~${formatTok(s.liveTokens)} tok live`,
    `  skills: ${s.byKind.skill.count} (~${formatTok(s.byKind.skill.liveTokens)} live)`,
    `  mcp: ${s.byKind.mcp.count} (~${formatTok(s.byKind.mcp.liveTokens)} live)`,
    `formula: ${COST_FORMULA}`,
  ].join("\n");
}

export { liveTokenTotal, formatTok };
