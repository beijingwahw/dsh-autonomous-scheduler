/**
 * self-model.ts — 自我建模引擎（第四阶段「元认知层」核心 1/2，implements ISelfModel）
 *
 * 职责：持续观察操作环（任务执行）与进化环（策略进化）的运行状态，
 * 产出结构化「心智报告」——系统对自身决策质量、记忆健康、进化效率、
 * 稳定性风险的周期性自我认知。
 *
 * 心智报告四视图：
 * 1. strategyPerformance：当前策略的优势（高成功率任务类型）与盲点
 *    （低成功率类型）+ 按策略版本归因的表现（版本升级收益证据基础）
 * 2. memoryQuality：三层记忆的增长/平稳/退化趋势 + 蒸馏水位
 * 3. evolverEfficiency：新策略发现速率与存活率（劣化会被金丝雀回滚）
 * 4. systemStability：综合稳定分 + 风险点清单 + token 趋势
 *
 * 自我改进证据（improvementEvidence）：与上一份报告的机器可验证对比——
 * 策略版本升级的成功率变化、程序记忆条数增长、发现间隔缩短、
 * 操作环成功率提升，全部携带 before/after 数值。
 *
 * 推荐调整（recommendedAdjustments）：规则化诊断 → 旋钮 id + 方向 + 优先级，
 * 交由元认知控制器保守执行（本引擎只诊断不开药方剂量）。
 *
 * 报告历史持久化（JSON）：重启后恢复，趋势分析与效果判定跨重启连续。
 */

import fs from 'node:fs';
import type { DecisionFeedback } from '../memory/long-term-memory.js';
import type { PolicyEvolverStatus } from '../policy/policy-evolver.js';
import type {
  EvolverEfficiencySummary,
  EvolverMetrics,
  HomeostasisBands,
  HomeostasisStatus,
  ImprovementEvidence,
  JudgeMetric,
  KnobEffectiveness,
  MentalReport,
  MemoryQualitySummary,
  MetricForecast,
  MetaStabilitySummary,
  OperationalMetrics,
  ProactiveRisk,
  RecommendedAdjustment,
  StrategyPerformanceSummary,
  SystemMetrics,
  SystemStabilitySummary,
  TrendMetric,
} from './meta-types.js';

// ─────────────────────────── 配置与采集器 ───────────────────────────

/** 自我建模配置 */
export interface SelfModelConfig {
  /** 报告历史持久化路径（缺省不持久化，仅内存趋势） */
  persistPath?: string;
  /** 内存中保留的报告份数（持久化不受限；缺省 50） */
  reportHistoryLimit?: number;
  /** 盲点/优势判定的最小样本数（缺省 3，防小样本噪声） */
  minSamplesPerTaskType?: number;
  /** 操作环表现统计的决策反馈窗口（缺省 100 条） */
  feedbackWindow?: number;
  // ── 2.0：预测与稳态 ──
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
export interface SelfModelCollectors {
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
  getDistillationProgress?(): { pendingSinceLastDistillation: number } | undefined;
  /** 最近决策反馈（操作环素材） */
  getRecentFeedback(limit?: number): DecisionFeedback[];
  /** 2.0：元认知层状态（调参策略学习器 + 熔断器 + 安全包络；由编排层回注） */
  getMetaLayerState?():
    | { knobEffectiveness?: KnobEffectiveness[]; metaStability?: Omit<MetaStabilitySummary, 'homeostasis'> }
    | undefined;
}

/** outcome → 质量分映射（与金丝雀喂数一致的近似） */
const QUALITY_BY_OUTCOME: Record<string, number> = {
  excellent: 0.95,
  good: 0.8,
  acceptable: 0.65,
  poor: 0.4,
  failed: 0.1,
};
const SUCCESS_OUTCOMES = new Set(['excellent', 'good', 'acceptable']);

/** 前瞻风险 → 建议旋钮映射（预测越限时的提前干预手段） */
const PROACTIVE_SUGGESTIONS: Partial<
  Record<TrendMetric, { knob: string; direction: 'up' | 'down' }>
> = {
  operationalSuccessRate: { knob: 'evolver.mutationRate', direction: 'up' }, // 成功率趋降 → 增强探索寻找更优策略基因
  discoveryRate: { knob: 'evolver.minGain', direction: 'down' }, // 发现速率趋缓 → 放宽部署门禁
  survivalRate: { knob: 'sandbox.evaluationSeeds', direction: 'up' }, // 存活率趋降 → 更严沙盒验证
  pendingDistillation: { knob: 'reflector.autoDistillThreshold', direction: 'down' }, // 积压上升 → 更早触发蒸馏
  stabilityScore: { knob: 'sandbox.evaluationSeeds', direction: 'up' }, // 稳定分趋降 → 收紧部署质量
};

/**
 * 稳态偏离计算（self-model 报告与 meta-controller 步长自适应共用）
 *
 * 返回归一化偏离：带内为 0（含近缘 near-edge），带外按带宽归一（可 >1）。
 * 控制器据此量化步长倍率：1 + floor(deviation × 2)，上限 maxStepMultiplier。
 */
export function computeHomeostasis(
  band: { min: number; max: number },
  current: number,
): { deviation: number; state: 'in-band' | 'near-edge' | 'out-of-band' } {
  const width = band.max - band.min;
  if (current < band.min) {
    return { deviation: width > 0 ? (band.min - current) / width : 1, state: 'out-of-band' };
  }
  if (current > band.max) {
    return { deviation: width > 0 ? (current - band.max) / width : 1, state: 'out-of-band' };
  }
  const edgeDistance = Math.min(current - band.min, band.max - current);
  const near = width > 0 ? edgeDistance / width <= 0.15 : false;
  return { deviation: 0, state: near ? 'near-edge' : 'in-band' };
}

// ─────────────────────────── 自我建模引擎 ───────────────────────────

/**
 * 自我建模引擎（implements ISelfModel）
 *
 * 被编排层持有：元认知控制器每轮 evaluateAndAdjust 先调用
 * generateMentalReport 采集最新自我认知；也可经 mental_report Tool
 * 手动触发（人类审查入口）。
 */
export class SelfModel {
  private config: Required<Omit<SelfModelConfig, 'persistPath'>> & Pick<SelfModelConfig, 'persistPath'>;
  private collectors: SelfModelCollectors;
  /** 报告历史（升序；趋势分析与改进证据的对比基线） */
  private history: MentalReport[] = [];
  /** 上一报告窗口的单次执行平均 token（趋势检测基线） */
  private lastTokensPerExecution?: number;

  constructor(params: { collectors: SelfModelCollectors; config?: SelfModelConfig }) {
    this.config = {
      reportHistoryLimit: 50,
      minSamplesPerTaskType: 3,
      feedbackWindow: 100,
      forecastHorizon: 3,
      minForecastHistory: 3,
      anomalyZThreshold: 2.5,
      homeostasisBands: {},
      ...params.config,
    };
    this.collectors = params.collectors;
    this.restore();
  }

  // ── ISelfModel 实现 ──

  /** 采集系统指标快照（心智报告的原始素材） */
  async getSystemMetrics(): Promise<SystemMetrics> {
    const feedback = this.collectors.getRecentFeedback(this.config.feedbackWindow);
    const dbStats = this.collectors.getMemoryStats();
    const global = this.collectors.getGlobalStats();
    const evolverStatus = this.collectors.getEvolverStatus();

    const operational = this.buildOperationalMetrics(feedback);
    const deployedAll = evolverStatus.deployedHistory;
    const deployments = deployedAll.slice(1); // 首节点为初始基准部署
    const rolledBack = deployments.filter((d) => d.rolledBackAt !== undefined);
    const gains = deployments.map((d) => d.gain).filter((g): g is number => typeof g === 'number');

    const evolver: EvolverMetrics = {
      currentPolicyId: evolverStatus.currentPolicy.id,
      currentPolicyVersion: evolverStatus.currentPolicy.version,
      currentPolicyGeneration: evolverStatus.currentPolicy.generation,
      currentPolicyOrigin: evolverStatus.currentPolicy.origin,
      totalCycles: evolverStatus.totalCycles,
      totalCandidatesEvaluated: evolverStatus.totalCandidatesEvaluated,
      deployedCount: deployments.length,
      rolledBackCount: rolledBack.length,
      survivalRate: deployments.length > 0 ? (deployments.length - rolledBack.length) / deployments.length : 1,
      discoveryRate: evolverStatus.totalCycles > 0 ? deployments.length / evolverStatus.totalCycles : 0,
      avgDiscoveryIntervalMs: this.avgDiscoveryInterval(deployedAll),
      avgDeployedGain: gains.length > 0 ? gains.reduce((s, g) => s + g, 0) / gains.length : 0,
      sigmaScale: evolverStatus.sigmaScale,
      populationSize: evolverStatus.population.length,
      canaryStatus: evolverStatus.canary?.status ?? 'none',
      deployedHistory: deployedAll.map((d) => ({
        id: d.id,
        version: d.version,
        generation: d.generation,
        deployedAt: d.deployedAt,
        rolledBackAt: d.rolledBackAt,
      })),
    };

    return {
      collectedAt: Date.now(),
      operational,
      memory: {
        counts: {
          episodic: dbStats.patterns,
          semantic: dbStats.semantic,
          procedural: dbStats.procedural,
          strategies: dbStats.strategies,
          modelProfiles: dbStats.profiles,
          feedback: dbStats.feedback,
        },
        pendingSinceLastDistillation:
          this.collectors.getDistillationProgress?.()?.pendingSinceLastDistillation ?? 0,
        totalExecutions: global.totalExecutions,
        totalSuccesses: global.totalSuccesses,
        totalFailures: global.totalFailures,
        totalTokensUsed: global.totalTokensUsed,
        averageQualityScore: global.averageQualityScore,
        averageExecutionTime: global.averageExecutionTime,
      },
      evolver,
    };
  }

  /** 生成心智报告（持续进程：历史累积 → 趋势与改进证据） */
  async generateMentalReport(): Promise<MentalReport> {
    const metrics = await this.getSystemMetrics();
    const previous = this.history[this.history.length - 1];
    const reportIndex = (previous?.reportIndex ?? 0) + 1;

    const strategyPerformance = this.buildStrategyPerformance(metrics, previous);
    const memoryQuality = this.buildMemoryQuality(metrics, previous);
    const evolverEfficiency = this.buildEvolverEfficiency(metrics);
    const systemStability = this.buildStability(metrics, memoryQuality, evolverEfficiency, previous);
    const improvementEvidence = this.buildEvidence(metrics, previous, strategyPerformance);
    const recommendedAdjustments = this.recommend(metrics, strategyPerformance, memoryQuality, evolverEfficiency);

    // ── 2.0：预测性自我建模（趋势外推 → 前瞻风险）+ 异常检测 ──
    const forecasts = this.buildForecasts(metrics, systemStability);
    const proactiveRisks = this.buildProactiveRisks(forecasts);
    this.detectAnomalies(metrics, systemStability);

    // ── 2.0：元认知层自察（学习器/熔断器/安全包络由控制器回注 + 本地稳态带评估） ──
    const metaLayer = this.collectors.getMetaLayerState?.();
    let metaStability: MetaStabilitySummary | undefined;
    if (metaLayer?.metaStability) {
      metaStability = { ...metaLayer.metaStability, homeostasis: this.buildHomeostasis(metrics, systemStability) };
    }

    const report: MentalReport = {
      timestamp: new Date().toISOString(),
      reportIndex,
      generatedAt: metrics.collectedAt,
      strategyPerformance,
      memoryQuality,
      evolverEfficiency,
      systemStability,
      improvementEvidence,
      recommendedAdjustments,
      forecasts,
      proactiveRisks,
      knobEffectiveness: metaLayer?.knobEffectiveness,
      metaStability,
    };

    this.history.push(report);
    if (this.history.length > this.config.reportHistoryLimit) this.history.shift();
    this.persist();
    return structuredClone(report);
  }

  // ── 可观测性入口 ──

  /** 报告历史（升序；趋势分析素材） */
  getReportHistory(): MentalReport[] {
    return this.history.map((r) => structuredClone(r));
  }

  /** 最近一份报告 */
  getLatestReport(): MentalReport | undefined {
    return this.history.length > 0 ? structuredClone(this.history[this.history.length - 1]) : undefined;
  }

  /** 趋势数据（关键指标序列，供图表渲染） */
  getTrendSeries(): {
    reportIndex: number[];
    operationalSuccessRate: number[];
    proceduralCount: number[];
    semanticCount: number[];
    discoveryRate: number[];
    stabilityScore: number[];
  } {
    return {
      reportIndex: this.history.map((r) => r.reportIndex),
      operationalSuccessRate: this.history.map((r) => r.strategyPerformance.operational.successRate),
      proceduralCount: this.history.map((r) => r.memoryQuality.counts.procedural),
      semanticCount: this.history.map((r) => r.memoryQuality.counts.semantic),
      discoveryRate: this.history.map((r) => r.evolverEfficiency.discoveryRate),
      stabilityScore: this.history.map((r) => r.systemStability.stabilityScore),
    };
  }

  /** 人类可读报告（mental_report Tool 输出 / 审查日志） */
  formatReport(report: MentalReport): string {
    const lines: string[] = [];
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    lines.push(`╔═ 心智报告 #${report.reportIndex}（${report.timestamp}）═`);
    lines.push('║ [策略表现]');
    lines.push(
      `║   当前策略 ${report.strategyPerformance.currentPolicyId}@v${report.strategyPerformance.currentPolicyVersion}` +
        `（第 ${report.strategyPerformance.currentPolicyGeneration} 代，来源 ${report.strategyPerformance.currentPolicyOrigin}）`,
    );
    lines.push(
      `║   操作环: 成功率 ${pct(report.strategyPerformance.operational.successRate)} / 质量 ${report.strategyPerformance.operational.avgQuality.toFixed(3)}（样本 ${report.strategyPerformance.operational.sampleCount}）`,
    );
    if (report.strategyPerformance.perVersion.length > 0) {
      lines.push(
        `║   版本归因: ${report.strategyPerformance.perVersion
          .map((v) => `v${v.version}=${pct(v.successRate)}(${v.samples}样本)`)
          .join('，')}`,
      );
    }
    if (report.strategyPerformance.strengths.length > 0) {
      lines.push(
        `║   优势: ${report.strategyPerformance.strengths.map((s) => `${s.taskType} ${pct(s.successRate)}`).join('、')}`,
      );
    }
    if (report.strategyPerformance.blindSpots.length > 0) {
      lines.push(
        `║   盲点: ${report.strategyPerformance.blindSpots.map((s) => `${s.taskType} ${pct(s.successRate)}`).join('、')}`,
      );
    }
    lines.push('║ [记忆体系]');
    lines.push(
      `║   情景 ${report.memoryQuality.counts.episodic} 条（+${report.memoryQuality.growth.episodic}）/ 语义 ${report.memoryQuality.counts.semantic} 条（+${report.memoryQuality.growth.semantic}）/ 程序 ${report.memoryQuality.counts.procedural} 条（+${report.memoryQuality.growth.procedural}）/ 策略 ${report.memoryQuality.counts.strategies} 条`,
    );
    lines.push(
      `║   层趋势: ${report.memoryQuality.layers.map((l) => `${l.layer}=${l.trend}`).join('，')}；蒸馏积压 ${report.memoryQuality.distillation.pendingSinceLastDistillation}`,
    );
    lines.push('║ [进化器效率]');
    lines.push(
      `║   ${report.evolverEfficiency.totalCycles} 轮评估 ${report.evolverEfficiency.totalCandidatesEvaluated} 候选，部署 ${report.evolverEfficiency.deployedCount} 次（存活率 ${pct(report.evolverEfficiency.survivalRate)}，回滚 ${report.evolverEfficiency.rolledBackCount}）`,
    );
    lines.push(
      `║   发现速率 ${report.evolverEfficiency.discoveryRate.toFixed(3)}/轮，平均间隔 ${this.formatDuration(report.evolverEfficiency.avgDiscoveryIntervalMs)}，平均收益 +${report.evolverEfficiency.avgDeployedGain.toFixed(4)}（σ×${report.evolverEfficiency.sigmaScale}）`,
    );
    lines.push('║ [系统稳定性]');
    lines.push(
      `║   稳定分 ${report.systemStability.stabilityScore.toFixed(3)}，token 趋势 ${report.systemStability.tokenUsageTrend}，金丝雀 ${report.systemStability.canaryActive ? '观察中' : '无'}`,
    );
    for (const risk of report.systemStability.riskPoints) {
      lines.push(`║   风险[${risk.severity}] ${risk.area}: ${risk.description}`);
    }
    if (report.improvementEvidence.length > 0) {
      lines.push('║ [自我改进证据]');
      for (const e of report.improvementEvidence) lines.push(`║   ✓ ${e.description}`);
    } else {
      lines.push('║ [自我改进证据] 暂无（首份报告或暂无正向变化）');
    }
    // ── 2.0：预测性自我建模 ──
    if (report.forecasts && report.forecasts.length > 0) {
      lines.push('║ [趋势预测]');
      const METRIC_LABELS: Record<string, string> = {
        operationalSuccessRate: '操作环成功率',
        discoveryRate: '发现速率',
        pendingDistillation: '蒸馏积压',
        survivalRate: '新策略存活率',
        stabilityScore: '综合稳定分',
      };
      for (const f of report.forecasts) {
        const label = METRIC_LABELS[f.metric] ?? f.metric;
        const cross = f.crossesRiskThreshold
          ? ` ⚠ 预计 ${f.crossesRiskThreshold.withinReports} 期后越限（${f.crossesRiskThreshold.direction === 'below' ? '<' : '>'} ${f.crossesRiskThreshold.threshold}）`
          : '';
        lines.push(
          `║   ${label}: ${f.slopePerReport >= 0 ? '+' : ''}${f.slopePerReport.toFixed(4)}/期 → ${f.horizon} 期后 ${f.predictedValue}（R²=${f.r2.toFixed(2)}，置信 ${f.confidence}）${cross}`,
        );
      }
    }
    if (report.proactiveRisks && report.proactiveRisks.length > 0) {
      lines.push('║ [前瞻风险]');
      for (const r of report.proactiveRisks) {
        lines.push(`║   ⚠ ${r.description} → 建议 ${r.suggestedKnob} ${r.suggestedDirection === 'up' ? '↑' : '↓'}（紧迫度 ${r.urgency}）`);
      }
    }
    if (report.knobEffectiveness && report.knobEffectiveness.length > 0) {
      lines.push('║ [调参策略学习]');
      for (const k of report.knobEffectiveness) {
        lines.push(
          `║   ${k.knob} ${k.direction === 'up' ? '↑' : '↓'}: ${k.trials} 试 / ${k.commits} 成（${(k.successRate * 100).toFixed(0)}%），均效 ${k.avgEffectDelta >= 0 ? '+' : ''}${k.avgEffectDelta.toFixed(4)}，评分 ${k.effectivenessScore.toFixed(3)}`,
        );
      }
    }
    if (report.metaStability) {
      lines.push('║ [元认知自察]');
      const ms = report.metaStability;
      const tripped = ms.circuitBreakers.filter((b) => b.tripped);
      lines.push(
        `║   熔断器: ${tripped.length > 0 ? tripped.map((b) => `${b.knob}（连续回滚 ${b.consecutiveRollbacks}）`).join('、') : '全部正常'}${ms.frozenByBreaker ? '；⚠ 全局熔断中' : ''}${ms.globalFrozen ? '；手动冻结中' : ''}`,
      );
      const learned = ms.safeEnvelopes.filter((e) => e.source === 'learned');
      lines.push(`║   安全包络: ${learned.length > 0 ? learned.map((e) => `${e.knob}∈[${e.min}, ${e.max}]（${e.sampleCount} 样本${e.knownBadValues.length > 0 ? `，排除 ${e.knownBadValues.join('/')}` : ''}）`).join('；') : '全部为默认边界'}`);
      lines.push(`║   学习器: ${ms.learner.totalTrials} 次试验 / ${ms.learner.arms} 臂，平均置信权重 ${ms.learner.explorationWeight.toFixed(2)}`);
      const outOfBand = ms.homeostasis.filter((h) => h.state === 'out-of-band');
      if (outOfBand.length > 0) {
        lines.push(`║   稳态带: ⚠ 越带 ${outOfBand.map((h) => `${h.metric}=${h.current}（带 [${h.band.min}, ${h.band.max}]，偏离 ${h.deviation}）`).join('、')}`);
      } else if (ms.homeostasis.length > 0) {
        lines.push('║   稳态带: 全部指标处于目标带内');
      }
    }
    if (report.recommendedAdjustments.length > 0) {
      lines.push('║ [推荐调整]');
      for (const r of report.recommendedAdjustments) {
        lines.push(`║   → ${r.label} ${r.direction === 'up' ? '↑' : '↓'}（优先级 ${r.priority.toFixed(2)}）：${r.reason}`);
      }
    }
    lines.push('╚════════════════════════════');
    return lines.join('\n');
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 操作环指标：反馈窗口聚合 + 按任务类型分组 */
  private buildOperationalMetrics(feedback: DecisionFeedback[]): OperationalMetrics {
    const byType = new Map<string, { total: number; successes: number; qualitySum: number }>();
    let successes = 0;
    let qualitySum = 0;
    for (const f of feedback) {
      const success = SUCCESS_OUTCOMES.has(f.outcome);
      const quality = QUALITY_BY_OUTCOME[f.outcome] ?? 0.5;
      if (success) successes += 1;
      qualitySum += quality;
      const entry = byType.get(f.signalType) ?? { total: 0, successes: 0, qualitySum: 0 };
      entry.total += 1;
      if (success) entry.successes += 1;
      entry.qualitySum += quality;
      byType.set(f.signalType, entry);
    }
    const n = feedback.length;
    return {
      successRate: n > 0 ? successes / n : 1,
      avgQuality: n > 0 ? qualitySum / n : 1,
      sampleCount: n,
      perTaskType: [...byType.entries()]
        .map(([taskType, e]) => ({
          taskType,
          total: e.total,
          successes: e.successes,
          successRate: e.successes / e.total,
          avgQuality: e.qualitySum / e.total,
        }))
        .sort((a, b) => b.total - a.total),
    };
  }

  /** 平均发现间隔：相邻部署 deployedAt 差均值（wall-clock） */
  private avgDiscoveryInterval(deployedAll: PolicyEvolverStatus['deployedHistory']): number {
    const times = deployedAll.map((d) => d.deployedAt).sort((a, b) => a - b);
    if (times.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < times.length; i += 1) sum += times[i] - times[i - 1];
    return sum / (times.length - 1);
  }

  /** 策略表现：版本归因（按 deployedAt 时间窗分配反馈）+ 优势/盲点 */
  private buildStrategyPerformance(metrics: SystemMetrics, previous?: MentalReport): StrategyPerformanceSummary {
    const { evolver, operational } = metrics;
    const feedback = this.collectors.getRecentFeedback(this.config.feedbackWindow);

    // 版本归因：每条反馈归属「部署时间 ≤ 反馈时间」的最新策略
    const perVersion: StrategyPerformanceSummary['perVersion'] = [];
    if (evolver.deployedHistory.length > 0) {
      const sortedDeployments = [...evolver.deployedHistory].sort((a, b) => a.deployedAt - b.deployedAt);
      const acc = sortedDeployments.map((d) => ({
        policyId: d.id,
        version: d.version,
        samples: 0,
        successes: 0,
        qualitySum: 0,
      }));
      for (const f of feedback) {
        let owner = 0;
        for (let i = 0; i < sortedDeployments.length; i += 1) {
          if (sortedDeployments[i].deployedAt <= f.timestamp) owner = i;
        }
        const entry = acc[owner];
        if (!entry) continue;
        entry.samples += 1;
        if (SUCCESS_OUTCOMES.has(f.outcome)) entry.successes += 1;
        entry.qualitySum += QUALITY_BY_OUTCOME[f.outcome] ?? 0.5;
      }
      for (const e of acc) {
        if (e.samples === 0) continue;
        perVersion.push({
          policyId: e.policyId,
          version: e.version,
          successRate: e.successes / e.samples,
          avgQuality: e.qualitySum / e.samples,
          samples: e.samples,
        });
      }
    }

    const minSamples = this.config.minSamplesPerTaskType;
    const qualified = operational.perTaskType.filter((t) => t.total >= minSamples);
    const sortedByRate = [...qualified].sort((a, b) => a.successRate - b.successRate);
    const blindSpots = sortedByRate
      .filter((t) => t.successRate < 0.6)
      .slice(0, 3)
      .map((t) => ({ taskType: t.taskType, successRate: t.successRate, samples: t.total }));
    const strengths = [...sortedByRate]
      .reverse()
      .filter((t) => t.successRate >= 0.75)
      .slice(0, 3)
      .map((t) => ({ taskType: t.taskType, successRate: t.successRate, samples: t.total }));

    return {
      currentPolicyId: evolver.currentPolicyId,
      currentPolicyVersion: evolver.currentPolicyVersion,
      currentPolicyGeneration: evolver.currentPolicyGeneration,
      currentPolicyOrigin: evolver.currentPolicyOrigin,
      operational: {
        successRate: operational.successRate,
        avgQuality: operational.avgQuality,
        sampleCount: operational.sampleCount,
      },
      perVersion,
      strengths,
      blindSpots,
      sandboxFitness: previous?.strategyPerformance.sandboxFitness,
    };
  }

  /** 记忆质量：三层增长趋势 + 蒸馏水位 */
  private buildMemoryQuality(metrics: SystemMetrics, previous?: MentalReport): MemoryQualitySummary {
    const { counts } = metrics.memory;
    const growth = previous
      ? {
          episodic: counts.episodic - previous.memoryQuality.counts.episodic,
          semantic: counts.semantic - previous.memoryQuality.counts.semantic,
          procedural: counts.procedural - previous.memoryQuality.counts.procedural,
          strategies: counts.strategies - previous.memoryQuality.counts.strategies,
        }
      : { episodic: 0, semantic: 0, procedural: 0, strategies: 0 };

    const layerTrend = (delta: number): 'growing' | 'stable' | 'degrading' =>
      delta > 0 ? 'growing' : delta < 0 ? 'degrading' : 'stable';
    const layers: MemoryQualitySummary['layers'] = [
      {
        layer: 'episodic',
        trend: layerTrend(growth.episodic),
        detail: `任务模式 ${counts.episodic} 条（较上期 ${growth.episodic >= 0 ? '+' : ''}${growth.episodic}）`,
      },
      {
        layer: 'semantic',
        trend: layerTrend(growth.semantic),
        detail: `语义记忆 ${counts.semantic} 条（较上期 ${growth.semantic >= 0 ? '+' : ''}${growth.semantic}）`,
      },
      {
        layer: 'procedural',
        trend: layerTrend(growth.procedural),
        detail: `程序记忆 ${counts.procedural} 条（较上期 ${growth.procedural >= 0 ? '+' : ''}${growth.procedural}）`,
      },
    ];

    return {
      counts,
      growth,
      distillation: { pendingSinceLastDistillation: metrics.memory.pendingSinceLastDistillation },
      layers,
      totalExecutions: metrics.memory.totalExecutions,
      averageQualityScore: metrics.memory.averageQualityScore,
    };
  }

  /** 进化器效率 */
  private buildEvolverEfficiency(metrics: SystemMetrics): EvolverEfficiencySummary {
    const e = metrics.evolver;
    return {
      totalCycles: e.totalCycles,
      totalCandidatesEvaluated: e.totalCandidatesEvaluated,
      deployedCount: e.deployedCount,
      survivalRate: e.survivalRate,
      rolledBackCount: e.rolledBackCount,
      discoveryRate: e.discoveryRate,
      avgDiscoveryIntervalMs: e.avgDiscoveryIntervalMs,
      avgDeployedGain: e.avgDeployedGain,
      sigmaScale: e.sigmaScale,
      populationSize: e.populationSize,
      canaryStatus: e.canaryStatus,
    };
  }

  /** 稳定性：综合分 + 风险点 */
  private buildStability(
    metrics: SystemMetrics,
    memory: MemoryQualitySummary,
    evolver: EvolverEfficiencySummary,
    previous?: MentalReport,
  ): SystemStabilitySummary {
    const riskPoints: SystemStabilitySummary['riskPoints'] = [];
    const operational = metrics.operational;

    if (operational.sampleCount >= 5 && operational.successRate < 0.7) {
      riskPoints.push({
        severity: operational.successRate < 0.5 ? 'high' : 'medium',
        area: 'operations',
        description: `操作环成功率 ${(operational.successRate * 100).toFixed(1)}% 低于 70% 健康线`,
      });
    }
    if (evolver.deployedCount >= 2 && evolver.survivalRate < 0.6) {
      riskPoints.push({
        severity: 'high',
        area: 'evolver',
        description: `新策略存活率仅 ${(evolver.survivalRate * 100).toFixed(0)}%（${evolver.rolledBackCount}/${evolver.deployedCount} 被回滚），沙盒门禁与真实表现脱钩`,
      });
    }
    if (evolver.totalCycles >= 5 && evolver.discoveryRate === 0) {
      riskPoints.push({
        severity: 'medium',
        area: 'evolver',
        description: `连续 ${evolver.totalCycles} 轮进化未发现可部署策略（探索不足或门禁过严）`,
      });
    }
    if (memory.distillation.pendingSinceLastDistillation >= 10) {
      riskPoints.push({
        severity: 'low',
        area: 'memory',
        description: `蒸馏积压 ${memory.distillation.pendingSinceLastDistillation} 条情景事件未沉淀为高级记忆`,
      });
    }
    for (const layer of memory.layers) {
      if (layer.trend === 'degrading') {
        riskPoints.push({ severity: 'low', area: 'memory', description: `${layer.layer} 记忆层退化：${layer.detail}` });
      }
    }
    if (metrics.memory.totalExecutions > 0 && metrics.memory.totalFailures / Math.max(1, metrics.memory.totalExecutions) > 0.4) {
      riskPoints.push({
        severity: 'medium',
        area: 'operations',
        description: `历史累计失败率 ${(metrics.memory.totalFailures / metrics.memory.totalExecutions * 100).toFixed(0)}% 偏高`,
      });
    }

    const stabilityScore = Math.max(
      0,
      Math.min(
        1,
        operational.successRate * 0.4 +
          evolver.survivalRate * 0.3 +
          (1 - Math.min(1, memory.distillation.pendingSinceLastDistillation / 30)) * 0.1 +
          (memory.layers.every((l) => l.trend !== 'degrading') ? 0.2 : 0.1),
      ),
    );

    // token 趋势：单次执行平均 token 消耗对比上一报告窗口（±10% 内视为平稳）
    const tokensPerExecution =
      metrics.memory.totalExecutions > 0 ? metrics.memory.totalTokensUsed / metrics.memory.totalExecutions : 0;
    let tokenUsageTrend: SystemStabilitySummary['tokenUsageTrend'] = 'unknown';
    if (this.lastTokensPerExecution !== undefined && this.lastTokensPerExecution > 0 && tokensPerExecution > 0) {
      const change = (tokensPerExecution - this.lastTokensPerExecution) / this.lastTokensPerExecution;
      tokenUsageTrend = change > 0.1 ? 'rising' : change < -0.1 ? 'falling' : 'stable';
    }
    if (tokensPerExecution > 0) this.lastTokensPerExecution = tokensPerExecution;

    return {
      stabilityScore: Number(stabilityScore.toFixed(3)),
      riskPoints,
      recentRollbacks: evolver.rolledBackCount,
      canaryActive: evolver.canaryStatus === 'active',
      tokenUsageTrend,
    };
  }

  /** 自我改进证据：与上份报告的机器可验证对比 */
  private buildEvidence(
    metrics: SystemMetrics,
    previous: MentalReport | undefined,
    strategy: StrategyPerformanceSummary,
  ): ImprovementEvidence[] {
    const evidence: ImprovementEvidence[] = [];
    if (!previous) return evidence;
    const now = metrics.collectedAt;

    // 1. 策略版本升级 + 成功率对照
    if (strategy.currentPolicyVersion > previous.strategyPerformance.currentPolicyVersion) {
      const beforeVer = previous.strategyPerformance.perVersion.find(
        (v) => v.version === previous.strategyPerformance.currentPolicyVersion,
      );
      const afterVer = strategy.perVersion.find((v) => v.version === strategy.currentPolicyVersion);
      const pp = (delta: number) => `${(delta * 100 >= 0 ? '+' : '')}${(delta * 100).toFixed(1)}pp`;
      let description = `策略 v${previous.strategyPerformance.currentPolicyVersion} 升级到 v${strategy.currentPolicyVersion}（第 ${strategy.currentPolicyGeneration} 代，来源 ${strategy.currentPolicyOrigin}）`;
      if (beforeVer && afterVer && beforeVer.samples >= 3 && afterVer.samples >= 3) {
        const delta = afterVer.successRate - beforeVer.successRate;
        description += `，平均任务成功率 ${(beforeVer.successRate * 100).toFixed(1)}% → ${(afterVer.successRate * 100).toFixed(1)}%（${pp(delta)}）`;
        evidence.push({
          kind: 'policy-upgrade',
          description,
          before: Number(beforeVer.successRate.toFixed(4)),
          after: Number(afterVer.successRate.toFixed(4)),
          unit: 'ratio',
          measuredAt: now,
        });
      } else {
        evidence.push({ kind: 'policy-upgrade', description, measuredAt: now });
      }
    }

    // 2. 高级记忆增长（程序/语义）
    const procDelta = metrics.memory.counts.procedural - previous.memoryQuality.counts.procedural;
    if (procDelta > 0) {
      evidence.push({
        kind: 'memory-growth',
        description: `蒸馏出的程序记忆从 ${previous.memoryQuality.counts.procedural} 条增加到 ${metrics.memory.counts.procedural} 条（+${procDelta}）`,
        before: previous.memoryQuality.counts.procedural,
        after: metrics.memory.counts.procedural,
        unit: '条',
        measuredAt: now,
      });
    }
    const semDelta = metrics.memory.counts.semantic - previous.memoryQuality.counts.semantic;
    if (semDelta > 0) {
      evidence.push({
        kind: 'memory-growth',
        description: `语义记忆从 ${previous.memoryQuality.counts.semantic} 条增加到 ${metrics.memory.counts.semantic} 条（+${semDelta}）`,
        before: previous.memoryQuality.counts.semantic,
        after: metrics.memory.counts.semantic,
        unit: '条',
        measuredAt: now,
      });
    }

    // 3. 进化器发现效率（发现间隔缩短 ≥ 10%）
    const prevInterval = previous.evolverEfficiency.avgDiscoveryIntervalMs;
    const nowInterval = metrics.evolver.avgDiscoveryIntervalMs;
    if (prevInterval > 0 && nowInterval > 0 && nowInterval <= prevInterval * 0.9) {
      evidence.push({
        kind: 'evolver-efficiency',
        description: `进化器发现新策略的平均时间从 ${this.formatDuration(prevInterval)} 缩短到 ${this.formatDuration(nowInterval)}`,
        before: prevInterval,
        after: nowInterval,
        unit: 'ms',
        measuredAt: now,
      });
    }

    // 4. 操作环质量提升（≥ 2pp 且样本充足）
    const prevRate = previous.strategyPerformance.operational.successRate;
    const curRate = strategy.operational.successRate;
    if (
      previous.strategyPerformance.operational.sampleCount >= 5 &&
      strategy.operational.sampleCount >= 5 &&
      curRate - prevRate >= 0.02
    ) {
      evidence.push({
        kind: 'quality-gain',
        description: `平均任务成功率从 ${(prevRate * 100).toFixed(1)}% 提升到 ${(curRate * 100).toFixed(1)}%（+${((curRate - prevRate) * 100).toFixed(1)}pp）`,
        before: Number(prevRate.toFixed(4)),
        after: Number(curRate.toFixed(4)),
        unit: 'ratio',
        measuredAt: now,
      });
    }

    return evidence;
  }

  /** 规则化诊断 → 推荐调整（仅诊断方向，剂量由元认知控制器保守决定） */
  private recommend(
    metrics: SystemMetrics,
    strategy: StrategyPerformanceSummary,
    memory: MemoryQualitySummary,
    evolver: EvolverEfficiencySummary,
  ): RecommendedAdjustment[] {
    const recs: RecommendedAdjustment[] = [];
    const KNOB_LABELS: Record<string, string> = {
      'evolver.mutationRate': '进化器变异率',
      'evolver.minGain': '进化器部署门禁（选择压力）',
      'sandbox.evaluationSeeds': '沙盒多种子评估严格度',
      'reflector.autoDistillThreshold': '反思器自动蒸馏阈值',
      'reflector.distillMinConfidence': '知识蒸馏写入置信度门槛',
      'optimizer.memoryFastPathThreshold': '记忆快路径复用门槛',
    };

    // 新策略存活率低 → 收紧选择压力 + 更严沙盒验证
    if (evolver.deployedCount >= 2 && evolver.survivalRate < 0.6) {
      recs.push({
        knob: 'evolver.minGain',
        label: KNOB_LABELS['evolver.minGain'],
        direction: 'up',
        reason: `新策略存活率 ${(evolver.survivalRate * 100).toFixed(0)}%，沙盒放行的劣质策略过多，需提高部署门禁`,
        priority: 0.9,
      });
      recs.push({
        knob: 'sandbox.evaluationSeeds',
        label: KNOB_LABELS['sandbox.evaluationSeeds'],
        direction: 'up',
        reason: '提高多种子统计门禁严格度，降低沙盒与操作环脱钩风险',
        priority: 0.85,
      });
    }

    // 存在盲点任务类型 → 增强探索
    if (strategy.blindSpots.length > 0) {
      recs.push({
        knob: 'evolver.mutationRate',
        label: KNOB_LABELS['evolver.mutationRate'],
        direction: 'up',
        reason: `存在盲点任务类型（${strategy.blindSpots.map((b) => b.taskType).join('、')}），增强变异探索以发现针对性策略基因`,
        priority: 0.8,
      });
    }

    // 进化停滞 → 放宽门禁（与存活率低场景互斥：discoveryRate=0 时通常部署少）
    if (evolver.totalCycles >= 5 && evolver.discoveryRate === 0 && evolver.deployedCount < 2) {
      recs.push({
        knob: 'evolver.minGain',
        label: KNOB_LABELS['evolver.minGain'],
        direction: 'down',
        reason: `连续 ${evolver.totalCycles} 轮进化零部署，选择压力过强抑制了增量改进`,
        priority: 0.75,
      });
    }

    // 蒸馏积压 → 降低自动蒸馏阈值（更频繁触发）
    if (memory.distillation.pendingSinceLastDistillation >= 8) {
      recs.push({
        knob: 'reflector.autoDistillThreshold',
        label: KNOB_LABELS['reflector.autoDistillThreshold'],
        direction: 'down',
        reason: `蒸馏积压 ${memory.distillation.pendingSinceLastDistillation} 条情景事件，应更早触发知识蒸馏`,
        priority: 0.7,
      });
    }

    // 情景增长但高级记忆零增长 → 降低蒸馏写入门槛
    if (memory.growth.episodic >= 2 && memory.growth.semantic + memory.growth.procedural === 0) {
      recs.push({
        knob: 'reflector.distillMinConfidence',
        label: KNOB_LABELS['reflector.distillMinConfidence'],
        direction: 'down',
        reason: '情景记忆持续累积但语义/程序记忆零增长，蒸馏写入门槛可能过高',
        priority: 0.6,
      });
    }

    // 操作环稳定优质 → 放宽记忆快路径门槛（更多复用，降本提速）
    if (strategy.operational.sampleCount >= 10 && strategy.operational.successRate >= 0.85) {
      recs.push({
        knob: 'optimizer.memoryFastPathThreshold',
        label: KNOB_LABELS['optimizer.memoryFastPathThreshold'],
        direction: 'down',
        reason: `操作环成功率 ${(strategy.operational.successRate * 100).toFixed(0)}% 稳定优质，可放宽复用门槛加速经验快路径`,
        priority: 0.4,
      });
    }

    return recs.sort((a, b) => b.priority - a.priority);
  }

  private formatDuration(ms: number): string {
    if (ms <= 0) return '—';
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }

  // ─────────────────── 2.0：预测性自我建模 ───────────────────

  /** 从报告提取趋势指标取值 */
  private metricValueOf(report: MentalReport, metric: TrendMetric): number {
    switch (metric) {
      case 'operationalSuccessRate':
        return report.strategyPerformance.operational.successRate;
      case 'discoveryRate':
        return report.evolverEfficiency.discoveryRate;
      case 'proceduralGrowth':
        return report.memoryQuality.counts.procedural;
      case 'pendingDistillation':
        return report.memoryQuality.distillation.pendingSinceLastDistillation;
      case 'survivalRate':
        return report.evolverEfficiency.survivalRate;
      case 'stabilityScore':
        return report.systemStability.stabilityScore;
    }
  }

  /**
   * 趋势外推：关键指标最小二乘拟合 → horizon 期预测 + 越限检测
   *
   * 从被动描述（当前值 + 增量）升级为主动预测：指标按当前轨迹
   * 将在 horizon 内穿越风险阈值时产出 crossesRiskThreshold——
   * 前瞻性调整的触发基础（风险发生前行动，而非发生后补救）。
   */
  private buildForecasts(metrics: SystemMetrics, stability: SystemStabilitySummary): MetricForecast[] {
    const horizon = this.config.forecastHorizon;
    const currentValueOf = (metric: TrendMetric): number => {
      switch (metric) {
        case 'operationalSuccessRate':
          return metrics.operational.successRate;
        case 'discoveryRate':
          return metrics.evolver.discoveryRate;
        case 'proceduralGrowth':
          return metrics.memory.counts.procedural;
        case 'pendingDistillation':
          return metrics.memory.pendingSinceLastDistillation;
        case 'survivalRate':
          return metrics.evolver.survivalRate;
        case 'stabilityScore':
          return stability.stabilityScore;
      }
    };
    /** 风险阈值（预测越限检测；与反应式规则的已发生阈值互补） */
    const RISK_THRESHOLDS: Partial<Record<TrendMetric, { value: number; direction: 'above' | 'below' }>> = {
      operationalSuccessRate: { value: 0.7, direction: 'below' },
      discoveryRate: { value: 0.05, direction: 'below' },
      pendingDistillation: { value: 25, direction: 'above' },
      survivalRate: { value: 0.6, direction: 'below' },
      stabilityScore: { value: 0.6, direction: 'below' },
    };

    const forecasts: MetricForecast[] = [];
    for (const metric of Object.keys(RISK_THRESHOLDS) as TrendMetric[]) {
      const points = this.history.map((r) => this.metricValueOf(r, metric));
      points.push(currentValueOf(metric));
      if (points.length < this.config.minForecastHistory) continue;

      const fit = this.linearFit(points.slice(-8));
      const predicted = fit.intercept + fit.slope * (fit.n - 1 + horizon);
      const confidence: MetricForecast['confidence'] =
        fit.n >= 4 && fit.r2 >= 0.8 ? 'high' : fit.n >= 3 && fit.r2 >= 0.3 ? 'medium' : 'low';

      const threshold = RISK_THRESHOLDS[metric]!;
      const current = points[points.length - 1];
      let crosses: MetricForecast['crossesRiskThreshold'];
      if (threshold.direction === 'below' && fit.slope < 0 && current > threshold.value) {
        const within = Math.ceil((current - threshold.value) / -fit.slope);
        if (within <= horizon) crosses = { threshold: threshold.value, direction: 'below', withinReports: within };
      } else if (threshold.direction === 'above' && fit.slope > 0 && current < threshold.value) {
        const within = Math.ceil((threshold.value - current) / fit.slope);
        if (within <= horizon) crosses = { threshold: threshold.value, direction: 'above', withinReports: within };
      }

      forecasts.push({
        metric,
        slopePerReport: Number(fit.slope.toFixed(6)),
        currentValue: current,
        horizon,
        predictedValue: Number(predicted.toFixed(6)),
        r2: Number(fit.r2.toFixed(4)),
        confidence,
        crossesRiskThreshold: crosses,
      });
    }
    return forecasts;
  }

  /** 最小二乘拟合（返回斜率/截距/R²） */
  private linearFit(values: number[]): { slope: number; intercept: number; r2: number; n: number } {
    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((s, v) => s + v, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i += 1) {
      sxx += (i - xMean) ** 2;
      sxy += (i - xMean) * (values[i] - yMean);
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const intercept = yMean - slope * xMean;
    let ssTot = 0;
    let ssRes = 0;
    for (let i = 0; i < n; i += 1) {
      ssTot += (values[i] - yMean) ** 2;
      ssRes += (values[i] - (intercept + slope * i)) ** 2;
    }
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 1;
    return { slope, intercept, r2, n };
  }

  /** 前瞻性风险：预测越限 → 紧迫度 + 建议旋钮（元认知控制器提前行动） */
  private buildProactiveRisks(forecasts: MetricForecast[]): ProactiveRisk[] {
    const risks: ProactiveRisk[] = [];
    const METRIC_LABELS: Record<string, string> = {
      operationalSuccessRate: '操作环成功率',
      discoveryRate: '进化发现速率',
      pendingDistillation: '蒸馏积压水位',
      survivalRate: '新策略存活率',
      stabilityScore: '综合稳定分',
    };
    for (const f of forecasts) {
      if (!f.crossesRiskThreshold) continue;
      const suggestion = PROACTIVE_SUGGESTIONS[f.metric];
      if (!suggestion) continue;
      const urgency = Number(
        Math.max(0.6, Math.min(1, 0.6 + 0.4 * (1 - f.crossesRiskThreshold.withinReports / f.horizon))).toFixed(2),
      );
      risks.push({
        metric: f.metric,
        description: `按当前趋势（每期 ${f.slopePerReport >= 0 ? '+' : ''}${f.slopePerReport.toFixed(4)}），${METRIC_LABELS[f.metric] ?? f.metric} 预计 ${f.crossesRiskThreshold.withinReports} 期后越限（阈值 ${f.crossesRiskThreshold.direction === 'below' ? '<' : '>'} ${f.crossesRiskThreshold.threshold}），当前值 ${f.currentValue} 仍健康`,
        forecast: f,
        urgency,
        suggestedKnob: suggestion.knob,
        suggestedDirection: suggestion.direction,
      });
    }
    return risks.sort((a, b) => b.urgency - a.urgency);
  }

  /** 异常检测：关键指标对自身历史的 z 分数突变（稳定系统的自体噪声基线） */
  private detectAnomalies(metrics: SystemMetrics, stability: SystemStabilitySummary): void {
    if (this.history.length < 4) return;
    const current: Partial<Record<TrendMetric, number>> = {
      operationalSuccessRate: metrics.operational.successRate,
      discoveryRate: metrics.evolver.discoveryRate,
      proceduralGrowth: metrics.memory.counts.procedural,
      pendingDistillation: metrics.memory.pendingSinceLastDistillation,
      survivalRate: metrics.evolver.survivalRate,
      stabilityScore: stability.stabilityScore,
    };
    const LABELS: Record<string, string> = {
      operationalSuccessRate: '操作环成功率',
      discoveryRate: '进化发现速率',
      proceduralGrowth: '程序记忆累积量',
      pendingDistillation: '蒸馏积压水位',
      survivalRate: '新策略存活率',
      stabilityScore: '综合稳定分',
    };
    for (const [metric, value] of Object.entries(current) as Array<[TrendMetric, number]>) {
      const prior = this.history.slice(-8).map((r) => this.metricValueOf(r, metric));
      if (prior.length < 4) continue;
      const mean = prior.reduce((s, v) => s + v, 0) / prior.length;
      const std = Math.sqrt(prior.reduce((s, v) => s + (v - mean) ** 2, 0) / prior.length);
      const z = std > 1e-9 ? Math.abs((value - mean) / std) : value !== mean ? Infinity : 0;
      if (z >= this.config.anomalyZThreshold) {
        stability.riskPoints.push({
          severity: 'high',
          area: 'meta',
          description: `指标突变：${LABELS[metric] ?? metric} 当前 ${value} 偏离近均值 ${mean.toFixed(4)} 达 ${Number.isFinite(z) ? `${z.toFixed(1)}σ` : '∞σ'}（异常波动，非趋势性劣化）`,
        });
      }
    }
  }

  /** 稳态目标带评估（偏离越远 → 元认知控制器步长越大） */
  private buildHomeostasis(metrics: SystemMetrics, stability: SystemStabilitySummary): HomeostasisStatus[] {
    const bands = this.config.homeostasisBands;
    if (!bands || Object.keys(bands).length === 0) return [];
    const current: Partial<Record<JudgeMetric, number>> = {
      operationalSuccessRate: metrics.operational.successRate,
      discoveryRate: metrics.evolver.discoveryRate,
      proceduralGrowth: metrics.memory.counts.procedural,
      pendingDistillation: metrics.memory.pendingSinceLastDistillation,
      survivalRate: metrics.evolver.survivalRate,
    };
    const statuses: HomeostasisStatus[] = [];
    for (const [metric, band] of Object.entries(bands) as Array<[JudgeMetric, { min: number; max: number }]>) {
      const value = current[metric];
      if (value === undefined) continue;
      const { deviation, state } = computeHomeostasis(band, value);
      statuses.push({ metric, band, current: value, deviation: Number(deviation.toFixed(4)), state });
    }
    void stability;
    return statuses;
  }

  // ─────────────────────────── 持久化 ───────────────────────────

  private persist(): void {
    if (!this.config.persistPath) return;
    try {
      fs.writeFileSync(
        this.config.persistPath,
        JSON.stringify({ history: this.history, savedAt: Date.now() }),
        'utf-8',
      );
    } catch {
      /* 持久化失败不影响运行 */
    }
  }

  private restore(): void {
    if (!this.config.persistPath || !fs.existsSync(this.config.persistPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.config.persistPath, 'utf-8')) as {
        history?: MentalReport[];
      };
      if (Array.isArray(parsed.history)) this.history = parsed.history;
    } catch {
      /* 损坏文件忽略，从零开始 */
    }
  }
}
