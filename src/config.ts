import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  HubConfigSchema,
  McpCatalogSchema,
  ProfileSchema,
  type HubConfig,
  type McpCatalog,
  type Profile,
} from "./types.ts";
import {
  hubConfigPath,
  hubDir,
  hubLibrarySkillsDir,
  hubMcpCatalogPath,
  hubProfilesDir,
  hubStatePath,
  hubWorkspacesDir,
} from "./paths.ts";

export async function ensureHubLayout(): Promise<void> {
  await mkdir(hubDir(), { recursive: true });
  await mkdir(hubProfilesDir(), { recursive: true });
  await mkdir(dirname(hubMcpCatalogPath()), { recursive: true });
  await mkdir(hubLibrarySkillsDir(), { recursive: true });
  await mkdir(hubWorkspacesDir(), { recursive: true });

  if (!existsSync(hubConfigPath())) {
    const cfg: HubConfig = HubConfigSchema.parse({});
    await writeFile(hubConfigPath(), stringifyYaml(cfg), "utf8");
  }
  if (!existsSync(hubMcpCatalogPath())) {
    const cat: McpCatalog = McpCatalogSchema.parse({ mcpServers: {} });
    await writeFile(hubMcpCatalogPath(), stringifyYaml(cat), "utf8");
  }
}

export async function loadConfig(): Promise<HubConfig> {
  await ensureHubLayout();
  const raw = await readFile(hubConfigPath(), "utf8");
  return HubConfigSchema.parse(parseYaml(raw) ?? {});
}

/** Write hub config (merges with current file so catalog/other keys survive). */
export async function saveConfig(patch: Partial<HubConfig>): Promise<string> {
  await ensureHubLayout();
  const current = await loadConfig();
  const next = HubConfigSchema.parse({
    ...current,
    ...patch,
    harnesses: { ...current.harnesses, ...patch.harnesses },
    catalog: patch.catalog ?? current.catalog,
  });
  const path = hubConfigPath();
  await writeFile(path, stringifyYaml(next), "utf8");
  return path;
}

export async function loadProfile(name: string): Promise<Profile> {
  const path = `${hubProfilesDir()}/${name}.yaml`;
  if (!existsSync(path)) {
    throw new Error(`profile not found: ${name} (${path})`);
  }
  const raw = await readFile(path, "utf8");
  const data = parseYaml(raw) ?? {};
  return ProfileSchema.parse({ ...data, name: data.name ?? name });
}

export async function saveProfile(profile: Profile): Promise<string> {
  await ensureHubLayout();
  const path = `${hubProfilesDir()}/${profile.name}.yaml`;
  const parsed = ProfileSchema.parse(profile);
  await writeFile(path, stringifyYaml(parsed), "utf8");
  return path;
}

export async function listProfiles(): Promise<string[]> {
  await ensureHubLayout();
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(hubProfilesDir());
  return files
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .sort();
}

export async function loadMcpCatalog(): Promise<McpCatalog> {
  await ensureHubLayout();
  const raw = await readFile(hubMcpCatalogPath(), "utf8");
  return McpCatalogSchema.parse(parseYaml(raw) ?? {});
}

export async function setActiveProfile(name: string): Promise<void> {
  await ensureHubLayout();
  const state = { activeProfile: name, updatedAt: new Date().toISOString() };
  await writeFile(hubStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function getActiveProfile(): Promise<string | undefined> {
  if (!existsSync(hubStatePath())) return undefined;
  try {
    const raw = await readFile(hubStatePath(), "utf8");
    return (JSON.parse(raw) as { activeProfile?: string }).activeProfile;
  } catch {
    return undefined;
  }
}
