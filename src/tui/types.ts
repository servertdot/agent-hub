import type { Profile } from "../types.ts";

export type TuiResult =
  | { action: "cancel" }
  | { action: "apply"; profile: Profile; dryRun: boolean };
