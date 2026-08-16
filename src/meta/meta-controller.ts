/**
 * meta-controller.ts — 元认知控制器（第四阶段「元认知层」核心 2/2，implements IMetaCognitiveController）
 *
 * 职责：基于自我建模产出心智报告，自动调整操作环与进化环的运行参数——
 * 系统不仅进化策略（第三阶段内环），还进化「进化机制本身」（第四阶段外环），
 * 完成双环自治进化架构。
 *
 * 可调旋钮（与真实组件联动，经 read/write 回调落地）：
 * - reflector.autoDistillThreshold / distillMinConfidence：反思触发频率与蒸馏门槛
 * - evolver.mutationRate / minGain：进化器变异率与选择压力
 * - sandbox.evaluationSeeds：沙盒验证严格度（多种子统计门禁）
 * - optimizer.memoryFastPathThreshold：记忆层读取复用门槛
 *
 * 保守原则（安全内建，不依赖调用方自觉）：
 * 1. 每轮至多应用 maxAdjustmentsPerRound（缺省 1）个调整
 * 2. 每次只移动一个 step（旋钮自定义的小步长），绝不跳变
 * 3. 调整后进入观察窗（observationReports 份心智报告），期间不应用新调整
 * 4. 观察期满按 judgeMetric 判定：劣化超容忍 → 自动回滚；否则保留生效
 * 5. 手动接管优先：setManualOverride 的旋钮与全局 freeze 期间不做自动调整
 *
 * ── 2.0 质级升级：从「规则诊断 + 固定步长」到「学习型稳态控制」──
 * 1. 调参策略学习（AdjustmentLearner，乐观先验 Bandit）：每个「旋钮×方向」
 *    是一个学习臂，从 commit/rollback 历史估计各臂有效性并参与候选排序
 *    （权重随试验数增长）——元认知器进化自己的调参策略本身
 * 2. 综合判定护栏：任何调整若伴随操作环成功率显著劣化（超容忍），无论
 *    目标指标改善与否一律判失败——单指标优化不得以整体劣化为代价
 * 3. 稳态自适应步长：判定指标配置目标带（homeostasisBands）后，偏离带
 *    越远步长倍率越大（1~maxStepMultiplier 量化档位）；带内保持标准步长
 * 4. 经验安全包络：从 commit 取值学习安全区间（好值 ± 一步长），自动回滚
 *    发生过的取值记为已知劣化值——后续调整自动排除（prevention > rollback）
 * 5. 熔断器：单旋钮连续 breakerThreshold 次自动回滚 → 熔断该旋钮；
 *    全局连续 globalBreakerThreshold 次 → 全局熔断；reArmBreaker 手动复位
 * 6. 前瞻性调整：心智报告的前瞻风险（预测越限）注入候选——指标仍健康
 *    时提前行动（proactive），与反应式规则（reactive）互补
 *
 * 审计与可追溯：全部 adjust/commit/rollback/manual-override/skip/circuit-breaker
 * 动作全量写入审计日志并持久化（JSON）；rollbackLastAdjustment 支持手动回滚
 * 最近一次调整（无论观察中还是已提交）。
 */

import fs from 'node:fs';
import type {
  AdjustmentReport,
  AuditEntry,
  CircuitBreakerInfo,
  HomeostasisBands,
  JudgeMetric,
  KnobEffectiveness,
  MentalReport,
  MetaControllerState,
  RecommendedAdjustment,
  RollbackResult,
  SafeEnvelopeInfo,
} from './meta-types.js';
import { computeHomeostasis } from './self-model.js';
import type { SelfModel } from './self-model.js';

// ─────────────────────────── 调节旋钮 ───────────────────────────

/** 单个调节旋钮（参数热调整的最小单元） */
export interface AdjustmentKnob {
  /** 全局唯一 id（与心智报告 recommendedAdjustments.knob 对齐） */
  id: string;
  /** 人类可读标签 */
  label: string;
  /** 所属子系统（reflector / evolver / sandbox / memory） */
  category: 'reflector' | 'evolver' | 'sandbox' | 'memory';
  /** 允许取值范围 */
  min: number;
  max: number;
  /** 单次保守步长 */
  step: number;
  /** 整数旋钮（如种子数） */
  integer?: boolean;
  /** 读当前值 */
  read(): number;
  /** 写入新值（落地到真实组件；抛异常视为失败） */
  write(value: number): void;
  /** 调整效果判定指标 */
  judgeMetric: JudgeMetric;
  /** 判定指标方向：true 越高越好；false 越低越好 */
  higherIsBetter: boolean;
}

// ─────────────────────────── 配置与状态 ───────────────────────────

/** 元认知控制器配置 */
export interface MetaControllerConfig {
  /** 每轮最大调整数（保守原则；缺省 1） */
  maxAdjustmentsPerRound?: number;
  /** 观察窗：调整后需观察的心智报告份数（缺省 2） */
  observationReports?: number;
  /** 劣化容忍度（judgeMetric 相对劣化超过该值 → 回滚；缺省 0.02） */
  degradationTolerance?: number;
  /** 审计日志持久化路径（缺省不持久化） */
  persistPath?: string;
  /** 内存保留的审计条数（缺省 200） */
  auditLimit?: number;
  /** 调整应用回调（编排层广播 / 日志） */
  onAdjust?: (entry: AuditEntry) => void;
  /** 回滚回调（自动或手动） */
  onRollback?: (entry: AuditEntry) => void;
  /** 判定保留回调 */
  onCommit?: (entry: AuditEntry) => void;
  // ── 2.0：学习型稳态控制 ──
  /**
   * 稳态目标带：判定指标 → 期望区间。
   * 配置后：① 步长随偏离量化放大（1~maxStepMultiplier 档）；
   * ② 心智报告输出稳态带状态。缺省空 = 纯保守固定步长。
   */
  homeostasisBands?: HomeostasisBands;
  /** 稳态自适应步长上限（×step；缺省 3） */
  maxStepMultiplier?: number;
  /** 单旋钮连续自动回滚熔断阈值（缺省 2） */
  breakerThreshold?: number;
  /** 全局连续自动回滚熔断阈值（缺省 3） */
  globalBreakerThreshold?: number;
  /** 前瞻性调整开关（心智报告前瞻风险注入候选；缺省 true） */
  proactiveEnabled?: boolean;
}

/** 观察窗中的待判定调整 */
interface PendingAdjustment {
  knob: string;
  from: number;
  to: number;
  reason: string;
  reportsSeen: number;
  reportsNeeded: number;
  judgeMetric: JudgeMetric;
  higherIsBetter: boolean;
  baselineMetricValue: number;
  /** 2.0：判定时刻的全指标基线快照（护栏综合判定用） */
  baselineMetrics?: Record<JudgeMetric, number>;
  /** 2.0：调整方向（学习臂的组成部分） */
  direction?: 'up' | 'down';
  /** 2.0：调整来源（reactive / proactive） */
  source?: 'reactive' | 'proactive';
  appliedAt: number;
  /** 触发本次调整的 adjust 审计条目 id（手动回滚去重用） */
  adjustAuditId?: string;
}

/** 持久化负载 */
interface PersistPayload {
  audit: AuditEntry[];
  pending?: PendingAdjustment;
  frozen: boolean;
  manuallyFrozenKnobs: string[];
  rolledBackAdjustIds: string[];
  counters: { adjustments: number; rollbacks: number; commits: number };
  // ── 2.0 ──
  learner?: { arms: Record<string, ArmStats>; totalTrials: number };
  envelopeGood?: Record<string, number[]>;
  envelopeBad?: Record<string, number[]>;
  breakerCounters?: Record<string, number>;
  trippedBreakers?: string[];
  globalRollbackStreak?: number;
  frozenByBreaker?: boolean;
}

// ─────────────────── 2.0：调参策略学习器（乐观先验 Bandit） ───────────────────

/** 学习臂统计（臂 = 旋钮 × 方向） */
export interface ArmStats {
  trials: number;
  commits: number;
  rollbacks: number;
  /** 按指标原符号的效果增量累计 */
  effectSum: number;
}

/** 乐观先验（Beta 平滑）：冷启动臂保持探索吸引力 */
const ARM_PRIOR_MEAN = 0.7;
const ARM_PRIOR_WEIGHT = 2;

/**
 * 调参策略学习器
 *
 * 每个调整臂（旋钮×方向）维护 trials/commits/rollbacks/effectSum；
 * 选择评分 = (1−w)·规则优先级 + w·贝叶斯平滑成功率，其中
 * w = trials/(trials+2)——试验越多越信任学习结果，冷启动完全
 * 遵循规则优先级（行为向后兼容），随经验积累逐步接管排序。
 */
class AdjustmentLearner {
  private arms = new Map<string, ArmStats & { knob: string; direction: 'up' | 'down'; judgeMetric: JudgeMetric }>();
  totalTrials = 0;

  private key(knob: string, direction: 'up' | 'down'): string {
    return `${knob}:${direction}`;
  }

  private ensure(knob: string, direction: 'up' | 'down', judgeMetric: JudgeMetric) {
    const k = this.key(knob, direction);
    let arm = this.arms.get(k);
    if (!arm) {
      arm = { knob, direction, judgeMetric, trials: 0, commits: 0, rollbacks: 0, effectSum: 0 };
      this.arms.set(k, arm);
    }
    return arm;
  }

  /** 候选选择评分（规则优先级与学习有效性的加权融合） */
  selectionScore(rulePriority: number, knob: string, direction: 'up' | 'down', judgeMetric: JudgeMetric): number {
    const arm = this.arms.get(this.key(knob, direction));
    if (!arm || arm.trials === 0) return rulePriority; // 冷启动：完全遵循规则优先级
    const w = arm.trials / (arm.trials + 2);
    const learned = (arm.commits + ARM_PRIOR_MEAN * ARM_PRIOR_WEIGHT) / (arm.trials + ARM_PRIOR_WEIGHT);
    return (1 - w) * rulePriority + w * learned;
  }

  /** 记录一次判定结果 */
  record(
    knob: string,
    direction: 'up' | 'down',
    judgeMetric: JudgeMetric,
    committed: boolean,
    effectDelta: number,
  ): void {
    const arm = this.ensure(knob, direction, judgeMetric);
    arm.trials += 1;
    arm.effectSum += effectDelta;
    if (committed) arm.commits += 1;
    else arm.rollbacks += 1;
    this.totalTrials += 1;
  }

  /** 有效性快照（试验过的臂；供心智报告与状态面板） */
  effectiveness(): KnobEffectiveness[] {
    return [...this.arms.values()]
      .filter((a) => a.trials > 0)
      .map((a) => ({
        knob: a.knob,
        direction: a.direction,
        judgeMetric: a.judgeMetric,
        trials: a.trials,
        commits: a.commits,
        rollbacks: a.rollbacks,
        successRate: a.commits / a.trials,
        avgEffectDelta: a.effectSum / a.trials,
        effectivenessScore: (a.commits + ARM_PRIOR_MEAN * ARM_PRIOR_WEIGHT) / (a.trials + ARM_PRIOR_WEIGHT),
      }));
  }

  /** 平均学习置信权重（心智报告 explorationWeight） */
  averageConfidenceWeight(): number {
    const tried = [...this.arms.values()].filter((a) => a.trials > 0);
    if (tried.length === 0) return 0;
    return tried.reduce((s, a) => s + a.trials / (a.trials + 2), 0) / tried.length;
  }

  /** 手动探测某臂评分（测试/可观测） */
  peekScore(knob: string, direction: 'up' | 'down'): number | undefined {
    const arm = this.arms.get(this.key(knob, direction));
    if (!arm || arm.trials === 0) return undefined;
    return (arm.commits + ARM_PRIOR_MEAN * ARM_PRIOR_WEIGHT) / (arm.trials + ARM_PRIOR_WEIGHT);
  }

  dump(): { arms: Record<string, ArmStats>; totalTrials: number } {
    const arms: Record<string, ArmStats> = {};
    for (const [k, a] of this.arms) {
      arms[k] = { trials: a.trials, commits: a.commits, rollbacks: a.rollbacks, effectSum: a.effectSum };
    }
    return { arms, totalTrials: this.totalTrials };
  }

  load(data: { arms: Record<string, ArmStats>; totalTrials: number } | undefined, judgeMetricOf: (knob: string) => JudgeMetric): void {
    if (!data || typeof data.arms !== 'object') return;
    for (const [k, stats] of Object.entries(data.arms)) {
      const [knob, direction] = k.split(':');
      if (!knob || (direction !== 'up' && direction !== 'down')) continue;
      const arm = this.ensure(knob, direction, judgeMetricOf(knob));
      arm.trials = stats.trials ?? 0;
      arm.commits = stats.commits ?? 0;
      arm.rollbacks = stats.rollbacks ?? 0;
      arm.effectSum = stats.effectSum ?? 0;
    }
    this.totalTrials = typeof data.totalTrials === 'number' ? data.totalTrials : 0;
  }
}

// ─────────────────────────── 元认知控制器 ───────────────────────────

/**
 * 元认知控制器（implements IMetaCognitiveController）
 *
 * 被编排层持有：autonomy-loop 低频触发 evaluateAndAdjust（每 N 轮心跳），
 * 也可经 meta_cognition_* Tool 手动触发/审查/接管。
 */
export class MetaCognitiveController {
  private config: Required<Omit<MetaControllerConfig, 'persistPath' | 'onAdjust' | 'onRollback' | 'onCommit'>> &
    Pick<MetaControllerConfig, 'persistPath' | 'onAdjust' | 'onRollback' | 'onCommit'>;
  private selfModel: SelfModel;
  private knobs: Map<string, AdjustmentKnob> = new Map();
  private audit: AuditEntry[] = [];
  private pending?: PendingAdjustment;
  private frozen = false;
  private manuallyFrozenKnobs = new Set<string>();
  /** 已被回滚过的 adjust 审计 id（手动回滚去重） */
  private rolledBackAdjustIds = new Set<string>();
  private counters = { adjustments: 0, rollbacks: 0, commits: 0 };
  private auditSeq = 0;
  // ── 2.0：学习 / 安全 / 稳态 ──
  /** 调参策略学习器（乐观先验 Bandit） */
  private learner = new AdjustmentLearner();
  /** 安全包络：各旋钮的已验证好取值 / 已知劣化取值 */
  private envelopeGood = new Map<string, number[]>();
  private envelopeBad = new Map<string, number[]>();
  /** 熔断器：单旋钮连续自动回滚计数与已熔断旋钮 */
  private breakerCounters = new Map<string, number>();
  private trippedBreakers = new Set<string>();
  /** 全局连续自动回滚计数（跨旋钮） */
  private globalRollbackStreak = 0;
  /** 全局熔断标记（区别于手动 frozen） */
  private frozenByBreaker = false;

  constructor(params: { selfModel: SelfModel; knobs: AdjustmentKnob[]; config?: MetaControllerConfig }) {
    this.config = {
      maxAdjustmentsPerRound: 1,
      observationReports: 2,
      degradationTolerance: 0.02,
      auditLimit: 200,
      homeostasisBands: {},
      maxStepMultiplier: 3,
      breakerThreshold: 2,
      globalBreakerThreshold: 3,
      proactiveEnabled: true,
      ...params.config,
    };
    this.selfModel = params.selfModel;
    for (const knob of params.knobs) this.knobs.set(knob.id, knob);
    this.restore();
  }

  // ── IMetaCognitiveController 实现 ──

  /**
   * 评估并调整（外环主入口；状态机单步推进）
   *
   * 每次调用 = 一份新心智报告 + 至多一个状态转移：
   * 观察窗满 → 判定（commit / rollback）；空闲 → 应用一个保守调整；
   * 观察中 → 仅累计进度；冻结 → no-op。
   *
   * 2.0：判定带护栏综合评判（学习器/包络/熔断器同步更新）；
   * 候选 = 反应式推荐 ∪ 前瞻风险建议，经学习器排序后保守应用
   * （稳态自适应步长 + 安全包络钳制 + 已知劣化值排除）。
   */
  async evaluateAndAdjust(): Promise<AdjustmentReport> {
    const report = await this.selfModel.generateMentalReport();

    // ── 1. 观察窗判定优先 ──
    if (this.pending) {
      this.pending.reportsSeen += 1;
      if (this.pending.reportsSeen < this.pending.reportsNeeded) {
        return this.buildReport('observing', report, {
          observation: {
            knob: this.pending.knob,
            reportsSeen: this.pending.reportsSeen,
            reportsNeeded: this.pending.reportsNeeded,
          },
        });
      }
      const verdict = this.judge(this.pending, report);
      const knob = this.knobs.get(this.pending.knob);
      const direction = this.pending.direction ?? 'up';
      const source = this.pending.source;
      if (verdict.good || !knob) {
        // 保留生效：未劣化（或小幅波动在容忍内）且护栏未违反
        const entry = this.appendAudit({
          type: 'commit',
          knob: this.pending.knob,
          from: this.pending.from,
          to: this.pending.to,
          reason: `观察 ${this.pending.reportsNeeded} 份报告：${verdict.detail}，调整保留生效`,
          effect: verdict.effect,
          guardrail: verdict.guardrail,
          source,
          reportIndex: report.reportIndex,
        });
        this.counters.commits += 1;
        // 2.0：学习器记录成功 + 包络收录好值 + 熔断器计数复位
        this.learner.record(this.pending.knob, direction, this.pending.judgeMetric, true, verdict.effect.delta);
        this.recordGoodValue(this.pending.knob, this.pending.to);
        this.onJudgedCommit(this.pending.knob);
        this.config.onCommit?.(entry);
        const result = this.buildReport('committed', report, {
          committed: { knob: this.pending.knob, effect: verdict.effect },
        });
        this.pending = undefined;
        this.persist();
        return result;
      }
      // 自动回滚：劣化超容忍或护栏违反
      let rolledBackTo = this.pending.to;
      try {
        knob.write(this.pending.from);
        rolledBackTo = this.pending.from;
      } catch {
        /* 写回失败保留审计记录，下轮重试判定 */
      }
      const entry = this.appendAudit({
        type: 'rollback',
        knob: this.pending.knob,
        from: this.pending.to,
        to: rolledBackTo,
        reason: `观察期判定劣化（${verdict.detail}），自动回滚参数`,
        effect: verdict.effect,
        guardrail: verdict.guardrail,
        source,
        reportIndex: report.reportIndex,
      });
      this.counters.rollbacks += 1;
      this.rolledBackAdjustIds.add(this.pending.adjustAuditId ?? '');
      // 2.0：学习器记录失败 + 包络标记劣化值 + 熔断器计数推进
      this.learner.record(this.pending.knob, direction, this.pending.judgeMetric, false, verdict.effect.delta);
      this.recordBadValue(this.pending.knob, this.pending.to);
      this.onJudgedRollback(this.pending.knob);
      this.config.onRollback?.(entry);
      const result = this.buildReport('rolled-back', report, {
        rolledBack: {
          knob: this.pending.knob,
          from: this.pending.to,
          to: rolledBackTo,
          reason: entry.reason,
          effect: verdict.effect,
        },
      });
      this.pending = undefined;
      this.persist();
      return result;
    }

    // ── 2. 冻结检查（手动冻结 或 全局熔断） ──
    if (this.frozen) {
      return this.buildReport('frozen', report, { skippedReason: '自动调整已被手动冻结（setFrozen）' });
    }
    if (this.frozenByBreaker) {
      return this.buildReport('frozen', report, {
        skippedReason: `连续 ${this.config.globalBreakerThreshold} 次自动回滚触发全局熔断（reArmBreaker 可复位）`,
      });
    }

    // ── 3. 构建候选（反应式推荐 ∪ 前瞻风险建议）──
    const candidates: Array<RecommendedAdjustment & { source: 'reactive' | 'proactive' }> = report.recommendedAdjustments
      .filter((r) => this.knobs.has(r.knob) && !this.manuallyFrozenKnobs.has(r.knob) && !this.trippedBreakers.has(r.knob))
      .map((r) => ({ ...r, source: 'reactive' as const }));

    if (this.config.proactiveEnabled && report.proactiveRisks) {
      for (const risk of report.proactiveRisks) {
        const knob = this.knobs.get(risk.suggestedKnob);
        if (!knob) continue;
        if (this.manuallyFrozenKnobs.has(knob.id) || this.trippedBreakers.has(knob.id)) continue;
        if (candidates.some((c) => c.knob === knob.id && c.direction === risk.suggestedDirection)) continue;
        candidates.push({
          knob: knob.id,
          label: knob.label,
          direction: risk.suggestedDirection,
          reason: `[前瞻] ${risk.description}，在指标仍健康时提前调整`,
          priority: risk.urgency,
          source: 'proactive',
        });
      }
    }

    if (candidates.length === 0) {
      const tripped = [...this.trippedBreakers];
      return this.buildReport('no-op', report, {
        skippedReason:
          tripped.length > 0
            ? `无可用候选（推荐旋钮被手动接管或已熔断：${tripped.join('、')}）`
            : '无匹配旋钮或全部被手动接管',
      });
    }

    // 2.0：学习器排序（规则优先级 × 学习有效性；冷启动臂退化为规则优先级 → 行为向后兼容）
    candidates.sort(
      (a, b) =>
        this.learner.selectionScore(b.priority, b.knob, b.direction, this.knobs.get(b.knob)!.judgeMetric) -
        this.learner.selectionScore(a.priority, a.knob, a.direction, this.knobs.get(a.knob)!.judgeMetric),
    );

    // ── 4. 保守应用一个调整（稳态自适应步长 + 安全包络） ──
    const applied: AdjustmentReport['applied'] = [];
    for (const rec of candidates) {
      if (applied.length >= this.config.maxAdjustmentsPerRound) break;
      const knob = this.knobs.get(rec.knob)!;
      const current = knob.read();
      const direction = rec.direction === 'up' ? 1 : -1;

      // 2.0：稳态自适应步长——判定指标偏离目标带越远步长越大（量化档位）
      const stepMultiplier = this.stepMultiplierFor(knob, report);
      let next = current + direction * knob.step * stepMultiplier;
      next = knob.integer ? Math.round(next) : Number(next.toFixed(6));

      // 2.0：安全包络钳制（经验学习的安全区间优先于旋钮原始边界）
      const envelope = this.envelopeOf(knob);
      next = Math.max(envelope.min, Math.min(envelope.max, next));
      if (knob.integer) next = Math.round(next);

      if (next === current) continue; // 已到边界/包络缘，换下一个候选
      if (this.isKnownBadValue(knob, next)) continue; // 已知劣化取值，预防性跳过

      try {
        knob.write(next);
      } catch {
        continue;
      }

      const entry = this.appendAudit({
        type: 'adjust',
        knob: knob.id,
        from: current,
        to: next,
        reason: rec.reason,
        source: rec.source,
        reportIndex: report.reportIndex,
      });
      this.counters.adjustments += 1;
      this.config.onAdjust?.(entry);

      applied.push({ knob: knob.id, label: knob.label, from: current, to: next, reason: rec.reason, source: rec.source });
      this.pending = {
        knob: knob.id,
        from: current,
        to: next,
        reason: rec.reason,
        reportsSeen: 0,
        reportsNeeded: this.config.observationReports,
        judgeMetric: knob.judgeMetric,
        higherIsBetter: knob.higherIsBetter,
        baselineMetricValue: this.extractMetric(report, knob.judgeMetric),
        baselineMetrics: this.snapshotAllMetrics(report),
        direction: rec.direction,
        source: rec.source,
        appliedAt: Date.now(),
        adjustAuditId: entry.id,
      };
      break; // 保守原则：一轮只调一个
    }

    if (applied.length === 0) {
      return this.buildReport('no-op', report, { skippedReason: '推荐旋钮均已到达边界或命中已知劣化值，无可应用调整' });
    }

    this.persist();
    return this.buildReport('adjusted', report, {
      applied,
      observation: {
        knob: this.pending!.knob,
        reportsSeen: 0,
        reportsNeeded: this.pending!.reportsNeeded,
      },
    });
  }

  /**
   * 手动回滚最近一次调整
   *
   * 优先回滚观察窗中的调整；无观察中调整时回滚最近一次已提交
   * （未被回滚过）的调整。全部审计留痕。
   */
  async rollbackLastAdjustment(): Promise<RollbackResult> {
    // 路径 1：观察窗中的调整
    if (this.pending) {
      const knob = this.knobs.get(this.pending.knob);
      const { knob: knobId, from, to, reason } = this.pending;
      if (!knob) {
        this.pending = undefined;
        return { success: false, reason: '旋钮未注册', message: `旋钮 ${knobId} 未注册，仅清除观察状态` };
      }
      try {
        knob.write(from);
      } catch (error) {
        return { success: false, knob: knobId, reason: '写回失败', message: `回滚写回失败：${(error as Error).message}` };
      }
      const entry = this.appendAudit({
        type: 'rollback',
        knob: knobId,
        from: to,
        to: from,
        reason: `手动回滚观察中的调整（原调整理由：${reason}）`,
      });
      this.counters.rollbacks += 1;
      if (this.pending.adjustAuditId) this.rolledBackAdjustIds.add(this.pending.adjustAuditId);
      this.pending = undefined;
      this.persist();
      this.config.onRollback?.(entry);
      return {
        success: true,
        knob: knobId,
        from: to,
        to: from,
        reason: '手动回滚观察中的调整',
        message: `旋钮 ${knobId} 已从 ${to} 回滚到 ${from}`,
      };
    }

    // 路径 2：最近一次已提交且未回滚过的调整
    for (let i = this.audit.length - 1; i >= 0; i -= 1) {
      const entry = this.audit[i];
      if (entry.type !== 'adjust' && entry.type !== 'commit') continue;
      if (entry.type === 'commit') {
        // commit 引用的原 adjust 已记录；继续向前找对应 adjust
        continue;
      }
      if (entry.knob === undefined || entry.to === undefined || entry.from === undefined) continue;
      if (this.rolledBackAdjustIds.has(entry.id)) continue;
      const knob = this.knobs.get(entry.knob);
      if (!knob) continue;
      try {
        knob.write(entry.from);
      } catch (error) {
        return {
          success: false,
          knob: entry.knob,
          reason: '写回失败',
          message: `回滚写回失败：${(error as Error).message}`,
        };
      }
      this.rolledBackAdjustIds.add(entry.id);
      const rollbackEntry = this.appendAudit({
        type: 'rollback',
        knob: entry.knob,
        from: entry.to,
        to: entry.from,
        reason: `手动回滚已提交的调整（原调整理由：${entry.reason}）`,
      });
      this.counters.rollbacks += 1;
      this.persist();
      this.config.onRollback?.(rollbackEntry);
      return {
        success: true,
        knob: entry.knob,
        from: entry.to,
        to: entry.from,
        reason: '手动回滚已提交的调整',
        message: `旋钮 ${entry.knob} 已从 ${entry.to} 回滚到 ${entry.from}`,
      };
    }

    return { success: false, reason: '无可回滚的调整', message: '审计日志中不存在未回滚的调整记录' };
  }

  // ── 手动接管（优先于自动调整） ──

  /** 手动覆盖旋钮值：写入后该旋钮冻结自动调整（人工优先） */
  setManualOverride(knobId: string, value: number): RollbackResult {
    const knob = this.knobs.get(knobId);
    if (!knob) return { success: false, reason: '旋钮未注册', message: `旋钮 ${knobId} 不存在` };
    const from = knob.read();
    const clamped = Math.max(knob.min, Math.min(knob.max, knob.integer ? Math.round(value) : value));
    try {
      knob.write(clamped);
    } catch (error) {
      return { success: false, knob: knobId, reason: '写入失败', message: `手动覆盖失败：${(error as Error).message}` };
    }
    this.manuallyFrozenKnobs.add(knobId);
    // 若观察中的正是该旋钮 → 撤销观察（人工已接管）
    if (this.pending?.knob === knobId) this.pending = undefined;
    const entry = this.appendAudit({
      type: 'manual-override',
      knob: knobId,
      from,
      to: clamped,
      reason: `手动覆盖取值（自动调整已对该旋钮冻结）`,
    });
    this.persist();
    void entry;
    return {
      success: true,
      knob: knobId,
      from,
      to: clamped,
      reason: '手动覆盖',
      message: `旋钮 ${knobId} 已手动设为 ${clamped}（原值 ${from}），该旋钮自动调整已冻结`,
    };
  }

  /** 解除旋钮的手动接管（恢复自动调整资格） */
  clearManualOverride(knobId: string): boolean {
    const removed = this.manuallyFrozenKnobs.delete(knobId);
    if (removed) {
      this.appendAudit({ type: 'freeze', knob: knobId, reason: '解除手动接管，恢复自动调整' });
      this.persist();
    }
    return removed;
  }

  /** 全局冻结 / 解冻自动调整 */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (frozen && this.pending) {
      // 冻结时保留 pending 状态（解冻后继续观察），仅阻断新调整
    }
    this.appendAudit({ type: 'freeze', reason: frozen ? '全局冻结自动调整（手动接管）' : '解除全局冻结' });
    this.persist();
  }

  /** 运行状态（meta_cognition_status Tool / 审查入口） */
  getState(): MetaControllerState {
    const effectiveness = this.learner.effectiveness();
    return {
      frozen: this.frozen,
      manuallyFrozenKnobs: [...this.manuallyFrozenKnobs],
      circuitBreakers: this.breakerPanel(),
      frozenByBreaker: this.frozenByBreaker,
      learner: {
        totalTrials: this.learner.totalTrials,
        arms: effectiveness.length,
        explorationWeight: this.learner.averageConfidenceWeight(),
        effectiveness,
      },
      safeEnvelopes: [...this.knobs.values()].map((k) => this.envelopeOf(k)),
      pending: this.pending
        ? {
            knob: this.pending.knob,
            from: this.pending.from,
            to: this.pending.to,
            reason: this.pending.reason,
            reportsSeen: this.pending.reportsSeen,
            reportsNeeded: this.pending.reportsNeeded,
            judgeMetric: this.pending.judgeMetric,
            baselineMetricValue: this.pending.baselineMetricValue,
          }
        : undefined,
      knobs: [...this.knobs.values()].map((k) => ({
        id: k.id,
        label: k.label,
        category: k.category,
        current: k.read(),
        min: k.min,
        max: k.max,
        step: k.step,
        manuallyFrozen: this.manuallyFrozenKnobs.has(k.id),
        breakerTripped: this.trippedBreakers.has(k.id),
      })),
      auditTrail: [...this.audit],
      totalAdjustments: this.counters.adjustments,
      totalRollbacks: this.counters.rollbacks,
      totalCommits: this.counters.commits,
    };
  }

  /** 审计日志（全量，升序） */
  getAuditTrail(): AuditEntry[] {
    return [...this.audit];
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * 观察期满判定：劣化超容忍 → 回滚
   *
   * 2.0 综合判定护栏：目标指标未劣化但操作环成功率显著下滑 → 一律判失败。
   * 单指标优化不得以整体劣化为代价（guardrail violated → rollback）。
   */
  private judge(
    pending: PendingAdjustment,
    report: MentalReport,
  ): {
    good: boolean;
    effect: NonNullable<AuditEntry['effect']>;
    guardrail?: AuditEntry['guardrail'];
    detail: string;
  } {
    const after = this.extractMetric(report, pending.judgeMetric);
    const before = pending.baselineMetricValue;
    const delta = after - before;
    // 按指标方向归一：progress > 0 = 改善，< 0 = 劣化
    const progress = pending.higherIsBetter ? delta : -delta;
    let good = progress >= -this.config.degradationTolerance;
    const metricLabel = JUDGE_METRIC_LABELS[pending.judgeMetric];
    let detail = `${metricLabel} ${before.toFixed(4)} → ${after.toFixed(4)}（${progress >= 0 ? '改善' : '劣化'} ${Math.abs(progress).toFixed(4)}，容忍 ${this.config.degradationTolerance}）`;

    // 2.0：护栏——操作环成功率显著劣化则一票否决（判定指标本身即操作环成功率时跳过）
    let guardrail: AuditEntry['guardrail'] | undefined;
    if (pending.baselineMetrics && pending.judgeMetric !== 'operationalSuccessRate') {
      const grBefore = pending.baselineMetrics.operationalSuccessRate;
      const grAfter = this.extractMetric(report, 'operationalSuccessRate');
      const violated = grAfter < grBefore - this.config.degradationTolerance;
      guardrail = {
        metric: 'operationalSuccessRate',
        before: grBefore,
        after: grAfter,
        delta: grAfter - grBefore,
        violated,
      };
      if (violated) {
        good = false;
        detail += `；护栏违规：操作环成功率 ${grBefore.toFixed(4)} → ${grAfter.toFixed(4)}（劣化 ${(grBefore - grAfter).toFixed(4)}）`;
      }
    }

    return {
      good,
      effect: {
        metric: pending.judgeMetric,
        before,
        after,
        delta,
        good,
      },
      guardrail,
      detail,
    };
  }

  /** 全指标基线快照（护栏综合判定的 before 数据） */
  private snapshotAllMetrics(report: MentalReport): Record<JudgeMetric, number> {
    return {
      operationalSuccessRate: this.extractMetric(report, 'operationalSuccessRate'),
      discoveryRate: this.extractMetric(report, 'discoveryRate'),
      proceduralGrowth: this.extractMetric(report, 'proceduralGrowth'),
      pendingDistillation: this.extractMetric(report, 'pendingDistillation'),
      survivalRate: this.extractMetric(report, 'survivalRate'),
    };
  }

  // ── 2.0：稳态自适应步长 ──

  /**
   * 稳态步长倍率（1~maxStepMultiplier）：
   * 判定指标配置了目标带 → 偏离带越远倍率越大（比例控制，量化档位）；
   * 未配置目标带 → 1（行为与 1.0 固定步长一致）。
   */
  private stepMultiplierFor(knob: AdjustmentKnob, report: MentalReport): number {
    const band = this.config.homeostasisBands[knob.judgeMetric];
    if (!band) return 1;
    const current = this.extractMetric(report, knob.judgeMetric);
    const { deviation } = computeHomeostasis(band, current);
    if (deviation <= 0) return 1; // 带内 / 贴边：标准步长
    const raw = 1 + deviation * 2; // 偏离 50% → ×2；≥100% → ×3
    return Math.max(1, Math.min(Math.ceil(raw), this.config.maxStepMultiplier));
  }

  // ── 2.0：经验安全包络 ──

  /** 旋钮当前安全包络：有 commit 好值 → 好值区间 ± 一步长；否则旋钮原始边界 */
  private envelopeOf(knob: AdjustmentKnob): SafeEnvelopeInfo {
    const good = this.envelopeGood.get(knob.id) ?? [];
    const bad = this.envelopeBad.get(knob.id) ?? [];
    if (good.length === 0) {
      return { knob: knob.id, min: knob.min, max: knob.max, source: 'default', sampleCount: 0, knownBadValues: bad };
    }
    const learnedMin = Math.max(knob.min, Number((Math.min(...good) - knob.step).toFixed(6)));
    const learnedMax = Math.min(knob.max, Number((Math.max(...good) + knob.step).toFixed(6)));
    return { knob: knob.id, min: learnedMin, max: learnedMax, source: 'learned', sampleCount: good.length, knownBadValues: bad };
  }

  /** 已知劣化值判定（数值直接相等，或整数旋钮按四舍五入相等） */
  private isKnownBadValue(knob: AdjustmentKnob, value: number): boolean {
    const bad = this.envelopeBad.get(knob.id);
    if (!bad || bad.length === 0) return false;
    return bad.some((b) => (knob.integer ? Math.round(b) === Math.round(value) : b === value));
  }

  /** commit 判定后收录好值（安全包络的「已验证安全」样本） */
  private recordGoodValue(knobId: string, value: number): void {
    const values = this.envelopeGood.get(knobId) ?? [];
    if (!values.includes(value)) values.push(value);
    if (values.length > 8) values.shift(); // 有界记忆：只保留最近 8 个好值
    this.envelopeGood.set(knobId, values);
  }

  /** 自动回滚后标记劣化值（后续调整预防性排除） */
  private recordBadValue(knobId: string, value: number): void {
    const values = this.envelopeBad.get(knobId) ?? [];
    if (!values.includes(value)) values.push(value);
    if (values.length > 8) values.shift();
    this.envelopeBad.set(knobId, values);
  }

  // ── 2.0：熔断器 ──

  /** 单次判定保留：该旋钮连续回滚清零、全局连续回滚清零 */
  private onJudgedCommit(knobId: string): void {
    this.breakerCounters.set(knobId, 0);
    this.globalRollbackStreak = 0;
  }

  /** 单次判定回滚：推进单旋钮与全局连续回滚计数，达阈值触发熔断 */
  private onJudgedRollback(knobId: string): void {
    // 单旋钮熔断
    const knobStreak = (this.breakerCounters.get(knobId) ?? 0) + 1;
    this.breakerCounters.set(knobId, knobStreak);
    if (knobStreak >= this.config.breakerThreshold && !this.trippedBreakers.has(knobId)) {
      this.trippedBreakers.add(knobId);
      this.appendAudit({
        type: 'circuit-breaker',
        knob: knobId,
        reason: `旋钮连续 ${knobStreak} 次自动回滚，熔断其自动调整（reArmBreaker 可复位）`,
      });
    }

    // 全局熔断
    this.globalRollbackStreak += 1;
    if (this.globalRollbackStreak >= this.config.globalBreakerThreshold && !this.frozenByBreaker) {
      this.frozenByBreaker = true;
      this.appendAudit({
        type: 'circuit-breaker',
        reason: `全局连续 ${this.globalRollbackStreak} 次自动回滚，触发全局熔断（reArmBreaker 可复位）`,
      });
    }
  }

  /** 熔断器面板（getState / 心智报告共享） */
  private breakerPanel(): CircuitBreakerInfo[] {
    return [...this.knobs.values()].map((k) => {
      const streak = this.breakerCounters.get(k.id) ?? 0;
      const tripped = this.trippedBreakers.has(k.id);
      return {
        knob: k.id,
        consecutiveRollbacks: streak,
        tripped,
        reason: tripped ? `连续 ${streak} 次自动回滚熔断` : undefined,
      };
    });
  }

  /**
   * 熔断器手动复位（公共 API）
   *
   * - 指定 knobId：复位该旋钮熔断（清零计数 + 解除熔断）
   * - 不指定：复位全局熔断 + 全部旋钮熔断与计数
   * 返回是否发生了实际复位动作。
   */
  reArmBreaker(knobId?: string): boolean {
    if (knobId) {
      const had = this.trippedBreakers.delete(knobId);
      const streak = this.breakerCounters.get(knobId) ?? 0;
      this.breakerCounters.set(knobId, 0);
      if (had || streak > 0) {
        this.appendAudit({ type: 'circuit-breaker', knob: knobId, reason: '手动复位旋钮熔断器，恢复自动调整' });
        this.persist();
        return true;
      }
      return false;
    }
    const anyTripped = this.frozenByBreaker || this.trippedBreakers.size > 0;
    this.frozenByBreaker = false;
    this.trippedBreakers.clear();
    this.breakerCounters.clear();
    this.globalRollbackStreak = 0;
    if (anyTripped) {
      this.appendAudit({ type: 'circuit-breaker', reason: '手动复位全局与全部旋钮熔断器，恢复自动调整' });
      this.persist();
    }
    return anyTripped;
  }

  /** 从心智报告提取判定指标 */
  private extractMetric(report: MentalReport, metric: JudgeMetric): number {
    switch (metric) {
      case 'operationalSuccessRate':
        return report.strategyPerformance.operational.successRate;
      case 'discoveryRate':
        return report.evolverEfficiency.discoveryRate;
      case 'proceduralGrowth':
        return report.memoryQuality.counts.procedural;
      case 'pendingDistillation':
        return report.memoryQuality.distillation.pendingSinceLastDistillation;
      case 'survivalRate':
        return report.evolverEfficiency.survivalRate;
    }
  }

  private appendAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'> & { adjustAuditId?: string }): AuditEntry {
    this.auditSeq += 1;
    const full: AuditEntry = {
      id: `audit-${this.auditSeq}`,
      timestamp: Date.now(),
      type: entry.type,
      knob: entry.knob,
      from: entry.from,
      to: entry.to,
      reason: entry.reason,
      effect: entry.effect,
      guardrail: entry.guardrail,
      source: entry.source,
      reportIndex: entry.reportIndex,
    };
    this.audit.push(full);
    if (this.audit.length > this.config.auditLimit) this.audit.shift();
    return full;
  }

  private buildReport(
    status: AdjustmentReport['status'],
    mentalReport: MentalReport,
    extra: Partial<AdjustmentReport> = {},
  ): AdjustmentReport {
    return {
      timestamp: new Date().toISOString(),
      reportIndex: mentalReport.reportIndex,
      status,
      applied: extra.applied ?? [],
      rolledBack: extra.rolledBack,
      committed: extra.committed,
      observation: extra.observation,
      skippedReason: extra.skippedReason,
      mentalReport,
    };
  }

  // ─────────────────────────── 持久化 ───────────────────────────

  private persist(): void {
    if (!this.config.persistPath) return;
    try {
      const payload: PersistPayload & { auditSeq?: number } = {
        audit: this.audit,
        pending: this.pending,
        frozen: this.frozen,
        manuallyFrozenKnobs: [...this.manuallyFrozenKnobs],
        rolledBackAdjustIds: [...this.rolledBackAdjustIds],
        counters: this.counters,
        auditSeq: this.auditSeq,
        // 2.0：学习器 / 安全包络 / 熔断器
        learner: this.learner.dump(),
        envelopeGood: Object.fromEntries(this.envelopeGood),
        envelopeBad: Object.fromEntries(this.envelopeBad),
        breakerCounters: Object.fromEntries(this.breakerCounters),
        trippedBreakers: [...this.trippedBreakers],
        globalRollbackStreak: this.globalRollbackStreak,
        frozenByBreaker: this.frozenByBreaker,
      };
      fs.writeFileSync(this.config.persistPath, JSON.stringify(payload), 'utf-8');
    } catch {
      /* 持久化失败不影响运行 */
    }
  }

  private restore(): void {
    if (!this.config.persistPath || !fs.existsSync(this.config.persistPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.config.persistPath, 'utf-8')) as PersistPayload & {
        auditSeq?: number;
      };
      if (Array.isArray(parsed.audit)) this.audit = parsed.audit;
      this.pending = parsed.pending;
      this.frozen = parsed.frozen === true;
      this.manuallyFrozenKnobs = new Set(parsed.manuallyFrozenKnobs ?? []);
      this.rolledBackAdjustIds = new Set(parsed.rolledBackAdjustIds ?? []);
      if (parsed.counters) this.counters = parsed.counters;
      if (typeof parsed.auditSeq === 'number') this.auditSeq = parsed.auditSeq;
      // 2.0：学习器 / 安全包络 / 熔断器（缺省字段向后兼容旧持久化文件）
      this.learner.load(parsed.learner, (knob) => this.knobs.get(knob)?.judgeMetric ?? 'operationalSuccessRate');
      this.envelopeGood = new Map(Object.entries(parsed.envelopeGood ?? {}).map(([k, v]) => [k, [...v]]));
      this.envelopeBad = new Map(Object.entries(parsed.envelopeBad ?? {}).map(([k, v]) => [k, [...v]]));
      this.breakerCounters = new Map(Object.entries(parsed.breakerCounters ?? {}));
      this.trippedBreakers = new Set(parsed.trippedBreakers ?? []);
      this.globalRollbackStreak = parsed.globalRollbackStreak ?? 0;
      this.frozenByBreaker = parsed.frozenByBreaker === true;
    } catch {
      /* 损坏文件忽略，从零开始 */
    }
  }
}

/** 判定指标人类可读标签 */
const JUDGE_METRIC_LABELS: Record<JudgeMetric, string> = {
  operationalSuccessRate: '操作环成功率',
  discoveryRate: '进化发现速率',
  proceduralGrowth: '程序记忆累积量',
  pendingDistillation: '蒸馏积压水位',
  survivalRate: '新策略存活率',
};
