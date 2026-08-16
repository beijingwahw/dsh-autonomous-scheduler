/**
 * contracts.ts — 自主智能闭环三大支柱的接口契约（验收标准 2）
 *
 * 三个接口与最初定义严格一致，由具体组件 implements：
 * - IMemoryStore  → LongTermMemory（记忆支柱：任务模式 / 模型画像 / 决策反馈）
 * - IReflector    → Reflector（反思支柱：执行后复盘并更新记忆）
 * - IOptimizer    → Optimizer（优化支柱：调度前基于记忆推荐）
 *
 * 外部集成方（宿主、测试、替代实现）只依赖本文件的接口，不依赖具体类。
 */

import type {
  BayesianEstimate,
  DecisionFeedback,
  DistilledStrategy,
  DistillationReport,
  ModelLongTermProfile,
  ProceduralMemory,
  RecordDecisionFeedbackParams,
  RecordFailureParams,
  RecordSuccessParams,
  SemanticMemory,
  TaskPatternMemory,
} from './memory/long-term-memory.js';
import type { ExecutionPlan, PlanExecutionResult } from './types.js';
import type { ExperienceLookup } from './optimizer.js';
import type { Signal } from './sentinel.js';
import type { MemorySearchHit } from './memory/backend.js';
// 第三阶段：策略进化（策略表示 + 沙盒评估报告）
import type { EvaluationReport, Policy, SandboxTask } from './policy/policy-types.js';
// 第四阶段：元认知层（心智报告 + 调整报告 + 回滚结果）
import type { AdjustmentReport, MentalReport, RollbackResult, SystemMetrics } from './meta/meta-types.js';

/** 记忆支柱契约：三类数据的读写与生命周期 */
export interface IMemoryStore {
  // ── 任务模式 ──
  findPattern(taskType: string, complexity: number, features?: string[]): TaskPatternMemory | undefined;
  recordSuccess(params: RecordSuccessParams): void;
  recordFailure(params: RecordFailureParams): void;
  getTopPatterns(limit?: number): TaskPatternMemory[];
  getAllTaskPatterns(): TaskPatternMemory[];
  upsertPattern(pattern: TaskPatternMemory): 'created' | 'updated';
  removePattern(fingerprint: string): boolean;
  // ── 模型画像 ──
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
  // ── 决策反馈 ──
  recordDecisionFeedback(params: RecordDecisionFeedbackParams): void;
  getRecentFeedback(limit?: number): DecisionFeedback[];
  getDecisionSuccessRate(signalType: string): { total: number; successRate: number; avgOutcome: string };
  appendFeedback(feedback: DecisionFeedback): boolean;
  // ── 蒸馏策略 ──
  distillExperience(minConfidence?: number): DistilledStrategy[];
  getStrategies(taskType: string, limit?: number): DistilledStrategy[];
  getAllStrategies(): DistilledStrategy[];
  recordStrategyOutcome(strategyId: string, success: boolean): void;
  // ── 语义记忆（第二阶段：跨任务规律） ──
  findSemanticMemory(
    taskType: string,
    context?: {
      features?: string[];
      complexity?: number;
      length?: number;
      tokenCost?: number;
    },
  ): SemanticMemory | undefined;
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
  // ── 程序记忆（第二阶段：if-then 可执行规则） ──
  findProceduralMemory(
    kind: ProceduralMemory['kind'],
    taskType: string,
    context?: {
      features?: string[];
      complexity?: number;
      length?: number;
      tokenCost?: number;
      outcome?: string;
      rootCause?: string;
    },
  ): ProceduralMemory | undefined;
  getProceduralMemories(taskType: string, kind?: ProceduralMemory['kind'], limit?: number): ProceduralMemory[];
  getAllProceduralMemories(): ProceduralMemory[];
  /**
   * 插入或更新程序记忆（第二阶段升级：证据合并增强 + 冲突消解，语义同 upsertSemanticMemory）
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertProceduralMemory(memory: ProceduralMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  removeProceduralMemory(id: string): boolean;
  recordProceduralOutcome(id: string, success: boolean): void;
  // ── 蒸馏水位（第二阶段升级：阈值触发知识蒸馏的依据；可选注入保持向后兼容） ──
  /** 情景事件水位：距上次蒸馏新增的情景事件数（成功+失败均计） */
  getDistillationProgress?(): {
    episodicEventCount: number;
    lastDistillationEventCount: number;
    pendingSinceLastDistillation: number;
  };
  /** 蒸馏完成检查点：刷新水位（distillKnowledge 成功后调用） */
  noteDistillationCheckpoint?(): void;
  // ── 全局统计与维护 ──
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
  applyForgettingCurve(halfLifeDays?: number, forgetThreshold?: number): { decayed: number; forgotten: number };
  // ── 混合检索增强（仅 SQLite 后端提供；JSON 后端缺省为空结果） ──
  fullTextSearch?(query: string, limit?: number): MemorySearchHit[];
  vectorSearch?(query: string, limit?: number): MemorySearchHit[];
  // ── 数据库维护 API（仅 SQLite 后端提供；JSON 后端为安全缺省） ──
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
export interface IReflector {
  reflectOnOutcome(params: {
    signal: Signal;
    plan: ExecutionPlan;
    result: PlanExecutionResult;
    /** 本次注入/应用的蒸馏策略 id 列表（策略反馈闭环） */
    appliedStrategies?: string[];
    /** 第二阶段升级：本次经验检索命中的语义/程序记忆 id（三层记忆应用反馈闭环） */
    appliedMemoryIds?: { semantic?: string[]; procedural?: string[] };
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
  distillKnowledge(options?: { force?: boolean }): Promise<DistillationReport>;
}

/** 优化支柱契约：下一次调度前基于记忆产出推荐 */
export interface IOptimizer {
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
  lookupExperience(
    taskType: string,
    complexity: number,
    features?: string[],
    context?: { length?: number; tokenCost?: number },
  ): ExperienceLookup;
  /** 经验快路径：高置信度模式直接召回历史最优成功计划 */
  recallPlan(lookup: ExperienceLookup, objective: string): ExecutionPlan | undefined;
  /** 混合检索（模糊 + FTS5 + 向量 + 图联想），缺省实现可省略 */
  hybridSearch?(query: string, taskType: string, complexity: number, limit?: number): MemorySearchHit[];
}

// ── 第三阶段：策略进化契约（策略进化器 + 安全沙盒） ──

/**
 * 安全沙盒契约：新策略上线路前的隔离验证环境
 *
 * 隔离性：评估全程离线（不调 LLM、不写记忆、不接触操作环调度器），
 * 不阻塞正常任务调度；同一策略 + 任务集 + 随机种子 → 评估结果可复现。
 */
export interface ISandbox {
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
export interface IPolicyEvolver {
  /** 变异：产出候选策略变体 */
  generateCandidates(currentPolicy: Policy): Promise<Policy[]>;
  /** 选择（评估）：沙盒隔离评估单个候选 */
  evaluateCandidate(policy: Policy, sandbox: ISandbox): Promise<EvaluationReport>;
  /** 保留：择优返回可部署候选（无合格候选返回 null） */
  selectBest(candidates: Policy[], reports: EvaluationReport[]): Promise<Policy | null>;
  /** 部署：策略热切换到操作环 */
  deployPolicy(policy: Policy): Promise<void>;
}

// ── 第四阶段：元认知层契约（自我建模 + 元认知控制） ──

/**
 * 自我建模契约：系统对自身运行状态的持续观察与结构化认知
 *
 * 双环架构的外环感知端：内环（执行 → 反思 → 记忆 → 优化 → 进化）
 * 的运行质量被持续采集为系统指标，并周期性凝结为心智报告——
 * 策略的优势与盲点、记忆体系的增长与退化、进化器的发现速度与
 * 存活率、系统稳定性与风险点，以及可机器验证的自我改进证据。
 */
export interface ISelfModel {
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
export interface IMetaCognitiveController {
  /** 评估最新心智报告并推进调整状态机（应用 / 观察 / 判定保留 / 自动回滚） */
  evaluateAndAdjust(): Promise<AdjustmentReport>;
  /** 手动回滚最近一次调整（观察中或已提交） */
  rollbackLastAdjustment(): Promise<RollbackResult>;
}
