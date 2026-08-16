/**
 * belief.ts — 信念市场（共生进化架构 Phase 2：市场即心智）
 *
 * 质变定位：Phase 1 让知识有了价格；本层让**信念**有了价格。
 *
 * 系统里所有"对未来的判断"（模型成功率、策略增益、知识有效性）原本是
 * 被动统计量——不可问责、不可聚合、不可对赌。本层把它们变成可交易的
 * 二元信念资产：
 *
 * - **LMSR 做市商**（对数市场评分规则，Hanson 2003）：
 *   成本函数 C(q) = b·ln(e^{q1/b} + e^{q2/b})，价格 = sigmoid((q1−q2)/b)。
 *   无需对手方即可成交；国库提供有界流动性补贴（最坏损失 b·ln2）；
 *   成本函数路径无关 → 买卖往返净成本恒为 0（无摩擦）。
 *
 * - **信息聚合**：持有私有信息的智能体（记忆层知道历史、进化器知道沙盒
 *   LCB）下注 → 价格移动到其估计 → 信息劣势者被套利。错的信念自动
 *   亏钱给对的信念——信念进化有了牙齿。
 *
 * - **结算即审计**：到期按实现结果结算（realized > threshold = YES），
 *   每份 YES/NO 份额支付 1 能量；赢家从流动性池领取，亏家血本无归。
 *
 * - **激励相容**：LMSR 本质是 proper scoring rule 的市场化——
 *   把价格推到自己真实估计是最优策略（谎报即送钱给套利者）。
 *
 * 能量流：买单成本 → belief-pool（流动性池）→ 结算赔付；
 * 池 shortfall 由国库有界补贴，盈余扫回国库。全程复式记账、守恒可审计。
 * 信念市场允许分数能量（连续价格机制的数学需要；账本不限制粒度）。
 */

import { TREASURY, type AccountId, type EnergyLedger } from './ledger.js';

/** 信念流动性池账户（收集买单成本、支付结算赔付） */
export const BELIEF_POOL: AccountId = 'belief-pool';

export type BeliefOutcome = 'YES' | 'NO';
export type BeliefStatus = 'open' | 'settled' | 'cancelled';

/** 信念资产：一条可机器核验的未来断言 */
export interface BeliefAsset {
  id: string;
  /** 人类可读断言 */
  claim: string;
  /** 结算主体键（运行时信号表的键，如 'task.successRate' / 'evolution:agent-x:3'） */
  subject: string;
  /** 断言阈值：到期 realized > threshold 判 YES */
  threshold: number;
  /** 结算心跳轮（<= 该轮时由运行时结算） */
  settleAtTick: number;
  creator: AccountId;
  /** LMSR 流动性参数 b（越大价格越稳、做市最坏补贴 b·ln2 越大） */
  liquidityB: number;
  /** 流通 YES 份额 */
  yesShares: number;
  /** 流通 NO 份额 */
  noShares: number;
  status: BeliefStatus;
  /** 结算结果（true = YES 兑付） */
  outcome?: boolean;
  /** 结算时的实测值 */
  realizedValue?: number;
  /** 累计净流入成本（= 池内该资产储备） */
  volume: number;
  createdAt: number;
}

/** 感知用脱敏视图（含当前隐含概率） */
export interface BeliefView {
  assetId: string;
  claim: string;
  subject: string;
  threshold: number;
  settleAtTick: number;
  /** 市场隐含 YES 概率 = 当前价格 */
  impliedProbYes: number;
  yesShares: number;
  noShares: number;
  volume: number;
  status: BeliefStatus;
}

/** 智能体持仓（审计可查） */
export interface BeliefPosition {
  agentId: string;
  assetId: string;
  yesShares: number;
  noShares: number;
  /** 累计净支出（取消退款的精确基数） */
  netPaid: number;
}

export interface BetReceipt {
  ok: boolean;
  error?: string;
  /** 买入 = 成本（正）；卖出 = 退款（负） */
  cost?: number;
  shares?: number;
  priceAfter?: number;
}

export interface SettlementReport {
  assetId: string;
  /** true = YES 兑付 */
  outcome: boolean;
  realized: number;
  payouts: Array<{ agentId: string; amount: number }>;
  /** 国库有界补贴（最坏 b·ln2 口径内） */
  subsidyFromTreasury: number;
  /** 池盈余扫回国库 */
  sweptToTreasury: number;
}

export interface CancelReport {
  assetId: string;
  refunds: Array<{ agentId: string; amount: number }>;
  /** 池余额不足等原因退款失败的持仓（审计可查：谁的钱没退成、应退多少） */
  failedRefunds?: Array<{ agentId: string; requested: number }>;
}

// ── LMSR 数学核心（数值稳定实现） ──

function logSumExp(a: number, b: number): number {
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/** 做市商成本函数 C(q1,q2) = b·ln(e^{q1/b} + e^{q2/b}) */
function cost(q1: number, q2: number, b: number): number {
  return b * logSumExp(q1 / b, q2 / b);
}

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** 隐含 YES 概率 = sigmoid((q1−q2)/b) */
function impliedProbYes(q1: number, q2: number, b: number): number {
  return sigmoid((q1 - q2) / b);
}

let beliefCounter = 0;

export interface BeliefMarketConfig {
  /** 默认流动性参数 b（缺省 10） */
  defaultB?: number;
}

/**
 * 信念市场：LMSR 做市的二元断言交易场所。
 *
 * 权限模型：仅 SymbiosisRuntime 持有实例；智能体经感知视图（BeliefView）
 * 只读价格，经 bet-belief 提案由运行时代为成交。
 */
export class BeliefMarket {
  private assets = new Map<string, BeliefAsset>();
  private positions = new Map<string, BeliefPosition>(); // key: `${assetId}|${agentId}`
  private readonly defaultB: number;

  constructor(
    private readonly ledger: EnergyLedger,
    config: BeliefMarketConfig = {},
  ) {
    this.defaultB = Math.max(0.5, config.defaultB ?? 10);
    if (!ledger.hasAccount(BELIEF_POOL)) ledger.openAccount(BELIEF_POOL);
  }

  /** 上市新信念（创建即开放交易；国库隐性承担做市补贴义务） */
  create(input: {
    claim: string;
    subject: string;
    threshold: number;
    settleAtTick: number;
    creator: AccountId;
    liquidityB?: number;
  }): { ok: boolean; error?: string; assetId?: string } {
    if (!input.subject) return { ok: false, error: 'missing-subject' };
    if (!Number.isFinite(input.threshold)) return { ok: false, error: 'invalid-threshold' };
    if (!(input.settleAtTick > 0)) return { ok: false, error: 'invalid-settle-tick' };
    beliefCounter += 1;
    const asset: BeliefAsset = {
      id: `belief-${beliefCounter}`,
      claim: input.claim,
      subject: input.subject,
      threshold: input.threshold,
      settleAtTick: input.settleAtTick,
      creator: input.creator,
      liquidityB: Math.max(0.5, input.liquidityB ?? this.defaultB),
      yesShares: 0,
      noShares: 0,
      status: 'open',
      volume: 0,
      createdAt: Date.now(),
    };
    this.assets.set(asset.id, asset);
    return { ok: true, assetId: asset.id };
  }

  /** 隐含 YES 概率（当前价格） */
  price(assetId: string): number | undefined {
    const a = this.assets.get(assetId);
    return a && a.status === 'open' ? impliedProbYes(a.yesShares, a.noShares, a.liquidityB) : undefined;
  }

  view(assetId: string): BeliefView | undefined {
    const a = this.assets.get(assetId);
    return a ? this.toView(a) : undefined;
  }

  views(): BeliefView[] {
    return [...this.assets.values()].map((a) => this.toView(a));
  }

  /** 持仓查询（审计/测试用，拷贝） */
  positionOf(agentId: string, assetId: string): BeliefPosition | undefined {
    const p = this.positions.get(`${assetId}|${agentId}`);
    return p ? { ...p } : undefined;
  }

  /**
   * 精确份额买入：成本 = C(q+Δ) − C(q)（LMSR 定价）。
   * 能量 agent → belief-pool。
   */
  buyShares(agentId: AccountId, assetId: string, outcome: BeliefOutcome, shares: number): BetReceipt {
    const asset = this.assets.get(assetId);
    if (!asset) return { ok: false, error: 'unknown-asset' };
    if (asset.status !== 'open') return { ok: false, error: 'not-open' };
    if (!(shares > 0) || !Number.isFinite(shares)) return { ok: false, error: 'non-positive-shares' };

    const b = asset.liquidityB;
    const newYes = asset.yesShares + (outcome === 'YES' ? shares : 0);
    const newNo = asset.noShares + (outcome === 'NO' ? shares : 0);
    const price = cost(newYes, newNo, b) - cost(asset.yesShares, asset.noShares, b);
    if (!(price > 0)) return { ok: false, error: 'non-positive-cost' };
    if (this.ledger.balance(agentId) < price) return { ok: false, error: 'insufficient-funds' };

    const receipt = this.ledger.transfer(agentId, BELIEF_POOL, price, 'belief-buy', assetId);
    if (!receipt.ok) return { ok: false, error: receipt.error };

    asset.yesShares = newYes;
    asset.noShares = newNo;
    asset.volume += price;
    this.updatePosition(agentId, assetId, outcome, shares, price);
    return { ok: true, cost: price, shares, priceAfter: impliedProbYes(newYes, newNo, b) };
  }

  /**
   * 卖回做市商（结算前平仓）：退款 = C(q) − C(q−Δ)。
   * LMSR 成本函数路径无关 → 买卖往返净成本恒为 0（零摩擦）。
   */
  sellShares(agentId: AccountId, assetId: string, outcome: BeliefOutcome, shares: number): BetReceipt {
    const asset = this.assets.get(assetId);
    if (!asset) return { ok: false, error: 'unknown-asset' };
    if (asset.status !== 'open') return { ok: false, error: 'not-open' };
    const pos = this.positions.get(`${assetId}|${agentId}`);
    const held = outcome === 'YES' ? pos?.yesShares ?? 0 : pos?.noShares ?? 0;
    if (!(shares > 0) || shares > held + 1e-9) return { ok: false, error: 'insufficient-shares' };

    const b = asset.liquidityB;
    const newYes = asset.yesShares - (outcome === 'YES' ? shares : 0);
    const newNo = asset.noShares - (outcome === 'NO' ? shares : 0);
    const refund = cost(asset.yesShares, asset.noShares, b) - cost(newYes, newNo, b);
    if (!(refund > 0)) return { ok: false, error: 'non-positive-refund' };

    const receipt = this.ledger.transfer(BELIEF_POOL, agentId, refund, 'belief-sell', assetId);
    if (!receipt.ok) return { ok: false, error: receipt.error };

    asset.yesShares = newYes;
    asset.noShares = newNo;
    asset.volume = Math.max(0, asset.volume - refund);
    this.updatePosition(agentId, assetId, outcome, -shares, -refund);
    return { ok: true, cost: -refund, shares, priceAfter: impliedProbYes(newYes, newNo, b) };
  }

  /**
   * 目标价格买入：把市场价格推到自己的真实估计（激励相容动作）。
   * 份额 = 使 implied = target 所需；预算封顶（不足时二分收缩）。
   * @param targetProb 该结果方向的估计概率 ∈ (0.01, 0.99)
   */
  buyToPrice(agentId: AccountId, assetId: string, outcome: BeliefOutcome, targetProb: number, budget: number): BetReceipt {
    const asset = this.assets.get(assetId);
    if (!asset) return { ok: false, error: 'unknown-asset' };
    if (asset.status !== 'open') return { ok: false, error: 'not-open' };
    if (!(targetProb > 0.01 && targetProb < 0.99)) return { ok: false, error: 'invalid-target' };
    if (!(budget > 0)) return { ok: false, error: 'non-positive-budget' };

    const b = asset.liquidityB;
    const targetYes = outcome === 'YES' ? targetProb : 1 - targetProb;
    const logit = Math.log(targetYes / (1 - targetYes));
    let shares: number;
    if (outcome === 'YES') {
      const q1star = asset.noShares + b * logit;
      shares = q1star - asset.yesShares;
    } else {
      const q2star = asset.yesShares + b * Math.log((1 - targetYes) / targetYes);
      shares = q2star - asset.noShares;
    }
    if (shares <= 1e-9) return { ok: false, error: 'no-impact-needed' };

    const costOf = (s: number) => {
      const ny = asset.yesShares + (outcome === 'YES' ? s : 0);
      const nn = asset.noShares + (outcome === 'NO' ? s : 0);
      return cost(ny, nn, b) - cost(asset.yesShares, asset.noShares, b);
    };
    let actual = shares;
    if (costOf(shares) > budget) {
      let lo = 0;
      let hi = shares;
      for (let i = 0; i < 40; i += 1) {
        const mid = (lo + hi) / 2;
        if (costOf(mid) <= budget) lo = mid;
        else hi = mid;
      }
      actual = lo;
      if (actual < 1e-6) return { ok: false, error: 'budget-too-small' };
    }
    return this.buyShares(agentId, assetId, outcome, actual);
  }

  /**
   * 结算：realized > threshold → YES 兑付。
   * 每份命中份额支付 1 能量（scoring 结算）；池缺口国库有界补贴，盈余扫回。
   *
   * 浮点鲁棒性：补贴额加 1e-6 余量对冲 ulp 舍入差（「缺口恰好补齐」在
   * 浮点回加后仍可能差 1e-7，导致赔付/清扫转账静默失败、赢家拿不到钱）；
   * 赔付与清扫均钳制到池实际余额——共享池 + 舍入路径差异下永不透支。
   */
  settle(assetId: string, realized: number): SettlementReport | undefined {
    const asset = this.assets.get(assetId);
    if (!asset || asset.status !== 'open') return undefined;
    const outcome = realized > asset.threshold;
    const payouts: Array<{ agentId: string; amount: number }> = [];
    for (const pos of this.positions.values()) {
      if (pos.assetId !== assetId) continue;
      const amount = outcome ? pos.yesShares : pos.noShares;
      if (amount > 1e-9) payouts.push({ agentId: pos.agentId, amount });
    }
    const totalPayout = payouts.reduce((a, p) => a + p.amount, 0);

    let subsidy = 0;
    if (totalPayout > asset.volume + 1e-9) {
      subsidy = totalPayout - asset.volume + 1e-6;
      const top = this.ledger.transfer(TREASURY, BELIEF_POOL, subsidy, 'belief-subsidy', assetId);
      if (!top.ok) subsidy = 0; // 国库枯竭：转入下方按池余额等比赔付
    }
    // 赔付：不足时等比收缩 + 逐笔钳制到余额。
    // 池污染修复：赔付上限只认本资产自身储备（volume + 国库补贴）——
    // 共享池余额里混着其他在市资产的储备，以池总额为上限会让先结算
    // 的资产静默挪用后来者的流动性，把自身缺口社会化给无辜资产
    const ownReserve = asset.volume + subsidy;
    const scale = totalPayout > ownReserve ? Math.max(0, ownReserve / totalPayout) : 1;
    for (const p of payouts) {
      p.amount = Math.min(p.amount * scale, this.ledger.balance(BELIEF_POOL));
      if (p.amount > 1e-9) this.ledger.transfer(BELIEF_POOL, p.agentId, p.amount, 'belief-payout', assetId);
    }
    const paidNow = payouts.reduce((a, p) => a + p.amount, 0);
    const sweep = Math.max(0, Math.min(asset.volume + subsidy - paidNow, this.ledger.balance(BELIEF_POOL)));
    if (sweep > 1e-9) this.ledger.transfer(BELIEF_POOL, TREASURY, sweep, 'belief-sweep', assetId);

    asset.status = 'settled';
    asset.outcome = outcome;
    asset.realizedValue = realized;
    return { assetId, outcome, realized, payouts, subsidyFromTreasury: subsidy, sweptToTreasury: sweep };
  }

  /** 取消：全额退还净支出（不可结算的悬空信念，如信号永缺失） */
  cancel(assetId: string): CancelReport | undefined {
    const asset = this.assets.get(assetId);
    if (!asset || asset.status !== 'open') return undefined;
    const refunds: Array<{ agentId: string; amount: number }> = [];
    const failedRefunds: Array<{ agentId: string; requested: number }> = [];
    for (const pos of this.positions.values()) {
      if (pos.assetId !== assetId || pos.netPaid <= 1e-9) continue;
      const r = this.ledger.transfer(BELIEF_POOL, pos.agentId, pos.netPaid, 'belief-refund', assetId);
      if (r.ok) refunds.push({ agentId: pos.agentId, amount: pos.netPaid });
      // 退款失败不再静默吞掉：落入 failedRefunds 审计——池被其他资产
      // 缺口抽干时，谁的钱没退成、应退多少，事后可对账追偿
      else failedRefunds.push({ agentId: pos.agentId, requested: pos.netPaid });
    }
    asset.status = 'cancelled';
    return failedRefunds.length > 0 ? { assetId, refunds, failedRefunds } : { assetId, refunds };
  }

  /** 池余额（审计用；全部结算/取消后应回到 0） */
  poolBalance(): number {
    return this.ledger.balance(BELIEF_POOL);
  }

  snapshot(): { open: number; settled: number; cancelled: number; volume: number; poolBalance: number } {
    let settled = 0;
    let cancelled = 0;
    let volume = 0;
    for (const a of this.assets.values()) {
      if (a.status === 'settled') settled += 1;
      else if (a.status === 'cancelled') cancelled += 1;
      else volume += a.volume;
    }
    return {
      open: this.assets.size - settled - cancelled,
      settled,
      cancelled,
      volume,
      poolBalance: this.poolBalance(),
    };
  }

  private updatePosition(agentId: string, assetId: string, outcome: BeliefOutcome, shares: number, paid: number): void {
    const key = `${assetId}|${agentId}`;
    const pos = this.positions.get(key) ?? { agentId, assetId, yesShares: 0, noShares: 0, netPaid: 0 };
    if (outcome === 'YES') pos.yesShares = Math.max(0, pos.yesShares + shares);
    else pos.noShares = Math.max(0, pos.noShares + shares);
    pos.netPaid = Math.max(0, pos.netPaid + paid);
    this.positions.set(key, pos);
  }

  private toView(a: BeliefAsset): BeliefView {
    return {
      assetId: a.id,
      claim: a.claim,
      subject: a.subject,
      threshold: a.threshold,
      settleAtTick: a.settleAtTick,
      impliedProbYes: a.status === 'open' ? impliedProbYes(a.yesShares, a.noShares, a.liquidityB) : (a.outcome ? 1 : 0),
      yesShares: a.yesShares,
      noShares: a.noShares,
      volume: a.volume,
      status: a.status,
    };
  }
}
