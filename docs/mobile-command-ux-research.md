# 手机端聊天机器人控制交互研究

更新时间：2026-08-20

## 结论

成熟的聊天机器人通常采用“渐进式交互”，而不是要求用户记住完整命令：

1. 用菜单、快捷入口或按钮承载少量高频动作。
2. 用选择器、序号或短表单承载需要上下文的下一步操作。
3. 用自然语言承载目录搜索、模糊匹配和多条件请求。
4. 保留确定性的文本命令作为无 UI、网络异常或自动化场景的兜底。

wecode 当前采用这套分层：纯文本“控制台菜单”和中文短控制词不依赖斜杠；复杂会话操作用“控制：……”显式进入 Control Agent；现有英文/中文斜杠命令保留为最后的故障兜底。只有在确认 iLink 支持稳定的结构化交互回传后，才增加真正的按钮或卡片。

### OpenAI Codex App Server：支持 steer 活动 turn

官方 App Server 协议提供 `turn/steer`，用于把新的用户输入追加到正在执行的活动 turn，并要求客户端带上 `expectedTurnId`；如果没有活动 turn，则应回退到新的 turn 或排队处理。wecode 现在优先使用这条能力，无法确定活动 turn 时再使用本地 FIFO 队列。

- [Codex App Server 官方文档](https://developers.openai.com/codex/app-server/)

## 一手资料观察

### Telegram：命令可发现，键盘负责高频操作

Telegram Bot API 同时提供 BotCommand、ReplyKeyboardMarkup、InlineKeyboardMarkup 和 ForceReply。ReplyKeyboardMarkup 用自定义键盘展示回复选项，InlineKeyboard 的按钮可以携带 callback data，ForceReply 则适合逐步引导用户回复。官方 Bot Commands 文档还把命令作为用户可发现的入口，而不是要求用户完全凭记忆输入。

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram Bot commands](https://core.telegram.org/api/bots/commands)

可借鉴点：

- 高频动作可以有一个“菜单”入口；不需要让用户先输入 `/`。
- 选择会话时，按钮或序号只传递短期选择，不让用户手填内部 ID。
- 多步操作应明确告诉用户下一步要输入什么。

### Slack：快捷入口、按钮、选择器和 Modal 分层

Slack 将快捷方式、slash command 和 Block Kit 交互组件视为不同的入口；按钮、选择菜单和文本输入可以放在消息、Modal 或 App Home 中。官方交互文档还明确支持由一次交互继续触发下一次交互，形成逐步工作流。

- [Slack Interactivity overview](https://docs.slack.dev/interactivity/)
- [Slack Block elements](https://docs.slack.dev/reference/block-kit/block-elements/)

可借鉴点：

- “打开控制台”是入口，“新建/切换/状态”是第一层动作。
- 参数多时不要把参数语法塞进按钮文字，而是进入下一步输入。
- 交互消息必须保留可读的文本 fallback，不能只依赖视觉组件。

### Discord：组件解决选择，Modal 解决多字段输入

Discord 的组件可以在客户端原生渲染按钮、选择菜单和文本输入；Modal 适合确认、故障报告或多字段配置。Application Commands 还支持命令选项和 autocomplete，让用户在输入参数时得到建议。

- [Discord Components & Modals](https://docs.discord.com/developers/platform/components)
- [Discord Application Commands](https://docs.discord.com/developers/interactions/application-commands)

可借鉴点：

- “切换会话”适合先显示候选列表，再选择序号或候选项。
- “新建会话”如果需要目录、模型、速度等多个字段，应拆成连续步骤，而不是要求用户一次记住全部参数。
- 危险动作使用单独确认步骤；按钮或回调只能引用短期、绑定用户的操作 token。

### 飞书：中文 IM 场景的卡片回传模式

飞书官方消息卡片提供按钮、折叠按钮组、列表选择器和日期选择器；交互组件可以通过 value 回传给服务端，服务端根据回传值执行操作或更新卡片。它还区分跳转交互和回传交互，说明“展示”和“执行”可以分离。

- [飞书配置卡片交互](https://open.feishu.cn/document/common-capabilities/message-card/add-card-interaction/interaction-module?lang=zh-CN)

可借鉴点：

- 中文用户更适合看到“新建、切换、状态、停止”这样的结果导向词。
- 回传值应是服务端可校验的短 token，而不是把 thread_id、路径等敏感内部信息直接放进客户端参数。
- 卡片交互要有超时、重复点击和失败回退策略。

## 对当前 wecode 的适配判断

当前仓库的 iLink 适配器实现的是文本入站和文本 `sendmessage` 出站：[src/ilink.ts](../src/ilink.ts)。当前没有结构化按钮、选择器或卡片回调模型。因此，不能直接假设 Telegram、Slack、Discord 或飞书的交互组件可以在 iLink 上工作。

第一阶段应使用纯文本能力实现相同的交互思想：

```text
用户：菜单

wecode：
🧭 会话控制
1. 新建会话
2. 切换会话
3. 查看会话
4. 查看状态
5. 返回上一个
6. 停止任务
7. 取消/解除绑定

回复序号，或直接发送“切换 2”。
```

菜单产生一个短期、按用户绑定的 menu state。只有在菜单状态有效期内，单独的 `1`、`2` 等数字才解释为菜单选择；其他普通文本继续发送给当前 Codex，避免把项目代码或自然语言误判为命令。

## 推荐的 wecode 交互层

### 第一层：无斜杠高频控制词

仅对高置信度的整句或明确前缀做本地解析：

```text
菜单
帮助
状态
会话
返回
停止
取消
```

带参数的操作使用动词开头：

```text
切换 2
切换 <会话 ID>
新建 <目录>
```

“控制：帮我新建一个会话”“控制：找到 web 项目并切换”等复杂表达交给 Control Agent，不把包含“新建”或“切换”的任意自然语言硬解析成本地命令。

### 第二层：菜单和短期选择状态

- `菜单` 返回不超过 7 个高频入口。
- `会话` 返回候选会话和序号。
- 序号只在对应菜单/列表的短 TTL 内有效。
- 选择状态绑定 `userId`、来源消息和过期时间。
- 重复点击或重复发送必须幂等，过期后给出“请重新发送菜单/会话”。

### 第三层：Control Agent

Control Agent 负责目录搜索、模糊匹配、多轮澄清、跨项目查找和复杂参数理解。它不是唯一入口，也不应承担停止、取消、状态、列表等确定性基础能力。

### 执行中的连续输入

如果目标 Codex 正在执行任务，用户可以继续发送普通消息：当前 turn 可控时通过 App Server 的 `turn/steer` 即时追加；如果没有可用的活动 turn ID，则进入按用户维护的 FIFO 队列，并在当前 turn 完成后自动续接。这样保留终端式连续输入体验，同时避免并发 `turn/start` 导致消息乱序。

### 第四层：斜杠兜底

保留 `/new`、`/use`、`/sessions`、`/stat`、`/back`、`/stop`、`/cancel`、`/help` 及中文斜杠别名，直接走本地桥接层。它们用于：

- Control Agent 不可用或卡住时恢复操作。
- 自动化脚本或熟练用户使用。
- 调试消息路由和故障排查。

## 不建议的方案

1. 让所有包含“新建”“切换”“停止”的自然语言都直接命令化：会误伤正常 Codex 开发消息。
2. 只做一个万能 `控制` 命令并把所有后续内容交给模型：失去确定性兜底，也让停止/取消依赖模型。
3. 把完整 thread_id、绝对路径或模型参数直接塞进未来的按钮回调：容易造成越权、过期回调和信息泄露。
4. 只做按钮而不保留文本 fallback：客户端能力、消息过期或交互回调失败时用户会被锁死。
5. 一次展示十几个入口：手机端应优先展示最常用的 5—7 个动作，其余放到“更多帮助”或自然语言。

## 推荐实施顺序

1. ✅ 增加 `菜单`/`操作` 入口和按用户 TTL 的菜单状态。
2. ✅ 增加无斜杠的高置信度中文控制词，并保持当前斜杠命令作为本地兜底。
3. ✅ 将会话列表的序号选择统一成菜单/列表短期状态，避免裸数字在普通会话中误触发。
4. ✅ 为停止、取消、接管确认保留本地确定性路径，并做幂等和过期处理。
5. 只有在获得稳定的 iLink 结构化交互协议后，再实现按钮/卡片适配器；届时沿用同一套命令语义，不改 SessionManager 的核心操作。

当前实现已经落地前四项：用户可以直接发送“菜单”“状态”“切换 2”等短词；复杂会话操作使用“控制：……”交给 Control Agent；`/new`、`/use` 等斜杠命令继续作为故障兜底。
