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
 * - optionally absorb ~/.agents/skills into library (prefer syncSharedToActiveProfile)
 * - absorb real (non-symlink) dirs from harness skill folders into library
 */
export async function migrateSkillsToLibrary(opts?: {
  dryRun?: boolean;
  /** When true, leave ~/.agents/skills alone (handled by sync → active profile). */
  skipShared?: boolean;
  /** When true, leave harness skill dirs alone (also handled by sync → active). */
  skipHarness?: boolean;
}): Promise<WorkspaceOp[]> {
  const dryRun = opts?.dryRun ?? false;
  const skipShared = opts?.skipShared ?? false;
  const skipHarness = opts?.skipHarness ?? false;
  const ops: WorkspaceOp[] = [];
  await ensureDir(hubLibrarySkillsDir());
  await ensureDir(hubWorkspacesDir());

  if (!skipShared) {
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
      if (!dryRun) {
        const left = (await readdir(shared)).filter((n) => !n.startsWith("."));
        if (left.length === 0) {
          // empty
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
    } else if (!existsSync(shared)) {
      if (!dryRun) await ensureDir(shared);
      ops.push({
        action: "park-shared",
        status: dryRun ? "planned" : "ok",
        detail: dryRun
          ? `would create empty ${shared}`
          : `created empty ${shared}`,
      });
    }
  }

  if (!skipHarness) {
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
 * Resolve skill package path: active/workspace first, then library.
 */
export async function resolveSkillSource(
  name: string,
  profileName?: string,
): Promise<string | undefined> {
  if (profileName) {
    const ws = join(hubWorkspaceSkillsDir(profileName), name);
    if (existsSync(join(ws, "SKILL.md"))) return ws;
  }
  const lib = join(hubLibrarySkillsDir(), name);
  if (existsSync(join(lib, "SKILL.md"))) return lib;
  return undefined;
}

/** @deprecated use resolveSkillSource */
export async function resolveLibrarySkill(
  name: string,
): Promise<string | undefined> {
  return resolveSkillSource(name);
}

/**
 * Install a skill into one profile workspace only (real copy, not shared).
 * Conflicts if the name already exists in this or another profile workspace.
 * Does not modify harness dirs — call apply afterward.
 */
export async function installSkillToWorkspace(opts: {
  sourcePath: string;
  profileName: string;
  dryRun?: boolean;
}): Promise<{ ops: WorkspaceOp[]; name: string }> {
  const { assertSkillInstallAllowed, findSkillOwners } = await import(
    "./ownership.ts"
  );
  const dryRun = opts.dryRun ?? false;
  const source = resolve(opts.sourcePath);
  const name = basename(source);
  const skillMd = join(source, "SKILL.md");
  if (!existsSync(skillMd)) {
    throw new Error(`not a skill directory (missing SKILL.md): ${source}`);
  }

  const owners = await findSkillOwners(name);
  assertSkillInstallAllowed(name, opts.profileName, owners);

  const ops: WorkspaceOp[] = [];
  const ws = hubWorkspaceSkillsDir(opts.profileName);
  const dest = join(ws, name);

  if (dryRun) {
    ops.push({
      action: "workspace-install",
      status: "planned",
      detail: `would copy ${source} → ${dest} (profile-private)`,
    });
    return { ops, name };
  }

  await ensureDir(ws);
  await cp(source, dest, { recursive: true });
  ops.push({
    action: "workspace-install",
    status: "ok",
    detail: `copied into workspace ${opts.profileName} (profile-private)`,
  });

  return { ops, name };
}

/**
 * Move/copy an orphan library skill into a profile workspace (claims the name).
 */
export async function adoptSkillFromLibrary(opts: {
  name: string;
  profileName: string;
  dryRun?: boolean;
}): Promise<{ ops: WorkspaceOp[]; name: string }> {
  const { assertSkillAdoptAllowed, findSkillOwners } = await import(
    "./ownership.ts"
  );
  const dryRun = opts.dryRun ?? false;
  const name = opts.name;
  const owners = await findSkillOwners(name);
  assertSkillAdoptAllowed(name, opts.profileName, owners);

  const lib = join(hubLibrarySkillsDir(), name);
  const dest = join(hubWorkspaceSkillsDir(opts.profileName), name);
  const ops: WorkspaceOp[] = [];

  if (dryRun) {
    ops.push({
      action: "workspace-adopt",
      status: "planned",
      detail: `would move ${lib} → ${dest}`,
    });
    return { ops, name };
  }

  await ensureDir(hubWorkspaceSkillsDir(opts.profileName));
  await rename(lib, dest);
  ops.push({
    action: "workspace-adopt",
    status: "ok",
    detail: `moved library → workspace ${opts.profileName}`,
  });
  return { ops, name };
}

/**
 * Remove a skill from one profile workspace. Other profiles untouched.
 * If no other profile owns the name, also drop the orphan library copy.
 */
export async function removeSkillFromWorkspace(opts: {
  name: string;
  profileName: string;
  dryRun?: boolean;
}): Promise<{ ops: WorkspaceOp[]; name: string }> {
  const { findSkillOwners, skillUsedElsewhere } = await import(
    "./ownership.ts"
  );
  const dryRun = opts.dryRun ?? false;
  const name = opts.name;
  const ops: WorkspaceOp[] = [];
  const dest = join(hubWorkspaceSkillsDir(opts.profileName), name);

  if (!existsSync(dest)) {
    ops.push({
      action: "workspace-remove",
      status: "skipped",
      detail: `${name} not in workspace ${opts.profileName}`,
    });
    return { ops, name };
  }

  if (dryRun) {
    ops.push({
      action: "workspace-remove",
      status: "planned",
      detail: `would remove ${dest}`,
    });
  } else if (await isSymlink(dest)) {
    await unlink(dest);
    ops.push({
      action: "workspace-remove",
      status: "ok",
      detail: `unlinked ${dest}`,
    });
  } else {
    await rm(dest, { recursive: true, force: true });
    ops.push({
      action: "workspace-remove",
      status: "ok",
      detail: `deleted ${dest}`,
    });
  }

  const lib = join(hubLibrarySkillsDir(), name);
  if (dryRun) {
    const owners = await findSkillOwners(name);
    if (
      !skillUsedElsewhere(name, opts.profileName, owners) &&
      existsSync(lib)
    ) {
      ops.push({
        action: "library-remove",
        status: "planned",
        detail: `would remove orphan library ${lib}`,
      });
    }
  } else {
    const ownersAfter = await findSkillOwners(name);
    if (!ownersAfter.profiles.length && existsSync(lib)) {
      await rm(lib, { recursive: true, force: true });
      ops.push({
        action: "library-remove",
        status: "ok",
        detail: `removed orphan library ${lib}`,
      });
    }
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

/**
 * Copy skill membership from one profile workspace into another.
 * Reuses library symlink when possible; otherwise copies the package.
 * Does not remove from the source profile.
 */
export async function copySkillsBetweenProfiles(opts: {
  fromProfile: string;
  toProfile: string;
  names: string[];
  dryRun?: boolean;
}): Promise<{ ops: WorkspaceOp[]; copied: string[]; skipped: string[] }> {
  const dryRun = opts.dryRun ?? false;
  const ops: WorkspaceOp[] = [];
  const copied: string[] = [];
  const skipped: string[] = [];

  if (opts.fromProfile === opts.toProfile) {
    throw new Error("from and to profiles must differ");
  }

  const { loadProfile, saveProfile } = await import("./config.ts");
  const fromProfile = await loadProfile(opts.fromProfile);
  let toProfile: Profile = await loadProfile(opts.toProfile).catch(
    async () => {
      const blank: Profile = {
        name: opts.toProfile,
        description: `workspace ${opts.toProfile}`,
        skills: {},
        mcp: {},
      };
      if (!dryRun) await saveProfile(blank);
      return blank;
    },
  );

  const fromWs = hubWorkspaceSkillsDir(opts.fromProfile);
  const toWs = hubWorkspaceSkillsDir(opts.toProfile);
  if (!dryRun) await ensureDir(toWs);

  for (const name of opts.names) {
    const fromPath = join(fromWs, name);
    const toPath = join(toWs, name);
    if (!existsSync(join(fromPath, "SKILL.md"))) {
      ops.push({
        action: "skill-copy",
        status: "skipped",
        detail: `${name} not in workspace ${opts.fromProfile}`,
      });
      skipped.push(name);
      continue;
    }
    if (existsSync(toPath)) {
      ops.push({
        action: "skill-copy",
        status: "ok",
        detail: `${name} already in ${opts.toProfile}`,
      });
      skipped.push(name);
      // still sync flags from source if missing
      if (!dryRun && !toProfile.skills[name] && fromProfile.skills[name]) {
        toProfile = {
          ...toProfile,
          skills: {
            ...toProfile.skills,
            [name]: { ...fromProfile.skills[name]! },
          },
        };
      }
      continue;
    }

    if (dryRun) {
      ops.push({
        action: "skill-copy",
        status: "planned",
        detail: `would copy ${name} ${opts.fromProfile} → ${opts.toProfile}`,
      });
      copied.push(name);
      continue;
    }

    // Prefer linking to library when source is a symlink into library.
    let linked = false;
    if (await isSymlink(fromPath)) {
      const { readlink } = await import("node:fs/promises");
      const target = await readlink(fromPath);
      const abs = target.startsWith("/")
        ? target
        : join(fromWs, target);
      if (abs.startsWith(hubLibrarySkillsDir())) {
        await symlink(abs, toPath);
        linked = true;
      }
    }
    if (!linked) {
      const lib = join(hubLibrarySkillsDir(), name);
      if (existsSync(join(lib, "SKILL.md"))) {
        await symlink(lib, toPath);
      } else {
        await cp(fromPath, toPath, { recursive: true });
      }
    }

    const flags = fromProfile.skills[name] ?? {
      cursor: true,
      claude: false,
      codex: true,
      pi: true,
      omp: true,
    };
    toProfile = {
      ...toProfile,
      skills: { ...toProfile.skills, [name]: { ...flags } },
    };
    copied.push(name);
    ops.push({
      action: "skill-copy",
      status: "ok",
      detail: `${name} → workspace ${opts.toProfile}`,
    });
  }

  if (!dryRun && (copied.length || skipped.length)) {
    await saveProfile(toProfile);
  }

  return { ops, copied, skipped };
}
