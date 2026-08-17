import Schema from "@deepseek-ai/schemastery";
import http from "node:http";
import { EventEmitter } from "node:events";
import { Context } from "@deepseek-ai/cordis";
//#region src/sentinel.d.ts
/**
 * sentinel.ts — 信号感知哨兵（集成层，执行链路第 1~2 步）
 *
 * 职责：主动感知环境变化，统一封装为 Signal 对象并在聚合窗口内合并相关信号
 * - 三种信号源：webhook（HTTP 接入）/ filesystem（文件监听）/ polling（轮询比对）
 * - 手动注入入口（autonomous_execute Tool 与级联触发共用）
 * - 聚合窗口：aggregationWindow 内相关信号合并去重，窗口结束批量交付
 * - 交付回调 onBatch 由 index.ts 编排层消费，进入优先级排序与战略决策
 *
 * 升级点（相对单一 webhook 的质的提升）：
 * 1. 窗口内同源去重：type + dedupeKey 相同的信号合并计数，避免重复决策
 * 2. 批次双触发：窗口到期或达到 maxBatchSize 立即交付，兼顾时延与吞吐
 * 3. 文件监听防抖 + 忽略规则（node_modules / dist / .git），杜绝噪声风暴
 * 4. 轮询源内容哈希比对：仅在内容真实变化时产生信号
 * 5. 全部资源（server / watcher / timer）由 stop() 统一回收，支持 cordis fiber 清理
 */
/** 统一信号对象（执行链路第 1 步产物） */
interface Signal {
  id: string;
  /** 信号类型：code-change / error-detected / performance-degraded / webhook / manual / cascade 等 */
  type: string;
  /** 人类可读描述 */
  description: string;
  /** 原始载荷 */
  payload: Record<string, any>;
  /** 紧急度 0~1（第 3 步由决策模型填充） */
  urgency?: number;
  receivedAt: number;
  /** 来源标识：webhook:9878 / fs:/path / poll:url / manual / cascade */
  source: string;
  /** 聚合去重键（缺省取 type + description） */
  dedupeKey?: string;
  /** 窗口内被合并的原始信号次数 */
  occurrences: number;
  /** 所属租户（多租户路由后填充） */
  tenantId?: string;
  /** 截止时间（毫秒时间戳）：截止时间感知调度依据 */
  deadlineMs?: number;
  /** 富化上下文（哨兵自动附加：到达速率 / 关联信号 / 历史频率） */
  enrichment?: SignalEnrichment;
}
/** 信号富化上下文（感知环节深度优化产物） */
interface SignalEnrichment {
  /** 该类型信号最近 1 分钟到达次数（突发检测依据） */
  recentRatePerMin: number;
  /** 该类型信号历史总次数 */
  historicalCount: number;
  /** 是否突发（recentRatePerMin 超过基线 3 倍） */
  isBurst: boolean;
  /** 关联信号 id 列表（时间邻近 + 类型关联） */
  correlatedSignalIds: string[];
  /** 当前生效的聚合窗口（毫秒，自适应） */
  effectiveWindowMs: number;
}
/** 信号源配置 */
interface SignalSourceConfig {
  type: 'webhook' | 'polling' | 'filesystem';
  /** webhook 监听端口 */
  port?: number;
  /** polling 间隔（毫秒） */
  interval?: number;
  /** polling 目标 URL */
  url?: string;
  /** filesystem 监听路径 */
  path?: string;
  /** 该源产生的信号类型 */
  signalType: string;
}
/** 哨兵配置（对应 cordis.patch.yml sentinel 节） */
interface SentinelConfig {
  watchCodeChanges: boolean;
  watchErrors: boolean;
  watchPerformance: boolean;
  /** 聚合窗口（秒） */
  aggregationWindow: number;
  signalSources?: SignalSourceConfig[];
  /** 文件监听根目录（watchCodeChanges 启用时） */
  watchDir?: string;
  /** 批次大小上限（达到即提前交付） */
  maxBatchSize?: number;
  /** fetch 实现注入（测试用） */
  fetchImpl?: typeof fetch;
}
/** 聚合批次（执行链路第 2 步产物） */
interface SignalBatch {
  signals: Signal[];
  aggregatedAt: number;
  /** 交付原因：窗口到期 / 批量上限 / 手动 flush */
  reason: 'window' | 'max-size' | 'flush';
}
/** 哨兵运行时状态 */
interface SentinelStatus {
  running: boolean;
  pendingSignals: number;
  totalIngested: number;
  totalBatches: number;
  sources: Array<{
    type: string;
    detail: string;
    active: boolean;
  }>;
  aggregationWindow: number;
  /** 当前自适应窗口（毫秒） */
  effectiveWindowMs: number;
  /** 累计突发次数 */
  burstCount: number;
  /** 各类型信号历史计数 */
  historicalCounts: Record<string, number>;
}
/**
 * 信号感知哨兵
 *
 * 被 index.ts 持有：start() 后持续产生 SignalBatch，
 * 编排层对每个批次执行第 3~10 步链路。
 */
declare class Sentinel {
  private config;
  private onBatch;
  private fetchImpl;
  private pending;
  private dedupeIndex;
  private windowTimer;
  private webhookServers;
  private fsWatchers;
  private pollTimers;
  private pollHashes;
  private fsDebounceTimer;
  private fsPendingPaths;
  private running;
  private totalIngested;
  private totalBatches;
  /** 各类型信号到达时间戳环形缓冲（突发检测 / 速率统计） */
  private arrivalHistory;
  /** 各类型信号历史总次数 */
  private historicalCounts;
  /** 各类型信号到达速率基线（指数移动平均，次/分钟） */
  private rateBaseline;
  /** 最近注入的信号（关联分析用，保留 50 条；ingest 时即记录，无需等待交付） */
  private recentSignals;
  /** 当前自适应窗口（毫秒） */
  private currentWindowMs;
  /** 突发计数（最近窗口内被判定为突发的次数） */
  private burstCount;
  /**
   * @param config 哨兵配置
   * @param onBatch 批次交付回调（编排层入口）
   */
  constructor(config: SentinelConfig, onBatch: (batch: SignalBatch) => void);
  /**
   * 启动所有信号源
   */
  start(): void;
  /**
   * 停止所有信号源并清空待处理缓冲（不交付残余信号）
   */
  stop(): void;
  /**
   * 注入一个信号（手动 / webhook / 文件监听 / 轮询 / 级联统一入口）
   * @param partial 信号字段（id / receivedAt / occurrences 自动补齐）
   * @returns 归一化后的 Signal（若被窗口内去重则返回已存在的信号）
   */
  ingest(partial: Omit<Signal, 'id' | 'receivedAt' | 'occurrences'> & Partial<Signal>): Signal;
  /**
   * 信号富化：到达速率统计 + 突发检测 + 关联分析 + 自适应窗口调整
   * @param signal 待富化信号
   */
  private enrich;
  /** 自适应窗口调整：突发 → 缩短至 1/4（下限 50ms）；平稳 → 逐步恢复配置值 */
  private adaptWindow;
  /**
   * 立即交付当前待处理批次（无待处理信号时为空操作）
   * @param reason 交付原因标记
   */
  flush(reason?: SignalBatch['reason']): void;
  /** 当前待处理信号（只读快照） */
  getPendingSignals(): Signal[];
  /**
   * 哨兵运行状态（manage_consensus / model_dashboard 等 Tool 可引用）
   */
  getStatus(): SentinelStatus;
  /** 确保聚合窗口定时器存在（首个信号触发开窗，使用自适应窗口） */
  private ensureWindowTimer;
  /** 启动 webhook 信号源 */
  private startWebhook;
  /** 启动文件监听信号源（递归监听 + 防抖 + 忽略规则） */
  private startFileWatch;
  /** 启动轮询信号源（内容哈希比对） */
  private startPolling;
}
//#endregion
//#region src/decision-engine.d.ts
/** 决策动作 */
type DecisionAction = 'execute' | 'defer' | 'dismiss' | 'ask-user';
/** 决策结果 */
interface Decision {
  action: DecisionAction;
  urgency: number;
  /** 置信度 0~1 */
  confidence: number;
  reason: string;
  /** 决策来源：规则 / 缓存 / strategist / 启发式 */
  source: 'rule' | 'cache' | 'strategist' | 'heuristic';
  deferMs?: number;
  /** 预估执行成本（token 量级） */
  estimatedCost?: number;
  decidedAt: number;
}
/** 决策引擎配置 */
interface DecisionEngineConfig {
  /** 决策缓存 TTL（毫秒） */
  cacheTtlMs: number;
  /** 缓存容量上限 */
  cacheMaxSize: number;
  /** 重复抑制窗口（毫秒）：窗口内同指纹成功执行过的信号直接 dismiss */
  suppressionWindowMs: number;
  /** 同类型连续失败达到该次数后升级为 ask-user */
  failureEscalationThreshold: number;
  /** 低于该置信度的决策升级为 ask-user */
  lowConfidenceThreshold: number;
  /** 成本延迟比：预估成本超过该值 × 历史均值 且 urgency < 0.3 时 defer */
  costDeferRatio: number;
  /** 突发判定：occurrences 达到该值视为突发 */
  burstOccurrences: number;
  /** strategist 决策器（注入，通常为 LLM 调用） */
  strategist?: (signals: Signal[], context: Map<string, SignalHistoryStats>) => Promise<Map<string, StrategistVerdict>>;
}
/** strategist 对单信号的裁定 */
interface StrategistVerdict {
  urgency: number;
  decision: DecisionAction;
  reason?: string;
  deferMs?: number;
}
/** 信号历史统计（由长期记忆提供，注入决策上下文） */
interface SignalHistoryStats {
  totalDecisions: number;
  successRate: number;
  avgExecutionTime: number;
  avgTokenCost: number;
}
/** 决策审计记录 */
interface DecisionAuditEntry {
  signalId: string;
  fingerprint: string;
  decision: Decision;
  /** 事后结果反馈 */
  outcome?: 'excellent' | 'good' | 'acceptable' | 'poor' | 'failed';
}
/** 默认配置 */
declare const DEFAULT_DECISION_ENGINE_CONFIG: DecisionEngineConfig;
/** 决策引擎统计（运维可观测） */
interface DecisionEngineStats {
  total: number;
  ruleHits: number;
  cacheHits: number;
  strategistCalls: number;
  heuristicFallbacks: number;
  cacheSize: number;
  cacheHitRate: number;
  ruleHitRate: number;
  consecutiveFailures: Record<string, number>;
}
/**
 * 战略决策引擎
 *
 * 被 index.ts 编排层持有：processBatch 的第 3~4 步由本引擎完成。
 */
declare class DecisionEngine {
  private config;
  private cache;
  /** 类型 → 连续失败计数 */
  private consecutiveFailures;
  /** 指纹 → 最近成功执行时间（重复抑制用） */
  private recentSuccess;
  /** 决策审计环形缓冲 */
  private audit;
  private stats;
  constructor(config?: Partial<DecisionEngineConfig>);
  /**
   * 对一批信号做决策（四级流水线）
   * @param signals 聚合后的信号批次
   * @param history 每类信号的历史统计（长期记忆提供）
   * @returns signalId → Decision
   */
  decide(signals: Signal[], history: Map<string, SignalHistoryStats>): Promise<Map<string, Decision>>;
  /**
   * 结果反馈闭环：依据执行结果修正缓存置信度与规则计数器
   * @param signalType 信号类型
   * @param fingerprint 信号指纹（缺省按 type+description 计算需提供 description）
   * @param outcome 执行结果
   */
  recordOutcome(signalType: string, fingerprint: string, outcome: DecisionAuditEntry['outcome']): void;
  /** 计算信号指纹（对外暴露，供编排层沉淀反馈时使用） */
  fingerprint(signal: Pick<Signal, 'type' | 'description'>): string;
  /**
   * 运行时配置热更新（策略进化引擎的基因组落地入口）
   * @param patch 配置补丁（仅覆盖提供的字段，strategist 回调不可经此修改）
   */
  updateConfig(patch: Partial<Omit<DecisionEngineConfig, 'strategist'>>): void;
  /** 当前配置快照（不含 strategist 回调） */
  getConfig(): Omit<DecisionEngineConfig, 'strategist'>;
  /** 决策引擎运行统计 */
  getStats(): DecisionEngineStats;
  /** 最近决策审计记录 */
  getAudit(limit?: number): DecisionAuditEntry[];
  /** 清空缓存与计数器（测试/重置用） */
  reset(): void;
  /** 第 1 级：规则快速路径 */
  private applyRules;
  /** 第 2 级：缓存查询（校验 TTL 与置信度） */
  private lookupCache;
  /** 缓存写入（LRU 淘汰） */
  private storeCache;
  /** 第 3 级：strategist 裁定 → Decision（含置信度与低置信升级） */
  private fromStrategist;
  /** 第 4 级：启发式兜底（保守执行） */
  private heuristic;
  /** 审计记录（环形缓冲上限 200） */
  private auditDecision;
  /** 清理过期的重复抑制记录 */
  private trimRecentSuccess;
}
//#endregion
//#region src/errors.d.ts
/**
 * errors.ts — 统一错误体系（AppError）
 *
 * 架构文档要求：所有模块的错误处理使用统一的 AppError 体系。
 * 每个子类携带稳定的机器可读 code，便于 Tool 层与日志层统一消费。
 */
/** 应用错误基类，所有业务错误的根类型 */
declare class AppError extends Error {
  /** 机器可读错误码，如 CRYPTO_ERROR / MEMORY_ERROR */
  readonly code: string;
  /** 附加上下文信息（不含敏感数据） */
  readonly details?: Record<string, unknown>;
  constructor(message: string, code?: string, details?: Record<string, unknown>);
}
/** 配置错误：cordis.patch.yml / 租户配置非法或缺失 */
declare class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/** 加密错误：加解密失败、密钥无效、加密功能未启用 */
declare class CryptoError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/** 记忆错误：持久化读写失败、记忆库损坏 */
declare class MemoryError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/** 网络错误：WebSocket / HTTP / 节点间通信失败 */
declare class NetworkError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/** 超时错误：模型调用或任务执行超过时限 */
declare class TimeoutError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
//#endregion
//#region src/types.d.ts
/** DAG 计划节点 */
interface PlanNode {
  id: string;
  description: string;
  /** 任务类型（code-generation / documentation / analysis 等） */
  type: string;
  dependsOn: string[];
  /** 指定模型（缺省由模型调度决定） */
  modelId?: string;
  /** 节点级超时覆盖（毫秒） */
  timeout?: number;
  /** 完成后级联触发的信号描述 */
  cascade?: Array<{
    type: string;
    description: string;
  }>;
}
/** 执行计划（优化器快路径召回 / strategist DAG / 离线兜底 三类来源） */
interface ExecutionPlan {
  objective: string;
  nodes: PlanNode[];
  parallelismStrategy: string;
  /** 计划来源：strategist 模型 / 离线兜底 / 记忆复用 */
  source: 'strategist' | 'fallback' | 'memory';
}
/** 单节点执行结果 */
interface NodeResult {
  nodeId: string;
  modelId: string;
  success: boolean;
  output?: string;
  /** 质量分 0~1（nodeRunner 自评或启发式） */
  quality: number;
  latency: number;
  attempts: number;
  error?: string;
  tokensUsed: number;
}
/** 计划执行结果 */
interface PlanExecutionResult {
  planId: string;
  success: boolean;
  nodeResults: NodeResult[];
  totalTime: number;
  successCount: number;
  totalTokens: number;
  /** 平均质量分（仅成功节点） */
  avgQuality: number;
  error?: string;
}
/** 节点执行器签名（可注入，测试可离线模拟） */
type NodeRunner = (params: {
  node: PlanNode;
  modelId: string;
  context: Record<string, string>;
  signal: Signal;
  attempt: number;
}) => Promise<{
  output: string;
  quality: number;
  tokensUsed?: number;
}>;
/** 级联触发回调（由 index.ts 桥接到 sentinel.ingest） */
type CascadeHandler = (newSignal: {
  type: string;
  description: string;
  payload: Record<string, any>;
}) => void;
/** 计划执行失败 */
declare class ExecutionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
//#endregion
//#region src/core/causal-kernel.d.ts
/**
 * causal-kernel.ts — 因果内核（项目 5.0「从相关到因果」的质变基座）
 *
 * 升级前的根本局限（全模块通病）：
 * - 证据内核（evidence.ts）回答的是 P(成功 | 特征) —— 这是相关性；
 *   系统据此排序/调度/分红，但从未回答「正是这个因素导致了结果吗？」
 * - 相关 ≠ 因果的典型陷阱：健康模型总被派发简单任务 → 观测成功率虚高
 *   （任务难度是混杂因子）；某策略与成功共现 → 可能只是都发生在低峰期。
 * - 一切「调参 / 换模型 / 进化」的决策依据都停留在 observational 层。
 *
 * 本内核引入 Pearl 因果阶梯的第二层 —— do-干预：
 * 1. 双流证据：每条因果边同时维护「干预证据」（do(X=x) 后观测 Y，
 *    如 A/B 实验真实切换）与「观测证据」（被动共现）——两层统计口径
 *    显式分离，永不混账。
 * 2. 干预效应估计：ATE = P(Y=1|do(X=1)) − P(Y=1|do(X=0))，
 *    每臂独立 Beta 后验 + Wilson 风格保守下界 —— 小样本实验不虚报因果。
 * 3. 混杂检测：观测关联与干预效应的显著背离 = 混杂因子的指纹。
 *    「冰淇淋销量 ↔ 溺水」类伪因果在此被自动标记（observationalOnly
 *    边的因果置信度被结构性折扣）。
 * 4. 反事实查询：actualOutcome 与 alternativeAction 的效应对比 ——
 *    「若当时选 B，成功概率几何」从哲学问题变为区间估计。
 * 5. 实验设计（好奇心接口）：不确定性最高（Beta 区间最宽）× 重要性
 *    最高（关联目标 KPI）的边优先做 do-实验 —— 假设驱动的好奇心。
 *
 * 与证据内核的关系：causal-kernel 建立在 evidence.ts 的同一套统计语言
 * （Beta 后验 / Wilson 下界 / 30 天时间衰减）之上，但回答的问题升了一层：
 * evidence.ts 问「它表现如何」，causal-kernel 问「是不是它造成的」。
 *
 * 审计性：全部干预记录（谁、何时、do 了什么、结果）保留链式日志，
 * 因果结论可追溯到每一次实验 —— 因果断言可被审计、可被证伪。
 */
/** 因果节点种类（动作 / 旋钮 / 指标 / 情境） */
type CausalNodeKind = 'action' | 'knob' | 'kpi' | 'context';
/** 因果节点（变量） */
interface CausalNode {
  id: string;
  kind: CausalNodeKind;
  label?: string;
}
/**
 * 因果边双流证据（X → Y）
 *
 * 干预流（黄金证据）：
 * - doXSuccess/doXFailure：do(X=1) 后 Y=1 / Y=0 的次数（处理组）
 * - doNotXSuccess/doNotXFailure：do(X=0) 后 Y=1 / Y=0 的次数（对照组）
 *
 * 观测流（银级证据，受混杂污染）：
 * - obsBoth：X=1 且 Y=1（联合）
 * - obsXOnly：X=1 且 Y=0
 * - obsYOnly：X=0 且 Y=1
 * - obsNeither：X=0 且 Y=0
 */
interface CausalEdgeEvidence {
  doXSuccess: number;
  doXFailure: number;
  doNotXSuccess: number;
  doNotXFailure: number;
  obsBoth: number;
  obsXOnly: number;
  obsYOnly: number;
  obsNeither: number;
  /** 惰性衰减基准（与 MemoryEvidence 同一语义） */
  lastDecayedAt: number;
}
/** 因果边（可序列化） */
interface CausalEdge {
  from: string;
  to: string;
  evidence: CausalEdgeEvidence;
  createdAt: number;
  lastTouchedAt: number;
}
/** 因果效应估计（对某条边的一次完整问答） */
interface CausalEffect {
  from: string;
  to: string;
  /** 平均处理效应 ATE = P(Y=1|do(X=1)) − P(Y=1|do(X=0)) */
  ate: number;
  /** ATE 保守下界（处理组下界 − 对照组上界，最悲观口径） */
  lower: number;
  /** ATE 乐观上界 */
  upper: number;
  /** 处理臂后验 P(Y=1|do(X=1))（无干预样本时回退观测估计并降权） */
  pDo: number;
  /** 对照臂后验 P(Y=1|do(X=0)) */
  pDoNot: number;
  /** 干预证据样本量（两臂合计） */
  interventionalSamples: number;
  /** 观测证据样本量（四格合计） */
  observationalSamples: number;
  /** 观测关联强度（P(Y=1|X=1) − P(Y=1|X=0)） */
  observationalAssociation: number;
  /** 混杂度 0~1：观测关联与干预效应的归一化背离 */
  confounding: number;
  /** 因果置信度 0~1（干预样本量 × 混杂折扣） */
  confidence: number;
  direction: 'positive' | 'negative' | 'none';
  /** 效应是否已确立（下界 > 0 或上界 < 0 且置信度足够） */
  established: boolean;
}
/** do-干预记录（审计链） */
interface InterventionRecord {
  seq: number;
  timestamp: number;
  from: string;
  to: string;
  /** 设定值（do(X=1) / do(X=0)） */
  setTo: boolean;
  /** 观测到的 Y */
  observedY: boolean;
  /** 干预发起方（如 'meta-cognition' / 'curiosity' / 'futarchy'） */
  actor: string;
  /** 干预理由（假设陈述） */
  hypothesis?: string;
}
/** 建议的因果实验（好奇心 → 实验设计） */
interface CausalExperiment {
  from: string;
  to: string;
  /** 建议的干预方向（先验更可能有效的一臂） */
  suggestedArm: boolean;
  /** 信息增益评分 0~1（不确定性 × 重要性） */
  infoGain: number;
  /** 实验假设（可读陈述） */
  hypothesis: string;
  /** 当前不确定性（Beta 区间宽度） */
  uncertainty: number;
}
/** 因果内核配置 */
interface CausalKernelConfig {
  /** 混杂告警的最小背离（|观测关联 − 干预效应|，默认 0.2） */
  confoundingThreshold: number;
  /** 因果确立的最小置信度（默认 0.5） */
  establishedConfidence: number;
  /** 单边干预记录上限（审计链截断保护） */
  maxInterventionLog: number;
  /** 实验建议的最小不确定性（Beta 区间宽度，默认 0.4） */
  experimentMinUncertainty: number;
}
declare const DEFAULT_CAUSAL_CONFIG: CausalKernelConfig;
/**
 * 因果内核：全系统共享的因果图 + do-干预登记处。
 *
 * 消费方：
 * - symbiosis/runtime：Shapley 分红用因果效应（而非线性权重）定价贡献
 * - world-model：do-干预效应预测（预见「若我这样做，世界会怎样」）
 * - reflection-engine：反事实反思（失败 → 「若选 B」教训）
 * - meta-cognition：旋钮推荐按因果效应排序（而非规则命中顺序）
 * - curiosity-engine：假设驱动实验设计（不确定性边 → do-实验 → 图更新）
 */
declare class CausalKernel {
  private config;
  private nodeMap;
  /** 边键 `${from}→${to}` */
  private edgeMap;
  /** 干预审计链（seq 单调递增） */
  private interventionLog;
  private seq;
  constructor(config?: Partial<CausalKernelConfig>);
  /** 登记因果节点（幂等；重复登记仅更新元信息） */
  addNode(node: CausalNode): void;
  /** 便捷登记：模型动作节点（from 形如 `use:model-x`） */
  private ensureNodes;
  /**
   * 被动观测（银级证据）：X 与 Y 的共现 —— 不做任何设定，只是看到。
   *
   * 观测证据只影响 observationalAssociation 与混杂度计算；
   * 无干预证据时作为 ATE 的降权回退估计。
   */
  observe(from: string, to: string, x: boolean, y: boolean, now?: number): void;
  /**
   * do-干预（黄金证据）：主动把 X 设为 setTo，观测结果 Y。
   *
   * 这是因果阶梯第二层的唯一入口 —— 每次真实 A/B 切换、每次参数实验、
   * 每次沙盒部署对照都应经此登记。审计链保留完整因果断言来源。
   *
   * @param actor 干预发起方（审计用）
   * @param hypothesis 实验假设（如「切换 model-b 可提升翻译成功率」）
   */
  intervene(from: string, to: string, setTo: boolean, observedY: boolean, actor: string, hypothesis?: string, now?: number): InterventionRecord;
  /**
   * 估计因果效应 ATE（对一条边的完整因果问答）。
   *
   * 口径优先级：
   * 1. 双臂干预证据齐全 → 纯干预 ATE（黄金口径）
   * 2. 仅处理臂 → 对照臂回退观测基线 P(Y=1|X=0)，混杂折扣已含在 confidence
   * 3. 无任何干预 → ATE = 观测关联 × 0.5（结构性折扣：未经实验的关联
   *    只值一半信任），confidence 上限 0.4（永不 established）
   */
  effect(from: string, to: string, now?: number): CausalEffect;
  /**
   * 因果排序：谁真正导致了 target（按效应下界降序）。
   *
   * 质变点：传统排序 = 相关性命中；本排序 = 已确立因果 > 高置信正效应 >
   * 待验证正效应。混杂严重的边即使观测关联再强也排不上来。
   */
  rankCauses(target: string, now?: number): CausalEffect[];
  /**
   * 混杂指纹检测：观测关联强但干预效应弱（或方向相反）的边。
   *
   * 返回的每条边都是一次「我们曾以为的因果」的证伪现场 ——
   * 调度器/优化器依赖这些边做的历史决策值得复查。
   */
  detectConfounding(now?: number): Array<CausalEffect & {
    divergence: number;
  }>;
  /**
   * 6.0：因果中介分析 —— 效应「经由什么机制」发生。
   *
   * X → M → Y 链上的效应分解（线性链近似，效应尺度用 ATE）：
   * - 总效应 total = effect(X→Y)
   * - 间接效应（经中介）indirect = effect(X→M) × effect(M→Y)
   * - 直接效应（绕过中介）direct = total − indirect
   * - 中介占比 share = indirect / |total|
   *
   * 质变点：此前系统只知道「模型 A 有效」，不知道「为什么有效」。
   * 中介分解回答机制问题：「model-fast 之所以提升成功率，80% 是
   * 因为它降低了延迟（latency），20% 是质量本身」——知识第一次
   * 拥有内部结构，机制理解支撑更精准的迁移决策。
   *
   * @param from 处理 X（如 model-fast）
   * @param mediator 中介 M（如 kpi:latency-improved）
   * @param to 结果 Y（如 task.outcome）
   */
  mediation(from: string, mediator: string, to: string, now?: number): {
    from: string;
    mediator: string;
    to: string;
    total: number;
    indirect: number;
    direct: number;
    /** 中介传导占比 0~1（间接/|总|；总效应近零时为 0） */
    share: number;
    /** 各段效应明细（链上每条边的完整问答） */
    path: {
      xm: CausalEffect;
      my: CausalEffect;
      xy: CausalEffect;
    };
    /** 机制解读 */
    mechanism: string;
  };
  /**
   * 反事实查询：给定实际发生了 actionActual 且结果为 actualY，
   * 「若当时做 actionAlternative」成功概率几何。
   *
   * 实现：两动作 → 同一结果的因果边后验对比（无证据时返回先验 0.5
   * 并以宽区间表达无知 —— 诚实的不确定性，而非假装知道）。
   */
  counterfactual(outcome: string, actionActual: string, actionAlternative: string, actualY: boolean, now?: number): {
    alternative: string;
    estimatedProb: number;
    lower: number;
    upper: number;
    actualProb: number;
    evidenceSamples: number;
    verdict: string;
  };
  /**
   * 假设驱动实验建议：不确定性最高 × 关联 target 的边优先做 do-实验。
   *
   * 信息增益 = Beta 区间宽度（不确定性）× max(观测关联, 已见干预效应)（重要性）。
   * 每条建议自带可读假设陈述 —— 好奇心从「随机探索」升级为
   * 「提出假设 → 设计实验 → do-干预 → 图更新」的科学循环。
   */
  suggestExperiments(target: string, budget?: number, now?: number): CausalExperiment[];
  /**
   * 10.0：单边证据明细（科学家内核的实验设计原料）。
   *
   * 暴露每条边两臂的原始成败计数与观测四格（含衰减口径），
   * 供外部按 Beta(1+s, 1+f) 精确重构臂后验并计算期望信息增益。
   * 只读快照，不暴露内部结构。
   */
  armEvidence(from: string, to: string, now?: number): CausalEdgeEvidence | undefined;
  /**
   * 11.0：全边衰减证据枚举（理论内核的归纳原料）。
   * 返回每条边的 (from, to, 衰减后双流证据)——理论内核据此分组归纳定律。
   */
  allEdgesEvidence(now?: number): Array<CausalEdgeEvidence & {
    from: string;
    to: string;
  }>;
  /** 图快照（节点 + 边效应摘要） */
  snapshot(now?: number): {
    nodes: CausalNode[];
    edgeCount: number;
    establishedEdges: CausalEffect[];
    confoundedEdges: Array<CausalEffect & {
      divergence: number;
    }>;
    interventions: number;
    topEdges: CausalEffect[];
  };
  /** 干预审计链（只读拷贝） */
  interventions(): InterventionRecord[];
  /** 序列化（持久化格式 = JSON） */
  serialize(): {
    nodes: CausalNode[];
    edges: CausalEdge[];
    interventions: InterventionRecord[];
    seq: number;
  };
  /** 反序列化 */
  deserialize(data: {
    nodes: CausalNode[];
    edges: CausalEdge[];
    interventions: InterventionRecord[];
    seq: number;
  }): void;
  /** 惰性衰减（写入路径，与 MemoryEvidence 同一语义） */
  private decayEdge;
  /** 读取式衰减视图（不回写） */
  private decayedView;
}
/** 联盟价值函数输入：单个贡献者的边际成功概率估计 */
interface ContributorProb {
  agentId: string;
  /** P(该贡献者的工作使任务成功) —— 反事实口径的个体成功率 */
  prob: number;
}
/**
 * noisy-OR 联盟价值：v(S) = 1 − Π_{i∈S}(1 − p_i)
 *
 * 语义：每个贡献者独立地「有机会」把任务做成功；任务成功只要
 * 至少一条路径走通。这是多模型协同（任一模型产出可用即成功）的
 * 忠实抽象，且让 Shapley 值有精确的子集枚举解。
 */
declare function coalitionValue(members: ContributorProb[]): number;
/**
 * 精确 Shapley 值（子集枚举，n ≤ 16 时精确；更大时按权重截断）。
 *
 * φ_i = Σ_{S ⊆ N∖{i}} [|S|! (n−|S|−1)! / n!] · [v(S ∪ {i}) − v(S)]
 *
 * 质变点：分红不再按「表现分的线性份额」（搭便车者只要有正分就
 * 永远分钱），而按「边际反事实贡献」——拔掉你，任务成功率掉多少，
 * 你就分多少。两个都干了活的智能体平分；只挂名不出力的边际贡献
 * ≈ 0，自然饿死（能量经济的真公平）。
 */
declare function shapleyValues(contributors: ContributorProb[]): Map<string, number>;
//#endregion
//#region src/reflection-engine.d.ts
/** 评审模型签名（可注入） */
type JudgeModel = (params: {
  taskDescription: string;
  output: string;
  taskType: string;
}) => Promise<{
  score: number;
  completeness: number;
  correctness: number;
  maintainability: number;
  comment: string;
}>;
/** 教训提取器签名（可注入，通常由 strategist 模型承担） */
type LessonExtractor = (params: {
  signalDescription: string;
  taskType: string;
  errorMessage: string;
  failedNodeId: string;
  failedModelId: string;
}) => Promise<{
  rootCause: RootCauseCategory;
  lesson: string;
  suggestion: string;
}>;
/** 根因分类 */
type RootCauseCategory = 'model-capability' | 'timeout' | 'dependency' | 'prompt-ambiguity' | 'transient' | 'unknown';
/** 结构化教训 */
interface Lesson {
  id: string;
  timestamp: number;
  taskType: string;
  rootCause: RootCauseCategory;
  lesson: string;
  suggestion: string;
  signalDescription: string;
  /** 5.0：反事实教训（失败 → 「若选 B」的因果估计） */
  counterfactual?: CounterfactualInsight;
}
/**
 * 5.0：反事实洞察 ——「若当时选 B」的因果区间估计。
 *
 * 质变点：传统教训只回答「为什么失败」（归因过去）；
 * 反事实教训回答「怎样会成功」（指导未来的反事实推理）。
 */
interface CounterfactualInsight {
  /** 实际采用的模型 */
  actualModel: string;
  /** 反事实最优替代 */
  bestAlternative: string;
  /** 替代模型的估计成功概率（因果口径，非相关） */
  estimatedProb: number;
  /** 区间下界 */
  lower: number;
  /** 区间上界 */
  upper: number;
  /** 可读结论 */
  verdict: string;
  /** 证据样本量（不足时建议先做实验而非直接切换） */
  evidenceSamples: number;
}
/** 质量趋势记录 */
interface QualityTrendPoint {
  timestamp: number;
  taskType: string;
  avgQuality: number;
  success: boolean;
}
/** 质量趋势摘要（按任务类型聚合） */
interface TrendSummary {
  threshold: number;
  windowSize: number;
  byType: Record<string, {
    samples: number;
    avgQuality: number;
    successRate: number;
    trending: 'rising' | 'falling' | 'stable';
  }>;
}
/** 反思引擎配置 */
interface ReflectionEngineConfig {
  /** 初始质量阈值 */
  qualityThreshold: number;
  /** 阈值自校准的最小样本数 */
  calibrationMinSamples: number;
  /** 阈值自校准步长 */
  calibrationStep: number;
  /** 阈值允许的范围 */
  thresholdRange: [number, number];
  /** 质量趋势滑动窗口大小 */
  trendWindowSize: number;
  /** 连续下滑触发告警的次数 */
  declineAlertCount: number;
  /** 评审模型（缺省则使用执行器自带质量分） */
  judge?: JudgeModel;
  /** 教训提取器（缺省则使用规则化提取） */
  lessonExtractor?: LessonExtractor;
}
/** 反思结论 */
interface ReflectionVerdict {
  /** 综合质量分（评审模型 or 执行器质量分） */
  quality: number;
  /** 是否达标 */
  passed: boolean;
  /** 重试建议：retry-same / retry-switch / no-retry */
  retryAdvice: 'retry-same' | 'retry-switch' | 'no-retry';
  /** 建议理由 */
  reason: string;
  /** 评审明细（judge 可用时） */
  dimensions?: {
    completeness: number;
    correctness: number;
    maintainability: number;
    comment: string;
  };
}
/** 默认配置 */
declare const DEFAULT_REFLECTION_CONFIG: ReflectionEngineConfig;
/**
 * 质量反思引擎
 *
 * 被 index.ts 持有：executor 执行完成后调用 reflect() 进行深度反思，
 * 失败时调用 extractLesson() 沉淀教训，阈值通过 getCurrentThreshold() 动态获取。
 */
declare class ReflectionEngine {
  private config;
  private lessons;
  private trendWindow;
  /** 各任务类型的质量历史（用于自校准；带时间戳支持衰减均值） */
  private qualityHistory;
  /** 当前动态阈值 */
  private currentThreshold;
  /** 告警回调（由 index.ts 桥接到进度广播） */
  private onAlert?;
  private lessonCounter;
  /** 5.0：因果内核（挂载后失败反思自动触发反事实分析） */
  private causal?;
  constructor(config?: Partial<ReflectionEngineConfig>);
  /** 设置告警回调 */
  setAlertHandler(handler: (alert: {
    type: string;
    message: string;
    taskType: string;
  }) => void): void;
  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: CausalKernel): void;
  /**
   * 5.0：反事实分析 —— 失败后的「若选 B」推理。
   *
   * 对每个候选替代模型查询因果内核：do(use:B) → task.outcome 的
   * 后验成功概率（黄金口径：仅干预证据 ≥ 3 时采信，观测证据降权），
   * 返回最优替代与可读结论。
   *
   * 质变点：教训从「A 超时了」升级为「A 超时了；若当时用 B，
   * 成功概率 0.78 [0.62, 0.91]（12 次干预证据）」——
   * 下次调度的切换决策第一次有了反事实依据。
   *
   * @param outcomeNode 因果图的结果节点（默认 'task.outcome'）
   */
  reflectCounterfactual(params: {
    failedModelId: string;
    alternativeModelIds: string[];
    actualSuccess: boolean;
    outcomeNode?: string;
  }): CounterfactualInsight | null;
  /**
   * 对单个节点输出做深度反思
   * @param params 节点输出与上下文
   * @returns 反思结论
   */
  reflect(params: {
    node: {
      id: string;
      description: string;
      type: string;
    };
    output: string;
    baseQuality: number;
    signal: Signal;
  }): Promise<ReflectionVerdict>;
  /**
   * 从失败执行中提取教训（异步，失败不阻塞主流程）
   * @param params 失败上下文
   * @returns 提取的教训
   */
  extractLesson(params: {
    signal: Signal;
    taskType: string;
    result: PlanExecutionResult;
    plan: ExecutionPlan;
  }): Promise<Lesson | null>;
  /**
   * 记录一次执行结果到趋势窗口并触发自校准
   * @param taskType 任务类型
   * @param quality 平均质量分
   * @param success 是否成功
   */
  recordExecution(taskType: string, quality: number, success: boolean): void;
  /** 当前动态质量阈值 */
  getCurrentThreshold(): number;
  /** 设置质量阈值（元认知自调优落地入口，限制在允许范围内） */
  setQualityThreshold(value: number): void;
  /** 获取指定任务类型的相关教训（供计划生成引用） */
  getLessons(taskType: string, limit?: number): Lesson[];
  /** 全部教训 */
  getAllLessons(): Lesson[];
  /**
   * 直接追加一条结构化教训（轻量入口，无需完整 PlanExecutionResult）。
   * 供宿主融合层等外部观测面在宿主工具连续失败时沉淀经验。
   * @param params 教训字段（id / timestamp 自动补齐）
   * @returns 追加的 Lesson
   */
  addLesson(params: {
    taskType: string;
    rootCause: RootCauseCategory;
    lesson: string;
    suggestion: string;
    signalDescription: string;
  }): Lesson;
  /** 质量趋势摘要 */
  getTrendSummary(): TrendSummary;
  /** 重试建议：依据教训库与根因判断 */
  private adviseRetry;
  /** 质量下滑告警检测 */
  private checkDeclineAlert;
  /**
   * 阈值自校准（4.0 证据化：时间衰减均值）
   *
   * 校准基准从裸算术均值升级为半衰期 30 天的时间加权均值——旧的
   * 质量分布（模型更强/更弱时期）自然让位，阈值始终锚定「当前能力」：
   * 分布整体偏高 → 收紧；偏低 → 放宽。
   */
  private calibrateThreshold;
  /** 趋势方向判断 */
  private trendDirection;
}
//#endregion
//#region src/goal-engine.d.ts
/** 洞察来源（目标生成的输入） */
interface Insight {
  /** 洞察来源引擎 */
  source: 'reflection' | 'meta-cognition' | 'memory' | 'user' | 'market';
  /** 洞察类别 */
  category: string;
  /** 关联任务类型（可选） */
  taskType?: string;
  /** 严重度 0~1（越高越值得生成目标） */
  severity: number;
  /** 洞察描述 */
  message: string;
  /** 改进建议（目标生成的种子） */
  suggestion: string;
}
/** 目标子任务 */
interface GoalSubtask {
  id: string;
  description: string;
  /** 子任务类型（注入哨兵时作为信号类型） */
  taskType: string;
  status: 'pending' | 'dispatched' | 'done' | 'failed';
  /** 绑定的执行信号 id（dispatched 后回填） */
  signalId?: string;
  /** 执行结果摘要 */
  result?: string;
  attempts: number;
}
/** 目标状态 */
type GoalStatus = 'proposed' | 'active' | 'in-progress' | 'completed' | 'abandoned';
/** 自主目标 */
interface Goal {
  id: string;
  title: string;
  description: string;
  /** 目标来源 */
  origin: Insight['source'];
  /** 生成该目标的洞察摘要 */
  insightRef: string;
  status: GoalStatus;
  /** 价值分（impact × confidence / cost） */
  valueScore: number;
  impact: number;
  confidence: number;
  estimatedCost: number;
  createdAt: number;
  updatedAt: number;
  /** 完成时限（毫秒时间戳，可选） */
  deadline?: number;
  subtasks: GoalSubtask[];
  /** 关联任务类型（用于匹配完成信号） */
  taskType?: string;
}
/** 目标分解器签名（可注入，通常为 strategist LLM） */
type GoalDecomposer = (goal: Goal) => Promise<Array<{
  description: string;
  taskType: string;
}>>;
/** 目标引擎配置 */
interface GoalEngineConfig {
  /** 生成目标的最低洞察严重度 */
  minInsightSeverity: number;
  /** 同时活跃的目标上限（防止目标膨胀） */
  maxActiveGoals: number;
  /** 子任务最大重试次数（超过则放弃目标） */
  maxSubtaskAttempts: number;
  /** 目标去重相似度门槛（标题归一化后包含关系视为重复） */
  dedupeEnabled: boolean;
  /** 目标分解器（缺省则规则化单步分解） */
  decomposer?: GoalDecomposer;
}
/** 默认配置 */
declare const DEFAULT_GOAL_ENGINE_CONFIG: GoalEngineConfig;
/**
 * 自主目标引擎
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳调用 generateGoalsFromInsights
 * 产出目标，再将分解后的子任务注入哨兵执行，执行结果经
 * recordSubtaskOutcome 回写进度，形成"洞察 → 目标 → 行动 → 达成"闭环。
 */
declare class GoalEngine {
  private config;
  private goals;
  private goalCounter;
  private subtaskCounter;
  constructor(config?: Partial<GoalEngineConfig>);
  /**
   * 从洞察批量生成目标（自主目标生成的核心入口）
   * @param insights 来自反思/元认知/记忆的洞察列表
   * @returns 新生成的目标（去重后）
   */
  generateGoalsFromInsights(insights: Insight[]): Goal[];
  /**
   * 分解目标为子任务（LLM 分解 + 规则兜底）
   * @param goalId 目标 id
   * @returns 分解出的子任务列表
   */
  decompose(goalId: string): Promise<GoalSubtask[]>;
  /**
   * 选取下一个待执行子任务（价值最高目标优先，FIFO 次序）
   * @returns 目标与子任务，无待执行项时返回 null
   */
  pickNextSubtask(): {
    goal: Goal;
    subtask: GoalSubtask;
  } | null;
  /**
   * 标记子任务已派发（绑定执行信号）
   */
  markDispatched(goalId: string, subtaskId: string, signalId: string): void;
  /**
   * 回写子任务执行结果（由编排层在信号执行完成后调用）
   * @returns 目标状态变化（completed / abandoned / null）
   */
  recordSubtaskOutcome(goalId: string, subtaskId: string, success: boolean, result?: string): GoalStatus | null;
  /** 通过信号 id 查找绑定的目标与子任务（执行完成回写用） */
  findBySignal(signalId: string): {
    goal: Goal;
    subtask: GoalSubtask;
  } | null;
  /** 活跃目标数（proposed / active / in-progress） */
  activeGoalCount(): number;
  /** 获取目标 */
  getGoal(goalId: string): Goal | undefined;
  /** 全部目标（按价值降序） */
  getAllGoals(): Goal[];
  /** 目标进度摘要 */
  getSummary(): any;
  /** 序列化（随长期记忆持久化） */
  serialize(): Goal[];
  /** 反序列化（恢复跨会话目标追求） */
  deserialize(goals: Goal[]): void;
  /** 价值评估：impact × confidence / cost（成本至少为 1） */
  private computeValue;
  /** 从洞察提炼目标标题 */
  private titleFromInsight;
  /** 目标去重：归一化标题的包含关系判定 */
  private isDuplicate;
  /** 目标进度 0~1 */
  private progressOf;
  /** 查找子任务 */
  private findSubtask;
}
/** 从反思教训构建洞察（目标引擎与反思引擎的桥接） */
declare function lessonsToInsights(lessons: Lesson[]): Insight[];
//#endregion
//#region src/core/free-energy.d.ts
/**
 * free-energy.ts — 主动推断内核（项目 6.0「自由能最小化心智」质变基座）
 *
 * 升级前的根本分裂（全模块通病）：
 * 系统有四套独立的「好坏」判据——调度器用策略评分（利用端），
 * 探索用 UCB 加成（手设预算），好奇心用盲区扫描（接触频率），
 * 元认知用 KPI 逐项阈值（规则命中）。四套判据彼此不通约：
 * 什么时候该探索、探索多少、知识与收益如何换算——全是拍脑袋常数。
 *
 * 本内核引入 Karl Friston 自由能原理（Active Inference）：
 * 智能体唯一目标是 minimize expected free energy——
 *
 *   G(a) = E_q[−ln P(goal | do(a))]  （务实价值：期望惊奇，越低越好）
 *        − E[info gain(a)]           （认知价值：期望信息增益，越高越好）
 *
 * 一个公式同时统一了四大启发式：
 * 1. 利用（务实价值）：预测成功率越接近偏好，惊奇越低 → 替代策略评分
 * 2. 探索（认知价值）：不确定性高的动作信息增益大 → 替代 UCB 加成，
 *    且探索预算不再是常数——不确定性耗尽，认知价值自动归零
 * 3. 好奇心（认知价值）：实验设计 = argmax info gain → 与探索同源，
 *    「想知道」与「想得分」在同一量纲（nat）下权衡
 * 4. 精度控制：温度 γ = f(系统平均不确定性)——世界模型越不可信，
 *    策略越随机（多探索）；越可信越贪婪（多利用）——自适应探索温度
 *
 * 变分自由能（感知侧）：F = KL(q‖p)（信念分布 ‖ 生成模型预测）——
 * 信念市场价与因果后验的背离第一次有了信息论度量（nat），
 * 模型漂移 = 自由能上升 = 系统对世界的「预测握力」松动。
 *
 * 与因果内核的关系：causal-kernel 提供生成模型 P(Y|do(X))，
 * 本内核提供基于该模型的行动选择定理。因果阶梯（第二层）回答
 * 「干预会怎样」，主动推断回答「因此该干预什么」——两者合成
 * 完整的感知-决策-学习闭环。
 *
 * 审计性：EFE 分解（务实/认知）逐动作输出，每个选择都能回答
 * 「为什么选它」——多少因为有用，多少因为想弄清。可解释、可追溯。
 */
/** ln Γ(x)（Lanczos 逼近；x>0） */
declare function lnGamma(x: number): number;
/** ψ(x) = d/dx ln Γ(x)（递推 + 渐近级数；x>0） */
declare function digamma(x: number): number;
/** Beta 分布微分熵（nat）：H = ln B(α,β) − (α−1)ψ(α) − (β−1)ψ(β) + (α+β−2)ψ(α+β) */
declare function betaEntropy(alpha: number, beta: number): number;
/** KL(q‖p)（伯努利分布，nat）；概率裁剪防 log(0) */
declare function bernoulliKL(q: number, p: number): number;
/** 行动候选（生成模型视角下的一个可干预动作） */
interface EFEAction {
  /** 动作标识（modelId / knob:x / 实验边 from） */
  id: string;
  /** P(Y=1|do(a))——因果内核处理臂后验（无证据回退 0.5） */
  pSuccess: number;
  /** 效应区间（不确定性来源） */
  lower: number;
  upper: number;
  /** 干预证据量（黄金证据，信息增益的主依据） */
  interventionalSamples: number;
  /** 观测证据量（银级证据，半价计入） */
  observationalSamples: number;
}
/** EFE 评估结论（逐动作可解释分解） */
interface EFEEvaluation {
  actionId: string;
  /** 务实价值：E[−ln P(goal|do(a))]（nat，越低越好） */
  pragmatic: number;
  /** 认知价值：期望信息增益（nat，越高越好） */
  epistemic: number;
  /** G(a) = pragmatic − epistemicWeight×epistemic（越低越好） */
  efe: number;
  /** Beta 后验参数（信息增益计算依据，审计可查） */
  alpha: number;
  beta: number;
  /** Boltzmann 策略选择概率 */
  boltzmannProb: number;
  /** 该选择中「想知道」的占比（epistemic/(pragmatic+epistemic)） */
  curiosityShare: number;
  /** 若选它，预期把该边的不确定性收缩多少（nat→0 收敛度） */
  expectedUncertaintyReduction: number;
}
/** 变分自由能报告（感知侧漂移监测） */
interface VariationalReport {
  /** Σ KL(q‖p)（nat，信念 vs 生成模型的总背离） */
  totalFreeEnergy: number;
  /** 逐信念明细 */
  perBelief: Array<{
    id: string;
    beliefProb: number;
    modelProb: number;
    kl: number;
  }>;
  /** 漂移判定（总自由能超阈值） */
  driftDetected: boolean;
  /** 最大背离源（漂移归因） */
  worst?: {
    id: string;
    kl: number;
  };
}
interface FreeEnergyConfig {
  /** 认知价值权重（信息增益折算系数，缺省 1：1 nat 信息 = 1 nat 惊奇） */
  epistemicWeight: number;
  /** Boltzmann 温度下限（缺省 0.05：证据充分时接近贪婪） */
  minTemperature: number;
  /** 温度对不确定性的敏感度（缺省 0.3） */
  temperatureSensitivity: number;
  /** 漂移判定的总自由能阈值（nat，缺省 0.25） */
  driftThreshold: number;
  /** 概率裁剪 ε（防 log(0)） */
  probEpsilon: number;
}
declare const DEFAULT_FREE_ENERGY_CONFIG: FreeEnergyConfig;
/**
 * 主动推断内核：期望自由能决策 + 变分漂移监测 + 精度控制。
 *
 * 消费方：
 * - model-scheduler：EFE 模式下行动选择 = argmin G(a)（探索/利用统一）
 * - symbiosis/runtime：行动提案按 EFE 排序（认知经济的注意力分配）
 * - meta-cognition：总自由能作为统一健康度（预测握力）
 * - curiosity-engine：实验目标 = argmax epistemic（与探索同源的定理化好奇心）
 * - world-model / 信念对账：KL 漂移监测（变分自由能）
 */
declare class FreeEnergyEngine {
  private config;
  /** 感知侧：最近观测惊奇（EMA，自由能代理） */
  private surprisalEma;
  private surprisalCount;
  constructor(config?: Partial<FreeEnergyConfig>);
  /**
   * 单动作期望自由能分解。
   *
   * 务实价值（期望惊奇）：
   *   G_prag = −[ω·ln p̂ + (1−ω)·ln(1−p̂)]
   *   ω = 对成功的偏好强度（goal weight）；p̂ = P(Y=1|do(a))。
   *   p̂ 越贴近 ω 惊奇越低；p̂ 与 ω 同侧时交叉熵单调。
   *
   * 认知价值（期望信息增益，一步前瞻）：
   *   IG = H(Beta(α,β)) − [p̂·H(α+1,β) + (1−p̂)·H(α,β+1)]
   *   做这个动作（无论成败）后该边后验熵的期望收缩量。
   *   样本充足 → 微分熵收缩趋零 → 认知价值自动归零（探索自我终结）。
   */
  evaluateAction(action: EFEAction, preference: number, temperature?: number): EFEEvaluation;
  /**
   * 全候选 EFE 评估 + Boltzmann 策略。
   *
   * P(a) ∝ exp(−G(a)/T)：温度由系统不确定性控制（precisionControl）。
   * 高不确定性 → 高温度 → 均匀探索；低不确定性 → 低温 → 贪婪利用。
   * 这是主动推断的规范策略形式：策略 = 对自由能的 softmax。
   */
  evaluateActions(actions: EFEAction[], preference: number, temperature?: number): EFEEvaluation[];
  /**
   * Thompson 采样：θ_a ~ Beta(α_a, β_a)，选 argmax θ。
   *
   * EFE 最优的随机化实现（Bernoulli bandit 的规范探索策略）：
   * 后验越宽采样越散 → 自动探索；后验越尖采样越稳 → 自动利用。
   * 与 Boltzmann 的区别：不依赖温度标定，探索幅度由证据量内生决定。
   */
  thompsonSelect(actions: EFEAction[]): {
    winner: string;
    samples: Record<string, number>;
  };
  /**
   * 精度控制：候选集平均不确定性 → 探索温度。
   *
   * T = minTemperature + sensitivity × avgWidth。
   * 世界的未知程度直接决定策略的随机程度——不确定时多试，
   * 胸有成竹时果断。探索率第一次由认识论内生推导，而非超参数。
   */
  minTemperatureFromActions(actions: EFEAction[]): number;
  /**
   * 感知：登记一次「预测-结果」惊奇（自由能的在线代理）。
   *
   * surprisal = −ln P(实际结果 | 预测概率)。EMA 平滑为系统级
   * 「预测握力」——元认知的总自由能 KPI 数据来源：
   * 预测越准惊奇越低；世界突变（漂移）时惊奇陡升。
   * @returns 本次的惊奇值（nat）
   */
  observeSurprisal(predictedProb: number, actualSuccess: boolean): number;
  /** 感知侧自由能（EMA 惊奇；无观测时 0） */
  currentSurprisal(): number;
  /**
   * 变分自由能：信念分布 vs 生成模型的 KL 总和（感知漂移监测）。
   *
   * 典型用法：信念市场隐含概率（q）vs 因果内核后验（p）。
   * F 上升 = 「市场以为的」与「模型知道的」裂开 = 模型漂移指纹——
   * 为既有 gap 判断提供信息论度量（nat）与归因（worst）。
   */
  variationalFreeEnergy(beliefs: Array<{
    id: string;
    beliefProb: number;
  }>, modelProbs: Record<string, number>): VariationalReport;
}
/** Beta(α,β) 精确采样：Gamma 采样比（Marsaglia-Tsang） */
declare function sampleBeta(alpha: number, beta: number): number;
//#endregion
//#region src/core/abstraction.d.ts
/**
 * abstraction.ts — 抽象内核（项目 9.0「抽象心智」质变基座：类比结构映射）
 *
 * 升级前的根本局限（8.0 元认知心智的天花板）：
 * 转移模型把每个状态键当**孤立符号**——`trapB#s0` 与 `trapA#s0`
 * 哪怕结构完全相同也互不相干；新任务域永远从 Beta(1,1) 完全无知
 * 开始，深思搜索在陌生域只能凭认知价值乱试探。系统**学不会
 * 举一反三**：经验被锁死在它被采集的具体状态键里。
 *
 * 本内核引入结构映射类比（Structure Mapping, Gentner 1983）+
 * 分层贝叶斯收缩（hierarchical partial pooling）：
 *
 * 1. **状态骨架分解**：state = `${domain}#${skeleton}`——域是
 *    「对象标签」（code-gen / translation / trapA / trapB），
 *    骨架是「关系角色」（#s0 起步 / #dead 死路 / #rich 富态）。
 *    抽象 = 保关系、换对象。
 *
 * 2. **域结构相似度**：域画像 = 观测过的 (骨架, 行动) 集合；
 *    sim(d1,d2) = Jaccard(画像)。两个结构相同的陷阱域相似度 1，
 *    无关域相似度 0——**结构同构可度量，类比有了闸门**。
 *
 * 3. **分层先验链**（全部排除自身叶子证据，防双计）：
 *    L1 类比层：结构相似的别域在同骨架同行动上的后验（sim 加权）
 *    L2 域边际层：本域其他骨架对同一行动的经验（域难度）
 *    L3 全局骨架层：所有域在该骨架行动上的无权池化
 *    L4 均匀层：Beta(1,1)（strength=2，与未挂载时严格等价）
 *
 * 4. **后继继承**（结构映射的核心）：冷叶子不仅继承边缘概率，
 *    还继承**转移结构**——别域 (骨架, 行动) 的 MAP 后继骨架映射
 *    回本域（trapA 的 bait→#dead 迁移成 trapB 的 bait→#dead）。
 *    陷阱的本质在后继结构里，不在边缘概率里——不继承结构
 *    就谈不上类比规划。
 *
 * 5. **抽象技能**：同一骨架同一行动序列在 ≥2 个域整体成功 →
 *    晋升为跨域宏技能（`*#${skeleton}` 触发），第三个同构域
 *    冷启动即可复用——「怎么做」的知识第一次跨域通用。
 *
 * 与 6/7/8.0 的关系：6.0 定价行动、7.0 定价计划、8.0 定价思考，
 * 本内核让三者**跨域泛化**——经验不再是一次性的。
 * 抽象心智 = 元认知心智 × 举一反三。
 */
/** 分层先验（叶子证据之外的一切知识来源） */
interface HierarchicalPrior {
  /** 先验均值（域间迁移来的成功率估计） */
  mean: number;
  /** 先验强度（伪计数；均匀层 = 2 与 Beta(1,1) 严格等价） */
  strength: number;
  /** 来源层标注（audit：analogy(domain) / domain-marginal / global-skeleton / uniform） */
  source: string;
  /** L1 层实际参与融合的域（结构映射的证人） */
  witnessDomains?: string[];
}
/** 抽象技能（跨域宏动作；在 deliberation 中包装为 Skill 参与 beam 种子） */
interface AbstractSkillEntry {
  id: string;
  /** 触发骨架（任意域匹配） */
  skeleton: string;
  actions: string[];
  /** 成功域数（晋升证据） */
  domains: number;
  /** 总成功次数 */
  successes: number;
  value: number;
}
/** 抽象统计（meta-cognition KPI 用） */
interface AbstractionStats {
  /** 已观测域数 */
  domains: number;
  /** 骨架级结构边数 */
  structuralEdges: number;
  /** 零样本应答：冷叶子拿到非均匀先验的次数（真正发生的举一反三） */
  zeroShotAnswers: number;
  /** 类比迁移启用次数（L1 命中） */
  analogyTransfers: number;
  /** 后继结构继承次数 */
  successorInheritances: number;
  /** 抽象技能数 */
  abstractSkills: number;
  interpretation: string;
}
interface AbstractionConfig {
  /** L1 类比层先验强度（伪计数，缺省 6） */
  analogyStrength: number;
  /** L2 域边际层先验强度（缺省 4） */
  domainStrength: number;
  /** L3 全局骨架层先验强度（缺省 3） */
  globalStrength: number;
  /** 结构相似度门槛（Jaccard，缺省 0.3——低于此不迁移） */
  minSimilarity: number;
  /** 抽象技能晋升所需跨域成功数（缺省 2） */
  abstractSkillDomains: number;
  /** 域画像最大容量（防爆内存；缺省 4096） */
  maxProfileSize: number;
}
declare const DEFAULT_ABSTRACTION_CONFIG: AbstractionConfig;
/**
 * 抽象内核：状态骨架分解 + 域结构相似度 + 分层先验链 + 后继继承
 * + 抽象技能晋升。
 *
 * 挂载于 DeliberationEngine（attachAbstraction）：observe 喂入证据、
 * posterior 经分层先验收缩、冷叶子继承别域后继结构、搜索种子合并
 * 抽象技能。未挂载时对既有行为零影响（先验链不参与）。
 */
declare class AbstractionEngine {
  private config;
  /** 骨架级证据（域, 骨架, 行动）——L1 目标 + 画像 + 自身排除基数 */
  private skeletonEdges;
  /** 域×行动边际（L2） */
  private domainAction;
  /** 全局骨架×行动（L3） */
  private globalSkeleton;
  /** 域画像（域 → 观测过的 skeleton|action 集合）——相似度原料 */
  private profiles;
  /** 抽象技能晋升追踪（骨架||签名 → 跨域成功） */
  private skillLadder;
  private abstractSkills;
  private skillCounter;
  private zeroShotAnswers;
  private analogyTransfers;
  private successorInheritances;
  constructor(config?: Partial<AbstractionConfig>);
  /**
   * 登记一次观测（与 DeliberationEngine.observe 同步调用）。
   * @param nextState 成功时的后继状态（后继继承的原料）
   */
  observe(state: string, action: string, success: boolean, nextState?: string): void;
  /**
   * 查询 (state, action) 的分层先验（叶子证据之外的一切）。
   *
   * 优先级：L1 类比（结构相似域同骨架）→ L2 域边际（本域其他骨架）
   * → L3 全局骨架（无权跨域）→ L4 均匀。各层均排除查询叶子自身
   * 的证据（防双计——deliberation 会把叶子证据加回后验）。
   */
  hierarchicalPrior(state: string, action: string): HierarchicalPrior;
  /**
   * 冷叶子的后继结构继承：类比域 (骨架, 行动) 的 MAP 后继骨架
   * 映射回本域（trapA#s0 --bait--> trapA#dead ⟹ trapB#s0 --bait--> trapB#dead）。
   * 陷阱的本质在后继结构里——不继承结构就谈不上类比规划。
   * @returns 继承的后继状态；无可继承时 undefined
   */
  inheritedSuccessor(state: string, action: string): string | undefined;
  /** 域画像 Jaccard：观测过的 (骨架, 行动) 集合重合度——结构同构可度量 */
  domainSimilarity(d1: string, d2: string): number;
  /**
   * 查询口径的结构相似度（含冷域首触规则）：
   * - 查询域已有画像：严格 Jaccard（闸门防误迁移；一旦发现域并非
   *   同构，相似度跌破门槛，类比自动停止——错误类比自纠）
   * - 查询域全冷（无任何观测）：对方在**恰好这个结构位置**
   *   (骨架, 行动) 上有经验即为证人（sim=1）——处女域相信任何
   *   走过同一条结构路的前辈；先验强度（6 伪计数）约束借用幅度，
   *   自身证据积累后严格闸门接管
   */
  private structuralSimilarity;
  /** 已观测域列表（audit） */
  domains(): string[];
  /**
   * 计划结局入账（与 DeliberationEngine.settle 同步）：
   * 同一骨架同一行动序列在多个域整体成功 → 跨域宏技能晋升。
   */
  notePlanOutcome(firstState: string, actions: string[], success: boolean): void;
  /** 检索：匹配状态骨架的抽象技能（跨域宏动作） */
  abstractSkillsFor(state: string): AbstractSkillEntry[];
  /** 全部抽象技能（audit） */
  allAbstractSkills(): AbstractSkillEntry[];
  stats(): AbstractionStats;
  serialize(): {
    skeletonEdges: Array<{
      domain: string;
      skeleton: string;
      action: string;
      successes: number;
      failures: number;
      successors: Array<[string, number]>;
    }>;
    domainAction: Array<{
      domain: string;
      action: string;
      successes: number;
      failures: number;
    }>;
    globalSkeleton: Array<{
      skeleton: string;
      action: string;
      successes: number;
      failures: number;
    }>;
    abstractSkills: AbstractSkillEntry[];
    counters: {
      zeroShotAnswers: number;
      analogyTransfers: number;
      successorInheritances: number;
    };
  };
  deserialize(data: ReturnType<AbstractionEngine['serialize']>): void;
}
/**
 * 状态分解：`${domain}#${skeleton...}`（'#' 后全部视为骨架，支持多段）。
 * 无 '#' 时骨架为空串（单段状态——相似度闸门防误迁移）。
 */
declare function decompose(state: string): {
  domain: string;
  skeleton: string;
  hasSkeleton: boolean;
};
//#endregion
//#region src/core/deliberation.d.ts
/** 转移边后验（state × action → outcome，学习与想象的生成模型） */
interface TransitionPosterior {
  state: string;
  action: string;
  /** Beta(α,β) 后验均值 = P(成功 | state, action) */
  pSuccess: number;
  alpha: number;
  beta: number;
  /** 真实证据量（成功 + 失败计数） */
  evidence: number;
  /** 90% 区间近似（后验 σ ± 1.645σ） */
  lower: number;
  upper: number;
  /** MAP 后继状态（无证据时停留原态；冷边可经类比继承别域结构） */
  successor: string;
  /**
   * 9.0：分层先验来源（挂载抽象内核时）——这条边的知识有多少是
   * 自己挣的、多少是类比/域边际/全局借来的。audit 用。
   */
  abstract?: {
    source: string;
    strength: number;
    mean: number;
  };
}
/** 轨迹中一步的完整分解（审计单元） */
interface StepEvaluation {
  /** 步序（0 起） */
  step: number;
  state: string;
  action: string;
  nextState: string;
  /** 该步成功概率（后验均值） */
  pStep: number;
  /** 该步开始时的有效证据（真实 + 轨迹内想象折算） */
  evidence: number;
  /** 务实价值：E[−ln P(goal|do(a))]（nat） */
  pragmatic: number;
  /** 认知价值：该步期望信息增益（nat；重访同一边时单调下降） */
  epistemic: number;
  /** 该步 G = pragmatic − epistemicWeight × epistemic */
  efe: number;
  /** 折扣后计入轨迹总 G 的份额（γ^step × efe） */
  discounted: number;
}
/** 想象报告（一条计划的梦境推演） */
interface ImaginationReport {
  /** 起始状态 */
  startState: string;
  /** 行动序列 */
  actions: string[];
  /** 状态轨迹（states[i] = 第 i 步之前所处状态） */
  states: string[];
  /** 折扣累计 G = Σ γ^t · G_t（越低越好；与单步 EFE 同量纲） */
  totalEfe: number;
  /** 未折扣累计（长计划审计用） */
  undiscountedEfe: number;
  /** 全程成功概率 = Π p_t */
  pAllSuccess: number;
  steps: StepEvaluation[];
  /** 首败风险分布：恰好在第 step 步首次失败的概率 */
  riskProfile: Array<{
    step: number;
    pFailAt: number;
  }>;
  /** 同一条边在轨迹内被重访时认知价值是否单调不增（想象证据坍缩） */
  epistemicMonotone: boolean;
}
/** 技能（时间抽象的宏动作：验证过的行动序列） */
interface Skill {
  id: string;
  /** 触发态（起始状态键；检索时精确匹配） */
  initiation: string;
  /** 行动序列（宏展开即按序执行） */
  actions: string[];
  /** 价值估计 = 宏动作全程成功概率口径（0~1，越高越好；随复用/失手 EMA 更新） */
  value: number;
  /** 全程成功概率估计（与价值同源，独立保留供审计） */
  reliability: number;
  /** 价值的不确定度（随结算次数收缩；检索排序折扣用） */
  confidence: number;
  usages: number;
  successes: number;
  createdAt: number;
  lastUsedAt: number;
}
/** 梦实现对账报告（想象的可问责性） */
interface SettlementReport$1 {
  steps: Array<{
    step: number;
    state: string;
    action: string;
    /** 梦里的预测（执行前口径，防止用结果修预测） */
    predicted: number;
    actual: boolean;
    /** −ln P(实际)（nat） */
    surprisal: number;
    /** |predicted − outcome| */
    error: number;
  }>;
  overallSuccess: boolean;
  meanSurprisal: number;
  /** 梦校准误差 EMA（0 = 完美预知；越高想象越不可信） */
  calibrationEma: number;
  /** 本轮技能库动作 */
  skillAction: 'acquired' | 'reinforced' | 'decayed' | 'none';
  skillId?: string;
}
/** 前瞻搜索结果 */
interface DeliberationResult {
  /** 按轨迹 G 升序的完整推演报告 */
  ranked: ImaginationReport[];
  best: ImaginationReport | undefined;
  /** 搜索展开的边数（含技能宏展开） */
  expandedNodes: number;
  /** 技能种子是否参与（时间抽象生效） */
  skillSeeded: boolean;
}
interface DeliberationConfig {
  /** 时间折扣 γ（缺省 0.95：远期收益按 5%/步衰减） */
  gamma: number;
  /** beam 宽度（缺省 6：每层保留的轨迹前缀数） */
  beamBreadth: number;
  /** 搜索深度上限（缺省 4 步） */
  maxDepth: number;
  /** 想象证据折算率（缺省 0.5：轨迹内重访同一边，每次折算 0.5 个伪证据） */
  imaginaryEvidenceRate: number;
  /** 认知价值权重（与 FreeEnergyConfig 同义，缺省 1） */
  epistemicWeight: number;
  /** 概率裁剪 ε */
  probEpsilon: number;
  /** 技能入库价值门槛（全程成功概率 ≥ 该值才可成技能，缺省 0.5） */
  skillValueThreshold: number;
  /** 技能库容量上限（超额按价值×置信度淘汰，缺省 64） */
  skillMaxCount: number;
  /** 梦校准 EMA 平滑系数（缺省 0.3，比感知惊奇更敏） */
  calibrationAlpha: number;
}
declare const DEFAULT_DELIBERATION_CONFIG: DeliberationConfig;
/**
 * 深思内核：转移模型 + 想象推演 + 前瞻搜索 + 技能库 + 梦实现对账。
 *
 * 消费方：
 * - optimizer：冷启动序列推荐（零情景记忆也能按想象给出计划级建议）
 * - meta-cognition：梦校准 KPI（想象可靠性的诚实度量）
 * - symbiosis/runtime：多步行动提案按轨迹 G 排序
 * - 宿主/执行器：计划执行后 settle 对账（学习 + 惊奇回流 + 技能蒸馏）
 */
declare class DeliberationEngine {
  private config;
  private edges;
  private skills;
  private skillCounter;
  private calibrationEma;
  private plansSettled;
  private freeEnergy?;
  /** 9.0：抽象内核（可选挂载；分层先验 + 后继继承 + 抽象技能） */
  private abstraction?;
  constructor(config?: Partial<DeliberationConfig>, freeEnergy?: FreeEnergyEngine);
  /** 挂载自由能引擎（梦对账的惊奇回流目标；幂等） */
  attachFreeEnergyEngine(engine: FreeEnergyEngine): void;
  /**
   * 9.0：挂载抽象内核（幂等）。挂载后：
   * - posterior 经分层先验收缩（L4 均匀层与 Beta(1,1) 严格等价，
   *   零数据时对既有行为零漂移）
   * - 冷叶子继承结构相似域的后继结构（类比规划）
   * - 搜索种子合并跨域抽象技能
   */
  attachAbstraction(engine: AbstractionEngine): void;
  /**
   * 登记一次真实执行证据（执行器/宿主在计划步落定后调用）。
   * @param state 该步所处状态键（如 `${taskType}#s${i}`）
   * @param action 行动（如 modelId）
   * @param success 该步成败
   * @param nextState 成功后的后继状态（缺省停留原态）
   */
  observe(state: string, action: string, success: boolean, nextState?: string): void;
  /**
   * 转移边后验查询。
   *
   * 未挂载抽象内核：Beta(1,1) 均匀先验（无证据 = 诚实的完全无知）。
   * 挂载后：分层先验收缩——先验 = 类比/域边际/全局借来的知识
   * （strength 伪计数），叶子证据逐条覆盖（经验渐近压倒类比）。
   * 均匀层 strength=2 与 Beta(1,1) 严格等价：零数据时零漂移。
   */
  posterior(state: string, action: string): TransitionPosterior;
  /**
   * 想象推演：在转移模型里 rollout 一条完整计划。
   *
   * 逐步计算（与单步 EFE 同一公式，证据沿轨迹累积）：
   *   α' = 1 + 真实成功 + λk·p̂   （λ = 想象证据折算率，k = 轨迹内已想象次数）
   *   β' = 1 + 真实失败 + λk·(1−p̂)
   *   务实 = −[ω ln p̂ + (1−ω) ln(1−p̂)]
   *   认知 = H(α',β') − [p̂·H(α'+1,β') + (1−p̂)·H(α',β'+1)]
   *   G_t = 务实 − w·认知；总 G = Σ γ^t G_t
   *
   * 关键性质：同一条边被重访时 λk 增大 → 后验熵收缩 → 认知价值单调不增
   * （想象证据坍缩：重复梦见同一件事不再带来新知识）。
   */
  imagine(startState: string, actions: string[], preference?: number): ImaginationReport;
  /**
   * 深思搜索：beam search 在轨迹空间按累计 G 剪枝。
   *
   * 与一步贪心（6.0 argmin G(a)）的本质区别：展开的是**轨迹前缀**——
   * 第 1 步的高 G 可以被第 2 步的低 G 补偿（γ 折扣），因此能看见
   * 「先苦后甜」的路，也能避开「第一步诱人、第二步是死路」的陷阱。
   *
   * 技能时间抽象：触发态匹配的技能作为宏动作直接展开整条序列
   * （一个 beam 槽位 = 多个原语步），深思从经验肩膀上起跳。
   *
   * @param startState 起始状态键
   * @param candidates 候选行动（静态清单或按状态动态给出）
   * @param opts 深度/宽度/偏好覆盖
   */
  search(startState: string, candidates: string[] | ((state: string) => string[]), opts?: {
    depth?: number;
    breadth?: number;
    preference?: number;
    useSkills?: boolean;
    /** 状态推进覆盖（确定性别状态机：忽略学习后继，按步推进） */
    advance?: (ctx: {
      state: string;
      action: string;
      step: number;
      successor: string;
    }) => string;
  }): DeliberationResult;
  /**
   * 技能入库/强化：整体成功的计划蒸馏为可复用宏动作。
   * 同一 (触发态, 行动序列) 已存在时按 EMA 强化价值。
   */
  acquireSkill(initiation: string, actions: string[], value: number, reliability: number): Skill | undefined;
  /** 技能衰减：匹配的技能失手（价值 EMA 下调，可靠性下滑） */
  decaySkill(initiation: string, actions: string[], penalty?: number): void;
  /**
   * 检索：触发态匹配的技能（按价值 × 置信度降序）。
   * 9.0：挂载抽象内核时合并跨域抽象技能（同骨架任意域可复用）。
   */
  skillsFor(state: string): Skill[];
  /** 全部技能（可观测/审计） */
  allSkills(): Skill[];
  /**
   * 计划落定对账：梦里预测 vs 现实结果。
   *
   * 三重回流：
   * 1. 转移模型学习（真实证据入库）
   * 2. 自由能感知惊奇（−ln P(实际)，挂载引擎时）
   * 3. 梦校准 EMA（|预测 − 结果|：想象可靠性的统一度量）
   *
   * 整体成功 → 计划蒸馏为技能（时间抽象资产）；
   * 整体失败 → 若匹配技能则衰减（梦境失灵的问责）。
   *
   * @param plan 逐步计划（state + action）
   * @param outcomes 逐步真实结果
   */
  settle(plan: Array<{
    state: string;
    action: string;
  }>, outcomes: boolean[], preference?: number): SettlementReport$1;
  /** 梦校准误差（EMA；未对账过时 undefined） */
  currentCalibration(): number | undefined;
  /** 已对账计划数（可观测） */
  settledCount(): number;
  /** 序列化（持久化用；含抽象内核状态） */
  serialize(): {
    edges: Array<{
      state: string;
      action: string;
      successes: number;
      failures: number;
      successors: Array<[string, number]>;
    }>;
    skills: Skill[];
    calibrationEma: number | undefined;
    plansSettled: number;
    /** 9.0：抽象内核状态（挂载时） */
    abstraction?: ReturnType<AbstractionEngine['serialize']>;
  };
  /** 反序列化 */
  deserialize(data: ReturnType<DeliberationEngine['serialize']>): void;
  /** 单步扩展一个 beam 前缀（含想象证据累积；advance 覆盖学习后继） */
  private extendNode;
  /** 整段序列展开（技能宏：从起始态一次推演完整技能） */
  private expandPrefix;
  /** beam 前缀 → 完整想象报告（复用已算好的步分解，不重算） */
  private nodeToReport;
}
//#endregion
//#region src/core/metareasoning.d.ts
/** 决策模式（双过程：1=习惯/反应，2=深思） */
type DecisionMode = 'habit' | 'reactive' | 'deliberative';
/** 习惯（深思的摊销缓存：状态 → 直答计划） */
interface Habit {
  /** 触发状态键 */
  state: string;
  /** 摊销的计划（深思反复收敛出的行动序列） */
  actions: string[];
  /** 连续成功次数（晋升后持续累计） */
  consecutiveSuccesses: number;
  /** 形成后总使用次数 */
  usages: number;
  /** 全程成功概率（形成时口径，审计用） */
  reliability: number;
  createdAt: number;
  lastUsedAt: number;
}
/** 元决策记录（pending → 结算回流） */
interface MetaDecision {
  id: number;
  /** 仲裁时的时间戳 */
  ts: number;
  state: string;
  mode: DecisionMode;
  /** 习惯模式 = 习惯计划；反应 = [bestAction]；深思 = 最优轨迹 */
  actions: string[];
  /** 计算成本（nat；习惯 ≈ 0，反应 ≈ 0，深思 = nodes × natPerNode） */
  costNat: number;
  /** 深思展开的节点数（认知经济审计） */
  nodesExpanded: number;
  /** 深思停止时的搜索深度 */
  depthStopped: number;
  /** 首行动稳定性（深思连续不变的层数） */
  firstActionStable: boolean;
  /** 反应门槛判定：best 与次优的单步 EFE 差（nat） */
  reactiveGap: number;
  /** 结算状态 */
  settled: boolean;
  /** 结算整体成败 */
  outcome?: boolean;
}
/** 仲裁结果 */
interface ArbitrationResult {
  mode: DecisionMode;
  actions: string[];
  /** 深思模式附带完整想象报告（审计/上游再利用） */
  report?: ImaginationReport;
  costNat: number;
  nodesExpanded: number;
  decisionId: number;
  /** 反应门槛判定：best 与次优的单步 EFE 差（nat；深思模式下 = 未达门槛的暧昧度） */
  reactiveGap: number;
  /** 深思停止时的搜索深度（反应 = 1，习惯 = 0） */
  depthStopped: number;
  /** 仲裁理由（人类可读，进决策审计） */
  rationale: string;
}
/** 认知经济 KPI（meta-cognition 统一报告用） */
interface CognitiveEconomy {
  /** 已仲裁决策总数 */
  decisions: number;
  /** 模式分布（份额和为 1） */
  modeShare: Record<DecisionMode, number>;
  /** 习惯命中节省的搜索成本（nat，认知经济的直接产出） */
  habitSavingsNat: number;
  /** 累计计算开销（nat） */
  totalSpendNat: number;
  /** 累计展开节点数 */
  totalNodes: number;
  /** 习惯库规模 */
  habits: number;
  /** 习惯命中率（习惯模式 / 决策总数） */
  habitHitRate: number;
  /** 元遗憾：习惯失灵（世界漂移下沿用了过期习惯）次数 */
  staleHabitRegrets: number;
  /** 反应失手次数（本该深思却反应了） */
  reactiveFailures: number;
  /** 各模式成功率（元学习实测：思考的价值） */
  modeSuccessRate: Partial<Record<DecisionMode, number>>;
  /** 平均深思深度（收敛性：越低=越早想清楚） */
  avgDeliberationDepth: number;
  interpretation: string;
}
interface MetareasoningConfig {
  /** 反应门槛：best 与次优单步 EFE 差 ≥ 该值 → 无需深思（nat，缺省 0.25） */
  decisivenessGap: number;
  /** 反应模式对 best 行动的最低证据量要求（缺省 8） */
  sufficientEvidence: number;
  /** 习惯晋升门槛：同状态同计划连续成功次数（缺省 2） */
  habitPromotionSuccesses: number;
  /** 深思最大深度（缺省 4；任意时停机通常更早） */
  maxDepth: number;
  /** beam 宽度（缺省 6） */
  beamBreadth: number;
  /** 每展开节点的计算价格（nat/节点，缺省 0.01） */
  natPerNode: number;
  /** 思考预算：单次深思最大开销（nat，缺省 2.0——约等于一次大惊小怪） */
  budgetNat: number;
  /** 反应失手后门槛收紧系数（缺省 0.8：gap *= 0.8，更难走反应路） */
  reactiveTightening: number;
  /** 反应门槛下限（收紧不至零：深思不能因一次失手变成常态，缺省 0.08） */
  minDecisivenessGap: number;
  /** 模式成功率 EMA 平滑（缺省 0.3） */
  metaAlpha: number;
}
declare const DEFAULT_METAREASONING_CONFIG: MetareasoningConfig;
/**
 * 元推理内核：双过程仲裁 + 任意时搜索 + 习惯摊销 + 元学习。
 *
 * 消费方：
 * - optimizer：metacognitiveRecommendation（冷启动推荐的元认知版）
 * - meta-cognition：认知经济 KPI（思考的价格与价值实测）
 * - 宿主：决策执行后 settleDecision 回流（元学习闭环）
 */
declare class RationalMetareasoner {
  private config;
  private deliberation;
  private habits;
  private pending;
  private decisionCounter;
  private modeCounts;
  private totalSpendNat;
  private totalNodes;
  private deliberationDepths;
  private habitSavingsNat;
  private staleHabitRegrets;
  private reactiveFailures;
  private modeOutcomes;
  private dynamicGap;
  constructor(deliberation: DeliberationEngine, config?: Partial<MetareasoningConfig>);
  /**
   * 双过程仲裁：习惯 → 反应 → 深思，逐级升级、逐级定价。
   *
   * 元 EFE 判据（越低越好）：
   *   habit:       直答（查表成本 ≈ 0）——信任摊销经验
   *   reactive:    一步 EFE 差悬殊且证据充分 → VOC ≈ 0，想也不会变
   *   deliberative: 任意时搜索直到首行动稳定或预算耗尽
   */
  decide(state: string, candidates: string[], opts?: {
    preference?: number;
    useSkills?: boolean;
    /** 状态推进覆盖（确定性别状态机；透传给深思搜索） */
    advance?: (ctx: {
      state: string;
      action: string;
      step: number;
      successor: string;
    }) => string;
  }): ArbitrationResult;
  /**
   * 任意时搜索：逐深度展开，首行动连续 stableRounds 层不变即停。
   *
   * 停机判据的数学含义：beam 在深度 d 与 d+1 给出的最优计划首行动
   * 相同 → 深层补偿已不影响当下选择 → 继续搜索的期望决策增益 < 成本。
   * 这是「思考收敛」的可观测证据，不是拍脑袋的深度上限。
   */
  private searchAnytime;
  /**
   * 决策结算：现实的后果校准元认知。
   *
   * - 习惯失手 → 习惯作废（世界漂移铁证）+ 元遗憾（不该省的思考）
   * - 反应失手 → 门槛收紧（下次更早进入深思）
   * - 深思成功且重复 → 习惯晋升候选（摊销推断）
   * - 各模式成功率 EMA 更新（思考价值的实测）
   */
  settleDecision(decisionId: number, overallSuccess: boolean, actionsTaken?: string[]): void;
  /** 未结算决策的只读视图（宿主对账用） */
  pendingDecisions(): MetaDecision[];
  /** 当前动态反应门槛（元学习可观测） */
  currentDecisivenessGap(): number;
  /** 习惯库只读视图（审计） */
  allHabits(): Habit[];
  /** 手动作废习惯（上游漂移信号，如变分自由能报警时） */
  invalidateHabit(state: string): boolean;
  /** 认知经济报告：思考的价格与价值的统一核算 */
  cognitiveEconomy(): CognitiveEconomy;
  private habitHitRate;
  /** 同长度深思的成本估算（习惯节省额入账口径） */
  private estimateDeliberationCost;
  /** 决策入账（pending 登记 + 认知经济计数） */
  private record;
  /** 晋升草稿（同状态连续同计划成功计数） */
  private drafts;
}
//#endregion
//#region src/core/theorist.d.ts
/** 定律成员（作用域内一条边的归纳明细） */
interface TheoryMember {
  from: string;
  to: string;
  /** do=1 臂衰减证据 */
  successes: number;
  failures: number;
  /** MLE 成功率（归纳投票口径） */
  phat: number;
  /**
   * 入伙收益（nat）：该边数据在定律下的边际对数似然（其余成员的
   * 汇聚后验作预测先验）− 自立门户的先验预测对数似然。
   * ≤ 0 = 反常者——它的数据用全族知识解释还不如自己单干。
   */
  fitsLawNat: number;
  /** 自立门户的先验预测对数似然（nat）：ln B(1+s, 1+f) */
  standaloneLogMlNat: number;
  /** 反常者：fitsLawNat ≤ 0（不属于这条定律——新范式的种子） */
  anomalous: boolean;
}
/** 归纳出的定律 */
interface Theory {
  /** 作用域标识 family→to */
  id: string;
  /** from 节点的族（id 冒号前缀；无冒号即整体） */
  family: string;
  to: string;
  /** 定律后验 Beta(1+Σs, 1+Σf) */
  lawAlpha: number;
  lawBeta: number;
  /** 定律成功率（后验均值） */
  lawP: number;
  /** 定律 Wilson 区间（比任何单边窄——借力收缩） */
  lawLower: number;
  lawUpper: number;
  /** 幸存成员（构成定律的证据） */
  members: TheoryMember[];
  /** 范式转移中被驱逐的 outlier（新范式的种子） */
  outliers: TheoryMember[];
  /**
   * 定律 vs 各自为政的精确对数贝叶斯因子（nat；>0 定律才配存在）：
   * ln B(1+Σs, 1+Σf) − Σ ln B(1+sᵢ, 1+fᵢ)
   * 共享 θ 用一个参数解释全部数据 vs 每条边各自付一个参数的代价。
   */
  compressionNat: number;
  /** 本次归纳是否发生范式转移（驱逐重建） */
  paradigmShift: boolean;
  /** law：全员一致；contested：存在反常者（定律存疑） */
  status: 'law' | 'contested';
  inducedAt: number;
}
/** 定律零样本预测（作用域内臂证据稀疏的边） */
interface TheoryPrediction {
  theoryId: string;
  p: number;
  lower: number;
  upper: number;
}
/** 理论前沿（meta-cognition 第六层 KPI） */
interface TheoryFrontier {
  /** 在世定律数 */
  theories: number;
  /** 被定律压缩的边数（不再各自为政） */
  compressedEdges: number;
  /** outlier 边数（新范式种子） */
  outlierEdges: number;
  /** 全部定律累计压缩（nat——理解的总账） */
  compressionNat: number;
  /** 零样本预测次数（定律泛化的使用量） */
  zeroShotPredictions: number;
  /** 范式转移累计次数 */
  paradigmShifts: number;
  interpretation: string;
}
interface TheoristConfig {
  /** 立定律的最小成员数（缺省 3：两条边的一致不足以称定律） */
  minMembers: number;
  /** 零样本预测的臂证据门槛：n ≥ 该值的边用自己的后验（缺省 1） */
  zeroShotMaxArmSamples: number;
}
declare const DEFAULT_THEORIST_CONFIG: TheoristConfig;
/**
 * 理论内核：定律归纳 + MDL 压缩定价 + 零样本预测 + 反常/范式转移。
 *
 * 数据流：
 *   kernel.allEdgesEvidence（原料）→ induce（按 family→to 分组、
 *   MDL 仲裁、范式转移）→ predict（定律零样本）→ frontier（第六层 KPI）
 *
 * 归纳是因果图的纯函数（确定性、可重放）；缓存仅避免重复计算。
 */
declare class TheoristEngine {
  private config;
  private kernel;
  private cached;
  private induced;
  private zeroShotCount;
  private paradigmShiftCount;
  /** 各作用域上次范式转移的成员签名（同状态重复归纳不重复计数） */
  private shiftSignatures;
  constructor(kernel: CausalKernel, config?: Partial<TheoristConfig>);
  /**
   * 归纳定律：扫描因果图全边，按 (family(from) → to) 分组，
   * 每组做 MDL 仲裁——compression > 0 才立定律；
   * 整组不抵代价时驱逐最大偏离者（范式转移）为幸存者重建。
   */
  induce(now?: number): Theory[];
  /** 覆盖 (from → to) 的在世定律（无缓存时惰性归纳） */
  coveringTheory(from: string, to: string, now?: number): Theory | undefined;
  /**
   * 定律零样本预测：作用域内臂证据稀疏的边直接拿定律后验说话。
   * 新成员入族即继承全族知识——定律覆盖处无冷启动。
   */
  predict(from: string, to: string, now?: number): TheoryPrediction | undefined;
  /** 在世定律只读视图 */
  allTheories(): Theory[];
  /**
   * 理论前沿报告（第六层 KPI：知识的压缩与体系化）。
   * 每次读取都基于当前因果图重归纳——KPI 永不呈现过期定律，
   * 且宿主无需显式调用 induce（挂载即生效；归纳是纯函数，
   * 心跳粒度重算成本 O(边数)，范式转移计数已去重防虚增）。
   */
  frontier(now?: number): TheoryFrontier;
  /** 对一组成员计算定律与模型比较账目（纯函数） */
  private evaluate;
}
//#endregion
//#region src/core/scientist.d.ts
/** 已登记的因果问题（实验设计的问题空间） */
interface CausalQuestion {
  from: string;
  to: string;
  /** 登记理由（审计：为什么这个因果问题值得回答） */
  why: string;
  /** 单次实验代价（nat；与 EIG 同货币，缺省由引擎配置） */
  costNat?: number;
  createdAt: number;
}
/** 设计好的实验（可执行单元） */
interface DesignedExperiment {
  /** 实验标识（结算回引用） */
  id: number;
  from: string;
  to: string;
  /** 最优臂（EIG 较大的干预方向） */
  arm: boolean;
  /** 该臂一步期望信息增益（nat，未含混杂加成） */
  armEig: number;
  /** 混杂加成（nat；该边因果分歧只能由干预裁决） */
  confoundingBonus: number;
  /** 总价值 = armEig + confoundingBonus + lawBonus（nat） */
  totalEig: number;
  /** 净价值 = totalEig − costNat（nat；>0 才值得做） */
  netValue: number;
  /** 11.0：定律试验加成（nat；作用域内一次实验同时检验压缩 K 条边的定律） */
  lawBonus: number;
  /** 臂后验（设计时口径；结算对账用） */
  priorAlpha: number;
  priorBeta: number;
  /** 预测臂成功率（后验均值） */
  predictedP: number;
  hypothesis: string;
  rationale: string;
}
/** 实验结算（信息台账单元） */
interface ExperimentLedgerEntry {
  experimentId: number;
  from: string;
  to: string;
  arm: boolean;
  observedY: boolean;
  /** 承诺的 EIG（nat，设计时口径） */
  promisedEig: number;
  /** 实际换到的熵收缩（nat，可测：H0 − H(结局后验)） */
  realizedInfo: number;
  /** 结局惊奇（nat，−ln P(实际结局)） */
  surprisal: number;
  settledAt: number;
}
/** 知识前沿（meta-cognition 第五层 KPI） */
interface KnowledgeFrontier {
  /** 已登记因果问题数 */
  questions: number;
  /** 存在混杂分歧的问题数（只能干预裁决） */
  confoundedQuestions: number;
  /** 所有问题两臂残差熵总和（nat；知识版图的总未知量） */
  residualEntropyNat: number;
  /** 已执行实验数 */
  experimentsRun: number;
  /** 累计设计 EIG（nat，承诺） */
  cumulativePromisedNat: number;
  /** 累计实现信息增益（nat，实测） */
  cumulativeRealizedNat: number;
  /** 设计兑现率 = realized / promised（0~1+） */
  deliveryRate: number;
  /** 设计校准 EMA（|承诺−实现|：设计者诚实度，越低越准） */
  designCalibration: number;
  interpretation: string;
}
interface ScientistConfig {
  /** 缺省单次实验代价（nat；EIG 低于此值的问题不值得做，缺省 0.05） */
  defaultCostNat: number;
  /** 混杂加成上限（nat；缺省 1.0 ≈ 一次二分问题的价值） */
  maxConfoundingBonus: number;
  /** 11.0：定律试验加成上限（nat；缺省 1.0——单实验不因定律加成无限膨胀） */
  lawBonusCap: number;
  /** 实验开始的最小臂证据门槛（样本少于该值才算前沿，缺省 0） */
  minArmSamples: number;
  /** 设计校准 EMA 平滑（缺省 0.3） */
  calibrationAlpha: number;
}
declare const DEFAULT_SCIENTIST_CONFIG: ScientistConfig;
/**
 * 科学家内核：EIG 实验设计 + 混杂侦测加成 + 最优臂选择 + 预算仲裁
 * + 信息台账 + 知识前沿。
 *
 * 数据流：
 *   registerQuestion（问题空间）→ designExperiments（最优设计）
 *   → 宿主执行 do-干预 → settleExperiment（图更新 + 惊奇回流 + 台账）
 *   → knowledgeFrontier（知识版图收缩可审计）
 */
declare class ScientistMind {
  private config;
  private kernel;
  private freeEnergy?;
  /** 11.0：理论内核（挂载后作用域内的问题获得定律试验加成） */
  private theorist?;
  private questions;
  private ledger;
  private experimentCounter;
  private cumulativePromised;
  private cumulativeRealized;
  private calibrationEma;
  constructor(kernel: CausalKernel, freeEnergy?: FreeEnergyEngine, config?: Partial<ScientistConfig>);
  /** 挂载自由能引擎（实验结局的惊奇回流；幂等） */
  attachFreeEnergyEngine(engine: FreeEnergyEngine): void;
  /** 11.0：挂载理论内核（定律试验加成；幂等） */
  attachTheorist(theorist: TheoristEngine): void;
  /**
   * 登记因果问题：一条值得回答的「X 是否导致 Y」。
   * 问题空间由宿主/好奇心/调度器声明——科学家只对已声明的问题设计实验。
   */
  registerQuestion(from: string, to: string, why?: string, costNat?: number): CausalQuestion;
  /** 注销问题（问题被回答或不再关心） */
  unregisterQuestion(from: string, to: string): boolean;
  /** 问题空间只读视图 */
  allQuestions(): CausalQuestion[];
  /**
   * 最优实验设计：对问题空间逐一计算 EIG，按净价值排序。
   *
   * 每个问题的评估：
   *   1. 两臂 Beta(1+s, 1+f) 重构（与因果内核 effect() 同数学）
   *   2. 各臂 EIG = 一步期望熵收缩；取大者为最优臂
   *   3. 混杂加成 = −ln(1 − confounding)（背离只能干预裁决）
   *   4. netValue = totalEig − costNat；≤0 不设计（预算仲裁）
   *
   * @param maxCount 最多返回的设计数（组合预算）
   */
  designExperiments(maxCount?: number, now?: number): DesignedExperiment[];
  /**
   * 结算实验：宿主已按设计执行 do-干预并观测到 Y。
   *
   * 三重回流 + 台账：
   * 1. 因果内核干预证据入库（黄金证据）
   * 2. 自由能惊奇回流（预测 vs 结局）
   * 3. 台账：承诺 EIG vs 实际熵收缩（设计校准）
   *
   * @returns 台账条目；设计不存在或重复结算返回 undefined
   */
  settleExperiment(design: DesignedExperiment, observedY: boolean, actor?: string, now?: number): ExperimentLedgerEntry | undefined;
  /** 知识前沿报告：知识版图的总未知量与设计的兑现率（第五层 KPI） */
  knowledgeFrontier(now?: number): KnowledgeFrontier;
  /** 台账只读视图（审计） */
  experimentLedger(): ExperimentLedgerEntry[];
}
//#endregion
//#region src/meta-cognition.d.ts
/** KPI 快照 */
interface KpiSnapshot {
  timestamp: number;
  /** 执行成功率 0~1 */
  successRate: number;
  /** 平均质量分 0~1 */
  avgQuality: number;
  /** 平均延迟（毫秒） */
  avgLatency: number;
  /** 决策缓存命中率 0~1 */
  cacheHitRate: number;
  /** 各模型成功率（模型健康度） */
  modelSuccessRates: Record<string, number>;
  /** 当前活跃执行数 */
  activeExecutions: number;
}
/** KPI 异常事件 */
interface KpiAnomaly {
  kpi: string;
  value: number;
  /** 窗口均值 */
  baseline: number;
  /** z-score（绝对值） */
  zScore: number;
  direction: 'degraded' | 'improved';
  timestamp: number;
}
/** 参数调整动作 */
interface TuningAction {
  parameter: 'qualityThreshold' | 'maxRetries' | 'aggregationWindow';
  from: number;
  to: number;
  reason: string;
  timestamp: number;
  /** 5.0：因果依据（该旋钮对目标 KPI 的干预效应估计） */
  causalBasis?: {
    ate: number;
    lower: number;
    confidence: number;
    interventionalSamples: number;
  };
}
/** 健康报告 */
interface HealthReport {
  healthy: boolean;
  score: number;
  message?: string;
  samples?: number;
  kpis: {
    successRate?: number;
    avgQuality?: number;
    avgLatency?: number;
    cacheHitRate?: number;
  };
  degradeStreaks?: Record<string, number>;
  recentAnomalies?: KpiAnomaly[];
  recentTuning?: TuningAction[];
  /**
   * 6.0：感知侧自由能（EMA 惊奇，nat）——统一健康度。
   *
   * 与逐项 KPI 的本质区别：KPI 各自为政（成功率降/质量降/缓存降），
   * 自由能度量的是系统生成模型对世界的「预测握力」——无论哪项
   * 漂移，惊奇都会上升。一个数字回答「系统整体还理解这个世界吗」。
   */
  freeEnergy?: {
    surprisalEma: number;
    samples: number;
    interpretation: string;
  };
  /**
   * 7.0：梦校准（深思心智的想象可靠性 KPI）。
   *
   * 自由能度量「系统预测世界有多准」；梦校准度量「系统预测
   * **自己的计划**有多准」——想象推演 vs 真实执行的逐步误差。
   * 校准差 = 计划在脑内排练的成绩与现实的落差：想象不可信时，
   * 深思搜索的结论全部作废（应先修转移模型再规划）。
   */
  imagination?: {
    calibrationEma: number;
    plansSettled: number;
    skills: number;
    interpretation: string;
  };
  /**
   * 8.0：认知经济（元认知心智 KPI——思考的价格与价值核算）。
   *
   * 自由能度量预测世界的准确度，梦校准度量预测自己计划的准确度；
   * 认知经济度量**思考本身用得值不值**——习惯命中率（摊销节省）、
   * 搜索开销（nat 计价）、模式成功率（思考价值的实测）、元遗憾
   * （本不该省的思考）。三个 KPI 层层递进：世界→计划→心智自身。
   */
  cognitiveEconomy?: CognitiveEconomy;
  /**
   * 9.0：抽象统计（抽象心智 KPI——举一反三的实绩）。
   *
   * 认知经济度量思考用得值不值；抽象统计度量**经验是否跨域流动**：
   * 类比迁移次数、零样本应答（冷状态凭结构同构直接给出非无知
   * 估计）、后继结构继承、跨域宏技能数。KPI 第四层：世界→计划→
   * 心智→心智的泛化能力。
   */
  abstraction?: AbstractionStats;
  /**
   * 10.0：知识前沿（科学家心智 KPI——知识获取的经济学）。
   *
   * 抽象统计度量经验是否跨域流动；知识前沿度量**求知本身值不值**：
   * 因果问题的残差熵总量（知识版图的未知量）、混杂分歧数（唯有
   * 干预可裁决）、实验兑现率（承诺 EIG vs 实现信息增益——设计者
   * 诚实度的内生度量）。KPI 第五层：世界→计划→心智→泛化→求知。
   */
  knowledgeFrontier?: KnowledgeFrontier;
  /**
   * 11.0：理论前沿（理论心智 KPI——知识的压缩与体系化）。
   *
   * 知识前沿度量求知值不值；理论前沿度量**知识是否成体系**：
   * 在世定律数、被压缩的边数、累计省下的描述长度（理解即压缩，
   * nat 口径）、零样本预测次数（定律泛化）、范式转移次数
   * （定律被推翻重建——科学的自我修正力）。KPI 第六层：
   * 世界→计划→心智→泛化→求知→体系化。
   */
  theoryFrontier?: TheoryFrontier;
}
/** 元认知配置 */
interface MetaCognitionConfig {
  /** KPI 历史窗口大小 */
  windowSize: number;
  /** z-score 异常判定阈值 */
  zScoreThreshold: number;
  /** 成功率目标线（低于该值判定退化） */
  successRateTarget: number;
  /** 质量目标线 */
  qualityTarget: number;
  /** 连续低于目标线多少次触发调优 */
  degradeStreakThreshold: number;
  /** 单模型成功率低于该值标记降级 */
  modelHealthThreshold: number;
  /** 参数调整冷却期（毫秒，防止震荡） */
  tuningCooldownMs: number;
  /** 参数调整落地回调（由 index.ts 桥接到真实引擎） */
  applier?: (action: TuningAction) => void;
}
/** 默认配置 */
declare const DEFAULT_META_COGNITION_CONFIG: MetaCognitionConfig;
/**
 * 元认知监控引擎
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳采集 KPI 快照并调用 observe()，
 * 引擎自动完成异常检测、参数调优与自愈洞察产出。
 */
declare class MetaCognitionEngine {
  private config;
  private history;
  private anomalies;
  private tuningHistory;
  /** 各 KPI 连续低于目标线的次数 */
  private degradeStreaks;
  private lastTuningAt;
  /** 5.0：因果内核（挂载后旋钮推荐按因果效应排序） */
  private causal?;
  /** 待结算的调参干预（动作 → 下一批 KPI 快照对账） */
  private pendingTuningInterventions;
  constructor(config?: Partial<MetaCognitionConfig>);
  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: CausalKernel): void;
  /** 6.0：挂载自由能引擎（幂等；健康报告开始携带统一自由能 KPI） */
  attachFreeEnergyEngine(engine: FreeEnergyEngine): void;
  /** 7.0：挂载深思内核（梦校准 KPI 数据源；幂等） */
  attachDeliberationEngine(engine: DeliberationEngine): void;
  /** 8.0：挂载元推理内核（认知经济 KPI 数据源；幂等） */
  attachMetareasoner(reasoner: RationalMetareasoner): void;
  /** 9.0：挂载抽象内核（抽象统计 KPI 数据源；幂等） */
  attachAbstractionEngine(engine: AbstractionEngine): void;
  /** 10.0：挂载科学家内核（知识前沿 KPI 数据源；幂等） */
  attachScientistMind(mind: ScientistMind): void;
  /** 11.0：挂载理论内核（理论前沿 KPI 数据源；幂等） */
  attachTheoristEngine(engine: TheoristEngine): void;
  private freeEnergyEngine?;
  private theoristEngine?;
  private deliberationEngine?;
  private metareasoner?;
  private abstractionEngine?;
  private scientistMind?;
  /**
   * 5.0：因果旋钮排序 —— 哪个旋钮真正导致了目标 KPI 的改善。
   *
   * 质变点：旧版 tryTune 是「if KPI 退化 then 固定规则调某旋钮」——
   * 规则命中顺序即优先级，与旋钮真实效果无关。挂载因果内核后，
   * 旋钮推荐改按 do-干预效应下界 × 置信度排序：调过且被实验证实
   * 有效的旋钮优先，混杂严重（观测相关但实验无效）的旋钮沉底。
   *
   * @param targetKpi 退化中的 KPI（如 'successRate'）
   */
  rankTuningKnobs(targetKpi: string): CausalEffect[];
  /**
   * 5.0：调参干预对账 —— 上次调参后 KPI 是否真的改善。
   *
   * 在 observe() 每批快照后自动调用：基线 → 干预后首个快照的比较
   * 结果作为 do-干预的 observedY 写回因果图（黄金证据闭环：
   * 调参 = 干预，下批 KPI = 实验结果，图更新 = 学习）。
   */
  private settleTuningInterventions;
  /** 登记待对账的调参干预（内部：动作落地后基线快照） */
  private registerTuningIntervention;
  /**
   * 观察一次 KPI 快照（元认知主入口）
   * @returns 本轮产出的自愈洞察（交给目标引擎）
   */
  observe(snapshot: KpiSnapshot): Insight[];
  /** 最近一次健康报告 */
  getHealthReport(): HealthReport;
  /** 调优历史 */
  getTuningHistory(): TuningAction[];
  /** 异常历史 */
  getAnomalies(): KpiAnomaly[];
  /** KPI 历史（只读快照） */
  getHistory(): KpiSnapshot[];
  /** z-score 异常检测 */
  private detectAnomaly;
  /** 退化检测：连续低于目标线 → 参数自调优 + 自愈洞察 */
  private checkDegradation;
  /**
   * 参数自调优策略
   *
   * 5.0 质变：挂载因果内核后，旋钮选择按因果证据而非规则命中顺序——
   * 1. rankTuningKnobs(kpi) 查询已确立的正因果旋钮（实验证实调它有效），
   *    有效应下界最高者优先，动作携带 causalBasis；
   * 2. 无因果证据时回退既有规则（零行为漂移）；
   * 3. 每次落地动作登记为待对账干预：下批 KPI 快照 = 实验读数，
   *    成败自动写回因果图（元认知从「调参」升级为「做实验」）。
   */
  private tryTune;
  /** 模型健康度检查：单模型成功率过低 → 自愈洞察 */
  private checkModelHealth;
}
//#endregion
//#region src/core/evidence.d.ts
/**
 * evidence.ts — 统一证据内核（项目 3.0「全层证据统一 + 自知之明」基石）
 *
 * 项目级质升前的问题（勘察结论）：
 * - 时间衰减 / Wilson 下界 / Beta 后验只服务于模型画像（ModelTaskStats）一层；
 *   蒸馏策略、语义记忆、程序记忆仍用裸 confidence + 裸计数，检索排序裸置信度；
 * - 沙盒校准读裸 avgQualityScore / totalCalls，旧证据与漂移无法感知；
 * - 各层统计口径（confidence / posteriorMean / wilsonLower）混用互不可比。
 *
 * 本内核把同一套统计语言铺到所有记忆层：
 * - wilsonLowerBound：小样本保守的置信下界（排序与校准的统一度量）
 * - decayFactor：时间衰减（30 天半衰期，旧证据自然让位）
 * - MemoryEvidence：可持久化的时间加权 Beta 证据（ws/wf/lastDecayedAt）
 * - observeEvidence：写入式观测（惰性衰减 + 累积，读取零开销）
 * - readEvidence：读取式视图（纯函数衰减，不回写）
 * - evidenceRankScore：证据化排序分（confidence × Wilson 下界等权混合；
 *   无证据时回退裸 confidence，行为与升级前逐位一致——并行旁路设计）
 *
 * 兼容性：旧格式记忆无 evidence 字段 → 首次观测时从裸计数按 0.5 折价初始化
 * （与模型画像 legacy 回退语义一致），confidence 更新公式保持不变。
 */
/** Wilson 置信下界（纯函数，全部层共享的统一不确定性度量） */
declare function wilsonLowerBound(successes: number, failures: number, z?: number): number;
/** 证据时间衰减半衰期（天）——30 天前的证据权重折半 */
declare const DECAY_HALF_LIFE_DAYS = 30;
/** Beta 先验强度（均匀先验 Beta(1,1)） */
declare const BAYES_PRIOR_STRENGTH = 1;
/** 证据参与排序/校准的最小有效样本量（低于此值回退裸 confidence） */
declare const EVIDENCE_MIN_SAMPLES = 3;
/** 旧格式（无时间信息）证据折价系数 */
declare const LEGACY_EVIDENCE_DISCOUNT = 0.5;
/** 排序混合权重：confidence 与 Wilson 下界各占一半 */
declare const EVIDENCE_RANK_BLEND = 0.5;
/** 时间衰减因子：0.5 ^ (elapsedMs / halfLife），未来时间不放大 */
declare function decayFactor(elapsedMs: number, halfLifeDays?: number): number;
/**
 * 可持久化的时间加权 Beta 证据
 *
 * 挂载于 DistilledStrategy / SemanticMemory / ProceduralMemory 的可选字段
 * evidence（并行旁路：不改变宿主实体的 confidence 语义）。
 */
interface MemoryEvidence {
  /** 时间加权成功证据（半衰期 30 天惰性累积） */
  weightedSuccesses: number;
  /** 时间加权失败证据 */
  weightedFailures: number;
  /** 幂等衰减基准（上次证据衰减时间戳） */
  lastDecayedAt: number;
}
/** 从裸计数初始化证据（无时间信息 → 0.5 折价，与模型画像 legacy 回退一致） */
declare function initEvidence(successes: number, total: number, at: number): MemoryEvidence;
/** 写入式观测：先惰性衰减到 now，再计入新证据（原地更新，读取零开销） */
declare function observeEvidence(evidence: MemoryEvidence, success: boolean, now: number): void;
/** 证据读取视图（Beta 后验 + Wilson 下界 + 有效样本量） */
interface EvidenceView {
  weightedSuccesses: number;
  weightedFailures: number;
  effectiveSamples: number;
  posteriorMean: number;
  wilsonLower: number;
}
/** 读取式视图：纯函数衰减（不回写），供排序/报告/沙盒校准消费 */
declare function readEvidence(evidence: MemoryEvidence, now: number): EvidenceView;
/**
 * 证据化排序分：confidence 与 Wilson 下界等权混合
 *
 * 质变：0.95 置信度但仅 3 次应用（下界 ≈ 0.44）的记忆，排序分 ≈ 0.70；
 * 0.85 置信度且 50 次应用 48 成（下界 ≈ 0.79）的记忆，排序分 ≈ 0.82——
 * 小样本高置信不再压过大样本稳置信。
 *
 * 兼容：无证据或有效样本 < EVIDENCE_MIN_SAMPLES → 原样返回 confidence
 * （与升级前排序行为逐位一致，既有消费方零感知）。
 */
declare function evidenceRankScore(confidence: number, evidence: MemoryEvidence | undefined, now: number): number;
//#endregion
//#region src/strategy-evolution.d.ts
/** 基因组基因（决策引擎可调超参数子集） */
interface StrategyGenes {
  suppressionWindowMs: number;
  failureEscalationThreshold: number;
  lowConfidenceThreshold: number;
  costDeferRatio: number;
  burstOccurrences: number;
}
/** 策略基因组 */
interface StrategyGenome {
  id: string;
  genes: StrategyGenes;
  /** 应用次数 */
  applications: number;
  /** 累计收益 */
  totalReward: number;
  /** 平均收益（适应度） */
  meanReward: number;
  /** 时间加权证据（4.0：连续收益证据化；旧数据无此字段回退 meanReward） */
  evidence?: MemoryEvidence;
  generation: number;
  createdAt: number;
}
/** 进化报告 */
interface EvolutionReport {
  generation: number;
  elites: string[];
  born: string[];
  eliminated: string[];
  bestMeanReward: number;
  populationMeanReward: number;
}
/** 策略进化配置 */
interface StrategyEvolutionConfig {
  /** 种群规模 */
  populationSize: number;
  /** UCB 探索常数 */
  explorationConstant: number;
  /** 变异概率（每个基因） */
  mutationRate: number;
  /** 变异强度（相对基因取值范围的比例） */
  mutationStrength: number;
  /** 精英保留数 */
  eliteCount: number;
  /** 触发进化所需的最小累计应用次数（相对上次进化） */
  minApplicationsBetweenEvolutions: number;
  /** 参与精英评定的最小应用次数（防止小样本侥幸） */
  minApplicationsForElite: number;
  /** 随机源（测试可注入确定性实现） */
  rng?: () => number;
}
/** 默认配置 */
declare const DEFAULT_STRATEGY_EVOLUTION_CONFIG: StrategyEvolutionConfig;
/** 种群报告（运维可观测） */
interface EvolutionStatusReport {
  generation: number;
  populationSize: number;
  applicationsSinceEvolution: number;
  populationMeanReward: number;
  genomes: Array<{
    id: string;
    generation: number;
    applications: number;
    meanReward: number;
    genes: StrategyGenes;
  }>;
  bestGenome: string;
  recentEvolutions: EvolutionReport[];
}
/**
 * 决策策略在线进化引擎
 *
 * 被 index.ts 持有：决策引擎每次决策前通过 selectGenome() 获取当前基因组
 * （其基因作为决策引擎运行时参数），决策结果经 recordOutcome() 回写适应度，
 * autonomy-loop 定期调用 evolve() 驱动种群进化。
 */
declare class StrategyEvolutionEngine {
  private config;
  private population;
  private genomeCounter;
  private generation;
  private applicationsSinceEvolution;
  private evolutionHistory;
  private rng;
  constructor(config?: Partial<StrategyEvolutionConfig>);
  /**
   * UCB1 选择当前基因组（探索-利用平衡；4.0 利用项 = 证据化适应度）
   *
   * 利用项与适应度同源（Wilson 下界 × 置信折扣），探索项保持 UCB1
   * 对数置信宽度——探索与利用在同一证据口径下平衡。
   * @returns 选中的基因组
   */
  selectGenome(): StrategyGenome;
  /**
   * 回写决策结果（适应度反馈）
   * @param genomeId 基因组 id
   * @param outcome 决策执行后的实际结果
   */
  recordOutcome(genomeId: string, outcome: string): void;
  /**
   * 触发一轮进化（精英保留 + 锦标赛选择 + 高斯变异）
   * @param force 强制进化（忽略最小应用次数门槛）
   * @returns 进化报告；未达门槛时返回 null
   */
  evolve(force?: boolean): EvolutionReport | null;
  /** 最优基因组（应用次数达标者中平均收益最高） */
  bestGenome(): StrategyGenome;
  /** 最优基因组 → 决策引擎配置片段（进化产物落地） */
  bestGenesAsConfig(): Partial<DecisionEngineConfig>;
  /** 种群报告 */
  getReport(): EvolutionStatusReport;
  /** 进化历史 */
  getEvolutionHistory(): EvolutionReport[];
  /** 初始种群：基准基因组 + 扰动变体 */
  private seedPopulation;
  /** 创建新基因组 */
  private createGenome;
  /**
   * 适应度（4.0 证据化）：证据后验 Wilson 置信下界 × 小样本置信折扣
   *
   * 有时间加权证据的基因组用 Wilson 下界（小样本保守、防侥幸、旧结果
   * 自然衰减）；无证据（未观测/旧数据）回退 meanReward × 折扣。
   */
  private fitness;
  /** 锦标赛选择（3 选 1） */
  private tournamentSelect;
  /** 高斯变异：按变异概率逐基因扰动 */
  private mutate;
  /** 种群平均收益 */
  private populationMeanReward;
}
//#endregion
//#region src/policy/policy-types.d.ts
/**
 * policy-types.ts — 第三阶段「策略进化」核心数据结构与共享评分函数
 *
 * 设计要点：
 * - 策略空间：模型评分函数权重 + 任务分解规则 + 模型组合逻辑（10 个可进化基因）
 * - 基准策略参数严格复刻 ModelScheduler 原固定值 → 未部署进化策略时行为与
 *   第二阶段完全一致（向后兼容验收点）
 * - 评分函数提取为纯函数 scoreModelWithPolicy：操作环（ModelScheduler）与
 *   沙盒（Sandbox）共用同一实现，保证沙盒评估对真实调度行为的保真度
 * - 全部结构可直接 JSON 序列化（Policy 即持久化格式）
 */
/** 规则匹配上下文（任务调度现场装配；沙盒评估提供完整上下文） */
interface PolicyMatchContext {
  taskType: string;
  complexity?: number;
  features?: string[];
}
/**
 * 条件-动作规则（规则基因组，质级升级）
 *
 * 超越全局标量权重的上下文敏感调度单元：满足条件时对有效参数施加
 * 增量调整（成本/记忆权重偏移）或直接覆盖分解/集成开关。
 * 规则按 priority 升序依次叠加；可变长度（0~MAX_POLICY_RULES 条），
 * 支持增加/删除/修改三类变异与双亲子集交叉。
 */
interface PolicyRule {
  id: string;
  /** 匹配条件（空字段 = 不限制） */
  when: {
    /** 匹配这些任务类型之一（空 = 任意类型） */
    taskTypes?: string[];
    /** 最小复杂度（缺省 0） */
    minComplexity?: number;
    /** 最大复杂度（缺省 1） */
    maxComplexity?: number;
    /** 含有任一特征标签即匹配（空 = 任意特征） */
    features?: string[];
  };
  /** 匹配时的动作 */
  action: {
    /** 成本权重增量（钳制后仍在基因边界内） */
    costWeightDelta?: number;
    /** 记忆基础权重增量 */
    memoryWeightBaseDelta?: number;
    /** 覆盖集成开关（undefined = 不覆盖） */
    ensembleForce?: boolean;
    /** 覆盖分解开关（undefined = 不覆盖） */
    decomposeForce?: boolean;
  };
  /** 应用顺序（小者优先） */
  priority: number;
}
/** 单策略最大规则数（防规则爆炸） */
declare const MAX_POLICY_RULES = 4;
/** 规则增量幅度边界 */
declare const POLICY_RULE_DELTA_BOUNDS: {
  min: number;
  max: number;
};
/**
 * 调度策略参数（策略基因）
 *
 * 两层基因组：
 * 1. 全局标量基因：评分权重 + 分解阈值 + 集成参数（10 个）
 * 2. 规则基因（rules）：上下文敏感的条件-动作覆盖层（可变长度）
 */
interface SchedulerPolicyParams {
  /** 成本感知权重 0~1（0=纯质量导向，1=纯成本导向） */
  costWeight: number;
  /** 记忆画像基础权重（有历史数据时的起始信任度） */
  memoryWeightBase: number;
  /** 记忆画像权重随历史调用量 的增长率 */
  memoryWeightGrowth: number;
  /** 记忆画像权重上限 */
  memoryWeightCap: number;
  /** 是否启用任务分解 */
  decomposeEnabled: boolean;
  /** 触发分解的任务复杂度阈值 */
  decomposeComplexityThreshold: number;
  /** 分解出的最大子任务数 */
  decomposeMaxSubtasks: number;
  /** 是否启用多模型集成（最高分与次高分差距小于 gap 时并行执行取融合） */
  ensembleEnabled: boolean;
  /** 触发集成的分数差阈值 */
  ensembleScoreGap: number;
  /** 集成的最大模型数 */
  ensembleMaxModels: number;
  rules?: PolicyRule[];
}
/** 策略适应度记录（沙盒评估产出，随策略持久化） */
interface PolicyFitness {
  /** 沙盒综合收益 reward（0~1） */
  score: number;
  successRate: number;
  avgQuality: number;
  avgLatencyMs: number;
  totalTokens: number;
  /** 评估任务数 */
  evaluatedTasks: number;
  evaluatedAt: number;
}
/**
 * 策略（序列化格式）
 *
 * 可追溯性：id 唯一、version 随部署谱系单调递增、generation 记录进化代际、
 * parentId 指向父代策略（交叉时另有 secondaryParentId 双亲）、origin 标记
 * 来源、fitness 携带最近评估表现数据。
 */
interface Policy {
  id: string;
  /** 版本（部署谱系单调递增；候选变体基于当前版本 +1 竞争下一版本槽位） */
  version: number;
  /** 策略类型（当前仅调度策略；预留扩展） */
  type: 'scheduler';
  params: SchedulerPolicyParams;
  /** 来源：baseline 基准 / mutation 变异 / crossover 交叉 / explorer 边界内随机探索 / manual 人工注入 */
  origin: 'baseline' | 'mutation' | 'crossover' | 'explorer' | 'manual';
  /** 进化代际（每轮进化周期 +1） */
  generation: number;
  /** 父代策略 id（可追溯进化链） */
  parentId?: string;
  /** 交叉第二亲代 id（仅 origin=crossover） */
  secondaryParentId?: string;
  /** 适应度（评估后回填） */
  fitness?: PolicyFitness;
  createdAt: number;
  /** 部署时间（未部署为空） */
  deployedAt?: number;
}
/** 沙盒任务（历史回放 / 对抗合成） */
interface SandboxTask {
  taskType: string;
  /** 复杂度 0~1 */
  complexity: number;
  /** 特征标签 */
  features: string[];
  /** 任务文本长度（影响 token 成本模拟） */
  length: number;
  /** 来源：replay 历史回放 / adversarial 对抗合成 */
  source: 'replay' | 'adversarial';
  /** 可读标签（评估报告与调试用） */
  label?: string;
}
/** 沙盒内模拟模型状态（从 LLMClient 运行时状态映射，离线快照） */
interface SimModelStatus {
  id: string;
  /** 能力画像（任务类型 → 适配分 0~1） */
  taskScores: Record<string, number>;
  /** 平均延迟（毫秒） */
  avgLatencyMs: number;
  /** 平均 token 消耗 */
  avgTokens: number;
  maxConcurrency: number;
}
/** 策略评估聚合指标 */
interface PolicyEvaluationMetrics {
  successRate: number;
  avgQuality: number;
  avgLatencyMs: number;
  totalTokens: number;
  /** 分解率（被分解的任务占比） */
  decompositionRate: number;
  /** 集成率（触发多模型集成的任务占比） */
  ensembleRate: number;
}
/**
 * 沙盒评估报告
 *
 * 收益（reward/gain）、风险（risks：参数越界/模拟异常/未知模型）、
 * 回归（regressions：相对 baseline 的成功率/质量/成本退化）三类信息
 * 共同决定 deployable（部署门禁）。
 */
interface EvaluationReport {
  policyId: string;
  baselinePolicyId?: string;
  metrics: PolicyEvaluationMetrics;
  baselineMetrics?: PolicyEvaluationMetrics;
  /** 综合收益 0~1（多种子均值） */
  reward: number;
  baselineReward?: number;
  /** 相对 baseline 的收益提升（多种子均值） */
  gain: number;
  /** 多种子 gain 标准差（0 = 单种子或完全稳定） */
  gainStdDev?: number;
  /** 收益置信下界 gain − 1.96·σ/√n（部署门禁用，防单种子过拟合） */
  gainLCB?: number;
  /** 评估种子数 */
  seeds?: number;
  /** 安全风险（非空 → 不可部署） */
  risks: string[];
  /** 回归项（非空 → 不可部署） */
  regressions: string[];
  /** 部署门禁结论 */
  deployable: boolean;
  taskStats: {
    replayed: number;
    adversarial: number;
  };
  evaluatedAt: number;
}
/** 标量基因键（数值 + 布尔；规则基因为独立可变长度维度） */
type ScalarGeneKey = Exclude<keyof SchedulerPolicyParams, 'rules'>;
/** 基因取值边界（变异钳制 + 部署前校验共用） */
declare const POLICY_GENE_BOUNDS: Record<ScalarGeneKey, {
  min: number;
  max: number;
  integer?: boolean;
}>;
/**
 * 基准策略参数 — 严格复刻 ModelScheduler 第二阶段固定值：
 * costWeight=0.2（index.ts 构造注入）、memoryWeight = min(0.6, 0.2 + n×0.02)、
 * 分解与集成缺省关闭（第二阶段无此行为）。
 */
declare const BASELINE_POLICY_PARAMS: SchedulerPolicyParams;
/** 单条规则是否匹配上下文（空条件字段 = 不限制） */
declare function policyRuleMatches(rule: PolicyRule, ctx: PolicyMatchContext): boolean;
/**
 * 上下文有效参数解析（规则基因组核心）
 *
 * 以基础标量基因为底，按 priority 升序叠加所有匹配规则的增量与开关覆盖，
 * 结果再经边界钳制 → 任意上下文下的有效参数恒在基因边界内（安全不变量）。
 * rules 为空或无匹配时与基础参数完全一致（向后兼容）。
 */
declare function resolveEffectiveParams(params: SchedulerPolicyParams, ctx: PolicyMatchContext): SchedulerPolicyParams;
/**
 * 参数规范化：越界值钳制到边界 + 缺失字段补基准值 + 规则清洗
 * （沙盒风险检查与部署热切换前的防御性归一，共用一份逻辑）
 */
declare function normalizePolicyParams(params: Partial<SchedulerPolicyParams>): SchedulerPolicyParams;
/** 参数是否全部在边界内（不修改原值的风险检查；含规则数量与增量幅度） */
declare function policyParamsWithinBounds(params: SchedulerPolicyParams): boolean;
/** 单模型评分输入（由调用方从运行时状态或沙盒快照装配） */
interface ModelScoreInput {
  /** 能力画像分（taskScores[taskType] ?? general ?? 0.5） */
  taskScore: number;
  /** 记忆画像成功率（无历史 0.5） */
  memoryScore: number;
  /** 该模型在该任务类型的历史调用量 */
  memoryCalls: number;
  /** 历史平均质量分（无历史 0.5） */
  avgQuality: number;
  /** 平均 token 消耗 */
  avgTokens: number;
}
/**
 * 策略化模型评分（操作环与沙盒共用）
 *
 * 公式（与 ModelScheduler 第二阶段实现同构，参数从策略注入）：
 *   memoryWeight = calls > 0 ? min(cap, base + calls × growth) : 0
 *   qualityScore = taskScore × (1-memoryWeight) + memoryScore × memoryWeight
 *   costEfficiency = clamp(avgQuality × (1 - min(1, avgTokens/10000)))
 *   score = qualityScore × (1-costWeight) + costEfficiency × costWeight
 *
 * 当 params = BASELINE_POLICY_PARAMS 时与原固定实现逐位一致。
 */
declare function scoreModelWithPolicy(params: SchedulerPolicyParams, input: ModelScoreInput): number;
/** 构造基准策略对象（缺省当前策略） */
declare function createBaselinePolicy(id?: string, version?: number): Policy;
//#endregion
//#region src/security/crypto-engine.d.ts
/**
 * crypto-engine.ts — 加密引擎（基础层，无内部依赖）
 *
 * 职责：
 * - 记忆库文件的整体加密 / 解密（fullFileEncryption）
 * - 敏感字段（如 apiKey）的字段级加密 / 解密
 * - 密钥轮换（rotateKey）与多版本密钥链管理
 * - 原子化落盘，避免写入中途崩溃导致记忆库损坏
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 主密钥经 scrypt KDF 派生为 32 字节工作密钥，避免弱口令直接作密钥
 * 2. 密钥链（keychain）支持多版本密钥并存，轮换后历史数据仍可解密
 * 3. 原子写入（tmp + rename），杜绝半写状态的记忆文件
 * 4. 密钥指纹使用 timingSafeEqual 比较，防时序侧信道
 * 5. 敏感字段深度递归扫描，支持任意嵌套层级
 */
/** 加密引擎配置 */
interface EncryptionConfig {
  /** 是否启用加密（关闭时 writeEncrypted 落明文 JSON） */
  enabled: boolean;
  /** 主密钥（任意字符串，内部经 scrypt 派生为工作密钥） */
  masterKey: string;
  /** 加密算法 */
  algorithm: 'aes-256-gcm' | 'aes-256-cbc';
  /** 需要字段级加密的字段名列表（递归匹配任意嵌套层级） */
  sensitiveFields: string[];
  /** 是否对整个文件加密（false 时仅加密敏感字段） */
  fullFileEncryption: boolean;
  /** 已轮换的历史主密钥（旧版本，用于解密历史数据） */
  rotatedKeys?: string[];
}
/** 字段级加密产物 */
interface EncryptedField {
  __encrypted: true;
  algorithm: string;
  iv: string;
  tag?: string;
  ciphertext: string;
  keyVersion: number;
}
/** 整文件加密产物 */
interface EncryptedFile {
  __encrypted_file: true;
  version: number;
  algorithm: string;
  iv: string;
  tag?: string;
  ciphertext: string;
  keyVersion: number;
  createdAt: number;
}
/** 加密操作结果 */
interface CryptoResult {
  success: boolean;
  error?: string;
  fieldsEncrypted?: number;
  fieldsDecrypted?: number;
  fileEncrypted?: boolean;
  fileDecrypted?: boolean;
  keyRotated?: boolean;
}
/**
 * 加密引擎
 *
 * 提供文件级与字段级两种加密粒度，以及密钥轮换能力。
 * 被 LongTermMemory（持久化加密）、DistributedSync（同步载荷加密）、
 * BenchmarkEngine（报告加密）依赖。
 */
declare class CryptoEngine {
  private config;
  /** 密钥链：index 0 对应 keyVersion 1，依次递增 */
  private keychain;
  constructor(config: EncryptionConfig);
  /**
   * 加密整段内容为 EncryptedFile 结构
   * @param content 明文字符串（通常是 JSON.stringify 的结果）
   */
  encryptFile(content: string): EncryptedFile;
  /**
   * 解密 EncryptedFile 结构，还原明文
   * @param file 加密文件结构
   * @throws CryptoError 密钥缺失或认证标签校验失败
   */
  decryptFile(file: EncryptedFile): string;
  /**
   * 递归加密对象中的敏感字段
   * @param obj 任意对象（不会被原地修改，返回深拷贝）
   * @returns 加密后的对象与被加密字段数
   */
  encryptSensitiveFields(obj: any): {
    result: any;
    encryptedCount: number;
  };
  /**
   * 递归解密对象中所有 EncryptedField 结构
   * @param obj 含加密字段的对象（不会被原地修改，返回深拷贝）
   * @returns 解密后的对象与被解密字段数
   */
  decryptSensitiveFields(obj: any): {
    result: any;
    decryptedCount: number;
  };
  /**
   * 将数据加密后写入文件（原子写入）
   *
   * 行为矩阵：
   * - enabled && fullFileEncryption  → 整文件加密
   * - enabled && !fullFileEncryption → 仅加密敏感字段后写明文 JSON
   * - !enabled                       → 直接写明文 JSON
   */
  writeEncrypted(filePath: string, data: any): CryptoResult;
  /**
   * 读取文件并自动解密（兼容明文 / 字段加密 / 整文件加密三种形态）
   */
  readEncrypted(filePath: string): {
    data: any;
    result: CryptoResult;
  };
  /**
   * 密钥轮换：用新主密钥重新加密指定文件
   * @param filePath 目标文件
   * @param newMasterKey 新主密钥
   * @param keepOldKey 是否保留旧密钥到 rotatedKeys（保留后历史 keyVersion 仍可解密）
   */
  rotateKey(filePath: string, newMasterKey: string, keepOldKey?: boolean): CryptoResult;
  /**
   * 生成随机主密钥（64 位 hex）
   */
  static generateKey(): string;
  /**
   * 获取指定版本密钥的指纹（SHA-256 前 16 位 hex），用于安全展示与比对
   * @param version 密钥版本，缺省为当前版本
   */
  getKeyFingerprint(version?: number): string;
  /**
   * 判断磁盘文件是否为整文件加密形态
   */
  static isFileEncrypted(filePath: string): boolean;
  /**
   * 判断对象中是否包含加密字段（任意嵌套层级）
   */
  static hasEncryptedFields(obj: any): boolean;
  /**
   * 时序安全的指纹比对（防时序侧信道）
   * @param a 指纹 A
   * @param b 指纹 B
   */
  static safeCompareFingerprint(a: string, b: string): boolean;
  /** 当前密钥版本号（密钥链长度） */
  private currentKeyVersion;
  /** 当前工作密钥 */
  private currentKey;
  /** 按版本号取密钥 */
  private getKeyByVersion;
  /** scrypt 派生工作密钥 */
  private deriveKey;
  /** 字符串 → EncryptedField */
  private encryptStringToField;
  /** 底层加密原语 */
  private encryptRaw;
  /** 底层解密原语 */
  private decryptRaw;
  /** 原子写入：先写临时文件再 rename，防止半写损坏 */
  private atomicWrite;
}
//#endregion
//#region src/memory/backend.d.ts
/** 持久化后端统一契约 */
interface MemoryBackend {
  readonly kind: 'sqlite' | 'json';
  /** FTS5 检索是否可用（仅 SQLite 后端） */
  readonly ftsAvailable?: boolean;
  /** sqlite-vec 扩展是否加载（仅 SQLite 后端） */
  readonly vecAvailable?: boolean;
  /** 加载记忆库（不存在时返回空库） */
  load(): MemoryStore;
  /** 全量保存记忆库 */
  save(store: MemoryStore): void;
  /** 释放连接/资源 */
  close(): void;
  /** FTS5 全文检索（混合检索增强，仅 SQLite 后端提供） */
  fullTextSearch?(query: string, limit?: number): MemorySearchHit[];
  /** 向量检索（sqlite-vec 不可用时的稀疏向量回退，仅 SQLite 后端提供） */
  vectorSearch?(query: string, limit?: number): MemorySearchHit[];
  integrityCheck?(): string;
  stats?(): {
    patterns: number;
    profiles: number;
    feedback: number;
    strategies: number;
    /** 第二阶段：语义记忆条数 */
    semantic: number;
    /** 第二阶段：程序记忆条数 */
    procedural: number;
    pageSize: number;
    pageCount: number;
    walSize: number;
    schemaVersion: number;
    fts: boolean;
    vec: boolean;
  };
  checkpoint?(): void;
  vacuum?(): void;
  backup?(destPath: string): string;
  rawQuery?(sql: string, params?: Array<string | number | null>): Array<Record<string, unknown>>;
}
/** 空记忆库工厂 */
declare function emptyMemoryStore(): MemoryStore;
/** 结构校验与缺省补全（JSON 加载与旧文件迁移共用） */
declare function sanitizeMemoryStore(raw: unknown): MemoryStore;
/** JSON 持久化路径 → SQLite 文件路径（memory.json → memory.db） */
declare function sqlitePathFor(persistPath: string): string;
/** 宿主是否支持内置 SQLite */
declare function sqliteAvailable(): boolean;
/**
 * 轻量中文分词（jieba 式管道的零依赖实现）：
 * - ASCII/数字串按词切分
 * - 连续 CJK 串切分为二元组（bigram），覆盖无词典场景下的中文词级匹配
 *
 * 若宿主提供真实 jieba 管道（如 jieba-wasm），可通过 setChineseTokenizer 注入替换。
 */
declare function tokenizeChinese(text: string): string[];
/** 注入真实 jieba 分词管道（可选；缺省使用内置轻量分词） */
declare function setChineseTokenizer(fn: ((text: string) => string[]) | null): void;
/** 分词入口：优先外部注入的 jieba 管道，缺省轻量分词 */
declare function segment(text: string): string[];
/** 稀疏词频向量（sqlite-vec 不可用时的零依赖向量检索） */
declare function toSparseVector(text: string): Record<string, number>;
declare function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number;
interface MemorySearchHit {
  /** 联合类型宽化（第二阶段）：新增 semantic / procedural；既有 pattern / strategy 仍合法 */
  kind: 'pattern' | 'strategy' | 'semantic' | 'procedural';
  refId: string;
  score: number;
}
/**
 * SQLite 后端（node:sqlite 内置，零依赖，完全关系化）
 *
 * schema v2：热查询/聚合字段提升为类型化列并建索引，SQL 可直接查询，
 * data 列存完整记录 JSON 保留 schema 演进弹性：
 * - meta(key PK, value)：schema_version / createdAt / lastUpdatedAt / globalStats(JSON)
 * - task_patterns(fingerprint PK, task_type, confidence REAL, frequency, last_seen_at, last_decay_at, data)
 *   + idx(task_type, confidence)：支撑"按类型取最优模式"类 SQL 聚合
 * - model_profiles(id PK, best_task_type, data)
 * - decision_feedback(id PK, ts, signal_type, decision, outcome, data)
 *   + idx(signal_type, ts)：支撑"按信号类型的决策成功率"类 SQL 统计
 * - distilled_strategies(id PK, task_type, confidence REAL, support_count, last_applied_at, data)
 *   + idx(task_type, confidence)
 *
 * 工程特性：
 * - WAL 模式（journal_mode=WAL）：读写不互斥、崩溃恢复更快
 * - 预编译语句缓存（stmt）：热路径零重复编译开销
 * - 增量 UPSERT 同步：save 按主键 upsert + 删除已消失行，不再全表重建
 * - 旧版 v1 blob 表首次打开自动无损升级为 v2
 */
declare class SqliteMemoryBackend implements MemoryBackend {
  readonly kind: 'sqlite';
  private db;
  private dbPath;
  private stmts;
  /** sqlite-vec 扩展是否加载成功（在线/预装环境启用；缺省走零依赖稀疏向量） */
  readonly vecAvailable: boolean;
  /** FTS5 是否可用（node:sqlite 内置；极端裁剪构建可能缺失） */
  readonly ftsAvailable: boolean;
  constructor(dbPath: string);
  /** sqlite-vec 接缝：宿主预装扩展时启用，失败静默回退稀疏向量 */
  private tryLoadVec;
  private createFtsTables;
  /** 预编译语句缓存：同一条 SQL 只编译一次 */
  private stmt;
  /**
   * 版本化迁移框架：按 schema_version 顺序执行 MIGRATIONS 中未应用的步骤，
   * 每步独立事务，失败即停（保留现场便于诊断）。新增迁移只需在数组末尾追加。
   */
  private migrateIfNeeded;
  /** 迁移步骤可访问的内部工具 */
  private hasColumn;
  /** v1（纯 blob 表）→ v2（关系化列）：从 data blob 回填类型化列 */
  private migrateV1toV2;
  private getMeta;
  private setMeta;
  load(): MemoryStore;
  /** 增量同步：按主键 UPSERT + 删除已消失行，单事务保证一致性 */
  save(store: MemoryStore): void;
  /**
   * FTS5 全文检索（混合检索增强）：
   * - trigram 表：原始内容子串级匹配（中文无需分词即可命中）
   * - 分词表：jieba 式 token 级 OR 匹配（词级语义召回）
   * 两路结果按 rank 合并去重。
   */
  fullTextSearch(query: string, limit?: number): MemorySearchHit[];
  /** 稀疏向量检索（sqlite-vec 不可用时的零依赖语义召回） */
  vectorSearch(query: string, limit?: number): MemorySearchHit[];
  /** 完整性检查（PRAGMA integrity_check），返回 ok 或错误描述 */
  integrityCheck(): string;
  /** 数据库统计（运维可观测：行数、页大小、WAL 状态、schema 版本、扩展能力） */
  stats(): {
    patterns: number;
    profiles: number;
    feedback: number;
    strategies: number;
    semantic: number;
    procedural: number;
    pageSize: number;
    pageCount: number;
    walSize: number;
    schemaVersion: number;
    fts: boolean;
    vec: boolean;
  };
  /** WAL checkpoint（TRUNCATE）：把 WAL 合并回主库，缩小文件、便于备份 */
  checkpoint(): void;
  /** VACUUM：回收碎片空间（阻塞式，建议低峰期调用） */
  vacuum(): void;
  /**
   * 热备份：checkpoint 后复制主库文件（node:sqlite 无 backup API，
   * 采用「checkpoint + 文件复制」保证备份一致性），返回备份路径
   */
  backup(destPath: string): string;
  /** 只读查询通道（运维/诊断用；调用方自行保证 SQL 只读） */
  rawQuery(sql: string, params?: Array<string | number | null>): Array<Record<string, unknown>>;
  close(): void;
}
/** JSON 后端（原子写 + 可选加密，回退/兼容路径） */
declare class JsonMemoryBackend implements MemoryBackend {
  private persistPath;
  private cryptoEngine?;
  readonly kind: 'json';
  constructor(persistPath: string, cryptoEngine?: CryptoEngine | undefined);
  load(): MemoryStore;
  save(store: MemoryStore): void;
  close(): void;
}
/**
 * 后端选型：加密启用 → JSON；否则 node:sqlite 可用 → SQLite；不可用 → JSON 回退
 */
declare function createMemoryBackend(persistPath: string, cryptoEngine?: CryptoEngine): MemoryBackend;
//#endregion
//#region src/memory/long-term-memory.d.ts
/** 成功执行记录 */
interface SuccessfulPlanRecord {
  timestamp: number;
  plan: {
    objective: string;
    nodes: Array<{
      id: string;
      description: string;
      type: string;
      dependsOn: string[];
    }>;
    parallelismStrategy: string;
  };
  modelAssignments: Record<string, string>;
  totalLatency: number;
  qualityScores: Record<string, number>;
  tokenCost: number;
}
/** 失败记录 */
interface FailureRecord {
  timestamp: number;
  reason: string;
  failedNodeId: string;
  failedModelId: string;
  errorMessage: string;
}
/** 任务模式记忆 */
interface TaskPatternMemory {
  fingerprint: string;
  taskSummary: string;
  frequency: number;
  firstSeenAt: number;
  lastSeenAt: number;
  successfulPlans: SuccessfulPlanRecord[];
  failureRecords: FailureRecord[];
  confidence: number;
  bestModelCombination?: Record<string, string>;
  avgExecutionTime: number;
  avgQualityScore: number;
  /** 上次遗忘曲线衰减的时间戳（幂等衰减基准；缺省视为 lastSeenAt） */
  lastDecayAt?: number;
}
/** 模型单任务类型统计（2.0：含时间加权贝叶斯证据，旧持久化缺省字段自动回退裸计数） */
interface ModelTaskStats {
  totalCalls: number;
  successCount: number;
  totalLatency: number;
  totalQualityScore: number;
  avgQualityScore: number;
  lastCalledAt: number;
  /** 2.0：时间加权成功计数（半衰期 decayHalfLifeDays，写入时惰性衰减累积） */
  weightedSuccesses?: number;
  /** 2.0：时间加权失败计数 */
  weightedFailures?: number;
  /** 2.0：成功执行质量的指数滑动均值（α=0.3，感知质量漂移） */
  emaQuality?: number;
  /** 2.0：上次时间衰减基准时间戳 */
  lastDecayedAt?: number;
}
/** 模型长期画像 */
interface ModelLongTermProfile {
  id: string;
  name: string;
  taskHistory: Record<string, ModelTaskStats>;
  costEfficiency: Record<string, number>;
  bestTaskType: string;
  worstTaskType: string;
  stability: number;
}
/** 决策反馈 */
interface DecisionFeedback {
  id: string;
  timestamp: number;
  signalType: string;
  signalDescription: string;
  decision: string;
  outcome: 'excellent' | 'good' | 'acceptable' | 'poor' | 'failed';
  outcomeReason: string;
  lesson?: string;
  /** 2.0：决策归因——本次实际选用的模型（校准与反事实分析的数据基础） */
  chosenModelId?: string;
  /** 2.0：调度时预测的成功概率（反思器据此计算校准误差） */
  predictedConfidence?: number;
  /** 2.0：本次是否为探索性选择（UCB 加成胜出） */
  exploration?: boolean;
}
/**
 * 贝叶斯能力估计（2.0：模型 × 任务类型的 Beta 后验推断）
 *
 * 设计动机——裸计数的三个盲区：
 * 1. 无不确定性：3 次全成与 300 次全成同置信 → Wilson 下界按样本量保守折价
 * 2. 无时效：半年前的成功与今天的成功等权 → 时间加权计数让近期证据主导
 * 3. 无漂移感知：模型能力变化（升级/降级）无法察觉 → drift = 加权成功率 - 裸成功率
 */
interface BayesianEstimate {
  modelId: string;
  taskType: string;
  /** Beta 后验参数（含均匀先验 Beta(1,1)） */
  alpha: number;
  beta: number;
  /** 后验均值 = (α)/(α+β)，调度预测置信度来源 */
  posteriorMean: number;
  /** Wilson 95% 置信下界（小样本自动保守，利用端评分依据） */
  wilsonLower: number;
  /** 有效样本量 = weightedSuccesses + weightedFailures（衰减后的等效观测数） */
  effectiveSamples: number;
  /** 裸成功率（对照基准） */
  rawSuccessRate: number;
  /** 近期漂移 = 加权成功率 - 裸成功率（>0 近期更好，<0 近期变差；有效样本 <2 时恒 0） */
  drift: number;
  /** 成功执行质量 EMA（无成功记录时为 0） */
  emaQuality: number;
}
/**
 * Wilson 置信下界：实现迁至 core/evidence.ts（3.0 全层共享），
 * 经文件顶部再导出保持既有导入路径（dist/index.mjs 根导出）兼容。
 */
/** 蒸馏策略（经验蒸馏产物：从成功方案中提炼的可复用决策规则） */
interface DistilledStrategy {
  id: string;
  taskType: string;
  /** 策略描述（如"documentation 类任务优先使用 model-b"） */
  description: string;
  /** 提炼依据的模式指纹 */
  sourceFingerprint: string;
  /** 支撑该策略的成功次数 */
  supportCount: number;
  /** 策略置信度 0~1 */
  confidence: number;
  distilledAt: number;
  /** 应用该策略后的成功次数（反馈闭环） */
  appliedSuccesses: number;
  appliedTotal: number;
  /** 上次被应用/验证的时间戳（置信度衰减基准；缺省视为 distilledAt） */
  lastAppliedAt?: number;
  /**
   * 3.0：时间加权 Beta 证据（并行旁路——不改变 confidence 语义，
   * 供证据化排序 / 证据普查 / 自知之明报告消费；旧格式缺省视为无证据）
   */
  evidence?: MemoryEvidence;
}
/** 语义记忆条件维度 */
type SemanticConditionDimension = 'task-type' | 'feature' | 'complexity' | 'length' | 'token-cost';
/** 语义记忆条件（与程序记忆条件结构一致，类型独立以便演进） */
interface SemanticCondition {
  dimension: SemanticConditionDimension;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}
/** 语义记忆结论 */
interface SemanticConclusion {
  /** 结论类型：模型偏好 / 并行策略 / 参数微调 */
  type: 'model-preference' | 'parallelism-strategy' | 'parameter-tuning';
  /** 推荐值（按 type 解释：model id / strategy name / 参数字典） */
  value: string | number | boolean | Record<string, string>;
  /** 结论理由 */
  rationale: string;
}
/**
 * 语义记忆：从情景记忆中抽象出的跨任务规律
 *
 * 例如：domain='model-affinity'，statement='长文本代码任务适合模型A'，
 * conditions=[{dimension:'feature',op:'contains',value:'code'},{dimension:'length',op:'gt',value:10000}]，
 * conclusion={type:'model-preference', value:'model-a', rationale:'占比 75% 成功'}。
 */
interface SemanticMemory {
  id: string;
  /** 规律主题：模型亲和 / 特征关联 / 复杂度模式 / 跨任务趋势 */
  domain: 'model-affinity' | 'feature-correlation' | 'complexity-pattern' | 'cross-task-trend';
  /** 人类可读规律陈述 */
  statement: string;
  /** 适用任务类型集合（空表示跨任务通用） */
  taskTypes: string[];
  /** 结构化条件（合取） */
  conditions: SemanticCondition[];
  /** 结构化结论 */
  conclusion: SemanticConclusion;
  /** 置信度 0~1 */
  confidence: number;
  /** 支撑样本数 */
  supportCount: number;
  /** 溯源情景记忆指纹 */
  sourceFingerprints: string[];
  distilledAt: number;
  /** 反馈闭环 */
  appliedTotal: number;
  appliedSuccesses: number;
  lastAppliedAt?: number;
  /** 幂等衰减基准（缺省视为 distilledAt） */
  lastDecayAt?: number;
  /** 3.0：时间加权 Beta 证据（并行旁路，同 DistilledStrategy.evidence） */
  evidence?: MemoryEvidence;
}
/** 程序记忆条件维度（含 outcome/root-cause，用于反思规则） */
type ProceduralConditionDimension = 'task-type' | 'feature' | 'complexity' | 'length' | 'token-cost' | 'outcome' | 'root-cause';
/** 程序记忆条件 */
interface ProceduralCondition {
  dimension: ProceduralConditionDimension;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}
/** 程序记忆动作 */
interface ProceduralAction {
  /**
   * 动作类型：
   * - prefer-model / avoid-model：偏好或规避某模型
   * - enable-cot：启用思维链
   * - parallelism：指定并行策略
   * - param-tune：参数微调（如 timeout）
   * - escalate：升级为 ask-user
   */
  type: 'prefer-model' | 'avoid-model' | 'enable-cot' | 'parallelism' | 'param-tune' | 'escalate';
  /** 动作参数（按 type 解释） */
  params: Record<string, string | number | boolean>;
  /** 理由 */
  rationale: string;
}
/**
 * 程序记忆：带触发条件的可执行 if-then 规则
 *
 * 例如：name='长代码任务启用思维链并偏好模型A'，
 * conditions=[{dimension:'feature',op:'contains',value:'code'},{dimension:'length',op:'gt',value:10000}]，
 * action={type:'enable-cot', params:{model:'model-a'}, rationale:'长代码任务在 model-a + CoT 下成功率提升 40%'}。
 *
 * kind='scheduling' 由优化器消费；kind='reflection' 由反思器消费（如"超时根因→直接换模型"）。
 */
interface ProceduralMemory {
  id: string;
  /** 规则类别：调度策略 / 反思规则 */
  kind: 'scheduling' | 'reflection';
  /** 规则名称 */
  name: string;
  /** 适用任务类型（空表示通用） */
  taskTypes: string[];
  /** 触发条件（合取：全部满足才触发） */
  conditions: ProceduralCondition[];
  /** 触发动作 */
  action: ProceduralAction;
  /** 置信度 0~1 */
  confidence: number;
  /** 支撑样本数 */
  supportCount: number;
  /** 溯源情景记忆指纹 */
  sourceFingerprints: string[];
  distilledAt: number;
  /** 反馈闭环 */
  appliedTotal: number;
  appliedSuccesses: number;
  lastAppliedAt?: number;
  /** 幂等衰减基准（缺省视为 distilledAt） */
  lastDecayAt?: number;
  /** 3.0：时间加权 Beta 证据（并行旁路，同 DistilledStrategy.evidence） */
  evidence?: MemoryEvidence;
}
/** 蒸馏报告（distillKnowledge 产物） */
interface DistillationReport {
  distilledAt: number;
  /** 参与蒸馏的情景记忆样本数 */
  sourceEpisodicCount: number;
  /** 新增/更新的语义记忆 */
  semanticMemories: SemanticMemory[];
  /** 新增/更新的程序记忆 */
  proceduralMemories: ProceduralMemory[];
  /** 兼容字段：本次产出的 DistilledStrategy（来自既有 distillExperience） */
  strategies: DistilledStrategy[];
  /** 人类可读摘要 */
  summary: string;
  /** 水位不足跳过蒸馏时为 true（此时各产物数组为空） */
  skipped?: boolean;
  /** 跳过原因（'below-threshold' 等） */
  skipReason?: string;
  /** 本次通过证据合并增强的语义记忆数（duplicate 不再丢弃证据） */
  mergedSemanticCount?: number;
  /** 本次通过证据合并增强的程序记忆数 */
  mergedProceduralCount?: number;
  /** 本次冲突消解中被新证据取代的旧规律数 */
  supersededCount?: number;
}
/** 记忆库持久化结构 */
interface MemoryStore {
  version: number;
  createdAt: number;
  lastUpdatedAt: number;
  taskPatterns: TaskPatternMemory[];
  modelProfiles: ModelLongTermProfile[];
  decisionFeedback: DecisionFeedback[];
  /** 蒸馏策略库（经验蒸馏产物） */
  distilledStrategies: DistilledStrategy[];
  /** 语义记忆库（第二阶段：跨任务规律） */
  semanticMemories: SemanticMemory[];
  /** 程序记忆库（第二阶段：if-then 可执行规则） */
  proceduralMemories: ProceduralMemory[];
  globalStats: {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalTokensUsed: number;
    totalCostEstimate: number;
    averageQualityScore: number;
    averageExecutionTime: number;
    /** 第二阶段升级：上次知识蒸馏完成时的情景事件计数（阈值触发蒸馏的水位基准；缺省视为当前值） */
    lastDistillationEventCount?: number;
  };
}
/** 成功执行记录参数（IMemoryStore 契约） */
interface RecordSuccessParams {
  taskType: string;
  complexity: number;
  features: string[];
  taskSummary: string;
  plan: SuccessfulPlanRecord['plan'];
  modelAssignments: Record<string, string>;
  totalLatency: number;
  qualityScores: Record<string, number>;
  tokenCost: number;
}
/** 失败执行记录参数（IMemoryStore 契约） */
interface RecordFailureParams {
  taskType: string;
  complexity: number;
  features: string[];
  reason: string;
  failedNodeId: string;
  failedModelId: string;
  errorMessage: string;
}
/** 决策反馈记录参数（IMemoryStore 契约） */
interface RecordDecisionFeedbackParams {
  signalType: string;
  signalDescription: string;
  decision: string;
  outcome: DecisionFeedback['outcome'];
  outcomeReason: string;
  lesson?: string;
}
/** 任务模式指纹（taskType + complexity 分桶 + 特征排序，全组件统一约定） */
declare function buildPatternFingerprint(taskType: string, complexity: number, features: string[]): string;
/** 条件匹配上下文（语义/程序记忆共用；outcome 与 rootCause 仅程序记忆使用） */
interface MemoryMatchContext {
  features?: string[];
  complexity?: number;
  length?: number;
  tokenCost?: number;
  outcome?: string;
  rootCause?: string;
}
/** 单条件结构（SemanticCondition / ProceduralCondition 的公共形状） */
interface MemoryCondition {
  dimension: string;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}
/** 单条件求值（actual 未知时除空值场景外均不命中） */
declare function evaluateMemoryCondition(actual: string | number | string[] | undefined, operator: MemoryCondition['operator'], expected: string | number | string[]): boolean;
/** 合取条件匹配：全部条件满足才返回 true（供优化器检索复用） */
declare function matchesMemoryConditions(conditions: MemoryCondition[], taskType: string, context: MemoryMatchContext): boolean;
/** 证据普查单层统计（3.0：自知之明报告的原料） */
interface EvidenceCensusLayer {
  /** 记忆层：蒸馏策略 / 语义记忆 / 程序记忆 / 模型画像 */
  layer: 'strategy' | 'semantic' | 'procedural' | 'model-profile';
  /** 该层实体总数 */
  total: number;
  /** 已携带时间加权证据的实体数 */
  withEvidence: number;
  /** 全层平均有效样本量（时间衰减后） */
  avgEffectiveSamples: number;
  /** 证据枯竭实体数（有效样本 < 1，长期未验证） */
  evidenceExhausted: number;
}
/** 证据普查（3.0：全层不确定性一览——系统知道自己「哪些记忆可信、哪些在过期」） */
interface EvidenceCensus {
  generatedAt: number;
  layers: EvidenceCensusLayer[];
  /** 能力漂移模型（|drift| > 0.1 且有效样本 ≥ 5）：修复被察觉 / 退化被预警 */
  driftedModels: Array<{
    modelId: string;
    taskType: string;
    drift: number;
    effectiveSamples: number;
    posteriorMean: number;
  }>;
}
/**
 * 跨会话长期记忆引擎
 *
 * 被 migration-tool / tenant-manager / benchmark-engine / distributed-sync 依赖。
 *
 * 3.0 工程升级：热路径全量索引化——record/upsert/find/get 的 O(n) 数组扫描
 * 替换为 Map 索引 O(1) 查找（模式指纹 / 画像 id / 策略 id+描述 / 语义 id+陈述 /
 * 程序 id+名称 / 反馈 id），写入方法同步维护索引，批量变更（prune/遗忘曲线/
 * 载入）后统一重建。
 */
declare class LongTermMemory implements IMemoryStore {
  private persistPath;
  private backend;
  private store;
  private persistTimer;
  private flushOnExit;
  private idxPattern;
  private idxProfile;
  private idxStrategy;
  private idxStrategyDesc;
  private idxSemantic;
  private idxSemanticStatement;
  private idxProcedural;
  private idxProceduralName;
  private idxFeedbackId;
  /** 从 store 全量重建索引（构造载入 / 批量过滤后调用） */
  private reindex;
  /** 当前持久化后端类型（sqlite / json） */
  get backendKind(): 'sqlite' | 'json';
  /**
   * @param persistPath 持久化文件路径（如 .scheduler/memory.json；SQLite 后端自动映射为 .db）
   * @param cryptoEngine 可选加密引擎，提供后持久化自动适配加密配置（走 JSON 后端）
   */
  constructor(persistPath: string, cryptoEngine?: CryptoEngine);
  /**
   * 模糊经验匹配：按 taskType + complexity + features 检索最相似的任务模式
   *
   * 打分公式：0.5 × taskType相似度 + 0.25 × complexity接近度 + 0.25 × features重叠度
   * 仅返回相似度 ≥ 0.4 的模式中的最优者。
   *
   * @param taskType 任务类型（如 code-generation）
   * @param complexity 复杂度 0~1
   * @param features 任务特征标签列表
   * @returns 最匹配的模式，无合格匹配时返回 undefined
   */
  findPattern(taskType: string, complexity: number, features?: string[]): TaskPatternMemory | undefined;
  /**
   * 记录一次成功执行：沉淀任务模式 + 更新模型画像 + 全局统计
   */
  recordSuccess(params: RecordSuccessParams): void;
  /**
   * 记录一次失败执行
   */
  recordFailure(params: RecordFailureParams): void;
  /**
   * 记录一次决策反馈（execute/defer/dismiss/ask-user 的结果复盘）
   */
  recordDecisionFeedback(params: RecordDecisionFeedbackParams): void;
  /** 获取全局统计 */
  getGlobalStats(): MemoryStore['globalStats'];
  /**
   * 获取置信度最高的任务模式
   * @param limit 返回数量上限，默认 10
   */
  getTopPatterns(limit?: number): TaskPatternMemory[];
  /** 获取指定模型画像 */
  getModelProfile(modelId: string): ModelLongTermProfile | undefined;
  /**
   * 贝叶斯能力估计（2.0：模型 × 任务类型的 Beta 后验推断）
   *
   * 时间加权证据 → Beta(1+ws, 1+wf) 后验：
   * - posteriorMean：调度预测置信度来源（校准闭环素材）
   * - wilsonLower：小样本保守的利用端评分依据
   * - drift：近期成功率 - 裸成功率，感知模型能力漂移（升级/降级）
   *
   * 读取零额外开销（衰减在写入时惰性完成）；旧持久化字段缺失时
   * 回退裸计数（半衰期从查询时刻起步，下次写入完成初始化）。
   */
  getBayesianEstimate(modelId: string, taskType: string): BayesianEstimate | undefined;
  /** 获取全部模型画像 */
  getAllModelProfiles(): ModelLongTermProfile[];
  /** 获取全部任务模式（迁移导出用） */
  getAllTaskPatterns(): TaskPatternMemory[];
  /** 获取全部决策反馈（迁移导出用） */
  getAllDecisionFeedback(): DecisionFeedback[];
  /**
   * 插入或更新任务模式（迁移导入用）
   * @returns 'created' 新增 / 'updated' 覆盖
   */
  upsertPattern(pattern: TaskPatternMemory): 'created' | 'updated';
  /**
   * 按指纹删除任务模式（分布式同步 pattern-deleted 变更用）
   * @returns 是否实际删除
   */
  removePattern(fingerprint: string): boolean;
  /**
   * 插入或更新模型画像（迁移导入用）
   * @returns 'created' 新增 / 'updated' 覆盖
   */
  upsertModelProfile(profile: ModelLongTermProfile): 'created' | 'updated';
  /**
   * 追加一条决策反馈（迁移导入用，按 id 去重）
   * @returns 是否实际写入（重复 id 返回 false）
   */
  appendFeedback(feedback: DecisionFeedback): boolean;
  /**
   * 累加式合并全局统计（迁移导入用）
   * 计数类字段相加，均值类字段按执行次数加权平均
   */
  mergeGlobalStats(incoming: MemoryStore['globalStats']): void;
  /**
   * 获取最近的决策反馈
   * @param limit 返回数量上限，默认 20
   */
  getRecentFeedback(limit?: number): DecisionFeedback[];
  /**
   * 统计某类信号的决策成功率
   * @param signalType 信号类型
   */
  getDecisionSuccessRate(signalType: string): {
    total: number;
    successRate: number;
    avgOutcome: string;
  };
  /**
   * 生成记忆库人类可读摘要（供 query_memory Tool 使用）
   */
  getMemorySummary(): string;
  /**
   * 清理过期记忆
   * @param maxAgeDays 最大保留天数，默认 90
   * @returns 被清理的条目数
   */
  prune(maxAgeDays?: number): number;
  /**
   * 经验蒸馏：从高置信度任务模式中提炼可复用策略
   *
   * 蒸馏规则：
   * 1. 模型偏好策略：某模型在该任务类型的成功方案中出现占比 ≥ 60% → 偏好策略
   * 2. 并行策略：成功方案的 parallelismStrategy 众数 → 并行偏好
   * 3. 仅蒸馏 confidence ≥ 0.6 且成功次数 ≥ 3 的模式，保证策略可靠性
   *
   * @param minConfidence 参与蒸馏的最低模式置信度，默认 0.6
   * @returns 本次新蒸馏的策略列表
   */
  distillExperience(minConfidence?: number): DistilledStrategy[];
  /**
   * 获取指定任务类型的蒸馏策略（3.0：按证据化排序分降序——confidence × Wilson 下界等权混合）
   * @param taskType 任务类型
   * @param limit 返回上限
   */
  getStrategies(taskType: string, limit?: number): DistilledStrategy[];
  /** 全部蒸馏策略 */
  getAllStrategies(): DistilledStrategy[];
  /**
   * 策略应用反馈：更新策略的应用成功率（闭环校准策略置信度）
   *
   * 3.0：同步观测统一证据（时间加权 Beta）——旧实体首次观测时从
   * 裸计数折价初始化，与模型画像 legacy 回退语义一致。
   *
   * @param strategyId 策略 id
   * @param success 本次应用是否成功
   */
  recordStrategyOutcome(strategyId: string, success: boolean): void;
  /**
   * 查找匹配的语义记忆
   *
   * 匹配规则：taskTypes 包含目标 taskType（或为空表示通用）+ conditions 全部满足。
   * 多条命中时按置信度降序返回最优。
   *
   * @param taskType 任务类型
   * @param context 条件上下文（任务特征 / 复杂度 / 长度等）
   * @returns 最匹配的语义记忆，无命中时 undefined
   */
  findSemanticMemory(taskType: string, context?: {
    features?: string[];
    complexity?: number;
    length?: number;
    tokenCost?: number;
  }): SemanticMemory | undefined;
  /** 获取指定任务类型的语义记忆（3.0：按证据化排序分降序） */
  getSemanticMemories(taskType: string, limit?: number): SemanticMemory[];
  /** 全部语义记忆 */
  getAllSemanticMemories(): SemanticMemory[];
  /**
   * 插入或更新语义记忆（第二阶段升级：证据合并增强 + 冲突消解）
   *
   * 写入语义（按优先级判定）：
   * 1. 冲突消解：同结构签名（domain + 结论类型 + 条件）但结论值不同 →
   *    新证据支撑 ≥ 旧证据 1.5 倍且 ≥ 3 时取代旧规律（'superseded'），否则丢弃（'duplicate'）
   * 2. 证据合并：同 id 或同 statement 的既有规律 → 不再丢弃新证据，而是
   *    支撑数累加、置信度按证据加权、溯源指纹取并集、衰减基准重置（'merged'）
   * 3. 同 id 直接覆盖（'updated'） / 新增（'created'）
   *
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertSemanticMemory(memory: SemanticMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  /** 按指纹溯源删除语义记忆（分布式同步用；3.0 索引同步删除） */
  removeSemanticMemory(id: string): boolean;
  /** 语义记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
  recordSemanticOutcome(id: string, success: boolean): void;
  /**
   * 查找匹配的程序记忆
   *
   * 匹配规则：kind 匹配 + taskTypes 适配 + conditions 合取全部满足。
   * 多条命中时按置信度降序返回最优。
   *
   * @param kind 规则类别（scheduling / reflection）
   * @param taskType 任务类型
   * @param context 条件上下文
   */
  findProceduralMemory(kind: ProceduralMemory['kind'], taskType: string, context?: {
    features?: string[];
    complexity?: number;
    length?: number;
    tokenCost?: number;
    outcome?: string;
    rootCause?: string;
  }): ProceduralMemory | undefined;
  /** 获取指定任务类型的程序记忆（3.0：按证据化排序分降序） */
  getProceduralMemories(taskType: string, kind?: ProceduralMemory['kind'], limit?: number): ProceduralMemory[];
  /** 全部程序记忆 */
  getAllProceduralMemories(): ProceduralMemory[];
  /**
   * 插入或更新程序记忆（第二阶段升级：证据合并增强 + 冲突消解，语义同 upsertSemanticMemory）
   *
   * 冲突判定：同结构签名（kind + 动作类型 + 目标模型维度 + 条件）但目标模型不同
   * （如"长代码任务偏好模型A" vs "偏好模型B"）→ 新证据显著更强时取代，否则丢弃。
   *
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertProceduralMemory(memory: ProceduralMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  /** 删除程序记忆（3.0 索引同步删除） */
  removeProceduralMemory(id: string): boolean;
  /** 程序记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
  recordProceduralOutcome(id: string, success: boolean): void;
  /**
   * 情景事件水位：距上次知识蒸馏新增了多少情景事件（成功+失败均计）
   *
   * 反思器据此实现"达到阈值时自动蒸馏"，替代纯周期触发，
   * 高负载时更快沉淀知识、低负载时不做无效全量蒸馏。
   * 水位持久化于 globalStats.lastDistillationEventCount（重启不丢）。
   */
  getDistillationProgress(): {
    /** 情景事件累计总数（= totalExecutions） */
    episodicEventCount: number;
    /** 上次蒸馏完成时的水位 */
    lastDistillationEventCount: number;
    /** 距上次蒸馏新增的情景事件数 */
    pendingSinceLastDistillation: number;
  };
  /** 蒸馏完成检查点：刷新水位（供 distillKnowledge 成功后调用） */
  noteDistillationCheckpoint(): void;
  /**
   * 证据普查（3.0：自知之明报告——全层不确定性一览）
   *
   * 系统级自检 API：
   * - 各记忆层的证据覆盖度（withEvidence / total）、平均有效样本量、证据枯竭数
   * - 模型画像层基于既有时间加权证据换算（legacy 裸计数折价，口径与 getBayesianEstimate 一致）
   * - 能力漂移检测：|drift| > 0.1 且有效样本 ≥ 5 的模型 × 任务组合
   *   （模型修复被察觉 / 模型退化被预警）
   */
  evidenceCensus(): EvidenceCensus;
  /**
   * 通用条件匹配（语义记忆用，第二阶段升级：委托导出的纯函数 matchesMemoryConditions，
   * 与优化器检索共用同一套求值语义，避免两处实现漂移）
   */
  private matchConditions;
  /** 程序记忆条件匹配（含 outcome/root-cause 维度） */
  private matchProceduralConditions;
  /**
   * 遗忘曲线（对冲机制一）：按艾宾浩斯衰减模型对长期未使用的记忆降低置信度
   *
   * 覆盖四类记忆：任务模式（基准 lastSeenAt）、蒸馏策略（基准 lastAppliedAt）、
   * 语义记忆与程序记忆（基准 lastAppliedAt，第二阶段新增）。
   *
   * 幂等性（关键修正）：衰减以 lastDecayAt 为基准计算"自上次衰减以来的闲置天数"，
   * 而非自 lastSeenAt 起的累计天数——否则高频维护调用会把同一段闲置时间
   * 重复计入，导致复合叠加过度衰减。多次调用只推进衰减窗口，不重复惩罚。
   *
   * 衰减公式：confidence ×= 0.5 ^ (daysIdle / effectiveHalfLife)
   * - 高频模式（frequency 高）半衰期更长，不易遗忘
   * - 置信度低于 forgetThreshold 的记忆直接清除（彻底遗忘）
   *
   * @param halfLifeDays 基准半衰期（天），默认 30
   * @param forgetThreshold 低于该置信度彻底遗忘，默认 0.2
   * @returns { decayed: 衰减的记忆数, forgotten: 彻底遗忘的记忆数 }
   */
  applyForgettingCurve(halfLifeDays?: number, forgetThreshold?: number): {
    decayed: number;
    forgotten: number;
  };
  /**
   * 通用衰减器（供语义/程序记忆复用，结构同 DistilledStrategy 衰减逻辑）
   *
   * @param items 待衰减的记忆数组
   * @param halfLifeDays 基准半衰期
   * @param forgetThreshold 遗忘阈值
   * @param now 当前时间戳
   * @param DAY 一天的毫秒数
   * @param onForget 遗忘计数回调
   * @param onDecay 衰减计数回调
   * @returns 衰减后的存活数组
   */
  private decayMemory;
  /** FTS5 全文检索（混合检索增强，委托 SQLite 后端；JSON 后端返回空） */
  fullTextSearch(query: string, limit?: number): MemorySearchHit[];
  /** 向量检索（稀疏向量回退，委托 SQLite 后端；JSON 后端返回空） */
  vectorSearch(query: string, limit?: number): MemorySearchHit[];
  /** 完整性检查（JSON 后端恒 ok） */
  integrityCheck(): string;
  /** 数据库统计（JSON 后端返回内存计数） */
  dbStats(): {
    patterns: number;
    profiles: number;
    feedback: number;
    strategies: number;
    semantic: number;
    procedural: number;
    pageSize: number;
    pageCount: number;
    walSize: number;
    schemaVersion: number;
    fts: boolean;
    vec: boolean;
  };
  /** WAL checkpoint（仅 SQLite 后端有效） */
  checkpoint(): void;
  /** VACUUM 回收碎片空间（仅 SQLite 后端有效） */
  vacuum(): void;
  /** 热备份（仅 SQLite 后端；返回备份路径） */
  backup(destPath: string): string | undefined;
  /** 只读 SQL 查询通道（仅 SQLite 后端；JSON 后端返回空） */
  rawQuery(sql: string, params?: Array<string | number | null>): Array<Record<string, unknown>>;
  /** 立即同步落盘（进程退出前调用） */
  flushSync(): void;
  /** 释放资源（落盘 + 移除 beforeExit 监听 + 关闭后端连接） */
  dispose(): void;
  /** 判断同描述策略是否已存在（蒸馏去重；3.0 索引化 O(1)） */
  private hasStrategy;
  /** 从持久化后端加载记忆库（损坏时由后端备份并抛出） */
  private load;
  /** 防抖持久化调度 */
  private schedulePersist;
  /** 执行持久化（委托后端：SQLite 事务 / JSON 原子写 / 加密落盘） */
  private persist;
  /** 更新模型画像 */
  private updateModelProfile;
  /** 构建任务指纹：taskType + 复杂度分桶 + 排序后的特征 */
  private buildFingerprint;
  /**
   * 相似度打分（0~1）
   * 0.5 × taskType 匹配 + 0.25 × complexity 接近度 + 0.25 × features Jaccard
   */
  private similarity;
  /** 质量分字典的平均值 */
  private avgQuality;
  /** 数值数组平均值 */
  private avg;
  /** 滚动平均（避免保存全量历史） */
  private rollingAvg;
}
//#endregion
//#region src/memory/memory-graph.d.ts
/**
 * memory-graph.ts — 记忆网络与主题树（自主学习建议 2：自定义数据结构序列化）
 *
 * SQLite 擅长行列存储，但图结构（记忆网络、主题树）是其短板。本组件将复杂关系
 * 保留在内存中管理与检索，定期序列化到本地 JSON 文件，Agent 启动时加载恢复：
 *
 * - 记忆网络：节点（任务模式 / 蒸馏策略 / 主题）+ 共现边（权重随共现次数增长），
 *   支撑"由一条记忆联想到相关记忆"的图检索（优化器混合检索的联想增强）
 * - 主题树：按 taskType 归类的层级结构（根主题 → 子主题 → 模式叶节点）
 *
 * 持久化：JSON 原子写（与记忆库同目录 memory-graph.json），dispose/flush 时落盘。
 */
interface MemoryNode {
  id: string;
  /**
   * 节点类型：
   * - pattern：任务模式（情景记忆叶节点）
   * - strategy：蒸馏策略（第一阶段既有）
   * - topic：主题树节点
   * - semantic：语义记忆节点（第二阶段，由知识蒸馏产出）
   * - procedural：程序记忆节点（第二阶段，由知识蒸馏产出）
   */
  kind: 'pattern' | 'strategy' | 'topic' | 'semantic' | 'procedural';
  label: string;
  createdAt: number;
}
interface MemoryEdge {
  source: string;
  target: string;
  /** 共现次数 */
  cooccurrences: number;
  /** 归一化权重 0~1（cooccurrences / 5 封顶） */
  weight: number;
  lastAt: number;
}
interface TopicNode {
  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  patternIds: string[];
}
declare class MemoryGraph {
  private nodes;
  private edges;
  private topics;
  private persistPath;
  constructor(persistPath: string);
  private edgeKey;
  /** 确保节点存在（幂等） */
  ensureNode(id: string, kind: MemoryNode['kind'], label: string): void;
  /** 记录共现：边权重随共现次数增长（上限 1） */
  link(a: string, b: string): MemoryEdge;
  /** 图联想：按边权重返回相邻节点 id（混合检索的联想增强） */
  related(id: string, limit?: number): string[];
  /** 将模式挂到主题树（根主题 = taskType） */
  attachTopic(patternId: string, topicName: string, parentTopic?: string): TopicNode;
  /** 主题树（仅根节点，含子主题与叶模式） */
  topicTree(): TopicNode[];
  getNode(id: string): MemoryNode | undefined;
  stats(): {
    nodes: number;
    edges: number;
    topics: number;
  };
  /** 序列化到本地 JSON（原子写） */
  save(): void;
  /** 启动时从本地 JSON 加载（损坏/缺失时从空图开始） */
  private load;
}
//#endregion
//#region src/progress-ws.d.ts
/** 进度事件（type 为附录协议中的 13 种事件名，可自由扩展） */
interface ProgressEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}
/**
 * WebSocket 进度广播器
 *
 * 独立监听一个 HTTP 端口并升级为 WebSocket 服务。
 * 被 index.ts 集成层持有，执行链路各阶段调用 broadcast() 推送事件。
 */
declare class ProgressBroadcaster {
  private port;
  private server;
  private connections;
  /** 环形回放缓冲 */
  private replayBuffer;
  private heartbeatTimer;
  private started;
  /** 可选 HTTP 请求处理器（dashboard 等静态页面复用本端口；返回 true 表示已响应） */
  private httpHandler;
  /**
   * @param port 监听端口，默认 9877（与 cordis.patch.yml progressPort 一致）
   */
  constructor(port?: number);
  /**
   * 注册 HTTP 请求处理器（非 WebSocket 升级请求优先交给它）
   * @param handler 返回 true 表示已处理该请求；返回 false 走默认健康检查响应
   */
  setHttpHandler(handler: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null): void;
  /**
   * 启动 WebSocket 服务
   * 监听失败（端口冲突等）通过 'error' 事件降级停机并记录，
   * 不抛出——EventEmitter 回调内 throw 会成为进程级未捕获异常
   */
  start(): void;
  /**
   * 广播事件给所有在线客户端，并写入回放缓冲
   * @param event 进度事件（timestamp 缺省时自动补当前时间）
   */
  broadcast(event: ProgressEvent): void;
  /**
   * 停止服务：关闭所有连接与监听
   */
  stop(): void;
  /** 当前在线连接数 */
  getClientCount(): number;
  /** RFC 6455 握手 */
  private handleUpgrade;
  /**
   * 解析入站帧（客户端帧必带掩码）
   * 仅处理控制帧：close(0x8) / ping(0x9) / pong(0xA)；业务上行暂不需要
   */
  private handleData;
  /** 发送未掩码服务端帧 */
  private sendFrame;
  /** 清理连接 */
  private dropConnection;
}
//#endregion
//#region src/optimizer.d.ts
/**
 * 记忆层级（第二阶段）
 *
 * 优化器推荐优先级：procedural > semantic > episodic > none
 * - procedural：程序记忆命中（最具体的 if-then 规则）
 * - semantic：语义记忆命中（跨任务抽象规律）
 * - episodic：情景记忆命中（既有任务模式匹配）
 * - none：无任何记忆命中（首次任务）
 */
type MemoryLayer = 'procedural' | 'semantic' | 'episodic' | 'none';
/** 经验检索结果（优化器产物，供模型调度消费） */
interface ExperienceLookup {
  pattern?: TaskPatternMemory;
  /** 按节点类型的推荐模型组合（模型调度优先采用） */
  recommendedModels: Record<string, string>;
  historicalSuccessRate: number;
  avgExecutionTime: number;
  /** 命中的最高记忆层级（procedural > semantic > episodic > none） */
  memoryLayer: MemoryLayer;
  /** 决策依据说明（人类可读，供广播与可观测性） */
  rationale: string;
  /** 命中的程序记忆 id（memoryLayer='procedural' 时非空） */
  matchedProceduralId?: string;
  /** 命中的语义记忆 id（memoryLayer='semantic' 时非空） */
  matchedSemanticId?: string;
  /** 程序记忆触发的动作列表（供执行器/调度器消费：启用思维链、避免某模型等） */
  suggestedActions?: ProceduralAction[];
  /** 程序记忆聚合的规避模型列表（avoid-model 动作目标；调度时从候选中剔除） */
  avoidModels: string[];
  /** 本次条件匹配命中的全部程序记忆 id（应用反馈闭环回写用） */
  matchedProceduralIds?: string[];
  /** 本次推荐使用的调度策略版本（policyId@vN；策略热切换后随次检索更新） */
  policyVersion: string;
}
/** 优化器配置 */
interface OptimizerConfig {
  /**
   * 经验快路径：命中模式置信度 ≥ 该阈值时，直接复用历史最优成功计划，
   * 跳过 strategist LLM 重新规划（越用越快、越稳、越省 token）。
   * 设为 >1 可关闭快路径。缺省 0.9。
   */
  memoryFastPathThreshold?: number;
}
/**
 * 优化器
 *
 * 被编排层（index.ts）持有：执行前调用 lookupExperience / recallPlan
 * 产出推荐模型与复用计划，喂给执行器（模型调度 + 任务执行）。
 *
 * 第三阶段升级（策略进化）：
 * - 策略版本标注：构造时注入 policyProvider（由编排层桥接到策略进化器或模型
 *   调度器），每次经验检索返回 policyVersion，推荐可追溯到具体策略版本
 * - 任务分解决策：shouldDecompose 按当前策略的分解规则判断是否拆分任务
 *   （沙盒中进化出的分解参数在操作环落地）
 * - 未注入 policyProvider 时标注 baseline 策略，行为与第二阶段一致（兼容）
 */
declare class Optimizer implements IOptimizer {
  private memory;
  private config;
  private broadcaster?;
  private graph?;
  /** 当前调度策略提供器（第三阶段：策略版本标注与分解决策依据） */
  private policyProvider?;
  /** 7.0：深思内核（冷启动序列推荐 = 规划即推断） */
  private deliberation?;
  /** 8.0：元推理内核（推荐的双过程仲裁 = 理性元推理） */
  private metareasoner?;
  constructor(params: {
    memory: IMemoryStore;
    config?: OptimizerConfig;
    broadcaster?: ProgressBroadcaster;
    graph?: MemoryGraph;
    policyProvider?: () => Policy;
  });
  /** 7.0：挂载深思内核（幂等；挂载后获得冷启动深思推荐能力） */
  attachDeliberation(engine: DeliberationEngine): void;
  /** 8.0：挂载元推理内核（幂等；挂载后推荐经双过程仲裁定价） */
  attachMetareasoner(reasoner: RationalMetareasoner): void;
  /** 运行时配置热更新（元认知自调优落地入口） */
  updateConfig(patch: Partial<OptimizerConfig>): void;
  /** 当前配置快照（第四阶段：元认知旋钮 read 端；只读） */
  getConfig(): Readonly<OptimizerConfig>;
  /** 当前策略版本标识（policyId@vN；未注入提供器时为 baseline） */
  private currentPolicyVersion;
  /**
   * 经验检索 — 三层记忆优先级匹配并给出推荐模型组合
   *
   * 第二阶段三层记忆级联（procedural > semantic > episodic > none）：
   * 1. 程序记忆（findProceduralMemory）：按 kind='scheduling' + 条件合取匹配。
   *    命中时从 action 提取 prefer-model 写入 recommendedModels，并返回 suggestedActions
   *    供执行器消费（如 enable-cot / avoid-model / parallelism）。
   * 2. 语义记忆（findSemanticMemory）：跨任务规律匹配。命中时从 conclusion 提取
   *    model-preference 写入 recommendedModels。
   * 3. 情景记忆（findPattern）：既有模糊匹配，回退路径。
   * 4. 全无命中：memoryLayer='none'，返回空推荐（首次任务）。
   *
   * 三层均会查询（不只取首层），但 memoryLayer 标记命中的最高层级，
   * rationale 说明决策依据。程序/语义记忆未命中时仍会回退到情景记忆，
   * 保证既有"模型推荐组合"链路不被破坏。
   *
   * @param taskType 任务类型
   * @param complexity 复杂度 0~1
   * @param features 任务特征标签
   * @param context 程序/语义记忆条件匹配所需的额外上下文（长度 / token 成本）
   */
  lookupExperience(taskType: string, complexity: number, features?: string[], context?: {
    length?: number;
    tokenCost?: number;
  }): ExperienceLookup;
  /**
   * 任务分解决策（第三阶段：策略进化中「任务分解规则」的操作环落地）
   *
   * 按当前策略判定：分解启用且复杂度 ≥ 阈值时建议将任务拆分为子任务。
   * 编排层在兜底单节点计划时消费该建议（decomposePlan）。
   * 质级升级：传入 taskType/features 时按规则基因组解析上下文有效参数
   * （规则可对特定任务类型/复杂度段强制开/关分解）。
   * @param complexity 任务复杂度 0~1
   * @param taskType 任务类型（供规则基因匹配）
   * @param features 特征标签（供规则基因匹配）
   */
  shouldDecompose(complexity: number, taskType?: string, features?: string[]): boolean;
  /**
   * 构建决策依据说明（人类可读，供广播与可观测性）
   *
   * 第二阶段升级：程序记忆层说明全部命中规则数与正负向动作概览，
   * 让"使用了哪一层记忆、为什么"完全可追溯。
   */
  private buildRationale;
  /**
   * 经验快路径：命中高置信度模式时，直接复用历史最优成功计划，
   * 跳过 strategist LLM 重新规划——越用越快、越稳、越省 token。
   *
   * 复用条件（全部满足才返回计划，否则返回 undefined 走常规规划）：
   * 1. 模式置信度 ≥ memoryFastPathThreshold（缺省 0.9）
   * 2. 存在至少一条成功计划记录
   *
   * 选取策略：取平均质量最高的成功记录；其节点模型分配经 recommendedModels
   * （按节点类型）在执行时优先采用，保持"记忆驱动选型"的一致性。
   *
   * @param lookup 经验检索结果
   * @param objective 当前任务目标（写入计划）
   * @returns 复用的计划（source='memory'），不满足条件时 undefined
   */
  recallPlan(lookup: ExperienceLookup, objective: string): ExecutionPlan | undefined;
  /**
   * 7.0：深思推荐 —— 规划即推断的冷启动序列建议。
   *
   * 与经验检索的本质区别：lookupExperience 回答「历史上类似任务
   * 用过什么」（没有历史就没有答案）；本方法回答「按我脑内的世界
   * 演练，怎样的一串选择全程自由能最低」——**零情景记忆也能给出
   * 计划级建议**（转移模型无证据时诚实返回无知区间，搜索以认知
   * 价值驱动试探序）。
   *
   * 消费方：编排层在 memoryLayer='none'（冷启动）时以序列建议辅助
   * 逐节点选型；有记忆命中时经验优先（深思只补充，不越权）。
   *
   * @param taskType 任务类型（构造状态键 `${taskType}#s${i}`）
   * @param candidateActions 每阶段的候选行动（如模型 id 列表）
   * @param stages 计划阶段数（搜索深度）
   */
  deliberativeRecommendation(taskType: string, candidateActions: string[], stages: number, opts?: {
    breadth?: number;
    preference?: number;
  }): DeliberationResult | undefined;
  /**
   * 8.0：元认知推荐 —— 理性元推理的冷启动序列建议。
   *
   * 与 7.0 深思推荐的区别：deliberativeRecommendation **每次都全深度
   * 搜索**（想不想要深思是配置，不是决策）；本方法把「想多深」本身
   * 变成决策——双过程仲裁：
   *   habit       深思已摊销为习惯（查表直答，成本 ≈ 0）
   *   reactive    证据充分且优劣悬殊（VOC ≈ 0，直接反应一步）
   *   deliberative 任意时搜索（首行动稳定即停，思考按 nat 计价）
   *
   * 结算闭环：上游执行后调 metareasoner.settleDecision(decisionId, 成败)
   * → 反应失手收紧门槛、深思成功晋升习惯（元学习）。
   */
  metacognitiveRecommendation(taskType: string, candidateActions: string[], stages: number, opts?: {
    preference?: number;
  }): ArbitrationResult | undefined;
  /**
   * 混合检索（自主学习建议 1：sqlite-vec + FTS5 + jieba 分词管道）
   *
   * 四路召回合并去重（按 refId 取最高分）：
   * 1. 模糊匹配（findPattern：taskType/complexity/features 相似度）
   * 2. FTS5 全文（trigram 子串级 + jieba 式 token 级，中文友好）
   * 3. 向量（sqlite-vec 可用时宿主扩展；缺省稀疏词频向量余弦）
   * 4. 图联想（记忆网络相邻节点，权重折半计入）
   */
  hybridSearch(query: string, taskType: string, complexity: number, limit?: number): MemorySearchHit[];
  /** 进度事件广播（broadcaster 缺省时为空操作） */
  private broadcast;
}
//#endregion
//#region src/meta/meta-types.d.ts
/**
 * meta-types.ts — 第四阶段「元认知层」共享数据结构
 *
 * 双环自治进化的外环数据契约：
 * - 内环（第一~三阶段）：任务执行 → 反思 → 记忆 → 优化 → 策略进化
 * - 外环（第四阶段）：观察内环运行 → 自我建模（心智报告）→ 元认知控制
 *   （调整内环参数）→ 观察调整效果 → 保留 / 回滚
 *
 * 设计要点：
 * - 全部结构可直接 JSON 序列化（报告/审计日志即持久化格式）
 * - MentalReport 严格实现第四阶段验收接口定义，并补充可追溯字段
 * - JudgeMetric 把「参数调整」与「效果判定指标」显式关联，
 *   使保守调整闭环（应用 → 观察 → 判定 → 保留/回滚）可机器执行
 */
/** 操作环指标（源自决策反馈与全局统计） */
interface OperationalMetrics {
  /** 综合成功率 0~1（excellent/good/acceptable 计成功） */
  successRate: number;
  /** 平均质量分（按 outcome 映射 0.95/0.8/0.65/0.4/0.1） */
  avgQuality: number;
  /** 样本数（参与统计的决策反馈条数） */
  sampleCount: number;
  /** 按任务类型（信号类型）分组的成败统计 */
  perTaskType: Array<{
    taskType: string;
    total: number;
    successes: number;
    successRate: number;
    avgQuality: number;
  }>;
}
/** 记忆体系指标 */
interface MemoryMetrics {
  counts: {
    /** 情景记忆（任务模式）条数 */
    episodic: number;
    /** 语义记忆条数 */
    semantic: number;
    /** 程序记忆条数 */
    procedural: number;
    /** 蒸馏策略条数 */
    strategies: number;
    /** 模型画像条数 */
    modelProfiles: number;
    /** 决策反馈条数 */
    feedback: number;
  };
  /** 距上次知识蒸馏新增的情景事件数（蒸馏水位） */
  pendingSinceLastDistillation: number;
  totalExecutions: number;
  totalSuccesses: number;
  totalFailures: number;
  totalTokensUsed: number;
  averageQualityScore: number;
  averageExecutionTime: number;
}
/** 进化环指标（源自策略进化器状态） */
interface EvolverMetrics {
  currentPolicyId: string;
  currentPolicyVersion: number;
  currentPolicyGeneration: number;
  currentPolicyOrigin: string;
  totalCycles: number;
  totalCandidatesEvaluated: number;
  /** 部署次数（不含初始基准） */
  deployedCount: number;
  /** 被金丝雀回滚的部署数 */
  rolledBackCount: number;
  /** 新策略存活率 = 未回滚部署 / 部署总数 */
  survivalRate: number;
  /** 发现速率 = 部署次数 / 进化轮数 */
  discoveryRate: number;
  /** 平均发现间隔（毫秒，相邻部署时间差的均值） */
  avgDiscoveryIntervalMs: number;
  /** 已部署策略的平均沙盒收益 */
  avgDeployedGain: number;
  /** 自适应变异步长系数 */
  sigmaScale: number;
  /** 种群精英数 */
  populationSize: number;
  /** 金丝雀状态（无观察窗为 'none'） */
  canaryStatus: 'none' | 'active' | 'promoted' | 'rolled-back';
  /** 部署链（按部署时间升序） */
  deployedHistory: Array<{
    id: string;
    version: number;
    generation: number;
    deployedAt: number;
    rolledBackAt?: number;
  }>;
}
/** 系统指标快照（getSystemMetrics 产物；心智报告的原始素材） */
interface SystemMetrics {
  collectedAt: number;
  operational: OperationalMetrics;
  memory: MemoryMetrics;
  evolver: EvolverMetrics;
}
/** 策略表现摘要（当前策略的优势与盲点） */
interface StrategyPerformanceSummary {
  currentPolicyId: string;
  currentPolicyVersion: number;
  currentPolicyGeneration: number;
  currentPolicyOrigin: string;
  /** 操作环整体表现（最近决策反馈窗口） */
  operational: {
    successRate: number;
    avgQuality: number;
    sampleCount: number;
  };
  /**
   * 按策略版本归因的表现（部署时间窗内的决策反馈统计）：
   * 回答「策略 v3 升级到 v4 后成功率变化多少」的证据基础
   */
  perVersion: Array<{
    policyId: string;
    version: number;
    successRate: number;
    avgQuality: number;
    samples: number;
  }>;
  /** 优势：成功率最高的任务类型（样本 ≥ 最小样本数） */
  strengths: Array<{
    taskType: string;
    successRate: number;
    samples: number;
  }>;
  /** 盲点：成功率最低的任务类型 */
  blindSpots: Array<{
    taskType: string;
    successRate: number;
    samples: number;
  }>;
  /** 最近一次进化周期的沙盒收益（无评估历史为空） */
  sandboxFitness?: {
    reward: number;
    gain: number;
    gainLCB?: number;
  };
}
/** 记忆体系质量摘要（哪类记忆在增加、哪类在退化） */
interface MemoryQualitySummary {
  counts: MemoryMetrics['counts'];
  /** 与上一份心智报告对比的增量（首份报告为全 0） */
  growth: {
    episodic: number;
    semantic: number;
    procedural: number;
    strategies: number;
  };
  /** 蒸馏水位（越高 = 情景积压越多，蒸馏越滞后） */
  distillation: {
    pendingSinceLastDistillation: number;
  };
  /** 各层趋势评估：growing 增长 / stable 平稳 / degrading 退化（遗忘主导） */
  layers: Array<{
    layer: string;
    trend: 'growing' | 'stable' | 'degrading';
    detail: string;
  }>;
  totalExecutions: number;
  averageQualityScore: number;
}
/** 进化器效率摘要（发现速度与存活率） */
interface EvolverEfficiencySummary {
  totalCycles: number;
  totalCandidatesEvaluated: number;
  deployedCount: number;
  /** 新策略存活率（部署后未被金丝雀回滚的比例） */
  survivalRate: number;
  rolledBackCount: number;
  /** 发现速率：每轮进化平均部署数 */
  discoveryRate: number;
  /** 平均发现间隔（毫秒；相邻部署的wall-clock差均值） */
  avgDiscoveryIntervalMs: number;
  /** 已部署策略的平均沙盒收益 */
  avgDeployedGain: number;
  sigmaScale: number;
  populationSize: number;
  canaryStatus: EvolverMetrics['canaryStatus'];
}
/** 系统稳定性与风险点 */
interface SystemStabilitySummary {
  /** 0~1 综合稳定分（成功率 + 存活率 + 记忆健康加权） */
  stabilityScore: number;
  riskPoints: Array<{
    severity: 'low' | 'medium' | 'high';
    area: 'strategy' | 'memory' | 'evolver' | 'operations' | 'meta';
    description: string;
  }>;
  /** 近期金丝雀回滚次数（部署链 rolledBackAt 计数） */
  recentRollbacks: number;
  canaryActive: boolean;
  /** token 消耗趋势（与上份报告对比） */
  tokenUsageTrend: 'rising' | 'stable' | 'falling' | 'unknown';
}
/** 自我改进证据（可机器验证的前后对比） */
interface ImprovementEvidence {
  kind: 'policy-upgrade' | 'memory-growth' | 'evolver-efficiency' | 'quality-gain';
  /** 人类可读描述（如「策略 v3→v4 后平均任务成功率提升 7pp」） */
  description: string;
  /** 调整/升级前取值 */
  before?: number;
  /** 调整/升级后取值 */
  after?: number;
  /** 计量单位（pp / 条 / 毫秒 / 比率） */
  unit?: string;
  measuredAt: number;
}
/** 推荐调整（元认知控制器的输入；与调节旋钮 id 一一对应） */
interface RecommendedAdjustment {
  /** 调节旋钮 id（如 'evolver.mutationRate'） */
  knob: string;
  label: string;
  direction: 'up' | 'down';
  reason: string;
  /** 0~1，越高越优先 */
  priority: number;
}
/** 心智报告（第四阶段验收核心结构） */
interface MentalReport {
  /** ISO 8601 时间戳（人类审查友好） */
  timestamp: string;
  /** 报告序号（趋势分析用；随报告累积单调递增） */
  reportIndex: number;
  /** 数值时间戳（毫秒） */
  generatedAt: number;
  strategyPerformance: StrategyPerformanceSummary;
  memoryQuality: MemoryQualitySummary;
  evolverEfficiency: EvolverEfficiencySummary;
  systemStability: SystemStabilitySummary;
  improvementEvidence: ImprovementEvidence[];
  recommendedAdjustments: RecommendedAdjustment[];
  /** 关键指标趋势外推（≥ minForecastHistory 份历史报告后产出） */
  forecasts?: MetricForecast[];
  /** 前瞻性风险：预测越限 → 建议在指标仍健康时提前调整 */
  proactiveRisks?: ProactiveRisk[];
  /** 旋钮调整有效性（Bandit 学习器快照；需编排层注入元认知状态采集器） */
  knobEffectiveness?: KnobEffectiveness[];
  /** 元认知层自察：熔断器 / 安全包络 / 学习器 / 稳态带（系统对自身调整机制的认知） */
  metaStability?: MetaStabilitySummary;
}
/** 调整效果判定指标（旋钮与指标的显式关联） */
type JudgeMetric = 'operationalSuccessRate' | 'discoveryRate' | 'proceduralGrowth' | 'pendingDistillation' | 'survivalRate';
/** 审计日志条目（所有自动/手动调整全量留痕） */
interface AuditEntry {
  id: string;
  timestamp: number;
  type: 'adjust' | 'commit' | 'rollback' | 'manual-override' | 'freeze' | 'skip' | 'circuit-breaker';
  /** 调节旋钮 id */
  knob?: string;
  from?: number;
  to?: number;
  reason: string;
  /** 效果判定记录（commit / rollback 时填写） */
  effect?: {
    metric: JudgeMetric;
    before: number;
    after: number;
    /** after - before（按指标原符号） */
    delta: number;
    /** true = 未劣化（保留）；false = 劣化超容忍（回滚） */
    good: boolean;
  };
  /** 2.0：护栏指标记录（操作环成功率综合判定） */
  guardrail?: {
    metric: 'operationalSuccessRate';
    before: number;
    after: number;
    delta: number;
    violated: boolean;
  };
  /** 2.0：调整来源（reactive 规则反应式 / proactive 预测前瞻式） */
  source?: 'reactive' | 'proactive';
  /** 关联的心智报告序号 */
  reportIndex?: number;
}
/** 调整报告（evaluateAndAdjust 产物） */
interface AdjustmentReport {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 本轮基于的心智报告序号 */
  reportIndex: number;
  /**
   * 本轮状态机结论：
   * - adjusted：应用了新调整（进入观察窗）
   * - observing：观察窗内等待更多报告
   * - committed：观察期通过，调整保留生效
   * - rolled-back：观察期判定劣化，自动回滚
   * - no-op：无可执行的推荐
   * - frozen：自动调整被冻结（手动接管）
   */
  status: 'adjusted' | 'observing' | 'committed' | 'rolled-back' | 'no-op' | 'frozen';
  /** 本轮应用的调整（保守原则：每轮至多 maxAdjustmentsPerRound 个） */
  applied: Array<{
    knob: string;
    label: string;
    from: number;
    to: number;
    reason: string;
    source?: 'reactive' | 'proactive';
  }>;
  /** 本轮自动回滚的调整 */
  rolledBack?: {
    knob: string;
    from: number;
    to: number;
    reason: string;
    effect: NonNullable<AuditEntry['effect']>;
  };
  /** 本轮判定保留的调整 */
  committed?: {
    knob: string;
    effect: NonNullable<AuditEntry['effect']>;
  };
  /** 观察窗进度 */
  observation?: {
    knob: string;
    reportsSeen: number;
    reportsNeeded: number;
  };
  /** no-op / frozen 时的原因说明 */
  skippedReason?: string;
  /** 本轮依据的心智报告（人类审查入口） */
  mentalReport: MentalReport;
}
/** 回滚结果（rollbackLastAdjustment 产物） */
interface RollbackResult {
  success: boolean;
  /** 回滚的旋钮 id（失败为空） */
  knob?: string;
  /** 回滚前取值 */
  from?: number;
  /** 回滚后取值 */
  to?: number;
  reason: string;
  message: string;
}
/** 元认知控制器状态（运维可观测） */
interface MetaControllerState {
  /** 自动调整全局冻结开关 */
  frozen: boolean;
  /** 手动接管（冻结自动调整）的旋钮 id 集合 */
  manuallyFrozenKnobs: string[];
  /** 2.0：熔断器面板（连续自动回滚的旋钮） */
  circuitBreakers: CircuitBreakerInfo[];
  /** 2.0：全局熔断标记（连续自动回滚触发，区别于手动冻结） */
  frozenByBreaker: boolean;
  /** 2.0：调参策略学习器快照 */
  learner: {
    totalTrials: number;
    arms: number;
    /** 平均学习置信权重（0=纯规则排序，1=完全信任学习结果） */
    explorationWeight: number;
    effectiveness: KnobEffectiveness[];
  };
  /** 2.0：安全包络快照（经验学习的安全区间） */
  safeEnvelopes: SafeEnvelopeInfo[];
  /** 观察窗中的待判定调整（无则空） */
  pending?: {
    knob: string;
    from: number;
    to: number;
    reason: string;
    reportsSeen: number;
    reportsNeeded: number;
    judgeMetric: JudgeMetric;
    baselineMetricValue: number;
  };
  /** 旋钮面板快照（当前值 / 边界 / 是否手动接管 / 是否熔断） */
  knobs: Array<{
    id: string;
    label: string;
    category: string;
    current: number;
    min: number;
    max: number;
    step: number;
    manuallyFrozen: boolean;
    /** 2.0：是否被熔断器冻结 */
    breakerTripped: boolean;
  }>;
  /** 最近审计条目（降序？否——按时间升序返回尾部） */
  auditTrail: AuditEntry[];
  totalAdjustments: number;
  totalRollbacks: number;
  totalCommits: number;
}
/** 趋势预测覆盖的指标（判定指标 + 综合稳定分） */
type TrendMetric = JudgeMetric | 'stabilityScore';
/** 单指标趋势外推（报告历史最小二乘拟合） */
interface MetricForecast {
  metric: TrendMetric;
  /** 每期变化量（最小二乘斜率；正 = 上升） */
  slopePerReport: number;
  /** 当前取值（最新报告） */
  currentValue: number;
  /** 外推期数 */
  horizon: number;
  /** horizon 期后的预测值 */
  predictedValue: number;
  /** 拟合优度 0~1 */
  r2: number;
  /** 置信度（历史点数 × R² 决定） */
  confidence: 'low' | 'medium' | 'high';
  /** 预测越限：风险阈值将在 horizon 内被穿越 */
  crossesRiskThreshold?: {
    threshold: number;
    direction: 'above' | 'below';
    /** 预计第几期越限 */
    withinReports: number;
  };
}
/** 前瞻性风险（预测越限 → 在指标仍健康时提前调整） */
interface ProactiveRisk {
  metric: TrendMetric;
  /** 人类可读描述 */
  description: string;
  /** 支撑该风险的预测 */
  forecast: MetricForecast;
  /** 紧迫度 0~1（越限越近越高） */
  urgency: number;
  /** 建议调整的旋钮 id */
  suggestedKnob: string;
  suggestedDirection: 'up' | 'down';
}
/** 旋钮调整有效性（「旋钮 × 方向」= 一个学习臂） */
interface KnobEffectiveness {
  /** 旋钮 id */
  knob: string;
  direction: 'up' | 'down';
  /** 该臂的判定指标 */
  judgeMetric: JudgeMetric;
  /** 试验次数（已判定的调整次数） */
  trials: number;
  commits: number;
  rollbacks: number;
  /** 试验成功率 = commits / trials */
  successRate: number;
  /** 平均效果增量（按指标原符号） */
  avgEffectDelta: number;
  /** 贝叶斯平滑有效性评分（乐观先验；冷启动臂更受探索青睐） */
  effectivenessScore: number;
}
/** 熔断器状态（连续自动回滚 → 冻结该旋钮的自动调整） */
interface CircuitBreakerInfo {
  knob: string;
  /** 连续自动回滚次数（判定保留后清零） */
  consecutiveRollbacks: number;
  /** 是否已熔断 */
  tripped: boolean;
  trippedAt?: number;
  reason?: string;
}
/** 经验安全包络（从 commit/rollback 历史学习的旋钮安全区间） */
interface SafeEnvelopeInfo {
  knob: string;
  min: number;
  max: number;
  /** default 旋钮原始边界 / learned 从好值学习 */
  source: 'default' | 'learned';
  /** 学习样本数（commit 的取值数） */
  sampleCount: number;
  /** 已知劣化取值（在该值上发生过自动回滚） */
  knownBadValues: number[];
}
/** 稳态目标带（判定指标的期望区间；偏离越远 → 调整步长越大） */
type HomeostasisBands = Partial<Record<JudgeMetric, {
  min: number;
  max: number;
}>>;
/** 单指标稳态状态 */
interface HomeostasisStatus {
  metric: TrendMetric;
  band: {
    min: number;
    max: number;
  };
  current: number;
  /** 归一化偏离（带内为 0；带外按带宽归一，可 >1） */
  deviation: number;
  state: 'in-band' | 'near-edge' | 'out-of-band';
}
/** 元认知层自察（系统对自身调整机制的认知） */
interface MetaStabilitySummary {
  /** 熔断器面板 */
  circuitBreakers: CircuitBreakerInfo[];
  /** 手动全局冻结 */
  globalFrozen: boolean;
  /** 全局熔断（连续回滚自动触发） */
  frozenByBreaker: boolean;
  /** 各旋钮安全包络 */
  safeEnvelopes: SafeEnvelopeInfo[];
  /** 学习器概况 */
  learner: {
    totalTrials: number;
    arms: number;
    explorationWeight: number;
  };
  /** 稳态目标带状态 */
  homeostasis: HomeostasisStatus[];
}
//#endregion
//#region src/contracts.d.ts
/** 记忆支柱契约：三类数据的读写与生命周期 */
interface IMemoryStore {
  findPattern(taskType: string, complexity: number, features?: string[]): TaskPatternMemory | undefined;
  recordSuccess(params: RecordSuccessParams): void;
  recordFailure(params: RecordFailureParams): void;
  getTopPatterns(limit?: number): TaskPatternMemory[];
  getAllTaskPatterns(): TaskPatternMemory[];
  upsertPattern(pattern: TaskPatternMemory): 'created' | 'updated';
  removePattern(fingerprint: string): boolean;
  getModelProfile(modelId: string): ModelLongTermProfile | undefined;
  getAllModelProfiles(): ModelLongTermProfile[];
  upsertModelProfile(profile: ModelLongTermProfile): 'created' | 'updated';
  /**
   * 贝叶斯能力估计（第一阶段 2.0：模型 × 任务类型的 Beta 后验推断）
   *
   * 时间加权证据 → 后验均值 / Wilson 下界 / 有效样本量 / 漂移；
   * 调度器利用端评分与反思器反事实分析的数据基础。
   * 可选方法：旧实现未提供时调度回退裸计数、反事实分析静默跳过。
   */
  getBayesianEstimate?(modelId: string, taskType: string): BayesianEstimate | undefined;
  recordDecisionFeedback(params: RecordDecisionFeedbackParams): void;
  getRecentFeedback(limit?: number): DecisionFeedback[];
  getDecisionSuccessRate(signalType: string): {
    total: number;
    successRate: number;
    avgOutcome: string;
  };
  appendFeedback(feedback: DecisionFeedback): boolean;
  distillExperience(minConfidence?: number): DistilledStrategy[];
  getStrategies(taskType: string, limit?: number): DistilledStrategy[];
  getAllStrategies(): DistilledStrategy[];
  recordStrategyOutcome(strategyId: string, success: boolean): void;
  findSemanticMemory(taskType: string, context?: {
    features?: string[];
    complexity?: number;
    length?: number;
    tokenCost?: number;
  }): SemanticMemory | undefined;
  getSemanticMemories(taskType: string, limit?: number): SemanticMemory[];
  getAllSemanticMemories(): SemanticMemory[];
  /**
   * 插入或更新语义记忆（第二阶段升级：证据合并增强 + 冲突消解）
   * @returns 'created' 新增 / 'updated' 覆盖 / 'merged' 证据合并增强 /
   *           'superseded' 取代旧冲突规律 / 'duplicate' 证据不足被丢弃
   */
  upsertSemanticMemory(memory: SemanticMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  removeSemanticMemory(id: string): boolean;
  recordSemanticOutcome(id: string, success: boolean): void;
  findProceduralMemory(kind: ProceduralMemory['kind'], taskType: string, context?: {
    features?: string[];
    complexity?: number;
    length?: number;
    tokenCost?: number;
    outcome?: string;
    rootCause?: string;
  }): ProceduralMemory | undefined;
  getProceduralMemories(taskType: string, kind?: ProceduralMemory['kind'], limit?: number): ProceduralMemory[];
  getAllProceduralMemories(): ProceduralMemory[];
  /**
   * 插入或更新程序记忆（第二阶段升级：证据合并增强 + 冲突消解，语义同 upsertSemanticMemory）
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertProceduralMemory(memory: ProceduralMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  removeProceduralMemory(id: string): boolean;
  recordProceduralOutcome(id: string, success: boolean): void;
  /** 情景事件水位：距上次蒸馏新增的情景事件数（成功+失败均计） */
  getDistillationProgress?(): {
    episodicEventCount: number;
    lastDistillationEventCount: number;
    pendingSinceLastDistillation: number;
  };
  /** 蒸馏完成检查点：刷新水位（distillKnowledge 成功后调用） */
  noteDistillationCheckpoint?(): void;
  getGlobalStats(): {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalTokensUsed: number;
    totalCostEstimate: number;
    averageQualityScore: number;
    averageExecutionTime: number;
  };
  getMemorySummary(): string;
  prune(maxAgeDays?: number): number;
  applyForgettingCurve(halfLifeDays?: number, forgetThreshold?: number): {
    decayed: number;
    forgotten: number;
  };
  fullTextSearch?(query: string, limit?: number): MemorySearchHit[];
  vectorSearch?(query: string, limit?: number): MemorySearchHit[];
  integrityCheck(): string;
  dbStats(): {
    patterns: number;
    profiles: number;
    feedback: number;
    strategies: number;
    /** 第二阶段：语义记忆条数 */
    semantic: number;
    /** 第二阶段：程序记忆条数 */
    procedural: number;
    pageSize: number;
    pageCount: number;
    walSize: number;
    schemaVersion: number;
    fts: boolean;
    vec: boolean;
  };
  checkpoint(): void;
  vacuum(): void;
  backup(destPath: string): string | undefined;
  rawQuery(sql: string, params?: Array<string | number | null>): Array<Record<string, unknown>>;
  flushSync(): void;
  dispose(): void;
}
/** 反思支柱契约：任务完成后复盘并更新记忆 */
interface IReflector {
  reflectOnOutcome(params: {
    signal: Signal;
    plan: ExecutionPlan;
    result: PlanExecutionResult;
    /** 本次注入/应用的蒸馏策略 id 列表（策略反馈闭环） */
    appliedStrategies?: string[];
    /** 第二阶段升级：本次经验检索命中的语义/程序记忆 id（三层记忆应用反馈闭环） */
    appliedMemoryIds?: {
      semantic?: string[];
      procedural?: string[];
    };
    /**
     * 第一阶段 2.0：本次各节点的调度决策洞察（预测置信度 + 实际结果）
     *
     * 由编排层从 TaskExecutor.getAndClearDecisionInsights() 桥接，
     * 反思器据此更新 Brier 校准统计（调度预测质量的自知之明）。
     */
    decisionInsights?: Array<{
      nodeId: string;
      taskType: string;
      modelId: string;
      predictedConfidence: number;
      exploration: boolean;
      success: boolean;
    }>;
  }): void;
  /**
   * 调度校准状态（第一阶段 2.0：预测置信度 vs 实际结果的滚动统计）
   *
   * Brier 分 / 平均残差 / 过自信-欠自信方向；可选方法，旧实现不提供时编排层跳过。
   */
  getCalibration?(): {
    brierScore: number;
    residualMean: number;
    samples: number;
    direction: 'overconfident' | 'underconfident' | 'calibrated' | 'insufficient';
    windowSize: number;
  };
  /**
   * 知识蒸馏（第二阶段）：从累积的情景记忆中蒸馏出语义记忆与程序记忆
   *
   * 触发时机：
   * - 定期：AutonomyLoop 维护周期内调用（水位门控，无新增样本时跳过）
   * - 阈值（第二阶段升级）：距上次蒸馏新增情景事件 ≥ autoDistillThreshold 时
   *   在成功复盘后由反思器自动触发
   * - 按需：外部通过 distill_knowledge Tool 调用（force 强制全量蒸馏）
   *
   * 蒸馏过程应产出可被优化器直接使用的结构化知识（SemanticMemory / ProceduralMemory）。
   * 第二阶段升级：产物使用内容寻址稳定 id；重复蒸馏合并增强既有规律（证据累积），
   * 冲突规律由证据竞争淘汰（superseded）。
   *
   * @param options.force 强制蒸馏（绕过水位门控）
   * @returns 蒸馏报告（水位不足或并发冲突时返回 skipped 报告）
   */
  distillKnowledge(options?: {
    force?: boolean;
  }): Promise<DistillationReport>;
}
/** 优化支柱契约：下一次调度前基于记忆产出推荐 */
interface IOptimizer {
  /**
   * 经验检索：相似任务模式 + 推荐模型组合 + 历史统计
   *
   * 第二阶段三层记忆优先级：procedural > semantic > episodic > none。
   * 命中程序/语义记忆时，返回 memoryLayer 与 rationale 说明决策依据。
   *
   * @param taskType 任务类型
   * @param complexity 复杂度 0~1
   * @param features 任务特征标签
   * @param context 第二阶段：程序/语义记忆条件匹配所需的额外上下文（长度 / token 成本）
   */
  lookupExperience(taskType: string, complexity: number, features?: string[], context?: {
    length?: number;
    tokenCost?: number;
  }): ExperienceLookup;
  /** 经验快路径：高置信度模式直接召回历史最优成功计划 */
  recallPlan(lookup: ExperienceLookup, objective: string): ExecutionPlan | undefined;
  /** 混合检索（模糊 + FTS5 + 向量 + 图联想），缺省实现可省略 */
  hybridSearch?(query: string, taskType: string, complexity: number, limit?: number): MemorySearchHit[];
}
/**
 * 安全沙盒契约：新策略上线路前的隔离验证环境
 *
 * 隔离性：评估全程离线（不调 LLM、不写记忆、不接触操作环调度器），
 * 不阻塞正常任务调度；同一策略 + 任务集 + 随机种子 → 评估结果可复现。
 */
interface ISandbox {
  /**
   * 隔离评估策略：历史任务回放 + 合成对抗任务，
   * 产出收益（reward/gain）、风险（risks）、回归（regressions）三段式报告
   * @param policy 待评估策略
   * @param baseline 对比基线策略（通常为当前部署策略；缺省仅输出绝对指标）
   */
  evaluate(policy: Policy, baseline?: Policy): Promise<EvaluationReport>;
  /** 当前评估任务集（历史回放 + 对抗合成） */
  getTaskSet(): SandboxTask[];
}
/**
 * 策略进化器契约：变异 → 沙盒选择 → 保留部署
 *
 * 进化循环：
 * - generateCandidates：基于当前策略产出变异候选（可追溯：generation/parentId/origin）
 * - evaluateCandidate：候选经沙盒隔离评估（与当前策略对比）
 * - selectBest：仅综合收益超阈值且零风险零回归的候选可胜出（劣变体淘汰）
 * - deployPolicy：胜出策略热切换到操作环（无需重启系统）
 */
interface IPolicyEvolver {
  /** 变异：产出候选策略变体 */
  generateCandidates(currentPolicy: Policy): Promise<Policy[]>;
  /** 选择（评估）：沙盒隔离评估单个候选 */
  evaluateCandidate(policy: Policy, sandbox: ISandbox): Promise<EvaluationReport>;
  /** 保留：择优返回可部署候选（无合格候选返回 null） */
  selectBest(candidates: Policy[], reports: EvaluationReport[]): Promise<Policy | null>;
  /** 部署：策略热切换到操作环 */
  deployPolicy(policy: Policy): Promise<void>;
}
/**
 * 自我建模契约：系统对自身运行状态的持续观察与结构化认知
 *
 * 双环架构的外环感知端：内环（执行 → 反思 → 记忆 → 优化 → 进化）
 * 的运行质量被持续采集为系统指标，并周期性凝结为心智报告——
 * 策略的优势与盲点、记忆体系的增长与退化、进化器的发现速度与
 * 存活率、系统稳定性与风险点，以及可机器验证的自我改进证据。
 */
interface ISelfModel {
  /** 生成一份心智报告（持续进程：报告随时间累积形成趋势） */
  generateMentalReport(): Promise<MentalReport>;
  /** 采集系统指标快照（心智报告的原始素材） */
  getSystemMetrics(): Promise<SystemMetrics>;
}
/**
 * 元认知控制契约：基于心智报告自动调整操作环与进化环参数
 *
 * 双环架构的外环决策端——调整「进化机制本身」：
 * - 保守原则：每轮至多小幅调整少量参数，观察效果后再继续
 * - 自动回滚：观察期内判定指标劣化超容忍 → 恢复调整前取值
 * - 审计留痕：全部自动/手动调整全量记录，支持手动覆盖与冻结
 */
interface IMetaCognitiveController {
  /** 评估最新心智报告并推进调整状态机（应用 / 观察 / 判定保留 / 自动回滚） */
  evaluateAndAdjust(): Promise<AdjustmentReport>;
  /** 手动回滚最近一次调整（观察中或已提交） */
  rollbackLastAdjustment(): Promise<RollbackResult>;
}
//#endregion
//#region src/policy/policy-evolver.d.ts
interface PolicyEvolverConfig {
  /** 每轮进化的候选变体数（缺省 6） */
  candidateCount?: number;
  /** 每个数值基因的变异概率（缺省 0.6） */
  mutationRate?: number;
  /** 变异强度基准（相对基因取值范围的比例，缺省 0.25；实际 × sigmaScale 自适应） */
  mutationStrength?: number;
  /** 布尔基因的翻转概率（缺省 0.25） */
  booleanFlipRate?: number;
  /** 部署门禁：相对 baseline 的最小收益提升（缺省 0.02，作用于 gainLCB） */
  minGain?: number;
  /** 种群（Hall of Fame）容量（缺省 6） */
  populationSize?: number;
  /** 交叉候选占比（缺省 0.34；种群 ≥2 时生效） */
  crossoverRate?: number;
  /** 规则变异概率（每个候选独立触发，缺省 0.3） */
  ruleMutationRate?: number;
  /** 探索者候选占比——边界内随机个体注入多样性（缺省 0.17） */
  explorerRate?: number;
  /** 规则变异可引用的已知任务类型（缺省空 = 规则用复杂度/特征条件） */
  knownTaskTypes?: string[];
  /** 金丝雀：最少观察样本数（缺省 5） */
  canaryMinSamples?: number;
  /** 金丝雀：晋升正式所需样本数（缺省 15） */
  canaryPromoteSamples?: number;
  /** 金丝雀：成功率劣化容忍（缺省 0.1） */
  canarySuccessTolerance?: number;
  /** 金丝雀：质量劣化容忍（缺省 0.05） */
  canaryQualityTolerance?: number;
  /** 进化历史持久化路径（缺省不持久化） */
  persistPath?: string;
  /** 随机源（测试可注入确定性实现） */
  rng?: () => number;
  /** 策略部署回调（热切换落地：更新 ModelScheduler/Optimizer 等） */
  onDeploy?: (policy: Policy) => void;
  /** 金丝雀决策回调（自动回滚 / 晋升时通知操作环） */
  onCanaryDecision?: (decision: {
    action: 'rolled-back' | 'promoted';
    policyId: string;
    reason: string;
  }) => void;
  /** 进化周期完成回调（可观测性） */
  onCycle?: (report: EvolutionCycleReport) => void;
}
/** 单轮进化周期报告 */
interface EvolutionCycleReport {
  /** 本轮进化代际 */
  generation: number;
  /** 父代策略 */
  parentPolicyId: string;
  /** 候选来源构成（mutation/crossover/rule-mutation/explorer） */
  candidateOrigins: Record<string, number>;
  /** 各候选评估摘要（含淘汰原因） */
  candidates: Array<{
    policyId: string;
    reward: number;
    gain: number;
    /** 收益置信下界（多种子统计门禁） */
    gainLCB?: number;
    deployable: boolean;
    risks: number;
    regressions: number;
  }>;
  /** 胜出并部署的策略 id（无合适候选为空） */
  deployedPolicyId?: string;
  /** 本轮结论（人类可读） */
  summary: string;
}
/** 金丝雀状态（部署后观察窗） */
interface CanaryState {
  policyId: string;
  deployedAt: number;
  status: 'active' | 'promoted' | 'rolled-back';
  /** 沙盒期望基线（部署时快照） */
  expectedSuccessRate: number;
  expectedAvgQuality: number;
  /** 操作环真实回报累计 */
  samples: number;
  successes: number;
  qualitySum: number;
  /** 状态变更原因（回滚/晋升时填写） */
  reason?: string;
}
/** 进化器状态报告（运维可观测） */
interface PolicyEvolverStatus {
  currentPolicy: Policy;
  /** 已部署策略链（按部署时间升序；含回滚标记） */
  deployedHistory: Array<{
    id: string;
    version: number;
    generation: number;
    origin: string;
    gain?: number;
    deployedAt: number;
    rolledBackAt?: number;
  }>;
  /** 种群精英（按适应度降序） */
  population: Array<{
    id: string;
    origin: string;
    generation: number;
    fitnessScore?: number;
  }>;
  /** 自适应变异步长系数（1 = 基准强度） */
  sigmaScale: number;
  /** 金丝雀观察窗（无活跃金丝雀为空） */
  canary?: CanaryState;
  /** 评估过的候选总数 */
  totalCandidatesEvaluated: number;
  /** 进化总轮数 */
  totalCycles: number;
  /** 最近一轮周期报告（无则为空） */
  lastCycle?: EvolutionCycleReport;
}
/**
 * 策略进化器（implements IPolicyEvolver）
 *
 * 被 index.ts 持有：autonomy-loop 进化段定期触发 runEvolutionCycle()，
 * 或外部经 evolve_policy Tool 手动触发；deployPolicy 经 onDeploy 回调
 * 热切换操作环（ModelScheduler.updatePolicy 等），金丝雀观察窗内由
 * reportOperationalOutcome 持续接收操作环真实结果。
 */
declare class PolicyEvolver implements IPolicyEvolver {
  private config;
  private current;
  /** 部署回滚栈：金丝雀失败时恢复 */
  private previousPolicy?;
  private deployedHistory;
  /** 种群精英存档（Hall of Fame，按 fitness.score 降序） */
  private population;
  private evaluatedReports;
  private cycleReports;
  private policyCounter;
  private totalCandidatesEvaluated;
  private totalCycles;
  /** 自适应步长系数（1/5 法则驱动） */
  private sigmaScale;
  /** 近 10 轮部署成败窗口（自适应步长依据） */
  private selectionWindow;
  /** 金丝雀观察窗（无活跃金丝雀为空） */
  private canary?;
  private rng;
  private evolving;
  constructor(config?: PolicyEvolverConfig, baseline?: Policy);
  /** 当前生效策略（操作环据此调度） */
  getCurrentPolicy(): Policy;
  /** 进化器状态报告 */
  getStatus(): PolicyEvolverStatus;
  /** 种群精英（只读快照） */
  getPopulation(): Policy[];
  /** 策略评估历史（policyId → 最近一次评估报告） */
  getEvaluationHistory(): EvaluationReport[];
  /**
   * 运行时调参入口（第四阶段：元认知控制器调节进化机制本身）
   *
   * 仅接受数值类进化参数（mutationRate / minGain / candidateCount 等），
   * 回调与持久化路径不可经此变更；下一进化周期即按新参数运行。
   */
  updateConfig(patch: Partial<PolicyEvolverConfig>): void;
  /** 数值进化参数快照（元认知旋钮 read 端；只读） */
  getTunableParams(): Readonly<{
    candidateCount: number;
    mutationRate: number;
    mutationStrength: number;
    booleanFlipRate: number;
    minGain: number;
    populationSize: number;
    crossoverRate: number;
    ruleMutationRate: number;
    explorerRate: number;
    canaryMinSamples: number;
    canaryPromoteSamples: number;
    canarySuccessTolerance: number;
    canaryQualityTolerance: number;
  }>;
  /**
   * 变异与交叉：产出混合候选（质级升级）
   *
   * 候选构成（candidateCount 个）：
   * - ⌈candidateCount × crossoverRate⌉ 个交叉候选（种群 ≥2 时；标量均匀交叉 +
   *   规则子集合并，双亲谱系可追溯）
   * - ⌊candidateCount × explorerRate⌋ 个探索者（边界内随机，注入多样性）
   * - 其余为当前策略/种群精英的高斯变异（sigmaScale 自适应）+ 规则变异
   */
  generateCandidates(currentPolicy: Policy): Promise<Policy[]>;
  /** 选择（评估）：在沙盒中隔离评估候选（与当前策略对比，多种子统计） */
  evaluateCandidate(policy: Policy, sandbox: ISandbox): Promise<EvaluationReport>;
  /**
   * 保留（择优）：deployable 且 gainLCB 最高且 ≥ minGain 的候选胜出
   *
   * 报告中 deployable 已含「零风险 + 零回归 + gainLCB ≥ 0」统计门禁，
   * 此处再叠加进化器级 minGain 阈值（双保险）；胜出者回填适应度并入种群。
   */
  selectBest(candidates: Policy[], reports: EvaluationReport[]): Promise<Policy | null>;
  /**
   * 部署：胜出策略热切换到操作环并进入金丝雀观察窗
   *
   * 经 onDeploy 回调落地（无需重启）；部署记录写入可追溯历史并持久化；
   * 金丝雀基线取沙盒评估期望，观察窗内 reportOperationalOutcome 持续校验。
   */
  deployPolicy(policy: Policy): Promise<void>;
  /**
   * 操作环真实结果回报（金丝雀观察窗，4.0 Wilson 统计判定）
   *
   * 单侧噪声不回滚：仅当成功率 Wilson 上界（乐观边界）也跌破
   * 期望 − 容忍 时才统计确认劣化 → 回滚（如 7/10 = 0.7 的 UB ≈ 0.89
   * 高于底线 → 继续观察；0/5 的 UB ≈ 0.43 → 立即回滚）。
   * 晋升：样本达 canaryPromoteSamples 且未确认劣化、点估计不破底线，
   * 且 Wilson 下界（保守边界）亦不破底线 → 统计达标晋升；下界未达标
   * 则继续累积样本（宁可多观察，不冒进上线）。
   * @returns 金丝雀状态（无活跃金丝雀返回 undefined）
   */
  reportOperationalOutcome(outcome: {
    success: boolean;
    quality?: number;
  }): CanaryState | undefined;
  /** 金丝雀自动回滚：恢复前一策略并热切换（操作环安全兜底） */
  private rollbackCanary;
  /** 运维手动回滚（金丝雀外强制恢复前一策略） */
  rollbackLastDeployment(): boolean;
  /**
   * 运行一轮完整进化周期（变异/交叉 → 沙盒评估 → 择优 → 部署）
   *
   * 自主循环定期调用 / 外部 Tool 手动触发；进化中重复调用返回进行中报告。
   * 周期尾部按 1/5 法则自适应调整变异步长。沙盒全程离线，不阻塞操作环。
   */
  runEvolutionCycle(sandbox: ISandbox): Promise<EvolutionCycleReport>;
  /** 高斯变异：数值基因按概率扰动（×sigmaScale）+ 钳制边界；布尔基因按概率翻转；规则基因增/删/改 */
  private mutatePolicy;
  /** 规则变异：无规则→增加；有规则→随机改一条或删一条 */
  private mutateRules;
  /** 随机合成一条规则（复杂度/特征/任务类型条件 + 随机动作） */
  private randomRule;
  /** 种群内随机双亲交叉（种群 <2 返回 null） */
  private crossoverRandom;
  /** 双亲交叉：标量基因逐位均匀选取 + 规则子集合并（双亲谱系可追溯） */
  private crossoverPolicies;
  /** 探索者：全基因边界内随机（注入种群多样性，跳出局部最优；origin 专属标记，谱系不误导为变异） */
  private explorerPolicy;
  /** 启动时确保种群含当前策略 */
  private seedPopulation;
  /**
   * 种群更新（4.0 多样性保持：拥挤去重选择）
   *
   * 候选按适应度竞争入种群，但与已入选个体基因距离 < DIVERSITY_RADIUS 的
   * 近重复个体被跳过（适应度共享的贪婪近似）——种群由「高适应度且彼此
   * 基因相异」的个体构成，避免单一基因型霸占种群导致交叉退化自交。
   * 池内相异个体不足容量时回填近重复（保持容量的降级策略）。
   */
  private updatePopulation;
  /**
   * 基因距离（0~1）：标量基因归一化绝对距离 + 布尔差异 + 规则集合
   * Jaccard 距离的等权平均——衡量两个策略在基因空间的相异度。
   */
  private geneDistance;
  /** 持久化进化状态（原子写；失败不阻断进化流程） */
  private persist;
  /** 启动时恢复上次部署策略与种群（无持久化文件或损坏时保持基准） */
  private loadPersisted;
}
//#endregion
//#region src/policy/sandbox.d.ts
/**
 * 模型×任务校准条目：用操作环真实历史锚定沙盒模拟
 *
 * observedAvgQuality = 记忆库模型画像中该模型在该任务类型的历史平均质量分；
 * samples = 历史调用次数（≥ minCalibrationSamples 才启用锚定）。
 *
 * 3.0 并行旁路（贝叶斯化）：posteriorQuality / effectiveSamples / drift
 * 由 buildCalibrationFromMemory 从统一证据内核填充——手工/旧格式条目
 * 缺省时 calibratedFit 回退 legacy 口径（observedAvgQuality × samples），
 * 行为与升级前逐位一致。
 */
interface SimCalibrationEntry {
  observedAvgQuality: number;
  samples: number;
  /** 3.0：贝叶斯后验质量（时间加权 EMA 质量向 0.5 先验收缩；小样本自动保守） */
  posteriorQuality?: number;
  /** 3.0：时间衰减后有效样本量（校准权重依据——旧证据自动让位） */
  effectiveSamples?: number;
  /** 3.0：近期能力漂移（加权成功率 − 裸成功率；沙盒感知模型修复/退化） */
  drift?: number;
}
/** 校准表：modelId → taskType → 条目 */
type SimCalibration = Record<string, Record<string, SimCalibrationEntry>>;
/** 启用校准锚定所需的最小历史样本数 */
declare const MIN_CALIBRATION_SAMPLES = 3;
/**
 * 从长期记忆构建校准表（index.ts 注入沙盒；进化周期之间可刷新）
 *
 * 3.0 贝叶斯化：在保留裸口径（observedAvgQuality/samples）的同时，
 * 从 getBayesianEstimate 附带时间加权证据视图——
 * - posteriorQuality = (n·emaQuality + 1·0.5) / (n+1)：近期敏感 + 小样本收缩
 * - effectiveSamples：30 天半衰期衰减后的等效观测数（校准权重依据）
 * - drift：能力漂移让沙盒感知「模型变了」（配合 calibratedFit 漂移倾斜）
 */
declare function buildCalibrationFromMemory(memory: LongTermMemory): SimCalibration;
interface SandboxConfig {
  /** 综合收益中成功率的权重（缺省 0.35） */
  successWeight?: number;
  /** 质量权重（缺省 0.35） */
  qualityWeight?: number;
  /** 成本权重（缺省 0.2；延迟权重 = 1 - 其余三项） */
  costWeight?: number;
  /** 成本归一化基准：单任务 token 数达到该值视为满成本（缺省 4000） */
  costNormTokens?: number;
  /** 延迟归一化基准：单任务延迟达到该值视为满延迟（缺省 5000ms） */
  latencyNormMs?: number;
  /** 模拟成功质量阈值（缺省 0.55） */
  successQualityThreshold?: number;
  /** 成功率的最大允许回归幅度（缺省 0.05） */
  regressionSuccessTolerance?: number;
  /** 质量的最大允许回归幅度（缺省 0.03） */
  regressionQualityTolerance?: number;
  /** token 成本的最大允许涨幅（相对 baseline，缺省 1.5 倍） */
  regressionCostTolerance?: number;
  /** 多种子评估的种子数（缺省 3；1 = 关闭统计门禁） */
  evaluationSeeds?: number;
  /** 历史校准表（缺省空 = 纯合成模拟） */
  calibration?: SimCalibration;
}
/** 单任务模拟结果 */
interface TaskSimulation {
  success: boolean;
  quality: number;
  latencyMs: number;
  tokens: number;
  decomposed: boolean;
  ensembleUsed: boolean;
  chosenModels: string[];
}
/**
 * 策略模拟执行器
 *
 * 给定策略参数 + 任务 + 模型快照，模拟「上下文规则解析 → 评分 → 分解决策 →
 * 选模型 → 组合决策 → 产出」：
 * - 有效参数：resolveEffectiveParams(params, task) —— 规则基因在此承受选择压力
 * - 产出质量 = 校准后能力适配 − 复杂度惩罚 + 稳定噪声（ensemble 取均值 + 多样性增益）
 * - 分解降低单节点复杂度（子复杂度 = c / n^0.7），但增加协调开销（延迟 +15%、token +10%）
 * - 评分调用与操作环共享 scoreModelWithPolicy → 沙盒保真
 */
declare class PolicySimulator {
  private models;
  private config;
  private modelIndex;
  constructor(models: SimModelStatus[], config?: SandboxConfig);
  /** 模型快照（只读） */
  getModels(): SimModelStatus[];
  /**
   * 校准后的能力适配分：真实历史锚定合成画像
   *
   * 3.0 贝叶斯口径（条目携带证据字段时）：
   * - 权重 w = min(0.6, effectiveSamples/50)：时间衰减后的等效样本——
   *   旧证据自动让位，长期不用的模型不再被陈旧历史过度锚定
   * - 锚定值 = posteriorQuality：近期敏感 EMA + 小样本向先验收缩
   * - 漂移倾斜：|drift| 大的模型按近期能力变化微调（±0.05 钳制），
   *   「模型修好了 / 模型退化了」在沙盒中被真实感知
   *
   * 兼容：旧格式条目（无证据字段）走 legacy 口径，行为与升级前逐位一致。
   */
  private calibratedFit;
  /**
   * 稳定噪声（FNV-1a 哈希 → [-0.05, 0.05)）
   *
   * 同一「任务×模型×种子」组合恒定同一噪声：策略变体与 baseline 在同一任务上
   * 的随机扰动完全一致，评估差异纯粹来自策略本身（选择压力不失真）。
   */
  private stableNoise;
  /** 按策略给全部候选模型评分（降序；使用上下文有效参数） */
  rankModels(params: SchedulerPolicyParams, task: SandboxTask): Array<{
    id: string;
    score: number;
  }>;
  /** 模拟执行单个任务（seedSalt 区分多种子轮次） */
  simulate(params: SchedulerPolicyParams, task: SandboxTask, seedSalt?: number): TaskSimulation;
}
/**
 * 生成合成对抗任务（测鲁棒性）
 *
 * 四类压力模式：
 * 1. 极端复杂：高复杂度 + 多特征 + 超长文本（压测分解与集成决策、规则条件匹配）
 * 2. 冷启动：从未见过的任务类型（压测评分函数的缺省路径）
 * 3. 特征密集：特征标签爆炸（压测规则特征条件匹配）
 * 4. 极简任务：低复杂度短文本（压测过度调度/过度分解）
 */
declare function generateAdversarialTasks(knownTaskTypes?: string[], rng?: () => number): SandboxTask[];
/**
 * 从长期记忆提取历史任务集（回放评估的数据来源）
 *
 * 每个任务模式（含成功与失败记录）至少产出 1 个回放任务；
 * 模式指纹 `taskType::complexity::features` 解析回任务上下文。
 */
declare function extractReplayTasks(memory: LongTermMemory): SandboxTask[];
/**
 * 安全沙盒（implements ISandbox）
 *
 * 被 PolicyEvolver 调用：evaluate(policy, baseline) 在隔离环境重放任务集，
 * 产出收益/风险/回归三段式评估报告（多种子统计门禁）。全程离线，不阻塞操作环调度。
 */
declare class Sandbox implements ISandbox {
  private simulator;
  private tasks;
  private config;
  constructor(params: {
    models: SimModelStatus[];
    tasks: SandboxTask[];
    config?: SandboxConfig;
  });
  /** 当前任务集（可观测） */
  getTaskSet(): SandboxTask[];
  /** 替换任务集（进化周期之间可刷新历史回放集） */
  setTaskSet(tasks: SandboxTask[]): void;
  /** 刷新校准表（操作环真实结果持续锚定模拟器） */
  setCalibration(calibration: SimCalibration): void;
  /**
   * 运行时调参入口（第四阶段：元认知控制器调节验证严格度）
   *
   * 经此调整多种子统计门禁（evaluationSeeds：种子越多 LCB 越严格）、
   * 回归容忍（regression*）与 reward 权重；下次评估即生效。
   * calibration 字段不可经此变更（走 setCalibration）。
   */
  updateConfig(patch: SandboxConfig): void;
  /** 当前评估配置快照（元认知旋钮 read 端；只读） */
  getConfig(): Readonly<SandboxConfig>;
  /**
   * 评估策略（可选与 baseline 对比；多种子统计）
   *
   * 流程：参数边界风险检查 → 多种子全任务集模拟（逐种子聚合求均值）→
   * reward/gain 均值与标准差 → 置信下界 LCB → 回归检测 → 部署门禁
   * （gainLCB ≥ 0：97.5% 置信下界上收益仍非负，防单种子过拟合）
   */
  evaluate(policy: Policy, baseline?: Policy): Promise<EvaluationReport>;
  /** 在全部种子上模拟执行（每种子完整跑一遍任务集） */
  private runAllSeeds;
  /** 单种子模拟执行全任务集并聚合指标（单个任务异常记为风险 + 失败样本） */
  private simulateAll;
  /** 综合收益：成功率 + 质量 + 成本效率 + 延迟效率 加权（归一化到 0~1） */
  private computeReward;
}
//#endregion
//#region src/meta/self-model.d.ts
/** 自我建模配置 */
interface SelfModelConfig {
  /** 报告历史持久化路径（缺省不持久化，仅内存趋势） */
  persistPath?: string;
  /** 内存中保留的报告份数（持久化不受限；缺省 50） */
  reportHistoryLimit?: number;
  /** 盲点/优势判定的最小样本数（缺省 3，防小样本噪声） */
  minSamplesPerTaskType?: number;
  /** 操作环表现统计的决策反馈窗口（缺省 100 条） */
  feedbackWindow?: number;
  /** 趋势外推期数（缺省 3） */
  forecastHorizon?: number;
  /** 产出预测所需的最少历史点数（缺省 3） */
  minForecastHistory?: number;
  /** 异常检测 z 分数阈值（缺省 2.5） */
  anomalyZThreshold?: number;
  /** 稳态目标带（未配置的指标不做稳态评估；元认知控制器同款配置用于步长自适应） */
  homeostasisBands?: HomeostasisBands;
}
/** 数据采集器（由编排层桥接到真实组件；全部同步只读） */
interface SelfModelCollectors {
  /** 策略进化器状态（进化环素材） */
  getEvolverStatus(): PolicyEvolverStatus;
  /** 记忆库分表条数 */
  getMemoryStats(): {
    patterns: number;
    semantic: number;
    procedural: number;
    strategies: number;
    profiles: number;
    feedback: number;
  };
  /** 记忆库全局统计 */
  getGlobalStats(): {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalTokensUsed: number;
    totalCostEstimate: number;
    averageQualityScore: number;
    averageExecutionTime: number;
  };
  /** 蒸馏水位（可选注入） */
  getDistillationProgress?(): {
    pendingSinceLastDistillation: number;
  } | undefined;
  /** 最近决策反馈（操作环素材） */
  getRecentFeedback(limit?: number): DecisionFeedback[];
  /** 2.0：元认知层状态（调参策略学习器 + 熔断器 + 安全包络；由编排层回注） */
  getMetaLayerState?(): {
    knobEffectiveness?: KnobEffectiveness[];
    metaStability?: Omit<MetaStabilitySummary, 'homeostasis'>;
  } | undefined;
}
/**
 * 稳态偏离计算（self-model 报告与 meta-controller 步长自适应共用）
 *
 * 返回归一化偏离：带内为 0（含近缘 near-edge），带外按带宽归一（可 >1）。
 * 控制器据此量化步长倍率：1 + floor(deviation × 2)，上限 maxStepMultiplier。
 */
declare function computeHomeostasis(band: {
  min: number;
  max: number;
}, current: number): {
  deviation: number;
  state: 'in-band' | 'near-edge' | 'out-of-band';
};
/**
 * 自我建模引擎（implements ISelfModel）
 *
 * 被编排层持有：元认知控制器每轮 evaluateAndAdjust 先调用
 * generateMentalReport 采集最新自我认知；也可经 mental_report Tool
 * 手动触发（人类审查入口）。
 */
declare class SelfModel {
  private config;
  private collectors;
  /** 报告历史（升序；趋势分析与改进证据的对比基线） */
  private history;
  /** 上一报告窗口的单次执行平均 token（趋势检测基线） */
  private lastTokensPerExecution?;
  constructor(params: {
    collectors: SelfModelCollectors;
    config?: SelfModelConfig;
  });
  /** 采集系统指标快照（心智报告的原始素材） */
  getSystemMetrics(): Promise<SystemMetrics>;
  /** 生成心智报告（持续进程：历史累积 → 趋势与改进证据） */
  generateMentalReport(): Promise<MentalReport>;
  /** 报告历史（升序；趋势分析素材） */
  getReportHistory(): MentalReport[];
  /** 最近一份报告 */
  getLatestReport(): MentalReport | undefined;
  /** 趋势数据（关键指标序列，供图表渲染） */
  getTrendSeries(): {
    reportIndex: number[];
    operationalSuccessRate: number[];
    proceduralCount: number[];
    semanticCount: number[];
    discoveryRate: number[];
    stabilityScore: number[];
  };
  /** 人类可读报告（mental_report Tool 输出 / 审查日志） */
  formatReport(report: MentalReport): string;
  /** 操作环指标：反馈窗口聚合 + 按任务类型分组 */
  private buildOperationalMetrics;
  /** 平均发现间隔：相邻部署 deployedAt 差均值（wall-clock） */
  private avgDiscoveryInterval;
  /** 策略表现：版本归因（按 deployedAt 时间窗分配反馈）+ 优势/盲点 */
  private buildStrategyPerformance;
  /** 记忆质量：三层增长趋势 + 蒸馏水位 */
  private buildMemoryQuality;
  /** 进化器效率 */
  private buildEvolverEfficiency;
  /** 稳定性：综合分 + 风险点 */
  private buildStability;
  /** 自我改进证据：与上份报告的机器可验证对比 */
  private buildEvidence;
  /** 规则化诊断 → 推荐调整（仅诊断方向，剂量由元认知控制器保守决定） */
  private recommend;
  private formatDuration;
  /** 从报告提取趋势指标取值 */
  private metricValueOf;
  /**
   * 趋势外推：关键指标最小二乘拟合 → horizon 期预测 + 越限检测
   *
   * 从被动描述（当前值 + 增量）升级为主动预测：指标按当前轨迹
   * 将在 horizon 内穿越风险阈值时产出 crossesRiskThreshold——
   * 前瞻性调整的触发基础（风险发生前行动，而非发生后补救）。
   */
  private buildForecasts;
  /** 最小二乘拟合（返回斜率/截距/R²） */
  private linearFit;
  /** 前瞻性风险：预测越限 → 紧迫度 + 建议旋钮（元认知控制器提前行动） */
  private buildProactiveRisks;
  /** 异常检测：关键指标对自身历史的 z 分数突变（稳定系统的自体噪声基线） */
  private detectAnomalies;
  /** 稳态目标带评估（偏离越远 → 元认知控制器步长越大） */
  private buildHomeostasis;
  private persist;
  private restore;
}
//#endregion
//#region src/meta/meta-controller.d.ts
/** 单个调节旋钮（参数热调整的最小单元） */
interface AdjustmentKnob {
  /** 全局唯一 id（与心智报告 recommendedAdjustments.knob 对齐） */
  id: string;
  /** 人类可读标签 */
  label: string;
  /** 所属子系统（reflector / evolver / sandbox / memory） */
  category: 'reflector' | 'evolver' | 'sandbox' | 'memory';
  /** 允许取值范围 */
  min: number;
  max: number;
  /** 单次保守步长 */
  step: number;
  /** 整数旋钮（如种子数） */
  integer?: boolean;
  /** 读当前值 */
  read(): number;
  /** 写入新值（落地到真实组件；抛异常视为失败） */
  write(value: number): void;
  /** 调整效果判定指标 */
  judgeMetric: JudgeMetric;
  /** 判定指标方向：true 越高越好；false 越低越好 */
  higherIsBetter: boolean;
}
/** 元认知控制器配置 */
interface MetaControllerConfig {
  /** 每轮最大调整数（保守原则；缺省 1） */
  maxAdjustmentsPerRound?: number;
  /** 观察窗：调整后需观察的心智报告份数（缺省 2） */
  observationReports?: number;
  /** 劣化容忍度（judgeMetric 相对劣化超过该值 → 回滚；缺省 0.02） */
  degradationTolerance?: number;
  /** 审计日志持久化路径（缺省不持久化） */
  persistPath?: string;
  /** 内存保留的审计条数（缺省 200） */
  auditLimit?: number;
  /** 调整应用回调（编排层广播 / 日志） */
  onAdjust?: (entry: AuditEntry) => void;
  /** 回滚回调（自动或手动） */
  onRollback?: (entry: AuditEntry) => void;
  /** 判定保留回调 */
  onCommit?: (entry: AuditEntry) => void;
  /**
   * 稳态目标带：判定指标 → 期望区间。
   * 配置后：① 步长随偏离量化放大（1~maxStepMultiplier 档）；
   * ② 心智报告输出稳态带状态。缺省空 = 纯保守固定步长。
   */
  homeostasisBands?: HomeostasisBands;
  /** 稳态自适应步长上限（×step；缺省 3） */
  maxStepMultiplier?: number;
  /** 单旋钮连续自动回滚熔断阈值（缺省 2） */
  breakerThreshold?: number;
  /** 全局连续自动回滚熔断阈值（缺省 3） */
  globalBreakerThreshold?: number;
  /** 前瞻性调整开关（心智报告前瞻风险注入候选；缺省 true） */
  proactiveEnabled?: boolean;
}
/** 学习臂统计（臂 = 旋钮 × 方向） */
interface ArmStats {
  trials: number;
  commits: number;
  rollbacks: number;
  /** 按指标原符号的效果增量累计 */
  effectSum: number;
}
/**
 * 元认知控制器（implements IMetaCognitiveController）
 *
 * 被编排层持有：autonomy-loop 低频触发 evaluateAndAdjust（每 N 轮心跳），
 * 也可经 meta_cognition_* Tool 手动触发/审查/接管。
 */
declare class MetaCognitiveController {
  private config;
  private selfModel;
  private knobs;
  private audit;
  private pending?;
  private frozen;
  private manuallyFrozenKnobs;
  /** 已被回滚过的 adjust 审计 id（手动回滚去重） */
  private rolledBackAdjustIds;
  private counters;
  private auditSeq;
  /** 调参策略学习器（乐观先验 Bandit） */
  private learner;
  /** 安全包络：各旋钮的已验证好取值 / 已知劣化取值 */
  private envelopeGood;
  private envelopeBad;
  /** 熔断器：单旋钮连续自动回滚计数与已熔断旋钮 */
  private breakerCounters;
  private trippedBreakers;
  /** 全局连续自动回滚计数（跨旋钮） */
  private globalRollbackStreak;
  /** 全局熔断标记（区别于手动 frozen） */
  private frozenByBreaker;
  constructor(params: {
    selfModel: SelfModel;
    knobs: AdjustmentKnob[];
    config?: MetaControllerConfig;
  });
  /**
   * 评估并调整（外环主入口；状态机单步推进）
   *
   * 每次调用 = 一份新心智报告 + 至多一个状态转移：
   * 观察窗满 → 判定（commit / rollback）；空闲 → 应用一个保守调整；
   * 观察中 → 仅累计进度；冻结 → no-op。
   *
   * 2.0：判定带护栏综合评判（学习器/包络/熔断器同步更新）；
   * 候选 = 反应式推荐 ∪ 前瞻风险建议，经学习器排序后保守应用
   * （稳态自适应步长 + 安全包络钳制 + 已知劣化值排除）。
   */
  evaluateAndAdjust(): Promise<AdjustmentReport>;
  /**
   * 手动回滚最近一次调整
   *
   * 优先回滚观察窗中的调整；无观察中调整时回滚最近一次已提交
   * （未被回滚过）的调整。全部审计留痕。
   */
  rollbackLastAdjustment(): Promise<RollbackResult>;
  /** 手动覆盖旋钮值：写入后该旋钮冻结自动调整（人工优先） */
  setManualOverride(knobId: string, value: number): RollbackResult;
  /** 解除旋钮的手动接管（恢复自动调整资格） */
  clearManualOverride(knobId: string): boolean;
  /** 全局冻结 / 解冻自动调整 */
  setFrozen(frozen: boolean): void;
  /** 运行状态（meta_cognition_status Tool / 审查入口） */
  getState(): MetaControllerState;
  /** 审计日志（全量，升序） */
  getAuditTrail(): AuditEntry[];
  /**
   * 观察期满判定：劣化超容忍 → 回滚
   *
   * 2.0 综合判定护栏：目标指标未劣化但操作环成功率显著下滑 → 一律判失败。
   * 单指标优化不得以整体劣化为代价（guardrail violated → rollback）。
   */
  private judge;
  /** 全指标基线快照（护栏综合判定的 before 数据） */
  private snapshotAllMetrics;
  /**
   * 稳态步长倍率（1~maxStepMultiplier）：
   * 判定指标配置了目标带 → 偏离带越远倍率越大（比例控制，量化档位）；
   * 未配置目标带 → 1（行为与 1.0 固定步长一致）。
   */
  private stepMultiplierFor;
  /** 旋钮当前安全包络：有 commit 好值 → 好值区间 ± 一步长；否则旋钮原始边界 */
  private envelopeOf;
  /** 已知劣化值判定（数值直接相等，或整数旋钮按四舍五入相等） */
  private isKnownBadValue;
  /** commit 判定后收录好值（安全包络的「已验证安全」样本） */
  private recordGoodValue;
  /** 自动回滚后标记劣化值（后续调整预防性排除） */
  private recordBadValue;
  /** 单次判定保留：该旋钮连续回滚清零、全局连续回滚清零 */
  private onJudgedCommit;
  /** 单次判定回滚：推进单旋钮与全局连续回滚计数，达阈值触发熔断 */
  private onJudgedRollback;
  /** 熔断器面板（getState / 心智报告共享） */
  private breakerPanel;
  /**
   * 熔断器手动复位（公共 API）
   *
   * - 指定 knobId：复位该旋钮熔断（清零计数 + 解除熔断）
   * - 不指定：复位全局熔断 + 全部旋钮熔断与计数
   * 返回是否发生了实际复位动作。
   */
  reArmBreaker(knobId?: string): boolean;
  /** 从心智报告提取判定指标 */
  private extractMetric;
  private appendAudit;
  private buildReport;
  private persist;
  private restore;
}
//#endregion
//#region src/world-model.d.ts
/**
 * world-model.ts — 世界模型（自主智能"预见"支柱）
 *
 * 职责：让系统对"外部世界如何运转"建立内部模型，从而具备预见能力——
 * 不是被动等待信号到来，而是提前预判信号到达、负载趋势与类型关联，
 * 为决策引擎、心跳循环与元认知提供前瞻性依据。
 *
 * 能力矩阵：
 * 1. 信号到达规律学习：按类型维护到达时间序列（滑动窗口），
 *    计算到达率、到达间隔分布、时段热度（小时直方图）
 * 2. 到达预测：基于历史到达率 + 时段热度 + 突发趋势，
 *    预测未来窗口内各类型信号的期望到达数（含置信区间）
 * 3. 类型关联矩阵：统计类型对的共现频率（时间邻近窗口内），
 *    识别"A 类型信号常伴随 B 类型信号"的规律，供级联与预取决策
 * 4. 预测校准：记录每次预测与实际到达的偏差，
 *    计算校准误差（MAE），误差过大时降低预测置信度并提示重学
 * 5. 趋势检测：对到达率做线性回归，识别上升/下降/平稳趋势，
 *    上升趋势触发负载预警洞察（交给元认知/目标引擎）
 *
 * 设计要点：
 * - 全部为纯统计学习，无需 LLM，开销极低，可在每次信号到达时增量更新
 * - 时间序列窗口有界（每类型最多保留 N 个到达时间戳），内存可控
 */
/** 单类型信号的到达统计 */
interface ArrivalStats {
  type: string;
  /** 到达时间戳（滑动窗口，最新在尾部） */
  timestamps: number[];
  /** 小时直方图（0~23 时段的到达计数） */
  hourHistogram: number[];
  /** 总到达数 */
  totalCount: number;
  /** 首次观测时间 */
  firstSeenAt: number;
  /** 最近观测时间 */
  lastSeenAt: number;
}
/** 到达预测结果 */
interface ArrivalPrediction {
  type: string;
  /** 预测窗口内期望到达数 */
  expectedCount: number;
  /** 置信区间下界 */
  lowerBound: number;
  /** 置信区间上界 */
  upperBound: number;
  /** 预测置信度 0~1（由校准误差驱动） */
  confidence: number;
  /** 趋势方向 */
  trend: 'rising' | 'falling' | 'stable';
}
/** 预测校准记录 */
interface CalibrationRecord {
  type: string;
  predicted: number;
  actual: number;
  error: number;
  timestamp: number;
}
/** 类型关联（共现） */
interface TypeCorrelation {
  typeA: string;
  typeB: string;
  /** 共现次数 */
  coOccurrences: number;
  /** 关联强度 0~1（共现数 / min(各自总数)） */
  strength: number;
}
/** 世界模型配置 */
interface WorldModelConfig {
  /** 每类型保留的到达时间戳上限 */
  maxTimestampsPerType: number;
  /** 关联共现判定窗口（毫秒） */
  coOccurrenceWindowMs: number;
  /** 趋势检测最少样本数 */
  minSamplesForTrend: number;
  /** 上升趋势判定斜率阈值（每分钟到达数增量） */
  risingSlopeThreshold: number;
  /** 校准误差超过该值视为预测失准 */
  calibrationErrorThreshold: number;
}
/** 默认配置 */
declare const DEFAULT_WORLD_MODEL_CONFIG: WorldModelConfig;
/** 世界模型摘要（运维可观测） */
interface WorldModelSummary {
  trackedTypes: number;
  totalArrivals: number;
  types: Array<{
    type: string;
    totalCount: number;
    lastSeenAt: number;
    recentRatePerMin: number;
  }>;
  correlations: TypeCorrelation[];
  trends: Array<{
    type: string;
    trend: 'rising' | 'falling' | 'stable';
    slopePerMin: number;
  }>;
  calibrationError: number;
  /** 5.0：混杂指纹（观测共现 ≠ 因果的证伪现场） */
  confoundedPairs?: Array<{
    typeA: string;
    typeB: string;
    observationalStrength: number;
    causalEffect: number;
    divergence: number;
  }>;
}
/**
 * 世界模型
 *
 * 被 index.ts 持有：哨兵每次 ingest 后调用 observeArrival() 增量学习；
 * 心跳循环定期调用 predictArrivals() 获取前瞻预测，detectTrends() 产出负载预警。
 *
 * 5.0 质变（因果升级）：挂载 CausalKernel 后，本模型从「相关性预测器」
 * 升级为「因果预见器」——predictInterventionEffect(action, kpi) 直接回答
 * 「若我对系统实施 do(action)，目标 KPI 期望变化几何（含不确定性区间）」。
 * 相关矩阵负责「看见规律」，因果图负责「预见干预后果」——
 * 二者的显著背离（混杂指纹）在 getSummary() 中显式曝光。
 */
declare class WorldModel {
  private config;
  private stats;
  private calibrations;
  /** 待校准的预测（type → 预测值，窗口结束后对账） */
  private pendingPredictions;
  /** 5.0：因果内核（可选挂载） */
  private causal?;
  constructor(config?: Partial<WorldModelConfig>);
  /**
   * 5.0：挂载因果内核（幂等）。
   *
   * 挂载后：
   * - 类型共现自动作为观测证据写入因果图（银级证据）；
   * - predictInterventionEffect 提供因果预见（黄金口径）。
   */
  attachCausalKernel(kernel: CausalKernel): void;
  /**
   * 5.0：因果预见 ——「若实施 do(action)，目标指标期望如何变化」。
   *
   * 与 predictArrivals 的本质区别：那是「世界自己会怎样」（外推），
   * 这是「我们主动干预后世界会怎样」（因果阶梯第二层）。
   * 无因果证据时诚实返回 null，而非伪装成知道。
   */
  predictInterventionEffect(action: string, targetKpi: string): CausalEffect | null;
  /** 5.0：登记一次真实干预（A/B 切换 / 参数实验的黄金证据） */
  recordIntervention(action: string, targetKpi: string, setTo: boolean, observedY: boolean, actor: string, hypothesis?: string): void;
  /**
   * 观察一次信号到达（增量学习入口）
   * @param type 信号类型
   * @param timestamp 到达时间戳（缺省当前时间）
   */
  observeArrival(type: string, timestamp?: number): void;
  /**
   * 预测未来窗口内各类型信号的到达数
   * @param horizonMs 预测窗口（毫秒，缺省 5 分钟）
   * @returns 各类型的到达预测（按期望到达数降序）
   */
  predictArrivals(horizonMs?: number): ArrivalPrediction[];
  /**
   * 对账预测与实际到达（校准）
   * @returns 本轮新增的校准记录
   */
  settleCalibrations(now?: number): CalibrationRecord[];
  /**
   * 类型关联矩阵（共现强度）
   * @param minStrength 最低关联强度过滤
   * @returns 类型对关联列表（按强度降序）
   */
  getCorrelations(minStrength?: number): TypeCorrelation[];
  /**
   * 趋势检测：识别到达率上升的类型（负载预警）
   * @returns 上升趋势的类型列表（含斜率）
   */
  detectTrends(): Array<{
    type: string;
    trend: 'rising' | 'falling' | 'stable';
    slopePerMin: number;
  }>;
  /** 世界模型摘要 */
  getSummary(): WorldModelSummary;
  /** 平均校准误差（MAE） */
  meanCalibrationError(): number;
  /** 序列化 */
  serialize(): {
    stats: ArrivalStats[];
    calibrations: CalibrationRecord[];
  };
  /** 反序列化 */
  deserialize(data: {
    stats: ArrivalStats[];
    calibrations: CalibrationRecord[];
  }): void;
  /** 最近到达率（每毫秒），基于最近 5 分钟窗口 */
  private recentRate;
  /** 时段热度因子：目标时段计数 / 全天均值 */
  private hourFactor;
  /** 趋势方向（由斜率判定） */
  private trendOf;
  /** 到达率线性回归斜率（每分钟到达数 / 分钟） */
  private slopeOf;
  /** 共现计数：两序列中时间邻近的配对数 */
  private countCoOccurrences;
  /** 预测置信度（由该类型历史校准误差驱动） */
  private calibrationConfidence;
  /** 最近一次预测窗口（用于对账，简化为固定 5 分钟） */
  private get lastHorizonMs();
}
//#endregion
//#region src/curiosity-engine.d.ts
/**
 * curiosity-engine.ts — 好奇心引擎（自主智能"内在动机"支柱）
 *
 * 职责：让系统不满足于"完成被指派的任务"，而是主动发现自身的知识盲区，
 * 生成探索性任务去填补盲区——这是从"工具"到"自主智能体"的关键跃迁。
 *
 * 能力矩阵：
 * 1. 知识盲区扫描：对比"系统接触过的任务类型"与"记忆中有成功经验的类型"，
 *    识别接触多但经验少（高失败/低质量）的类型，以及从未探索过的类型
 * 2. 新颖度排序：对候选探索目标按"信息增益"打分——
 *    未知程度（无经验）+ 潜在价值（接触频率）+ 探索稀缺度（历史探索次数）
 * 3. 探索预算：限制探索任务占比，防止好奇心失控挤占核心任务资源，
 *    预算随系统健康度动态调节（健康时多探索，退化时收敛）
 * 4. 探索回写：探索任务完成后记录收获（是否填补了盲区），
 *    驱动好奇心模型更新，形成"探索 → 学习 → 新盲区"的循环
 *
 * 设计要点：
 * - 好奇心产出的探索目标经 goalEngine 注入哨兵执行，与自主闭环无缝衔接
 * - 探索预算与健康度联动，保证探索行为始终在安全边界内
 */
/** 知识盲区候选 */
interface KnowledgeGap {
  /** 任务类型 */
  taskType: string;
  /** 盲区成因 */
  reason: 'unexplored' | 'low-experience' | 'high-failure';
  /** 接触次数（外部信号到达次数） */
  exposureCount: number;
  /** 已有成功经验数 */
  experienceCount: number;
  /** 历史探索次数 */
  explorationCount: number;
  /** 新颖度评分 0~1（越高越值得探索） */
  noveltyScore: number;
}
/** 探索任务建议 */
interface ExplorationProposal {
  taskType: string;
  description: string;
  noveltyScore: number;
  /** 预期信息增益描述 */
  expectedGain: string;
}
/** 探索记录 */
interface ExplorationRecord {
  taskType: string;
  timestamp: number;
  /** 探索是否带来新知识（填补盲区） */
  gainedKnowledge: boolean;
  note?: string;
}
/**
 * 5.0：因果实验记录（假设驱动好奇心的科学循环）
 *
 * 与普通探索记录的本质区别：每次因果实验都有先验假设（可证伪）、
 * 干预动作（do 而非看）与图更新（贝叶斯后验收缩）——
 * 即使结果否定假设（证伪），区间收窄本身就是知识增量。
 */
interface CausalExplorationRecord {
  from: string;
  to: string;
  hypothesis: string;
  setTo: boolean;
  observedY: boolean;
  timestamp: number;
  /** 实验前效应区间宽度 */
  uncertaintyBefore: number;
  /** 实验后效应区间宽度（应小于 before —— 后验收缩） */
  uncertaintyAfter: number;
  /** 假设是否被支持 */
  hypothesisSupported: boolean;
}
/** 好奇心引擎配置 */
interface CuriosityEngineConfig {
  /** 探索预算占单轮心跳派发的最大比例 0~1 */
  explorationBudgetRatio: number;
  /** 判定"低经验"的成功经验数阈值 */
  lowExperienceThreshold: number;
  /** 判定"高失败"的失败率阈值 */
  highFailureRateThreshold: number;
  /** 新颖度评分中未知程度的权重 */
  noveltyUnknownWeight: number;
  /** 新颖度评分中接触频率的权重 */
  noveltyExposureWeight: number;
  /** 新颖度评分中探索稀缺度的权重 */
  noveltyScarcityWeight: number;
}
/** 默认配置 */
declare const DEFAULT_CURIOSITY_CONFIG: CuriosityEngineConfig;
/** 知识状态提供器（由 index.ts 桥接长期记忆与世界模型） */
interface KnowledgeProvider {
  /** 系统接触过的任务类型及接触次数 */
  getExposure(): Record<string, number>;
  /** 各任务类型的成功经验数 */
  getExperienceCounts(): Record<string, number>;
  /** 各任务类型的失败率 0~1 */
  getFailureRates(): Record<string, number>;
}
/**
 * 好奇心引擎
 *
 * 被 index.ts 持有：心跳循环在派发子任务前调用 proposeExplorations()
 * 获取探索建议（受预算约束），探索完成后经 recordExploration() 回写收获。
 */
declare class CuriosityEngine {
  private config;
  private provider;
  private explorations;
  /** 各类型历史探索次数 */
  private explorationCounts;
  /** 5.0：因果内核（挂载后好奇心升级为假设驱动的实验设计） */
  private causal?;
  /** 10.0：科学家内核（挂载后实验建议升级为 Lindley EIG 最优设计） */
  private scientist?;
  /** 5.0：因果实验历史 */
  private causalExplorations;
  constructor(provider: KnowledgeProvider, config?: Partial<CuriosityEngineConfig>);
  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: CausalKernel): void;
  /** 10.0：挂载科学家内核（幂等）——实验建议升级为 EIG 最优设计 */
  attachScientistMind(mind: ScientistMind): void;
  /**
   * 5.0：假设驱动实验设计 —— 好奇心的科学化。
   *
   * 质变点：旧版好奇心是「类型盲区扫描」（没做过什么就做什么）——
   * 探索目标由接触频率决定，与知识价值无关。挂载因果内核后，
   * 探索目标改为「因果图上不确定性最高 × 重要性最高的边」：
   * 每个建议自带可证伪假设与 do-干预方案。
   * 探索从「到处走走看」升级为「设计实验回答关键问题」。
   *
   * 10.0 质变（挂载科学家内核后）：建议口径从「不确定性 × 重要性」
   * 的启发式升级为 Lindley EIG 最优设计——每条建议携带净价值
   * （EIG + 混杂加成 − 实验代价，nat 口径）与最优臂选择，
   * 混杂分歧边（观测≠干预）优先——那是观测永远买不到的知识。
   *
   * @param targetKpi 实验关心的结果指标（默认 'task.outcome'；EIG 口径下仅作无科学家时的回退）
   * @param budget 本轮实验配额
   */
  proposeCausalExperiments(targetKpi?: string, budget?: number): CausalExperiment[];
  /**
   * 10.0：EIG 最优实验设计透传（原生口径，供宿主直接执行与结算）。
   * 与 proposeCausalExperiments 的区别：不压缩为 0~1 启发式评分，
   * 返回完整的 DesignedExperiment（nat 口径 + 台账结算句柄）。
   */
  designOptimalExperiments(maxCount?: number): DesignedExperiment[];
  /**
   * 5.0：回写因果实验结果（假设 → 干预 → 图更新闭环）。
   *
   * 证伪也是收获：假设被否定时区间同样收窄（后验收缩），
   * uncertaintyReduction > 0 即记 gainedKnowledge ——
   * 好奇心的收益率第一次有了科学口径（信息增益而非运气）。
   */
  recordCausalExperiment(experiment: {
    from: string;
    to: string;
    setTo: boolean;
    hypothesis: string;
  }, observedY: boolean): CausalExplorationRecord | null;
  /** 5.0：因果实验历史 */
  getCausalExplorations(): CausalExplorationRecord[];
  /** 5.0：实验的信息增益率（平均区间收缩比例） */
  getCausalYield(): number;
  /**
   * 扫描知识盲区
   * @returns 盲区候选列表（按新颖度降序）
   */
  scanKnowledgeGaps(): KnowledgeGap[];
  /**
   * 生成探索建议（受预算约束）
   * @param dispatchSlots 本轮心跳的总派发槽位数
   * @param healthScore 系统健康度 0~1（健康时多探索）
   * @returns 探索任务建议列表
   */
  proposeExplorations(dispatchSlots: number, healthScore?: number): ExplorationProposal[];
  /**
   * 回写探索结果（探索完成后调用）
   * @param taskType 探索的任务类型
   * @param gainedKnowledge 是否填补了盲区
   * @param note 备注
   */
  recordExploration(taskType: string, gainedKnowledge: boolean, note?: string): void;
  /** 探索历史 */
  getExplorations(): ExplorationRecord[];
  /** 探索收获率（填补盲区的比例） */
  getExplorationYield(): number;
  /** 好奇心摘要 */
  getSummary(): any;
  /** 生成探索任务描述 */
  private describeExploration;
  /** 生成预期收益描述 */
  private describeGain;
}
//#endregion
//#region src/safety-governor.d.ts
/**
 * safety-governor.ts — 安全治理器（自主智能"边界"支柱）
 *
 * 职责：自主性越强，越需要明确的边界。安全治理器为系统的自主行为
 * 设置硬性约束，确保"自主"不演变为"失控"。
 *
 * 能力矩阵：
 * 1. 限流（Rate Limiter）：限制单位时间内的自主动作次数，
 *    防止心跳循环或探索行为在短时间内过度消耗资源
 * 2. 预算（Budget）：限制累计 token 消耗 / 成本，
 *    超出预算后拒绝新的自主动作，防止成本失控
 * 3. 熔断器（Circuit Breaker）：连续失败超过阈值时熔断，
 *    暂停自主执行进入冷却期，冷却后半开试探，成功则恢复
 * 4. 置信度门控（Confidence Gate）：低置信度的决策不放行自主执行，
 *    要求转人工确认，防止盲目行动
 * 5. Kill Switch：全局紧急停止开关，一键冻结所有自主行为
 *
 * 设计要点：
 * - 治理器是"否决权"角色：不决定做什么，只决定"能不能做"
 * - 所有约束均可配置，且提供审计日志追溯每次拦截原因
 *
 * 4.0 升级（治理闭环）：
 * - 半开探测互斥：冷却期结束后仅放行一个试探动作，其余继续拒绝——
 *   升级前半开态放行全部流量，恢复瞬间的洪峰会直接打垮刚喘息的下游
 * - 按动作限流：perActionRateLimits 为指定动作配置独立窗口
 *   （如 exploration 5/min、autonomous-execute 60/min），
 *   未配置的动作沿用共享全局窗口（与升级前行为一致）
 * - 预算/审计持久化：persistPath 配置后，token/成本累计与审计尾部
 *   落盘重启恢复——升级前纯内存，重启即预算清零、审计丢失
 */
/** 治理动作类型 */
type GovernedAction = 'autonomous-execute' | 'exploration' | 'goal-dispatch' | 'strategy-evolution';
/** 治理裁决 */
interface GovernanceVerdict {
  allowed: boolean;
  /** 拦截原因（allowed=false 时） */
  reason?: string;
  /** 拦截类别 */
  blockedBy?: 'kill-switch' | 'rate-limit' | 'budget' | 'circuit-breaker' | 'confidence-gate';
}
/** 治理审计条目 */
interface GovernanceAuditEntry {
  timestamp: number;
  action: GovernedAction;
  verdict: GovernanceVerdict;
}
/** 熔断器状态 */
type CircuitState = 'closed' | 'open' | 'half-open';
/** 安全治理器配置 */
interface SafetyGovernorConfig {
  /** 限流：每分钟最大自主动作数 */
  maxActionsPerMinute: number;
  /** 预算：累计 token 上限（0=不限制） */
  tokenBudget: number;
  /** 预算：累计成本上限（美元，0=不限制） */
  costBudget: number;
  /** 熔断：连续失败阈值 */
  circuitFailureThreshold: number;
  /** 熔断：冷却期（毫秒） */
  circuitCooldownMs: number;
  /** 置信度门控：低于该值的决策需人工确认 */
  confidenceThreshold: number;
  /** 治理审计日志上限 */
  auditLimit: number;
  /**
   * 4.0：按动作独立限流（每分钟上限；未列出的动作沿用共享全局窗口）。
   * 配置后该动作拥有自己的滑动窗口，不再与全局窗口叠加计数。
   */
  perActionRateLimits?: Partial<Record<GovernedAction, number>>;
  /**
   * 4.0：治理状态持久化路径（预算累计 + 审计尾部落盘，重启恢复）。
   * 不配置则纯内存（与升级前行为一致）。
   */
  persistPath?: string;
}
/** 默认配置 */
declare const DEFAULT_SAFETY_GOVERNOR_CONFIG: SafetyGovernorConfig;
/** 可持久化的治理状态（4.0） */
interface GovernorPersistState {
  version: 1;
  totalTokensUsed: number;
  totalCost: number;
  circuitState: CircuitState;
  consecutiveFailures: number;
  circuitOpenedAt: number;
  killSwitchEngaged: boolean;
  auditTail: GovernanceAuditEntry[];
}
/**
 * 安全治理器
 *
 * 被 index.ts 持有：所有自主动作执行前调用 govern() 获取裁决，
 * 执行结果经 recordOutcome() 回写以驱动熔断器与预算统计。
 * 4.0：主执行路径（executeSignal）执行前同样过 govern('autonomous-execute')。
 */
declare class SafetyGovernor {
  private config;
  /** 限流：最近一分钟的动作时间戳（共享全局窗口） */
  private recentActions;
  /** 限流：按动作独立窗口（perActionRateLimits 配置的动作） */
  private perActionWindows;
  /** 预算：累计消耗 */
  private totalTokensUsed;
  private totalCost;
  /** 熔断器状态 */
  private circuitState;
  private consecutiveFailures;
  private circuitOpenedAt;
  /** 4.0：半开试探互斥（探测在途时其余动作继续拒绝） */
  private halfOpenProbeInFlight;
  /** Kill Switch */
  private killSwitchEngaged;
  /** 审计日志 */
  private audit;
  /** 4.0：持久化防抖定时器 */
  private persistTimer?;
  constructor(config?: Partial<SafetyGovernorConfig>);
  /**
   * 治理裁决：判定一个自主动作能否执行
   * @param action 动作类型
   * @param confidence 决策置信度（用于置信度门控）
   * @returns 裁决结果
   */
  govern(action: GovernedAction, confidence?: number): GovernanceVerdict;
  /**
   * 回写动作结果（驱动熔断器与预算统计）
   * @param success 动作是否成功
   * @param tokensUsed 本次消耗 token
   * @param cost 本次成本
   */
  recordOutcome(success: boolean, tokensUsed?: number, cost?: number): void;
  /**
   * 只读门控检查：不消耗限流配额、不记审计、不改变任何状态。
   * 供宿主融合层等外部治理面使用（govern() 有副作用，会推进限流窗口）。
   * @returns 当前 kill switch / 熔断器是否放行
   */
  checkGate(): {
    allowed: boolean;
    reason?: string;
    blockedBy?: 'kill-switch' | 'circuit-breaker';
  };
  /** 启用 Kill Switch */
  engageKillSwitch(): void;
  /** 解除 Kill Switch */
  disengageKillSwitch(): void;
  /** Kill Switch 状态 */
  isKillSwitchEngaged(): boolean;
  /** 手动重置熔断器 */
  resetCircuit(): void;
  /** 熔断器状态 */
  getCircuitState(): CircuitState;
  /** 治理状态摘要 */
  getStatus(): any;
  /** 审计日志 */
  getAudit(limit?: number): GovernanceAuditEntry[];
  /** 导出可持久化状态（4.0：测试与外部备份通道） */
  exportState(): GovernorPersistState;
  /** 导入状态（4.0：重启恢复；忽略非法字段） */
  importState(state: Partial<GovernorPersistState>): void;
  /** 立即落盘（dispose 时调用） */
  flushPersist(): void;
  /** 记录审计日志 */
  private logAudit;
  /** 防抖持久化（高频 recordOutcome 不逐次落盘） */
  private schedulePersist;
  /** 原子写持久化状态（失败静默——治理不能因落盘故障停摆） */
  private writePersist;
  /** 启动时恢复持久化状态 */
  private loadPersisted;
}
//#endregion
//#region src/autonomy-loop.d.ts
/** KPI 采集器（由 index.ts 桥接真实引擎状态） */
type KpiCollector = () => KpiSnapshot;
/** 子任务派发器（由 index.ts 桥接到 sentinel.ingest，返回信号 id） */
type SubtaskDispatcher = (subtask: GoalSubtask, goal: Goal) => string;
/** 探索任务派发器（由 index.ts 桥接到 sentinel.ingest，返回信号 id） */
type ExplorationDispatcher = (proposal: ExplorationProposal) => string;
/** 记忆维护器（由 index.ts 桥接到长期记忆） */
interface MemoryMaintainer {
  distillExperience(): number;
  applyForgettingCurve(): {
    decayed: number;
    forgotten: number;
  };
  /**
   * 知识蒸馏（第二阶段）：从情景记忆蒸馏出语义+程序记忆
   * @returns 蒸馏产出的语义/程序记忆条数（{ semantic, procedural }）
   */
  distillKnowledge?(): Promise<{
    semantic: number;
    procedural: number;
  }>;
}
/** 反思教训提供器（由 index.ts 桥接到反思引擎） */
type LessonProvider = () => Lesson[];
/** 策略落地器（进化产物应用到决策引擎） */
type StrategyApplier = (config: Record<string, any>) => void;
/**
 * 调度策略进化桥接器（第三阶段：由 index.ts 桥接到 PolicyEvolver + Sandbox）
 *
 * 心跳进化段调用 runEvolutionCycle 触发「变异 → 沙盒评估 → 择优 → 热切换」；
 * 沙盒离线运行，不阻塞操作环任务调度。
 */
interface PolicyEvolutionBridge {
  runEvolutionCycle(): Promise<unknown>;
}
/**
 * 元认知环桥接器（第四阶段：由 index.ts 桥接到 SelfModel + MetaCognitiveController）
 *
 * 心跳低频段调用 runMetaCycle 触发「自我建模 → 心智报告 → 保守调整 →
 * 观察判定/回滚」——系统观察并改进自身的进化机制（双环外环）。
 */
interface MetaCognitionBridge {
  runMetaCycle(): Promise<unknown>;
}
/**
 * 共生进化桥接器（第五阶段 Phase 2.5：由 index.ts 桥接到 SymbiosisBridge）
 *
 * 心跳每拍调用 runSymbiosisTick：宿主 KPI 注入共生运行时（能量经济 +
 * 信念市场），市场价 vs 被动统计估计的显著背离回流为漂移洞察——
 * 模型漂移的第一现场由市场先行报警，进入目标引擎的自愈链路。
 */
interface SymbiosisBridgeHook {
  runSymbiosisTick(snapshot: KpiSnapshot): Promise<Insight[]>;
}
/** 自主心跳配置 */
interface AutonomyLoopConfig {
  /** 心跳间隔（毫秒） */
  heartbeatMs: number;
  /** 单轮最多派发的子任务数（防止一次性灌入过多信号） */
  maxDispatchPerTick: number;
  /** 每 N 轮心跳触发一次记忆维护 */
  maintenanceEveryTicks: number;
  /** 第四阶段：每 N 轮心跳触发一次元认知环（自我建模 + 保守调整；缺省 7） */
  metaCognitionEveryTicks: number;
  /** 每轮最多生成的目标数 */
  maxGoalsPerTick: number;
  /** 是否启用策略进化落地 */
  enableStrategyEvolution: boolean;
  /** 是否启用好奇心探索（缺省 true，需注入好奇心引擎） */
  enableExploration: boolean;
  /** 到达预测窗口（毫秒，缺省 5 分钟） */
  predictionHorizonMs: number;
}
/** 默认配置 */
declare const DEFAULT_AUTONOMY_LOOP_CONFIG: AutonomyLoopConfig;
/** 单轮心跳摘要 */
interface TickReport {
  tick: number;
  timestamp: number;
  insightsCollected: number;
  goalsCreated: number;
  subtasksDispatched: number;
  /** 本轮派发的探索任务数 */
  explorationsDispatched: number;
  /** 本轮被治理器拦截的动作数 */
  governanceBlocked: number;
  /** 世界模型预测摘要（rising 趋势类型） */
  risingTrends: string[];
  evolved: boolean;
  maintenance?: {
    distilled: number;
    decayed: number;
    forgotten: number;
    semanticDistilled?: number;
    proceduralDistilled?: number;
  };
  healthScore: number;
}
/**
 * 自主心跳循环
 *
 * 被 index.ts 持有：插件启动时 start()，fiber 卸载时 stop()。
 * 测试可绕过定时器直接调用 tick() 驱动单轮心跳。
 */
declare class AutonomyLoop {
  private config;
  private goalEngine;
  private metaCognition;
  private evolution;
  private collectKpi;
  private dispatchSubtask;
  private maintainer;
  private lessonProvider;
  private strategyApplier?;
  /** 第三阶段：调度策略进化桥接（可选注入） */
  private policyEvolution?;
  /** 第四阶段：元认知环桥接（可选注入） */
  private metaCognitionBridge?;
  /** 第五阶段 Phase 2.5：共生进化桥接（可选注入，缺省不启用） */
  private symbiosis?;
  private worldModel?;
  private curiosity?;
  private governor?;
  private dispatchExploration?;
  private timer;
  /** 重入保护：上一轮 tick 未完成时跳过新 tick */
  private ticking;
  private running;
  private tickCount;
  private reports;
  /** 已消化过的教训 id（避免重复生成目标） */
  private consumedLessons;
  constructor(params: {
    config?: Partial<AutonomyLoopConfig>;
    goalEngine: GoalEngine;
    metaCognition: MetaCognitionEngine;
    evolution: StrategyEvolutionEngine;
    collectKpi: KpiCollector;
    dispatchSubtask: SubtaskDispatcher;
    maintainer: MemoryMaintainer;
    lessonProvider: LessonProvider;
    strategyApplier?: StrategyApplier;
    /** 第三阶段：调度策略进化桥接（可选，缺省不启用） */
    policyEvolution?: PolicyEvolutionBridge;
    /** 第四阶段：元认知环桥接（可选，缺省不启用） */
    metaCognitionBridge?: MetaCognitionBridge;
    /** 第五阶段 Phase 2.5：共生进化桥接（可选，缺省不启用） */
    symbiosis?: SymbiosisBridgeHook;
    worldModel?: WorldModel;
    curiosity?: CuriosityEngine;
    governor?: SafetyGovernor;
    dispatchExploration?: ExplorationDispatcher;
  });
  /** 启动心跳定时器 */
  start(): void;
  /** 停止心跳 */
  stop(): void;
  /** 是否运行中 */
  isRunning(): boolean;
  /**
   * 执行一轮心跳（自主智能的核心节拍）
   *
   * 重入保护：心跳是异步长链路（目标分解 / 沙盒进化 / 元认知环都可能
   * 慢于 heartbeatMs），interval 触发的新 tick 与滞留中的旧 tick 并发
   * 会双重派发目标与探索、双重触发维护与进化——上一轮未完成时本轮
   * 直接跳过（返回空摘要，不推进计数）
   * @returns 本轮摘要
   */
  tick(): Promise<TickReport>;
  private runTick;
  /** 心跳历史 */
  getReports(): TickReport[];
  /** 最近一轮摘要 */
  getLatestReport(): TickReport | undefined;
  /**
   * 自省报告（自主智能的全景自我认知）
   * 汇总心跳状态、健康度、目标进度、探索收获、治理状态、世界模型预测
   */
  introspect(): any;
  /** 运行状态 */
  getStatus(): any;
}
//#endregion
//#region src/host-fusion.d.ts
/** 宿主工具执行对象（ToolExecution 的结构化子集） */
interface HostToolExecution {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
/** 宿主工具执行结果（ToolExecutionResult 的结构化子集） */
interface HostToolResult {
  readonly isError: boolean;
  readonly error?: {
    message: string;
  };
}
/** pre-execute waterfall 决策 */
type PreToolDecision = {
  kind: 'allow';
} | {
  kind: 'deny';
  reason: string;
} | {
  kind: 'ask';
  reason?: string;
};
/**
 * 声明本插件所依赖的宿主 ToolRegistry 管线事件（结构化签名）。
 * 宿主加载 @deepseek-ai/dsh-tools 时，其官方声明与本声明合并为重载，二者兼容；
 * 宿主未加载时，本声明保证类型层面可订阅（运行时无事件到达，静默无操作）。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 宿主工具最终结果（emit 模式，监听者失败被隔离） */
    'tools/result'(exec: HostToolExecution, result: HostToolResult): undefined;
    /** 宿主工具派发前决策（waterfall 模式：allow / deny / ask） */
    'tools/pre-execute'(exec: HostToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
  }
}
/** 宿主融合层配置 */
interface HostFusionConfig {
  /** 是否启用宿主融合（缺省 true；宿主无 ctx.tools 时自动静默降级） */
  enabled: boolean;
  /** 是否观测宿主工具结果（世界模型 + 失败信号注入） */
  observeToolResults: boolean;
  /** 是否治理宿主工具调用（kill switch / 熔断器门控） */
  governToolCalls: boolean;
  /** 同工具连续失败达到该次数后注入高紧急度信号并提取教训 */
  failureEscalationThreshold: number;
}
/** 融合层依赖（由 index.ts apply 注入） */
interface HostFusionDeps {
  ctx: Context;
  sentinel: Sentinel;
  worldModel: WorldModel;
  governor: SafetyGovernor;
  /** 进度广播（可为 null：enableProgress=false 时） */
  broadcast: (event: Record<string, unknown>) => void;
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  /** 调度器自身桥接进宿主注册表的 Tool 名集合（自排除，避免反馈环路） */
  selfToolNames: Set<string>;
  /** 教训提取回调（复用反思引擎的规则化路径） */
  onLessonExtracted?: (toolName: string, consecutiveFailures: number, lastError: string) => void;
}
/**
 * 宿主融合层
 *
 * 由 index.ts 在全部引擎构造完成后 activate()；fiber 卸载时 dispose()。
 * 宿主未提供 ctx.tools 服务时，activate() 静默返回 false（降级为纯内部模式）。
 */
declare class HostFusionLayer {
  private config;
  private deps;
  private active;
  /** 每工具连续失败计数 */
  private consecutiveFailures;
  /** 每工具最近一次失败信息 */
  private lastFailureError;
  /** 统计 */
  private stats;
  constructor(config: Partial<HostFusionConfig> | undefined, deps: HostFusionDeps);
  /**
   * 激活融合层：订阅宿主管线事件
   * @returns 是否成功激活（宿主无 ctx.tools 时返回 false）
   */
  activate(): boolean;
  /** 是否已激活 */
  isActive(): boolean;
  /** 融合层统计 */
  getStats(): {
    observed: number;
    failures: number;
    governed: number;
    denied: number;
    active: boolean;
  };
  /**
   * 观测宿主工具执行结果
   * - 成功：世界模型学习到达节律 + 重置该工具失败计数
   * - 失败：注入信号 + 连续失败升级
   */
  private onToolResult;
  /**
   * 治理宿主工具调用（pre-execute waterfall）
   * - Kill Switch → deny（紧急冻结全宿主）
   * - 熔断器开启 → deny（fail-closed）
   * - 其余 → next() 放行
   */
  private onPreExecute;
  /** 卸载：清理状态（事件监听由 cordis fiber 自动回收） */
  dispose(): void;
}
//#endregion
//#region src/tenant/tenant-manager.d.ts
/** 租户静态配置 */
interface TenantConfig {
  id: string;
  name: string;
  /** 租户工作目录（用于路径匹配与记忆库默认存放位置） */
  workDir: string;
  models?: Array<{
    id: string;
    name?: string;
    endpoint: string;
    apiKey: string;
    timeout?: number;
    maxConcurrency?: number;
    costPerKToken?: number;
    contextWindow?: number;
    initialCapabilities?: Record<string, any>;
  }>;
  strategistModel?: {
    id: string;
    endpoint: string;
    apiKey: string;
  };
  sentinel?: {
    watchCodeChanges?: boolean;
    watchErrors?: boolean;
    watchPerformance?: boolean;
    aggregationWindow?: number;
    signalSources?: Array<{
      type: 'webhook' | 'polling' | 'filesystem';
      port?: number;
      interval?: number;
      path?: string;
      signalType: string;
    }>;
  };
  qualityThreshold?: number;
  maxRetries?: number;
  globalTimeout?: number;
  memoryPath?: string;
  enabled?: boolean;
  tags?: string[];
  createdAt: number;
  lastActiveAt: number;
}
/** 租户运行时（配置 + 记忆 + 实时状态） */
interface TenantRuntime {
  config: TenantConfig;
  memory: LongTermMemory;
  activeExecutions: number;
  pendingSignals: Signal[];
  isExecuting: boolean;
  modelProfiles: Map<string, ModelLongTermProfile>;
  aggregationTimer: ReturnType<typeof setTimeout> | null;
  stats: {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalSignals: number;
    totalTokensUsed: number;
  };
}
/** 租户注册表（持久化结构） */
interface TenantRegistry {
  version: number;
  tenants: TenantConfig[];
  globalDefaults: {
    qualityThreshold: number;
    maxRetries: number;
    globalTimeout: number;
    aggregationWindow: number;
  };
}
/**
 * 多租户管理器
 *
 * 被 index.ts 集成层持有，manage_tenants Tool 的全部 action 映射到本类方法。
 */
declare class TenantManager {
  private dataDir;
  private registryPath;
  private registry;
  private runtimes;
  private cryptoEngine?;
  /**
   * @param dataDir 租户数据根目录（注册表与各租户记忆库的存放处）
   * @param cryptoEngine 可选加密引擎，透传给各租户的记忆库
   */
  constructor(dataDir: string, cryptoEngine?: CryptoEngine);
  /**
   * 注册新租户并创建运行时
   * @param config 租户配置（createdAt / lastActiveAt 自动填充）
   * @throws ConfigError id 重复或必填字段缺失
   */
  registerTenant(config: Omit<TenantConfig, 'createdAt' | 'lastActiveAt'>): TenantRuntime;
  /**
   * 移除租户
   * @param tenantId 租户 id
   * @param deleteData 是否级联删除租户记忆数据，默认 false
   */
  removeTenant(tenantId: string, deleteData?: boolean): void;
  /**
   * 更新租户配置（增量合并）
   * @param tenantId 租户 id
   * @param updates 需要更新的字段
   */
  updateTenant(tenantId: string, updates: Partial<TenantConfig>): void;
  /** 获取单个租户运行时 */
  getTenant(tenantId: string): TenantRuntime | undefined;
  /** 获取全部租户运行时 */
  getAllTenants(): TenantRuntime[];
  /** 按标签检索租户 */
  getTenantsByTag(tag: string): TenantRuntime[];
  /**
   * 按文件路径匹配租户（路径规范化后做前缀比较）
   * @param filePath 文件或目录绝对路径
   * @returns workDir 最深匹配的租户运行时，无匹配返回 undefined
   */
  matchTenantByPath(filePath: string): TenantRuntime | undefined;
  /**
   * 信号路由：将信号分发到最合适的租户
   *
   * 评分规则（加权）：
   * - payload 中的路径字段命中租户 workDir：+2 × 路径深度
   * - 信号类型命中租户 sentinel.signalSources：+3
   * - 信号类型命中租户 tags：+1
   * 得分最高者胜出，全部为 0 分时返回 undefined（由默认实例接管）。
   *
   * @param signal 外部信号 { type, payload }
   */
  routeSignal(signal: {
    type: string;
    payload: Record<string, any>;
  }): TenantRuntime | undefined;
  /** 刷新租户活跃时间 */
  touchTenant(tenantId: string): void;
  /**
   * 全局统计（跨租户汇总，供 manage_tenants stats 使用）
   */
  getGlobalStats(): Record<string, any>;
  /** 释放全部运行时（进程退出前调用） */
  dispose(): void;
  /** 加载注册表（不存在时初始化） */
  private loadRegistry;
  /** 持久化注册表（原子写入） */
  private persistRegistry;
  /** 解析租户记忆库路径 */
  private resolveMemoryPath;
  /** 构建租户运行时 */
  private buildRuntime;
}
//#endregion
//#region src/benchmark/benchmark-engine.d.ts
/** 单次迭代结果 */
interface BenchmarkResult {
  success: boolean;
  latency: number;
  error?: string;
  memoryUsed?: number;
  tokensUsed?: number;
}
/** 基准场景定义 */
interface BenchmarkScenario {
  name: string;
  description: string;
  target: 'sentinel' | 'strategist' | 'executor' | 'memory' | 'sync' | 'consensus' | 'encryption' | 'full-pipeline';
  concurrency: number;
  totalRequests: number;
  warmupRequests: number;
  timeout: number;
  execute: (iteration: number) => Promise<BenchmarkResult>;
  /** 场景资源回收钩子（全部迭代结束后调用一次；如关闭哨兵/Raft 服务） */
  teardown?: () => void | Promise<void>;
}
/** 聚合统计 */
interface BenchmarkStats {
  totalRequests: number;
  successCount: number;
  failCount: number;
  successRate: number;
  minLatency: number;
  maxLatency: number;
  avgLatency: number;
  p50Latency: number;
  p90Latency: number;
  p95Latency: number;
  p99Latency: number;
  stdDev: number;
  /** 每秒完成请求数 */
  throughput: number;
  totalDuration: number;
  peakMemoryMB: number;
  errorDistribution: Record<string, number>;
}
/** 性能阈值 */
interface PerformanceThreshold {
  maxP95Latency: number;
  minThroughput: number;
  minSuccessRate: number;
  maxP99Latency: number;
}
/** 基准报告 */
interface BenchmarkReport {
  id: string;
  timestamp: number;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpuCount: number;
    totalMemoryMB: number;
    pluginVersion: string;
  };
  scenarios: Array<{
    name: string;
    description: string;
    target: string;
    concurrency: number;
    stats: BenchmarkStats;
    passed: boolean;
    thresholdViolations: string[];
    latencyDistribution: Array<{
      bucket: string;
      count: number;
    }>;
  }>;
  overallPassed: boolean;
  totalDuration: number;
}
/** 内置场景上下文 */
interface BuiltinScenarioContext {
  memory: LongTermMemory;
  cryptoEngine: CryptoEngine;
  callLLM: Function;
  models: Array<{
    id: string;
    endpoint: string;
    apiKey: string;
  }>;
}
/**
 * 性能基准测试引擎
 *
 * 被 index.ts 的 run_benchmark Tool 调用
 * （run-all / list-scenarios / list-reports / compare / generate-report）。
 */
declare class BenchmarkEngine {
  private reportDir;
  private scenarios;
  private thresholds;
  /**
   * @param reportDir 报告持久化目录（如 .scheduler/benchmarks）
   */
  constructor(reportDir: string);
  /**
   * 注册自定义场景（同名覆盖）
   */
  registerScenario(scenario: BenchmarkScenario): void;
  /**
   * 覆盖指定 target 的性能阈值
   */
  setThreshold(target: BenchmarkScenario['target'], threshold: Partial<PerformanceThreshold>): void;
  /** 获取已注册场景名列表 */
  listScenarios(): Array<{
    name: string;
    target: string;
    concurrency: number;
    totalRequests: number;
  }>;
  /**
   * 注册内置场景
   *
   * - memory / encryption / sentinel / executor / sync / consensus 场景直接压测
   *   真实模块（离线可运行；executor 压测其弹性内核：熔断/退避/错误分型）
   * - strategist / full-pipeline 场景依赖 context.callLLM，
   *   缺省时注册为"跳过型"场景（执行时立即标注 skipped 原因）
   */
  registerBuiltinScenarios(context: BuiltinScenarioContext): void;
  /**
   * 执行单个场景
   * @param scenario 场景定义
   * @param onProgress 进度回调 (done, total)
   */
  runScenario(scenario: BenchmarkScenario, onProgress?: (done: number, total: number) => void): Promise<{
    stats: BenchmarkStats;
    latencyDistribution: Array<{
      bucket: string;
      count: number;
    }>;
    passed: boolean;
    thresholdViolations: string[];
  }>;
  /**
   * 执行全部已注册场景并生成报告（自动持久化）
   * @param onProgress 进度回调 (scenarioName, done, total)
   */
  runAll(onProgress?: (scenarioName: string, done: number, total: number) => void): Promise<BenchmarkReport>;
  /** 加载全部历史报告（按时间倒序） */
  loadReports(): BenchmarkReport[];
  /**
   * 对比两份报告，输出逐场景变化（用于性能回归检测）
   * @param beforeId 基线报告 id
   * @param afterId 新报告 id
   */
  compareReports(beforeId: string, afterId: string): string;
  /**
   * 生成 Markdown 格式报告
   */
  generateMarkdownReport(report: BenchmarkReport): string;
  /** 计算聚合统计 */
  private computeStats;
  /** 构建延迟分布直方图 */
  private buildDistribution;
  /** 阈值门禁检查 */
  private checkThresholds;
  /** 持久化报告 */
  private saveReport;
}
//#endregion
//#region src/sync/distributed-sync.d.ts
/**
 * 变更载荷联合类型（按 ChangeEntry.type 判别）：
 * - pattern-created / pattern-updated：完整模式，或反思器产出的轻量变更描述
 * - model-profile-updated：模型画像
 * - feedback-created：决策反馈
 * - stats-updated：全局统计增量
 * - pattern-deleted：无载荷（null）
 */
type ChangePayload = TaskPatternMemory | ModelLongTermProfile | DecisionFeedback | MemoryStore['globalStats'] | {
  taskType: string;
  complexity: number;
  outcome: 'success' | 'failure';
} | null;
/** 同步节点配置 */
interface SyncNodeConfig {
  nodeId: string;
  name: string;
  protocol: 'http-poll' | 'websocket' | 'file-share';
  remoteUrl?: string;
  wsUrl?: string;
  sharePath?: string;
  pollInterval?: number;
  authToken?: string;
  bidirectional?: boolean;
  enabled?: boolean;
}
/** 单条变更条目 */
interface ChangeEntry {
  id: string;
  type: 'pattern-created' | 'pattern-updated' | 'pattern-deleted' | 'model-profile-updated' | 'feedback-created' | 'stats-updated';
  fingerprint: string;
  timestamp: number;
  sourceNodeId: string;
  payload: ChangePayload;
  logicalClock: number;
  dataHash: string;
}
/** 同步批次 */
interface SyncBatch {
  batchId: string;
  sourceNodeId: string;
  changes: ChangeEntry[];
  timestamp: number;
  logicalClock: number;
  batchHash: string;
}
/** 同步冲突记录 */
interface SyncConflict {
  changeId: string;
  fingerprint: string;
  localData: TaskPatternMemory;
  remoteData: ChangePayload;
  localClock: number;
  remoteClock: number;
  resolution: 'local-wins' | 'remote-wins' | 'merged' | 'pending';
  resolvedAt?: number;
  resolutionReason?: string;
}
/** 单次同步日志 */
interface SyncLogEntry {
  timestamp: number;
  direction: 'push' | 'pull';
  remoteNodeId: string;
  changesSent: number;
  changesReceived: number;
  conflictsDetected: number;
  conflictsResolved: number;
  errors: string[];
  duration: number;
  status: 'success' | 'partial' | 'failed';
}
/** 同步状态（持久化结构） */
interface SyncState {
  localClock: number;
  peerClocks: Record<string, number>;
  pendingChanges: ChangeEntry[];
  unresolvedConflicts: SyncConflict[];
  syncLog: SyncLogEntry[];
  lastSyncAt: Record<string, number>;
  /** 已应用变更 id（有界 FIFO；跨重启幂等去重的持久化载体） */
  appliedIds?: string[];
}
/**
 * 分布式记忆同步引擎
 *
 * 被 index.ts 的 manage_sync Tool 调用（status / sync-now / register-node）。
 */
declare class DistributedSync {
  private localNodeId;
  private memory;
  private statePath;
  private cryptoEngine?;
  private state;
  /** 已应用的变更 id（幂等去重） */
  private appliedIds;
  private nodes;
  private pollTimers;
  private persistTimer;
  private options;
  /** 各指纹最近一次本地变更时间戳（并发冲突仲裁的第二级依据） */
  private lastLocalChangeAt;
  /** 待推送队列总字节数（含每条变更近似大小缓存） */
  private pendingBytes;
  private totalPendingBytes;
  /**
   * @param localNodeId 本节点 id
   * @param memory 本节点记忆库
   * @param statePath 同步状态持久化路径
   * @param cryptoEngine 可选加密引擎（状态文件加密落盘）
   */
  constructor(localNodeId: string, memory: LongTermMemory, statePath: string, cryptoEngine?: CryptoEngine | null);
  /**
   * 记录一条本地变更（由记忆写入路径调用）
   * @param type 变更类型
   * @param fingerprint 变更对象指纹（pattern 指纹 / 模型 id / 反馈 id）
   * @param payload 变更载荷
   */
  recordChange(type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload): void;
  /**
   * 获取待推送给指定 peer 的增量变更（clock > peer 已知进度）
   * @param forPeerId 目标 peer，缺省返回全部待推送变更
   */
  getPendingChanges(forPeerId?: string): ChangeEntry[];
  /**
   * 确认 peer 已消费到指定时钟位点（可裁剪已确认变更）
   */
  acknowledgePeer(peerId: string, clock: number): void;
  /**
   * 接收并应用远端批次
   *
   * 流程：批次哈希校验 → 逐条幂等应用 → 冲突检测与仲裁 → 时钟推进
   */
  receiveBatch(batch: SyncBatch): Promise<{
    applied: number;
    conflicts: SyncConflict[];
    errors: string[];
  }>;
  /**
   * 为指定 peer 创建增量批次（无新变更时返回 null）
   */
  createBatch(forPeerId: string): SyncBatch | null;
  /**
   * 注册同步节点（enabled 的 http-poll 节点自动启动定时拉取）
   */
  registerNode(config: SyncNodeConfig): void;
  /**
   * 创建 HTTP 同步端点处理器（供集成层挂载到 HTTP 服务）
   *
   * - handlePush: POST 接收远端批次
   * - handlePull: GET 返回本地增量批次（?peerId=xxx&since=clock）
   * - handleStatus: GET 返回同步状态摘要
   */
  createSyncHandlers(): {
    handlePush: (body: unknown) => Promise<Record<string, unknown>>;
    handlePull: (query: {
      peerId?: string;
    }) => {
      ok: boolean;
      batch: SyncBatch | null;
    };
    handleAck: (body: {
      peerId?: string;
      clock?: number;
    }) => Record<string, unknown>;
    handleStatus: () => Record<string, unknown>;
  };
  /**
   * 立即与指定 peer 同步一次（push 本地增量 + 可选 pull 远端增量）
   * @param peerId 已注册节点 id
   */
  syncNow(peerId: string): Promise<SyncLogEntry>;
  /**
   * 停止全部轮询定时器与持久化定时器
   */
  stop(): void;
  /**
   * 获取同步状态摘要（供 manage_sync status 使用）
   */
  /** 同步状态摘要（运维可观测） */
  getStatus(): {
    localNodeId: string;
    localClock: number;
    registeredNodes: Array<{
      nodeId: string;
      name: string;
      protocol: SyncNodeConfig['protocol'];
      enabled: boolean;
    }>;
    peerClocks: Record<string, number>;
    pendingChanges: number;
    unresolvedConflicts: number;
    recentSyncs: SyncLogEntry[];
    lastSyncAt: Record<string, number>;
  };
  /**
   * 应用单条变更到本地记忆库
   * @returns 检测到冲突时返回冲突记录（已自动仲裁）
   */
  private applyChange;
  /**
   * 三级仲裁：clock 高者胜 → timestamp 新者胜 → nodeId 字典序大者胜。
   * 第二级原实现用 Date.now() 近似本地变更时间——墙钟在「应用远端批次」
   * 的当下必然新于远端时间戳，等价于「时钟同段时远端恒胜」，仲裁退化为
   * 单级；现改用指纹级真实本地变更时间（recordChange 时记录）。
   * 第三级 nodeId 决胜保证双方独立仲裁结果一致（无分歧收敛）
   */
  private arbitrate;
  /** http-poll 协议同步：先 push 本地增量，再 pull 远端增量 */
  private syncViaHttp;
  /** file-share 协议同步：通过共享目录交换批次文件 */
  private syncViaFileShare;
  /** 启动 http-poll 定时拉取 */
  private startPolling;
  /** 简易 HTTP 请求（走环境代理，JSON 载荷） */
  private httpRequest;
  /** 计算批次哈希（变更 id + dataHash 链式哈希） */
  private computeBatchHash;
  /** 校验批次哈希 */
  private verifyBatchHash;
  /** 载荷哈希 */
  private hashPayload;
  /** 变更条目近似字节数（载荷序列化长度 + 条目固定开销） */
  private approxSizeOf;
  /** 已应用集合 FIFO 淘汰 */
  private trimAppliedIds;
  /** 追加同步日志（限长） */
  private appendSyncLog;
  /** 加载同步状态 */
  private loadState;
  /** 防抖持久化调度 */
  private schedulePersist;
  /** 执行状态持久化 */
  private persistState;
}
//#endregion
//#region src/consensus/raft-engine.d.ts
/** 节点角色 */
type NodeRole = 'leader' | 'follower' | 'candidate';
/** 共识日志条目（决策命令） */
interface ConsensusLogEntry {
  index: number;
  term: number;
  command: {
    type: 'execute-plan' | 'reject-signal' | 'defer-signal' | 'reassign-model' | 'escalate-to-user';
    signalId: string;
    signalDescription: string;
    decision: Decision | null;
    proposedBy: string;
  };
  timestamp: number;
}
/** 集群状态摘要（运维可观测） */
interface ClusterStatus {
  localNodeId: string;
  role: NodeRole;
  term: number;
  leaderId: string | null;
  commitIndex: number;
  lastLogIndex: number;
  logLength: number;
  peers: Array<{
    nodeId: string;
    address: string;
    matchIndex: number;
    nextIndex: number;
  }>;
  pendingProposals: number;
}
/** 集群节点配置 */
interface ClusterNodeConfig {
  nodeId: string;
  address: string;
  port: number;
  /** 选举优先级（越大越倾向成为 leader），默认 1 */
  priority?: number;
}
/** Raft 引擎配置 */
interface RaftConfig {
  localNodeId: string;
  cluster: ClusterNodeConfig[];
  /** 选举超时下限（毫秒） */
  electionTimeoutMin: number;
  /** 选举超时上限（毫秒） */
  electionTimeoutMax: number;
  /** leader 心跳间隔（毫秒） */
  heartbeatInterval: number;
  /** 共识 RPC 监听端口 */
  consensusPort: number;
  /** 持久化状态路径 */
  logPath: string;
}
/** 提案结果 */
interface ProposeResult {
  committed: boolean;
  decision: Decision | null;
}
/**
 * 分布式共识引擎（Raft）
 *
 * 被 index.ts 的 manage_consensus Tool 调用（status / propose）。
 * 集群模式下，战略决策需经多数派提交后方可执行。
 */
declare class RaftEngine {
  private config;
  private role;
  private currentTerm;
  private votedFor;
  private log;
  private commitIndex;
  private lastApplied;
  private leaderId;
  /** leader 专用：各 peer 已知复制的最高日志索引 */
  private matchIndex;
  /** leader 专用：下一条要发送的日志索引 */
  private nextIndex;
  private electionTimer;
  private heartbeatTimer;
  private server;
  private commitCallbacks;
  private roleChangeCallbacks;
  /** 提案等待队列：logIndex → { term, resolver }（term 防跨任期错配兑现） */
  private pendingProposals;
  private running;
  constructor(config: RaftConfig);
  /**
   * 启动引擎：监听共识端口 + 启动选举定时器
   */
  start(): void;
  /**
   * 停止引擎：关闭服务与全部定时器
   */
  stop(): void;
  /**
   * 提交决策提案
   *
   * - leader：追加本地日志并复制，多数派确认后 resolve
   * - 非 leader：转发给当前 leader；无 leader 时提案失败
   * - 单节点：立即提交
   *
   * @param command 决策命令
   * @param timeoutMs 等待提交的超时（默认 10s）
   */
  propose(command: ConsensusLogEntry['command'], timeoutMs?: number): Promise<ProposeResult>;
  /** 当前 leader id（未知返回 null） */
  getLeaderId(): string | null;
  /** 当前角色 */
  getRole(): NodeRole;
  /** 当前任期 */
  getTerm(): number;
  /**
   * 集群状态摘要（供 manage_consensus status 使用）
   */
  getClusterStatus(): ClusterStatus;
  /** 注册已提交条目回调（状态机应用） */
  onCommit(callback: (entry: ConsensusLogEntry) => void): void;
  /** 注册角色变更回调 */
  onRoleChange(callback: (role: NodeRole, term: number) => void): void;
  /** 重置选举定时器（随机化超时，priority 越高超时越短） */
  private resetElectionTimer;
  /** 发起选举 */
  private startElection;
  /** 成为 leader：初始化 nextIndex/matchIndex 并启动心跳 */
  private becomeLeader;
  /** 降级为 follower */
  private stepDown;
  /** leader 广播心跳 / 日志复制 */
  private broadcastHeartbeat;
  /** 向单个 peer 复制日志 */
  private replicateTo;
  /** leader 推进 commitIndex（多数派 + 仅提交当前任期日志） */
  private advanceCommitIndex;
  /** 应用已提交但未应用的日志条目 */
  private applyCommitted;
  /** 处理 RequestVote */
  private handleRequestVote;
  /** 处理 AppendEntries */
  private handleAppendEntries;
  /** 启动共识 RPC 服务 */
  private startRpcServer;
  /** 发送 RPC 到 peer（泛型响应类型，JSON 边界处一次性断言） */
  private sendRpc;
  /** 非 leader 转发提案 */
  private forwardPropose;
  /** 除自己外的 peer 列表 */
  private peers;
  /** 自身节点配置 */
  private selfConfig;
  /** 多数派数量 */
  private majority;
  /** 最后一条日志索引 */
  private lastLogIndex;
  /**
   * 按索引二分查找日志条目（日志保持 index 升序不变量）。
   * 原实现 Array.find 线性扫描——advanceCommitIndex 每轮对每个 n 都
   * 全表扫，日志增长到数千条后复制心跳的 CPU 开销平方级膨胀
   */
  private findByIndex;
  /**
   * 有序插入：索引已存在返回 false；否则按升序插入到正确位次
   * （纯追加路径 index > 尾元素 → O(1) 尾推）
   */
  private insertOrdered;
  /** 最后一条日志任期 */
  private lastLogTerm;
  /** 触发角色变更回调 */
  private emitRoleChange;
  /** 加载持久化状态 */
  private loadPersistentState;
  /** 持久化状态（原子写入） */
  private persistState;
}
//#endregion
//#region src/hot-reload/hot-reload-engine.d.ts
/** 插件版本记录 */
interface PluginVersion {
  version: string;
  codeHash: string;
  bundlePath: string;
  deployedAt: number;
  source: 'file-watch' | 'manual' | 'remote';
  active: boolean;
  status: 'deploying' | 'active' | 'rolling-back' | 'failed' | 'retired';
  error?: string;
}
/** 热更新配置 */
interface HotReloadConfig {
  enabled: boolean;
  watchDirs: string[];
  watchExtensions: string[];
  /** 防抖窗口（毫秒） */
  debounceMs: number;
  buildCommand: string;
  distDir: string;
  entryFile: string;
  maxVersionHistory: number;
  gracefulShutdownTimeout: number;
  versionsDir: string;
  autoRollback: boolean;
}
/** 活跃任务记录 */
interface ActiveTask {
  id: string;
  type: string;
  startedAt: number;
  version: string;
}
/** 热更新事件（12 种） */
type HotReloadEvent = {
  type: 'file-changed';
  filePath: string;
  timestamp: number;
} | {
  type: 'compilation-started';
  version: string;
  timestamp: number;
} | {
  type: 'compilation-succeeded';
  version: string;
  duration: number;
  timestamp: number;
} | {
  type: 'compilation-failed';
  version: string;
  error: string;
  timestamp: number;
} | {
  type: 'deploy-started';
  version: string;
  timestamp: number;
} | {
  type: 'deploy-succeeded';
  version: string;
  previousVersion: string | null;
  timestamp: number;
} | {
  type: 'deploy-failed';
  version: string;
  error: string;
  timestamp: number;
} | {
  type: 'rollback-started';
  fromVersion: string;
  toVersion: string;
  timestamp: number;
} | {
  type: 'rollback-succeeded';
  version: string;
  timestamp: number;
} | {
  type: 'rollback-failed';
  error: string;
  timestamp: number;
} | {
  type: 'graceful-shutdown-started';
  version: string;
  activeTasks: number;
  timestamp: number;
} | {
  type: 'graceful-shutdown-completed';
  version: string;
  timestamp: number;
};
/** 热重载状态（运维可观测） */
interface HotReloadStatus {
  enabled: boolean;
  watching: boolean;
  deploying: boolean;
  activeVersion: string | null;
  activeTaskCount: number;
  versionCount: number;
  recentVersions: Array<{
    version: string;
    status: string;
    deployedAt: number;
    source: string;
  }>;
}
/**
 * 插件热更新引擎
 *
 * 被 index.ts 的 manage_hot_reload Tool 调用
 * （status / rollback / deploy-version / stop-watching / start-watching）。
 */
declare class HotReloadEngine extends EventEmitter {
  private config;
  private watchers;
  private debounceTimer;
  private versions;
  private activeTasks;
  private versionsIndexPath;
  private deploying;
  private watching;
  constructor(config: HotReloadConfig);
  /**
   * 启动文件监听（enabled=false 时为空操作）
   */
  startWatching(): void;
  /**
   * 停止文件监听
   */
  stopWatching(): void;
  /**
   * 注册活跃任务（执行层开始子任务时调用）
   */
  registerTask(taskId: string, taskType: string): void;
  /**
   * 注销活跃任务（子任务完成/失败时调用）
   */
  unregisterTask(taskId: string): void;
  /** 当前活跃任务数 */
  getActiveTaskCount(): number;
  /**
   * 回滚到上一个 active 历史版本
   * @throws 无可回滚版本时 reject
   */
  rollback(): Promise<void>;
  /**
   * 手动部署指定版本（从版本历史中选择）
   * @param versionId 目标版本号
   */
  manualDeploy(versionId: string): Promise<void>;
  /**
   * 引擎状态摘要（供 manage_hot_reload status 使用）
   */
  getStatus(): HotReloadStatus;
  /**
   * 停止引擎：停止监听并清理
   */
  stop(): void;
  /** 防抖调度重载流程 */
  private scheduleReload;
  /** 完整重载管道：构建 → 校验 → 优雅停机 → 切换 */
  private reloadPipeline;
  /** 执行构建命令 */
  private runBuild;
  /**
   * 优雅停机：等待活跃任务结束（超时强制继续）
   */
  private gracefulShutdown;
  /** 获取当前激活版本 */
  private getActiveVersion;
  /** 版本历史上限裁剪（保留 active + 最近 N 个） */
  private trimVersionHistory;
  /** 发射事件（类型安全封装） */
  private emitEvent;
  /** 加载版本历史 */
  private loadVersions;
  /** 持久化版本历史 */
  private persistVersions;
}
//#endregion
//#region src/llm-client.d.ts
/** 聊天消息（OpenAI 兼容格式） */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}
/** 模型端点配置（cordis.patch.yml models[] 条目 + strategistModel 的公共形态） */
interface ModelConfig {
  id: string;
  name?: string;
  /** API 基地址，如 https://api.deepseek.com（自动补 /v1/chat/completions） */
  endpoint: string;
  /**
   * API Key。可选：当 DSH 宿主经 ctx 注入请求头（headerProvider）时
   * 无需在配置中携带 Key，宿主会自动把用户配置的 Key 注入请求头。
   */
  apiKey?: string;
  /** 单请求超时（毫秒） */
  timeout?: number;
  /** 该模型最大并发请求数 */
  maxConcurrency?: number;
  /** 每千 token 成本（美元），用于成本估算 */
  costPerKToken?: number;
  /** 上下文窗口大小（token） */
  contextWindow?: number;
  /** 初始能力画像 */
  initialCapabilities?: {
    taskScores?: Record<string, number>;
    [key: string]: any;
  };
}
/** LLM 客户端全局配置 */
interface LLMClientConfig {
  /** 默认单请求超时（毫秒），可被单次调用覆盖 */
  timeout: number;
  /** 默认最大重试次数（不含首次调用） */
  maxRetries: number;
  /** 重试基础延迟（毫秒），指数退避基数 */
  retryBaseDelay: number;
  /** 默认每模型并发上限 */
  defaultMaxConcurrency: number;
  /** 每模型排队队列上限，超出直接拒绝 */
  maxQueueSize: number;
  /** fetch 实现注入点（测试/自定义运行时） */
  fetchImpl?: typeof fetch;
  /**
   * DSH 宿主请求头注入器：返回的头部会合并进每次模型调用
   * （如 Authorization），使插件无需在配置中持有 API Key。
   * keyAttempt 用于多密钥故障转移：认证/配额失败时递增，
   * 注入器可据此轮换到下一个候选密钥。
   */
  headerProvider?: (modelId: string, keyAttempt?: number) => Record<string, string> | undefined;
  /** 密钥结果回调：每次调用结束后上报成功/失败（含 HTTP 状态码），用于健康感知路由 */
  onKeyOutcome?: (modelId: string, keyAttempt: number, success: boolean, status?: number) => void;
  /**
   * DSH 宿主 LLM 客户端调用器：存在时所有模型调用委托给宿主客户端
   * （经 ctx 获取的已配置客户端），本客户端仅保留并发控制/统计/重试外壳。
   */
  externalChat?: (modelId: string, messages: ChatMessage[], options: ChatOptions) => Promise<LLMResponse>;
}
/** 单次调用选项 */
interface ChatOptions {
  /** 覆盖超时（毫秒） */
  timeout?: number;
  /** 覆盖重试次数 */
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  /** 额外请求体字段（top_p 等） */
  extraBody?: Record<string, any>;
  /** 外部中止信号（与内部超时信号合并） */
  signal?: AbortSignal;
}
/** 调用结果 */
interface LLMResponse {
  /** 模型输出文本 */
  content: string;
  /** 实际响应模型 id */
  model: string;
  /** 本次调用总耗时（毫秒，含重试） */
  latency: number;
  /** token 消耗（prompt + completion，端点未返回时为估算值） */
  tokensUsed: number;
  /** 成本估算（美元） */
  cost: number;
  /** 实际发生的重试次数 */
  retries: number;
}
/** 单模型运行时状态（供 model_dashboard Tool 消费） */
interface ModelRuntimeStatus {
  id: string;
  name: string;
  endpoint: string;
  activeRequests: number;
  queuedRequests: number;
  maxConcurrency: number;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatency: number;
  totalTokensUsed: number;
  totalCost: number;
  taskScores: Record<string, number>;
}
/** 模型调用错误（携带 HTTP 状态与可重试标记） */
declare class LLMError extends AppError {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, status?: number, retryable?: boolean, details?: Record<string, unknown>);
}
/** 默认配置 */
declare const DEFAULT_LLM_CLIENT_CONFIG: LLMClientConfig;
/**
 * OpenAI 兼容 LLM 客户端
 *
 * 被 index.ts 持有：strategist 决策与 executor 子任务执行均通过本客户端调用。
 */
declare class LLMClient {
  private config;
  private models;
  private fetchImpl;
  private disposed;
  constructor(config?: Partial<LLMClientConfig>);
  /**
   * 注册一个模型端点（重复注册同 id 时覆盖配置并保留统计）
   * @param model 模型配置
   */
  registerModel(model: ModelConfig): void;
  /**
   * 获取已注册模型配置
   * @param modelId 模型 id
   */
  getModel(modelId: string): ModelConfig | undefined;
  /** 所有已注册模型 id */
  getModelIds(): string[];
  /**
   * 发起一次聊天补全调用（含并发控制、超时、重试）
   * @param modelId 已注册的模型 id
   * @param messages 聊天消息序列
   * @param options 单次调用选项
   * @returns 调用结果
   * @throws LLMError / TimeoutError / NetworkError
   */
  chat(modelId: string, messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse>;
  /**
   * 发起一次调用并将输出解析为 JSON（容错代码块包裹）
   * @param modelId 已注册的模型 id
   * @param messages 聊天消息序列
   * @param options 单次调用选项
   * @returns 解析后的 JSON 对象与调用元数据
   */
  chatJSON<T = any>(modelId: string, messages: ChatMessage[], options?: ChatOptions): Promise<{
    data: T;
    response: LLMResponse;
  }>;
  /**
   * 获取所有模型的运行时状态（model_dashboard Tool 数据源）
   */
  getModelStatuses(): ModelRuntimeStatus[];
  /**
   * 关闭客户端：拒绝所有排队中的请求
   */
  dispose(): void;
  /** 获取并发槽位（必要时排队） */
  private acquireSlot;
  /** 释放并发槽位并唤醒队首 */
  private releaseSlot;
  /** 带重试的调用主循环（含多密钥故障转移） */
  private chatWithRetry;
  /** 单次 HTTP 调用（含超时控制；keyAttempt 用于多密钥轮换） */
  private chatOnce;
}
/**
 * 宽松 JSON 解析：剥离 Markdown 代码块包裹，截取首个完整 JSON 片段
 * @param text 模型原始输出
 * @returns 解析结果，失败返回 undefined
 */
declare function parseJSONLoose<T = any>(text: string): T | undefined;
//#endregion
//#region src/model-scheduler.d.ts
/** 模型调度配置 */
interface ModelSchedulerConfig {
  /** 成本感知权重 0~1：模型选择时对单位成本的惩罚系数（0=纯质量导向） */
  costWeight?: number;
  /** 2.0：探索/利用权衡——UCB 探索开关（缺省开启；关闭后纯利用端评分） */
  explorationEnabled?: boolean;
  /** 2.0：探索加成系数（缺省 0.08；乘以 sqrt(log(1+Σn)/(1+n)) 不确定性项） */
  exploreBonus?: number;
  /** 2.0：探索生效的有效样本下限（缺省 5；样本充足的模型不再获得加成） */
  exploreSampleFloor?: number;
  /**
   * 2.0：冷启动探索预算——全部模型有效样本总和 ≥ 该值后探索关闭（缺省 30）
   *
   * 探索的使命是解决冷启动，不是永远与利用竞争：证据充足后纯利用端评分，
   * 避免大样本场景下 log(ΣN) 项给零样本模型过大加成、干扰稳健决策。
   */
  exploreBudget?: number;
  /**
   * 第五阶段 B 路线：能量反哺调度（缺省 false，零行为漂移）。
   * 启用后 updateEconomicSignals 注入的共生经济乘数作用于利用端评分：
   * 赚钱且信誉好的模型升权、持续亏损的模型降权——能量经济的生存压力
   * 直接反馈到调度行为。UCB 探索加成不受乘数影响（信息价值高于
   * 短期经济；冷启动重估机会不被经济惩罚剥夺）。
   */
  economicFeedbackEnabled?: boolean;
  /**
   * 6.0：主动推断调度（缺省 false，零行为漂移）。
   *
   * 启用后候选评分改用期望自由能 G(a) = 务实价值 − 认知价值：
   * - 务实价值 = 模型后验预测对成功偏好的期望惊奇（利用端，替代线性策略评分）
   * - 认知价值 = 该选择预期收缩多少不确定性（探索端，替代 UCB 加成——
   *   不确定性耗尽认知价值自动归零，探索预算不再需要手设常数）
   * 一个变分目标统一探索/利用，且逐选择输出「多少因为有用/多少
   * 因为想弄清」的可解释分解。未启用时评分路径逐位保持原逻辑。
   */
  freeEnergyEnabled?: boolean;
  /** 6.0：EFE 偏好强度（对成功的目标概率，缺省 0.9） */
  freeEnergyPreference?: number;
}
/** 调度决策洞察（2.0：预测置信度 + 探索标记，供反思器校准与反事实分析消费） */
interface SchedulingInsight {
  taskType: string;
  modelId: string;
  /** 所选模型的贝叶斯后验均值（调度器对成功率的预测；无画像时为中性 0.5） */
  confidence: number;
  /** 本次选择是否由探索加成胜出（冷启动模型重估机会） */
  exploration: boolean;
  /** 所选模型有效样本量（0 = 无历史证据的纯探索） */
  effectiveSamples: number;
  /** 决策依据说明 */
  rationale: string;
  /** B 路线：所选模型的共生经济乘数（能量反哺调度；未启用/无信号时为 1） */
  economicMultiplier?: number;
}
/** 任务调度上下文（规则基因组的匹配输入；可选，兼容旧调用方） */
interface SchedulerTaskContext {
  complexity?: number;
  features?: string[];
}
/**
 * 模型调度器
 *
 * 被任务执行器（task-executor.ts）持有：节点执行前调用 assignModel 分配模型，
 * 重试切换时调用 pickFallbackModel 选择次优模型。
 */
declare class ModelScheduler {
  private llm;
  private memory;
  private config;
  /** 当前生效调度策略（第三阶段：评分函数参数来源；基准 = 原固定行为） */
  private currentPolicy;
  /** B 路线：共生经济乘数（modelId → 乘数；缺省空 = 全中性） */
  private economicMultipliers;
  /** 6.0：自由能引擎（EFE 调度模式；未挂载/未启用零漂移） */
  private freeEnergy?;
  constructor(params: {
    llm: LLMClient;
    memory: LongTermMemory;
    config?: ModelSchedulerConfig;
  });
  /** 运行时配置热更新（元认知自调优落地入口） */
  updateConfig(patch: Partial<ModelSchedulerConfig>): void;
  /**
   * B 路线：注入共生经济乘数（能量反哺调度；宿主心跳桥接调用）。
   *
   * 乘数来自 SymbiosisBridge.economicSignals()（余额 × Wilson 信誉的
   * 复合健康度），仅作用于利用端评分——赚钱的模型升权、持续亏损的
   * 模型降权。注入即生效（对后续 assignModel/pickEnsemble/pickFallback
   * 全路径一致）；信号中缺失的模型回退中性乘数 1。
   * @param signals modelId → 调度乘数（典型范围 0.5~1.5）
   */
  updateEconomicSignals(signals: Record<string, number> | Map<string, number>): void;
  /**
   * 6.0：挂载自由能引擎（幂等；需同时 freeEnergyEnabled=true 才生效）。
   *
   * @param engine 主动推断内核实例（宿主单一实例共享）
   * @param outcomeNode 因果图结果节点（缺省 'task.outcome'；模型选择即
   *   do(use:model) 干预，证据由共生结算侧登记）
   */
  attachFreeEnergy(engine: FreeEnergyEngine, outcomeNode?: string): void;
  private efeOutcomeNode;
  /** 模型的当前经济乘数（无信号 = 中性 1；economicFeedbackEnabled 关闭时恒为 1） */
  economicMultiplierOf(modelId: string): number;
  /**
   * 策略热切换（第三阶段：策略进化器部署入口）
   *
   * 由 PolicyEvolver.deployPolicy → onDeploy 回调调用；
   * 替换评分函数参数集，立即对后续 assignModel 生效，无需重启。
   */
  updatePolicy(policy: Policy): void;
  /** 当前生效策略（供优化器标注策略版本） */
  getPolicy(): Policy;
  /** 解析上下文有效参数（规则基因组匹配；无规则时即基础参数） */
  private effectiveParams;
  /** 单模型评分（2.0：贝叶斯证据装配——Wilson 下界 + 有效样本量 + 质量 EMA） */
  private scoreModel;
  /**
   * 全候选评分（2.0：利用端策略评分 + UCB 探索加成）
   *
   * 探索/利用权衡（解决裸计数调度的两个死局）：
   * - 冷启动死局：新模型 0 样本得中性分 0.5，永远竞争不过平庸但样本多的模型
   * - 埋没死局：模型早期失败后，即使能力已修复也永无翻身机会
   *
   * UCB 加成 = exploreBonus × sqrt(log(1+ΣN) / (1+n_i))：
   * 样本越少加成越大（信息价值高）；仅冷启动期（ΣN < exploreBudget）
   * 生效，且有效样本 ≥ exploreSampleFloor 的模型不加成（纯利用）。
   */
  private scoreCandidates;
  /** 所选模型的决策洞察（预测置信度 + 探索标记 + 依据说明） */
  private insightOf;
  /** 所选模型的贝叶斯置信度（重试切换后由执行器刷新洞察用） */
  modelInsight(taskType: string, modelId: string): SchedulingInsight;
  /**
   * 为任务类型分配最优模型（能力画像 × 贝叶斯记忆画像 × 成本感知 × 探索/利用权衡）
   *
   * 第三阶段：评分核心改用策略参数化的 scoreModelWithPolicy
   * （与安全沙盒共享同一实现，参数 = 基准策略时与原固定公式一致）。
   * 质级升级：传入 context 时按规则基因组解析上下文有效参数。
   * 2.0：记忆证据从裸成功率升级为 Wilson 下界 + 有效样本量 + UCB 探索。
   *
   * @param taskType 任务类型
   * @param preferred 优化器推荐的模型（优先）
   * @param context 任务上下文（复杂度/特征；供规则基因匹配）
   */
  assignModel(taskType: string, preferred?: string, context?: SchedulerTaskContext, options?: {
    avoidModels?: string[];
  }): string;
  /**
   * 带洞察的模型分配（2.0：返回预测置信度与探索标记，供反思器校准闭环）
   *
   * 与 assignModel 共享同一评分与选择逻辑；编排层用本方法收集决策洞察，
   * 在复盘时回注反思器计算 Brier 校准误差与反事实遗憾。
   * 4.0：avoidModels 负向约束——经验规避模型（历史超时/能力不足）从候选剔除，
   * 推荐模型被规避时同样降级为动态评分选型（勘察修复：升级前 avoidModels
   * 产出后无人消费，负向经验在调度端断链）。
   */
  assignModelWithInsight(taskType: string, preferred?: string, context?: SchedulerTaskContext, options?: {
    avoidModels?: string[];
  }): SchedulingInsight;
  /**
   * 多模型集成候选（第三阶段：模型组合逻辑的策略落地）
   *
   * 按当前策略评分降序返回前 N 个模型（供执行侧并行执行 + 融合决策）。
   * 质级升级：传入 context 时按规则基因组解析上下文有效参数
   * （如规则强制 ensembleForce=true 的任务类型稳定给出组合候选）。
   * @param taskType 任务类型
   * @param count 集成模型数（缺省取策略 ensembleMaxModels）
   * @param exclude 排除的模型 id（如重试时排除当前模型）
   * @param context 任务上下文（复杂度/特征；供规则基因匹配）
   */
  pickEnsemble(taskType: string, count?: number, exclude?: string[], context?: SchedulerTaskContext): string[];
  /**
   * 选择次优模型（排除当前模型，按策略评分；context 供规则基因匹配）
   * 4.0：excludeModels 额外排除清单（经验规避模型 / 熔断中模型），向后兼容
   */
  pickFallbackModel(taskType: string, excludeModelId: string, context?: SchedulerTaskContext, excludeModels?: string[]): string | undefined;
  /**
   * 动态并行度：依据已注册模型的总并发容量计算同层最大并行数
   * （避免同层节点数超过模型并发容量导致全部排队）
   */
  computeParallelism(): number;
}
//#endregion
//#region src/task-executor.d.ts
/** 任务执行器配置 */
interface TaskExecutorConfig {
  qualityThreshold: number;
  maxRetries: number;
  /** 计划级全局超时（毫秒） */
  globalTimeout: number;
  /** 单节点默认超时（毫秒） */
  nodeTimeout: number;
  /** 是否广播进度事件 */
  enableProgress: boolean;
  verbose: boolean;
  /**
   * 4.0：模型级熔断阈值（同一模型连续可用性失败次数，达到即熔断该模型）
   * 缺省 5；设为 0 关闭熔断（与升级前行为一致）
   */
  circuitFailureThreshold?: number;
  /** 4.0：熔断冷却期（毫秒，缺省 60s），期满转半开放行单次试探 */
  circuitCooldownMs?: number;
  /**
   * 4.0：重试退避基数（毫秒，缺省 0 = 不退避，与升级前紧贴重发一致）。
   * 全抖动指数退避：min(base×2^(attempt-1), retryBackoffMaxMs) 内均匀采样
   */
  retryBackoffBaseMs?: number;
  /** 4.0：重试退避上限（毫秒，缺省 8000） */
  retryBackoffMaxMs?: number;
}
/**
 * 任务执行器
 *
 * 被 index.ts 持有：编排层完成战略决策与计划生成后，将计划交给本执行器执行。
 */
declare class TaskExecutor {
  private config;
  private llm;
  private modelScheduler;
  private broadcaster?;
  private nodeRunner;
  private cascadeHandler?;
  /** 反思引擎（可选，节点级质量反思） */
  private reflection?;
  /** 4.0：模型级熔断器注册表（circuitFailureThreshold=0 时不启用） */
  private breakers?;
  /** 2.0：最近一次计划执行的调度决策洞察（校准闭环素材，getAndClearDecisionInsights 取走） */
  private decisionInsights;
  constructor(params: {
    config: TaskExecutorConfig;
    llm: LLMClient;
    modelScheduler: ModelScheduler;
    broadcaster?: ProgressBroadcaster;
    nodeRunner?: NodeRunner;
    cascadeHandler?: CascadeHandler;
    reflection?: ReflectionEngine;
  });
  /**
   * 运行时配置热更新（元认知自调优落地入口）
   * @param patch 配置补丁（仅覆盖提供的字段）
   */
  updateConfig(patch: Partial<TaskExecutorConfig>): void;
  /**
   * 取走最近一次计划执行的调度决策洞察（2.0：校准闭环桥接）
   *
   * 编排层在 executePlan 返回后调用本方法，将洞察作为
   * reflectOnOutcome({ decisionInsights }) 回注反思器，
   * 完成「调度预测 → 实际结果 → Brier 校准」闭环。
   * 取走即清空（每份洞察只消费一次）。
   */
  getAndClearDecisionInsights(): Array<{
    nodeId: string;
    taskType: string;
    modelId: string;
    predictedConfidence: number;
    exploration: boolean;
    success: boolean;
  }>;
  /**
   * 计划生成 — 解析 strategist 输出，非法时回退离线计划
   * @param objective 任务目标
   * @param strategistOutput strategist 模型原始输出（可为空）
   * @param taskType 任务类型
   */
  buildPlan(objective: string, strategistOutput: string | undefined, taskType: string): ExecutionPlan;
  /**
   * 执行完整计划
   *
   * 深度优化：
   * - 截止时间感知：signal.deadlineMs 存在时，全局超时收紧为 min(globalTimeout, deadline - now)
   * - 动态并行度：同层节点数超过模型总并发容量时分批执行，避免并发过载排队
   * - 4.0：avoidModels 负向约束贯通——优化器产出的规避模型在调度与重试切换中全局排除
   *
   * @param signal 触发信号
   * @param plan 执行计划
   * @param recommendedModels 优化器产出的按节点类型推荐模型（模型调度优先采纳）
   * @param options 4.0 扩展选项（avoidModels：经验规避模型，调度与重试全程排除）
   * @returns 计划执行结果
   */
  executePlan(signal: Signal, plan: ExecutionPlan, recommendedModels?: Record<string, string>, options?: {
    avoidModels?: string[];
  }): Promise<PlanExecutionResult>;
  /** 模型级熔断快照（运维可观测：哪些模型被熔断、连续失败数） */
  getBreakerSnapshot(): Record<string, {
    state: string;
    consecutiveFailures: number;
  }>;
  /** 模型当前是否可执行（无熔断器或熔断器放行；peek 纯读取不占探测名额） */
  private modelExecutable;
  /** 选择健康的次优模型：排除当前模型、规避模型与熔断中的模型 */
  private pickHealthyFallback;
  /** 单节点执行（4.0：熔断感知调度 + 错误分型退避重试 + 质量反思切换、级联触发） */
  private executeNode;
  /** 带节点级超时的 nodeRunner 调用 */
  private runWithTimeout;
  /** 默认节点执行器：通过 LLMClient 调用分配模型 */
  private defaultNodeRunner;
  /** 级联触发：节点完成且质量达标时回注下游信号 */
  private triggerCascade;
  /** 拓扑分层（Kahn 算法），检测环 */
  private topologicalLayers;
  /** DAG 结构校验（节点 id 唯一、依赖存在、无环） */
  private validateDag;
  /** 归一化 strategist 输出的节点 */
  private normalizeNode;
  /** 进度事件广播（enableProgress 关闭时为空操作） */
  private broadcast;
}
//#endregion
//#region src/reflector.d.ts
/** 反思器配置 */
interface ReflectorConfig {
  /** 是否广播进度事件（lesson-extracted / experience-distilled 等） */
  enableProgress?: boolean;
  /** 教训沉淀回调（编排层日志） */
  onLesson?: (lesson: Lesson) => void;
  /** 经验蒸馏回调（编排层日志） */
  onDistilled?: (strategies: DistilledStrategy[]) => void;
  /** 第二阶段：知识蒸馏回调（语义+程序记忆产出） */
  onKnowledgeDistilled?: (report: DistillationReport) => void;
  /** 第二阶段：参与蒸馏的最低情景记忆置信度，缺省 0.6 */
  distillMinConfidence?: number;
  /** 第二阶段：参与蒸馏的最低成功方案数，缺省 3 */
  distillMinSuccesses?: number;
  /** 第二阶段：模型偏好蒸馏的最低占比阈值，缺省 0.6 */
  distillModelAffinityThreshold?: number;
  /**
   * 第二阶段升级：阈值自动蒸馏 — 距上次蒸馏新增情景事件 ≥ 该值时，
   * 在成功复盘后自动触发知识蒸馏（缺省 5；设为 0 关闭自动触发）。
   * 与自主循环的周期触发互补：高负载更快沉淀，低负载不做无效全量蒸馏。
   */
  autoDistillThreshold?: number;
  /** 校准滑动窗口容量（缺省 50；Brier 残差滚动统计范围） */
  calibrationWindowSize?: number;
  /** 反事实遗憾触发的置信差距（缺省 0.1；替代者下界须超过所用模型后验均值该幅度） */
  counterfactualMargin?: number;
  /** 反事实分析的最低有效样本量（缺省 3；证据不足不产生遗憾结论） */
  counterfactualMinSamples?: number;
}
/** 决策洞察记录（2.0：执行器收集、反思器消费的调度预测归因） */
interface DecisionInsightRecord {
  nodeId: string;
  taskType: string;
  modelId: string;
  /** 调度时预测的成功概率（贝叶斯后验均值） */
  predictedConfidence: number;
  /** 本次是否探索性选择 */
  exploration: boolean;
  /** 该节点实际执行结果 */
  success: boolean;
}
/** 调度校准状态（2.0：预测置信度 vs 实际结果的持续统计；3.0：自修正量） */
interface CalibrationStatus {
  /** Brier 分 = mean((predicted - actual)²)，0 完美 1 最差（概率预测质量金标准） */
  brierScore: number;
  /** 平均残差 = mean(predicted - actual)：>0 系统性过自信，<0 欠自信 */
  residualMean: number;
  /** 样本量（窗口内） */
  samples: number;
  /** 校准方向判定（样本 < 10 时为 insufficient） */
  direction: 'overconfident' | 'underconfident' | 'calibrated' | 'insufficient';
  /** 滑动窗口容量 */
  windowSize: number;
  /**
   * 3.0 校准自修正量：后续预测置信度的建议偏移（过自信 → 负值收缩）。
   * 样本 ≥ 20 且 |residualMean| > 0.1 时生效（= −residual × 0.5，±0.15 钳制），
   * 否则为 0——样本不足或已校准时不动预测，避免噪声驱动的过度修正。
   */
  correction: number;
}
/**
 * 反思器
 *
 * 被编排层（index.ts）持有：执行器完成计划后调用 reflectOnOutcome()，
 * 一次性完成「复盘 → 记忆更新 → 策略反馈 → 蒸馏」全链路学习。
 */
declare class Reflector implements IReflector {
  private memory;
  private reflection;
  private config;
  private broadcaster?;
  private graph?;
  /** 同步变更登记回调（由 index.ts 桥接到 distributed-sync.recordChange） */
  private onMemoryChange?;
  /** 蒸馏进行中标志（阈值自动触发的防抖，避免并发重复蒸馏） */
  private distilling;
  /** 2.0：校准滑动窗口（Brier 残差滚动统计） */
  private calibrationWindow;
  constructor(params: {
    memory: IMemoryStore;
    reflection: ReflectionEngine;
    config?: ReflectorConfig;
    broadcaster?: ProgressBroadcaster;
    graph?: MemoryGraph;
    onMemoryChange?: (type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload) => void;
  });
  /**
   * 运行时配置热更新（第四阶段：元认知控制器调参落地入口）
   *
   * 元认知层经此调整反思触发频率与蒸馏门槛（autoDistillThreshold /
   * distillMinConfidence 等），立即对后续复盘生效，无需重启。
   * 回调类字段（onLesson/onDistilled/...）仅显式传入时覆盖。
   */
  updateConfig(patch: ReflectorConfig): void;
  /** 当前配置快照（元认知旋钮 read 端；只读） */
  getConfig(): Readonly<ReflectorConfig>;
  /**
   * 执行后反思与记忆更新（闭环学习入口）
   *
   * 步骤：
   * 1. 质量趋势记录（反思引擎阈值自校准）
   * 2. 经验沉淀：成功 → 任务模式 + 模型画像；失败 → 失败记录 + 教训提取
   * 3. 策略反馈：本次应用的蒸馏策略按结果回写，校准置信度
   * 3.5 记忆反馈（第二阶段升级）：本次命中的语义/程序记忆按结果回写——
   *    有效规律越用越强，无效规律被应用成功率反向衰减，同时刷新 lastAppliedAt
   *    （否则遗忘曲线会以 distilledAt 为基准误杀从未被"应用"过的高级记忆）
   * 4. 经验蒸馏：成功时尝试提炼新策略
   * 4.6 阈值自动蒸馏（第二阶段升级）：新增情景事件达阈值时后台触发知识蒸馏
   *
   * @param signal 触发信号
   * @param plan 执行的计划
   * @param result 计划执行结果
   * @param appliedStrategies 本次注入/应用的蒸馏策略 id 列表（策略反馈闭环）
   * @param appliedMemoryIds 本次经验检索命中的语义/程序记忆 id（记忆反馈闭环）
   */
  reflectOnOutcome(params: {
    signal: Signal;
    plan: ExecutionPlan;
    result: PlanExecutionResult;
    appliedStrategies?: string[];
    /** 第二阶段升级：本次命中的语义/程序记忆 id（三层记忆应用反馈闭环） */
    appliedMemoryIds?: {
      semantic?: string[];
      procedural?: string[];
    };
    /** 2.0：本次各节点的调度决策洞察（校准闭环素材；缺省跳过校准更新） */
    decisionInsights?: DecisionInsightRecord[];
  }): void;
  /**
   * 校准更新（2.0：预测置信度 vs 实际结果的滚动统计）
   *
   * Brier 分 = mean((predicted - actual)²)——概率预测质量金标准：
   * 调度器说「90% 能成」的实际成了 → 无惩罚；说 90% 却连续失败 → 重罚。
   * 这是「系统知道自己有多准」的自知之明，过自信/欠自信方向可诊断。
   */
  private updateCalibration;
  /** 校准状态查询（2.0：调度预测质量的持续自知；3.0：附带自修正量） */
  getCalibration(): CalibrationStatus;
  /**
   * 校准自修正（3.0）：对调度预测置信度施加校准偏移
   *
   * 过自信系统（如预测 0.9 实际 0.7）→ 收缩预测使其贴近真实成功率；
   * 欠自信系统 → 适度放大。样本不足或已校准时为恒等映射（零风险旁路）。
   */
  correctConfidence(predicted: number): number;
  /**
   * 自知之明报告（3.0：系统对自己记忆与预测质量的一次性全景自检）
   *
   * 汇聚两路自知信号：
   * - calibration：调度预测校准（Brier / 残差 / 方向 / 自修正量）
   * - census：全层证据普查（各记忆层证据覆盖度 + 有效样本量 + 证据枯竭 +
   *   模型能力漂移）——记忆库未实现 evidenceCensus 时静默省略（旧实现兼容）
   */
  getSelfKnowledge(): {
    generatedAt: number;
    calibration: CalibrationStatus;
    census?: EvidenceCensus;
  };
  /**
   * 反事实遗憾分析（2.0：「当时是否有更优选择」的结构化复盘）
   *
   * 对每个节点实际使用的模型，检索全部模型画像中该任务类型的贝叶斯估计：
   * 若存在替代者满足（威尔逊下界 > 所用模型后验均值 + margin 且有效样本充足），
   * 则生成反事实教训写入决策反馈——不依赖 LLM 的可机器验证归因，
   * 让「本可以更优」的选择失误成为可检索的记忆而非事后遗忘。
   *
   * 证据门槛（margin / minSamples 可配）杜绝小样本噪声触发误报。
   */
  private analyzeCounterfactualRegret;
  /**
   * 知识蒸馏（第二阶段）：从累积的情景记忆中蒸馏出语义记忆与程序记忆
   *
   * 蒸馏来源：
   * 1. 情景记忆（TaskPatternMemory）：高置信度 + 多次成功的模式
   * 2. 反思教训（Lesson）：失败根因 → 反思规则（程序记忆 kind='reflection'）
   * 3. 既有 distillExperience：兼容产出 DistilledStrategy（不变）
   *
   * 蒸馏产物：
   * - 语义记忆（SemanticMemory）：
   *   * model-affinity：某模型在某任务类型的多条模式中占比 ≥ 阈值 → 跨任务规律
   *   * complexity-pattern：高复杂度任务的成功模型偏好
   * - 程序记忆（ProceduralMemory）：
   *   * scheduling：feature='code' 且复杂度高 → prefer-model + enable-cot
   *   * reflection：rootCause='timeout'/'model-capability' → avoid-model 规则
   *
   * 第二阶段升级：
   * - 幂等性升级：蒸馏产物使用内容寻址稳定 id（同一规律跨次蒸馏 id 不变），
   *   重复蒸馏不再丢弃证据，而是合并增强（supportCount 累加、置信度加权），
   *   冲突规律由证据竞争淘汰（详见 upsertSemanticMemory / upsertProceduralMemory）
   * - 水位门控：options.force 未设且新增情景事件 < autoDistillThreshold 且
   *   已有蒸馏知识时跳过全量蒸馏（返回 skipped 报告），避免无效计算
   * - 水位检查点：蒸馏成功后刷新水位（noteDistillationCheckpoint）
   *
   * @param options.force 强制蒸馏（Tool 按需调用 / 首次蒸馏时使用）
   * @returns 蒸馏报告（含本次产出的语义/程序记忆与兼容策略）
   */
  distillKnowledge(options?: {
    force?: boolean;
  }): Promise<DistillationReport>;
  /**
   * 内容寻址稳定 id（第二阶段升级）
   *
   * 同一规律（相同组成要素）跨次蒸馏生成相同 id，使 upsert 的证据合并
   * 能命中既有记录，而非每次插入新 id 后靠 statement 判重丢弃证据。
   */
  private stableId;
  /**
   * 蒸馏模型亲和规律（语义记忆 domain='model-affinity'）
   *
   * 按 taskType 聚合所有合格模式中的模型分配，若某模型占比 ≥ affinityThreshold
   * 且支撑模式数 ≥ 2，则产出跨任务规律："X 类任务适合模型 Y"。
   */
  private distillModelAffinity;
  /**
   * 蒸馏复杂度模式（语义记忆 domain='complexity-pattern'）
   *
   * 高复杂度（complexity ≥ 0.7）任务的成功模型偏好。
   */
  private distillComplexityPatterns;
  /**
   * 蒸馏调度规则（程序记忆 kind='scheduling'）
   *
   * 规则：feature='code' 且 complexity ≥ 0.7 的任务 → prefer-model + enable-cot
   * 支撑：该任务类型的成功方案中存在模型偏好。
   */
  private distillSchedulingRules;
  /**
   * 蒸馏反思规则（程序记忆 kind='reflection'）
   *
   * 从反思教训中提炼：rootCause='timeout' → avoid-model + escalate
   * rootCause='model-capability' → avoid-model + retry-switch
   */
  private distillReflectionRules;
  /** 从模式指纹提取 taskType（首段，去除 [失败] 前缀） */
  private extractTaskType;
  /** 构建蒸馏报告摘要 */
  private buildDistillationSummary;
  /** 经验沉淀：成功方案 / 失败记录写入记忆库并登记同步变更 */
  private settleExperience;
  /** 进度事件广播（enableProgress 关闭或 broadcaster 缺省时为空操作） */
  private broadcast;
}
//#endregion
//#region src/core/resilience.d.ts
/**
 * resilience.ts — 弹性内核（项目 4.0「可靠执行」基石）
 *
 * 勘察结论（升级前）：task-executor 重试紧贴重发（无退避）、错误不分型
 * （网络错与质量错同路径）、无模型级熔断（同一坏模型被反复重试打爆配额）。
 *
 * 本内核把「熔断 + 退避 + 错误分型」做成全链路共享的纯组件：
 * - CircuitBreaker：closed → open（连续失败 ≥ 阈值）→ half-open（冷却后单试探，
 *   并发互斥——同一时刻只放行一个探测请求）→ closed（探测成功）
 * - CircuitBreakerRegistry：按 key（如 modelId）隔离的熔断器集合（容量上限防泄漏）
 * - backoffDelayMs：指数退避 + 全抖动（防惊群），可注入随机源保证测试确定性
 * - abortableSleep：可中止睡眠（全局超时到达时立即中断退避等待）
 * - classifyError：错误分型——可退避重试（网络/超时/限流）/ 立即重试 /
 *   换模型（能力类）/ 终止（不可恢复），驱动差异化重试策略
 */
/** 熔断器状态 */
type BreakerState = 'closed' | 'open' | 'half-open';
/** 熔断器配置 */
interface CircuitBreakerConfig {
  /** 连续失败进入熔断的阈值 */
  failureThreshold: number;
  /** 熔断冷却期（毫秒），期满转 half-open */
  cooldownMs: number;
}
declare const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig;
/** 熔断器可执行性探测结果 */
interface BreakerProbe {
  allowed: boolean;
  state: BreakerState;
  /** open 状态下距下次可试探的剩余毫秒 */
  msUntilRetry: number;
}
/** 熔断器状态快照（可观测性） */
interface BreakerStatus {
  state: BreakerState;
  consecutiveFailures: number;
}
/**
 * 单 key 熔断器
 *
 * half-open 并发互斥：冷却期满后首个请求获得探测资格，其余请求仍被拒绝——
 * 避免冷却结束瞬间流量洪峰直接打到尚未恢复的下游。
 */
declare class CircuitBreaker {
  private config;
  private state;
  private consecutiveFailures;
  private openedAt;
  /** half-open 探测互斥：>0 表示已有探测在途 */
  private halfOpenInFlight;
  constructor(config?: Partial<CircuitBreakerConfig>);
  /** 探测当前是否放行（不改变状态；放行后调用方须成对调用 recordSuccess/recordFailure） */
  canExecute(now?: number): BreakerProbe;
  /**
   * 无副作用检查：纯读取当前可执行性（不获取 half-open 探测名额）
   *
   * 用于候选过滤/展示等「只看不执行」场景——canExecute 在 half-open 态
   * 会占用探测名额，纯检查场景必须用 peek，否则名额泄漏导致永久误判熔断。
   */
  peek(now?: number): BreakerProbe;
  /** 成功回报：清零失败计数，half-open 探测成功 → 恢复闭合 */
  recordSuccess(): void;
  /** 失败回报：累计连续失败，达阈值熔断；half-open 探测失败 → 重新熔断 */
  recordFailure(now?: number): void;
  /** 状态快照（可观测性） */
  getState(): BreakerStatus;
  /** 手动复位 */
  reset(): void;
  /**
   * 释放 half-open 探测资格（不改变成功/失败统计）
   *
   * 用于「请求已发出但无法判定下游可用性」的场景（如客户端 4xx）：
   * 探测互斥锁必须释放，否则后续请求永久被拒。
   */
  releaseProbe(): void;
}
/**
 * 按 key 隔离的熔断器注册表
 *
 * 典型 key = modelId（模型 A 熔断不影响模型 B）；容量上限 + 简单 LRU 淘汰，
 * 防止长尾模型 id 导致的无界增长。
 */
declare class CircuitBreakerRegistry {
  private breakers;
  private config;
  private capacity;
  constructor(config?: Partial<CircuitBreakerConfig> & {
    capacity?: number;
  });
  private get;
  canExecute(key: string, now?: number): BreakerProbe;
  /** 无副作用检查（纯读取，不占用 half-open 探测名额） */
  peek(key: string, now?: number): BreakerProbe;
  recordSuccess(key: string): void;
  recordFailure(key: string): void;
  releaseProbe(key: string): void;
  /** 全部熔断器状态（运维可观测） */
  snapshot(): Record<string, BreakerStatus>;
  /** 是否有任一 key 处于熔断（快速检查） */
  hasOpen(): boolean;
  reset(key?: string): void;
}
/** 退避配置 */
interface BackoffConfig {
  /** 首次退避基数（毫秒） */
  baseMs: number;
  /** 指数因子 */
  factor: number;
  /** 退避上限（毫秒）——防止大重试次数下延迟爆炸 */
  maxMs: number;
}
declare const DEFAULT_BACKOFF_CONFIG: BackoffConfig;
/**
 * 指数退避延迟（全抖动：[0, min(base × factor^(attempt-1), max)] 均匀采样）
 *
 * 全抖动（full jitter）相对确定性退避的优势：并发重试错峰，防惊群。
 * @param attempt 本次失败后的重试序号（1 = 第一次重试）
 * @param rng 随机源（测试可注入确定性实现）
 */
declare function backoffDelayMs(attempt: number, config?: Partial<BackoffConfig>, rng?: () => number): number;
/**
 * 可中止睡眠：全局超时/中止信号到达时立即返回 false（放弃重试）
 * @returns true = 睡满（可继续重试）；false = 被中止（放弃）
 */
declare function abortableSleep(ms: number, abortSignal?: AbortSignal): Promise<boolean>;
/** 错误重试分型 */
type RetryClass =
/** 网络抖动/限流/超时：指数退避后原路重试（下游可能恢复） */
'retryable-backoff' |
/** 已知幂等瞬时错：立即重试（如队列争用） */
'retryable-immediate' |
/** 执行到达但产出不达标：重试无益，换模型（能力问题） */
'switch-model' |
/** 不可恢复（配置错/鉴权错/未知错）：停止重试 */
'fatal';
interface ErrorClassification {
  class: RetryClass;
  /** 机器可读错误类别名 */
  kind: 'timeout' | 'network' | 'rate-limit' | 'server' | 'client' | 'quality' | 'unknown';
  /** 人类可读说明 */
  reason: string;
}
/**
 * 错误分型（差异化重试的依据）
 *
 * 分型策略：
 * - TimeoutError → retryable-backoff（下游可能过载，退避让路）
 * - NetworkError → retryable-backoff（网络抖动，退避重试）
 * - 携带可重试状态码的 LLMError → retryable-backoff（429/5xx）
 * - 携带 4xx（非 408/429）状态码 → fatal（请求本身有问题，重试无意义）
 * - 质量不达标（由调用方在 verdict 层判定，不走本函数）→ switch-model
 * - 其余未知错误 → fatal（与升级前「非超时不重试」行为一致）
 */
declare function classifyError(err: unknown): ErrorClassification;
//#endregion
//#region src/memory/alias-map.d.ts
/**
 * alias-map.ts — 防幻觉短索引映射（自主学习建议 3）
 *
 * 将冗长的记忆 ID（指纹 / 策略 id / 教训 id）在注入大模型前转换为短索引（#1, #2, #3），
 * 模型只需引用短索引，输出后再反向解析回完整 ID：
 * - 降低模型复述长 ID 产生的幻觉率
 * - 减少注入与输出的 Token 消耗
 *
 * 映射为请求级临时对象（不持久化）：每次注入前新建，注入与反解共用同一实例。
 */
declare class AliasMap {
  private encodeMap;
  private decodeMap;
  private next;
  /** 为完整 ID 分配短索引（幂等），返回形如 #1 */
  encode(id: string): string;
  /** 短索引 → 完整 ID（未知索引返回 undefined） */
  resolve(alias: string): string | undefined;
  /** 将文本中的完整 ID 替换为短索引（按 ID 长度降序，避免前缀误替换） */
  encodeText(text: string): string;
  /** 将文本中的短索引反向解析回完整 ID（未登记的索引原样保留） */
  decodeText(text: string): string;
  /** 当前映射条目（调试/日志） */
  entries(): Array<{
    alias: string;
    id: string;
  }>;
  get size(): number;
}
//#endregion
//#region src/memory/migration-tool.d.ts
/** 迁移冲突中可保留的记录版本（按冲突类型判别） */
type MigrationRecordVersion = TaskPatternMemory | ModelLongTermProfile | DecisionFeedback | SemanticMemory | ProceduralMemory;
/** 迁移包（自包含、可校验、可审计） */
interface MigrationPackage {
  version: number;
  exportedAt: number;
  source: {
    instanceId: string;
    instanceName?: string;
    pluginVersion: string;
  };
  scope: {
    includePatterns: boolean;
    includeModelProfiles: boolean;
    includeFeedback: boolean;
    includeSemanticMemories: boolean;
    includeProceduralMemories: boolean;
    includeGlobalStats: boolean;
    tenantFilter?: string[];
  };
  /** data 段 JSON 序列化后的 SHA-256（hex），导入前强制校验 */
  checksum: string;
  data: {
    taskPatterns?: TaskPatternMemory[];
    modelProfiles?: ModelLongTermProfile[];
    decisionFeedback?: DecisionFeedback[];
    /** 4.0：语义记忆（跨任务规律）——此前缺失导致迁移丢数据 */
    semanticMemories?: SemanticMemory[];
    /** 4.0：程序记忆（if-then 规则）——此前缺失导致迁移丢数据 */
    proceduralMemories?: ProceduralMemory[];
    globalStats?: MemoryStore['globalStats'];
    tenants?: TenantConfig[];
  };
}
/** 冲突合并策略 */
type MergeStrategy = 'overwrite' | 'merge' | 'skip' | 'newer-wins';
/** 迁移冲突记录（保留双方数据供审计） */
interface MigrationConflict {
  type: 'pattern' | 'model-profile' | 'feedback' | 'semantic' | 'procedural';
  key: string;
  localVersion: MigrationRecordVersion;
  remoteVersion: MigrationRecordVersion;
  resolution?: MergeStrategy;
}
/** 迁移结果报告 */
interface MigrationReport {
  success: boolean;
  strategy: MergeStrategy;
  imported: {
    patterns: number;
    modelProfiles: number;
    feedback: number;
    semantic: number;
    procedural: number;
  };
  skipped: number;
  conflicts: MigrationConflict[];
  errors: string[];
  duration: number;
}
/** 导出选项 */
interface ExportOptions {
  includePatterns?: boolean;
  includeModelProfiles?: boolean;
  includeFeedback?: boolean;
  includeSemanticMemories?: boolean;
  includeProceduralMemories?: boolean;
  includeGlobalStats?: boolean;
  tenantFilter?: string[];
  instanceName?: string;
}
/**
 * 记忆迁移工具
 *
 * 被 index.ts 的 memory_migration Tool 调用（export/import/dry-run/migrate-tenant）。
 */
declare class MigrationTool {
  private instanceId;
  /**
   * @param instanceId 当前实例标识（写入迁移包 source），缺省自动生成
   */
  constructor(instanceId?: string);
  /**
   * 从记忆库实例导出迁移包
   * @param memory 源记忆库
   * @param options 导出范围选项（缺省全量导出）
   */
  exportFromMemory(memory: LongTermMemory, options?: ExportOptions): MigrationPackage;
  /**
   * 从磁盘文件读取迁移包（含校验和验证）
   * @param filePath 迁移包文件路径
   * @throws MemoryError 文件不存在 / JSON 非法 / 校验和不匹配
   */
  exportFromFile(filePath: string): MigrationPackage;
  /**
   * 导出迁移包并写入文件
   * @param memory 源记忆库
   * @param outputPath 输出路径
   * @param options 导出范围选项
   */
  exportToFile(memory: LongTermMemory, outputPath: string, options?: ExportOptions): void;
  /**
   * 将迁移包导入目标记忆库
   * @param memory 目标记忆库
   * @param pkg 迁移包
   * @param strategy 冲突合并策略，默认 merge
   */
  importToMemory(memory: LongTermMemory, pkg: MigrationPackage, strategy?: MergeStrategy): MigrationReport;
  /**
   * 从文件读取迁移包并导入
   * @param memory 目标记忆库
   * @param filePath 迁移包文件路径
   * @param strategy 冲突合并策略，默认 merge
   */
  importFromFile(memory: LongTermMemory, filePath: string, strategy?: MergeStrategy): MigrationReport;
  /**
   * 预演导入：检测冲突与统计，不产生任何写入
   * @param memory 目标记忆库
   * @param pkg 迁移包
   */
  dryRun(memory: LongTermMemory, pkg: MigrationPackage): {
    conflicts: MigrationConflict[];
    summary: Record<string, number>;
  };
  /**
   * 跨租户迁移：源记忆库 → 目标记忆库
   * @param sourceMemory 源租户记忆库
   * @param targetMemory 目标租户记忆库
   * @param options 迁移选项（范围 + 策略）
   */
  migrateBetweenTenants(sourceMemory: LongTermMemory, targetMemory: LongTermMemory, options?: ExportOptions & {
    strategy?: MergeStrategy;
  }): MigrationReport;
  /** 构建带校验和的迁移包 */
  private buildPackage;
  /** 计算 data 段的 SHA-256（深度键序规范化序列化，与键序无关） */
  private computeChecksum;
  /** 递归按键名排序的规范化 JSON 序列化（保证任意嵌套层级的确定性） */
  private canonicalStringify;
  /** 校验迁移包完整性 */
  private verifyChecksum;
  /**
   * 任务模式冲突仲裁
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolvePatternConflict;
  /** 深度合并两个任务模式：方案并集 + 记录并集 + 统计重算 */
  private mergePatterns;
  /**
   * 模型画像冲突仲裁
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveProfileConflict;
  /** 深度合并两个模型画像：taskHistory 按任务类型累加 */
  private mergeProfiles;
  /**
   * 语义记忆冲突仲裁（4.0 补全）
   *
   * merge 不做二选一：交给记忆库 upsert 的证据合并语义（同 id 覆盖时
   * 继承既有 evidence 与应用反馈统计；同 statement 时支撑累加合并）。
   * newer-wins 按 max(distilledAt, lastAppliedAt) 仲裁。
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveSemanticConflict;
  /**
   * 程序记忆冲突仲裁（4.0 补全；语义同 resolveSemanticConflict）
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveProceduralConflict;
}
//#endregion
//#region src/symbiosis/ledger.d.ts
/**
 * ledger.ts — 认知能量账本（共生进化架构第五阶段 1/4）
 *
 * 质变设计（相对"agent.energy 公开字段"草案的三重升级）：
 *
 * 1. 能量不可伪造：智能体没有 energy 字段，能量只存在于账本账户中，
 *    只能经 transfer/mint/burn 流转；每笔流转双方平衡（复式记账），
 *    全局守恒律恒成立：Σ(所有账户余额) === initialSupply + minted。
 *
 * 2. 链式哈希审计：每笔转账携带 sha256 链哈希（前序哈希 + 本笔内容），
 *    任何对历史凭证的篡改都会导致 verifyChain() 失败——能量流向可审计、
 *    可回放、不可抵赖。这是"玩具模拟"与"经济系统"的分水岭。
 *
 * 3. 生态健康可观测：giniCoefficient() 度量能量分布集中度——
 *    能量过度集中 = 垄断 = 认知生态死亡信号（单一智能体买断全部资源，
 *    多样性消失，进化停滞）。监管层可据此调节铸币与救济策略。
 *
 * 账户语义：
 * - treasury：央行国库（初始供给 + 任务成功铸币收入池），仅 runtime 持有账本引用
 * - burn（INCINERATOR）：燃烧池，burn 的能量退出流通但保留审计痕迹
 * - escrow：行动预扣托管（提案批准 → 预扣；执行完毕 → 燃烧/退还）
 *
 * 权限模型（Phase 1）：EnergyLedger 实例仅由 SymbiosisRuntime / CognitiveMarket
 * 持有；智能体只拿到只读快照（Perception.ownBalance），无法绕过市场直接转账。
 */
/** 账户 id（智能体 id / 内部账户） */
type AccountId = string;
/** 央行国库：初始供给与铸币收入池 */
declare const TREASURY: AccountId;
/** 燃烧池：burn 的能量退出流通（余额保留供审计） */
declare const INCINERATOR: AccountId;
/** 行动预扣托管账户 */
declare const ESCROW: AccountId;
/** 单笔能量流转凭证（复式记账：from 失去 = to 得到，恒等） */
interface EnergyTransfer {
  seq: number;
  from: AccountId;
  to: AccountId;
  amount: number;
  reason: string;
  /** 关联对象（资产 id / 提案 id / 交易 seq 等） */
  refId?: string;
  timestamp: number;
  /** 链式哈希：sha256(prevHash + 本笔内容) */
  hash: string;
}
type TransferError = 'non-positive-amount' | 'unknown-account' | 'insufficient-funds' | 'frozen-account' | 'self-transfer';
interface TransferReceipt {
  ok: boolean;
  error?: TransferError;
  transfer?: EnergyTransfer;
}
interface LedgerConfig {
  /** 央行初始供给（默认 10000） */
  initialSupply?: number;
  /** 凭证日志上限（默认 2000，超出滑出最旧） */
  journalLimit?: number;
}
interface LedgerStats {
  /** 守恒总供给 = initialSupply + minted */
  totalSupply: number;
  /** 流通供给（总供给 - 燃烧池余额） */
  circulatingSupply: number;
  minted: number;
  burned: number;
  transfers: number;
  accounts: number;
  frozenAccounts: number;
  /** 能量分布基尼系数（默认不含 treasury/内部账户） */
  gini: number;
  chainHead: string;
  chainIntact: boolean;
}
/** 账本可持久化快照（同时服务测试篡改注入） */
interface LedgerSnapshot {
  balances: Array<[AccountId, number]>;
  frozen: AccountId[];
  journal: EnergyTransfer[];
  seqCounter: number;
  minted: number;
  initialSupply: number;
  /** 链锚点（journalLimit 裁剪后与创世哈希解耦；旧快照缺省回退 GENESIS） */
  chainAnchor?: string;
}
declare class EnergyLedger {
  private balances;
  private frozen;
  private journal;
  private chainHead;
  /** 链锚点：被裁剪的最后一条凭证哈希（verifyChain 由此起验） */
  private chainAnchor;
  private seqCounter;
  private mintedTotal;
  private readonly initialSupply;
  private readonly journalLimit;
  constructor(config?: LedgerConfig);
  /** 开户（零余额；初始注资由调用方经 treasury transfer 完成） */
  openAccount(id: AccountId): boolean;
  hasAccount(id: AccountId): boolean;
  balance(id: AccountId): number;
  isFrozen(id: AccountId): boolean;
  freeze(id: AccountId): void;
  unfreeze(id: AccountId): void;
  /** 原子转账：余额不足/冻结/非法金额全部拒绝，拒绝时状态零变更 */
  transfer(from: AccountId, to: AccountId, amount: number, reason: string, refId?: string): TransferReceipt;
  /** 央行铸币：向 to 增发能量（对应真实价值注入：任务成功/知识生效）。
   *  仅 runtime 持有账本引用时调用；破坏守恒律的唯一入口且被显式记账。 */
  mint(to: AccountId, amount: number, reason: string, refId?: string): TransferReceipt;
  /** 燃烧：能量转入燃烧池退出流通（余额保留供审计与守恒校验） */
  burn(from: AccountId, amount: number, reason: string, refId?: string): TransferReceipt;
  /** 已燃烧总量 */
  burned(): number;
  /** 央行铸币总量 */
  minted(): number;
  /** 守恒总供给 = initialSupply + minted */
  totalSupply(): number;
  /** 流通供给 = 总供给 - 燃烧池余额 - 托管余额 */
  circulatingSupply(): number;
  /**
   * 基尼系数（0 完全平等 → 1 完全垄断）。
   * 默认只统计智能体账户（排除 treasury/burn/escrow 内部账户）——
   * 内部账户是基础设施而非生态成员，计入会稀释真实集中度信号。
   * 零余额账户**保留**在统计内：这是基尼系数的标准口径（零收入人口
   * 计入分母）——饿死归零 / 尚未入场的智能体都是生态成员，「很多
   * 零余额者」本身就是分布的事实而非统计噪声，剔除会系统性低估
   * 集中度（[100,0] 标准值 0.5，剔除后虚降为 0）
   */
  giniCoefficient(includeInternal?: boolean): number;
  /** 最近 limit 条凭证（拷贝，外部修改不影响账本） */
  audit(limit?: number): EnergyTransfer[];
  /** 守恒律校验：Σ(所有账户余额) === initialSupply + minted */
  verifyConservation(): boolean;
  /** 链完整性校验：重算全链哈希，任何历史篡改即刻暴露 */
  verifyChain(): boolean;
  stats(): LedgerStats;
  /** 导出快照（持久化 / 测试篡改注入用） */
  snapshotState(): LedgerSnapshot;
  /** 导入快照（原子整体替换） */
  restoreState(snap: LedgerSnapshot): void;
  private appendEntry;
}
//#endregion
//#region src/symbiosis/belief.d.ts
/** 信念流动性池账户（收集买单成本、支付结算赔付） */
declare const BELIEF_POOL: AccountId;
type BeliefOutcome = 'YES' | 'NO';
type BeliefStatus = 'open' | 'settled' | 'cancelled';
/** 信念资产：一条可机器核验的未来断言 */
interface BeliefAsset {
  id: string;
  /** 人类可读断言 */
  claim: string;
  /** 结算主体键（运行时信号表的键，如 'task.successRate' / 'evolution:agent-x:3'） */
  subject: string;
  /** 断言阈值：到期 realized > threshold 判 YES */
  threshold: number;
  /** 结算心跳轮（<= 该轮时由运行时结算） */
  settleAtTick: number;
  creator: AccountId;
  /** LMSR 流动性参数 b（越大价格越稳、做市最坏补贴 b·ln2 越大） */
  liquidityB: number;
  /** 流通 YES 份额 */
  yesShares: number;
  /** 流通 NO 份额 */
  noShares: number;
  status: BeliefStatus;
  /** 结算结果（true = YES 兑付） */
  outcome?: boolean;
  /** 结算时的实测值 */
  realizedValue?: number;
  /** 累计净流入成本（= 池内该资产储备） */
  volume: number;
  createdAt: number;
}
/** 感知用脱敏视图（含当前隐含概率） */
interface BeliefView {
  assetId: string;
  claim: string;
  subject: string;
  threshold: number;
  settleAtTick: number;
  /** 市场隐含 YES 概率 = 当前价格 */
  impliedProbYes: number;
  yesShares: number;
  noShares: number;
  volume: number;
  status: BeliefStatus;
}
/** 智能体持仓（审计可查） */
interface BeliefPosition {
  agentId: string;
  assetId: string;
  yesShares: number;
  noShares: number;
  /** 累计净支出（取消退款的精确基数） */
  netPaid: number;
}
interface BetReceipt {
  ok: boolean;
  error?: string;
  /** 买入 = 成本（正）；卖出 = 退款（负） */
  cost?: number;
  shares?: number;
  priceAfter?: number;
}
interface SettlementReport {
  assetId: string;
  /** true = YES 兑付 */
  outcome: boolean;
  realized: number;
  payouts: Array<{
    agentId: string;
    amount: number;
  }>;
  /** 国库有界补贴（最坏 b·ln2 口径内） */
  subsidyFromTreasury: number;
  /** 池盈余扫回国库 */
  sweptToTreasury: number;
}
interface CancelReport {
  assetId: string;
  refunds: Array<{
    agentId: string;
    amount: number;
  }>;
  /** 池余额不足等原因退款失败的持仓（审计可查：谁的钱没退成、应退多少） */
  failedRefunds?: Array<{
    agentId: string;
    requested: number;
  }>;
}
interface BeliefMarketConfig {
  /** 默认流动性参数 b（缺省 10） */
  defaultB?: number;
}
/**
 * 信念市场：LMSR 做市的二元断言交易场所。
 *
 * 权限模型：仅 SymbiosisRuntime 持有实例；智能体经感知视图（BeliefView）
 * 只读价格，经 bet-belief 提案由运行时代为成交。
 */
declare class BeliefMarket {
  private readonly ledger;
  private assets;
  private positions;
  private readonly defaultB;
  constructor(ledger: EnergyLedger, config?: BeliefMarketConfig);
  /** 上市新信念（创建即开放交易；国库隐性承担做市补贴义务） */
  create(input: {
    claim: string;
    subject: string;
    threshold: number;
    settleAtTick: number;
    creator: AccountId;
    liquidityB?: number;
  }): {
    ok: boolean;
    error?: string;
    assetId?: string;
  };
  /** 隐含 YES 概率（当前价格） */
  price(assetId: string): number | undefined;
  view(assetId: string): BeliefView | undefined;
  views(): BeliefView[];
  /** 持仓查询（审计/测试用，拷贝） */
  positionOf(agentId: string, assetId: string): BeliefPosition | undefined;
  /**
   * 精确份额买入：成本 = C(q+Δ) − C(q)（LMSR 定价）。
   * 能量 agent → belief-pool。
   */
  buyShares(agentId: AccountId, assetId: string, outcome: BeliefOutcome, shares: number): BetReceipt;
  /**
   * 卖回做市商（结算前平仓）：退款 = C(q) − C(q−Δ)。
   * LMSR 成本函数路径无关 → 买卖往返净成本恒为 0（零摩擦）。
   */
  sellShares(agentId: AccountId, assetId: string, outcome: BeliefOutcome, shares: number): BetReceipt;
  /**
   * 目标价格买入：把市场价格推到自己的真实估计（激励相容动作）。
   * 份额 = 使 implied = target 所需；预算封顶（不足时二分收缩）。
   * @param targetProb 该结果方向的估计概率 ∈ (0.01, 0.99)
   */
  buyToPrice(agentId: AccountId, assetId: string, outcome: BeliefOutcome, targetProb: number, budget: number): BetReceipt;
  /**
   * 结算：realized > threshold → YES 兑付。
   * 每份命中份额支付 1 能量（scoring 结算）；池缺口国库有界补贴，盈余扫回。
   *
   * 浮点鲁棒性：补贴额加 1e-6 余量对冲 ulp 舍入差（「缺口恰好补齐」在
   * 浮点回加后仍可能差 1e-7，导致赔付/清扫转账静默失败、赢家拿不到钱）；
   * 赔付与清扫均钳制到池实际余额——共享池 + 舍入路径差异下永不透支。
   */
  settle(assetId: string, realized: number): SettlementReport | undefined;
  /** 取消：全额退还净支出（不可结算的悬空信念，如信号永缺失） */
  cancel(assetId: string): CancelReport | undefined;
  /** 池余额（审计用；全部结算/取消后应回到 0） */
  poolBalance(): number;
  snapshot(): {
    open: number;
    settled: number;
    cancelled: number;
    volume: number;
    poolBalance: number;
  };
  private updatePosition;
  private toView;
}
//#endregion
//#region src/symbiosis/agent.d.ts
/** 智能体种类（对应认知生态中的角色） */
type AgentKind = 'memory' | 'reflector' | 'optimizer' | 'evolver' | 'curiosity' | 'world-model' | 'model';
/** 运行模式：活跃 / 饥饿休眠 */
type AgentMode = 'active' | 'dormant';
/** 信誉等级：由证据统计自动晋级，不可自封 */
type ReputationTier = 'seed' | 'established' | 'elite';
/** 结构化目标（可机器观测，而非自由文本口号） */
interface AgentGoal {
  /** 目标陈述（人类可读） */
  objective: string;
  /** 关联的可观测指标名（供心智报告/元认知层归因） */
  metrics: string[];
  /** 能量生存线：低于此值进入休眠 */
  survivalThreshold: number;
}
/** 证据化信誉视图（Wilson 口径，与全层统计语言一致） */
interface AgentReputation {
  tier: ReputationTier;
  /** 有效样本量（时间衰减后） */
  effectiveSamples: number;
  /** Beta 后验均值 */
  posteriorMean: number;
  /** Wilson 95% 置信下界 —— 分红权重与市场定价可信度的统一度量 */
  wilsonLower: number;
  /** 累计收入（能量） */
  earnings: number;
  /** 累计支出（能量） */
  spend: number;
  /** 净流入 */
  netFlow: number;
}
/** 市场行情快照（智能体感知的一部分） */
interface MarketSnapshot {
  listed: number;
  openBids: number;
  trades: number;
  /** 累计成交额（能量） */
  volume: number;
  /** 最近成交均价 */
  lastPrice: number;
}
/** 市场挂单脱敏视图（买方决策依据；不暴露底层知识本体） */
interface ListingView {
  assetId: string;
  kind: string;
  seller: string;
  ask: number;
  /** 卖方申报质量（成交后由实测证据校准） */
  claimedQuality: number;
  /** 历史成交次数 */
  sales: number;
}
/** 感知：运行时每轮心跳分发的世界状态切片 */
interface Perception {
  tick: number;
  timestamp: number;
  /** 自身账户余额（只读快照） */
  ownBalance: number;
  /** 自身信誉视图 */
  reputation: AgentReputation;
  /** 市场行情 */
  market: MarketSnapshot;
  /** 市场挂单列表（脱敏） */
  listings: ReadonlyArray<ListingView>;
  /** 信念市场开放资产视图（隐含概率 = 系统对该断言的市场定价；Phase 2） */
  beliefs?: ReadonlyArray<BeliefView>;
  /** 系统信号（成功率/质量/负载等数值观测，键由宿主定义） */
  signals: Readonly<Record<string, number>>;
}
type ProposalKind = 'list-knowledge' | 'buy-knowledge' | 'maintenance' | 'evolution' | 'exploration' | 'bet-belief' | 'idle';
/** 智能体提案：意图 + 出价。运行时/市场/监管批准后才生效 */
interface AgentProposal {
  id: string;
  kind: ProposalKind;
  description: string;
  /** 行动类=愿意支付的能量；list-knowledge=要价；bet-belief=下注预算上限 */
  bid: number;
  /** 关联知识引用（记忆指纹 / 策略 id / 市场 assetId / 信念 assetId） */
  assetRef?: string;
  /** 挂卖时的申报质量（0~1，成交后由使用证据校准） */
  claimedQuality?: number;
  /** 挂卖/购买的资产种类（pattern/semantic/procedural/strategy/policy-gene 等） */
  assetKind?: string;
  /** bet-belief：下注方向 */
  outcome?: 'YES' | 'NO';
  /** bet-belief：自己对该方向的估计概率（把市场价格推到此值，激励相容动作） */
  targetPrice?: number;
  /** 提案有效期（心跳轮数，缺省 1） */
  ttlTicks?: number;
}
/** 执行授权：能量已预扣托管，智能体据此执行被批准的行动 */
interface ExecutionGrant {
  agentId: string;
  proposal: AgentProposal;
  /** 已托管（escrow）的能量预算 */
  budget: number;
  approvedAt: number;
}
/** 行动结果 */
interface ActionResult {
  success: boolean;
  /** 申报价值估计（0~1，供分红与信誉观测参考） */
  valueEstimate: number;
  summary: string;
  data?: unknown;
}
/**
 * 智能体契约（共生层第五阶段契约；稳定后可提升至 contracts.ts）。
 *
 * 实现方约束：
 * - propose() 必须为同步纯决策（基于最近一次 perceive 的快照），不得有副作用；
 * - execute() 只在收到 ExecutionGrant 后被调用，重操作全部放在这里；
 * - 不得缓存 Ledger/Market 引用（构造注入仅限只读回调）。
 */
interface IAgent {
  readonly id: string;
  readonly kind: AgentKind;
  goal(): AgentGoal;
  mode(): AgentMode;
  reputation(): AgentReputation;
  perceive(p: Perception): void;
  propose(): AgentProposal[];
  execute(grant: ExecutionGrant): Promise<ActionResult>;
}
/** 可选成交回调：买方智能体实现 notePurchase 时，运行时在成交后自动通知（已购去重的数据来源） */
interface TradeListener {
  notePurchase(assetId: string, refId: string, price: number): void;
}
/** 结构化能力检测（IAgent 可选能力，非破坏性扩展） */
declare function isTradeListener(agent: IAgent): agent is IAgent & TradeListener;
/**
 * 运行时托管钩子（AgentBase 统一提供，自定义智能体请继承 AgentBase）：
 * 模式切换 / 贡献观测 / 收支记账均由运行时驱动——智能体自身无法
 * 自增能量、自切模式，能量与信誉的唯一合法来源在宿主侧。
 */
interface ManagedAgent extends IAgent {
  setMode(mode: AgentMode): void;
  recordContribution(success: boolean, now?: number): void;
  noteEarnings(amount: number): void;
  noteSpend(amount: number): void;
}
/**
 * 智能体基座：证据化信誉 + 收支记账 + 模式切换的共享实现。
 * 子类只需实现 goal/propose/execute（perceive 默认存快照）。
 */
declare abstract class AgentBase implements IAgent {
  readonly id: string;
  abstract readonly kind: AgentKind;
  protected lastPerception: Perception | undefined;
  private modeFlag;
  private readonly evidence;
  private earningsTotal;
  private spendTotal;
  private proposalCounter;
  constructor(id: string, createdAt?: number);
  abstract goal(): AgentGoal;
  perceive(p: Perception): void;
  /** 默认空转提案（子类按角色覆写） */
  propose(): AgentProposal[];
  /** 默认 no-op 执行（市场类提案无需 execute，由运行时直接撮合） */
  execute(grant: ExecutionGrant): Promise<ActionResult>;
  mode(): AgentMode;
  /** 模式切换由运行时驱动（休眠/复活），智能体自身只读 */
  setMode(mode: AgentMode): void;
  /** 贡献观测（由运行时在任务结算时回调）——信誉的唯一来源 */
  recordContribution(success: boolean, now?: number): void;
  reputation(now?: number): AgentReputation;
  /** 收入记账（由运行时经账本/市场回调，智能体不可自增） */
  noteEarnings(amount: number): void;
  /** 支出记账 */
  noteSpend(amount: number): void;
  /** 提案 id 生成（id 稳定可追溯） */
  protected proposal(kind: ProposalKind, description: string, bid: number, extra?: Partial<AgentProposal>): AgentProposal;
}
//#endregion
//#region src/symbiosis/market.d.ts
/** 知识资产种类 */
type AssetKind = 'pattern' | 'semantic' | 'procedural' | 'strategy' | 'policy-gene' | 'model-profile';
/** 挂单中的知识资产（引用底层知识本体，不复制数据） */
interface KnowledgeAsset {
  id: string;
  kind: AssetKind;
  seller: AccountId;
  /** 底层知识引用（记忆指纹 / 策略 id 等） */
  refId: string;
  description: string;
  /** 要价（能量） */
  ask: number;
  /** 卖方申报质量（0~1，成交后由使用证据校准） */
  claimedQuality: number;
  /** 售后分成比例（相对最近成交价） */
  royaltyRate: number;
  listedAt: number;
  /** 成交次数 */
  sales: number;
  /** 最近成交价（分成基数） */
  lastPrice: number;
  /** 资产级使用证据 */
  evidence: MemoryEvidence;
}
/** 买单 */
interface BidOrder {
  id: string;
  bidder: AccountId;
  assetId: string;
  price: number;
  placedAt: number;
}
/** 成交记录 */
interface TradeRecord {
  seq: number;
  assetId: string;
  assetKind: AssetKind;
  buyer: AccountId;
  seller: AccountId;
  price: number;
  timestamp: number;
}
/** 售后分成支付凭证 */
interface RoyaltyPayout {
  assetId: string;
  seller: AccountId;
  amount: number;
  /** 有效使用次数（累计） */
  confirmedUses: number;
}
interface MarketConfig {
  /** 挂单费率（相对 ask，燃烧；默认 0.1） */
  listingFeeRate?: number;
  /** 默认售后分成比例（默认 0.2） */
  defaultRoyaltyRate?: number;
  /** 最大同时挂单数（默认 64） */
  maxAssets?: number;
}
type ListError = 'non-positive-ask' | 'duplicate-ref' | 'market-full' | 'listing-fee-unaffordable' | 'insufficient-quality';
declare class CognitiveMarket {
  private readonly ledger;
  private assets;
  private bidsByAsset;
  private trades;
  private volumeTraded;
  private readonly listingFeeRate;
  private readonly defaultRoyaltyRate;
  private readonly maxAssets;
  constructor(ledger: EnergyLedger, config?: MarketConfig);
  /** 挂单要价：立即燃烧挂单费（防垃圾信息），同 refId 去重 */
  list(input: {
    seller: AccountId;
    kind: AssetKind;
    refId: string;
    description: string;
    ask: number;
    claimedQuality: number;
    royaltyRate?: number;
  }): {
    ok: boolean;
    error?: ListError;
    assetId?: string;
    listingFee?: number;
  };
  /** 出价买单（竞价；撮合时取最高价） */
  placeBid(bidder: AccountId, assetId: string, price: number): {
    ok: boolean;
    error?: string;
  };
  /** 卖家下架（无费用；已付挂单费不退——信息发布成本已发生） */
  delist(seller: AccountId, assetId: string): boolean;
  /**
   * 撮合：对每个资产取最高出价，price >= ask 则成交。
   * 能量 buyer → seller；成交后该资产买单清空。
   */
  match(): TradeRecord[];
  /**
   * 使用反馈（由运行时在任务结算自动回填，买卖双方无法操纵）：
   * - 观测资产级证据（申报质量的实测校准来源）；
   * - 有效使用 → 央行向卖方支付售后分成（激励相容：买方零成本报告）。
   */
  reportUsage(assetId: string, success: boolean, now?: number): RoyaltyPayout | undefined;
  getAsset(assetId: string): KnowledgeAsset | undefined;
  listAssets(): KnowledgeAsset[];
  openBidCount(): number;
  tradesLog(limit?: number): TradeRecord[];
  /** 智能体感知用的脱敏挂单视图 */
  listingViews(): ListingView[];
  snapshot(): MarketSnapshot;
  /** 资产证据视图（监管/审计用） */
  assetEvidence(assetId: string, now?: number): {
    weightedSuccesses: number;
    weightedFailures: number;
    effectiveSamples: number;
    posteriorMean: number;
    wilsonLower: number;
    claimedQuality: number;
  } | undefined;
}
//#endregion
//#region src/symbiosis/runtime.d.ts
/** 只读监管门控（与 SafetyGovernor.checkGate 结构兼容） */
interface GovernanceGate {
  checkGate(): {
    allowed: boolean;
    reason?: string;
    blockedBy?: string;
  };
}
interface SymbiosisConfig {
  /** 央行初始供给（默认 10000） */
  initialSupply?: number;
  /** 智能体开业注资（默认 100，从 treasury 划拨） */
  openingGrant?: number;
  /** 休眠救济金额（默认 30） */
  reliefAmount?: number;
  /** 每智能体救济次数上限（默认 3，防僵尸吸血） */
  reliefQuota?: number;
  /** 任务成功的铸币分红总额（默认 40） */
  incomePerSuccess?: number;
  /** 行动失败退还比例（默认 0.5） */
  failureRefundRate?: number;
  /** 心跳系统信号采集器（接入宿主 KPI） */
  tickSignals?: () => Record<string, number>;
  /** ── Phase 2：信念市场（市场即心智）── */
  /** 信念市场流动性参数 b（默认 10；越大价格越稳、国库做市补贴上界 b·ln2 越大） */
  beliefLiquidityB?: number;
  /** 信念到期后信号仍缺失的宽限轮数（默认 2，超出取消退款） */
  beliefGraceTicks?: number;
  /** 元认知对账背离阈值（|市场价 − 统计估计| 超过才告警，默认 0.15） */
  divergenceMargin?: number;
  /** futarchy：高成本行动（进化）是否由信念市场资助表决（默认 false，保持既有行为） */
  futarchyEnabled?: boolean;
  /** futarchy：资助门槛（隐含成功概率下限，默认 0.55） */
  futarchyMinImpliedProb?: number;
  /** futarchy：决策资产流动性 b（默认 6，轻流动性让小额信念快速定价） */
  futarchyDecisionB?: number;
  /** ── 5.0：因果内核（do-干预登记 + Shapley 反事实分红）── */
  /** 因果内核实例（挂载后任务结算自动登记 do-干预、分红改用 Shapley 边际贡献） */
  causalKernel?: CausalKernel;
  /** 因果图的结果节点名（默认 'task.outcome'） */
  causalOutcomeNode?: string;
  /** ── 6.0：主动推断内核（期望自由能行动排序 + 变分漂移监测）── */
  /** 自由能引擎实例（挂载后心跳产出变分自由能、行动提案可按 EFE 排序） */
  freeEnergy?: FreeEnergyEngine;
  /**
   * ── 10.0：科学家内核（热点自动登记问题空间）──
   * 挂载后任务结算的 do-干预边 (贡献者 → task.outcome) 自动进入
   * 科学家问题空间——调度器每刻意选型一次，就为「选用 X 是否导致
   * 成功」这个因果问题积累一次 EIG 实验设计机会（幂等，零漂移）。
   */
  scientist?: ScientistMind;
  /** ── 7.0：深思内核（多步行动提案按轨迹自由能排序）── */
  /** 深思内核实例（挂载后多步计划提案可按想象推演的轨迹 G 排序） */
  deliberation?: DeliberationEngine;
}
interface GrantOutcome {
  agentId: string;
  proposalId: string;
  kind: ProposalKind;
  success: boolean;
  burned: number;
  refunded: number;
  valueEstimate: number;
  summary: string;
}
interface SymbiosisTickReport {
  tick: number;
  timestamp: number;
  activeAgents: string[];
  dormantAgents: string[];
  reliefs: Array<{
    agentId: string;
    amount: number;
  }>;
  proposals: Array<{
    agentId: string;
    kind: ProposalKind;
    bid: number;
  }>;
  vetoes: Array<{
    agentId: string;
    kind: ProposalKind;
    reason: string;
  }>;
  trades: number;
  grants: GrantOutcome[];
  mintedThisTick: number;
  burnedThisTick: number;
  gini: number;
  conservationIntact: boolean;
  market: MarketSnapshot;
  /** ── Phase 2：信念市场 ── */
  /** 本轮成交的信念下注（价格即信念） */
  beliefBets: Array<{
    agentId: string;
    assetId: string;
    outcome: 'YES' | 'NO';
    cost: number;
    priceAfter: number;
  }>;
  /** 本轮到期结算 / 宽限超时取消的信念 */
  beliefSettlements: Array<{
    assetId: string;
    mode: 'settled' | 'cancelled';
    outcome?: boolean;
    realized?: number;
    paidOut: number;
    subsidy: number;
    swept: number;
    refunded: number;
  }>;
  /** futarchy 决议：市场资助 / 市场否决 / 监管一票否决 */
  futarchyDecisions: Array<{
    agentId: string;
    proposalId: string;
    impliedProb: number;
    decision: 'funded' | 'market-rejected' | 'governor-vetoed';
    actionSuccess?: boolean;
  }>;
  /** 元认知对账：市场价 vs 被动统计估计的显著背离（模型漂移信号） */
  divergence: Array<{
    assetId: string;
    subject: string;
    marketProb: number;
    statEstimate: number;
    gap: number;
  }>;
  /** 6.0：变分自由能（信念市场价 vs 因果后验的 KL 总和；漂移的信息论度量） */
  variationalFreeEnergy?: {
    total: number;
    driftDetected: boolean;
    worst?: {
      id: string;
      kl: number;
    };
  };
}
interface DistributionReport {
  totalDistributed: number;
  shares: Array<{
    agentId: string;
    weight: number;
    amount: number;
  }>;
  /** ── 5.0：Shapley 反事实分红明细（挂载因果内核时启用）── */
  method?: 'linear-wilson' | 'shapley-counterfactual';
  /** 各贡献者的 Shapley 边际贡献值（拔掉该智能体任务成功率掉多少） */
  shapley?: Array<{
    agentId: string;
    shapleyValue: number;
    counterfactualProb: number;
  }>;
}
declare class SymbiosisRuntime {
  readonly ledger: EnergyLedger;
  readonly market: CognitiveMarket;
  readonly beliefMarket: BeliefMarket;
  private agents;
  private agentIds;
  private reliefUsed;
  private tickCount;
  /** futarchy 待决议行动（提案轮创建决策资产 → 下一轮市场表决 → 执行/否决） */
  private pendingDecisions;
  private readonly config;
  private readonly tickSignals?;
  private readonly governor?;
  /** 5.0：因果内核（可选挂载；缺省保持既有线性分红，零行为漂移） */
  private readonly causalKernel?;
  private readonly causalOutcomeNode;
  /** 6.0：自由能引擎（可选挂载；缺省心跳不产变分项，零漂移） */
  private readonly freeEnergy?;
  /** 10.0：科学家内核（可选挂载；缺省结算不登记问题，零漂移） */
  private readonly scientist?;
  /** 7.0：深思内核（可选挂载；缺省多步提案排序不可用，零漂移） */
  private readonly deliberation?;
  constructor(config?: SymbiosisConfig, governor?: GovernanceGate);
  /** 注册智能体：开户 + 央行开业注资（继承 AgentBase 即满足托管契约） */
  register(agent: ManagedAgent): boolean;
  /**
   * 单轮心跳：生态一轮完整的生存-感知-决策-交易-行动循环。
   * @param signals 心跳系统信号（同时是信念结算的 realized 值来源）
   * @param opts.externalEstimates 宿主被动统计估计（元认知对账用，键 = 信念 subject）
   */
  tick(signals?: Record<string, number>, opts?: {
    externalEstimates?: Record<string, number>;
  }): Promise<SymbiosisTickReport>;
  /**
   * 6.0：EFE 行动排序——把候选行动按期望自由能从低到高排序。
   *
   * 排序依据 G(a) = 务实价值 − 认知价值：
   * 既预测能达成目标的动作优先，同时高不确定性的动作获得认知价值
   * 折抵（探索不再是外挂加成，而是同一目标函数的另一半）。
   *
   * 消费方：宿主在多个行动提案间分配注意力/预算时调用；
   * 返回逐动作分解（多少因为有用 / 多少因为想弄清），可解释可审计。
   */
  efeRankActions(actions: Array<{
    id: string;
    outcomeNode?: string;
  }>, preference?: number): EFEEvaluation[];
  /**
   * 7.0：EFE 多步计划排序——把候选**行动序列**（计划）按想象推演的
   * 轨迹自由能从低到高排序。
   *
   * 与 efeRankActions 的本质区别：那是单步 bandit（每个行动独立评分），
   * 这是轨迹评估——第 1 步的代价可以被第 2 步的收获补偿（γ 折扣），
   * 序列中同一条边重访时认知价值坍缩（排练过的路不再有信息量）。
   * 智能体提出多步方案（如「先实验后上线」）时按全程 G 分配注意力。
   */
  efeRankPlans(plans: Array<{
    id: string;
    startState: string;
    actions: string[];
  }>, preference?: number): Array<{
    id: string;
    totalEfe: number;
    pAllSuccess: number;
    undiscountedEfe: number;
    epistemicMonotone: boolean;
    worstStep: number;
  }>;
  /** 结算信念并把赔付记入智能体收入账（能量经账本，记账经宿主钩子） */
  private settleBelief;
  /** 取消信念退款（悬空断言的零损失退出） */
  private cancelBelief;
  /**
   * 任务结算：成功 → 央行铸币分红。
   *
   * 5.0 质变（挂载因果内核后）：
   * 1. do-干预登记：调度器「刻意选用」某模型/策略 = 天然干预实验
   *    （非被动观测）——每个贡献者的成败都以 do(use:X) → task.outcome
   *    写入因果图，为后续反事实查询与旋钮排序积累黄金证据。
   * 2. Shapley 反事实分红：分红权重从「Wilson 下界的线性份额」升级为
   *    noisy-OR 联盟下的精确 Shapley 值——「拔掉你，任务成功率掉多少，
   *    你就分多少」。挂名不出力的边际贡献 ≈ 0，自然饿死；不可替代的
   *    关键贡献者获得超额回报（真公平的能量经济）。
   *
   * 未挂载内核时保持既有线性 Wilson 分红（零行为漂移）。
   */
  settleTaskOutcome(success: boolean, contributors: Array<{
    agentId: string;
    weight?: number;
  }>): DistributionReport;
  /** 知识使用回报（任务结算时由运行时自动回填，买卖双方不可操纵） */
  reportAssetUsage(assetId: string, success: boolean): void;
  /** 行动类提案执行：预扣 → 执行 → 成功燃烧 / 失败半退 */
  private executeAction;
  /** 生态全景（心智报告/审计用） */
  stats(): {
    tick: number;
    agents: Array<{
      id: string;
      kind: string;
      mode: string;
      balance: number;
      reputation: ReturnType<ManagedAgent['reputation']>;
    }>;
    ledger: ReturnType<EnergyLedger['stats']>;
    market: MarketSnapshot;
    belief: ReturnType<BeliefMarket['snapshot']>;
  };
}
//#endregion
//#region src/symbiosis/wrappers.d.ts
interface MemoryAgentConfig {
  /** 挂卖定价基准（要价 = base × confidence，默认 10） */
  listingBasePrice?: number;
  /** 挂卖门槛：模式置信度（默认 0.5） */
  listingConfidenceThreshold?: number;
  /** 挂卖门槛：出现频次（默认 2，防孤例噪声） */
  listingFrequencyThreshold?: number;
  /** 单轮最多挂卖数（默认 2） */
  maxListedPerTick?: number;
  /** 维护行动成本（默认 2） */
  maintenanceCost?: number;
  /** 维护间隔（心跳轮数，默认 5） */
  maintenanceInterval?: number;
}
/**
 * 记忆智能体：最大化记忆资产价值。
 * 主动行为：挂卖高置信模式（赚取能量 + 售后分成）、周期维护（遗忘曲线）。
 */
declare class MemoryAgent extends AgentBase {
  private readonly memory;
  readonly kind: 'memory';
  private readonly cfg;
  private listedRefs;
  private lastMaintenanceTick;
  constructor(id: string, memory: LongTermMemory, config?: MemoryAgentConfig);
  goal(): AgentGoal;
  propose(): AgentProposal[];
  execute(grant: ExecutionGrant): Promise<ActionResult>;
  /** 已挂卖引用（测试/审计用） */
  listed(): string[];
}
interface OptimizerAgentConfig {
  /** 单次购买预算上限（默认 20） */
  maxBudget?: number;
  /** 保留余额（低于此值不再出价，默认 30） */
  reserveBalance?: number;
  /** 只买申报质量下限（默认 0.55） */
  minClaimedQuality?: number;
  /** 每轮最多出价数（默认 1） */
  maxBidsPerTick?: number;
  /** ── Phase 2：信念市场 ── */
  /** 单条信念下注预算上限（默认 8） */
  beliefBetBudget?: number;
  /** 每轮最多下注信念数（默认 2） */
  maxBeliefBetsPerTick?: number;
}
/**
 * 优化智能体：提高决策收益。
 * 主动行为：观察行情 → 对高性价比知识出价 → 积累已购知识清单；
 * Phase 2：把系统信号的私有判断注入信念市场（成功率信号 → 下注方向）。
 */
declare class OptimizerAgent extends AgentBase {
  private readonly onPurchase?;
  readonly kind: 'optimizer';
  private readonly cfg;
  private purchased;
  private betAssets;
  constructor(id: string, config?: OptimizerAgentConfig, onPurchase?: ((assetId: string, refId: string, price: number) => void) | undefined);
  goal(): AgentGoal;
  propose(): AgentProposal[];
  private betAgents;
  /** 成交通知（由宿主/测试桥接调用；记录已购清单并回调宿主） */
  notePurchase(assetId: string, refId: string, price: number): void;
  purchases(): Array<{
    assetId: string;
    refId: string;
    price: number;
  }>;
}
interface EvolverAgentConfig {
  /** 进化行动成本（默认 50，提案 bid） */
  evolutionCost?: number;
  /** 发起进化的余额门槛（默认 60，留生存余量） */
  evolutionBalanceThreshold?: number;
  /** 策略基因挂卖基准价（默认 15） */
  geneBasePrice?: number;
  /** ── Phase 2：为自己的进化决策自注（私有信息 = 沙盒增益） ── */
  /** 自注预算上限（默认 12） */
  selfBetBudget?: number;
}
/** 进化周期结果（由宿主桥接真实 PolicyEvolver.runEvolutionCycle） */
interface EvolutionCycleOutcome {
  /** 是否产出可部署策略 */
  deployed: boolean;
  /** 沙盒评估收益（gain，可为负） */
  bestGain: number;
  /** 部署策略 id（有则挂卖） */
  policyId?: string;
  /** 人类可读摘要 */
  summary: string;
}
/**
 * 进化智能体：发现突破性策略。
 * 主动行为：能量充足时发起沙盒进化（最贵的行动）；进化产出的策略基因
 * 下一轮挂上市场出售——「进化 → 变现 → 再进化」资本循环。
 */
declare class EvolverAgent extends AgentBase {
  private readonly runCycle?;
  readonly kind: 'evolver';
  private readonly cfg;
  private pendingGeneListing;
  private cyclesRun;
  private deployCount;
  /** 最近一轮沙盒增益（私有信息：自注 futarchy 决策的依据） */
  private lastGain;
  private betAssets;
  constructor(id: string, runCycle?: (() => Promise<EvolutionCycleOutcome>) | undefined, config?: EvolverAgentConfig);
  goal(): AgentGoal;
  propose(): AgentProposal[];
  execute(grant: ExecutionGrant): Promise<ActionResult>;
  stats(): {
    cyclesRun: number;
    deployCount: number;
  };
}
/** 从感知快照提取挂单视图（便捷桥接，供自定义智能体复用） */
declare function listingsOf(p: Perception | undefined): ListingView[];
//#endregion
//#region src/symbiosis/observability.d.ts
/** 渠道分组（着色 + 图例） */
type ChannelGroup = 'distribution' | 'mint' | 'market' | 'belief' | 'action' | 'other';
declare const CHANNEL_GROUPS: Array<{
  group: ChannelGroup;
  label: string;
  color: string;
}>;
/** Sankey 链接：同 (from,to,reason) 聚合 */
interface SankeyLink {
  source: string;
  target: string;
  channel: string;
  channelLabel: string;
  group: ChannelGroup;
  /** 聚合金额 */
  amount: number;
  /** 聚合笔数 */
  count: number;
}
/** Sankey 节点（分层布局：0 铸币源 / 1 国库 / 2 智能体 / 3 池 / 4 燃烧池） */
interface SankeyNode {
  id: string;
  label: string;
  layer: number;
  kind: string;
  /** 当前余额（快照） */
  balance: number;
  /** 窗口内流入总量 */
  inflow: number;
  /** 窗口内流出总量 */
  outflow: number;
}
/** 生态健康快照（HTML 头部指标） */
interface SankeyTotals {
  transfers: number;
  minted: number;
  burned: number;
  totalSupply: number;
  circulatingSupply: number;
  gini: number;
  conservation: boolean;
  chainIntact: boolean;
}
/** Sankey 数据模型（HTML 渲染与 WS 广播共用） */
interface EnergySankeyReport {
  generatedAt: number;
  /** 聚合窗口的凭证序号范围 */
  seqRange: {
    from: number;
    to: number;
  } | null;
  nodes: SankeyNode[];
  links: SankeyLink[];
  /** 渠道汇总（金额降序） */
  channels: Array<{
    channel: string;
    label: string;
    group: ChannelGroup;
    amount: number;
    count: number;
  }>;
  totals: SankeyTotals;
}
/** 智能元信息（节点标注用；缺省按账户 id 展示） */
interface AgentMeta {
  id: string;
  kind?: string;
  label?: string;
}
/**
 * 构建能量 Sankey 数据模型。
 * @param ledger 只读账本（audit 拷贝聚合）
 * @param opts.agents 智能体元信息（kind/label 标注）
 * @param opts.sinceSeq 只聚合 seq > sinceSeq 的凭证（增量窗口；缺省全量）
 */
declare function buildEnergySankey(ledger: EnergyLedger, opts?: {
  agents?: AgentMeta[];
  sinceSeq?: number;
}): EnergySankeyReport;
/**
 * 渲染自包含 HTML 报告（零外部依赖，离线可开）。
 * @param report buildEnergySankey 产物
 * @param opts.title 报告标题（缺省「认知生态能量流 Sankey」）
 */
declare function renderSankeyHtml(report: EnergySankeyReport, opts?: {
  title?: string;
}): string;
//#endregion
//#region src/symbiosis/bridge.d.ts
/** 全局成功率信号键（同时是滚动信念的 subject 与 externalEstimates 的键） */
declare const SIGNAL_GLOBAL_SUCCESS = "task.successRate";
/** 兼容键：wrappers.OptimizerAgent 读取的信号名 */
declare const SIGNAL_GLOBAL_SUCCESS_ALIAS = "taskSuccessRate";
/** 单模型成功率信号键 */
declare function modelSignalKey(modelId: string): string;
/** 模型智能体账户 id */
declare function modelAgentId(modelId: string): string;
/**
 * 模型智能体：宿主 LLM 在认知生态中的化身。
 *
 * 不主动执行任何行动（模型服务本身在宿主操作环）；其经济角色有二：
 * 1. 用「自身近期表现」作为私有信息，在信念市场为自己（及全局指标）
 *    的未来成功率定价——表现好的模型把价格推向乐观，赚结算兑付；
 *    表现差的自然亏损（信息劣势被套利）。
 * 2. 作为任务结算的贡献者，靠成功任务赚取央行铸币分红。
 */
declare class ModelAgent extends AgentBase {
  readonly modelId: string;
  readonly kind: 'model';
  private readonly betBudget;
  private readonly reserveBalance;
  private betAssets;
  constructor(modelId: string, config?: {
    betBudget?: number;
    reserveBalance?: number;
  });
  goal(): {
    objective: string;
    metrics: string[];
    survivalThreshold: number;
  };
  propose(): AgentProposal[];
}
/** 共生融合桥配置 */
interface SymbiosisBridgeConfig {
  /** 是否启用（缺省 false——影子系统，不改变既有主链路行为） */
  enabled?: boolean;
  /** 滚动信念周期（心跳拍数，缺省 3：市场预测 3 拍后的指标） */
  beliefHorizonTicks?: number;
  /** 全局成功率信念阈值（缺省 0.8，与元认知 successRateTarget 对齐） */
  globalSuccessThreshold?: number;
  /** 单模型成功率信念阈值（缺省 0.7） */
  modelSuccessThreshold?: number;
  /** 模型智能体单信念下注预算（缺省 6） */
  modelBetBudget?: number;
  /** 模型智能体保留余额（低于此值+预算不再下注，缺省 10） */
  modelReserveBalance?: number;
  /** 元认知对账背离阈值（缺省 0.15，透传 runtime） */
  divergenceMargin?: number;
  /** 单轮最多产出的漂移洞察数（缺省 3，防告警风暴） */
  maxDriftInsightsPerTick?: number;
  /**
   * A 路线：futarchy 进化表决（缺省关闭）。
   * 启用后须调用 attachEvolver() 绑定真实进化周期；宿主 autonomy-loop
   * 应停止直连执行进化（市场成为高成本进化的唯一资助闸门）。
   */
  futarchy?: {
    /** 是否启用（缺省 false） */
    enabled?: boolean;
    /** 资助门槛：隐含成功概率下限（缺省 0.55，透传 runtime） */
    minImpliedProb?: number;
    /** 决策资产流动性 b（缺省 6，透传 runtime） */
    decisionB?: number;
    /** 进化行动成本（缺省 50，EvolverAgent 提案 bid） */
    evolutionCost?: number;
    /** 发起进化的余额门槛（缺省 60） */
    evolutionBalanceThreshold?: number;
    /** 自注预算上限（缺省 12：足够把价格从 0.5 推到 ~0.77） */
    selfBetBudget?: number;
  };
  /**
   * B 路线：能量反哺调度（缺省关闭）。
   * economicSignals() 把生态经济健康度（余额 × Wilson 信誉）折算为
   * 调度乘数注入 ModelScheduler——赚钱的模型升权、亏钱的模型降权，
   * 能量从记账数字变成真实的调度行为压力。
   */
  economic?: {
    /** 信誉在经济健康度中的权重（缺省 0.6；余额权重 = 1 − 此值） */
    reputationWeight?: number;
    /** 调度乘数下限（缺省 0.5：亏损模型最多打对折，仍可被选中——经济压力是软约束，不死锁） */
    minMultiplier?: number;
    /** 调度乘数上限（缺省 1.5：盈利模型最多加成一半） */
    maxMultiplier?: number;
    /** 中性健康度锚点（缺省 0.5：h = 该值时乘数恰为 1） */
    neutralHealth?: number;
    /** 余额归一化基准（缺省 100 = 开业注资；余额达 2× 基准即满格） */
    balanceBaseline?: number;
  };
  /** 透传 SymbiosisRuntime 的其余配置（期初供给/开业注资等） */
  runtime?: SymbiosisConfig;
}
/**
 * 共生融合桥：宿主主链路 ⇄ 共生运行时的唯一通道。
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳调用 heartbeat()（KPI 注入 +
 * 漂移洞察回流），任务执行完成后调用 settleTask()（价值铸币）。
 */
declare class SymbiosisBridge {
  readonly runtime: SymbiosisRuntime;
  private modelAgents;
  private heartbeatCount;
  private evolver?;
  private evolverDividendWeight?;
  private memoryAgentInstance?;
  private optimizerAgentInstance?;
  private futarchyLog;
  private readonly cfg;
  constructor(config?: SymbiosisBridgeConfig, governor?: GovernanceGate);
  /** 注册宿主模型（为其开立模型智能体账户并注入开业能量） */
  registerModel(modelId: string): void;
  /**
   * A 路线：绑定宿主真实进化周期（futarchy 表决的行动本体）。
   *
   * 注册进化智能体并开启市场资助闸门：进化提案 → 决策资产上市 →
   * 次拍自注定价 → 隐含概率过门槛且监管放行 → 资助执行 runCycle。
   * @param runCycle 宿主桥接的真实进化周期（index.ts: 金丝雀喂数 +
   *        沙盒素材刷新 + PolicyEvolver.runEvolutionCycle）
   * @param opts.dividendWeight 任务成功时进化贡献者的分红权重钩子
   *        （返回 undefined/≤0 = 当前无部署策略，不参与分红）
   */
  attachEvolver(runCycle: () => Promise<EvolutionCycleOutcome>, opts?: {
    dividendWeight?: () => number | undefined;
  }): EvolverAgent;
  /** 进化智能体（未绑定为 undefined；观测/审计用） */
  get evolverAgent(): EvolverAgent | undefined;
  /**
   * D 路线：绑定宿主真实长期记忆（知识卖方智能体）。
   *
   * 注册记忆智能体：真实高置信任务模式挂上认知市场出售（成交价 +
   * 央行版税），周期性支付能量执行真实维护（遗忘曲线幂等，与宿主
   * loop 的维护并行安全，多次调用不复合叠加）。
   * @param memory 宿主 LongTermMemory（只经既有公开 API 读写）
   * @param opts 透传 MemoryAgentConfig（挂卖基准价/门槛/维护间隔等）
   */
  attachMemory(memory: LongTermMemory, opts?: MemoryAgentConfig): MemoryAgent;
  /** 记忆智能体（未绑定为 undefined；观测/审计用） */
  get memoryAgent(): MemoryAgent | undefined;
  /**
   * D 路线：注册优化智能体（知识买方 + 信念下注方）。
   *
   * 真实认知分工市场化：Optimizer 观察市场行情，对高性价比知识出价
   * 购买（runtime 撮合成交后经 TradeListener 自动回调 notePurchase），
   * 并以决策视角参与信念市场下注——与模型智能体构成多方定价。
   * @param opts.onPurchase 成交回调（宿主广播/日志桥接点）
   * @param opts.config 透传 OptimizerAgentConfig（预算/保留余额/质量门槛）
   */
  attachOptimizer(opts?: {
    onPurchase?: (assetId: string, refId: string, price: number) => void;
    config?: OptimizerAgentConfig;
  }): OptimizerAgent;
  /** 优化智能体（未绑定为 undefined；观测/审计用） */
  get optimizerAgent(): OptimizerAgent | undefined;
  /** 最近一次心跳的 futarchy 决议（可观测性：funded / market-rejected / governor-vetoed） */
  lastFutarchyDecisions(): SymbiosisTickReport['futarchyDecisions'];
  /** 已注册模型清单 */
  registeredModels(): string[];
  /**
   * 共生心跳（autonomy-loop 每拍调用）：
   * KPI 快照 → 系统信号 + 被动统计估计 + 滚动信念 → 市场对账 → 漂移洞察。
   * @returns source='market' 的漂移洞察（空数组 = 市场与统计一致）
   */
  heartbeat(kpi: KpiSnapshot): Promise<Insight[]>;
  /**
   * 任务结算（宿主计划执行完成后调用）：
   * 逐节点贡献聚合（各模型 = 其成功节点质量之和）→ 央行铸币分红。
   * futarchy 启用时，部署中的策略基因视为任务成功的隐性贡献者
   * （dividendWeight 钩子评估）——进化经济的自持收入来源。
   * 未注册模型的节点不计入；失败任务不铸币但记录贡献证据（信誉惩罚）。
   */
  settleTask(result: {
    success: boolean;
    nodeResults: ReadonlyArray<{
      modelId: string;
      success: boolean;
      quality: number;
    }>;
  }): DistributionReport;
  /**
   * C 路线：能量 Sankey 报告（生态可观测性）。
   * 聚合链式账本凭证为 分层流量图数据模型（节点余额/流入流出 + 渠道链接），
   * 智能体节点自动携带 kind 标注（模型/进化者/记忆/…）。
   * @param sinceSeq 增量窗口（只聚合 seq > sinceSeq 的凭证；缺省全量）
   */
  sankey(sinceSeq?: number): EnergySankeyReport;
  /** C 路线：自包含 HTML（零依赖离线可开；宿主直接落盘即得能量全景） */
  sankeyHtml(sinceSeq?: number): string;
  /**
   * B 路线：模型经济信号 → 调度乘数（能量反哺调度的数据源）。
   *
   * 经济健康度 h = w_rep × Wilson 信誉下界 + w_bal × 余额归一化
   * （余额达 2× balanceBaseline 即满格；信誉为主——长期统计，余额为辅——
   * 短期波动）；调度乘数 m = clamp(h / neutralHealth, min, max)：
   *   赚钱且信誉好的模型 m > 1 升权，持续亏损的模型 m < 1 降权，
   *   中性健康度恰为 1（不奖不罚）。
   *
   * 设计护栏：乘数有界（缺省 0.5~1.5，亏损最多打对折但仍可被选中——
   * 经济压力是软约束，不造成调度死锁）；未注册模型 / 无信号模型
   * 不出现在返回中（调度器对缺失信号保持乘数 1 的中性行为）。
   */
  economicSignals(): Map<string, {
    balance: number;
    reputationLower: number;
    health: number;
    multiplier: number;
  }>;
  /** 生态状态快照（可观测性 / 心智报告采集器用） */
  status(): {
    enabled: boolean;
    registeredModels: string[];
    heartbeats: number;
    gini: number;
    conservationIntact: boolean;
    treasury: number;
    belief: ReturnType<SymbiosisRuntime['beliefMarket']['snapshot']>;
    /** A 路线：futarchy 进化表决状态（未启用时 undefined） */
    futarchy?: {
      enabled: boolean;
      minImpliedProb: number;
      evolver: {
        balance: number;
        cyclesRun: number;
        deployCount: number;
      } | undefined;
      lastDecisions: SymbiosisTickReport['futarchyDecisions'];
    };
  };
  /** 确保某 subject 存在 open 信念；否则新上市一条（结算拍 = 下一拍 + horizon） */
  private ensureRollingBelief;
  /** 市场背离 → 元认知洞察（模型漂移报警，回流目标引擎） */
  private divergenceToInsights;
}
//#endregion
//#region src/dashboard/index.d.ts
/**
 * 将仪表盘挂载到进度广播器的 HTTP 端口
 * @param broadcaster 已创建的进度广播器（须在 start() 之前或之后调用均可）
 * @param getModelStatuses 模型状态提供函数（通常绑定 LLMClient.getModelStatuses）
 * @returns 卸载函数（恢复默认健康检查响应）
 */
declare function attachDashboard(broadcaster: ProgressBroadcaster, getModelStatuses: () => ModelRuntimeStatus[]): () => void;
//#endregion
//#region src/index.d.ts
/** 插件配置（对应 cordis.patch.yml config 节） */
interface SchedulerConfig {
  /** 可选：DSH 宿主经 ctx 提供模型时无需配置；apiKey 亦可省略（宿主注入请求头） */
  strategistModel?: {
    id: string;
    endpoint: string;
    apiKey?: string;
  };
  /** 可选：宿主未提供模型目录时的兜底配置 */
  models?: ModelConfig[];
  sentinel: {
    watchCodeChanges: boolean;
    watchErrors: boolean;
    watchPerformance: boolean;
    /** 聚合窗口（秒） */
    aggregationWindow: number;
    signalSources?: Array<{
      type: 'webhook' | 'polling' | 'filesystem';
      port?: number;
      interval?: number;
      url?: string;
      path?: string;
      signalType: string;
    }>;
  };
  qualityThreshold: number;
  maxRetries: number;
  globalTimeout: number;
  enableProgress: boolean;
  progressPort: number;
  verbose: boolean;
  experienceStorePath: string;
  encryption: {
    enabled: boolean;
    masterKey?: string;
    algorithm: 'aes-256-gcm' | 'aes-256-cbc';
    fullFileEncryption: boolean;
  };
  sync: {
    localNodeId: string;
    peers: SyncNodeConfig[];
  };
  consensus: {
    enabled: boolean;
    localNodeId: string;
    consensusPort: number;
    electionTimeoutMin: number;
    electionTimeoutMax: number;
    heartbeatInterval: number;
    cluster: Array<{
      nodeId: string;
      address: string;
      port: number;
      priority?: number;
    }>;
  };
  hotReload: Partial<HotReloadConfig> & {
    enabled: boolean;
  };
  tenants: Array<any>;
  /** 运行时数据根目录（默认 .scheduler） */
  dataDir?: string;
  /** 经验快路径阈值：命中模式置信度 ≥ 该值时直接复用历史成功计划（缺省 0.9；设 >1 关闭） */
  memoryFastPathThreshold?: number;
  /** LLM 客户端选项覆盖（测试注入 fetchImpl 等） */
  llm?: {
    fetchImpl?: typeof fetch;
    timeout?: number;
  };
  /** 执行器节点执行器注入（测试离线模拟） */
  nodeRunner?: NodeRunner;
  /** 决策引擎配置覆盖（闭环深度优化） */
  decision?: Partial<DecisionEngineConfig>;
  /** 反思引擎配置覆盖（闭环深度优化） */
  reflection?: Partial<ReflectionEngineConfig>;
  /** 评审模型注入（LLM-as-judge，测试离线模拟） */
  judge?: JudgeModel;
  /** 教训提取器注入（测试离线模拟） */
  lessonExtractor?: LessonExtractor;
  /** 自主智能配置（目标引擎 / 元认知 / 策略进化 / 心跳循环 / 世界模型 / 好奇心 / 安全治理） */
  autonomy?: {
    /** 是否启用自主心跳循环（缺省 true） */
    enabled?: boolean;
    /** 心跳间隔（毫秒，缺省 30000） */
    heartbeatMs?: number;
    /** 目标引擎配置覆盖 */
    goal?: Partial<GoalEngineConfig>;
    /** 元认知配置覆盖 */
    metaCognition?: Partial<MetaCognitionConfig>;
    /** 策略进化配置覆盖 */
    evolution?: Partial<StrategyEvolutionConfig>;
    /**
     * 第三阶段：调度策略进化（PolicyEvolver + Sandbox）配置覆盖。
     * 设为 { enabled: false } 可完全关闭；沙盒离线评估，不阻塞操作环调度。
     */
    policyEvolution?: Partial<PolicyEvolverConfig> & {
      enabled?: boolean;
      /** 沙盒评估配置覆盖 */
      sandbox?: Partial<SandboxConfig>;
    };
    /**
     * 第四阶段：元认知层（SelfModel + MetaCognitiveController）配置覆盖。
     * 设为 { enabled: false } 可完全关闭外环；心智报告与审计日志落盘 dataDir。
     */
    metaLayer?: {
      enabled?: boolean;
      /** 自我建模配置覆盖 */
      selfModel?: Partial<SelfModelConfig>;
      /** 元认知控制器配置覆盖 */
      controller?: Partial<MetaControllerConfig>;
    };
    /** 心跳循环配置覆盖 */
    loop?: Partial<AutonomyLoopConfig>;
    /**
     * 第五阶段 Phase 2.5：共生进化融合（能量经济 + 信念市场）。
     * 缺省关闭（影子系统，不改变既有主链路行为）；启用后：
     * KPI 注入共生心跳，市场价 vs 统计估计显著背离回流为自愈目标，
     * 任务成功按模型贡献铸币分红（能量经济真实闭环）。
     */
    symbiosis?: {
      /** 是否启用（缺省 false） */
      enabled?: boolean;
      /** 滚动信念周期（心跳拍数，缺省 3） */
      beliefHorizonTicks?: number;
      /** 全局成功率信念阈值（缺省 0.8） */
      globalSuccessThreshold?: number;
      /** 单模型成功率信念阈值（缺省 0.7） */
      modelSuccessThreshold?: number;
      /** 模型智能体单信念下注预算（缺省 6） */
      modelBetBudget?: number;
      /** 元认知对账背离阈值（缺省 0.15） */
      divergenceMargin?: number;
      /**
       * A 路线：futarchy 进化表决（缺省关闭）。
       * 启用后高成本进化周期不再由心跳无条件触发，改由信念市场表决资助
       * （进化者自注私有信息 + 模型健康度定价 ≥ 门槛且监管放行 → 执行）；
       * autonomy-loop 的直连进化桥接自动让位（市场成为唯一资助闸门）。
       */
      futarchy?: {
        /** 是否启用（缺省 false；须同时 symbiosis.enabled = true） */
        enabled?: boolean;
        /** 资助门槛：隐含成功概率下限（缺省 0.55） */
        minImpliedProb?: number;
        /** 决策资产流动性 b（缺省 6） */
        decisionB?: number;
        /** 进化行动成本（能量，缺省 50） */
        evolutionCost?: number;
        /** 发起进化的余额门槛（能量，缺省 60） */
        evolutionBalanceThreshold?: number;
        /** 自注预算上限（能量，缺省 12） */
        selfBetBudget?: number;
      };
      /**
       * B 路线：能量反哺调度（缺省关闭）。
       * 启用后每轮共生心跳把模型经济健康度（余额 × Wilson 信誉）折算为
       * 调度乘数注入 ModelScheduler——赚钱的模型升权、亏钱的模型降权，
       * 能量从记账数字变成真实的调度行为压力（乘数有界 0.5~1.5，
       * 探索加成不受影响，preferred 推荐语义保持）。
       */
      schedulingFeedback?: {
        /** 是否启用（缺省 false；须同时 symbiosis.enabled = true） */
        enabled?: boolean;
        /** 信誉在经济健康度中的权重（缺省 0.6） */
        reputationWeight?: number;
        /** 调度乘数下限（缺省 0.5） */
        minMultiplier?: number;
        /** 调度乘数上限（缺省 1.5） */
        maxMultiplier?: number;
        /** 中性健康度锚点（缺省 0.5） */
        neutralHealth?: number;
        /** 余额归一化基准（缺省 100） */
        balanceBaseline?: number;
      };
      /**
       * C 路线：生态可观测性（缺省关闭）。
       * 设置 sankeyPath 后每 N 拍共生心跳落盘一份自包含能量 Sankey HTML
       * （零依赖离线可开：分层流量图 + 渠道明细 + 账户余额 + 健康快照）。
       */
      observability?: {
        /** Sankey HTML 落盘路径（设置即启用；如 /tmp/symbiosis-sankey.html） */
        sankeyPath?: string;
        /** 每 N 拍心跳落盘一次（缺省 5） */
        everyNTicks?: number;
      };
      /**
       * D 路线：全智能体接入（缺省关闭；须同时 symbiosis.enabled = true）。
       * 记忆智能体把真实高置信任务模式挂上认知市场（成交 + 央行版税），
       * 优化智能体以决策视角买知识 + 参与信念下注——认知分工完全市场化。
       * （进化智能体经 futarchy.enabled → attachEvolver 接入，见上。）
       */
      agents?: {
        /** 记忆智能体（知识卖方）：缺省关闭 */
        memory?: {
          /** 是否启用（缺省 false） */
          enabled?: boolean;
          /** 挂卖定价基准（要价 = base × 置信度，缺省 10） */
          listingBasePrice?: number;
          /** 挂卖门槛：模式置信度（缺省 0.5） */
          listingConfidenceThreshold?: number;
          /** 挂卖门槛：出现频次（缺省 2） */
          listingFrequencyThreshold?: number;
          /** 维护间隔（共生心跳轮数，缺省 5；遗忘曲线幂等，与宿主 loop 维护并行安全） */
          maintenanceInterval?: number;
        };
        /** 优化智能体（知识买方 + 信念下注方）：缺省关闭 */
        optimizer?: {
          /** 是否启用（缺省 false） */
          enabled?: boolean;
          /** 单次购买预算上限（能量，缺省 20） */
          maxBudget?: number;
          /** 保留余额（能量，缺省 30） */
          reserveBalance?: number;
          /** 只买申报质量下限（缺省 0.55） */
          minClaimedQuality?: number;
          /** 单条信念下注预算上限（能量，缺省 8） */
          beliefBetBudget?: number;
        };
      };
    };
    /** 世界模型配置覆盖 */
    worldModel?: Partial<WorldModelConfig>;
    /** 好奇心引擎配置覆盖 */
    curiosity?: Partial<CuriosityEngineConfig>;
    /** 安全治理器配置覆盖 */
    governor?: Partial<SafetyGovernorConfig>;
    /** 5.0：因果内核配置覆盖（do-干预登记 + Shapley 分红 + 反事实查询） */
    causalKernel?: Partial<CausalKernelConfig>;
    /**
     * 6.0：主动推断配置（自由能最小化心智）。
     * enabled 时调度改用期望自由能（探索/利用统一）、健康报告携带
     * 统一自由能 KPI、共生心跳产出变分漂移监测。缺省关闭（零漂移）。
     */
    activeInference?: {
      enabled?: boolean;
      /** 调度偏好强度（对成功的目标概率，缺省 0.9） */
      schedulingPreference?: number;
      /** 认知价值权重（信息增益折算系数，缺省 1） */
      epistemicWeight?: number;
    };
    /**
     * 8.0：元推理配置（元认知心智：计算即行动，思考有价格）。
     * optimizer.metacognitiveRecommendation 按 habit/reactive/deliberative
     * 三模式仲裁；结算回流驱动元学习（门槛自适应 + 习惯晋升/作废）。
     */
    metareasoning?: {
      /** 反应门槛：单步 EFE 差 ≥ 该值直接反应（nat，缺省 0.25） */
      decisivenessGap?: number;
      /** 反应模式最低证据量（缺省 8） */
      sufficientEvidence?: number;
      /** 习惯晋升门槛：同状态同计划连续成功次数（缺省 2） */
      habitPromotionSuccesses?: number;
      /** 深思最大深度（缺省 4） */
      maxDepth?: number;
      /** 每节点计算价格（nat，缺省 0.01） */
      natPerNode?: number;
      /** 单次深思预算（nat，缺省 2.0） */
      budgetNat?: number;
    };
    /**
     * 9.0：抽象配置（抽象心智：类比结构映射 + 分层收缩）。
     * enabled 时深思内核挂载抽象层——冷状态凭结构同构借别域经验
     * （零样本应答）、后继结构继承、跨域宏技能；健康报告携带
     * 抽象统计 KPI。缺省关闭（零漂移；均匀层与 Beta(1,1) 严格等价）。
     */
    abstraction?: {
      enabled?: boolean;
      /** L1 类比层先验强度（伪计数，缺省 6） */
      analogyStrength?: number;
      /** 结构相似度门槛（Jaccard，缺省 0.3） */
      minSimilarity?: number;
      /** 抽象技能晋升所需跨域成功数（缺省 2） */
      abstractSkillDomains?: number;
    };
    /**
     * 10.0：科学家配置（科学家心智：最优实验设计）。
     * enabled 时宿主创建 ScientistMind（EIG 实验设计 + 混杂侦测加成
     * + 预算仲裁 + 信息台账），好奇心/调度的因果实验建议升级为
     * Lindley 期望信息增益口径；健康报告携带知识前沿 KPI。
     * 缺省关闭（零漂移——不登记问题即无实验设计）。
     */
    scientist?: {
      enabled?: boolean;
      /** 缺省单次实验代价（nat；EIG 低于此值不设计，缺省 0.05） */
      defaultCostNat?: number;
      /** 混杂加成上限（nat，缺省 1.0） */
      maxConfoundingBonus?: number;
      /** 定律试验加成上限（nat，缺省 1.0；需 theorist.enabled） */
      lawBonusCap?: number;
      /** 热点自动登记：调度器观测到的 (model, taskType) 边入问题空间 */
      autoRegisterQuestions?: boolean;
    };
    /**
     * 11.0：理论配置（理论心智：从数据到定律）。
     * enabled 时宿主创建 TheoristEngine（层级贝叶斯定律归纳 +
     * MDL 压缩定价 + 零样本预测 + 反常/范式转移），科学家的问题
     * 若落在定律作用域内获得定律试验加成；健康报告携带理论前沿
     * KPI。缺省关闭（零漂移——不归纳即无定律）。
     */
    theorist?: {
      enabled?: boolean;
      /** 立定律的最小成员数（缺省 3） */
      minMembers?: number;
      /** 零样本预测的臂证据门槛（缺省 1） */
      zeroShotMaxArmSamples?: number;
    };
    /** 目标分解器注入（测试离线模拟） */
    decomposer?: GoalDecomposer;
  };
  /** 宿主融合配置（全宿主可观测 + 全宿主安全治理；宿主无 ctx.tools 时静默降级） */
  hostFusion?: Partial<HostFusionConfig>;
}
/** Tool 定义 */
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
    enum?: string[];
  }>;
  handler: (args: any) => Promise<any> | any;
}
/** Tool 调用错误 */
declare class ToolError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/**
 * Tool 注册表服务
 *
 * cordis 核心未内置 Tool API，本插件以 provide('schedulerTools') 形式
 * 向宿主暴露 12 个 Tool 的注册、发现与调用能力。
 */
declare class ToolRegistry {
  private tools;
  /** 注册一个 Tool（重名覆盖） */
  register(tool: ToolDefinition): void;
  /** 注销一个 Tool */
  unregister(name: string): boolean;
  /** 获取 Tool 定义 */
  get(name: string): ToolDefinition | undefined;
  /** 列出全部 Tool（不含 handler） */
  list(): Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>>;
  /** 调用 Tool（未知名称抛 ToolError） */
  invoke(name: string, args?: Record<string, any>): Promise<any>;
}
/** 插件对外暴露的调度器服务面 */
interface SchedulerService {
  tools: ToolRegistry;
  sentinel: Sentinel;
  /** 模型调度器（新架构：优化器 → 模型调度） */
  modelScheduler: ModelScheduler;
  /** 任务执行器（新架构：模型调度 → 任务执行） */
  taskExecutor: TaskExecutor;
  memory: LongTermMemory;
  llm: LLMClient;
  tenantManager: TenantManager;
  sync: DistributedSync;
  raft: RaftEngine | null;
  hotReload: HotReloadEngine | null;
  broadcaster: ProgressBroadcaster | null;
  benchmark: BenchmarkEngine;
  cryptoEngine: CryptoEngine | null;
  /** 决策引擎（闭环深度优化） */
  decisionEngine: DecisionEngine;
  /** 反思引擎（闭环深度优化） */
  reflectionEngine: ReflectionEngine;
  /** 优化器（新架构：记忆库 → 优化器 → 模型调度） */
  optimizer: Optimizer;
  /** 反思器（新架构：任务执行 → 反思器 → 记忆更新） */
  reflector: Reflector;
  /** 目标引擎（自主智能） */
  goalEngine: GoalEngine;
  /** 元认知引擎（自主智能） */
  metaCognition: MetaCognitionEngine;
  /** 策略进化引擎（自主智能） */
  strategyEvolution: StrategyEvolutionEngine;
  /** 第四阶段：自我建模引擎（心智报告） */
  selfModel: SelfModel;
  /** 第四阶段：元认知控制器（保守调参 + 自动回滚 + 审计） */
  metaController: MetaCognitiveController;
  /** 自主心跳循环（自主智能） */
  autonomyLoop: AutonomyLoop;
  /** 世界模型（自主智能·预见） */
  worldModel: WorldModel;
  /** 好奇心引擎（自主智能·内在动机） */
  curiosity: CuriosityEngine;
  /** 安全治理器（自主智能·边界） */
  governor: SafetyGovernor;
  /** 宿主融合层（全宿主可观测 + 安全治理；未激活时 isActive()=false） */
  hostFusion: HostFusionLayer;
  /** 手动提交任务（等价于 autonomous_execute Tool） */
  submitTask(task: string, urgency?: number): Signal;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    scheduler: SchedulerService;
    schedulerTools: ToolRegistry;
  }
  interface Events {
    'scheduler/signal'(signal: Signal): void;
    'scheduler/plan-complete'(result: PlanExecutionResult, signal: Signal): void;
  }
}
/**
 * 插件配置 schema（cordis Plugin.Base.Config）。
 * 经 ctx.plugin() 加载时由 cordis resolveConfig 自动校验并填充默认值；
 * 函数型注入字段（nodeRunner / judge / llm.fetchImpl 等）不在 schema 中声明，
 * 作为额外属性透传，不受校验影响。
 */
declare const Config: Schema<Schemastery.ObjectS<{
  strategistModel: Schema<Schemastery.ObjectS<{
    id: Schema<string, string>;
    endpoint: Schema<string, string>;
    apiKey: Schema<string, string>;
  }>, Schemastery.ObjectT<{
    id: Schema<string, string>;
    endpoint: Schema<string, string>;
    apiKey: Schema<string, string>;
  }>>;
  models: Schema<any[], any[]>;
  sentinel: Schema<Schemastery.ObjectS<{
    watchCodeChanges: Schema<boolean, boolean>;
    watchErrors: Schema<boolean, boolean>;
    watchPerformance: Schema<boolean, boolean>;
    aggregationWindow: Schema<number, number>;
    signalSources: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    watchCodeChanges: Schema<boolean, boolean>;
    watchErrors: Schema<boolean, boolean>;
    watchPerformance: Schema<boolean, boolean>;
    aggregationWindow: Schema<number, number>;
    signalSources: Schema<any[], any[]>;
  }>>;
  qualityThreshold: Schema<number, number>;
  maxRetries: Schema<number, number>;
  globalTimeout: Schema<number, number>;
  enableProgress: Schema<boolean, boolean>;
  progressPort: Schema<number, number>;
  verbose: Schema<boolean, boolean>;
  experienceStorePath: Schema<string, string>;
  encryption: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    masterKey: Schema<string, string>;
    algorithm: Schema<"aes-256-cbc" | "aes-256-gcm", "aes-256-cbc" | "aes-256-gcm">;
    fullFileEncryption: Schema<boolean, boolean>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    masterKey: Schema<string, string>;
    algorithm: Schema<"aes-256-cbc" | "aes-256-gcm", "aes-256-cbc" | "aes-256-gcm">;
    fullFileEncryption: Schema<boolean, boolean>;
  }>>;
  sync: Schema<Schemastery.ObjectS<{
    localNodeId: Schema<string, string>;
    peers: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    localNodeId: Schema<string, string>;
    peers: Schema<any[], any[]>;
  }>>;
  consensus: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    localNodeId: Schema<string, string>;
    consensusPort: Schema<number, number>;
    electionTimeoutMin: Schema<number, number>;
    electionTimeoutMax: Schema<number, number>;
    heartbeatInterval: Schema<number, number>;
    cluster: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    localNodeId: Schema<string, string>;
    consensusPort: Schema<number, number>;
    electionTimeoutMin: Schema<number, number>;
    electionTimeoutMax: Schema<number, number>;
    heartbeatInterval: Schema<number, number>;
    cluster: Schema<any[], any[]>;
  }>>;
  hotReload: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    watchDirs: Schema<string[], string[]>;
    watchExtensions: Schema<string[], string[]>;
    debounceMs: Schema<number, number>;
    buildCommand: Schema<string, string>;
    autoRollback: Schema<boolean, boolean>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    watchDirs: Schema<string[], string[]>;
    watchExtensions: Schema<string[], string[]>;
    debounceMs: Schema<number, number>;
    buildCommand: Schema<string, string>;
    autoRollback: Schema<boolean, boolean>;
  }>>;
  tenants: Schema<any[], any[]>;
  dataDir: Schema<string, string>;
  memoryFastPathThreshold: Schema<number, number>;
  autonomy: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    heartbeatMs: Schema<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    heartbeatMs: Schema<number, number>;
  }>>;
  hostFusion: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    observeToolResults: Schema<boolean, boolean>;
    governToolCalls: Schema<boolean, boolean>;
    failureEscalationThreshold: Schema<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    observeToolResults: Schema<boolean, boolean>;
    governToolCalls: Schema<boolean, boolean>;
    failureEscalationThreshold: Schema<number, number>;
  }>>;
}>, Schemastery.ObjectT<{
  strategistModel: Schema<Schemastery.ObjectS<{
    id: Schema<string, string>;
    endpoint: Schema<string, string>;
    apiKey: Schema<string, string>;
  }>, Schemastery.ObjectT<{
    id: Schema<string, string>;
    endpoint: Schema<string, string>;
    apiKey: Schema<string, string>;
  }>>;
  models: Schema<any[], any[]>;
  sentinel: Schema<Schemastery.ObjectS<{
    watchCodeChanges: Schema<boolean, boolean>;
    watchErrors: Schema<boolean, boolean>;
    watchPerformance: Schema<boolean, boolean>;
    aggregationWindow: Schema<number, number>;
    signalSources: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    watchCodeChanges: Schema<boolean, boolean>;
    watchErrors: Schema<boolean, boolean>;
    watchPerformance: Schema<boolean, boolean>;
    aggregationWindow: Schema<number, number>;
    signalSources: Schema<any[], any[]>;
  }>>;
  qualityThreshold: Schema<number, number>;
  maxRetries: Schema<number, number>;
  globalTimeout: Schema<number, number>;
  enableProgress: Schema<boolean, boolean>;
  progressPort: Schema<number, number>;
  verbose: Schema<boolean, boolean>;
  experienceStorePath: Schema<string, string>;
  encryption: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    masterKey: Schema<string, string>;
    algorithm: Schema<"aes-256-cbc" | "aes-256-gcm", "aes-256-cbc" | "aes-256-gcm">;
    fullFileEncryption: Schema<boolean, boolean>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    masterKey: Schema<string, string>;
    algorithm: Schema<"aes-256-cbc" | "aes-256-gcm", "aes-256-cbc" | "aes-256-gcm">;
    fullFileEncryption: Schema<boolean, boolean>;
  }>>;
  sync: Schema<Schemastery.ObjectS<{
    localNodeId: Schema<string, string>;
    peers: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    localNodeId: Schema<string, string>;
    peers: Schema<any[], any[]>;
  }>>;
  consensus: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    localNodeId: Schema<string, string>;
    consensusPort: Schema<number, number>;
    electionTimeoutMin: Schema<number, number>;
    electionTimeoutMax: Schema<number, number>;
    heartbeatInterval: Schema<number, number>;
    cluster: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    localNodeId: Schema<string, string>;
    consensusPort: Schema<number, number>;
    electionTimeoutMin: Schema<number, number>;
    electionTimeoutMax: Schema<number, number>;
    heartbeatInterval: Schema<number, number>;
    cluster: Schema<any[], any[]>;
  }>>;
  hotReload: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    watchDirs: Schema<string[], string[]>;
    watchExtensions: Schema<string[], string[]>;
    debounceMs: Schema<number, number>;
    buildCommand: Schema<string, string>;
    autoRollback: Schema<boolean, boolean>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    watchDirs: Schema<string[], string[]>;
    watchExtensions: Schema<string[], string[]>;
    debounceMs: Schema<number, number>;
    buildCommand: Schema<string, string>;
    autoRollback: Schema<boolean, boolean>;
  }>>;
  tenants: Schema<any[], any[]>;
  dataDir: Schema<string, string>;
  memoryFastPathThreshold: Schema<number, number>;
  autonomy: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    heartbeatMs: Schema<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    heartbeatMs: Schema<number, number>;
  }>>;
  hostFusion: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    observeToolResults: Schema<boolean, boolean>;
    governToolCalls: Schema<boolean, boolean>;
    failureEscalationThreshold: Schema<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    observeToolResults: Schema<boolean, boolean>;
    governToolCalls: Schema<boolean, boolean>;
    failureEscalationThreshold: Schema<number, number>;
  }>>;
}>>;
/** 插件名称 */
declare const name = "dsh-proactive";
/**
 * 插件入口：初始化全部模块、编排 10 步链路、注册 12 Tool、登记 cleanup
 */
declare function apply(ctx: Context, config: Partial<SchedulerConfig>): void;
/**
 * 插件导出（cordis 函数插件形态 + 静态元数据）
 * - name：注册表显示名（Function.name 只读，须用 defineProperty）
 * - Config：Schemastery 标准 schema，加载时由 cordis resolveConfig 校验并填充默认值
 * - provide：向宿主声明本插件提供的服务（供加载器诊断，不改变运行时行为）
 */
declare const pluginEntry: typeof apply & {
  name: string;
  Config: typeof Config;
  provide: string[];
};
//#endregion
export { AbstractSkillEntry, AbstractionConfig, AbstractionEngine, AbstractionStats, AccountId, ActionResult, ActiveTask, AdjustmentKnob, AdjustmentReport, AgentBase, AgentGoal, AgentKind, AgentMeta, AgentMode, AgentProposal, AgentReputation, AliasMap, AppError, ArbitrationResult, ArmStats, ArrivalPrediction, ArrivalStats, AssetKind, AuditEntry, AutonomyLoop, AutonomyLoopConfig, BASELINE_POLICY_PARAMS, BAYES_PRIOR_STRENGTH, BELIEF_POOL, type BackoffConfig, BayesianEstimate, BeliefAsset, BeliefMarket, BeliefMarketConfig, BeliefOutcome, BeliefPosition, type SettlementReport as BeliefSettlementReport, BeliefStatus, BeliefView, BenchmarkEngine, BenchmarkReport, BenchmarkResult, BenchmarkScenario, BenchmarkStats, BetReceipt, BidOrder, type BreakerProbe, type BreakerState, type BreakerStatus, BuiltinScenarioContext, CHANNEL_GROUPS, CalibrationRecord, CalibrationStatus, CanaryState, CancelReport, CascadeHandler, CausalEdge, CausalEdgeEvidence, CausalEffect, CausalExperiment, CausalExplorationRecord, CausalKernel, CausalKernelConfig, CausalNode, CausalNodeKind, CausalQuestion, ChangeEntry, ChangePayload, ChannelGroup, ChatMessage, ChatOptions, CircuitBreaker, type CircuitBreakerConfig, CircuitBreakerInfo, CircuitBreakerRegistry, CircuitState, ClusterNodeConfig, ClusterStatus, CognitiveEconomy, CognitiveMarket, Config, ConfigError, ConsensusLogEntry, ContributorProb, CounterfactualInsight, CryptoEngine, CryptoError, CryptoResult, CuriosityEngine, CuriosityEngineConfig, DECAY_HALF_LIFE_DAYS, DEFAULT_ABSTRACTION_CONFIG, DEFAULT_AUTONOMY_LOOP_CONFIG, DEFAULT_BACKOFF_CONFIG, DEFAULT_CAUSAL_CONFIG, DEFAULT_CIRCUIT_BREAKER_CONFIG, DEFAULT_CURIOSITY_CONFIG, DEFAULT_DECISION_ENGINE_CONFIG, DEFAULT_DELIBERATION_CONFIG, DEFAULT_FREE_ENERGY_CONFIG, DEFAULT_GOAL_ENGINE_CONFIG, DEFAULT_LLM_CLIENT_CONFIG, DEFAULT_METAREASONING_CONFIG, DEFAULT_META_COGNITION_CONFIG, DEFAULT_REFLECTION_CONFIG, DEFAULT_SAFETY_GOVERNOR_CONFIG, DEFAULT_SCIENTIST_CONFIG, DEFAULT_STRATEGY_EVOLUTION_CONFIG, DEFAULT_THEORIST_CONFIG, DEFAULT_WORLD_MODEL_CONFIG, Decision, DecisionAction, DecisionAuditEntry, DecisionEngine, DecisionEngineConfig, DecisionEngineStats, DecisionFeedback, DecisionInsightRecord, DecisionMode, DeliberationConfig, DeliberationEngine, DeliberationResult, type SettlementReport$1 as DeliberationSettlementReport, SettlementReport$1 as SettlementReport, DesignedExperiment, DistillationReport, DistilledStrategy, DistributedSync, DistributionReport, EFEAction, EFEEvaluation, ESCROW, EVIDENCE_MIN_SAMPLES, EVIDENCE_RANK_BLEND, EncryptedField, EncryptedFile, EncryptionConfig, EnergyLedger, EnergySankeyReport, EnergyTransfer, type ErrorClassification, EvaluationReport, EvidenceCensus, EvidenceCensusLayer, type EvidenceView, EvolutionCycleOutcome, EvolutionCycleReport, EvolutionReport, EvolutionStatusReport, EvolverAgent, EvolverAgentConfig, EvolverEfficiencySummary, EvolverMetrics, ExecutionError, ExecutionGrant, ExecutionPlan, ExperienceLookup, ExperimentLedgerEntry, ExplorationDispatcher, ExplorationProposal, ExplorationRecord, ExportOptions, FailureRecord, FreeEnergyConfig, FreeEnergyEngine, Goal, GoalDecomposer, GoalEngine, GoalEngineConfig, GoalStatus, GoalSubtask, GovernanceAuditEntry, GovernanceGate, GovernanceVerdict, GovernedAction, GovernorPersistState, GrantOutcome, Habit, HealthReport, HierarchicalPrior, HomeostasisBands, HomeostasisStatus, HotReloadConfig, HotReloadEngine, HotReloadEvent, HotReloadStatus, IAgent, IMemoryStore, IMetaCognitiveController, INCINERATOR, IOptimizer, IPolicyEvolver, IReflector, ISandbox, ISelfModel, ImaginationReport, ImprovementEvidence, Insight, InterventionRecord, JsonMemoryBackend, JudgeMetric, JudgeModel, KnobEffectiveness, KnowledgeAsset, KnowledgeFrontier, KnowledgeGap, KnowledgeProvider, KpiAnomaly, KpiCollector, KpiSnapshot, LEGACY_EVIDENCE_DISCOUNT, LLMClient, LLMClientConfig, LLMError, LLMResponse, LedgerConfig, LedgerSnapshot, LedgerStats, Lesson, LessonExtractor, LessonProvider, ListError, ListingView, LongTermMemory, MAX_POLICY_RULES, MIN_CALIBRATION_SAMPLES, ManagedAgent, MarketConfig, MarketSnapshot, MemoryAgent, MemoryAgentConfig, MemoryBackend, MemoryCondition, MemoryEdge, MemoryError, type MemoryEvidence, MemoryGraph, MemoryLayer, MemoryMaintainer, MemoryMatchContext, MemoryMetrics, MemoryNode, MemoryQualitySummary, MemorySearchHit, MemoryStore, MentalReport, MergeStrategy, MetaCognitionBridge, MetaCognitionConfig, MetaCognitionEngine, MetaCognitiveController, MetaControllerConfig, MetaControllerState, MetaDecision, MetaStabilitySummary, MetareasoningConfig, MetricForecast, MigrationConflict, MigrationPackage, MigrationRecordVersion, MigrationReport, MigrationTool, ModelAgent, ModelConfig, ModelLongTermProfile, ModelRuntimeStatus, ModelScheduler, ModelSchedulerConfig, ModelScoreInput, ModelTaskStats, NetworkError, NodeResult, NodeRole, NodeRunner, OperationalMetrics, Optimizer, OptimizerAgent, OptimizerAgentConfig, OptimizerConfig, POLICY_GENE_BOUNDS, POLICY_RULE_DELTA_BOUNDS, Perception, PerformanceThreshold, PlanExecutionResult, PlanNode, PluginVersion, Policy, PolicyEvaluationMetrics, PolicyEvolutionBridge, PolicyEvolver, PolicyEvolverConfig, PolicyEvolverStatus, PolicyFitness, PolicyMatchContext, PolicyRule, PolicySimulator, ProactiveRisk, ProceduralAction, ProceduralCondition, ProceduralConditionDimension, ProceduralMemory, ProgressBroadcaster, ProgressEvent, ProposalKind, QualityTrendPoint, RaftConfig, RaftEngine, RationalMetareasoner, RecommendedAdjustment, RecordDecisionFeedbackParams, RecordFailureParams, RecordSuccessParams, ReflectionEngine, ReflectionEngineConfig, ReflectionVerdict, Reflector, ReflectorConfig, ReputationTier, type RetryClass, RollbackResult, RootCauseCategory, RoyaltyPayout, SIGNAL_GLOBAL_SUCCESS, SIGNAL_GLOBAL_SUCCESS_ALIAS, SafeEnvelopeInfo, SafetyGovernor, SafetyGovernorConfig, Sandbox, SandboxConfig, SandboxTask, SankeyLink, SankeyNode, SankeyTotals, ScalarGeneKey, SchedulerConfig, SchedulerPolicyParams, SchedulerService, SchedulerTaskContext, SchedulingInsight, ScientistConfig, ScientistMind, SelfModel, SelfModelCollectors, SelfModelConfig, SemanticConclusion, SemanticCondition, SemanticConditionDimension, SemanticMemory, Sentinel, SentinelConfig, SentinelStatus, Signal, SignalBatch, SignalEnrichment, SignalHistoryStats, SignalSourceConfig, SimCalibration, SimCalibrationEntry, SimModelStatus, Skill, SqliteMemoryBackend, StepEvaluation, StrategistVerdict, StrategyApplier, StrategyEvolutionConfig, StrategyEvolutionEngine, StrategyGenes, StrategyGenome, StrategyPerformanceSummary, SubtaskDispatcher, SuccessfulPlanRecord, SymbiosisBridge, SymbiosisBridgeConfig, SymbiosisBridgeHook, SymbiosisConfig, SymbiosisRuntime, SymbiosisTickReport, SyncBatch, SyncConflict, SyncLogEntry, SyncNodeConfig, SyncState, SystemMetrics, SystemStabilitySummary, TREASURY, TaskExecutor, TaskExecutorConfig, TaskPatternMemory, TenantConfig, TenantManager, TenantRegistry, TenantRuntime, TheoristConfig, TheoristEngine, Theory, TheoryFrontier, TheoryMember, TheoryPrediction, TickReport, TimeoutError, ToolDefinition, ToolError, ToolRegistry, TopicNode, TradeListener, TradeRecord, TransferError, TransferReceipt, TransitionPosterior, TrendMetric, TrendSummary, TuningAction, TypeCorrelation, VariationalReport, WorldModel, WorldModelConfig, WorldModelSummary, abortableSleep, apply, attachDashboard, backoffDelayMs, bernoulliKL, betaEntropy, buildCalibrationFromMemory, buildEnergySankey, buildPatternFingerprint, classifyError, coalitionValue, computeHomeostasis, cosineSimilarity, createBaselinePolicy, createMemoryBackend, decayFactor, decompose, pluginEntry as default, digamma, emptyMemoryStore, evaluateMemoryCondition, evidenceRankScore, extractReplayTasks, generateAdversarialTasks, initEvidence, isTradeListener, lessonsToInsights, listingsOf, lnGamma, matchesMemoryConditions, modelAgentId, modelSignalKey, name, normalizePolicyParams, observeEvidence, parseJSONLoose, policyParamsWithinBounds, policyRuleMatches, readEvidence, renderSankeyHtml, resolveEffectiveParams, sampleBeta, sanitizeMemoryStore, scoreModelWithPolicy, segment, setChineseTokenizer, shapleyValues, sqliteAvailable, sqlitePathFor, toSparseVector, tokenizeChinese, wilsonLowerBound };