import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncSharedToActiveProfile } from "./sync-shared.ts";
import {
  agentsSkillsPath,
  hubLibrarySkillsDir,
  hubWorkspaceSkillsDir,
} from "./paths.ts";
import { setActiveProfile } from "./config.ts";

async function makeSkill(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: t\n---\n`,
    "utf8",
  );
  return dir;
}

describe("syncSharedToActiveProfile", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevHub: string | undefined;

  beforeEach(async () => {
    home = join(
      tmpdir(),
      `agent-hub-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(home, { recursive: true });
    prevHome = process.env.HOME;
    prevHub = process.env.AGENT_HUB_DIR;
    process.env.HOME = home;
    process.env.AGENT_HUB_DIR = join(home, ".agent-hub");
    await mkdir(join(home, ".agent-hub", "profiles"), { recursive: true });
    await writeFile(
      join(home, ".agent-hub", "profiles", "lab.yaml"),
      "name: lab\nskills: {}\nmcp: {}\n",
      "utf8",
    );
    await writeFile(
      join(home, ".agent-hub", "profiles", "stable.yaml"),
      "name: stable\nskills: {}\nmcp: {}\n",
      "utf8",
    );
    await writeFile(
      join(home, ".agent-hub", "config.yaml"),
      "harnesses:\n  cursor: true\n  claude: false\n  codex: true\n  pi: true\n  omp: true\n",
      "utf8",
    );
    await setActiveProfile("lab");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.AGENT_HUB_DIR;
    else process.env.AGENT_HUB_DIR = prevHub;
  });

  test("moves ~/.agents/skills into active profile workspace", async () => {
    await makeSkill(agentsSkillsPath(), "pstack");
    const result = await syncSharedToActiveProfile({ profileName: "lab" });
    expect(result.added).toEqual(["pstack"]);
    expect(result.conflicts).toEqual([]);
    expect(
      existsSync(join(hubWorkspaceSkillsDir("lab"), "pstack", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(agentsSkillsPath(), "pstack"))).toBe(false);
    const yaml = await readFile(
      join(home, ".agent-hub", "profiles", "lab.yaml"),
      "utf8",
    );
    expect(yaml).toContain("pstack:");
    expect(yaml).toContain("pi: true");
  });

  test("does not put synced skill into other profile", async () => {
    await makeSkill(agentsSkillsPath(), "only-lab");
    await syncSharedToActiveProfile({ profileName: "lab" });
    expect(existsSync(join(hubWorkspaceSkillsDir("stable"), "only-lab"))).toBe(
      false,
    );
  });

  test("conflicts when other profile already owns the name", async () => {
    await makeSkill(hubWorkspaceSkillsDir("stable"), "taken");
    await makeSkill(agentsSkillsPath(), "taken");
    const result = await syncSharedToActiveProfile({ profileName: "lab" });
    expect(result.added).toEqual([]);
    expect(result.conflicts.some((c) => c.name === "taken")).toBe(true);
    expect(existsSync(join(agentsSkillsPath(), "taken", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(hubWorkspaceSkillsDir("lab"), "taken"))).toBe(false);
  });

  test("drops duplicate when active already has the skill", async () => {
    await makeSkill(hubWorkspaceSkillsDir("lab"), "dup");
    await makeSkill(agentsSkillsPath(), "dup");
    const result = await syncSharedToActiveProfile({ profileName: "lab" });
    expect(result.added).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(agentsSkillsPath(), "dup"))).toBe(false);
    expect(
      existsSync(join(hubWorkspaceSkillsDir("lab"), "dup", "SKILL.md")),
    ).toBe(true);
  });

  test("conflicts with library orphan of same name", async () => {
    await makeSkill(hubLibrarySkillsDir(), "libbed");
    await makeSkill(agentsSkillsPath(), "libbed");
    const result = await syncSharedToActiveProfile({ profileName: "lab" });
    expect(result.conflicts.some((c) => c.name === "libbed")).toBe(true);
    expect(existsSync(join(hubWorkspaceSkillsDir("lab"), "libbed"))).toBe(
      false,
    );
  });

  test("absorbs real skill from codex harness dir into active profile", async () => {
    const { harnessSkillDir } = await import("./paths.ts");
    await makeSkill(harnessSkillDir("codex"), "from-codex");
    const result = await syncSharedToActiveProfile({ profileName: "lab" });
    expect(result.added).toContain("from-codex");
    expect(
      existsSync(join(hubWorkspaceSkillsDir("lab"), "from-codex", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(harnessSkillDir("codex"), "from-codex"))).toBe(
      false,
    );
  });

  test("ignores hub symlinks in harness dirs", async () => {
    const { harnessSkillDir } = await import("./paths.ts");
    const { symlink } = await import("node:fs/promises");
    await makeSkill(hubWorkspaceSkillsDir("lab"), "linked");
    await mkdir(harnessSkillDir("pi"), { recursive: true });
    await symlink(
      join(hubWorkspaceSkillsDir("lab"), "linked"),
      join(harnessSkillDir("pi"), "linked"),
    );
    const result = await syncSharedToActiveProfile({ profileName: "lab" });
    expect(result.added).not.toContain("linked");
    const { lstat } = await import("node:fs/promises");
    expect(
      (await lstat(join(harnessSkillDir("pi"), "linked"))).isSymbolicLink(),
    ).toBe(true);
  });
});
