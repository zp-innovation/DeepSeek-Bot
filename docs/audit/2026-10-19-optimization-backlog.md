# DS Bot 源码优化待处理清单

- 日期：2026-10-19
- 基线：`main`，提交 `e13bc34`
- 范围：`ds-bot/index.js`、`ds-bot/src/host/`、`ds-bot/src/client/`、构建与发布配置
- 性质：源码审计后的待处理文档，不是已定设计；改变既定行为的项目仍需维护者确认

## 结论

当前工程质量基础较好：635 个测试全部通过，行覆盖率约 91.49%，`npm audit` 未发现已知漏洞。现阶段最需要处理的不是继续堆功能，而是收紧权限边界、替换不可靠的自定义状态锁、建立崩溃一致性，并把仓库从上游 fork 的发布配置中解耦。

## 优先级

| 级别 | 含义 |
|---|---|
| P1 | 会造成权限绕过、数据损坏、错误发布或安全事故，应在扩大使用范围前处理 |
| P2 | 会造成性能退化、重复执行、兼容性风险或维护成本上升，应排入近期迭代 |
| P3 | 改进项，可在稳定迭代中逐步完成 |

## 总览

| ID | 级别 | 状态 | 工作项 |
|---|---|---|---|
| P1-01 | P1 | 待处理 | 修复 `state.lock` 的 TOCTOU 竞态 |
| P1-02 | P1 | 待处理 | 收紧 MCP 能力的创建、网络和密钥权限 |
| P1-03 | P1 | 待处理 | 建立崩溃一致的状态与执行检查点 |
| P1-04 | P1 | 待处理 | 将 fork 的仓库、发布和更新元数据解耦 |
| P2-05 | P2 | 待处理 | 密钥 scope 改为 fail-closed，并最小化 shell 注入 |
| P2-06 | P2 | 待处理 | 强化不可信网页内容与敏感字段隔离 |
| P2-07 | P2 | 已完成 | 让定时任务迁移具备幂等性 |
| P2-08 | P2 | 待处理 | 移除主线程同步 I/O 和全局串行记忆队列 |
| P2-09 | P2 | 待处理 | 去掉对 DSH compaction 内部引擎的直接修改 |
| P2-10 | P2 | 待处理 | 增加状态 schema 校验与工具契约类型 |
| P2-11 | P2 | 待处理 | 改为事件驱动推送，并增加并发与成本预算 |
| P2-12 | P2 | 已完成 | 增加分布式追踪、指标和场景级评测 |
| P3-13 | P3 | 待处理 | 收紧 Node 与 DSH 的兼容范围 |
| P3-14 | P3 | 待处理 | 补齐安全敏感模块的针对性测试 |

---

## P1-01 修复 `state.lock` 的 TOCTOU 竞态

**问题**

清理过期锁时先读取 token，再按路径删除文件，两步不是原子操作。另一个进程可以在两步之间写入新的 owner token，随后被当前进程删除。锁文件不可用时，当前实现还会继续写状态，进一步扩大并发写风险。

**源码证据**

- `ds-bot/src/host/home-lock.js:74-84`：读取 `current` 后执行 `unlinkSync(path)`。
- `ds-bot/src/host/store.js:44-49`：锁不可用时只警告，随后仍允许保存。
- `ds-bot/test/home-lock.test.js:65-89`：现有测试只覆盖“读取期间换主”，没有覆盖“读取后、删除前换主”。

**已完成验证**

使用临时脚本在 `unlinkSync` 前注入新 owner token，复现了以下结果：

```json
{"injected":true,"finalToken":"<当前进程 token>","newOwnerLost":true,"lockOwns":true}
```

**建议方案**

1. 短期：不再用“读 token + unlink”清理过期锁；使用操作系统文件锁，或让 SQLite 事务成为唯一写入口。
2. 过渡期：将锁升级为带 generation 的租约文件，使用原子 rename/CAS 语义，删除前再次校验文件内容与 mtime。
3. 锁不可用时默认只读，禁止继续写 `state.json`；只有用户显式允许“不安全单机模式”时才可继续。
4. 增加多进程压力测试：两个以上进程反复争抢、过期、心跳和释放锁。

**验收标准**

- 任意并发时序下，同一时刻最多一个写者。
- 读取后、删除前换主的竞态测试通过。
- 锁不可用时不发生无锁写入。
- 旧锁、崩溃残留锁、跨主机过期锁都有回归测试。

**测试**

- `test/home-lock.test.js`：新增 TOCTOU、多进程竞争和不可用锁测试。
- `test/store.test.js`：新增无锁时拒绝写入、只读恢复和接管测试。

---

## P1-02 收紧 MCP 能力的创建、网络和密钥权限

**问题**

任意 Bot 都可以创建新的共享能力。HTTP MCP 自动视为已批准，且没有限制目标地址。能力配置会原样返回客户端，`$DSH_SECRET_*` 会按 Bot 权限解析并发送给 MCP 服务。结果是只读 Bot 也可能新增远程 MCP、访问内网服务或把可用密钥发送到攻击者控制的地址。

**源码证据**

- `ds-bot/src/host/tools.js:648-677`：`save_capability` 对所有 Bot 开放。
- `ds-bot/src/host/capabilities.js:84-118`：新能力没有创建者权限检查；HTTP MCP 设置 `approved: true`。
- `ds-bot/src/host/capabilities.js:232-237`：`libraryView` 返回原始 `env` 和 `headers`。
- `ds-bot/src/host/capabilities.js:250-266`：解析并注入 MCP 密钥。

**建议方案**

1. 新能力默认进入 `pending`，由用户或 Main Bot 批准后才可挂载。
2. HTTP MCP 也必须审批；至少限制为 HTTPS，默认禁止 localhost、私有网段、链路本地地址和云元数据地址。
3. 能力绑定 `createdBy`、`scope`、`audience` 和 `serverOrigin`，Bot 只能创建或修改自己作用域内的能力。
4. 密钥引用必须显式绑定到 capability 和 origin；禁止在 `headers`、`env` 中保存明文密钥。
5. `libraryView` 只返回脱敏后的配置，不返回原始 header/env 值。
6. MCP 工具调用继承 Bot 的 permission preset，并增加网络 egress 策略。

**验收标准**

- 只读 Bot 无法创建或挂载未经批准的能力。
- 非 Main Bot 无法修改其他 Bot 使用中的能力。
- HTTP MCP 不能访问未批准的私网地址。
- 错误日志、客户端状态和诊断中不出现密钥。
- 能力审批、拒绝、撤销和删除都有测试。

**测试**

- 新增 capability 权限矩阵测试。
- 新增 SSRF 目标测试：localhost、RFC1918、169.254、IPv6 本地地址、重定向。
- 新增明文密钥拒绝和脱敏测试。

---

## P1-03 建立崩溃一致的状态与执行检查点

**问题**

`state.json` 是整体重写，迁移只修复部分字段；`inflight.json` 明确使用原地写，可能在崩溃时留下半写文件。进程崩溃、断电或网络盘异常时，状态和执行记录可能丢失或损坏。

**源码证据**

- `ds-bot/src/host/store.js:100-118`：只修复 `agents`、`capabilities` 等部分字段。
- `ds-bot/src/host/store.js:273-309`：每次保存整体序列化并重写状态。
- `ds-bot/src/host/resume.js:70-77`：为避免 Windows rename 问题，原地写 `inflight.json`。
- `ds-bot/src/host/resume.js:37-44`：读取失败时静默返回空记录。

**建议方案**

1. 将团队状态、工作图、问题、定时任务和 handoff 迁移到 SQLite WAL。
2. 使用事务写入业务变更，使用 append-only event/outbox 表记录跨模块事件。
3. 为 turn、delivery、schedule、handoff 和 capability mount 增加幂等键。
4. 引入 schema version、逐字段校验和可回滚迁移。
5. 写入时执行 `fsync`，并为关键表保留可恢复快照。
6. 在测试中注入“写入一半崩溃”“rename 前崩溃”“WAL 恢复”等故障。

**验收标准**

- 任意时刻断电后，数据库可恢复到最后一个完整事务。
- 不再存在静默清空 `inflight` 的路径。
- 同一 exchange、schedule 或 handoff 不会因重试重复执行。
- 迁移失败时保持原数据只读，不自动覆盖。

**参考**

- LangGraph checkpoint/persistence
- Temporal durable execution、Activity idempotency

---

## P1-04 将 fork 的仓库、发布和更新元数据解耦

**问题**

GitHub API 已确认 `zp-innovation/DeepSeek-Bot` 是 `Fei2411/DeepSeek-Bot` 的 fork。但 package、更新检查、反馈链接、README 和发布工作流仍指向上游。若该 fork 作为独立产品发布，更新会检查上游 release，npm Trusted Publishing 也会因 owner/repository 不匹配失败。

**源码证据**

- `ds-bot/package.json:14-21`：homepage、bugs、repository 均指向 Fei2411。
- `ds-bot/src/host/diagnostics.js:19`：Issue 链接指向上游。
- `ds-bot/src/host/update.js:98-108`：更新检查从 package repository 推导仓库。
- `.github/workflows/release.yml:8`：Trusted Publisher 注释固定为 Fei2411。
- `README.zh.md:28`：安装地址指向上游。

**建议方案**

1. 明确项目归属：继续作为上游 fork，还是转为独立产品。
2. 如果独立发布，统一替换以下位置：
   - `package.json` 的 homepage、bugs、repository。
   - README、CONTRIBUTING、CHANGELOG 链接。
   - diagnostics、feedback、update checker 的仓库地址。
   - Docker OCI label、NOTICE 和发布工作流。
   - npm Trusted Publisher 的 owner/repository。
3. 如果继续跟随上游，明确标注 fork，并禁止向上游发布或自动更新到错误渠道。
4. 增加 CI 检查：仓库元数据必须与 `origin` 或配置的 canonical repository 一致。

**验收标准**

- 安装、更新、反馈和 release 全部指向同一个 canonical 仓库。
- `release.yml` 的 OIDC 配置与 npm 发布目标一致。
- README 与 package 元数据不再混用两个 owner。

---

## P2-05 密钥 scope 改为 fail-closed，并最小化 shell 注入

**问题**

密钥文件中的非法 `scope` 会默认成 `all`；每条 shell 命令都会注入该 Bot 可用的全部密钥，而不是只注入命令实际引用的密钥。密钥文件本身也是明文 JSON。

**源码证据**

- `ds-bot/src/host/secrets.js:121-132`：非法 scope 回退为 `all`。
- `ds-bot/src/host/secrets.js:476-491`：所有可用密钥都进入 shell 环境。
- `ds-bot/src/host/secrets.js:143-160`：明文写入 `secrets.json`。

**建议方案**

1. 非法或缺失 scope 时视为无权限，并记录诊断。
2. shell 只注入命令中显式引用的 `DSH_SECRET_*`，或改为短期 secret broker。
3. Windows 使用 DPAPI/凭据管理器，macOS 使用 Keychain，Linux 使用 Secret Service；无法使用时明确告警。
4. 增加密钥访问审计：谁、何时、为哪个工具、访问了哪个密钥。
5. 禁止在 MCP 配置和 state 中保存明文密钥。

**验收标准**

- 损坏的 scope 不会授予任何 Bot 权限。
- `env` 不再默认包含未引用密钥。
- 密钥文件不以可直接读取的明文长期保存。

---

## P2-06 强化不可信网页内容与敏感字段隔离

**问题**

网页内容以普通文本进入模型，只依赖提示词要求“视为数据”。敏感字段识别不完整，完整 URL 可能携带 token 或用户信息。该模块是安全敏感路径，但覆盖率只有约 8%。

**源码证据**

- `ds-bot/src/host/browser.js:173-175`：页面内容进入模型，仅附带“treat as data”说明。
- `ds-bot/src/client/read-page.js:41-44`：敏感字段只检查 `type`、`autocomplete`、`name/id`。
- `ds-bot/src/client/read-page.js:93`：非敏感字段值直接输出。
- `ds-bot/src/client/read-page.js:317-328`：完整 `location.href` 进入页面结果。

**建议方案**

1. 给所有外部内容加来源标签和信任级别：`web`、`file`、`mcp`、`issue`、`chat`。
2. 对不可信来源触发的写操作、网络请求、密钥读取和跨 Bot 委派要求审批。
3. 扩展敏感字段识别：`aria-label`、`placeholder`、label 文本、`inputmode`、常见 OTP/PIN/CVV/card 字段。
4. URL 输出前移除 userinfo、敏感 query/fragment 参数。
5. 增加提示注入语料和 DOM 结构语料测试。

**验收标准**

- 常见 OTP、PIN、卡号字段不会被读取值。
- 带 token 的 URL 不会原样进入模型上下文。
- 外部内容触发的敏感工具调用需要审批。
- 安全敏感的 `read-page.js` 覆盖率达到可接受阈值。

---

## P2-07 让定时任务迁移具备幂等性

**状态**：已完成。当前实现先持久化 move intent，再检查目标 Session 的等价任务；重启恢复会补齐或清理残留，且不会重新 arm 已投递的一次性任务。详见 [定时任务与事件自动化](../plans/2026-10-19-automation-schedules-events.md)。

**问题**

会话分段时，定时任务采用“先创建新任务，再删除旧任务”。中途崩溃或删除失败会留下两个相同任务，导致重复执行。

**源码证据**

- `ds-bot/src/host/schedules.js:129-147`：`create` 成功后才 `delete`。

**建议方案**

1. 为迁移生成稳定的 `migrationId` 或 `idempotencyKey`。
2. 新任务创建前检查同一 key 是否已存在。
3. 使用事务或 outbox 记录迁移状态。
4. 删除失败时进入可重试队列，而不是只记录警告。

**验收标准**

- 在 create 后、delete 前崩溃，重启后不会产生第二个任务。
- 重复执行迁移不会重复创建任务。
- 迁移失败可恢复、可观测、可重试。

---

## P2-08 移除主线程同步 I/O 和全局串行记忆队列

**问题**

记忆模块在主线程使用同步文件读写；FTS5 和 Usage 使用同步 `DatabaseSync`；所有 Bot 的记忆整理共用一个全局 Promise 链。Bot 数量和历史规模上升后，会阻塞事件循环并造成排队。

**源码证据**

- `ds-bot/src/host/memory.js:429-451`：同步读取和目录遍历。
- `ds-bot/src/host/memory.js:689-700`：同步写入快照。
- `ds-bot/src/host/chat-index.js:103-125`：主线程同步 SQLite。
- `ds-bot/src/host/usage.js:134-192`：主线程同步 SQLite。
- `ds-bot/src/host/memory.js:1316-1337`：全局 `reviewChain`。

**建议方案**

1. 将记忆文件 I/O 改为异步队列，或迁移到 SQLite。
2. 将 FTS 索引、Usage 扫描和批量聚合移入 worker thread。
3. 记忆整理改为“按 Bot/群作用域串行、不同作用域并行”的调度器。
4. 增加背压、公平队列和最大并发限制。
5. 对大历史、大团队做基准测试。

**验收标准**

- 长历史扫描期间主线程事件循环延迟保持可控。
- 一个 Bot 的慢记忆整理不会阻塞其他 Bot。
- 团队规模扩大时 CPU 和内存有明确上限。

---

## P2-09 去掉对 DSH compaction 内部引擎的直接修改

**问题**

`parts.js` 直接替换共享 compaction 引擎的方法。该做法依赖 DSH 内部对象结构和插件加载顺序，与仓库“绝不 patch DSH”的规则冲突。

**源码证据**

- `ds-bot/src/host/parts.js:201-240`：替换 `compactIfNeeded`、`compactNow`、`compactRegion`、`summarize`。

**建议方案**

1. 优先向 DSH 请求正式扩展点：按 Session 禁用自动压缩、注入自定义 checkpoint。
2. 在正式扩展点出现前，将兼容层集中到单一 adapter，并做能力探测和版本校验。
3. 启动时检测多个插件同时修改同一引擎，给出明确诊断。
4. 将兼容层加入 `docs/plans/2026-10-13-dsh-concessions.md`，记录代价和退出条件。

**验收标准**

- DSH 升级或插件顺序变化时，失败可诊断且不会静默破坏压缩。
- 兼容逻辑有独立测试和版本门禁。
- 正式扩展点可用后可以删除该层。

---

## P2-10 增加状态 schema 校验与工具契约类型

**问题**

状态文件只检查 `version`，`bots`、`rooms`、`exchanges`、`works`、`questions` 等字段没有统一校验。源码约 2.4 万行 JavaScript，没有类型检查。损坏或手改状态可能导致 `Object.values(null)` 之类的启动崩溃。

**源码证据**

- `ds-bot/src/host/store.js:89-118`：只验证 version，并只修复部分字段。
- `ds-bot/src/host/store.js:101-102`：直接 `Object.assign` 外部 JSON。
- `ds-bot/src/host/tools.js`、`groups.js`、`turns.js`：大量跨模块结构通过 `rt` 动态约定。

**建议方案**

1. 为 `state.json`、`inflight.json`、`secrets.json` 和 capability 配置定义 JSON Schema。
2. 在加载、迁移和保存前统一校验，失败时进入只读恢复模式。
3. 使用 JSDoc + `checkJs`，或逐步迁移到 TypeScript。
4. 为 `rt` 的跨模块契约定义接口，减少字符串键和隐式依赖。
5. 引入属性测试和 fuzz 测试覆盖迁移与损坏输入。

**验收标准**

- 任意字段为 null、数组、错误类型时不会导致未处理异常。
- schema 迁移失败不会覆盖原文件。
- 新增跨模块 API 必须经过类型检查。

---

## P2-11 改为事件驱动推送，并增加并发与成本预算

**问题**

客户端前台每 1.5 秒轮询一次，隐藏时每 10 秒一次。服务端每次仍计算并序列化 live 状态。当前也没有全局并发、token 或成本预算，只记录 Usage，不阻止失控工作流。

**源码证据**

- `ds-bot/src/client/index.js:172-187`：固定间隔轮询。
- `ds-bot/src/host/channel.js:110-116`：每次 state 请求都计算 live 视图。
- `ds-bot/src/host/usage.js`：只记录用量，没有预算拦截。

**建议方案**

1. 使用 SSE/WebSocket 推送 revision 和事件，轮询只作为降级路径。
2. 增加全局、每 Bot、每群和每工作的并发上限。
3. 增加 token/费用预算和熔断：达到阈值后暂停并通知用户。
4. 对 Bot 消息、群轮次和 handoff 增加公平队列与背压。
5. 将 live 视图按订阅粒度拆分，避免每次返回完整快照。

**验收标准**

- 多窗口空闲时没有高频重复请求。
- 单个失控 Bot 不会无限消耗团队额度。
- 并发上限和预算触发时有明确 UI 状态和恢复入口。

---

## P2-12 增加分布式追踪、指标和场景级评测

**状态：已完成（2026-10-19）**

**问题**

当前只有本地 diagnostics 日志，缺少统一的 turn、tool、MCP、handoff trace 和指标。单元测试覆盖率高，但缺少安全、崩溃恢复、长时运行和多 Agent 场景评测。

**源码证据**

- `ds-bot/src/host/diagnostics.js`：仅保存错误和警告。
- CI 只运行单元测试、leak scan 和 Docker；未运行覆盖率阈值、smoke、Web UI 或 Desktop 测试。

**建议方案**

1. 按 OpenTelemetry GenAI 语义约定增加 trace/span：
   - agent turn
   - model request
   - tool execution
   - MCP mount/call
   - handoff
   - approval
2. 增加指标：turn 延迟、工具失败率、MCP 连接失败率、token、成本、队列长度、重启恢复次数。
3. 增加场景级评测：
   - 提示注入
   - 多 Bot 循环与预算
   - 崩溃恢复
   - 大团队和大历史
   - 权限矩阵
4. 在 CI 中加入覆盖率阈值和关键安全回归测试。
5. 在 Linux 上运行 Web smoke 和截图测试；Desktop 可做夜间任务。

**验收标准**

- 每次失败能定位到具体 turn、tool 和 MCP 调用。
- 关键指标有趋势和告警阈值。
- 安全与恢复场景进入 CI，而不是只靠手工验证。

---

## P3-13 收紧 Node 与 DSH 的兼容范围

**问题**

`peerDependencies` 全部为 `"*"`，package 没有 `engines`。这会接受未来不兼容的 DSH 或 Node 版本，问题只能在运行时暴露。

**源码证据**

- `ds-bot/package.json:49-54`：peer dependencies 全部为 `"*"`。
- `ds-bot/package.json`：没有 `engines` 字段。

**建议方案**

1. 设置明确 Node 范围，例如 `>=22.19 <25`。
2. 将 DSH peer 范围收紧到已验证的 minor 范围。
3. 启动时检查 DSH 版本和关键能力，不满足时给出明确错误。
4. 在 CI 中增加最低支持版本和下一预发布版本。

**验收标准**

- 不兼容 Node/DSH 在安装或启动时明确失败。
- 不会静默加载到未经验证的 DSH 内部结构。

---

## P3-14 补齐安全敏感模块的针对性测试

**问题**

整体覆盖率较高，但分布不均：

| 模块 | 当前覆盖率 |
|---|---:|
| `src/client/read-page.js` | 约 8% |
| `src/host/chat-index.js` | 约 70% |
| `src/host/schedules.js` | 约 79% |
| `src/host/parts.js` | 约 79% |

**建议方案**

1. 为 `read-page.js` 增加 DOM 语料和属性测试。
2. 为 `chat-index.js` 增加损坏数据库、重建、断点和长历史测试。
3. 为 `schedules.js` 增加迁移崩溃和幂等测试。
4. 为 `parts.js` 增加 DSH 版本差异、并发切换和失败恢复测试。
5. 将覆盖率阈值写入 CI，防止后续下降。

**验收标准**

- 关键安全模块达到约定覆盖率。
- 每个 P1 修复都有能复现原问题的回归测试。
- CI 能阻止覆盖率和关键场景退化。

---

## 实施顺序

### 阶段 0：立即处理

- P1-01 状态锁竞态。
- P1-02 MCP 权限边界。
- P1-04 仓库与发布元数据。

### 阶段 1：持久化与执行可靠性

- P1-03 SQLite/checkpoint 持久化。
- P2-07 定时任务幂等。
- P2-10 schema 校验与迁移。

### 阶段 2：安全与性能

- P2-05 密钥最小权限。
- P2-06 不可信内容隔离。
- P2-08 worker thread 与异步 I/O。
- P2-11 事件推送、并发和预算。

### 阶段 3：长期架构

- P2-09 移除 DSH 内部修改。
- P2-12 可观测性与场景评测。
- P3-13 兼容范围。
- P3-14 测试补齐。

## 验证基线

本次审计执行了：

- `npm ci --no-fund --no-audit`
- `npm run harness`
- `npm test`：635 个测试通过
- `node scripts/build-client.mjs --check`：通过
- `npm run lint`：无错误，存在若干非阻断警告
- `npm audit --omit=dev`：无已知漏洞
- `node --test --experimental-test-coverage`：行覆盖率 91.49%，分支覆盖率 85.34%

未执行：

- Linux smoke test
- Web/Desktop 截图测试
- Desktop/Xvfb 测试
- 真实模型费用评测

## 参考实践

- [LangGraph persistence and durable execution](https://langchain-ai.github.io/langgraph/concepts/durable_execution/)
- [OpenAI Agents SDK human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- [OpenHands runtime architecture](https://github.com/OpenHands/docs/blob/main/openhands/usage/architecture/runtime.mdx)
- [AutoGen Core](https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/index.html)
- [Temporal durable execution](https://docs.temporal.io/evaluate)
- [MCP authorization and security](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx)
- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/)
- [OpenTelemetry AI agent observability](https://opentelemetry.io/blog/2025/ai-agent-observability/)
