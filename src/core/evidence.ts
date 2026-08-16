/**
 * evidence.ts — 统一证据内核（项目 3.0「全层证据统一 + 自知之明」基石）
 *
 * 项目级质升前的问题（勘察结论）：
 * - 时间衰减 / Wilson 下界 / Beta 后验只服务于模型画像（ModelTaskStats）一层；
 *   蒸馏策略、语义记忆、程序记忆仍用裸 confidence + 裸计数，检索排序裸置信度；
 * - 沙盒校准读裸 avgQualityScore / totalCalls，旧证据与漂移无法感知；
 * - 各层统计口径（confidence / posteriorMean / wilsonLower）混用互不可比。
 *
 * 本内核把同一套统计语言铺到所有记忆层：
 * - wilsonLowerBound：小样本保守的置信下界（排序与校准的统一度量）
 * - decayFactor：时间衰减（30 天半衰期，旧证据自然让位）
 * - MemoryEvidence：可持久化的时间加权 Beta 证据（ws/wf/lastDecayedAt）
 * - observeEvidence：写入式观测（惰性衰减 + 累积，读取零开销）
 * - readEvidence：读取式视图（纯函数衰减，不回写）
 * - evidenceRankScore：证据化排序分（confidence × Wilson 下界等权混合；
 *   无证据时回退裸 confidence，行为与升级前逐位一致——并行旁路设计）
 *
 * 兼容性：旧格式记忆无 evidence 字段 → 首次观测时从裸计数按 0.5 折价初始化
 * （与模型画像 legacy 回退语义一致），confidence 更新公式保持不变。
 */

/** Wilson 置信下界（纯函数，全部层共享的统一不确定性度量） */
export function wilsonLowerBound(successes: number, failures: number, z = 1.96): number {
  const n = successes + failures;
  if (n <= 0) return 0;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/**
 * Wilson 置信上界（4.0：金丝雀/回归判定的「乐观边界」）
 *
 * 用途：只有当乐观边界也低于期望阈值时才确认劣化——单侧噪声不触发回滚。
 * 如 7/10 成功（raw 0.7 < 期望 0.85-0.1）但上界 0.89 ≥ 0.75 → 未确认，继续观察；
 * 0/5 全败上界 0.43 << 0.75 → 立即确认。
 */
export function wilsonUpperBound(successes: number, failures: number, z = 1.96): number {
  const n = successes + failures;
  if (n <= 0) return 1;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + margin) / denom);
}

/** 证据时间衰减半衰期（天）——30 天前的证据权重折半 */
export const DECAY_HALF_LIFE_DAYS = 30;
/** Beta 先验强度（均匀先验 Beta(1,1)） */
export const BAYES_PRIOR_STRENGTH = 1;
/** 证据参与排序/校准的最小有效样本量（低于此值回退裸 confidence） */
export const EVIDENCE_MIN_SAMPLES = 3;
/** 旧格式（无时间信息）证据折价系数 */
export const LEGACY_EVIDENCE_DISCOUNT = 0.5;
/** 排序混合权重：confidence 与 Wilson 下界各占一半 */
export const EVIDENCE_RANK_BLEND = 0.5;

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/** 时间衰减因子：0.5 ^ (elapsedMs / halfLife），未来时间不放大 */
export function decayFactor(elapsedMs: number, halfLifeDays: number = DECAY_HALF_LIFE_DAYS): number {
  if (elapsedMs <= 0) return 1;
  return Math.pow(0.5, elapsedMs / (halfLifeDays * DAY_MS));
}

/**
 * 可持久化的时间加权 Beta 证据
 *
 * 挂载于 DistilledStrategy / SemanticMemory / ProceduralMemory 的可选字段
 * evidence（并行旁路：不改变宿主实体的 confidence 语义）。
 */
export interface MemoryEvidence {
  /** 时间加权成功证据（半衰期 30 天惰性累积） */
  weightedSuccesses: number;
  /** 时间加权失败证据 */
  weightedFailures: number;
  /** 幂等衰减基准（上次证据衰减时间戳） */
  lastDecayedAt: number;
}

/** 从裸计数初始化证据（无时间信息 → 0.5 折价，与模型画像 legacy 回退一致） */
export function initEvidence(successes: number, total: number, at: number): MemoryEvidence {
  const failures = Math.max(0, total - Math.max(0, successes));
  return {
    weightedSuccesses: Math.max(0, successes) * LEGACY_EVIDENCE_DISCOUNT,
    weightedFailures: failures * LEGACY_EVIDENCE_DISCOUNT,
    lastDecayedAt: at,
  };
}

/** 写入式观测：先惰性衰减到 now，再计入新证据（原地更新，读取零开销） */
export function observeEvidence(evidence: MemoryEvidence, success: boolean, now: number): void {
  const decay = decayFactor(Math.max(0, now - evidence.lastDecayedAt));
  evidence.weightedSuccesses *= decay;
  evidence.weightedFailures *= decay;
  if (success) evidence.weightedSuccesses += 1;
  else evidence.weightedFailures += 1;
  evidence.lastDecayedAt = now;
}

/**
 * 加权观测（4.0：连续收益 0~1 的证据化，如进化引擎的 outcome reward）
 *
 * 把一次 value∈[0,1] 的连续观测拆为 success=value / failure=1-value 计入——
 * 布鲁厄姆/冯·诺依曼式分数观测：连续信号无需离散化即可进入统一 Beta 证据，
 * 时间衰减语义与 observeEvidence 完全一致。
 */
export function observeWeightedEvidence(evidence: MemoryEvidence, value: number, now: number): void {
  const v = Math.max(0, Math.min(1, value));
  const decay = decayFactor(Math.max(0, now - evidence.lastDecayedAt));
  evidence.weightedSuccesses *= decay;
  evidence.weightedFailures *= decay;
  evidence.weightedSuccesses += v;
  evidence.weightedFailures += 1 - v;
  evidence.lastDecayedAt = now;
}

/** 证据读取视图（Beta 后验 + Wilson 下界 + 有效样本量） */
export interface EvidenceView {
  weightedSuccesses: number;
  weightedFailures: number;
  effectiveSamples: number;
  posteriorMean: number;
  wilsonLower: number;
}

/** 读取式视图：纯函数衰减（不回写），供排序/报告/沙盒校准消费 */
export function readEvidence(evidence: MemoryEvidence, now: number): EvidenceView {
  const decay = decayFactor(Math.max(0, now - evidence.lastDecayedAt));
  const ws = evidence.weightedSuccesses * decay;
  const wf = evidence.weightedFailures * decay;
  const alpha = ws + BAYES_PRIOR_STRENGTH;
  const beta = wf + BAYES_PRIOR_STRENGTH;
  return {
    weightedSuccesses: ws,
    weightedFailures: wf,
    effectiveSamples: ws + wf,
    posteriorMean: alpha / (alpha + beta),
    wilsonLower: wilsonLowerBound(ws, wf),
  };
}

/**
 * 证据化排序分：confidence 与 Wilson 下界等权混合
 *
 * 质变：0.95 置信度但仅 3 次应用（下界 ≈ 0.44）的记忆，排序分 ≈ 0.70；
 * 0.85 置信度且 50 次应用 48 成（下界 ≈ 0.79）的记忆，排序分 ≈ 0.82——
 * 小样本高置信不再压过大样本稳置信。
 *
 * 兼容：无证据或有效样本 < EVIDENCE_MIN_SAMPLES → 原样返回 confidence
 * （与升级前排序行为逐位一致，既有消费方零感知）。
 */
export function evidenceRankScore(confidence: number, evidence: MemoryEvidence | undefined, now: number): number {
  if (!evidence) return confidence;
  const view = readEvidence(evidence, now);
  if (view.effectiveSamples < EVIDENCE_MIN_SAMPLES) return confidence;
  return EVIDENCE_RANK_BLEND * confidence + (1 - EVIDENCE_RANK_BLEND) * view.wilsonLower;
}
