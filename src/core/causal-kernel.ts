/**
 * causal-kernel.ts — 因果内核（项目 5.0「从相关到因果」的质变基座）
 *
 * 升级前的根本局限（全模块通病）：
 * - 证据内核（evidence.ts）回答的是 P(成功 | 特征) —— 这是相关性；
 *   系统据此排序/调度/分红，但从未回答「正是这个因素导致了结果吗？」
 * - 相关 ≠ 因果的典型陷阱：健康模型总被派发简单任务 → 观测成功率虚高
 *   （任务难度是混杂因子）；某策略与成功共现 → 可能只是都发生在低峰期。
 * - 一切「调参 / 换模型 / 进化」的决策依据都停留在 observational 层。
 *
 * 本内核引入 Pearl 因果阶梯的第二层 —— do-干预：
 * 1. 双流证据：每条因果边同时维护「干预证据」（do(X=x) 后观测 Y，
 *    如 A/B 实验真实切换）与「观测证据」（被动共现）——两层统计口径
 *    显式分离，永不混账。
 * 2. 干预效应估计：ATE = P(Y=1|do(X=1)) − P(Y=1|do(X=0))，
 *    每臂独立 Beta 后验 + Wilson 风格保守下界 —— 小样本实验不虚报因果。
 * 3. 混杂检测：观测关联与干预效应的显著背离 = 混杂因子的指纹。
 *    「冰淇淋销量 ↔ 溺水」类伪因果在此被自动标记（observationalOnly
 *    边的因果置信度被结构性折扣）。
 * 4. 反事实查询：actualOutcome 与 alternativeAction 的效应对比 ——
 *    「若当时选 B，成功概率几何」从哲学问题变为区间估计。
 * 5. 实验设计（好奇心接口）：不确定性最高（Beta 区间最宽）× 重要性
 *    最高（关联目标 KPI）的边优先做 do-实验 —— 假设驱动的好奇心。
 *
 * 与证据内核的关系：causal-kernel 建立在 evidence.ts 的同一套统计语言
 * （Beta 后验 / Wilson 下界 / 30 天时间衰减）之上，但回答的问题升了一层：
 * evidence.ts 问「它表现如何」，causal-kernel 问「是不是它造成的」。
 *
 * 审计性：全部干预记录（谁、何时、do 了什么、结果）保留链式日志，
 * 因果结论可追溯到每一次实验 —— 因果断言可被审计、可被证伪。
 */

import { decayFactor, wilsonLowerBound, wilsonUpperBound, BAYES_PRIOR_STRENGTH, DECAY_HALF_LIFE_DAYS } from './evidence.js';

// ─────────────────────────── 数据结构 ───────────────────────────

/** 因果节点种类（动作 / 旋钮 / 指标 / 情境） */
export type CausalNodeKind = 'action' | 'knob' | 'kpi' | 'context';

/** 因果节点（变量） */
export interface CausalNode {
  id: string;
  kind: CausalNodeKind;
  label?: string;
}

/**
 * 因果边双流证据（X → Y）
 *
 * 干预流（黄金证据）：
 * - doXSuccess/doXFailure：do(X=1) 后 Y=1 / Y=0 的次数（处理组）
 * - doNotXSuccess/doNotXFailure：do(X=0) 后 Y=1 / Y=0 的次数（对照组）
 *
 * 观测流（银级证据，受混杂污染）：
 * - obsBoth：X=1 且 Y=1（联合）
 * - obsXOnly：X=1 且 Y=0
 * - obsYOnly：X=0 且 Y=1
 * - obsNeither：X=0 且 Y=0
 */
export interface CausalEdgeEvidence {
  doXSuccess: number;
  doXFailure: number;
  doNotXSuccess: number;
  doNotXFailure: number;
  obsBoth: number;
  obsXOnly: number;
  obsYOnly: number;
  obsNeither: number;
  /** 惰性衰减基准（与 MemoryEvidence 同一语义） */
  lastDecayedAt: number;
}

/** 因果边（可序列化） */
export interface CausalEdge {
  from: string;
  to: string;
  evidence: CausalEdgeEvidence;
  createdAt: number;
  lastTouchedAt: number;
}

/** 因果效应估计（对某条边的一次完整问答） */
export interface CausalEffect {
  from: string;
  to: string;
  /** 平均处理效应 ATE = P(Y=1|do(X=1)) − P(Y=1|do(X=0)) */
  ate: number;
  /** ATE 保守下界（处理组下界 − 对照组上界，最悲观口径） */
  lower: number;
  /** ATE 乐观上界 */
  upper: number;
  /** 处理臂后验 P(Y=1|do(X=1))（无干预样本时回退观测估计并降权） */
  pDo: number;
  /** 对照臂后验 P(Y=1|do(X=0)) */
  pDoNot: number;
  /** 干预证据样本量（两臂合计） */
  interventionalSamples: number;
  /** 观测证据样本量（四格合计） */
  observationalSamples: number;
  /** 观测关联强度（P(Y=1|X=1) − P(Y=1|X=0)） */
  observationalAssociation: number;
  /** 混杂度 0~1：观测关联与干预效应的归一化背离 */
  confounding: number;
  /** 因果置信度 0~1（干预样本量 × 混杂折扣） */
  confidence: number;
  direction: 'positive' | 'negative' | 'none';
  /** 效应是否已确立（下界 > 0 或上界 < 0 且置信度足够） */
  established: boolean;
}

/** do-干预记录（审计链） */
export interface InterventionRecord {
  seq: number;
  timestamp: number;
  from: string;
  to: string;
  /** 设定值（do(X=1) / do(X=0)） */
  setTo: boolean;
  /** 观测到的 Y */
  observedY: boolean;
  /** 干预发起方（如 'meta-cognition' / 'curiosity' / 'futarchy'） */
  actor: string;
  /** 干预理由（假设陈述） */
  hypothesis?: string;
}

/** 建议的因果实验（好奇心 → 实验设计） */
export interface CausalExperiment {
  from: string;
  to: string;
  /** 建议的干预方向（先验更可能有效的一臂） */
  suggestedArm: boolean;
  /** 信息增益评分 0~1（不确定性 × 重要性） */
  infoGain: number;
  /** 实验假设（可读陈述） */
  hypothesis: string;
  /** 当前不确定性（Beta 区间宽度） */
  uncertainty: number;
}

// ─────────────────────────── 配置 ───────────────────────────

/** 因果内核配置 */
export interface CausalKernelConfig {
  /** 混杂告警的最小背离（|观测关联 − 干预效应|，默认 0.2） */
  confoundingThreshold: number;
  /** 因果确立的最小置信度（默认 0.5） */
  establishedConfidence: number;
  /** 单边干预记录上限（审计链截断保护） */
  maxInterventionLog: number;
  /** 实验建议的最小不确定性（Beta 区间宽度，默认 0.4） */
  experimentMinUncertainty: number;
}

export const DEFAULT_CAUSAL_CONFIG: CausalKernelConfig = {
  confoundingThreshold: 0.2,
  establishedConfidence: 0.5,
  maxInterventionLog: 2000,
  experimentMinUncertainty: 0.4,
};

// ─────────────────────────── 内核实现 ───────────────────────────

/**
 * 因果内核：全系统共享的因果图 + do-干预登记处。
 *
 * 消费方：
 * - symbiosis/runtime：Shapley 分红用因果效应（而非线性权重）定价贡献
 * - world-model：do-干预效应预测（预见「若我这样做，世界会怎样」）
 * - reflection-engine：反事实反思（失败 → 「若选 B」教训）
 * - meta-cognition：旋钮推荐按因果效应排序（而非规则命中顺序）
 * - curiosity-engine：假设驱动实验设计（不确定性边 → do-实验 → 图更新）
 */
export class CausalKernel {
  private config: CausalKernelConfig;
  private nodeMap = new Map<string, CausalNode>();
  /** 边键 `${from}→${to}` */
  private edgeMap = new Map<string, CausalEdge>();
  /** 干预审计链（seq 单调递增） */
  private interventionLog: InterventionRecord[] = [];
  private seq = 0;

  constructor(config?: Partial<CausalKernelConfig>) {
    this.config = { ...DEFAULT_CAUSAL_CONFIG, ...config };
  }

  // ── 图构建 ──

  /** 登记因果节点（幂等；重复登记仅更新元信息） */
  addNode(node: CausalNode): void {
    this.nodeMap.set(node.id, { ...node, label: node.label ?? node.id });
  }

  /** 便捷登记：模型动作节点（from 形如 `use:model-x`） */
  private ensureNodes(from: string, to: string, fromKind: CausalNodeKind, toKind: CausalNodeKind): CausalEdge {
    if (!this.nodeMap.has(from)) this.addNode({ id: from, kind: fromKind });
    if (!this.nodeMap.has(to)) this.addNode({ id: to, kind: toKind });
    const key = `${from}→${to}`;
    let edge = this.edgeMap.get(key);
    if (!edge) {
      const now = Date.now();
      edge = {
        from,
        to,
        evidence: {
          doXSuccess: 0,
          doXFailure: 0,
          doNotXSuccess: 0,
          doNotXFailure: 0,
          obsBoth: 0,
          obsXOnly: 0,
          obsYOnly: 0,
          obsNeither: 0,
          lastDecayedAt: now,
        },
        createdAt: now,
        lastTouchedAt: now,
      };
      this.edgeMap.set(key, edge);
    }
    return edge;
  }

  /**
   * 被动观测（银级证据）：X 与 Y 的共现 —— 不做任何设定，只是看到。
   *
   * 观测证据只影响 observationalAssociation 与混杂度计算；
   * 无干预证据时作为 ATE 的降权回退估计。
   */
  observe(from: string, to: string, x: boolean, y: boolean, now = Date.now()): void {
    const edge = this.ensureNodes(from, to, 'action', 'kpi');
    this.decayEdge(edge, now);
    if (x && y) edge.evidence.obsBoth += 1;
    else if (x) edge.evidence.obsXOnly += 1;
    else if (y) edge.evidence.obsYOnly += 1;
    else edge.evidence.obsNeither += 1;
    edge.lastTouchedAt = now;
  }

  /**
   * do-干预（黄金证据）：主动把 X 设为 setTo，观测结果 Y。
   *
   * 这是因果阶梯第二层的唯一入口 —— 每次真实 A/B 切换、每次参数实验、
   * 每次沙盒部署对照都应经此登记。审计链保留完整因果断言来源。
   *
   * @param actor 干预发起方（审计用）
   * @param hypothesis 实验假设（如「切换 model-b 可提升翻译成功率」）
   */
  intervene(
    from: string,
    to: string,
    setTo: boolean,
    observedY: boolean,
    actor: string,
    hypothesis?: string,
    now = Date.now(),
  ): InterventionRecord {
    const edge = this.ensureNodes(from, to, 'action', 'kpi');
    this.decayEdge(edge, now);
    if (setTo) {
      if (observedY) edge.evidence.doXSuccess += 1;
      else edge.evidence.doXFailure += 1;
    } else {
      if (observedY) edge.evidence.doNotXSuccess += 1;
      else edge.evidence.doNotXFailure += 1;
    }
    edge.lastTouchedAt = now;
    this.seq += 1;
    const record: InterventionRecord = {
      seq: this.seq,
      timestamp: now,
      from,
      to,
      setTo,
      observedY,
      actor,
      hypothesis,
    };
    this.interventionLog.push(record);
    if (this.interventionLog.length > this.config.maxInterventionLog) {
      this.interventionLog.splice(0, this.interventionLog.length - this.config.maxInterventionLog);
    }
    return record;
  }

  // ── 效应估计 ──

  /**
   * 估计因果效应 ATE（对一条边的完整因果问答）。
   *
   * 口径优先级：
   * 1. 双臂干预证据齐全 → 纯干预 ATE（黄金口径）
   * 2. 仅处理臂 → 对照臂回退观测基线 P(Y=1|X=0)，混杂折扣已含在 confidence
   * 3. 无任何干预 → ATE = 观测关联 × 0.5（结构性折扣：未经实验的关联
   *    只值一半信任），confidence 上限 0.4（永不 established）
   */
  effect(from: string, to: string, now = Date.now()): CausalEffect {
    const key = `${from}→${to}`;
    const edge = this.edgeMap.get(key);
    if (!edge) {
      return {
        from,
        to,
        ate: 0,
        lower: 0,
        upper: 0,
        pDo: 0.5,
        pDoNot: 0.5,
        interventionalSamples: 0,
        observationalSamples: 0,
        observationalAssociation: 0,
        confounding: 0,
        confidence: 0,
        direction: 'none',
        established: false,
      };
    }
    const ev = this.decayedView(edge, now);

    // 处理臂 / 对照臂 Beta 后验（干预优先，观测回退降权）
    const doN = ev.doXSuccess + ev.doXFailure;
    const doNotN = ev.doNotXSuccess + ev.doNotXFailure;
    const obsX1 = ev.obsBoth + ev.obsXOnly;
    const obsX0 = ev.obsYOnly + ev.obsNeither;
    const obsAll = obsX1 + obsX0;

    const pDo =
      doN > 0
        ? (ev.doXSuccess + BAYES_PRIOR_STRENGTH) / (doN + 2 * BAYES_PRIOR_STRENGTH)
        : obsX1 > 0
          ? (ev.obsBoth + BAYES_PRIOR_STRENGTH) / (obsX1 + 2 * BAYES_PRIOR_STRENGTH) // 观测回退
          : 0.5;
    const pDoNot =
      doNotN > 0
        ? (ev.doNotXSuccess + BAYES_PRIOR_STRENGTH) / (doNotN + 2 * BAYES_PRIOR_STRENGTH)
        : obsX0 > 0
          ? (ev.obsYOnly + BAYES_PRIOR_STRENGTH) / (obsX0 + 2 * BAYES_PRIOR_STRENGTH)
          : 0.5;

    // 观测关联（对照参考，非因果）
    const obsAssociation =
      obsX1 > 0 && obsX0 > 0 ? (ev.obsBoth / obsX1) - (ev.obsYOnly / obsX0) : 0;

    // ATE 统一定义：两臂后验均值之差（臂估计已含回退链）。
    // 是否经过实验由 confidence / 区间 / established 表达，不混入点估计。
    const usedDo = doN > 0 || doNotN > 0;
    const ate = pDo - pDoNot;

    // 臂区间：干预 Wilson 界 → 观测 Wilson 界 → 先验全区间 [0,1]。
    // 无对照臂数据时区间保持全宽 —— 未做实验的边，效应诚实未知。
    const [doLower, doUpper] =
      doN >= 1
        ? [wilsonLowerBound(ev.doXSuccess, ev.doXFailure), wilsonUpperBound(ev.doXSuccess, ev.doXFailure)]
        : obsX1 >= 1
          ? [wilsonLowerBound(ev.obsBoth, ev.obsXOnly), wilsonUpperBound(ev.obsBoth, ev.obsXOnly)]
          : [0, 1];
    const [doNotLower, doNotUpper] =
      doNotN >= 1
        ? [wilsonLowerBound(ev.doNotXSuccess, ev.doNotXFailure), wilsonUpperBound(ev.doNotXSuccess, ev.doNotXFailure)]
        : obsX0 >= 1
          ? [wilsonLowerBound(ev.obsYOnly, ev.obsNeither), wilsonUpperBound(ev.obsYOnly, ev.obsNeither)]
          : [0, 1];
    const conservativeLower = Math.max(-1, doLower - doNotUpper);
    const conservativeUpper = Math.min(1, doUpper - doNotLower);

    // 混杂度：观测关联与干预效应的归一化背离。
    // 前提：两臂干预 + 两臂观测基线都在（否则关联不可计算，
    // 缺基线不构成混杂证据，避免假阳性）。
    const hasObsBaseline = obsX1 >= 1 && obsX0 >= 1;
    const divergence = usedDo && hasObsBaseline && obsAll >= 4 ? Math.abs(obsAssociation - ate) : 0;
    const confounding = Math.min(1, divergence / Math.max(0.5, Math.abs(obsAssociation) + Math.abs(ate)));

    // 因果置信度：干预证据强度 ×（1 − 混杂折扣）× 时间新鲜度
    const interventionalSamples = doN + doNotN;
    const evidenceStrength = Math.min(1, interventionalSamples / 10); // 10 次实验满强度
    const obsOnlyCap = 0.4; // 纯观测边的置信度天花板（结构性折扣）
    const freshness = decayFactor(now - edge.lastTouchedAt, DECAY_HALF_LIFE_DAYS);
    let confidence = evidenceStrength * (1 - 0.5 * confounding) * Math.max(0.5, freshness);
    if (!usedDo) confidence = Math.min(confidence, obsOnlyCap * Math.min(1, obsAll / 10));

    // 方向由点估计给出（信息量）；「确立」必须经实验：置信度达标 +
    // Wilson 口径区间整体偏移 + 至少一条干预臂（纯观测永不确立）。
    const direction = ate > 0.02 ? 'positive' : ate < -0.02 ? 'negative' : 'none';
    const established =
      usedDo &&
      confidence >= this.config.establishedConfidence &&
      (conservativeLower > 0 || conservativeUpper < 0);

    return {
      from,
      to,
      ate: round(ate),
      lower: round(Math.max(-1, conservativeLower)),
      upper: round(Math.min(1, conservativeUpper)),
      pDo: round(pDo),
      pDoNot: round(pDoNot),
      interventionalSamples,
      observationalSamples: obsAll,
      observationalAssociation: round(obsAssociation),
      confounding: round(confounding),
      confidence: round(confidence),
      direction,
      established,
    };
  }

  /**
   * 因果排序：谁真正导致了 target（按效应下界降序）。
   *
   * 质变点：传统排序 = 相关性命中；本排序 = 已确立因果 > 高置信正效应 >
   * 待验证正效应。混杂严重的边即使观测关联再强也排不上来。
   */
  rankCauses(target: string, now = Date.now()): CausalEffect[] {
    const effects: CausalEffect[] = [];
    for (const edge of this.edgeMap.values()) {
      if (edge.to !== target) continue;
      effects.push(this.effect(edge.from, edge.to, now));
    }
    return effects.sort((a, b) => {
      // 已确立因果绝对优先
      if (a.established !== b.established) return a.established ? -1 : 1;
      // 再比保守下界 × 置信度（因果期望）
      return b.lower * b.confidence - a.lower * a.confidence;
    });
  }

  /**
   * 混杂指纹检测：观测关联强但干预效应弱（或方向相反）的边。
   *
   * 返回的每条边都是一次「我们曾以为的因果」的证伪现场 ——
   * 调度器/优化器依赖这些边做的历史决策值得复查。
   */
  detectConfounding(now = Date.now()): Array<CausalEffect & { divergence: number }> {
    const flagged: Array<CausalEffect & { divergence: number }> = [];
    for (const edge of this.edgeMap.values()) {
      const eff = this.effect(edge.from, edge.to, now);
      if (eff.interventionalSamples < 3 || eff.observationalSamples < 4) continue;
      if (eff.confounding <= 0) continue; // 无观测基线 → 关联不可比较 → 不构成混杂证据
      const divergence = Math.abs(eff.observationalAssociation - eff.ate);
      if (divergence >= this.config.confoundingThreshold) {
        flagged.push({ ...eff, divergence: round(divergence) });
      }
    }
    return flagged.sort((a, b) => b.divergence - a.divergence);
  }

  /**
   * 6.0：因果中介分析 —— 效应「经由什么机制」发生。
   *
   * X → M → Y 链上的效应分解（线性链近似，效应尺度用 ATE）：
   * - 总效应 total = effect(X→Y)
   * - 间接效应（经中介）indirect = effect(X→M) × effect(M→Y)
   * - 直接效应（绕过中介）direct = total − indirect
   * - 中介占比 share = indirect / |total|
   *
   * 质变点：此前系统只知道「模型 A 有效」，不知道「为什么有效」。
   * 中介分解回答机制问题：「model-fast 之所以提升成功率，80% 是
   * 因为它降低了延迟（latency），20% 是质量本身」——知识第一次
   * 拥有内部结构，机制理解支撑更精准的迁移决策。
   *
   * @param from 处理 X（如 model-fast）
   * @param mediator 中介 M（如 kpi:latency-improved）
   * @param to 结果 Y（如 task.outcome）
   */
  mediation(from: string, mediator: string, to: string, now = Date.now()): {
    from: string;
    mediator: string;
    to: string;
    total: number;
    indirect: number;
    direct: number;
    /** 中介传导占比 0~1（间接/|总|；总效应近零时为 0） */
    share: number;
    /** 各段效应明细（链上每条边的完整问答） */
    path: { xm: CausalEffect; my: CausalEffect; xy: CausalEffect };
    /** 机制解读 */
    mechanism: string;
  } {
    const xm = this.effect(from, mediator, now);
    const my = this.effect(mediator, to, now);
    const xy = this.effect(from, to, now);
    // 恒等式严格成立：total = direct + indirect（链上各段 ATE 已单轮取整，
    // 此处不再二次取整，保证返回值自洽到机器精度）
    const total = round(xy.ate);
    const indirect = xm.ate * my.ate;
    const direct = total - indirect;
    const share = Math.abs(total) > 0.05 ? Math.min(1, Math.abs(indirect) / Math.abs(total)) : 0;
    let mechanism: string;
    if (xy.interventionalSamples < 3) {
      mechanism = `总效应证据不足（${xy.interventionalSamples} 干预样本），机制分解暂不可靠`;
    } else if (share >= 0.6) {
      mechanism = `${from} 对 ${to} 的效应 ${Math.round(share * 100)}% 经由 ${mediator} 传导（${from}→${mediator} ${xm.ate.toFixed(2)} × ${mediator}→${to} ${my.ate.toFixed(2)}）——机制主导型效应`;
    } else if (share <= 0.2) {
      mechanism = `${from} 对 ${to} 的效应主要不走 ${mediator}（中介占比 ${Math.round(share * 100)}%，直接效应 ${direct.toFixed(2)}）——直接主导型效应`;
    } else {
      mechanism = `${from} 对 ${to} 的效应混合传导：中介 ${Math.round(share * 100)}% + 直接 ${direct.toFixed(2)}——双通道机制`;
    }
    return {
      from,
      mediator,
      to,
      total,
      indirect,
      direct,
      share: round(share),
      path: { xm, my, xy },
      mechanism,
    };
  }

  /**
   * 反事实查询：给定实际发生了 actionActual 且结果为 actualY，
   * 「若当时做 actionAlternative」成功概率几何。
   *
   * 实现：两动作 → 同一结果的因果边后验对比（无证据时返回先验 0.5
   * 并以宽区间表达无知 —— 诚实的不确定性，而非假装知道）。
   */
  counterfactual(
    outcome: string,
    actionActual: string,
    actionAlternative: string,
    actualY: boolean,
    now = Date.now(),
  ): {
    alternative: string;
    estimatedProb: number;
    lower: number;
    upper: number;
    actualProb: number;
    evidenceSamples: number;
    verdict: string;
  } {
    const altEffect = this.effect(actionAlternative, outcome, now);
    const actualEffect = this.effect(actionActual, outcome, now);
    // actual 已发生：用观测事实校正 actual 概率
    const actualProb = actualY ? Math.max(actualEffect.pDo, 0.5) : Math.min(actualEffect.pDo, 0.5);
    const samples = altEffect.interventionalSamples + altEffect.observationalSamples;
    // 反事实区间宽窄由证据量决定：无证据 → 全区间（一无所知）
    const margin = samples >= 10 ? 0.1 : samples >= 4 ? 0.2 : 0.5;
    const estimatedProb = altEffect.pDo;
    let verdict: string;
    if (samples < 4) {
      verdict = `证据不足（${samples} 样本）：「若选 ${actionAlternative}」暂无法可靠回答，建议登记为因果实验`;
    } else if (actualY && estimatedProb - actualProb > 0.1) {
      verdict = `反事实遗憾：${actionAlternative} 的估计成功概率（${round(estimatedProb)}）高于实际路径（${round(actualProb)}）`;
    } else if (!actualY && estimatedProb > 0.6) {
      verdict = `反事实教训：失败路径下 ${actionAlternative} 估计成功概率 ${round(estimatedProb)}，下次优先`;
    } else {
      verdict = `实际选择已接近最优（${actionAlternative} 估计 ${round(estimatedProb)} vs 实际 ${round(actualProb)}）`;
    }
    return {
      alternative: actionAlternative,
      estimatedProb: round(estimatedProb),
      lower: round(Math.max(0, estimatedProb - margin)),
      upper: round(Math.min(1, estimatedProb + margin)),
      actualProb: round(actualProb),
      evidenceSamples: samples,
      verdict,
    };
  }

  // ── 实验设计（好奇心接口）──

  /**
   * 假设驱动实验建议：不确定性最高 × 关联 target 的边优先做 do-实验。
   *
   * 信息增益 = Beta 区间宽度（不确定性）× max(观测关联, 已见干预效应)（重要性）。
   * 每条建议自带可读假设陈述 —— 好奇心从「随机探索」升级为
   * 「提出假设 → 设计实验 → do-干预 → 图更新」的科学循环。
   */
  suggestExperiments(target: string, budget = 3, now = Date.now()): CausalExperiment[] {
    const candidates: CausalExperiment[] = [];
    for (const edge of this.edgeMap.values()) {
      if (edge.to !== target) continue;
      const eff = this.effect(edge.from, edge.to, now);
      // 区间宽度 = 效应不确定性
      const uncertainty = Math.min(1, eff.upper - eff.lower);
      if (uncertainty < this.config.experimentMinUncertainty) continue;
      const importance = Math.max(Math.abs(eff.observationalAssociation), Math.abs(eff.ate), 0.05);
      const infoGain = uncertainty * importance;
      candidates.push({
        from: edge.from,
        to: edge.to,
        suggestedArm: eff.ate >= 0 || eff.observationalAssociation >= 0,
        infoGain: round(infoGain),
        hypothesis: `假设：对 ${edge.from} 实施 do=${eff.ate >= 0 || eff.observationalAssociation >= 0 ? '启用' : '停用'} 将使 ${edge.to} ${eff.ate >= 0 || eff.observationalAssociation >= 0 ? '提升' : '下降'}（当前不确定区间 [${round(eff.lower)}, ${round(eff.upper)}]）`,
        uncertainty: round(uncertainty),
      });
    }
    return candidates.sort((a, b) => b.infoGain - a.infoGain).slice(0, budget);
  }

  // ── 可观测与持久化 ──

  /**
   * 10.0：单边证据明细（科学家内核的实验设计原料）。
   *
   * 暴露每条边两臂的原始成败计数与观测四格（含衰减口径），
   * 供外部按 Beta(1+s, 1+f) 精确重构臂后验并计算期望信息增益。
   * 只读快照，不暴露内部结构。
   */
  armEvidence(from: string, to: string, now = Date.now()): CausalEdgeEvidence | undefined {
    const edge = this.edgeMap.get(`${from}→${to}`);
    if (!edge) return undefined;
    return { ...this.decayedView(edge, now) };
  }

  /**
   * 11.0：全边衰减证据枚举（理论内核的归纳原料）。
   * 返回每条边的 (from, to, 衰减后双流证据)——理论内核据此分组归纳定律。
   */
  allEdgesEvidence(now = Date.now()): Array<CausalEdgeEvidence & { from: string; to: string }> {
    return [...this.edgeMap.values()].map((e) => ({ from: e.from, to: e.to, ...this.decayedView(e, now) }));
  }

  /** 图快照（节点 + 边效应摘要） */
  snapshot(now = Date.now()): {
    nodes: CausalNode[];
    edgeCount: number;
    establishedEdges: CausalEffect[];
    confoundedEdges: Array<CausalEffect & { divergence: number }>;
    interventions: number;
    topEdges: CausalEffect[];
  } {
    const all = [...this.edgeMap.values()].map((e) => this.effect(e.from, e.to, now));
    return {
      nodes: [...this.nodeMap.values()],
      edgeCount: all.length,
      establishedEdges: all.filter((e) => e.established).sort((a, b) => b.lower - a.lower),
      confoundedEdges: this.detectConfounding(now),
      interventions: this.interventionLog.length,
      topEdges: [...all].sort((a, b) => b.lower * b.confidence - a.lower * a.confidence).slice(0, 10),
    };
  }

  /** 干预审计链（只读拷贝） */
  interventions(): InterventionRecord[] {
    return [...this.interventionLog];
  }

  /** 序列化（持久化格式 = JSON） */
  serialize(): { nodes: CausalNode[]; edges: CausalEdge[]; interventions: InterventionRecord[]; seq: number } {
    return {
      nodes: [...this.nodeMap.values()],
      edges: [...this.edgeMap.values()],
      interventions: [...this.interventionLog],
      seq: this.seq,
    };
  }

  /** 反序列化 */
  deserialize(data: { nodes: CausalNode[]; edges: CausalEdge[]; interventions: InterventionRecord[]; seq: number }): void {
    this.nodeMap.clear();
    this.edgeMap.clear();
    for (const n of data.nodes) this.nodeMap.set(n.id, n);
    for (const e of data.edges) this.edgeMap.set(`${e.from}→${e.to}`, e);
    this.interventionLog = [...data.interventions];
    this.seq = data.seq ?? this.interventionLog.length;
  }

  // ── 内部 ──

  /** 惰性衰减（写入路径，与 MemoryEvidence 同一语义） */
  private decayEdge(edge: CausalEdge, now: number): void {
    const decay = decayFactor(Math.max(0, now - edge.evidence.lastDecayedAt));
    const e = edge.evidence;
    e.doXSuccess *= decay;
    e.doXFailure *= decay;
    e.doNotXSuccess *= decay;
    e.doNotXFailure *= decay;
    e.obsBoth *= decay;
    e.obsXOnly *= decay;
    e.obsYOnly *= decay;
    e.obsNeither *= decay;
    e.lastDecayedAt = now;
  }

  /** 读取式衰减视图（不回写） */
  private decayedView(edge: CausalEdge, now: number): CausalEdgeEvidence {
    const decay = decayFactor(Math.max(0, now - edge.evidence.lastDecayedAt));
    const e = edge.evidence;
    return {
      doXSuccess: e.doXSuccess * decay,
      doXFailure: e.doXFailure * decay,
      doNotXSuccess: e.doNotXSuccess * decay,
      doNotXFailure: e.doNotXFailure * decay,
      obsBoth: e.obsBoth * decay,
      obsXOnly: e.obsXOnly * decay,
      obsYOnly: e.obsYOnly * decay,
      obsNeither: e.obsNeither * decay,
      lastDecayedAt: now,
    };
  }
}

// ─────────────────────────── Shapley 反事实分红 ───────────────────────────

/** 联盟价值函数输入：单个贡献者的边际成功概率估计 */
export interface ContributorProb {
  agentId: string;
  /** P(该贡献者的工作使任务成功) —— 反事实口径的个体成功率 */
  prob: number;
}

/**
 * noisy-OR 联盟价值：v(S) = 1 − Π_{i∈S}(1 − p_i)
 *
 * 语义：每个贡献者独立地「有机会」把任务做成功；任务成功只要
 * 至少一条路径走通。这是多模型协同（任一模型产出可用即成功）的
 * 忠实抽象，且让 Shapley 值有精确的子集枚举解。
 */
export function coalitionValue(members: ContributorProb[]): number {
  let failAll = 1;
  for (const m of members) failAll *= Math.max(0, 1 - m.prob);
  return 1 - failAll;
}

/**
 * 精确 Shapley 值（子集枚举，n ≤ 16 时精确；更大时按权重截断）。
 *
 * φ_i = Σ_{S ⊆ N∖{i}} [|S|! (n−|S|−1)! / n!] · [v(S ∪ {i}) − v(S)]
 *
 * 质变点：分红不再按「表现分的线性份额」（搭便车者只要有正分就
 * 永远分钱），而按「边际反事实贡献」——拔掉你，任务成功率掉多少，
 * 你就分多少。两个都干了活的智能体平分；只挂名不出力的边际贡献
 * ≈ 0，自然饿死（能量经济的真公平）。
 */
export function shapleyValues(contributors: ContributorProb[]): Map<string, number> {
  const n = contributors.length;
  const result = new Map<string, number>();
  if (n === 0) return result;
  if (n === 1) {
    result.set(contributors[0]!.agentId, coalitionValue(contributors));
    return result;
  }
  // 子集价值缓存（位掩码）
  const cache = new Map<number, number>();
  const valueOf = (mask: number): number => {
    let v = cache.get(mask);
    if (v !== undefined) return v;
    const members: ContributorProb[] = [];
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) members.push(contributors[i]!);
    v = coalitionValue(members);
    cache.set(mask, v);
    return v;
  };
  // 阶乘权重
  const factorials = [1];
  for (let i = 1; i <= n; i += 1) factorials[i] = factorials[i - 1]! * i;

  for (let i = 0; i < n; i += 1) {
    let phi = 0;
    const others = n - 1;
    for (let subset = 0; subset < 1 << others; subset += 1) {
      // 把 others 位掩码展开为不含 i 的成员集
      let sMask = 0;
      let bit = 0;
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        if (subset & (1 << bit)) sMask |= 1 << j;
        bit += 1;
      }
      const sSize = popcount(sMask);
      const weight = (factorials[sSize]! * factorials[n - sSize - 1]!) / factorials[n]!;
      phi += weight * (valueOf(sMask | (1 << i)) - valueOf(sMask));
    }
    result.set(contributors[i]!.agentId, phi);
  }
  return result;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c += 1;
  }
  return c;
}

function round(x: number): number {
  return Number(x.toFixed(4));
}
