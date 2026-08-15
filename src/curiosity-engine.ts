/**
 * curiosity-engine.ts — 好奇心引擎（自主智能"内在动机"支柱）
 *
 * 职责：让系统不满足于"完成被指派的任务"，而是主动发现自身的知识盲区，
 * 生成探索性任务去填补盲区——这是从"工具"到"自主智能体"的关键跃迁。
 *
 * 能力矩阵：
 * 1. 知识盲区扫描：对比"系统接触过的任务类型"与"记忆中有成功经验的类型"，
 *    识别接触多但经验少（高失败/低质量）的类型，以及从未探索过的类型
 * 2. 新颖度排序：对候选探索目标按"信息增益"打分——
 *    未知程度（无经验）+ 潜在价值（接触频率）+ 探索稀缺度（历史探索次数）
 * 3. 探索预算：限制探索任务占比，防止好奇心失控挤占核心任务资源，
 *    预算随系统健康度动态调节（健康时多探索，退化时收敛）
 * 4. 探索回写：探索任务完成后记录收获（是否填补了盲区），
 *    驱动好奇心模型更新，形成"探索 → 学习 → 新盲区"的循环
 *
 * 设计要点：
 * - 好奇心产出的探索目标经 goalEngine 注入哨兵执行，与自主闭环无缝衔接
 * - 探索预算与健康度联动，保证探索行为始终在安全边界内
 */

/** 知识盲区候选 */
export interface KnowledgeGap {
  /** 任务类型 */
  taskType: string;
  /** 盲区成因 */
  reason: 'unexplored' | 'low-experience' | 'high-failure';
  /** 接触次数（外部信号到达次数） */
  exposureCount: number;
  /** 已有成功经验数 */
  experienceCount: number;
  /** 历史探索次数 */
  explorationCount: number;
  /** 新颖度评分 0~1（越高越值得探索） */
  noveltyScore: number;
}

/** 探索任务建议 */
export interface ExplorationProposal {
  taskType: string;
  description: string;
  noveltyScore: number;
  /** 预期信息增益描述 */
  expectedGain: string;
}

/** 探索记录 */
export interface ExplorationRecord {
  taskType: string;
  timestamp: number;
  /** 探索是否带来新知识（填补盲区） */
  gainedKnowledge: boolean;
  note?: string;
}

/** 好奇心引擎配置 */
export interface CuriosityEngineConfig {
  /** 探索预算占单轮心跳派发的最大比例 0~1 */
  explorationBudgetRatio: number;
  /** 判定"低经验"的成功经验数阈值 */
  lowExperienceThreshold: number;
  /** 判定"高失败"的失败率阈值 */
  highFailureRateThreshold: number;
  /** 新颖度评分中未知程度的权重 */
  noveltyUnknownWeight: number;
  /** 新颖度评分中接触频率的权重 */
  noveltyExposureWeight: number;
  /** 新颖度评分中探索稀缺度的权重 */
  noveltyScarcityWeight: number;
}

/** 默认配置 */
export const DEFAULT_CURIOSITY_CONFIG: CuriosityEngineConfig = {
  explorationBudgetRatio: 0.3,
  lowExperienceThreshold: 2,
  highFailureRateThreshold: 0.5,
  noveltyUnknownWeight: 0.5,
  noveltyExposureWeight: 0.3,
  noveltyScarcityWeight: 0.2,
};

/** 知识状态提供器（由 index.ts 桥接长期记忆与世界模型） */
export interface KnowledgeProvider {
  /** 系统接触过的任务类型及接触次数 */
  getExposure(): Record<string, number>;
  /** 各任务类型的成功经验数 */
  getExperienceCounts(): Record<string, number>;
  /** 各任务类型的失败率 0~1 */
  getFailureRates(): Record<string, number>;
}

/**
 * 好奇心引擎
 *
 * 被 index.ts 持有：心跳循环在派发子任务前调用 proposeExplorations()
 * 获取探索建议（受预算约束），探索完成后经 recordExploration() 回写收获。
 */
export class CuriosityEngine {
  private config: CuriosityEngineConfig;
  private provider: KnowledgeProvider;
  private explorations: ExplorationRecord[] = [];
  /** 各类型历史探索次数 */
  private explorationCounts = new Map<string, number>();

  constructor(provider: KnowledgeProvider, config?: Partial<CuriosityEngineConfig>) {
    this.provider = provider;
    this.config = { ...DEFAULT_CURIOSITY_CONFIG, ...config };
  }

  /**
   * 扫描知识盲区
   * @returns 盲区候选列表（按新颖度降序）
   */
  scanKnowledgeGaps(): KnowledgeGap[] {
    const exposure = this.provider.getExposure();
    const experience = this.provider.getExperienceCounts();
    const failureRates = this.provider.getFailureRates();
    const gaps: KnowledgeGap[] = [];

    const maxExposure = Math.max(1, ...Object.values(exposure));

    for (const [taskType, exposureCount] of Object.entries(exposure)) {
      const experienceCount = experience[taskType] ?? 0;
      const failureRate = failureRates[taskType] ?? 0;
      const explorationCount = this.explorationCounts.get(taskType) ?? 0;

      // 盲区成因判定
      let reason: KnowledgeGap['reason'] | null = null;
      if (experienceCount === 0) reason = 'unexplored';
      else if (failureRate >= this.config.highFailureRateThreshold) reason = 'high-failure';
      else if (experienceCount < this.config.lowExperienceThreshold) reason = 'low-experience';
      if (!reason) continue;

      // 新颖度评分：未知程度 + 接触频率 + 探索稀缺度
      const unknownScore = reason === 'unexplored' ? 1 : experienceCount < this.config.lowExperienceThreshold ? 0.6 : 0.4;
      const exposureScore = exposureCount / maxExposure;
      const scarcityScore = 1 / (1 + explorationCount);
      const noveltyScore =
        unknownScore * this.config.noveltyUnknownWeight +
        exposureScore * this.config.noveltyExposureWeight +
        scarcityScore * this.config.noveltyScarcityWeight;

      gaps.push({
        taskType,
        reason,
        exposureCount,
        experienceCount,
        explorationCount,
        noveltyScore: Number(noveltyScore.toFixed(3)),
      });
    }

    return gaps.sort((a, b) => b.noveltyScore - a.noveltyScore);
  }

  /**
   * 生成探索建议（受预算约束）
   * @param dispatchSlots 本轮心跳的总派发槽位数
   * @param healthScore 系统健康度 0~1（健康时多探索）
   * @returns 探索任务建议列表
   */
  proposeExplorations(dispatchSlots: number, healthScore = 1): ExplorationProposal[] {
    // 探索预算：基础比例 × 健康度调节（退化时收敛探索）
    const healthFactor = Math.max(0.2, Math.min(1, healthScore));
    const budget = Math.floor(dispatchSlots * this.config.explorationBudgetRatio * healthFactor);
    if (budget <= 0) return [];

    const gaps = this.scanKnowledgeGaps();
    const proposals: ExplorationProposal[] = [];
    for (const gap of gaps) {
      if (proposals.length >= budget) break;
      proposals.push({
        taskType: gap.taskType,
        description: this.describeExploration(gap),
        noveltyScore: gap.noveltyScore,
        expectedGain: this.describeGain(gap),
      });
    }
    return proposals;
  }

  /**
   * 回写探索结果（探索完成后调用）
   * @param taskType 探索的任务类型
   * @param gainedKnowledge 是否填补了盲区
   * @param note 备注
   */
  recordExploration(taskType: string, gainedKnowledge: boolean, note?: string): void {
    this.explorations.push({ taskType, timestamp: Date.now(), gainedKnowledge, note });
    this.explorationCounts.set(taskType, (this.explorationCounts.get(taskType) ?? 0) + 1);
    if (this.explorations.length > 200) this.explorations.splice(0, this.explorations.length - 200);
  }

  /** 探索历史 */
  getExplorations(): ExplorationRecord[] {
    return [...this.explorations];
  }

  /** 探索收获率（填补盲区的比例） */
  getExplorationYield(): number {
    if (this.explorations.length === 0) return 0;
    const gained = this.explorations.filter((e) => e.gainedKnowledge).length;
    return Number((gained / this.explorations.length).toFixed(3));
  }

  /** 好奇心摘要 */
  getSummary(): any {
    return {
      totalExplorations: this.explorations.length,
      explorationYield: this.getExplorationYield(),
      topGaps: this.scanKnowledgeGaps().slice(0, 5),
      explorationCounts: Object.fromEntries(this.explorationCounts),
    };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 生成探索任务描述 */
  private describeExploration(gap: KnowledgeGap): string {
    switch (gap.reason) {
      case 'unexplored':
        return `探索未知任务类型「${gap.taskType}」：系统已接触 ${gap.exposureCount} 次但尚无成功经验，需建立首个成功范例`;
      case 'high-failure':
        return `攻克高失败任务类型「${gap.taskType}」：失败率偏高，需探索更可靠的执行方案`;
      case 'low-experience':
        return `深化低经验任务类型「${gap.taskType}」：成功经验不足，需积累更多成功范例`;
      default:
        return `探索任务类型「${gap.taskType}」`;
    }
  }

  /** 生成预期收益描述 */
  private describeGain(gap: KnowledgeGap): string {
    switch (gap.reason) {
      case 'unexplored':
        return `填补「${gap.taskType}」的经验空白，使系统具备处理该类任务的能力`;
      case 'high-failure':
        return `降低「${gap.taskType}」的失败率，提升该类任务的可靠性`;
      case 'low-experience':
        return `丰富「${gap.taskType}」的成功经验库，提升决策与模型分配的准确性`;
      default:
        return `增强「${gap.taskType}」的处理能力`;
    }
  }
}
