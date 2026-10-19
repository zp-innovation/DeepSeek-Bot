# Codex 级单 Agent 编码、终端与 PR

- 日期：2026-10-19
- 状态：Coding Core v1 与 Coding Preset v1 已落地
- 目标：让 DS Bot 的单 Bot 编码能力达到 Codex 级工作闭环，同时保持 DSH 沙箱、审批和权限边界

## 为什么

DS Bot 的差异化是长期 Bot 团队，但团队成员必须先能独立、可靠地完成编码工作。编码闭环不能只依赖一句“你会写代码”，也不能让插件绕过 DSH 直接执行命令。正确方向是复用 DSH 的 shell、sandbox、审批、会话和持久化能力，在其上增加编码工作流。

## 目标

一个 Bot 收到编码任务后，应能稳定完成：

1. 理解仓库和项目规则。
2. 制定可执行计划。
3. 修改代码和配置。
4. 在终端运行测试、lint、构建和诊断。
5. 根据失败输出继续修复。
6. 审查实际 diff。
7. 创建 commit、push 分支、创建或更新 PR。
8. 读取 CI/check 结果并继续修复。
9. 明确报告验证证据和未完成项。

## 不做什么

- 不复制 Codex 的 Rust harness。
- 不绕过 DSH shell、sandbox、permission 和 approval。
- 不在 Bot shell 中暴露 GitHub token。
- 不自动 commit、push 或创建 PR，除非用户明确要求。
- 不 force-push，不重写已推送分支，不跳过 hooks。
- 不让 DSH Agent 或普通 Session 获得团队编码工具。

## 第一版：Coding Core v1

### 常驻编码协议

每个 Bot Session 增加一段编码协议，要求：

- 编码任务先调用 `repo_status`。
- 读取最近的 `AGENTS.md`、`CONTRIBUTING` 和相关项目规则。
- 多步骤任务使用 `todo_write`。
- 修改后运行窄范围检查，再扩大范围。
- 完成前调用 `repo_diff` 审查真实差异。
- 没有命令输出证据就不得声称已验证。

### 新工具

| 工具 | 作用 | 写操作 | 沙箱 |
|---|---|---|---|
| `repo_status` | 仓库根目录、分支、remote、状态、近期提交、diffstat | 否 | 经 DSH shell |
| `repo_diff` | unstaged、staged、branch diff、diffstat、空白检查 | 否 | 经 DSH shell |
| `git_commit` | 暂存明确路径或全部变更并提交 | 是，需审批 | 经 DSH shell |
| `git_push` | 推送当前或指定分支 | 是，需审批 | 经 DSH shell |
| `pull_request` | 查看、创建、更新 PR，读取 checks | create/update 需审批 | GitHub API，token 留在 host |

### 执行边界

- 本地命令通过 `ctx.tools.execute()` 调用当前 Agent 的 `bash` 或 `pwsh` 工具。
- 因此命令继承 DSH 的 sandbox、permission、approval、超时和输出裁剪。
- 插件不直接 `spawn` shell，不直接访问工作目录。
- GitHub 写操作使用 `GITHUB_TOKEN`，仅存在 host 内存和 secrets 文件。
- 所有写操作都通过 DSH approval 服务请求 `allowed-once`。

### Coding Preset v1

Bot Session 默认使用插件自带的 `ds-bot-coding` preset，不再依赖用户当前的默认 preset：

- Windows 挂载 owner-scoped 持久 PowerShell，POSIX 挂载持久 bash；cwd、环境变量、函数和后台任务跨调用保留。
- 保留 DSH 的 persona、项目指令、文件、搜索、jobs、skills、plan mode、todo、compaction、subagent、workflow 和 web 工具。
- preset 不可用时回退到 DSH `standard`，两者都不可用时使用 DSH 默认 preset。
- 编码工具把 shell 超时、shell 退出和转入后台视为未完成，不能误报 commit、push 或 diff 成功。
- 显式路径提交使用 `git commit --only`，不会顺带提交用户原有的其他 staged 变更；`all: true` 才提交全部变更。

### 已验证闭环

- 单元测试覆盖仓库状态、真实 diff、路径逃逸、审批、PR API、超时和 preset 回退。
- DSH smoke 在真实 Git 仓库上调用 `repo_status` 与 `repo_diff`。
- DSH smoke 跨两个模型回合读取同一个持久 shell 的环境变量。
- DSH 会话头确认实际 preset 为 `ds-bot-coding`，非静默回退。

## 后续版本

### Coding Core v2

- 后台命令管理：长测试、dev server、watch mode、日志读取和停止。
- 项目检测：自动识别 Node、Python、Rust、Go、Java 等测试/lint 命令。
- 变更影响分析：根据 diff 推荐最小测试集合。
- 结构化失败解析：测试、lint、typecheck、CI 统一输出。

### Coding Core v3

- Git worktree 隔离：Coding Core v2 已提供 `create_worktree` / `list_worktrees`，见 [沙箱、远程执行与多后端](2026-10-19-execution-backends.md)。
- 检查点与回滚：Checkpoint & Time Travel v1 已提供自动/命名检查点和 DSH Session fork，见 [检查点、恢复与时间旅行](2026-10-19-checkpoints-time-travel.md)；文件级回滚仍保持显式边界。
- 远程执行：Docker、SSH、VM、云 sandbox。
- PR review comment 读取与回复。
- CI watch、失败修复循环和 PR 自动更新。
- Code review 模式：只读审查，输出按严重度排序。

## 验收标准

- Bot 能把“实现一个功能”从仓库检查推进到测试通过和 diff 审查。
- Bot 能在测试失败时读取真实输出并继续修复。
- 用户未要求时不会 commit、push 或创建 PR。
- commit、push、PR 创建前一定出现审批。
- GitHub token 不出现在 Bot shell、工具结果、诊断或日志中。
- 被取消或失败的写操作不会报告成功。
- DSH Agent Session 不出现这些团队工具。

## 测试

- remote URL 解析。
- repo status 输出。
- 路径逃逸和绝对路径拒绝。
- commit 前审批与空暂存保护。
- push 前审批与 remote validation。
- PR create/view/checks 的 API 错误和脱敏。
- Bot Session 协议注入，非 Bot Session 不注入。
- `ds-bot-coding` preset 被 DSH 实际加载，并使用持久 shell。
- 真实 Git 仓库上的 `repo_status`、`repo_diff` 和跨回合持久环境。
