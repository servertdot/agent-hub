import { readdir, lstat, symlink, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { HarnessId, OpResult, SkillRef } from "../types.ts";

/** List skill directories that contain SKILL.md under roots. */
export async function listSkillDirs(
  roots: string[],
  source: string,
): Promise<SkillRef[]> {
  const out: SkillRef[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const path = join(root, name);
      const skillMd = join(path, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, path, source: `${source}:${root}` });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Enable = ensure symlink (or leave existing dir) at targetDir/name → sourcePath.
 * Disable = remove symlink only (never delete a real directory).
 */
export async function setSkillLink(opts: {
  harness: HarnessId;
  targetDir: string;
  name: string;
  sourcePath: string | undefined;
  enabled: boolean;
  dryRun: boolean;
}): Promise<OpResult> {
  const { harness, targetDir, name, sourcePath, enabled, dryRun } = opts;
  const dest = join(targetDir, name);
  const action = enabled ? "enable" : "disable";

  if (enabled) {
    if (!sourcePath) {
      return {
        harness,
        kind: "skill",
        name,
        action,
        status: "skipped",
        detail: "no catalog source path",
      };
    }
    if (existsSync(dest)) {
      return {
        harness,
        kind: "skill",
        name,
        action: "noop",
        status: "ok",
        detail: "already present",
      };
    }
    if (dryRun) {
      return {
        harness,
        kind: "skill",
        name,
        action: "would-enable",
        status: "planned",
        detail: `symlink ${dest} -> ${sourcePath}`,
      };
    }
    await mkdir(targetDir, { recursive: true });
    await symlink(sourcePath, dest);
    return {
      harness,
      kind: "skill",
      name,
      action,
      status: "ok",
      detail: `linked ${dest}`,
    };
  }

  // disable
  if (!existsSync(dest)) {
    return {
      harness,
      kind: "skill",
      name,
      action: "noop",
      status: "ok",
      detail: "already absent",
    };
  }
  const st = await lstat(dest);
  if (!st.isSymbolicLink()) {
    return {
      harness,
      kind: "skill",
      name,
      action: "disable",
      status: "skipped",
      detail: "refusing to remove non-symlink directory",
    };
  }
  if (dryRun) {
    return {
      harness,
      kind: "skill",
      name,
      action: "would-disable",
      status: "planned",
      detail: `unlink ${dest}`,
    };
  }
  await unlink(dest);
  return {
    harness,
    kind: "skill",
    name,
    action,
    status: "ok",
    detail: `unlinked ${dest}`,
  };
}
