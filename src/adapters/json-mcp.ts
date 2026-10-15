import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import type { HarnessId, McpRef, McpServer, OpResult } from "../types.ts";

type JsonMcpFile = {
  mcpServers?: Record<string, unknown>;
  disabledServers?: string[];
  [key: string]: unknown;
};

/** Strip line and block comments for Cursor-style JSONC mcp.json files. */
export function stripJsonc(raw: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < raw.length) {
    const c = raw[i]!;
    const n = raw[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i + 1 < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export async function readJsonMcpFile(path: string): Promise<JsonMcpFile> {
  if (!existsSync(path)) return { mcpServers: {} };
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(stripJsonc(raw)) as JsonMcpFile;
  } catch (e) {
    throw new Error(`invalid JSON MCP file ${path}: ${e}`);
  }
}

export async function listJsonMcp(
  path: string,
  source: string,
): Promise<McpRef[]> {
  const data = await readJsonMcpFile(path);
  const servers = data.mcpServers ?? {};
  const disabled = new Set(data.disabledServers ?? []);
  return Object.keys(servers)
    .sort()
    .map((name) => {
      const entry = servers[name] as { enabled?: boolean } | undefined;
      const flaggedOff = entry?.enabled === false;
      return {
        name,
        enabled: !disabled.has(name) && !flaggedOff,
        source,
      };
    });
}

/**
 * Enable/disable an MCP server in a Claude/Cursor/OMP-style mcpServers JSON.
 * Prefer flipping `disabledServers` when that array exists (OMP); else set
 * `enabled: false` on the entry or remove/add from mcpServers using catalog.
 */
export async function setJsonMcp(opts: {
  harness: HarnessId;
  path: string;
  name: string;
  enabled: boolean;
  dryRun: boolean;
  /** Catalog definition used when enabling a missing server. */
  catalogEntry?: McpServer;
}): Promise<OpResult> {
  const { harness, path, name, enabled, dryRun, catalogEntry } = opts;
  const action = enabled ? "enable" : "disable";
  const data = await readJsonMcpFile(path);
  data.mcpServers ??= {};

  const hasDisabledList = Array.isArray(data.disabledServers);
  const exists = name in data.mcpServers;

  if (enabled) {
    if (!exists && !catalogEntry) {
      return {
        harness,
        kind: "mcp",
        name,
        action,
        status: "skipped",
        detail: "not in file and no catalog entry",
      };
    }
    if (exists) {
      const entry = data.mcpServers[name] as Record<string, unknown>;
      const listedDisabled =
        hasDisabledList && (data.disabledServers ?? []).includes(name);
      const flaggedOff = entry.enabled === false;
      if (!listedDisabled && !flaggedOff) {
        return {
          harness,
          kind: "mcp",
          name,
          action: "noop",
          status: "ok",
          detail: "already enabled",
        };
      }
    }
    if (dryRun) {
      return {
        harness,
        kind: "mcp",
        name,
        action: "would-enable",
        status: "planned",
        detail: path,
      };
    }
    if (!exists && catalogEntry) {
      data.mcpServers[name] = catalogEntry;
    } else if (exists) {
      const entry = data.mcpServers[name] as Record<string, unknown>;
      if ("enabled" in entry) entry.enabled = true;
    }
    if (hasDisabledList) {
      data.disabledServers = (data.disabledServers ?? []).filter(
        (n) => n !== name,
      );
    }
  } else {
    // Not installed here — do not pollute disabledServers with foreign names
    if (!exists) {
      return {
        harness,
        kind: "mcp",
        name,
        action: "noop",
        status: "ok",
        detail: "already absent",
      };
    }
    const entry = data.mcpServers[name] as Record<string, unknown>;
    const alreadyOff =
      entry.enabled === false ||
      (hasDisabledList && (data.disabledServers ?? []).includes(name));
    if (alreadyOff) {
      return {
        harness,
        kind: "mcp",
        name,
        action: "noop",
        status: "ok",
        detail: "already disabled",
      };
    }
    if (dryRun) {
      return {
        harness,
        kind: "mcp",
        name,
        action: "would-disable",
        status: "planned",
        detail: path,
      };
    }
    if (hasDisabledList) {
      const set = new Set(data.disabledServers ?? []);
      set.add(name);
      data.disabledServers = [...set].sort();
    } else {
      entry.enabled = false;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { harness, kind: "mcp", name, action, status: "ok", detail: path };
}
