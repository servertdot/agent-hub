import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { HarnessId, McpRef, McpServer, OpResult } from "../types.ts";

/** Line range [start, end) of mcp_servers.<name> plus dotted subtables. */
export function findMcpBlock(
  text: string,
  name: string,
): { start: number; end: number; body: string } | null {
  const lines = text.split("\n");
  const header = `[mcp_servers.${name}]`;
  const prefix = `[mcp_servers.${name}.`;

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === header) {
      startLine = i;
      break;
    }
  }
  // Subtable-only (rare): treat first matching subtable as start
  if (startLine < 0) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim().startsWith(prefix)) {
        startLine = i;
        break;
      }
    }
  }
  if (startLine < 0) return null;

  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t.startsWith("[")) continue;
    if (t === header || t.startsWith(prefix)) continue;
    endLine = i;
    break;
  }

  return {
    start: startLine,
    end: endLine,
    body: lines.slice(startLine, endLine).join("\n"),
  };
}

export function isMcpEnabledInBlock(body: string): boolean {
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*enabled\s*=\s*(true|false)\s*$/i);
    if (m) return m[1]!.toLowerCase() === "true";
  }
  return true;
}

export function setEnabledInBlock(body: string, enabled: boolean): string {
  const lines = body.split("\n");
  let found = false;
  const next = lines.map((line) => {
    if (/^\s*enabled\s*=/.test(line)) {
      found = true;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      return `${indent}enabled = ${enabled}`;
    }
    return line;
  });
  if (!found) {
    if (next.length === 0) return `enabled = ${enabled}`;
    next.splice(1, 0, `enabled = ${enabled}`);
  }
  return next.join("\n");
}

export function listTomlMcp(text: string, source: string): McpRef[] {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\[mcp_servers\.([^.\]\s]+)\]/);
    if (m) names.add(m[1]!);
  }
  return [...names]
    .sort()
    .map((name) => {
      const block = findMcpBlock(text, name);
      return {
        name,
        enabled: block ? isMcpEnabledInBlock(block.body) : true,
        source,
      };
    });
}

export function renderTomlMcpBlock(name: string, entry: McpServer): string {
  const lines = [`[mcp_servers.${name}]`, "enabled = true"];
  if (entry.command) lines.push(`command = ${tomlString(entry.command)}`);
  if (entry.args?.length) {
    lines.push(`args = [${entry.args.map(tomlString).join(", ")}]`);
  }
  if (entry.url) lines.push(`url = ${tomlString(entry.url)}`);
  if (entry.cwd) lines.push(`cwd = ${tomlString(entry.cwd)}`);
  if (entry.env && Object.keys(entry.env).length) {
    lines.push("");
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [k, v] of Object.entries(entry.env)) {
      lines.push(`${k} = ${tomlString(v)}`);
    }
  }
  return lines.join("\n");
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

function spliceBlock(
  text: string,
  startLine: number,
  endLine: number,
  newBody: string,
): string {
  const lines = text.split("\n");
  return [
    ...lines.slice(0, startLine),
    ...newBody.split("\n"),
    ...lines.slice(endLine),
  ].join("\n");
}

export async function setTomlMcp(opts: {
  harness: HarnessId;
  path: string;
  name: string;
  enabled: boolean;
  dryRun: boolean;
  catalogEntry?: McpServer;
}): Promise<OpResult> {
  const { harness, path, name, enabled, dryRun, catalogEntry } = opts;
  const action = enabled ? "enable" : "disable";

  if (!existsSync(path) && !(enabled && catalogEntry)) {
    return {
      harness,
      kind: "mcp",
      name,
      action,
      status: "skipped",
      detail: `missing ${path}`,
    };
  }

  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  const block = findMcpBlock(text, name);

  if (enabled) {
    if (block) {
      if (isMcpEnabledInBlock(block.body)) {
        return {
          harness,
          kind: "mcp",
          name,
          action: "noop",
          status: "ok",
          detail: "already enabled",
        };
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
      const newBody = setEnabledInBlock(block.body, true);
      await writeFile(
        path,
        spliceBlock(text, block.start, block.end, newBody),
        "utf8",
      );
      return { harness, kind: "mcp", name, action, status: "ok", detail: path };
    }
    if (!catalogEntry) {
      return {
        harness,
        kind: "mcp",
        name,
        action,
        status: "skipped",
        detail: "not in config.toml and no catalog entry",
      };
    }
    if (dryRun) {
      return {
        harness,
        kind: "mcp",
        name,
        action: "would-enable",
        status: "planned",
        detail: `append to ${path}`,
      };
    }
    const addition = renderTomlMcpBlock(name, catalogEntry);
    const sep = text === "" || text.endsWith("\n") ? "" : "\n";
    await writeFile(path, `${text}${sep}\n${addition}\n`, "utf8");
    return {
      harness,
      kind: "mcp",
      name,
      action,
      status: "ok",
      detail: `appended ${path}`,
    };
  }

  if (!block) {
    return {
      harness,
      kind: "mcp",
      name,
      action: "noop",
      status: "ok",
      detail: "already absent",
    };
  }
  if (!isMcpEnabledInBlock(block.body)) {
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
  const newBody = setEnabledInBlock(block.body, false);
  await writeFile(
    path,
    spliceBlock(text, block.start, block.end, newBody),
    "utf8",
  );
  return { harness, kind: "mcp", name, action, status: "ok", detail: path };
}
