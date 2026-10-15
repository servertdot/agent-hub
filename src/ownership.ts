import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { listProfiles, loadMcpCatalog } from "./config.ts";
import {
  hubLibrarySkillsDir,
  hubWorkspaceMcpPath,
  hubWorkspaceSkillsDir,
  hubWorkspacesDir,
} from "./paths.ts";

export type SkillOwners = {
  /** Profiles whose workspace contains this skill name. */
  profiles: string[];
  /** Present under shared library/skills. */
  library: boolean;
};

export type McpOwners = {
  profiles: string[];
  /** Present in global ~/.agent-hub/catalog/mcp.yaml */
  globalCatalog: boolean;
};

export class NameConflictError extends Error {
  readonly kind: "skill" | "mcp";
  readonly name: string;
  readonly owners: string[];

  constructor(kind: "skill" | "mcp", name: string, owners: string[]) {
    const where = owners.join(", ");
    super(
      `${kind} name conflict: "${name}" already exists (${where}). Pick another name or remove it from the other profile first.`,
    );
    this.kind = kind;
    this.name = name;
    this.owners = owners;
  }
}

async function listWorkspaceProfileNames(): Promise<string[]> {
  const fromYaml = await listProfiles();
  const root = hubWorkspacesDir();
  if (!existsSync(root)) return fromYaml;
  const dirs = (await readdir(root)).filter((n) => !n.startsWith("."));
  return [...new Set([...fromYaml, ...dirs])].sort();
}

export async function findSkillOwners(name: string): Promise<SkillOwners> {
  const profiles: string[] = [];
  for (const p of await listWorkspaceProfileNames()) {
    const path = join(hubWorkspaceSkillsDir(p), name);
    if (existsSync(path) && existsSync(join(path, "SKILL.md"))) {
      profiles.push(p);
    }
  }
  const lib = join(hubLibrarySkillsDir(), name);
  const library = existsSync(join(lib, "SKILL.md"));
  return { profiles, library };
}

/**
 * Fresh install into `profileName` requires a free name across the machine:
 * no other profile workspace and no library package with that name.
 */
export function assertSkillInstallAllowed(
  name: string,
  profileName: string,
  owners: SkillOwners,
): void {
  const labels: string[] = [
    ...owners.profiles.map((p) => `profile:${p}`),
    ...(owners.library ? ["library"] : []),
  ];
  if (labels.length) {
    throw new NameConflictError("skill", name, labels);
  }
  void profileName;
}

/**
 * Claim an orphan library skill into a profile (name not in any workspace yet).
 */
export function assertSkillAdoptAllowed(
  name: string,
  profileName: string,
  owners: SkillOwners,
): void {
  if (!owners.library) {
    throw new Error(`skill "${name}" not in library — use skill install <path>`);
  }
  if (owners.profiles.length) {
    throw new NameConflictError(
      "skill",
      name,
      owners.profiles.map((p) => `profile:${p}`),
    );
  }
  void profileName;
}

export async function findMcpOwners(name: string): Promise<McpOwners> {
  const profiles: string[] = [];
  for (const p of await listWorkspaceProfileNames()) {
    const path = hubWorkspaceMcpPath(p);
    if (!existsSync(path)) continue;
    try {
      const raw = await readFile(path, "utf8");
      const data = (parseYaml(raw) ?? {}) as {
        mcpServers?: Record<string, unknown>;
      };
      if (data.mcpServers?.[name]) profiles.push(p);
    } catch {
      // ignore unreadable workspace catalogs
    }
  }
  const global = await loadMcpCatalog();
  return {
    profiles,
    globalCatalog: Boolean(global.mcpServers[name]),
  };
}

/**
 * Fresh MCP install into a profile: name must not exist in any profile
 * workspace catalog or the global hub catalog.
 */
export function assertMcpInstallAllowed(
  name: string,
  profileName: string,
  owners: McpOwners,
): void {
  const labels: string[] = [
    ...owners.profiles.map((p) => `profile:${p}`),
    ...(owners.globalCatalog ? ["global-catalog"] : []),
  ];
  if (labels.length) {
    throw new NameConflictError("mcp", name, labels);
  }
  void profileName;
}

/** Claim a global-catalog MCP into a profile when no profile owns the name yet. */
export function assertMcpAdoptAllowed(
  name: string,
  profileName: string,
  owners: McpOwners,
): void {
  if (!owners.globalCatalog) {
    throw new Error(
      `mcp "${name}" not in global catalog — use mcp install with a definition`,
    );
  }
  if (owners.profiles.length) {
    throw new NameConflictError(
      "mcp",
      name,
      owners.profiles.map((p) => `profile:${p}`),
    );
  }
  void profileName;
}

/** True if any other profile still has this skill in its workspace. */
export function skillUsedElsewhere(
  name: string,
  profileName: string,
  owners: SkillOwners,
): boolean {
  return owners.profiles.some((p) => p !== profileName);
}
