# dsh-proactive

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](#安装)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-8250df)](https://github.com/topics/dsh-plugin)

> **主动智能（Proactive Intelligence）调度插件** —— DeepSeek Harness（DSH）生态中的多模型协同调度系统：自主感知、自主决策、自主进化。
>
> [English](./README.en.md) | 中文


## 什么是主动智能？

传统调度系统是**被动的**：收到信号才响应，没有信号就空转。本插件在「感知 → 决策 → 执行 → 反思 → 沉淀」闭环之上叠加自主层，让系统：

- **没有任务时**，主动观察自身运行状态、发现瓶颈、生成改进目标
- **遇到未知领域**，主动发起探索，把"不知道"变成"有经验"
- **面对未来负载**，主动预测信号到达趋势，提前预留容量
- **出现异常时**，主动熔断、限流、降级，而不是等到崩溃


## 核心特性

### 主动感知
- Sentinel 多源信号接入（webhook / 文件监听 / 轮询 / 手动注入）
- 聚合窗口去重合并，紧急度智能排序

### 自主决策
- 战略决策引擎：execute / defer / dismiss / ask-user 四级决策
- 经验检索 + DAG 计划生成 + 多模型并行执行
- 决策缓存与反馈闭环

### 自我反思与进化
- 目标引擎：从洞察生成目标并分解子任务
- 质量反思引擎：低于阈值自动重试 / 切换模型
- 元认知引擎：持续监测 KPI 健康度并自调参
- 策略进化引擎：遗传算法演化最优决策基因
- 长期记忆：任务模式、模型画像、经验教训跨会话沉淀

### 主动智能三支柱
- **世界模型**（`world-model.ts`）：信号到达率统计、小时直方图、到达预测（含置信区间）、趋势检测、预测校准（MAE）
- **好奇心引擎**（`curiosity-engine.ts`）：知识盲区扫描（未探索 / 低经验 / 高失败率）、新颖度评分、健康度自适应探索预算
- **安全治理**（`safety-governor.ts`）：每分钟限流、token/成本预算、熔断器（连续失败→冷却→半开）、置信度门控、紧急停止开关、审计日志

### 工程基础设施
- Raft 共识、分布式同步、热更新、AES-256 加密存储
- 多租户隔离、基准测试引擎、实时进度 WebSocket、可视化 Dashboard
- 13 个 Tool 注册，支持 `introspect` 七维自省报告

## 自主循环（Autonomy Loop）

每个心跳执行 8 步编排：

1. 元认知观察 —— 采集 KPI，发现异常洞察
2. 世界模型预测 —— 预测信号到达，捕捉上升趋势
3. 洞察聚合 —— 合并反思引擎的经验教训
4. 目标生成 —— 从洞察自动生成改进目标并分解子任务
5. 子任务派发 —— 经安全治理审查后注入执行
6. 好奇探索 —— 剩余容量用于知识盲区探索
7. 策略进化 —— 遗传算法演化决策策略
8. 记忆维护 —— 经验蒸馏 + 遗忘曲线

## 自助智能闭环（越用越聪明）

插件是一个能够自我服务、自我完善的智能体：核心是「感知—决策—执行—学习」闭环，由三大支柱支撑。
新架构按单向数据流组织组件，与架构图一一对应：

```
记忆库(Memory) → 优化器(Optimizer) → 模型调度(ModelScheduler)/任务执行(TaskExecutor) → 反思器(Reflector) → 记忆更新(Memory)
```

- **记忆**（`memory/long-term-memory.ts`）：记录任务模式、模型能力画像和决策反馈，作为进化燃料
- **反思**（`reflector.ts` + `reflection-engine.ts`）：每次任务后复盘，沉淀成功模式、提取失败教训，更新记忆
- **优化**（`optimizer.ts`）：基于更新的记忆，产出推荐模型与复用计划，驱动更优调度和决策

三大支柱的接口契约定义于 [contracts.ts](./src/contracts.ts)：`IMemoryStore` / `IReflector` / `IOptimizer`，
由 `LongTermMemory` / `Reflector` / `Optimizer` 严格 implements，外部集成方只依赖接口。

**记忆持久化**：基于 Node 内置 `node:sqlite`（零依赖），完全关系化 schema——`task_patterns` /
`model_profiles` / `decision_feedback`（+ `distilled_strategies` / `meta`）分表存储，热查询字段
（task_type / confidence / frequency / last_seen_at 等）提升为类型化列并建索引，SQL 可直接查询聚合；
WAL 模式、预编译语句缓存、按主键增量 UPSERT 同步，事务保证崩溃一致性，重启后完整恢复；
旧版 JSON 记忆与旧版 blob 表均自动无损升级。加密启用或宿主不支持 `node:sqlite` 时
自动回退 JSON 原子写后端（`memory/backend.ts` 统一抽象）。

**数据库工程能力**：PRAGMA 加固（WAL + `busy_timeout=5000` 多连接安全 + `synchronous=NORMAL`）；
版本化迁移框架（`schema_version` + MIGRATIONS 注册表，每步独立事务，新增迁移只需追加）；
维护 API（`integrityCheck` 完整性检查 / `dbStats` 行数·页·WAL·扩展能力统计 / `checkpoint`
WAL 合并 / `vacuum` 碎片回收 / `backup` 热备份（checkpoint+文件复制）/ `rawQuery` 只读 SQL 通道）。

**自主学习检索增强**（SQLite 落地三件套）：
1. **混合检索增强**：FTS5 双分词表（trigram 子串级中文匹配 + jieba 式 token 级匹配，
   可经 `setChineseTokenizer` 注入真实 jieba 管道）+ 稀疏词频向量余弦检索（sqlite-vec
   接缝已预留：宿主预装扩展时自动启用，缺省零依赖回退）+ 记忆图联想，四路召回合并
   （`optimizer.hybridSearch`）
2. **自定义数据结构序列化**：记忆网络（共现边权重）与主题树保留在内存管理检索，
   JSON 序列化到 `memory-graph.json`，启动时加载（`memory/memory-graph.ts`），
   弥补 SQLite 图结构短板；反思器成功沉淀时更新图，优化器检索时联想增强
3. **防幻觉短索引**：注入大模型前将冗长记忆 ID 转为 `#1…` 短索引（`memory/alias-map.ts`），
   模型输出后反解回完整 ID，降低幻觉率并节省 Token

闭环的三个关键通路（缺一即退化为静态系统）：

1. **经验驱动选型**：优化器检索到的推荐模型组合按节点类型真正参与节点分配（`Optimizer.lookupExperience → ModelScheduler.assignModel`），而非仅作为提示词
2. **策略反馈校准**：反思器将蒸馏策略按执行结果回写应用成功率（`Reflector.reflectOnOutcome → recordStrategyOutcome`），有效策略越用越强、无效策略自然淘汰
3. **经验快路径**：优化器命中高置信度模式（默认 ≥ 0.9，`memoryFastPathThreshold` 可调）时直接召回历史最优成功计划（`Optimizer.recallPlan`），跳过 LLM 重新规划——越用越快、越稳、越省 token

三个对冲机制（防止「越学越错」的安全阀，缺一不可）：

1. **遗忘曲线**（`memory.applyForgettingCurve`，自主循环低频维护驱动）：长期未用的记忆按艾宾浩斯模型降置信直至彻底遗忘；以 `lastDecayAt` 为基准幂等衰减，高频维护调用不复合叠加
2. **置信度衰减**：覆盖任务模式与蒸馏策略两类记忆——成功加分、失败扣分，长期未被应用/验证的策略同样衰减清除，无效经验自然淘汰
3. **阈值自校准**（`reflection-engine.calibrateThreshold`，反思器每次执行后驱动）：质量分布偏高收紧阈值追求卓越、偏低放宽避免无效重试风暴；任务执行器读取动态阈值

离线端到端验证（模拟 10 轮闭环运行，验证推荐模型采纳率 / 策略反馈回写 / 快路径命中 / 三对冲机制）：

```bash
node scripts/verify-self-evolution.mjs
```

## 安装

要求：Node.js `^22.18.0 || >=24.11.0`、pnpm。

```bash
git clone https://github.com/beijingwahw/dsh-proactive.git
cd dsh-proactive
pnpm install
pnpm build
```

## 配置（零手动配置）

**开箱即用，无需手动配置任何模型或密钥，插件本身也不持有任何 API Key。**

- 随附的 [cordis.yml](./cordis.yml) 已封装全部国产模型（DeepSeek / 通义千问 / 智谱 / Kimi / MiniMax / 讯飞星火 / 腾讯混元 / 百度文心 / 商汤日日新），加载即用；
- 运行时插件经 ctx 上下文获取 DSH 已配置好的 LLM 客户端，DSH 自动把用户配置的 Key（Web UI 填写或环境变量配置）注入请求头；
- **密钥自动填入**：插件还会自动读取宿主本地密钥并按厂商匹配填入请求头，优先级为 宿主 ctx 注入 → 进程环境变量（如 `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`，按模型 id 前缀匹配厂商）→ DSH 本地配置文件（`~/.dsh/config.json` 等，mtime 热更新、缺失时定期重探测）；密钥只进内存，不落盘、不打印；
- **多密钥故障转移**：同一厂商存在多个候选密钥时，认证失败（401/403）或配额耗尽（429）会自动轮换到下一个候选密钥重试，并升级为**健康感知路由**——按成功/失败统计选择最优密钥，429 冷却 1 分钟、401/403 冷却 5 分钟，成功后自动恢复；用户可通过 `manage_keys` 工具调整密钥使用顺序（持久化，重启保留），启动日志输出每个模型的密钥来源（不含密钥值），运行时可用 `query_memory keys` 查看各密钥健康状态；
- 若只需单一厂商，可改用 `patches/domestic-models/` 下按厂商拆分的 patch；重新生成：`pnpm generate:patches`。

完整运行配置项（哨兵 / 加密 / 同步 / 共识 / 热更新 / 租户）同样内置于 [cordis.yml](./cordis.yml)，无需改动。

## 工具调用示例

通过 `manage_autonomy` 获取七维自省报告：

```jsonc
// 调用：manage_autonomy { "action": "introspect" }
// 返回（示例，字段节选）：
{
  "loop":      { "running": true, "tickCount": 42 },
  "health":    { "score": 0.86 },
  "goals":     { "active": 3 },
  "exploration": { "totalExplorations": 5 },
  "governance":  { "circuitState": "closed" },
  "worldModel":  { "types": 4 },
  "evolution":   { "generation": 7 }
}
```

其他常用操作：

- `manage_autonomy`：`start` / `stop` / `tick` / `kill-switch` / `revive` / `reset-circuit`
- `query_memory`：`world-model` / `curiosity` / `governance` / `patterns` / `lessons` 等

## DSH 插件规范符合性

本插件遵循 DeepSeek Harness（cordis）插件开发规范，在不影响性能的前提下完成以下规范化提升：

- **函数插件形态 + 静态元数据**：默认导出为 `apply(ctx, config)` 函数插件，并挂载 `name` / `Config` / `provide` 静态元数据，供注册表与加载器识别；
- **Schemastery Config schema**：`Config` 为标准 schema，加载时由 cordis `resolveConfig` 自动校验类型并填充默认值（哨兵 / 加密 / 同步 / 共识 / 热更新 / 租户 / 自主智能等全部配置节）；函数型注入字段（`nodeRunner` / `judge` / `llm.fetchImpl` 等）作为额外属性透传，不受校验影响；
- **官方 Tool 注册链路**：宿主加载 `@deepseek-ai/dsh-tools`（`ctx.tools` 服务）时，14 个 Tool 经 duck-typing 桥接注册进官方 ToolRegistry，纳入 pre/around/post 执行管线与模型可见面（参数转为官方 JSON Schema 子集）；宿主未提供时静默降级为内部 ToolRegistry + `ctx.provide('schedulerTools')`，不引入整套 agent 栈依赖；
- **依赖注入与服务声明**：经 `ctx.provide('scheduler' / 'schedulerTools')` 暴露服务面，并通过 TypeScript 声明合并（`declare module '@deepseek-ai/cordis'`）为 `Context` 注入类型；
- **生命周期清理**：全部资源在 fiber 卸载时经 `ctx.effect` 按依赖逆序清理（含官方 Tool 注销）；
- **发布清单**：`package.json` 声明 `dsh.bundle.patch` 指向 [cordis.yml](./cordis.yml) bundle 配置层，`exports` / `files` / `engines` / `keywords` 齐备，`prepare` 脚本保证安装即构建。

## 宿主融合层（Host Fusion）

在规范化之上，插件经 cordis 跨 fiber 事件机制深度融入宿主运行时，从"被动插件"升维为**宿主级认知与安全层**（宿主加载 `@deepseek-ai/dsh-tools` 时自动激活，否则静默降级）：

- **全宿主可观测**（`tools/result`，emit）：观测宿主全部工具调用结果——每次调用经世界模型 `observeArrival` 学习宿主行为节律（增强预见性）；工具失败注入 `host-tool-failure` 信号至哨兵，触发决策链路自愈；同工具连续失败达阈值（默认 3 次）自动升级：高紧急度信号 + 教训沉淀至反思引擎；
- **全宿主安全治理**（`tools/pre-execute`，waterfall）：调度器的安全治理器获得对宿主管线的否决权——Kill Switch 启用时冻结全宿主工具调用（紧急停止从"冻结自身"升级为"冻结宿主"）；调度器自身失败螺旋触发熔断器时 fail-closed 拒绝宿主动作；只读门控（`checkGate`），不消耗限流/预算；
- **安全设计**：观测 fail-open（自身异常绝不破坏宿主管线）、治理 fail-closed（仅显式安全状态拒绝）；自排除调度器自身 14 个桥接 Tool，避免反馈环路；零新增依赖（结构化类型 + 声明合并）。

配置节 `hostFusion`：`enabled` / `observeToolResults` / `governToolCalls` / `failureEscalationThreshold`（默认 `true / true / true / 3`）。

## 项目结构

```
src/
├── index.ts                  # 插件入口与 10 步链路编排
├── sentinel.ts               # 信号感知
├── decision-engine.ts        # 战略决策
├── types.ts                  # 共享类型层（计划/结果/注入点/错误）
├── contracts.ts              # 三支柱接口契约（IMemoryStore/IReflector/IOptimizer）
├── model-scheduler.ts        # 模型调度（原有，能力画像 × 记忆加权 × 成本感知）
├── task-executor.ts          # 任务执行（原有，DAG 并行 + 质量反思重试 + 级联）
├── optimizer.ts              # 优化器（经验检索 + 快路径计划召回）
├── reflector.ts              # 反思器（复盘 + 记忆更新 + 策略反馈 + 蒸馏）
├── reflection-engine.ts      # 质量反思引擎（阈值自校准 / 教训提取）
├── goal-engine.ts            # 目标引擎
├── meta-cognition.ts         # 元认知监测
├── strategy-evolution.ts     # 策略进化
├── world-model.ts            # 世界模型（预见）
├── curiosity-engine.ts       # 好奇心引擎（内在动机）
├── safety-governor.ts        # 安全治理（边界）
├── autonomy-loop.ts          # 自主循环编排
├── host-fusion.ts            # 宿主融合层（全宿主可观测 + 安全治理）
├── dsh-host.ts               # DSH 宿主集成（LLM 客户端 / 模型目录 / Key 注入）
├── memory/                   # 长期记忆（SQLite/JSON 双后端）、记忆图、别名映射、迁移
├── consensus/                # Raft 共识
├── sync/                     # 分布式同步
├── hot-reload/               # 热更新
├── security/                 # 加密引擎
├── tenant/                   # 多租户
├── benchmark/                # 基准测试
└── dashboard/                # 可视化面板
```

## 许可

[MIT](./LICENSE)
