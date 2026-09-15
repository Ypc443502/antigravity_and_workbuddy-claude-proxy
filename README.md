# Antigravity Claude Proxy（含 WorkBuddy 支持）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个代理服务器，对外暴露 **Anthropic 兼容 API**，后端接 **Antigravity 的 Cloud Code** 和
**腾讯 WorkBuddy**，让你可以在 **Claude Code CLI** 和 **OpenClaw / ClawdBot** 里使用
Claude、Gemini、DeepSeek、GLM、Kimi 等模型。

![Antigravity Claude Proxy Banner](images/banner.png)

> **⚠️ 警告：** Google 已对连接此代理的账号发出 ToS 违规封禁。使用风险自负。

<details>
<summary><strong>⚠️ 服务条款警告 —— 安装前请先阅读</strong></summary>

> [!CAUTION]
> 使用此代理可能违反 Google 的服务条款。已有少量用户反馈其 Google 账号被**封禁**或**影子封禁**
> （访问受限但无明确通知）。
>
> **使用此代理即表示你已知晓：**
> - 这是非官方工具，未获 Google 认可
> - 你的账号可能被暂停或永久封禁
> - 你自行承担使用此代理带来的一切风险
>
> **建议：** 不要用主账号，改用小号；如有需要，可将其加入主账号的家庭组。

</details>

---

## 工作原理

```
                                                     ┌────────────────────────────┐
                                              ┌─────▶│  Antigravity Cloud Code    │
                                              │      │  (Google Cloud Code API)   │
┌──────────────────┐     ┌─────────────────┐  │      └────────────────────────────┘
│   Claude Code    │────▶│   Provider      │──┤
│   (Anthropic     │     │   Router        │  │      ┌────────────────────────────┐
│    Messages API) │     │   (本代理 :8080) │  └─────▶│  WorkBuddy Copilot         │
└──────────────────┘     └─────────────────┘         │  (copilot.tencent.com)     │
                                                     └────────────────────────────┘
```

1. 接收 **Anthropic Messages API 格式**的请求（`/v1/messages`）
2. **Provider Router** 按前缀分发模型：
   - `workbuddy/*`（如 `workbuddy/deepseek-v4-pro`、`workbuddy/glm-5.2`）→ **WorkBuddy Provider**
   - `antigravity/*` 或不带前缀（如 `claude-sonnet-4-6`、`gemini-3.1-pro-high`）→ **Antigravity Provider**（100% 向后兼容）
3. **Antigravity**：转换为 Google Cloud Code Generative AI 格式，并管理 Google 多账号配额
4. **WorkBuddy**：将 Anthropic 消息与工具调用转换为原生 OpenAI Chat Completions 格式，
   连接 `copilot.tencent.com`，流式接收 SSE，再转回 Anthropic 事件流
5. 令牌在过期前 60 秒自动刷新（原子写回），支持 401 重试与 429 限流故障转移

## 前置要求

- **Node.js** 18 或更高版本
- 已安装 **Antigravity**（或已添加 Google 账号），**或**本地已登录 **WorkBuddy / CodeBuddy**

---

## 安装与启动（速览）

```bash
git clone -b feat/workbuddy-provider https://github.com/Ypc443502/antigravity_and_workbuddy-claude-proxy.git
cd antigravity_and_workbuddy-claude-proxy
npm install
npm run acc start
```

四条命令，代理就在 `http://localhost:8080` 跑起来了。用 `npm run acc status` 查看状态，
用 `npm run acc ui` 打开网页控制台。

**每个 Provider 都需要本地已有登录好的账号 —— 代理只读取现成的会话，不会替你创建：**

- **Antigravity**（Claude、Gemini）—— 需要已安装并登录 Antigravity，或通过
  `npm run acc accounts add` 添加 Google 账号。
- **WorkBuddy**（DeepSeek、GLM、Kimi）—— 需要**已安装并登录 WorkBuddy 桌面端**。
  没有 API key，也没有登录流程。详见 [WorkBuddy 账号要求](#workbuddy-账号要求)。

---

## 安装

```bash
git clone -b feat/workbuddy-provider https://github.com/Ypc443502/antigravity_and_workbuddy-claude-proxy.git
cd antigravity_and_workbuddy-claude-proxy
npm install
npm run acc start
```

整个安装过程就这四条命令。

`npm run acc start` 会把代理放到后台运行在 `http://localhost:8080` —— 它会脱离终端，
所以你的终端可以继续用，关闭终端后服务也不会停。

> **不要跳过 `npm install`。** 它会触发 `prepare` 钩子编译 Tailwind 样式表
> （`public/css/style.css`）。跳过的话网页控制台会没有样式。

### `acc` 命令

`acc` 是管理代理的内置 CLI。克隆仓库的情况下，通过 `npm run` 调用：

| 命令 | 作用 |
|---|---|
| `npm run acc start` | 后台启动代理 |
| `npm run acc start -- --log` | 前台运行并显示日志 |
| `npm run acc stop` | 关闭代理 |
| `npm run acc restart` | 重启代理 |
| `npm run acc status` | 查看健康状态与 PID |
| `npm run acc ui` | 打开网页控制台 |

如果你想让 `acc` 直接出现在 PATH 里，可以链接一下：

```bash
npm link          # 之后可直接用：acc start、acc status、acc ui
```

### 本仓库相比上游 npm 包多了什么

这个 fork 增加了 **WorkBuddy Provider**。npm 上的 `antigravity-claude-proxy` 由上游作者发布，
**只包含 Antigravity** —— 没有 `workbuddy/*` 模型，也没有相关代码。想用 DeepSeek、GLM、Kimi
就用本仓库。

| 模型系列 | 本仓库 | 上游 npm 包 |
|---|---|---|
| Claude、Gemini（Antigravity） | ✅ | ✅ |
| **DeepSeek、GLM、Kimi（WorkBuddy）** | ✅ | ❌ |

---

## WorkBuddy 账号要求

> ⚠️ **WorkBuddy 模型只有在 WorkBuddy 桌面端已登录的情况下才能使用。**
> WorkBuddy 没有 API key、没有 token，也没有 `acc accounts add` 流程。代理只读取桌面端
> 已经创建好的会话 —— **它无法替你创建**。

### 实际表现

| 情况 | 结果 |
|---|---|
| 已安装 WorkBuddy 桌面端**且已登录** | `/v1/models` 中出现 `workbuddy/*` 模型 |
| 已安装但**未登录** | 没有 `workbuddy/*` 模型，只有 Antigravity 模型 |
| **未安装**桌面端 | 没有 `workbuddy/*` 模型，只有 Antigravity 模型 |

Antigravity 模型在任何情况下都能用。WorkBuddy 属于纯增量。

### 代理去哪里找会话

| 系统 | 认证文件位置 |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/` |
| Linux | `~/.local/share/CodeBuddyExtension/Data/Public/auth/` |

如果安装位置不同，用环境变量 `WORKBUDDY_AUTH_DIR` 覆盖。

### 验证是否生效

```bash
curl http://localhost:8080/health
```

查看 `workbuddy` 那一段，`"accounts"` 应大于等于 1：

```json
"providers": {
  "antigravity": { "status": "ok", "accounts": 2, "available": 2 },
  "workbuddy":   { "status": "ok", "accounts": 1, "available": 1 }
}
```

如果 `workbuddy` 显示 `"accounts": 0`，说明桌面端没登录 —— 打开 WorkBuddy 桌面端登录，
然后用 `npm run acc restart` 重启代理。

---

## 快速开始

### 1. 启动代理服务器

```bash
npm run acc start         # 后台运行，关闭终端后依然存活
```

| 命令 | 说明 |
|---|---|
| `npm run acc start` | 后台启动代理 |
| `npm run acc start -- --log` | 前台运行并显示日志 |
| `npm run acc stop` | 关闭代理 |
| `npm run acc restart` | 重启代理 |
| `npm run acc status` | 查看健康状态与 PID |
| `npm run acc ui` | 打开网页控制台 |

默认端口 `8080`。想换端口：

```bash
PORT=3001 npm run acc start
```

### 2. 绑定账号

**Antigravity** —— 选择以下任一方式授权：

**方式 A：网页控制台（推荐）**

代理启动后，浏览器打开 `http://localhost:8080`，进入 **Accounts** 标签页，点击 **Add Account**，
在弹出的窗口中完成 Google OAuth 授权。

> 无头 / 远程服务器：如果服务器没有浏览器，网页控制台支持「手动授权」模式。点击 Add Account 后，
> 复制 OAuth 链接，在本地机器完成授权，再把授权码粘贴回来。

**方式 B：命令行**

```bash
# 桌面环境（会打开浏览器）
npm run accounts:add

# 无头环境（Docker / SSH）
npm run accounts:add -- --no-browser
```

**方式 C：自动（Antigravity 用户）**

如果你已安装并登录 Antigravity 应用，代理会自动检测到本机会话，无需额外配置。

**WorkBuddy** —— 不需要在代理这边做任何操作。只要 WorkBuddy 桌面端已登录，代理会自动读取。
详见 [WorkBuddy 账号要求](#workbuddy-账号要求)。

### 3. 验证是否正常

```bash
# 健康检查
curl http://localhost:8080/health

# 查看账号状态与配额
curl "http://localhost:8080/account-limits?format=table"

# 查看当前可用的模型列表
curl http://localhost:8080/v1/models
```

---

## 配合 Claude Code CLI 使用

### 配置 Claude Code

有两种方式：

**通过网页控制台（推荐）**

1. 打开 `http://localhost:8080`
2. 进入 **Settings → Claude CLI**
3. 用「连接模式」开关在两种模式间切换：
   - **代理模式**：使用本地代理服务器（Antigravity Cloud Code）。在此配置模型、Base URL 和预设。
   - **付费模式**：直连官方 Anthropic 额度（需要你自己的订阅）。此模式会隐藏代理设置，避免误配置。
4. 点击 **Apply to Claude CLI** 保存

> **配置优先级提示：** 系统环境变量（如在 `.zshrc` 中设置的）优先级**高于** `settings.json`。
> 如果你用网页控制台管理设置，请确认没有在终端里手动导出冲突的变量。

**手动配置**

编辑 Claude Code 配置文件：

| 系统 | 路径 |
|---|---|
| macOS | `~/.claude/settings.json` |
| Linux | `~/.claude/settings.json` |
| Windows | `%USERPROFILE%\.claude\settings.json` |

使用 Claude 模型：

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

使用 Gemini 模型：

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

#### 使用 WorkBuddy 模型（DeepSeek、GLM、Kimi）

WorkBuddy 模型带 `workbuddy/` 前缀。配置前请确认代理已经拿到 WorkBuddy 凭据 ——
代理会自动从本地已登录的 WorkBuddy / CodeBuddy 扩展读取，**不需要针对代理单独登录**。

| 系统 | 认证文件位置 |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/` |
| Linux | `~/.local/share/CodeBuddyExtension/Data/Public/auth/` |

如果安装位置不同，用环境变量 `WORKBUDDY_AUTH_DIR` 覆盖。

> **请先通过 WorkBuddy 桌面端登录。** 代理只读取认证文件 —— 它无法替你创建会话。

确认模型已被发现：

```bash
curl http://localhost:8080/v1/models
```

然后配置 `%USERPROFILE%\.claude\settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080",
    "ANTHROPIC_AUTH_TOKEN": "test",

    "ANTHROPIC_MODEL": "workbuddy/deepseek-v4-pro",

    "ANTHROPIC_DEFAULT_OPUS_MODEL": "workbuddy/deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "workbuddy/deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "workbuddy/deepseek-v4.1-flash",

    "CLAUDE_CODE_SUBAGENT_MODEL": "workbuddy/deepseek-v4-pro"
  }
}
```

或在 PowerShell 会话中直接设置：

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
$env:ANTHROPIC_AUTH_TOKEN="test"
$env:ANTHROPIC_MODEL="workbuddy/deepseek-v4-pro"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="workbuddy/deepseek-v4-pro"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="workbuddy/deepseek-v4-pro"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="workbuddy/deepseek-v4.1-flash"
$env:CLAUDE_CODE_SUBAGENT_MODEL="workbuddy/deepseek-v4-pro"

claude
```

**模型 ID 是从 WorkBuddy API 实时获取的，不是写死的。** 上面只是可直接使用的示例；
运行 `curl http://localhost:8080/v1/models` 查看你的账号实际可用的模型。
可用 ID 取决于你的 WorkBuddy 套餐。

### 加载环境变量

把代理设置写进 shell 配置文件：

**macOS / Linux：**

```bash
echo 'export ANTHROPIC_BASE_URL="http://localhost:8080"' >> ~/.zshrc
echo 'export ANTHROPIC_AUTH_TOKEN="test"' >> ~/.zshrc
source ~/.zshrc
```

Bash 用户把 `~/.zshrc` 换成 `~/.bashrc`。

**Windows（PowerShell）：**

```powershell
Add-Content $PROFILE "`n`$env:ANTHROPIC_BASE_URL = 'http://localhost:8080'"
Add-Content $PROFILE "`$env:ANTHROPIC_AUTH_TOKEN = 'test'"
. $PROFILE
```

**Windows（命令提示符）：**

```cmd
setx ANTHROPIC_BASE_URL "http://localhost:8080"
setx ANTHROPIC_AUTH_TOKEN "test"
```

重启终端使配置生效。

### 运行 Claude Code

```bash
# 确认代理已启动
npm run acc start

# 在另一个终端运行 Claude Code
claude
```

> **提示：** 如果 Claude Code 要求你选择登录方式，在 `~/.claude.json`（macOS/Linux）或
> `%USERPROFILE%\.claude.json`（Windows）中加入 `"hasCompletedOnboarding": true`，
> 然后重启终端重试。

---

## 代理模式 vs 付费模式

在 **Settings → Claude CLI** 中切换：

| 特性 | 🔌 代理模式 | 💳 付费模式 |
|---|---|---|
| 后端 | 本地服务器（Antigravity） | 官方 Anthropic 额度 |
| 费用 | 免费（Google Cloud） | 付费（Anthropic 额度） |
| 模型 | Claude + Gemini | 仅 Claude |

付费模式会自动清除代理设置，以便你直接使用官方 Anthropic 账号。

## 多开 Claude Code 实例（可选）

想同时运行官方 Claude Code 和本代理版本，可以添加别名：

**macOS / Linux：**

```bash
# 加入 ~/.zshrc 或 ~/.bashrc
alias claude-antigravity='CLAUDE_CONFIG_DIR=~/.claude-account-antigravity ANTHROPIC_BASE_URL="http://localhost:8080" ANTHROPIC_AUTH_TOKEN="test" command claude'
```

**Windows（PowerShell）：**

```powershell
# 加入 $PROFILE
function claude-antigravity {
    $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-account-antigravity"
    $env:ANTHROPIC_BASE_URL = "http://localhost:8080"
    $env:ANTHROPIC_AUTH_TOKEN = "test"
    claude
}
```

之后用 `claude` 走官方 API，用 `claude-antigravity` 走本代理。

## 以系统服务运行（systemd）

以 systemd 服务运行时，代理会以另一个用户（如 root）身份运行，因此找不到你的 Claude CLI 配置
`~/.claude/settings.json`。需要设置 `CLAUDE_CONFIG_PATH` 指向真实用户的 `.claude` 目录：

```ini
# /etc/systemd/system/antigravity-proxy.service
[Service]
Environment=CLAUDE_CONFIG_PATH=/home/youruser/.claude
ExecStart=/usr/bin/node /path/to/antigravity-claude-proxy/src/index.js
```

不设置的话，网页控制台的 Claude CLI 标签页将无法读写你的 Claude Code 配置。

---

## 文档

- [可用模型](docs/models.md)
- [多账号负载均衡](docs/load-balancing.md)
- [网页管理控制台](docs/web-console.md)
- [高级配置](docs/configuration.md)
- [macOS 菜单栏应用](docs/menubar-app.md)
- [OpenClaw / ClawdBot 集成](docs/openclaw.md)
- [API 端点](docs/api-endpoints.md)
- [测试](docs/testing.md)
- [故障排查](docs/troubleshooting.md)
- [安全、使用与风险提示](docs/safety-notices.md)
- [法律](docs/legal.md)
- [开发](docs/development.md)

## 致谢

本项目基于以下项目的思路与代码：

- [opencode-antigravity-auth](https://github.com/NoeFly/opencode-antigravity-auth) —— OpenCode 的 Antigravity OAuth 插件
- [claude-code-proxy](https://github.com/1rgs/claude-code-proxy) —— 使用 LiteLLM 的 Anthropic API 代理

## 许可证

MIT

## Star 历史

[![Star History Chart](https://star-history.dera.page/svg?repos=Ypc443502/antigravity_and_workbuddy-claude-proxy&type=date&legend=top-left&cache-control=no-cache)](https://star-history.dera.page/#Ypc443502/antigravity_and_workbuddy-claude-proxy&type=date&legend=top-left)
