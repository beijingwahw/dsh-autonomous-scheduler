/**
 * policy-evolver.ts — 策略进化器（第三阶段质级升级：种群进化 + 金丝雀部署）
 *
 * 进化循环（变异/交叉 → 选择 → 保留）：
 * 1. 变异与交叉 generateCandidates：以当前策略与种群精英（Hall of Fame）为
 *    亲代，产出混合候选——高斯变异（自适应步长）、双亲交叉（标量均匀 + 
 *    规则子集合并）、规则基因变异（增/删/改）、边界内探索者
 * 2. 选择 evaluateCandidate + selectBest：每个候选经沙盒多种子统计评估
 *    （历史回放 + 对抗任务），产出收益/风险/回归/LCB 四段式报告；
 *    仅 deployable（gainLCB ≥ minGain 且零风险零回归）的候选可胜出
 * 3. 保留 deployPolicy：胜出变体热切换到操作环（onDeploy 回调落地到
 *    ModelScheduler / Optimizer，无需重启）；劣于当前策略的变体自然淘汰，
 *    但精英进种群存档（优秀基因不因单轮失利丢失）
 *
 * 质级升级点：
 * 1. 种群进化（1+λ + HoF）：从单亲盲变异升级为种群精英交叉——进化在
 *    「当前最优」与「历史优秀基因库」之间重组，跳出局部最优
 * 2. 自适应步长（1/5 法则）：近 10 轮部署成功率 > 20% 时放大变异强度
 *    （×1.25 探索），否则收缩（×0.85 收敛），无需人工调参
 * 3. 规则基因组变异：规则的增加/删除/修改三类变异 + 交叉合并，
 *    策略空间从标量微调扩展为可组合调度程序
 * 4. 金丝雀部署：新策略上线后进入观察窗，操作环真实结果回报
 *    （reportOperationalOutcome）；成功率/质量劣化超阈自动回滚前一策略，
 *    样本充足且无劣化则晋升正式——「沙盒通过」不再等于「永久上线」
 *
 * 可追溯性：每个策略携带 id / version / generation / parentId（交叉含
 * secondaryParentId）/ origin / fitness；评估报告、部署历史、种群、金丝雀
 * 状态全量持久化（JSON），支持任意时点审计进化链。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EvaluationReport, Policy, PolicyRule, ScalarGeneKey, SchedulerPolicyParams } from './policy-types.js';
import {
  MAX_POLICY_RULES,
  POLICY_GENE_BOUNDS,
  POLICY_RULE_DELTA_BOUNDS,
  createBaselinePolicy,
  normalizePolicyParams,
} from './policy-types.js';
import { wilsonLowerBound, wilsonUpperBound } from '../core/evidence.js';
import type { ISandbox, IPolicyEvolver } from '../contracts.js';

/** 标量基因视图（数值/布尔字段；规则基因单独处理） */
type GeneRecord = Record<string, number | boolean>;

const geneRecord = (params: SchedulerPolicyParams): GeneRecord => params as unknown as GeneRecord;

/** 全部标量基因键 */
const SCALAR_GENE_KEYS = Object.keys(POLICY_GENE_BOUNDS) as ScalarGeneKey[];

/** 种群多样性半径：基因距离小于此值的个体视为近重复（适应度共享近似） */
const POLICY_DIVERSITY_RADIUS = 0.06;

// ─────────────────────────── 配置与报告 ───────────────────────────

export interface PolicyEvolverConfig {
  /** 每轮进化的候选变体数（缺省 6） */
  candidateCount?: number;
  /** 每个数值基因的变异概率（缺省 0.6） */
  mutationRate?: number;
  /** 变异强度基准（相对基因取值范围的比例，缺省 0.25；实际 × sigmaScale 自适应） */
  mutationStrength?: number;
  /** 布尔基因的翻转概率（缺省 0.25） */
  booleanFlipRate?: number;
  /** 部署门禁：相对 baseline 的最小收益提升（缺省 0.02，作用于 gainLCB） */
  minGain?: number;
  /** 种群（Hall of Fame）容量（缺省 6） */
  populationSize?: number;
  /** 交叉候选占比（缺省 0.34；种群 ≥2 时生效） */
  crossoverRate?: number;
  /** 规则变异概率（每个候选独立触发，缺省 0.3） */
  ruleMutationRate?: number;
  /** 探索者候选占比——边界内随机个体注入多样性（缺省 0.17） */
  explorerRate?: number;
  /** 规则变异可引用的已知任务类型（缺省空 = 规则用复杂度/特征条件） */
  knownTaskTypes?: string[];
  /** 金丝雀：最少观察样本数（缺省 5） */
  canaryMinSamples?: number;
  /** 金丝雀：晋升正式所需样本数（缺省 15） */
  canaryPromoteSamples?: number;
  /** 金丝雀：成功率劣化容忍（缺省 0.1） */
  canarySuccessTolerance?: number;
  /** 金丝雀：质量劣化容忍（缺省 0.05） */
  canaryQualityTolerance?: number;
  /** 进化历史持久化路径（缺省不持久化） */
  persistPath?: string;
  /** 随机源（测试可注入确定性实现） */
  rng?: () => number;
  /** 策略部署回调（热切换落地：更新 ModelScheduler/Optimizer 等） */
  onDeploy?: (policy: Policy) => void;
  /** 金丝雀决策回调（自动回滚 / 晋升时通知操作环） */
  onCanaryDecision?: (decision: { action: 'rolled-back' | 'promoted'; policyId: string; reason: string }) => void;
  /** 进化周期完成回调（可观测性） */
  onCycle?: (report: EvolutionCycleReport) => void;
}

/** 单轮进化周期报告 */
export interface EvolutionCycleReport {
  /** 本轮进化代际 */
  generation: number;
  /** 父代策略 */
  parentPolicyId: string;
  /** 候选来源构成（mutation/crossover/rule-mutation/explorer） */
  candidateOrigins: Record<string, number>;
  /** 各候选评估摘要（含淘汰原因） */
  candidates: Array<{
    policyId: string;
    reward: number;
    gain: number;
    /** 收益置信下界（多种子统计门禁） */
    gainLCB?: number;
    deployable: boolean;
    risks: number;
    regressions: number;
  }>;
  /** 胜出并部署的策略 id（无合适候选为空） */
  deployedPolicyId?: string;
  /** 本轮结论（人类可读） */
  summary: string;
}

/** 金丝雀状态（部署后观察窗） */
export interface CanaryState {
  policyId: string;
  deployedAt: number;
  status: 'active' | 'promoted' | 'rolled-back';
  /** 沙盒期望基线（部署时快照） */
  expectedSuccessRate: number;
  expectedAvgQuality: number;
  /** 操作环真实回报累计 */
  samples: number;
  successes: number;
  qualitySum: number;
  /** 状态变更原因（回滚/晋升时填写） */
  reason?: string;
}

/** 进化器状态报告（运维可观测） */
export interface PolicyEvolverStatus {
  currentPolicy: Policy;
  /** 已部署策略链（按部署时间升序；含回滚标记） */
  deployedHistory: Array<{
    id: string;
    version: number;
    generation: number;
    origin: string;
    gain?: number;
    deployedAt: number;
    rolledBackAt?: number;
  }>;
  /** 种群精英（按适应度降序） */
  population: Array<{ id: string; origin: string; generation: number; fitnessScore?: number }>;
  /** 自适应变异步长系数（1 = 基准强度） */
  sigmaScale: number;
  /** 金丝雀观察窗（无活跃金丝雀为空） */
  canary?: CanaryState;
  /** 评估过的候选总数 */
  totalCandidatesEvaluated: number;
  /** 进化总轮数 */
  totalCycles: number;
  /** 最近一轮周期报告（无则为空） */
  lastCycle?: EvolutionCycleReport;
}

// ─────────────────────────── 策略进化器 ───────────────────────────

/**
 * 策略进化器（implements IPolicyEvolver）
 *
 * 被 index.ts 持有：autonomy-loop 进化段定期触发 runEvolutionCycle()，
 * 或外部经 evolve_policy Tool 手动触发；deployPolicy 经 onDeploy 回调
 * 热切换操作环（ModelScheduler.updatePolicy 等），金丝雀观察窗内由
 * reportOperationalOutcome 持续接收操作环真实结果。
 */
export class PolicyEvolver implements IPolicyEvolver {
  private config: Required<Omit<PolicyEvolverConfig, 'onDeploy' | 'onCanaryDecision' | 'onCycle' | 'persistPath' | 'rng' | 'knownTaskTypes'>> &
    Pick<PolicyEvolverConfig, 'onDeploy' | 'onCanaryDecision' | 'onCycle' | 'persistPath' | 'rng' | 'knownTaskTypes'>;
  private current: Policy;
  /** 部署回滚栈：金丝雀失败时恢复 */
  private previousPolicy?: Policy;
  private deployedHistory: Array<Policy & { gain?: number; rolledBackAt?: number }> = [];
  /** 种群精英存档（Hall of Fame，按 fitness.score 降序） */
  private population: Policy[] = [];
  private evaluatedReports = new Map<string, EvaluationReport>();
  private cycleReports: EvolutionCycleReport[] = [];
  private policyCounter = 0;
  private totalCandidatesEvaluated = 0;
  private totalCycles = 0;
  /** 自适应步长系数（1/5 法则驱动） */
  private sigmaScale = 1;
  /** 近 10 轮部署成败窗口（自适应步长依据） */
  private selectionWindow: boolean[] = [];
  /** 金丝雀观察窗（无活跃金丝雀为空） */
  private canary?: CanaryState;
  private rng: () => number;
  private evolving = false;

  constructor(config?: PolicyEvolverConfig, baseline?: Policy) {
    const { onDeploy, onCanaryDecision, onCycle, persistPath, rng, knownTaskTypes, ...rest } = config ?? {};
    this.config = {
      candidateCount: 6,
      mutationRate: 0.6,
      mutationStrength: 0.25,
      booleanFlipRate: 0.25,
      minGain: 0.02,
      populationSize: 6,
      crossoverRate: 0.34,
      ruleMutationRate: 0.3,
      explorerRate: 0.17,
      canaryMinSamples: 5,
      canaryPromoteSamples: 15,
      canarySuccessTolerance: 0.1,
      canaryQualityTolerance: 0.05,
      ...rest,
      onDeploy,
      onCanaryDecision,
      onCycle,
      persistPath,
      rng,
      knownTaskTypes,
    };
    this.rng = this.config.rng ?? Math.random;
    this.current = baseline ?? createBaselinePolicy();
    this.deployedHistory.push({ ...this.current, deployedAt: this.current.createdAt });
    this.loadPersisted();
    this.seedPopulation();
  }

  /** 当前生效策略（操作环据此调度） */
  getCurrentPolicy(): Policy {
    return { ...this.current, params: cloneParams(this.current.params) };
  }

  /** 进化器状态报告 */
  getStatus(): PolicyEvolverStatus {
    return {
      currentPolicy: this.getCurrentPolicy(),
      deployedHistory: this.deployedHistory.map((p) => ({
        id: p.id,
        version: p.version,
        generation: p.generation,
        origin: p.origin,
        gain: p.gain,
        deployedAt: p.deployedAt ?? p.createdAt,
        rolledBackAt: p.rolledBackAt,
      })),
      population: this.population.map((p) => ({ id: p.id, origin: p.origin, generation: p.generation, fitnessScore: p.fitness?.score })),
      sigmaScale: Number(this.sigmaScale.toFixed(3)),
      canary: this.canary ? { ...this.canary } : undefined,
      totalCandidatesEvaluated: this.totalCandidatesEvaluated,
      totalCycles: this.totalCycles,
      lastCycle: this.cycleReports[this.cycleReports.length - 1],
    };
  }

  /** 种群精英（只读快照） */
  getPopulation(): Policy[] {
    return this.population.map((p) => ({ ...p, params: cloneParams(p.params) }));
  }

  /** 策略评估历史（policyId → 最近一次评估报告） */
  getEvaluationHistory(): EvaluationReport[] {
    return [...this.evaluatedReports.values()].sort((a, b) => b.evaluatedAt - a.evaluatedAt);
  }

  /**
   * 运行时调参入口（第四阶段：元认知控制器调节进化机制本身）
   *
   * 仅接受数值类进化参数（mutationRate / minGain / candidateCount 等），
   * 回调与持久化路径不可经此变更；下一进化周期即按新参数运行。
   */
  updateConfig(patch: Partial<PolicyEvolverConfig>): void {
    const numericKeys = [
      'candidateCount',
      'mutationRate',
      'mutationStrength',
      'booleanFlipRate',
      'minGain',
      'populationSize',
      'crossoverRate',
      'ruleMutationRate',
      'explorerRate',
      'canaryMinSamples',
      'canaryPromoteSamples',
      'canarySuccessTolerance',
      'canaryQualityTolerance',
    ] as const;
    for (const key of numericKeys) {
      const value = patch[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const target = this.config as unknown as Record<string, number>;
        target[key] = key === 'populationSize' || key === 'candidateCount' || key === 'canaryMinSamples' || key === 'canaryPromoteSamples' ? Math.max(1, Math.round(value)) : value;
      }
    }
    if (Array.isArray(patch.knownTaskTypes)) this.config.knownTaskTypes = patch.knownTaskTypes;
  }

  /** 数值进化参数快照（元认知旋钮 read 端；只读） */
  getTunableParams(): Readonly<{
    candidateCount: number;
    mutationRate: number;
    mutationStrength: number;
    booleanFlipRate: number;
    minGain: number;
    populationSize: number;
    crossoverRate: number;
    ruleMutationRate: number;
    explorerRate: number;
    canaryMinSamples: number;
    canaryPromoteSamples: number;
    canarySuccessTolerance: number;
    canaryQualityTolerance: number;
  }> {
    return {
      candidateCount: this.config.candidateCount,
      mutationRate: this.config.mutationRate,
      mutationStrength: this.config.mutationStrength,
      booleanFlipRate: this.config.booleanFlipRate,
      minGain: this.config.minGain,
      populationSize: this.config.populationSize,
      crossoverRate: this.config.crossoverRate,
      ruleMutationRate: this.config.ruleMutationRate,
      explorerRate: this.config.explorerRate,
      canaryMinSamples: this.config.canaryMinSamples,
      canaryPromoteSamples: this.config.canaryPromoteSamples,
      canarySuccessTolerance: this.config.canarySuccessTolerance,
      canaryQualityTolerance: this.config.canaryQualityTolerance,
    };
  }

  // ─────────────────────────── IPolicyEvolver 实现 ───────────────────────────

  /**
   * 变异与交叉：产出混合候选（质级升级）
   *
   * 候选构成（candidateCount 个）：
   * - ⌈candidateCount × crossoverRate⌉ 个交叉候选（种群 ≥2 时；标量均匀交叉 +
   *   规则子集合并，双亲谱系可追溯）
   * - ⌊candidateCount × explorerRate⌋ 个探索者（边界内随机，注入多样性）
   * - 其余为当前策略/种群精英的高斯变异（sigmaScale 自适应）+ 规则变异
   */
  async generateCandidates(currentPolicy: Policy): Promise<Policy[]> {
    const total = Math.max(1, this.config.candidateCount);
    const crossoverCount =
      this.population.length >= 2 ? Math.ceil(total * this.config.crossoverRate) : 0;
    const explorerCount = Math.floor(total * this.config.explorerRate);
    const mutationCount = Math.max(1, total - crossoverCount - explorerCount);

    const candidates: Policy[] = [];
    for (let i = 0; i < crossoverCount; i += 1) {
      const child = this.crossoverRandom();
      if (child) candidates.push(child);
    }
    for (let i = 0; i < explorerCount; i += 1) {
      candidates.push(this.explorerPolicy(currentPolicy));
    }
    for (let i = 0; i < mutationCount; i += 1) {
      // 亲代交替取当前策略与种群精英（精英基因持续参与变异）
      const parent = i % 2 === 0 || this.population.length === 0 ? currentPolicy : this.population[Math.floor(this.rng() * this.population.length)]!;
      candidates.push(this.mutatePolicy(parent));
    }
    return candidates.slice(0, Math.max(total, candidates.length));
  }

  /** 选择（评估）：在沙盒中隔离评估候选（与当前策略对比，多种子统计） */
  async evaluateCandidate(policy: Policy, sandbox: ISandbox): Promise<EvaluationReport> {
    const report = await sandbox.evaluate(policy, this.current);
    this.evaluatedReports.set(policy.id, report);
    this.totalCandidatesEvaluated += 1;
    return report;
  }

  /**
   * 保留（择优）：deployable 且 gainLCB 最高且 ≥ minGain 的候选胜出
   *
   * 报告中 deployable 已含「零风险 + 零回归 + gainLCB ≥ 0」统计门禁，
   * 此处再叠加进化器级 minGain 阈值（双保险）；胜出者回填适应度并入种群。
   */
  async selectBest(candidates: Policy[], reports: EvaluationReport[]): Promise<Policy | null> {
    const reportByPolicy = new Map(reports.map((r) => [r.policyId, r]));
    let best: Policy | null = null;
    let bestScore = this.config.minGain;
    for (const candidate of candidates) {
      const report = reportByPolicy.get(candidate.id);
      if (!report || !report.deployable) continue;
      const score = report.gainLCB ?? report.gain;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best) {
      const report = reportByPolicy.get(best.id)!;
      best.fitness = {
        score: report.reward,
        successRate: report.metrics.successRate,
        avgQuality: report.metrics.avgQuality,
        avgLatencyMs: report.metrics.avgLatencyMs,
        totalTokens: report.metrics.totalTokens,
        evaluatedTasks: report.taskStats.replayed + report.taskStats.adversarial,
        evaluatedAt: report.evaluatedAt,
      };
    }
    // 种群更新：全部候选（含未胜出者）按适应度竞争入种群——优秀基因不丢失
    this.updatePopulation(candidates);
    return best;
  }

  /**
   * 部署：胜出策略热切换到操作环并进入金丝雀观察窗
   *
   * 经 onDeploy 回调落地（无需重启）；部署记录写入可追溯历史并持久化；
   * 金丝雀基线取沙盒评估期望，观察窗内 reportOperationalOutcome 持续校验。
   */
  async deployPolicy(policy: Policy): Promise<void> {
    const deployedAt = Date.now();
    const normalized: Policy = {
      ...policy,
      params: normalizePolicyParams(policy.params),
      deployedAt,
    };
    const report = this.evaluatedReports.get(policy.id);
    const previous = this.current;
    this.current = normalized;
    this.previousPolicy = { ...previous, params: cloneParams(previous.params) };
    this.deployedHistory.push({ ...normalized, gain: report?.gain });
    this.canary = {
      policyId: normalized.id,
      deployedAt,
      status: 'active',
      expectedSuccessRate: report?.metrics.successRate ?? 1,
      expectedAvgQuality: report?.metrics.avgQuality ?? 1,
      samples: 0,
      successes: 0,
      qualitySum: 0,
    };
    this.persist();
    try {
      this.config.onDeploy?.(normalized);
    } catch {
      // 部署回调失败回滚到前一策略（操作环一致性优先）
      this.current = previous;
      this.previousPolicy = undefined;
      this.deployedHistory.pop();
      this.canary = undefined;
      this.persist();
      throw new Error(`策略 ${policy.id} 部署回调失败，已回滚至 ${previous.id}`);
    }
  }

  // ─────────────────────────── 金丝雀（质级升级） ───────────────────────────

  /**
   * 操作环真实结果回报（金丝雀观察窗，4.0 Wilson 统计判定）
   *
   * 单侧噪声不回滚：仅当成功率 Wilson 上界（乐观边界）也跌破
   * 期望 − 容忍 时才统计确认劣化 → 回滚（如 7/10 = 0.7 的 UB ≈ 0.89
   * 高于底线 → 继续观察；0/5 的 UB ≈ 0.43 → 立即回滚）。
   * 晋升：样本达 canaryPromoteSamples 且未确认劣化、点估计不破底线，
   * 且 Wilson 下界（保守边界）亦不破底线 → 统计达标晋升；下界未达标
   * 则继续累积样本（宁可多观察，不冒进上线）。
   * @returns 金丝雀状态（无活跃金丝雀返回 undefined）
   */
  reportOperationalOutcome(outcome: { success: boolean; quality?: number }): CanaryState | undefined {
    if (!this.canary || this.canary.status !== 'active') return this.canary;
    this.canary.samples += 1;
    if (outcome.success) this.canary.successes += 1;
    if (typeof outcome.quality === 'number' && outcome.quality > 0) this.canary.qualitySum += outcome.quality;

    if (this.canary.samples >= this.config.canaryMinSamples) {
      const failures = this.canary.samples - this.canary.successes;
      const successRate = this.canary.successes / this.canary.samples;
      const successUB = wilsonUpperBound(this.canary.successes, failures);
      const successLB = wilsonLowerBound(this.canary.successes, failures);
      const successFloor = this.canary.expectedSuccessRate - this.config.canarySuccessTolerance;
      const avgQuality = this.canary.qualitySum / Math.max(1, this.canary.samples);
      const successDegrade = successUB < successFloor;
      const qualityDegrade =
        this.canary.qualitySum > 0 && this.canary.expectedAvgQuality - avgQuality > this.config.canaryQualityTolerance;
      if (successDegrade || qualityDegrade) {
        const reason = successDegrade
          ? `成功率 Wilson 上界 ${successUB.toFixed(3)}（点估计 ${successRate.toFixed(3)}，n=${this.canary.samples}）仍低于底线 ${successFloor.toFixed(3)}（期望 ${this.canary.expectedSuccessRate.toFixed(3)} − 容忍 ${this.config.canarySuccessTolerance}），统计确认劣化`
          : `质量 ${avgQuality.toFixed(3)} 低于沙盒期望 ${this.canary.expectedAvgQuality.toFixed(3)} 超过容忍 ${this.config.canaryQualityTolerance}`;
        return this.rollbackCanary(reason);
      }
      if (this.canary.samples >= this.config.canaryPromoteSamples) {
        if (successRate < successFloor || successLB < successFloor) {
          // 点估计或保守边界未达标：不冒进晋升，继续观察累积样本
          return { ...this.canary };
        }
        this.canary.status = 'promoted';
        this.canary.reason = `金丝雀观察 ${this.canary.samples} 个样本：成功率 ${successRate.toFixed(3)}（Wilson 区间 [${successLB.toFixed(3)}, ${successUB.toFixed(3)}]）达标底线 ${successFloor.toFixed(3)}，质量 ${avgQuality.toFixed(3)} 无劣化，晋升正式`;
        const decision = { action: 'promoted' as const, policyId: this.canary.policyId, reason: this.canary.reason };
        this.persist();
        this.config.onCanaryDecision?.(decision);
        return { ...this.canary };
      }
    }
    return { ...this.canary };
  }

  /** 金丝雀自动回滚：恢复前一策略并热切换（操作环安全兜底） */
  private rollbackCanary(reason: string): CanaryState {
    const canary = this.canary!;
    canary.status = 'rolled-back';
    canary.reason = reason;
    if (this.previousPolicy) {
      const rollbackTarget = this.previousPolicy;
      this.current = { ...rollbackTarget, params: cloneParams(rollbackTarget.params) };
      this.previousPolicy = undefined;
      const lastEntry = this.deployedHistory[this.deployedHistory.length - 1];
      if (lastEntry && lastEntry.id === canary.policyId) lastEntry.rolledBackAt = Date.now();
      this.persist();
      try {
        this.config.onDeploy?.(this.getCurrentPolicy());
      } catch {
        /* 回滚回调失败仅记录（前一策略本就是稳定态） */
      }
      this.config.onCanaryDecision?.({ action: 'rolled-back', policyId: canary.policyId, reason });
    }
    return { ...canary };
  }

  /** 运维手动回滚（金丝雀外强制恢复前一策略） */
  rollbackLastDeployment(): boolean {
    if (!this.previousPolicy) return false;
    return Boolean(this.rollbackCanary('运维手动回滚'));
  }

  // ─────────────────────────── 进化周期编排 ───────────────────────────

  /**
   * 运行一轮完整进化周期（变异/交叉 → 沙盒评估 → 择优 → 部署）
   *
   * 自主循环定期调用 / 外部 Tool 手动触发；进化中重复调用返回进行中报告。
   * 周期尾部按 1/5 法则自适应调整变异步长。沙盒全程离线，不阻塞操作环。
   */
  async runEvolutionCycle(sandbox: ISandbox): Promise<EvolutionCycleReport> {
    if (this.evolving) {
      return {
        generation: this.current.generation,
        parentPolicyId: this.current.id,
        candidateOrigins: {},
        candidates: [],
        summary: '跳过：已有进化周期进行中',
      };
    }
    this.evolving = true;
    try {
      const parent = this.getCurrentPolicy();
      const candidates = await this.generateCandidates(parent);
      const reports: EvaluationReport[] = [];
      for (const candidate of candidates) {
        reports.push(await this.evaluateCandidate(candidate, sandbox));
      }
      const best = await this.selectBest(candidates, reports);
      if (best) await this.deployPolicy(best);

      // 1/5 法则自适应步长：近 10 轮部署成功率驱动探索/收敛
      this.selectionWindow.push(Boolean(best));
      if (this.selectionWindow.length > 10) this.selectionWindow.shift();
      if (this.selectionWindow.length >= 5) {
        const successRate = this.selectionWindow.filter(Boolean).length / this.selectionWindow.length;
        this.sigmaScale = Math.max(0.25, Math.min(3, this.sigmaScale * (successRate > 0.2 ? 1.25 : 0.85)));
      }

      this.totalCycles += 1;
      const bestReport = best ? reports.find((r) => r.policyId === best.id) : undefined;
      const cycle: EvolutionCycleReport = {
        generation: parent.generation + 1,
        parentPolicyId: parent.id,
        candidateOrigins: candidates.reduce<Record<string, number>>((acc, c) => {
          const key = c.origin === 'mutation' && (c.params.rules?.length ?? 0) > 0 ? 'rule-mutation' : c.origin;
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
        candidates: candidates.map((c) => {
          const r = reports.find((x) => x.policyId === c.id);
          return {
            policyId: c.id,
            reward: r?.reward ?? 0,
            gain: r?.gain ?? 0,
            gainLCB: r?.gainLCB,
            deployable: r?.deployable ?? false,
            risks: r?.risks.length ?? 0,
            regressions: r?.regressions.length ?? 0,
          };
        }),
        deployedPolicyId: best?.id,
        summary: best
          ? `第 ${parent.generation + 1} 代：候选 ${candidates.length} 个（${Object.entries(
              candidates.reduce<Record<string, number>>((acc, c) => ((acc[c.origin] = (acc[c.origin] ?? 0) + 1), acc), {}),
            )
              .map(([k, v]) => `${k}×${v}`)
              .join(' + ')}），胜出 ${best.id}（gainLCB ${((bestReport?.gainLCB ?? bestReport?.gain ?? 0)).toFixed(3)}），已热切换进入金丝雀观察`
          : `第 ${parent.generation + 1} 代：候选 ${candidates.length} 个均未达部署门禁（minGain=${this.config.minGain}，LCB 统计），当前策略保持不变（σ×${this.sigmaScale.toFixed(2)}）`,
      };
      this.cycleReports.push(cycle);
      if (this.cycleReports.length > 50) this.cycleReports.shift();
      this.persist();
      this.config.onCycle?.(cycle);
      return cycle;
    } finally {
      this.evolving = false;
    }
  }

  // ─────────────────────────── 内部实现：遗传算子 ───────────────────────────

  /** 高斯变异：数值基因按概率扰动（×sigmaScale）+ 钳制边界；布尔基因按概率翻转；规则基因增/删/改 */
  private mutatePolicy(parent: Policy): Policy {
    const genes = { ...parent.params, rules: [...(parent.params.rules ?? [])] };
    const record = geneRecord(genes);
    for (const key of SCALAR_GENE_KEYS) {
      const value = record[key];
      if (typeof value === 'boolean') {
        if (this.rng() < this.config.booleanFlipRate) record[key] = !value;
        continue;
      }
      if (this.rng() > this.config.mutationRate) continue;
      const bounds = POLICY_GENE_BOUNDS[key];
      const range = bounds.max - bounds.min;
      // 近似高斯（两均匀分布叠加中心化），强度 × 自适应 sigmaScale
      const noise =
        (this.rng() + this.rng() - 1) * this.config.mutationStrength * this.sigmaScale * range;
      let mutated = Number(value) + noise;
      mutated = Math.max(bounds.min, Math.min(bounds.max, mutated));
      record[key] = bounds.integer ? Math.round(mutated) : Number(mutated.toFixed(4));
    }
    // 规则基因变异（增/删/改）
    if (this.rng() < this.config.ruleMutationRate) this.mutateRules(genes);
    return {
      id: `policy-${++this.policyCounter}`,
      version: parent.version + 1,
      type: 'scheduler',
      params: genes,
      origin: 'mutation',
      generation: parent.generation + 1,
      parentId: parent.id,
      createdAt: Date.now(),
    };
  }

  /** 规则变异：无规则→增加；有规则→随机改一条或删一条 */
  private mutateRules(genes: SchedulerPolicyParams): void {
    const rules = genes.rules ?? [];
    if (rules.length === 0) {
      genes.rules = [this.randomRule()];
      return;
    }
    const roll = this.rng();
    if (roll < 0.4 && rules.length < MAX_POLICY_RULES) {
      genes.rules = [...rules, this.randomRule()];
    } else if (roll < 0.7) {
      genes.rules = rules.slice(0, rules.length - 1); // 删除末位规则
    } else {
      // 修改随机一条的动作幅度
      const idx = Math.floor(this.rng() * rules.length);
      const rule = { ...rules[idx]!, action: { ...rules[idx]!.action } };
      if (rule.action.costWeightDelta !== undefined || rule.action.ensembleForce !== undefined) {
        rule.action.costWeightDelta = clampDelta(
          (rule.action.costWeightDelta ?? 0) + (this.rng() - 0.5) * 0.2,
        );
      } else {
        rule.action.memoryWeightBaseDelta = clampDelta(
          (rule.action.memoryWeightBaseDelta ?? 0) + (this.rng() - 0.5) * 0.2,
        );
      }
      genes.rules = rules.map((r, i) => (i === idx ? rule : r));
    }
  }

  /** 随机合成一条规则（复杂度/特征/任务类型条件 + 随机动作） */
  private randomRule(): PolicyRule {
    const min = Number((this.rng() * 0.8).toFixed(2));
    const taskTypes =
      this.config.knownTaskTypes && this.config.knownTaskTypes.length > 0 && this.rng() < 0.6
        ? [this.config.knownTaskTypes[Math.floor(this.rng() * this.config.knownTaskTypes.length)]!]
        : undefined;
    const roll = this.rng();
    return {
      id: `rule-${++this.policyCounter}-${Math.floor(this.rng() * 10_000)}`,
      when: {
        taskTypes,
        minComplexity: min,
        maxComplexity: Number(Math.min(1, min + 0.2 + this.rng() * 0.3).toFixed(2)),
      },
      action:
        roll < 0.4
          ? { costWeightDelta: clampDelta((this.rng() - 0.5) * 2 * POLICY_RULE_DELTA_BOUNDS.max) }
          : roll < 0.7
            ? { ensembleForce: this.rng() < 0.7 }
            : { decomposeForce: this.rng() < 0.5 },
      priority: Math.floor(this.rng() * 10),
    };
  }

  /** 种群内随机双亲交叉（种群 <2 返回 null） */
  private crossoverRandom(): Policy | null {
    if (this.population.length < 2) return null;
    const i = Math.floor(this.rng() * this.population.length);
    let j = Math.floor(this.rng() * this.population.length);
    if (j === i) j = (j + 1) % this.population.length;
    return this.crossoverPolicies(this.population[i]!, this.population[j]!);
  }

  /** 双亲交叉：标量基因逐位均匀选取 + 规则子集合并（双亲谱系可追溯） */
  private crossoverPolicies(a: Policy, b: Policy): Policy {
    const childParams = { ...a.params, rules: [...(a.params.rules ?? [])] };
    const childRecord = geneRecord(childParams);
    const aRecord = geneRecord(a.params);
    const bRecord = geneRecord(b.params);
    for (const key of SCALAR_GENE_KEYS) {
      childRecord[key] = this.rng() < 0.5 ? aRecord[key] : bRecord[key];
    }
    // 数值基因中点交叉（50% 概率）：在两亲之间取值，平滑探索
    for (const key of ['costWeight', 'memoryWeightBase', 'memoryWeightCap', 'ensembleScoreGap'] as const) {
      if (this.rng() < 0.5) {
        const va = Number(aRecord[key]);
        const vb = Number(bRecord[key]);
        childRecord[key] = Number(((va + vb) / 2).toFixed(4));
      }
    }
    // 规则合并：双亲规则去重合并后截断
    const mergedRules = [...(a.params.rules ?? []), ...(b.params.rules ?? [])];
    const seen = new Set<string>();
    childParams.rules = mergedRules.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).slice(0, MAX_POLICY_RULES);
    return {
      id: `policy-${++this.policyCounter}`,
      version: Math.max(a.version, b.version) + 1,
      type: 'scheduler',
      params: childParams,
      origin: 'crossover',
      generation: Math.max(a.generation, b.generation) + 1,
      parentId: a.id,
      secondaryParentId: b.id,
      createdAt: Date.now(),
    };
  }

  /** 探索者：全基因边界内随机（注入种群多样性，跳出局部最优；origin 专属标记，谱系不误导为变异） */
  private explorerPolicy(parent: Policy): Policy {
    const params = { ...parent.params, rules: [] as PolicyRule[] };
    const record = geneRecord(params);
    for (const key of SCALAR_GENE_KEYS) {
      const bounds = POLICY_GENE_BOUNDS[key];
      const value = bounds.min + this.rng() * (bounds.max - bounds.min);
      record[key] = bounds.integer ? Math.round(value) : Number(value.toFixed(4));
    }
    params.decomposeEnabled = this.rng() < 0.5;
    params.ensembleEnabled = this.rng() < 0.6;
    params.rules = this.rng() < 0.3 ? [this.randomRule()] : [];
    return {
      id: `policy-${++this.policyCounter}`,
      version: parent.version + 1,
      type: 'scheduler',
      params,
      origin: 'explorer',
      generation: parent.generation + 1,
      createdAt: Date.now(),
    };
  }

  // ─────────────────────────── 内部实现：种群 ───────────────────────────

  /** 启动时确保种群含当前策略 */
  private seedPopulation(): void {
    if (this.population.length === 0) {
      this.population = [this.getCurrentPolicy()];
    }
  }

  /**
   * 种群更新（4.0 多样性保持：拥挤去重选择）
   *
   * 候选按适应度竞争入种群，但与已入选个体基因距离 < DIVERSITY_RADIUS 的
   * 近重复个体被跳过（适应度共享的贪婪近似）——种群由「高适应度且彼此
   * 基因相异」的个体构成，避免单一基因型霸占种群导致交叉退化自交。
   * 池内相异个体不足容量时回填近重复（保持容量的降级策略）。
   */
  private updatePopulation(candidates: Policy[]): void {
    const pool = [...this.population];
    for (const candidate of candidates) {
      const report = this.evaluatedReports.get(candidate.id);
      if (!report) continue;
      const fitness = {
        score: report.reward,
        successRate: report.metrics.successRate,
        avgQuality: report.metrics.avgQuality,
        avgLatencyMs: report.metrics.avgLatencyMs,
        totalTokens: report.metrics.totalTokens,
        evaluatedTasks: report.taskStats.replayed + report.taskStats.adversarial,
        evaluatedAt: report.evaluatedAt,
      };
      pool.push({ ...candidate, fitness });
    }
    // 去重（同 id 保留最新）+ 按 fitness.score 降序
    const byId = new Map(pool.map((p) => [p.id, p]));
    const ranked = [...byId.values()].sort((a, b) => (b.fitness?.score ?? -1) - (a.fitness?.score ?? -1));
    const capacity = Math.max(2, this.config.populationSize);

    // 第一遍：适应度降序贪心入选，跳过与已入选个体基因过近的近重复
    const selected: Policy[] = [];
    for (const p of ranked) {
      if (selected.length >= capacity) break;
      if (!selected.some((s) => this.geneDistance(s.params, p.params) < POLICY_DIVERSITY_RADIUS)) selected.push(p);
    }
    // 第二遍：相异个体不足容量时回填（保持种群容量的降级策略）
    for (const p of ranked) {
      if (selected.length >= capacity) break;
      if (!selected.includes(p)) selected.push(p);
    }
    this.population = selected;
  }

  /**
   * 基因距离（0~1）：标量基因归一化绝对距离 + 布尔差异 + 规则集合
   * Jaccard 距离的等权平均——衡量两个策略在基因空间的相异度。
   */
  private geneDistance(a: SchedulerPolicyParams, b: SchedulerPolicyParams): number {
    let total = 0;
    let count = 0;
    for (const key of SCALAR_GENE_KEYS) {
      const bounds = POLICY_GENE_BOUNDS[key];
      const va = a[key];
      const vb = b[key];
      if (typeof va === 'boolean' || typeof vb === 'boolean') {
        total += va === vb ? 0 : 1;
      } else {
        const range = Math.max(1e-9, bounds.max - bounds.min);
        total += Math.min(1, Math.abs(Number(va) - Number(vb)) / range);
      }
      count += 1;
    }
    const ra = new Set((a.rules ?? []).map((r) => r.id));
    const rb = new Set((b.rules ?? []).map((r) => r.id));
    if (ra.size > 0 || rb.size > 0) {
      let inter = 0;
      for (const id of ra) if (rb.has(id)) inter += 1;
      const union = new Set([...ra, ...rb]).size;
      total += 1 - inter / union;
      count += 1;
    }
    return count === 0 ? 0 : total / count;
  }

  // ─────────────────────────── 持久化 ───────────────────────────

  /** 持久化进化状态（原子写；失败不阻断进化流程） */
  private persist(): void {
    const persistPath = this.config.persistPath;
    if (!persistPath) return;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const payload = {
        version: 2,
        currentPolicy: this.current,
        previousPolicy: this.previousPolicy,
        deployedHistory: this.deployedHistory.map((p) => ({ ...p, params: cloneParams(p.params) })),
        population: this.population.map((p) => ({ ...p, params: cloneParams(p.params) })),
        sigmaScale: this.sigmaScale,
        canary: this.canary,
        totalCandidatesEvaluated: this.totalCandidatesEvaluated,
        totalCycles: this.totalCycles,
        cycleReports: this.cycleReports.slice(-20),
        savedAt: Date.now(),
      };
      const tmp = `${persistPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmp, persistPath);
    } catch {
      /* 持久化失败静默（进化流程不受影响） */
    }
  }

  /** 启动时恢复上次部署策略与种群（无持久化文件或损坏时保持基准） */
  private loadPersisted(): void {
    const persistPath = this.config.persistPath;
    if (!persistPath || !fs.existsSync(persistPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(persistPath, 'utf-8')) as {
        currentPolicy: Policy;
        previousPolicy?: Policy;
        deployedHistory?: Policy[];
        population?: Policy[];
        sigmaScale?: number;
        canary?: CanaryState;
        totalCandidatesEvaluated?: number;
        totalCycles?: number;
      };
      if (parsed.currentPolicy?.params) {
        this.current = { ...parsed.currentPolicy, params: normalizePolicyParams(parsed.currentPolicy.params) };
        this.deployedHistory = parsed.deployedHistory ?? [this.current];
        this.population = (parsed.population ?? []).filter((p) => p?.params).map((p) => ({ ...p, params: normalizePolicyParams(p.params) }));
        this.previousPolicy = parsed.previousPolicy ? { ...parsed.previousPolicy, params: normalizePolicyParams(parsed.previousPolicy.params) } : undefined;
        this.sigmaScale = typeof parsed.sigmaScale === 'number' ? Math.max(0.25, Math.min(3, parsed.sigmaScale)) : 1;
        this.canary = parsed.canary?.status === 'active' ? parsed.canary : undefined;
        this.totalCandidatesEvaluated = parsed.totalCandidatesEvaluated ?? 0;
        this.totalCycles = parsed.totalCycles ?? 0;
        // 恢复后立即热切换到上次策略（无需重启即恢复进化成果）
        this.config.onDeploy?.(this.getCurrentPolicy());
      }
    } catch {
      /* 损坏文件忽略，保持基准策略 */
    }
  }
}

// ─────────────────────────── 工具函数 ───────────────────────────

function clampDelta(v: number): number {
  return Number(Math.max(POLICY_RULE_DELTA_BOUNDS.min, Math.min(POLICY_RULE_DELTA_BOUNDS.max, v)).toFixed(4));
}

function cloneParams(params: SchedulerPolicyParams): SchedulerPolicyParams {
  return { ...params, rules: (params.rules ?? []).map((r) => ({ ...r, when: { ...r.when }, action: { ...r.action } })) };
}
