#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { render } from "ink";
import React from "react";
import { applyProfile, formatResults } from "./apply.ts";
import {
  ensureHubLayout,
  getActiveProfile,
  listProfiles,
  loadConfig,
  loadProfile,
  saveProfile,
} from "./config.ts";
import {
  discoverMatrix,
  formatMatrix,
  formatMatrixFooter,
} from "./discover.ts";
import { sortByCost } from "./cost.ts";
import {
  hubDir,
  hubLibrarySkillsDir,
  hubWorkspaceSkillsDir,
} from "./paths.ts";
import { adapters } from "./adapters/index.ts";
import { HARNESSES, type HarnessId } from "./types.ts";
import {
  formatWorkspaceOps,
  installSkillToWorkspace,
  listLibrarySkills,
  listWorkspaceSkills,
  migrateSkillsToLibrary,
  ensureSharedParked,
} from "./workspace.ts";
import { App } from "./tui/App.tsx";
import { runNumberedMenu } from "./tui/menu.ts";
import type { TuiResult } from "./tui/types.ts";
import {
  captureProfileFromDiscovery,
  importMcpCatalog,
  scrubExistingCatalog,
  seedLabProfile,
} from "./import-catalog.ts";
import {
  formatHarnessScrubReports,
  scrubHarnessMcpFiles,
} from "./scrub-harnesses.ts";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const main = defineCommand({
  meta: {
    name: "agent-hub",
    version: "0.1.0",
    description:
      "Manage skills & MCP across Cursor, Claude Code, Codex, pi, and OMP",
  },
  subCommands: {
    init: defineCommand({
      meta: { description: "Create ~/.agent-hub layout and example profiles" },
      async run() {
        await ensureHubLayout();
        // src/cli.ts → ../profiles; dist/cli.js → ../profiles
        const root = fileURLToPath(new URL("..", import.meta.url));
        const examples = join(root, "profiles");
        for (const name of ["stable", "lab"]) {
          const src = join(examples, `${name}.yaml`);
          const dest = join(hubDir(), "profiles", `${name}.yaml`);
          if (existsSync(src) && !existsSync(dest)) {
            await mkdir(dirname(dest), { recursive: true });
            await copyFile(src, dest);
            console.log(`wrote ${dest}`);
          } else if (!existsSync(src)) {
            console.warn(`skip example ${name}: missing ${src}`);
          }
        }
        console.log(`hub dir: ${hubDir()}`);
        console.log("done. Next: agent-hub status");
      },
    }),

    status: defineCommand({
      meta: { description: "Show hub dir, harnesses, active profile, workspace" },
      async run() {
        await ensureHubLayout();
        const cfg = await loadConfig();
        const active = await getActiveProfile();
        const profiles = await listProfiles();
        const libCount = (await listLibrarySkills()).length;
        const wsCount = active
          ? (await listWorkspaceSkills(active)).length
          : 0;
        console.log(`hub: ${hubDir()}`);
        console.log(`active profile: ${active ?? "(none)"}`);
        console.log(`profiles: ${profiles.join(", ") || "(none)"}`);
        console.log(`library: ${hubLibrarySkillsDir()} (${libCount} skills)`);
        if (active) {
          console.log(
            `workspace: ${hubWorkspaceSkillsDir(active)} (${wsCount} skills)`,
          );
        }
        console.log("harnesses:");
        for (const id of HARNESSES) {
          const on = cfg.harnesses[id] !== false;
          const ad = adapters[id];
          const installed = await ad.isInstalled();
          console.log(
            `  ${id.padEnd(8)} config=${on ? "on" : "off"}  installed=${installed ? "yes" : "no"}`,
          );
        }
      },
    }),

    migrate: defineCommand({
      meta: {
        description:
          "Absorb ~/.agents/skills + real harness skill dirs into library; park shared pool empty",
      },
      args: {
        "dry-run": { type: "boolean", description: "Plan only" },
      },
      async run({ args }) {
        await ensureHubLayout();
        const dryRun = Boolean(args["dry-run"]);
        const ops = await migrateSkillsToLibrary({ dryRun });
        const parked = await ensureSharedParked(dryRun);
        console.log(formatWorkspaceOps([...ops, parked]));
      },
    }),

    skill: defineCommand({
      meta: { description: "Install / list skills in library & active workspace" },
      subCommands: {
        install: defineCommand({
          meta: {
            description:
              "Copy a skill dir into library + active workspace; enable on hub harnesses; optional apply",
          },
          args: {
            path: {
              type: "positional",
              required: true,
              description: "Path to skill directory (contains SKILL.md)",
            },
            profile: {
              type: "string",
              description: "Target profile (default: active)",
            },
            apply: {
              type: "boolean",
              description: "Apply profile after install",
            },
            "dry-run": { type: "boolean", description: "Plan only" },
          },
          async run({ args }) {
            await ensureHubLayout();
            const cfg = await loadConfig();
            const active = await getActiveProfile();
            const profileName =
              (args.profile ? String(args.profile) : undefined) ?? active;
            if (!profileName) {
              throw new Error(
                "no active profile — pass --profile or run agent-hub apply <name> first",
              );
            }
            const dryRun = Boolean(args["dry-run"]);
            const { ops, name } = await installSkillToWorkspace({
              sourcePath: String(args.path),
              profileName,
              dryRun,
            });
            console.log(formatWorkspaceOps(ops));

            let profile = await loadProfile(profileName).catch(async () => {
              const blank = {
                name: profileName,
                description: `workspace ${profileName}`,
                skills: {},
                mcp: {},
              };
              if (!dryRun) await saveProfile(blank);
              return blank;
            });

            const flags: Record<HarnessId, boolean> = {
              cursor: false,
              claude: false,
              codex: false,
              pi: false,
              omp: false,
            };
            for (const id of HARNESSES) {
              flags[id] = cfg.harnesses[id] !== false;
            }
            profile = {
              ...profile,
              skills: { ...profile.skills, [name]: flags },
            };
            if (!dryRun) {
              await saveProfile(profile);
              console.log(`updated profile ${profileName}: ${name} enabled`);
            }

            if (args.apply) {
              const results = await applyProfile({ profile, dryRun });
              console.log(formatResults(results));
            } else {
              console.log(
                dryRun
                  ? "(dry-run) skip profile write / apply"
                  : `next: agent-hub apply ${profileName}`,
              );
            }
          },
        }),
        list: defineCommand({
          meta: { description: "List library and active workspace skills" },
          async run() {
            await ensureHubLayout();
            const active = await getActiveProfile();
            const lib = await listLibrarySkills();
            console.log(`library (${lib.length}):`);
            for (const n of lib) console.log(`  ${n}`);
            if (active) {
              const ws = await listWorkspaceSkills(active);
              console.log(`workspace ${active} (${ws.length}):`);
              for (const n of ws) console.log(`  ${n}`);
            } else {
              console.log("workspace: (no active profile)");
            }
          },
        }),
      },
    }),

    discover: defineCommand({
      meta: {
        description:
          "Print skill/MCP matrix discovered on this machine (with token estimates)",
      },
      async run() {
        const rows = await discoverMatrix();
        console.log(formatMatrix(rows));
        console.log(`\n${formatMatrixFooter(rows)}`);
      },
    }),

    cost: defineCommand({
      meta: {
        description:
          "Startup token estimates, biggest first (same formula as discover)",
      },
      args: {
        type: {
          type: "string",
          description: "Filter: skill | mcp",
        },
        limit: {
          type: "string",
          description: "Max rows (default 40)",
          default: "40",
        },
      },
      async run({ args }) {
        let rows = await discoverMatrix();
        const type = args.type ? String(args.type) : undefined;
        if (type === "skill" || type === "mcp") {
          rows = rows.filter((r) => r.kind === type);
        }
        rows = sortByCost(rows, "desc");
        const limit = Math.max(1, Number(args.limit) || 40);
        const slice = rows.slice(0, limit);
        console.log(`tok\tkind\tname\tbasis`);
        for (const r of slice) {
          console.log(
            `${r.tokens ?? 0}\t${r.kind}\t${r.name}\t${r.costBasis ?? ""}`,
          );
        }
        if (rows.length > limit) {
          console.log(`… ${rows.length - limit} more`);
        }
        console.log(`\n${formatMatrixFooter(rows)}`);
      },
    }),

    diff: defineCommand({
      meta: { description: "Dry-run apply a profile" },
      args: {
        profile: { type: "positional", required: true, description: "Profile name" },
        harness: { type: "string", description: "Limit to one harness" },
        verbose: {
          type: "boolean",
          description: "Show noop rows too",
          alias: "v",
        },
      },
      async run({ args }) {
        const profile = await loadProfile(String(args.profile));
        const harness = args.harness
          ? (String(args.harness) as HarnessId)
          : undefined;
        const results = await applyProfile({
          profile,
          dryRun: true,
          harness,
        });
        console.log(
          formatResults(results, { verbose: Boolean(args.verbose) }),
        );
      },
    }),

    apply: defineCommand({
      meta: { description: "Apply a profile to enabled harnesses" },
      args: {
        profile: { type: "positional", required: true, description: "Profile name" },
        harness: { type: "string", description: "Limit to one harness" },
        "dry-run": { type: "boolean", description: "Plan only" },
        verbose: {
          type: "boolean",
          description: "Show noop rows too",
          alias: "v",
        },
      },
      async run({ args }) {
        const profile = await loadProfile(String(args.profile));
        const harness = args.harness
          ? (String(args.harness) as HarnessId)
          : undefined;
        const results = await applyProfile({
          profile,
          dryRun: Boolean(args["dry-run"]),
          harness,
        });
        console.log(
          formatResults(results, { verbose: Boolean(args.verbose) }),
        );
      },
    }),

    profile: defineCommand({
      meta: { description: "List or save profiles" },
      subCommands: {
        list: defineCommand({
          meta: { description: "List profiles" },
          async run() {
            const names = await listProfiles();
            console.log(names.join("\n") || "(none)");
          },
        }),
        save: defineCommand({
          meta: {
            description:
              "Save current discovery as a full boolean matrix profile",
          },
          args: {
            name: { type: "positional", required: true },
          },
          async run({ args }) {
            const path = await captureProfileFromDiscovery(String(args.name));
            console.log(`saved ${path}`);
          },
        }),
        "seed-lab": defineCommand({
          meta: {
            description:
              "Clone stable (or --from) into lab and enable a few skills on omp",
          },
          args: {
            from: {
              type: "string",
              description: "Source profile name",
              default: "stable",
            },
          },
          async run({ args }) {
            const { path, extras } = await seedLabProfile({
              from: String(args.from),
            });
            console.log(`saved ${path}`);
            console.log(`omp extras: ${extras.join(", ")}`);
          },
        }),
      },
    }),

    "import-mcp": defineCommand({
      meta: {
        description:
          "Import MCP server defs from JSON harness configs into ~/.agent-hub/catalog/mcp.yaml (secrets → $ENV)",
      },
      args: {
        overwrite: {
          type: "boolean",
          description: "Replace existing catalog entries",
        },
      },
      async run({ args }) {
        const { added, skipped, scrubbed, path } = await importMcpCatalog({
          overwrite: Boolean(args.overwrite),
        });
        console.log(`catalog: ${path}`);
        console.log(`added (${added.length}):`);
        for (const a of added) console.log(`  ${a}`);
        if (skipped.length) {
          console.log(`skipped (${skipped.length}):`);
          for (const s of skipped.slice(0, 20)) console.log(`  ${s}`);
          if (skipped.length > 20) console.log(`  … ${skipped.length - 20} more`);
        }
        if (scrubbed.length) {
          console.log(`scrubbed secrets (${scrubbed.length}):`);
          for (const h of scrubbed) console.log(`  ${h.path} → ${h.to}`);
        }
      },
    }),

    "scrub-catalog": defineCommand({
      meta: {
        description:
          "Replace pasted secrets in ~/.agent-hub/catalog/mcp.yaml with $ENV refs",
      },
      async run() {
        const { hits, path } = await scrubExistingCatalog();
        console.log(`catalog: ${path}`);
        if (!hits.length) {
          console.log("no secrets found");
          return;
        }
        console.log(`scrubbed (${hits.length}):`);
        for (const h of hits) console.log(`  ${h.path}: ${h.from} → ${h.to}`);
      },
    }),

    "scrub-harnesses": defineCommand({
      meta: {
        description:
          "Scrub pasted secrets in harness MCP files (dry-run by default; --write to apply)",
      },
      args: {
        write: {
          type: "boolean",
          description: "Actually write files (backs up under ~/.agent-hub/backups)",
        },
        harness: {
          type: "string",
          description: "Limit to one harness",
        },
      },
      async run({ args }) {
        const harness = args.harness
          ? (String(args.harness) as HarnessId)
          : undefined;
        const reports = await scrubHarnessMcpFiles({
          write: Boolean(args.write),
          harness,
        });
        console.log(formatHarnessScrubReports(reports));
        if (!args.write && reports.some((r) => r.wouldWrite)) {
          console.log("\nRe-run with --write to apply (backups are created).");
        }
      },
    }),

    tui: defineCommand({
      meta: {
        description:
          "Interactive matrix (Ink TUI on a TTY; numbered menu otherwise)",
      },
      args: {
        "dry-run": { type: "boolean", description: "Stage apply as dry-run" },
        profile: {
          type: "string",
          description:
            "Profile to open (default: active profile, else first on disk, else tui-session)",
        },
        menu: {
          type: "boolean",
          description: "Force numbered menu even on a TTY",
        },
        verbose: {
          type: "boolean",
          description: "Show noop rows in apply output",
          alias: "v",
        },
      },
      async run({ args }) {
        await ensureHubLayout();
        const cfg = await loadConfig();
        const rows = await discoverMatrix();
        const profileNames = await listProfiles();
        const active = await getActiveProfile();
        const profileName =
          (args.profile ? String(args.profile) : undefined) ??
          active ??
          profileNames[0] ??
          "tui-session";

        let profile: Awaited<ReturnType<typeof loadProfile>> | undefined;
        try {
          profile = await loadProfile(profileName);
        } catch {
          profile = undefined;
        }

        const dryRun = Boolean(args["dry-run"]);
        const useMenu = Boolean(args.menu) || !process.stdin.isTTY;

        let result: TuiResult;
        if (useMenu) {
          result = await runNumberedMenu({
            rows,
            profileName,
            profile,
            profileNames,
            harnesses: cfg.harnesses,
            dryRun,
          });
        } else {
          const hold: { current: TuiResult } = {
            current: { action: "cancel" },
          };
          const { waitUntilExit } = render(
            React.createElement(App, {
              rows,
              profileName,
              profile,
              profileNames,
              harnesses: cfg.harnesses,
              dryRun,
              onDone: (r: TuiResult) => {
                hold.current = r;
              },
            }),
          );
          await waitUntilExit();
          result = hold.current;
        }

        if (result.action === "cancel") {
          console.log("cancelled");
          return;
        }
        const results = await applyProfile({
          profile: result.profile,
          dryRun: result.dryRun,
        });
        console.log(
          formatResults(results, { verbose: Boolean(args.verbose) }),
        );
      },
    }),
  },
});

runMain(main);
