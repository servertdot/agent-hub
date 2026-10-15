# agent-hub

CLI + TUI to manage **skills** and **MCP servers** across:

| Harness | Skills (live) | MCP |
|---------|---------------|-----|
| Cursor | `~/.cursor/skills` | `~/.cursor/mcp.json` |
| Claude Code | `~/.claude/skills` | `~/.claude.json` |
| Codex | `~/.codex/skills` | `~/.codex/config.toml` |
| pi | `~/.pi/agent/skills` | `~/.pi/agent/mcp.json` |
| OMP | `~/.omp/agent/skills` | `~/.omp/agent/mcp.json` |

## Model: profile = workspace

A **profile** is an active **workspace**. Switching profile changes which skills (and MCP flags) harnesses actually see.

```text
~/.agent-hub/
  library/skills/           # all skill packages (SoT contents)
  workspaces/<profile>/skills/  # subset for this profile (symlinks → library)
  profiles/<profile>.yaml   # per-harness enable matrix
  catalog/mcp.yaml
  state.json                # active profile
```

- **Library** — global package store. Installs land here.
- **Workspace** — skills that belong to the active profile (any harness `true`).
- **Apply** — parks shared `~/.agents/skills` (empty), syncs workspace, then projects symlinks into each harness skill dir per matrix.
- **Install** — `agent-hub skill install <path>` → library + active workspace (+ profile flags).

`~/.agents/skills` is **parked empty** on purpose: pi/Cursor/Codex also auto-load that path, so a shared pool would leak skills across profiles. Live skills live only in harness-private dirs.

Inspired by [agent-toggle](https://github.com/weskao/agent-toggle)’s TUI — but the SoT is a **workspace + per-harness matrix**, not park-in-place only.

No GUI. Config + CLI + TUI.

## Install

```bash
git clone git@github.com:servertdot/agent-hub.git
cd agent-hub
bun install
bun link          # puts `agent-hub` / `ahub` on PATH via bun
# or: bun run src/cli.ts …
```

Requires Node 22+ or Bun.

## Quick start

```bash
agent-hub init                 # ~/.agent-hub + example profiles
agent-hub migrate              # absorb ~/.agents/skills → library; park shared empty
agent-hub status
agent-hub discover             # matrix + token estimates
agent-hub cost                 # biggest startup costs first
agent-hub import-mcp           # fill catalog/mcp.yaml from Cursor/Claude/OMP JSON
agent-hub scrub-catalog        # replace pasted secrets with $ENV refs
agent-hub scrub-harnesses --write
agent-hub profile save stable  # capture current discovery into a profile
agent-hub profile seed-lab     # clone stable → lab + omp extras
agent-hub diff lab             # dry-run (hides noops; -v for full)
agent-hub apply lab            # activate workspace + project to harnesses
agent-hub skill install ./my-skill --apply
agent-hub tui                  # Ink matrix on a TTY
agent-hub tui --menu           # numbered fallback (also used without TTY)
agent-hub tui --dry-run
```

## Layout

```text
~/.agent-hub/
  config.yaml
  catalog/mcp.yaml
  library/skills/
  workspaces/
    lab/skills/
    stable/skills/
  profiles/
    stable.yaml
    lab.yaml
  state.json
```

Profile shape:

```yaml
name: lab
description: Experimental
skills:
  tdd:
    cursor: true
    claude: false
    codex: false
    pi: false
    omp: false
mcp:
  fff:
    cursor: true
    claude: false
    codex: false
    pi: true
    omp: false
```

Only keys you set are applied. Omitted harness cells are left alone.

Skill with **all harnesses false** → removed from workspace and from harness dirs on apply.

## TUI (agent-toggle flavoured)

- `●` live / `○` off / `-` unknown
- `+` / `-` before glyph = staged change
- Tab toggles focused cell; ←→ moves harness column; ↑↓ rows
- Top tabs: **Skills** | **MCP** | **Harnesses** (`t` / `1` / `2` / `3`)
- Selecting a profile in the sidebar **loads** it for editing — it does **not** apply
- Enter applies (save profile + workspace sync + harness projection); Esc cancels
- `w` saves profile YAML only

## Safety

- Disabling a skill removes harness symlinks; real dirs are **moved into the library** (never deleted blindly)
- Shared `~/.agents/skills` is emptied/parked on migrate/apply so profiles cannot leak
- MCP edits merge into existing JSON; Codex TOML flips `enabled` and keeps subtables
- Prefer `$ENV_NAME` in MCP configs — do not commit secrets
- Always `diff` / `tui --dry-run` before the first real apply

## Status (0.1)

- workspace library + per-profile skills
- migrate / apply parks shared Agent Skills pool
- `skill install` → active workspace
- discover / profiles / Ink TUI (stage → apply)
- cost estimates, MCP import/scrub

## License

MIT
