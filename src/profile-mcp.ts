import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  McpCatalogSchema,
  type McpCatalog,
  type McpServer,
} from "./types.ts";
import { hubWorkspaceMcpPath } from "./paths.ts";
import {
  assertMcpAdoptAllowed,
  assertMcpInstallAllowed,
  findMcpOwners,
  type McpOwners,
} from "./ownership.ts";
import { loadMcpCatalog } from "./config.ts";

export async function loadWorkspaceMcpCatalog(
  profileName: string,
): Promise<McpCatalog> {
  const path = hubWorkspaceMcpPath(profileName);
  if (!existsSync(path)) return McpCatalogSchema.parse({ mcpServers: {} });
  const raw = await readFile(path, "utf8");
  return McpCatalogSchema.parse(parseYaml(raw) ?? { mcpServers: {} });
}

export async function saveWorkspaceMcpCatalog(
  profileName: string,
  catalog: McpCatalog,
): Promise<string> {
  const path = hubWorkspaceMcpPath(profileName);
  await mkdir(dirname(path), { recursive: true });
  const parsed = McpCatalogSchema.parse(catalog);
  await writeFile(path, stringifyYaml(parsed), "utf8");
  return path;
}

/** Profile catalog wins; global hub catalog fills gaps (read-only fallback). */
export async function resolveMcpCatalogForProfile(
  profileName: string,
): Promise<McpCatalog> {
  const local = await loadWorkspaceMcpCatalog(profileName);
  const global = await loadMcpCatalog();
  return McpCatalogSchema.parse({
    mcpServers: { ...global.mcpServers, ...local.mcpServers },
  });
}

export async function installMcpToProfile(opts: {
  profileName: string;
  name: string;
  server: McpServer;
  dryRun?: boolean;
}): Promise<{ path: string; owners: McpOwners }> {
  const owners = await findMcpOwners(opts.name);
  assertMcpInstallAllowed(opts.name, opts.profileName, owners);
  const path = hubWorkspaceMcpPath(opts.profileName);
  if (opts.dryRun) {
    return { path, owners };
  }
  const cat = await loadWorkspaceMcpCatalog(opts.profileName);
  cat.mcpServers[opts.name] = opts.server;
  await saveWorkspaceMcpCatalog(opts.profileName, cat);
  return { path, owners };
}

export async function removeMcpFromProfile(opts: {
  profileName: string;
  name: string;
  dryRun?: boolean;
}): Promise<{ removed: boolean; path: string }> {
  const path = hubWorkspaceMcpPath(opts.profileName);
  const cat = await loadWorkspaceMcpCatalog(opts.profileName);
  if (!cat.mcpServers[opts.name]) {
    return { removed: false, path };
  }
  if (opts.dryRun) return { removed: true, path };
  delete cat.mcpServers[opts.name];
  await saveWorkspaceMcpCatalog(opts.profileName, cat);
  return { removed: true, path };
}

/** Copy a global-catalog MCP def into the profile workspace catalog. */
export async function adoptMcpFromGlobal(opts: {
  profileName: string;
  name: string;
  dryRun?: boolean;
}): Promise<{ path: string }> {
  const owners = await findMcpOwners(opts.name);
  assertMcpAdoptAllowed(opts.name, opts.profileName, owners);
  const global = await loadMcpCatalog();
  const server = global.mcpServers[opts.name];
  if (!server) throw new Error(`mcp "${opts.name}" missing from global catalog`);
  const path = hubWorkspaceMcpPath(opts.profileName);
  if (opts.dryRun) return { path };
  const cat = await loadWorkspaceMcpCatalog(opts.profileName);
  cat.mcpServers[opts.name] = server;
  await saveWorkspaceMcpCatalog(opts.profileName, cat);
  return { path };
}
