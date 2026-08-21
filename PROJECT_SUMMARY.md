# wecode 项目分析与总结报告

> 分析日期：2026-08-18
> 分析对象：项目根目录 当前文件快照

## 结论摘要

wecode 是一个独立的 Node.js/TypeScript 桥接服务，通过微信 iLink 控制本机 Codex 交互会话。当前已经打通了“微信长轮询 → 消息路由 → 会话管理 Agent 或 Codex App Server → 微信回复 → 长报告分享页”的第一版纵向链路，代码规模适中，模块边界清楚，自动化校验通过。

项目目前适合个人本机工具或受控内测，不适合直接作为多用户或公网生产服务。最重要的原因是：

1. 会话管理 Agent 和目标 Codex 默认使用 approvalPolicy=never、danger-full-access，远程消息可以驱动本机执行高权限操作。
2. 白名单配置和二维码返回用户 ID 同时为空时，桥接层不会拒绝消息，访问控制存在 fail-open 路径。
3. 工作目录只校验“是否存在且为目录”，没有限制在受控根目录内。

此外，当前仍有一个已定位的会话恢复回执问题、一个 WebSocket 断线后不会自动重连的问题，以及缺少外部协议端到端测试的问题。报告页的原始 HTML 和危险链接过滤已经在当前源码中实现，旧报告中关于“可直接触发 XSS”的结论不再适用于当前版本；当前更准确的风险是页面缺少访问认证，可能造成报告内容泄露。

## 1. 分析范围与证据

本次检查了以下内容：

- README、环境变量示例、package.json、tsconfig.json 和 lockfile。
- src/ 下 12 个 TypeScript 源文件。
- test/ 下 7 个测试文件，共 34 个测试用例。
- 会话管理 Agent 的 JSON Schema 和 cloudflared 调用配置。
- 当前已有的 PROJECT_SUMMARY.md 与 docs/project-summary-research.md，并以当前源码和实际命令结果为准重新核验。

仓库根目录不是 Git 工作树，也不存在 .codegraph/，因此本报告不包含提交历史、分支差异、变更归属或 CodeGraph 调用图分析。未执行真实微信 QR 登录、真实 iLink 联调、公网 Cloudflare Tunnel 访问或真实 Codex 工作流；这些部分的结论来自源码审查和模拟测试。

## 2. 项目定位与技术构成

README 将项目定位为“通过微信 iLink 控制本地 Codex 交互会话”，并明确项目是独立 Node 服务，不依赖 Obsidian，见 [README.md](README.md)。

| 类别 | 当前实现 | 主要证据 |
| --- | --- | --- |
| 运行时 | Node.js >=22、ESM、TypeScript strict 模式，启用 noUncheckedIndexedAccess | [package.json](package.json)、[tsconfig.json](tsconfig.json) |
| 微信协议 | HTTP 长轮询 getupdates，sendmessage 回复，二维码登录，context token 续用 | [src/ilink.ts](src/ilink.ts) |
| Codex 协议 | 本机 WebSocket JSON-RPC App Server，共享原生 thread | [src/codex.ts](src/codex.ts) |
| 状态 | .data/state.json，原子替换写入，文件权限尽力设为 0600 | [src/state.ts#L61](src/state.ts#L61)、[src/state.ts#L112](src/state.ts#L112) |
| 长内容 | 本地 127.0.0.1 Markdown 页面，使用自定义公网地址或 Cloudflare Quick Tunnel | [src/render.ts#L287](src/render.ts#L287) |
| 依赖 | dotenv、marked、qrcode、ws；无 Web 框架、无数据库 | [package.json](package.json) |
| 可选工具 | cloudflared 由本机安装或通过 `CLOUDFLARED_COMMAND` 指定；本地二进制不纳入仓库 | [src/config.ts](src/config.ts)、[.env.example](.env.example) |

## 3. 架构与核心流程

    微信 iLink
        │ getupdates / sendmessage
        ▼
    IlinkClient
        │
        ▼
    BridgeApp ───────────────► ControlAgent
        │                          │ 结构化 action JSON
        │                          ▼
        └────────────────────► SessionManager
                                   │
                         CodexAppServer / WebSocket
                                   │
                         Codex 原生 thread
                                   │
                                   ▼
                              微信回复
                            │
                            ▼
                     PagePublisher 分享页

### 启动与登录

src/index.ts 根据命令执行 login 或 run。login 通过二维码取得 bot token、bot ID、服务地址和扫码用户，并写入状态文件；run 要求已有 token 和 bot ID，然后创建 iLink 客户端、Codex App Server、会话管理器和桥接层。

### 消息路由

BridgeApp 先检查允许用户、保存 context token、进行消息去重，再处理状态、停止、退出、帮助四个本地命令、唤醒词和普通文本，见 [src/bridge.ts#L41](src/bridge.ts#L41)。需要查找、新建、切换或恢复会话时，只有“帅哥、靓仔、小哥哥、哥哥、大哥、老哥”等唤醒词会进入会话管理 Agent；没有当前 thread 绑定且未使用唤醒词时只返回提示。有绑定时，执行中的普通消息优先通过 App Server steer 当前 turn，无法 steer 时进入 FIFO 队列并在完成后自动续接。

### 会话与 App Server

SessionManager 负责创建、恢复、列出 thread、启动/中断 turn、订阅通知并聚合最终文本。Codex 原生 thread 是会话真相，桥接层只保存用户到 thread 的绑定，见 [src/sessions.ts](src/sessions.ts)。

新 thread 在首条 turn 之前标记为 hasRollout=false；首条消息成功启动后将绑定标记为已产生 rollout。这是对 Codex 新 thread 生命周期的针对性处理。

### 会话管理 Agent

ControlAgent 调用 codex exec --json --output-schema，让模型只返回 new_session、switch_session、list_sessions、status、interrupt、set_note、reply 或 ask 等结构化 action，schema 位于 [schemas/control-action.json](schemas/control-action.json)，解析和字段校验位于 [src/control.ts](src/control.ts)。对用户显示的名称统一为“会话管理 Agent”。

### 长报告分享

请求文本或 Codex 输出被识别为报告、计划、差异，或超过长度阈值时，BridgeApp 调用 PagePublisher 生成临时 HTML 页面。页面服务只监听 127.0.0.1，再由 Cloudflare Quick Tunnel 或 SHARE_PAGE_BASE_URL 对外提供访问地址，见 [src/render.ts#L391](src/render.ts#L391)。

## 4. 已实现能力与产品边界

已实现：

- 微信二维码登录、iLink 长轮询、context token 保存、消息去重和文本分片。
- `状态`、`停止`、`退出`、`帮助` 四个中文短词由桥接层本地执行；“帅哥、靓仔、小哥哥、哥哥、大哥、老哥”加需求作为会话管理 Agent 的唯一唤醒入口；不再保留任何斜杠命令、菜单、序号选择或 Raw 模式。
- Codex thread 创建、恢复、列出、turn 启动和中断。
- wecode 通过 Codex App Server 管理原生 thread，其他 Codex 客户端可独立连接同一服务；发生占用冲突时，只有用户明确确认后才会通过 App Server 请求中断活动 turn，并向精确持有目标 thread 锁的外部 Codex 进程发送退出信号，不删除锁文件或触碰其他进程。
- turn 通知聚合：普通文本、plan、diff、report 等展示类型。
- 状态原子写入、最多保留 500 条去重记录、空闲 App Server 订阅回收。
- Markdown 转微信纯文本，按段落和代码块切分，并使用 Unicode 安全长度计算。
- 长报告自动转分享页；引用当前工作目录内的 Markdown 文件时，可将文件正文嵌入分享页。
- 分享页对原始 HTML 做转义，对链接和图片协议做 allowlist 过滤。当前测试确认 script 标签会被转义，javascript: 链接不会生成 href，见 [src/render.ts#L134](src/render.ts#L134) 和 [test/render.test.ts#L74](test/render.test.ts#L74)。

明确边界：

- 图片、文件、视频和无文字语音目前只保留附件元数据并提示“当前版本先处理文字消息”，不会下载、解密或交给 Codex，见 [src/ilink.ts#L145](src/ilink.ts#L145)。
- typing endpoint 仍为空实现。
- 没有真实 iLink、Codex App Server、cloudflared 的端到端测试。
- 当前设计按单机、少用户场景组织，没有租户隔离、配额、速率限制或多实例协调。

## 5. 本地验证结果

| 检查项 | 结果 |
| --- | --- |
| npm test | 通过，34/34 |
| npm run lint | 通过；脚本实际执行 tsc -p tsconfig.json --noEmit，并非 ESLint |
| npm run build | 通过，生成 dist/ |
| Node.js | 当前环境 v24.14.0，满足 package.json 的 >=22 要求 |
| npm ls --depth=0 | 通过，依赖树无缺失 |
| 页面安全探针 | 通过，原始 HTML 转义、javascript: 链接过滤 |

现有测试重点覆盖命令解析、控制 action、状态快速连续写入、Markdown 清洗与分片、报告识别、Codex sandbox 参数、新 thread 首次发送和 stale fresh binding 重建。测试主要使用 fake App Server 和本地 WebSocket/HTTP server，未覆盖 BridgeApp 的完整路由，也未覆盖真实微信协议。

## 6. 优点与工程质量评价

1. 模块职责清楚。iLink、桥接路由、会话管理 Agent、Codex RPC、会话、状态和渲染分别位于独立模块，后续替换外部适配器的成本较低。
2. 类型约束较好。项目启用 strict、noUncheckedIndexedAccess，并对控制 action 使用 JSON Schema 与运行时字段校验。
3. 本地状态写入考虑了崩溃一致性。状态先写临时文件再 rename，并对最终文件执行 0600 权限设置。
4. 子进程调用普遍使用参数数组和 shell=false，没有发现把用户文本直接拼接进 shell 命令的路径。
5. 微信输出体验有针对性设计。文本分片考虑段落、代码围栏和 Unicode，报告类输出有独立的手机阅读页面。
6. 当前页面渲染已经补上原始 HTML 和危险 URL 的基本防护，安全基线比旧版更好。

总体工程质量可评为“个人工具第一版合格，生产化不足”：核心链路完整，可靠性和安全边界仍依赖部署环境和操作者自律。

## 7. 风险与问题清单

| 优先级 | 问题 | 影响与证据 | 建议 |
| --- | --- | --- | --- |
| 高 | Codex 默认完全放权 | ControlAgent 使用 dangerously-bypass-approvals-and-sandbox；thread/start、thread/resume、turn/start 均使用 never/full-access，见 [src/control.ts#L43](src/control.ts#L43)、[src/codex.ts#L186](src/codex.ts#L186)。一旦远程消息被接受，Codex 可修改本机文件、执行命令和访问其运行用户可见的数据。 | 默认改为沙箱和审批；如必须全权限，使用专用低权限 OS 用户、显式 opt-in，并限制工作目录。 |
| 高 | 审批请求仍会被自动接受 | 即使未来把 Codex 改回需要审批，JsonRpcConnection 对 requestApproval 仍直接返回 decision=accept，见 [src/codex.ts#L133](src/codex.ts#L133)。这会让“启用审批”形同虚设。 | 删除自动 accept，改为明确拒绝或接入真正的人工/策略审批通道；安全配置变更后增加验证测试。 |
| 高 | 访问控制 fail-open | 过滤条件是 allowedUser || scannedUser；两者都为空时不会拒绝任何发送者，见 [src/bridge.ts#L43](src/bridge.ts#L43)。二维码接口没有返回用户 ID 时尤其明显。 | 启动或处理消息前强制要求显式白名单；两项都为空时拒绝运行，并允许多个明确的 allowlist 用户。 |
| 高 | 工作目录没有安全边界 | validCwd 只检查路径存在且为目录，未限制在 WECHATBOT_HOME 或配置的项目根目录下，见 [src/sessions.ts#L254](src/sessions.ts#L254)。会话管理 Agent 或用户可把会话指向任意本机目录。 | 对 realpath 后的目录做 allowlist，拒绝根目录、敏感目录和越界 symlink；必要时只允许预注册项目。 |
| 高 | thread 所有权没有校验 | 会话管理 Agent action 可以按 thread_id 恢复任意 App Server thread，未验证 thread 是否属于当前用户或允许目录，见 [src/bridge.ts#L169](src/bridge.ts#L169)、[src/sessions.ts#L55](src/sessions.ts#L55)。多用户时可能导致会话串用和数据越权。 | 建立用户/thread/cwd 所有权映射；切换前校验归属和目录，禁止跨用户复用未经授权的 thread。 |
| 中 | 分享页是无认证 bearer URL | PagePublisher 的服务端只按随机 slug 找页面，没有认证；默认 TTL 为 24 小时，Quick Tunnel 通常是公网地址。报告还会按引用嵌入本地 Markdown 正文，见 [src/render.ts#L226](src/render.ts#L226)、[src/render.ts#L322](src/render.ts#L322)。 | 使用短 TTL、签名/一次性 URL 或访问认证；敏感文件默认不嵌入；增加 CSP 和内容脱敏。当前已验证的 XSS 过滤仍应保留。 |
| 中 | WebSocket 断线后不会自动恢复 | JsonRpcConnection 的 close 处理只拒绝 pending request，没有通知 CodexAppServer 清理 connection；后续 connect 看到非空 connection 会直接复用已关闭连接，见 [src/codex.ts#L92](src/codex.ts#L92)、[src/codex.ts#L165](src/codex.ts#L165)。桥接服务重启前后的 thread 订阅也没有完整恢复流程。 | 在 close/error 时清空连接，按退避重连，重新 initialize，并对已绑定 thread 重新订阅；增加断线恢复测试。 |
| 中 | stale thread 重建后可能丢失微信回执 | send 在首条 turn 失败时把 activeBinding 更新为新 thread，但随后创建 TurnAccumulator 时仍写入旧的 binding.threadId，见 [src/sessions.ts#L82](src/sessions.ts#L82)、[src/sessions.ts#L98](src/sessions.ts#L98)。完成回调按 thread 查绑定，可能找不到用户而直接返回，见 [src/bridge.ts#L218](src/bridge.ts#L218)。现有测试只验证绑定切换，没有验证最终回执。 | accumulator 使用 activeBinding.threadId；补充 turn/completed 到微信回复的回归测试。 |
| 中 | 输入、队列和报告缺少全局上限 | 运行中消息直接 push 到用户内存队列，没有队列长度、单条消息、控制 prompt、页面内容或并发限制，见 [src/bridge.ts#L201](src/bridge.ts#L201)。大量消息可能造成内存压力或长时间占用 Codex。 | 设置消息/队列/报告大小上限，增加每用户速率限制和并发上限，超限时明确拒绝或丢弃。 |
| 中 | cursor 可能早于消息处理落盘 | poll 成功后先异步更新 cursor，再逐条执行 bridge.handle；进程若在处理期间崩溃，重启后可能无法重放已取出的消息，见 [src/index.ts#L84](src/index.ts#L84)、[src/index.ts#L89](src/index.ts#L89)。 | 采用处理成功后再提交 cursor，或设计可重放/幂等的消息确认流程。 |
| 中 | Quick Tunnel 失活后 URL 仍会复用 | Tunnel 返回 URL 后，后续只检查 publicBaseUrl，不监控 cloudflared 退出；隧道中途断开时仍会发送旧链接，见 [src/render.ts#L339](src/render.ts#L339)。多请求同时首次发布时也没有显式的 in-flight 锁。 | 监听 tunnel exit、清空失效 URL并重建；用共享初始化 promise 串行化首次建隧道。 |
| 低 | 会话管理 Agent 临时文件异常时可能残留 | outputPath 在启动会话管理进程前创建；超时、spawn error 或非零退出会在进入清理 finally 前直接 reject，见 [src/control.ts#L35](src/control.ts#L35)、[src/control.ts#L52](src/control.ts#L52)、[src/control.ts#L87](src/control.ts#L87)。反复失败会积累 control-*.json。 | 将输出文件清理放入外层 finally，并在启动时清理过期临时文件。 |
| 低 | 退出时没有显式等待状态落盘 | update/setBinding 等调用异步触发 save；SIGINT/SIGTERM 的 stop 只关闭 bridge/session/page，随后直接 process.exit，见 [src/index.ts#L51](src/index.ts#L51)、[src/state.ts#L56](src/state.ts#L56)。快速退出可能丢失 cursor、绑定时间或错误状态。 | 统一 shutdown 流程中显式 await store.save()，并处理写盘失败。 |
| 中 | 状态文件损坏会降级为空状态 | state.json 读取或 JSON 解析失败后只记录日志并继续使用 emptyState，没有备份或 fail-closed；可能丢失登录凭据、cursor 和会话绑定，见 [src/state.ts#L33](src/state.ts#L33)、[src/state.ts#L46](src/state.ts#L46)。同时没有验证 version 和 binding 字段类型。 | 先备份损坏文件并停止运行或显式要求恢复；增加 BotState schema 校验、版本迁移和损坏状态恢复流程。 |
| 低 | 控制 action 的运行时校验不完整 | JSON Schema 声明了 additionalProperties=false 和完整字段类型，但 parseAction 只校验 action 及少数必需字段，未校验可选字段类型或额外字段，见 [schemas/control-action.json#L3](schemas/control-action.json#L3)、[src/control.ts#L165](src/control.ts#L165)。 | 使用同一份 schema 做运行时验证，拒绝未知字段和错误类型，避免模型输出绕过边界。 |
| 低 | 外部能力和部署可移植性有限 | 附件只保留元数据；bin/cloudflared 是 x86-64 Linux 二进制；没有 CI、覆盖率门禁或真实协议集成测试。 | 明确“文本优先”边界，或补齐媒体下载/解密/临时文件限制；为 ARM/其他平台提供安装方式，并加入 CI 和集成测试。 |

## 8. 建议实施顺序

### 第一阶段：先收紧安全边界

1. 访问控制改为 fail-closed，强制显式 allowlist。
2. 将 Codex sandbox、approval policy 和是否允许 full-access 改为显式配置，生产默认安全。
3. 对工作目录做 realpath 后的项目根目录 allowlist，并拒绝敏感路径和 symlink 越界。
4. 增加 thread 所有权校验，并删除 requestApproval 的自动 accept。
5. 对分享页增加签名访问、短 TTL、CSP 和敏感内容策略，默认不自动嵌入任意 Markdown。
6. 增加输入大小、队列长度、报告大小和每用户速率限制。

### 第二阶段：修复会话和进程可靠性

1. 修复 stale thread 的 TurnAccumulator threadId。
2. 为 WebSocket 增加断线清理、重连和 thread 重订阅。
3. 监控 cloudflared 生命周期，失效时重建隧道；避免并发首次初始化。
4. 统一退出流程并等待 state save。
5. 明确 App Server 的进程所有权，避免由 wecode 启动的后台进程长期遗留。
6. 调整 cursor 提交时机，确保消息处理成功后再推进游标；清理会话管理 Agent 的临时文件。

### 第三阶段：补齐工程化

1. 增加 BridgeApp 授权/路由、iLink poll/send、Codex notification、断线重连、页面访问控制和信号退出的测试。
2. 为 stale thread 增加完整的“turn 完成 → 找到绑定 → 微信回复 → 排队消息继续发送”回归测试。
3. 为状态文件和 control action 增加运行时 schema 校验与迁移测试。
4. 增加 ESLint 或等效 lint、格式化、覆盖率门禁、CI 和依赖/运行时兼容版本记录。
5. 为单实例运行增加锁或明确多实例禁止策略。
6. 决定附件是否进入产品范围；若暂不实现，应在 README 和运行提示中持续强调仅支持文字消息。

## 最终判断

项目的核心设计方向成立：以 Codex 原生 thread 作为会话真相，以轻量状态保存微信用户绑定，以 App Server 连接支撑微信入口，再用报告页承载长内容。当前源码和自动化测试足以支撑个人环境试用。

在扩大使用范围前，应优先处理“远程输入驱动本机完全权限执行”“访问控制 fail-open”“任意工作目录”这三个安全边界问题，然后修复 stale thread 回执丢失和 WebSocket 断线恢复。修复这些问题后，再投入真实微信、Codex 和 Tunnel 环境的端到端验证，项目才具备更稳妥的内测基础。
