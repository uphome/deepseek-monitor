# DeepSeek Monitor

A VSCode extension that monitors DeepSeek API balance and token usage in real time, with an interactive dashboard — designed for use with Claude Code.

> No proxy or network interception required — token data is parsed directly from Claude Code's local JSONL session files. API key is encrypted via the VSCode Secrets API.

## Features

- 💰 **Balance monitoring** — real-time balance in the status bar with color-coded warnings
- 📊 **Token usage** — per-project accumulation of Input / Output / Cache Read tokens
- 📈 **7-day line chart** — daily consumption visualization with hover tooltips
- 🔔 **Low-balance alerts** — automatic notifications when balance drops below threshold
- 🔐 **Secure storage** — API key stored in OS keychain via VSCode Secrets, never written to disk
- ⚡ **Live updates** — balance polling + JSONL file watcher, flicker-free DOM patching

## Prerequisites

| Dependency | Minimum | Check |
|------------|---------|-------|
| Node.js | >= 18 | `node -v` |
| npm | >= 9 | `npm -v` |
| VSCode | >= 1.85.0 | `code --version` |
| Git | any | `git --version` |

```sh
node -v    # should print v18.x or higher
npm -v     # should print 9.x or higher
```

## Installation

### Option 1: Build from source

```sh
# 1. Clone the repo
git clone https://github.com/uphome/deepseek-monitor.git
cd deepseek-monitor

# 2. Install dependencies
npm install

# 3. Compile TypeScript
npm run compile

# 4. Package as .vsix (first run will install vsce)
npx @vscode/vsce package

# 5. Install into VSCode
code --install-extension deepseek-monitor-0.1.0.vsix
```

### Option 2: VSCode Marketplace (once published)

Search for `DeepSeek Monitor` in the VSCode Extensions panel and install.

### Development

```sh
git clone https://github.com/uphome/deepseek-monitor.git
cd deepseek-monitor
npm install
npm run watch    # watch & recompile on file changes
```

Open the project in VSCode and press `F5` to launch the Extension Development Host.

## Configuration

### 1. Get an API Key

Create an API key at [DeepSeek Platform](https://platform.deepseek.com/api_keys) (format: `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).

### 2. Set the API Key

In VSCode:

1. `Ctrl+Shift+P` to open the command palette
2. Run **DeepSeek: Set API Key (Secure Storage)**
3. Paste your API key
4. The key is encrypted into the OS keychain — never saved as plain text

### 3. Verify

Once configured, the status bar shows your balance immediately:

```
┌─────────────────────────────────────┐
│ $(circuit-board) ¥4.52 | Tokens 3.73M │
└─────────────────────────────────────┘
```

### 4. Optional Settings

Search `deepseekMonitor` in VSCode Settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `deepseekMonitor.refreshInterval` | `60` | Balance polling interval in seconds (min: 10) |
| `deepseekMonitor.lowBalanceThreshold` | `5` | Low-balance warning threshold (CNY) |
| `deepseekMonitor.showInStatusBar` | `true` | Show/hide the status bar item |

## Usage

### Status Bar

The status bar displays real-time balance and the current project's token consumption. Hover for details, click to open the full dashboard.

Balance color coding:
- Default (no background): sufficient balance
- Yellow: below threshold (default ¥5)
- Red: balance depleted

### Dashboard

`Ctrl+Shift+P` → **DeepSeek: Open Dashboard**

Panels include:
- Account balance cards (total balance + today's consumption)
- Token usage cards (Input / Output / Cache Read / cache coverage rate)
- 7-day daily consumption line chart (hover for tooltips)
- 7-day daily consumption table
- Model distribution & session details

### Commands

| Command | Description |
|---------|-------------|
| `DeepSeek: Refresh Balance` | Manually refresh balance |
| `DeepSeek: Set API Key (Secure Storage)` | Configure API key |
| `DeepSeek: Clear API Key` | Remove saved API key |
| `DeepSeek: Open Dashboard` | Open the usage dashboard |
| `DeepSeek: Generate Test Data (Dev)` | Generate 7-day mock data for debugging |
| `DeepSeek: Clear Test Data (Dev)` | Remove all test data |

## Architecture

```
src/
├── extension.ts    # Entry point, command registration, timer, watcher lifecycle
├── api.ts          # DeepSeek /user/balance API client
├── storage.ts      # Balance history persistence (VSCode globalState)
├── statusBar.ts    # Status bar display (balance + tokens)
├── dashboard.ts    # Webview panel (cards + line chart + token usage)
└── usage.ts        # Local JSONL parser + fs.watch file listener
```

Data sources:
- **Balance** → `api.deepseek.com/user/balance` (polled every N seconds)
- **Tokens** → `~/.claude/projects/<project-path>/*.jsonl` (file watcher)

## FAQ

### Q: Status bar shows "DeepSeek: Not Configured"?

Run **DeepSeek: Set API Key (Secure Storage)** and paste your API key.

### Q: Token usage panel shows "No Data"?

Make sure you have used Claude Code in the current project. Token data comes from Claude Code's local JSONL files — if there are no sessions for the project, there is no data.

### Q: Line chart / consumption shows `--`?

At least 2 balance samples are needed. Wait ~60 seconds after installation, or run **Generate Test Data (Dev)** for mock data.

### Q: Balance not updating?

Check if your API key is valid: run **DeepSeek: Refresh Balance**. A 401 error means the key needs to be re-configured.

## License

MIT
