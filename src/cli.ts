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
} from "./config.ts";
import { discoverMatrix, formatMatrix } from "./discover.ts";
import { hubDir } from "./paths.ts";
import { adapters } from "./adapters/index.ts";
import { HARNESSES, type HarnessId } from "./types.ts";
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
      meta: { description: "Show hub dir, harnesses, active profile" },
      async run() {
        await ensureHubLayout();
        const cfg = await loadConfig();
        const active = await getActiveProfile();
        const profiles = await listProfiles();
        console.log(`hub: ${hubDir()}`);
        console.log(`active profile: ${active ?? "(none)"}`);
        console.log(`profiles: ${profiles.join(", ") || "(none)"}`);
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

    discover: defineCommand({
      meta: { description: "Print skill/MCP matrix discovered on this machine" },
      async run() {
        const rows = await discoverMatrix();
        console.log(formatMatrix(rows));
        console.log(`\n${rows.length} resources`);
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
          description: "Name written when applying staged cells",
          default: "tui-session",
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
        const rows = await discoverMatrix();
        const profileName = String(args.profile);
        const dryRun = Boolean(args["dry-run"]);
        const useMenu = Boolean(args.menu) || !process.stdin.isTTY;

        let result: TuiResult;
        if (useMenu) {
          result = await runNumberedMenu({ rows, profileName, dryRun });
        } else {
          const hold: { current: TuiResult } = {
            current: { action: "cancel" },
          };
          const { waitUntilExit } = render(
            React.createElement(App, {
              rows,
              profileName,
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
