# npm 发布与一键启动方案调研

日期：2026-08-21

## 结论

`wecode` 适合先发布为 Node CLI，再由 CLI 在首次配置时按平台安装用户级后台服务。推荐的用户路径是：

```text
npm install -g @<scope>/wecode
wecode onboard --install-service
```

其中 `onboard` 负责依赖检查、二维码登录、默认工作目录和白名单配置；`--install-service` 负责安装并启动原生服务。普通 `wecode run` 仍保留为前台模式。

npm 安装本身不应自动写入 systemd、launchd 或 Windows 任务计划。安装生命周期脚本可能在 CI、非交互环境或用户没有预期时执行；把系统变更放在显式的 `onboard` / `service install` 命令中更可控。这是结合 npm 生命周期机制与下列案例得出的设计判断。

## 成熟案例

### OpenClaw：最接近的 AI Gateway 模式

OpenClaw 将全局 npm CLI、首次向导和原生服务安装组合在一起：

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

它同时保留前台 `gateway run`，并提供 `gateway install/start/stop/restart/status/uninstall` 生命周期命令；文档明确覆盖 macOS LaunchAgent、Linux systemd user service 和 Windows 服务路径。这个命令分层最适合借鉴到 wecode。

来源：

- [OpenClaw 安装文档](https://github.com/openclaw/openclaw/blob/main/docs/install/index.md)
- [OpenClaw Gateway CLI](https://github.com/openclaw/openclaw/blob/main/docs/cli/gateway.md)

### Homebridge：CLI 内置跨平台服务安装器

Homebridge Config UI X 提供 `hb-service install`，用同一套 CLI 命令为 Linux、macOS 和 Windows 安装服务，并提供 start、stop、restart、logs、uninstall。它还负责默认配置目录、日志和服务重启策略。对 wecode 来说，可借鉴“服务管理是产品命令的一部分”，但不必把 UI 或系统级安装复制过来。

来源：[Homebridge Service Command](https://github.com/homebridge/homebridge-config-ui-x/wiki/Homebridge-Service-Command)

### PM2：把后台托管交给外部进程管理器

PM2 采用 `pm2 start`、`pm2 startup`、`pm2 save` 管理后台进程，适合已有 Node 运维体系的用户；但使用者需要额外理解 PM2 的进程列表和开机恢复，不适合作为 wecode 普通用户的默认前置依赖。因此建议支持“前台运行 + 原生服务”，不把 PM2 作为运行时依赖。

来源：[PM2 Quick Start](https://doc.pm2.io/en/runtime/quick-start/)

### n8n：npm 适合快速本地试用，但不代表所有生产部署

n8n 文档提供 `npx n8n` 和 `npm install -g n8n` 的快速启动方式，同时说明 npm 安装方式的适用范围和更新路径。当前文档还标注 npm 安装将在 n8n 3.0 被弃用，说明复杂应用通常会逐步提供 Docker、桌面版或其他更可控的发行方式。wecode 可以先以 npm CLI 为主，但应把安装、配置和服务生命周期解耦，为未来提供 standalone/Docker 留出口。

来源：[n8n Install with npm](https://docs.n8n.io/deploy/host-n8n/install-options/install-with-npm)

### code-server：原生依赖会显著放大 npm 安装成本

code-server 的官方 npm 文档要求额外的编译工具和平台依赖，并提醒 Node 升级后可能需要重新编译原生模块。wecode 当前没有这类重型原生依赖，适合先走 npm；但发布前仍应验证 Linux、macOS、Windows 的干净环境安装。

来源：[code-server npm 安装](https://coder.com/docs/code-server/npm)

## 当前仓库的发布阻塞点

1. `package.json` 当前设置了 `private: true`，npm 会拒绝发布。
2. 没有 `bin` 入口，安装后不会提供 `wecode` 命令。
3. `tsconfig` 的构建输出在 `dist`，但 `dist/` 被 `.gitignore` 排除；当前 `npm pack --dry-run` 不会把构建产物放进包。
4. 当前没有 `files` 白名单，测试、源码和仓库开发文件会被一起打包；发布包应只包含 `bin`、`dist`、运行时 schema、README 和 LICENSE。
5. `src/control.ts` 通过 `process.cwd()/schemas/control-action.json` 找 schema。全局安装后从任意目录启动会找不到它，应改为包内相对路径或编译时复制到 `dist`。
6. 配置和状态默认基于 `process.cwd()`，全局 CLI / 服务模式下不应把 `.data` 和 `.env` 写到用户当前项目目录；应迁移到用户级配置、数据和日志目录，同时保留环境变量覆盖。
7. 当前只有 Linux systemd 脚本，且脚本依赖仓库目录；发布后需要抽象出 service adapter，至少支持 Linux systemd user、macOS launchd、Windows Task Scheduler/用户服务。
8. npm 上已经存在同名 `wecode` 包（本地 `npm view wecode` 可见），应使用 npm scope 或更换包名；CLI 命令仍可保持为 `wecode`。

## 推荐的产品命令

```text
wecode onboard                    首次配置、二维码登录、检查 Codex
wecode onboard --install-service  配置完成后安装并启动原生用户服务
wecode run                        前台运行，适合调试和 npx
wecode service status             查看服务和进程健康状态
wecode service start|stop|restart|uninstall
wecode doctor                     检查 Node、Codex、配置、状态文件和服务路径
wecode logs                       查看当前平台的服务日志
```

没有 TTY 时，`onboard` 不应尝试启动二维码交互，而应打印明确的下一步命令；服务启动时必须使用绝对的 Node 和包入口路径，不能依赖当前 shell 的 PATH 或当前工作目录。

## npm 包最小配置

```json
{
  "name": "@<scope>/wecode",
  "private": false,
  "bin": { "wecode": "bin/wecode.js" },
  "files": ["bin", "dist", "schemas", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

`bin/wecode.js` 应带 `#!/usr/bin/env node`，并加载编译后的入口。发布前固定执行：

```bash
npm run build
npm pack --dry-run
npm publish --access public
```

来源：[npm package.json 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)、[npm publish 文档](https://docs.npmjs.com/cli/v11/commands/npm-publish/)

## 分阶段落地

### P0：先让 npm 包可用

- 选择 scoped 包名，增加 `bin`、`files`、发布元数据和发布检查。
- 修复 schema、默认配置目录和全局安装路径问题。
- 增加 `onboard`、`doctor` 和前台 `run`。
- 在干净临时目录验证 `npm pack` 安装后的 `wecode --version`、`onboard` 和 `run`。

### P1：内置服务生命周期

- 抽象 `ServiceManager` 接口。
- Linux 复用现有 systemd user 逻辑，但模板改为从已安装包和用户数据目录生成。
- 新增 macOS LaunchAgent 和 Windows 用户任务计划程序实现。
- 增加服务状态、日志、升级后重装/修复和卸载命令。

### P2：减少外部前置依赖

- 提供安装脚本或本地 prefix 安装器，解决 Node/npm 版本和全局目录权限问题。
- 评估 standalone 二进制或桌面安装包；npm 仍作为开发者和 Node 用户的主渠道。

## 最终建议

第一版不要引入 PM2、数据库或额外的历史会话调度器。让 Codex App Server 管理原生 thread 历史，wecode 只负责微信路由和本地配置。发行体验采用 OpenClaw/Homebridge 的“首次向导 + 显式服务安装”模式；服务安装封装 systemd/launchd/Windows 差异，但不让用户手工编辑 unit 文件。
