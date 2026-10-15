import {
  readdir,
  lstat,
  symlink,
  unlink,
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { HarnessId, OpResult, SkillRef } from "../types.ts";
import { hubLibrarySkillsDir } from "../paths.ts";

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
 * Enable = ensure symlink at targetDir/name → sourcePath.
 * Disable = remove symlink, or relocate a real directory into the library.
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
      const st = await lstat(dest);
      if (st.isSymbolicLink() || st.isDirectory()) {
        return {
          harness,
          kind: "skill",
          name,
          action: "noop",
          status: "ok",
          detail: "already present",
        };
      }
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
  if (st.isSymbolicLink()) {
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

  // Real directory: absorb into library (or rm duplicate) so harness no longer sees it.
  const lib = join(hubLibrarySkillsDir(), name);
  if (!existsSync(lib)) {
    if (dryRun) {
      return {
        harness,
        kind: "skill",
        name,
        action: "would-disable",
        status: "planned",
        detail: `would move ${dest} → ${lib}`,
      };
    }
    await mkdir(hubLibrarySkillsDir(), { recursive: true });
    await rename(dest, lib);
    return {
      harness,
      kind: "skill",
      name,
      action,
      status: "ok",
      detail: `moved to library ${lib}`,
    };
  }
  if (dryRun) {
    return {
      harness,
      kind: "skill",
      name,
      action: "would-disable",
      status: "planned",
      detail: `would rm duplicate ${dest} (library has ${name})`,
    };
  }
  await rm(dest, { recursive: true, force: true });
  return {
    harness,
    kind: "skill",
    name,
    action,
    status: "ok",
    detail: `removed duplicate ${dest}`,
  };
}
