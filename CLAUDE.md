# CLAUDE.md

Node.js proxy that exposes an Anthropic-compatible API backed by Google's Cloud Code service (Antigravity) and Tencent's WorkBuddy service (Copilot), letting Claude Code CLI use Gemini, Claude, DeepSeek, GLM, and Kimi models with multi-account quota and credential management.

Request flow: `Claude Code CLI → Express (server.js) → Provider Router → Antigravity / WorkBuddy Provider → Upstream API`

## Providers & Model Routing

- **Antigravity Provider**: Backed by Google Cloud Code (`antigravity/*` or unprefixed models like `claude-sonnet-4-6`, `gemini-3.1-pro-high`).
- **WorkBuddy Provider**: Backed by Tencent WorkBuddy / Copilot (`workbuddy/*` models like `workbuddy/deepseek-v4-pro`, `workbuddy/glm-5.2`, `workbuddy/kimi-k2.7`).
- **Model Resolution**: `config.modelMapping` aliases resolved first, then prefix routing. Unprefixed models route to Antigravity for 100% backward compatibility.
- **WorkBuddy Auth**: Discovered automatically from `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` on Windows (also supports macOS, Linux, and `WORKBUDDY_AUTH_DIR`). Credentials auto-refresh 60s before expiry with atomic write-back.

## Commands

```bash
npm install          # installs deps and builds CSS (prepare hook)
npm start            # port 8080
npm run dev          # watch server files
npm run dev:full     # watch CSS + server files

npm start -- --strategy=sticky       # cache-optimized (default is hybrid)
npm start -- --strategy=round-robin  # load-balanced
npm start -- --fallback              # fall back to alternate model on quota exhaustion
npm start -- --dev-mode              # enables debug logging + dev tools (--debug is a legacy alias)

npm run build:css    # compile Tailwind once
npm run watch:css    # watch CSS

npm run accounts:add                 # add Google account via OAuth
npm run accounts:add -- --no-browser # headless/manual code input
npm run accounts:list
npm run accounts:verify

npm test                             # requires server running on port 8080
npm run test:workbuddy               # run all WorkBuddy provider unit & integration tests
node tests/run-all.cjs <filter>      # run matching tests only
node tests/test-strategies.cjs       # strategy unit tests (no server needed)
```

## Non-obvious things

**CSS**: Source is `public/css/src/input.css` (Tailwind + `@apply`). Compiled output is `public/css/style.css` — don't edit the compiled file.

**Quota thresholds** are stored as fractions (0–0.99) but displayed as percentages in the UI. Three-tier resolution: per-model > per-account > global.

**`cache_control` stripping**: Claude Code CLI sends `cache_control` on content blocks; Cloud Code API rejects them. Stripped at the start of `convertAnthropicToGoogle()` before any other processing.

**Cross-model thinking signatures**: Claude and Gemini signatures are incompatible. When switching models mid-conversation, mismatched signatures are dropped. Gemini targets: strict (drop unknown). Claude targets: lenient (let Claude validate).

**`CLAUDE_CONFIG_PATH` env var**: Set this when running as a systemd service — `os.homedir()` returns the service user's home, not the real user's.

**`WEBUI_PASSWORD` env var**: Enables password protection on the web UI.

**Native module rebuild**: On Node.js version mismatch, `better-sqlite3` is auto-rebuilt via `npm rebuild`. If reload still fails after rebuild, a server restart is required.

**Dev mode sub-toggles** are client-side only (localStorage in `settings-store.js`): screenshot/redact mode, debug logging, log export, health inspector, placeholder data. No backend involvement.

**`/api/strategy/health`** returns 403 unless dev mode is on.
