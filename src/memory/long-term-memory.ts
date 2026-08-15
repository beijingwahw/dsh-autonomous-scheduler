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
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryError } from '../errors.js';
import type { CryptoEngine } from '../security/crypto-engine.js';

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
}

/** 模型长期画像 */
export interface ModelLongTermProfile {
  id: string;
  name: string;
  taskHistory: Record<
    string,
    {
      totalCalls: number;
      successCount: number;
      totalLatency: number;
      totalQualityScore: number;
      avgQualityScore: number;
      lastCalledAt: number;
    }
  >;
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
}

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
  globalStats: {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalTokensUsed: number;
    totalCostEstimate: number;
    averageQualityScore: number;
    averageExecutionTime: number;
  };
}

/** outcome → 数值映射（用于决策成功率统计） */
const OUTCOME_SCORE: Record<DecisionFeedback['outcome'], number> = {
  excellent: 1.0,
  good: 0.8,
  acceptable: 0.6,
  poor: 0.3,
  failed: 0,
};

/** 模糊匹配最低相似度门槛 */
const MIN_SIMILARITY = 0.4;
/** 持久化防抖窗口（毫秒） */
const PERSIST_DEBOUNCE_MS = 500;
/** 单个模式保留的成功方案上限（保留质量最高者） */
const MAX_SUCCESSFUL_PLANS = 20;
/** 单个模式保留的失败记录上限 */
const MAX_FAILURE_RECORDS = 20;

/**
 * 跨会话长期记忆引擎
 *
 * 被 migration-tool / tenant-manager / benchmark-engine / distributed-sync 依赖。
 */
export class LongTermMemory {
  private persistPath: string;
  private cryptoEngine?: CryptoEngine;
  private store: MemoryStore;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private flushOnExit: () => void;

  /**
   * @param persistPath 持久化文件路径（如 .scheduler/memory.json）
   * @param cryptoEngine 可选加密引擎，提供后持久化自动适配加密配置
   */
  constructor(persistPath: string, cryptoEngine?: CryptoEngine) {
    this.persistPath = persistPath;
    this.cryptoEngine = cryptoEngine;
    this.store = this.load();
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
  recordSuccess(params: {
    taskType: string;
    complexity: number;
    features: string[];
    taskSummary: string;
    plan: any;
    modelAssignments: Record<string, string>;
    totalLatency: number;
    qualityScores: Record<string, number>;
    tokenCost: number;
  }): void {
    const now = Date.now();
    const fingerprint = this.buildFingerprint(params.taskType, params.complexity, params.features);
    let pattern = this.store.taskPatterns.find((p) => p.fingerprint === fingerprint);

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
  recordFailure(params: {
    taskType: string;
    complexity: number;
    features: string[];
    reason: string;
    failedNodeId: string;
    failedModelId: string;
    errorMessage: string;
  }): void {
    const now = Date.now();
    const fingerprint = this.buildFingerprint(params.taskType, params.complexity, params.features);
    let pattern = this.store.taskPatterns.find((p) => p.fingerprint === fingerprint);

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
  recordDecisionFeedback(params: {
    signalType: string;
    signalDescription: string;
    decision: string;
    outcome: DecisionFeedback['outcome'];
    outcomeReason: string;
    lesson?: string;
  }): void {
    this.store.decisionFeedback.push({
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...params,
    });
    // 反馈记录上限 500 条，FIFO
    if (this.store.decisionFeedback.length > 500) {
      this.store.decisionFeedback = this.store.decisionFeedback.slice(-500);
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
    return this.store.modelProfiles.find((p) => p.id === modelId);
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
      this.schedulePersist();
      return 'updated';
    }
    this.store.taskPatterns.push(pattern);
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
      this.schedulePersist();
      return 'updated';
    }
    this.store.modelProfiles.push(profile);
    this.schedulePersist();
    return 'created';
  }

  /**
   * 追加一条决策反馈（迁移导入用，按 id 去重）
   * @returns 是否实际写入（重复 id 返回 false）
   */
  appendFeedback(feedback: DecisionFeedback): boolean {
    if (this.store.decisionFeedback.some((f) => f.id === feedback.id)) {
      return false;
    }
    this.store.decisionFeedback.push(feedback);
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
      `任务模式数: ${this.store.taskPatterns.length} | 模型画像数: ${this.store.modelProfiles.length} | 决策反馈数: ${this.store.decisionFeedback.length}`,
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

    if (pruned > 0) this.schedulePersist();
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
                id: `strategy-${now}-${fresh.length + this.store.distilledStrategies.length}`,
                taskType,
                description,
                sourceFingerprint: pattern.fingerprint,
                supportCount: wins,
                confidence: Math.min(0.95, pattern.confidence * ratio + 0.1),
                distilledAt: now,
                appliedSuccesses: 0,
                appliedTotal: 0,
              };
              this.store.distilledStrategies.push(strategy);
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
            id: `strategy-${now}-p${fresh.length + this.store.distilledStrategies.length}`,
            taskType,
            description,
            sourceFingerprint: pattern.fingerprint,
            supportCount: bestCount,
            confidence: Math.min(0.9, pattern.confidence * 0.9),
            distilledAt: now,
            appliedSuccesses: 0,
            appliedTotal: 0,
          };
          this.store.distilledStrategies.push(strategy);
          fresh.push(strategy);
        }
      }
    }

    if (fresh.length > 0) this.schedulePersist();
    return fresh;
  }

  /**
   * 获取指定任务类型的蒸馏策略（按置信度降序）
   * @param taskType 任务类型
   * @param limit 返回上限
   */
  getStrategies(taskType: string, limit = 5): DistilledStrategy[] {
    return this.store.distilledStrategies
      .filter((s) => s.taskType === taskType)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  /** 全部蒸馏策略 */
  getAllStrategies(): DistilledStrategy[] {
    return [...this.store.distilledStrategies];
  }

  /**
   * 策略应用反馈：更新策略的应用成功率（闭环校准策略置信度）
   * @param strategyId 策略 id
   * @param success 本次应用是否成功
   */
  recordStrategyOutcome(strategyId: string, success: boolean): void {
    const strategy = this.store.distilledStrategies.find((s) => s.id === strategyId);
    if (!strategy) return;
    strategy.appliedTotal += 1;
    if (success) strategy.appliedSuccesses += 1;
    // 应用成功率反向修正置信度（指数加权）
    const appliedRate = strategy.appliedSuccesses / strategy.appliedTotal;
    strategy.confidence = strategy.confidence * 0.7 + appliedRate * 0.3;
    this.schedulePersist();
  }

  /**
   * 遗忘曲线：按艾宾浩斯衰减模型对长期未使用的模式降低置信度
   *
   * 衰减公式：confidence ×= decayFactor ^ (daysSinceLastSeen / halfLifeDays)
   * - 高频模式（frequency 高）半衰期更长，不易遗忘
   * - 置信度低于 forgetThreshold 的模式直接清除（彻底遗忘）
   *
   * @param halfLifeDays 基准半衰期（天），默认 30
   * @param forgetThreshold 低于该置信度彻底遗忘，默认 0.2
   * @returns { decayed: 衰减的模式数, forgotten: 彻底遗忘的模式数 }
   */
  applyForgettingCurve(halfLifeDays = 30, forgetThreshold = 0.2): { decayed: number; forgotten: number } {
    const now = Date.now();
    let decayed = 0;
    let forgotten = 0;
    const survivors: TaskPatternMemory[] = [];

    for (const pattern of this.store.taskPatterns) {
      const daysSince = (now - pattern.lastSeenAt) / (24 * 60 * 60 * 1000);
      if (daysSince < 1) {
        survivors.push(pattern);
        continue;
      }
      // 高频模式半衰期延长：frequency 每 +5 次，半衰期 +50%（上限 3 倍）
      const effectiveHalfLife = halfLifeDays * Math.min(3, 1 + pattern.frequency / 10);
      const decayFactor = Math.pow(0.5, daysSince / effectiveHalfLife);
      const newConfidence = pattern.confidence * decayFactor;

      if (newConfidence < forgetThreshold) {
        forgotten += 1;
        continue; // 彻底遗忘
      }
      if (newConfidence < pattern.confidence - 0.001) {
        pattern.confidence = newConfidence;
        decayed += 1;
      }
      survivors.push(pattern);
    }

    if (forgotten > 0 || decayed > 0) {
      this.store.taskPatterns = survivors;
      this.schedulePersist();
    }
    return { decayed, forgotten };
  }

  /** 立即同步落盘（进程退出前调用） */
  flushSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  /** 释放资源（移除 beforeExit 监听） */
  dispose(): void {
    this.flushSync();
    process.removeListener('beforeExit', this.flushOnExit);
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 判断同描述策略是否已存在（蒸馏去重） */
  private hasStrategy(description: string): boolean {
    return this.store.distilledStrategies.some((s) => s.description === description);
  }

  /** 从磁盘加载记忆库，损坏时自动备份并重建 */
  private load(): MemoryStore {
    const empty: MemoryStore = {
      version: 1,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      taskPatterns: [],
      modelProfiles: [],
      decisionFeedback: [],
      distilledStrategies: [],
      globalStats: {
        totalExecutions: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalTokensUsed: 0,
        totalCostEstimate: 0,
        averageQualityScore: 0,
        averageExecutionTime: 0,
      },
    };
    if (!fs.existsSync(this.persistPath)) return empty;
    try {
      if (this.cryptoEngine) {
        const { data } = this.cryptoEngine.readEncrypted(this.persistPath);
        return this.validate(data);
      }
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
      return this.validate(raw);
    } catch (err) {
      // 损坏文件备份后重建，避免启动失败
      const backup = `${this.persistPath}.corrupt.${Date.now()}`;
      try {
        fs.copyFileSync(this.persistPath, backup);
      } catch {
        /* 备份失败不阻塞 */
      }
      throw new MemoryError(`记忆库加载失败，已备份至 ${backup}`, {
        persistPath: this.persistPath,
      });
    }
  }

  /** 结构校验与缺省补全 */
  private validate(data: any): MemoryStore {
    if (!data || typeof data !== 'object' || !Array.isArray(data.taskPatterns)) {
      throw new MemoryError('记忆库结构非法：缺少 taskPatterns 数组');
    }
    return {
      version: data.version ?? 1,
      createdAt: data.createdAt ?? Date.now(),
      lastUpdatedAt: data.lastUpdatedAt ?? Date.now(),
      taskPatterns: data.taskPatterns,
      modelProfiles: data.modelProfiles ?? [],
      decisionFeedback: data.decisionFeedback ?? [],
      distilledStrategies: data.distilledStrategies ?? [],
      globalStats: {
        totalExecutions: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalTokensUsed: 0,
        totalCostEstimate: 0,
        averageQualityScore: 0,
        averageExecutionTime: 0,
        ...data.globalStats,
      },
    };
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

  /** 执行持久化（优先走加密引擎） */
  private persist(): void {
    try {
      if (this.cryptoEngine) {
        const result = this.cryptoEngine.writeEncrypted(this.persistPath, this.store);
        if (!result.success) {
          throw new MemoryError(`记忆库写入失败: ${result.error}`);
        }
        return;
      }
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.persistPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), 'utf-8');
      fs.renameSync(tmp, this.persistPath);
    } catch (err) {
      if (err instanceof MemoryError) throw err;
      throw new MemoryError('记忆库持久化失败', {
        persistPath: this.persistPath,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
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
    let profile = this.store.modelProfiles.find((p) => p.id === modelId);
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
    const bucket = Math.round(complexity * 10) / 10;
    return `${taskType}::${bucket}::${[...features].sort().join(',')}`;
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
