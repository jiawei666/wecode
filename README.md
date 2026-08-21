# wecode

[![License: MIT](https://img.shields.io/github/license/jiawei666/wecode)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

用微信 iLink 控制本机 Codex 的轻量桥接服务。

一句话理解：微信负责消息入口，Codex App Server 负责原生会话。绑定会话后，普通消息直接发给当前 Codex；需要新建、切换或恢复项目时，说任一唤醒语（“帅哥、靓仔、小哥哥、哥哥、大哥、老哥”）进入会话管理 Agent。

> [!WARNING]
> wecode 会以 `approval_policy=never`、`danger-full-access` 运行 Codex，并允许远程消息驱动本机任务。请只在你完全信任的机器上运行，配置微信用户白名单，并把工作目录限制在专用环境内。

## 适合什么场景

- 在手机上查看、启动和继续本机 Codex 任务。
- Codex 执行期间继续发送补充要求，优先即时追加，无法追加时按顺序排队。
- 在终端、IDE 或 Codex 客户端已经打开会话时，通过一次明确确认安全接管。
- 在 Windows、macOS 和 Linux 上使用同一套 App Server 架构。

wecode 不依赖 tmux，也不提供 Raw 原始输入模式。Codex 原生 thread 是会话真相；wecode 只保存微信用户到 thread 的本地绑定，重启服务不会删除 Codex 历史。

## 工作方式

```text
微信 iLink
   │  收发消息
   ▼
wecode
   ├── 状态/停止/退出/帮助 ─── 本地确定性操作
   ├── “帅哥/靓仔，帮我……” ─ 会话管理 Agent
   ├── 已绑定会话的普通消息 ── Codex App Server 当前 thread
   ├── 执行中的补充消息 ────── turn/steer；不可追加时 FIFO 排队
   └── 长报告 ──────────────── 临时 Markdown 分享页
```

消息分类很简单：

| 你发送的内容 | 处理方式 |
| --- | --- |
| 普通文字，且已有当前会话 | 直接发送给当前 Codex |
| 普通文字，但还没有会话 | 提示使用唤醒词，不自动进入会话管理 Agent |
| `状态`、`停止`、`退出`、`帮助` | wecode 系统本地处理，不依赖会话管理 Agent |
| `唤醒语 + 帮我……` | 交给会话管理 Agent 处理会话操作 |

## 五分钟启动

### 1. 安装

```bash
git clone https://github.com/jiawei666/wecode.git
cd wecode
npm ci
```

要求：

- Node.js 22 或更高版本。
- 已安装并登录 Codex CLI，且 `codex` 可以在终端中执行。
- 能够使用微信 iLink 完成二维码登录。

### 2. 创建配置

macOS/Linux：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

大多数情况下 `.env` 不需要填写任何值。长期运行或共享机器，建议至少填写微信白名单：

```dotenv
WECHATBOT_ALLOWED_USER=你的微信用户ID
```

如果要指定新会话目录，再填写：

```dotenv
WECHATBOT_DEFAULT_CWD=你的项目目录
```

首次登录可以暂时留空 `WECHATBOT_ALLOWED_USER`，服务会使用二维码登录得到的用户。模型、Codex 路径、App Server 地址和分享页地址都有默认值，需要定制时再按 [`.env.example`](.env.example) 或下方高级配置覆盖。

### 3. 登录并启动

先登录一次：

```bash
npm run dev -- login
```

按终端提示完成二维码登录。然后启动桥接服务：

```bash
npm run dev -- run
```

验证稳定后可以使用生产启动方式：

```bash
npm run build
npm start
```

### 4. 在微信里发送第一条消息

```text
帅哥，帮我找项目并切换
```

也可以直接说：

```text
靓仔，帮我新建一个会话
帅哥，帮我恢复昨天的会话
```

首次收到消息时，wecode 会发送一条简短提示；提示不会吞掉你发出的第一条命令。

## 手机端操作

手机端只需记住两个入口：唤醒词和四个中文命令。

| 输入 | 作用 | 备注 |
| --- | --- | --- |
| `帅哥，帮我……` / `靓仔，帮我……` | 唤醒会话管理 Agent | 查找、新建、切换、恢复会话 |
| `状态` | 查看当前目录、任务和队列 | 诊断首选 |
| `停止` | 中断当前任务 | 同时清空排队消息 |
| `退出` | 退出会话或会话管理流程 | 历史仍保留 |
| `帮助` | 显示简短帮助 |  |

### 连续对话

Codex 执行时不需要等待上一条完成，可以像终端里继续输入一样发送补充要求：

```text
请先检查登录流程并告诉我风险
先修复发现的测试问题，再运行 npm test
最后给我一个改动总结
```

处理规则：

1. 当前 turn 仍可追加时，通过 Codex App Server 的 `turn/steer` 即时加入当前任务。
2. 如果当前 turn 来自外部客户端、刚好结束或暂时无法取得活动 turn，则进入 FIFO 队列，前一条完成后自动继续。
3. 发送 `状态` 可以查看队列数量；发送 `停止` 或 `退出` 会清空尚未发送的消息。

这不是伪造终端按键：普通消息通过 App Server 追加到 Codex 的任务上下文，不会杀掉或接管外部终端进程；安全接管是另一个需要明确确认的流程。

### 会话管理 Agent

唤醒词任选一个：`帅哥`、`靓仔`、`小哥哥`、`哥哥`、`大哥`、`老哥`。

直接照着下面的句式发送即可：

```text
帅哥，帮我在 wecode 项目新建一个会话
靓仔，帮我查找 wecode 项目最新的 5 个会话
小哥哥，帮我切换到刚才那个会话
哥哥，帮我恢复昨天的支付接口会话
```

唤醒后，后续普通消息仍会交给会话管理 Agent；发送 `退出` 离开。已有当前会话时，普通消息仍直接发送给当前 Codex。

## 本地命令

四个命令由 wecode 系统直接执行；其他会话操作统一通过唤醒词交给会话管理 Agent。

| 命令 | 作用 |
| --- | --- |
| `状态` | 查看状态 |
| `停止` | 中断任务并清空队列 |
| `退出` | 退出会话或会话管理流程 |
| `帮助` | 查看帮助 |

不保留任何斜杠命令，也不保留 Raw 原始输入模式。

## 外部终端安全接管

如果目标 thread 正被 Codex CLI、IDE 或桌面客户端使用，wecode 默认不会触碰它；只有用户明确确认接管后，才会尝试释放精确持有该 thread 锁的外部 Codex 进程。流程是：

1. 先说“帅哥/靓仔，帮我切换或恢复目标会话”。
2. 如果发现目标被占用，wecode 会说明目标目录并要求明确回复 `确认接管`。
3. 确认后，wecode 通过 App Server 读取状态、请求中断活动 turn、等待会话空闲；如果外部客户端仍持锁，只向精确匹配的外部 Codex 进程发送优雅退出信号，必要时发送终止信号，然后重试恢复。
4. 如果进程拒绝退出或平台无法识别锁持有者，流程安全失败；wecode 不删除锁文件，也不触碰其他进程。

因此三种平台的状态判断逻辑一致；macOS/Linux 可在明确确认后按精确锁持有者请求释放，Windows 无法安全枚举锁持有者时会安全失败并提示手动退出。

## Windows、macOS 与 Linux

主流程只依赖 Node.js、Codex CLI 和 Codex App Server，三种平台使用同一套命令：

```text
安装 Node.js/Codex → npm ci → 配置 .env → login → run
```

如果已有独立运行的 App Server，可以在 `.env` 中填写：

```dotenv
CODEX_APP_ENDPOINT=ws://127.0.0.1:45037
```

wecode 会优先连接这个端点；端点不可用时，会按 `CODEX_COMMAND` 启动自己的 `codex app-server`。wecode 只关闭自己启动的 App Server；外部客户端只有在用户明确确认接管、且其持有目标 thread 锁时才会被请求退出。

进程托管建议：

| 平台 | 推荐方式 |
| --- | --- |
| Windows | PowerShell 任务计划程序或其他服务管理器 |
| macOS | `launchd` |
| Linux | systemd 用户服务 |

Linux 可使用仓库提供的安装脚本：

```bash
npm run build
scripts/install-systemd-user.sh
systemctl --user status wecode.service
```

macOS/Windows 直接托管 `npm start` 即可，不需要 tmux 或 Unix shell。

## 配置参考

复制 [`.env.example`](.env.example) 后按需修改。配置分两层：

### 常用配置

| 配置 | 作用 |
| --- | --- |
| `WECHATBOT_ALLOWED_USER` | 允许使用机器的微信用户，建议显式填写 |
| `WECHATBOT_DEFAULT_CWD` | 新会话默认工作目录 |
| `WECHATBOT_SEARCH_ROOTS` | 可选的项目搜索目录，多个目录用逗号分隔 |

### 高级配置

以下变量都有稳定默认值，通常不需要修改：

| 配置 | 作用 |
| --- | --- |
| `WECHATBOT_DATA_DIR` | 登录凭证和本地运行状态目录，默认 `.data` |
| `WECHATBOT_HOME` | 会话管理 Agent 可扫描的本机 home 目录 |
| `CODEX_COMMAND` | Codex CLI 路径或命令名 |
| `CODEX_MODEL` / `CONTROL_MODEL` | 目标会话 / 会话管理 Agent 模型 |
| `CODEX_REASONING_EFFORT` / `CONTROL_REASONING_EFFORT` | 两类 Agent 的推理强度 |
| `CODEX_FAST` | 是否为目标会话启用 fast service tier |
| `CODEX_APP_ENDPOINT` | Codex App Server WebSocket 地址 |
| `CLOUDFLARED_COMMAND` | `cloudflared` 路径或命令名 |
| `SHARE_PAGE_BASE_URL` | 自建反向代理的分享页基地址 |
| `WECHATBOT_PAGE_TTL_MS` | 分享页保留时长 |
| `WECHATBOT_IDLE_TIMEOUT_MS` / `WECHATBOT_CONTROL_TIMEOUT_MS` | 会话和会话管理流程超时 |
| `WECHATBOT_BINDING_HISTORY_LIMIT` | 本地会话历史数量 |
| `WECHATBOT_CHAT_CHUNK_SIZE` / `WECHATBOT_POLL_TIMEOUT_MS` | 微信分片和轮询参数 |
| `ILINK_API_BASE` / `ILINK_CDN_BASE` / `ILINK_CHANNEL_VERSION` | iLink 协议覆盖参数 |

未填写的变量使用代码默认值；`WECHATBOT_SEARCH_ROOTS` 和 `WECHATBOT_DEFAULT_CWD` 未填写时使用当前项目目录。真实凭证、用户 ID、个人路径和运行状态应留在 `.env`、`.data/` 或 `runtime/` 中，不要提交到仓库。

## 长报告与分享页

当回复过长，或内容被识别为报告、计划、差异或代码，wecode 可以生成临时 Markdown 分享页：

- 本地页面只监听回环地址。
- 配置 `SHARE_PAGE_BASE_URL` 时使用自建反向代理。
- 未配置时会尝试使用 Cloudflare Quick Tunnel，因此需要本机安装 `cloudflared`。
- 分享链接带随机路径，但不等于访问认证；请把它当作 bearer token，不要分享敏感内容。

## 安全边界

- 只在专用、低权限的本机用户下运行，不要直接连接生产数据或存放云凭证的账号。
- 显式设置 `WECHATBOT_ALLOWED_USER`，并将 `WECHATBOT_SEARCH_ROOTS`、`WECHATBOT_DEFAULT_CWD` 限制到必要的最小目录。
- 不要把服务端口或 App Server 暴露到公网，默认保持在 `127.0.0.1`。
- 不要提交 `.env`、`.data/`、`runtime/`、个人路径或本地二进制。
- 发布前检查：

```bash
git diff --cached
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 微信没有响应 | 确认已执行 `login`，并检查 `WECHATBOT_ALLOWED_USER` 是否填错 |
| 没有当前会话 | 发送“帅哥，帮我找到并切换到项目” |
| App Server 未就绪 | 确认 Codex CLI 已安装/登录；检查 `CODEX_COMMAND` 和 `CODEX_APP_ENDPOINT` |
| 目标会话被占用 | 只在确认目标正确时回复 `确认接管`；wecode 会尝试释放精确持有目标锁的外部 Codex 客户端，失败时再手动退出该客户端 |
| 补充消息没有立即执行 | 发送 `状态` 查看队列；这是无法取得活动 turn 时的有序兜底 |
| 忘记命令 | 发送 `帮助` |

## 开发与验证

```bash
npm test          # 运行自动化测试
npm run lint      # TypeScript 类型检查
npm run build     # 构建 dist/
```

项目结构：

```text
src/                    核心桥接、iLink、Codex 和渲染逻辑
deploy/wecode.service   systemd 用户服务模板
scripts/                安装和运维脚本
schemas/                会话管理 Agent action schema
test/                   自动化测试
```

## 相关文档

- [Codex App Server 文档](https://developers.openai.com/codex/app-server/)
- [示例配置](.env.example)
- [项目总结](PROJECT_SUMMARY.md)
- [移动端命令体验研究](docs/mobile-command-ux-research.md)

## 贡献与许可证

欢迎提交 Issue 和 Pull Request。提交前请运行 `npm test`、`npm run lint` 和 `npm run build`，并确认示例配置不包含真实凭证或个人路径。

本项目采用 MIT License，详见 [`LICENSE`](LICENSE)。
