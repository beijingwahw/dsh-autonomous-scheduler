/**
 * long-term-memory.ts — 跨会话长期记忆引擎（基础层）
 *
 * 职责：
 * - 任务模式记忆（TaskPatternMemory）：相似任务的成功方案沉淀与检索
 * - 模型长期画像（ModelLongTermProfile）：按任务类型统计成功率/延迟/质量/成本
 * - 决策反馈（DecisionFeedback）：信号决策的结果复盘与经验教训
 * - 全局统计（globalStats）：执行总量、成功率、token 消耗、成本估算
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 模糊经验匹配：findPattern 不再要求指纹精确命中，而是按
 *    taskType 相似度 + complexity 距离 + features 重叠度加权打分，
 *    返回置信度最高的模式（含最低相似度门槛）
 * 2. 防抖持久化 + 原子写入 + 进程退出兜底 flush，杜绝记忆丢失
 * 3. 与 CryptoEngine 无缝集成，持久化形态自动适配加密配置
 * 4. 模型画像自动推导 bestTaskType / worstTaskType / stability
 * 5. 模式置信度动态演化：成功加分、失败扣分，衰减由频率驱动
 * 6. 对冲机制（防止"越学越错"，缺一不可）：
 *    - 遗忘曲线（applyForgettingCurve）：幂等衰减，以 lastDecayAt 为基准，
 *      多次维护调用不复合叠加；长期未用模式降置信直至彻底遗忘
 *    - 置信度衰减：覆盖任务模式与蒸馏策略两类记忆（策略以 lastAppliedAt 为基准），
 *      长期未被应用/验证的策略同样衰减直至清除
 *    - 阈值自校准：委托反思引擎（reflection-engine.calibrateThreshold），
 *      质量分布偏高收紧、偏低放宽，避免无效重试风暴
 */

import fs from 'node:fs';
import type { CryptoEngine } from '../security/crypto-engine.js';
import { createMemoryBackend, sanitizeMemoryStore } from './backend.js';
import type { MemoryBackend } from './backend.js';
import type { IMemoryStore } from '../contracts.js';
import { BAYES_PRIOR_STRENGTH, DECAY_HALF_LIFE_DAYS, LEGACY_EVIDENCE_DISCOUNT, type MemoryEvidence, evidenceRankScore, initEvidence, observeEvidence, readEvidence, wilsonLowerBound } from '../core/evidence.js';

// 3.0：统计内核迁至 core/evidence.ts（全层共享），此处再导出保持既有导入路径兼容
export { wilsonLowerBound, DECAY_HALF_LIFE_DAYS, BAYES_PRIOR_STRENGTH } from '../core/evidence.js';

/** 成功执行记录 */
export interface SuccessfulPlanRecord {
  timestamp: number;
  plan: {
    objective: string;
    nodes: Array<{ id: string; description: string; type: string; dependsOn: string[] }>;
    parallelismStrategy: string;
  };
  modelAssignments: Record<string, string>;
  totalLatency: number;
  qualityScores: Record<string, number>;
  tokenCost: number;
}

/** 失败记录 */
export interface FailureRecord {
  timestamp: number;
  reason: string;
  failedNodeId: string;
  failedModelId: string;
  errorMessage: string;
}

/** 任务模式记忆 */
export interface TaskPatternMemory {
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
export interface ModelTaskStats {
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
export interface ModelLongTermProfile {
  id: string;
  name: string;
  taskHistory: Record<string, ModelTaskStats>;
  costEfficiency: Record<string, number>;
  bestTaskType: string;
  worstTaskType: string;
  stability: number;
}

/** 决策反馈 */
export interface DecisionFeedback {
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
export interface BayesianEstimate {
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
export interface DistilledStrategy {
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

// ─────────────────────────── 三层记忆扩展（第二阶段） ───────────────────────────
//
// 第二阶段在情景记忆（TaskPatternMemory / DecisionFeedback）之上新增两层抽象记忆：
// - 语义记忆（SemanticMemory）：从情景记忆抽象出的跨任务规律
// - 程序记忆（ProceduralMemory）：带触发条件的可执行 if-then 规则
//
// 与既有 DistilledStrategy 共存而非替换：
// DistilledStrategy 仍是面向"模型偏好 / 并行策略"的轻量规则，被同步变更登记、
// 反馈闭环等已验证链路消费；程序记忆承载更丰富的条件+动作结构（启用思维链、
// 避免某模型、参数微调等），供优化器在 lookupExperience 中按条件匹配优先采纳。

/** 语义记忆条件维度 */
export type SemanticConditionDimension = 'task-type' | 'feature' | 'complexity' | 'length' | 'token-cost';

/** 语义记忆条件（与程序记忆条件结构一致，类型独立以便演进） */
export interface SemanticCondition {
  dimension: SemanticConditionDimension;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}

/** 语义记忆结论 */
export interface SemanticConclusion {
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
export interface SemanticMemory {
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
export type ProceduralConditionDimension =
  | 'task-type'
  | 'feature'
  | 'complexity'
  | 'length'
  | 'token-cost'
  | 'outcome'
  | 'root-cause';

/** 程序记忆条件 */
export interface ProceduralCondition {
  dimension: ProceduralConditionDimension;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}

/** 程序记忆动作 */
export interface ProceduralAction {
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
export interface ProceduralMemory {
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
export interface DistillationReport {
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
  // ── 第二阶段升级：增量蒸馏与证据合并可观测性 ──
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
export interface MemoryStore {
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
export interface RecordSuccessParams {
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
export interface RecordFailureParams {
  taskType: string;
  complexity: number;
  features: string[];
  reason: string;
  failedNodeId: string;
  failedModelId: string;
  errorMessage: string;
}

/** 决策反馈记录参数（IMemoryStore 契约） */
export interface RecordDecisionFeedbackParams {
  signalType: string;
  signalDescription: string;
  decision: string;
  outcome: DecisionFeedback['outcome'];
  outcomeReason: string;
  lesson?: string;
}

/** outcome → 数值映射（用于决策成功率统计） */
const OUTCOME_SCORE: Record<DecisionFeedback['outcome'], number> = {
  excellent: 1.0,
  good: 0.8,
  acceptable: 0.6,
  poor: 0.3,
  failed: 0,
};

/** 任务模式指纹（taskType + complexity 分桶 + 特征排序，全组件统一约定） */
export function buildPatternFingerprint(taskType: string, complexity: number, features: string[]): string {
  const bucket = Math.round(complexity * 10) / 10;
  return `${taskType}::${bucket}::${[...features].sort().join(',')}`;
}

// ───────────────────── 第二阶段升级：可复用的条件求值与签名工具（纯函数） ─────────────────────
//
// 语义记忆与程序记忆共享同一套条件求值语义（合取 + 保守缺省）。
// 导出为纯函数供优化器（optimizer.ts）在检索多条程序记忆时复用，
// 避免在 IMemoryStore 之外重复实现一套有漂移风险的匹配逻辑。

/** 条件匹配上下文（语义/程序记忆共用；outcome 与 rootCause 仅程序记忆使用） */
export interface MemoryMatchContext {
  features?: string[];
  complexity?: number;
  length?: number;
  tokenCost?: number;
  outcome?: string;
  rootCause?: string;
}

/** 单条件结构（SemanticCondition / ProceduralCondition 的公共形状） */
export interface MemoryCondition {
  dimension: string;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}

/** 条件维度 → 上下文取值（未知维度返回 undefined，保守不命中） */
function conditionValueOf(dimension: string, taskType: string, context: MemoryMatchContext): string | number | string[] | undefined {
  switch (dimension) {
    case 'task-type':
      return taskType;
    case 'feature':
      return context.features;
    case 'complexity':
      return context.complexity;
    case 'length':
      return context.length;
    case 'token-cost':
      return context.tokenCost;
    case 'outcome':
      return context.outcome;
    case 'root-cause':
      return context.rootCause;
    default:
      return undefined;
  }
}

/** 单条件求值（actual 未知时除空值场景外均不命中） */
export function evaluateMemoryCondition(
  actual: string | number | string[] | undefined,
  operator: MemoryCondition['operator'],
  expected: string | number | string[],
): boolean {
  if (actual === undefined) return false;
  switch (operator) {
    case 'eq':
      return actual === expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.includes(String(expected));
      return false;
    case 'in':
      if (Array.isArray(expected)) {
        if (Array.isArray(actual)) return actual.some((a) => expected.includes(a));
        return expected.includes(String(actual));
      }
      return false;
    default:
      return false;
  }
}

/** 合取条件匹配：全部条件满足才返回 true（供优化器检索复用） */
export function matchesMemoryConditions(conditions: MemoryCondition[], taskType: string, context: MemoryMatchContext): boolean {
  for (const cond of conditions) {
    const actual = conditionValueOf(cond.dimension, taskType, context);
    if (!evaluateMemoryCondition(actual, cond.operator, cond.value)) return false;
  }
  return true;
}

/** 条件列表 → 归一化签名（排序后拼接，维度无关顺序） */
function conditionSignature(conditions: MemoryCondition[]): string {
  return conditions
    .map((c) => `${c.dimension}:${c.operator}:${Array.isArray(c.value) ? [...c.value].sort().join('|') : String(c.value)}`)
    .sort()
    .join('&');
}

/** 语义记忆结构签名（domain + 结论类型 + 条件）：签名相同且结论值不同 → 规律冲突 */
function semanticSignature(m: SemanticMemory): string {
  return `${m.domain}|${m.conclusion.type}|${conditionSignature(m.conditions)}`;
}

/** 模糊匹配最低相似度门槛 */
const MIN_SIMILARITY = 0.4;
/** 持久化防抖窗口（毫秒） */
const PERSIST_DEBOUNCE_MS = 500;
/** 单个模式保留的成功方案上限（保留质量最高者） */
const MAX_SUCCESSFUL_PLANS = 20;
/** 单个模式保留的失败记录上限 */
const MAX_FAILURE_RECORDS = 20;

/** 证据普查单层统计（3.0：自知之明报告的原料） */
export interface EvidenceCensusLayer {
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
export interface EvidenceCensus {
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
export class LongTermMemory implements IMemoryStore {
  private persistPath: string;
  private backend: MemoryBackend;
  private store: MemoryStore;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private flushOnExit: () => void;

  // ── 3.0：主键索引（热路径 O(n) → O(1)）──
  private idxPattern = new Map<string, TaskPatternMemory>();
  private idxProfile = new Map<string, ModelLongTermProfile>();
  private idxStrategy = new Map<string, DistilledStrategy>();
  private idxStrategyDesc = new Map<string, DistilledStrategy>();
  private idxSemantic = new Map<string, SemanticMemory>();
  private idxSemanticStatement = new Map<string, SemanticMemory>();
  private idxProcedural = new Map<string, ProceduralMemory>();
  private idxProceduralName = new Map<string, ProceduralMemory>();
  private idxFeedbackId = new Set<string>();

  /** 从 store 全量重建索引（构造载入 / 批量过滤后调用） */
  private reindex(): void {
    this.idxPattern = new Map(this.store.taskPatterns.map((p) => [p.fingerprint, p]));
    this.idxProfile = new Map(this.store.modelProfiles.map((p) => [p.id, p]));
    this.idxStrategy = new Map(this.store.distilledStrategies.map((s) => [s.id, s]));
    this.idxStrategyDesc = new Map(this.store.distilledStrategies.map((s) => [s.description, s]));
    this.idxSemantic = new Map(this.store.semanticMemories.map((m) => [m.id, m]));
    this.idxSemanticStatement = new Map(this.store.semanticMemories.map((m) => [m.statement, m]));
    this.idxProcedural = new Map(this.store.proceduralMemories.map((p) => [p.id, p]));
    this.idxProceduralName = new Map(this.store.proceduralMemories.map((p) => [p.name, p]));
    this.idxFeedbackId = new Set(this.store.decisionFeedback.map((f) => f.id));
  }

  /** 当前持久化后端类型（sqlite / json） */
  get backendKind(): 'sqlite' | 'json' {
    return this.backend.kind;
  }

  /**
   * @param persistPath 持久化文件路径（如 .scheduler/memory.json；SQLite 后端自动映射为 .db）
   * @param cryptoEngine 可选加密引擎，提供后持久化自动适配加密配置（走 JSON 后端）
   */
  constructor(persistPath: string, cryptoEngine?: CryptoEngine) {
    this.persistPath = persistPath;
    this.backend = createMemoryBackend(persistPath, cryptoEngine);
    // 旧版 JSON 记忆 → SQLite 一次性迁移（仅无加密且后端为 sqlite 时）
    if (this.backend.kind === 'sqlite' && fs.existsSync(persistPath)) {
      try {
        const legacy = sanitizeMemoryStore(JSON.parse(fs.readFileSync(persistPath, 'utf-8')));
        this.backend.save(legacy);
        fs.renameSync(persistPath, `${persistPath}.migrated`);
      } catch {
        /* 旧文件损坏则跳过迁移，从空库开始 */
      }
    }
    this.store = this.backend.load();
    this.reindex();
    // 进程退出兜底：确保未落盘的脏数据不丢失
    this.flushOnExit = () => this.flushSync();
    process.once('beforeExit', this.flushOnExit);
  }

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
  findPattern(taskType: string, complexity: number, features: string[] = []): TaskPatternMemory | undefined {
    let best: TaskPatternMemory | undefined;
    let bestScore = 0;
    for (const pattern of this.store.taskPatterns) {
      const score = this.similarity(pattern, taskType, complexity, features);
      if (score > bestScore) {
        bestScore = score;
        best = pattern;
      }
    }
    return bestScore >= MIN_SIMILARITY ? best : undefined;
  }

  /**
   * 记录一次成功执行：沉淀任务模式 + 更新模型画像 + 全局统计
   */
  recordSuccess(params: RecordSuccessParams): void {
    const now = Date.now();
    const fingerprint = this.buildFingerprint(params.taskType, params.complexity, params.features);
    let pattern = this.idxPattern.get(fingerprint);

    if (!pattern) {
      pattern = {
        fingerprint,
        taskSummary: params.taskSummary,
        frequency: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        successfulPlans: [],
        failureRecords: [],
        confidence: 0.5,
        avgExecutionTime: 0,
        avgQualityScore: 0,
      };
      this.store.taskPatterns.push(pattern);
      this.idxPattern.set(fingerprint, pattern);
    }

    // 更新模式统计
    pattern.frequency += 1;
    pattern.lastSeenAt = now;
    const record: SuccessfulPlanRecord = {
      timestamp: now,
      plan: params.plan,
      modelAssignments: params.modelAssignments,
      totalLatency: params.totalLatency,
      qualityScores: params.qualityScores,
      tokenCost: params.tokenCost,
    };
    pattern.successfulPlans.push(record);
    // 按质量保留 Top N
    if (pattern.successfulPlans.length > MAX_SUCCESSFUL_PLANS) {
      pattern.successfulPlans.sort((a, b) => this.avgQuality(b.qualityScores) - this.avgQuality(a.qualityScores));
      pattern.successfulPlans = pattern.successfulPlans.slice(0, MAX_SUCCESSFUL_PLANS);
    }
    // 置信度演化：成功 +0.05，上限 0.99
    pattern.confidence = Math.min(0.99, pattern.confidence + 0.05);
    pattern.avgExecutionTime = this.avg(pattern.successfulPlans.map((p) => p.totalLatency));
    pattern.avgQualityScore = this.avg(pattern.successfulPlans.map((p) => this.avgQuality(p.qualityScores)));
    // 最佳模型组合 = 最近一次成功方案的分配
    pattern.bestModelCombination = { ...params.modelAssignments };

    // 更新模型画像
    const qualityValues = Object.values(params.qualityScores);
    for (const [nodeId, modelId] of Object.entries(params.modelAssignments)) {
      const quality = params.qualityScores[nodeId] ?? this.avgQuality(params.qualityScores);
      this.updateModelProfile(modelId, params.taskType, true, params.totalLatency, quality, params.tokenCost);
    }
    void qualityValues;

    // 全局统计
    const stats = this.store.globalStats;
    stats.totalExecutions += 1;
    stats.totalSuccesses += 1;
    stats.totalTokensUsed += params.tokenCost;
    stats.totalCostEstimate += params.tokenCost * 0.001; // 粗估：token → 成本系数
    stats.averageQualityScore = this.rollingAvg(stats.averageQualityScore, this.avgQuality(params.qualityScores), stats.totalSuccesses);
    stats.averageExecutionTime = this.rollingAvg(stats.averageExecutionTime, params.totalLatency, stats.totalSuccesses);

    this.schedulePersist();
  }

  /**
   * 记录一次失败执行
   */
  recordFailure(params: RecordFailureParams): void {
    const now = Date.now();
    const fingerprint = this.buildFingerprint(params.taskType, params.complexity, params.features);
    let pattern = this.idxPattern.get(fingerprint);

    if (!pattern) {
      pattern = {
        fingerprint,
        taskSummary: `[失败] ${params.taskType}: ${params.reason}`,
        frequency: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        successfulPlans: [],
        failureRecords: [],
        confidence: 0.5,
        avgExecutionTime: 0,
        avgQualityScore: 0,
      };
      this.store.taskPatterns.push(pattern);
      this.idxPattern.set(fingerprint, pattern);
    }

    pattern.frequency += 1;
    pattern.lastSeenAt = now;
    pattern.failureRecords.push({
      timestamp: now,
      reason: params.reason,
      failedNodeId: params.failedNodeId,
      failedModelId: params.failedModelId,
      errorMessage: params.errorMessage,
    });
    if (pattern.failureRecords.length > MAX_FAILURE_RECORDS) {
      pattern.failureRecords = pattern.failureRecords.slice(-MAX_FAILURE_RECORDS);
    }
    // 置信度演化：失败 -0.08，下限 0.01
    pattern.confidence = Math.max(0.01, pattern.confidence - 0.08);

    // 失败模型画像
    this.updateModelProfile(params.failedModelId, params.taskType, false, 0, 0, 0);

    // 全局统计
    this.store.globalStats.totalExecutions += 1;
    this.store.globalStats.totalFailures += 1;

    this.schedulePersist();
  }

  /**
   * 记录一次决策反馈（execute/defer/dismiss/ask-user 的结果复盘）
   */
  recordDecisionFeedback(params: RecordDecisionFeedbackParams): void {
    const feedback: DecisionFeedback = {
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...params,
    };
    this.store.decisionFeedback.push(feedback);
    this.idxFeedbackId.add(feedback.id);
    // 反馈记录上限 500 条，FIFO
    if (this.store.decisionFeedback.length > 500) {
      this.store.decisionFeedback = this.store.decisionFeedback.slice(-500);
      this.idxFeedbackId = new Set(this.store.decisionFeedback.map((f) => f.id));
    }
    this.schedulePersist();
  }

  /** 获取全局统计 */
  getGlobalStats(): MemoryStore['globalStats'] {
    return { ...this.store.globalStats };
  }

  /**
   * 获取置信度最高的任务模式
   * @param limit 返回数量上限，默认 10
   */
  getTopPatterns(limit = 10): TaskPatternMemory[] {
    return [...this.store.taskPatterns]
      .sort((a, b) => b.confidence - a.confidence || b.frequency - a.frequency)
      .slice(0, limit);
  }

  /** 获取指定模型画像 */
  getModelProfile(modelId: string): ModelLongTermProfile | undefined {
    return this.idxProfile.get(modelId);
  }

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
  getBayesianEstimate(modelId: string, taskType: string): BayesianEstimate | undefined {
    const profile = this.idxProfile.get(modelId);
    const history = profile?.taskHistory[taskType];
    if (!profile || !history) return undefined;

    // 旧格式回退：加权字段缺失时按裸计数估算（无法追溯证据时间，保守以 0.5 折价）
    const legacy = history.weightedSuccesses === undefined || history.weightedFailures === undefined;
    const rawWs = history.weightedSuccesses ?? history.successCount;
    const rawWf = history.weightedFailures ?? history.totalCalls - history.successCount;
    const legacyDiscount = legacy ? 0.5 : 1;
    const ws = rawWs * legacyDiscount;
    const wf = rawWf * legacyDiscount;

    const alpha = ws + BAYES_PRIOR_STRENGTH;
    const beta = wf + BAYES_PRIOR_STRENGTH;
    const posteriorMean = alpha / (alpha + beta);
    const effectiveSamples = ws + wf;
    const rawSuccessRate = history.totalCalls > 0 ? history.successCount / history.totalCalls : 0;
    const weightedRate = effectiveSamples > 0 ? ws / effectiveSamples : 0;
    // 读取时同样应用惰性衰减（距上次衰减基准的流逝时间），保证漂移感知的时效性
    const elapsedSinceDecay = Math.max(0, Date.now() - (history.lastDecayedAt ?? history.lastCalledAt ?? Date.now()));
    const readDecay = Math.pow(0.5, elapsedSinceDecay / (DECAY_HALF_LIFE_DAYS * 86_400_000));
    const decayedSamples = effectiveSamples * readDecay;

    return {
      modelId,
      taskType,
      alpha: Number(alpha.toFixed(6)),
      beta: Number(beta.toFixed(6)),
      posteriorMean: Number(posteriorMean.toFixed(6)),
      wilsonLower: Number(wilsonLowerBound(ws, wf).toFixed(6)),
      effectiveSamples: Number(decayedSamples.toFixed(6)),
      rawSuccessRate: Number(rawSuccessRate.toFixed(6)),
      drift: effectiveSamples >= 2 ? Number((weightedRate - rawSuccessRate).toFixed(6)) : 0,
      emaQuality: history.emaQuality ?? 0,
    };
  }

  /** 获取全部模型画像 */
  getAllModelProfiles(): ModelLongTermProfile[] {
    return [...this.store.modelProfiles];
  }

  /** 获取全部任务模式（迁移导出用） */
  getAllTaskPatterns(): TaskPatternMemory[] {
    return [...this.store.taskPatterns];
  }

  /** 获取全部决策反馈（迁移导出用） */
  getAllDecisionFeedback(): DecisionFeedback[] {
    return [...this.store.decisionFeedback];
  }

  /**
   * 插入或更新任务模式（迁移导入用）
   * @returns 'created' 新增 / 'updated' 覆盖
   */
  upsertPattern(pattern: TaskPatternMemory): 'created' | 'updated' {
    const index = this.store.taskPatterns.findIndex((p) => p.fingerprint === pattern.fingerprint);
    if (index >= 0) {
      this.store.taskPatterns[index] = pattern;
      this.idxPattern.set(pattern.fingerprint, pattern);
      this.schedulePersist();
      return 'updated';
    }
    this.store.taskPatterns.push(pattern);
    this.idxPattern.set(pattern.fingerprint, pattern);
    this.schedulePersist();
    return 'created';
  }

  /**
   * 按指纹删除任务模式（分布式同步 pattern-deleted 变更用）
   * @returns 是否实际删除
   */
  removePattern(fingerprint: string): boolean {
    const index = this.store.taskPatterns.findIndex((p) => p.fingerprint === fingerprint);
    if (index < 0) return false;
    this.store.taskPatterns.splice(index, 1);
    this.idxPattern.delete(fingerprint);
    this.schedulePersist();
    return true;
  }

  /**
   * 插入或更新模型画像（迁移导入用）
   * @returns 'created' 新增 / 'updated' 覆盖
   */
  upsertModelProfile(profile: ModelLongTermProfile): 'created' | 'updated' {
    const index = this.store.modelProfiles.findIndex((p) => p.id === profile.id);
    if (index >= 0) {
      this.store.modelProfiles[index] = profile;
      this.idxProfile.set(profile.id, profile);
      this.schedulePersist();
      return 'updated';
    }
    this.store.modelProfiles.push(profile);
    this.idxProfile.set(profile.id, profile);
    this.schedulePersist();
    return 'created';
  }

  /**
   * 追加一条决策反馈（迁移导入用，按 id 去重）
   * @returns 是否实际写入（重复 id 返回 false）
   */
  appendFeedback(feedback: DecisionFeedback): boolean {
    if (this.idxFeedbackId.has(feedback.id)) {
      return false;
    }
    this.store.decisionFeedback.push(feedback);
    this.idxFeedbackId.add(feedback.id);
    this.schedulePersist();
    return true;
  }

  /**
   * 累加式合并全局统计（迁移导入用）
   * 计数类字段相加，均值类字段按执行次数加权平均
   */
  mergeGlobalStats(incoming: MemoryStore['globalStats']): void {
    const local = this.store.globalStats;
    const totalExec = local.totalExecutions + incoming.totalExecutions;
    const totalSucc = local.totalSuccesses + incoming.totalSuccesses;
    const mergedAvg = (a: number, aWeight: number, b: number, bWeight: number): number => {
      const w = aWeight + bWeight;
      return w > 0 ? (a * aWeight + b * bWeight) / w : 0;
    };
    local.averageQualityScore = mergedAvg(
      local.averageQualityScore,
      local.totalSuccesses,
      incoming.averageQualityScore,
      incoming.totalSuccesses,
    );
    local.averageExecutionTime = mergedAvg(
      local.averageExecutionTime,
      local.totalExecutions,
      incoming.averageExecutionTime,
      incoming.totalExecutions,
    );
    local.totalExecutions = totalExec;
    local.totalSuccesses = totalSucc;
    local.totalFailures += incoming.totalFailures;
    local.totalTokensUsed += incoming.totalTokensUsed;
    local.totalCostEstimate += incoming.totalCostEstimate;
    this.schedulePersist();
  }

  /**
   * 获取最近的决策反馈
   * @param limit 返回数量上限，默认 20
   */
  getRecentFeedback(limit = 20): DecisionFeedback[] {
    return this.store.decisionFeedback.slice(-limit).reverse();
  }

  /**
   * 统计某类信号的决策成功率
   * @param signalType 信号类型
   */
  getDecisionSuccessRate(signalType: string): { total: number; successRate: number; avgOutcome: string } {
    const relevant = this.store.decisionFeedback.filter((f) => f.signalType === signalType);
    if (relevant.length === 0) {
      return { total: 0, successRate: 0, avgOutcome: 'n/a' };
    }
    const scores = relevant.map((f) => OUTCOME_SCORE[f.outcome]);
    const avgScore = this.avg(scores);
    const successRate = scores.filter((s) => s >= 0.6).length / scores.length;
    // 反查最接近平均分的 outcome 名称
    const avgOutcome = (Object.entries(OUTCOME_SCORE) as Array<[DecisionFeedback['outcome'], number]>)
      .sort((a, b) => Math.abs(a[1] - avgScore) - Math.abs(b[1] - avgScore))[0]![0];
    return { total: relevant.length, successRate, avgOutcome };
  }

  /**
   * 生成记忆库人类可读摘要（供 query_memory Tool 使用）
   */
  getMemorySummary(): string {
    const s = this.store.globalStats;
    const successRate = s.totalExecutions > 0 ? ((s.totalSuccesses / s.totalExecutions) * 100).toFixed(1) : '0';
    const topPatterns = this.getTopPatterns(3)
      .map((p) => `  - ${p.taskSummary}（置信度 ${p.confidence.toFixed(2)}，出现 ${p.frequency} 次）`)
      .join('\n');
    const profiles = this.store.modelProfiles
      .map((p) => `  - ${p.id}: 最佳 ${p.bestTaskType || '-'} / 最差 ${p.worstTaskType || '-'} / 稳定性 ${p.stability.toFixed(2)}`)
      .join('\n');
    return [
      `📊 记忆库摘要`,
      `总执行: ${s.totalExecutions} | 成功: ${s.totalSuccesses} | 失败: ${s.totalFailures} | 成功率: ${successRate}%`,
      `总 token: ${s.totalTokensUsed} | 估算成本: ${s.totalCostEstimate.toFixed(4)}`,
      `平均质量分: ${s.averageQualityScore.toFixed(3)} | 平均耗时: ${Math.round(s.averageExecutionTime)}ms`,
      `任务模式数: ${this.store.taskPatterns.length} | 模型画像数: ${this.store.modelProfiles.length} | 决策反馈数: ${this.store.decisionFeedback.length} | 蒸馏策略数: ${this.store.distilledStrategies.length} | 语义记忆数: ${this.store.semanticMemories.length} | 程序记忆数: ${this.store.proceduralMemories.length}`,
      topPatterns ? `Top 任务模式:\n${topPatterns}` : '',
      profiles ? `模型画像:\n${profiles}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 清理过期记忆
   * @param maxAgeDays 最大保留天数，默认 90
   * @returns 被清理的条目数
   */
  prune(maxAgeDays = 90): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    const beforePatterns = this.store.taskPatterns.length;
    this.store.taskPatterns = this.store.taskPatterns.filter((p) => p.lastSeenAt >= cutoff);
    pruned += beforePatterns - this.store.taskPatterns.length;

    const beforeFeedback = this.store.decisionFeedback.length;
    this.store.decisionFeedback = this.store.decisionFeedback.filter((f) => f.timestamp >= cutoff);
    pruned += beforeFeedback - this.store.decisionFeedback.length;

    if (pruned > 0) {
      this.reindex();
      this.schedulePersist();
    }
    return pruned;
  }

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
  distillExperience(minConfidence = 0.6): DistilledStrategy[] {
    const fresh: DistilledStrategy[] = [];
    const now = Date.now();
    /** 策略 id 铸币：同毫秒内多次蒸馏时保证全局唯一（防 memory_vectors ref_id 冲突） */
    const mintStrategyId = (infix: string): string => {
      let seq = this.store.distilledStrategies.length + fresh.length;
      let id = `strategy-${now}-${infix}${seq}`;
      while (this.idxStrategy.has(id) || fresh.some((s) => s.id === id)) {
        seq += 1;
        id = `strategy-${now}-${infix}${seq}`;
      }
      return id;
    };

    for (const pattern of this.store.taskPatterns) {
      if (pattern.confidence < minConfidence || pattern.successfulPlans.length < 3) continue;
      const taskType = pattern.taskSummary.split(':')[0].replace('[失败] ', '').trim() || 'general';

      // ── 规则 1：模型偏好蒸馏 ──
      const modelWins = new Map<string, number>();
      let totalAssignments = 0;
      for (const plan of pattern.successfulPlans) {
        for (const modelId of Object.values(plan.modelAssignments)) {
          modelWins.set(modelId, (modelWins.get(modelId) ?? 0) + 1);
          totalAssignments += 1;
        }
      }
      if (totalAssignments > 0) {
        for (const [modelId, wins] of modelWins) {
          const ratio = wins / totalAssignments;
          if (ratio >= 0.6) {
            const description = `${taskType} 类任务优先使用模型 ${modelId}（成功方案占比 ${(ratio * 100).toFixed(0)}%）`;
            if (!this.hasStrategy(description)) {
              const strategy: DistilledStrategy = {
                id: mintStrategyId(''),
                taskType,
                description,
                sourceFingerprint: pattern.fingerprint,
                supportCount: wins,
                confidence: Math.min(0.95, pattern.confidence * ratio + 0.1),
                distilledAt: now,
                appliedSuccesses: 0,
                appliedTotal: 0,
                // 3.0：蒸馏证据初始化（成功方案占比证据，legacy 折价起步）
                evidence: initEvidence(wins, wins, now),
              };
              this.store.distilledStrategies.push(strategy);
              this.idxStrategy.set(strategy.id, strategy);
              this.idxStrategyDesc.set(strategy.description, strategy);
              fresh.push(strategy);
            }
          }
        }
      }

      // ── 规则 2：并行策略蒸馏 ──
      const strategyCounts = new Map<string, number>();
      for (const plan of pattern.successfulPlans) {
        strategyCounts.set(plan.plan.parallelismStrategy, (strategyCounts.get(plan.plan.parallelismStrategy) ?? 0) + 1);
      }
      let bestStrategy = '';
      let bestCount = 0;
      for (const [strategy, count] of strategyCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestStrategy = strategy;
        }
      }
      if (bestStrategy && bestCount / pattern.successfulPlans.length >= 0.6) {
        const description = `${taskType} 类任务推荐 ${bestStrategy} 并行策略（${bestCount}/${pattern.successfulPlans.length} 次成功）`;
        if (!this.hasStrategy(description)) {
          const strategy: DistilledStrategy = {
            id: mintStrategyId('p'),
            taskType,
            description,
            sourceFingerprint: pattern.fingerprint,
            supportCount: bestCount,
            confidence: Math.min(0.9, pattern.confidence * 0.9),
            distilledAt: now,
            appliedSuccesses: 0,
            appliedTotal: 0,
            // 3.0：蒸馏证据初始化（成功方案数证据，legacy 折价起步）
            evidence: initEvidence(bestCount, bestCount, now),
          };
          this.store.distilledStrategies.push(strategy);
          this.idxStrategy.set(strategy.id, strategy);
          this.idxStrategyDesc.set(strategy.description, strategy);
          fresh.push(strategy);
        }
      }
    }

    if (fresh.length > 0) this.schedulePersist();
    return fresh;
  }

  /**
   * 获取指定任务类型的蒸馏策略（3.0：按证据化排序分降序——confidence × Wilson 下界等权混合）
   * @param taskType 任务类型
   * @param limit 返回上限
   */
  getStrategies(taskType: string, limit = 5): DistilledStrategy[] {
    const now = Date.now();
    return this.store.distilledStrategies
      .filter((s) => s.taskType === taskType)
      .sort((a, b) => evidenceRankScore(b.confidence, b.evidence, now) - evidenceRankScore(a.confidence, a.evidence, now))
      .slice(0, limit);
  }

  /** 全部蒸馏策略 */
  getAllStrategies(): DistilledStrategy[] {
    return [...this.store.distilledStrategies];
  }

  /**
   * 策略应用反馈：更新策略的应用成功率（闭环校准策略置信度）
   *
   * 3.0：同步观测统一证据（时间加权 Beta）——旧实体首次观测时从
   * 裸计数折价初始化，与模型画像 legacy 回退语义一致。
   *
   * @param strategyId 策略 id
   * @param success 本次应用是否成功
   */
  recordStrategyOutcome(strategyId: string, success: boolean): void {
    const strategy = this.idxStrategy.get(strategyId);
    if (!strategy) return;
    const now = Date.now();
    if (!strategy.evidence) strategy.evidence = initEvidence(strategy.appliedSuccesses, strategy.appliedTotal, now);
    strategy.appliedTotal += 1;
    strategy.lastAppliedAt = now;
    if (success) strategy.appliedSuccesses += 1;
    observeEvidence(strategy.evidence, success, now);
    // 应用成功率反向修正置信度（指数加权）
    const appliedRate = strategy.appliedSuccesses / strategy.appliedTotal;
    strategy.confidence = strategy.confidence * 0.7 + appliedRate * 0.3;
    this.schedulePersist();
  }

  // ─────────────────────────── 语义记忆（第二阶段） ───────────────────────────

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
  findSemanticMemory(
    taskType: string,
    context: {
      features?: string[];
      complexity?: number;
      length?: number;
      tokenCost?: number;
    } = {},
  ): SemanticMemory | undefined {
    const now = Date.now();
    const candidates = this.store.semanticMemories.filter((m) => m.taskTypes.length === 0 || m.taskTypes.includes(taskType));
    let best: SemanticMemory | undefined;
    let bestScore = 0;
    for (const mem of candidates) {
      if (!this.matchConditions(mem.conditions, taskType, context)) continue;
      // 3.0 证据化评分：confidence × Wilson 混合分 × supportCount 平滑
      const supportBoost = Math.min(1.5, 1 + Math.log10(1 + mem.supportCount) * 0.15);
      const score = evidenceRankScore(mem.confidence, mem.evidence, now) * supportBoost;
      if (score > bestScore) {
        bestScore = score;
        best = mem;
      }
    }
    return best;
  }

  /** 获取指定任务类型的语义记忆（3.0：按证据化排序分降序） */
  getSemanticMemories(taskType: string, limit = 5): SemanticMemory[] {
    const now = Date.now();
    return this.store.semanticMemories
      .filter((m) => m.taskTypes.length === 0 || m.taskTypes.includes(taskType))
      .sort((a, b) => evidenceRankScore(b.confidence, b.evidence, now) - evidenceRankScore(a.confidence, a.evidence, now))
      .slice(0, limit);
  }

  /** 全部语义记忆 */
  getAllSemanticMemories(): SemanticMemory[] {
    return [...this.store.semanticMemories];
  }

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
  upsertSemanticMemory(memory: SemanticMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded' {
    // ── 1. 冲突消解：同签名不同结论的旧规律 ──
    const signature = semanticSignature(memory);
    const conflicting = this.store.semanticMemories.find(
      (m) =>
        m.id !== memory.id &&
        semanticSignature(m) === signature &&
        m.conclusion.value !== memory.conclusion.value,
    );
    if (conflicting) {
      if (memory.supportCount >= conflicting.supportCount * 1.5 && memory.supportCount >= 3) {
        // 新证据显著更强 → 取代旧规律（保留应用统计以延续反馈闭环）
        const superseded: SemanticMemory = {
          ...memory,
          supportCount: memory.supportCount + conflicting.supportCount,
          sourceFingerprints: [...new Set([...memory.sourceFingerprints, ...conflicting.sourceFingerprints])].slice(0, 50),
          appliedTotal: conflicting.appliedTotal,
          appliedSuccesses: conflicting.appliedSuccesses,
          lastAppliedAt: conflicting.lastAppliedAt,
          evidence: memory.evidence ?? conflicting.evidence, // 3.0：证据随应用统计一并继承
        };
        this.store.semanticMemories[this.store.semanticMemories.indexOf(conflicting)] = superseded;
        this.idxSemantic.delete(conflicting.id);
        this.idxSemanticStatement.delete(conflicting.statement);
        this.idxSemantic.set(superseded.id, superseded);
        this.idxSemanticStatement.set(superseded.statement, superseded);
        this.schedulePersist();
        return 'superseded';
      }
      return 'duplicate'; // 证据不足，保守丢弃新样本
    }

    // ── 2. 证据合并：同 id 或同 statement（3.0 索引化 O(1)） ──
    const existing = this.idxSemantic.get(memory.id) ?? this.idxSemanticStatement.get(memory.statement);
    if (existing && existing.id === memory.id) {
      // 同 id 覆盖（重蒸馏全量重算支撑度）：保留既有应用反馈统计，
      // 避免每次重蒸馏把反馈闭环积累的 appliedTotal/appliedSuccesses 清零
      const replacement: SemanticMemory =
        memory.appliedTotal === 0 && (existing.appliedTotal > 0 || existing.appliedSuccesses > 0)
          ? {
              ...memory,
              appliedTotal: existing.appliedTotal,
              appliedSuccesses: existing.appliedSuccesses,
              lastAppliedAt: existing.lastAppliedAt,
            }
          : memory;
      if (!replacement.evidence && existing.evidence) replacement.evidence = existing.evidence; // 3.0：证据继承
      this.store.semanticMemories[this.store.semanticMemories.indexOf(existing)] = replacement;
      if (existing.statement !== replacement.statement) this.idxSemanticStatement.delete(existing.statement);
      this.idxSemantic.set(replacement.id, replacement);
      this.idxSemanticStatement.set(replacement.statement, replacement);
      this.schedulePersist();
      return 'updated';
    }
    if (existing) {
      const totalSupport = existing.supportCount + memory.supportCount;
      existing.confidence = Math.min(
        0.98,
        (existing.confidence * existing.supportCount + memory.confidence * memory.supportCount) / Math.max(1, totalSupport),
      );
      existing.supportCount = totalSupport;
      existing.sourceFingerprints = [...new Set([...existing.sourceFingerprints, ...memory.sourceFingerprints])].slice(0, 50);
      existing.taskTypes = [...new Set([...existing.taskTypes, ...memory.taskTypes])];
      if (existing.statement !== memory.statement) {
        this.idxSemanticStatement.delete(existing.statement);
        existing.statement = memory.statement; // 陈述刷新为最新占比表述
        this.idxSemanticStatement.set(existing.statement, existing);
      }
      existing.conclusion = memory.conclusion;
      existing.distilledAt = memory.distilledAt;
      existing.lastDecayAt = memory.distilledAt; // 新证据已吸收，闲置计时重置
      // 3.0：证据叠加合并（支撑证据累加，衰减基准随新证据重置）
      if (memory.evidence) {
        if (!existing.evidence) existing.evidence = initEvidence(existing.appliedSuccesses, existing.appliedTotal, memory.distilledAt);
        existing.evidence.weightedSuccesses += memory.evidence.weightedSuccesses;
        existing.evidence.weightedFailures += memory.evidence.weightedFailures;
        existing.evidence.lastDecayedAt = memory.distilledAt;
      }
      this.schedulePersist();
      return 'merged';
    }

    this.store.semanticMemories.push(memory);
    this.idxSemantic.set(memory.id, memory);
    this.idxSemanticStatement.set(memory.statement, memory);
    this.schedulePersist();
    return 'created';
  }

  /** 按指纹溯源删除语义记忆（分布式同步用；3.0 索引同步删除） */
  removeSemanticMemory(id: string): boolean {
    const mem = this.idxSemantic.get(id);
    if (!mem) return false;
    const index = this.store.semanticMemories.indexOf(mem);
    if (index < 0) return false;
    this.store.semanticMemories.splice(index, 1);
    this.idxSemantic.delete(id);
    if (this.idxSemanticStatement.get(mem.statement) === mem) this.idxSemanticStatement.delete(mem.statement);
    this.schedulePersist();
    return true;
  }

  /** 语义记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
  recordSemanticOutcome(id: string, success: boolean): void {
    const mem = this.idxSemantic.get(id);
    if (!mem) return;
    const now = Date.now();
    if (!mem.evidence) mem.evidence = initEvidence(mem.appliedSuccesses, mem.appliedTotal, now);
    mem.appliedTotal += 1;
    mem.lastAppliedAt = now;
    if (success) mem.appliedSuccesses += 1;
    observeEvidence(mem.evidence, success, now);
    const appliedRate = mem.appliedSuccesses / mem.appliedTotal;
    mem.confidence = mem.confidence * 0.7 + appliedRate * 0.3;
    this.schedulePersist();
  }

  // ─────────────────────────── 程序记忆（第二阶段） ───────────────────────────

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
  findProceduralMemory(
    kind: ProceduralMemory['kind'],
    taskType: string,
    context: {
      features?: string[];
      complexity?: number;
      length?: number;
      tokenCost?: number;
      outcome?: string;
      rootCause?: string;
    } = {},
  ): ProceduralMemory | undefined {
    const candidates = this.store.proceduralMemories.filter(
      (p) => p.kind === kind && (p.taskTypes.length === 0 || p.taskTypes.includes(taskType)),
    );
    let best: ProceduralMemory | undefined;
    let bestScore = 0;
    const now = Date.now();
    for (const proc of candidates) {
      if (!this.matchProceduralConditions(proc.conditions, taskType, context)) continue;
      // 3.0 证据化评分：confidence × Wilson 混合分 × supportCount 平滑
      const supportBoost = Math.min(1.5, 1 + Math.log10(1 + proc.supportCount) * 0.15);
      const score = evidenceRankScore(proc.confidence, proc.evidence, now) * supportBoost;
      if (score > bestScore) {
        bestScore = score;
        best = proc;
      }
    }
    return best;
  }

  /** 获取指定任务类型的程序记忆（3.0：按证据化排序分降序） */
  getProceduralMemories(taskType: string, kind?: ProceduralMemory['kind'], limit = 5): ProceduralMemory[] {
    const now = Date.now();
    return this.store.proceduralMemories
      .filter((p) => (kind ? p.kind === kind : true) && (p.taskTypes.length === 0 || p.taskTypes.includes(taskType)))
      .sort((a, b) => evidenceRankScore(b.confidence, b.evidence, now) - evidenceRankScore(a.confidence, a.evidence, now))
      .slice(0, limit);
  }

  /** 全部程序记忆 */
  getAllProceduralMemories(): ProceduralMemory[] {
    return [...this.store.proceduralMemories];
  }

  /**
   * 插入或更新程序记忆（第二阶段升级：证据合并增强 + 冲突消解，语义同 upsertSemanticMemory）
   *
   * 冲突判定：同结构签名（kind + 动作类型 + 目标模型维度 + 条件）但目标模型不同
   * （如"长代码任务偏好模型A" vs "偏好模型B"）→ 新证据显著更强时取代，否则丢弃。
   *
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertProceduralMemory(memory: ProceduralMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded' {
    // ── 1. 冲突消解：同条件同动作类型但目标模型不同（如"偏好模型A" vs "偏好模型B"） ──
    const conditionSig = conditionSignature(memory.conditions);
    const realConflicting = this.store.proceduralMemories.find((p) => {
      if (p.id === memory.id) return false;
      if (p.kind !== memory.kind || p.action.type !== memory.action.type) return false;
      if (conditionSignature(p.conditions) !== conditionSig) return false;
      const targetA = p.action.params['model'];
      const targetB = memory.action.params['model'];
      return typeof targetA === 'string' && typeof targetB === 'string' && targetA !== targetB;
    });
    if (realConflicting) {
      if (memory.supportCount >= realConflicting.supportCount * 1.5 && memory.supportCount >= 3) {
        const superseded: ProceduralMemory = {
          ...memory,
          supportCount: memory.supportCount + realConflicting.supportCount,
          sourceFingerprints: [...new Set([...memory.sourceFingerprints, ...realConflicting.sourceFingerprints])].slice(0, 50),
          appliedTotal: realConflicting.appliedTotal,
          appliedSuccesses: realConflicting.appliedSuccesses,
          lastAppliedAt: realConflicting.lastAppliedAt,
          evidence: memory.evidence ?? realConflicting.evidence, // 3.0：证据随应用统计一并继承
        };
        this.store.proceduralMemories[this.store.proceduralMemories.indexOf(realConflicting)] = superseded;
        this.idxProcedural.delete(realConflicting.id);
        this.idxProceduralName.delete(realConflicting.name);
        this.idxProcedural.set(superseded.id, superseded);
        this.idxProceduralName.set(superseded.name, superseded);
        this.schedulePersist();
        return 'superseded';
      }
      return 'duplicate';
    }

    // ── 2. 证据合并：同 id 或同 name（3.0 索引化 O(1)） ──
    const existing = this.idxProcedural.get(memory.id) ?? this.idxProceduralName.get(memory.name);
    if (existing && existing.id === memory.id) {
      if (!memory.evidence && existing.evidence) memory.evidence = existing.evidence; // 3.0：证据继承
      this.store.proceduralMemories[this.store.proceduralMemories.indexOf(existing)] = memory;
      if (existing.name !== memory.name) this.idxProceduralName.delete(existing.name);
      this.idxProcedural.set(memory.id, memory);
      this.idxProceduralName.set(memory.name, memory);
      this.schedulePersist();
      return 'updated';
    }
    if (existing) {
      const totalSupport = existing.supportCount + memory.supportCount;
      existing.confidence = Math.min(
        0.98,
        (existing.confidence * existing.supportCount + memory.confidence * memory.supportCount) / Math.max(1, totalSupport),
      );
      existing.supportCount = totalSupport;
      existing.sourceFingerprints = [...new Set([...existing.sourceFingerprints, ...memory.sourceFingerprints])].slice(0, 50);
      existing.taskTypes = [...new Set([...existing.taskTypes, ...memory.taskTypes])];
      if (existing.name !== memory.name) {
        this.idxProceduralName.delete(existing.name);
        existing.name = memory.name;
        this.idxProceduralName.set(existing.name, existing);
      }
      existing.action = memory.action;
      existing.distilledAt = memory.distilledAt;
      existing.lastDecayAt = memory.distilledAt;
      // 3.0：证据叠加合并（支撑证据累加，衰减基准随新证据重置）
      if (memory.evidence) {
        if (!existing.evidence) existing.evidence = initEvidence(existing.appliedSuccesses, existing.appliedTotal, memory.distilledAt);
        existing.evidence.weightedSuccesses += memory.evidence.weightedSuccesses;
        existing.evidence.weightedFailures += memory.evidence.weightedFailures;
        existing.evidence.lastDecayedAt = memory.distilledAt;
      }
      this.schedulePersist();
      return 'merged';
    }

    this.store.proceduralMemories.push(memory);
    this.idxProcedural.set(memory.id, memory);
    this.idxProceduralName.set(memory.name, memory);
    this.schedulePersist();
    return 'created';
  }

  /** 删除程序记忆（3.0 索引同步删除） */
  removeProceduralMemory(id: string): boolean {
    const proc = this.idxProcedural.get(id);
    if (!proc) return false;
    const index = this.store.proceduralMemories.indexOf(proc);
    if (index < 0) return false;
    this.store.proceduralMemories.splice(index, 1);
    this.idxProcedural.delete(id);
    if (this.idxProceduralName.get(proc.name) === proc) this.idxProceduralName.delete(proc.name);
    this.schedulePersist();
    return true;
  }

  /** 程序记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
  recordProceduralOutcome(id: string, success: boolean): void {
    const proc = this.idxProcedural.get(id);
    if (!proc) return;
    const now = Date.now();
    if (!proc.evidence) proc.evidence = initEvidence(proc.appliedSuccesses, proc.appliedTotal, now);
    proc.appliedTotal += 1;
    proc.lastAppliedAt = now;
    if (success) proc.appliedSuccesses += 1;
    observeEvidence(proc.evidence, success, now);
    const appliedRate = proc.appliedSuccesses / proc.appliedTotal;
    proc.confidence = proc.confidence * 0.7 + appliedRate * 0.3;
    this.schedulePersist();
  }

  // ── 蒸馏水位（第二阶段升级：阈值触发知识蒸馏的依据） ──

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
  } {
    const episodicEventCount = this.store.globalStats.totalExecutions;
    const lastDistillationEventCount = this.store.globalStats.lastDistillationEventCount ?? episodicEventCount;
    return {
      episodicEventCount,
      lastDistillationEventCount,
      pendingSinceLastDistillation: Math.max(0, episodicEventCount - lastDistillationEventCount),
    };
  }

  /** 蒸馏完成检查点：刷新水位（供 distillKnowledge 成功后调用） */
  noteDistillationCheckpoint(): void {
    this.store.globalStats.lastDistillationEventCount = this.store.globalStats.totalExecutions;
    this.schedulePersist();
  }

  /**
   * 证据普查（3.0：自知之明报告——全层不确定性一览）
   *
   * 系统级自检 API：
   * - 各记忆层的证据覆盖度（withEvidence / total）、平均有效样本量、证据枯竭数
   * - 模型画像层基于既有时间加权证据换算（legacy 裸计数折价，口径与 getBayesianEstimate 一致）
   * - 能力漂移检测：|drift| > 0.1 且有效样本 ≥ 5 的模型 × 任务组合
   *   （模型修复被察觉 / 模型退化被预警）
   */
  evidenceCensus(): EvidenceCensus {
    const now = Date.now();
    const layerOf = (layer: EvidenceCensusLayer['layer'], items: Array<{ evidence?: MemoryEvidence }>): EvidenceCensusLayer => {
      let withEvidence = 0;
      let exhausted = 0;
      let totalSamples = 0;
      for (const item of items) {
        if (!item.evidence) continue;
        withEvidence += 1;
        const view = readEvidence(item.evidence, now);
        totalSamples += view.effectiveSamples;
        if (view.effectiveSamples < 1) exhausted += 1;
      }
      return {
        layer,
        total: items.length,
        withEvidence,
        avgEffectiveSamples: items.length > 0 ? Number((totalSamples / items.length).toFixed(3)) : 0,
        evidenceExhausted: exhausted,
      };
    };

    // 模型画像层：任务历史 → 证据视图（加权字段缺失时 legacy 折价）
    const profileItems: Array<{ evidence?: MemoryEvidence }> = [];
    for (const profile of this.store.modelProfiles) {
      for (const history of Object.values(profile.taskHistory)) {
        const legacy = history.weightedSuccesses === undefined || history.weightedFailures === undefined;
        profileItems.push({
          evidence: {
            weightedSuccesses: (history.weightedSuccesses ?? history.successCount) * (legacy ? LEGACY_EVIDENCE_DISCOUNT : 1),
            weightedFailures:
              (history.weightedFailures ?? history.totalCalls - history.successCount) * (legacy ? LEGACY_EVIDENCE_DISCOUNT : 1),
            lastDecayedAt: history.lastDecayedAt ?? history.lastCalledAt ?? now,
          },
        });
      }
    }

    // 能力漂移：Beta 后验漂移检测（加权成功率 vs 裸成功率）
    const driftedModels: EvidenceCensus['driftedModels'] = [];
    for (const profile of this.store.modelProfiles) {
      for (const taskType of Object.keys(profile.taskHistory)) {
        const est = this.getBayesianEstimate(profile.id, taskType);
        if (!est || est.effectiveSamples < 5 || Math.abs(est.drift) <= 0.1) continue;
        driftedModels.push({
          modelId: profile.id,
          taskType,
          drift: est.drift,
          effectiveSamples: est.effectiveSamples,
          posteriorMean: est.posteriorMean,
        });
      }
    }

    return {
      generatedAt: now,
      layers: [
        layerOf('strategy', this.store.distilledStrategies),
        layerOf('semantic', this.store.semanticMemories),
        layerOf('procedural', this.store.proceduralMemories),
        layerOf('model-profile', profileItems),
      ],
      driftedModels,
    };
  }

  /**
   * 通用条件匹配（语义记忆用，第二阶段升级：委托导出的纯函数 matchesMemoryConditions，
   * 与优化器检索共用同一套求值语义，避免两处实现漂移）
   */
  private matchConditions(
    conditions: SemanticCondition[],
    taskType: string,
    context: MemoryMatchContext,
  ): boolean {
    return matchesMemoryConditions(conditions, taskType, context);
  }

  /** 程序记忆条件匹配（含 outcome/root-cause 维度） */
  private matchProceduralConditions(
    conditions: ProceduralCondition[],
    taskType: string,
    context: MemoryMatchContext,
  ): boolean {
    return matchesMemoryConditions(conditions, taskType, context);
  }

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
  applyForgettingCurve(halfLifeDays = 30, forgetThreshold = 0.2): { decayed: number; forgotten: number } {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    let decayed = 0;
    let forgotten = 0;

    // ── 任务模式衰减（幂等：以 lastDecayAt 为基准） ──
    const survivors: TaskPatternMemory[] = [];
    for (const pattern of this.store.taskPatterns) {
      const decayBase = pattern.lastDecayAt ?? pattern.lastSeenAt;
      const daysIdle = (now - decayBase) / DAY;
      if (daysIdle < 1) {
        survivors.push(pattern);
        continue;
      }
      // 高频模式半衰期延长：frequency 每 +10 次，半衰期 +100%（上限 3 倍）
      const effectiveHalfLife = halfLifeDays * Math.min(3, 1 + pattern.frequency / 10);
      const decayFactor = Math.pow(0.5, daysIdle / effectiveHalfLife);
      const newConfidence = pattern.confidence * decayFactor;

      if (newConfidence < forgetThreshold) {
        forgotten += 1;
        continue; // 彻底遗忘
      }
      if (newConfidence < pattern.confidence - 0.001) {
        pattern.confidence = newConfidence;
        decayed += 1;
      }
      pattern.lastDecayAt = now;
      survivors.push(pattern);
    }

    // ── 蒸馏策略衰减（对冲机制二：长期未被应用/验证的策略同样遗忘） ──
    const strategySurvivors: DistilledStrategy[] = [];
    for (const strategy of this.store.distilledStrategies) {
      const decayBase = strategy.lastAppliedAt ?? strategy.distilledAt;
      const daysIdle = (now - decayBase) / DAY;
      if (daysIdle < 1) {
        strategySurvivors.push(strategy);
        continue;
      }
      // 策略半衰期按支撑度延长：supportCount 越高越不易遗忘（上限 2 倍）
      const effectiveHalfLife = halfLifeDays * Math.min(2, 1 + strategy.supportCount / 20);
      const decayFactor = Math.pow(0.5, daysIdle / effectiveHalfLife);
      const newConfidence = strategy.confidence * decayFactor;

      if (newConfidence < forgetThreshold) {
        forgotten += 1;
        continue; // 彻底遗忘
      }
      if (newConfidence < strategy.confidence - 0.001) {
        strategy.confidence = newConfidence;
        decayed += 1;
      }
      strategy.lastAppliedAt = now;
      strategySurvivors.push(strategy);
    }

    // ── 语义记忆衰减（第二阶段：跨任务规律长期未被应用同样遗忘） ──
    const semanticSurvivors: SemanticMemory[] = this.decayMemory(
      this.store.semanticMemories,
      halfLifeDays,
      forgetThreshold,
      now,
      DAY,
      (count) => forgotten += count,
      (count) => decayed += count,
    );

    // ── 程序记忆衰减（第二阶段：if-then 规则长期未被触发同样遗忘） ──
    const proceduralSurvivors: ProceduralMemory[] = this.decayMemory(
      this.store.proceduralMemories,
      halfLifeDays,
      forgetThreshold,
      now,
      DAY,
      (count) => forgotten += count,
      (count) => decayed += count,
    );

    if (forgotten > 0 || decayed > 0) {
      this.store.taskPatterns = survivors;
      this.store.distilledStrategies = strategySurvivors;
      this.store.semanticMemories = semanticSurvivors;
      this.store.proceduralMemories = proceduralSurvivors;
      this.reindex(); // 3.0：批量过滤后重建索引，保持 O(1) 查找一致性
      this.schedulePersist();
    }
    return { decayed, forgotten };
  }

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
  private decayMemory<T extends { confidence: number; supportCount: number; distilledAt: number; lastAppliedAt?: number; lastDecayAt?: number }>(
    items: T[],
    halfLifeDays: number,
    forgetThreshold: number,
    now: number,
    DAY: number,
    onForget: (count: number) => void,
    onDecay: (count: number) => void,
  ): T[] {
    const survivors: T[] = [];
    for (const item of items) {
      const decayBase = item.lastDecayAt ?? item.lastAppliedAt ?? item.distilledAt;
      const daysIdle = (now - decayBase) / DAY;
      if (daysIdle < 1) {
        survivors.push(item);
        continue;
      }
      const effectiveHalfLife = halfLifeDays * Math.min(2, 1 + item.supportCount / 20);
      const decayFactor = Math.pow(0.5, daysIdle / effectiveHalfLife);
      const newConfidence = item.confidence * decayFactor;

      if (newConfidence < forgetThreshold) {
        onForget(1);
        continue; // 彻底遗忘
      }
      if (newConfidence < item.confidence - 0.001) {
        item.confidence = newConfidence;
        onDecay(1);
      }
      item.lastDecayAt = now;
      survivors.push(item);
    }
    return survivors;
  }

  /** FTS5 全文检索（混合检索增强，委托 SQLite 后端；JSON 后端返回空） */
  fullTextSearch(query: string, limit = 5) {
    return this.backend.fullTextSearch?.(query, limit) ?? [];
  }

  /** 向量检索（稀疏向量回退，委托 SQLite 后端；JSON 后端返回空） */
  vectorSearch(query: string, limit = 5) {
    return this.backend.vectorSearch?.(query, limit) ?? [];
  }

  // ── 数据库维护 API（委托 SQLite 后端；JSON 后端为安全缺省） ──

  /** 完整性检查（JSON 后端恒 ok） */
  integrityCheck(): string {
    return this.backend.integrityCheck?.() ?? 'ok';
  }

  /** 数据库统计（JSON 后端返回内存计数） */
  dbStats() {
    return (
      this.backend.stats?.() ?? {
        patterns: this.store.taskPatterns.length,
        profiles: this.store.modelProfiles.length,
        feedback: this.store.decisionFeedback.length,
        strategies: this.store.distilledStrategies.length,
        semantic: this.store.semanticMemories.length,
        procedural: this.store.proceduralMemories.length,
        pageSize: 0,
        pageCount: 0,
        walSize: 0,
        schemaVersion: 0,
        fts: false,
        vec: false,
      }
    );
  }

  /** WAL checkpoint（仅 SQLite 后端有效） */
  checkpoint(): void {
    this.backend.checkpoint?.();
  }

  /** VACUUM 回收碎片空间（仅 SQLite 后端有效） */
  vacuum(): void {
    this.backend.vacuum?.();
  }

  /** 热备份（仅 SQLite 后端；返回备份路径） */
  backup(destPath: string): string | undefined {
    return this.backend.backup?.(destPath);
  }

  /** 只读 SQL 查询通道（仅 SQLite 后端；JSON 后端返回空） */
  rawQuery(sql: string, params: Array<string | number | null> = []): Array<Record<string, unknown>> {
    return this.backend.rawQuery?.(sql, params) ?? [];
  }

  /** 立即同步落盘（进程退出前调用） */
  flushSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  /** 释放资源（落盘 + 移除 beforeExit 监听 + 关闭后端连接） */
  dispose(): void {
    this.flushSync();
    process.removeListener('beforeExit', this.flushOnExit);
    this.backend.close();
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 判断同描述策略是否已存在（蒸馏去重；3.0 索引化 O(1)） */
  private hasStrategy(description: string): boolean {
    return this.idxStrategyDesc.has(description);
  }

  /** 从持久化后端加载记忆库（损坏时由后端备份并抛出） */
  private load(): MemoryStore {
    return this.backend.load();
  }

  /** 防抖持久化调度 */
  private schedulePersist(): void {
    this.store.lastUpdatedAt = Date.now();
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    // 不阻塞进程退出
    this.persistTimer.unref?.();
  }

  /** 执行持久化（委托后端：SQLite 事务 / JSON 原子写 / 加密落盘） */
  private persist(): void {
    this.backend.save(this.store);
  }

  /** 更新模型画像 */
  private updateModelProfile(
    modelId: string,
    taskType: string,
    success: boolean,
    latency: number,
    quality: number,
    tokenCost: number,
  ): void {
    let profile = this.idxProfile.get(modelId);
    if (!profile) {
      profile = {
        id: modelId,
        name: modelId,
        taskHistory: {},
        costEfficiency: {},
        bestTaskType: '',
        worstTaskType: '',
        stability: 0.5,
      };
      this.store.modelProfiles.push(profile);
      this.idxProfile.set(modelId, profile);
    }
    const history = (profile.taskHistory[taskType] ??= {
      totalCalls: 0,
      successCount: 0,
      totalLatency: 0,
      totalQualityScore: 0,
      avgQualityScore: 0,
      lastCalledAt: 0,
    });
    history.totalCalls += 1;
    if (success) {
      history.successCount += 1;
      history.totalLatency += latency;
      history.totalQualityScore += quality;
    }
    history.lastCalledAt = Date.now();

    // ── 2.0：时间加权贝叶斯证据（写入时惰性衰减累积，读取零开销） ──
    // 旧持久化缺省字段回退裸计数起步（首次写入即完成初始化，向后兼容）
    const now = history.lastCalledAt;
    const decayBase = history.lastDecayedAt ?? history.lastCalledAt ?? now;
    const decay = Math.pow(0.5, Math.max(0, now - decayBase) / (DECAY_HALF_LIFE_DAYS * 86_400_000));
    const ws = (history.weightedSuccesses ?? history.successCount - (success ? 1 : 0)) * decay;
    const wf = (history.weightedFailures ?? history.totalCalls - history.successCount - (success ? 0 : 1)) * decay;
    history.weightedSuccesses = success ? ws + 1 : ws;
    history.weightedFailures = success ? wf : wf + 1;
    history.lastDecayedAt = now;
    // 质量漂移感知：成功执行的 EMA（α=0.3，与 avgQualityScore 语义对齐只计成功）
    if (success) {
      history.emaQuality = history.emaQuality == null ? quality : 0.7 * history.emaQuality + 0.3 * quality;
    }

    history.avgQualityScore = history.successCount > 0 ? history.totalQualityScore / history.successCount : 0;

    // 成本效率：质量分 / (token 成本 + 1)，越高越好
    if (success && tokenCost > 0) {
      const prev = profile.costEfficiency[taskType] ?? 0;
      profile.costEfficiency[taskType] = (prev + quality / (tokenCost / 1000 + 1)) / 2;
    }

    // 推导 best/worst 任务类型（按成功率，至少 2 次调用才参与评比）
    const ranked = Object.entries(profile.taskHistory)
      .filter(([, h]) => h.totalCalls >= 2)
      .sort((a, b) => b[1].successCount / b[1].totalCalls - a[1].successCount / a[1].totalCalls);
    if (ranked.length > 0) {
      profile.bestTaskType = ranked[0]![0];
      profile.worstTaskType = ranked[ranked.length - 1]![0];
    }

    // 稳定性 = 全任务加权成功率的平滑值（向历史值收敛）
    const totalCalls = Object.values(profile.taskHistory).reduce((s, h) => s + h.totalCalls, 0);
    const totalSuccess = Object.values(profile.taskHistory).reduce((s, h) => s + h.successCount, 0);
    const currentRate = totalCalls > 0 ? totalSuccess / totalCalls : 0.5;
    profile.stability = profile.stability * 0.7 + currentRate * 0.3;
  }

  /** 构建任务指纹：taskType + 复杂度分桶 + 排序后的特征 */
  private buildFingerprint(taskType: string, complexity: number, features: string[]): string {
    return buildPatternFingerprint(taskType, complexity, features);
  }

  /**
   * 相似度打分（0~1）
   * 0.5 × taskType 匹配 + 0.25 × complexity 接近度 + 0.25 × features Jaccard
   */
  private similarity(pattern: TaskPatternMemory, taskType: string, complexity: number, features: string[]): number {
    // taskType：从指纹中还原
    const patternType = pattern.fingerprint.split('::')[0] ?? '';
    const typeScore = patternType === taskType ? 1 : patternType.startsWith(taskType) || taskType.startsWith(patternType) ? 0.5 : 0;

    // complexity：从指纹中还原分桶值
    const patternComplexity = Number(pattern.fingerprint.split('::')[1] ?? 0.5);
    const complexityScore = Math.max(0, 1 - Math.abs(patternComplexity - complexity) * 2);

    // features：Jaccard 系数
    const patternFeatures = (pattern.fingerprint.split('::')[2] ?? '').split(',').filter(Boolean);
    let featureScore = 0;
    if (features.length === 0 && patternFeatures.length === 0) {
      featureScore = 1;
    } else if (features.length > 0 || patternFeatures.length > 0) {
      const setA = new Set(features);
      const setB = new Set(patternFeatures);
      const intersection = [...setA].filter((f) => setB.has(f)).length;
      const union = new Set([...setA, ...setB]).size;
      featureScore = union > 0 ? intersection / union : 0;
    }

    return 0.5 * typeScore + 0.25 * complexityScore + 0.25 * featureScore;
  }

  /** 质量分字典的平均值 */
  private avgQuality(scores: Record<string, number>): number {
    const values = Object.values(scores);
    return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  }

  /** 数值数组平均值 */
  private avg(values: number[]): number {
    return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  }

  /** 滚动平均（避免保存全量历史） */
  private rollingAvg(prevAvg: number, newValue: number, count: number): number {
    return count <= 1 ? newValue : prevAvg + (newValue - prevAvg) / count;
  }
}
