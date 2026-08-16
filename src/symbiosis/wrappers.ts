/**
 * wrappers.ts — 认知生态首批智能体（共生进化架构第五阶段，Phase 1 概念验证）
 *
 * 把既有「被动模块」包装为「主动智能体」——不改任何现有模块代码，
 * 仅在共生层赋予其目标、信誉与经济行为：
 *
 * - MemoryAgent（卖方 + 维护者）：包装 LongTermMemory。主动把高置信
 *   任务模式挂上市场出售（定价 = 基准价 × 模式置信度），周期性发起
 *   记忆维护（遗忘曲线 + 修剪）并支付能量成本。
 *
 * - OptimizerAgent（买方）：观察市场行情，对高性价比知识出价购买，
 *   为后续决策检索积累「已购知识清单」（Phase 1 记录不接管主链路）。
 *
 * - EvolverAgent（高成本进化者 + 策略基因卖方）：能量充足时发起
 *   沙盒进化（高成本行动，成功燃烧全额、失败半退）；进化产出
 *   （策略基因）下一轮挂上市场出售——「进化→产出→变现→再进化」
 *   的资本循环。
 *
 * 三者构成最小认知经济闭环：
 *   Evolver 花大钱进化 → 卖策略基因变现 → Optimizer 买知识提升决策
 *   → 任务成功央行铸币分红（按 Wilson 信誉加权）→ Memory 卖沉淀知识
 *   持续抽取售后分成 → 能量流向高效智能体，低效者饥饿休眠。
 */

import type { LongTermMemory, TaskPatternMemory } from '../memory/long-term-memory.js';
import { AgentBase, type ActionResult, type AgentGoal, type AgentProposal, type ExecutionGrant, type ListingView, type Perception } from './agent.js';

// ─────────────────────────── MemoryAgent ───────────────────────────

export interface MemoryAgentConfig {
  /** 挂卖定价基准（要价 = base × confidence，默认 10） */
  listingBasePrice?: number;
  /** 挂卖门槛：模式置信度（默认 0.5） */
  listingConfidenceThreshold?: number;
  /** 挂卖门槛：出现频次（默认 2，防孤例噪声） */
  listingFrequencyThreshold?: number;
  /** 单轮最多挂卖数（默认 2） */
  maxListedPerTick?: number;
  /** 维护行动成本（默认 2） */
  maintenanceCost?: number;
  /** 维护间隔（心跳轮数，默认 5） */
  maintenanceInterval?: number;
}

/**
 * 记忆智能体：最大化记忆资产价值。
 * 主动行为：挂卖高置信模式（赚取能量 + 售后分成）、周期维护（遗忘曲线）。
 */
export class MemoryAgent extends AgentBase {
  readonly kind = 'memory' as const;

  private readonly cfg: Required<MemoryAgentConfig>;
  private listedRefs = new Set<string>();
  private lastMaintenanceTick = 0;

  constructor(
    id: string,
    private readonly memory: LongTermMemory,
    config: MemoryAgentConfig = {},
  ) {
    super(id);
    this.cfg = {
      listingBasePrice: config.listingBasePrice ?? 10,
      listingConfidenceThreshold: config.listingConfidenceThreshold ?? 0.5,
      listingFrequencyThreshold: config.listingFrequencyThreshold ?? 2,
      maxListedPerTick: config.maxListedPerTick ?? 2,
      maintenanceCost: config.maintenanceCost ?? 2,
      maintenanceInterval: config.maintenanceInterval ?? 5,
    };
  }

  goal(): AgentGoal {
    return {
      objective: '最大化记忆资产价值：让高置信经验持续产生交易收入与售后分成',
      metrics: ['market.sales', 'memory.avgConfidence', 'royalty.income'],
      survivalThreshold: 5,
    };
  }

  propose(): AgentProposal[] {
    const p = this.lastPerception;
    if (!p) return [];
    const proposals: AgentProposal[] = [];

    // 1. 挂卖高置信模式（经济来源一：成交价 + 售后分成）
    const candidates = this.memory
      .getTopPatterns(10)
      .filter(
        (pattern) =>
          pattern.confidence >= this.cfg.listingConfidenceThreshold &&
          pattern.frequency >= this.cfg.listingFrequencyThreshold &&
          !this.listedRefs.has(pattern.fingerprint),
      )
      .slice(0, this.cfg.maxListedPerTick);
    for (const pattern of candidates) {
      const ask = Math.max(1, Math.ceil(this.cfg.listingBasePrice * pattern.confidence));
      proposals.push(
        this.proposal('list-knowledge', `出售任务模式 ${pattern.taskSummary}`, ask, {
          assetRef: pattern.fingerprint,
          assetKind: 'pattern',
          claimedQuality: pattern.confidence,
        }),
      );
      this.listedRefs.add(pattern.fingerprint);
    }

    // 2. 周期维护（支付成本换取记忆库长期健康；濒危时停摆保命）
    const dueForMaintenance = p.tick - this.lastMaintenanceTick >= this.cfg.maintenanceInterval;
    if (dueForMaintenance && p.ownBalance >= this.cfg.maintenanceCost * 3) {
      proposals.push(this.proposal('maintenance', '记忆维护：遗忘曲线衰减 + 过期修剪', this.cfg.maintenanceCost));
      this.lastMaintenanceTick = p.tick;
    }
    return proposals;
  }

  async execute(grant: ExecutionGrant): Promise<ActionResult> {
    if (grant.proposal.kind !== 'maintenance') {
      return { success: true, valueEstimate: 0, summary: 'no-op' };
    }
    const decayed = this.memory.applyForgettingCurve();
    const pruned = this.memory.prune(90);
    const scale = Math.min(1, (decayed.forgotten + pruned) / 50);
    return {
      success: true,
      valueEstimate: 0.2 + scale * 0.5,
      summary: `维护完成：衰减 ${decayed.decayed} 条 / 遗忘 ${decayed.forgotten} 条 / 修剪 ${pruned} 条`,
    };
  }

  /** 已挂卖引用（测试/审计用） */
  listed(): string[] {
    return [...this.listedRefs];
  }
}

// ────────────────────────── OptimizerAgent ──────────────────────────

export interface OptimizerAgentConfig {
  /** 单次购买预算上限（默认 20） */
  maxBudget?: number;
  /** 保留余额（低于此值不再出价，默认 30） */
  reserveBalance?: number;
  /** 只买申报质量下限（默认 0.55） */
  minClaimedQuality?: number;
  /** 每轮最多出价数（默认 1） */
  maxBidsPerTick?: number;
  /** ── Phase 2：信念市场 ── */
  /** 单条信念下注预算上限（默认 8） */
  beliefBetBudget?: number;
  /** 每轮最多下注信念数（默认 2） */
  maxBeliefBetsPerTick?: number;
}

/**
 * 优化智能体：提高决策收益。
 * 主动行为：观察行情 → 对高性价比知识出价 → 积累已购知识清单；
 * Phase 2：把系统信号的私有判断注入信念市场（成功率信号 → 下注方向）。
 */
export class OptimizerAgent extends AgentBase {
  readonly kind = 'optimizer' as const;

  private readonly cfg: Required<OptimizerAgentConfig>;
  private purchased: Array<{ assetId: string; refId: string; price: number }> = [];
  private betAssets = new Set<string>();

  constructor(
    id: string,
    config: OptimizerAgentConfig = {},
    private readonly onPurchase?: (assetId: string, refId: string, price: number) => void,
  ) {
    super(id);
    this.cfg = {
      maxBudget: config.maxBudget ?? 20,
      reserveBalance: config.reserveBalance ?? 30,
      minClaimedQuality: config.minClaimedQuality ?? 0.55,
      maxBidsPerTick: config.maxBidsPerTick ?? 1,
      beliefBetBudget: config.beliefBetBudget ?? 8,
      maxBeliefBetsPerTick: config.maxBeliefBetsPerTick ?? 2,
    };
  }

  goal(): AgentGoal {
    return {
      objective: '提高决策收益：购入高性价比知识加速经验检索与模型选型',
      metrics: ['decision.successRate', 'market.purchases', 'recall.hitRate'],
      survivalThreshold: 5,
    };
  }

  propose(): AgentProposal[] {
    const p = this.lastPerception;
    if (!p) return [];
    const proposals: AgentProposal[] = [];
    const spendable = p.ownBalance - this.cfg.reserveBalance;
    if (spendable >= 1) {
      // 价值排序：申报质量 / 要价（性价比优先），已有成交的加分（被市场验证过）
      const ranked = (p.listings as ListingView[])
        .filter((l) => !this.purchased.some((b) => b.assetId === l.assetId))
        .filter((l) => l.claimedQuality >= this.cfg.minClaimedQuality && l.ask <= Math.min(this.cfg.maxBudget, spendable))
        .sort((a, b) => (b.claimedQuality + b.sales * 0.1) / b.ask - (a.claimedQuality + a.sales * 0.1) / a.ask)
        .slice(0, this.cfg.maxBidsPerTick);

      for (const listing of ranked) {
        proposals.push(
          this.proposal('buy-knowledge', `购买知识 ${listing.assetId}（要价 ${listing.ask}）`, listing.ask, {
            assetRef: listing.assetId,
            assetKind: listing.kind,
          }),
        );
      }
    }

    // Phase 2：信念下注——系统信号即私有信息（成功率好 → 对未来乐观）
    if (p.ownBalance >= this.cfg.beliefBetBudget * 2) {
      const successRate = p.signals['taskSuccessRate'];
      if (Number.isFinite(successRate)) {
        const estimate = Math.min(0.9, Math.max(0.1, successRate));
        const outcome = estimate >= 0.5 ? 'YES' : 'NO';
        const targetPrice = outcome === 'YES' ? estimate : 1 - estimate;
        const candidates = (p.beliefs ?? [])
          .filter((b) => b.status === 'open' && b.settleAtTick >= p.tick && !this.betAgents(b.assetId))
          .slice(0, this.cfg.maxBeliefBetsPerTick);
        for (const belief of candidates) {
          proposals.push(
            this.proposal('bet-belief', `对 ${belief.assetId} 下注 ${outcome}@${targetPrice.toFixed(2)}（私有信号：任务成功率 ${successRate.toFixed(2)}）`, this.cfg.beliefBetBudget, {
              assetRef: belief.assetId,
              outcome,
              targetPrice,
            }),
          );
          this.betAssets.add(belief.assetId);
        }
      }
    }
    return proposals;
  }

  private betAgents(assetId: string): boolean {
    return this.betAssets.has(assetId);
  }

  /** 成交通知（由宿主/测试桥接调用；记录已购清单并回调宿主） */
  notePurchase(assetId: string, refId: string, price: number): void {
    this.purchased.push({ assetId, refId, price });
    this.onPurchase?.(assetId, refId, price);
  }

  purchases(): Array<{ assetId: string; refId: string; price: number }> {
    return [...this.purchased];
  }
}

// ────────────────────────── EvolverAgent ──────────────────────────

export interface EvolverAgentConfig {
  /** 进化行动成本（默认 50，提案 bid） */
  evolutionCost?: number;
  /** 发起进化的余额门槛（默认 60，留生存余量） */
  evolutionBalanceThreshold?: number;
  /** 策略基因挂卖基准价（默认 15） */
  geneBasePrice?: number;
  /** ── Phase 2：为自己的进化决策自注（私有信息 = 沙盒增益） ── */
  /** 自注预算上限（默认 12） */
  selfBetBudget?: number;
}

/** 进化周期结果（由宿主桥接真实 PolicyEvolver.runEvolutionCycle） */
export interface EvolutionCycleOutcome {
  /** 是否产出可部署策略 */
  deployed: boolean;
  /** 沙盒评估收益（gain，可为负） */
  bestGain: number;
  /** 部署策略 id（有则挂卖） */
  policyId?: string;
  /** 人类可读摘要 */
  summary: string;
}

/**
 * 进化智能体：发现突破性策略。
 * 主动行为：能量充足时发起沙盒进化（最贵的行动）；进化产出的策略基因
 * 下一轮挂上市场出售——「进化 → 变现 → 再进化」资本循环。
 */
export class EvolverAgent extends AgentBase {
  readonly kind = 'evolver' as const;

  private readonly cfg: Required<EvolverAgentConfig>;
  private pendingGeneListing: { policyId: string; quality: number } | undefined;
  private cyclesRun = 0;
  private deployCount = 0;
  /** 最近一轮沙盒增益（私有信息：自注 futarchy 决策的依据） */
  private lastGain = 0.2;
  private betAssets = new Set<string>();

  constructor(
    id: string,
    private readonly runCycle?: () => Promise<EvolutionCycleOutcome>,
    config: EvolverAgentConfig = {},
  ) {
    super(id);
    this.cfg = {
      evolutionCost: config.evolutionCost ?? 50,
      evolutionBalanceThreshold: config.evolutionBalanceThreshold ?? 60,
      geneBasePrice: config.geneBasePrice ?? 15,
      selfBetBudget: config.selfBetBudget ?? 12,
    };
  }

  goal(): AgentGoal {
    return {
      objective: '发现突破性策略：沙盒进化产出高收益策略基因并变现回血',
      metrics: ['evolution.deployedCount', 'evolution.avgGain', 'market.geneSales'],
      survivalThreshold: 5,
    };
  }

  propose(): AgentProposal[] {
    const p = this.lastPerception;
    if (!p) return [];
    const proposals: AgentProposal[] = [];

    // 1. 上一轮进化产出 → 本轮挂卖策略基因（变现通路）
    if (this.pendingGeneListing) {
      const ask = Math.max(1, Math.ceil(this.cfg.geneBasePrice * Math.max(0.2, this.pendingGeneListing.quality)));
      proposals.push(
        this.proposal('list-knowledge', `出售策略基因 ${this.pendingGeneListing.policyId}`, ask, {
          assetRef: this.pendingGeneListing.policyId,
          assetKind: 'policy-gene',
          claimedQuality: this.pendingGeneListing.quality,
        }),
      );
      this.pendingGeneListing = undefined;
    }

    // 2. 能量充足 → 发起沙盒进化（高成本行动；futarchy 开启时由信念市场表决）
    //    决议未决期间不重复提案：一条在途决策资产 = 一次表决，避免每拍
    //    都资助一个真实进化周期（进化节奏由「市场决议 × 能量余额」双重约束）
    const hasPendingDecision = (p.beliefs ?? []).some(
      (b) => b.status === 'open' && b.subject.startsWith(`evolution:${this.id}:`),
    );
    if (this.runCycle && !hasPendingDecision && p.ownBalance >= this.cfg.evolutionBalanceThreshold) {
      proposals.push(this.proposal('evolution', '沙盒进化周期：变异/交叉 → 校准评估 → 择优', this.cfg.evolutionCost));
    }

    // 3. Phase 2：为自己的进化决策自注（私有信息：上轮沙盒增益映射为成功率信念）
    const decision = (p.beliefs ?? []).find(
      (b) => b.status === 'open' && b.subject.startsWith(`evolution:${this.id}:`) && !this.betAssets.has(b.assetId),
    );
    if (decision && p.ownBalance >= this.cfg.selfBetBudget * 2) {
      const confidence = Math.min(0.92, Math.max(0.55, 0.5 + this.lastGain * 0.5));
      proposals.push(
        this.proposal('bet-belief', `为自己的进化决策自注 YES@${confidence.toFixed(2)}（私有信息：上轮增益 ${this.lastGain.toFixed(2)}）`, this.cfg.selfBetBudget, {
          assetRef: decision.assetId,
          outcome: 'YES',
          targetPrice: confidence,
        }),
      );
      this.betAssets.add(decision.assetId);
    }
    return proposals;
  }

  async execute(grant: ExecutionGrant): Promise<ActionResult> {
    if (grant.proposal.kind !== 'evolution' || !this.runCycle) {
      return { success: true, valueEstimate: 0, summary: 'no-op' };
    }
    this.cyclesRun += 1;
    const outcome = await this.runCycle();
    this.lastGain = outcome.bestGain;
    if (outcome.deployed) {
      this.deployCount += 1;
      // 部署产出 → 下一轮挂卖；质量估计 = 增益映射到 [0.3, 1]
      this.pendingGeneListing = {
        policyId: outcome.policyId ?? `policy-${this.cyclesRun}`,
        quality: Math.max(0.3, Math.min(1, 0.5 + outcome.bestGain)),
      };
    }
    return {
      success: outcome.deployed || outcome.bestGain >= 0,
      valueEstimate: outcome.deployed ? Math.max(0.4, Math.min(1, 0.5 + outcome.bestGain)) : 0.2,
      summary: outcome.summary,
    };
  }

  stats(): { cyclesRun: number; deployCount: number } {
    return { cyclesRun: this.cyclesRun, deployCount: this.deployCount };
  }
}

/** 从感知快照提取挂单视图（便捷桥接，供自定义智能体复用） */
export function listingsOf(p: Perception | undefined): ListingView[] {
    return p ? [...(p.listings as ListingView[])] : [];
}
