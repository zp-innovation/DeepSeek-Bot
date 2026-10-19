# 沙箱、远程执行与多后端

- 日期：2026-10-19
- 状态：Execution Backends v1 已落地
- 目标：让 Bot 清楚知道自己在哪个执行世界运行，在本地沙箱内完成工作，并能用 Git worktree 隔离高风险或并行任务

## 为什么

编码 Agent 的可靠性不只取决于模型会不会写代码，还取决于它是否知道自己实际拥有多少文件权限、命令在哪里执行、测试结果属于哪个目录。把“本地”“worktree”“远程”混成一个概念会造成错误判断：Bot 可能以为自己在隔离环境中运行，实际却改动了主工作区。

DSH 的 `fs`、`subprocess`、`sandbox`、`shell` 和 `terminals` 属于同一个执行世界。远程 SSH provider 替换的是整套执行世界，而不是单个工具。DS Bot 必须遵守这个边界，不能用一个 `ssh` 命令包装器伪装成远程文件系统。

## 已定的行为

### 执行状态

每个 Bot 可以调用 `execution_status`，只读地报告：

- 当前是本地执行还是 profile 级 SSH 执行；
- 当前工作目录；
- 当前 permission preset、sandbox mode 和 approval policy；
- sandbox provider 实际报告的 `full`、`partial`、不可用或显式绕过；
- 当前 Session 是否已经进入 worktree。

状态探测只解析 sandbox argv，不执行命令。探测失败会如实报告，不能让 Bot 声称沙箱已验证。

### 本地隔离

- 文件写入、shell、PTY、文件搜索和 Git 都继续经过 DSH 的同一套 sandbox provider。
- `workspace-write` 的根目录是 Session 的当前工作目录；`read-only` 禁止写入；`danger-full-access` 明确报告为未应用文件隔离。
- DS Bot 不直接 spawn 本地进程，也不绕过 DSH approval。

### Git worktree 后端

`create_worktree`：

- 从本地 commit、分支或 tag 创建新分支和 checkout；
- 默认位置为仓库内的 `.agents/worktrees/<name>`；
- 创建时禁用 Git hooks、fsmonitor、clean/smudge/process filters；
- 创建成功后通过 `workingDirectory.set()` 进入该目录；
- 不复制 staged、unstaged、untracked 或 ignored 文件；
- 失败时保留已创建的 branch/checkout，并明确报告路径。

`list_worktrees` 只读列出 Git 已注册的 worktree。

上下文换段时，如果当前目录仍位于 Bot 的授权工作目录内，fresh part 会留在当前 worktree，而不是退回主 checkout。用户改变 Bot 的工作目录后，新授权范围优先。

### 远程执行

- 当 DSH profile 以 `dsh-ssh`、`dsh-fs-ssh`、`dsh-subprocess-ssh` 和 `dsh-sandbox-ssh` 替换根执行世界时，DS Bot 的文件、命令、worktree 和持久 shell 都在该远程执行世界中使用。
- `execution_status` 通过是否存在 `ctx.ssh` 报告 profile 级 SSH。
- 远程 profile 只支持 DSH 文档声明的 POSIX 客户端和 POSIX 远端。

## 不做什么

- 不在当前 Web profile 中同时挂载本地与 SSH 两套根执行世界。
- 不提供“每 Bot 一个 SSH provider”的假实现。DSH 尚未提供跨 Session 动态切换整套 provider 的接口；Web 工作区接口也仍假定宿主文件系统可访问。
- 不通过直接调用 `ssh`、`docker` 或 `rsync` 绕过 `ctx.fs`、`ctx.subprocess` 和 `ctx.sandbox`。
- 不自动删除 worktree 或分支。
- 不把容器 CLI 包装成 DSH sandbox；DSH 目前没有容器 provider。

## 已知限制

- worktree 只基于本地 revision，不 fetch、不初始化 submodule、不安装依赖。
- Git filters 被禁用后，LFS 等文件保持指针表示。
- 远程执行是整个 profile 的选择，不是 Bot 级选择。
- 文件沙箱只限制文件效果，不限制网络、进程可见性或主机的信任边界。
- Windows 上没有 DSH SSH 执行世界。

## 验收

- `execution_status` 能区分完整、部分、不可用和显式绕过的文件隔离。
- SSH profile 被报告为 `ssh (profile-managed)`，不会误报为本地。
- `create_worktree` 创建 branch、checkout，并让后续 `repo_status` 读取该 worktree。
- `list_worktrees` 显示新 checkout。
- 上下文换段保留仍在授权范围内的当前目录。
- 所有 Git 写入仍经过 DSH sandbox 和既有的 Git approval 规则。

## 后续

当 DSH 提供按 Agent/Session 动态路由 `fs`、`subprocess`、`sandbox` 和 `workingDirectory` 的稳定接口后，再增加每 Bot 的后端选择，包括 SSH、容器和远程 worktree。届时应新增独立文档，不在当前接口上叠加隐式路由。
