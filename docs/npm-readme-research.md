# npm CLI README 与 Cloudflare Quick Tunnel 资料研究

> 研究目标：为 wecode 设计一份面向 npm CLI 用户的简洁 README，并核对 Cloudflare Quick Tunnel 的安装方式、使用方式和限制。
>
> 资料范围：项目官方仓库 README、项目官方安装文档、Cloudflare 官方文档。外部事实均附官方链接；“给 wecode 的建议”属于基于这些资料的设计判断。

## 结论摘要

README 的首屏应当只回答四件事：这是什么、为什么值得用、如何安装、启动后下一步做什么。OpenClaw、n8n 和 code-server 都把项目定位与最短启动路径放在前面；Homebridge 则把多平台安装拆成入口链接，把细节下沉到平台文档。[OpenClaw README](https://github.com/openclaw/openclaw/blob/main/README.md)、[n8n README](https://github.com/n8n-io/n8n/blob/master/README.md)、[code-server README](https://github.com/coder/code-server)、[Homebridge README](https://github.com/homebridge/homebridge/blob/latest/README.md)

对 wecode，建议 README 采用以下主线：

1. 一句话定位：在微信里使用本机 Codex，并把长回答自动变成可分享网页。
2. 一张小架构图：微信 → wecode → 本机 Codex App Server；长回答 → 本地页面 → 可选 Cloudflare Quick Tunnel。
3. 三步 Quick Start：安装 npm 包、运行 `wecode`、扫码登录。
4. 单独突出“长文案分享”：安装 `cloudflared` 后，wecode 在需要时自动创建临时公网链接。
5. 只保留极少量配置和必要的安全/限制说明；完整配置、服务管理、开发指南放到独立文档。

不要照搬 OpenClaw 的 onboarding、Daemon 和多渠道配置流程：它适合功能更多的网关产品，而 wecode 的差异化体验应是“安装后直接运行、扫码即可用”。OpenClaw 官方 README 明确把 onboarding 作为其推荐路径；这说明该路径适合 OpenClaw，但不代表适合所有 CLI。[OpenClaw README 的 Install/Quick start](https://github.com/openclaw/openclaw/blob/main/README.md#install)

## 官方项目 README 样本

### 1. OpenClaw

官方 README 的结构是：项目定位 → 安装 → Quick start → 架构说明 → 安全 → 文档导航。它同时提供安装脚本和 npm 安装方式，并明确给出安装后的命令；“How it fits together”用 Gateway、Control UI、Channels 等概念解释组件边界。[OpenClaw README](https://github.com/openclaw/openclaw/blob/main/README.md)

可借鉴写法：

- 首屏先讲产品是什么，再给安装命令；
- 用一个很短的架构章节解释核心组件；
- 把安全提醒放在 README，而不是完全藏到文档站；
- 用“Goal → Start here”的表格承接详细文档。[OpenClaw README 的 Documentation 表格](https://github.com/openclaw/openclaw/blob/main/README.md#documentation)

不建议直接复制的部分：OpenClaw 的安装后流程包含 `openclaw onboard --install-daemon`、Gateway 状态检查和 Dashboard，这与 wecode 的扫码即用目标不同。[OpenClaw README 的 Quick start](https://github.com/openclaw/openclaw/blob/main/README.md#quick-start)

### 2. Homebridge

Homebridge README 先用一句话说明它是可运行在家庭网络中的 Node.js 服务，然后将 Installation 按 Raspberry Pi、Linux、macOS、Windows、Docker 等平台分组，每个平台只提供官方安装文档入口；配对和常见问题也作为单独章节出现。[Homebridge README](https://github.com/homebridge/homebridge/blob/latest/README.md)

可借鉴写法：

- 平台差异较大时，README 只保留平台选择，不塞入所有命令；
- 需要长期运行的 CLI/服务，应在合适位置说明服务化或启动方式；
- QR 码、配对、常见问题这类用户任务应单独成节，而不是混在配置表里。[Homebridge README 的 Installation 与 Adding Homebridge to iOS](https://github.com/homebridge/homebridge/blob/latest/README.md#installation)

### 3. n8n

n8n README 的 Quick Start 非常短：先给出 `npx n8n`，再给 Docker 方案，然后告诉用户本地访问地址；README 后面只保留资源、支持、许可证和贡献入口。[n8n README](https://github.com/n8n-io/n8n/blob/master/README.md#quick-start)

官方 npm 安装文档另外给出了全局安装 `npm install n8n -g` 和启动 `n8n` 的方式，同时注明 npm-based installs 从 n8n 3.0 起已标记为 deprecated。因此 n8n 适合作为“Quick Start 很短”的排版样本，但不应把它当前的 npm 部署策略直接当成 wecode 的方案。[n8n npm 安装文档](https://docs.n8n.io/hosting/installation/npm/)

可借鉴写法：

- README 直接展示最短可运行命令；
- 命令后立刻给出用户下一步（例如访问地址）；
- 把资源、支持和完整部署方式放到链接，而不是扩写成教程。

### 4. code-server

code-server README 采用“产品一句话 → Requirements → Getting started → 详细安装/配置”的结构，并提供安装脚本的预览方式；官方安装文档再按 npm、独立发行包、Debian/Ubuntu、macOS、Docker 等路径展开。[code-server README](https://github.com/coder/code-server)、[code-server 安装文档](https://github.com/coder/code-server/blob/main/docs/install.md)

可借鉴写法：

- 如果存在多种安装渠道，README 只推荐一条默认路径，其他路径放在安装文档；
- 给出命令的“预览/检查”方式，有助于用户在执行安装脚本前确认行为；
- 说明安装后产生的配置和数据位置；
- 对 npm 安装可能需要原生编译依赖这一类平台差异，放到专门的 npm 文档，而不是污染首屏。[code-server npm 安装说明](https://github.com/coder/code-server/blob/main/docs/npm.md)

## 建议中的 wecode README 结构

以下结构是从上述官方 README 抽取后的项目化建议，不是对外部项目的逐字复制：

```text
# wecode

一句话价值主张 + npm / license / CI 徽章

## 特点
- 微信扫码登录
- 在微信中使用本机 Codex
- 长回答自动生成网页
- 可选 Cloudflare 临时分享链接

## 架构
一张简图或 Mermaid 图

## 安装
npm install -g wecode

## 使用
wecode
扫码后即可使用

## 长文案分享（特色）
安装 cloudflared
wecode 在需要时自动生成 trycloudflare.com 临时链接

## 配置
只放真正需要用户修改的配置；默认不需要配置

## 注意事项
链接公开可访问；Quick Tunnel 只适合临时分享，不适合生产

## 故障排查
扫码、Codex、cloudflared 三类最常见问题

## 开发 / 许可证 / 贡献
链接到独立文档
```

README 首屏不建议出现以下内容：完整环境变量表、所有内部超时参数、App Server 高级地址、定时任务实现、Cloudflare 固定域名 Tunnel、源码级模块说明。这些信息可以保留在 `docs/`，但不应成为首次使用的门槛。

## Cloudflare Quick Tunnel 官方事实

### 工作方式

Cloudflare 官方将 Quick Tunnel（TryCloudflare）定位为测试和开发用途。运行 `cloudflared` 后，它会生成一个随机的 `trycloudflare.com` 子域名，并将公网请求代理到本机的 localhost 服务；官方示例命令是：

```bash
cloudflared tunnel --url http://localhost:8080
```

[Cloudflare Quick Tunnels 官方文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

这意味着 wecode 的用户体验可以设计为：用户只需安装一次 `cloudflared`，不需要填写分享域名；wecode 在本机启动临时页面后，按实际端口执行 Quick Tunnel，并把生成的 URL 返回给用户。这里“不需要填写分享域名”是根据 Quick Tunnel 使用随机子域名、且不要求把站点加入 Cloudflare DNS 的产品行为得出的设计结论。[Cloudflare Quick Tunnels 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

### 安装方式

Cloudflare 官方下载页说明 `cloudflared` 是连接本地基础设施与 Cloudflare 的轻量 daemon，并提供 Linux 包仓库、直接下载、macOS Homebrew、Windows 安装包和 Docker 等方式。[Cloudflare Downloads](https://developers.cloudflare.com/tunnel/downloads/)

README 可以只保留主流平台的最短命令，并把其他架构链接到官方页面：

macOS：

```bash
brew install cloudflared
cloudflared --version
```

[Cloudflare 官方 macOS 安装说明](https://developers.cloudflare.com/tunnel/downloads/)

Debian/Ubuntu：

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
```

[Cloudflare 官方 Package Repository](https://pkg.cloudflare.com/)

Windows 用户应从 Cloudflare 官方 Downloads 页面选择 32 位或 64 位的 EXE/MSI；官方文档特别说明 Windows 上的 `cloudflared` 不会自动更新，需要手动更新。[Cloudflare Windows 下载说明](https://developers.cloudflare.com/tunnel/downloads/)

README 不应要求用户执行 `cloudflared tunnel login`：该命令用于登录 Cloudflare 账号并管理固定/正式 Tunnel，而 Quick Tunnel 的官方用法是直接执行 `cloudflared tunnel --url ...`。[Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)、[Cloudflare Tunnel 常用命令](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/tunnel-useful-commands/)

### 必须写进 README 的限制

- Quick Tunnel 只适合测试和开发，Cloudflare 不为它保证 SLA 或 uptime；正式生产场景应创建 remotely-managed tunnel。[Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- 当前 Quick Tunnel 的并发代理请求上限是 200 个 in-flight requests，超过后可能返回 HTTP `429`。[Cloudflare Quick Tunnel 限制](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- Quick Tunnel 不支持 Server-Sent Events（SSE）。因此分享页应使用普通 HTTP 请求/静态页面，不应依赖 SSE 推送。[Cloudflare Quick Tunnel 限制](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- 如果用户的 `~/.cloudflared` 目录中存在 `config.yaml`，Quick Tunnel 当前可能无法使用；官方建议必要时临时重命名该文件。[Cloudflare Quick Tunnel 注意事项](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

对 wecode 的直接文案建议：把 Cloudflare 描述成“可选的临时分享能力”，而不是运行前置条件。正常聊天和扫码登录不应要求安装它；只有用户需要把长回答变成公网网页时，才提示安装并检测 `cloudflared`。这是产品设计建议，限制依据见上方 Cloudflare 官方文档。

## 建议最终呈现的用户流程

```text
npm install -g wecode
wecode
  └─ 首次运行：显示二维码 → 用户扫码 → 自动保存本地状态
  └─ 后续运行：直接启动微信桥接

需要长文案时
  └─ wecode 生成本地 Markdown/HTML 页面
  └─ 检测 cloudflared
       ├─ 已安装：自动创建 trycloudflare.com 临时链接并返回
       └─ 未安装：继续发送普通文本，并提示查看 Cloudflare 安装说明
```

这个流程把“主产品能力”和“可选分享能力”分开，既保留 Cloudflare 临时链接这一特色，也不会让没有安装 `cloudflared` 的用户无法启动 wecode。

## 参考资料清单

- [OpenClaw 官方 README](https://github.com/openclaw/openclaw/blob/main/README.md)
- [Homebridge 官方 README](https://github.com/homebridge/homebridge/blob/latest/README.md)
- [n8n 官方 README](https://github.com/n8n-io/n8n/blob/master/README.md)
- [n8n 官方 npm 安装文档](https://docs.n8n.io/hosting/installation/npm/)
- [code-server 官方仓库 README](https://github.com/coder/code-server)
- [code-server 官方安装文档](https://github.com/coder/code-server/blob/main/docs/install.md)
- [code-server 官方 npm 安装说明](https://github.com/coder/code-server/blob/main/docs/npm.md)
- [Cloudflare Quick Tunnels 官方文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Tunnel Downloads 官方文档](https://developers.cloudflare.com/tunnel/downloads/)
- [Cloudflare 官方 Package Repository](https://pkg.cloudflare.com/)
