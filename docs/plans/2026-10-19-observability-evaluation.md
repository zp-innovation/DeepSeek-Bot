# 可观测性与场景评测

- 日期：2026-10-19
- 状态：Observability & Evaluation v1 已落地
- 目标：让一次失败能落到具体 Turn、模型调用、工具和审批，并让安全/恢复类场景可以重复运行、比较和发现回归

## 为什么

原有 `diagnostics` 只保存错误和警告，`usage.sqlite` 只保存 Token 用量。两者无法回答“这个失败发生在哪个 Turn、哪个工具、等了多久、是不是模型错误”，也不能验证一次 Skill、提示词、模型或运行时改动是否让已有场景退步。

本地轨迹不能保存提示词、工具参数或密钥。评测也不能直接拿真实 Bot 会话运行，否则会污染长期记忆、触发团队工具或修改工作区。本设计把“观测”和“评测”都放在隔离边界内。

## 已定的行为

### 本地轨迹

- 轨迹写入 `<home>/observability.jsonl`，单文件约 8 MB，超出后轮换为 `.1`。
- 最多保留最近 5,000 条 trace 和 30 天数据。
- 每条 Turn trace 记录：
  - Bot、群聊、Session、Turn；
  - 来源 kind/role（用户、Bot、schedule、automation、integration）；
  - 开始/结束时间、耗时、最终状态；
  - 模型调用次数、Token；
  - 工具调用次数和失败次数；
  - 清洗后的错误 code/message。
- 每条 span 记录：
  - `agent.turn`
  - `model.request`
  - `tool.<name>`
  - `approval.wait`
  - `assistant.message`
  - `handoff.message`
  - `integration.delivery`
  - `automation.delivery`
- 字段命名参考 OpenTelemetry GenAI 语义约定，例如：
  - `gen_ai.operation.name`
  - `gen_ai.provider.name`
  - `gen_ai.request.model`
  - `gen_ai.tool.name`
  - `gen_ai.usage.*`
- 不保存提示词正文、消息正文、工具参数、工具结果正文、审批正文、密钥、签名或 Webhook payload。只保存字符数、字节数、来源摘要和经过脱敏的错误。
- 进程重启时仍为 `running` 的 trace/span 标记为 `interrupted`，错误码为 `RESTART`。
- `observability-export` 返回可下载的 JSON，包含 trace 与 span 记录，供外部采集器转换。

### 指标与告警

- 页面支持最近 24 小时、7 天和 30 天。
- 可按 Bot 过滤。
- 汇总：
  - Turn 数、完成数、成功率；
  - p50/p95 Turn 耗时；
  - 工具调用数、失败率；
  - 模型调用数、错误率、Token；
  - 按 Bot 的 Turn、失败、p95 和 Token；
  - 时间桶趋势。
- 默认阈值：
  - Turn 成功率不低于 90%；
  - 工具失败率不高于 20%；
  - Turn p95 不高于 120 秒；
  - 模型错误率不高于 10%。
- 阈值保存在 `state.json`，Settings → Observability 可以修改。
- 超过阈值时返回结构化 alert，页面用文字和颜色同时显示，不能只靠颜色表达。

### 评测套件

- 一套评测绑定一个目标 Bot，包含 1–20 个 case。
- 每个 case 包含：
  - 名称与 prompt；
  - answer contains / not contains；
  - regex / not regex；
  - required tools / forbidden tools；
  - 最大耗时和最大 Token。
- 正则表达式在保存时验证，非法表达式拒绝保存。
- 每个 case 都创建一个新的 DSH Session，不复用 Bot 私聊或群 Session。
- 评测 Session：
  - 使用目标 Bot 的模型与思考强度；
  - 使用只读权限 preset；
  - 只挂载目标 Bot 的 Skill，不挂载写能力的 MCP；
  - 拒绝 `TEAM_TOOLS`、原始 schedule、goal 与阻塞问题工具；
  - 注入目标 Bot 的名称、角色和 instructions；
  - 结束后无论成功失败都归档。
- 评测运行一次只允许一个，最多保存 20 条 run。
- 每个 run 保存：
  - 套件、Bot、时间、状态、当前 case；
  - 每个 case 的通过/失败、耗时、Token、工具、检查项、错误；
  - 最多 4,000 字符且已脱敏的输出摘录；
  - pass rate 和总耗时。
- 第二次及之后运行会自动与同一套件的上一次完成 run 比较：
  - 通过数变化；
  - 耗时与 Token 变化；
  - 新回归；
  - 新修复。
- Host 在评测中断后重启，遗留 run 标为 `interrupted`，不自动重跑。

### Bot 工具

- `observability_overview`：Main Bot 只读查看最近 Turn/模型/工具健康。
- `eval_list`：Main Bot 只读查看套件和最近通过率。
- 创建、编辑、运行和停止评测只在 Settings → Evaluation 中进行。

## 不做什么

- 不保存完整 prompt 或完整工具轨迹内容。
- 不向外部发送遥测；导出必须由用户主动触发。
- 不让评测 Session 管理 Bots、群聊、密钥、 Goals、schedule 或用户提问。
- 不在评测中挂载目标 Bot 的 MCP 写工具。
- 不承诺并行执行同一评测套件。
- 不把评测当作沙箱逃逸证明；它仍依赖 DSH 的 permission preset。

## 已知限制

- 当前是本地单机观测，不是分布式 Collector；多 Host 不共享一条实时 trace。
- 工具参数只记录字节数，因此详情页能定位工具和失败，但不能重放输入。
- 模型 span 统计依赖 DSH 的 usage chunk；极端 provider 只给 Session 汇总时，模型 span 的 Token 可能不完整。
- 评测只验证文本检查、工具使用和耗时/Token；图像、文件产物和 UI 视觉输出暂不做自动判分。
- Skill 可以进入评测；MCP 暂时排除，避免外部写操作。
- 评测会真实调用模型并消耗 Token。

## 验收

- 单元测试覆盖 Turn/Model/Tool/Approval/Handoff、阈值告警、重启中断、导出和敏感内容不落盘。
- 评测测试覆盖只读 Session、团队工具拒绝、归档、检查项、通过率与回归比较。
- 真实 smoke 能看到 Turn/工具/模型指标，并运行一个通过的真实评测 case。
- Web UI 在 1400 px 与 390 px 下显示 Observability/Evaluation，无横向溢出。
