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
export interface ArrivalStats {
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
export interface ArrivalPrediction {
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
export interface CalibrationRecord {
  type: string;
  predicted: number;
  actual: number;
  error: number;
  timestamp: number;
}

/** 类型关联（共现） */
export interface TypeCorrelation {
  typeA: string;
  typeB: string;
  /** 共现次数 */
  coOccurrences: number;
  /** 关联强度 0~1（共现数 / min(各自总数)） */
  strength: number;
}

/** 世界模型配置 */
export interface WorldModelConfig {
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
export const DEFAULT_WORLD_MODEL_CONFIG: WorldModelConfig = {
  maxTimestampsPerType: 500,
  coOccurrenceWindowMs: 60_000,
  minSamplesForTrend: 6,
  risingSlopeThreshold: 0.05,
  calibrationErrorThreshold: 2,
};

/**
 * 世界模型
 *
 * 被 index.ts 持有：哨兵每次 ingest 后调用 observeArrival() 增量学习；
 * 心跳循环定期调用 predictArrivals() 获取前瞻预测，detectTrends() 产出负载预警。
 */
export class WorldModel {
  private config: WorldModelConfig;
  private stats = new Map<string, ArrivalStats>();
  private calibrations: CalibrationRecord[] = [];
  /** 待校准的预测（type → 预测值，窗口结束后对账） */
  private pendingPredictions = new Map<string, { predicted: number; windowEnd: number }>();

  constructor(config?: Partial<WorldModelConfig>) {
    this.config = { ...DEFAULT_WORLD_MODEL_CONFIG, ...config };
  }

  /**
   * 观察一次信号到达（增量学习入口）
   * @param type 信号类型
   * @param timestamp 到达时间戳（缺省当前时间）
   */
  observeArrival(type: string, timestamp = Date.now()): void {
    let entry = this.stats.get(type);
    if (!entry) {
      entry = {
        type,
        timestamps: [],
        hourHistogram: new Array(24).fill(0),
        totalCount: 0,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      };
      this.stats.set(type, entry);
    }
    entry.timestamps.push(timestamp);
    if (entry.timestamps.length > this.config.maxTimestampsPerType) {
      entry.timestamps.splice(0, entry.timestamps.length - this.config.maxTimestampsPerType);
    }
    entry.hourHistogram[new Date(timestamp).getHours()] += 1;
    entry.totalCount += 1;
    entry.lastSeenAt = timestamp;
  }

  /**
   * 预测未来窗口内各类型信号的到达数
   * @param horizonMs 预测窗口（毫秒，缺省 5 分钟）
   * @returns 各类型的到达预测（按期望到达数降序）
   */
  predictArrivals(horizonMs = 5 * 60_000): ArrivalPrediction[] {
    const now = Date.now();
    const predictions: ArrivalPrediction[] = [];

    for (const [type, entry] of this.stats) {
      const ratePerMs = this.recentRate(entry, now);
      const trend = this.trendOf(entry, now);
      // 趋势修正：上升趋势上浮预测，下降趋势下调
      const trendFactor = trend === 'rising' ? 1.25 : trend === 'falling' ? 0.75 : 1;
      const expected = ratePerMs * horizonMs * trendFactor;

      // 时段热度修正：目标时段相对全天均值的权重
      const hourFactor = this.hourFactor(entry, now + horizonMs / 2);
      const adjusted = expected * hourFactor;

      // 置信区间：基于到达间隔的波动性（泊松近似，std≈sqrt(mean)）
      const spread = Math.sqrt(Math.max(adjusted, 0.5));
      const confidence = this.calibrationConfidence(type);

      predictions.push({
        type,
        expectedCount: Number(adjusted.toFixed(2)),
        lowerBound: Math.max(0, Number((adjusted - spread).toFixed(2))),
        upperBound: Number((adjusted + spread).toFixed(2)),
        confidence,
        trend,
      });

      // 登记待校准预测
      this.pendingPredictions.set(type, { predicted: adjusted, windowEnd: now + horizonMs });
    }

    return predictions.sort((a, b) => b.expectedCount - a.expectedCount);
  }

  /**
   * 对账预测与实际到达（校准）
   * @returns 本轮新增的校准记录
   */
  settleCalibrations(now = Date.now()): CalibrationRecord[] {
    const settled: CalibrationRecord[] = [];
    for (const [type, pending] of this.pendingPredictions) {
      if (pending.windowEnd > now) continue;
      const entry = this.stats.get(type);
      // 统计预测窗口内的实际到达数
      const windowStart = pending.windowEnd - this.lastHorizonMs;
      const actualCount = entry ? entry.timestamps.filter((t) => t > windowStart && t <= pending.windowEnd).length : 0;
      const record: CalibrationRecord = {
        type,
        predicted: Number(pending.predicted.toFixed(2)),
        actual: actualCount,
        error: Number(Math.abs(pending.predicted - actualCount).toFixed(2)),
        timestamp: now,
      };
      this.calibrations.push(record);
      settled.push(record);
      this.pendingPredictions.delete(type);
    }
    if (this.calibrations.length > 200) this.calibrations.splice(0, this.calibrations.length - 200);
    return settled;
  }

  /**
   * 类型关联矩阵（共现强度）
   * @param minStrength 最低关联强度过滤
   * @returns 类型对关联列表（按强度降序）
   */
  getCorrelations(minStrength = 0.1): TypeCorrelation[] {
    const types = [...this.stats.keys()];
    const correlations: TypeCorrelation[] = [];
    for (let i = 0; i < types.length; i += 1) {
      for (let j = i + 1; j < types.length; j += 1) {
        const a = this.stats.get(types[i])!;
        const b = this.stats.get(types[j])!;
        const coOccurrences = this.countCoOccurrences(a.timestamps, b.timestamps);
        if (coOccurrences === 0) continue;
        const strength = coOccurrences / Math.max(1, Math.min(a.totalCount, b.totalCount));
        if (strength >= minStrength) {
          correlations.push({ typeA: types[i], typeB: types[j], coOccurrences, strength: Number(strength.toFixed(3)) });
        }
      }
    }
    return correlations.sort((x, y) => y.strength - x.strength);
  }

  /**
   * 趋势检测：识别到达率上升的类型（负载预警）
   * @returns 上升趋势的类型列表（含斜率）
   */
  detectTrends(): Array<{ type: string; trend: 'rising' | 'falling' | 'stable'; slopePerMin: number }> {
    const now = Date.now();
    const results: Array<{ type: string; trend: 'rising' | 'falling' | 'stable'; slopePerMin: number }> = [];
    for (const [type, entry] of this.stats) {
      const slope = this.slopeOf(entry, now);
      const trend = slope > this.config.risingSlopeThreshold ? 'rising' : slope < -this.config.risingSlopeThreshold ? 'falling' : 'stable';
      results.push({ type, trend, slopePerMin: Number(slope.toFixed(4)) });
    }
    return results.sort((a, b) => b.slopePerMin - a.slopePerMin);
  }

  /** 世界模型摘要 */
  getSummary(): any {
    const types = [...this.stats.keys()];
    return {
      trackedTypes: types.length,
      totalArrivals: types.reduce((sum, t) => sum + this.stats.get(t)!.totalCount, 0),
      types: types.map((t) => {
        const entry = this.stats.get(t)!;
        return { type: t, totalCount: entry.totalCount, lastSeenAt: entry.lastSeenAt, recentRatePerMin: Number((this.recentRate(entry, Date.now()) * 60_000).toFixed(3)) };
      }),
      correlations: this.getCorrelations().slice(0, 10),
      trends: this.detectTrends().filter((t) => t.trend !== 'stable'),
      calibrationError: this.meanCalibrationError(),
    };
  }

  /** 平均校准误差（MAE） */
  meanCalibrationError(): number {
    if (this.calibrations.length === 0) return 0;
    return Number((this.calibrations.reduce((sum, c) => sum + c.error, 0) / this.calibrations.length).toFixed(3));
  }

  /** 序列化 */
  serialize(): { stats: ArrivalStats[]; calibrations: CalibrationRecord[] } {
    return { stats: [...this.stats.values()], calibrations: [...this.calibrations] };
  }

  /** 反序列化 */
  deserialize(data: { stats: ArrivalStats[]; calibrations: CalibrationRecord[] }): void {
    this.stats.clear();
    for (const entry of data.stats) this.stats.set(entry.type, entry);
    this.calibrations = [...data.calibrations];
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 最近到达率（每毫秒），基于最近 5 分钟窗口 */
  private recentRate(entry: ArrivalStats, now: number): number {
    const windowMs = 5 * 60_000;
    const recent = entry.timestamps.filter((t) => t >= now - windowMs);
    if (recent.length === 0) return 0;
    return recent.length / windowMs;
  }

  /** 时段热度因子：目标时段计数 / 全天均值 */
  private hourFactor(entry: ArrivalStats, targetTimestamp: number): number {
    const total = entry.hourHistogram.reduce((a, b) => a + b, 0);
    if (total === 0) return 1;
    const hour = new Date(targetTimestamp).getHours();
    const mean = total / 24;
    if (mean === 0) return 1;
    // 限制因子范围，避免冷启动时段过度放大
    return Math.max(0.5, Math.min(2, entry.hourHistogram[hour] / mean));
  }

  /** 趋势方向（由斜率判定） */
  private trendOf(entry: ArrivalStats, now: number): 'rising' | 'falling' | 'stable' {
    const slope = this.slopeOf(entry, now);
    if (slope > this.config.risingSlopeThreshold) return 'rising';
    if (slope < -this.config.risingSlopeThreshold) return 'falling';
    return 'stable';
  }

  /** 到达率线性回归斜率（每分钟到达数 / 分钟） */
  private slopeOf(entry: ArrivalStats, now: number): number {
    const windowMs = 10 * 60_000;
    const recent = entry.timestamps.filter((t) => t >= now - windowMs);
    if (recent.length < this.config.minSamplesForTrend) return 0;
    // 将窗口切成两半，比较前后半的到达率
    const mid = now - windowMs / 2;
    const firstHalf = recent.filter((t) => t < mid).length;
    const secondHalf = recent.filter((t) => t >= mid).length;
    const halfMinutes = windowMs / 2 / 60_000;
    return (secondHalf - firstHalf) / halfMinutes / halfMinutes;
  }

  /** 共现计数：两序列中时间邻近的配对数 */
  private countCoOccurrences(a: number[], b: number[]): number {
    let count = 0;
    let j = 0;
    for (let i = 0; i < a.length; i += 1) {
      while (j < b.length && b[j] < a[i] - this.config.coOccurrenceWindowMs) j += 1;
      for (let k = j; k < b.length && b[k] <= a[i] + this.config.coOccurrenceWindowMs; k += 1) {
        count += 1;
      }
    }
    return count;
  }

  /** 预测置信度（由该类型历史校准误差驱动） */
  private calibrationConfidence(type: string): number {
    const records = this.calibrations.filter((c) => c.type === type);
    if (records.length === 0) return 0.5; // 无校准数据时中等置信
    const mae = records.reduce((sum, c) => sum + c.error, 0) / records.length;
    if (mae > this.config.calibrationErrorThreshold) return 0.3;
    return Math.max(0.4, Math.min(0.95, 1 - mae / (this.config.calibrationErrorThreshold * 2)));
  }

  /** 最近一次预测窗口（用于对账，简化为固定 5 分钟） */
  private get lastHorizonMs(): number {
    return 5 * 60_000;
  }
}
