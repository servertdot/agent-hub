import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyProfile,
  formatResults,
  isNoopResult,
  summarizeResults,
} from "./apply.ts";
import type { OpResult, Profile } from "./types.ts";
import { harnessSkillDir, hubLibrarySkillsDir } from "./paths.ts";
import { setActiveProfile } from "./config.ts";

const sample: OpResult[] = [
  {
    harness: "cursor",
    kind: "skill",
    name: "tdd",
    action: "noop",
    status: "ok",
    detail: "already present",
  },
  {
    harness: "claude",
    kind: "skill",
    name: "tdd",
    action: "would-enable",
    status: "planned",
    detail: "symlink",
  },
  {
    harness: "codex",
    kind: "mcp",
    name: "fff",
    action: "disable",
    status: "ok",
  },
  {
    harness: "pi",
    kind: "mcp",
    name: "x",
    action: "enable",
    status: "skipped",
    detail: "missing",
  },
];

describe("formatResults", () => {
  test("hides noop by default and prints summary", () => {
    const out = formatResults(sample);
    expect(out).not.toContain("noop — already present");
    expect(out).toContain("would-enable");
    expect(out).toContain("disable");
    expect(out).toContain("4 checked");
    expect(out).toContain("1 planned");
    expect(out).toContain("1 changed");
    expect(out).toContain("1 skipped");
    expect(out).toContain("1 noop");
  });

  test("verbose shows noop rows", () => {
    const out = formatResults(sample, { verbose: true });
    expect(out).toContain("already present");
  });

  test("all-noop is a short message", () => {
    const out = formatResults([sample[0]!]);
    expect(out.startsWith("(no changes)")).toBe(true);
    expect(out).toContain("1 noop");
  });
});

describe("summarizeResults", () => {
  test("counts buckets", () => {
    expect(summarizeResults(sample)).toEqual({
      total: 4,
      noop: 1,
      planned: 1,
      changed: 1,
      skipped: 1,
      error: 0,
    });
    expect(isNoopResult(sample[0]!)).toBe(true);
  });
});

describe("applyProfile prune", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevHub: string | undefined;

  beforeEach(async () => {
    home = join(
      tmpdir(),
      `agent-hub-apply-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(home, { recursive: true });
    prevHome = process.env.HOME;
    prevHub = process.env.AGENT_HUB_DIR;
    process.env.HOME = home;
    process.env.AGENT_HUB_DIR = join(home, ".agent-hub");
    await mkdir(join(home, ".agent-hub", "profiles"), { recursive: true });
    await writeFile(
      join(home, ".agent-hub", "config.yaml"),
      "harnesses:\n  cursor: true\n  claude: false\n  codex: false\n  pi: true\n  omp: false\n",
      "utf8",
    );
    await writeFile(
      join(home, ".agent-hub", "profiles", "empty.yaml"),
      "name: empty\nskills: {}\nmcp: {}\n",
      "utf8",
    );
    await setActiveProfile("empty");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevHub === undefined) delete process.env.AGENT_HUB_DIR;
    else process.env.AGENT_HUB_DIR = prevHub;
  });

  test("empty profile removes leftover harness skill symlinks", async () => {
    await mkdir(hubLibrarySkillsDir(), { recursive: true });
    const skillDir = join(hubLibrarySkillsDir(), "leftover");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: leftover\ndescription: t\n---\n",
      "utf8",
    );

    const piSkills = harnessSkillDir("pi");
    await mkdir(piSkills, { recursive: true });
    await symlink(skillDir, join(piSkills, "leftover"));
    expect(existsSync(join(piSkills, "leftover", "SKILL.md"))).toBe(true);

    const empty: Profile = { name: "empty", skills: {}, mcp: {} };
    const results = await applyProfile({
      profile: empty,
      skipWorkspacePrep: true,
    });
    expect(
      results.some(
        (r) =>
          r.harness === "pi" &&
          r.kind === "skill" &&
          r.name === "leftover" &&
          r.action === "disable" &&
          r.status === "ok",
      ),
    ).toBe(true);
    expect(existsSync(join(piSkills, "leftover"))).toBe(false);
  });
});
