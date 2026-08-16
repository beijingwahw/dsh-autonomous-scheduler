/**
 * meta-cognition.ts — 元认知监控引擎（"彻底自主智能"核心组件 2/4）
 *
 * 职责：系统对"自身运行状态"的觉察与调节——监控自己的 KPI、
 * 检测退化、自主调整运行参数、为无法自愈的问题生成自愈目标。
 *
 * 能力矩阵：
 * 1. KPI 快照采集：成功率 / 平均质量 / 平均延迟 / 决策缓存命中率 /
 *    模型健康度（单模型成功率过低自动标记降级）
 * 2. 异常检测：滑动窗口 + z-score 检测 KPI 突变，连续低于目标线判定退化
 * 3. 参数自调优：检测到退化时自主调整可调参数（质量阈值 / 重试次数 /
 *    聚合窗口），调整动作经 applier 回调落地到真实引擎
 * 4. 自愈目标触发：参数调整仍无法解决的结构性问题（如某模型持续失败）
 *    产出高严重度洞察，交给目标引擎生成自愈目标
 * 5. 健康报告：综合评分 + 各 KPI 状态 + 调整历史，可查询可追溯
 */

import type { Insight } from './goal-engine.js';
import type { CausalEffect, CausalKernel } from './core/causal-kernel.js';

/** KPI 快照 */
export interface KpiSnapshot {
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
export interface KpiAnomaly {
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
export interface TuningAction {
  parameter: 'qualityThreshold' | 'maxRetries' | 'aggregationWindow';
  from: number;
  to: number;
  reason: string;
  timestamp: number;
  /** 5.0：因果依据（该旋钮对目标 KPI 的干预效应估计） */
  causalBasis?: { ate: number; lower: number; confidence: number; interventionalSamples: number };
}

/** 健康报告 */
export interface HealthReport {
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
  freeEnergy?: { surprisalEma: number; samples: number; interpretation: string };
  /**
   * 7.0：梦校准（深思心智的想象可靠性 KPI）。
   *
   * 自由能度量「系统预测世界有多准」；梦校准度量「系统预测
   * **自己的计划**有多准」——想象推演 vs 真实执行的逐步误差。
   * 校准差 = 计划在脑内排练的成绩与现实的落差：想象不可信时，
   * 深思搜索的结论全部作废（应先修转移模型再规划）。
   */
  imagination?: { calibrationEma: number; plansSettled: number; skills: number; interpretation: string };
  /**
   * 8.0：认知经济（元认知心智 KPI——思考的价格与价值核算）。
   *
   * 自由能度量预测世界的准确度，梦校准度量预测自己计划的准确度；
   * 认知经济度量**思考本身用得值不值**——习惯命中率（摊销节省）、
   * 搜索开销（nat 计价）、模式成功率（思考价值的实测）、元遗憾
   * （本不该省的思考）。三个 KPI 层层递进：世界→计划→心智自身。
   */
  cognitiveEconomy?: import('./core/metareasoning.js').CognitiveEconomy;
  /**
   * 9.0：抽象统计（抽象心智 KPI——举一反三的实绩）。
   *
   * 认知经济度量思考用得值不值；抽象统计度量**经验是否跨域流动**：
   * 类比迁移次数、零样本应答（冷状态凭结构同构直接给出非无知
   * 估计）、后继结构继承、跨域宏技能数。KPI 第四层：世界→计划→
   * 心智→心智的泛化能力。
   */
  abstraction?: import('./core/abstraction.js').AbstractionStats;
  /**
   * 10.0：知识前沿（科学家心智 KPI——知识获取的经济学）。
   *
   * 抽象统计度量经验是否跨域流动；知识前沿度量**求知本身值不值**：
   * 因果问题的残差熵总量（知识版图的未知量）、混杂分歧数（唯有
   * 干预可裁决）、实验兑现率（承诺 EIG vs 实现信息增益——设计者
   * 诚实度的内生度量）。KPI 第五层：世界→计划→心智→泛化→求知。
   */
  knowledgeFrontier?: import('./core/scientist.js').KnowledgeFrontier;
  /**
   * 11.0：理论前沿（理论心智 KPI——知识的压缩与体系化）。
   *
   * 知识前沿度量求知值不值；理论前沿度量**知识是否成体系**：
   * 在世定律数、被压缩的边数、累计省下的描述长度（理解即压缩，
   * nat 口径）、零样本预测次数（定律泛化）、范式转移次数
   * （定律被推翻重建——科学的自我修正力）。KPI 第六层：
   * 世界→计划→心智→泛化→求知→体系化。
   */
  theoryFrontier?: import('./core/theorist.js').TheoryFrontier;
}

/** 元认知配置 */
export interface MetaCognitionConfig {
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
export const DEFAULT_META_COGNITION_CONFIG: MetaCognitionConfig = {
  windowSize: 20,
  zScoreThreshold: 2,
  successRateTarget: 0.8,
  qualityTarget: 0.7,
  degradeStreakThreshold: 3,
  modelHealthThreshold: 0.4,
  tuningCooldownMs: 30_000,
};

/**
 * 元认知监控引擎
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳采集 KPI 快照并调用 observe()，
 * 引擎自动完成异常检测、参数调优与自愈洞察产出。
 */
export class MetaCognitionEngine {
  private config: MetaCognitionConfig;
  private history: KpiSnapshot[] = [];
  private anomalies: KpiAnomaly[] = [];
  private tuningHistory: TuningAction[] = [];
  /** 各 KPI 连续低于目标线的次数 */
  private degradeStreaks = new Map<string, number>();
  private lastTuningAt = 0;
  /** 5.0：因果内核（挂载后旋钮推荐按因果效应排序） */
  private causal?: CausalKernel;
  /** 待结算的调参干预（动作 → 下一批 KPI 快照对账） */
  private pendingTuningInterventions: Array<{ action: TuningAction; kpi: string; baseline: number }> = [];

  constructor(config?: Partial<MetaCognitionConfig>) {
    this.config = { ...DEFAULT_META_COGNITION_CONFIG, ...config };
  }

  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: CausalKernel): void {
    this.causal = kernel;
  }

  /** 6.0：挂载自由能引擎（幂等；健康报告开始携带统一自由能 KPI） */
  attachFreeEnergyEngine(engine: import('./core/free-energy.js').FreeEnergyEngine): void {
    this.freeEnergyEngine = engine;
  }

  /** 7.0：挂载深思内核（梦校准 KPI 数据源；幂等） */
  attachDeliberationEngine(engine: import('./core/deliberation.js').DeliberationEngine): void {
    this.deliberationEngine = engine;
  }

  /** 8.0：挂载元推理内核（认知经济 KPI 数据源；幂等） */
  attachMetareasoner(reasoner: import('./core/metareasoning.js').RationalMetareasoner): void {
    this.metareasoner = reasoner;
  }

  /** 9.0：挂载抽象内核（抽象统计 KPI 数据源；幂等） */
  attachAbstractionEngine(engine: import('./core/abstraction.js').AbstractionEngine): void {
    this.abstractionEngine = engine;
  }

  /** 10.0：挂载科学家内核（知识前沿 KPI 数据源；幂等） */
  attachScientistMind(mind: import('./core/scientist.js').ScientistMind): void {
    this.scientistMind = mind;
  }

  /** 11.0：挂载理论内核（理论前沿 KPI 数据源；幂等） */
  attachTheoristEngine(engine: import('./core/theorist.js').TheoristEngine): void {
    this.theoristEngine = engine;
  }

  private freeEnergyEngine?: import('./core/free-energy.js').FreeEnergyEngine;
  private theoristEngine?: import('./core/theorist.js').TheoristEngine;
  private deliberationEngine?: import('./core/deliberation.js').DeliberationEngine;
  private metareasoner?: import('./core/metareasoning.js').RationalMetareasoner;
  private abstractionEngine?: import('./core/abstraction.js').AbstractionEngine;
  private scientistMind?: import('./core/scientist.js').ScientistMind;

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
  rankTuningKnobs(targetKpi: string): CausalEffect[] {
    if (!this.causal) return [];
    return this.causal.rankCauses(`kpi:${targetKpi}`).filter((e) => e.from.startsWith('knob:'));
  }

  /**
   * 5.0：调参干预对账 —— 上次调参后 KPI 是否真的改善。
   *
   * 在 observe() 每批快照后自动调用：基线 → 干预后首个快照的比较
   * 结果作为 do-干预的 observedY 写回因果图（黄金证据闭环：
   * 调参 = 干预，下批 KPI = 实验结果，图更新 = 学习）。
   */
  private settleTuningInterventions(snapshot: KpiSnapshot): void {
    if (!this.causal || this.pendingTuningInterventions.length === 0) return;
    for (const pending of this.pendingTuningInterventions) {
      const current = (snapshot as unknown as Record<string, number>)[pending.kpi];
      if (!Number.isFinite(current)) continue;
      const improved = current >= pending.baseline;
      this.causal.intervene(
        `knob:${pending.action.parameter}`,
        `kpi:${pending.kpi}`,
        true,
        improved,
        'meta-cognition',
        `调参实验：${pending.action.parameter} ${pending.action.from} → ${pending.action.to}，观察 ${pending.kpi}`,
      );
    }
    // 每次干预只对账一次（下一批快照即实验读数）
    this.pendingTuningInterventions = [];
  }

  /** 登记待对账的调参干预（内部：动作落地后基线快照） */
  private registerTuningIntervention(action: TuningAction, kpi: string, baseline: number): void {
    this.pendingTuningInterventions.push({ action, kpi, baseline });
    if (this.pendingTuningInterventions.length > 8) this.pendingTuningInterventions.shift();
  }

  /**
   * 观察一次 KPI 快照（元认知主入口）
   * @returns 本轮产出的自愈洞察（交给目标引擎）
   */
  observe(snapshot: KpiSnapshot): Insight[] {
    this.history.push(snapshot);
    if (this.history.length > this.config.windowSize) this.history.shift();

    const insights: Insight[] = [];

    // 0. 5.0：调参干预对账（上批调参 → 本批 KPI 即实验读数）
    this.settleTuningInterventions(snapshot);

    // 1. z-score 异常检测（窗口足够时）
    if (this.history.length >= 5) {
      for (const kpi of ['successRate', 'avgQuality', 'cacheHitRate'] as const) {
        const anomaly = this.detectAnomaly(kpi, snapshot[kpi]);
        if (anomaly) this.anomalies.push(anomaly);
      }
      if (this.anomalies.length > 100) this.anomalies.splice(0, this.anomalies.length - 100);
    }

    // 2. 退化检测与参数自调优
    insights.push(...this.checkDegradation(snapshot));

    // 3. 模型健康度检查
    insights.push(...this.checkModelHealth(snapshot));

    return insights;
  }

  /** 最近一次健康报告 */
  getHealthReport(): HealthReport {
    const latest = this.history[this.history.length - 1];
    if (!latest) return { healthy: true, score: 1, message: '暂无 KPI 数据', kpis: {} };

    const successScore = Math.min(1, latest.successRate / this.config.successRateTarget);
    const qualityScore = Math.min(1, latest.avgQuality / this.config.qualityTarget);
    const cacheScore = Math.min(1, latest.cacheHitRate / 0.3); // 命中率 30% 视为满分基准
    const score = successScore * 0.5 + qualityScore * 0.35 + cacheScore * 0.15;

    return {
      healthy: score >= 0.7,
      score: Number(score.toFixed(3)),
      samples: this.history.length,
      kpis: {
        successRate: latest.successRate,
        avgQuality: latest.avgQuality,
        avgLatency: latest.avgLatency,
        cacheHitRate: latest.cacheHitRate,
      },
      degradeStreaks: Object.fromEntries(this.degradeStreaks),
      recentAnomalies: this.anomalies.slice(-5),
      recentTuning: this.tuningHistory.slice(-5),
      // 6.0：统一自由能 KPI（挂载引擎且有观测时输出）
      freeEnergy: this.freeEnergyEngine
        ? (() => {
            const s = this.freeEnergyEngine!.currentSurprisal();
            const interpretation =
              s < 0.35 ? '预测握力强：世界行为基本符合模型预期'
              : s < 0.7 ? '预测握力中等：部分结果出乎意料，模型在局部过时'
              : '预测握力弱：世界已漂移（惊讶持续偏高），建议触发世界模型重构或因果实验';
            return { surprisalEma: Number(s.toFixed(3)), samples: this.history.length, interpretation };
          })()
        : undefined,
      // 7.0：梦校准 KPI（挂载深思内核且已有对账记录时输出）
      imagination: this.deliberationEngine
        ? (() => {
            const cal = this.deliberationEngine!.currentCalibration() ?? 0;
            const settled = this.deliberationEngine!.settledCount();
            const skills = this.deliberationEngine!.allSkills().length;
            const interpretation =
              settled === 0 ? '尚未对账：想象力未经现实检验'
              : cal < 0.15 ? '梦境即现实：计划排练可信，深思搜索结论可靠'
              : cal < 0.3 ? '梦有偏差：想象部分失真，规划结论需保留怀疑'
              : '梦已失灵：想象与现实验重背离，先修转移模型再规划';
            return { calibrationEma: Number(cal.toFixed(3)), plansSettled: settled, skills, interpretation };
          })()
        : undefined,
      // 8.0：认知经济 KPI（挂载元推理内核时输出）
      cognitiveEconomy: this.metareasoner ? this.metareasoner.cognitiveEconomy() : undefined,
      // 9.0：抽象统计 KPI（挂载抽象内核时输出）
      abstraction: this.abstractionEngine ? this.abstractionEngine.stats() : undefined,
      // 10.0：知识前沿 KPI（挂载科学家内核时输出）
      knowledgeFrontier: this.scientistMind ? this.scientistMind.knowledgeFrontier() : undefined,
      // 11.0：理论前沿 KPI（挂载理论内核时输出）
      theoryFrontier: this.theoristEngine ? this.theoristEngine.frontier() : undefined,
    };
  }

  /** 调优历史 */
  getTuningHistory(): TuningAction[] {
    return [...this.tuningHistory];
  }

  /** 异常历史 */
  getAnomalies(): KpiAnomaly[] {
    return [...this.anomalies];
  }

  /** KPI 历史（只读快照） */
  getHistory(): KpiSnapshot[] {
    return [...this.history];
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** z-score 异常检测 */
  private detectAnomaly(kpi: keyof Pick<KpiSnapshot, 'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>, value: number): KpiAnomaly | null {
    const series = this.history.slice(0, -1).map((s) => s[kpi]);
    if (series.length < 4) return null;
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length;
    const std = Math.sqrt(variance);
    if (std < 1e-6) return null;
    const z = (value - mean) / std;
    if (Math.abs(z) < this.config.zScoreThreshold) return null;
    return {
      kpi,
      value,
      baseline: mean,
      zScore: Number(z.toFixed(2)),
      direction: z < 0 ? 'degraded' : 'improved',
      timestamp: Date.now(),
    };
  }

  /** 退化检测：连续低于目标线 → 参数自调优 + 自愈洞察 */
  private checkDegradation(snapshot: KpiSnapshot): Insight[] {
    const insights: Insight[] = [];
    const checks: Array<{ kpi: string; value: number; target: number }> = [
      { kpi: 'successRate', value: snapshot.successRate, target: this.config.successRateTarget },
      { kpi: 'avgQuality', value: snapshot.avgQuality, target: this.config.qualityTarget },
    ];

    for (const check of checks) {
      const streak = check.value < check.target ? (this.degradeStreaks.get(check.kpi) ?? 0) + 1 : 0;
      this.degradeStreaks.set(check.kpi, streak);
      if (streak < this.config.degradeStreakThreshold) continue;

      // 触发参数自调优（冷却期内不重复调整）
      const tuned = this.tryTune(check.kpi, check.value, check.target);
      if (tuned) {
        this.tuningHistory.push(tuned);
        this.config.applier?.(tuned);
        // 调优后重置连续计数，给新参数生效的机会
        this.degradeStreaks.set(check.kpi, 0);
      } else {
        // 冷却期内或无可调参数 → 产出自愈洞察交给目标引擎
        insights.push({
          source: 'meta-cognition',
          category: 'kpi-degradation',
          severity: Math.min(1, 0.5 + streak * 0.1),
          message: `KPI ${check.kpi} 连续 ${streak} 次低于目标线（当前 ${check.value.toFixed(2)}，目标 ${check.target}）`,
          suggestion: check.kpi === 'successRate'
            ? '排查高频失败任务类型并优化其执行策略'
            : '复盘低质量任务的计划生成与模型分配',
        });
      }
    }
    return insights;
  }

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
  private tryTune(kpi: string, value: number, target: number): TuningAction | null {
    if (Date.now() - this.lastTuningAt < this.config.tuningCooldownMs) return null;

    let action: TuningAction | null = null;

    // 5.0：因果旋钮优先（有实验证据的调参方向）
    if (this.causal) {
      const ranked = this.rankTuningKnobs(kpi);
      const bestKnob = ranked.find((e) => e.established && e.direction === 'positive' && e.interventionalSamples >= 3);
      if (bestKnob) {
        const parameter = bestKnob.from.replace('knob:', '') as TuningAction['parameter'];
        const step = parameter === 'maxRetries' ? 1 : 0.05;
        action = {
          parameter,
          from: target,
          to: Number((target + step).toFixed(2)),
          reason: `因果证据优先：${parameter} 对 ${kpi} 的干预效应 ${bestKnob.ate.toFixed(2)} [${bestKnob.lower.toFixed(2)}, ${bestKnob.upper.toFixed(2)}]（${bestKnob.interventionalSamples} 次实验）`,
          timestamp: Date.now(),
          causalBasis: {
            ate: bestKnob.ate,
            lower: bestKnob.lower,
            confidence: bestKnob.confidence,
            interventionalSamples: bestKnob.interventionalSamples,
          },
        };
      }
    }

    // 规则回退（无因果证据时保持既有行为）
    if (!action) {
      if (kpi === 'successRate') {
        // 成功率退化：降低质量阈值减少无效重试风暴，提升通过率
        const relaxed = Math.max(0.5, target - 0.05);
        if (relaxed < target) {
          action = {
            parameter: 'qualityThreshold',
            from: target,
            to: relaxed,
            reason: `成功率 ${value.toFixed(2)} 低于目标 ${target}，放宽质量阈值减少重试风暴`,
            timestamp: Date.now(),
          };
        }
      } else if (kpi === 'avgQuality') {
        // 质量退化：增加重试次数争取更高质量
        action = {
          parameter: 'maxRetries',
          from: 2,
          to: 3,
          reason: `平均质量 ${value.toFixed(2)} 低于目标 ${target}，增加重试次数`,
          timestamp: Date.now(),
        };
      }
    }

    if (action) {
      this.lastTuningAt = Date.now();
      // 5.0：登记待对账干预（下批快照结算成败 → 写回因果图）
      this.registerTuningIntervention(action, kpi, value);
    }
    return action;
  }

  /** 模型健康度检查：单模型成功率过低 → 自愈洞察 */
  private checkModelHealth(snapshot: KpiSnapshot): Insight[] {
    const insights: Insight[] = [];
    for (const [modelId, rate] of Object.entries(snapshot.modelSuccessRates)) {
      if (rate >= this.config.modelHealthThreshold) continue;
      insights.push({
        source: 'meta-cognition',
        category: 'model-unhealthy',
        severity: 0.8,
        message: `模型 ${modelId} 成功率仅 ${(rate * 100).toFixed(0)}%，低于健康线 ${(this.config.modelHealthThreshold * 100).toFixed(0)}%`,
        suggestion: `降低模型 ${modelId} 的任务分配权重，将其任务迁移至更健康的模型`,
      });
    }
    return insights;
  }
}
