import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { enabledAdapters } from "./adapters/index.ts";
import { readJsonMcpFile } from "./adapters/json-mcp.ts";
import { findMcpBlock, listTomlMcp } from "./adapters/toml-mcp.ts";
import { loadConfig } from "./config.ts";
import { harnessPaths, hubBackupsDir } from "./paths.ts";
import {
  applyReplacementsToText,
  collectReplacementsFromRawServer,
  envRefForKey,
  isEnvRef,
  looksLikeSecretValue,
  type ScrubHit,
  type ScrubReplacement,
} from "./secrets.ts";
import type { HarnessId } from "./types.ts";

export type HarnessScrubReport = {
  harness: HarnessId;
  file: string;
  hits: ScrubHit[];
  wouldWrite: boolean;
  written: boolean;
  backup?: string;
  detail?: string;
};

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function backupFile(file: string): Promise<string> {
  const dir = join(hubBackupsDir(), "harness-mcp", stamp());
  await mkdir(dir, { recursive: true });
  const unique = join(dir, `${file.replace(/[\\/:]/g, "__")}.bak`);
  await copyFile(file, unique);
  return unique;
}

const SENSITIVE_KEY =
  /(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|private[_-]?key)/i;

async function scrubJsonMcpFile(
  harness: HarnessId,
  file: string,
  write: boolean,
): Promise<HarnessScrubReport> {
  const data = await readJsonMcpFile(file);
  const hits: ScrubHit[] = [];
  const replacements: ScrubReplacement[] = [];
  for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const found = collectReplacementsFromRawServer(
      name,
      raw as Record<string, unknown>,
    );
    hits.push(...found.hits);
    replacements.push(...found.replacements);
  }
  if (!hits.length) {
    return {
      harness,
      file,
      hits: [],
      wouldWrite: false,
      written: false,
      detail: "clean",
    };
  }

  const rawText = await readFile(file, "utf8");
  const { text, applied } = applyReplacementsToText(rawText, replacements);
  if (applied === 0) {
    return {
      harness,
      file,
      hits,
      wouldWrite: false,
      written: false,
      detail: "secrets found but could not patch raw text (format mismatch)",
    };
  }

  if (!write) {
    return {
      harness,
      file,
      hits,
      wouldWrite: true,
      written: false,
      detail: `dry-run: would patch ${applied} value(s)`,
    };
  }

  const backup = await backupFile(file);
  await writeFile(file, text, "utf8");
  return {
    harness,
    file,
    hits,
    wouldWrite: true,
    written: true,
    backup,
    detail: `patched ${applied} value(s)`,
  };
}

/** Only scrub inside [mcp_servers.*] tables. */
async function scrubTomlMcpFile(
  harness: HarnessId,
  file: string,
  write: boolean,
): Promise<HarnessScrubReport> {
  const rawText = await readFile(file, "utf8");
  const hits: ScrubHit[] = [];
  const replacements: ScrubReplacement[] = [];
  const servers = listTomlMcp(rawText, harness);

  for (const s of servers) {
    const block = findMcpBlock(rawText, s.name);
    if (!block) continue;
    const lineRe = /^(\s*)([A-Za-z0-9_]+)\s*=\s*"([^"]+)"\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(block.body))) {
      const key = m[2]!;
      const value = m[3]!;
      if (isEnvRef(value)) continue;
      // Never rewrite path/url fields even if the string looks opaque
      if (/^(command|cwd|url|args)$/i.test(key)) continue;
      if (!(SENSITIVE_KEY.test(key) || looksLikeSecretValue(value))) continue;
      const ref = envRefForKey(key);
      const whole = m[0]!;
      const wholeTo = `${m[1]!}${key} = "${ref}"`;
      hits.push({
        path: `mcp_servers.${s.name}.${key}`,
        from:
          value.length <= 8
            ? "***"
            : `${value.slice(0, 4)}…${value.slice(-2)}`,
        to: ref,
      });
      replacements.push({
        path: `mcp_servers.${s.name}.${key}`,
        secret: value,
        ref,
        whole,
        wholeTo,
      });
    }

    const argRe = /"(--figma-api-key=)([^"]+)"/g;
    while ((m = argRe.exec(block.body))) {
      const value = m[2]!;
      if (value.startsWith("$")) continue;
      const whole = m[0]!;
      const wholeTo = `"${m[1]!}$FIGMA_API_KEY"`;
      hits.push({
        path: `mcp_servers.${s.name}.figma-api-key`,
        from:
          value.length <= 8
            ? "***"
            : `${value.slice(0, 4)}…${value.slice(-2)}`,
        to: "$FIGMA_API_KEY",
      });
      replacements.push({
        path: `mcp_servers.${s.name}.figma-api-key`,
        secret: value,
        ref: "$FIGMA_API_KEY",
        whole,
        wholeTo,
      });
    }
  }

  if (!hits.length) {
    return {
      harness,
      file,
      hits: [],
      wouldWrite: false,
      written: false,
      detail: "clean",
    };
  }

  const { text, applied } = applyReplacementsToText(rawText, replacements);
  if (!write) {
    return {
      harness,
      file,
      hits,
      wouldWrite: applied > 0,
      written: false,
      detail: `dry-run: would patch ${applied} value(s)`,
    };
  }
  if (applied === 0) {
    return {
      harness,
      file,
      hits,
      wouldWrite: false,
      written: false,
      detail: "could not patch raw TOML",
    };
  }
  const backup = await backupFile(file);
  await writeFile(file, text, "utf8");
  return {
    harness,
    file,
    hits,
    wouldWrite: true,
    written: true,
    backup,
    detail: `patched ${applied} value(s)`,
  };
}

export async function scrubHarnessMcpFiles(opts?: {
  write?: boolean;
  harness?: HarnessId;
}): Promise<HarnessScrubReport[]> {
  const write = opts?.write ?? false;
  const cfg = await loadConfig();
  let ads = enabledAdapters(cfg.harnesses);
  if (opts?.harness) ads = ads.filter((a) => a.id === opts.harness);

  const reports: HarnessScrubReport[] = [];
  for (const ad of ads) {
    const file = harnessPaths(ad.id).mcpFiles[0];
    if (!file || !existsSync(file)) {
      reports.push({
        harness: ad.id,
        file: file ?? "(none)",
        hits: [],
        wouldWrite: false,
        written: false,
        detail: "missing",
      });
      continue;
    }
    if (file.endsWith(".toml")) {
      reports.push(await scrubTomlMcpFile(ad.id, file, write));
    } else {
      reports.push(await scrubJsonMcpFile(ad.id, file, write));
    }
  }
  return reports;
}

export function formatHarnessScrubReports(
  reports: HarnessScrubReport[],
): string {
  const lines: string[] = [];
  for (const r of reports) {
    const flag = r.written ? "WROTE" : r.wouldWrite ? "PLAN" : "ok";
    lines.push(
      `${flag.padEnd(5)} ${r.harness.padEnd(8)} ${r.file} — ${r.detail ?? ""}`,
    );
    for (const h of r.hits) {
      lines.push(`       ${h.path}: ${h.from} → ${h.to}`);
    }
    if (r.backup) lines.push(`       backup: ${r.backup}`);
  }
  const planned = reports.filter((r) => r.wouldWrite).length;
  const written = reports.filter((r) => r.written).length;
  const secrets = reports.reduce((n, r) => n + r.hits.length, 0);
  lines.push(
    `${reports.length} harness files, ${secrets} secrets, ${planned} to patch, ${written} written`,
  );
  return lines.join("\n");
}
