# Slack、GitHub 与 IM 入站集成

- 日期：2026-10-19
- 状态：Inbound Integrations v1 已落地
- 目标：让 GitHub、Slack 和通用 IM 的签名事件进入现有 Bot/群聊，并将最终回复送回来源会话，同时保持 DSH 的权限、沙箱和审批边界

## 为什么

原有 GitHub 连接器只有出站工具：DSH 通过 GitHub MCP 向 Bot 提供仓库、issue 和 PR 工具，但没有公开入站 Webhook。Slack 和 IM 也没有连接方式。仅增加 HTTP 处理器还不够：外部事件必须完成签名验证、幂等、目标路由、回复关联和可见状态，否则会出现重放、丢消息、回复错线程或绕过权限的风险。

入站事件不直接执行工具。它只生成一条带 `source.kind = "integration"` 的普通用户消息。目标 Bot 或群聊仍通过已有的 Session、capability、权限、sandbox 和 approval 流程处理它。

## 已定的行为

### 连接模型

- 一个集成连接包含 provider、名称、启用状态、目标 Bot/群聊、事件过滤器、是否回复和最近投递状态。
- 支持三个 provider：`github`、`slack`、`im`。
- 目标必须是一个当前存在的 Bot 或群聊；删除目标时，指向它的连接和投递记录一并删除。
- 密钥只保存在 `secrets.json`，`state.json` 只保存连接配置和安全的投递摘要。
- 固定密钥名：
  - `GITHUB_WEBHOOK_SECRET`
  - `SLACK_SIGNING_SECRET`
  - `SLACK_BOT_TOKEN`
  - `IM_WEBHOOK_SECRET`
  - `IM_OUTBOUND_URL`
  - `IM_OUTBOUND_TOKEN`
- 集成密钥的默认 scope 为空，不进入任何 Bot 的 shell。

### HTTP 入口

- 在现有 `ctx.webServer` 上注册一个前缀路由 `/api/integrations`，不占用浏览器 API 路由 `/api/bot`。
- 实际地址为：
  - `/api/integrations/github/<connectionId>`
  - `/api/integrations/slack/<connectionId>`
  - `/api/integrations/im/<connectionId>`
- 只接受 `POST` 和 `application/json`。未知、停用、目标已删除或缺少密钥的连接表现成 404/503，不泄露配置细节。
- 请求体有大小上限；读取完成后先验证签名，再解析 JSON。
- 响应不等待 Bot 回合完成。202 表示事件已经持久记录并投递到 Session inbox，不表示模型已经回答。

### provider 契约

GitHub：

- 验证 `X-Hub-Signature-256` 对原始请求体的 HMAC-SHA256。
- 要求 `X-GitHub-Delivery` 和 `X-GitHub-Event`。
- 可按事件名和 `owner/repository` 过滤。
- 支持 issue、issue comment、pull request、review、workflow run、check run 和 push 的配置入口。

Slack：

- URL 验证请求返回 `challenge`，但同样先验证签名和时间窗。
- 签名使用 `v0:{timestamp}:{rawBody}`；时间戳超出约 5 分钟即拒绝。
- 以顶层 `event_id` 去重。
- 接受 `app_mention`、直接消息和相关线程消息；忽略 Bot 自己、编辑、删除和其他无关 subtype。
- 回复通过 `chat.postMessage` 发回原频道；原消息在线程中时使用原 `thread_ts`。

通用 IM：

- 要求 `X-DS-Bot-Timestamp`、`X-DS-Bot-Signature` 和投递 id。
- 签名覆盖 `{timestamp}.{rawBody}`。
- 请求 JSON 至少提供会话 id、文本和事件 id；支持 `conversationId`、`threadId`、`user` 和 `text`。
- 出站地址必须是 `https://`，不能带 URL 用户名/密码，也不能指向 localhost、`.local` 或明显的私网地址。
- 回复 POST 为 JSON，包含 `replyTo`、`conversationId`、可选 `threadId` 和 `text`。

### 去重与状态

- 每个连接以 provider delivery id 建立持久收据。
- 收据状态：`received`、`queued`、`completed`、`failed`、`ignored`。
- `received` 在投递前保存；同一 id 的并发或重试不会再次进入 Bot。
- Host 在上次投递完成前重启时，遗留的 `received/queued` 收据标为 `failed`，错误写明重启中断，不自动重放。
- 最近 2,000 条收据用于状态和重放保护；旧记录会滚动删除。
- 页面显示上次投递时间、状态和清洗后的错误，不显示 payload、签名或密钥。

### Bot 与群聊路由

- Bot 目标：消息进入该 Bot 当前私聊 part；DSH 的真实事件顺序是 `turn/start` 先于 `user/message`，两种顺序都能关联。
- 一个回合内合并的多个集成消息会共享该回合的最终回复。
- 群聊目标：消息进入群聊 relay Session，再按现有群规则选择发言人。
- 群聊完整一轮结束后，把成员结果组合为一条 provider 回复；仍在后台工作的成员继续在群聊里发结果。
- 回合失败或停止会向 Slack/IM 返回简短的失败说明，避免来源方一直等待。
- GitHub 只入站通知，不自动回写 issue/PR；需要写操作时仍使用现有 GitHub MCP 工具和正常审批。

### 安全边界

- 外部正文、GitHub payload、Slack 文本和 IM 文本都标记为不可信数据。
- 提示明确要求不得因外部内容泄露密钥、绕过权限或运行无关命令。
- 集成不能扩大目标 Bot 的权限，也不能绕过 sandbox 或 approval。
- Bot 只有只读的 `integration_list`；创建、修改、启停和测试连接只能由用户在设置页完成。
- 不在日志中记录 payload、签名、token、Webhook secret 或出站 URL。

### 界面与可观测性

- Settings → Connectors 同时显示原有 GitHub 出站连接和新的入站集成。
- 连接卡片显示 provider、目标、过滤器、启用开关、Webhook 地址、复制按钮、上次投递和错误。
- 表单输入密钥时使用遮罩字段；已有密钥留空表示保留。
- 1400×900 和 390×844 下无横向溢出；移动端操作按钮保持可点击尺寸。

## 不做什么

- 不复用 DSH `webhookRuntime` 的“创建新的根 Session”动作；它不能把事件送进 DS Bot 团队。
- 不允许 Bot 动态创建公开 HTTP 路由。
- 不让 Webhook 直接调用 shell、Git、MCP、文件或网络工具。
- 不把 provider payload 全量写入 `state.json` 或诊断日志。
- 不承诺跨进程 exactly-once；语义是至少一次到达入口、按 delivery id 幂等投递。
- 不把 Slack Socket Mode、Teams、Discord 或完整 IM SDK 纳入 v1。

## 已知限制

- WebServer 默认通常只监听回环地址；公网接入需要部署方自行配置 TLS 反向代理或隧道。
- Slack 线程内的后续消息是否送达取决于 Slack App 的事件订阅；DS Bot 只处理收到的合法事件。
- 群聊中某个成员在整轮结束后才异步完成时，它的后续结果留在群聊，不再追加第二条 provider 回复。
- 收据去重窗口有限；超出保留数量的极旧重放可能被视为新投递。
- 通用 IM 的出站契约是 DS Bot 定义的最小 JSON，不是某个厂商 SDK 的完整实现。
- 多 Host 共用同一团队时，只有持有写锁的 Host 可以修改连接；只读 Host 可以查看但不能启用或投递新连接。

## 验收

- GitHub 原始体签名、事件/仓库过滤、重复 delivery 和错误签名均有测试。
- Slack challenge、时间窗、签名、重复 event_id 和线程回复均有测试。
- IM 时间戳签名、HTTPS 校验、会话过滤和出站回复均有测试。
- Bot 和群聊目标都能生成 `integration` source，并保持普通工具权限。
- 删除 Bot、群聊或连接会清理相关目标和收据。
- 真实 Web 服务可接收签名 GitHub Webhook，完成 Bot 回合并把收据从 `queued` 更新为 `completed`。
- Settings → Connectors 在桌面与移动视口都能创建、显示和复制集成地址。
