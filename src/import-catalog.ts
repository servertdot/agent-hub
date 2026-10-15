import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";
import { enabledAdapters } from "./adapters/index.ts";
import { readJsonMcpFile } from "./adapters/json-mcp.ts";
import {
  ensureHubLayout,
  loadConfig,
  loadMcpCatalog,
  saveProfile,
} from "./config.ts";
import { discoverMatrix } from "./discover.ts";
import { harnessPaths, hubMcpCatalogPath } from "./paths.ts";
import {
  HARNESSES,
  McpCatalogSchema,
  type HarnessId,
  type McpCatalog,
  type McpServer,
} from "./types.ts";

function asMcpServer(raw: unknown): McpServer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const out: McpServer = {};
  if (typeof o.command === "string") out.command = o.command;
  if (Array.isArray(o.args) && o.args.every((a) => typeof a === "string")) {
    out.args = o.args as string[];
  }
  if (typeof o.url === "string") out.url = o.url;
  if (typeof o.cwd === "string") out.cwd = o.cwd;
  if (o.type === "stdio" || o.type === "http" || o.type === "sse") {
    out.type = o.type;
  }
  if (o.env && typeof o.env === "object") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
    if (Object.keys(env).length) out.env = env;
  }
  if (o.headers && typeof o.headers === "object") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      o.headers as Record<string, unknown>,
    )) {
      if (typeof v === "string") headers[k] = v;
    }
    if (Object.keys(headers).length) out.headers = headers;
  }
  if (!out.command && !out.url) return null;
  return out;
}

/** Merge MCP server defs from JSON harness files into the hub catalog. */
export async function importMcpCatalog(opts?: {
  overwrite?: boolean;
}): Promise<{ added: string[]; skipped: string[]; path: string }> {
  await ensureHubLayout();
  const cfg = await loadConfig();
  const catalog = await loadMcpCatalog();
  const added: string[] = [];
  const skipped: string[] = [];

  const ads = enabledAdapters(cfg.harnesses);
  for (const ad of ads) {
    const file = harnessPaths(ad.id).mcpFiles[0];
    if (!file || !existsSync(file) || file.endsWith(".toml")) continue;
    const data = await readJsonMcpFile(file);
    for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
      if (catalog.mcpServers[name] && !opts?.overwrite) {
        skipped.push(`${name} (${ad.id})`);
        continue;
      }
      const parsed = asMcpServer(raw);
      if (!parsed) {
        skipped.push(`${name} (${ad.id}, unparseable)`);
        continue;
      }
      catalog.mcpServers[name] = parsed;
      added.push(`${name} ← ${ad.id}`);
    }
  }

  const next: McpCatalog = McpCatalogSchema.parse(catalog);
  await writeFile(hubMcpCatalogPath(), stringifyYaml(next), "utf8");
  return { added, skipped, path: hubMcpCatalogPath() };
}

/** Snapshot discovery into a full boolean matrix profile. */
export async function captureProfileFromDiscovery(
  name: string,
): Promise<string> {
  const rows = await discoverMatrix();
  const skills: Record<string, Record<HarnessId, boolean>> = {};
  const mcp: Record<string, Record<HarnessId, boolean>> = {};

  for (const r of rows) {
    const flags = {} as Record<HarnessId, boolean>;
    for (const h of HARNESSES) {
      flags[h] = r.flags[h] === true;
    }
    if (r.kind === "skill") skills[r.name] = flags;
    else mcp[r.name] = flags;
  }

  return saveProfile({
    name,
    description: `Captured from discover at ${new Date().toISOString()}`,
    skills,
    mcp,
  });
}
