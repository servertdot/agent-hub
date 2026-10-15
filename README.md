# agent-hub

CLI + TUI to manage **skills** and **MCP servers** across:

| Harness | Skills | MCP |
|---------|--------|-----|
| Cursor | `~/.cursor/skills` (+ `~/.agents/skills`) | `~/.cursor/mcp.json` |
| Claude Code | `~/.claude/skills` | `~/.claude.json` |
| Codex | `~/.codex/skills` | `~/.codex/config.toml` |
| pi | `~/.pi/agent/skills` | `~/.pi/agent/mcp.json` |
| OMP | `~/.omp/agent/skills` | `~/.omp/agent/mcp.json` |

Inspired by [agent-toggle](https://github.com/weskao/agent-toggle)’s TUI (staging, profiles, dry-run) — but the model is a **per-harness matrix**, not park-in-place only.

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
agent-hub status
agent-hub discover             # matrix of what is on this machine
agent-hub profile save stable  # capture current discovery into a profile
agent-hub diff stable          # dry-run
agent-hub apply stable
agent-hub tui                  # interactive matrix
agent-hub tui --dry-run
```

## Layout

```text
~/.agent-hub/
  config.yaml           # which harnesses are enabled
  catalog/mcp.yaml      # canonical MCP defs ($ENV refs preferred)
  profiles/
    stable.yaml
    lab.yaml
  state.json            # active profile
```

Profile shape:

```yaml
name: stable
description: Everyday set
skills:
  tdd:
    cursor: true
    claude: true
    codex: true
    pi: true
    omp: true
mcp:
  fff:
    cursor: true
    claude: true
    codex: false
    pi: true
    omp: false
```

Only keys you set are applied. Omitted harness cells are left alone.

## TUI (agent-toggle flavoured)

- `●` live / `○` off / `-` unknown
- `+` / `-` before glyph = staged change
- Tab toggles focused cell; ←→ moves harness column; ↑↓ rows
- `/` search, `t` filter skill|mcp, `h` harness tab
- Enter applies staged cells; Esc cancels
- Nothing is written while the picker is open

## Safety

- Disabling a skill **only removes symlinks** we created — never deletes a real skill directory
- MCP edits merge into existing JSON; Codex TOML apply is stubbed in MVP (`diff`/`apply` report `skipped`)
- Prefer `$ENV_NAME` in MCP configs — do not commit secrets
- Always `diff` / `tui --dry-run` before the first real apply

## Status (0.1)

MVP: discover, profiles, JSON MCP apply (Cursor/Claude/pi/OMP), skill symlink enable/disable, Ink TUI.

Next: Codex TOML MCP writer, import-from-harnesses into catalog, cost estimates, numbered non-TTY fallback.

## License

MIT
