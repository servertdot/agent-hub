import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NameConflictError,
  assertSkillInstallAllowed,
  findSkillOwners,
} from "./ownership.ts";
import {
  adoptSkillFromLibrary,
  installSkillToWorkspace,
  removeSkillFromWorkspace,
} from "./workspace.ts";
import {
  hubLibrarySkillsDir,
  hubWorkspaceSkillsDir,
} from "./paths.ts";
import { existsSync } from "node:fs";

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

describe("profile-private skills", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevHub: string | undefined;

  beforeEach(async () => {
    home = join(
      tmpdir(),
      `agent-hub-own-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.AGENT_HUB_DIR;
    else process.env.AGENT_HUB_DIR = prevHub;
  });

  test("install copies into profile workspace only", async () => {
    const src = await makeSkill(join(home, "incoming"), "solo");
    await installSkillToWorkspace({
      sourcePath: src,
      profileName: "lab",
      dryRun: false,
    });
    expect(existsSync(join(hubWorkspaceSkillsDir("lab"), "solo", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(hubLibrarySkillsDir(), "solo"))).toBe(false);
    expect(existsSync(join(hubWorkspaceSkillsDir("stable"), "solo"))).toBe(
      false,
    );
  });

  test("install conflicts when other profile owns the name", async () => {
    const src = await makeSkill(join(home, "incoming"), "dup");
    await installSkillToWorkspace({
      sourcePath: src,
      profileName: "lab",
      dryRun: false,
    });
    const src2 = await makeSkill(join(home, "incoming2"), "dup");
    expect(() =>
      assertSkillInstallAllowed("dup", "stable", {
        profiles: ["lab"],
        library: false,
      }),
    ).toThrow(NameConflictError);
    await expect(
      installSkillToWorkspace({
        sourcePath: src2,
        profileName: "stable",
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(NameConflictError);
  });

  test("remove from one profile leaves the other intact", async () => {
    await makeSkill(hubLibrarySkillsDir(), "shared-old");
    // place copies in both workspaces (simulate pre-conflict era)
    await mkdir(hubWorkspaceSkillsDir("lab"), { recursive: true });
    await mkdir(hubWorkspaceSkillsDir("stable"), { recursive: true });
    await rename(
      join(hubLibrarySkillsDir(), "shared-old"),
      join(hubWorkspaceSkillsDir("lab"), "shared-old"),
    );
    await makeSkill(hubWorkspaceSkillsDir("stable"), "shared-old");

    await removeSkillFromWorkspace({
      name: "shared-old",
      profileName: "lab",
      dryRun: false,
    });
    expect(existsSync(join(hubWorkspaceSkillsDir("lab"), "shared-old"))).toBe(
      false,
    );
    expect(
      existsSync(join(hubWorkspaceSkillsDir("stable"), "shared-old", "SKILL.md")),
    ).toBe(true);
  });

  test("adopt moves orphan library skill into profile", async () => {
    await makeSkill(hubLibrarySkillsDir(), "orphan");
    const owners = await findSkillOwners("orphan");
    expect(owners.library).toBe(true);
    expect(owners.profiles).toEqual([]);

    await adoptSkillFromLibrary({
      name: "orphan",
      profileName: "lab",
      dryRun: false,
    });
    expect(existsSync(join(hubLibrarySkillsDir(), "orphan"))).toBe(false);
    expect(
      existsSync(join(hubWorkspaceSkillsDir("lab"), "orphan", "SKILL.md")),
    ).toBe(true);
  });
});
