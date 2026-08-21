# wecode

[![npm](https://img.shields.io/npm/v/%40jiawei666%2Fwecode?logo=npm)](https://www.npmjs.com/package/@jiawei666/wecode)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/jiawei666/wecode)](LICENSE)

在微信里使用本机 Codex。普通消息进入当前 Codex 会话；需要新建、切换或恢复会话时，用自然语言告诉 wecode；长回答自动生成适合手机阅读的临时分享页。

> [!WARNING]
> wecode 会以 `approval_policy=never` 和 `danger-full-access` 驱动本机 Codex。请只在你完全信任的机器和微信账号上运行。

## 特点

- 扫码登录，启动后直接使用，不需要 onboard。
- Codex App Server 保存原生会话历史，wecode 只保存本地绑定和运行状态。
- 手机上管理项目会话：新建、切换、恢复、停止和查看状态。
- 长文案自动转成移动端网页，可选 Cloudflare Quick Tunnel 生成临时链接。

## 架构

```text
微信
 │ iLink
 ▼
wecode（本机桥接层）
 ├─ 普通消息 ───────────────► Codex App Server ─► Codex 原生 threads
 ├─ “帅哥，帮我……” ───────► 会话管理 Agent
 ├─ 状态 / 停止 / 退出 / 帮助 ─► 本地确定性操作
 └─ 长回答
      ├─ 本地临时 Markdown 页面
      └─ cloudflared Quick Tunnel（可选）► trycloudflare.com 临时链接

~/.wecode/config.json   用户配置
~/.wecode/state.json    iLink 凭证、微信绑定和 wecode 运行状态
Codex 数据目录           Codex 原生会话历史
```

## 安装

要求：Node.js 22+，以及已经可以在终端运行的 [Codex CLI](https://developers.openai.com/codex/)。

```bash
npm install -g @jiawei666/wecode
wecode
```

Windows 如果终端中 `codex` 可以运行但 wecode 仍提示找不到 Codex，执行 `where.exe codex`。如果结果是 npm 目录下的 `codex.cmd`，把绝对路径写入 `~/.wecode/config.json`：

```json
{
  "codexCommand": "C:\\Users\\你的用户名\\AppData\\Roaming\\npm\\codex.cmd"
}
```

第一次运行会在终端显示二维码。微信扫码确认后，wecode 会自动保存状态并开始监听；以后仍然只需要执行：

```bash
wecode
```

需要重新扫码时：

```bash
wecode login
```

## 使用

在绑定的微信中发送普通消息即可继续当前 Codex 会话。还没有当前会话时，可以直接说：

```text
帅哥，帮我在 wecode 项目新建一个会话
```

会话管理示例：

```text
帅哥，帮我查找 wecode 项目最近的 5 个会话
靓仔，帮我切换到刚才那个会话
小哥哥，帮我恢复昨天的支付接口会话
```

本地命令：

| 消息 | 作用 |
| --- | --- |
| `状态` | 查看当前目录、任务和队列 |
| `停止` | 中断当前任务并清空队列 |
| `退出` | 退出当前会话管理流程 |
| `帮助` | 查看简短帮助 |

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

Windows 或其他架构：从 [Cloudflare 官方下载页](https://developers.cloudflare.com/tunnel/downloads/) 安装，并确保 `cloudflared` 在系统 `PATH` 中。

### 2. 直接使用

不需要 Cloudflare 账号、域名、Token，也不要执行 `cloudflared tunnel login`。安装完成后重启 `wecode`，然后发送：

```text
写一份完整的项目分析报告，并生成分享页
```

wecode 会在需要时自动启动 Quick Tunnel，生成随机的 `trycloudflare.com` 地址，并返回带随机路径的分享链接。用户不需要填写 `SHARE_PAGE_BASE_URL`。

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

- `codex: command not found`：先确认 Codex CLI 已安装，并且 `codex --version` 可执行。
- 分享页提示未安装 `cloudflared`：执行 `cloudflared --version`；如果命令不在 `PATH`，在配置文件中填写绝对路径。
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

## 许可证

[MIT](LICENSE)
