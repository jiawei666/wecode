# wecode 项目调查总结

> 这是历史审计记录；当前配置、路径和发布相关结论以源码与 README 为准。

## 1. 调查范围与结论

- 调查对象：`项目根目录` 当前文件快照，审查日期为 2026-08-17。
- 依据：仓库内 README、TypeScript 源码、JSON Schema、Shell 启动脚本、`package.json`/lockfile 和测试；未使用外部二手材料。
- 变更边界：本报告记录生成时的源码快照；后续配置化改动可能使部分行号和结论过时。
- 环境备注：根目录不存在 `.git`，因此无法进行提交历史、分支差异或变更归属审查；也不存在 `.codegraph/`，本次按普通源码阅读方式调查。

### 总体判断

这是一个面向个人本机使用的、以 Node.js/TypeScript 实现的微信 iLink 到 Codex 的桥接服务。它已经形成了清晰的第一版纵向链路：微信长轮询、用户/会话状态、控制 Agent、Codex App Server JSON-RPC，以及长报告分享页。项目定位和运行说明集中在 [README.md:3](../README.md:3) 和 [README.md:7](../README.md:7)。

本地验证结果较好：`npm test` 共 13 个测试全部通过，`npm run lint`（TypeScript `--noEmit`）通过。尚不能据此判定生产链路完整，因为真实 iLink、Codex CLI/App Server 和 Cloudflare Tunnel 没有做端到端联调；`npm run build` 也未执行，以避免在只读审查中写入已有的 `dist/` 构建产物。

当前最值得优先处理的不是目录拆分，而是运行边界：控制 Agent 和目标 Codex 都显式启用了审批绕过及 full-access；用户白名单在两个配置都为空时会失效；分享页默认可通过公开 Tunnel 或配置的反向代理提供，且未显式做 Markdown HTML 清洗；Codex WebSocket 断线后没有可靠的连接失效/重连路径；新线程首次发送发生重建时还存在将 turn 绑定到旧 thread 的代码路径。这些判断分别见“风险与改进建议”。

## 2. 项目定位与用户能力

README 将项目定义为“通过微信 iLink 控制本地 Codex 交互会话”的独立 Node 服务，并明确不依赖 Obsidian（[README.md:3](../README.md:3)）。设计上，Codex 原生 thread 是会话真相，桥接层只持久化微信账号到 thread 的当前绑定，桥接进程退出不会主动删除 Codex 历史（[README.md:21](../README.md:21)）。

面向微信用户暴露的命令包括：

| 能力 | 命令/实现 | 证据 |
| --- | --- | --- |
| 登录与运行 | `npm run dev -- login`、`npm run dev -- run`；生产可用 `npm run build && npm start` | [README.md:23](../README.md:23)、[package.json:10](../package.json:10) |
| 会话控制 | `菜单`、`新建`、`切换`、`会话`、`状态` 等高置信度短词和菜单序号由桥接层本地执行；`控制：……` 或 `/ctrl [自然语言]` 进入 Control Agent；旧版斜杠命令继续作为本地故障兜底 | [src/commands.ts:1](../src/commands.ts:1)、[src/bridge.ts:1](../src/bridge.ts:1) |
| 紧急入口 | `/stop`、`/cancel`、`/help` | [src/bridge.ts:41](../src/bridge.ts:41) |
| 控制 Agent | `/ctrl [自然语言]`，或在没有当前绑定时将普通消息交给控制 Agent | [src/bridge.ts:72](../src/bridge.ts:72) |
| 目标 Codex 对话 | 有绑定时普通消息直接进入 Codex thread | [src/bridge.ts:83](../src/bridge.ts:83) |
| 长输出分享 | 长报告或显式 page 输出发布为 Markdown 页面，必要时启动 Cloudflare Quick Tunnel | [src/render.ts:279](../src/render.ts:279)、[README.md:64](../README.md:64) |

当前范围有意收窄：README 说明第一版只接 Codex，报告类请求会自动标记为分享页；iLink 媒体目前只保留附件元数据，普通消息处理仍以文字为主（[README.md:60](../README.md:60)、[src/bridge.ts:53](../src/bridge.ts:53)）。

## 3. 目录结构

| 路径 | 职责 | 关键事实 |
| --- | --- | --- |
| `src/index.ts` | 进程入口、依赖组装、登录/运行分支、轮询主循环、信号退出 | `main()` 默认 `run`，先加载配置和状态，再创建 iLink、Codex、SessionManager、BridgeApp（[src/index.ts:11](../src/index.ts:11)） |
| `src/bridge.ts` | 微信消息路由、命令分派、控制流程、回复和队列 | 负责 allowlist、去重、控制 Agent/目标 thread 分流和 turn 回传（[src/bridge.ts:41](../src/bridge.ts:41)） |
| `src/ilink.ts` | iLink HTTP API、QR 登录、消息解析、文字发送 | 使用 `getupdates` 长轮询和 `sendmessage`，处理 token、cursor、context token（[src/ilink.ts:159](../src/ilink.ts:159)） |
| `src/control.ts` | 控制 Agent 进程与 action JSON 解析 | 通过 `codex exec --json --output-schema` 产生会话控制动作（[src/control.ts:31](../src/control.ts:31)） |
| `src/codex.ts` | Codex App Server 生命周期、WebSocket JSON-RPC、thread/turn 操作 | 支持外部已启动的 App Server，也可按 endpoint 自动拉起 `codex app-server`（[src/codex.ts:153](../src/codex.ts:153)） |
| `src/sessions.ts` | 微信用户绑定、turn 累积、Codex 通知映射和 App Server 生命周期 | 将 delta、plan、diff、completed 事件聚合成 `TurnResult`（[src/sessions.ts:171](../src/sessions.ts:171)） |
| `src/state.ts` / `src/model.ts` | 本地持久化状态和领域类型 | 状态包含 iLink token、bot、cursor、context token、绑定、控制会话和去重键（[src/model.ts:18](../src/model.ts:18)） |
| `src/render.ts` | 微信文本规整、分片、Markdown 页面生成、Cloudflare Tunnel | 长输出使用内存页面表和 TTL（[src/render.ts:157](../src/render.ts:157)） |
| `schemas/control-action.json` | 控制 Agent 输出的结构化契约 | action、cwd、thread_id、text、title、presentation、reason 均列为 required，且禁止额外属性（[schemas/control-action.json:3](../schemas/control-action.json:3)） |
| `test/` | Node test + tsx 测试 | 覆盖命令、schema/action、渲染、session、Codex sandbox 参数和状态原子写入；没有 Bridge/iLink 真实网络端到端测试 |
| `dist/` | 已存在的 TypeScript 构建产物和 source map | `tsconfig` 输出目录为 `dist`，且 `.gitignore` 将它排除（[tsconfig.json:11](../tsconfig.json:11)、[.gitignore:1](../.gitignore:1)） |

仓库没有现成 `docs/` 目录或其他研究笔记约定，本文件按请求新建于 `docs/project-summary-research.md`。

## 4. 运行入口与生命周期

### 4.1 启动入口

`src/index.ts` 从 `process.argv[2]` 读取 `login` 或 `run`；两种模式都会加载 `.env`、创建数据目录并初始化 `StateStore`（[src/index.ts:1](../src/index.ts:1)）。

- `login`：调用 QR 登录接口，保存 `token`、`botId`、`baseUrl`、扫描用户和 cursor，然后退出（[src/index.ts:18](../src/index.ts:18)）。
- `run`：若状态中没有 token/botId 则拒绝启动；随后实例化 `IlinkClient`、`CodexAppServer`、`SessionManager` 和 `BridgeApp`（[src/index.ts:33](../src/index.ts:33)）。
- 进程每 60 秒调用一次 idle reap；主循环持续 iLink `poll(cursor)`，遇到 session expired 退出，普通错误采用 1 秒到 30 秒的指数退避（[src/index.ts:60](../src/index.ts:60)）。
- `SIGINT`/`SIGTERM` 触发 Bridge 关闭、页面清理、SessionManager/Codex 子进程关闭（[src/index.ts:51](../src/index.ts:51)）。

### 4.2 消息路由

1. `IlinkClient.poll` 向 `ilink/bot/getupdates` 发送 cursor，跳过 bot 自己的消息，提取发送者、文字、附件元数据、message id、时间和 context token（[src/ilink.ts:175](../src/ilink.ts:175)）。
2. `BridgeApp` 先按 `WECHATBOT_ALLOWED_USER` 或 QR 扫描用户做过滤，再保存 context token，并用最多 500 个去重键防止重复处理（[src/bridge.ts:41](../src/bridge.ts:41)、[src/state.ts:5](../src/state.ts:5)）。
3. `/cancel`、`/stop`、高置信度中文短词、菜单序号以及全部斜杠会话命令优先处理，不依赖控制 Agent；“控制：……”是手机端显式进入 Control Agent 的无斜杠入口；目标 Codex 执行中收到的新消息优先 steer 当前 turn，失败时按 FIFO 队列续接；裸数字只有在对应菜单/会话列表状态未过期时才会被解释为选择，其他文本再根据控制状态和 thread 绑定进入 Control Agent 或目标 Codex（[src/bridge.ts:59](../src/bridge.ts:59)）。
4. 控制 Agent 只返回 action JSON。`BridgeApp.executeAction` 将 action 映射为新建/切换/列出/状态/中断/reply 等具体行为（[src/bridge.ts:161](../src/bridge.ts:161)）。
5. 目标消息通过 `SessionManager.send` 调用 `turn/start`；Codex 事件由 `SessionManager` 累积，`turn/completed` 后回调 `BridgeApp.onTurn`（[src/sessions.ts:69](../src/sessions.ts:69)、[src/sessions.ts:216](../src/sessions.ts:216)）。任务执行期间同一用户的新消息进入内存队列，完成后逐条 drain（[src/bridge.ts:200](../src/bridge.ts:200)）。
6. 回复先经 `renderResponse`：普通内容规整并按 Unicode 字符/段落分片；长报告、plan、diff 或显式 page 尝试发布分享页，失败时回退到带依赖提示的聊天文本（[src/render.ts:107](../src/render.ts:107)、[src/render.ts:279](../src/render.ts:279)）。最后 `IlinkClient.sendText` 按分片发送到当前 context token（[src/ilink.ts:223](../src/ilink.ts:223)）。

## 5. 核心模块与数据流判断

### 5.1 状态和会话真相

`BotState` 把 iLink 登录凭据、cursor、按用户的 context token、按用户的 `SessionBinding`、控制 Agent session、去重键和最近轮询错误集中保存；`SessionBinding` 保存 thread id、cwd、rollout 标记和活动时间（[src/model.ts:3](../src/model.ts:3)、[src/model.ts:18](../src/model.ts:18)）。

`StateStore` 在初始化时读取 JSON，写入时使用 `${stateFile}.tmp-${pid}` 后 rename，并尽力设置 `0600`；连续 update 通过 `saveRequested/savePending` 合并，测试覆盖了快速连续更新的持久化（[src/state.ts:61](../src/state.ts:61)、[test/state.test.ts:8](../test/state.test.ts:8)）。这使它适合作为单进程本地状态存储，但不是带 schema 校验、锁和事务日志的多进程数据库。

### 5.2 Codex 集成

`CodexAppServer` 与 App Server 建立 WebSocket，发送 `initialize`/`initialized`，再使用 `thread/start`、`thread/resume`、`thread/list`、`turn/start` 和 `turn/interrupt`。启动 thread/turn 时都传入 `approvalPolicy: 'never'` 和 full-access sandbox；这与测试中断言的 `danger-full-access` 一致（[src/codex.ts:165](../src/codex.ts:165)、[test/codex.test.ts:8](../test/codex.test.ts:8)）。

通知层识别 `turn/started`、agent message delta、item completed、plan/diff updated 和 `turn/completed`，支持把 Codex 输出标记为 plain/plan/diff/report/code，并依据用户请求把报告类 turn 标为 page（[src/sessions.ts:171](../src/sessions.ts:171)、[src/sessions.ts:271](../src/sessions.ts:271)）。

### 5.3 控制 Agent 与目标 Agent 分工

控制 Agent 的 system prompt 要求它只理解控制意图并输出 action JSON，不直接完成项目开发；它可扫描配置的 home 目录并把实际工作交给目标 Codex thread（[src/control.ts:13](../src/control.ts:13)）。命令使用 `--output-schema`、`--output-last-message`，并在结束后尝试读取和删除临时 JSON（[src/control.ts:34](../src/control.ts:34)）。

目标 Codex 由 `SessionManager` 通过 App Server endpoint 直接管理；新 thread 首次 turn 前标记为 `hasRollout=false`，首次发送后再标记为已产生 rollout。切换前使用不持有连接的 `thread/read` 检查活动状态；只有用户明确确认后，才通过 `turn/interrupt`、等待空闲并 `thread/resume` 完成安全接管（[src/sessions.ts:343](../src/sessions.ts:343)、[src/codex.ts:244](../src/codex.ts:244)）。

## 6. 依赖、配置与外部边界

### 6.1 依赖

`package.json` 要求 Node `>=22`，运行时依赖为 `dotenv`、`marked`、`qrcode`、`ws`，开发依赖为 Node 类型、qrcode/ws 类型、tsx 和 TypeScript（[package.json:7](../package.json:7)、[package.json:17](../package.json:17)）。lockfile 为 v3，resolved 包地址已使用公共 npm registry，便于外部环境安装（[package-lock.json:1](../package-lock.json:1)、[package-lock.json:27](../package-lock.json:27)）。

TypeScript 采用 `ES2022`、`NodeNext`、strict、`noUncheckedIndexedAccess`、source map，源码和测试都纳入编译而 `dist` 排除（[tsconfig.json:2](../tsconfig.json:2)）。

### 6.2 配置

配置读取以当前工作目录为项目根，支持相对数据目录；默认数据文件是 `.data/state.json`，默认 iLink API/CDN、Codex endpoint、2 小时 idle timeout、24 小时分享页 TTL、1200 字符聊天分片和 35 秒 poll timeout（[src/config.ts:37](../src/config.ts:37)）。`.env.example` 覆盖数据目录、允许用户、扫描 home/default cwd、Codex 命令/model/endpoint、控制模型、idle timeout、cloudflared 和分享页 URL（[.env.example:1](../.env.example:1)）。源码还支持 `ILINK_API_BASE`、`ILINK_CDN_BASE`、`ILINK_CHANNEL_VERSION`、`WECHATBOT_CHAT_CHUNK_SIZE`、`WECHATBOT_CONTROL_TIMEOUT_MS` 和 `WECHATBOT_POLL_TIMEOUT_MS`（[src/config.ts:48](../src/config.ts:48)）。

### 6.3 外部系统边界

- 微信：HTTPS iLink QR、getupdates、sendmessage；token 和 context token 在本地状态中使用。
- Codex：本机 `codex` CLI、App Server WebSocket 和持久化 native thread；占用冲突只通过 App Server 协作式处理，不操作外部客户端进程。
- 分享页：本地仅监听 `127.0.0.1` 的随机端口，再由配置的反向代理或 Cloudflare Quick Tunnel 暴露；页面只在进程内存保存，默认 TTL 来自 `WECHATBOT_PAGE_TTL_MS`（[src/render.ts:196](../src/render.ts:196)、[.env.example:22](../.env.example:22)）。

## 7. 测试与验证

### 已执行

| 命令 | 结果 | 覆盖/说明 |
| --- | --- | --- |
| `npm test` | 当前通过，34 passed, 0 failed | Node test + tsx；覆盖 Codex `thread/start`/`turn/steer`、命令解析、中文/英文本地兜底命令、菜单状态、连续输入顺序、控制 schema/action、Markdown/分片/分享页失败回退、fresh/stale session、占用会话安全接管和状态快速持久化（[test/render.test.ts:6](../test/render.test.ts:6)、[test/sessions.test.ts:17](../test/sessions.test.ts:17)） |
| `npm run lint` | 通过 | `tsc -p tsconfig.json --noEmit`，严格类型检查脚本定义见 [package.json:10](../package.json:10) |

测试有价值地覆盖了“新 thread 首次 turn”和“丢失 fresh thread 时重建”两条近期易错路径（[test/sessions.test.ts:17](../test/sessions.test.ts:17)、[test/sessions.test.ts:58](../test/sessions.test.ts:58)）。渲染测试还验证了长仓库报告在没有显式 kind 时会自动走分享页，以及 cloudflared 缺失时能回退并说明原因（[test/render.test.ts:27](../test/render.test.ts:27)、[test/render.test.ts:41](../test/render.test.ts:41)）。

### 未覆盖或未执行

- 没有真实 iLink HTTP/QR/过期 cursor/sendmessage 测试；`IlinkClient` 的协议失败、重试和 context token 更新主要依赖静态审查。
- 没有真实 Codex App Server 重启/断线重连测试，也没有验证 codex/cloudflared 在目标机器上的可执行文件和权限。
- 没有 `BridgeApp` 的集成测试来覆盖 allowlist、去重、控制/目标分流、消息队列和回复失败。
- 没有看到 CI、覆盖率阈值或依赖安全扫描配置；当前测试规模不能代表生产场景。
- 未执行 `npm run build`，原因是该脚本会写入 `dist/`；本报告保持源码和现有构建产物不变。

## 8. 已知风险与改进建议

以下“影响”是基于仓库实现的工程判断；不是对外部服务协议的额外推断。

| 优先级 | 风险/事实 | 证据与影响 | 建议 |
| --- | --- | --- | --- |
| P0 | 执行权限边界过宽 | 控制 Agent 传入 `--dangerously-bypass-approvals-and-sandbox`，目标 App Server/turn 也固定 `approvalPolicy=never`、`danger-full-access`（[src/control.ts:37](../src/control.ts:37)、[src/codex.ts:186](../src/codex.ts:186)）。一旦微信入口被非预期用户使用，Codex 可读写本机广泛文件。 | 生产默认改为受限 sandbox/审批；如必须全权限，使用专用低权限 OS 用户、显式 opt-in，并限制工作目录。 |
| P0 | 用户授权可能 fail-open | 处理逻辑是 `allowedUser || scannedUser`，两个值都为空时不会过滤任何 `from`；`.env.example` 默认把 `WECHATBOT_ALLOWED_USER` 留空（[src/bridge.ts:41](../src/bridge.ts:41)、[.env.example:4](../.env.example:4)）。 | `run` 启动前强制要求已解析的扫描用户或显式 allowlist；两者都缺失时拒绝启动并记录原因，增加陌生 sender 的回归测试。 |
| P0 | 分享页可能造成信息暴露和 HTML 注入 | 页面内容直接交给 `marked.parse`，服务端路由只有随机 slug 和 TTL，没有用户认证或内容清洗（[src/render.ts:135](../src/render.ts:135)、[src/render.ts:210](../src/render.ts:210)）；默认还会启动公开 Quick Tunnel（[src/render.ts:227](../src/render.ts:227)）。长报告可能包含源码、路径、凭据或内部日志。 | 默认只发聊天文本；分享页采用严格 Markdown 白名单/HTML sanitize，禁止危险 URL/HTML，使用短 TTL、一次性签名或登录鉴权，并在发布前过滤 secret/path 等敏感信息。 |
| P1 | Codex WebSocket 断线后缺少重连 | socket `close` 只拒绝 pending 请求；外层 `CodexAppServer.connection` 没有被置空，而 `connect()` 看到已有 connection 就直接返回（[src/codex.ts:98](../src/codex.ts:98)、[src/codex.ts:165](../src/codex.ts:165)）。断线后后续请求可能持续得到“connection is closed”。 | 在 close/error 时使 connection 失效，按指数退避重连，重新 initialize/resume 已绑定 thread，并把正在执行的 turn 标为可恢复或明确失败；加入 App Server 重启测试。 |
| P1 | fresh thread 重建路径可能丢失最终回复 | `startTurn` 失败后会把 `activeBinding` 换成新 thread，但随后创建 `TurnAccumulator` 时仍使用旧的 `binding.threadId`（[src/sessions.ts:82](../src/sessions.ts:82)、[src/sessions.ts:98](../src/sessions.ts:98)）。这是基于变量生命周期的代码推断：新 thread 的 completed 通知可能被标成旧 thread，`BridgeApp.onTurn` 找不到当前绑定而丢弃回复。 | 用 `activeBinding.threadId` 初始化 accumulator，并增加“收到新 thread 通知→微信收到完成消息”的回归测试；同时测试 turn/started 与 `startTurn` 返回的竞态。 |
| P1 | 状态恢复和临时文件失败时不够可诊断 | 状态 JSON 解析/读取失败会打印后继续使用空状态（[src/state.ts:33](../src/state.ts:33)），可能导致凭据/绑定看似消失；控制 Agent 的 `outputPath` 清理位于成功返回后的读取分支，`runProcess` 超时或 spawn 失败时可能绕过清理（[src/control.ts:52](../src/control.ts:52)）。 | 对 state 做版本/schema 校验，损坏时备份并 fail-safe；为控制输出使用 `try/finally`，为临时文件增加启动清理和敏感信息日志脱敏。 |
| P1 | 进程退出时的异步状态写入风险 | `StateStore.update` 触发 `void this.save()`，而信号处理器完成 close 后直接 `process.exit(0)`，没有显式等待最后一次 state save（[src/state.ts:56](../src/state.ts:56)、[src/index.ts:51](../src/index.ts:51)）。 | 退出流程显式 `await store.save()`；将关键 cursor/token 更新纳入可等待的持久化队列，必要时处理 SIGTERM 超时。 |
| P1 | 附件只被识别，不被消费 | `parseAttachments` 明确不拷贝或解密媒体，只返回 image/file/video/audio 元数据（[src/ilink.ts:145](../src/ilink.ts:145)）；Bridge 对纯附件回复“当前版本先处理文字消息”（[src/bridge.ts:53](../src/bridge.ts:53)）。 | 若属于设计范围，README 明确限制；否则实现下载、AES 解密、大小/MIME/路径校验，并以 Codex 支持的 input 结构安全传递，增加恶意媒体测试。 |
| P2 | 用户消息队列无上限且只存在内存 | `BridgeApp.queued` 是按用户保存的普通数组，任务运行时持续 push，未见长度上限或持久化（[src/bridge.ts:14](../src/bridge.ts:14)、[src/bridge.ts:200](../src/bridge.ts:200)）。高频发送可增加内存和待执行工作量，进程重启则丢队列。 | 设置每用户/全局队列上限、拒绝或合并重复消息，增加超时和取消语义；若需要可靠投递，再引入持久化队列。 |
| P2 | 集成测试和运维可观测性不足 | 现有测试主要是纯函数、假的 App Server/WebSocket 和临时目录；没有 Bridge 全链路、真实外部依赖、CI 或覆盖率门槛。 | 增加可替换的 iLink/Codex/cloudflared adapter 和 contract tests；CI 至少执行 lint/test/build，增加覆盖率、结构化日志、健康检查和依赖漏洞扫描。 |

## 9. 建议的实施顺序

1. **先收紧入口**：强制 allowlist、限制可访问目录和执行权限，默认关闭 public share page；这是降低“远程消息触发本机任意操作”风险的前置条件。
2. **修复会话可靠性**：修正 fresh thread 重建时的 thread id 使用，补上 WebSocket close/error 失效和重连/resume，增加断线、重启、通知竞态测试。
3. **保护输出与状态**：对分享页做 sanitize/鉴权/短 TTL，对 state 做校验和安全恢复，退出时等待保存，保证控制临时文件在异常路径清理。
4. **补齐边界能力**：决定附件是明确不支持还是正式支持；若支持，先制定媒体大小、MIME、解密和本地落盘策略。
5. **建立发布门槛**：补 `npm run build` 验证、CI、覆盖率和真实依赖的可控替身，避免只凭 13 个单元/伪集成测试发布。

## 10. 一句话交付结论

项目已经是一个结构清楚、测试可通过的个人本地微信-Codex 桥接原型；要面向更广泛或长期运行的环境，首要工作是把“默认全权限 + 可能开放入口 + 公共分享页”的信任模型改成显式授权、受限执行和可恢复连接。
