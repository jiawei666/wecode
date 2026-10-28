# wecode

[![npm](https://img.shields.io/npm/v/%40jiawei666%2Fwecode?logo=npm)](https://www.npmjs.com/package/@jiawei666/wecode)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/jiawei666/wecode)](LICENSE)

在微信里使用本机 Codex。需要新建、切换或查找会话时，呼唤“小微”；接入会话后，普通消息直接进入当前 Codex；长回答自动生成适合手机阅读的临时分享页。

> [!WARNING]
> wecode 会以 `approval_policy=never` 和 `danger-full-access` 驱动本机 Codex。请只在你完全信任的机器和微信账号上运行。

## 特点

- Codex App Server 保存原生会话历史，wecode 只保存本地绑定和运行状态。
- 通过“小微”管理项目会话：列出最近 5 个、按项目查找或新建、回复序号切换。
- 微信图片会作为图片输入交给当前 Codex 会话；微信文件会下载到本机，并把本地路径交给 Codex 读取。
- 长任务期间显示微信原生“正在输入”状态，不再额外发送“已发送，执行中……”占位消息。
- 长文案自动转成移动端网页，可选 Cloudflare Quick Tunnel 生成临时链接。

## 架构

```text
微信
 │ iLink
 ▼
wecode（本机桥接层，登录后自动后台运行）
 ├─ 普通消息（有会话） ─────► Codex App Server ─► Codex 原生 threads
 ├─ 图片/文件（有会话） ────► 下载并解密 ───────► 当前 Codex 会话
 ├─ 普通消息（无会话） ─────► 自动进入小微并列出最近 5 个会话
 ├─ “小微，帮我……” ───────► 中断当前 Codex 任务并进入小微
 ├─ “小微，进入本机维护模式……” ► 小微直接执行本机维护
 ├─ status / login / restart / stop / logs ─► 后台进程管理
 ├─ 状态 / 停止 / 退出 ─► 本地确定性操作
 └─ 长回答
      ├─ 本地临时 Markdown 页面
      └─ cloudflared Quick Tunnel（可选）► trycloudflare.com 临时链接

~/.wecode/config.json   用户配置
~/.wecode/state.json    iLink 凭证、微信绑定和 wecode 运行状态
~/.wecode/wecode.pid    后台进程 PID
~/.wecode/wecode.log    后台进程日志
Codex 数据目录           Codex 原生会话历史
```

## 安装

要求：Node.js 22+，以及已经可以在终端运行的 [Codex CLI](https://developers.openai.com/codex/)。

Windows 源码安装可直接执行下面的一键脚本；它会幂等检查/安装 Node.js、Codex CLI、cloudflared，构建项目并注册 `wecode` 命令，不使用 WSL2：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows.ps1
```

只检查环境、不安装任何内容：

```powershell
.\scripts\install-windows.ps1 -CheckOnly
```

```bash
npm install -g @jiawei666/wecode
wecode
```

如果本机 npm 配置了其他 registry，请显式使用 npm 公共 registry：

```bash
npm install -g @jiawei666/wecode --registry=https://registry.npmjs.org/
```

Windows 如果终端中 `codex` 可以运行但 wecode 仍提示找不到 Codex，执行 `where.exe codex`。如果结果是 npm 目录下的 `codex.cmd`，把绝对路径写入 `~/.wecode/config.json`：

```json
{
  "codexCommand": "C:\\Users\\你的用户名\\AppData\\Roaming\\npm\\codex.cmd"
}
```

从源码安装后如果只执行了 `npm run build`，PowerShell 可能还没有 `wecode` 命令；执行 `npm link`，或重新运行上面的一键脚本即可。

Windows 上执行“确认接管”或“退出”时，wecode 会调用系统 Restart Manager 查询目标 thread 对应的精确锁文件。退出最后一个 wecode 绑定时会回收 wecode 自己的 App Server 连接/子进程；为避免 GPT/Codex Desktop 崩溃，Windows 不会自动强制结束外部持锁客户端。确认接管仍被占用时会自动通过 `thread/fork` 复制已保存历史并绑定新会话。如果必须继续使用原 thread，请先完全退出客户端（包括托盘进程）后重试。wecode 不会删除锁文件，也不会关闭其他无关进程。

首次启动执行 `wecode`，扫码登录。完整命令见下表。

## 命令

### 终端命令

| 命令 | 作用 |
| --- | --- |
| `wecode` | 首次扫码登录；已有登录状态时直接启动后台进程 |
| `wecode login` | 停止旧进程，重新扫码登录并启动后台进程 |
| `wecode restart` | 重启后台进程，复用已有登录状态；未登录时才扫码 |
| `wecode status` | 查看后台进程、登录状态和最近错误 |
| `wecode logs` | 查看后台日志 |
| `wecode stop` | 停止后台进程 |
| `wecode --help` | 查看命令帮助 |

### 微信消息命令

| 消息 | 作用 |
| --- | --- |
| `状态` | 查看当前会话、任务和队列 |
| `停止` | 中断当前任务并清空队列 |
| `退出` | 退出当前会话管理流程；没有管理流程时解除当前 wecode 会话绑定，外部 Desktop 锁需在 Desktop 中释放 |
| `小微` | 中断当前 Codex 任务，直接列出全局最近 5 个会话；回复序号即可切换到对应历史会话 |
| `小微，帮我查找……` | 按自然语言指定项目并查找该项目的历史会话 |
| `小微，帮我新建……` | 按自然语言指定项目并新建会话 |
| `小微，进入本机维护模式……` | 在当前管理会话中直接使用终端、文件和进程权限维护本机 wecode；完成后仍复用同一管理会话 |

## 使用

扫码登录后，wecode 有两种工作模式。

iLink 不允许在用户首次发消息前主动创建会话，因此扫码绑定后需要你先在微信发送任意一条消息。wecode 收到后会先发送一次欢迎语，并且不会把这条激活消息转发给 Codex；之后不再重复：

```text
👋 欢迎使用 wecode

小微是你的会话管理助手。想继续已有会话，或在不同项目中新建会话，都可以先呼唤「小微」。

成功接入会话后，直接发送消息就能和 Codex 对话；之后需要切换或新建会话时，再呼唤「小微」即可。

你可以这样说：
• 「小微」：查看最近 5 个会话，回复序号直接切换
• 「小微，在 wecode 项目新建会话」
• 「小微，查找 Rambo 最近的会话」
• 「小微，进入本机维护模式」

常用命令：状态｜停止｜退出
语音输入说成“小薇”“小威”等也能识别。
```

### 普通会话模式

有当前会话时，直接发送普通消息，消息会交给当前 Codex 会话。也可以把图片或文件发到微信：图片会作为图片输入，文件会保存在本机（默认目录为 `~/.wecode/incoming-media`）并把本地路径交给 Codex 读取；可以附带文字说明。每个附件最多 25 MiB，每条微信消息最多 5 个图片/文件、合计 50 MiB；处理附件时会清理修改时间超过 30 天的旧附件。当前没有绑定 Codex 会话时，请先新建或切换会话，再重新发送附件。

### 会话管理模式

用于查找和新建会话。交互只保留一层列表，不先选项目、再选会话：

- 没有当前会话：发送普通消息会进入会话管理模式，并继续处理这条消息。
- 已有当前会话：发送“小微”进入管理模式；如果当前有 Codex 任务正在回复，会先中断该任务并清空排队消息。
- 裸唤醒后直接列出全局最近 5 个会话，再按项目分组；列表只有一层，回复序号即可切换。
- wecode 启动时会从 Codex App Server 历史会话的 `cwd` 建立项目索引；每次唤醒、自然语言查找和新建会话后都会刷新。
- 指定项目时优先从历史项目索引匹配 `cwd`，索引没有匹配才检查配置的项目搜索根目录。
- 语音转文字兼容“小薇、小威、小唯、小伟、小巍、晓微”等常见同音写法。
- 小微只负责解释意图、按项目查找会话、按项目新建会话和本机维护；不再直接切换会话或维护备注。

```text
小微，帮我在 wecode 项目新建一个会话
```

会话管理示例：

```text
小微，帮我查找 wecode 项目最近的 5 个会话
小威，帮我在 Rambo 项目新建一个会话
```

如果远程控制导致本机服务不可用，可以直接发送：

```text
小微，进入本机维护模式。请检查 wecode 当前版本，重新打包并重启服务，验证日志和进程。
```

维护模式已经使用 wecode 为小微配置的本机终端权限。它不会因为进入维护模式主动重建小微；仅在会话确实丢失且无法恢复时才按系统错误处理。`wecode status` 会显示 wecode 与 Codex CLI 版本；更新 Codex CLI 后，wecode 在下一次 App Server 操作前会检测可执行文件版本/路径/文件指纹，发现变化会自动回收并启动新的受管 App Server。更新 wecode 自身后需要重启后台进程，`wecode` 启动入口会检测已记录的后台版本，或直接执行 `wecode restart`。如果本机 Codex 提示由 wecode 使用过的会话仍被占用，先执行 `wecode restart`；新版会在释放最后一个绑定时回收本实例启动的 App Server，并在停止 wecode 时结束同一进程组里的 App Server。退出绑定时也会主动停止原生仍在运行的 turn。

Codex 的用户可见 commentary/preamble（例如“我先查看两张截图……”）会合并后发送到微信，不添加“思路摘要”或“处理提示”前缀；内部 reasoning summary 不转发，任务完成后的最终回复会单独发送。需要调整 Codex 生成的摘要级别时，可在 `~/.wecode/config.json` 设置 `codexReasoningSummary`，可选值为 `auto`、`concise`、`detailed`、`none`。

项目有重名时，小微会要求更具体的项目名或路径，不会在多个目录之间猜。新建或切换完成后，后续普通消息会回到当前 Codex 会话。`状态`、`停止`、`退出` 可以直接使用。

## 长文案与 Cloudflare 临时链接

这是可选能力。没有 `cloudflared` 时，扫码、聊天和 Codex 会话仍然可以正常使用。

### 1. 安装 cloudflared

macOS：

```bash
brew install cloudflared
cloudflared --version
```

Ubuntu / Debian：

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update
sudo apt-get install cloudflared
```

Windows：PowerShell 推荐执行：

```powershell
winget install --id Cloudflare.cloudflared --source winget
cloudflared --version
wecode restart
```

或从 [Cloudflare 官方下载页](https://developers.cloudflare.com/tunnel/downloads/) 安装，并确保 `cloudflared` 在系统 `PATH` 中。其他架构也请使用官方下载安装包。

### 2. 直接使用

不需要 Cloudflare 账号、域名、Token，也不要执行 `cloudflared tunnel login`。安装完成后先确认 `cloudflared --version` 可用；如果运行中的 wecode 找不到它，执行 `wecode restart`，然后发送：

```text
写一份完整的项目分析报告，并生成分享页
```

wecode 会在需要时自动启动 Quick Tunnel，生成随机的 `trycloudflare.com` 地址，并返回带随机路径的分享链接。分享页支持分析、计划、变更摘要和普通长文，不限定为分析报告；标题会根据内容动态生成，页头显示项目名，页脚显示 `Powered by wecode`。用户不需要填写 `SHARE_PAGE_BASE_URL`。

Quick Tunnel 适合临时阅读和开发测试，不是正式网站服务。链接相当于访问凭证，拿到链接的人都可以访问页面；不要分享敏感内容。Cloudflare 的 Quick Tunnel 还有并发和协议限制，详见[官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。

## 配置

普通用户不需要手动创建配置。首次运行会自动生成：

```text
~/.wecode/config.json
```

默认内容类似：

```json
{
  "version": 1,
  "defaultCwd": "/你的项目目录"
}
```

需要修改时直接编辑这个文件，例如：

```json
{
  "version": 1,
  "defaultCwd": "/Users/me/projects/demo",
  "searchRoots": ["/Users/me/projects"],
  "allowedUser": "微信用户 ID"
}
```

`cloudflared` 已在 `PATH` 中时，不需要任何配置。只有安装在自定义路径时，才需要增加高级项：

```json
{
  "cloudflaredCommand": "/绝对路径/cloudflared"
}
```

`codexEndpoint`、`sharePageBaseUrl`、超时和协议地址都不是普通用户配置项，保持默认即可。

wecode 默认请求 Codex 生成 `detailed` reasoning summary；其中用户可见的 commentary/preamble 会发送到微信，内部 reasoning summary 不发送，也不额外添加“思路摘要”前缀；任务完成后再发送最终回复。需要调整时可在 `~/.wecode/config.json` 设置 `codexReasoningSummary`，可选值为 `auto`、`concise`、`detailed`、`none`。

## 故障排查

- `wecode` 无法识别：源码目录执行 `npm link`；如果刚安装了 Node.js 或 cloudflared，重新打开 PowerShell，再执行 `wecode restart`。
- `codex: command not found`：先确认 Codex CLI 已安装，并且 `codex --version` 可执行。
- 不需要 `/sessions`、`/use`：发送“小微”后会直接列出最近 5 个会话，再回复序号即可切换。
- `node:events ... Unhandled 'error' event`：通常是子进程命令不存在；重新运行 Windows 一键安装脚本，确认 `codex --version` 和 `cloudflared --version` 后再执行 `wecode restart`。
- 后台启动后没有响应：执行 `wecode status` 和 `wecode logs` 查看进程与错误日志。
- 微信发送日志出现 `prepare failed`：通常是长任务结束时使用的 `context_token` 已过期，不等同于发送频率过高；wecode 会保留未送达的最终结果，收到下一条消息刷新 token 后优先发送。
- 刚扫码绑定后没有收到欢迎语：这是 iLink 的首次会话限制；先在微信发送任意一条消息，wecode 会立即发送欢迎语。不要用无 `context_token` 的主动发送请求，服务端可能返回成功但实际静默丢弃。
- 分享页提示未安装 `cloudflared`：执行 `cloudflared --version`；如果命令不在 `PATH`，在配置文件中填写绝对路径。
- `reasoning_effort must not be empty`：wecode 不会向 Codex 发送空的 `model_reasoning_effort`；如果仍出现，执行 `wecode restart` 后查看最新日志。
- `timeout waiting for child process to exit`：这是 Codex App Server 刷新模型列表的外部警告；不影响已能使用的会话，先执行 `wecode restart`，持续出现时升级 Codex CLI。
- 本机 Codex 提示会话被 wecode 占用：先在微信发送 `退出`释放当前绑定；如果需要停止后台 wecode，执行 `wecode stop`，再在本机执行 `codex resume`。如果仍被占用，执行 `wecode logs` 查看是否有 `stale App Server` 或 `thread-store conflict`。
- `已在另一个应用中打开` 或接管失败：确认接管会尝试结束持有 thread 锁的外部进程；如果仍失败，完全退出 Desktop（包括托盘）后重试。
- 二维码过期：重新执行 `wecode login`。
- 发现 `~/.cloudflared/config.yaml` 后 Quick Tunnel 无法启动：按照 [Cloudflare 说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) 暂时移开该配置文件。

## 开发

```bash
git clone https://github.com/jiawei666/wecode.git
cd wecode
npm ci
npm test
npm run lint
npm run build
npm run pack:check
```

维护者发布版本时，遵循项目内的[版本发布 skill](.codex/skills/github-npm-release/SKILL.md)，确保 `package.json`、`package-lock.json`、Git tag、GitHub Release 和 npm 版本保持一致。

## 许可证

[MIT](LICENSE)
