/**
 * decision-engine.ts — 战略决策引擎（闭环"决策"环节深度优化）
 *
 * 职责：在 strategist LLM 决策之上构建四级决策流水线，
 * 让高频/已知信号以近零成本、近零延迟获得决策，LLM 只处理真正的新信号。
 *
 * 四级流水线（命中即返回，逐级下沉）：
 * 1. 规则快速路径（rule）：确定性强的高置信规则
 *    - 重复抑制：同指纹信号在抑制窗口内已成功执行 → dismiss（避免重复劳动）
 *    - 失败升级：同类型连续失败 ≥ N 次 → ask-user（止损，防止无效重试循环）
 *    - 突发提权：occurrences 突发放大 → 提升 urgency
 * 2. 决策缓存（cache）：同指纹信号的历史决策复用（TTL + 结果反馈修正置信度）
 * 3. strategist 模型（strategist）：新信号交给 LLM 决策（注入历史统计上下文）
 * 4. 启发式兜底（heuristic）：strategist 失败时的保守决策
 *
 * 升级点（相对裸 LLM 决策的质的提升）：
 * 1. 成本/影响估算：基于长期记忆的 avgExecutionTime / tokenCost 预估执行成本，
 *    高成本 + 低紧急度 → 自动 defer，把算力留给关键任务
 * 2. 置信度评分：每个决策携带 confidence，低于阈值自动升级为 ask-user
 * 3. 结果反馈闭环：recordOutcome 依据实际结果修正缓存置信度与规则计数器，
 *    决策系统随运行时间自我校准
 * 4. 决策审计：保留最近决策记录，可追溯每个决策的来源与理由
 */

import crypto from 'node:crypto';
import type { Signal } from './sentinel.js';

/** 决策动作 */
export type DecisionAction = 'execute' | 'defer' | 'dismiss' | 'ask-user';

/** 决策结果 */
export interface Decision {
  action: DecisionAction;
  urgency: number;
  /** 置信度 0~1 */
  confidence: number;
  reason: string;
  /** 决策来源：规则 / 缓存 / strategist / 启发式 */
  source: 'rule' | 'cache' | 'strategist' | 'heuristic';
  deferMs?: number;
  /** 预估执行成本（token 量级） */
  estimatedCost?: number;
  decidedAt: number;
}

/** 决策引擎配置 */
export interface DecisionEngineConfig {
  /** 决策缓存 TTL（毫秒） */
  cacheTtlMs: number;
  /** 缓存容量上限 */
  cacheMaxSize: number;
  /** 重复抑制窗口（毫秒）：窗口内同指纹成功执行过的信号直接 dismiss */
  suppressionWindowMs: number;
  /** 同类型连续失败达到该次数后升级为 ask-user */
  failureEscalationThreshold: number;
  /** 低于该置信度的决策升级为 ask-user */
  lowConfidenceThreshold: number;
  /** 成本延迟比：预估成本超过该值 × 历史均值 且 urgency < 0.3 时 defer */
  costDeferRatio: number;
  /** 突发判定：occurrences 达到该值视为突发 */
  burstOccurrences: number;
  /** strategist 决策器（注入，通常为 LLM 调用） */
  strategist?: (signals: Signal[], context: Map<string, SignalHistoryStats>) => Promise<Map<string, StrategistVerdict>>;
}

/** strategist 对单信号的裁定 */
export interface StrategistVerdict {
  urgency: number;
  decision: DecisionAction;
  reason?: string;
  deferMs?: number;
}

/** 信号历史统计（由长期记忆提供，注入决策上下文） */
export interface SignalHistoryStats {
  totalDecisions: number;
  successRate: number;
  avgExecutionTime: number;
  avgTokenCost: number;
}

/** 决策审计记录 */
export interface DecisionAuditEntry {
  signalId: string;
  fingerprint: string;
  decision: Decision;
  /** 事后结果反馈 */
  outcome?: 'excellent' | 'good' | 'acceptable' | 'poor' | 'failed';
}

/** 缓存条目 */
interface CacheEntry {
  decision: Decision;
  hits: number;
  /** 反馈修正后的置信度 */
  adjustedConfidence: number;
}

/** 默认配置 */
export const DEFAULT_DECISION_ENGINE_CONFIG: DecisionEngineConfig = {
  cacheTtlMs: 10 * 60_000,
  cacheMaxSize: 512,
  suppressionWindowMs: 5 * 60_000,
  failureEscalationThreshold: 3,
  lowConfidenceThreshold: 0.4,
  costDeferRatio: 3,
  burstOccurrences: 5,
};

/** outcome → 决策质量数值 */
const OUTCOME_VALUE: Record<string, number> = {
  excellent: 1,
  good: 0.8,
  acceptable: 0.6,
  poor: 0.3,
  failed: 0,
};

/**
 * 战略决策引擎
 *
 * 被 index.ts 编排层持有：processBatch 的第 3~4 步由本引擎完成。
 */
export class DecisionEngine {
  private config: DecisionEngineConfig;
  private cache = new Map<string, CacheEntry>();
  /** 类型 → 连续失败计数 */
  private consecutiveFailures = new Map<string, number>();
  /** 指纹 → 最近成功执行时间（重复抑制用） */
  private recentSuccess = new Map<string, number>();
  /** 决策审计环形缓冲 */
  private audit: DecisionAuditEntry[] = [];
  private stats = { total: 0, ruleHits: 0, cacheHits: 0, strategistCalls: 0, heuristicFallbacks: 0 };

  constructor(config?: Partial<DecisionEngineConfig>) {
    this.config = { ...DEFAULT_DECISION_ENGINE_CONFIG, ...config };
  }

  /**
   * 对一批信号做决策（四级流水线）
   * @param signals 聚合后的信号批次
   * @param history 每类信号的历史统计（长期记忆提供）
   * @returns signalId → Decision
   */
  async decide(signals: Signal[], history: Map<string, SignalHistoryStats>): Promise<Map<string, Decision>> {
    const results = new Map<string, Decision>();
    const needStrategist: Signal[] = [];

    for (const signal of signals) {
      const fingerprint = fingerprintOf(signal);

      // ── 第 1 级：规则快速路径 ──
      const ruleDecision = this.applyRules(signal, fingerprint, history.get(signal.type));
      if (ruleDecision) {
        this.stats.ruleHits += 1;
        results.set(signal.id, ruleDecision);
        this.auditDecision(signal, fingerprint, ruleDecision);
        continue;
      }

      // ── 第 2 级：决策缓存 ──
      const cached = this.lookupCache(fingerprint);
      if (cached) {
        this.stats.cacheHits += 1;
        results.set(signal.id, cached);
        this.auditDecision(signal, fingerprint, cached);
        continue;
      }

      needStrategist.push(signal);
    }

    // ── 第 3 级：strategist 模型 ──
    if (needStrategist.length > 0) {
      this.stats.strategistCalls += 1;
      let verdicts = new Map<string, StrategistVerdict>();
      if (this.config.strategist) {
        try {
          verdicts = await this.config.strategist(needStrategist, history);
        } catch {
          /* 落入启发式兜底 */
        }
      }
      for (const signal of needStrategist) {
        const fingerprint = fingerprintOf(signal);
        const verdict = verdicts.get(signal.id);
        const stats = history.get(signal.type);
        const decision = verdict
          ? this.fromStrategist(signal, verdict, stats)
          : this.heuristic(signal, stats);
        if (!verdict) this.stats.heuristicFallbacks += 1;
        this.storeCache(fingerprint, decision);
        results.set(signal.id, decision);
        this.auditDecision(signal, fingerprint, decision);
      }
    }

    this.stats.total += signals.length;
    return results;
  }

  /**
   * 结果反馈闭环：依据执行结果修正缓存置信度与规则计数器
   * @param signalType 信号类型
   * @param fingerprint 信号指纹（缺省按 type+description 计算需提供 description）
   * @param outcome 执行结果
   */
  recordOutcome(signalType: string, fingerprint: string, outcome: DecisionAuditEntry['outcome']): void {
    // 连续失败计数
    if (outcome === 'failed' || outcome === 'poor') {
      this.consecutiveFailures.set(signalType, (this.consecutiveFailures.get(signalType) ?? 0) + 1);
    } else {
      this.consecutiveFailures.set(signalType, 0);
    }

    // 成功记录用于重复抑制
    if (outcome === 'excellent' || outcome === 'good') {
      this.recentSuccess.set(fingerprint, Date.now());
      this.trimRecentSuccess();
    }

    // 缓存置信度修正
    const entry = this.cache.get(fingerprint);
    if (entry) {
      const value = OUTCOME_VALUE[outcome ?? 'acceptable'] ?? 0.6;
      // 指数加权：新结果占 30%
      entry.adjustedConfidence = entry.adjustedConfidence * 0.7 + value * 0.3;
      entry.decision.confidence = entry.adjustedConfidence;
      // 持续失败的缓存条目淘汰，强制重新决策
      if (entry.adjustedConfidence < 0.2) this.cache.delete(fingerprint);
    }

    // 审计回填
    for (let i = this.audit.length - 1; i >= 0; i -= 1) {
      if (this.audit[i].fingerprint === fingerprint && !this.audit[i].outcome) {
        this.audit[i].outcome = outcome;
        break;
      }
    }
  }

  /** 计算信号指纹（对外暴露，供编排层沉淀反馈时使用） */
  fingerprint(signal: Pick<Signal, 'type' | 'description'>): string {
    return fingerprintOf(signal);
  }

  /**
   * 运行时配置热更新（策略进化引擎的基因组落地入口）
   * @param patch 配置补丁（仅覆盖提供的字段，strategist 回调不可经此修改）
   */
  updateConfig(patch: Partial<Omit<DecisionEngineConfig, 'strategist'>>): void {
    this.config = { ...this.config, ...patch };
  }

  /** 当前配置快照（不含 strategist 回调） */
  getConfig(): Omit<DecisionEngineConfig, 'strategist'> {
    const { strategist: _strategist, ...rest } = this.config;
    return { ...rest };
  }

  /** 决策引擎运行统计 */
  getStats(): any {
    return {
      ...this.stats,
      cacheSize: this.cache.size,
      cacheHitRate: this.stats.total > 0 ? this.stats.cacheHits / this.stats.total : 0,
      ruleHitRate: this.stats.total > 0 ? this.stats.ruleHits / this.stats.total : 0,
      consecutiveFailures: Object.fromEntries(this.consecutiveFailures),
    };
  }

  /** 最近决策审计记录 */
  getAudit(limit = 20): DecisionAuditEntry[] {
    return this.audit.slice(-limit);
  }

  /** 清空缓存与计数器（测试/重置用） */
  reset(): void {
    this.cache.clear();
    this.consecutiveFailures.clear();
    this.recentSuccess.clear();
    this.audit = [];
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 第 1 级：规则快速路径 */
  private applyRules(signal: Signal, fingerprint: string, stats?: SignalHistoryStats): Decision | null {
    const now = Date.now();

    // 规则 A：重复抑制 — 抑制窗口内已成功执行过
    const lastSuccess = this.recentSuccess.get(fingerprint);
    if (lastSuccess && now - lastSuccess < this.config.suppressionWindowMs) {
      return {
        action: 'dismiss',
        urgency: 0.1,
        confidence: 0.9,
        reason: `重复抑制：${Math.round((now - lastSuccess) / 1000)}s 前同指纹任务已成功执行`,
        source: 'rule',
        decidedAt: now,
      };
    }

    // 规则 B：失败升级 — 同类型连续失败达阈值，止损交人工
    const failures = this.consecutiveFailures.get(signal.type) ?? 0;
    if (failures >= this.config.failureEscalationThreshold) {
      return {
        action: 'ask-user',
        urgency: 0.7,
        confidence: 0.85,
        reason: `类型 ${signal.type} 已连续失败 ${failures} 次，升级人工介入`,
        source: 'rule',
        decidedAt: now,
      };
    }

    // 规则 C：成本闸门 — 高成本 + 低紧急度 → defer（需历史成本数据支撑）
    if (stats && stats.avgTokenCost > 0 && signal.urgency !== undefined) {
      const estimatedCost = stats.avgTokenCost;
      if (signal.urgency < 0.3 && estimatedCost > 5000) {
        return {
          action: 'defer',
          urgency: signal.urgency,
          confidence: 0.7,
          reason: `高成本任务（约 ${estimatedCost} tokens）且紧急度低，延迟到空闲期`,
          source: 'rule',
          deferMs: 5 * 60_000,
          estimatedCost,
          decidedAt: now,
        };
      }
    }

    return null;
  }

  /** 第 2 级：缓存查询（校验 TTL 与置信度） */
  private lookupCache(fingerprint: string): Decision | null {
    const entry = this.cache.get(fingerprint);
    if (!entry) return null;
    if (Date.now() - entry.decision.decidedAt > this.config.cacheTtlMs) {
      this.cache.delete(fingerprint);
      return null;
    }
    // 低置信度缓存不复用，交给 strategist 重审
    if (entry.adjustedConfidence < this.config.lowConfidenceThreshold) return null;

    entry.hits += 1;
    return { ...entry.decision, source: 'cache', confidence: entry.adjustedConfidence, decidedAt: Date.now() };
  }

  /** 缓存写入（LRU 淘汰） */
  private storeCache(fingerprint: string, decision: Decision): void {
    if (this.cache.size >= this.config.cacheMaxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(fingerprint, { decision, hits: 0, adjustedConfidence: decision.confidence });
  }

  /** 第 3 级：strategist 裁定 → Decision（含置信度与低置信升级） */
  private fromStrategist(signal: Signal, verdict: StrategistVerdict, stats?: SignalHistoryStats): Decision {
    // 置信度基线：历史数据越充分越可信
    const historyFactor = stats ? Math.min(0.2, stats.totalDecisions * 0.02) : 0;
    let confidence = 0.65 + historyFactor;
    let action = verdict.decision;

    // 突发信号提权
    let urgency = Math.max(0, Math.min(1, verdict.urgency));
    if (signal.occurrences >= this.config.burstOccurrences) {
      urgency = Math.min(1, urgency + 0.2);
    }

    // 成本估算注入
    const estimatedCost = stats?.avgTokenCost;

    // 低置信升级
    if (confidence < this.config.lowConfidenceThreshold && action === 'execute') {
      action = 'ask-user';
    }

    return {
      action,
      urgency,
      confidence,
      reason: verdict.reason ?? 'strategist 决策',
      source: 'strategist',
      deferMs: verdict.deferMs,
      estimatedCost,
      decidedAt: Date.now(),
    };
  }

  /** 第 4 级：启发式兜底（保守执行） */
  private heuristic(signal: Signal, stats?: SignalHistoryStats): Decision {
    return {
      action: 'execute',
      urgency: Math.min(1, 0.5 + signal.occurrences * 0.1),
      confidence: 0.5,
      reason: 'strategist 不可用，启发式兜底',
      source: 'heuristic',
      estimatedCost: stats?.avgTokenCost,
      decidedAt: Date.now(),
    };
  }

  /** 审计记录（环形缓冲上限 200） */
  private auditDecision(signal: Signal, fingerprint: string, decision: Decision): void {
    this.audit.push({ signalId: signal.id, fingerprint, decision });
    if (this.audit.length > 200) this.audit.shift();
  }

  /** 清理过期的重复抑制记录 */
  private trimRecentSuccess(): void {
    const cutoff = Date.now() - this.config.suppressionWindowMs;
    for (const [key, ts] of this.recentSuccess) {
      if (ts < cutoff) this.recentSuccess.delete(key);
    }
  }
}

/** 信号指纹：type + 归一化描述 */
function fingerprintOf(signal: Pick<Signal, 'type' | 'description'>): string {
  const normalized = signal.description.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${signal.type}:${normalized}`).digest('hex').slice(0, 16);
}
