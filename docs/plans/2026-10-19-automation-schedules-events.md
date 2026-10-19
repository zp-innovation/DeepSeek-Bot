# 定时任务与事件自动化

- 日期：2026-10-19
- 状态：Scheduled Tasks & Event Automations v1 已落地
- 目标：在 DSH 持久调度器之上提供完整任务管理，并增加安全、可观测的事件触发规则

## 为什么

DSH 已经提供持久 schedule domain：支持 one-shot 延迟、绝对时间、固定间隔、每日、每周和 cron，Host 重启后仍存在，并且恢复后只补发最近一次错过的周期任务。DS Bot 原先只使用了其中的创建、列表和删除，缺少编辑、投递历史、分段迁移幂等，也没有“某个事件发生后自动唤醒 Bot”的能力。

事件自动化不能直接代替用户执行工具。否则一条规则会绕过 Bot 的权限、沙箱和审批边界。DS Bot 把事件规则定义为“匹配事件后，向一个 Bot 或群聊投递一条自动化提示”，实际工作仍由普通回合执行。

## 已定的行为

### 定时任务

- 支持 `after` 延迟、`at` 绝对时间、`every` 固定间隔、`daily`、`weekly` 和五字段 Vixie `cron`。
- 所有时间选择器使用 DSH 的严格校验；每日/每周/cron 带显式 IANA 时区，DST 跳过的本地时间不发，重复时间只用较早实例。
- 设置页可以新建、编辑和删除任务；编辑使用 DSH 的 compare-and-set `update`，不是删除后重建。
- 任务保留 DSH 的 id、Session 绑定和投递历史；识别冲突时要求刷新后重试。
- 每次投递可以在“历史”中查看。投递收据表示消息已经持久进入 Session inbox，不表示模型已经完成工作。
- Bot 可使用 `schedule_task_create`、`schedule_task_update`、`schedule_task_delete`、`schedule_task_history`。
- Bot 工具在当前 Bot 私聊中绑定当前私聊 part；在群聊中绑定该群聊的 relay Session，而不是成员隐藏的群 Session。
- Bot 的 Session 隐藏 DSH 原始 `schedule_create/list/update/delete`，统一使用 DS Bot 工具，避免群任务投递到不可见 Session。
- 对话换段迁移任务时，先持久化 move intent，再检查目标 Session 是否已有等价任务；创建、删除任一步崩溃后都可恢复，避免重复 arm。
- 已是 inactive 的 one-shot 不会被迁移后重新启用。

### 事件自动化

- 规则触发源支持：
  - Bot 完成回合；
  - 回合失败；
  - 回合被停止；
  - Bot 请求审批；
  - 定时任务投递；
  - 后台任务完成通知；
  - 用户发送消息。
- 规则可限定一个来源 Bot，并可要求事件文本包含一段不区分大小写的文本。
- 规则目标为一个 Bot 或群聊；投递消息的 source kind 为 `automation`。
- 规则 prompt 支持只读模板变量：`{{rule}}`、`{{event}}`、`{{status}}`、`{{bot}}`、`{{room}}`、`{{text}}`、`{{time}}`、`{{id}}`。
- 模板只做一次替换，不执行 JavaScript，不解析表达式，不递归展开。
- 同一事件 key 每规则只处理一次；每规则有冷却时间，每次事件最多触发 5 条规则。
- 自动化级联深度最多 3；自动化产生的回合即使再次满足同一规则，同一目标的自触发会被拒绝，防止无限唤醒。
- 规则运行前先保存 `running` run record 和事件 key，再投递；成功后写 `delivered`，失败写 `failed`。
- Host 在投递结果写入前退出时，重启后 run 标为 `interrupted`，不会自动重试。该模型优先保证不重复触发，并明确暴露未知结果。
- 普通 Bot 只能查看相关规则；只有 Main Bot 或用户可以通过工具/界面创建、修改、启停和删除规则。
- 事件规则只产生提示回合，不直接调用 shell、Git、MCP、网络或文件工具，也不增加目标 Bot 的权限。

### 可观测性

- 自动化页显示任务的下次运行、最近投递时间和投递历史。
- 事件规则显示来源过滤、目标、冷却、上次运行状态和累计次数。
- 保存最近 300 条自动化 run，页面展示其中最近 100 条中的前 8 条。
- 每条 run 记录规则、事件 kind、event key、目标、开始/结束时间、深度、状态和清洗后的错误。

## 不做什么

- 不复制或修改 DSH schedule domain。
- 不提供任意 webhook、任意文件监听或任意 shell 事件源。
- 不让事件规则直接执行工具动作。
- 不让普通 Bot 创建跨团队事件规则。
- 不承诺事件投递 exactly-once；崩溃窗口显示为 `interrupted`。
- 不自动重放历史事件。

## 已知限制

- DSH schedule 的 Session inbox 写入和任务状态更新是两个持久写；极端崩溃窗口仍可能由 DSH 重复投递同一提醒。
- 事件自动化以 DS Bot 的 `state.json` 保存规则和 run log；它不是独立分布式调度器。
- 事件模板的 `{{text}}` 最多保留 4,000 字符，并作为不可信事件内容处理。
- 事件自动化没有暂停整个团队的全局开关；以单条规则的 enabled 状态控制。
- 群聊用户消息的触发文本来自该用户最新消息；不是整轮对话摘要。

## 验收

- 六种 schedule timing 都能创建；编辑保持任务 id。
- cron、延迟任务、投递历史和设置页编辑可用。
- 换段迁移在目标已有等价任务时不会重复创建。
- 事件规则可匹配回合、审批和用户消息，并正确渲染模板。
- 重复 event key、冷却和自目标级联不会重复唤醒。
- 普通 Bot 不能改动事件规则。
- DSH Agent Session 看不到 DS Bot 自动化工具。
- 自动化 run 在重启后不会永远停留在 `running`。
