# Skills、Recipes 与 Plugins

- 日期：2026-10-19
- 状态：Skills / Recipes / Plugins v1 已落地
- 目标：让 Bot 复用可版本化的任务知识与工作流，同时把 profile 级插件权限留在用户手里

## 为什么

DS Bot 原先只有“技能纯文本”和 MCP 能力。它能保存说明，却不能表达完整的 `SKILL.md` 路由元数据、调用策略，也没有带参数的可复用任务流程。另一方面，DSH Profile 插件会影响同一 profile 里的所有 Session；若让任意 Bot 安装插件，等于让一次提示注入获得安装和执行构建脚本的能力。

本阶段把三种概念分开：

- Skill：模型可发现、可按需加载的说明；
- Recipe：用户保存、Bot 按输入展开的任务模板；
- Plugin：由用户管理的 profile 级运行时代码。

## 已定的行为

### Skills

- 共享技能既可以保存普通说明，也可以保存完整 `SKILL.md`。
- `SKILL.md` 必须包含 YAML frontmatter 和正文；支持 `name`、`description`、`whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。
- frontmatter 的 `name` 必须与共享能力名称一致；调用策略严格接受文档列出的布尔写法，非法值拒绝保存。
- frontmatter 优先于表单中的说明、使用时机、元数据和调用策略字段。
- 技能作为 runtime skill 挂载到 Bot 自己的聊天和群聊 Session；模型调用和 `/name` 用户调用遵守 DSH 的 invocation policy。
- 项目 `.dsh/skills`、`.agents/skills` 以及用户级 skill roots 继续由 `ds-bot-coding` preset 的 DSH `skill-filesystem` 发现，不由 DS Bot 复制或接管。
- 技能正文上限为 50,000 字符，元数据上限为 8,000 字符。

### Recipes

- Recipe 有名称、说明、模板、输入定义和 revision；内容变化时 revision 增加，纯读取不会。
- 输入名使用小写字母、数字和下划线；模板使用 `{{input_name}}`，未知、非法或未闭合占位符拒绝保存。
- 一次最多 20 个输入；必填输入缺失时 `recipe_run` 返回明确错误，不会留下半展开内容。
- 输入值只允许文本、数字或布尔值；单个值、总输入和模板都有长度上限。
- 替换是一次性的：输入值里的 `{{other}}` 不会被递归展开。
- Recipe 按 Bot 挂载。`recipe_list` 可读取共享库并显示挂载状态；`recipe_run` 只展开当前 Bot 已挂载的 Recipe。
- `recipe_run` 返回带边界标记的指令内容，不执行命令、不调用模型、不写文件，也不授予新的 shell、sandbox、审批或 Git 权限。
- Main Bot 可管理全部 Recipe；普通 Bot 只能改自己创建且未被其他 Bot 使用的 Recipe。

### Plugins

- 设置页展示当前 DSH Profile 的插件和 bundle 清单，包括启用状态、Fiber phase、版本、官方标记和只读原因。
- 清单是只读快照，默认缓存 15 秒；DSH 发出 `plugin-manager/changed` 后失效，刷新按钮会强制重读。
- Plugin 与 Bundle 明确标为 profile 级：变更影响所有 Session 和 Bot。
- Bot 只获得 `plugin_list` 只读工具；不提供安装、启用、停用、卸载或 package-manager 工具。
- 用户通过 DSH 插件管理界面完成安装和变更；DS Bot 只提供入口和当前状态。

## 不做什么

- 不让 Bot 自主安装或升级 Profile 插件。
- 不运行 Recipe 里的任意 JavaScript，也不把 Recipe 当作脚本引擎。
- 不把共享 Skill 的 `references/`、`scripts/`、`assets/` 自动复制进团队状态。
- 不改变项目/用户 Skill roots 的 DSH 发现优先级。
- 不把 Plugin 清单暴露为 secret、环境变量或 shell 变量读取接口。

## 已知限制

- 共享 Skill 目前只保存正文与解析后的元数据；需要资源文件的技能应放在项目的 `.dsh/skills` 或 `.agents/skills` 中。
- Recipe 直接挂载到 Bot，不参与 MCP/Skill/Pack 的子项展开。
- Recipe 是受控文本展开，不是独立沙箱；它描述的操作仍受 Bot 当前权限和执行后端约束。
- Plugin 清单是运行中 Profile 的观察结果，不替代 DSH 插件管理器的安装详情、构建审批或重启提示。

## 验收

- 完整 `SKILL.md` 保存后，runtime skill 带上 description、whenToUse、metadata 和 invocation policy。
- 非法 frontmatter、名称不一致、缺正文或非法布尔值被拒绝。
- 未挂载的 Recipe 不能运行；缺参数、未知参数和未知占位符都有明确错误。
- Recipe 内容修改递增 revision，删除时从所有 Bot 卸载。
- `TEAM_TOOLS` 包含新工具，DSH Agent Session 全部拒绝。
- Plugin 面板可以刷新清单，且 Bot 工具不会调用任何插件变更方法。
