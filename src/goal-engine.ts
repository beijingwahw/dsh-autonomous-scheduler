/**
 * goal-engine.ts — 自主目标引擎（"彻底自主智能"核心组件 1/4）
 *
 * 职责：让系统从"被动响应信号"进化为"主动追求目标"。
 *
 * 能力矩阵：
 * 1. 目标自主生成：从反思教训 / 质量趋势 / 元认知诊断等洞察中，
 *    自动提炼可执行的改进目标（规则化 + 可选 LLM 增强），无需人工指派
 * 2. 目标分解：将目标拆解为带任务类型的子任务序列，
 *    每个子任务可直接注入哨兵作为信号执行（LLM 分解 + 规则兜底）
 * 3. 价值评估：impact × confidence / cost 三维打分，
 *    多目标竞争时按价值排序，资源永远流向最高价值目标
 * 4. 进度追踪：子任务与执行信号双向绑定，信号完成自动回写目标进度，
 *    全部子任务完成 → 目标达成；反复失败 → 自动放弃（止损）
 * 5. 目标生命周期：proposed → active → in-progress → completed / abandoned
 *
 * 设计要点：
 * - 目标库随长期记忆持久化（serialize/deserialize），跨会话延续追求
 * - decomposer 可注入，冒烟测试可离线模拟
 */

import type { Lesson } from './reflection-engine.js';

/** 洞察来源（目标生成的输入） */
export interface Insight {
  /** 洞察来源引擎 */
  source: 'reflection' | 'meta-cognition' | 'memory' | 'user';
  /** 洞察类别 */
  category: string;
  /** 关联任务类型（可选） */
  taskType?: string;
  /** 严重度 0~1（越高越值得生成目标） */
  severity: number;
  /** 洞察描述 */
  message: string;
  /** 改进建议（目标生成的种子） */
  suggestion: string;
}

/** 目标子任务 */
export interface GoalSubtask {
  id: string;
  description: string;
  /** 子任务类型（注入哨兵时作为信号类型） */
  taskType: string;
  status: 'pending' | 'dispatched' | 'done' | 'failed';
  /** 绑定的执行信号 id（dispatched 后回填） */
  signalId?: string;
  /** 执行结果摘要 */
  result?: string;
  attempts: number;
}

/** 目标状态 */
export type GoalStatus = 'proposed' | 'active' | 'in-progress' | 'completed' | 'abandoned';

/** 自主目标 */
export interface Goal {
  id: string;
  title: string;
  description: string;
  /** 目标来源 */
  origin: Insight['source'];
  /** 生成该目标的洞察摘要 */
  insightRef: string;
  status: GoalStatus;
  /** 价值分（impact × confidence / cost） */
  valueScore: number;
  impact: number;
  confidence: number;
  estimatedCost: number;
  createdAt: number;
  updatedAt: number;
  /** 完成时限（毫秒时间戳，可选） */
  deadline?: number;
  subtasks: GoalSubtask[];
  /** 关联任务类型（用于匹配完成信号） */
  taskType?: string;
}

/** 目标分解器签名（可注入，通常为 strategist LLM） */
export type GoalDecomposer = (goal: Goal) => Promise<Array<{ description: string; taskType: string }>>;

/** 目标引擎配置 */
export interface GoalEngineConfig {
  /** 生成目标的最低洞察严重度 */
  minInsightSeverity: number;
  /** 同时活跃的目标上限（防止目标膨胀） */
  maxActiveGoals: number;
  /** 子任务最大重试次数（超过则放弃目标） */
  maxSubtaskAttempts: number;
  /** 目标去重相似度门槛（标题归一化后包含关系视为重复） */
  dedupeEnabled: boolean;
  /** 目标分解器（缺省则规则化单步分解） */
  decomposer?: GoalDecomposer;
}

/** 默认配置 */
export const DEFAULT_GOAL_ENGINE_CONFIG: GoalEngineConfig = {
  minInsightSeverity: 0.4,
  maxActiveGoals: 5,
  maxSubtaskAttempts: 2,
  dedupeEnabled: true,
};

/**
 * 自主目标引擎
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳调用 generateGoalsFromInsights
 * 产出目标，再将分解后的子任务注入哨兵执行，执行结果经
 * recordSubtaskOutcome 回写进度，形成"洞察 → 目标 → 行动 → 达成"闭环。
 */
export class GoalEngine {
  private config: GoalEngineConfig;
  private goals = new Map<string, Goal>();
  private goalCounter = 0;
  private subtaskCounter = 0;

  constructor(config?: Partial<GoalEngineConfig>) {
    this.config = { ...DEFAULT_GOAL_ENGINE_CONFIG, ...config };
  }

  /**
   * 从洞察批量生成目标（自主目标生成的核心入口）
   * @param insights 来自反思/元认知/记忆的洞察列表
   * @returns 新生成的目标（去重后）
   */
  generateGoalsFromInsights(insights: Insight[]): Goal[] {
    const created: Goal[] = [];
    // 按严重度降序，优先消化最重要的洞察
    const sorted = [...insights]
      .filter((i) => i.severity >= this.config.minInsightSeverity)
      .sort((a, b) => b.severity - a.severity);

    for (const insight of sorted) {
      if (this.activeGoalCount() >= this.config.maxActiveGoals) break;

      const title = this.titleFromInsight(insight);
      if (this.config.dedupeEnabled && this.isDuplicate(title)) continue;

      // 价值评估：严重度驱动 impact，建议明确度驱动 confidence，成本按子任务数估算
      const impact = Math.min(1, 0.3 + insight.severity * 0.7);
      const confidence = insight.suggestion.length > 0 ? 0.7 : 0.4;
      const estimatedCost = 1; // 分解前按单步估算，分解后可重估
      const goal: Goal = {
        id: `goal-${++this.goalCounter}`,
        title,
        description: `${insight.message}。改进方向：${insight.suggestion}`,
        origin: insight.source,
        insightRef: insight.message,
        status: 'proposed',
        valueScore: this.computeValue(impact, confidence, estimatedCost),
        impact,
        confidence,
        estimatedCost,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        taskType: insight.taskType,
        subtasks: [],
      };
      this.goals.set(goal.id, goal);
      created.push(goal);
    }
    return created;
  }

  /**
   * 分解目标为子任务（LLM 分解 + 规则兜底）
   * @param goalId 目标 id
   * @returns 分解出的子任务列表
   */
  async decompose(goalId: string): Promise<GoalSubtask[]> {
    const goal = this.goals.get(goalId);
    if (!goal) return [];

    let steps: Array<{ description: string; taskType: string }> = [];
    if (this.config.decomposer) {
      try {
        steps = await this.config.decomposer(goal);
      } catch {
        /* 落入规则兜底 */
      }
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      // 规则兜底：目标描述本身作为单一子任务
      steps = [{ description: goal.description, taskType: goal.taskType ?? 'self-improvement' }];
    }

    goal.subtasks = steps.slice(0, 8).map((step) => ({
      id: `subtask-${++this.subtaskCounter}`,
      description: step.description,
      taskType: step.taskType || goal.taskType || 'self-improvement',
      status: 'pending' as const,
      attempts: 0,
    }));
    // 分解后按子任务数重估成本与价值
    goal.estimatedCost = goal.subtasks.length;
    goal.valueScore = this.computeValue(goal.impact, goal.confidence, goal.estimatedCost);
    goal.status = 'active';
    goal.updatedAt = Date.now();
    return goal.subtasks;
  }

  /**
   * 选取下一个待执行子任务（价值最高目标优先，FIFO 次序）
   * @returns 目标与子任务，无待执行项时返回 null
   */
  pickNextSubtask(): { goal: Goal; subtask: GoalSubtask } | null {
    const activeGoals = [...this.goals.values()]
      .filter((g) => (g.status === 'active' || g.status === 'in-progress') && g.subtasks.some((s) => s.status === 'pending'))
      .sort((a, b) => b.valueScore - a.valueScore);
    for (const goal of activeGoals) {
      const subtask = goal.subtasks.find((s) => s.status === 'pending');
      if (subtask) return { goal, subtask };
    }
    return null;
  }

  /**
   * 标记子任务已派发（绑定执行信号）
   */
  markDispatched(goalId: string, subtaskId: string, signalId: string): void {
    const subtask = this.findSubtask(goalId, subtaskId);
    if (!subtask) return;
    subtask.status = 'dispatched';
    subtask.signalId = signalId;
    subtask.attempts += 1;
    const goal = this.goals.get(goalId);
    if (goal) {
      goal.status = 'in-progress';
      goal.updatedAt = Date.now();
    }
  }

  /**
   * 回写子任务执行结果（由编排层在信号执行完成后调用）
   * @returns 目标状态变化（completed / abandoned / null）
   */
  recordSubtaskOutcome(goalId: string, subtaskId: string, success: boolean, result?: string): GoalStatus | null {
    const goal = this.goals.get(goalId);
    const subtask = this.findSubtask(goalId, subtaskId);
    if (!goal || !subtask) return null;

    if (success) {
      subtask.status = 'done';
      subtask.result = result;
    } else if (subtask.attempts >= this.config.maxSubtaskAttempts) {
      subtask.status = 'failed';
      subtask.result = result ?? '重试耗尽';
    } else {
      // 未达重试上限：回到 pending 等待重新派发
      subtask.status = 'pending';
      subtask.signalId = undefined;
    }
    goal.updatedAt = Date.now();

    // 目标终态判定
    const allDone = goal.subtasks.every((s) => s.status === 'done');
    const anyFailed = goal.subtasks.some((s) => s.status === 'failed');
    if (allDone && goal.subtasks.length > 0) {
      goal.status = 'completed';
      return 'completed';
    }
    if (anyFailed && !goal.subtasks.some((s) => s.status === 'pending' || s.status === 'dispatched')) {
      goal.status = 'abandoned';
      return 'abandoned';
    }
    return null;
  }

  /** 通过信号 id 查找绑定的目标与子任务（执行完成回写用） */
  findBySignal(signalId: string): { goal: Goal; subtask: GoalSubtask } | null {
    for (const goal of this.goals.values()) {
      const subtask = goal.subtasks.find((s) => s.signalId === signalId);
      if (subtask) return { goal, subtask };
    }
    return null;
  }

  /** 活跃目标数（proposed / active / in-progress） */
  activeGoalCount(): number {
    return [...this.goals.values()].filter((g) => g.status === 'proposed' || g.status === 'active' || g.status === 'in-progress').length;
  }

  /** 获取目标 */
  getGoal(goalId: string): Goal | undefined {
    return this.goals.get(goalId);
  }

  /** 全部目标（按价值降序） */
  getAllGoals(): Goal[] {
    return [...this.goals.values()].sort((a, b) => b.valueScore - a.valueScore);
  }

  /** 目标进度摘要 */
  getSummary(): any {
    const goals = this.getAllGoals();
    return {
      total: goals.length,
      byStatus: goals.reduce((acc, g) => {
        acc[g.status] = (acc[g.status] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      activeGoals: goals.filter((g) => g.status === 'active' || g.status === 'in-progress').map((g) => ({
        id: g.id,
        title: g.title,
        valueScore: Number(g.valueScore.toFixed(3)),
        progress: this.progressOf(g),
        subtasks: g.subtasks.map((s) => ({ id: s.id, status: s.status, description: s.description })),
      })),
    };
  }

  /** 序列化（随长期记忆持久化） */
  serialize(): Goal[] {
    return this.getAllGoals();
  }

  /** 反序列化（恢复跨会话目标追求） */
  deserialize(goals: Goal[]): void {
    this.goals.clear();
    let maxGoal = 0;
    let maxSubtask = 0;
    for (const goal of goals) {
      this.goals.set(goal.id, goal);
      const goalNum = Number(goal.id.split('-')[1] ?? 0);
      if (goalNum > maxGoal) maxGoal = goalNum;
      for (const subtask of goal.subtasks) {
        const subNum = Number(subtask.id.split('-')[1] ?? 0);
        if (subNum > maxSubtask) maxSubtask = subNum;
      }
    }
    this.goalCounter = maxGoal;
    this.subtaskCounter = maxSubtask;
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 价值评估：impact × confidence / cost（成本至少为 1） */
  private computeValue(impact: number, confidence: number, cost: number): number {
    return (impact * confidence) / Math.max(1, cost);
  }

  /** 从洞察提炼目标标题 */
  private titleFromInsight(insight: Insight): string {
    const scope = insight.taskType ? `[${insight.taskType}] ` : '';
    return `${scope}${insight.suggestion}`.slice(0, 120);
  }

  /** 目标去重：归一化标题的包含关系判定 */
  private isDuplicate(title: string): boolean {
    const normalized = title.toLowerCase().trim();
    for (const goal of this.goals.values()) {
      if (goal.status === 'completed' || goal.status === 'abandoned') continue;
      const existing = goal.title.toLowerCase().trim();
      if (existing === normalized || existing.includes(normalized) || normalized.includes(existing)) {
        return true;
      }
    }
    return false;
  }

  /** 目标进度 0~1 */
  private progressOf(goal: Goal): number {
    if (goal.subtasks.length === 0) return 0;
    const done = goal.subtasks.filter((s) => s.status === 'done').length;
    return done / goal.subtasks.length;
  }

  /** 查找子任务 */
  private findSubtask(goalId: string, subtaskId: string): GoalSubtask | undefined {
    return this.goals.get(goalId)?.subtasks.find((s) => s.id === subtaskId);
  }
}

/** 从反思教训构建洞察（目标引擎与反思引擎的桥接） */
export function lessonsToInsights(lessons: Lesson[]): Insight[] {
  return lessons.map((lesson) => ({
    source: 'reflection' as const,
    category: lesson.rootCause,
    taskType: lesson.taskType,
    severity: lesson.rootCause === 'model-capability' || lesson.rootCause === 'timeout' ? 0.7 : 0.5,
    message: lesson.lesson,
    suggestion: lesson.suggestion,
  }));
}
