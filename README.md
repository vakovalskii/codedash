# CodeDash

Dashboard + CLI for AI coding agent sessions. View, search, resume, convert, and hand off between 5 agents.

[Russian / Русский](docs/README_RU.md) | [Chinese / 中文](docs/README_ZH.md)

https://github.com/user-attachments/assets/15c45659-365b-49f8-86a3-9005fa155ca6

![npm](https://img.shields.io/npm/v/codedash-app?style=flat-square) ![Node](https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square) ![Zero deps](https://img.shields.io/badge/dependencies-0-blue?style=flat-square)

## Quick Start

```bash
npm i -g codedash-app
codedash run
```

## Docker

Docker files live under `docker/`. Use `./in-docker.sh` to select which host agent data sources should be mounted into the container.

```bash
./in-docker.sh --claude --codex
./in-docker.sh --cursor -- up -d
./in-docker.sh --all -- up --build
```

Supported flags:
- `--claude` mounts `~/.claude` to `/root/.claude`
- `--codex` mounts `~/.codex` to `/root/.codex`
- `--cursor` mounts `~/.cursor` to `/root/.cursor`
- `--opencode` mounts `~/.local/share/opencode/opencode.db`
- `--kiro` mounts `~/Library/Application Support/kiro-cli/data.sqlite3`
- `--all` enables every supported mount

The base container always listens on `0.0.0.0:3847`, so it can be reached via the host machine LAN IP when Docker publishes that port.
Mounted agent data sources are writable inside the container so CodeDash actions like delete, convert, and settings updates work the same way as a host run.

## Supported Agents

| Agent | Sessions | Preview | Search | Live Status | Convert | Handoff | Launch |
|-------|----------|---------|--------|-------------|---------|---------|--------|
| Claude Code | JSONL | Yes | Yes | Yes | Yes | Yes | Terminal / cmux |
| Codex CLI | JSONL | Yes | Yes | Yes | Yes | Yes | Terminal |
| Cursor | JSONL | Yes | Yes | Yes | - | Yes | Open in Cursor |
| OpenCode | SQLite | Yes | Yes | Yes | - | Yes | Terminal |
| Kiro CLI | SQLite | Yes | Yes | Yes | - | Yes | Terminal |

Also detects Claude Code running inside Cursor (via `claude-vscode` entrypoint).

## Features

**Browser Dashboard**
- Grid and List view with project grouping
- Trigram fuzzy search + full-text deep search across all messages
- Filter by agent, tags, date range
- Star/pin sessions, tag with labels
- GitHub-style SVG activity heatmap with streak stats
- Session Replay with timeline slider and play/pause
- Hover preview + expandable cards
- Themes: Dark, Light, System

**Live Monitoring**
- LIVE/WAITING badges on all 5 agent types
- Animated border on active session cards
- Running view with CPU, Memory, PID, Uptime
- Focus Terminal / Open in Cursor buttons
- Polling every 5 seconds

**Cost Analytics**
- Real cost from actual token usage (input, output, cache)
- Per-model pricing: Opus, Sonnet, Haiku, Codex, GPT-5
- Daily cost chart, cost by project, most expensive sessions

**Cross-Agent**
- Convert sessions between Claude Code and Codex
- Handoff: generate context document to continue in any agent
- Install Agents: one-click install commands for all 5 agents

**CLI**
```bash
codedash run [--port=N] [--no-browser]
codedash search <query>
codedash show <session-id>
codedash handoff <id> [target] [--verbosity=full] [--out=file.md]
codedash convert <id> claude|codex
codedash list [limit]
codedash stats
codedash export [file.tar.gz]
codedash import <file.tar.gz>
codedash update
codedash restart
codedash stop
```

Bind host can be configured with `--host=ADDR` or `CODEDASH_HOST`:

```bash
codedash run
codedash run --host=0.0.0.0
CODEDASH_HOST=0.0.0.0 codedash run
```

If both are set, `--host` takes precedence.

**Keyboard Shortcuts**: `/` search, `j/k` navigate, `Enter` open, `x` star, `d` delete, `s` select, `g` group, `r` refresh, `Esc` close

## Data Sources

```
~/.claude/                              Claude Code sessions + PID tracking
~/.codex/                               Codex CLI sessions
~/.cursor/projects/*/agent-transcripts/ Cursor agent sessions
~/.local/share/opencode/opencode.db     OpenCode (SQLite)
~/Library/Application Support/kiro-cli/ Kiro CLI (SQLite)
```

Zero dependencies. By default everything runs on `localhost`. Set `--host=0.0.0.0` or `CODEDASH_HOST=0.0.0.0` to listen on all interfaces, including your host machine LAN IP.

## Install Agents

```bash
curl -fsSL https://claude.ai/install.sh | bash          # Claude Code
npm i -g @openai/codex                                   # Codex CLI
curl -fsSL https://cli.kiro.dev/install | bash           # Kiro CLI
curl -fsSL https://opencode.ai/install | bash            # OpenCode
```

## Requirements

- Node.js >= 18
- At least one AI coding agent installed
- macOS / Linux / Windows

## Contributing

`main` is protected. All changes go through feature branches and pull requests.

```bash
git checkout -b fix/my-fix
# make changes
git push -u origin fix/my-fix
gh pr create
```

- **Branch naming:** `feat/`, `fix/`, `chore/`, `release/`
- **1 approval** required to merge
- Keep PRs small and focused

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for codebase details.

## License

MIT
