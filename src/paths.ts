import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessId } from "./types.ts";

export function home(): string {
  return process.env.HOME ?? homedir();
}

export function expandHome(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/")) return join(home(), p.slice(2));
  return p;
}

/** Hub state directory (config, profiles, catalog). */
export function hubDir(): string {
  return process.env.AGENT_HUB_DIR
    ? expandHome(process.env.AGENT_HUB_DIR)
    : join(home(), ".agent-hub");
}

export function hubConfigPath(): string {
  return join(hubDir(), "config.yaml");
}

export function hubProfilesDir(): string {
  return join(hubDir(), "profiles");
}

export function hubMcpCatalogPath(): string {
  return join(hubDir(), "catalog", "mcp.yaml");
}

export function hubStatePath(): string {
  return join(hubDir(), "state.json");
}

export function hubBackupsDir(): string {
  return join(hubDir(), "backups");
}

/** Global skill package store (SoT for skill contents). */
export function hubLibrarySkillsDir(): string {
  return join(hubDir(), "library", "skills");
}

export function hubWorkspacesDir(): string {
  return join(hubDir(), "workspaces");
}

export function hubWorkspaceDir(profile: string): string {
  return join(hubWorkspacesDir(), profile);
}

/** Skills belonging to a profile workspace (profile-private packages). */
export function hubWorkspaceSkillsDir(profile: string): string {
  return join(hubWorkspaceDir(profile), "skills");
}

/** Per-profile MCP server definitions (SoT for that workspace). */
export function hubWorkspaceMcpPath(profile: string): string {
  return join(hubWorkspaceDir(profile), "mcp.yaml");
}

/** Shared Agent Skills path — must stay empty/parked; harnesses use private dirs. */
export function agentsSkillsPath(): string {
  return join(home(), ".agents", "skills");
}

/** Harness-owned skill install dir (where apply writes symlinks). */
export function harnessSkillDir(id: HarnessId): string {
  const h = home();
  switch (id) {
    case "cursor":
      return join(h, ".cursor", "skills");
    case "claude":
      return join(h, ".claude", "skills");
    case "codex":
      return join(h, ".codex", "skills");
    case "pi":
      return join(h, ".pi", "agent", "skills");
    case "omp":
      return join(h, ".omp", "agent", "skills");
  }
}

/** Default skill / MCP locations per harness (read side). */
export function harnessPaths(id: HarnessId): {
  skills: string[];
  mcpFiles: string[];
} {
  const h = home();
  switch (id) {
    case "cursor":
      return {
        // Shared ~/.agents/skills is parked by workspace apply — do not treat as live.
        skills: [harnessSkillDir("cursor"), hubLibrarySkillsDir()],
        mcpFiles: [join(h, ".cursor", "mcp.json")],
      };
    case "claude":
      return {
        skills: [harnessSkillDir("claude"), hubLibrarySkillsDir()],
        mcpFiles: [join(h, ".claude.json")],
      };
    case "codex":
      return {
        skills: [harnessSkillDir("codex"), hubLibrarySkillsDir()],
        mcpFiles: [join(h, ".codex", "config.toml")],
      };
    case "pi":
      return {
        skills: [harnessSkillDir("pi"), hubLibrarySkillsDir()],
        mcpFiles: [join(h, ".pi", "agent", "mcp.json")],
      };
    case "omp":
      return {
        skills: [harnessSkillDir("omp"), hubLibrarySkillsDir()],
        mcpFiles: [join(h, ".omp", "agent", "mcp.json")],
      };
  }
}
