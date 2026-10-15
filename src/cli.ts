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
  agentsSkillsPath,
  hubDir,
  hubLibrarySkillsDir,
  hubWorkspaceSkillsDir,
} from "./paths.ts";
import { adapters } from "./adapters/index.ts";
import { HARNESSES, type HarnessId } from "./types.ts";
import {
  adoptSkillFromLibrary,
  copySkillsBetweenProfiles,
  formatWorkspaceOps,
  installSkillToWorkspace,
  listLibrarySkills,
  listWorkspaceSkills,
  migrateSkillsToLibrary,
  ensureSharedParked,
  removeSkillFromWorkspace,
} from "./workspace.ts";
import {
  adoptMcpFromGlobal,
  installMcpToProfile,
  loadWorkspaceMcpCatalog,
  removeMcpFromProfile,
} from "./profile-mcp.ts";
import { NameConflictError } from "./ownership.ts";
import type { McpServer } from "./types.ts";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
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
          "Absorb harness real skill dirs into library; shared ~/.agents is handled by sync → active profile",
      },
      args: {
        "dry-run": { type: "boolean", description: "Plan only" },
      },
      async run({ args }) {
        await ensureHubLayout();
        const dryRun = Boolean(args["dry-run"]);
        const active = await getActiveProfile();
        if (active) {
          const {
            formatSyncSharedResult,
            syncSharedToActiveProfile,
          } = await import("./sync-shared.ts");
          const synced = await syncSharedToActiveProfile({
            dryRun,
            profileName: active,
          });
          console.log(formatSyncSharedResult(synced));
        }
        const ops = await migrateSkillsToLibrary({
          dryRun,
          skipShared: Boolean(active),
          skipHarness: Boolean(active),
        });
        if (!active) {
          const parked = await ensureSharedParked(dryRun);
          console.log(formatWorkspaceOps([...ops, parked]));
        } else {
          console.log(formatWorkspaceOps(ops));
        }
      },
    }),

    sync: defineCommand({
      meta: {
        description:
          "Absorb external skill installs (~/.agents + cursor/claude/codex/pi/omp) into the active profile",
      },
      args: {
        profile: {
          type: "string",
          description: "Profile (default: active)",
        },
        apply: {
          type: "boolean",
          description: "Also project newly added skills onto harnesses",
        },
        "dry-run": { type: "boolean", description: "Plan only" },
      },
      async run({ args }) {
        await ensureHubLayout();
        const {
          formatSyncSharedResult,
          syncSharedToActiveProfile,
        } = await import("./sync-shared.ts");
        const active = await getActiveProfile();
        const profileName =
          (args.profile ? String(args.profile) : undefined) ?? active;
        if (!profileName) {
          throw new Error("no active profile — pass --profile");
        }
        const dryRun = Boolean(args["dry-run"]);
        const synced = await syncSharedToActiveProfile({
          dryRun,
          profileName,
        });
        console.log(formatSyncSharedResult(synced));
        if (args.apply && !dryRun && synced.added.length) {
          const profile = await loadProfile(profileName);
          console.log(formatResults(await applyProfile({ profile })));
        } else if (synced.added.length && !args.apply && !dryRun) {
          console.log(`next: agent-hub apply ${profileName}`);
        }
        if (synced.conflicts.length) {
          process.exitCode = 2;
        }
      },
    }),

    watch: defineCommand({
      meta: {
        description:
          "Watch ~/.agents + harness skill dirs; auto-sync into the active profile (Ctrl+C to stop)",
      },
      args: {
        profile: {
          type: "string",
          description: "Lock sync target profile (default: re-read active each time)",
        },
        apply: {
          type: "boolean",
          description: "Apply profile after each successful sync with additions",
        },
      },
      async run({ args }) {
        await ensureHubLayout();
        const {
          externalSkillRoots,
          formatSyncSharedResult,
          watchSharedSkills,
        } = await import("./sync-shared.ts");
        const locked = args.profile ? String(args.profile) : undefined;
        console.log(
          `watching → profile ${locked ?? "(active)"}:\n${externalSkillRoots()
            .map((r) => `  ${r.path}`)
            .join("\n")}`,
        );
        const ac = new AbortController();
        const onSig = () => ac.abort();
        process.on("SIGINT", onSig);
        process.on("SIGTERM", onSig);
        try {
          await watchSharedSkills({
            signal: ac.signal,
            profileName: locked,
            onSync: async (result) => {
              console.log(`\n[${new Date().toISOString()}]`);
              console.log(formatSyncSharedResult(result));
              if (
                args.apply &&
                result.added.length &&
                !result.conflicts.length
              ) {
                const profile = await loadProfile(result.profileName);
                console.log(formatResults(await applyProfile({ profile })));
              }
            },
            onError: (err) => {
              console.error(
                err instanceof Error ? err.message : String(err),
              );
            },
          });
        } finally {
          process.off("SIGINT", onSig);
          process.off("SIGTERM", onSig);
        }
      },
    }),

    skill: defineCommand({
      meta: {
        description:
          "Install/remove/adopt profile-private skills (name conflicts across profiles)",
      },
      subCommands: {
        install: defineCommand({
          meta: {
            description:
              "Copy a skill dir into the active profile workspace only (conflicts if name exists elsewhere)",
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
            try {
              const { ops, name } = await installSkillToWorkspace({
                sourcePath: String(args.path),
                profileName,
                dryRun,
              });
              console.log(formatWorkspaceOps(ops));
              await bumpSkillInProfile(profileName, name, cfg, dryRun);
              if (args.apply) {
                const profile = await loadProfile(profileName);
                console.log(
                  formatResults(await applyProfile({ profile, dryRun })),
                );
              } else if (!dryRun) {
                console.log(`next: agent-hub apply ${profileName}`);
              }
            } catch (e) {
              if (e instanceof NameConflictError) throw e;
              throw e;
            }
          },
        }),
        remove: defineCommand({
          meta: {
            description:
              "Delete a skill from the active profile workspace only (other profiles untouched)",
          },
          args: {
            name: {
              type: "positional",
              required: true,
              description: "Skill name",
            },
            profile: {
              type: "string",
              description: "Target profile (default: active)",
            },
            apply: {
              type: "boolean",
              description: "Apply profile after remove (unlinks harnesses)",
            },
            "dry-run": { type: "boolean", description: "Plan only" },
          },
          async run({ args }) {
            await ensureHubLayout();
            const active = await getActiveProfile();
            const profileName =
              (args.profile ? String(args.profile) : undefined) ?? active;
            if (!profileName) {
              throw new Error("no active profile — pass --profile");
            }
            const dryRun = Boolean(args["dry-run"]);
            const name = String(args.name);
            const { ops } = await removeSkillFromWorkspace({
              name,
              profileName,
              dryRun,
            });
            console.log(formatWorkspaceOps(ops));
            if (!dryRun) {
              const profile = await loadProfile(profileName);
              // Disable on harnesses first (omitted keys are left alone by apply).
              const off: Record<HarnessId, boolean> = {
                cursor: false,
                claude: false,
                codex: false,
                pi: false,
                omp: false,
              };
              const withOff = {
                ...profile,
                skills: { ...profile.skills, [name]: off },
              };
              if (args.apply) {
                console.log(
                  formatResults(await applyProfile({ profile: withOff })),
                );
              }
              const skills = { ...profile.skills };
              delete skills[name];
              await saveProfile({ ...profile, skills });
              console.log(`removed ${name} from profile ${profileName}`);
            }
          },
        }),
        adopt: defineCommand({
          meta: {
            description:
              "Move an orphan library skill into the active profile workspace (claims the name)",
          },
          args: {
            name: { type: "positional", required: true },
            profile: { type: "string" },
            apply: { type: "boolean" },
            "dry-run": { type: "boolean" },
          },
          async run({ args }) {
            await ensureHubLayout();
            const cfg = await loadConfig();
            const active = await getActiveProfile();
            const profileName =
              (args.profile ? String(args.profile) : undefined) ?? active;
            if (!profileName) throw new Error("no active profile");
            const dryRun = Boolean(args["dry-run"]);
            const { ops, name } = await adoptSkillFromLibrary({
              name: String(args.name),
              profileName,
              dryRun,
            });
            console.log(formatWorkspaceOps(ops));
            await bumpSkillInProfile(profileName, name, cfg, dryRun);
            if (args.apply && !dryRun) {
              const profile = await loadProfile(profileName);
              console.log(formatResults(await applyProfile({ profile })));
            }
          },
        }),
        copy: defineCommand({
          meta: {
            description:
              "Copy skill(s) from one profile workspace into another (keeps source; copies flags)",
          },
          args: {
            names: {
              type: "positional",
              required: false,
              description:
                "Skill name(s). Omit with --all to copy every skill from --from",
            },
            from: {
              type: "string",
              description: "Source profile (default: active)",
            },
            to: {
              type: "string",
              required: true,
              description: "Target profile",
            },
            all: {
              type: "boolean",
              description: "Copy all skills from --from",
            },
            apply: {
              type: "boolean",
              description: "Apply the target profile after copy",
            },
            "dry-run": { type: "boolean" },
          },
          async run({ args }) {
            await ensureHubLayout();
            const active = await getActiveProfile();
            const fromProfile =
              (args.from ? String(args.from) : undefined) ?? active;
            const toProfile = String(args.to);
            if (!fromProfile) throw new Error("no source profile — pass --from");
            const dryRun = Boolean(args["dry-run"]);
            let names: string[] = [];
            if (args.all) {
              names = await listWorkspaceSkills(fromProfile);
            } else {
              const raw = args.names;
              if (Array.isArray(raw)) names = raw.map(String);
              else if (raw) names = [String(raw)];
            }
            if (!names.length) {
              throw new Error("pass skill name(s) or --all");
            }
            const { ops, copied, skipped } = await copySkillsBetweenProfiles({
              fromProfile,
              toProfile,
              names,
              dryRun,
            });
            console.log(formatWorkspaceOps(ops));
            console.log(
              `copied: ${copied.length || 0}, skipped: ${skipped.length || 0}`,
            );
            if (args.apply && !dryRun && copied.length) {
              const profile = await loadProfile(toProfile);
              console.log(formatResults(await applyProfile({ profile })));
            } else if (copied.length && !dryRun) {
              console.log(`next: agent-hub apply ${toProfile}`);
            }
          },
        }),
        list: defineCommand({
          meta: { description: "List library orphans and active workspace skills" },
          async run() {
            await ensureHubLayout();
            const active = await getActiveProfile();
            const lib = await listLibrarySkills();
            console.log(`library orphans (${lib.length}):`);
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

    mcp: defineCommand({
      meta: {
        description:
          "Install/remove/adopt profile-private MCP defs (name conflicts across profiles)",
      },
      subCommands: {
        install: defineCommand({
          meta: {
            description:
              "Add an MCP server def into the active profile workspace catalog from a YAML/JSON file",
          },
          args: {
            file: {
              type: "positional",
              required: true,
              description:
                "YAML/JSON file: { name?, mcpServers: { <name>: {...} } } or a single server object with --name",
            },
            name: {
              type: "string",
              description: "Server name (required if file is a single server object)",
            },
            profile: { type: "string" },
            apply: { type: "boolean" },
            "dry-run": { type: "boolean" },
          },
          async run({ args }) {
            await ensureHubLayout();
            const cfg = await loadConfig();
            const active = await getActiveProfile();
            const profileName =
              (args.profile ? String(args.profile) : undefined) ?? active;
            if (!profileName) throw new Error("no active profile");
            const dryRun = Boolean(args["dry-run"]);
            const raw = parseYaml(await readFile(String(args.file), "utf8")) as
              | Record<string, unknown>
              | null;
            if (!raw || typeof raw !== "object") {
              throw new Error("invalid MCP file");
            }
            const servers =
              (raw.mcpServers as Record<string, McpServer> | undefined) ??
              undefined;
            const entries: Array<[string, McpServer]> = [];
            if (servers) {
              for (const [n, s] of Object.entries(servers)) entries.push([n, s]);
            } else {
              const n = args.name ? String(args.name) : undefined;
              if (!n) {
                throw new Error("pass --name when file is a single server object");
              }
              entries.push([n, raw as McpServer]);
            }
            for (const [name, server] of entries) {
              const { path } = await installMcpToProfile({
                profileName,
                name,
                server,
                dryRun,
              });
              console.log(
                dryRun
                  ? `planned  mcp-install — ${name} → ${path}`
                  : `ok       mcp-install — ${name} → ${path}`,
              );
              await bumpMcpInProfile(profileName, name, cfg, dryRun);
            }
            if (args.apply && !dryRun) {
              const profile = await loadProfile(profileName);
              console.log(formatResults(await applyProfile({ profile })));
            }
          },
        }),
        remove: defineCommand({
          meta: {
            description: "Remove an MCP def from the active profile workspace only",
          },
          args: {
            name: { type: "positional", required: true },
            profile: { type: "string" },
            apply: { type: "boolean" },
            "dry-run": { type: "boolean" },
          },
          async run({ args }) {
            await ensureHubLayout();
            const active = await getActiveProfile();
            const profileName =
              (args.profile ? String(args.profile) : undefined) ?? active;
            if (!profileName) throw new Error("no active profile");
            const dryRun = Boolean(args["dry-run"]);
            const name = String(args.name);
            const { removed, path } = await removeMcpFromProfile({
              profileName,
              name,
              dryRun,
            });
            console.log(
              removed
                ? `${dryRun ? "planned" : "ok"}  mcp-remove — ${name} (${path})`
                : `skipped  mcp-remove — ${name} not in profile catalog`,
            );
            if (!dryRun && removed) {
              const profile = await loadProfile(profileName);
              const off: Record<HarnessId, boolean> = {
                cursor: false,
                claude: false,
                codex: false,
                pi: false,
                omp: false,
              };
              if (args.apply) {
                console.log(
                  formatResults(
                    await applyProfile({
                      profile: {
                        ...profile,
                        mcp: { ...profile.mcp, [name]: off },
                      },
                    }),
                  ),
                );
              }
              const mcp = { ...profile.mcp };
              delete mcp[name];
              await saveProfile({ ...profile, mcp });
            }
          },
        }),
        adopt: defineCommand({
          meta: {
            description:
              "Copy a global-catalog MCP into the active profile workspace (claims the name)",
          },
          args: {
            name: { type: "positional", required: true },
            profile: { type: "string" },
            apply: { type: "boolean" },
            "dry-run": { type: "boolean" },
          },
          async run({ args }) {
            await ensureHubLayout();
            const cfg = await loadConfig();
            const active = await getActiveProfile();
            const profileName =
              (args.profile ? String(args.profile) : undefined) ?? active;
            if (!profileName) throw new Error("no active profile");
            const dryRun = Boolean(args["dry-run"]);
            const name = String(args.name);
            const { path } = await adoptMcpFromGlobal({
              profileName,
              name,
              dryRun,
            });
            console.log(
              `${dryRun ? "planned" : "ok"}  mcp-adopt — ${name} → ${path}`,
            );
            await bumpMcpInProfile(profileName, name, cfg, dryRun);
            if (args.apply && !dryRun) {
              const profile = await loadProfile(profileName);
              console.log(formatResults(await applyProfile({ profile })));
            }
          },
        }),
        list: defineCommand({
          meta: { description: "List active profile workspace MCP defs" },
          async run() {
            await ensureHubLayout();
            const active = await getActiveProfile();
            if (!active) {
              console.log("(no active profile)");
              return;
            }
            const cat = await loadWorkspaceMcpCatalog(active);
            const names = Object.keys(cat.mcpServers).sort();
            console.log(`workspace ${active} mcp (${names.length}):`);
            for (const n of names) console.log(`  ${n}`);
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
        const profileNames = await listProfiles();
        const active = await getActiveProfile();
        const profileName =
          (args.profile ? String(args.profile) : undefined) ??
          active ??
          profileNames[0] ??
          "tui-session";
        const rows = await discoverMatrix({ profileName });

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

async function bumpSkillInProfile(
  profileName: string,
  name: string,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  let profile = await loadProfile(profileName).catch(async () => {
    const blank = {
      name: profileName,
      description: `workspace ${profileName}`,
      skills: {},
      mcp: {},
    };
    await saveProfile(blank);
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
  profile = { ...profile, skills: { ...profile.skills, [name]: flags } };
  await saveProfile(profile);
  console.log(`updated profile ${profileName}: skill ${name} enabled`);
}

async function bumpMcpInProfile(
  profileName: string,
  name: string,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  let profile = await loadProfile(profileName).catch(async () => {
    const blank = {
      name: profileName,
      description: `workspace ${profileName}`,
      skills: {},
      mcp: {},
    };
    await saveProfile(blank);
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
  profile = { ...profile, mcp: { ...profile.mcp, [name]: flags } };
  await saveProfile(profile);
  console.log(`updated profile ${profileName}: mcp ${name} enabled`);
}

runMain(main);
