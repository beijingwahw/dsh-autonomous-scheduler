/**
 * model-scheduler.ts — 模型调度组件（新架构「优化器 → 模型调度」）
 *
 * 职责（对应架构图「模型调度（原有）」框）：
 * - assignModel：为任务类型选择最优模型（能力画像 × 记忆画像成功率加权 × 成本感知）；
 *   优化器（optimizer.ts）产出的推荐模型作为 preferred 优先采纳
 * - pickFallbackModel：质量反思触发模型切换时选择次优模型
 * - computeParallelism：依据已注册模型总并发容量计算同层最大并行数
 *
 * 第三阶段升级（策略进化）：
 * - 评分函数参数化：固定权重（costWeight / memoryWeight 系列）改为从当前策略
 *   （Policy.params）注入，评分核心与沙盒共享 scoreModelWithPolicy（沙盒保真）
 * - 热切换：updatePolicy(policy) 运行时替换当前策略，无需重启系统
 * - 多模型组合：pickEnsemble 按当前策略评分返回集成候选（供执行侧编排）
 *
 * 质级升级（规则基因组）：
 * - assignModel / pickEnsemble / pickFallbackModel 增加可选任务上下文
 *   （复杂度/特征标签）；调用 resolveEffectiveParams 解析规则基因的
 *   条件覆盖（如「高复杂度任务强制集成」「特定类型降本」），调度决策
 *   从全局单一权重升级为上下文敏感的可进化规则程序
 * - 无规则或无匹配时行为与纯标量策略逐位一致（向后兼容）
 *
 * 兼容性：未部署进化策略时 currentPolicy = 基准策略（参数复刻原固定值），
 * 行为与第二阶段逐位一致。
 *
 * 边界：只读 LLM 客户端运行时状态与记忆库模型画像，不执行任务、不写记忆。
 */

import type { LLMClient } from './llm-client.js';
import type { BayesianEstimate, LongTermMemory } from './memory/long-term-memory.js';
import { ExecutionError } from './types.js';
import {
  BASELINE_POLICY_PARAMS,
  resolveEffectiveParams,
  scoreModelWithPolicy,
  type Policy,
  type SchedulerPolicyParams,
} from './policy/policy-types.js';
import type { EFEAction, EFEEvaluation, FreeEnergyEngine } from './core/free-energy.js';

/** 模型调度配置 */
export interface ModelSchedulerConfig {
  /** 成本感知权重 0~1：模型选择时对单位成本的惩罚系数（0=纯质量导向） */
  costWeight?: number;
  /** 2.0：探索/利用权衡——UCB 探索开关（缺省开启；关闭后纯利用端评分） */
  explorationEnabled?: boolean;
  /** 2.0：探索加成系数（缺省 0.08；乘以 sqrt(log(1+Σn)/(1+n)) 不确定性项） */
  exploreBonus?: number;
  /** 2.0：探索生效的有效样本下限（缺省 5；样本充足的模型不再获得加成） */
  exploreSampleFloor?: number;
  /**
   * 2.0：冷启动探索预算——全部模型有效样本总和 ≥ 该值后探索关闭（缺省 30）
   *
   * 探索的使命是解决冷启动，不是永远与利用竞争：证据充足后纯利用端评分，
   * 避免大样本场景下 log(ΣN) 项给零样本模型过大加成、干扰稳健决策。
   */
  exploreBudget?: number;
  /**
   * 第五阶段 B 路线：能量反哺调度（缺省 false，零行为漂移）。
   * 启用后 updateEconomicSignals 注入的共生经济乘数作用于利用端评分：
   * 赚钱且信誉好的模型升权、持续亏损的模型降权——能量经济的生存压力
   * 直接反馈到调度行为。UCB 探索加成不受乘数影响（信息价值高于
   * 短期经济；冷启动重估机会不被经济惩罚剥夺）。
   */
  economicFeedbackEnabled?: boolean;
  /**
   * 6.0：主动推断调度（缺省 false，零行为漂移）。
   *
   * 启用后候选评分改用期望自由能 G(a) = 务实价值 − 认知价值：
   * - 务实价值 = 模型后验预测对成功偏好的期望惊奇（利用端，替代线性策略评分）
   * - 认知价值 = 该选择预期收缩多少不确定性（探索端，替代 UCB 加成——
   *   不确定性耗尽认知价值自动归零，探索预算不再需要手设常数）
   * 一个变分目标统一探索/利用，且逐选择输出「多少因为有用/多少
   * 因为想弄清」的可解释分解。未启用时评分路径逐位保持原逻辑。
   */
  freeEnergyEnabled?: boolean;
  /** 6.0：EFE 偏好强度（对成功的目标概率，缺省 0.9） */
  freeEnergyPreference?: number;
}

/** 调度决策洞察（2.0：预测置信度 + 探索标记，供反思器校准与反事实分析消费） */
export interface SchedulingInsight {
  taskType: string;
  modelId: string;
  /** 所选模型的贝叶斯后验均值（调度器对成功率的预测；无画像时为中性 0.5） */
  confidence: number;
  /** 本次选择是否由探索加成胜出（冷启动模型重估机会） */
  exploration: boolean;
  /** 所选模型有效样本量（0 = 无历史证据的纯探索） */
  effectiveSamples: number;
  /** 决策依据说明 */
  rationale: string;
  /** B 路线：所选模型的共生经济乘数（能量反哺调度；未启用/无信号时为 1） */
  economicMultiplier?: number;
}

/** 任务调度上下文（规则基因组的匹配输入；可选，兼容旧调用方） */
export interface SchedulerTaskContext {
  complexity?: number;
  features?: string[];
}

/**
 * 模型调度器
 *
 * 被任务执行器（task-executor.ts）持有：节点执行前调用 assignModel 分配模型，
 * 重试切换时调用 pickFallbackModel 选择次优模型。
 */
export class ModelScheduler {
  private llm: LLMClient;
  private memory: LongTermMemory;
  private config: ModelSchedulerConfig;
  /** 当前生效调度策略（第三阶段：评分函数参数来源；基准 = 原固定行为） */
  private currentPolicy: Policy;
  /** B 路线：共生经济乘数（modelId → 乘数；缺省空 = 全中性） */
  private economicMultipliers = new Map<string, number>();
  /** 6.0：自由能引擎（EFE 调度模式；未挂载/未启用零漂移） */
  private freeEnergy?: FreeEnergyEngine;

  constructor(params: { llm: LLMClient; memory: LongTermMemory; config?: ModelSchedulerConfig }) {
    this.llm = params.llm;
    this.memory = params.memory;
    this.config = params.config ?? {};
    // 基准策略：costWeight 沿用构造配置（保持既有调用方行为），其余复刻原固定值
    this.currentPolicy = {
      id: 'policy-baseline',
      version: 1,
      type: 'scheduler',
      params: { ...BASELINE_POLICY_PARAMS, costWeight: this.config.costWeight ?? BASELINE_POLICY_PARAMS.costWeight },
      origin: 'baseline',
      generation: 0,
      createdAt: Date.now(),
    };
  }

  /** 运行时配置热更新（元认知自调优落地入口） */
  updateConfig(patch: Partial<ModelSchedulerConfig>): void {
    this.config = { ...this.config, ...patch };
    if (patch.costWeight !== undefined) {
      // 配置热更新同步到当前策略参数（策略部署前的兼容路径）
      this.currentPolicy = { ...this.currentPolicy, params: { ...this.currentPolicy.params, costWeight: patch.costWeight } };
    }
  }

  /**
   * B 路线：注入共生经济乘数（能量反哺调度；宿主心跳桥接调用）。
   *
   * 乘数来自 SymbiosisBridge.economicSignals()（余额 × Wilson 信誉的
   * 复合健康度），仅作用于利用端评分——赚钱的模型升权、持续亏损的
   * 模型降权。注入即生效（对后续 assignModel/pickEnsemble/pickFallback
   * 全路径一致）；信号中缺失的模型回退中性乘数 1。
   * @param signals modelId → 调度乘数（典型范围 0.5~1.5）
   */
  updateEconomicSignals(signals: Record<string, number> | Map<string, number>): void {
    const next = new Map<string, number>();
    const entries = signals instanceof Map ? signals : Object.entries(signals);
    for (const [modelId, m] of entries) {
      // 防御：非有限值 / 非正数一律忽略（外部信号不破坏评分域）
      if (Number.isFinite(m) && m > 0) next.set(modelId, m);
    }
    this.economicMultipliers = next;
  }

  /**
   * 6.0：挂载自由能引擎（幂等；需同时 freeEnergyEnabled=true 才生效）。
   *
   * @param engine 主动推断内核实例（宿主单一实例共享）
   * @param outcomeNode 因果图结果节点（缺省 'task.outcome'；模型选择即
   *   do(use:model) 干预，证据由共生结算侧登记）
   */
  attachFreeEnergy(engine: FreeEnergyEngine, outcomeNode = 'task.outcome'): void {
    this.freeEnergy = engine;
    this.efeOutcomeNode = outcomeNode;
  }

  private efeOutcomeNode = 'task.outcome';

  /** 模型的当前经济乘数（无信号 = 中性 1；economicFeedbackEnabled 关闭时恒为 1） */
  economicMultiplierOf(modelId: string): number {
    if (this.config.economicFeedbackEnabled !== true) return 1;
    return this.economicMultipliers.get(modelId) ?? 1;
  }

  /**
   * 策略热切换（第三阶段：策略进化器部署入口）
   *
   * 由 PolicyEvolver.deployPolicy → onDeploy 回调调用；
   * 替换评分函数参数集，立即对后续 assignModel 生效，无需重启。
   */
  updatePolicy(policy: Policy): void {
    this.currentPolicy = { ...policy, params: { ...policy.params } };
  }

  /** 当前生效策略（供优化器标注策略版本） */
  getPolicy(): Policy {
    return { ...this.currentPolicy, params: { ...this.currentPolicy.params } };
  }

  /** 解析上下文有效参数（规则基因组匹配；无规则时即基础参数） */
  private effectiveParams(taskType: string, context?: SchedulerTaskContext): SchedulerPolicyParams {
    return resolveEffectiveParams(this.currentPolicy.params, {
      taskType,
      complexity: context?.complexity,
      features: context?.features,
    });
  }

  /** 单模型评分（2.0：贝叶斯证据装配——Wilson 下界 + 有效样本量 + 质量 EMA） */
  private scoreModel(
    taskType: string,
    status: { id: string; taskScores: Record<string, number>; totalCalls: number; totalTokensUsed: number },
    params: SchedulerPolicyParams,
  ): number {
    const estimate = this.memory.getBayesianEstimate(status.id, taskType);
    const base = scoreModelWithPolicy(params, {
      taskScore: status.taskScores[taskType] ?? status.taskScores['general'] ?? 0.5,
      // 2.0 质变：裸成功率 → Wilson 下界（3 次全成 ≈ 0.40，300 次全成 ≈ 0.95，
      // 小样本自动保守；杜绝「3/3 成功」压过「290/300 稳健」的小数点幻觉）
      memoryScore: estimate ? estimate.wilsonLower : 0.5,
      // 2.0：memoryCalls 用有效样本量（时间衰减后的等效观测数，旧证据自然让位）
      memoryCalls: estimate ? Math.round(estimate.effectiveSamples) : 0,
      avgQuality: estimate?.emaQuality || 0.5,
      avgTokens: status.totalCalls > 0 ? status.totalTokensUsed / status.totalCalls : 0,
    });
    // B 路线：共生经济乘数作用于利用端（UCB 探索加成不乘——信息价值
    // 高于短期经济；关闭/无信号时恒为 1，评分与原逻辑逐位一致）
    return base * this.economicMultiplierOf(status.id);
  }

  /**
   * 全候选评分（2.0：利用端策略评分 + UCB 探索加成）
   *
   * 探索/利用权衡（解决裸计数调度的两个死局）：
   * - 冷启动死局：新模型 0 样本得中性分 0.5，永远竞争不过平庸但样本多的模型
   * - 埋没死局：模型早期失败后，即使能力已修复也永无翻身机会
   *
   * UCB 加成 = exploreBonus × sqrt(log(1+ΣN) / (1+n_i))：
   * 样本越少加成越大（信息价值高）；仅冷启动期（ΣN < exploreBudget）
   * 生效，且有效样本 ≥ exploreSampleFloor 的模型不加成（纯利用）。
   */
  private scoreCandidates(
    taskType: string,
    context: SchedulerTaskContext | undefined,
    statuses: Array<{ id: string; taskScores: Record<string, number>; totalCalls: number; totalTokensUsed: number }>,
  ): Array<{ id: string; base: number; bonus: number; total: number; estimate?: BayesianEstimate; efe?: EFEEvaluation }> {
    const params = this.effectiveParams(taskType, context);
    const scored: Array<{ id: string; base: number; bonus: number; total: number; estimate?: BayesianEstimate; efe?: EFEEvaluation }> = statuses.map((status) => {
      const estimate = this.memory.getBayesianEstimate(status.id, taskType);
      const base = this.scoreModel(taskType, status, params);
      return { id: status.id, base, bonus: 0, total: base, estimate };
    });

    // 6.0：主动推断模式——期望自由能统一探索/利用（启用且挂载引擎时
    // 完全替换 UCB 路径；探索预算由证据量内生，无需手设常数）。
    // total = −G(a)：G 越低（既预测有用又可能学到东西）total 越高；
    // bonus = 认知价值（nat），供洞察层标注「这次选择有多少是想弄清」。
    if (this.config.freeEnergyEnabled === true && this.freeEnergy) {
      const preference = this.config.freeEnergyPreference ?? 0.9;
      const actions: EFEAction[] = scored.map((s) => {
        const est = s.estimate;
        const mean = est ? est.posteriorMean : 0.5;
        const lower = est ? est.wilsonLower : 0;
        return {
          id: s.id,
          pSuccess: mean,
          lower,
          // 区间上界镜像估计（Wilson 上界近似：均值 + (均值 − 下界)）
          upper: Math.min(1, mean + Math.max(0, mean - lower)),
          // 调度器的刻意选型 = do 干预证据（与共生结算登记同源）
          interventionalSamples: est ? est.effectiveSamples : 0,
          observationalSamples: 0,
        };
      });
      const evals = this.freeEnergy.evaluateActions(actions, preference);
      const byId = new Map(evals.map((e) => [e.actionId, e]));
      for (const s of scored) {
        const e = byId.get(s.id);
        if (!e) continue;
        s.efe = e;
        s.total = -e.efe;
        s.bonus = e.epistemic;
      }
      return scored;
    }

    const explorationOn = this.config.explorationEnabled !== false;
    const bonusWeight = this.config.exploreBonus ?? 0.08;
    const sampleFloor = this.config.exploreSampleFloor ?? 5;
    const exploreBudget = this.config.exploreBudget ?? 30;
    if (explorationOn && bonusWeight > 0) {
      const totalN = scored.reduce((sum, s) => sum + (s.estimate?.effectiveSamples ?? 0), 0);
      // 冷启动探索期：总证据不足预算时才探索（证据充足后纯利用端决策）
      if (totalN < exploreBudget) {
        for (const s of scored) {
          const n = s.estimate?.effectiveSamples ?? 0;
          if (n >= sampleFloor) continue;
          s.bonus = bonusWeight * Math.sqrt(Math.log(1 + totalN + scored.length) / (1 + n));
          s.total = s.base + s.bonus;
        }
      }
    }
    return scored;
  }

  /** 所选模型的决策洞察（预测置信度 + 探索标记 + 依据说明） */
  private insightOf(
    taskType: string,
    chosen: { id: string; base: number; bonus: number; total: number; estimate?: BayesianEstimate; efe?: EFEEvaluation } | undefined,
    preferredUsed: boolean,
    scored?: Array<{ id: string; base: number; efe?: EFEEvaluation }>,
  ): SchedulingInsight {
    const estimate = chosen?.estimate;
    // 6.0：EFE 模式洞察——自由能分解直接进决策依据
    if (chosen?.efe && this.config.freeEnergyEnabled === true && this.freeEnergy) {
      const e = chosen.efe;
      // 探索的主动推断语义：存在「纯利用端不劣于所选」的对手（务实值 ≤ 所选，
      // 认知价值≈0 的既知者）却输给了所选的认知价值 → 这次选择是为学而选
      const pragmaticRival = (scored ?? []).find(
        (s) => s.efe && s.id !== chosen.id && s.efe.pragmatic <= e.pragmatic + 1e-9,
      );
      const exploration = e.epistemic > 0.03 && pragmaticRival !== undefined;
      return {
        taskType,
        modelId: chosen.id,
        confidence: estimate ? estimate.posteriorMean : 0.5,
        exploration,
        effectiveSamples: estimate?.effectiveSamples ?? 0,
        rationale: `主动推断选择 ${chosen.id}（EFE ${e.efe.toFixed(3)} = 务实 ${e.pragmatic.toFixed(3)} − 认知 ${e.epistemic.toFixed(3)} nat；好奇占比 ${Math.round(e.curiosityShare * 100)}%，Boltzmann ${(e.boltzmannProb * 100).toFixed(1)}%）`,
        economicMultiplier: this.economicMultiplierOf(chosen.id),
      };
    }
    // 探索胜出 = 探索加成把非利用端最优的模型推上榜首（信息价值驱动的主动重估）
    const bestBaseId = scored && scored.length > 0 ? scored.reduce((a, b) => (b.base > a.base ? b : a)).id : undefined;
    const exploration = Boolean(!preferredUsed && chosen && chosen.bonus > 0 && bestBaseId !== undefined && chosen.id !== bestBaseId);
    return {
      taskType,
      modelId: chosen?.id ?? '',
      confidence: estimate ? estimate.posteriorMean : 0.5,
      exploration,
      effectiveSamples: estimate?.effectiveSamples ?? 0,
      rationale: preferredUsed
        ? `优先采用推荐模型 ${chosen?.id}（优化器经验推荐，贝叶斯置信度 ${estimate ? estimate.posteriorMean.toFixed(2) : '0.50'}）`
        : exploration
          ? `探索性选择 ${chosen?.id}（利用分 ${chosen!.base.toFixed(3)} + UCB 加成 ${chosen!.bonus.toFixed(3)}，有效样本 ${estimate?.effectiveSamples.toFixed(1) ?? '0'} < ${this.config.exploreSampleFloor ?? 5}，收集证据中）`
          : `利用端最优 ${chosen?.id}（策略评分 ${chosen?.base.toFixed(3)}，贝叶斯下界 ${estimate ? estimate.wilsonLower.toFixed(2) : '-'}，有效样本 ${estimate?.effectiveSamples.toFixed(1) ?? '0'}）`,
      // B 路线：经济乘数进洞察（非中性时标注，供反思器归因调度偏差来源）
      economicMultiplier: this.economicMultiplierOf(chosen?.id ?? ''),
    };
  }

  /** 所选模型的贝叶斯置信度（重试切换后由执行器刷新洞察用） */
  modelInsight(taskType: string, modelId: string): SchedulingInsight {
    const estimate = this.memory.getBayesianEstimate(modelId, taskType);
    return {
      taskType,
      modelId,
      confidence: estimate ? estimate.posteriorMean : 0.5,
      exploration: false,
      effectiveSamples: estimate?.effectiveSamples ?? 0,
      rationale: `切换至 ${modelId}（贝叶斯后验 ${estimate ? estimate.posteriorMean.toFixed(2) : '0.50'}，下界 ${estimate ? estimate.wilsonLower.toFixed(2) : '-'}）`,
    };
  }

  /**
   * 为任务类型分配最优模型（能力画像 × 贝叶斯记忆画像 × 成本感知 × 探索/利用权衡）
   *
   * 第三阶段：评分核心改用策略参数化的 scoreModelWithPolicy
   * （与安全沙盒共享同一实现，参数 = 基准策略时与原固定公式一致）。
   * 质级升级：传入 context 时按规则基因组解析上下文有效参数。
   * 2.0：记忆证据从裸成功率升级为 Wilson 下界 + 有效样本量 + UCB 探索。
   *
   * @param taskType 任务类型
   * @param preferred 优化器推荐的模型（优先）
   * @param context 任务上下文（复杂度/特征；供规则基因匹配）
   */
  assignModel(taskType: string, preferred?: string, context?: SchedulerTaskContext, options?: { avoidModels?: string[] }): string {
    return this.assignModelWithInsight(taskType, preferred, context, options).modelId;
  }

  /**
   * 带洞察的模型分配（2.0：返回预测置信度与探索标记，供反思器校准闭环）
   *
   * 与 assignModel 共享同一评分与选择逻辑；编排层用本方法收集决策洞察，
   * 在复盘时回注反思器计算 Brier 校准误差与反事实遗憾。
   * 4.0：avoidModels 负向约束——经验规避模型（历史超时/能力不足）从候选剔除，
   * 推荐模型被规避时同样降级为动态评分选型（勘察修复：升级前 avoidModels
   * 产出后无人消费，负向经验在调度端断链）。
   */
  assignModelWithInsight(
    taskType: string,
    preferred?: string,
    context?: SchedulerTaskContext,
    options?: { avoidModels?: string[] },
  ): SchedulingInsight {
    const avoid = new Set(options?.avoidModels ?? []);
    if (preferred && !avoid.has(preferred) && this.llm.getModel(preferred)) {
      return this.insightOf(taskType, { id: preferred, base: 0, bonus: 0, total: 0, estimate: this.memory.getBayesianEstimate(preferred, taskType) }, true);
    }

    const statuses = this.llm.getModelStatuses().filter((s) => !avoid.has(s.id));
    if (statuses.length === 0) throw new ExecutionError('没有已注册的可用模型');

    const scored = this.scoreCandidates(taskType, context, statuses);
    let best = scored[0]!;
    for (const s of scored) {
      if (s.total > best.total) best = s;
    }
    return this.insightOf(taskType, best, false, scored);
  }

  /**
   * 多模型集成候选（第三阶段：模型组合逻辑的策略落地）
   *
   * 按当前策略评分降序返回前 N 个模型（供执行侧并行执行 + 融合决策）。
   * 质级升级：传入 context 时按规则基因组解析上下文有效参数
   * （如规则强制 ensembleForce=true 的任务类型稳定给出组合候选）。
   * @param taskType 任务类型
   * @param count 集成模型数（缺省取策略 ensembleMaxModels）
   * @param exclude 排除的模型 id（如重试时排除当前模型）
   * @param context 任务上下文（复杂度/特征；供规则基因匹配）
   */
  pickEnsemble(taskType: string, count?: number, exclude: string[] = [], context?: SchedulerTaskContext): string[] {
    const statuses = this.llm.getModelStatuses().filter((s) => !exclude.includes(s.id));
    if (statuses.length === 0) return [];
    const params = this.effectiveParams(taskType, context);
    const ranked = statuses
      .map((status) => ({ id: status.id, score: this.scoreModel(taskType, status, params) }))
      .sort((a, b) => b.score - a.score);
    const n = Math.max(1, count ?? params.ensembleMaxModels);
    return ranked.slice(0, n).map((r) => r.id);
  }

  /**
   * 选择次优模型（排除当前模型，按策略评分；context 供规则基因匹配）
   * 4.0：excludeModels 额外排除清单（经验规避模型 / 熔断中模型），向后兼容
   */
  pickFallbackModel(taskType: string, excludeModelId: string, context?: SchedulerTaskContext, excludeModels?: string[]): string | undefined {
    const exclude = new Set<string>([excludeModelId, ...(excludeModels ?? [])]);
    const statuses = this.llm.getModelStatuses().filter((s) => !exclude.has(s.id));
    if (statuses.length === 0) return undefined;
    const params = this.effectiveParams(taskType, context);
    let bestId: string | undefined;
    let bestScore = -1;
    for (const status of statuses) {
      const score = this.scoreModel(taskType, status, params);
      if (score > bestScore) {
        bestScore = score;
        bestId = status.id;
      }
    }
    return bestId;
  }

  /**
   * 动态并行度：依据已注册模型的总并发容量计算同层最大并行数
   * （避免同层节点数超过模型并发容量导致全部排队）
   */
  computeParallelism(): number {
    const totalConcurrency = this.llm
      .getModelStatuses()
      .reduce((sum, s) => sum + s.maxConcurrency, 0);
    // 至少 1，上限 16（防止异常配置导致过度并行）
    return Math.max(1, Math.min(16, totalConcurrency || 4));
  }
}
