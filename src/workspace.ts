import {
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { listSkillDirs } from "./adapters/fs-skills.ts";
import type { OpResult, Profile } from "./types.ts";
import { HARNESSES, type HarnessId } from "./types.ts";
import {
  agentsSkillsPath,
  harnessSkillDir,
  hubLibrarySkillsDir,
  hubWorkspaceSkillsDir,
  hubWorkspacesDir,
} from "./paths.ts";

export type WorkspaceOp = {
  action: string;
  status: "ok" | "planned" | "skipped" | "error";
  detail?: string;
};

function skillHasAnyHarness(flags: Partial<Record<HarnessId, boolean>>): boolean {
  return HARNESSES.some((h) => flags[h] === true);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** True if path exists and is a symlink. */
async function isSymlink(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const st = await lstat(path);
  return st.isSymbolicLink();
}

/** True if path exists as a real directory (not a symlink). */
async function isRealDir(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const st = await lstat(path);
  return st.isDirectory() && !st.isSymbolicLink();
}

/**
 * Move a skill directory into the library if missing there.
 * Returns the library path for the skill.
 */
export async function absorbSkillIntoLibrary(
  name: string,
  sourcePath: string,
  dryRun: boolean,
): Promise<WorkspaceOp> {
  const dest = join(hubLibrarySkillsDir(), name);
  if (existsSync(dest)) {
    return {
      action: "library-absorb",
      status: "ok",
      detail: `${name} already in library`,
    };
  }
  if (dryRun) {
    return {
      action: "library-absorb",
      status: "planned",
      detail: `would move ${sourcePath} → ${dest}`,
    };
  }
  await ensureDir(hubLibrarySkillsDir());
  await rename(sourcePath, dest);
  return {
    action: "library-absorb",
    status: "ok",
    detail: `moved ${sourcePath} → ${dest}`,
  };
}

/**
 * One-shot / apply prelude:
 * - absorb ~/.agents/skills real packages into library, then leave shared empty
 * - absorb real (non-symlink) dirs from harness skill folders into library
 */
export async function migrateSkillsToLibrary(opts?: {
  dryRun?: boolean;
}): Promise<WorkspaceOp[]> {
  const dryRun = opts?.dryRun ?? false;
  const ops: WorkspaceOp[] = [];
  await ensureDir(hubLibrarySkillsDir());
  await ensureDir(hubWorkspacesDir());

  const shared = agentsSkillsPath();
  if (await isRealDir(shared)) {
    const entries = await readdir(shared);
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const child = join(shared, name);
      if (!(await isRealDir(child))) continue;
      const skillMd = join(child, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      ops.push(await absorbSkillIntoLibrary(name, child, dryRun));
    }
    // Park shared: rename leftover dir, recreate empty so tools don't auto-load.
    if (!dryRun) {
      const left = (await readdir(shared)).filter((n) => !n.startsWith("."));
      if (left.length === 0) {
        // already empty after moves — keep empty dir
      } else {
        const parked = `${shared}.hub-parked-${Date.now()}`;
        await rename(shared, parked);
        await ensureDir(shared);
        ops.push({
          action: "park-shared",
          status: "ok",
          detail: `renamed leftover ${shared} → ${parked}; recreated empty`,
        });
      }
    } else {
      ops.push({
        action: "park-shared",
        status: "planned",
        detail: `would empty/park ${shared}`,
      });
    }
  } else if (await isSymlink(shared)) {
    // Already managed — ensure it does not point at a full pool.
    // Apply will re-point via ensureSharedParked.
  } else if (!existsSync(shared)) {
    if (!dryRun) await ensureDir(shared);
    ops.push({
      action: "park-shared",
      status: dryRun ? "planned" : "ok",
      detail: dryRun ? `would create empty ${shared}` : `created empty ${shared}`,
    });
  }

  for (const id of HARNESSES) {
    const dir = harnessSkillDir(id);
    if (!(await isRealDir(dir))) continue;
    const entries = await readdir(dir);
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const child = join(dir, name);
      if (!(await isRealDir(child))) continue;
      if (!existsSync(join(child, "SKILL.md"))) continue;
      const lib = join(hubLibrarySkillsDir(), name);
      if (!existsSync(lib)) {
        ops.push(await absorbSkillIntoLibrary(name, child, dryRun));
      } else if (dryRun) {
        ops.push({
          action: "library-absorb",
          status: "planned",
          detail: `would rm duplicate ${id}/${name} (library has it)`,
        });
      } else {
        await rm(child, { recursive: true, force: true });
        ops.push({
          action: "library-absorb",
          status: "ok",
          detail: `removed duplicate ${id}/${name} (library has it)`,
        });
      }
    }
  }

  return ops;
}

/** Ensure ~/.agents/skills is an empty real directory (no leaked shared pool). */
export async function ensureSharedParked(dryRun: boolean): Promise<WorkspaceOp> {
  const shared = agentsSkillsPath();
  if (await isSymlink(shared)) {
    if (dryRun) {
      return {
        action: "park-shared",
        status: "planned",
        detail: `would replace symlink ${shared} with empty dir`,
      };
    }
    await unlink(shared);
    await ensureDir(shared);
    return {
      action: "park-shared",
      status: "ok",
      detail: `replaced symlink with empty ${shared}`,
    };
  }
  if (await isRealDir(shared)) {
    const entries = (await readdir(shared)).filter((n) => !n.startsWith("."));
    if (entries.length === 0) {
      return {
        action: "park-shared",
        status: "ok",
        detail: `${shared} already empty`,
      };
    }
    // Non-empty real dir should have been migrated; force park.
    if (dryRun) {
      return {
        action: "park-shared",
        status: "planned",
        detail: `would park non-empty ${shared} (${entries.length} entries)`,
      };
    }
    const parked = `${shared}.hub-parked-${Date.now()}`;
    await rename(shared, parked);
    await ensureDir(shared);
    return {
      action: "park-shared",
      status: "ok",
      detail: `parked ${parked}; empty ${shared}`,
    };
  }
  if (!dryRun) await ensureDir(join(shared, ".."));
  if (!dryRun) await ensureDir(shared);
  return {
    action: "park-shared",
    status: dryRun ? "planned" : "ok",
    detail: dryRun ? `would create empty ${shared}` : `ensured empty ${shared}`,
  };
}

/**
 * Materialize profile workspace: symlinks into library for skills with any
 * harness enabled; remove workspace entries that are fully off.
 */
export async function syncWorkspace(
  profile: Profile,
  dryRun: boolean,
): Promise<WorkspaceOp[]> {
  const ops: WorkspaceOp[] = [];
  const ws = hubWorkspaceSkillsDir(profile.name);
  if (!dryRun) await ensureDir(ws);
  else {
    ops.push({
      action: "workspace-dir",
      status: "planned",
      detail: `would ensure ${ws}`,
    });
  }

  const desired = new Set<string>();
  for (const [name, flags] of Object.entries(profile.skills)) {
    if (skillHasAnyHarness(flags)) desired.add(name);
  }

  // Add / refresh desired
  for (const name of desired) {
    const lib = join(hubLibrarySkillsDir(), name);
    const dest = join(ws, name);
    if (!existsSync(lib)) {
      ops.push({
        action: "workspace-link",
        status: "skipped",
        detail: `${name}: not in library (${lib})`,
      });
      continue;
    }
    if (existsSync(dest)) {
      if (await isSymlink(dest)) {
        ops.push({
          action: "workspace-link",
          status: "ok",
          detail: `${name} already linked`,
        });
        continue;
      }
      ops.push({
        action: "workspace-link",
        status: "skipped",
        detail: `${name}: real dir in workspace, leave alone`,
      });
      continue;
    }
    if (dryRun) {
      ops.push({
        action: "workspace-link",
        status: "planned",
        detail: `would link ${dest} → ${lib}`,
      });
      continue;
    }
    await symlink(lib, dest);
    ops.push({
      action: "workspace-link",
      status: "ok",
      detail: `linked ${name}`,
    });
  }

  // Remove workspace skills not desired
  if (existsSync(ws)) {
    const entries = await readdir(ws);
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (desired.has(name)) continue;
      const dest = join(ws, name);
      if (!(await isSymlink(dest))) {
        ops.push({
          action: "workspace-unlink",
          status: "skipped",
          detail: `${name}: refusing to remove non-symlink`,
        });
        continue;
      }
      if (dryRun) {
        ops.push({
          action: "workspace-unlink",
          status: "planned",
          detail: `would unlink ${dest}`,
        });
        continue;
      }
      await unlink(dest);
      ops.push({
        action: "workspace-unlink",
        status: "ok",
        detail: `unlinked ${name}`,
      });
    }
  }

  return ops;
}

/**
 * Resolve skill package path from library (preferred) or workspace.
 */
export async function resolveLibrarySkill(
  name: string,
): Promise<string | undefined> {
  const lib = join(hubLibrarySkillsDir(), name);
  if (existsSync(join(lib, "SKILL.md"))) return lib;
  return undefined;
}

/**
 * Install a skill directory into the library and active workspace.
 * Does not modify harness dirs — call apply afterward.
 */
export async function installSkillToWorkspace(opts: {
  sourcePath: string;
  profileName: string;
  dryRun?: boolean;
}): Promise<{ ops: WorkspaceOp[]; name: string }> {
  const dryRun = opts.dryRun ?? false;
  const source = resolve(opts.sourcePath);
  const name = basename(source);
  const skillMd = join(source, "SKILL.md");
  if (!existsSync(skillMd)) {
    throw new Error(`not a skill directory (missing SKILL.md): ${source}`);
  }

  const ops: WorkspaceOp[] = [];
  await ensureDir(hubLibrarySkillsDir());
  const lib = join(hubLibrarySkillsDir(), name);

  if (existsSync(lib)) {
    ops.push({
      action: "library-install",
      status: "ok",
      detail: `${name} already in library`,
    });
  } else if (dryRun) {
    ops.push({
      action: "library-install",
      status: "planned",
      detail: `would copy ${source} → ${lib}`,
    });
  } else {
    await cp(source, lib, { recursive: true });
    ops.push({
      action: "library-install",
      status: "ok",
      detail: `copied → ${lib}`,
    });
  }

  const ws = hubWorkspaceSkillsDir(opts.profileName);
  if (!dryRun) await ensureDir(ws);
  const dest = join(ws, name);
  if (existsSync(dest)) {
    ops.push({
      action: "workspace-install",
      status: "ok",
      detail: `${name} already in workspace ${opts.profileName}`,
    });
  } else if (dryRun) {
    ops.push({
      action: "workspace-install",
      status: "planned",
      detail: `would link ${dest} → ${lib}`,
    });
  } else {
    const target = existsSync(lib) ? lib : source;
    await symlink(target, dest);
    ops.push({
      action: "workspace-install",
      status: "ok",
      detail: `linked into workspace ${opts.profileName}`,
    });
  }

  return { ops, name };
}

export function formatWorkspaceOps(ops: WorkspaceOp[]): string {
  if (!ops.length) return "(no workspace ops)";
  return ops
    .map(
      (o) =>
        `${o.status.padEnd(8)} ${o.action}${o.detail ? ` — ${o.detail}` : ""}`,
    )
    .join("\n");
}

/** Map workspace ops into OpResult-shaped hub rows for unified apply output. */
export function workspaceOpsAsResults(
  ops: WorkspaceOp[],
  harness: HarnessId = "pi",
): OpResult[] {
  return ops.map((o) => ({
    harness,
    kind: "skill" as const,
    name: "_workspace",
    action:
      o.status === "planned"
        ? ("would-enable" as const)
        : o.action.includes("unlink") || o.action.includes("park")
          ? ("disable" as const)
          : ("enable" as const),
    status: o.status,
    detail: `${o.action}${o.detail ? `: ${o.detail}` : ""}`,
  }));
}

/** List skill names currently in a workspace. */
export async function listWorkspaceSkills(
  profileName: string,
): Promise<string[]> {
  const ws = hubWorkspaceSkillsDir(profileName);
  if (!existsSync(ws)) return [];
  const refs = await listSkillDirs([ws], "workspace");
  return refs.map((r) => r.name);
}

/** List skill names in the library. */
export async function listLibrarySkills(): Promise<string[]> {
  const refs = await listSkillDirs([hubLibrarySkillsDir()], "library");
  return refs.map((r) => r.name);
}
