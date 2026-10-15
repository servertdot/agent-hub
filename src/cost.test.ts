import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  estimateMcp,
  estimateSkill,
  formatTok,
  liveTokenTotal,
  parseFrontmatter,
  tokensOf,
} from "./cost.ts";
import type { MatrixRow } from "./types.ts";

describe("cost", () => {
  test("tokensOf rounds up", () => {
    expect(tokensOf(0)).toBe(0);
    expect(tokensOf(1)).toBe(1);
    expect(tokensOf(4)).toBe(1);
    expect(tokensOf(5)).toBe(2);
  });

  test("parseFrontmatter name+description", () => {
    const fm = parseFrontmatter(`---
name: tdd
description: Test-driven development
---
# body ignored
`);
    expect(fm.name).toBe("tdd");
    expect(fm.description).toBe("Test-driven development");
  });

  test("estimateSkill from SKILL.md", async () => {
    const dir = join(tmpdir(), `agent-hub-cost-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---
name: demo
description: hello world
---
body
`,
      "utf8",
    );
    const est = await estimateSkill(dir);
    expect(est.tokens).toBe(tokensOf("demohello world".length));
    expect(est.description).toBe("hello world");
  });

  test("estimateMcp flat defaults", () => {
    expect(estimateMcp().tokens).toBe(1500);
    expect(estimateMcp({ deferred: true }).tokens).toBe(20);
    expect(estimateMcp({ toolCount: 3 }).tokens).toBe(900);
  });

  test("formatTok and liveTokenTotal", () => {
    expect(formatTok(500)).toBe("500");
    expect(formatTok(1500)).toBe("1.5k");
    expect(formatTok(12000)).toBe("12k");
    const rows: MatrixRow[] = [
      { kind: "skill", name: "a", flags: { cursor: true }, tokens: 100 },
      { kind: "skill", name: "b", flags: { cursor: false }, tokens: 200 },
      { kind: "mcp", name: "c", flags: { cursor: true, claude: true }, tokens: 1500 },
    ];
    expect(liveTokenTotal(rows)).toBe(1600);
    expect(liveTokenTotal(rows, "cursor")).toBe(1600);
    expect(liveTokenTotal(rows, "claude")).toBe(1500);
  });
});
