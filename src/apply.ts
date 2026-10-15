import { adapters, enabledAdapters } from "./adapters/index.ts";
import { loadConfig, loadProfile, setActiveProfile } from "./config.ts";
import { syncSharedToActiveProfile } from "./sync-shared.ts";
import {
  HARNESSES,
  type HarnessId,
  type OpResult,
  type Profile,
} from "./types.ts";
import {
  formatWorkspaceOps,
  migrateSkillsToLibrary,
  syncWorkspace,
  workspaceOpsAsResults,
} from "./workspace.ts";

export type ApplyOptions = {
  profile: Profile;
  dryRun?: boolean;
  /** Limit to one harness. */
  harness?: HarnessId;
  /** Skip library migrate / shared park (tests). */
  skipWorkspacePrep?: boolean;
};

/** Skills/MCP that should be live on each harness after apply. */
function desiredEnabled(
  profile: Profile,
  kind: "skills" | "mcp",
): Map<HarnessId, Set<string>> {
  const out = new Map<HarnessId, Set<string>>();
  for (const id of HARNESSES) out.set(id, new Set());
  const bucket = kind === "skills" ? profile.skills : profile.mcp;
  for (const [name, flags] of Object.entries(bucket)) {
    for (const id of HARNESSES) {
      if (flags[id] === true) out.get(id)!.add(name);
    }
  }
  return out;
}

async function projectProfile(
  profile: Profile,
  ads: ReturnType<typeof enabledAdapters>,
  dryRun: boolean,
): Promise<OpResult[]> {
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

  return results;
}

/**
 * Remove harness projections that are not enabled in the profile.
 * Empty profile → clear all hub-managed skill links (and disable extra MCP).
 */
async function pruneHarnessExtras(
  profile: Profile,
  ads: ReturnType<typeof enabledAdapters>,
  dryRun: boolean,
): Promise<OpResult[]> {
  const results: OpResult[] = [];
  const wantSkills = desiredEnabled(profile, "skills");
  const wantMcp = desiredEnabled(profile, "mcp");

  for (const ad of ads) {
    const liveSkills = await ad.listSkills();
    for (const s of liveSkills) {
      if (wantSkills.get(ad.id)?.has(s.name)) continue;
      results.push(await ad.setSkill(s.name, false, dryRun));
    }

    const liveMcp = await ad.listMcp();
    for (const m of liveMcp) {
      if (!m.enabled) continue;
      if (wantMcp.get(ad.id)?.has(m.name)) continue;
      results.push(await ad.setMcp(m.name, false, dryRun));
    }
  }

  return results;
}

export async function applyProfile(opts: ApplyOptions): Promise<OpResult[]> {
  const { profile, dryRun = false, harness, skipWorkspacePrep = false } = opts;
  const cfg = await loadConfig();
  let ads = enabledAdapters(cfg.harnesses);
  if (harness) ads = ads.filter((a) => a.id === harness);

  const results: OpResult[] = [];

  // Active early so shared sync + skill sources target this profile.
  if (!dryRun) await setActiveProfile(profile.name);

  let effective = profile;

  if (!skipWorkspacePrep) {
    // ~/.agents + harness skill dirs (real installs) → active profile workspace
    const synced = await syncSharedToActiveProfile({
      dryRun,
      profileName: profile.name,
    });
    results.push(...workspaceOpsAsResults(synced.ops));
    for (const c of synced.conflicts) {
      results.push({
        harness: "pi",
        kind: "skill",
        name: c.name,
        action: "enable",
        status: "skipped",
        detail: `external sync conflict — ${c.detail}`,
      });
    }

    // Legacy leftover absorb disabled — sync owns agents + harness real dirs.
    const migrated = await migrateSkillsToLibrary({
      dryRun,
      skipShared: true,
      skipHarness: true,
    });
    results.push(...workspaceOpsAsResults(migrated));

    if (!dryRun && synced.added.length) {
      effective = await loadProfile(profile.name);
    }
    const wsOps = await syncWorkspace(effective, dryRun);
    results.push(...workspaceOpsAsResults(wsOps));
  }

  results.push(...(await projectProfile(effective, ads, dryRun)));
  results.push(...(await pruneHarnessExtras(effective, ads, dryRun)));

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

export { formatWorkspaceOps };
