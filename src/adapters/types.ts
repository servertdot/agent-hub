import type { HarnessId, McpRef, OpResult, SkillRef } from "../types.ts";

export interface HarnessAdapter {
  readonly id: HarnessId;
  /** True when the harness home looks installed on this machine. */
  isInstalled(): Promise<boolean>;
  listSkills(): Promise<SkillRef[]>;
  listMcp(): Promise<McpRef[]>;
  setSkill(
    name: string,
    enabled: boolean,
    dryRun: boolean,
  ): Promise<OpResult>;
  setMcp(name: string, enabled: boolean, dryRun: boolean): Promise<OpResult>;
}
