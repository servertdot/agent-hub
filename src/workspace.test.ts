import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readdir, lstat, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureSharedParked,
  installSkillToWorkspace,
  migrateSkillsToLibrary,
  syncWorkspace,
} from "./workspace.ts";
import {
  agentsSkillsPath,
  harnessSkillDir,
  hubLibrarySkillsDir,
  hubWorkspaceSkillsDir,
} from "./paths.ts";
import type { Profile } from "./types.ts";

async function makeSkill(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: t\n---\n`, "utf8");
  return dir;
}

describe("workspace model", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevHub: string | undefined;

  beforeEach(async () => {
    home = join(tmpdir(), `agent-hub-ws-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(home, { recursive: true });
    prevHome = process.env.HOME;
    prevHub = process.env.AGENT_HUB_DIR;
    process.env.HOME = home;
    process.env.AGENT_HUB_DIR = join(home, ".agent-hub");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.AGENT_HUB_DIR;
    else process.env.AGENT_HUB_DIR = prevHub;
  });

  test("migrate absorbs shared skills and parks empty ~/.agents/skills", async () => {
    const shared = agentsSkillsPath();
    await makeSkill(shared, "tdd");
    await makeSkill(shared, "review");

    const ops = await migrateSkillsToLibrary({ dryRun: false });
    expect(ops.some((o) => o.action === "library-absorb")).toBe(true);
    expect(existsSync(join(hubLibrarySkillsDir(), "tdd", "SKILL.md"))).toBe(true);
    expect(existsSync(join(hubLibrarySkillsDir(), "review", "SKILL.md"))).toBe(true);

    await ensureSharedParked(false);
    expect(existsSync(shared)).toBe(true);
    const left = (await readdir(shared)).filter((n) => !n.startsWith("."));
    expect(left).toEqual([]);
  });

  test("syncWorkspace links only skills enabled on some harness", async () => {
    await makeSkill(hubLibrarySkillsDir(), "tdd");
    await makeSkill(hubLibrarySkillsDir(), "off-skill");

    const profile: Profile = {
      name: "lab",
      skills: {
        tdd: {
          cursor: true,
          claude: false,
          codex: false,
          pi: false,
          omp: false,
        },
        "off-skill": {
          cursor: false,
          claude: false,
          codex: false,
          pi: false,
          omp: false,
        },
      },
      mcp: {},
    };

    const ops = await syncWorkspace(profile, false);
    expect(ops.some((o) => o.status === "ok" && o.detail?.includes("tdd"))).toBe(
      true,
    );
    const ws = hubWorkspaceSkillsDir("lab");
    expect(existsSync(join(ws, "tdd"))).toBe(true);
    expect(existsSync(join(ws, "off-skill"))).toBe(false);
    const st = await lstat(join(ws, "tdd"));
    expect(st.isSymbolicLink()).toBe(true);
  });

  test("installSkillToWorkspace copies into profile workspace only", async () => {
    const srcRoot = join(home, "incoming");
    await makeSkill(srcRoot, "new-skill");
    await mkdir(join(home, ".agent-hub", "profiles"), { recursive: true });
    await writeFile(
      join(home, ".agent-hub", "profiles", "stable.yaml"),
      "name: stable\nskills: {}\nmcp: {}\n",
      "utf8",
    );

    const { ops, name } = await installSkillToWorkspace({
      sourcePath: join(srcRoot, "new-skill"),
      profileName: "stable",
      dryRun: false,
    });
    expect(name).toBe("new-skill");
    expect(ops.length).toBeGreaterThan(0);
    expect(existsSync(join(hubLibrarySkillsDir(), "new-skill"))).toBe(false);
    expect(
      existsSync(join(hubWorkspaceSkillsDir("stable"), "new-skill", "SKILL.md")),
    ).toBe(true);
  });

  test("migrate absorbs real harness skill dirs into library", async () => {
    const piSkills = harnessSkillDir("pi");
    await makeSkill(piSkills, "pdf-reader");

    await migrateSkillsToLibrary({ dryRun: false });
    expect(existsSync(join(hubLibrarySkillsDir(), "pdf-reader", "SKILL.md"))).toBe(
      true,
    );
    // source was moved out of harness dir
    expect(existsSync(join(piSkills, "pdf-reader"))).toBe(false);
  });

  test("symlink in harness is left for setSkillLink to unlink (migrate skips)", async () => {
    await makeSkill(hubLibrarySkillsDir(), "linked");
    const piSkills = harnessSkillDir("pi");
    await mkdir(piSkills, { recursive: true });
    await symlink(join(hubLibrarySkillsDir(), "linked"), join(piSkills, "linked"));

    await migrateSkillsToLibrary({ dryRun: false });
    const st = await lstat(join(piSkills, "linked"));
    expect(st.isSymbolicLink()).toBe(true);
  });
});
