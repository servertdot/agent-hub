import { describe, expect, test } from "bun:test";
import {
  findMcpBlock,
  isMcpEnabledInBlock,
  listTomlMcp,
  setEnabledInBlock,
} from "./toml-mcp.ts";

const SAMPLE = `
[foo]
x = 1

[mcp_servers.fff]
command = "fff-mcp"

[mcp_servers.node_repl]
command = "node"
enabled = true

[mcp_servers.node_repl.env]
A = "1"

[mcp_servers.pencil]
command = "pencil"
enabled = false

[agents.explore]
description = "x"
`;

describe("toml-mcp", () => {
  test("finds block including env subtable", () => {
    const b = findMcpBlock(SAMPLE, "node_repl");
    expect(b).not.toBeNull();
    expect(b!.body).toContain("[mcp_servers.node_repl.env]");
    expect(b!.body).toContain('A = "1"');
    expect(b!.body).not.toContain("[mcp_servers.pencil]");
  });

  test("enabled detection", () => {
    expect(isMcpEnabledInBlock(findMcpBlock(SAMPLE, "fff")!.body)).toBe(true);
    expect(isMcpEnabledInBlock(findMcpBlock(SAMPLE, "pencil")!.body)).toBe(
      false,
    );
  });

  test("setEnabledInBlock inserts or flips", () => {
    const fff = setEnabledInBlock(findMcpBlock(SAMPLE, "fff")!.body, false);
    expect(fff).toContain("enabled = false");
    const pencil = setEnabledInBlock(
      findMcpBlock(SAMPLE, "pencil")!.body,
      true,
    );
    expect(pencil).toContain("enabled = true");
    expect(pencil).not.toContain("enabled = false");
  });

  test("listTomlMcp", () => {
    const list = listTomlMcp(SAMPLE, "codex");
    expect(list.map((x) => x.name)).toEqual(["fff", "node_repl", "pencil"]);
    expect(list.find((x) => x.name === "pencil")!.enabled).toBe(false);
    expect(list.find((x) => x.name === "fff")!.enabled).toBe(true);
  });
});
