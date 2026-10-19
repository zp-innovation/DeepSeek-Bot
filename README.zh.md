<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DeepSeek Bot" width="260">
  </picture>
</p>

# DeepSeek Bot

[English](README.md) | 中文

![版本](https://img.shields.io/badge/版本-v0.1_预览-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

DeepSeek Bot（简称 DS Bot）是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh）的 bot 插件，插件将 dsh 改造为 bot 形式。你可以与自己创建的 bot 交流、工作。

![和 Chief 说一句话，它就把 bot 和群聊建好](docs/images/team.zh.png)

## 安装

先装好 dsh，并在 dsh 里配好至少一个模型。ds bot 直接使用 dsh 里的模型。

**dsh Desktop（Windows、macOS）**

1. 侧栏点 **插件** → **添加插件**。
2. **包名或地址** 填 `ds-bot`。在中国大陆，**安装源** 选 **中国大陆镜像源**。
3. 点 **安装**，再点 **立即启用**。如果提示“下次启动生效”，完全退出 dsh 再打开。

连不上 npm 时，第 2 步也可以填 [Releases](https://github.com/Fei2411/DeepSeek-Bot/releases) 里下载的 `ds-bot-0.1.7.tgz` 的完整路径，或者 `github:Fei2411/DeepSeek-Bot#v0.1.7&path:/ds-bot`（需要装 Git）。

**dsh Web（Windows、macOS、Linux）**

需要 Node.js `22.19` 以上和 pnpm。

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

**Docker（NAS、Linux 服务器）**

[`docker/`](docker/) 目录构建一个带 dsh Web 和 DS Bot 的镜像，适合 NAS 或其他常开的机器。容器就是 bot 的沙箱：bot 对挂进容器的目录有完全权限，其他的碰不到。见 [`docker/README.md`](docker/README.md)（英文）。

## 配置

我强烈建议你直接通过和 bot 对话来配置其他 bot 和群聊。

## 功能

### Bot

你可以在一个窗口中和一个 bot 完成所有对话和工作，你无需担心背后的上下文问题。你可以在 bot 详情页查看 bot 信息，也可以为 bot 选择你想使用的模型。你可以随时切换模型，但我仍然建议你为一个 bot 长期保持一个模型，仅在真正必要的时刻切换。

另外，bot 拥有记忆，它会记住你的喜好并在下次的工作中应用。你可以在 bot 的详情页管理记忆，也可以直接和 bot 对话来进行管理。

![bot 详情页：模型、记忆、用量](docs/images/details.zh.png)

### 编码

普通 bot 也可以在自己的文件夹里完成编码任务：检查 Git 仓库、制定计划、修改文件、通过 dsh shell 运行测试和检查、审查真实 diff，并在你要求时 commit、push，或创建和更新 GitHub PR。每个 bot 的聊天使用专用编码 preset 和持久 PowerShell 或 bash shell，因此工作目录、环境变量和后台任务能跨工具调用保留，同时沙箱和审批仍由 dsh 管理。Bot 可以用 `execution_status` 查看真实的执行策略，用 `create_worktree` 隔离高风险工作，也可以从自动或命名检查点通过 `time_travel` 打开新的对话分支。检查点只恢复对话历史，不会回滚文件和进程。`repo_status` 和 `repo_diff` 只读。`git_commit`、`git_push` 和 PR 修改会请求你批准。GitHub token 只留在宿主进程里，不会进入 bot 的 shell。

### Main bot

这个 bot 作为你的 chief，它拥有非常高的权限，可以管理其他 bot 和群聊。第一次进入 ds bot 时，默认会有一个 main bot 叫 Chief。你可以直接和它对话，让它引导你完成配置。

总之，有问题，找 main bot。

### 群聊

ds bot 拥有群聊功能。群聊是非常好的多 bot 协作方式，但它会带来非常明显的费用问题。ds bot 为此特意做了优化：在一个群聊中，你需要设置一个管理员。你的消息默认由管理员回复，它会帮你调用其他 bot。你也可以直接 @ 你需要沟通的 bot，它会直接回应你：输入 @，从列表里选 bot 就行。想让 bot 参考另一段对话，点输入框的 + → 引用对话。

任何 bot 都可以用 @ 把活派给另一个 bot。接活的 bot 自己去做，群聊照常进行。它干活时会在群里同步进度，群聊、侧边栏和它自己的聊天里也能看到它在做什么。做完后，它把结果发到群里，由派活的 bot 接着回应。要停下它的工作，打开群聊详情。

![群聊：管理员 Chief 把活派给写手和程序员](docs/images/group.zh.png)

### 能力

设置 → **能力** 是团队共享的 MCP 服务、技能、能力包和参数化配方。技能既可以是带路由元数据和 DSH 调用策略的完整 `SKILL.md`，也可以是普通说明。配方只会把具名输入展开成可复用指令，不执行代码，也不会增加额外权限。在 Bot 设置中启用能力或配方后，从该 Bot 下一条消息开始生效，也适用于它参与的群聊。Bot 添加的本地 MCP 命令需要你先批准才能运行。有其他 Bot 在用的能力或配方，只有你或主 Bot 能修改、删除。

设置 → **插件** 只读展示当前 DSH Profile 的插件和插件包。插件是配置级能力，变更会影响所有 Session 和 Bot；安装、启用和卸载仍由 DSH 自己的插件管理界面完成。

### 自动化

设置 → **自动化** 管理持久定时任务和事件触发提示。定时任务支持一次延迟、绝对时间、固定间隔、每日/每周墙钟时间和五字段 cron，可指定时区并查看投递历史。长对话换到新 Session 时，活跃任务会一并迁移，不会重复 arm。

事件自动化可以响应回合完成、失败或停止、审批请求、定时任务投递、后台任务完成和用户消息。规则可以按来源 Bot 和文本过滤，然后向一个 Bot 或群聊发送提示。去重、冷却、级联深度上限和持久化运行记录用于防止循环并暴露失败。规则不会直接执行工具：产生的回合仍受目标 Bot 原有沙箱、权限和审批约束。

### 集成

设置 → **连接器** 可以添加 GitHub、Slack 和通用 IM 的签名入站集成。每个连接选择一个 Bot 或群聊，并可按 GitHub 事件与仓库、Slack 事件与频道、IM 会话过滤。外部事件作为不可信用户消息进入，因此目标仍使用原有模型、能力、权限、沙箱和审批。

GitHub 使用原始请求体的 HMAC 和 `X-Hub-Signature-256`；Slack 验证带时间戳的签名，并把回复发回原线程；通用 IM 使用带时间戳的 HMAC 和 HTTPS 出站 Webhook。delivery id 会在开始工作前保存，所以供应商重试不会重复创建回合。连接卡片显示入口地址、上次投递和清洗后的错误。公网 Webhook 需要自备 TLS 反向代理或隧道，因为 dsh Web 默认只监听回环地址。

### 可观测性与评测

设置 → **可观测性** 会把每个回合与模型调用、工具、审批和 Bot 交接串起来，并显示耗时、Token、失败和本地 OpenTelemetry 风格导出。它只记录元数据，不保存提示词、工具参数、消息正文或密钥。你可以配置成功率、耗时、工具失败和模型错误阈值，超过时页面会直接提示。

设置 → **评测** 会在全新的只读 Session 中重复运行场景套件。用例可以检查文本、正则、必需或禁止使用的工具、耗时和 Token 预算。团队管理、调度、Goal 和阻塞提问工具会被禁用，MCP 不会挂载，临时 Session 结束后立即归档。每次结果会与上一次运行比较，让提示词、模型、Skill 或运行时改动造成的回归在发布前暴露出来。

### 用量

在 设置 → 用量 里，可以按时间、按 bot、按模型查看 Token 用量。

![用量页](docs/images/usage.zh.png)

## 数据

所有数据都在你自己的电脑上，在 dsh 主目录（默认 `~/.dsh`）的 `bot/` 和 `sessions/` 里。卸载插件不会删除这些数据。

## 开发

插件源码在 [`ds-bot/`](ds-bot/)。配置项和内部结构见 [`ds-bot/README.md`](ds-bot/README.md)，开发、测试和协作方式见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：ds bot 建在 dsh 的插件系统上。每个 bot 都在 dsh 会话里工作，用的是 dsh 的工具和模型。
- [esbuild](https://esbuild.github.io/)：用来打包插件的界面代码。
- 感谢下面这些项目公开的设计思路。ds bot 参考了它们的思路，没有使用它们的代码：
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo)：bot 记忆的 Markdown 格式。
  - [OpenAI Codex](https://github.com/openai/codex)：压缩时把用户原话留在摘要旁边，以及搜索聊天记录用的消息锚点。
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮流发言和 @ 接力。
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) 和 [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：每个成员在每个群里一个会话，以及交接时带上用户之前的原话。
  - [OpenCode](https://github.com/sst/opencode)、[goose](https://github.com/block/goose)、[pi](https://github.com/badlogic/pi-mono)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)：长对话什么时候压缩，交接笔记写哪些内容。
  - [obelisk](https://github.com/tommy0103/obelisk)：用 SQLite 全文索引搜索聊天记录。
- 每一位试用 ds bot、提问题、报 bug 的人。

## 许可

[Apache License 2.0](LICENSE)。按“原样”提供，不附带任何担保。用到的第三方代码和它的许可见 [NOTICE](NOTICE)。

## 声明

ds bot 是独立的社区项目，**不是 DeepSeek 官方产品**，与 DeepSeek 没有隶属、认可或赞助关系。“DeepSeek”“DeepSeek Harness”等名称是各自所有者的商标，这里只用来说明本插件和什么一起用。

bot 会消耗你自己的模型额度，也会按你的要求读写文件、运行命令。重要的操作请自己检查。
