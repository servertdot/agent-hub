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

export function formatResults(results: OpResult[]): string {
  if (results.length === 0) return "(nothing to apply)";
  return results
    .map(
      (r) =>
        `${r.status.padEnd(8)} ${r.harness}/${r.kind}/${r.name} ${r.action}${
          r.detail ? ` — ${r.detail}` : ""
        }`,
    )
    .join("\n");
}
