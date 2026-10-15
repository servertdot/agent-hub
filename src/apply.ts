import { adapters, enabledAdapters } from "./adapters/index.ts";
import { loadConfig, setActiveProfile } from "./config.ts";
import { HARNESSES, type HarnessId, type OpResult, type Profile } from "./types.ts";

export type ApplyOptions = {
  profile: Profile;
  dryRun?: boolean;
  /** Limit to one harness. */
  harness?: HarnessId;
};

export async function applyProfile(opts: ApplyOptions): Promise<OpResult[]> {
  const { profile, dryRun = false, harness } = opts;
  const cfg = await loadConfig();
  let ads = enabledAdapters(cfg.harnesses);
  if (harness) ads = ads.filter((a) => a.id === harness);

  const results: OpResult[] = [];

  for (const [name, flags] of Object.entries(profile.skills)) {
    for (const id of HARNESSES) {
      if (flags[id] === undefined) continue;
      const ad = adapters[id];
      if (!ads.includes(ad)) continue;
      results.push(await ad.setSkill(name, flags[id]!, dryRun));
    }
  }

  for (const [name, flags] of Object.entries(profile.mcp)) {
    for (const id of HARNESSES) {
      if (flags[id] === undefined) continue;
      const ad = adapters[id];
      if (!ads.includes(ad)) continue;
      results.push(await ad.setMcp(name, flags[id]!, dryRun));
    }
  }

  if (!dryRun) await setActiveProfile(profile.name);
  return results;
}

export function isNoopResult(r: OpResult): boolean {
  return r.action === "noop" && r.status === "ok";
}

export function summarizeResults(results: OpResult[]): {
  total: number;
  noop: number;
  planned: number;
  changed: number;
  skipped: number;
  error: number;
} {
  let noop = 0;
  let planned = 0;
  let changed = 0;
  let skipped = 0;
  let error = 0;
  for (const r of results) {
    if (r.status === "error") error++;
    else if (r.status === "skipped") skipped++;
    else if (r.status === "planned") planned++;
    else if (isNoopResult(r)) noop++;
    else changed++;
  }
  return { total: results.length, noop, planned, changed, skipped, error };
}

export type FormatResultsOptions = {
  /** When false (default), hide noop rows. */
  verbose?: boolean;
};

export function formatResults(
  results: OpResult[],
  opts: FormatResultsOptions = {},
): string {
  const verbose = opts.verbose ?? false;
  if (results.length === 0) return "(nothing to apply)";

  const visible = verbose ? results : results.filter((r) => !isNoopResult(r));
  const summary = summarizeResults(results);
  const lines = visible.map(
    (r) =>
      `${r.status.padEnd(8)} ${r.harness}/${r.kind}/${r.name} ${r.action}${
        r.detail ? ` — ${r.detail}` : ""
      }`,
  );

  const parts: string[] = [];
  if (lines.length) parts.push(lines.join("\n"));
  else parts.push("(no changes)");

  const bits = [
    `${summary.total} checked`,
    summary.changed ? `${summary.changed} changed` : null,
    summary.planned ? `${summary.planned} planned` : null,
    summary.skipped ? `${summary.skipped} skipped` : null,
    summary.error ? `${summary.error} error` : null,
    summary.noop ? `${summary.noop} noop` : null,
  ].filter(Boolean);
  parts.push(bits.join(", "));
  return parts.join("\n");
}
