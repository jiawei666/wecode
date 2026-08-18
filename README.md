# wecode

通过微信 iLink 控制本机 Codex 交互会话的轻量桥接服务。

你可以在微信里登录并绑定本机服务，然后用自然语言让 Codex 处理代码任务、切换项目和恢复历史会话。wecode 不保存 Codex 对话内容，只维护微信用户与 Codex thread 的本地绑定关系。

## 功能

- 通过二维码完成微信 iLink 登录。
- 在微信中创建、切换、查看和中断 Codex 会话。
- 使用控制 Agent 理解自然语言意图，并将任务路由到目标项目。
- 通过 Codex App Server 复用原生 thread；tmux 负责本地 TUI 交互。
- 将长报告渲染为 Markdown 分享页，支持 Cloudflare Quick Tunnel 或自定义反向代理。
- 所有本机目录、用户、模型和服务路径均可通过配置调整。

## 工作原理

```text
微信 iLink
   │  长轮询收发消息
   ▼
wecode 桥接层
   ├── /ctrl 或控制消息 ── Codex 控制 Agent
   ├── 普通消息 ────────── Codex App Server thread
   ├── /new /use /sessions ─ 会话管理
   └── 长报告 ───────────── Markdown 页面 + 可选 Tunnel
                                  │
                                  ▼
                              微信链接
```

Codex 原生 thread 是会话真相。wecode 只保存微信账号到 thread 的当前绑定；退出 tmux 或重启服务不会删除 Codex 历史，会话可以继续恢复。

## 环境要求

- Node.js 22 或更高版本。
- 已安装并登录的 Codex CLI，且 `codex` 可执行。
- `tmux`，用于本地 TUI 会话。
- Linux/macOS 均可运行；systemd 用户服务仅适用于 Linux。
- `cloudflared` 是可选依赖，仅在需要自动生成公网分享页时使用。

## 快速开始

```bash
git clone <repository-url> wecode
cd wecode
npm install
cp .env.example .env
```

编辑 `.env`，至少确认 Codex 命令和允许接收消息的微信用户配置正确：

```dotenv
WECHATBOT_ALLOWED_USER=你的微信用户ID
CODEX_COMMAND=codex
CODEX_MODEL=你的模型名
```

首次运行登录：

```bash
npm run dev -- login
```

终端会显示二维码 URL 和终端二维码。登录成功后启动服务：

```bash
npm run dev -- run
```

生产模式：

```bash
npm run build
npm start
```

## systemd 用户服务

在项目目录执行安装脚本，脚本会根据当前机器动态生成绝对路径：

```bash
scripts/install-systemd-user.sh
systemctl --user status wecode.service
```

如果希望退出终端后服务仍保持运行，需要为当前用户启用 lingering：

```bash
loginctl enable-linger "$USER"
```

服务模板是 [`deploy/wecode.service`](deploy/wecode.service)，不要直接安装模板文件；请始终使用安装脚本。

## 配置

复制 `.env.example` 为 `.env` 后按本机环境修改。常用配置如下：

| 配置 | 作用 |
| --- | --- |
| `WECHATBOT_DATA_DIR` | 登录凭证和运行状态的本地目录，默认 `.data` |
| `WECHATBOT_ALLOWED_USER` | 允许使用机器的微信用户；建议显式填写 |
| `WECHATBOT_HOME` | 控制 Agent 可扫描的本机 home 目录 |
| `WECHATBOT_SEARCH_ROOTS` | 可选的项目搜索目录，多个目录用逗号分隔 |
| `WECHATBOT_DEFAULT_CWD` | 新会话默认工作目录 |
| `CODEX_COMMAND` | Codex CLI 路径或命令名 |
| `CODEX_MODEL` / `CONTROL_MODEL` | 目标会话和控制 Agent 的模型 |
| `CODEX_APP_ENDPOINT` | 本机 Codex App Server WebSocket 地址 |
| `CLOUDFLARED_COMMAND` | `cloudflared` 路径或命令名 |
| `SHARE_PAGE_BASE_URL` | 自建反向代理的分享页基地址；为空时尝试 Quick Tunnel |

空的 `WECHATBOT_SEARCH_ROOTS` 和 `WECHATBOT_DEFAULT_CWD` 会默认使用当前项目目录。所有真实凭证、用户 ID、个人路径和运行状态都应留在本地 `.env`、`.data/` 或 `runtime/` 中，不要提交到仓库。

## 微信命令

```text
/ctrl [自然语言]     进入或继续控制 Agent
/new [目录]          新建会话；支持 --model/-m、--fast、--no-fast
/use [ID]            切换会话；也支持会话列表序号
/sessions            查看最近会话；支持 here/all/full
/stat                查看状态
/stop                中断当前任务
/cancel              退出控制模式或解除绑定
/back                返回上一个绑定会话
/raw [内容]          原样发送到当前 tmux TUI
/help                查看帮助
```

没有当前会话时，普通消息会进入控制 Agent；绑定会话后，普通消息直达 Codex。控制模式中的普通消息继续交给控制 Agent，`/new`、`/use` 和 `/raw` 是显式会话操作。

## 安全注意事项

wecode 会调用 Codex 的 full-access/yolo 能力处理本机任务。请只在你信任的机器上运行，并务必配置 `WECHATBOT_ALLOWED_USER`，不要把服务端口直接暴露到公网。Quick Tunnel 生成的分享链接可能包含报告内容，请按敏感信息等级使用。

仓库默认忽略 `.env`、`.data/`、`runtime/`、`dist/`、`node_modules/` 和本地 `cloudflared` 二进制。发布前仍应检查 `git diff --cached`，确认没有凭证或个人文件。

## 开发与验证

```bash
npm test          # 运行测试
npm run lint      # TypeScript 类型检查
npm run build     # 构建 dist/
```

## 项目结构

```text
src/                    核心桥接、iLink、Codex 和渲染逻辑
bin/tmux-codex          tmux + Codex TUI 启动包装器
deploy/wecode.service   systemd 用户服务模板
scripts/                安装和运维脚本
schemas/                控制 Agent 返回的 action schema
test/                   自动化测试
```

## License

本项目采用 MIT License，详见 [`LICENSE`](LICENSE)。
