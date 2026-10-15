import { describe, expect, test } from "bun:test";
import {
  looksLikeSecretValue,
  scrubMcpCatalog,
  scrubMcpServer,
} from "./secrets.ts";

describe("secrets", () => {
  test("detects common secret shapes", () => {
    expect(looksLikeSecretValue("$FIGMA_API_KEY")).toBe(false);
    expect(looksLikeSecretValue("https://example.com")).toBe(false);
    expect(looksLikeSecretValue("figd_abcDEF1234567890_xyz")).toBe(true);
    expect(
      looksLikeSecretValue("ece80e94-6a6b-46fa-b62d-93b55fad2c73"),
    ).toBe(true);
  });

  test("scrubs env keys and figma CLI args", () => {
    const { server, hits } = scrubMcpServer("figma", {
      command: "npx",
      args: ["-y", "figma-developer-mcp", "--figma-api-key=figd_TESTKEY_1234567890", "--stdio"],
      env: {
        KAITEN_TOKEN: "ece80e94-6a6b-46fa-b62d-93b55fad2c73",
        KAITEN_BASE_URL: "https://kaiten.example",
      },
    });
    expect(server.args).toContain("--figma-api-key=$FIGMA_API_KEY");
    expect(server.env?.KAITEN_TOKEN).toBe("$KAITEN_TOKEN");
    expect(server.env?.KAITEN_BASE_URL).toBe("https://kaiten.example");
    expect(hits.length).toBe(2);
  });

  test("catalog scrub aggregates hits", () => {
    const { servers, hits } = scrubMcpCatalog({
      a: { env: { Z_AI_API_KEY: "734b261f21fe4536a52ed4c700010d9d.abc" } },
      b: { url: "http://127.0.0.1:3845/mcp" },
    });
    expect(servers.a?.env?.Z_AI_API_KEY).toBe("$Z_AI_API_KEY");
    expect(servers.b?.url).toBe("http://127.0.0.1:3845/mcp");
    expect(hits.length).toBe(1);
  });
});
