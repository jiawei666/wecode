# wecode

[![npm](https://img.shields.io/npm/v/%40jiawei666%2Fwecode?logo=npm)](https://www.npmjs.com/package/@jiawei666/wecode)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/jiawei666/wecode)](LICENSE)

在微信里使用本机 Codex。普通消息进入当前 Codex 会话；需要新建、切换或恢复会话时，用自然语言告诉 wecode；长回答自动生成适合手机阅读的临时分享页。

> [!WARNING]
> wecode 会以 `approval_policy=never` 和 `danger-full-access` 驱动本机 Codex。请只在你完全信任的机器和微信账号上运行。

## 特点

- Codex App Server 保存原生会话历史，wecode 只保存本地绑定和运行状态。
- 手机上管理项目会话：新建、切换、恢复、停止和查看状态。
- 长文案自动转成移动端网页，可选 Cloudflare Quick Tunnel 生成临时链接。

## 架构

```text
微信
 │ iLink
 ▼
wecode（本机桥接层，登录后自动后台运行）
 ├─ 普通消息（有会话） ─────► Codex App Server ─► Codex 原生 threads
 ├─ 普通消息（无会话） ─────► 自动进入会话管理 Agent
 ├─ “帅哥，帮我……” ───────► 已有会话时进入会话管理 Agent
 ├─ “帅哥，进入本机维护模式……” ► 会话管理 Agent 直接执行本机维护
 ├─ status / login / restart / stop / logs ─► 后台进程管理
 ├─ 状态 / 停止 / 退出 / 帮助 ─► 本地确定性操作
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
| `分叉` / `复制会话` | 从当前会话复制已保存历史并新建对话 |
| `退出` | 退出当前会话管理流程；没有管理流程时解除当前 wecode 会话绑定，外部 Desktop 锁需在 Desktop 中释放 |
| `帮助` | 查看会话管理帮助 |
| `帅哥，帮我……` | 已有会话时进入会话管理模式 |
| `帅哥，进入本机维护模式……` | 在当前管理会话中直接使用终端、文件和进程权限维护本机 wecode；完成后仍复用同一管理会话 |

## 使用

扫码登录后，wecode 有两种工作模式。

首次收到消息时会发送一次欢迎语，之后不再重复。

### 普通会话模式

有当前会话时，直接发送普通消息，消息会交给当前 Codex 会话。

### 会话管理模式

用于查找、新建、切换、恢复和退出会话：

- 没有当前会话：发送普通消息会进入会话管理模式，并继续处理这条消息。
- 已有当前会话：使用唤醒词进入管理模式，例如：
- `分叉` / `复制会话` 是桥接层提供的固定快捷命令，直接复制当前会话；需要从历史列表中选择目标时，使用自然语言交给会话管理 Agent。
- 会话管理 Agent 会先判断是否需要历史 catalog；只有明确查找、列出、切换、恢复或选择历史会话时，系统才读取 catalog。

```text
帅哥，帮我在 wecode 项目新建一个会话
```

会话管理示例：

```text
帅哥，帮我查找 wecode 项目最近的 5 个会话
靓仔，帮我切换到刚才那个会话
小哥哥，帮我恢复昨天的支付接口会话
分叉
```

如果远程控制导致本机服务不可用，可以直接发送：

```text
帅哥，进入本机维护模式。请检查 wecode 当前版本，重新打包并重启服务，验证日志和进程。
```

维护模式已经使用 wecode 为控制 Agent 配置的本机终端权限。它不会因为进入维护模式主动重建会话管理 Agent；仅在会话确实丢失且无法恢复时才按系统错误处理。`wecode status` 会显示 wecode 与 Codex CLI 版本；更新 Codex CLI 后，wecode 在下一次 App Server 操作前会检测可执行文件版本/路径/文件指纹，发现变化会自动回收并启动新的受管 App Server。更新 wecode 自身后需要重启后台进程，`wecode` 启动入口会检测已记录的后台版本，或直接执行 `wecode restart`。

Codex 的 reasoning summary 和 preamble 会以合并后的“思路摘要/处理提示”发送；这是模型提供给用户的安全摘要，不是隐藏的完整思维链，也不会转发工具调用原文。

发送“分叉”或“复制会话”会通过 Codex App Server 复制当前会话的已保存历史，创建并绑定一个新会话；原会话不会被关闭。Windows Codex Desktop 占用会话时，确认接管失败也会自动使用这个方式，不会强制结束 Desktop。正在生成中的未完成回复不会复制。
新建或切换完成后，后续普通消息会回到当前 Codex 会话。`状态`、`停止`、`退出`、`帮助` 可以直接使用。

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

## 故障排查

- `wecode` 无法识别：源码目录执行 `npm link`；如果刚安装了 Node.js 或 cloudflared，重新打开 PowerShell，再执行 `wecode restart`。
- `codex: command not found`：先确认 Codex CLI 已安装，并且 `codex --version` 可执行。
- 不需要 `/sessions`、`/use` 或序号切换：直接发送 `状态`、`停止`、`分叉`、`退出`、`帮助`，会话选择用自然语言描述。
- `node:events ... Unhandled 'error' event`：通常是子进程命令不存在；重新运行 Windows 一键安装脚本，确认 `codex --version` 和 `cloudflared --version` 后再执行 `wecode restart`。
- 后台启动后没有响应：执行 `wecode status` 和 `wecode logs` 查看进程与错误日志。
- 分享页提示未安装 `cloudflared`：执行 `cloudflared --version`；如果命令不在 `PATH`，在配置文件中填写绝对路径。
- `reasoning_effort must not be empty`：wecode 不会向 Codex 发送空的 `model_reasoning_effort`；如果仍出现，执行 `wecode restart` 后查看最新日志。
- `timeout waiting for child process to exit`：这是 Codex App Server 刷新模型列表的外部警告；不影响已能使用的会话，先执行 `wecode restart`，持续出现时升级 Codex CLI。
- `已在另一个应用中打开` 或接管失败：Windows 会保护外部 Codex Desktop，不会强杀持锁进程；完全退出 Desktop（包括托盘）后重试，或发送 `分叉` / `复制会话`。
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
