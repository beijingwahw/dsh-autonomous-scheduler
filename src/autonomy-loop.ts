/**
 * autonomy-loop.ts — 自主心跳循环（自主智能的总节拍器）
 *
 * 职责：把全部自主组件串成一个自驱心跳，让系统在无外部信号的空闲期
 * 也持续自我观察、自我改进、自我进化、主动探索，且始终运行在安全边界内。
 *
 * 每轮心跳（tick）编排：
 * 1. 元认知观察：采集 KPI → 异常检测 + 参数自调优 + 自愈洞察
 * 2. 世界模型预见：到达预测 + 趋势检测 → 上升趋势转为负载预警洞察
 * 3. 洞察汇总：元认知自愈 + 反思教训 + 负载预警 → 目标引擎生成目标
 * 4. 子任务派发：价值最高优先，每个动作先经安全治理器裁决
 * 5. 好奇心探索：扫描知识盲区，预算内派发探索任务（治理器放行后）
 * 6. 策略进化：样本达标时触发种群进化，最优基因组落地决策引擎
 * 7. 记忆维护：定期经验蒸馏 + 遗忘曲线衰减（低频后台）
 *
 * 设计要点：
 * - 心跳间隔可配置，测试可手动 tick（不依赖真实定时器）
 * - 所有依赖经接口注入，冒烟测试可完全离线模拟
 * - 单轮心跳异常隔离，任一环节失败不影响其余环节
 * - 世界模型 / 好奇心 / 治理器均为可选注入，向后兼容旧调用方
 */

import type { GoalEngine, GoalSubtask, Goal, Insight } from './goal-engine.js';
import type { MetaCognitionEngine, KpiSnapshot } from './meta-cognition.js';
import type { StrategyEvolutionEngine } from './strategy-evolution.js';
import type { Lesson } from './reflection-engine.js';
import type { WorldModel } from './world-model.js';
import type { CuriosityEngine, ExplorationProposal } from './curiosity-engine.js';
import type { SafetyGovernor } from './safety-governor.js';

/** KPI 采集器（由 index.ts 桥接真实引擎状态） */
export type KpiCollector = () => KpiSnapshot;

/** 子任务派发器（由 index.ts 桥接到 sentinel.ingest，返回信号 id） */
export type SubtaskDispatcher = (subtask: GoalSubtask, goal: Goal) => string;

/** 探索任务派发器（由 index.ts 桥接到 sentinel.ingest，返回信号 id） */
export type ExplorationDispatcher = (proposal: ExplorationProposal) => string;

/** 记忆维护器（由 index.ts 桥接到长期记忆） */
export interface MemoryMaintainer {
  distillExperience(): number;
  applyForgettingCurve(): { decayed: number; forgotten: number };
  /**
   * 知识蒸馏（第二阶段）：从情景记忆蒸馏出语义+程序记忆
   * @returns 蒸馏产出的语义/程序记忆条数（{ semantic, procedural }）
   */
  distillKnowledge?(): Promise<{ semantic: number; procedural: number }>;
}

/** 反思教训提供器（由 index.ts 桥接到反思引擎） */
export type LessonProvider = () => Lesson[];

/** 策略落地器（进化产物应用到决策引擎） */
export type StrategyApplier = (config: Record<string, any>) => void;

/**
 * 调度策略进化桥接器（第三阶段：由 index.ts 桥接到 PolicyEvolver + Sandbox）
 *
 * 心跳进化段调用 runEvolutionCycle 触发「变异 → 沙盒评估 → 择优 → 热切换」；
 * 沙盒离线运行，不阻塞操作环任务调度。
 */
export interface PolicyEvolutionBridge {
  runEvolutionCycle(): Promise<unknown>;
}

/**
 * 元认知环桥接器（第四阶段：由 index.ts 桥接到 SelfModel + MetaCognitiveController）
 *
 * 心跳低频段调用 runMetaCycle 触发「自我建模 → 心智报告 → 保守调整 →
 * 观察判定/回滚」——系统观察并改进自身的进化机制（双环外环）。
 */
export interface MetaCognitionBridge {
  runMetaCycle(): Promise<unknown>;
}

/**
 * 共生进化桥接器（第五阶段 Phase 2.5：由 index.ts 桥接到 SymbiosisBridge）
 *
 * 心跳每拍调用 runSymbiosisTick：宿主 KPI 注入共生运行时（能量经济 +
 * 信念市场），市场价 vs 被动统计估计的显著背离回流为漂移洞察——
 * 模型漂移的第一现场由市场先行报警，进入目标引擎的自愈链路。
 */
export interface SymbiosisBridgeHook {
  runSymbiosisTick(snapshot: KpiSnapshot): Promise<Insight[]>;
}

/** 自主心跳配置 */
export interface AutonomyLoopConfig {
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
export const DEFAULT_AUTONOMY_LOOP_CONFIG: AutonomyLoopConfig = {
  heartbeatMs: 30_000,
  maxDispatchPerTick: 2,
  maintenanceEveryTicks: 10,
  metaCognitionEveryTicks: 7,
  maxGoalsPerTick: 3,
  enableStrategyEvolution: true,
  enableExploration: true,
  predictionHorizonMs: 5 * 60_000,
};

/** 单轮心跳摘要 */
export interface TickReport {
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
  maintenance?: { distilled: number; decayed: number; forgotten: number; semanticDistilled?: number; proceduralDistilled?: number };
  healthScore: number;
}

/**
 * 自主心跳循环
 *
 * 被 index.ts 持有：插件启动时 start()，fiber 卸载时 stop()。
 * 测试可绕过定时器直接调用 tick() 驱动单轮心跳。
 */
export class AutonomyLoop {
  private config: AutonomyLoopConfig;
  private goalEngine: GoalEngine;
  private metaCognition: MetaCognitionEngine;
  private evolution: StrategyEvolutionEngine;
  private collectKpi: KpiCollector;
  private dispatchSubtask: SubtaskDispatcher;
  private maintainer: MemoryMaintainer;
  private lessonProvider: LessonProvider;
  private strategyApplier?: StrategyApplier;
  /** 第三阶段：调度策略进化桥接（可选注入） */
  private policyEvolution?: PolicyEvolutionBridge;
  /** 第四阶段：元认知环桥接（可选注入） */
  private metaCognitionBridge?: MetaCognitionBridge;
  /** 第五阶段 Phase 2.5：共生进化桥接（可选注入，缺省不启用） */
  private symbiosis?: SymbiosisBridgeHook;
  // 可选自主组件（向后兼容）
  private worldModel?: WorldModel;
  private curiosity?: CuriosityEngine;
  private governor?: SafetyGovernor;
  private dispatchExploration?: ExplorationDispatcher;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** 重入保护：上一轮 tick 未完成时跳过新 tick */
  private ticking = false;
  private running = false;
  private tickCount = 0;
  private reports: TickReport[] = [];
  /** 已消化过的教训 id（避免重复生成目标） */
  private consumedLessons = new Set<string>();

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
  }) {
    this.config = { ...DEFAULT_AUTONOMY_LOOP_CONFIG, ...params.config };
    this.goalEngine = params.goalEngine;
    this.metaCognition = params.metaCognition;
    this.evolution = params.evolution;
    this.collectKpi = params.collectKpi;
    this.dispatchSubtask = params.dispatchSubtask;
    this.maintainer = params.maintainer;
    this.lessonProvider = params.lessonProvider;
    this.strategyApplier = params.strategyApplier;
    this.policyEvolution = params.policyEvolution;
    this.metaCognitionBridge = params.metaCognitionBridge;
    this.symbiosis = params.symbiosis;
    this.worldModel = params.worldModel;
    this.curiosity = params.curiosity;
    this.governor = params.governor;
    this.dispatchExploration = params.dispatchExploration;
  }

  /** 启动心跳定时器 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* 单轮心跳异常隔离 */
      });
    }, this.config.heartbeatMs);
    this.timer.unref?.();
  }

  /** 停止心跳 */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 是否运行中 */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * 执行一轮心跳（自主智能的核心节拍）
   *
   * 重入保护：心跳是异步长链路（目标分解 / 沙盒进化 / 元认知环都可能
   * 慢于 heartbeatMs），interval 触发的新 tick 与滞留中的旧 tick 并发
   * 会双重派发目标与探索、双重触发维护与进化——上一轮未完成时本轮
   * 直接跳过（返回空摘要，不推进计数）
   * @returns 本轮摘要
   */
  async tick(): Promise<TickReport> {
    if (this.ticking) {
      return {
        tick: this.tickCount,
        timestamp: Date.now(),
        insightsCollected: 0,
        goalsCreated: 0,
        subtasksDispatched: 0,
        explorationsDispatched: 0,
        governanceBlocked: 0,
        risingTrends: [],
        evolved: false,
        healthScore: 1,
      };
    }
    this.ticking = true;
    try {
      return await this.runTick();
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<TickReport> {
    this.tickCount += 1;
    const report: TickReport = {
      tick: this.tickCount,
      timestamp: Date.now(),
      insightsCollected: 0,
      goalsCreated: 0,
      subtasksDispatched: 0,
      explorationsDispatched: 0,
      governanceBlocked: 0,
      risingTrends: [],
      evolved: false,
      healthScore: 1,
    };

    // ── 1. 元认知观察：采集 KPI → 异常检测 + 自愈洞察 ──
    let insights: Insight[] = [];
    let kpiSnapshot: KpiSnapshot | undefined;
    try {
      kpiSnapshot = this.collectKpi();
      insights = this.metaCognition.observe(kpiSnapshot);
      report.healthScore = this.metaCognition.getHealthReport().score ?? 1;
    } catch {
      /* KPI 采集失败不阻断 */
    }

    // ── 1.5 共生心跳（第五阶段 Phase 2.5）：KPI 注入能量经济 + 信念市场 ──
    // 市场隐含概率 vs 被动统计估计显著背离 → 漂移洞察回流目标引擎（自愈链路）
    try {
      if (this.symbiosis && kpiSnapshot) {
        const driftInsights = await this.symbiosis.runSymbiosisTick(kpiSnapshot);
        insights.push(...driftInsights);
      }
    } catch {
      /* 共生心跳失败不阻断主链路 */
    }

    // ── 2. 世界模型预见：趋势检测 → 负载预警洞察 ──
    try {
      if (this.worldModel) {
        const trends = this.worldModel.detectTrends();
        for (const trend of trends) {
          if (trend.trend !== 'rising') continue;
          report.risingTrends.push(trend.type);
          insights.push({
            source: 'meta-cognition',
            category: 'load-forecast',
            taskType: trend.type,
            severity: 0.5,
            message: `世界模型预测「${trend.type}」信号到达率上升（斜率 ${trend.slopePerMin}/min²）`,
            suggestion: `为「${trend.type}」预留执行容量并优化其处理链路`,
          });
        }
        // 预测校准对账（窗口到期的预测）
        this.worldModel.settleCalibrations();
      }
    } catch {
      /* 预见失败不阻断 */
    }

    // ── 3. 汇总反思教训洞察（去重已消化的教训） ──
    try {
      const lessons = this.lessonProvider();
      for (const lesson of lessons) {
        if (this.consumedLessons.has(lesson.id)) continue;
        this.consumedLessons.add(lesson.id);
        insights.push({
          source: 'reflection',
          category: lesson.rootCause,
          taskType: lesson.taskType,
          severity: lesson.rootCause === 'model-capability' || lesson.rootCause === 'timeout' ? 0.7 : 0.5,
          message: lesson.lesson,
          suggestion: lesson.suggestion,
        });
      }
    } catch {
      /* 教训读取失败不阻断 */
    }
    report.insightsCollected = insights.length;

    // ── 4. 目标生成（限制单轮数量） ──
    try {
      const created = this.goalEngine.generateGoalsFromInsights(insights).slice(0, this.config.maxGoalsPerTick);
      report.goalsCreated = created.length;
      // 立即分解新目标，使其可执行
      for (const goal of created) {
        await this.goalEngine.decompose(goal.id);
      }
    } catch {
      /* 目标生成失败不阻断 */
    }

    // ── 5. 子任务派发（价值最高优先 + 治理器裁决） ──
    try {
      for (let i = 0; i < this.config.maxDispatchPerTick; i += 1) {
        const picked = this.goalEngine.pickNextSubtask();
        if (!picked) break;
        // 安全治理：goal-dispatch 动作需经裁决
        if (this.governor) {
          const verdict = this.governor.govern('goal-dispatch', picked.goal.confidence);
          if (!verdict.allowed) {
            report.governanceBlocked += 1;
            break; // 被拦截时停止本轮派发，避免反复撞墙
          }
        }
        const signalId = this.dispatchSubtask(picked.subtask, picked.goal);
        this.goalEngine.markDispatched(picked.goal.id, picked.subtask.id, signalId);
        report.subtasksDispatched += 1;
      }
    } catch {
      /* 派发失败不阻断 */
    }

    // ── 6. 好奇心探索（预算内 + 治理器裁决） ──
    if (this.config.enableExploration && this.curiosity && this.dispatchExploration) {
      try {
        const remainingSlots = Math.max(0, this.config.maxDispatchPerTick - report.subtasksDispatched);
        const proposals = this.curiosity.proposeExplorations(remainingSlots + 1, report.healthScore);
        for (const proposal of proposals) {
          if (this.governor) {
            const verdict = this.governor.govern('exploration', 1);
            if (!verdict.allowed) {
              report.governanceBlocked += 1;
              break;
            }
          }
          this.dispatchExploration(proposal);
          report.explorationsDispatched += 1;
        }
      } catch {
        /* 探索失败不阻断 */
      }
    }

    // ── 7. 策略进化（样本达标时触发，产物落地决策引擎） ──
    if (this.config.enableStrategyEvolution) {
      try {
        const evolutionReport = this.evolution.evolve();
        if (evolutionReport) {
          report.evolved = true;
          this.strategyApplier?.(this.evolution.bestGenesAsConfig());
        }
      } catch {
        /* 进化失败不阻断 */
      }
    }

    // ── 7.5 策略进化器（第三阶段：调度策略经沙盒验证后热切换） ──
    // 沙盒离线评估不阻塞操作环；进化失败静默（下轮再试）
    if (this.policyEvolution) {
      try {
        await this.policyEvolution.runEvolutionCycle();
      } catch {
        /* 策略进化失败不阻断 */
      }
    }

    // ── 7.7 元认知环（第四阶段：自我建模 → 保守调整 → 观察/回滚） ──
    // 低频触发（每 metaCognitionEveryTicks 轮）：观察并改进进化机制本身；
    // 心智报告生成与参数调整均为轻量同步操作，失败静默（下轮再试）
    if (this.metaCognitionBridge && this.tickCount % this.config.metaCognitionEveryTicks === 0) {
      try {
        await this.metaCognitionBridge.runMetaCycle();
      } catch {
        /* 元认知环失败不阻断 */
      }
    }

    // ── 8. 记忆维护（低频后台） ──
    if (this.tickCount % this.config.maintenanceEveryTicks === 0) {
      try {
        const distilled = this.maintainer.distillExperience();
        const forgetting = this.maintainer.applyForgettingCurve();
        report.maintenance = { distilled, decayed: forgetting.decayed, forgotten: forgetting.forgotten };
        // 第二阶段：知识蒸馏（语义+程序记忆），失败不阻断主维护流程
        if (this.maintainer.distillKnowledge) {
          try {
            const knowledge = await this.maintainer.distillKnowledge();
            report.maintenance.semanticDistilled = knowledge.semantic;
            report.maintenance.proceduralDistilled = knowledge.procedural;
          } catch {
            /* 知识蒸馏失败不阻断 */
          }
        }
      } catch {
        /* 维护失败不阻断 */
      }
    }

    this.reports.push(report);
    if (this.reports.length > 100) this.reports.shift();
    return report;
  }

  /** 心跳历史 */
  getReports(): TickReport[] {
    return [...this.reports];
  }

  /** 最近一轮摘要 */
  getLatestReport(): TickReport | undefined {
    return this.reports[this.reports.length - 1];
  }

  /**
   * 自省报告（自主智能的全景自我认知）
   * 汇总心跳状态、健康度、目标进度、探索收获、治理状态、世界模型预测
   */
  introspect(): any {
    return {
      loop: this.getStatus(),
      health: this.metaCognition.getHealthReport(),
      goals: this.goalEngine.getSummary(),
      exploration: this.curiosity?.getSummary() ?? null,
      governance: this.governor?.getStatus() ?? null,
      worldModel: this.worldModel?.getSummary() ?? null,
      evolution: this.evolution.getReport(),
    };
  }

  /** 运行状态 */
  getStatus(): any {
    return {
      running: this.running,
      heartbeatMs: this.config.heartbeatMs,
      tickCount: this.tickCount,
      latest: this.getLatestReport(),
    };
  }
}
