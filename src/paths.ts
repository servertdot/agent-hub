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

/** Default skill / MCP locations per harness (read side). */
export function harnessPaths(id: HarnessId): {
  skills: string[];
  mcpFiles: string[];
} {
  const h = home();
  switch (id) {
    case "cursor":
      return {
        skills: [join(h, ".cursor", "skills"), join(h, ".agents", "skills")],
        mcpFiles: [join(h, ".cursor", "mcp.json")],
      };
    case "claude":
      return {
        skills: [join(h, ".claude", "skills"), join(h, ".agents", "skills")],
        mcpFiles: [join(h, ".claude.json")],
      };
    case "codex":
      return {
        skills: [join(h, ".codex", "skills"), join(h, ".agents", "skills")],
        mcpFiles: [join(h, ".codex", "config.toml")],
      };
    case "pi":
      return {
        skills: [join(h, ".pi", "agent", "skills"), join(h, ".agents", "skills")],
        mcpFiles: [join(h, ".pi", "agent", "mcp.json")],
      };
    case "omp":
      return {
        skills: [join(h, ".omp", "agent", "skills"), join(h, ".agents", "skills")],
        mcpFiles: [join(h, ".omp", "agent", "mcp.json")],
      };
  }
}
