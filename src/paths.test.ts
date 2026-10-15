import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { packageRoot, resolveSkillInstallPath } from "./paths.ts";

describe("resolveSkillInstallPath", () => {
  test("finds bundled skill via relative path from a foreign cwd", () => {
    const prev = process.cwd();
    try {
      process.chdir(process.env.HOME ?? "/tmp");
      const resolved = resolveSkillInstallPath("./skills/agent-hub");
      expect(resolved).toBe(join(packageRoot(), "skills", "agent-hub"));
      expect(resolved.endsWith("/skills/agent-hub")).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  test("finds bundled skill by bare name", () => {
    const prev = process.cwd();
    try {
      process.chdir(process.env.HOME ?? "/tmp");
      const resolved = resolveSkillInstallPath("agent-hub");
      expect(resolved).toBe(join(packageRoot(), "skills", "agent-hub"));
    } finally {
      process.chdir(prev);
    }
  });

  test("prefers cwd when skill exists there", async () => {
    const { mkdtemp, mkdir, writeFile, realpath } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "ahub-path-"));
    const skill = join(root, "skills", "local-only");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: local-only\ndescription: t\n---\n",
      "utf8",
    );
    const prev = process.cwd();
    try {
      process.chdir(root);
      const resolved = resolveSkillInstallPath("./skills/local-only");
      expect(await realpath(resolved)).toBe(await realpath(skill));
    } finally {
      process.chdir(prev);
    }
  });
});
