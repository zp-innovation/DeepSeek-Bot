# 检查点、恢复与时间旅行

- 日期：2026-10-19
- 状态：Checkpoint & Time Travel v1 已落地
- 目标：让 Bot 能回到某个完整对话节点并继续工作，同时保留原分支和不可逆操作的真实边界

## 为什么

长任务需要能在不丢失上下文的情况下回退、比较方案和重试。只保存一句“做过什么”不够：恢复必须来自 DSH 持久 Session 日志中的精确事件位置。文件系统、终端进程和 Git 状态又属于另一个执行世界，不能因为对话回退就假装它们也自动恢复。

DSH 已提供稳定的 Session fork：从一个精确的 inclusive event seq 复制历史，并用合成 closer 关闭未完成 turn。DS Bot 直接使用该原语，不复制或重写 Session 日志。

## 已定的行为

### 自动检查点

- 每个 Bot 自己聊天中的普通 completed turn 结束后，自动保存一个检查点。
- 自动检查点记录 Session id、turn 编号、event seq、创建时间和当时工作目录。
- 每个 Bot 最多保留 30 个自动检查点和总共 50 个检查点；命名检查点优先于自动检查点保留。
- aborted turn 不生成自动检查点。
- 自动检查点只写 DS Bot 状态，不向 Session 注入额外消息。

### 命名检查点

`checkpoint_create`：

- 保存当前会话最后一个完整 turn；
- 可设置短标签；
- 同一个 Session/seq 的手动检查点会升级已有自动检查点，而不是重复保存。

`checkpoint_list` 按创建时间倒序列出 ID、标签、turn、seq 和来源。

### 时间旅行

`time_travel`：

- 只允许在 Bot 自己的聊天中使用；
- 只在用户明确要求回到历史时使用；
- 根据检查点的 Session id 和 event seq 调用 DSH `sessionController.fork`；
- fork 在新分支中继承检查点之前的完整对话；
- 当前 turn 结束后，新 fork 才成为 Bot 的当前对话；
- 原当前 Session 保留为 earlier branch，并记录 `reason: "time-travel"` 和 checkpoint id；
- 新分支重设标题、permission preset、模型和 Bot capabilities；
- 一个 Bot 同时只能有一个等待切换的 time-travel branch。

待切换分支持久化在 Bot 状态中。DS Bot 重启后会检查源 Session：源 turn 已不运行则完成切换，源对话已变化则归档孤立 fork。

## 恢复边界

- 对话、工具调用和工具结果由 DSH Session fork 精确恢复。
- fork 会为继承前缀中未闭合的工具步骤补上 DSH 的 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 结果，提醒模型不要盲目重试有副作用的操作。
- 文件、Git index/worktree、终端进程、后台任务、端口和外部服务状态不会被回退。
- 模型必须用 `repo_status`、`repo_diff`、`execution_status` 或实际命令验证当前文件状态，不能声称“全部恢复到过去”。
- 需要文件隔离时使用 Git worktree；需要进程隔离时使用新的 Session 或远程/profile 执行世界。

## 不做什么

- 不就地删除 Session 事件。
- 不覆盖原分支。
- 不复制或修改 DSH fork 实现。
- 不在 group Session 中提供 Bot 私有检查点。
- 不自动 reset、checkout、stash 或删除用户文件。
- 不提供 Session tree UI；当前通过对话工具创建、浏览和进入分支。

## 已知限制

- 检查点元数据存放在团队 `state.json`，每个 Bot 最多 50 条。
- 时间旅行在工具调用所在 turn 结束后才切换，因此当前 turn 的最后回复属于旧分支。
- 文件状态没有快照，不能等同于 VM/容器 checkpoint。
- 历史 Session 已损坏、迁移失败或存储不可读时，fork 会按 DSH 错误拒绝。

## 验收

- completed turn 后自动出现检查点。
- 手动检查点可列出并通过 label 或 ID 找到。
- DSH fork 使用保存的 exact seq。
- 当前 turn 结束后 Bot 切到 fork，旧 Session 留在 segments。
- 新分支能继续接收用户消息。
- 重启后待切换分支不会永久悬挂。
- 工具结果和文档都明确说明文件没有回滚。
