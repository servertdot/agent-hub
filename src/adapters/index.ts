import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { HarnessAdapter } from "./types.ts";
import type { HarnessId, McpRef, OpResult, SkillRef } from "../types.ts";
import {
  harnessPaths,
  harnessSkillDir,
  hubLibrarySkillsDir,
} from "../paths.ts";
import { listSkillDirs, setSkillLink } from "./fs-skills.ts";
import { listJsonMcp, setJsonMcp } from "./json-mcp.ts";
import { listTomlMcp, setTomlMcp } from "./toml-mcp.ts";
import { getActiveProfile, loadMcpCatalog } from "../config.ts";
import { resolveMcpCatalogForProfile } from "../profile-mcp.ts";
import { resolveSkillSource } from "../workspace.ts";

/** Primary skill install dir per harness (where we symlink on enable). */
function skillTargetDir(id: HarnessId): string {
  return harnessSkillDir(id);
}

function mcpPrimaryFile(id: HarnessId): string | undefined {
  return harnessPaths(id).mcpFiles[0];
}

function dirnameSafe(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? p : p.slice(0, i);
}

function makeAdapter(id: HarnessId): HarnessAdapter {
  const paths = harnessPaths(id);
  return {
    id,
    async isInstalled() {
      return (
        existsSync(skillTargetDir(id)) ||
        existsSync(hubLibrarySkillsDir()) ||
        (mcpPrimaryFile(id) !== undefined &&
          existsSync(dirnameSafe(mcpPrimaryFile(id)!)))
      );
    },
    async listSkills() {
      return listSkillDirs([skillTargetDir(id)], id);
    },
    async listMcp() {
      const file = mcpPrimaryFile(id);
      if (!file || !existsSync(file)) return [];
      if (file.endsWith(".toml")) {
        const text = await readFile(file, "utf8");
        return listTomlMcp(text, id);
      }
      return listJsonMcp(file, id);
    },
    async setSkill(name, enabled, dryRun) {
      const active = await getActiveProfile();
      const src = await resolveSkillSource(name, active);
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
      const active = await getActiveProfile();
      const catalog = active
        ? await resolveMcpCatalogForProfile(active)
        : await loadMcpCatalog();
      const catalogEntry = catalog.mcpServers[name];
      if (file.endsWith(".toml")) {
        return setTomlMcp({
          harness: id,
          path: file,
          name,
          enabled,
          dryRun,
          catalogEntry,
        });
      }
      return setJsonMcp({
        harness: id,
        path: file,
        name,
        enabled,
        dryRun,
        catalogEntry,
      });
    },
  };
}

export const adapters: Record<HarnessId, HarnessAdapter> = {
  cursor: makeAdapter("cursor"),
  claude: makeAdapter("claude"),
  codex: makeAdapter("codex"),
  pi: makeAdapter("pi"),
  omp: makeAdapter("omp"),
};

export function enabledAdapters(
  flags: Partial<Record<HarnessId, boolean>>,
): HarnessAdapter[] {
  return (Object.keys(adapters) as HarnessId[])
    .filter((id) => flags[id] !== false)
    .map((id) => adapters[id]);
}

export type { SkillRef, McpRef, OpResult };
