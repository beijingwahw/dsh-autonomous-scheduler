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

  constructor(config?: Partial<MetaCognitionConfig>) {
    this.config = { ...DEFAULT_META_COGNITION_CONFIG, ...config };
  }

  /**
   * 观察一次 KPI 快照（元认知主入口）
   * @returns 本轮产出的自愈洞察（交给目标引擎）
   */
  observe(snapshot: KpiSnapshot): Insight[] {
    this.history.push(snapshot);
    if (this.history.length > this.config.windowSize) this.history.shift();

    const insights: Insight[] = [];

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
  getHealthReport(): any {
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
  private detectAnomaly(kpi: string, value: number): KpiAnomaly | null {
    const series = this.history.slice(0, -1).map((s) => (s as any)[kpi] as number);
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

  /** 参数自调优策略 */
  private tryTune(kpi: string, value: number, target: number): TuningAction | null {
    if (Date.now() - this.lastTuningAt < this.config.tuningCooldownMs) return null;

    let action: TuningAction | null = null;
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

    if (action) this.lastTuningAt = Date.now();
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
