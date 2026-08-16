/**
 * sandbox.ts — 安全沙盒（第三阶段质级升级：校准 + 多种子统计门禁）
 *
 * 职责：
 * - 历史任务回放：从长期记忆的任务模式中提取历史任务集，重放评估策略变体
 * - 对抗任务合成：生成极端复杂度/冷启动/特征密集/超长文本等压力任务，测鲁棒性
 * - 策略模拟执行：PolicySimulator 按策略参数（评分函数/分解规则/组合逻辑/规则基因组）
 *   在离线模型快照上模拟调度与产出（质量/延迟/成本），形成真实选择压力
 * - 评估报告：收益（reward/gain/gainLCB）+ 风险（risks）+ 回归（regressions）→ 部署门禁
 *
 * 质级升级点：
 * 1. 历史校准（calibration）：模型×任务维度的真实历史平均质量锚定模拟 baseFit，
 *    沙盒不再是纯合成世界——操作环真实结果持续校准模拟器，保真度随使用提升
 * 2. 规则基因组选择压力：simulate 内以完整任务上下文（类型/复杂度/特征）
 *    解析有效参数（resolveEffectiveParams），规则基因在沙盒中承受真实淘汰
 * 3. 多种子统计门禁：评估在 N 个噪声种子上重复，产出 gain 均值/标准差/
 *    置信下界（LCB）；deployable 要求 gainLCB ≥ 0，防止单种子过拟合的
 *    脆弱策略混入操作环
 *
 * 隔离性保证：
 * - 纯内存计算，不调用 LLM、不写记忆库、不接触操作环调度器
 * - 离线可运行（构造沙盒只需模型状态快照 + 任务集 + 校准表，均可注入）
 * - 质量噪声为「任务×模型×种子」哈希稳定噪声：与评估顺序/策略无关 → 候选与
 *   baseline 在同一评估内看到完全相同的噪声序列（公平对比），且确定可复现
 */

import type {
  EvaluationReport,
  Policy,
  PolicyEvaluationMetrics,
  SandboxTask,
  SchedulerPolicyParams,
  SimModelStatus,
} from './policy-types.js';
import { policyParamsWithinBounds, resolveEffectiveParams, scoreModelWithPolicy } from './policy-types.js';
import type { LongTermMemory } from '../memory/long-term-memory.js';
import type { ISandbox } from '../contracts.js';
import { BAYES_PRIOR_STRENGTH } from '../core/evidence.js';

// ─────────────────────────── 校准数据 ───────────────────────────

/**
 * 模型×任务校准条目：用操作环真实历史锚定沙盒模拟
 *
 * observedAvgQuality = 记忆库模型画像中该模型在该任务类型的历史平均质量分；
 * samples = 历史调用次数（≥ minCalibrationSamples 才启用锚定）。
 *
 * 3.0 并行旁路（贝叶斯化）：posteriorQuality / effectiveSamples / drift
 * 由 buildCalibrationFromMemory 从统一证据内核填充——手工/旧格式条目
 * 缺省时 calibratedFit 回退 legacy 口径（observedAvgQuality × samples），
 * 行为与升级前逐位一致。
 */
export interface SimCalibrationEntry {
  observedAvgQuality: number;
  samples: number;
  /** 3.0：贝叶斯后验质量（时间加权 EMA 质量向 0.5 先验收缩；小样本自动保守） */
  posteriorQuality?: number;
  /** 3.0：时间衰减后有效样本量（校准权重依据——旧证据自动让位） */
  effectiveSamples?: number;
  /** 3.0：近期能力漂移（加权成功率 − 裸成功率；沙盒感知模型修复/退化） */
  drift?: number;
}

/** 校准表：modelId → taskType → 条目 */
export type SimCalibration = Record<string, Record<string, SimCalibrationEntry>>;

/** 启用校准锚定所需的最小历史样本数 */
export const MIN_CALIBRATION_SAMPLES = 3;

/**
 * 从长期记忆构建校准表（index.ts 注入沙盒；进化周期之间可刷新）
 *
 * 3.0 贝叶斯化：在保留裸口径（observedAvgQuality/samples）的同时，
 * 从 getBayesianEstimate 附带时间加权证据视图——
 * - posteriorQuality = (n·emaQuality + 1·0.5) / (n+1)：近期敏感 + 小样本收缩
 * - effectiveSamples：30 天半衰期衰减后的等效观测数（校准权重依据）
 * - drift：能力漂移让沙盒感知「模型变了」（配合 calibratedFit 漂移倾斜）
 */
export function buildCalibrationFromMemory(memory: LongTermMemory): SimCalibration {
  const calibration: SimCalibration = {};
  for (const profile of memory.getAllModelProfiles()) {
    const perTask: Record<string, SimCalibrationEntry> = {};
    for (const [taskType, history] of Object.entries(profile.taskHistory)) {
      if (history.totalCalls >= MIN_CALIBRATION_SAMPLES && history.avgQualityScore > 0) {
        const entry: SimCalibrationEntry = { observedAvgQuality: history.avgQualityScore, samples: history.totalCalls };
        const est = memory.getBayesianEstimate(profile.id, taskType);
        if (est) {
          const n = Math.max(0, est.effectiveSamples);
          entry.posteriorQuality = Number(((n * est.emaQuality + BAYES_PRIOR_STRENGTH * 0.5) / (n + BAYES_PRIOR_STRENGTH)).toFixed(6));
          entry.effectiveSamples = Number(n.toFixed(6));
          entry.drift = est.drift;
        }
        perTask[taskType] = entry;
      }
    }
    if (Object.keys(perTask).length > 0) calibration[profile.id] = perTask;
  }
  return calibration;
}

// ─────────────────────────── 沙盒配置 ───────────────────────────

export interface SandboxConfig {
  /** 综合收益中成功率的权重（缺省 0.35） */
  successWeight?: number;
  /** 质量权重（缺省 0.35） */
  qualityWeight?: number;
  /** 成本权重（缺省 0.2；延迟权重 = 1 - 其余三项） */
  costWeight?: number;
  /** 成本归一化基准：单任务 token 数达到该值视为满成本（缺省 4000） */
  costNormTokens?: number;
  /** 延迟归一化基准：单任务延迟达到该值视为满延迟（缺省 5000ms） */
  latencyNormMs?: number;
  /** 模拟成功质量阈值（缺省 0.55） */
  successQualityThreshold?: number;
  /** 成功率的最大允许回归幅度（缺省 0.05） */
  regressionSuccessTolerance?: number;
  /** 质量的最大允许回归幅度（缺省 0.03） */
  regressionQualityTolerance?: number;
  /** token 成本的最大允许涨幅（相对 baseline，缺省 1.5 倍） */
  regressionCostTolerance?: number;
  /** 多种子评估的种子数（缺省 3；1 = 关闭统计门禁） */
  evaluationSeeds?: number;
  /** 历史校准表（缺省空 = 纯合成模拟） */
  calibration?: SimCalibration;
}

const DEFAULT_SANDBOX_CONFIG: Required<SandboxConfig> = {
  successWeight: 0.35,
  qualityWeight: 0.35,
  costWeight: 0.2,
  costNormTokens: 4_000,
  latencyNormMs: 5_000,
  successQualityThreshold: 0.55,
  regressionSuccessTolerance: 0.05,
  regressionQualityTolerance: 0.03,
  regressionCostTolerance: 1.5,
  evaluationSeeds: 3,
  calibration: {},
};

// ─────────────────────────── 模拟执行 ───────────────────────────

/** 单任务模拟结果 */
interface TaskSimulation {
  success: boolean;
  quality: number;
  latencyMs: number;
  tokens: number;
  decomposed: boolean;
  ensembleUsed: boolean;
  chosenModels: string[];
}

/**
 * 策略模拟执行器
 *
 * 给定策略参数 + 任务 + 模型快照，模拟「上下文规则解析 → 评分 → 分解决策 →
 * 选模型 → 组合决策 → 产出」：
 * - 有效参数：resolveEffectiveParams(params, task) —— 规则基因在此承受选择压力
 * - 产出质量 = 校准后能力适配 − 复杂度惩罚 + 稳定噪声（ensemble 取均值 + 多样性增益）
 * - 分解降低单节点复杂度（子复杂度 = c / n^0.7），但增加协调开销（延迟 +15%、token +10%）
 * - 评分调用与操作环共享 scoreModelWithPolicy → 沙盒保真
 */
export class PolicySimulator {
  private models: SimModelStatus[];
  private config: Required<SandboxConfig>;
  private modelIndex: Map<string, SimModelStatus>;

  constructor(models: SimModelStatus[], config?: SandboxConfig) {
    this.models = [...models];
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    this.modelIndex = new Map(this.models.map((m) => [m.id, m]));
  }

  /** 模型快照（只读） */
  getModels(): SimModelStatus[] {
    return [...this.models];
  }

  /**
   * 校准后的能力适配分：真实历史锚定合成画像
   *
   * 3.0 贝叶斯口径（条目携带证据字段时）：
   * - 权重 w = min(0.6, effectiveSamples/50)：时间衰减后的等效样本——
   *   旧证据自动让位，长期不用的模型不再被陈旧历史过度锚定
   * - 锚定值 = posteriorQuality：近期敏感 EMA + 小样本向先验收缩
   * - 漂移倾斜：|drift| 大的模型按近期能力变化微调（±0.05 钳制），
   *   「模型修好了 / 模型退化了」在沙盒中被真实感知
   *
   * 兼容：旧格式条目（无证据字段）走 legacy 口径，行为与升级前逐位一致。
   */
  private calibratedFit(modelId: string, taskType: string, syntheticFit: number): number {
    const entry = this.config.calibration[modelId]?.[taskType];
    if (!entry) return syntheticFit;
    const n = entry.effectiveSamples ?? entry.samples;
    const w = Math.min(0.6, n / 50);
    const anchor = entry.posteriorQuality ?? entry.observedAvgQuality;
    const blended = syntheticFit * (1 - w) + anchor * w;
    const driftTilt = Math.max(-0.05, Math.min(0.05, (entry.drift ?? 0) * 0.25));
    return Number((blended + driftTilt).toFixed(6));
  }

  /**
   * 稳定噪声（FNV-1a 哈希 → [-0.05, 0.05)）
   *
   * 同一「任务×模型×种子」组合恒定同一噪声：策略变体与 baseline 在同一任务上
   * 的随机扰动完全一致，评估差异纯粹来自策略本身（选择压力不失真）。
   */
  private stableNoise(seed: string, salt: number): number {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const frac = ((h >>> 0) % 10_000) / 10_000;
    return (frac - 0.5) * 0.1;
  }

  /** 按策略给全部候选模型评分（降序；使用上下文有效参数） */
  rankModels(params: SchedulerPolicyParams, task: SandboxTask): Array<{ id: string; score: number }> {
    const effective = resolveEffectiveParams(params, {
      taskType: task.taskType,
      complexity: task.complexity,
      features: task.features,
    });
    return this.models
      .map((m) => ({
        id: m.id,
        score: scoreModelWithPolicy(effective, {
          taskScore: m.taskScores[task.taskType] ?? m.taskScores['general'] ?? 0.5,
          // 沙盒无记忆画像历史（策略比较在同等条件下进行）→ 记忆项中性
          memoryScore: 0.5,
          memoryCalls: 0,
          avgQuality: 0.5,
          avgTokens: m.avgTokens,
        }),
      }))
      .sort((a, b) => b.score - a.score);
  }

  /** 模拟执行单个任务（seedSalt 区分多种子轮次） */
  simulate(params: SchedulerPolicyParams, task: SandboxTask, seedSalt = 0): TaskSimulation {
    const ranked = this.rankModels(params, task);
    if (ranked.length === 0) {
      throw new Error('沙盒内无可用模型');
    }
    const effective = resolveEffectiveParams(params, {
      taskType: task.taskType,
      complexity: task.complexity,
      features: task.features,
    });

    // ── 分解决策：复杂度超阈值 → 拆为 n 个子任务（规则可覆盖开关） ──
    const decomposed =
      effective.decomposeEnabled && task.complexity >= effective.decomposeComplexityThreshold;
    const subtaskCount = decomposed
      ? Math.max(
          1,
          Math.min(effective.decomposeMaxSubtasks, Math.ceil(task.complexity * effective.decomposeMaxSubtasks)),
        )
      : 1;
    // 分解降低单节点复杂度（次线性收益），但存在协调开销
    const subComplexity = task.complexity / Math.pow(subtaskCount, 0.7);

    // ── 组合决策：最高分与次高分差距 < gap 且模型数足够 → 集成（规则可覆盖开关） ──
    const ensembleUsed =
      effective.ensembleEnabled && ranked.length >= 2 && ranked[0]!.score - ranked[1]!.score < effective.ensembleScoreGap;
    const ensembleSize = ensembleUsed ? Math.min(effective.ensembleMaxModels, ranked.length) : 1;
    const chosen = ranked.slice(0, ensembleSize).map((r) => r.id);

    // ── 产出模拟 ──
    let qualitySum = 0;
    let latencyMax = 0;
    let tokensTotal = 0;
    for (const modelId of chosen) {
      const model = this.modelIndex.get(modelId);
      if (!model) throw new Error(`策略选中了沙盒外的模型: ${modelId}`);
      const syntheticFit = model.taskScores[task.taskType] ?? model.taskScores['general'] ?? 0.5;
      const baseFit = this.calibratedFit(modelId, task.taskType, syntheticFit);
      // 复杂度惩罚：模型能力越弱、任务越复杂，惩罚越大；噪声按「任务×模型×种子」指纹稳定派生
      const noise = this.stableNoise(`${task.taskType}|${task.complexity}|${task.length}|${modelId}`, seedSalt);
      const quality = Math.max(0, Math.min(1, baseFit - subComplexity * (1 - baseFit) * 0.5 + noise));
      qualitySum += quality;
      latencyMax = Math.max(latencyMax, model.avgLatencyMs * (1 + subComplexity));
      tokensTotal += model.avgTokens * (1 + subComplexity * 0.5) * (1 + task.length / 50_000);
    }

    let quality = qualitySum / ensembleSize;
    if (ensembleUsed) quality = Math.min(1, quality + 0.05); // 多样性融合增益

    const success = quality >= this.config.successQualityThreshold;
    const coordinationOverhead = decomposed ? 1.15 : 1;
    const latency = latencyMax * coordinationOverhead;
    const tokens = tokensTotal * subtaskCount * (decomposed ? 1.1 : 1);

    return { success, quality, latencyMs: latency, tokens: Math.round(tokens), decomposed, ensembleUsed, chosenModels: chosen };
  }
}

// ─────────────────────────── 对抗任务合成 ───────────────────────────

/**
 * 生成合成对抗任务（测鲁棒性）
 *
 * 四类压力模式：
 * 1. 极端复杂：高复杂度 + 多特征 + 超长文本（压测分解与集成决策、规则条件匹配）
 * 2. 冷启动：从未见过的任务类型（压测评分函数的缺省路径）
 * 3. 特征密集：特征标签爆炸（压测规则特征条件匹配）
 * 4. 极简任务：低复杂度短文本（压测过度调度/过度分解）
 */
export function generateAdversarialTasks(knownTaskTypes: string[] = [], rng: () => number = Math.random): SandboxTask[] {
  const types = knownTaskTypes.length > 0 ? knownTaskTypes : ['code-generation'];
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  return [
    {
      taskType: pick(types),
      complexity: 0.95 + rng() * 0.05,
      features: ['code', 'review', 'test', 'documentation'],
      length: 80_000,
      source: 'adversarial',
      label: '极端复杂任务',
    },
    {
      taskType: `unseen-${Math.floor(rng() * 1_000_000)}`,
      complexity: 0.5 + rng() * 0.3,
      features: [],
      length: 2_000,
      source: 'adversarial',
      label: '冷启动任务',
    },
    {
      taskType: pick(types),
      complexity: 0.7 + rng() * 0.2,
      features: ['code', 'review', 'test', 'analysis', 'translation', 'documentation'],
      length: 30_000,
      source: 'adversarial',
      label: '特征密集任务',
    },
    {
      taskType: pick(types),
      complexity: 0.05 + rng() * 0.1,
      features: [],
      length: 120,
      source: 'adversarial',
      label: '极简任务',
    },
  ];
}

// ─────────────────────────── 历史任务回放集 ───────────────────────────

/**
 * 从长期记忆提取历史任务集（回放评估的数据来源）
 *
 * 每个任务模式（含成功与失败记录）至少产出 1 个回放任务；
 * 模式指纹 `taskType::complexity::features` 解析回任务上下文。
 */
export function extractReplayTasks(memory: LongTermMemory): SandboxTask[] {
  const tasks: SandboxTask[] = [];
  for (const pattern of memory.getAllTaskPatterns()) {
    const [taskType, complexityRaw, featuresRaw] = pattern.fingerprint.split('::');
    if (!taskType) continue;
    const complexity = Number(complexityRaw ?? 0.5);
    const features = (featuresRaw ?? '').split(',').filter(Boolean);
    const records = Math.max(1, pattern.successfulPlans.length + pattern.failureRecords.length);
    // 每个成功/失败记录各产出 1 个回放任务（高频模式权重更高）
    for (let i = 0; i < records; i += 1) {
      tasks.push({
        taskType,
        complexity,
        features,
        length: Math.max(100, Math.round(complexity * 20_000)),
        source: 'replay',
        label: pattern.taskSummary,
      });
    }
  }
  return tasks;
}

// ─────────────────────────── 安全沙盒 ───────────────────────────

/** 多种子单轮聚合产物 */
interface SeedRun {
  metrics: PolicyEvaluationMetrics;
  reward: number;
}

/**
 * 安全沙盒（implements ISandbox）
 *
 * 被 PolicyEvolver 调用：evaluate(policy, baseline) 在隔离环境重放任务集，
 * 产出收益/风险/回归三段式评估报告（多种子统计门禁）。全程离线，不阻塞操作环调度。
 */
export class Sandbox implements ISandbox {
  private simulator: PolicySimulator;
  private tasks: SandboxTask[];
  private config: Required<SandboxConfig>;

  constructor(params: { models: SimModelStatus[]; tasks: SandboxTask[]; config?: SandboxConfig }) {
    this.simulator = new PolicySimulator(params.models, params.config);
    this.tasks = [...params.tasks];
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...params.config };
  }

  /** 当前任务集（可观测） */
  getTaskSet(): SandboxTask[] {
    return [...this.tasks];
  }

  /** 替换任务集（进化周期之间可刷新历史回放集） */
  setTaskSet(tasks: SandboxTask[]): void {
    this.tasks = [...tasks];
  }

  /** 刷新校准表（操作环真实结果持续锚定模拟器） */
  setCalibration(calibration: SimCalibration): void {
    this.config = { ...this.config, calibration };
    this.simulator = new PolicySimulator(this.simulator.getModels(), this.config);
  }

  /**
   * 运行时调参入口（第四阶段：元认知控制器调节验证严格度）
   *
   * 经此调整多种子统计门禁（evaluationSeeds：种子越多 LCB 越严格）、
   * 回归容忍（regression*）与 reward 权重；下次评估即生效。
   * calibration 字段不可经此变更（走 setCalibration）。
   */
  updateConfig(patch: SandboxConfig): void {
    const { calibration: _ignored, ...rest } = patch;
    void _ignored;
    this.config = { ...this.config, ...rest };
    this.simulator = new PolicySimulator(this.simulator.getModels(), this.config);
  }

  /** 当前评估配置快照（元认知旋钮 read 端；只读） */
  getConfig(): Readonly<SandboxConfig> {
    return { ...this.config, calibration: this.config.calibration };
  }

  /**
   * 评估策略（可选与 baseline 对比；多种子统计）
   *
   * 流程：参数边界风险检查 → 多种子全任务集模拟（逐种子聚合求均值）→
   * reward/gain 均值与标准差 → 置信下界 LCB → 回归检测 → 部署门禁
   * （gainLCB ≥ 0：97.5% 置信下界上收益仍非负，防单种子过拟合）
   */
  async evaluate(policy: Policy, baseline?: Policy): Promise<EvaluationReport> {
    const evaluatedAt = Date.now();
    const replayed = this.tasks.filter((t) => t.source === 'replay').length;
    const adversarial = this.tasks.filter((t) => t.source === 'adversarial').length;
    const seeds = Math.max(1, Math.floor(this.config.evaluationSeeds));

    // ── 风险检查 1：参数越界（含规则数量与增量幅度；防御，变异已钳制） ──
    const risks: string[] = [];
    if (!policyParamsWithinBounds(policy.params)) {
      risks.push('策略参数越界（超出 POLICY_GENE_BOUNDS）');
    }

    // ── 多种子模拟：候选与 baseline 在相同种子序列上评估（公平对比） ──
    const policyRuns = this.runAllSeeds(policy.params, seeds, risks);
    const metrics = averageMetrics(policyRuns.map((r) => r.metrics));
    const reward = policyRuns.reduce((s, r) => s + r.reward, 0) / policyRuns.length;

    // ── baseline 对比（gain 均值 + 跨种子标准差 + LCB + 回归检测） ──
    let baselineMetrics: PolicyEvaluationMetrics | undefined;
    let baselineReward: number | undefined;
    let gainStdDev = 0;
    let gainLCB: number | undefined;
    const regressions: string[] = [];
    if (baseline) {
      const baselineRisks: string[] = [];
      const baselineRuns = this.runAllSeeds(baseline.params, seeds, baselineRisks);
      baselineMetrics = averageMetrics(baselineRuns.map((r) => r.metrics));
      baselineReward = baselineRuns.reduce((s, r) => s + r.reward, 0) / baselineRuns.length;

      // 逐种子配对差值 → 均值与标准差（配对消除种子间公共方差）
      const gains = policyRuns.map((r, i) => r.reward - (baselineRuns[i]?.reward ?? r.reward));
      const meanGain = gains.reduce((s, g) => s + g, 0) / gains.length;
      gainStdDev =
        gains.length > 1
          ? Math.sqrt(gains.reduce((s, g) => s + (g - meanGain) ** 2, 0) / (gains.length - 1))
          : 0;
      gainLCB = meanGain - (1.96 * gainStdDev) / Math.sqrt(gains.length);

      if (metrics.successRate < baselineMetrics.successRate - this.config.regressionSuccessTolerance) {
        regressions.push(`成功率回归：${baselineMetrics.successRate.toFixed(3)} → ${metrics.successRate.toFixed(3)}`);
      }
      if (metrics.avgQuality < baselineMetrics.avgQuality - this.config.regressionQualityTolerance) {
        regressions.push(`质量回归：${baselineMetrics.avgQuality.toFixed(3)} → ${metrics.avgQuality.toFixed(3)}`);
      }
      if (baselineMetrics.totalTokens > 0 && metrics.totalTokens > baselineMetrics.totalTokens * this.config.regressionCostTolerance) {
        regressions.push(
          `成本回归：token ${baselineMetrics.totalTokens} → ${metrics.totalTokens}（超出 ${(this.config.regressionCostTolerance - 1) * 100}%）`,
        );
      }
    }

    const gain = baselineReward !== undefined ? reward - baselineReward : 0;
    // 部署门禁：零风险 + 零回归 + 收益置信下界非负（多种子 LCB；无 baseline 时交由进化器决定）
    const deployable =
      risks.length === 0 &&
      regressions.length === 0 &&
      baselineReward !== undefined &&
      (gainLCB ?? gain) >= 0 &&
      this.tasks.length > 0;

    return {
      policyId: policy.id,
      baselinePolicyId: baseline?.id,
      metrics,
      baselineMetrics,
      reward,
      baselineReward,
      gain,
      gainStdDev: seeds > 1 ? gainStdDev : undefined,
      gainLCB: seeds > 1 ? gainLCB : undefined,
      seeds,
      risks,
      regressions,
      deployable,
      taskStats: { replayed, adversarial },
      evaluatedAt,
    };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 在全部种子上模拟执行（每种子完整跑一遍任务集） */
  private runAllSeeds(params: SchedulerPolicyParams, seeds: number, risks: string[]): SeedRun[] {
    const runs: SeedRun[] = [];
    for (let salt = 0; salt < seeds; salt += 1) {
      const metrics = this.simulateAll(params, salt, risks);
      runs.push({ metrics, reward: this.computeReward(metrics) });
    }
    return runs;
  }

  /** 单种子模拟执行全任务集并聚合指标（单个任务异常记为风险 + 失败样本） */
  private simulateAll(params: SchedulerPolicyParams, seedSalt: number, risks: string[]): PolicyEvaluationMetrics {
    let successCount = 0;
    let qualitySum = 0;
    let latencySum = 0;
    let tokensTotal = 0;
    let decomposeCount = 0;
    let ensembleCount = 0;
    let evaluated = 0;

    for (const task of this.tasks) {
      try {
        const sim = this.simulator.simulate(params, task, seedSalt);
        evaluated += 1;
        if (sim.success) successCount += 1;
        qualitySum += sim.quality;
        latencySum += sim.latencyMs;
        tokensTotal += sim.tokens;
        if (sim.decomposed) decomposeCount += 1;
        if (sim.ensembleUsed) ensembleCount += 1;
      } catch (err) {
        risks.push(`任务 ${task.taskType}(${task.label ?? ''}) 模拟异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const total = Math.max(evaluated, 1);
    return {
      successRate: successCount / total,
      avgQuality: qualitySum / total,
      avgLatencyMs: latencySum / total,
      totalTokens: Math.round(tokensTotal),
      decompositionRate: decomposeCount / total,
      ensembleRate: ensembleCount / total,
    };
  }

  /** 综合收益：成功率 + 质量 + 成本效率 + 延迟效率 加权（归一化到 0~1） */
  private computeReward(metrics: PolicyEvaluationMetrics): number {
    const perTaskTokens = metrics.totalTokens / Math.max(1, this.tasks.length);
    const costEfficiency = 1 - Math.min(1, perTaskTokens / this.config.costNormTokens);
    const latencyEfficiency = 1 - Math.min(1, metrics.avgLatencyMs / this.config.latencyNormMs);
    const { successWeight, qualityWeight, costWeight } = this.config;
    const latencyWeight = Math.max(0, 1 - successWeight - qualityWeight - costWeight);
    return successWeight * metrics.successRate + qualityWeight * metrics.avgQuality + costWeight * costEfficiency + latencyWeight * latencyEfficiency;
  }
}

/** 多种子指标平均（token 取均值以保持与单任务口径一致） */
function averageMetrics(list: PolicyEvaluationMetrics[]): PolicyEvaluationMetrics {
  if (list.length === 0) {
    return { successRate: 0, avgQuality: 0, avgLatencyMs: 0, totalTokens: 0, decompositionRate: 0, ensembleRate: 0 };
  }
  const avg = (pick: (m: PolicyEvaluationMetrics) => number) => list.reduce((s, m) => s + pick(m), 0) / list.length;
  return {
    successRate: avg((m) => m.successRate),
    avgQuality: avg((m) => m.avgQuality),
    avgLatencyMs: avg((m) => m.avgLatencyMs),
    totalTokens: Math.round(avg((m) => m.totalTokens)),
    decompositionRate: avg((m) => m.decompositionRate),
    ensembleRate: avg((m) => m.ensembleRate),
  };
}
