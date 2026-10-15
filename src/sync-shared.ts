import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, watch } from "node:fs/promises";
import { join } from "node:path";
import {
  getActiveProfile,
  loadConfig,
  loadProfile,
  saveProfile,
} from "./config.ts";
import { findSkillOwners, NameConflictError } from "./ownership.ts";
import {
  agentsSkillsPath,
  harnessSkillDir,
  hubWorkspaceSkillsDir,
} from "./paths.ts";
import { HARNESSES, type HarnessId, type Profile } from "./types.ts";
import { ensureSharedParked, type WorkspaceOp } from "./workspace.ts";

export type SyncSharedResult = {
  ops: WorkspaceOp[];
  /** Skill names newly claimed into the active profile. */
  added: string[];
  /** Names skipped due to conflict. */
  conflicts: Array<{ name: string; detail: string }>;
  profileName: string;
};

type SkillSource = "agents" | HarnessId;

type Candidate = {
  name: string;
  path: string;
  source: SkillSource;
};

/** Roots we watch / scan for externally installed real skill dirs. */
export function externalSkillRoots(): Array<{
  source: SkillSource;
  path: string;
}> {
  return [
    { source: "agents", path: agentsSkillsPath() },
    ...HARNESSES.map((id) => ({
      source: id as SkillSource,
      path: harnessSkillDir(id),
    })),
  ];
}

async function isRealSkillDir(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const st = await lstat(path);
  // Hub projections are symlinks — never absorb those.
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  return existsSync(join(path, "SKILL.md"));
}

async function listCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const root of externalSkillRoots()) {
    if (!existsSync(root.path)) continue;
    let entries: string[];
    try {
      entries = await readdir(root.path);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const child = join(root.path, name);
      if (!(await isRealSkillDir(child))) continue;
      out.push({ name, path: child, source: root.source });
    }
  }
  return out;
}

async function enableSkillOnProfile(
  profileName: string,
  skillName: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  const cfg = await loadConfig();
  let profile: Profile;
  try {
    profile = await loadProfile(profileName);
  } catch {
    profile = {
      name: profileName,
      description: `workspace ${profileName}`,
      skills: {},
      mcp: {},
    };
  }
  const flags: Record<HarnessId, boolean> = {
    cursor: false,
    claude: false,
    codex: false,
    pi: false,
    omp: false,
  };
  for (const id of HARNESSES) {
    flags[id] = cfg.harnesses[id] !== false;
  }
  await saveProfile({
    ...profile,
    skills: { ...profile.skills, [skillName]: flags },
  });
}

function sourceLabel(source: SkillSource): string {
  return source === "agents" ? "~/.agents/skills" : `~/${source} skills`;
}

/**
 * Absorb externally installed real skill dirs into the active profile:
 * - ~/.agents/skills
 * - ~/.cursor/skills, ~/.claude/skills, ~/.codex/skills, ~/.pi/agent/skills, ~/.omp/agent/skills
 *
 * Symlinks (hub projections) are ignored. Name conflicts with other profiles
 * or library orphans are reported and left in place.
 */
export async function syncSharedToActiveProfile(opts?: {
  dryRun?: boolean;
  /** Override active profile (e.g. during apply of a named profile). */
  profileName?: string;
}): Promise<SyncSharedResult> {
  const dryRun = opts?.dryRun ?? false;
  const profileName =
    opts?.profileName ?? (await getActiveProfile()) ?? undefined;
  if (!profileName) {
    throw new Error(
      "no active profile — run agent-hub apply <name> or pass --profile",
    );
  }

  const ops: WorkspaceOp[] = [];
  const added: string[] = [];
  const conflicts: Array<{ name: string; detail: string }> = [];

  // Ensure shared agents dir exists (parked empty by default).
  const shared = agentsSkillsPath();
  if (!existsSync(shared) && !dryRun) {
    await mkdir(shared, { recursive: true });
  }

  const candidates = await listCandidates();
  const byName = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }

  const wsRoot = hubWorkspaceSkillsDir(profileName);
  if (!dryRun) await mkdir(wsRoot, { recursive: true });

  for (const [name, group] of [...byName.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const owners = await findSkillOwners(name);
    const inActive = owners.profiles.includes(profileName);
    const others = owners.profiles.filter((p) => p !== profileName);

    if (others.length || (owners.library && !inActive)) {
      const detail = [
        ...others.map((p) => `profile:${p}`),
        ...(owners.library ? ["library"] : []),
      ].join(", ");
      conflicts.push({ name, detail });
      const where = group.map((g) => sourceLabel(g.source)).join(", ");
      ops.push({
        action: "sync-external",
        status: "skipped",
        detail: `conflict ${name} (${detail}) — left in ${where}`,
      });
      continue;
    }

    if (inActive) {
      for (const c of group) {
        if (dryRun) {
          ops.push({
            action: "sync-external",
            status: "planned",
            detail: `would drop duplicate ${c.path} (already in ${profileName})`,
          });
        } else {
          await rm(c.path, { recursive: true, force: true });
          ops.push({
            action: "sync-external",
            status: "ok",
            detail: `dropped duplicate ${name} from ${sourceLabel(c.source)}`,
          });
        }
      }
      continue;
    }

    const [primary, ...rest] = group;
    if (!primary) continue;
    const dest = join(wsRoot, name);

    if (dryRun) {
      ops.push({
        action: "sync-external",
        status: "planned",
        detail: `would move ${primary.path} → ${dest}`,
      });
      for (const c of rest) {
        ops.push({
          action: "sync-external",
          status: "planned",
          detail: `would drop extra copy ${c.path}`,
        });
      }
      added.push(name);
      continue;
    }

    await rename(primary.path, dest);
    await enableSkillOnProfile(profileName, name, false);
    added.push(name);
    ops.push({
      action: "sync-external",
      status: "ok",
      detail: `moved ${name} from ${sourceLabel(primary.source)} → workspace ${profileName}`,
    });
    for (const c of rest) {
      if (existsSync(c.path)) {
        await rm(c.path, { recursive: true, force: true });
        ops.push({
          action: "sync-external",
          status: "ok",
          detail: `dropped extra copy from ${sourceLabel(c.source)}`,
        });
      }
    }
  }

  // Park ~/.agents/skills when no conflicting skills remain there.
  const agentsLeft = existsSync(shared)
    ? (await readdir(shared)).filter((n) => !n.startsWith("."))
    : [];
  let agentsSkillLeft = 0;
  for (const n of agentsLeft) {
    if (await isRealSkillDir(join(shared, n))) agentsSkillLeft++;
  }
  if (agentsSkillLeft === 0) {
    const parked = await ensureSharedParked(dryRun);
    ops.push(parked);
  } else {
    ops.push({
      action: "park-shared",
      status: "skipped",
      detail: `${agentsSkillLeft} conflicting skill(s) still in ${shared}`,
    });
  }

  return { ops, added, conflicts, profileName };
}

export function formatSyncSharedResult(r: SyncSharedResult): string {
  const lines: string[] = [
    `profile: ${r.profileName}`,
    `added: ${r.added.length ? r.added.join(", ") : "(none)"}`,
  ];
  if (r.conflicts.length) {
    lines.push("conflicts:");
    for (const c of r.conflicts) {
      lines.push(`  ${c.name} — ${c.detail}`);
    }
  }
  for (const o of r.ops) {
    lines.push(
      `${o.status.padEnd(8)} ${o.action}${o.detail ? ` — ${o.detail}` : ""}`,
    );
  }
  return lines.join("\n");
}

/**
 * Watch ~/.agents/skills + all harness skill dirs; debounce-sync into active profile.
 */
export async function watchSharedSkills(opts: {
  signal?: AbortSignal;
  debounceMs?: number;
  onSync?: (result: SyncSharedResult) => void;
  onError?: (err: unknown) => void;
  profileName?: string;
}): Promise<void> {
  const roots = externalSkillRoots();
  for (const r of roots) {
    await mkdir(r.path, { recursive: true });
  }

  const debounceMs = opts.debounceMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;

  const run = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const result = await syncSharedToActiveProfile({
        profileName: opts.profileName,
      });
      opts.onSync?.(result);
    } catch (err) {
      if (err instanceof NameConflictError) opts.onError?.(err);
      else opts.onError?.(err);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void run();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), debounceMs);
  };

  await run();

  const watchers = roots.map((r) => watch(r.path, { recursive: true }));
  const abort = () => {
    for (const w of watchers) void w.return?.();
  };
  opts.signal?.addEventListener("abort", abort, { once: true });

  try {
    await Promise.race(
      watchers.map(async (watcher) => {
        for await (const _event of watcher) {
          if (opts.signal?.aborted) break;
          schedule();
        }
      }),
    );
  } finally {
    if (timer) clearTimeout(timer);
    abort();
    opts.signal?.removeEventListener("abort", abort);
  }
}
