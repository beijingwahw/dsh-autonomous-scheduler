/**
 * runtime.ts — 共生运行时（共生进化架构第五阶段 4/4）
 *
 * 认知生态的「市场监管者 + 央行 + 生存裁判」三合一运行时：
 *
 * 1. 心跳编排（tick）：生存检查 → 感知分发 → 收集提案 →
 *    监管否决 → 市场撮合 → 行动授权执行 → 生态报告。
 *
 * 2. 价值注入（settleTaskOutcome）：任务成功 = 真实价值进入生态 →
 *    央行铸币 incomePerSuccess，按贡献者 Wilson 下界加权分红——
 *    「智能体通过提升任务表现赚钱」的直接机制；失败不铸币但记
 *    负贡献，信誉下界的统计保守性自动压缩其未来分红。
 *
 * 3. 生存法则：余额低于生存线 → 休眠（不再被感知/调度）；
 *    央行救济（有限配额，防僵尸智能体无限吸血）或后续分红 → 复活。
 *
 * 4. 行动经济学：行动类提案批准即预扣能量到 escrow——
 *    成功全额燃烧（成本沉没）、失败退还一半（试验学费折扣，
 *    鼓励尝试但不鼓励重复失败）；未批准提案零成本。
 *
 * 5. 监管桥接：宿主 SafetyGovernor.checkGate()（kill-switch/熔断）
 *    对行动类提案有一票否决权——能量经济与安全治理在批准层统一。
 *
 * Phase 1 影子定位：本运行时独立心跳、不接管既有 autonomy-loop
 * 主链路，可并行观察能量流向后再决定融合深度（不破坏现有功能）。
 */

import { isTradeListener, type AgentProposal, type ExecutionGrant, type ManagedAgent, type MarketSnapshot, type ProposalKind } from './agent.js';
import { BeliefMarket } from './belief.js';
import { CognitiveMarket } from './market.js';
import { EnergyLedger, ESCROW, TREASURY } from './ledger.js';
import { shapleyValues, type CausalKernel, type ContributorProb } from '../core/causal-kernel.js';
import { FreeEnergyEngine, type EFEAction, type EFEEvaluation } from '../core/free-energy.js';

/** 只读监管门控（与 SafetyGovernor.checkGate 结构兼容） */
export interface GovernanceGate {
  checkGate(): { allowed: boolean; reason?: string; blockedBy?: string };
}

export interface SymbiosisConfig {
  /** 央行初始供给（默认 10000） */
  initialSupply?: number;
  /** 智能体开业注资（默认 100，从 treasury 划拨） */
  openingGrant?: number;
  /** 休眠救济金额（默认 30） */
  reliefAmount?: number;
  /** 每智能体救济次数上限（默认 3，防僵尸吸血） */
  reliefQuota?: number;
  /** 任务成功的铸币分红总额（默认 40） */
  incomePerSuccess?: number;
  /** 行动失败退还比例（默认 0.5） */
  failureRefundRate?: number;
  /** 心跳系统信号采集器（接入宿主 KPI） */
  tickSignals?: () => Record<string, number>;
  /** ── Phase 2：信念市场（市场即心智）── */
  /** 信念市场流动性参数 b（默认 10；越大价格越稳、国库做市补贴上界 b·ln2 越大） */
  beliefLiquidityB?: number;
  /** 信念到期后信号仍缺失的宽限轮数（默认 2，超出取消退款） */
  beliefGraceTicks?: number;
  /** 元认知对账背离阈值（|市场价 − 统计估计| 超过才告警，默认 0.15） */
  divergenceMargin?: number;
  /** futarchy：高成本行动（进化）是否由信念市场资助表决（默认 false，保持既有行为） */
  futarchyEnabled?: boolean;
  /** futarchy：资助门槛（隐含成功概率下限，默认 0.55） */
  futarchyMinImpliedProb?: number;
  /** futarchy：决策资产流动性 b（默认 6，轻流动性让小额信念快速定价） */
  futarchyDecisionB?: number;
  /** ── 5.0：因果内核（do-干预登记 + Shapley 反事实分红）── */
  /** 因果内核实例（挂载后任务结算自动登记 do-干预、分红改用 Shapley 边际贡献） */
  causalKernel?: CausalKernel;
  /** 因果图的结果节点名（默认 'task.outcome'） */
  causalOutcomeNode?: string;
  /** ── 6.0：主动推断内核（期望自由能行动排序 + 变分漂移监测）── */
  /** 自由能引擎实例（挂载后心跳产出变分自由能、行动提案可按 EFE 排序） */
  freeEnergy?: FreeEnergyEngine;
  /**
   * ── 10.0：科学家内核（热点自动登记问题空间）──
   * 挂载后任务结算的 do-干预边 (贡献者 → task.outcome) 自动进入
   * 科学家问题空间——调度器每刻意选型一次，就为「选用 X 是否导致
   * 成功」这个因果问题积累一次 EIG 实验设计机会（幂等，零漂移）。
   */
  scientist?: import('../core/scientist.js').ScientistMind;
  /** ── 7.0：深思内核（多步行动提案按轨迹自由能排序）── */
  /** 深思内核实例（挂载后多步计划提案可按想象推演的轨迹 G 排序） */
  deliberation?: import('../core/deliberation.js').DeliberationEngine;
}

export interface GrantOutcome {
  agentId: string;
  proposalId: string;
  kind: ProposalKind;
  success: boolean;
  burned: number;
  refunded: number;
  valueEstimate: number;
  summary: string;
}

export interface SymbiosisTickReport {
  tick: number;
  timestamp: number;
  activeAgents: string[];
  dormantAgents: string[];
  reliefs: Array<{ agentId: string; amount: number }>;
  proposals: Array<{ agentId: string; kind: ProposalKind; bid: number }>;
  vetoes: Array<{ agentId: string; kind: ProposalKind; reason: string }>;
  trades: number;
  grants: GrantOutcome[];
  mintedThisTick: number;
  burnedThisTick: number;
  gini: number;
  conservationIntact: boolean;
  market: MarketSnapshot;
  /** ── Phase 2：信念市场 ── */
  /** 本轮成交的信念下注（价格即信念） */
  beliefBets: Array<{ agentId: string; assetId: string; outcome: 'YES' | 'NO'; cost: number; priceAfter: number }>;
  /** 本轮到期结算 / 宽限超时取消的信念 */
  beliefSettlements: Array<{
    assetId: string;
    mode: 'settled' | 'cancelled';
    outcome?: boolean;
    realized?: number;
    paidOut: number;
    subsidy: number;
    swept: number;
    refunded: number;
  }>;
  /** futarchy 决议：市场资助 / 市场否决 / 监管一票否决 */
  futarchyDecisions: Array<{
    agentId: string;
    proposalId: string;
    impliedProb: number;
    decision: 'funded' | 'market-rejected' | 'governor-vetoed';
    actionSuccess?: boolean;
  }>;
  /** 元认知对账：市场价 vs 被动统计估计的显著背离（模型漂移信号） */
  divergence: Array<{ assetId: string; subject: string; marketProb: number; statEstimate: number; gap: number }>;
  /** 6.0：变分自由能（信念市场价 vs 因果后验的 KL 总和；漂移的信息论度量） */
  variationalFreeEnergy?: { total: number; driftDetected: boolean; worst?: { id: string; kl: number } };
}

export interface DistributionReport {
  totalDistributed: number;
  shares: Array<{ agentId: string; weight: number; amount: number }>;
  /** ── 5.0：Shapley 反事实分红明细（挂载因果内核时启用）── */
  method?: 'linear-wilson' | 'shapley-counterfactual';
  /** 各贡献者的 Shapley 边际贡献值（拔掉该智能体任务成功率掉多少） */
  shapley?: Array<{ agentId: string; shapleyValue: number; counterfactualProb: number }>;
}

/** 行动类提案（需预扣能量并执行）；市场类由运行时直接撮合 */
const ACTION_KINDS: ReadonlySet<ProposalKind> = new Set(['maintenance', 'evolution', 'exploration']);

export class SymbiosisRuntime {
  readonly ledger: EnergyLedger;
  readonly market: CognitiveMarket;
  readonly beliefMarket: BeliefMarket;
  private agents: ManagedAgent[] = [];
  private agentIds = new Set<string>();
  private reliefUsed = new Map<string, number>();
  private tickCount = 0;
  /** futarchy 待决议行动（提案轮创建决策资产 → 下一轮市场表决 → 执行/否决） */
  private pendingDecisions: Array<{ agentId: string; proposal: AgentProposal; assetId: string }> = [];
  private readonly config: Required<Omit<SymbiosisConfig, 'tickSignals' | 'governor' | 'causalKernel' | 'causalOutcomeNode' | 'freeEnergy' | 'scientist' | 'deliberation'>>;
  private readonly tickSignals?: () => Record<string, number>;
  private readonly governor?: GovernanceGate;
  /** 5.0：因果内核（可选挂载；缺省保持既有线性分红，零行为漂移） */
  private readonly causalKernel?: CausalKernel;
  private readonly causalOutcomeNode: string;
  /** 6.0：自由能引擎（可选挂载；缺省心跳不产变分项，零漂移） */
  private readonly freeEnergy?: FreeEnergyEngine;
  /** 10.0：科学家内核（可选挂载；缺省结算不登记问题，零漂移） */
  private readonly scientist?: import('../core/scientist.js').ScientistMind;
  /** 7.0：深思内核（可选挂载；缺省多步提案排序不可用，零漂移） */
  private readonly deliberation?: import('../core/deliberation.js').DeliberationEngine;

  constructor(config: SymbiosisConfig = {}, governor?: GovernanceGate) {
    this.config = {
      initialSupply: config.initialSupply ?? 10_000,
      openingGrant: config.openingGrant ?? 100,
      reliefAmount: config.reliefAmount ?? 30,
      reliefQuota: config.reliefQuota ?? 3,
      incomePerSuccess: config.incomePerSuccess ?? 40,
      failureRefundRate: config.failureRefundRate ?? 0.5,
      beliefLiquidityB: config.beliefLiquidityB ?? 10,
      beliefGraceTicks: config.beliefGraceTicks ?? 2,
      divergenceMargin: config.divergenceMargin ?? 0.15,
      futarchyEnabled: config.futarchyEnabled ?? false,
      futarchyMinImpliedProb: config.futarchyMinImpliedProb ?? 0.55,
      futarchyDecisionB: config.futarchyDecisionB ?? 6,
    };
    this.tickSignals = config.tickSignals;
    this.governor = governor;
    this.causalKernel = config.causalKernel;
    this.causalOutcomeNode = config.causalOutcomeNode ?? 'task.outcome';
    this.freeEnergy = config.freeEnergy;
    this.scientist = config.scientist;
    this.deliberation = config.deliberation;
    this.ledger = new EnergyLedger({ initialSupply: this.config.initialSupply });
    this.market = new CognitiveMarket(this.ledger);
    this.beliefMarket = new BeliefMarket(this.ledger, { defaultB: this.config.beliefLiquidityB });
  }

  /** 注册智能体：开户 + 央行开业注资（继承 AgentBase 即满足托管契约） */
  register(agent: ManagedAgent): boolean {
    if (this.agentIds.has(agent.id)) return false;
    this.agentIds.add(agent.id);
    this.agents.push(agent);
    this.ledger.openAccount(agent.id);
    if (this.config.openingGrant > 0) {
      this.ledger.transfer(TREASURY, agent.id, this.config.openingGrant, 'opening-grant', agent.id);
    }
    return true;
  }

  /**
   * 单轮心跳：生态一轮完整的生存-感知-决策-交易-行动循环。
   * @param signals 心跳系统信号（同时是信念结算的 realized 值来源）
   * @param opts.externalEstimates 宿主被动统计估计（元认知对账用，键 = 信念 subject）
   */
  async tick(signals?: Record<string, number>, opts?: { externalEstimates?: Record<string, number> }): Promise<SymbiosisTickReport> {
    this.tickCount += 1;
    const now = Date.now();
    const supplyBefore = this.ledger.totalSupply();
    const burnBefore = this.ledger.burned();

    // 1. 生存检查：饥饿休眠 / 有限救济复活
    const relieves: Array<{ agentId: string; amount: number }> = [];
    const active: ManagedAgent[] = [];
    const dormant: string[] = [];
    for (const agent of this.agents) {
      const threshold = agent.goal().survivalThreshold;
      const balance = this.ledger.balance(agent.id);
      if (agent.mode() === 'active' && balance < threshold) {
        agent.setMode('dormant');
      }
      if (agent.mode() === 'dormant') {
        const used = this.reliefUsed.get(agent.id) ?? 0;
        if (used < this.config.reliefQuota && this.ledger.balance(TREASURY) >= this.config.reliefAmount) {
          const receipt = this.ledger.transfer(TREASURY, agent.id, this.config.reliefAmount, 'relief', agent.id);
          if (receipt.ok) {
            this.reliefUsed.set(agent.id, used + 1);
            agent.setMode('active');
            relieves.push({ agentId: agent.id, amount: this.config.reliefAmount });
            active.push(agent);
            continue;
          }
        }
        dormant.push(agent.id);
        continue;
      }
      active.push(agent);
    }

    // 2. 感知分发（快照切片，智能体只读；Phase 2 附带信念市场行情）
    const marketSnapshot = this.market.snapshot();
    const listingViews = this.market.listingViews();
    const openBeliefs = this.beliefMarket.views().filter((bv) => bv.status === 'open');
    const systemSignals = { ...(this.tickSignals?.() ?? {}), ...(signals ?? {}) };
    for (const agent of active) {
      agent.perceive({
        tick: this.tickCount,
        timestamp: now,
        ownBalance: this.ledger.balance(agent.id),
        reputation: agent.reputation(),
        market: marketSnapshot,
        listings: listingViews,
        beliefs: openBeliefs,
        signals: systemSignals,
      });
    }

    // 3. 收集提案 + 4. 监管否决 + 5. 市场类直接撮合 + 6. 行动类授权执行
    const proposalsSeen: SymbiosisTickReport['proposals'] = [];
    const vetoes: SymbiosisTickReport['vetoes'] = [];
    const grants: GrantOutcome[] = [];
    const pendingBids: Array<{ bidder: string; assetId: string; price: number }> = [];
    const beliefBets: SymbiosisTickReport['beliefBets'] = [];

    const gate = this.governor?.checkGate() ?? { allowed: true };

    for (const agent of active) {
      let proposals: AgentProposal[];
      try {
        proposals = agent.propose();
      } catch {
        continue; // 单智能体决策异常不拖垮生态
      }
      for (const proposal of proposals) {
        if (proposal.kind === 'idle') continue;
        proposalsSeen.push({ agentId: agent.id, kind: proposal.kind, bid: proposal.bid });

        // 市场类提案：监管仅拦暂停态；否则直接进市场
        if (proposal.kind === 'list-knowledge') {
          if (!gate.allowed) {
            vetoes.push({ agentId: agent.id, kind: proposal.kind, reason: gate.reason ?? 'governance' });
            continue;
          }
          const listed = this.market.list({
            seller: agent.id,
            kind: (proposal.assetKind as 'pattern') ?? 'pattern',
            refId: proposal.assetRef ?? proposal.id,
            description: proposal.description,
            ask: proposal.bid,
            claimedQuality: proposal.claimedQuality ?? 0.5,
          });
          if (listed.ok) agent.noteSpend(listed.listingFee ?? 0);
          continue;
        }
        if (proposal.kind === 'buy-knowledge') {
          if (!proposal.assetRef) continue;
          pendingBids.push({ bidder: agent.id, assetId: proposal.assetRef, price: proposal.bid });
          continue;
        }

        // 信念下注：把市场价格推向自己的估计（信息注入）。
        // 信息层不受熔断压制——市场定价继续、能量只是账户间流转；
        // 监管主权在执行层（futarchy 决议 / 行动类提案一票否决）。
        if (proposal.kind === 'bet-belief') {
          if (!proposal.assetRef) {
            vetoes.push({ agentId: agent.id, kind: proposal.kind, reason: 'missing-asset-ref' });
            continue;
          }
          const bet = this.beliefMarket.buyToPrice(
            agent.id,
            proposal.assetRef,
            proposal.outcome ?? 'YES',
            proposal.targetPrice ?? 0.75,
            proposal.bid,
          );
          if (bet.ok) {
            agent.noteSpend(bet.cost ?? 0);
            beliefBets.push({ agentId: agent.id, assetId: proposal.assetRef, outcome: proposal.outcome ?? 'YES', cost: bet.cost ?? 0, priceAfter: bet.priceAfter ?? 0.5 });
          } else {
            vetoes.push({ agentId: agent.id, kind: proposal.kind, reason: bet.error ?? 'bet-rejected' });
          }
          continue;
        }

        // futarchy 拦截：高成本进化不由运行时直接批准，改由信念市场表决资助。
        // 注意：市场表决属信息层，熔断态照常进行（信息聚合不受安全态压制）；
        // 监管否决权保留在执行层（决议轮 gate 不通过 → governor-vetoed）。
        if (this.config.futarchyEnabled && proposal.kind === 'evolution') {
          const asset = this.beliefMarket.create({
            claim: proposal.description,
            subject: `evolution:${agent.id}:${this.tickCount}`,
            threshold: 0.5,
            settleAtTick: this.tickCount + 1,
            creator: agent.id,
            liquidityB: this.config.futarchyDecisionB,
          });
          if (asset.ok && asset.assetId) {
            this.pendingDecisions.push({ agentId: agent.id, proposal, assetId: asset.assetId });
          }
          continue;
        }

        // 行动类提案：监管一票否决（kill-switch / 熔断）
        if (!gate.allowed) {
          vetoes.push({ agentId: agent.id, kind: proposal.kind, reason: gate.reason ?? 'governance' });
          continue;
        }
        const outcome = await this.executeAction(agent, proposal);
        if (outcome) grants.push(outcome);
      }
    }

    // 7. 买单进场 + 撮合
    for (const bid of pendingBids) {
      const placed = this.market.placeBid(bid.bidder, bid.assetId, bid.price);
      if (!placed.ok) {
        vetoes.push({ agentId: bid.bidder, kind: 'buy-knowledge', reason: placed.error ?? 'bid-rejected' });
      }
    }
    const trades = this.market.match();
    for (const trade of trades) {
      const buyer = this.agents.find((a) => a.id === trade.buyer);
      const seller = this.agents.find((a) => a.id === trade.seller);
      buyer?.noteSpend(trade.price);
      seller?.noteEarnings(trade.price);
      if (buyer && isTradeListener(buyer)) {
        buyer.notePurchase(trade.assetId, this.market.getAsset(trade.assetId)?.refId ?? trade.assetId, trade.price);
      }
    }

    // 8. futarchy 决议：上轮挂起的进化提案 → 市场隐含概率过门槛则资助执行
    const beliefSettlements: SymbiosisTickReport['beliefSettlements'] = [];
    const futarchyDecisions: SymbiosisTickReport['futarchyDecisions'] = [];
    const stillPending: typeof this.pendingDecisions = [];
    for (const decision of this.pendingDecisions) {
      const view = this.beliefMarket.view(decision.assetId);
      if (!view || view.status !== 'open' || view.settleAtTick > this.tickCount) {
        stillPending.push(decision); // 未到期（含本轮新建）继续挂起
        continue;
      }
      const agent = this.agents.find((a) => a.id === decision.agentId);
      const implied = view.impliedProbYes;
      if (!gate.allowed) {
        futarchyDecisions.push({ agentId: decision.agentId, proposalId: decision.proposal.id, impliedProb: implied, decision: 'governor-vetoed' });
        this.cancelBelief(decision.assetId, beliefSettlements);
        continue;
      }
      if (implied >= this.config.futarchyMinImpliedProb && agent) {
        const grant = await this.executeAction(agent, decision.proposal);
        if (grant) grants.push(grant);
        futarchyDecisions.push({ agentId: decision.agentId, proposalId: decision.proposal.id, impliedProb: implied, decision: 'funded', actionSuccess: grant?.success ?? false });
        this.settleBelief(decision.assetId, grant?.success ? 1 : 0, beliefSettlements);
      } else {
        futarchyDecisions.push({ agentId: decision.agentId, proposalId: decision.proposal.id, impliedProb: implied, decision: 'market-rejected' });
        this.cancelBelief(decision.assetId, beliefSettlements);
      }
    }
    this.pendingDecisions = stillPending;

    // 9. 到期信念结算：subject 命中信号 → scoring 结算；宽限超时 → 取消退款
    for (const view of this.beliefMarket.views()) {
      if (view.status !== 'open' || view.settleAtTick > this.tickCount) continue;
      if (view.subject.startsWith('evolution:')) continue; // 决策资产由 futarchy 流程处置
      const realized = systemSignals[view.subject];
      if (Number.isFinite(realized)) {
        this.settleBelief(view.assetId, realized, beliefSettlements);
      } else if (this.tickCount - view.settleAtTick > this.config.beliefGraceTicks) {
        this.cancelBelief(view.assetId, beliefSettlements);
      }
    }

    // 10. 元认知对账：市场价 vs 被动统计估计的显著背离（模型漂移信号）
    const divergence: SymbiosisTickReport['divergence'] = [];
    const external = opts?.externalEstimates ?? {};
    for (const view of this.beliefMarket.views()) {
      if (view.status !== 'open') continue;
      const statEstimate = external[view.subject];
      if (!Number.isFinite(statEstimate)) continue;
      const gap = Math.abs(view.impliedProbYes - statEstimate);
      if (gap >= this.config.divergenceMargin) {
        divergence.push({ assetId: view.assetId, subject: view.subject, marketProb: view.impliedProbYes, statEstimate, gap });
      }
    }

    // 6.0：变分自由能——信念市场价 vs 因果后验的 KL 总和（信息论漂移度量）。
    // 与 gap 口径的本质区别：KL 惩罚「市场确信但模型反对」的背离方向性，
    // 且以 nat 计量可与认知价值/惊奇直接换算——心智的三个量纲统一。
    let variational: SymbiosisTickReport['variationalFreeEnergy'];
    if (this.freeEnergy && this.causalKernel) {
      const beliefs: Array<{ id: string; beliefProb: number }> = [];
      const modelProbs: Record<string, number> = {};
      for (const view of this.beliefMarket.views()) {
        if (view.status !== 'open') continue;
        const eff = this.causalKernel.effect(view.subject, this.causalOutcomeNode, now);
        if (eff.interventionalSamples + eff.observationalSamples < 3) continue;
        beliefs.push({ id: view.subject, beliefProb: view.impliedProbYes });
        modelProbs[view.subject] = eff.pDo;
      }
      if (beliefs.length > 0) {
        const report = this.freeEnergy.variationalFreeEnergy(beliefs, modelProbs);
        variational = { total: report.totalFreeEnergy, driftDetected: report.driftDetected, worst: report.worst };
      }
    }

    return {
      tick: this.tickCount,
      timestamp: now,
      activeAgents: active.map((a) => a.id),
      dormantAgents: dormant,
      reliefs: relieves,
      proposals: proposalsSeen,
      vetoes,
      trades: trades.length,
      grants,
      mintedThisTick: this.ledger.totalSupply() - supplyBefore,
      burnedThisTick: this.ledger.burned() - burnBefore,
      gini: this.ledger.giniCoefficient(),
      conservationIntact: this.ledger.verifyConservation(),
      market: this.market.snapshot(),
      beliefBets,
      beliefSettlements,
      futarchyDecisions,
      divergence,
      variationalFreeEnergy: variational,
    };
  }

  /**
   * 6.0：EFE 行动排序——把候选行动按期望自由能从低到高排序。
   *
   * 排序依据 G(a) = 务实价值 − 认知价值：
   * 既预测能达成目标的动作优先，同时高不确定性的动作获得认知价值
   * 折抵（探索不再是外挂加成，而是同一目标函数的另一半）。
   *
   * 消费方：宿主在多个行动提案间分配注意力/预算时调用；
   * 返回逐动作分解（多少因为有用 / 多少因为想弄清），可解释可审计。
   */
  efeRankActions(
    actions: Array<{ id: string; outcomeNode?: string }>,
    preference = 0.9,
  ): EFEEvaluation[] {
    if (!this.causalKernel || !this.freeEnergy) return [];
    const efeActions: EFEAction[] = actions.map((a) => {
      const eff = this.causalKernel!.effect(a.id, a.outcomeNode ?? this.causalOutcomeNode);
      return {
        id: a.id,
        pSuccess: eff.pDo,
        lower: eff.lower,
        upper: eff.upper,
        interventionalSamples: eff.interventionalSamples,
        observationalSamples: eff.observationalSamples,
      };
    });
    return this.freeEnergy.evaluateActions(efeActions, preference);
  }

  /**
   * 7.0：EFE 多步计划排序——把候选**行动序列**（计划）按想象推演的
   * 轨迹自由能从低到高排序。
   *
   * 与 efeRankActions 的本质区别：那是单步 bandit（每个行动独立评分），
   * 这是轨迹评估——第 1 步的代价可以被第 2 步的收获补偿（γ 折扣），
   * 序列中同一条边重访时认知价值坍缩（排练过的路不再有信息量）。
   * 智能体提出多步方案（如「先实验后上线」）时按全程 G 分配注意力。
   */
  efeRankPlans(
    plans: Array<{ id: string; startState: string; actions: string[] }>,
    preference = 0.9,
  ): Array<{
    id: string;
    totalEfe: number;
    pAllSuccess: number;
    undiscountedEfe: number;
    epistemicMonotone: boolean;
    worstStep: number;
  }> {
    if (!this.deliberation) return [];
    return plans
      .map((plan) => {
        const report = this.deliberation!.imagine(plan.startState, plan.actions, preference);
        const worstStep = report.steps.reduce(
          (worst, s) => (s.efe > worst.efe ? s : worst),
          report.steps[0] ?? { step: -1, efe: 0 },
        ).step;
        return {
          id: plan.id,
          totalEfe: report.totalEfe,
          pAllSuccess: report.pAllSuccess,
          undiscountedEfe: report.undiscountedEfe,
          epistemicMonotone: report.epistemicMonotone,
          worstStep,
        };
      })
      .sort((a, b) => a.totalEfe - b.totalEfe);
  }

  /** 结算信念并把赔付记入智能体收入账（能量经账本，记账经宿主钩子） */
  private settleBelief(assetId: string, realized: number, sink: SymbiosisTickReport['beliefSettlements']): void {
    const report = this.beliefMarket.settle(assetId, realized);
    if (!report) return;
    let paidOut = 0;
    for (const payout of report.payouts) {
      paidOut += payout.amount;
      this.agents.find((a) => a.id === payout.agentId)?.noteEarnings(payout.amount);
    }
    sink.push({ assetId, mode: 'settled', outcome: report.outcome, realized: report.realized, paidOut, subsidy: report.subsidyFromTreasury, swept: report.sweptToTreasury, refunded: 0 });
  }

  /** 取消信念退款（悬空断言的零损失退出） */
  private cancelBelief(assetId: string, sink: SymbiosisTickReport['beliefSettlements']): void {
    const report = this.beliefMarket.cancel(assetId);
    if (!report) return;
    const refunded = report.refunds.reduce((a, r) => a + r.amount, 0);
    sink.push({ assetId, mode: 'cancelled', paidOut: 0, subsidy: 0, swept: 0, refunded });
  }

  /**
   * 任务结算：成功 → 央行铸币分红。
   *
   * 5.0 质变（挂载因果内核后）：
   * 1. do-干预登记：调度器「刻意选用」某模型/策略 = 天然干预实验
   *    （非被动观测）——每个贡献者的成败都以 do(use:X) → task.outcome
   *    写入因果图，为后续反事实查询与旋钮排序积累黄金证据。
   * 2. Shapley 反事实分红：分红权重从「Wilson 下界的线性份额」升级为
   *    noisy-OR 联盟下的精确 Shapley 值——「拔掉你，任务成功率掉多少，
   *    你就分多少」。挂名不出力的边际贡献 ≈ 0，自然饿死；不可替代的
   *    关键贡献者获得超额回报（真公平的能量经济）。
   *
   * 未挂载内核时保持既有线性 Wilson 分红（零行为漂移）。
   */
  settleTaskOutcome(
    success: boolean,
    contributors: Array<{ agentId: string; weight?: number }>,
  ): DistributionReport {
    const valid = contributors.filter((c) => this.agentIds.has(c.agentId));
    const shares: DistributionReport['shares'] = [];
    if (valid.length === 0) return { totalDistributed: 0, shares, method: this.causalKernel ? 'shapley-counterfactual' : 'linear-wilson' };

    // 贡献观测（无论成败都写入证据——失败的统计代价）
    for (const c of valid) {
      this.agents.find((a) => a.id === c.agentId)?.recordContribution(success);
    }

    // 5.0：调度器的刻意选型 = do-干预（黄金因果证据，成败都登记）
    if (this.causalKernel) {
      for (const c of valid) {
        this.causalKernel.intervene(c.agentId, this.causalOutcomeNode, true, success, 'scheduler', `任务结算：选用 ${c.agentId} → ${success ? '成功' : '失败'}`);
      }
    }

    // 10.0：结算边自动入科学家问题空间（幂等）——调度热点即研究热点：
    // 被频繁选用的贡献者，其因果效应问题自动获得 EIG 实验设计资格
    if (this.scientist) {
      for (const c of valid) {
        this.scientist.registerQuestion(c.agentId, this.causalOutcomeNode, `调度器热点：选用 ${c.agentId} 对任务结局的因果效应`);
      }
    }

    if (!success) return { totalDistributed: 0, shares, method: this.causalKernel ? 'shapley-counterfactual' : 'linear-wilson' };

    // ── 分红权重计算 ──
    let weights: number[];
    let method: DistributionReport['method'] = 'linear-wilson';
    let shapleyDetail: DistributionReport['shapley'];

    if (this.causalKernel) {
      // 反事实口径的个体成功概率：该智能体参与时任务走向成功的
      // 后验估计（因果图处理臂 P(Y=1|do(参与))，无证据回退 Wilson 下界）
      const probs: ContributorProb[] = valid.map((c) => {
        const agent = this.agents.find((a) => a.id === c.agentId);
        const fallback = agent ? Math.max(agent.reputation().wilsonLower, 0.05) : 0.05;
        const eff = this.causalKernel!.effect(c.agentId, this.causalOutcomeNode);
        return { agentId: c.agentId, prob: eff.interventionalSamples >= 3 ? Math.max(eff.pDo, 0.02) : fallback };
      });
      const shapleys = shapleyValues(probs);
      const sum = [...shapleys.values()].reduce((a, b) => a + Math.max(0, b), 0);
      weights = probs.map((p) => {
        const phi = Math.max(0, shapleys.get(p.agentId) ?? 0);
        // Shapley 全零退化（人人搭便车）→ 平权保底（诚实的不确定性）
        return sum > 0.0001 ? phi : 1 / probs.length;
      });
      method = 'shapley-counterfactual';
      shapleyDetail = probs.map((p) => ({
        agentId: p.agentId,
        shapleyValue: Number(Math.max(0, shapleys.get(p.agentId) ?? 0).toFixed(4)),
        counterfactualProb: Number(p.prob.toFixed(4)),
      }));
    } else {
      // 既有口径：显式 weight ?? Wilson 下界（+ε 保底）
      weights = valid.map((c) => {
        const agent = this.agents.find((a) => a.id === c.agentId);
        const fallback = agent ? Math.max(agent.reputation().wilsonLower, 0.05) : 0.05;
        return Math.max(0.0001, c.weight ?? fallback);
      });
    }

    const weightSum = weights.reduce((a, b) => a + b, 0);
    let distributed = 0;
    weights.forEach((w, i) => {
      const amount = Math.floor((this.config.incomePerSuccess * w) / weightSum);
      if (amount <= 0) return;
      const receipt = this.ledger.mint(valid[i]!.agentId, amount, 'task-dividend');
      if (!receipt.ok) return;
      this.agents.find((a) => a.id === valid[i]!.agentId)?.noteEarnings(amount);
      shares.push({ agentId: valid[i]!.agentId, weight: Number(w.toFixed(4)), amount });
      distributed += amount;
    });
    return { totalDistributed: distributed, shares, method, shapley: shapleyDetail };
  }

  /** 知识使用回报（任务结算时由运行时自动回填，买卖双方不可操纵） */
  reportAssetUsage(assetId: string, success: boolean): void {
    const payout = this.market.reportUsage(assetId, success);
    if (payout) {
      this.agents.find((a) => a.id === payout.seller)?.noteEarnings(payout.amount);
    }
  }

  /** 行动类提案执行：预扣 → 执行 → 成功燃烧 / 失败半退 */
  private async executeAction(agent: ManagedAgent, proposal: AgentProposal): Promise<GrantOutcome | undefined> {
    const budget = Math.ceil(proposal.bid);
    if (budget > 0) {
      const escrowed = this.ledger.transfer(agent.id, ESCROW, budget, 'action-escrow', proposal.id);
      if (!escrowed.ok) return undefined; // 余额不足：静默落选（不出现在 grants）
      agent.noteSpend(budget);
    }
    const grant: ExecutionGrant = {
      agentId: agent.id,
      proposal,
      budget,
      approvedAt: Date.now(),
    };
    let success = false;
    let valueEstimate = 0;
    let summary = '';
    try {
      const result = await agent.execute(grant);
      success = result.success;
      valueEstimate = result.valueEstimate;
      summary = result.summary;
    } catch (err) {
      success = false;
      summary = err instanceof Error ? err.message : String(err);
    }
    let burned = 0;
    let refunded = 0;
    if (budget > 0) {
      if (success) {
        this.ledger.burn(ESCROW, budget, 'action-cost', proposal.id);
        burned = budget;
      } else {
        refunded = Math.floor(budget * this.config.failureRefundRate);
        if (refunded > 0) this.ledger.transfer(ESCROW, agent.id, refunded, 'action-refund', proposal.id);
        const rest = budget - refunded;
        if (rest > 0) this.ledger.burn(ESCROW, rest, 'action-cost', proposal.id);
        burned = rest;
      }
    }
    return {
      agentId: agent.id,
      proposalId: proposal.id,
      kind: proposal.kind,
      success,
      burned,
      refunded,
      valueEstimate,
      summary,
    };
  }

  /** 生态全景（心智报告/审计用） */
  stats(): {
    tick: number;
    agents: Array<{ id: string; kind: string; mode: string; balance: number; reputation: ReturnType<ManagedAgent['reputation']> }>;
    ledger: ReturnType<EnergyLedger['stats']>;
    market: MarketSnapshot;
    belief: ReturnType<BeliefMarket['snapshot']>;
  } {
    return {
      tick: this.tickCount,
      agents: this.agents.map((a) => ({
        id: a.id,
        kind: a.kind,
        mode: a.mode(),
        balance: this.ledger.balance(a.id),
        reputation: a.reputation(),
      })),
      ledger: this.ledger.stats(),
      market: this.market.snapshot(),
      belief: this.beliefMarket.snapshot(),
    };
  }
}
