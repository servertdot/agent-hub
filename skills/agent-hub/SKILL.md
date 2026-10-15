---
name: agent-hub
description: Manage skills and MCP across Cursor, Claude Code, Codex, pi, and OMP via agent-hub profiles/workspaces. Use when switching profiles, installing/removing/copying skills or MCP, syncing npx/harness installs into the active profile, applying or diffing a profile, or debugging why a harness still shows the wrong skill set.
---

# agent-hub

CLI: `agent-hub` / `ahub`. Hub data: `~/.agent-hub/`.

## Mental model

- **Profile = workspace.** `lab` / `stable` / … each own a private skill set and MCP catalog.
- **Apply** projects that workspace onto harness dirs, then **prunes** anything on the harness that is not `true` in the profile.
- Selecting a profile in the TUI only **loads** it for editing. Live harnesses change only after **Enter** / `agent-hub apply <name>`.
- `state.json` `activeProfile` alone does not clear leftovers — always **apply**.

Layout:

```text
~/.agent-hub/
  library/skills/                 # orphans / migrate leftovers (not new installs)
  workspaces/<profile>/skills/    # profile-private packages
  workspaces/<profile>/mcp.yaml   # profile-private MCP defs
  profiles/<profile>.yaml         # per-harness enable matrix
  catalog/mcp.yaml                # global MCP fallback
  state.json                      # active profile
```

Harness live skills (hub-managed): `~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`, `~/.omp/agent/skills`.  
`~/.agents/skills` is **parked empty** so shared Agent Skills paths cannot leak across profiles.

## Do / don't

**Do**

- Change membership with hub commands or TUI, then `apply`.
- After `npx skills add …` or dropping a skill into a harness dir: `agent-hub sync --apply` (or `watch --apply`).
- Prefer `agent-hub diff <profile>` before a risky apply.
- Copy between profiles with `skill copy` (source kept).

**Don't**

- Hand-edit harness skill dirs or assume deleting a symlink elsewhere updates the profile.
- Expect package skills (e.g. pi `npm:pi-lens`) to disappear on apply — hub does not manage package-shipped skills.
- Treat TUI sidebar selection as apply.
- Install the same skill **name** into two profiles — names conflict machine-wide.

## Commands agents should use

```bash
agent-hub status
agent-hub discover
agent-hub diff <profile>
agent-hub apply <profile>          # activate + project + prune extras

agent-hub skill install <path|name> [--profile X] [--apply]
  # path: absolute, ~/…, or relative (cwd, then agent-hub package root)
  # bare name: <package>/skills/<name> (e.g. agent-hub)
agent-hub skill remove <name> [--profile X] [--apply]
agent-hub skill adopt <name> [--apply]          # orphan library → active
agent-hub skill copy <name…> --from A --to B [--apply]
agent-hub skill copy --all --from A --to B [--apply]
agent-hub skill list

agent-hub sync [--apply]           # ~/.agents + harness real dirs → active
agent-hub watch [--apply]          # same, continuous

agent-hub mcp install <file> [--name N] [--apply]
agent-hub mcp remove <name> [--apply]
agent-hub mcp adopt <name> [--apply]
agent-hub mcp list

agent-hub tui                      # w=save draft, Enter=apply, c/C=copy skills
```

New empty profile (TUI `+ new` or):

```bash
mkdir -p ~/.agent-hub/workspaces/<name>/skills
# profiles/<name>.yaml with skills: {} and mcp: {}
agent-hub apply <name>             # clears hub projections on harnesses
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Empty profile but pi/Cursor still lists skills | Apply never ran, or leftovers from previous profile | `agent-hub apply <empty-profile>` |
| Skill file on disk but missing from `available_skills` | Session started before enable, or `disable-model-invocation: true` | `/reload` or new session; check SKILL.md frontmatter |
| `pi-lens-*` still present after empty apply | Comes from pi **packages**, not hub | Not hub-managed; remove package via pi settings if needed |
| Install fails with name conflict | Name exists in another profile or library | `skill remove` / rename / `adopt` as appropriate |
| New TUI profile filled with skills | Old bug (fixed): inherited live rows | Use current CLI; new profiles start empty |

## TUI cheatsheet

- Sidebar click = load profile (not apply)
- `w` = save YAML only
- Enter = save + apply (+ prune)
- Skills tab: `c` copy focused / `C` copy visible → pick target profile → Enter
- `d` / `e` = bulk off/on for current kind tab

## Secrets

Prefer `$ENV_NAME` in MCP configs. Use `import-mcp`, `scrub-catalog`, `scrub-harnesses --write` when cleaning pasted tokens. Never commit secrets into profile or catalog YAML.
