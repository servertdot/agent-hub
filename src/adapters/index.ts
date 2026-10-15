import { join } from "node:path";
import type { HarnessAdapter } from "./types.ts";
import type { HarnessId, McpRef, OpResult, SkillRef } from "../types.ts";
import { home, harnessPaths } from "../paths.ts";
import { listSkillDirs, setSkillLink } from "./fs-skills.ts";
import { listJsonMcp, setJsonMcp } from "./json-mcp.ts";
import { existsSync } from "node:fs";

/** Primary skill install dir per harness (where we symlink on enable). */
function skillTargetDir(id: HarnessId): string {
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

function mcpPrimaryFile(id: HarnessId): string | undefined {
  return harnessPaths(id).mcpFiles[0];
}

function makeJsonAdapter(id: HarnessId): HarnessAdapter {
  const paths = harnessPaths(id);
  return {
    id,
    async isInstalled() {
      // Installed if home-ish path exists or shared agents skills exist
      return (
        existsSync(skillTargetDir(id)) ||
        existsSync(join(home(), ".agents", "skills")) ||
        (mcpPrimaryFile(id) !== undefined && existsSync(dirnameSafe(mcpPrimaryFile(id)!)))
      );
    },
    async listSkills() {
      return listSkillDirs(paths.skills, id);
    },
    async listMcp() {
      const file = mcpPrimaryFile(id);
      if (!file || !existsSync(file)) return [];
      if (file.endsWith(".toml")) {
        // Codex TOML — discovery stub for MVP (apply still skipped with detail)
        return listCodexMcpNames(file, id);
      }
      return listJsonMcp(file, id);
    },
    async setSkill(name, enabled, dryRun) {
      const discovered = await listSkillDirs(
        [join(home(), ".agents", "skills"), ...paths.skills],
        "catalog",
      );
      const src = discovered.find((s) => s.name === name)?.path;
      return setSkillLink({
        harness: id,
        targetDir: skillTargetDir(id),
        name,
        sourcePath: src,
        enabled,
        dryRun,
      });
    },
    async setMcp(name, enabled, dryRun) {
      const file = mcpPrimaryFile(id);
      if (!file) {
        return {
          harness: id,
          kind: "mcp",
          name,
          action: enabled ? "enable" : "disable",
          status: "skipped",
          detail: "no mcp file mapped",
        };
      }
      if (file.endsWith(".toml")) {
        return {
          harness: id,
          kind: "mcp",
          name,
          action: enabled ? "enable" : "disable",
          status: "skipped",
          detail: "codex TOML mcp apply not implemented in MVP",
        };
      }
      return setJsonMcp({ harness: id, path: file, name, enabled, dryRun });
    },
  };
}

function dirnameSafe(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? p : p.slice(0, i);
}

async function listCodexMcpNames(
  path: string,
  source: string,
): Promise<McpRef[]> {
  const { readFile } = await import("node:fs/promises");
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\[mcp_servers\.([^\].]+)\]/);
    if (m) names.add(m[1]!);
  }
  return [...names].sort().map((name) => ({
    name,
    enabled: true,
    source,
  }));
}

export const adapters: Record<HarnessId, HarnessAdapter> = {
  cursor: makeJsonAdapter("cursor"),
  claude: makeJsonAdapter("claude"),
  codex: makeJsonAdapter("codex"),
  pi: makeJsonAdapter("pi"),
  omp: makeJsonAdapter("omp"),
};

export function enabledAdapters(
  flags: Partial<Record<HarnessId, boolean>>,
): HarnessAdapter[] {
  return (Object.keys(adapters) as HarnessId[])
    .filter((id) => flags[id] !== false)
    .map((id) => adapters[id]);
}
