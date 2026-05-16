# 本地安装指南 (Local Install)

本指南适用于 **从源码构建和使用** OpenWolf，而非通过 npm 安装。

## 前置要求

- Node.js 20+
- pnpm（推荐）或 npm
- OpenCode CLI 1.15+

## 1. 克隆并构建

```bash
git clone https://github.com/cytostack/openwolf.git openwolf-opencode
cd openwolf-opencode
pnpm install
pnpm build
```

构建产物在 `dist/` 目录下：
```
dist/
├── bin/openwolf.js          # CLI 入口
├── plugin/openwolf-plugin.js # OpenCode 插件（核心）
├── daemon/wolf-daemon.js     # Dashboard + Cron 守护进程
├── hooks/                    # 钩子脚本
├── dashboard/                # Web Dashboard (React)
└── src/                      # 编译后的源码模块
```

## 2. 链接到全局

```bash
# 方式 A：npm link（推荐）
npm link

# 方式 B：手动添加 PATH
# 在 ~/.bashrc 或 ~/.zshrc 中添加：
export PATH="$(pwd)/dist/bin:$PATH"
```

验证安装：

```bash
openwolf --version
# 应输出: 1.0.4
```

## 3. 在项目中使用

```bash
cd /path/to/your-project
openwolf init
```

`openwolf init` 会在项目中创建：

| 路径 | 说明 |
|------|------|
| `.wolf/` | OpenWolf 数据目录（anatomy, cerebrum, memory, buglog 等） |
| `.opencode/plugins/openwolf.js` | OpenCode 插件（自动加载） |
| `.opencode/skills/openwolf/SKILL.md` | OpenCode 技能（`/skills` 可见） |
| `AGENTS.md` | 注入 OpenWolf 指令 |
| `opencode.json` | 配置文件（添加 instructions） |

## 4. 验证是否生效

```bash
cd /path/to/your-project
opencode run "list available skills" 2>&1
```

如果看到以下输出，说明 OpenWolf 插件已成功加载：

```
OpenWolf: cerebrum.md has only X entries. Record user preferences...
OpenWolf: buglog.json is empty. If you encounter bugs, log them.
```

在 OpenCode TUI 中使用 `/skills` 搜索 `openwolf` 即可看到并加载 OpenWolf 技能。

## 5. Dashboard UI

```bash
# 启动守护进程 + Web Dashboard
openwolf dashboard

# Dashboard 默认端口: 18791
# 访问: http://localhost:18791
```

Dashboard 功能：
- **Project Overview**: 项目文件地图、token 统计
- **Token Usage**: 会话级和累计 token 追踪
- **Cerebrum Viewer**: 学习记忆管理
- **Bug Log**: 已知 bug 搜索和管理
- **Activity Timeline**: 文件读写日志
- **Cron Status**: 定时任务管理

## 6. 开发工作流

修改源码后重新构建并刷新：

```bash
# 1. 修改源码
vim src/plugin/openwolf-plugin.ts

# 2. 重新构建
pnpm build

# 3. 在目标项目中刷新插件
cd /path/to/your-project
openwolf init    # 会覆盖更新 .opencode/plugins/openwolf.js

# 4. 重启 OpenCode 即可生效
```

## 7. 与 npm 版本的区别

本仓库从 [original openwolf](https://github.com/cytostack/openwolf) 适配而来，核心改动：

| 改动 | 说明 |
|------|------|
| ~~Claude Code hooks~~ → OpenCode plugin | 6 个外部钩子脚本替换为 1 个 OpenCode 插件 (`src/plugin/openwolf-plugin.ts`) |
| ~~`.claude/settings.json`~~ → `opencode.json` | 配置文件适配 |
| ~~`CLAUDE.md`~~ → `AGENTS.md` | 指令文件适配 |
| ~~`claude -p`~~ → `opencode run` | CLI 适配（cron 引擎） |
| 新增 `.opencode/skills/openwolf/SKILL.md` | OpenCode 技能系统集成 |
| 保留 `CLAUDE_PROJECT_DIR` 兼容 | 向后兼容原有环境变量 |

## 8. 常见问题

### `openwolf` 命令找不到

```bash
source ~/.bashrc
# 或确认 npm link 是否成功: npm ls -g --depth=0 | grep openwolf
```

### `/skills` 中找不到 openwolf

- 确保在已运行 `openwolf init` 的项目目录下启动 OpenCode
- 重启 OpenCode TUI
- 检查 `.opencode/skills/openwolf/SKILL.md` 是否存在

### OpenCode 报 "Unexpected server error"

- 不要在 OpenCode 源码仓库内运行 `opencode`（monorepo 冲突）
- 确认已配置 AI provider：运行 `opencode` → TUI 中输入 `/connect` → 选择 DeepSeek 等 → 输入 API key

### Dashboard 无法访问

```bash
# 手动启动守护进程
node dist/src/daemon/wolf-daemon.js

# 或在目标项目中
OPENWOLF_PROJECT_ROOT=/path/to/project node /path/to/openwolf-opencode/dist/src/daemon/wolf-daemon.js
```
