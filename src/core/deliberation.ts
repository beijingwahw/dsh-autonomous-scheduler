/**
 * deliberation.ts — 深思内核（项目 7.0「深思心智」质变基座：规划即推断）
 *
 * 升级前的根本局限（6.0 自由能心智的天花板）：
 * EFE 是**一步前瞻**的 bandit——每个动作只问「做它之后世界会怎样」，
 * 从不问「做完它之后，我还能做什么」。系统因此是**短视的**：
 * 能选出当下最优的一步，看不见两步之后的死路，更不会为第 N 步
 * 的收获放弃第 1 步的诱惑。所有「规划」都退化为贪心序列。
 *
 * 本内核引入 Planning as Inference（Friston 层级生成模型 /
 * Dreamer 想象规划 / MuZero 树搜索的主动推断统一）：
 *
 * 1. **转移模型**（生成模型的时间维）：Beta 后验 P(Y=1 | state, action)
 *    + 后继状态分布——从真实执行中增量学习，无证据时诚实返回
 *    Beta(1,1)（完全无知），绝不伪装成知道。
 *
 * 2. **想象推演**（梦境）：imagine(start, [a1..an]) 在转移模型里把
 *    整条计划 rollout 一遍——不求世界一次给出答案，而是自己在
 *    脑内预演每一步的成败分布。轨迹级产出：
 *    - 折扣累计 G = Σ γ^t·G_t（深度期望自由能，与 6.0 单步 EFE 同量纲）
 *    - 全程成功概率 Π p_t 与首败风险分布（在第几步翻车、概率几何）
 *    - 逐步务实/认知价值分解（审计：哪一步是收益、哪一步是学费）
 *
 * 3. **想象证据坍缩**（认知价值的时间衰减）：同一条边在一条轨迹里
 *    被第 2 次想象时，认知价值严格下降——想象本身就消耗不确定性。
 *    「做一次实验就能学到的东西，不需要做梦一百遍。」
 *
 * 4. **前瞻搜索**（beam search × 技能宏）：beam 在轨迹空间按累计 G
 *    剪枝；技能库把验证过的行动序列作为**宏动作**（时间抽象）注入
 *    beam 种子——深思不必从原语动作重新发明轮子。
 *
 * 5. **技能库**（options / 时间抽象）：整体成功的计划蒸馏为技能
 *    （触发态 + 行动序列 + 价值 + 可靠性），复用强化、失手衰减、
 *    超额淘汰——「怎么做」的知识第一次有了与「是什么」(语义)、
 *    「有多好」(情景) 并列的程序形态。
 *
 * 6. **梦实现对账**（想象的可问责性）：计划执行后逐步对账
 *    「梦里的预测 vs 现实的结果」——每一步的惊奇与误差回流：
 *    转移模型（学习）、自由能引擎（感知惊奇）、校准 EMA
 *    （梦可靠性 KPI：系统对自己想象力的诚实度量）。
 *
 * 与 6.0 的关系：free-energy 提供单动作 EFE 定理，本内核把它沿
 * 时间维展开——从「选最好的一步」到「选最好的余生」。
 * 深思心智 = 自由能心智 × 时间。
 */

import { betaEntropy, FreeEnergyEngine } from './free-energy.js';
import type { AbstractionEngine } from './abstraction.js';

// ─────────────────────────── 数据结构 ───────────────────────────

/** 转移边后验（state × action → outcome，学习与想象的生成模型） */
export interface TransitionPosterior {
  state: string;
  action: string;
  /** Beta(α,β) 后验均值 = P(成功 | state, action) */
  pSuccess: number;
  alpha: number;
  beta: number;
  /** 真实证据量（成功 + 失败计数） */
  evidence: number;
  /** 90% 区间近似（后验 σ ± 1.645σ） */
  lower: number;
  upper: number;
  /** MAP 后继状态（无证据时停留原态；冷边可经类比继承别域结构） */
  successor: string;
  /**
   * 9.0：分层先验来源（挂载抽象内核时）——这条边的知识有多少是
   * 自己挣的、多少是类比/域边际/全局借来的。audit 用。
   */
  abstract?: { source: string; strength: number; mean: number };
}

/** 轨迹中一步的完整分解（审计单元） */
export interface StepEvaluation {
  /** 步序（0 起） */
  step: number;
  state: string;
  action: string;
  nextState: string;
  /** 该步成功概率（后验均值） */
  pStep: number;
  /** 该步开始时的有效证据（真实 + 轨迹内想象折算） */
  evidence: number;
  /** 务实价值：E[−ln P(goal|do(a))]（nat） */
  pragmatic: number;
  /** 认知价值：该步期望信息增益（nat；重访同一边时单调下降） */
  epistemic: number;
  /** 该步 G = pragmatic − epistemicWeight × epistemic */
  efe: number;
  /** 折扣后计入轨迹总 G 的份额（γ^step × efe） */
  discounted: number;
}

/** 想象报告（一条计划的梦境推演） */
export interface ImaginationReport {
  /** 起始状态 */
  startState: string;
  /** 行动序列 */
  actions: string[];
  /** 状态轨迹（states[i] = 第 i 步之前所处状态） */
  states: string[];
  /** 折扣累计 G = Σ γ^t · G_t（越低越好；与单步 EFE 同量纲） */
  totalEfe: number;
  /** 未折扣累计（长计划审计用） */
  undiscountedEfe: number;
  /** 全程成功概率 = Π p_t */
  pAllSuccess: number;
  steps: StepEvaluation[];
  /** 首败风险分布：恰好在第 step 步首次失败的概率 */
  riskProfile: Array<{ step: number; pFailAt: number }>;
  /** 同一条边在轨迹内被重访时认知价值是否单调不增（想象证据坍缩） */
  epistemicMonotone: boolean;
}

/** 技能（时间抽象的宏动作：验证过的行动序列） */
export interface Skill {
  id: string;
  /** 触发态（起始状态键；检索时精确匹配） */
  initiation: string;
  /** 行动序列（宏展开即按序执行） */
  actions: string[];
  /** 价值估计 = 宏动作全程成功概率口径（0~1，越高越好；随复用/失手 EMA 更新） */
  value: number;
  /** 全程成功概率估计（与价值同源，独立保留供审计） */
  reliability: number;
  /** 价值的不确定度（随结算次数收缩；检索排序折扣用） */
  confidence: number;
  usages: number;
  successes: number;
  createdAt: number;
  lastUsedAt: number;
}

/** 梦实现对账报告（想象的可问责性） */
export interface SettlementReport {
  steps: Array<{
    step: number;
    state: string;
    action: string;
    /** 梦里的预测（执行前口径，防止用结果修预测） */
    predicted: number;
    actual: boolean;
    /** −ln P(实际)（nat） */
    surprisal: number;
    /** |predicted − outcome| */
    error: number;
  }>;
  overallSuccess: boolean;
  meanSurprisal: number;
  /** 梦校准误差 EMA（0 = 完美预知；越高想象越不可信） */
  calibrationEma: number;
  /** 本轮技能库动作 */
  skillAction: 'acquired' | 'reinforced' | 'decayed' | 'none';
  skillId?: string;
}

/** 前瞻搜索结果 */
export interface DeliberationResult {
  /** 按轨迹 G 升序的完整推演报告 */
  ranked: ImaginationReport[];
  best: ImaginationReport | undefined;
  /** 搜索展开的边数（含技能宏展开） */
  expandedNodes: number;
  /** 技能种子是否参与（时间抽象生效） */
  skillSeeded: boolean;
}

// ─────────────────────────── 配置 ───────────────────────────

export interface DeliberationConfig {
  /** 时间折扣 γ（缺省 0.95：远期收益按 5%/步衰减） */
  gamma: number;
  /** beam 宽度（缺省 6：每层保留的轨迹前缀数） */
  beamBreadth: number;
  /** 搜索深度上限（缺省 4 步） */
  maxDepth: number;
  /** 想象证据折算率（缺省 0.5：轨迹内重访同一边，每次折算 0.5 个伪证据） */
  imaginaryEvidenceRate: number;
  /** 认知价值权重（与 FreeEnergyConfig 同义，缺省 1） */
  epistemicWeight: number;
  /** 概率裁剪 ε */
  probEpsilon: number;
  /** 技能入库价值门槛（全程成功概率 ≥ 该值才可成技能，缺省 0.5） */
  skillValueThreshold: number;
  /** 技能库容量上限（超额按价值×置信度淘汰，缺省 64） */
  skillMaxCount: number;
  /** 梦校准 EMA 平滑系数（缺省 0.3，比感知惊奇更敏） */
  calibrationAlpha: number;
}

export const DEFAULT_DELIBERATION_CONFIG: DeliberationConfig = {
  gamma: 0.95,
  beamBreadth: 6,
  maxDepth: 4,
  imaginaryEvidenceRate: 0.5,
  epistemicWeight: 1,
  probEpsilon: 1e-6,
  skillValueThreshold: 0.5,
  skillMaxCount: 64,
  calibrationAlpha: 0.3,
};

// ─────────────────────────── 内核实现 ───────────────────────────

/** 转移边内部记账 */
interface EdgeStats {
  successes: number;
  failures: number;
  /** 后继状态计数（成功转移的分布；想象沿 MAP 走） */
  successors: Map<string, number>;
}

/** 搜索 beam 中的轨迹前缀 */
interface BeamNode {
  state: string;
  actions: string[];
  states: string[];
  steps: StepEvaluation[];
  totalEfe: number;
  pSuccess: number;
  /** 轨迹内想象证据（edgeKey → 已想象次数） */
  imaginedUses: Map<string, number>;
}

/**
 * 深思内核：转移模型 + 想象推演 + 前瞻搜索 + 技能库 + 梦实现对账。
 *
 * 消费方：
 * - optimizer：冷启动序列推荐（零情景记忆也能按想象给出计划级建议）
 * - meta-cognition：梦校准 KPI（想象可靠性的诚实度量）
 * - symbiosis/runtime：多步行动提案按轨迹 G 排序
 * - 宿主/执行器：计划执行后 settle 对账（学习 + 惊奇回流 + 技能蒸馏）
 */
export class DeliberationEngine {
  private config: DeliberationConfig;
  private edges = new Map<string, EdgeStats>();
  private skills: Skill[] = [];
  private skillCounter = 0;
  private calibrationEma: number | undefined;
  private plansSettled = 0;
  private freeEnergy?: FreeEnergyEngine;
  /** 9.0：抽象内核（可选挂载；分层先验 + 后继继承 + 抽象技能） */
  private abstraction?: AbstractionEngine;

  constructor(config?: Partial<DeliberationConfig>, freeEnergy?: FreeEnergyEngine) {
    this.config = { ...DEFAULT_DELIBERATION_CONFIG, ...config };
    this.freeEnergy = freeEnergy;
  }

  /** 挂载自由能引擎（梦对账的惊奇回流目标；幂等） */
  attachFreeEnergyEngine(engine: FreeEnergyEngine): void {
    this.freeEnergy = engine;
  }

  /**
   * 9.0：挂载抽象内核（幂等）。挂载后：
   * - posterior 经分层先验收缩（L4 均匀层与 Beta(1,1) 严格等价，
   *   零数据时对既有行为零漂移）
   * - 冷叶子继承结构相似域的后继结构（类比规划）
   * - 搜索种子合并跨域抽象技能
   */
  attachAbstraction(engine: AbstractionEngine): void {
    this.abstraction = engine;
  }

  // ─────────────────────────── 学习（真实证据） ───────────────────────────

  /**
   * 登记一次真实执行证据（执行器/宿主在计划步落定后调用）。
   * @param state 该步所处状态键（如 `${taskType}#s${i}`）
   * @param action 行动（如 modelId）
   * @param success 该步成败
   * @param nextState 成功后的后继状态（缺省停留原态）
   */
  observe(state: string, action: string, success: boolean, nextState?: string): void {
    const key = edgeKey(state, action);
    let edge = this.edges.get(key);
    if (!edge) {
      edge = { successes: 0, failures: 0, successors: new Map() };
      this.edges.set(key, edge);
    }
    if (success) {
      edge.successes += 1;
      const next = nextState ?? state;
      edge.successors.set(next, (edge.successors.get(next) ?? 0) + 1);
    } else {
      edge.failures += 1;
    }
    // 9.0：证据同步喂入抽象内核（分层先验 + 后继继承 + 域画像的原料）
    this.abstraction?.observe(state, action, success, nextState);
  }

  /**
   * 转移边后验查询。
   *
   * 未挂载抽象内核：Beta(1,1) 均匀先验（无证据 = 诚实的完全无知）。
   * 挂载后：分层先验收缩——先验 = 类比/域边际/全局借来的知识
   * （strength 伪计数），叶子证据逐条覆盖（经验渐近压倒类比）。
   * 均匀层 strength=2 与 Beta(1,1) 严格等价：零数据时零漂移。
   */
  posterior(state: string, action: string): TransitionPosterior {
    const edge = this.edges.get(edgeKey(state, action));
    const successes = edge?.successes ?? 0;
    const failures = edge?.failures ?? 0;

    let alpha: number;
    let beta: number;
    let abstractInfo: TransitionPosterior['abstract'];
    if (this.abstraction) {
      const prior = this.abstraction.hierarchicalPrior(state, action);
      alpha = prior.strength * prior.mean + successes;
      beta = prior.strength * (1 - prior.mean) + failures;
      abstractInfo = { source: prior.source, strength: prior.strength, mean: round(prior.mean) };
    } else {
      alpha = 1 + successes;
      beta = 1 + failures;
    }

    const p = alpha / (alpha + beta);
    const n = alpha + beta;
    const sigma = Math.sqrt((alpha * beta) / (n * n * (n + 1)));
    let successor = state;
    let best = 0;
    for (const [candidate, count] of edge?.successors ?? []) {
      if (count > best) {
        best = count;
        successor = candidate;
      }
    }
    // 9.0：冷边后继继承——无自身后继证据时，经结构映射从类比域
    // 借转移结构（陷阱的本质在后继里，不在边缘概率里）
    if (successor === state && this.abstraction && successes + failures === 0) {
      successor = this.abstraction.inheritedSuccessor(state, action) ?? state;
    }
    return {
      state,
      action,
      pSuccess: round(p),
      alpha,
      beta,
      evidence: successes + failures,
      lower: round(Math.max(0, p - 1.645 * sigma)),
      upper: round(Math.min(1, p + 1.645 * sigma)),
      successor,
      abstract: abstractInfo,
    };
  }

  // ─────────────────────────── 想象（梦境推演） ───────────────────────────

  /**
   * 想象推演：在转移模型里 rollout 一条完整计划。
   *
   * 逐步计算（与单步 EFE 同一公式，证据沿轨迹累积）：
   *   α' = 1 + 真实成功 + λk·p̂   （λ = 想象证据折算率，k = 轨迹内已想象次数）
   *   β' = 1 + 真实失败 + λk·(1−p̂)
   *   务实 = −[ω ln p̂ + (1−ω) ln(1−p̂)]
   *   认知 = H(α',β') − [p̂·H(α'+1,β') + (1−p̂)·H(α',β'+1)]
   *   G_t = 务实 − w·认知；总 G = Σ γ^t G_t
   *
   * 关键性质：同一条边被重访时 λk 增大 → 后验熵收缩 → 认知价值单调不增
   * （想象证据坍缩：重复梦见同一件事不再带来新知识）。
   */
  imagine(startState: string, actions: string[], preference = 0.9): ImaginationReport {
    const eps = this.config.probEpsilon;
    const omega = Math.min(1, Math.max(0, preference));
    const steps: StepEvaluation[] = [];
    const states = [startState];
    const imaginedUses = new Map<string, number>();
    let state = startState;
    let totalEfe = 0;
    let undiscounted = 0;
    let pAll = 1;

    for (let t = 0; t < actions.length; t += 1) {
      const action = actions[t]!;
      const key = edgeKey(state, action);
      const k = imaginedUses.get(key) ?? 0;
      const post = this.posterior(state, action);
      const p = Math.min(1 - eps, Math.max(eps, post.pSuccess));

      // 想象证据折算：伪计数按后验比例分摊（均值不变，方差收缩）
      const lambda = this.config.imaginaryEvidenceRate * k;
      const alpha = post.alpha + lambda * p;
      const beta = post.beta + lambda * (1 - p);

      const pragmatic = -(omega * Math.log(p) + (1 - omega) * Math.log(1 - p));
      const h0 = betaEntropy(alpha, beta);
      const hYes = betaEntropy(alpha + 1, beta);
      const hNo = betaEntropy(alpha, beta + 1);
      const epistemic = Math.max(0, h0 - (p * hYes + (1 - p) * hNo));
      const efe = pragmatic - this.config.epistemicWeight * epistemic;
      const discounted = Math.pow(this.config.gamma, t) * efe;

      steps.push({
        step: t,
        state,
        action,
        nextState: post.successor,
        pStep: round(p),
        evidence: round(post.evidence + lambda),
        pragmatic: round(pragmatic),
        epistemic: round(epistemic),
        efe: round(efe),
        discounted: round(discounted),
      });
      totalEfe += discounted;
      undiscounted += efe;
      pAll *= p;
      states.push(post.successor);
      imaginedUses.set(key, k + 1);
      state = post.successor;
    }

    // 首败风险分布：P(恰在第 t 步首次失败) = (Π_{j<t} p_j)·(1−p_t)
    const riskProfile = steps.map((s) => {
      const before = steps.slice(0, s.step).reduce((prod, x) => prod * x.pStep, 1);
      return { step: s.step, pFailAt: round(before * (1 - s.pStep)) };
    });

    return {
      startState,
      actions: [...actions],
      states,
      totalEfe: round(totalEfe),
      undiscountedEfe: round(undiscounted),
      pAllSuccess: round(pAll),
      steps,
      riskProfile,
      epistemicMonotone: checkEpistemicMonotone(steps),
    };
  }

  // ─────────────────────────── 前瞻搜索 ───────────────────────────

  /**
   * 深思搜索：beam search 在轨迹空间按累计 G 剪枝。
   *
   * 与一步贪心（6.0 argmin G(a)）的本质区别：展开的是**轨迹前缀**——
   * 第 1 步的高 G 可以被第 2 步的低 G 补偿（γ 折扣），因此能看见
   * 「先苦后甜」的路，也能避开「第一步诱人、第二步是死路」的陷阱。
   *
   * 技能时间抽象：触发态匹配的技能作为宏动作直接展开整条序列
   * （一个 beam 槽位 = 多个原语步），深思从经验肩膀上起跳。
   *
   * @param startState 起始状态键
   * @param candidates 候选行动（静态清单或按状态动态给出）
   * @param opts 深度/宽度/偏好覆盖
   */
  search(
    startState: string,
    candidates: string[] | ((state: string) => string[]),
    opts?: {
      depth?: number;
      breadth?: number;
      preference?: number;
      useSkills?: boolean;
      /** 状态推进覆盖（确定性别状态机：忽略学习后继，按步推进） */
      advance?: (ctx: { state: string; action: string; step: number; successor: string }) => string;
    },
  ): DeliberationResult {
    const depth = Math.max(1, Math.min(opts?.depth ?? this.config.maxDepth, 12));
    const breadth = Math.max(1, opts?.breadth ?? this.config.beamBreadth);
    const preference = opts?.preference ?? 0.9;
    const useSkills = opts?.useSkills !== false;
    const actionsAt = (state: string): string[] =>
      typeof candidates === 'function' ? candidates(state) : candidates;
    if (actionsAt(startState).length === 0 && !useSkills) {
      return { ranked: [], best: undefined, expandedNodes: 0, skillSeeded: false };
    }

    let expandedNodes = 0;
    const finished: BeamNode[] = [];

    // 技能宏种子：触发态匹配 → 整条序列一次展开（时间抽象）
    let skillSeeded = false;
    let frontier: BeamNode[] = [
      { state: startState, actions: [], states: [startState], steps: [], totalEfe: 0, pSuccess: 1, imaginedUses: new Map() },
    ];
    if (useSkills) {
      for (const skill of this.skillsFor(startState)) {
        if (skill.actions.length === 0) continue;
        const node = this.expandPrefix(startState, skill.actions, preference);
        expandedNodes += skill.actions.length;
        finished.push(node);
        skillSeeded = true;
      }
    }

    // 逐层展开：每层对每个前缀 × 每个候选行动算一步，按累计 G 剪枝
    for (let level = 0; level < depth; level += 1) {
      const children: BeamNode[] = [];
      for (const prefix of frontier) {
        for (const action of actionsAt(prefix.state)) {
          const child = this.extendNode(prefix, action, preference, level, opts?.advance);
          expandedNodes += 1;
          children.push(child);
        }
      }
      if (children.length === 0) break;
      children.sort((a, b) => a.totalEfe - b.totalEfe);
      frontier = children.slice(0, breadth);
      // 到达深度的完整轨迹进入候选
      for (const node of frontier) {
        if (node.actions.length === depth) finished.push(node);
      }
      // 部分展开的前缀（深度未满）也保留为合法短计划（含纯原语情形）
      if (level === depth - 1) break;
    }
    // 深度未满因候选耗尽而中断的前缀同样是完整计划
    for (const node of frontier) {
      if (node.actions.length > 0 && node.actions.length < depth) finished.push(node);
    }

    // 汇总排序（轨迹 G 升序；同 G 时更长计划优先——同等代价收获更多步）
    const seen = new Set<string>();
    const reports = finished
      .filter((n) => n.actions.length > 0)
      .map((n) => this.nodeToReport(n))
      .filter((r) => {
        const sig = r.actions.join('|');
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
      })
      .sort((a, b) => a.totalEfe - b.totalEfe || b.actions.length - a.actions.length)
      .slice(0, Math.max(breadth, 3));

    return { ranked: reports, best: reports[0], expandedNodes, skillSeeded };
  }

  // ─────────────────────────── 技能库（时间抽象） ───────────────────────────

  /**
   * 技能入库/强化：整体成功的计划蒸馏为可复用宏动作。
   * 同一 (触发态, 行动序列) 已存在时按 EMA 强化价值。
   */
  acquireSkill(initiation: string, actions: string[], value: number, reliability: number): Skill | undefined {
    if (actions.length === 0) return undefined;
    const signature = actions.join('|');
    const existing = this.skills.find((s) => s.initiation === initiation && s.actions.join('|') === signature);
    if (existing) {
      existing.usages += 1;
      existing.successes += 1;
      existing.value = round(0.7 * existing.value + 0.3 * value);
      existing.reliability = round(0.7 * existing.reliability + 0.3 * reliability);
      existing.confidence = Math.min(1, 0.5 + existing.usages * 0.1);
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (value < this.config.skillValueThreshold) return undefined;
    if (this.skills.length >= this.config.skillMaxCount) {
      // 淘汰价值×置信度最低者（经济自然选择）
      this.skills.sort((a, b) => b.value * b.confidence - a.value * a.confidence);
      this.skills.pop();
    }
    const skill: Skill = {
      id: `skill-${++this.skillCounter}`,
      initiation,
      actions: [...actions],
      value: round(value),
      reliability: round(reliability),
      confidence: 0.5,
      usages: 1,
      successes: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.skills.push(skill);
    return skill;
  }

  /** 技能衰减：匹配的技能失手（价值 EMA 下调，可靠性下滑） */
  decaySkill(initiation: string, actions: string[], penalty = 0.2): void {
    const signature = actions.join('|');
    const existing = this.skills.find((s) => s.initiation === initiation && s.actions.join('|') === signature);
    if (!existing) return;
    existing.usages += 1;
    existing.value = round(existing.value - penalty);
    existing.reliability = round(Math.max(0, existing.reliability * 0.8));
    existing.confidence = Math.min(1, 0.5 + existing.usages * 0.1);
  }

  /**
   * 检索：触发态匹配的技能（按价值 × 置信度降序）。
   * 9.0：挂载抽象内核时合并跨域抽象技能（同骨架任意域可复用）。
   */
  skillsFor(state: string): Skill[] {
    const concrete = this.skills
      .filter((s) => s.initiation === state)
      .sort((a, b) => b.value * b.confidence - a.value * a.confidence);
    if (!this.abstraction) return concrete;
    const abstract = this.abstraction.abstractSkillsFor(state).map((a) => ({
      id: a.id,
      initiation: state, // 检索口径：具体状态（抽象匹配已在内核完成）
      actions: [...a.actions],
      value: a.value,
      reliability: a.value,
      confidence: 0.6,
      usages: a.successes,
      successes: a.successes,
      createdAt: 0,
      lastUsedAt: Date.now(),
    }));
    return [...concrete, ...abstract];
  }

  /** 全部技能（可观测/审计） */
  allSkills(): Skill[] {
    return [...this.skills].sort((a, b) => b.value * b.confidence - a.value * a.confidence);
  }

  // ─────────────────────────── 梦实现对账 ───────────────────────────

  /**
   * 计划落定对账：梦里预测 vs 现实结果。
   *
   * 三重回流：
   * 1. 转移模型学习（真实证据入库）
   * 2. 自由能感知惊奇（−ln P(实际)，挂载引擎时）
   * 3. 梦校准 EMA（|预测 − 结果|：想象可靠性的统一度量）
   *
   * 整体成功 → 计划蒸馏为技能（时间抽象资产）；
   * 整体失败 → 若匹配技能则衰减（梦境失灵的问责）。
   *
   * @param plan 逐步计划（state + action）
   * @param outcomes 逐步真实结果
   */
  settle(plan: Array<{ state: string; action: string }>, outcomes: boolean[], preference = 0.9): SettlementReport {
    const steps: SettlementReport['steps'] = [];
    let surprisalSum = 0;
    let errorSum = 0;

    // 先按「执行前」口径取全部预测（防止用后面的更新修前面的预测）
    const predictions = plan.map((p) => this.posterior(p.state, p.action).pSuccess);

    for (let i = 0; i < plan.length; i += 1) {
      const { state, action } = plan[i]!;
      const actual = outcomes[i] ?? false;
      const predicted = Math.min(1 - this.config.probEpsilon, Math.max(this.config.probEpsilon, predictions[i]!));
      const surprisal = -Math.log(actual ? predicted : 1 - predicted);
      const error = Math.abs(predicted - (actual ? 1 : 0));
      this.observe(state, action, actual);
      this.freeEnergy?.observeSurprisal(predicted, actual);
      steps.push({ step: i, state, action, predicted: round(predicted), actual, surprisal: round(surprisal), error: round(error) });
      surprisalSum += surprisal;
      errorSum += error;
    }

    const meanError = plan.length > 0 ? errorSum / plan.length : 0;
    this.calibrationEma =
      this.calibrationEma === undefined
        ? meanError
        : (1 - this.config.calibrationAlpha) * this.calibrationEma + this.config.calibrationAlpha * meanError;
    this.plansSettled += 1;

    // 技能蒸馏 / 衰减
    const overallSuccess = outcomes.length > 0 && outcomes.every(Boolean);
    // 9.0：计划结局喂入抽象内核（同骨架同序列跨域成功 → 抽象技能晋升）
    if (plan.length > 0) {
      this.abstraction?.notePlanOutcome(plan[0]!.state, plan.map((p) => p.action), overallSuccess);
    }
    let skillAction: SettlementReport['skillAction'] = 'none';
    let skillId: string | undefined;
    if (plan.length > 0) {
      const initiation = plan[0]!.state;
      const actions = plan.map((p) => p.action);
      if (overallSuccess) {
        const after = this.imagine(initiation, actions, preference);
        const skill = this.acquireSkill(initiation, actions, after.pAllSuccess, after.pAllSuccess);
        if (skill) {
          skillAction = skill.usages > 1 ? 'reinforced' : 'acquired';
          skillId = skill.id;
        }
      } else {
        this.decaySkill(initiation, actions);
        const signature = actions.join('|');
        const hit = this.skills.find((s) => s.initiation === initiation && s.actions.join('|') === signature);
        if (hit) {
          skillAction = 'decayed';
          skillId = hit.id;
        }
      }
    }

    return {
      steps,
      overallSuccess,
      meanSurprisal: round(plan.length > 0 ? surprisalSum / plan.length : 0),
      calibrationEma: round(this.calibrationEma ?? 0),
      skillAction,
      skillId,
    };
  }

  /** 梦校准误差（EMA；未对账过时 undefined） */
  currentCalibration(): number | undefined {
    return this.calibrationEma === undefined ? undefined : round(this.calibrationEma);
  }

  /** 已对账计划数（可观测） */
  settledCount(): number {
    return this.plansSettled;
  }

  /** 序列化（持久化用；含抽象内核状态） */
  serialize(): {
    edges: Array<{ state: string; action: string; successes: number; failures: number; successors: Array<[string, number]> }>;
    skills: Skill[];
    calibrationEma: number | undefined;
    plansSettled: number;
    /** 9.0：抽象内核状态（挂载时） */
    abstraction?: ReturnType<AbstractionEngine['serialize']>;
  } {
    const edges: Array<{ state: string; action: string; successes: number; failures: number; successors: Array<[string, number]> }> = [];
    for (const [key, stats] of this.edges) {
      const [state, action] = key.split('\u0000');
      edges.push({
        state: state!,
        action: action!,
        successes: stats.successes,
        failures: stats.failures,
        successors: [...stats.successors],
      });
    }
    return {
      edges,
      skills: [...this.skills],
      calibrationEma: this.calibrationEma,
      plansSettled: this.plansSettled,
      abstraction: this.abstraction?.serialize(),
    };
  }

  /** 反序列化 */
  deserialize(data: ReturnType<DeliberationEngine['serialize']>): void {
    this.edges.clear();
    for (const e of data.edges) {
      this.edges.set(edgeKey(e.state, e.action), {
        successes: e.successes,
        failures: e.failures,
        successors: new Map(e.successors),
      });
    }
    this.skills = [...data.skills];
    this.calibrationEma = data.calibrationEma;
    this.plansSettled = data.plansSettled;
    if (data.abstraction && this.abstraction) this.abstraction.deserialize(data.abstraction);
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 单步扩展一个 beam 前缀（含想象证据累积；advance 覆盖学习后继） */
  private extendNode(
    prefix: BeamNode,
    action: string,
    preference: number,
    level: number,
    advance?: (ctx: { state: string; action: string; step: number; successor: string }) => string,
  ): BeamNode {
    const eps = this.config.probEpsilon;
    const omega = Math.min(1, Math.max(0, preference));
    const key = edgeKey(prefix.state, action);
    const k = prefix.imaginedUses.get(key) ?? 0;
    const post = this.posterior(prefix.state, action);
    const p = Math.min(1 - eps, Math.max(eps, post.pSuccess));
    const lambda = this.config.imaginaryEvidenceRate * k;
    const alpha = post.alpha + lambda * p;
    const beta = post.beta + lambda * (1 - p);
    const pragmatic = -(omega * Math.log(p) + (1 - omega) * Math.log(1 - p));
    const h0 = betaEntropy(alpha, beta);
    const epistemic = Math.max(0, h0 - (p * betaEntropy(alpha + 1, beta) + (1 - p) * betaEntropy(alpha, beta + 1)));
    const efe = pragmatic - this.config.epistemicWeight * epistemic;
    const discounted = Math.pow(this.config.gamma, level) * efe;
    const imaginedUses = new Map(prefix.imaginedUses);
    imaginedUses.set(key, k + 1);
    const nextState = advance
      ? advance({ state: prefix.state, action, step: level, successor: post.successor })
      : post.successor;
    const step: StepEvaluation = {
      step: level,
      state: prefix.state,
      action,
      nextState,
      pStep: round(p),
      evidence: round(post.evidence + lambda),
      pragmatic: round(pragmatic),
      epistemic: round(epistemic),
      efe: round(efe),
      discounted: round(discounted),
    };
    return {
      state: nextState,
      actions: [...prefix.actions, action],
      states: [...prefix.states, nextState],
      steps: [...prefix.steps, step],
      totalEfe: round(prefix.totalEfe + discounted),
      pSuccess: round(prefix.pSuccess * p),
      imaginedUses,
    };
  }

  /** 整段序列展开（技能宏：从起始态一次推演完整技能） */
  private expandPrefix(startState: string, actions: string[], preference: number): BeamNode {
    const report = this.imagine(startState, actions, preference);
    const imaginedUses = new Map<string, number>();
    let state = startState;
    for (const action of actions) {
      const key = edgeKey(state, action);
      imaginedUses.set(key, (imaginedUses.get(key) ?? 0) + 1);
      state = this.posterior(state, action).successor;
    }
    return {
      state: report.states[report.states.length - 1] ?? startState,
      actions: [...actions],
      states: report.states,
      steps: report.steps,
      totalEfe: report.totalEfe,
      pSuccess: report.pAllSuccess,
      imaginedUses,
    };
  }

  /** beam 前缀 → 完整想象报告（复用已算好的步分解，不重算） */
  private nodeToReport(node: BeamNode): ImaginationReport {
    const before = (i: number) => node.steps.slice(0, i).reduce((prod, x) => prod * x.pStep, 1);
    return {
      startState: node.states[0] ?? '',
      actions: node.actions,
      states: node.states,
      totalEfe: node.totalEfe,
      undiscountedEfe: round(node.steps.reduce((s, x) => s + x.efe, 0)),
      pAllSuccess: node.pSuccess,
      steps: node.steps,
      riskProfile: node.steps.map((s) => ({ step: s.step, pFailAt: round(before(s.step) * (1 - s.pStep)) })),
      epistemicMonotone: checkEpistemicMonotone(node.steps),
    };
  }
}

// ─────────────────────────── 工具 ───────────────────────────

function edgeKey(state: string, action: string): string {
  return `${state}\u0000${action}`;
}

/** 认知价值坍缩校验：同一条边重访时认知价值单调不增 */
function checkEpistemicMonotone(steps: StepEvaluation[]): boolean {
  const lastEpistemic = new Map<string, number>();
  for (const s of steps) {
    const key = edgeKey(s.state, s.action);
    const prev = lastEpistemic.get(key);
    if (prev !== undefined && s.epistemic > prev + 1e-9) return false;
    lastEpistemic.set(key, s.epistemic);
  }
  return true;
}

function round(x: number): number {
  return Number(x.toFixed(6));
}
