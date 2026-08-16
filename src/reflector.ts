/**
 * reflector.ts — 反思器组件（新架构「任务执行 → 反思器 → 记忆更新」）
 *
 * 职责（对应架构图 Reflector 框）：
 * - 执行后复盘：消费执行结果，驱动反思引擎（质量趋势 / 阈值自校准 / 教训提取）
 * - 记忆更新：成功方案沉淀（任务模式 + 模型画像）/ 失败记录写入记忆库
 * - 策略反馈：蒸馏策略应用结果回写，反向校准策略置信度
 * - 经验蒸馏：成功沉淀达到阈值时提炼可复用策略
 *
 * 边界：只写记忆库 + 复盘，不做调度决策。
 * 与优化器（optimizer.ts）构成单向数据流的两端：
 *   记忆库 → 优化器 → 模型调度/任务执行 → 反思器 → 记忆更新 → 记忆库
 */

import crypto from 'node:crypto';
import type { ExecutionPlan, PlanExecutionResult } from './types.js';
import type { IMemoryStore, IReflector } from './contracts.js';
import type { ProgressBroadcaster } from './progress-ws.js';
import type { Lesson, ReflectionEngine } from './reflection-engine.js';
import type {
  DistilledStrategy,
  DistillationReport,
  ProceduralAction,
  ProceduralCondition,
  ProceduralMemory,
  SemanticCondition,
  SemanticConclusion,
  SemanticMemory,
  TaskPatternMemory,
} from './memory/long-term-memory.js';
import { buildPatternFingerprint } from './memory/long-term-memory.js';
import type { MemoryGraph } from './memory/memory-graph.js';
import type { ChangeEntry, ChangePayload } from './sync/distributed-sync.js';
import type { Signal } from './sentinel.js';

/** 反思器配置 */
export interface ReflectorConfig {
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
  // ── 2.0：统计学习反思 ──
  /** 校准滑动窗口容量（缺省 50；Brier 残差滚动统计范围） */
  calibrationWindowSize?: number;
  /** 反事实遗憾触发的置信差距（缺省 0.1；替代者下界须超过所用模型后验均值该幅度） */
  counterfactualMargin?: number;
  /** 反事实分析的最低有效样本量（缺省 3；证据不足不产生遗憾结论） */
  counterfactualMinSamples?: number;
}

/** 决策洞察记录（2.0：执行器收集、反思器消费的调度预测归因） */
export interface DecisionInsightRecord {
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
export interface CalibrationStatus {
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
export class Reflector implements IReflector {
  private memory: IMemoryStore;
  private reflection: ReflectionEngine;
  private config: ReflectorConfig;
  private broadcaster?: ProgressBroadcaster;
  private graph?: MemoryGraph;
  /** 同步变更登记回调（由 index.ts 桥接到 distributed-sync.recordChange） */
  private onMemoryChange?: (type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload) => void;
  /** 蒸馏进行中标志（阈值自动触发的防抖，避免并发重复蒸馏） */
  private distilling = false;
  /** 2.0：校准滑动窗口（Brier 残差滚动统计） */
  private calibrationWindow: Array<{ predicted: number; actual: 0 | 1 }> = [];

  constructor(params: {
    memory: IMemoryStore;
    reflection: ReflectionEngine;
    config?: ReflectorConfig;
    broadcaster?: ProgressBroadcaster;
    graph?: MemoryGraph;
    onMemoryChange?: (type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload) => void;
  }) {
    this.memory = params.memory;
    this.reflection = params.reflection;
    this.config = params.config ?? {};
    this.broadcaster = params.broadcaster;
    this.graph = params.graph;
    this.onMemoryChange = params.onMemoryChange;
  }

  /**
   * 运行时配置热更新（第四阶段：元认知控制器调参落地入口）
   *
   * 元认知层经此调整反思触发频率与蒸馏门槛（autoDistillThreshold /
   * distillMinConfidence 等），立即对后续复盘生效，无需重启。
   * 回调类字段（onLesson/onDistilled/...）仅显式传入时覆盖。
   */
  updateConfig(patch: ReflectorConfig): void {
    this.config = { ...this.config, ...patch };
  }

  /** 当前配置快照（元认知旋钮 read 端；只读） */
  getConfig(): Readonly<ReflectorConfig> {
    return { ...this.config };
  }

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
    appliedMemoryIds?: { semantic?: string[]; procedural?: string[] };
    /** 2.0：本次各节点的调度决策洞察（校准闭环素材；缺省跳过校准更新） */
    decisionInsights?: DecisionInsightRecord[];
  }): void {
    const { signal, plan, result } = params;
    const taskType = plan.nodes[0]?.type ?? signal.type;

    // 1. 质量趋势记录（驱动阈值自校准与下滑告警）
    this.reflection.recordExecution(taskType, result.avgQuality, result.success);

    // 2. 经验沉淀（记忆更新）
    this.settleExperience(signal, plan, result);

    // 2.5 统计学习反思（2.0：校准闭环 + 反事实遗憾）
    if (params.decisionInsights && params.decisionInsights.length > 0) {
      this.updateCalibration(params.decisionInsights);
    }
    this.analyzeCounterfactualRegret(signal, plan, result);

    // 3. 策略应用反馈闭环：有效策略越用越强，无效策略自然淘汰
    for (const strategyId of params.appliedStrategies ?? []) {
      this.memory.recordStrategyOutcome(strategyId, result.success);
    }

    // 3.5 语义/程序记忆应用反馈闭环（第二阶段升级）
    for (const semanticId of params.appliedMemoryIds?.semantic ?? []) {
      this.memory.recordSemanticOutcome(semanticId, result.success);
    }
    for (const proceduralId of params.appliedMemoryIds?.procedural ?? []) {
      this.memory.recordProceduralOutcome(proceduralId, result.success);
    }

    // 4.5 记忆图更新（自主学习建议 2：记忆网络共现边 + 主题树挂载）
    if (this.graph && result.success) {
      const complexity = Math.min(1, plan.nodes.length / 5);
      const features = [...new Set(plan.nodes.map((n) => n.type))];
      const fingerprint = buildPatternFingerprint(taskType, complexity, features);
      this.graph.ensureNode(fingerprint, 'pattern', signal.description);
      this.graph.attachTopic(fingerprint, taskType);
      for (const strategyId of params.appliedStrategies ?? []) {
        this.graph.ensureNode(strategyId, 'strategy', strategyId);
        this.graph.link(fingerprint, strategyId);
      }
    }

    // 4. 失败 → 教训提取（异步，不阻塞主流程）；成功 → 经验蒸馏
    if (!result.success) {
      void this.reflection.extractLesson({ signal, taskType, result, plan }).then((lesson) => {
        if (lesson) {
          this.broadcast({ type: 'lesson-extracted', lessonId: lesson.id, rootCause: lesson.rootCause, lesson: lesson.lesson });
          this.config.onLesson?.(lesson);
        }
      });
    } else {
      const fresh = this.memory.distillExperience();
      if (fresh.length > 0) {
        this.broadcast({ type: 'experience-distilled', strategies: fresh.map((s) => ({ id: s.id, description: s.description, confidence: s.confidence })) });
        this.config.onDistilled?.(fresh);
      }
    }

    // 4.6 阈值自动蒸馏（第二阶段升级）：新增情景事件达到阈值时后台触发
    // （非阻塞：蒸馏在微任务/IO 间隙完成，失败不影响主复盘流程）
    const autoThreshold = this.config.autoDistillThreshold ?? 5;
    if (autoThreshold > 0 && !this.distilling) {
      const progress = this.memory.getDistillationProgress?.();
      if (progress && progress.pendingSinceLastDistillation >= autoThreshold) {
        void this.distillKnowledge().catch(() => {
          /* 自动蒸馏失败静默（下次阈值再试） */
        });
      }
    }
  }

  /**
   * 校准更新（2.0：预测置信度 vs 实际结果的滚动统计）
   *
   * Brier 分 = mean((predicted - actual)²)——概率预测质量金标准：
   * 调度器说「90% 能成」的实际成了 → 无惩罚；说 90% 却连续失败 → 重罚。
   * 这是「系统知道自己有多准」的自知之明，过自信/欠自信方向可诊断。
   */
  private updateCalibration(insights: DecisionInsightRecord[]): void {
    const windowSize = this.config.calibrationWindowSize ?? 50;
    for (const insight of insights) {
      this.calibrationWindow.push({ predicted: insight.predictedConfidence, actual: insight.success ? 1 : 0 });
    }
    if (this.calibrationWindow.length > windowSize) {
      this.calibrationWindow.splice(0, this.calibrationWindow.length - windowSize);
    }
    const status = this.getCalibration();
    this.broadcast({
      type: 'calibration-updated',
      brierScore: Number(status.brierScore.toFixed(4)),
      residualMean: Number(status.residualMean.toFixed(4)),
      samples: status.samples,
      direction: status.direction,
      correction: status.correction,
    });
  }

  /** 校准状态查询（2.0：调度预测质量的持续自知；3.0：附带自修正量） */
  getCalibration(): CalibrationStatus {
    const windowSize = this.config.calibrationWindowSize ?? 50;
    const n = this.calibrationWindow.length;
    if (n === 0) {
      return { brierScore: 0, residualMean: 0, samples: 0, direction: 'insufficient', windowSize, correction: 0 };
    }
    const brier = this.calibrationWindow.reduce((s, w) => s + (w.predicted - w.actual) ** 2, 0) / n;
    const residual = this.calibrationWindow.reduce((s, w) => s + (w.predicted - w.actual), 0) / n;
    const direction: CalibrationStatus['direction'] =
      n < 10 ? 'insufficient' : residual > 0.1 ? 'overconfident' : residual < -0.1 ? 'underconfident' : 'calibrated';
    // 3.0 自修正量：样本充分且系统性偏差显著时，给出保守的预测偏移建议
    const correction = n >= 20 && Math.abs(residual) > 0.1 ? Math.max(-0.15, Math.min(0.15, -residual * 0.5)) : 0;
    return {
      brierScore: Number(brier.toFixed(6)),
      residualMean: Number(residual.toFixed(6)),
      samples: n,
      direction,
      windowSize,
      correction: Number(correction.toFixed(6)),
    };
  }

  /**
   * 校准自修正（3.0）：对调度预测置信度施加校准偏移
   *
   * 过自信系统（如预测 0.9 实际 0.7）→ 收缩预测使其贴近真实成功率；
   * 欠自信系统 → 适度放大。样本不足或已校准时为恒等映射（零风险旁路）。
   */
  correctConfidence(predicted: number): number {
    const { correction, samples } = this.getCalibration();
    if (correction === 0 || samples < 20) return predicted;
    return Number(Math.max(0, Math.min(1, predicted + correction)).toFixed(6));
  }

  /**
   * 自知之明报告（3.0：系统对自己记忆与预测质量的一次性全景自检）
   *
   * 汇聚两路自知信号：
   * - calibration：调度预测校准（Brier / 残差 / 方向 / 自修正量）
   * - census：全层证据普查（各记忆层证据覆盖度 + 有效样本量 + 证据枯竭 +
   *   模型能力漂移）——记忆库未实现 evidenceCensus 时静默省略（旧实现兼容）
   */
  getSelfKnowledge(): { generatedAt: number; calibration: CalibrationStatus; census?: import('./memory/long-term-memory.js').EvidenceCensus } {
    const calibration = this.getCalibration();
    const memoryWithCensus = this.memory as import('./memory/long-term-memory.js').LongTermMemory;
    const census = typeof memoryWithCensus.evidenceCensus === 'function' ? memoryWithCensus.evidenceCensus() : undefined;
    return { generatedAt: Date.now(), calibration, census };
  }

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
  private analyzeCounterfactualRegret(signal: Signal, plan: ExecutionPlan, result: PlanExecutionResult): void {
    if (!this.memory.getBayesianEstimate) return; // 记忆库未提供贝叶斯估计（旧实现兼容）
    const margin = this.config.counterfactualMargin ?? 0.1;
    const minSamples = this.config.counterfactualMinSamples ?? 3;
    const nodeTypeById = new Map(plan.nodes.map((n) => [n.id, n.type] as const));

    for (const node of result.nodeResults) {
      const taskType = nodeTypeById.get(node.nodeId);
      if (!taskType) continue;
      const usedEstimate = this.memory.getBayesianEstimate(node.modelId, taskType);
      if (!usedEstimate || usedEstimate.effectiveSamples < minSamples) continue;

      let bestAlternative: { modelId: string; wilsonLower: number; samples: number } | undefined;
      for (const profile of this.memory.getAllModelProfiles()) {
        if (profile.id === node.modelId) continue;
        const est = this.memory.getBayesianEstimate!(profile.id, taskType);
        if (!est || est.effectiveSamples < minSamples) continue;
        if (est.wilsonLower > usedEstimate.posteriorMean + margin && (!bestAlternative || est.wilsonLower > bestAlternative.wilsonLower)) {
          bestAlternative = { modelId: profile.id, wilsonLower: est.wilsonLower, samples: est.effectiveSamples };
        }
      }
      if (!bestAlternative) continue;

      const lesson = `[反事实] ${taskType} 节点 ${node.nodeId} 使用 ${node.modelId}（贝叶斯后验 ${usedEstimate.posteriorMean.toFixed(2)}，本次${node.success ? '成功' : '失败'}），但 ${bestAlternative.modelId} 的威尔逊下界 ${bestAlternative.wilsonLower.toFixed(2)}（有效样本 ${bestAlternative.samples.toFixed(0)}）显著更优——下次同类任务优先考虑`;
      this.memory.appendFeedback({
        id: `cf-${node.nodeId}-${node.modelId}-${Date.now()}`,
        timestamp: Date.now(),
        signalType: taskType,
        signalDescription: signal.description,
        decision: `model:${node.modelId}`,
        outcome: node.success ? 'acceptable' : 'poor',
        outcomeReason: 'counterfactual-regret-analysis',
        lesson,
        chosenModelId: node.modelId,
        predictedConfidence: usedEstimate.posteriorMean,
      });
      this.broadcast({
        type: 'counterfactual-regret',
        nodeId: node.nodeId,
        taskType,
        usedModel: node.modelId,
        usedPosterior: usedEstimate.posteriorMean,
        betterModel: bestAlternative.modelId,
        betterWilsonLower: bestAlternative.wilsonLower,
      });
    }
  }

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
  async distillKnowledge(options?: { force?: boolean }): Promise<DistillationReport> {
    const now = Date.now();
    const minConfidence = this.config.distillMinConfidence ?? 0.6;
    const minSuccesses = this.config.distillMinSuccesses ?? 3;
    const affinityThreshold = this.config.distillModelAffinityThreshold ?? 0.6;
    const autoThreshold = this.config.autoDistillThreshold ?? 5;

    // ── 0. 水位门控：无新增样本且已有蒸馏知识 → 跳过全量蒸馏 ──
    if (!options?.force && !this.distilling) {
      const progress = this.memory.getDistillationProgress?.();
      const hasDistilledKnowledge =
        this.memory.getAllSemanticMemories().length > 0 || this.memory.getAllProceduralMemories().length > 0;
      if (progress && hasDistilledKnowledge && progress.pendingSinceLastDistillation < Math.max(1, autoThreshold)) {
        const skippedReport: DistillationReport = {
          distilledAt: now,
          sourceEpisodicCount: 0,
          semanticMemories: [],
          proceduralMemories: [],
          strategies: [],
          summary: `跳过蒸馏：新增情景事件 ${progress.pendingSinceLastDistillation} 未达阈值 ${Math.max(1, autoThreshold)}，既有知识无需刷新`,
          skipped: true,
          skipReason: 'below-threshold',
        };
        return skippedReport;
      }
    }

    // ── 并发防抖：蒸馏进行中直接返回空报告 ──
    if (this.distilling) {
      return {
        distilledAt: now,
        sourceEpisodicCount: 0,
        semanticMemories: [],
        proceduralMemories: [],
        strategies: [],
        summary: '跳过蒸馏：已有蒸馏任务进行中',
        skipped: true,
        skipReason: 'in-flight',
      };
    }

    this.distilling = true;
    try {
      // ── 1. 收集符合条件的情景记忆样本 ──
      const patterns = this.memory.getAllTaskPatterns();
      const qualifiedPatterns = patterns.filter(
        (p) => p.confidence >= minConfidence && p.successfulPlans.length >= minSuccesses,
      );
      const sourceEpisodicCount = qualifiedPatterns.length;

      // ── 2. 兼容：调用既有 distillExperience 产出 DistilledStrategy ──
      const strategies = this.memory.distillExperience(minConfidence);

      // ── 3. 蒸馏语义记忆：模型亲和规律 ──
      const semanticMemories: SemanticMemory[] = [];
      semanticMemories.push(...this.distillModelAffinity(qualifiedPatterns, affinityThreshold, now));
      semanticMemories.push(...this.distillComplexityPatterns(qualifiedPatterns, now));

      // ── 4. 蒸馏程序记忆：调度规则 + 反思规则 ──
      const proceduralMemories: ProceduralMemory[] = [];
      proceduralMemories.push(...this.distillSchedulingRules(qualifiedPatterns, now));
      proceduralMemories.push(...this.distillReflectionRules(now));

      // ── 5. 写入记忆库（第二阶段升级：证据合并 / 冲突取代） ──
      let mergedSemanticCount = 0;
      let mergedProceduralCount = 0;
      let supersededCount = 0;
      const writtenSemantic: SemanticMemory[] = [];
      for (const mem of semanticMemories) {
        const result = this.memory.upsertSemanticMemory(mem);
        if (result === 'merged') {
          mergedSemanticCount += 1;
          // 报告携带合并后的库内版本（含累加后的支撑度）
          writtenSemantic.push(this.memory.getAllSemanticMemories().find((m) => m.id === mem.id) ?? mem);
        } else if (result === 'superseded') {
          supersededCount += 1;
          writtenSemantic.push(mem);
        } else if (result !== 'duplicate') {
          writtenSemantic.push(mem);
        }
      }
      const writtenProcedural: ProceduralMemory[] = [];
      for (const proc of proceduralMemories) {
        const result = this.memory.upsertProceduralMemory(proc);
        if (result === 'merged') {
          mergedProceduralCount += 1;
          writtenProcedural.push(this.memory.getAllProceduralMemories().find((p) => p.id === proc.id) ?? proc);
        } else if (result === 'superseded') {
          supersededCount += 1;
          writtenProcedural.push(proc);
        } else if (result !== 'duplicate') {
          writtenProcedural.push(proc);
        }
      }

      // ── 6. 记忆图挂载（语义/程序记忆与源模式建立共现边） ──
      if (this.graph) {
        for (const mem of writtenSemantic) {
          this.graph.ensureNode(mem.id, 'semantic', mem.statement);
          for (const fp of mem.sourceFingerprints) {
            this.graph.ensureNode(fp, 'pattern', fp);
            this.graph.link(fp, mem.id);
          }
        }
        for (const proc of writtenProcedural) {
          this.graph.ensureNode(proc.id, 'procedural', proc.name);
          for (const fp of proc.sourceFingerprints) {
            this.graph.ensureNode(fp, 'pattern', fp);
            this.graph.link(fp, proc.id);
          }
        }
      }

      // ── 7. 构建摘要 ──
      const summary = this.buildDistillationSummary(sourceEpisodicCount, writtenSemantic, writtenProcedural, strategies);
      const summaryWithMerge =
        mergedSemanticCount + mergedProceduralCount + supersededCount > 0
          ? `${summary}\n证据合并：语义 ${mergedSemanticCount} 条 / 程序 ${mergedProceduralCount} 条；冲突取代 ${supersededCount} 条`
          : summary;

      // ── 8. 蒸馏成功：刷新水位（下次阈值触发以此为基准） ──
      this.memory.noteDistillationCheckpoint?.();

      this.broadcast({
        type: 'knowledge-distilled',
        sourceEpisodicCount,
        semanticCount: writtenSemantic.length,
        proceduralCount: writtenProcedural.length,
        strategyCount: strategies.length,
        mergedSemanticCount,
        mergedProceduralCount,
        supersededCount,
      });

      const report: DistillationReport = {
        distilledAt: now,
        sourceEpisodicCount,
        semanticMemories: writtenSemantic,
        proceduralMemories: writtenProcedural,
        strategies,
        summary: summaryWithMerge,
        mergedSemanticCount,
        mergedProceduralCount,
        supersededCount,
      };
      this.config.onKnowledgeDistilled?.(report);
      return report;
    } finally {
      this.distilling = false;
    }
  }

  /**
   * 内容寻址稳定 id（第二阶段升级）
   *
   * 同一规律（相同组成要素）跨次蒸馏生成相同 id，使 upsert 的证据合并
   * 能命中既有记录，而非每次插入新 id 后靠 statement 判重丢弃证据。
   */
  private stableId(prefix: string, ...parts: Array<string | number>): string {
    const hash = crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 12);
    return `${prefix}-${hash}`;
  }

  /**
   * 蒸馏模型亲和规律（语义记忆 domain='model-affinity'）
   *
   * 按 taskType 聚合所有合格模式中的模型分配，若某模型占比 ≥ affinityThreshold
   * 且支撑模式数 ≥ 2，则产出跨任务规律："X 类任务适合模型 Y"。
   */
  private distillModelAffinity(
    patterns: TaskPatternMemory[],
    affinityThreshold: number,
    now: number,
  ): SemanticMemory[] {
    const result: SemanticMemory[] = [];
    // 按 taskType 聚合模型分配
    const byTaskType = new Map<string, { patterns: TaskPatternMemory[]; modelWins: Map<string, number>; total: number }>();
    for (const pattern of patterns) {
      const taskType = this.extractTaskType(pattern);
      const bucket = byTaskType.get(taskType) ?? { patterns: [], modelWins: new Map<string, number>(), total: 0 };
      bucket.patterns.push(pattern);
      for (const plan of pattern.successfulPlans) {
        for (const modelId of Object.values(plan.modelAssignments)) {
          bucket.modelWins.set(modelId, (bucket.modelWins.get(modelId) ?? 0) + 1);
          bucket.total += 1;
        }
      }
      byTaskType.set(taskType, bucket);
    }

    for (const [taskType, bucket] of byTaskType) {
      if (bucket.patterns.length < 2 || bucket.total === 0) continue;
      for (const [modelId, wins] of bucket.modelWins) {
        const ratio = wins / bucket.total;
        if (ratio >= affinityThreshold) {
          const statement = `${taskType} 类任务适合模型 ${modelId}（跨 ${bucket.patterns.length} 个模式占比 ${(ratio * 100).toFixed(0)}%）`;
          const conditions: SemanticCondition[] = [
            { dimension: 'task-type', operator: 'eq', value: taskType },
          ];
          const conclusion: SemanticConclusion = {
            type: 'model-preference',
            value: modelId,
            rationale: `在 ${bucket.patterns.length} 个高置信度模式中占比 ${(ratio * 100).toFixed(0)}%（${wins}/${bucket.total} 次成功分配）`,
          };
          result.push({
            id: this.stableId('sem-ma', taskType, modelId),
            domain: 'model-affinity',
            statement,
            taskTypes: [taskType],
            conditions,
            conclusion,
            confidence: Math.min(0.95, ratio * 0.9 + 0.1),
            supportCount: wins,
            sourceFingerprints: bucket.patterns.map((p) => p.fingerprint),
            distilledAt: now,
            appliedTotal: 0,
            appliedSuccesses: 0,
          });
        }
      }
    }
    return result;
  }

  /**
   * 蒸馏复杂度模式（语义记忆 domain='complexity-pattern'）
   *
   * 高复杂度（complexity ≥ 0.7）任务的成功模型偏好。
   */
  private distillComplexityPatterns(patterns: TaskPatternMemory[], now: number): SemanticMemory[] {
    const result: SemanticMemory[] = [];
    const highComplexity = patterns.filter((p) => {
      const complexity = Number(p.fingerprint.split('::')[1] ?? 0);
      return complexity >= 0.7;
    });
    if (highComplexity.length < 2) return result;

    const modelWins = new Map<string, number>();
    let total = 0;
    for (const pattern of highComplexity) {
      for (const plan of pattern.successfulPlans) {
        for (const modelId of Object.values(plan.modelAssignments)) {
          modelWins.set(modelId, (modelWins.get(modelId) ?? 0) + 1);
          total += 1;
        }
      }
    }
    if (total === 0) return result;

    for (const [modelId, wins] of modelWins) {
      const ratio = wins / total;
      if (ratio >= 0.6) {
        const statement = `高复杂度任务适合模型 ${modelId}（${highComplexity.length} 个高复杂度模式占比 ${(ratio * 100).toFixed(0)}%）`;
        result.push({
          id: this.stableId('sem-cp', modelId),
          domain: 'complexity-pattern',
          statement,
          taskTypes: [], // 跨任务通用
          conditions: [{ dimension: 'complexity', operator: 'gte', value: 0.7 }],
          conclusion: {
            type: 'model-preference',
            value: modelId,
            rationale: `高复杂度（≥0.7）任务中占比 ${(ratio * 100).toFixed(0)}%（${wins}/${total}）`,
          },
          confidence: Math.min(0.9, ratio * 0.85),
          supportCount: wins,
          sourceFingerprints: highComplexity.map((p) => p.fingerprint),
          distilledAt: now,
          appliedTotal: 0,
          appliedSuccesses: 0,
        });
      }
    }
    return result;
  }

  /**
   * 蒸馏调度规则（程序记忆 kind='scheduling'）
   *
   * 规则：feature='code' 且 complexity ≥ 0.7 的任务 → prefer-model + enable-cot
   * 支撑：该任务类型的成功方案中存在模型偏好。
   */
  private distillSchedulingRules(patterns: TaskPatternMemory[], now: number): ProceduralMemory[] {
    const result: ProceduralMemory[] = [];
    for (const pattern of patterns) {
      const features = (pattern.fingerprint.split('::')[2] ?? '').split(',').filter(Boolean);
      const complexity = Number(pattern.fingerprint.split('::')[1] ?? 0);
      const taskType = this.extractTaskType(pattern);
      if (!features.includes('code') || complexity < 0.7) continue;

      // 统计该模式的最优模型
      const modelWins = new Map<string, number>();
      for (const plan of pattern.successfulPlans) {
        for (const modelId of Object.values(plan.modelAssignments)) {
          modelWins.set(modelId, (modelWins.get(modelId) ?? 0) + 1);
        }
      }
      let bestModel = '';
      let bestWins = 0;
      for (const [modelId, wins] of modelWins) {
        if (wins > bestWins) {
          bestWins = wins;
          bestModel = modelId;
        }
      }
      if (!bestModel || bestWins < 2) continue;

      const conditions: ProceduralCondition[] = [
        { dimension: 'task-type', operator: 'eq', value: taskType },
        { dimension: 'feature', operator: 'contains', value: 'code' },
        { dimension: 'complexity', operator: 'gte', value: 0.7 },
      ];
      const action: ProceduralAction = {
        type: 'prefer-model',
        params: { model: bestModel, cot: true },
        rationale: `长代码任务在 ${bestModel} + CoT 下成功率更高（${bestWins}/${pattern.successfulPlans.length} 次成功）`,
      };
      // 同时附加 enable-cot 动作（通过单独的程序记忆条目，避免动作合取）
      result.push({
        id: this.stableId('proc-sched', taskType, 'prefer', bestModel),
        kind: 'scheduling',
        name: `${taskType} 长代码任务偏好模型 ${bestModel}`,
        taskTypes: [taskType],
        conditions,
        action,
        confidence: Math.min(0.9, pattern.confidence * 0.95),
        supportCount: bestWins,
        sourceFingerprints: [pattern.fingerprint],
        distilledAt: now,
        appliedTotal: 0,
        appliedSuccesses: 0,
      });
      result.push({
        id: this.stableId('proc-sched', taskType, 'cot'),
        kind: 'scheduling',
        name: `${taskType} 长代码任务启用思维链`,
        taskTypes: [taskType],
        conditions,
        action: {
          type: 'enable-cot',
          params: { model: bestModel },
          rationale: `长代码任务启用 CoT 可提升结构化输出质量`,
        },
        confidence: Math.min(0.85, pattern.confidence * 0.9),
        supportCount: bestWins,
        sourceFingerprints: [pattern.fingerprint],
        distilledAt: now,
        appliedTotal: 0,
        appliedSuccesses: 0,
      });
    }
    return result;
  }

  /**
   * 蒸馏反思规则（程序记忆 kind='reflection'）
   *
   * 从反思教训中提炼：rootCause='timeout' → avoid-model + escalate
   * rootCause='model-capability' → avoid-model + retry-switch
   */
  private distillReflectionRules(now: number): ProceduralMemory[] {
    const result: ProceduralMemory[] = [];
    const lessons = this.reflection.getAllLessons();
    // 按 taskType + rootCause 聚合
    const byKey = new Map<string, { taskType: string; rootCause: string; modelIds: Set<string>; count: number }>();
    for (const lesson of lessons) {
      const key = `${lesson.taskType}::${lesson.rootCause}`;
      const bucket = byKey.get(key) ?? { taskType: lesson.taskType, rootCause: lesson.rootCause, modelIds: new Set<string>(), count: 0 };
      bucket.count += 1;
      // 从 lesson 文本中提取模型 id（启发式：匹配 "模型 X" 模式）
      const modelMatch = lesson.lesson.match(/模型\s+(\S+)/);
      if (modelMatch) bucket.modelIds.add(modelMatch[1]!);
      byKey.set(key, bucket);
    }

    for (const [, bucket] of byKey) {
      if (bucket.count < 2) continue; // 至少 2 次同类教训才蒸馏为规则
      for (const modelId of bucket.modelIds) {
        const conditions: ProceduralCondition[] = [
          { dimension: 'task-type', operator: 'eq', value: bucket.taskType },
          { dimension: 'root-cause', operator: 'eq', value: bucket.rootCause },
        ];
        const avoidAction: ProceduralAction =
          bucket.rootCause === 'timeout'
            ? {
                type: 'avoid-model',
                params: { model: modelId },
                rationale: `${bucket.taskType} 在 ${modelId} 上累计 ${bucket.count} 次超时，应规避`,
              }
            : {
                type: 'avoid-model',
                params: { model: modelId },
                rationale: `${bucket.taskType} 在 ${modelId} 上累计 ${bucket.count} 次能力不足，应换模型`,
              };
        result.push({
          id: this.stableId('proc-refl', bucket.taskType, bucket.rootCause, modelId),
          kind: 'reflection',
          name: `${bucket.taskType} ${bucket.rootCause} 时规避模型 ${modelId}`,
          taskTypes: [bucket.taskType],
          conditions,
          action: avoidAction,
          confidence: Math.min(0.85, 0.5 + bucket.count * 0.1),
          supportCount: bucket.count,
          sourceFingerprints: [],
          distilledAt: now,
          appliedTotal: 0,
          appliedSuccesses: 0,
        });
      }
    }
    return result;
  }

  /** 从模式指纹提取 taskType（首段，去除 [失败] 前缀） */
  private extractTaskType(pattern: TaskPatternMemory): string {
    return pattern.fingerprint.split('::')[0]?.replace(/^\[失败\]\s*/, '') || 'general';
  }

  /** 构建蒸馏报告摘要 */
  private buildDistillationSummary(
    sourceCount: number,
    semantic: SemanticMemory[],
    procedural: ProceduralMemory[],
    strategies: DistilledStrategy[],
  ): string {
    const lines = [
      `知识蒸馏完成：来源情景记忆 ${sourceCount} 条`,
      `产出语义记忆 ${semantic.length} 条${semantic.length > 0 ? `（${semantic.map((m) => m.statement).join('；')}）` : ''}`,
      `产出程序记忆 ${procedural.length} 条${procedural.length > 0 ? `（${procedural.map((p) => p.name).join('；')}）` : ''}`,
      `产出蒸馏策略 ${strategies.length} 条（兼容）`,
    ];
    return lines.join('\n');
  }

  /** 经验沉淀：成功方案 / 失败记录写入记忆库并登记同步变更 */
  private settleExperience(signal: Signal, plan: ExecutionPlan, result: PlanExecutionResult): void {
    const taskType = plan.nodes[0]?.type ?? signal.type;
    const complexity = Math.min(1, plan.nodes.length / 5);
    const features = [...new Set(plan.nodes.map((n) => n.type))];
    const taskSummary = signal.description;

    if (result.success) {
      const modelAssignments: Record<string, string> = {};
      const qualityScores: Record<string, number> = {};
      for (const nodeResult of result.nodeResults) {
        modelAssignments[nodeResult.nodeId] = nodeResult.modelId;
        qualityScores[nodeResult.nodeId] = nodeResult.quality;
      }
      this.memory.recordSuccess({
        taskType,
        complexity,
        features,
        taskSummary,
        plan: { objective: plan.objective, nodes: plan.nodes.map((n) => ({ id: n.id, description: n.description, type: n.type, dependsOn: n.dependsOn })), parallelismStrategy: plan.parallelismStrategy },
        modelAssignments,
        totalLatency: result.totalTime,
        qualityScores,
        tokenCost: result.totalTokens,
      });
      this.onMemoryChange?.('pattern-updated', fingerprintOf(taskType, complexity), { taskType, complexity, outcome: 'success' });
    } else {
      const failed = result.nodeResults.find((r) => !r.success);
      this.memory.recordFailure({
        taskType,
        complexity,
        features,
        reason: failed?.error ?? '计划执行失败',
        failedNodeId: failed?.nodeId ?? 'unknown',
        failedModelId: failed?.modelId ?? 'unknown',
        errorMessage: failed?.error ?? 'unknown',
      });
      this.onMemoryChange?.('pattern-updated', fingerprintOf(taskType, complexity), { taskType, complexity, outcome: 'failure' });
    }
  }

  /** 进度事件广播（enableProgress 关闭或 broadcaster 缺省时为空操作） */
  private broadcast(event: Record<string, any>): void {
    if (this.config.enableProgress === false || !this.broadcaster) return;
    this.broadcaster.broadcast({ type: event.type as string, timestamp: Date.now(), ...event });
  }
}

/** 任务指纹（taskType + complexity 分档，同步变更登记的稳定键） */
function fingerprintOf(taskType: string, complexity: number): string {
  return crypto.createHash('sha256').update(`${taskType}:${Math.round(complexity * 10)}`).digest('hex').slice(0, 16);
}
