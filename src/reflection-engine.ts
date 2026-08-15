/**
 * reflection-engine.ts — 质量反思引擎（闭环"反思"环节深度优化）
 *
 * 职责：在执行完成后进行深度质量反思，超越简单的阈值比较
 *
 * 能力矩阵：
 * 1. LLM-as-judge 质量评审：调用评审模型对节点输出打分（多维度：
 *    完整性 / 正确性 / 可维护性），替代单一启发式质量分
 * 2. 失败教训提取：从失败执行中提炼结构化教训（根因分类 + 改进建议），
 *    写入长期记忆供后续计划生成引用
 * 3. 质量趋势追踪：滑动窗口统计各任务类型的质量走势，
 *    连续下滑触发告警事件
 * 4. 阈值自校准：依据历史质量分布动态调整 qualityThreshold
 *    （质量普遍偏高 → 收紧阈值追求卓越；普遍偏低 → 适度放宽避免无效重试风暴）
 * 5. 重试策略优化：依据教训库判断重试是否有意义
 *    （如"模型能力不足"类根因 → 直接换模型而非原模型重试）
 *
 * 升级点（相对固定阈值重试的质的提升）：
 * - 反思从"事后统计"进化为"主动诊断"，每次失败都产出可复用的教训
 * - 阈值不再是静态配置，而是随系统能力演化的活参数
 * - 评审模型可注入，冒烟测试可离线模拟
 */

import type { NodeResult, PlanExecutionResult, ExecutionPlan } from './executor.js';
import type { Signal } from './sentinel.js';

/** 评审模型签名（可注入） */
export type JudgeModel = (params: {
  taskDescription: string;
  output: string;
  taskType: string;
}) => Promise<{ score: number; completeness: number; correctness: number; maintainability: number; comment: string }>;

/** 教训提取器签名（可注入，通常由 strategist 模型承担） */
export type LessonExtractor = (params: {
  signalDescription: string;
  taskType: string;
  errorMessage: string;
  failedNodeId: string;
  failedModelId: string;
}) => Promise<{ rootCause: RootCauseCategory; lesson: string; suggestion: string }>;

/** 根因分类 */
export type RootCauseCategory =
  | 'model-capability' // 模型能力不足（应换模型）
  | 'timeout' // 超时（应加大超时或拆分任务）
  | 'dependency' // 上游依赖产出质量问题
  | 'prompt-ambiguity' // 任务描述模糊（应要求澄清）
  | 'transient' // 瞬时故障（重试有意义）
  | 'unknown';

/** 结构化教训 */
export interface Lesson {
  id: string;
  timestamp: number;
  taskType: string;
  rootCause: RootCauseCategory;
  lesson: string;
  suggestion: string;
  signalDescription: string;
}

/** 质量趋势记录 */
export interface QualityTrendPoint {
  timestamp: number;
  taskType: string;
  avgQuality: number;
  success: boolean;
}

/** 反思引擎配置 */
export interface ReflectionEngineConfig {
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
export interface ReflectionVerdict {
  /** 综合质量分（评审模型 or 执行器质量分） */
  quality: number;
  /** 是否达标 */
  passed: boolean;
  /** 重试建议：retry-same / retry-switch / no-retry */
  retryAdvice: 'retry-same' | 'retry-switch' | 'no-retry';
  /** 建议理由 */
  reason: string;
  /** 评审明细（judge 可用时） */
  dimensions?: { completeness: number; correctness: number; maintainability: number; comment: string };
}

/** 默认配置 */
export const DEFAULT_REFLECTION_CONFIG: ReflectionEngineConfig = {
  qualityThreshold: 0.7,
  calibrationMinSamples: 10,
  calibrationStep: 0.02,
  thresholdRange: [0.5, 0.95],
  trendWindowSize: 20,
  declineAlertCount: 3,
};

/**
 * 质量反思引擎
 *
 * 被 index.ts 持有：executor 执行完成后调用 reflect() 进行深度反思，
 * 失败时调用 extractLesson() 沉淀教训，阈值通过 getCurrentThreshold() 动态获取。
 */
export class ReflectionEngine {
  private config: ReflectionEngineConfig;
  private lessons: Lesson[] = [];
  private trendWindow: QualityTrendPoint[] = [];
  /** 各任务类型的质量历史（用于自校准） */
  private qualityHistory = new Map<string, number[]>();
  /** 当前动态阈值 */
  private currentThreshold: number;
  /** 告警回调（由 index.ts 桥接到进度广播） */
  private onAlert?: (alert: { type: string; message: string; taskType: string }) => void;
  private lessonCounter = 0;

  constructor(config?: Partial<ReflectionEngineConfig>) {
    this.config = { ...DEFAULT_REFLECTION_CONFIG, ...config };
    this.currentThreshold = this.config.qualityThreshold;
  }

  /** 设置告警回调 */
  setAlertHandler(handler: (alert: { type: string; message: string; taskType: string }) => void): void {
    this.onAlert = handler;
  }

  /**
   * 对单个节点输出做深度反思
   * @param params 节点输出与上下文
   * @returns 反思结论
   */
  async reflect(params: {
    node: { id: string; description: string; type: string };
    output: string;
    baseQuality: number;
    signal: Signal;
  }): Promise<ReflectionVerdict> {
    let quality = params.baseQuality;
    let dimensions: ReflectionVerdict['dimensions'];

    // LLM-as-judge 评审（可用时）
    if (this.config.judge) {
      try {
        const judged = await this.config.judge({
          taskDescription: params.node.description,
          output: params.output,
          taskType: params.node.type,
        });
        // 评审分与执行器自评分加权（评审占 70%）
        quality = judged.score * 0.7 + params.baseQuality * 0.3;
        dimensions = {
          completeness: judged.completeness,
          correctness: judged.correctness,
          maintainability: judged.maintainability,
          comment: judged.comment,
        };
      } catch {
        /* 评审失败回退基础质量分 */
      }
    }

    const passed = quality >= this.currentThreshold;
    const retryAdvice = this.adviseRetry(params.node.type, quality, passed);

    return {
      quality,
      passed,
      retryAdvice,
      reason: passed
        ? `质量 ${quality.toFixed(2)} ≥ 动态阈值 ${this.currentThreshold.toFixed(2)}`
        : `质量 ${quality.toFixed(2)} < 动态阈值 ${this.currentThreshold.toFixed(2)}，建议 ${retryAdvice}`,
      dimensions,
    };
  }

  /**
   * 从失败执行中提取教训（异步，失败不阻塞主流程）
   * @param params 失败上下文
   * @returns 提取的教训
   */
  async extractLesson(params: {
    signal: Signal;
    taskType: string;
    result: PlanExecutionResult;
    plan: ExecutionPlan;
  }): Promise<Lesson | null> {
    const failed = params.result.nodeResults.find((r) => !r.success);
    if (!failed) return null;

    let rootCause: RootCauseCategory = 'unknown';
    let lesson = '';
    let suggestion = '';

    if (this.config.lessonExtractor) {
      try {
        const extracted = await this.config.lessonExtractor({
          signalDescription: params.signal.description,
          taskType: params.taskType,
          errorMessage: failed.error ?? '',
          failedNodeId: failed.nodeId,
          failedModelId: failed.modelId,
        });
        rootCause = extracted.rootCause;
        lesson = extracted.lesson;
        suggestion = extracted.suggestion;
      } catch {
        /* 落入规则化提取 */
      }
    }

    // 规则化兜底提取
    if (!lesson) {
      const err = (failed.error ?? '').toLowerCase();
      if (err.includes('超时') || err.includes('timeout')) {
        rootCause = 'timeout';
        lesson = `任务类型 ${params.taskType} 在模型 ${failed.modelId} 上超时`;
        suggestion = '增大节点超时或拆分任务粒度';
      } else if (err.includes('质量不达标')) {
        rootCause = 'model-capability';
        lesson = `模型 ${failed.modelId} 对 ${params.taskType} 类任务质量不足（重试 ${failed.attempts} 次未达标）`;
        suggestion = '切换到该任务类型能力更强的模型';
      } else if (err.includes('依赖')) {
        rootCause = 'dependency';
        lesson = `上游依赖产出异常导致节点 ${failed.nodeId} 失败`;
        suggestion = '检查上游节点质量或增加依赖校验';
      } else {
        rootCause = 'transient';
        lesson = `节点 ${failed.nodeId} 执行失败: ${failed.error ?? '未知'}`;
        suggestion = '重试或检查瞬时故障';
      }
    }

    const record: Lesson = {
      id: `lesson-${++this.lessonCounter}`,
      timestamp: Date.now(),
      taskType: params.taskType,
      rootCause,
      lesson,
      suggestion,
      signalDescription: params.signal.description,
    };
    this.lessons.push(record);
    if (this.lessons.length > 100) this.lessons.shift();
    return record;
  }

  /**
   * 记录一次执行结果到趋势窗口并触发自校准
   * @param taskType 任务类型
   * @param quality 平均质量分
   * @param success 是否成功
   */
  recordExecution(taskType: string, quality: number, success: boolean): void {
    this.trendWindow.push({ timestamp: Date.now(), taskType, avgQuality: quality, success });
    if (this.trendWindow.length > this.config.trendWindowSize) this.trendWindow.shift();

    const history = this.qualityHistory.get(taskType) ?? [];
    history.push(quality);
    if (history.length > 50) history.shift();
    this.qualityHistory.set(taskType, history);

    this.checkDeclineAlert(taskType, history);
    this.calibrateThreshold(taskType, history);
  }

  /** 当前动态质量阈值 */
  getCurrentThreshold(): number {
    return this.currentThreshold;
  }

  /** 设置质量阈值（元认知自调优落地入口，限制在允许范围内） */
  setQualityThreshold(value: number): void {
    const [min, max] = this.config.thresholdRange;
    this.currentThreshold = Math.max(min, Math.min(max, value));
  }

  /** 获取指定任务类型的相关教训（供计划生成引用） */
  getLessons(taskType: string, limit = 5): Lesson[] {
    return this.lessons.filter((l) => l.taskType === taskType).slice(-limit);
  }

  /** 全部教训 */
  getAllLessons(): Lesson[] {
    return [...this.lessons];
  }

  /** 质量趋势摘要 */
  getTrendSummary(): any {
    const byType = new Map<string, QualityTrendPoint[]>();
    for (const point of this.trendWindow) {
      const list = byType.get(point.taskType) ?? [];
      list.push(point);
      byType.set(point.taskType, list);
    }
    const summary: Record<string, any> = {};
    for (const [type, points] of byType) {
      const qualities = points.map((p) => p.avgQuality);
      summary[type] = {
        samples: points.length,
        avgQuality: qualities.reduce((a, b) => a + b, 0) / qualities.length,
        successRate: points.filter((p) => p.success).length / points.length,
        trending: this.trendDirection(qualities),
      };
    }
    return { threshold: this.currentThreshold, windowSize: this.trendWindow.length, byType: summary };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 重试建议：依据教训库与根因判断 */
  private adviseRetry(taskType: string, quality: number, passed: boolean): ReflectionVerdict['retryAdvice'] {
    if (passed) return 'no-retry';
    // 差距过大（< 阈值的 60%）：原模型重试无意义，直接换模型
    if (quality < this.currentThreshold * 0.6) return 'retry-switch';
    // 有"模型能力不足"教训：直接换模型
    const capabilityLesson = this.lessons.some((l) => l.taskType === taskType && l.rootCause === 'model-capability');
    if (capabilityLesson) return 'retry-switch';
    return 'retry-same';
  }

  /** 质量下滑告警检测 */
  private checkDeclineAlert(taskType: string, history: number[]): void {
    if (history.length < this.config.declineAlertCount + 1) return;
    const recent = history.slice(-this.config.declineAlertCount);
    let declining = true;
    for (let i = 1; i < recent.length; i += 1) {
      if (recent[i] >= recent[i - 1]) {
        declining = false;
        break;
      }
    }
    if (declining && this.onAlert) {
      this.onAlert({
        type: 'quality-decline',
        message: `任务类型 ${taskType} 质量连续 ${this.config.declineAlertCount} 次下滑（${recent.map((q) => q.toFixed(2)).join(' → ')}）`,
        taskType,
      });
    }
  }

  /** 阈值自校准：质量分布整体偏高 → 收紧；偏低 → 放宽 */
  private calibrateThreshold(taskType: string, history: number[]): void {
    if (history.length < this.config.calibrationMinSamples) return;
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    const [min, max] = this.config.thresholdRange;

    if (avg > this.currentThreshold + 0.15) {
      // 质量普遍优秀：收紧阈值追求卓越
      this.currentThreshold = Math.min(max, this.currentThreshold + this.config.calibrationStep);
    } else if (avg < this.currentThreshold - 0.15) {
      // 质量普遍偏低：放宽阈值避免无效重试风暴
      this.currentThreshold = Math.max(min, this.currentThreshold - this.config.calibrationStep);
    }
  }

  /** 趋势方向判断 */
  private trendDirection(qualities: number[]): 'rising' | 'falling' | 'stable' {
    if (qualities.length < 3) return 'stable';
    const half = Math.floor(qualities.length / 2);
    const firstAvg = qualities.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const secondAvg = qualities.slice(half).reduce((a, b) => a + b, 0) / (qualities.length - half);
    if (secondAvg - firstAvg > 0.05) return 'rising';
    if (firstAvg - secondAvg > 0.05) return 'falling';
    return 'stable';
  }
}
