/**
 * scientist.ts — 科学家内核（项目 10.0「科学家心智」质变基座：最优实验设计）
 *
 * 升级前的根本局限（9.0 抽象心智的天花板）：
 * 系统的全部学习都是**被动的**——世界喂什么就统计什么。即使
 * suggestExperiments 也只是「不确定性 × 重要性」的启发式排序：
 * - 没有 Lindley 期望信息增益（EIG）——不知道一次实验**期望**
 *   能换来多少 nat 的知识；
 * - 不懂混杂的价值——观测关联与干预效应背离时，再多的观测
 *   **永远**无法裁决（ Simpson 悖论不可观测消除），只有干预能；
 * - 不选臂——do=1 与 do=0 哪个臂更值得做从未被计算；
 * - 不算账——实验有代价，值不值得做没有统一货币的仲裁；
 * - 无台账——承诺的信息增益 vs 实际换到的知识，设计本身从不校准。
 *
 * 本内核引入贝叶斯最优实验设计（Lindley 1956; Chaloner & Verdinelli）：
 *
 * 1. **真 EIG（nat 口径）**：臂后验 Beta(1+s, 1+f)（与因果内核同一
 *    数学）的一步期望熵收缩：
 *      EIG(arm) = H(α,β) − [p·H(α+1,β) + (1−p)·H(α,β+1)]
 *    与自由能认知价值同公式同量纲——知识有了公价。
 *
 * 2. **混杂加成（实验独有的价值）**：|观测关联 − 干预效应| 背离
 *    且双侧证据都在时，该边的因果问题**只能由干预裁决**：
 *      bonus = −ln(1 − confounding)（nat，封顶配置值）
 *    观测再多也买不到这 1 nat——这是实验相对被动学习的本质优势。
 *
 * 3. **最优臂选择**：对两臂各算 EIG，取大者——哪边证据薄就补哪边
 *    （方差大的臂一步收缩更多），而不是拍脑袋跟随效应符号。
 *
 * 4. **预算仲裁（统一货币）**：netValue = EIG − costNat。信息
 *    增益低于代价的问题不设计——好奇心第一次有了会计。
 *
 * 5. **信息台账（设计自身的校准）**：每个实验登记承诺 EIG 与
 *    实际换到的熵收缩（可测：H0 − H(实际结局后验)）；校准 EMA
 *    度量「设计者的诚实」——承诺兑现率是科学方法论的内生 KPI。
 *
 * 6. **知识前沿（组合自动再平衡）**：实验结算后臂后验收紧、
 *    EIG 递减（收益递减），前沿自动转向新的最未知处；残差熵
 *    总量单调下降 = 知识版图的可审计收缩。
 *
 * 与 6-9.0 的关系：6.0 定价行动、7.0 定价计划、8.0 定价思考、
 * 9.0 让知识跨域流动，本内核定价**知识获取本身**。
 * 科学家心智 = 抽象心智 × 主动求知的经济学。
 */

import type { CausalKernel } from './causal-kernel.js';
import { betaEntropy, FreeEnergyEngine } from './free-energy.js';
import type { TheoristEngine } from './theorist.js';

// ─────────────────────────── 数据结构 ───────────────────────────

/** 已登记的因果问题（实验设计的问题空间） */
export interface CausalQuestion {
  from: string;
  to: string;
  /** 登记理由（审计：为什么这个因果问题值得回答） */
  why: string;
  /** 单次实验代价（nat；与 EIG 同货币，缺省由引擎配置） */
  costNat?: number;
  createdAt: number;
}

/** 设计好的实验（可执行单元） */
export interface DesignedExperiment {
  /** 实验标识（结算回引用） */
  id: number;
  from: string;
  to: string;
  /** 最优臂（EIG 较大的干预方向） */
  arm: boolean;
  /** 该臂一步期望信息增益（nat，未含混杂加成） */
  armEig: number;
  /** 混杂加成（nat；该边因果分歧只能由干预裁决） */
  confoundingBonus: number;
  /** 总价值 = armEig + confoundingBonus + lawBonus（nat） */
  totalEig: number;
  /** 净价值 = totalEig − costNat（nat；>0 才值得做） */
  netValue: number;
  /** 11.0：定律试验加成（nat；作用域内一次实验同时检验压缩 K 条边的定律） */
  lawBonus: number;
  /** 臂后验（设计时口径；结算对账用） */
  priorAlpha: number;
  priorBeta: number;
  /** 预测臂成功率（后验均值） */
  predictedP: number;
  hypothesis: string;
  rationale: string;
}

/** 实验结算（信息台账单元） */
export interface ExperimentLedgerEntry {
  experimentId: number;
  from: string;
  to: string;
  arm: boolean;
  observedY: boolean;
  /** 承诺的 EIG（nat，设计时口径） */
  promisedEig: number;
  /** 实际换到的熵收缩（nat，可测：H0 − H(结局后验)） */
  realizedInfo: number;
  /** 结局惊奇（nat，−ln P(实际结局)） */
  surprisal: number;
  settledAt: number;
}

/** 知识前沿（meta-cognition 第五层 KPI） */
export interface KnowledgeFrontier {
  /** 已登记因果问题数 */
  questions: number;
  /** 存在混杂分歧的问题数（只能干预裁决） */
  confoundedQuestions: number;
  /** 所有问题两臂残差熵总和（nat；知识版图的总未知量） */
  residualEntropyNat: number;
  /** 已执行实验数 */
  experimentsRun: number;
  /** 累计设计 EIG（nat，承诺） */
  cumulativePromisedNat: number;
  /** 累计实现信息增益（nat，实测） */
  cumulativeRealizedNat: number;
  /** 设计兑现率 = realized / promised（0~1+） */
  deliveryRate: number;
  /** 设计校准 EMA（|承诺−实现|：设计者诚实度，越低越准） */
  designCalibration: number;
  interpretation: string;
}

// ─────────────────────────── 配置 ───────────────────────────

export interface ScientistConfig {
  /** 缺省单次实验代价（nat；EIG 低于此值的问题不值得做，缺省 0.05） */
  defaultCostNat: number;
  /** 混杂加成上限（nat；缺省 1.0 ≈ 一次二分问题的价值） */
  maxConfoundingBonus: number;
  /** 11.0：定律试验加成上限（nat；缺省 1.0——单实验不因定律加成无限膨胀） */
  lawBonusCap: number;
  /** 实验开始的最小臂证据门槛（样本少于该值才算前沿，缺省 0） */
  minArmSamples: number;
  /** 设计校准 EMA 平滑（缺省 0.3） */
  calibrationAlpha: number;
}

export const DEFAULT_SCIENTIST_CONFIG: ScientistConfig = {
  defaultCostNat: 0.05,
  maxConfoundingBonus: 1.0,
  lawBonusCap: 1.0,
  minArmSamples: 0,
  calibrationAlpha: 0.3,
};

// ─────────────────────────── 内核实现 ───────────────────────────

/**
 * 科学家内核：EIG 实验设计 + 混杂侦测加成 + 最优臂选择 + 预算仲裁
 * + 信息台账 + 知识前沿。
 *
 * 数据流：
 *   registerQuestion（问题空间）→ designExperiments（最优设计）
 *   → 宿主执行 do-干预 → settleExperiment（图更新 + 惊奇回流 + 台账）
 *   → knowledgeFrontier（知识版图收缩可审计）
 */
export class ScientistMind {
  private config: ScientistConfig;
  private kernel: CausalKernel;
  private freeEnergy?: FreeEnergyEngine;
  /** 11.0：理论内核（挂载后作用域内的问题获得定律试验加成） */
  private theorist?: TheoristEngine;
  private questions = new Map<string, CausalQuestion>();
  private ledger: ExperimentLedgerEntry[] = [];
  private experimentCounter = 0;
  private cumulativePromised = 0;
  private cumulativeRealized = 0;
  private calibrationEma: number | undefined;

  constructor(kernel: CausalKernel, freeEnergy?: FreeEnergyEngine, config?: Partial<ScientistConfig>) {
    this.kernel = kernel;
    this.freeEnergy = freeEnergy;
    this.config = { ...DEFAULT_SCIENTIST_CONFIG, ...config };
  }

  /** 挂载自由能引擎（实验结局的惊奇回流；幂等） */
  attachFreeEnergyEngine(engine: FreeEnergyEngine): void {
    this.freeEnergy = engine;
  }

  /** 11.0：挂载理论内核（定律试验加成；幂等） */
  attachTheorist(theorist: TheoristEngine): void {
    this.theorist = theorist;
  }

  // ─────────────────────────── 问题空间 ───────────────────────────

  /**
   * 登记因果问题：一条值得回答的「X 是否导致 Y」。
   * 问题空间由宿主/好奇心/调度器声明——科学家只对已声明的问题设计实验。
   */
  registerQuestion(from: string, to: string, why = '声明待补', costNat?: number): CausalQuestion {
    const key = qKey(from, to);
    const existing = this.questions.get(key);
    if (existing) {
      if (costNat !== undefined) existing.costNat = costNat;
      return existing;
    }
    const q: CausalQuestion = { from, to, why, costNat, createdAt: Date.now() };
    this.questions.set(key, q);
    return q;
  }

  /** 注销问题（问题被回答或不再关心） */
  unregisterQuestion(from: string, to: string): boolean {
    return this.questions.delete(qKey(from, to));
  }

  /** 问题空间只读视图 */
  allQuestions(): CausalQuestion[] {
    return [...this.questions.values()];
  }

  // ─────────────────────────── 实验设计 ───────────────────────────

  /**
   * 最优实验设计：对问题空间逐一计算 EIG，按净价值排序。
   *
   * 每个问题的评估：
   *   1. 两臂 Beta(1+s, 1+f) 重构（与因果内核 effect() 同数学）
   *   2. 各臂 EIG = 一步期望熵收缩；取大者为最优臂
   *   3. 混杂加成 = −ln(1 − confounding)（背离只能干预裁决）
   *   4. netValue = totalEig − costNat；≤0 不设计（预算仲裁）
   *
   * @param maxCount 最多返回的设计数（组合预算）
   */
  designExperiments(maxCount = 3, now = Date.now()): DesignedExperiment[] {
    const designs: DesignedExperiment[] = [];
    for (const q of this.questions.values()) {
      const eff = this.kernel.effect(q.from, q.to, now);
      const ev = this.kernel.armEvidence(q.from, q.to, now);
      if (!ev) continue;

      // 两臂 Beta 后验重构（干预优先口径；无干预样本时 Beta(1,1) 全无知）
      const arms = [
        { arm: true, s: ev.doXSuccess, f: ev.doXFailure },
        { arm: false, s: ev.doNotXSuccess, f: ev.doNotXFailure },
      ];
      const evals = arms.map((a) => eigOfBeta(1 + a.s, 1 + a.f));
      // 最优臂：EIG 较大者（证据薄的臂一步收缩更多）
      const best = evals[0]!.eig >= evals[1]!.eig ? { ...evals[0]!, arm: true } : { ...evals[1]!, arm: false };
      const evidence = ev.doXSuccess + ev.doXFailure + ev.doNotXSuccess + ev.doNotXFailure;
      if (evidence < this.config.minArmSamples * 2) {
        // 前沿门槛未到（太新的问题先观察）
        continue;
      }

      // 混杂加成：|观测关联 − 干预效应| 的背离只能由干预裁决
      const divergence = eff.confounding;
      const bonus =
        divergence > 0 ? Math.min(this.config.maxConfoundingBonus, -Math.log(Math.max(1e-9, 1 - divergence))) : 0;

      // 11.0 定律试验加成：定律作用域内的一条边实验同时检验压缩了
      // K 条边的定律——一次实验重新校准的是整个作用域（按 ln(K+1)
      // 计费并封顶，防单实验价值无限膨胀）
      const law = this.theorist?.coveringTheory(q.from, q.to, now);
      const lawBonus = law
        ? Math.min(this.config.lawBonusCap, Math.log(law.members.length + 1))
        : 0;

      const costNat = q.costNat ?? this.config.defaultCostNat;
      const totalEig = best.eig + bonus + lawBonus;
      const netValue = totalEig - costNat;
      if (netValue <= 0) continue; // 预算仲裁：知识不抵代价，不设计

      designs.push({
        id: 0, // 批量赋号
        from: q.from,
        to: q.to,
        arm: best.arm,
        armEig: round(best.eig),
        confoundingBonus: round(bonus),
        lawBonus: round(lawBonus),
        totalEig: round(totalEig),
        netValue: round(netValue),
        priorAlpha: best.alpha,
        priorBeta: best.beta,
        predictedP: round(best.p),
        hypothesis: `假设：do(${q.from}=${best.arm ? '启用' : '停用'}) 对 ${q.to} 的效应将落在当前后验 ${best.p.toFixed(2)} 附近（混杂分歧 ${divergence.toFixed(2)}${divergence > 0 ? '，唯有干预可裁决' : ''}）`,
        rationale:
          divergence > 0
            ? `混杂加成 +${round(bonus)} nat：观测关联 ${eff.observationalAssociation.toFixed(2)} vs 干预效应 ${eff.ate.toFixed(2)} 背离——该边因果问题只能由干预裁决`
            : lawBonus > 0
              ? `定律试验 +${round(lawBonus)} nat：该边在定律 ${law!.id}（${law!.members.length} 条边，P≈${law!.lawP.toFixed(2)}）作用域内——一次实验校准整个作用域`
              : `最优臂 do=${best.arm}：一步期望熵收缩 ${best.eig.toFixed(3)} nat（另一臂 ${(best.eig === evals[0]!.eig ? evals[1]!.eig : evals[0]!.eig).toFixed(3)} nat）`,
      });
    }
    // 净价值降序（混杂问题优先——它是观测永远买不到的知识）
    designs.sort((a, b) => b.netValue - a.netValue);
    // 编号在设计时即消耗（防两次设计未结算时撞号）
    return designs.slice(0, maxCount).map((d) => {
      this.experimentCounter += 1;
      return { ...d, id: this.experimentCounter };
    });
  }

  // ─────────────────────────── 执行与结算 ───────────────────────────

  /**
   * 结算实验：宿主已按设计执行 do-干预并观测到 Y。
   *
   * 三重回流 + 台账：
   * 1. 因果内核干预证据入库（黄金证据）
   * 2. 自由能惊奇回流（预测 vs 结局）
   * 3. 台账：承诺 EIG vs 实际熵收缩（设计校准）
   *
   * @returns 台账条目；设计不存在或重复结算返回 undefined
   */
  settleExperiment(design: DesignedExperiment, observedY: boolean, actor = 'scientist', now = Date.now()): ExperimentLedgerEntry | undefined {
    this.kernel.intervene(design.from, design.to, design.arm, observedY, actor, design.hypothesis, now);
    const predicted = clampProb(design.predictedP);
    const surprisal = -Math.log(observedY ? predicted : 1 - predicted);
    // 实际换到的信息：H(先验) − H(结局后验)（可测的知识增量）
    const h0 = betaEntropy(design.priorAlpha, design.priorBeta);
    const hAfter = betaEntropy(
      design.priorAlpha + (observedY ? 1 : 0),
      design.priorBeta + (observedY ? 0 : 1),
    );
    const realized = Math.max(0, h0 - hAfter);

    this.freeEnergy?.observeSurprisal(predicted, observedY);

    this.experimentCounter = Math.max(this.experimentCounter, design.id);
    this.cumulativePromised += design.totalEig;
    this.cumulativeRealized += realized;
    const gap = Math.abs(design.totalEig - realized);
    this.calibrationEma =
      this.calibrationEma === undefined
        ? gap
        : (1 - this.config.calibrationAlpha) * this.calibrationEma + this.config.calibrationAlpha * gap;

    const entry: ExperimentLedgerEntry = {
      experimentId: design.id,
      from: design.from,
      to: design.to,
      arm: design.arm,
      observedY,
      promisedEig: round(design.totalEig),
      realizedInfo: round(realized),
      surprisal: round(surprisal),
      settledAt: now,
    };
    this.ledger.push(entry);
    return entry;
  }

  // ─────────────────────────── 知识前沿 ───────────────────────────

  /** 知识前沿报告：知识版图的总未知量与设计的兑现率（第五层 KPI） */
  knowledgeFrontier(now = Date.now()): KnowledgeFrontier {
    let residual = 0;
    let confounded = 0;
    for (const q of this.questions.values()) {
      const eff = this.kernel.effect(q.from, q.to, now);
      const ev = this.kernel.armEvidence(q.from, q.to, now);
      if (!ev) continue;
      // 两臂残差熵（干预证据口径；无知臂 = 均匀熵 0 nat）
      residual += betaEntropy(1 + ev.doXSuccess, 1 + ev.doXFailure);
      residual += betaEntropy(1 + ev.doNotXSuccess, 1 + ev.doNotXFailure);
      if (eff.confounding > 0.2) confounded += 1;
    }
    const delivered = this.cumulativePromised > 0 ? this.cumulativeRealized / this.cumulativePromised : 0;
    const interpretation =
      this.questions.size === 0
        ? '问题空间为空：科学家待命（registerQuestion 声明因果问题）'
        : this.ledger.length === 0
          ? `${this.questions.size} 个因果问题待设计（前沿残差 ${residual.toFixed(2)} nat）`
          : confounded > 0
            ? `${confounded} 个混杂分歧待干预裁决（观测不可解）；已兑现 ${this.cumulativeRealized.toFixed(2)}/${this.cumulativePromised.toFixed(2)} nat`
            : `知识版图收缩中：残差 ${residual.toFixed(2)} nat，实验 ${this.ledger.length} 次，兑现率 ${(delivered * 100).toFixed(0)}%`;
    return {
      questions: this.questions.size,
      confoundedQuestions: confounded,
      residualEntropyNat: round(residual),
      experimentsRun: this.ledger.length,
      cumulativePromisedNat: round(this.cumulativePromised),
      cumulativeRealizedNat: round(this.cumulativeRealized),
      deliveryRate: round(delivered),
      designCalibration: round(this.calibrationEma ?? 0),
      interpretation,
    };
  }

  /** 台账只读视图（审计） */
  experimentLedger(): ExperimentLedgerEntry[] {
    return [...this.ledger];
  }
}

// ─────────────────────────── 工具 ───────────────────────────

function qKey(from: string, to: string): string {
  return `${from}→${to}`;
}

/** Beta(α,β) 臂的一步期望信息增益（nat）——与自由能认知价值同公式 */
function eigOfBeta(alpha: number, beta: number): { eig: number; alpha: number; beta: number; p: number } {
  const p = alpha / (alpha + beta);
  const h0 = betaEntropy(alpha, beta);
  const hYes = betaEntropy(alpha + 1, beta);
  const hNo = betaEntropy(alpha, beta + 1);
  return { eig: Math.max(0, h0 - (p * hYes + (1 - p) * hNo)), alpha, beta, p };
}

function clampProb(p: number): number {
  return Math.min(1 - 1e-6, Math.max(1e-6, p));
}

function round(x: number): number {
  return Number(x.toFixed(6));
}
