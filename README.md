# Antigravity Claude Proxy

[![npm version](https://img.shields.io/npm/v/antigravity-claude-proxy.svg)](https://www.npmjs.com/package/antigravity-claude-proxy)
[![npm downloads](https://img.shields.io/npm/dm/antigravity-claude-proxy.svg)](https://www.npmjs.com/package/antigravity-claude-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A proxy server that exposes an **Anthropic-compatible API** backed by **Antigravity's Cloud Code**, letting you use Claude and Gemini models with **Claude Code CLI** and **OpenClaw / ClawdBot**.

![Antigravity Claude Proxy Banner](images/banner.png)

> **⚠️ WARNING:** Google has been issuing ToS violation bans on accounts connected to this proxy. Use at your own risk.

<details>
<summary><strong>⚠️ Terms of Service Warning — Read Before Installing</strong></summary>

> [!CAUTION]
> Using this proxy may violate Google's Terms of Service. A small number of users have reported their Google accounts being **banned** or **shadow-banned** (restricted access without explicit notification).
>
> **By using this proxy, you acknowledge:**
> - This is an unofficial tool not endorsed by Google
> - Your account may be suspended or permanently banned
> - You assume all risks associated with using this proxy
>
> **Recommendation:** Do not use your main account. Use a burner account instead, and optionally add it to your main account's family plan if needed.

</details>

---

## How It Works

```
                                                     ┌────────────────────────────┐
                                              ┌─────▶│  Antigravity Cloud Code    │
                                              │      │  (Google Cloud Code API)   │
┌──────────────────┐     ┌─────────────────┐  │      └────────────────────────────┘
│   Claude Code    │────▶│ Provider Router │──┤
│   (Anthropic     │     │  (This Proxy    │  │      ┌────────────────────────────┐
│    Messages API) │     │   Server :8080) │  └─────▶│  WorkBuddy Copilot         │
└──────────────────┘     └─────────────────┘         │  (copilot.tencent.com)     │
                                                     └────────────────────────────┘
```

1. Receives requests in **Anthropic Messages API format** (`/v1/messages`)
2. **Provider Router** resolves models by prefix:
   - `workbuddy/*` (e.g. `workbuddy/deepseek-v4-pro`, `workbuddy/glm-5.2`) → **WorkBuddy Provider**
   - `antigravity/*` or unprefixed (e.g. `claude-sonnet-4-6`, `gemini-3.1-pro-high`) → **Antigravity Provider** (100% backward compatible)
3. For **Antigravity**: Transforms to Google Cloud Code Generative AI format and manages Google multi-account quotas
4. For **WorkBuddy**: Transforms Anthropic messages and tool calls to native OpenAI Chat Completions, connects to `copilot.tencent.com`, streams SSE, and converts back to Anthropic event stream
5. Automatic token refresh 60s before expiry with atomic write-back, 401 retry, and 429 rate limit failover

## Prerequisites

- **Node.js** 18 or later
- **Antigravity** installed / Google account(s) OR **WorkBuddy / CodeBuddy** logged in locally

---

## Installation

### Option 1: npm (Recommended)

```bash
# Run directly with npx (no install needed)
npx antigravity-claude-proxy@latest start

# Or install globally
npm install -g antigravity-claude-proxy@latest
antigravity-claude-proxy start
```

### Option 2: Clone Repository

```bash
git clone https://github.com/badri-s2001/antigravity-claude-proxy.git
cd antigravity-claude-proxy
npm install
npm start
```

---

## Quick Start

### 1. Start the Proxy Server

```bash
# If installed globally
acc start
# or: antigravity-claude-proxy start

# If using npx
npx antigravity-claude-proxy@latest start

# If cloned locally
npm start
```

The server launches as a **background process** on `http://localhost:8080` by default and survives terminal closure.

| Command | Description |
| :--- | :--- |
| `acc start` | Launch proxy in the background |
| `acc stop` | Shut down the proxy |
| `acc restart` | Restart the proxy |
| `acc status` | Check proxy health and PID |
| `acc ui` | Open the web dashboard |
| `acc start --log` | Run in foreground with visible logs |

### 2. Link Account(s)

Choose one of the following methods to authorize the proxy:

#### **Method A: Web Dashboard (Recommended)**

1. With the proxy running, open `http://localhost:8080` in your browser.
2. Navigate to the **Accounts** tab and click **Add Account**.
3. Complete the Google OAuth authorization in the popup window.

> **Headless/Remote Servers**: If running on a server without a browser, the WebUI supports a "Manual Authorization" mode. After clicking "Add Account", you can copy the OAuth URL, complete authorization on your local machine, and paste the authorization code back.

#### **Method B: CLI (Desktop or Headless)**

If you prefer the terminal or are on a remote server:

```bash
# Desktop (opens browser)
antigravity-claude-proxy accounts add

# Headless (Docker/SSH)
antigravity-claude-proxy accounts add --no-browser
```

> For full CLI account management options, run `antigravity-claude-proxy accounts --help`.

#### **Method C: Automatic (Antigravity Users)**

If you have the **Antigravity** app installed and logged in, the proxy will automatically detect your local session. No additional setup is required.

To use a custom port:

```bash
PORT=3001 antigravity-claude-proxy start
```

### 3. Verify It's Working

```bash
# Health check
curl http://localhost:8080/health

# Check account status and quota limits
curl "http://localhost:8080/account-limits?format=table"
```

---

## Using with Claude Code CLI

### Configure Claude Code

You can configure these settings in two ways:

#### **Via Web Console (Recommended)**

1. Open the WebUI at `http://localhost:8080`.
2. Go to **Settings** → **Claude CLI**.
3. Use the **Connection Mode** toggle to switch between:
   - **Proxy Mode**: Uses the local proxy server (Antigravity Cloud Code). Configure models, base URL, and presets here.
   - **Paid Mode**: Uses the official Anthropic Credits directly (requires your own subscription). This hides proxy settings to prevent accidental misconfiguration.
4. Click **Apply to Claude CLI** to save your changes.

> [!TIP] > **Configuration Precedence**: System environment variables (set in shell profile like `.zshrc`) take precedence over the `settings.json` file. If you use the Web Console to manage settings, ensure you haven't manually exported conflicting variables in your terminal.

#### **Manual Configuration**

Create or edit the Claude Code settings file:

**macOS:** `~/.claude/settings.json`
**Linux:** `~/.claude/settings.json`
**Windows:** `%USERPROFILE%\.claude\settings.json`

Add this configuration:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-6",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

#### **Using with WorkBuddy Models (DeepSeek, GLM, Kimi)**

To use WorkBuddy models with Claude Code CLI, configure your `%USERPROFILE%\.claude\settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080",
    "ANTHROPIC_AUTH_TOKEN": "test",

    "ANTHROPIC_MODEL": "workbuddy/deepseek-v4-pro",

    "ANTHROPIC_DEFAULT_OPUS_MODEL": "workbuddy/deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "workbuddy/deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "workbuddy/deepseek-v4-flash",

    "CLAUDE_CODE_SUBAGENT_MODEL": "workbuddy/deepseek-v4-pro"
  }
}
```

Or set in your PowerShell session:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
$env:ANTHROPIC_AUTH_TOKEN="test"
$env:ANTHROPIC_MODEL="workbuddy/deepseek-v4-pro"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="workbuddy/deepseek-v4-pro"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="workbuddy/deepseek-v4-pro"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="workbuddy/deepseek-v4-flash"
$env:CLAUDE_CODE_SUBAGENT_MODEL="workbuddy/deepseek-v4-pro"

claude
```

Or to use Gemini models:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_MODEL": "gemini-3.1-pro-low",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3.1-pro-low",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3.5-flash-low",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.5-flash-low",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gemini-3.5-flash-low",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true"
  }
}
```

### Load Environment Variables

Add the proxy settings to your shell profile:

**macOS / Linux:**

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:8080"' >> ~/.zshrc
echo 'export ANTHROPIC_AUTH_TOKEN="test"' >> ~/.zshrc
source ~/.zshrc
```

> For Bash users, replace `~/.zshrc` with `~/.bashrc`

**Windows (PowerShell):**

```powershell
Add-Content $PROFILE "`n`$env:ANTHROPIC_BASE_URL = 'http://localhost:8080'"
Add-Content $PROFILE "`$env:ANTHROPIC_AUTH_TOKEN = 'test'"
. $PROFILE
```

**Windows (Command Prompt):**

```cmd
setx ANTHROPIC_BASE_URL "http://localhost:8080"
setx ANTHROPIC_AUTH_TOKEN "test"
```

Restart your terminal for changes to take effect.

### Run Claude Code

```bash
# Make sure the proxy is running first
antigravity-claude-proxy start

# In another terminal, run Claude Code
claude
```

> **Note:** If Claude Code asks you to select a login method, add `"hasCompletedOnboarding": true` to `~/.claude.json` (macOS/Linux) or `%USERPROFILE%\.claude.json` (Windows), then restart your terminal and try again.

### Proxy Mode vs. Paid Mode

Toggle in **Settings** → **Claude CLI**:

| Feature | 🔌 Proxy Mode | 💳 Paid Mode |
| :--- | :--- | :--- |
| **Backend** | Local Server (Antigravity) | Official Anthropic Credits |
| **Cost** | Free (Google Cloud) | Paid (Anthropic Credits) |
| **Models** | Claude + Gemini | Claude Only |

**Paid Mode** automatically clears proxy settings so you can use your official Anthropic account directly.

### Multiple Claude Code Instances (Optional)

To run both the official Claude Code and Antigravity version simultaneously, add this alias:

**macOS / Linux:**

```bash
# Add to ~/.zshrc or ~/.bashrc
alias claude-antigravity='CLAUDE_CONFIG_DIR=~/.claude-account-antigravity ANTHROPIC_BASE_URL="http://localhost:8080" ANTHROPIC_AUTH_TOKEN="test" command claude'
```

**Windows (PowerShell):**

```powershell
# Add to $PROFILE
function claude-antigravity {
    $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-account-antigravity"
    $env:ANTHROPIC_BASE_URL = "http://localhost:8080"
    $env:ANTHROPIC_AUTH_TOKEN = "test"
    claude
}
```

Then run `claude` for official API or `claude-antigravity` for this proxy.

### Running as a System Service (systemd)

When running as a systemd service, the proxy runs under a different user (e.g. `root`), so it can't find your Claude CLI settings at `~/.claude/settings.json`. Set `CLAUDE_CONFIG_PATH` to point to the real user's `.claude` directory:

```ini
# /etc/systemd/system/antigravity-proxy.service
[Service]
Environment=CLAUDE_CONFIG_PATH=/home/youruser/.claude
ExecStart=/usr/bin/node /path/to/antigravity-claude-proxy/src/index.js
```

Without this, the WebUI's Claude CLI tab won't be able to read or write your Claude Code configuration.

---

## Documentation

- [Available Models](docs/models.md)
- [Multi-Account Load Balancing](docs/load-balancing.md)
- [Web Management Console](docs/web-console.md)
- [Advanced Configuration](docs/configuration.md)
- [macOS Menu Bar App](docs/menubar-app.md)
- [OpenClaw / ClawdBot Integration](docs/openclaw.md)
- [API Endpoints](docs/api-endpoints.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Safety, Usage, and Risk Notices](docs/safety-notices.md)
- [Legal](docs/legal.md)
- [Development](docs/development.md)

---

## Credits

This project is based on insights and code from:

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - Antigravity OAuth plugin for OpenCode
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) - Anthropic API proxy using LiteLLM

---

## License

MIT

---

<a href="https://buymeacoffee.com/badrinarayanans" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50"></a>

## Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left&cache-control=no-cache)](https://star-history.dera.page/#badrisnarayanan/antigravity-claude-proxy&type=date&legend=top-left)
