import { z } from "zod";

export const HARNESSES = ["cursor", "claude", "codex", "pi", "omp"] as const;
export type HarnessId = (typeof HARNESSES)[number];

export const ResourceKind = z.enum(["skill", "mcp"]);
export type ResourceKind = z.infer<typeof ResourceKind>;

export const HarnessFlags = z.record(z.enum(HARNESSES), z.boolean());
export type HarnessFlags = z.infer<typeof HarnessFlags>;

export const ProfileSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  skills: z.record(z.string(), HarnessFlags).default({}),
  mcp: z.record(z.string(), HarnessFlags).default({}),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const HubConfigSchema = z.object({
  harnesses: z
    .object({
      cursor: z.boolean().default(true),
      claude: z.boolean().default(true),
      codex: z.boolean().default(true),
      pi: z.boolean().default(true),
      omp: z.boolean().default(true),
    })
    .default({
      cursor: true,
      claude: true,
      codex: true,
      pi: true,
      omp: true,
    }),
  catalog: z
    .object({
      /** Extra skill roots to scan (absolute or ~). */
      skillRoots: z.array(z.string()).default([]),
    })
    .default({ skillRoots: [] }),
});
export type HubConfig = z.infer<typeof HubConfigSchema>;

export const McpServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  cwd: z.string().optional(),
  type: z.enum(["stdio", "http", "sse"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpCatalogSchema = z.object({
  mcpServers: z.record(z.string(), McpServerSchema).default({}),
});
export type McpCatalog = z.infer<typeof McpCatalogSchema>;

export type OpResult = {
  harness: HarnessId;
  kind: ResourceKind;
  name: string;
  action: "enable" | "disable" | "noop" | "would-enable" | "would-disable";
  status: "ok" | "planned" | "skipped" | "error";
  detail?: string;
};

export type SkillRef = {
  name: string;
  path: string;
  source: string;
};

export type McpRef = {
  name: string;
  enabled: boolean;
  source: string;
};

export type MatrixRow = {
  kind: ResourceKind;
  name: string;
  flags: Partial<Record<HarnessId, boolean>>;
  /** Live discovery hint (path or source). */
  basis?: string;
};
