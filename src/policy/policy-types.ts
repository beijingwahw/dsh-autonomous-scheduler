/**
 * policy-types.ts — 第三阶段「策略进化」核心数据结构与共享评分函数
 *
 * 设计要点：
 * - 策略空间：模型评分函数权重 + 任务分解规则 + 模型组合逻辑（10 个可进化基因）
 * - 基准策略参数严格复刻 ModelScheduler 原固定值 → 未部署进化策略时行为与
 *   第二阶段完全一致（向后兼容验收点）
 * - 评分函数提取为纯函数 scoreModelWithPolicy：操作环（ModelScheduler）与
 *   沙盒（Sandbox）共用同一实现，保证沙盒评估对真实调度行为的保真度
 * - 全部结构可直接 JSON 序列化（Policy 即持久化格式）
 */

// ─────────────────────────── 策略参数（可进化基因） ───────────────────────────

/** 规则匹配上下文（任务调度现场装配；沙盒评估提供完整上下文） */
export interface PolicyMatchContext {
  taskType: string;
  complexity?: number;
  features?: string[];
}

/**
 * 条件-动作规则（规则基因组，质级升级）
 *
 * 超越全局标量权重的上下文敏感调度单元：满足条件时对有效参数施加
 * 增量调整（成本/记忆权重偏移）或直接覆盖分解/集成开关。
 * 规则按 priority 升序依次叠加；可变长度（0~MAX_POLICY_RULES 条），
 * 支持增加/删除/修改三类变异与双亲子集交叉。
 */
export interface PolicyRule {
  id: string;
  /** 匹配条件（空字段 = 不限制） */
  when: {
    /** 匹配这些任务类型之一（空 = 任意类型） */
    taskTypes?: string[];
    /** 最小复杂度（缺省 0） */
    minComplexity?: number;
    /** 最大复杂度（缺省 1） */
    maxComplexity?: number;
    /** 含有任一特征标签即匹配（空 = 任意特征） */
    features?: string[];
  };
  /** 匹配时的动作 */
  action: {
    /** 成本权重增量（钳制后仍在基因边界内） */
    costWeightDelta?: number;
    /** 记忆基础权重增量 */
    memoryWeightBaseDelta?: number;
    /** 覆盖集成开关（undefined = 不覆盖） */
    ensembleForce?: boolean;
    /** 覆盖分解开关（undefined = 不覆盖） */
    decomposeForce?: boolean;
  };
  /** 应用顺序（小者优先） */
  priority: number;
}

/** 单策略最大规则数（防规则爆炸） */
export const MAX_POLICY_RULES = 4;

/** 规则增量幅度边界 */
export const POLICY_RULE_DELTA_BOUNDS = { min: -0.3, max: 0.3 };

/**
 * 调度策略参数（策略基因）
 *
 * 两层基因组：
 * 1. 全局标量基因：评分权重 + 分解阈值 + 集成参数（10 个）
 * 2. 规则基因（rules）：上下文敏感的条件-动作覆盖层（可变长度）
 */
export interface SchedulerPolicyParams {
  // ── 模型评分函数 ──
  /** 成本感知权重 0~1（0=纯质量导向，1=纯成本导向） */
  costWeight: number;
  /** 记忆画像基础权重（有历史数据时的起始信任度） */
  memoryWeightBase: number;
  /** 记忆画像权重随历史调用量 的增长率 */
  memoryWeightGrowth: number;
  /** 记忆画像权重上限 */
  memoryWeightCap: number;

  // ── 任务分解规则 ──
  /** 是否启用任务分解 */
  decomposeEnabled: boolean;
  /** 触发分解的任务复杂度阈值 */
  decomposeComplexityThreshold: number;
  /** 分解出的最大子任务数 */
  decomposeMaxSubtasks: number;

  // ── 模型组合逻辑 ──
  /** 是否启用多模型集成（最高分与次高分差距小于 gap 时并行执行取融合） */
  ensembleEnabled: boolean;
  /** 触发集成的分数差阈值 */
  ensembleScoreGap: number;
  /** 集成的最大模型数 */
  ensembleMaxModels: number;

  // ── 规则基因组（质级升级：上下文敏感覆盖层；空数组 = 纯标量行为，向后兼容） ──
  rules?: PolicyRule[];
}

// ─────────────────────────── 策略与适应度 ───────────────────────────

/** 策略适应度记录（沙盒评估产出，随策略持久化） */
export interface PolicyFitness {
  /** 沙盒综合收益 reward（0~1） */
  score: number;
  successRate: number;
  avgQuality: number;
  avgLatencyMs: number;
  totalTokens: number;
  /** 评估任务数 */
  evaluatedTasks: number;
  evaluatedAt: number;
}

/**
 * 策略（序列化格式）
 *
 * 可追溯性：id 唯一、version 随部署谱系单调递增、generation 记录进化代际、
 * parentId 指向父代策略（交叉时另有 secondaryParentId 双亲）、origin 标记
 * 来源、fitness 携带最近评估表现数据。
 */
export interface Policy {
  id: string;
  /** 版本（部署谱系单调递增；候选变体基于当前版本 +1 竞争下一版本槽位） */
  version: number;
  /** 策略类型（当前仅调度策略；预留扩展） */
  type: 'scheduler';
  params: SchedulerPolicyParams;
  /** 来源：baseline 基准 / mutation 变异 / crossover 交叉 / explorer 边界内随机探索 / manual 人工注入 */
  origin: 'baseline' | 'mutation' | 'crossover' | 'explorer' | 'manual';
  /** 进化代际（每轮进化周期 +1） */
  generation: number;
  /** 父代策略 id（可追溯进化链） */
  parentId?: string;
  /** 交叉第二亲代 id（仅 origin=crossover） */
  secondaryParentId?: string;
  /** 适应度（评估后回填） */
  fitness?: PolicyFitness;
  createdAt: number;
  /** 部署时间（未部署为空） */
  deployedAt?: number;
}

// ─────────────────────────── 沙盒数据结构 ───────────────────────────

/** 沙盒任务（历史回放 / 对抗合成） */
export interface SandboxTask {
  taskType: string;
  /** 复杂度 0~1 */
  complexity: number;
  /** 特征标签 */
  features: string[];
  /** 任务文本长度（影响 token 成本模拟） */
  length: number;
  /** 来源：replay 历史回放 / adversarial 对抗合成 */
  source: 'replay' | 'adversarial';
  /** 可读标签（评估报告与调试用） */
  label?: string;
}

/** 沙盒内模拟模型状态（从 LLMClient 运行时状态映射，离线快照） */
export interface SimModelStatus {
  id: string;
  /** 能力画像（任务类型 → 适配分 0~1） */
  taskScores: Record<string, number>;
  /** 平均延迟（毫秒） */
  avgLatencyMs: number;
  /** 平均 token 消耗 */
  avgTokens: number;
  maxConcurrency: number;
}

/** 策略评估聚合指标 */
export interface PolicyEvaluationMetrics {
  successRate: number;
  avgQuality: number;
  avgLatencyMs: number;
  totalTokens: number;
  /** 分解率（被分解的任务占比） */
  decompositionRate: number;
  /** 集成率（触发多模型集成的任务占比） */
  ensembleRate: number;
}

/**
 * 沙盒评估报告
 *
 * 收益（reward/gain）、风险（risks：参数越界/模拟异常/未知模型）、
 * 回归（regressions：相对 baseline 的成功率/质量/成本退化）三类信息
 * 共同决定 deployable（部署门禁）。
 */
export interface EvaluationReport {
  policyId: string;
  baselinePolicyId?: string;
  metrics: PolicyEvaluationMetrics;
  baselineMetrics?: PolicyEvaluationMetrics;
  /** 综合收益 0~1（多种子均值） */
  reward: number;
  baselineReward?: number;
  /** 相对 baseline 的收益提升（多种子均值） */
  gain: number;
  /** 多种子 gain 标准差（0 = 单种子或完全稳定） */
  gainStdDev?: number;
  /** 收益置信下界 gain − 1.96·σ/√n（部署门禁用，防单种子过拟合） */
  gainLCB?: number;
  /** 评估种子数 */
  seeds?: number;
  /** 安全风险（非空 → 不可部署） */
  risks: string[];
  /** 回归项（非空 → 不可部署） */
  regressions: string[];
  /** 部署门禁结论 */
  deployable: boolean;
  taskStats: { replayed: number; adversarial: number };
  evaluatedAt: number;
}

// ─────────────────────────── 基因边界与基准 ───────────────────────────

/** 标量基因键（数值 + 布尔；规则基因为独立可变长度维度） */
export type ScalarGeneKey = Exclude<keyof SchedulerPolicyParams, 'rules'>;

/** 基因取值边界（变异钳制 + 部署前校验共用） */
export const POLICY_GENE_BOUNDS: Record<
  ScalarGeneKey,
  { min: number; max: number; integer?: boolean }
> = {
  costWeight: { min: 0, max: 0.8 },
  memoryWeightBase: { min: 0, max: 0.5 },
  memoryWeightGrowth: { min: 0, max: 0.1 },
  memoryWeightCap: { min: 0.3, max: 0.9 },
  decomposeComplexityThreshold: { min: 0.3, max: 0.95 },
  decomposeMaxSubtasks: { min: 2, max: 8, integer: true },
  ensembleScoreGap: { min: 0.01, max: 0.3 },
  ensembleMaxModels: { min: 2, max: 4, integer: true },
  // 布尔基因无边界（变异时按概率翻转）
  decomposeEnabled: { min: 0, max: 1 },
  ensembleEnabled: { min: 0, max: 1 },
};

/**
 * 基准策略参数 — 严格复刻 ModelScheduler 第二阶段固定值：
 * costWeight=0.2（index.ts 构造注入）、memoryWeight = min(0.6, 0.2 + n×0.02)、
 * 分解与集成缺省关闭（第二阶段无此行为）。
 */
export const BASELINE_POLICY_PARAMS: SchedulerPolicyParams = {
  costWeight: 0.2,
  memoryWeightBase: 0.2,
  memoryWeightGrowth: 0.02,
  memoryWeightCap: 0.6,
  decomposeEnabled: false,
  decomposeComplexityThreshold: 0.75,
  decomposeMaxSubtasks: 4,
  ensembleEnabled: false,
  ensembleScoreGap: 0.05,
  ensembleMaxModels: 2,
  rules: [],
};

/** 钳制到边界 */
function clampGene(value: number, bounds: { min: number; max: number; integer?: boolean }): number {
  const v = Math.max(bounds.min, Math.min(bounds.max, value));
  return bounds.integer ? Math.round(v) : Number(v.toFixed(4));
}

const clampDelta = (v: number): number => Number(Math.max(POLICY_RULE_DELTA_BOUNDS.min, Math.min(POLICY_RULE_DELTA_BOUNDS.max, v)).toFixed(4));

/** 单条规则是否匹配上下文（空条件字段 = 不限制） */
export function policyRuleMatches(rule: PolicyRule, ctx: PolicyMatchContext): boolean {
  const { when } = rule;
  if (when.taskTypes && when.taskTypes.length > 0 && !when.taskTypes.includes(ctx.taskType)) return false;
  if (when.minComplexity !== undefined && (ctx.complexity ?? 0.5) < when.minComplexity) return false;
  if (when.maxComplexity !== undefined && (ctx.complexity ?? 0.5) > when.maxComplexity) return false;
  if (when.features && when.features.length > 0) {
    const feats = ctx.features ?? [];
    if (!when.features.some((f) => feats.includes(f))) return false;
  }
  return true;
}

/** 规则数组清洗：增量钳制 + 条件域修正 + 去重 + 截断到上限 */
function sanitizeRules(rules: PolicyRule[] | undefined): PolicyRule[] {
  if (!Array.isArray(rules)) return [];
  const seen = new Set<string>();
  const out: PolicyRule[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push({
      id: rule.id,
      when: {
        taskTypes: Array.isArray(rule.when?.taskTypes) ? rule.when.taskTypes.filter(Boolean).slice(0, 8) : undefined,
        minComplexity: rule.when?.minComplexity !== undefined ? clampGene(rule.when.minComplexity, { min: 0, max: 1 }) : undefined,
        maxComplexity: rule.when?.maxComplexity !== undefined ? clampGene(rule.when.maxComplexity, { min: 0, max: 1 }) : undefined,
        features: Array.isArray(rule.when?.features) ? rule.when.features.filter(Boolean).slice(0, 8) : undefined,
      },
      action: {
        costWeightDelta: rule.action?.costWeightDelta !== undefined ? clampDelta(rule.action.costWeightDelta) : undefined,
        memoryWeightBaseDelta: rule.action?.memoryWeightBaseDelta !== undefined ? clampDelta(rule.action.memoryWeightBaseDelta) : undefined,
        ensembleForce: rule.action?.ensembleForce,
        decomposeForce: rule.action?.decomposeForce,
      },
      priority: Number.isFinite(rule.priority) ? Number(rule.priority) : 0,
    });
    if (out.length >= MAX_POLICY_RULES) break;
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/**
 * 上下文有效参数解析（规则基因组核心）
 *
 * 以基础标量基因为底，按 priority 升序叠加所有匹配规则的增量与开关覆盖，
 * 结果再经边界钳制 → 任意上下文下的有效参数恒在基因边界内（安全不变量）。
 * rules 为空或无匹配时与基础参数完全一致（向后兼容）。
 */
export function resolveEffectiveParams(params: SchedulerPolicyParams, ctx: PolicyMatchContext): SchedulerPolicyParams {
  const rules = params.rules ?? [];
  if (rules.length === 0) return params;
  let costWeight = params.costWeight;
  let memoryWeightBase = params.memoryWeightBase;
  let ensembleEnabled = params.ensembleEnabled;
  let decomposeEnabled = params.decomposeEnabled;
  for (const rule of rules) {
    if (!policyRuleMatches(rule, ctx)) continue;
    if (rule.action.costWeightDelta !== undefined) costWeight += rule.action.costWeightDelta;
    if (rule.action.memoryWeightBaseDelta !== undefined) memoryWeightBase += rule.action.memoryWeightBaseDelta;
    if (rule.action.ensembleForce !== undefined) ensembleEnabled = rule.action.ensembleForce;
    if (rule.action.decomposeForce !== undefined) decomposeEnabled = rule.action.decomposeForce;
  }
  return {
    ...params,
    costWeight: clampGene(costWeight, POLICY_GENE_BOUNDS.costWeight),
    memoryWeightBase: clampGene(memoryWeightBase, POLICY_GENE_BOUNDS.memoryWeightBase),
    ensembleEnabled,
    decomposeEnabled,
    rules,
  };
}

/**
 * 参数规范化：越界值钳制到边界 + 缺失字段补基准值 + 规则清洗
 * （沙盒风险检查与部署热切换前的防御性归一，共用一份逻辑）
 */
export function normalizePolicyParams(params: Partial<SchedulerPolicyParams>): SchedulerPolicyParams {
  const merged = { ...BASELINE_POLICY_PARAMS, ...params };
  return {
    costWeight: clampGene(merged.costWeight, POLICY_GENE_BOUNDS.costWeight),
    memoryWeightBase: clampGene(merged.memoryWeightBase, POLICY_GENE_BOUNDS.memoryWeightBase),
    memoryWeightGrowth: clampGene(merged.memoryWeightGrowth, POLICY_GENE_BOUNDS.memoryWeightGrowth),
    memoryWeightCap: clampGene(merged.memoryWeightCap, POLICY_GENE_BOUNDS.memoryWeightCap),
    decomposeEnabled: Boolean(merged.decomposeEnabled),
    decomposeComplexityThreshold: clampGene(merged.decomposeComplexityThreshold, POLICY_GENE_BOUNDS.decomposeComplexityThreshold),
    decomposeMaxSubtasks: clampGene(merged.decomposeMaxSubtasks, POLICY_GENE_BOUNDS.decomposeMaxSubtasks),
    ensembleEnabled: Boolean(merged.ensembleEnabled),
    ensembleScoreGap: clampGene(merged.ensembleScoreGap, POLICY_GENE_BOUNDS.ensembleScoreGap),
    ensembleMaxModels: clampGene(merged.ensembleMaxModels, POLICY_GENE_BOUNDS.ensembleMaxModels),
    rules: sanitizeRules(merged.rules),
  };
}

/** 参数是否全部在边界内（不修改原值的风险检查；含规则数量与增量幅度） */
export function policyParamsWithinBounds(params: SchedulerPolicyParams): boolean {
  const keys = Object.keys(POLICY_GENE_BOUNDS) as ScalarGeneKey[];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'boolean') continue;
    const bounds = POLICY_GENE_BOUNDS[key];
    if (typeof value !== 'number' || Number.isNaN(value) || value < bounds.min || value > bounds.max) return false;
  }
  const rules = params.rules ?? [];
  if (rules.length > MAX_POLICY_RULES) return false;
  for (const rule of rules) {
    const deltas = [rule.action?.costWeightDelta, rule.action?.memoryWeightBaseDelta];
    for (const d of deltas) {
      if (d !== undefined && (d < POLICY_RULE_DELTA_BOUNDS.min || d > POLICY_RULE_DELTA_BOUNDS.max)) return false;
    }
  }
  return true;
}

// ─────────────────────────── 共享评分函数（沙盒保真的关键） ───────────────────────────

/** 单模型评分输入（由调用方从运行时状态或沙盒快照装配） */
export interface ModelScoreInput {
  /** 能力画像分（taskScores[taskType] ?? general ?? 0.5） */
  taskScore: number;
  /** 记忆画像成功率（无历史 0.5） */
  memoryScore: number;
  /** 该模型在该任务类型的历史调用量 */
  memoryCalls: number;
  /** 历史平均质量分（无历史 0.5） */
  avgQuality: number;
  /** 平均 token 消耗 */
  avgTokens: number;
}

/**
 * 策略化模型评分（操作环与沙盒共用）
 *
 * 公式（与 ModelScheduler 第二阶段实现同构，参数从策略注入）：
 *   memoryWeight = calls > 0 ? min(cap, base + calls × growth) : 0
 *   qualityScore = taskScore × (1-memoryWeight) + memoryScore × memoryWeight
 *   costEfficiency = clamp(avgQuality × (1 - min(1, avgTokens/10000)))
 *   score = qualityScore × (1-costWeight) + costEfficiency × costWeight
 *
 * 当 params = BASELINE_POLICY_PARAMS 时与原固定实现逐位一致。
 */
export function scoreModelWithPolicy(params: SchedulerPolicyParams, input: ModelScoreInput): number {
  const costWeight = Math.max(0, Math.min(1, params.costWeight));
  const memoryWeight =
    input.memoryCalls > 0
      ? Math.min(params.memoryWeightCap, params.memoryWeightBase + input.memoryCalls * params.memoryWeightGrowth)
      : 0;
  const qualityScore = input.taskScore * (1 - memoryWeight) + input.memoryScore * memoryWeight;

  let costEfficiency = 0.5;
  if (input.memoryCalls > 0 && input.avgTokens > 0) {
    costEfficiency = Math.max(0, Math.min(1, input.avgQuality * (1 - Math.min(1, input.avgTokens / 10_000))));
  }

  return qualityScore * (1 - costWeight) + costEfficiency * costWeight;
}

/** 构造基准策略对象（缺省当前策略） */
export function createBaselinePolicy(id = 'policy-baseline', version = 1): Policy {
  return {
    id,
    version,
    type: 'scheduler',
    params: { ...BASELINE_POLICY_PARAMS },
    origin: 'baseline',
    generation: 0,
    createdAt: Date.now(),
  };
}
