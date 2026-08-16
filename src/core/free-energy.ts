/**
 * free-energy.ts — 主动推断内核（项目 6.0「自由能最小化心智」质变基座）
 *
 * 升级前的根本分裂（全模块通病）：
 * 系统有四套独立的「好坏」判据——调度器用策略评分（利用端），
 * 探索用 UCB 加成（手设预算），好奇心用盲区扫描（接触频率），
 * 元认知用 KPI 逐项阈值（规则命中）。四套判据彼此不通约：
 * 什么时候该探索、探索多少、知识与收益如何换算——全是拍脑袋常数。
 *
 * 本内核引入 Karl Friston 自由能原理（Active Inference）：
 * 智能体唯一目标是 minimize expected free energy——
 *
 *   G(a) = E_q[−ln P(goal | do(a))]  （务实价值：期望惊奇，越低越好）
 *        − E[info gain(a)]           （认知价值：期望信息增益，越高越好）
 *
 * 一个公式同时统一了四大启发式：
 * 1. 利用（务实价值）：预测成功率越接近偏好，惊奇越低 → 替代策略评分
 * 2. 探索（认知价值）：不确定性高的动作信息增益大 → 替代 UCB 加成，
 *    且探索预算不再是常数——不确定性耗尽，认知价值自动归零
 * 3. 好奇心（认知价值）：实验设计 = argmax info gain → 与探索同源，
 *    「想知道」与「想得分」在同一量纲（nat）下权衡
 * 4. 精度控制：温度 γ = f(系统平均不确定性)——世界模型越不可信，
 *    策略越随机（多探索）；越可信越贪婪（多利用）——自适应探索温度
 *
 * 变分自由能（感知侧）：F = KL(q‖p)（信念分布 ‖ 生成模型预测）——
 * 信念市场价与因果后验的背离第一次有了信息论度量（nat），
 * 模型漂移 = 自由能上升 = 系统对世界的「预测握力」松动。
 *
 * 与因果内核的关系：causal-kernel 提供生成模型 P(Y|do(X))，
 * 本内核提供基于该模型的行动选择定理。因果阶梯（第二层）回答
 * 「干预会怎样」，主动推断回答「因此该干预什么」——两者合成
 * 完整的感知-决策-学习闭环。
 *
 * 审计性：EFE 分解（务实/认知）逐动作输出，每个选择都能回答
 * 「为什么选它」——多少因为有用，多少因为想弄清。可解释、可追溯。
 */

// ─────────────────────────── 数学基座 ───────────────────────────

/** Lanczos 逼近系数（g=7, n=9，双精度全域 |ε| < 1e-15） */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x)（Lanczos 逼近；x>0） */
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0]!;
  const t = x + 7.5;
  for (let i = 1; i < LANCZOS.length; i += 1) a += LANCZOS[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** ψ(x) = d/dx ln Γ(x)（递推 + 渐近级数；x>0） */
export function digamma(x: number): number {
  let r = 0;
  while (x < 6) {
    r -= 1 / x;
    x += 1;
  }
  const inv = 1 / x;
  const inv2 = inv * inv;
  r += Math.log(x) - 0.5 * inv - inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 / 252));
  return r;
}

/** Beta 分布微分熵（nat）：H = ln B(α,β) − (α−1)ψ(α) − (β−1)ψ(β) + (α+β−2)ψ(α+β) */
export function betaEntropy(alpha: number, beta: number): number {
  const lnB = lnGamma(alpha) + lnGamma(beta) - lnGamma(alpha + beta);
  return lnB - (alpha - 1) * digamma(alpha) - (beta - 1) * digamma(beta) + (alpha + beta - 2) * digamma(alpha + beta);
}

/** KL(q‖p)（伯努利分布，nat）；概率裁剪防 log(0) */
export function bernoulliKL(q: number, p: number): number {
  const qc = Math.min(1 - 1e-12, Math.max(1e-12, q));
  const pc = Math.min(1 - 1e-12, Math.max(1e-12, p));
  return qc * Math.log(qc / pc) + (1 - qc) * Math.log((1 - qc) / (1 - pc));
}

// ─────────────────────────── 数据结构 ───────────────────────────

/** 行动候选（生成模型视角下的一个可干预动作） */
export interface EFEAction {
  /** 动作标识（modelId / knob:x / 实验边 from） */
  id: string;
  /** P(Y=1|do(a))——因果内核处理臂后验（无证据回退 0.5） */
  pSuccess: number;
  /** 效应区间（不确定性来源） */
  lower: number;
  upper: number;
  /** 干预证据量（黄金证据，信息增益的主依据） */
  interventionalSamples: number;
  /** 观测证据量（银级证据，半价计入） */
  observationalSamples: number;
}

/** EFE 评估结论（逐动作可解释分解） */
export interface EFEEvaluation {
  actionId: string;
  /** 务实价值：E[−ln P(goal|do(a))]（nat，越低越好） */
  pragmatic: number;
  /** 认知价值：期望信息增益（nat，越高越好） */
  epistemic: number;
  /** G(a) = pragmatic − epistemicWeight×epistemic（越低越好） */
  efe: number;
  /** Beta 后验参数（信息增益计算依据，审计可查） */
  alpha: number;
  beta: number;
  /** Boltzmann 策略选择概率 */
  boltzmannProb: number;
  /** 该选择中「想知道」的占比（epistemic/(pragmatic+epistemic)） */
  curiosityShare: number;
  /** 若选它，预期把该边的不确定性收缩多少（nat→0 收敛度） */
  expectedUncertaintyReduction: number;
}

/** 变分自由能报告（感知侧漂移监测） */
export interface VariationalReport {
  /** Σ KL(q‖p)（nat，信念 vs 生成模型的总背离） */
  totalFreeEnergy: number;
  /** 逐信念明细 */
  perBelief: Array<{ id: string; beliefProb: number; modelProb: number; kl: number }>;
  /** 漂移判定（总自由能超阈值） */
  driftDetected: boolean;
  /** 最大背离源（漂移归因） */
  worst?: { id: string; kl: number };
}

// ─────────────────────────── 配置 ───────────────────────────

export interface FreeEnergyConfig {
  /** 认知价值权重（信息增益折算系数，缺省 1：1 nat 信息 = 1 nat 惊奇） */
  epistemicWeight: number;
  /** Boltzmann 温度下限（缺省 0.05：证据充分时接近贪婪） */
  minTemperature: number;
  /** 温度对不确定性的敏感度（缺省 0.3） */
  temperatureSensitivity: number;
  /** 漂移判定的总自由能阈值（nat，缺省 0.25） */
  driftThreshold: number;
  /** 概率裁剪 ε（防 log(0)） */
  probEpsilon: number;
}

export const DEFAULT_FREE_ENERGY_CONFIG: FreeEnergyConfig = {
  epistemicWeight: 1,
  minTemperature: 0.05,
  temperatureSensitivity: 0.3,
  driftThreshold: 0.25,
  probEpsilon: 1e-6,
};

// ─────────────────────────── 内核实现 ───────────────────────────

/**
 * 主动推断内核：期望自由能决策 + 变分漂移监测 + 精度控制。
 *
 * 消费方：
 * - model-scheduler：EFE 模式下行动选择 = argmin G(a)（探索/利用统一）
 * - symbiosis/runtime：行动提案按 EFE 排序（认知经济的注意力分配）
 * - meta-cognition：总自由能作为统一健康度（预测握力）
 * - curiosity-engine：实验目标 = argmax epistemic（与探索同源的定理化好奇心）
 * - world-model / 信念对账：KL 漂移监测（变分自由能）
 */
export class FreeEnergyEngine {
  private config: FreeEnergyConfig;
  /** 感知侧：最近观测惊奇（EMA，自由能代理） */
  private surprisalEma: number | undefined;
  private surprisalCount = 0;

  constructor(config?: Partial<FreeEnergyConfig>) {
    this.config = { ...DEFAULT_FREE_ENERGY_CONFIG, ...config };
  }

  /**
   * 单动作期望自由能分解。
   *
   * 务实价值（期望惊奇）：
   *   G_prag = −[ω·ln p̂ + (1−ω)·ln(1−p̂)]
   *   ω = 对成功的偏好强度（goal weight）；p̂ = P(Y=1|do(a))。
   *   p̂ 越贴近 ω 惊奇越低；p̂ 与 ω 同侧时交叉熵单调。
   *
   * 认知价值（期望信息增益，一步前瞻）：
   *   IG = H(Beta(α,β)) − [p̂·H(α+1,β) + (1−p̂)·H(α,β+1)]
   *   做这个动作（无论成败）后该边后验熵的期望收缩量。
   *   样本充足 → 微分熵收缩趋零 → 认知价值自动归零（探索自我终结）。
   */
  evaluateAction(action: EFEAction, preference: number, temperature = this.config.minTemperature): EFEEvaluation {
    const eps = this.config.probEpsilon;
    const p = Math.min(1 - eps, Math.max(eps, action.pSuccess));
    const omega = Math.min(1, Math.max(0, preference));

    // 务实价值：期望交叉熵（nat）
    const pragmatic = -(omega * Math.log(p) + (1 - omega) * Math.log(1 - p));

    // Beta 后验参数：干预证据全价 + 观测证据半价（与因果内核置信度同构）
    const strength = action.interventionalSamples + 0.5 * action.observationalSamples;
    const alpha = Math.max(1e-9, p * strength + 1);
    const beta = Math.max(1e-9, (1 - p) * strength + 1);

    // 认知价值：一步前瞻期望熵收缩
    const h0 = betaEntropy(alpha, beta);
    const hYes = betaEntropy(alpha + 1, beta);
    const hNo = betaEntropy(alpha, beta + 1);
    const epistemic = Math.max(0, h0 - (p * hYes + (1 - p) * hNo));

    const efe = pragmatic - this.config.epistemicWeight * epistemic;

    return {
      actionId: action.id,
      pragmatic: round(pragmatic),
      epistemic: round(epistemic),
      efe: round(efe),
      alpha: round(alpha),
      beta: round(beta),
      boltzmannProb: 0, // 由 evaluateActions 统一归一
      curiosityShare: round(pragmatic + epistemic > 1e-9 ? epistemic / (pragmatic + epistemic) : 0),
      expectedUncertaintyReduction: round(epistemic / Math.max(1e-9, h0)),
    };
  }

  /**
   * 全候选 EFE 评估 + Boltzmann 策略。
   *
   * P(a) ∝ exp(−G(a)/T)：温度由系统不确定性控制（precisionControl）。
   * 高不确定性 → 高温度 → 均匀探索；低不确定性 → 低温 → 贪婪利用。
   * 这是主动推断的规范策略形式：策略 = 对自由能的 softmax。
   */
  evaluateActions(
    actions: EFEAction[],
    preference: number,
    temperature?: number,
  ): EFEEvaluation[] {
    if (actions.length === 0) return [];
    const T = Math.max(this.config.minTemperature, temperature ?? this.minTemperatureFromActions(actions));
    const evals = actions.map((a) => this.evaluateAction(a, preference, T));
    // 数值稳定 softmax（减最大值）
    const minG = Math.min(...evals.map((e) => e.efe));
    const weights = evals.map((e) => Math.exp(-(e.efe - minG) / T));
    const sum = weights.reduce((a, b) => a + b, 0);
    evals.forEach((e, i) => {
      e.boltzmannProb = round(weights[i]! / sum);
    });
    return evals.sort((a, b) => a.efe - b.efe);
  }

  /**
   * Thompson 采样：θ_a ~ Beta(α_a, β_a)，选 argmax θ。
   *
   * EFE 最优的随机化实现（Bernoulli bandit 的规范探索策略）：
   * 后验越宽采样越散 → 自动探索；后验越尖采样越稳 → 自动利用。
   * 与 Boltzmann 的区别：不依赖温度标定，探索幅度由证据量内生决定。
   */
  thompsonSelect(actions: EFEAction[]): { winner: string; samples: Record<string, number> } {
    const samples: Record<string, number> = {};
    let winner = actions[0]?.id ?? '';
    let best = -Infinity;
    for (const a of actions) {
      const eps = this.config.probEpsilon;
      const p = Math.min(1 - eps, Math.max(eps, a.pSuccess));
      const strength = a.interventionalSamples + 0.5 * a.observationalSamples;
      const theta = sampleBeta(p * strength + 1, (1 - p) * strength + 1);
      samples[a.id] = round(theta);
      if (theta > best) {
        best = theta;
        winner = a.id;
      }
    }
    return { winner, samples };
  }

  /**
   * 精度控制：候选集平均不确定性 → 探索温度。
   *
   * T = minTemperature + sensitivity × avgWidth。
   * 世界的未知程度直接决定策略的随机程度——不确定时多试，
   * 胸有成竹时果断。探索率第一次由认识论内生推导，而非超参数。
   */
  minTemperatureFromActions(actions: EFEAction[]): number {
    if (actions.length === 0) return this.config.minTemperature;
    const avgWidth = actions.reduce((s, a) => s + Math.max(0, a.upper - a.lower), 0) / actions.length;
    return this.config.minTemperature + this.config.temperatureSensitivity * avgWidth;
  }

  /**
   * 感知：登记一次「预测-结果」惊奇（自由能的在线代理）。
   *
   * surprisal = −ln P(实际结果 | 预测概率)。EMA 平滑为系统级
   * 「预测握力」——元认知的总自由能 KPI 数据来源：
   * 预测越准惊奇越低；世界突变（漂移）时惊奇陡升。
   * @returns 本次的惊奇值（nat）
   */
  observeSurprisal(predictedProb: number, actualSuccess: boolean): number {
    const eps = this.config.probEpsilon;
    const p = Math.min(1 - eps, Math.max(eps, predictedProb));
    const surprisal = -Math.log(actualSuccess ? p : 1 - p);
    this.surprisalEma = this.surprisalEma === undefined ? surprisal : 0.9 * this.surprisalEma + 0.1 * surprisal;
    this.surprisalCount += 1;
    return surprisal;
  }

  /** 感知侧自由能（EMA 惊奇；无观测时 0） */
  currentSurprisal(): number {
    return this.surprisalEma ?? 0;
  }

  /**
   * 变分自由能：信念分布 vs 生成模型的 KL 总和（感知漂移监测）。
   *
   * 典型用法：信念市场隐含概率（q）vs 因果内核后验（p）。
   * F 上升 = 「市场以为的」与「模型知道的」裂开 = 模型漂移指纹——
   * 为既有 gap 判断提供信息论度量（nat）与归因（worst）。
   */
  variationalFreeEnergy(
    beliefs: Array<{ id: string; beliefProb: number }>,
    modelProbs: Record<string, number>,
  ): VariationalReport {
    const perBelief: VariationalReport['perBelief'] = [];
    let total = 0;
    for (const b of beliefs) {
      const p = modelProbs[b.id];
      if (!Number.isFinite(p)) continue;
      const kl = bernoulliKL(b.beliefProb, p);
      total += kl;
      perBelief.push({ id: b.id, beliefProb: round(b.beliefProb), modelProb: round(p), kl: round(kl) });
    }
    const worstEntry = [...perBelief].sort((a, b) => b.kl - a.kl)[0];
    return {
      totalFreeEnergy: round(total),
      perBelief: perBelief.sort((a, b) => b.kl - a.kl),
      driftDetected: total >= this.config.driftThreshold,
      worst: worstEntry ? { id: worstEntry.id, kl: worstEntry.kl } : undefined,
    };
  }
}

// ─────────────────────────── 采样基座 ───────────────────────────

/** Beta(α,β) 精确采样：Gamma 采样比（Marsaglia-Tsang） */
export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

/** Gamma(shape=k, scale=1) 采样（Marsaglia-Tsang，k>0） */
function sampleGamma(k: number): number {
  if (k < 1) return sampleGamma(k + 1) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      x = gaussian();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Box-Muller 标准正态 */
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(x: number): number {
  return Number(x.toFixed(6));
}
