/**
 * market.ts — 认知市场（共生进化架构第五阶段 3/4）
 *
 * 知识（记忆模式 / 蒸馏策略 / 语义规律 / 程序规则 / 策略基因）作为
 * 可交易资产：卖方挂 ask（付挂单费防垃圾信息），买方出 bid，
 * 价格交叉即成交——连续双向拍卖机制（与股票市场同构）。
 *
 * 两个激励相容关键设计：
 *
 * 1. 挂单费 burn（燃烧而非给市场）：发挂单信息本身有成本，
 *    无限免费挂单会淹没市场；费用随要价比例收取。
 *
 * 2. 售后分成（royalty）由央行国库支付，而非买方支付：
 *    若从买方扣分成，买方有动机谎报「没用上/失败了」逃避抽成；
 *    若由央行对「知识被验证有效」铸币奖励卖方，买方报告零成本，
 *    且使用反馈由运行时在任务结算时自动回填（买卖双方均无法操纵）。
 *    —— 这是解决知识定价「阿罗信息悖论」（买前不知值不值，知道后
 *    不想付钱）的机制化答案：卖方收入 = 成交价 + 持续分成，
 *    只有真正有效的知识才能持续产生分成，劣质知识自然被证据淘汰。
 *
 * 资产级证据：每笔资产携带 MemoryEvidence，使用反馈持续观测——
 * 申报质量（claimedQuality）与实测证据的偏离构成「质量欺骗」信号，
 * 供监管层下架/罚没（Phase 2 扩展点）。
 */

import { initEvidence, observeEvidence, readEvidence, type MemoryEvidence } from '../core/evidence.js';
import type { ListingView, MarketSnapshot } from './agent.js';
import { TREASURY, type AccountId, type EnergyLedger } from './ledger.js';

/** 知识资产种类 */
export type AssetKind = 'pattern' | 'semantic' | 'procedural' | 'strategy' | 'policy-gene' | 'model-profile';

/** 挂单中的知识资产（引用底层知识本体，不复制数据） */
export interface KnowledgeAsset {
  id: string;
  kind: AssetKind;
  seller: AccountId;
  /** 底层知识引用（记忆指纹 / 策略 id 等） */
  refId: string;
  description: string;
  /** 要价（能量） */
  ask: number;
  /** 卖方申报质量（0~1，成交后由使用证据校准） */
  claimedQuality: number;
  /** 售后分成比例（相对最近成交价） */
  royaltyRate: number;
  listedAt: number;
  /** 成交次数 */
  sales: number;
  /** 最近成交价（分成基数） */
  lastPrice: number;
  /** 资产级使用证据 */
  evidence: MemoryEvidence;
}

/** 买单 */
export interface BidOrder {
  id: string;
  bidder: AccountId;
  assetId: string;
  price: number;
  placedAt: number;
}

/** 成交记录 */
export interface TradeRecord {
  seq: number;
  assetId: string;
  assetKind: AssetKind;
  buyer: AccountId;
  seller: AccountId;
  price: number;
  timestamp: number;
}

/** 售后分成支付凭证 */
export interface RoyaltyPayout {
  assetId: string;
  seller: AccountId;
  amount: number;
  /** 有效使用次数（累计） */
  confirmedUses: number;
}

export interface MarketConfig {
  /** 挂单费率（相对 ask，燃烧；默认 0.1） */
  listingFeeRate?: number;
  /** 默认售后分成比例（默认 0.2） */
  defaultRoyaltyRate?: number;
  /** 最大同时挂单数（默认 64） */
  maxAssets?: number;
}

export type ListError = 'non-positive-ask' | 'duplicate-ref' | 'market-full' | 'listing-fee-unaffordable' | 'insufficient-quality';

let assetCounter = 0;
let bidCounter = 0;
let tradeCounter = 0;

export class CognitiveMarket {
  private assets = new Map<string, KnowledgeAsset>();
  private bidsByAsset = new Map<string, BidOrder[]>();
  private trades: TradeRecord[] = [];
  private volumeTraded = 0;
  private readonly listingFeeRate: number;
  private readonly defaultRoyaltyRate: number;
  private readonly maxAssets: number;

  constructor(
    private readonly ledger: EnergyLedger,
    config: MarketConfig = {},
  ) {
    this.listingFeeRate = Math.max(0, config.listingFeeRate ?? 0.1);
    this.defaultRoyaltyRate = Math.min(1, Math.max(0, config.defaultRoyaltyRate ?? 0.2));
    this.maxAssets = Math.max(1, config.maxAssets ?? 64);
  }

  /** 挂单要价：立即燃烧挂单费（防垃圾信息），同 refId 去重 */
  list(input: {
    seller: AccountId;
    kind: AssetKind;
    refId: string;
    description: string;
    ask: number;
    claimedQuality: number;
    royaltyRate?: number;
  }): { ok: boolean; error?: ListError; assetId?: string; listingFee?: number } {
    if (!(input.ask > 0)) return { ok: false, error: 'non-positive-ask' };
    if (input.claimedQuality < 0 || input.claimedQuality > 1) return { ok: false, error: 'insufficient-quality' };
    for (const asset of this.assets.values()) {
      if (asset.refId === input.refId) return { ok: false, error: 'duplicate-ref' };
    }
    if (this.assets.size >= this.maxAssets) return { ok: false, error: 'market-full' };

    const listingFee = Math.ceil(input.ask * this.listingFeeRate);
    if (listingFee > 0) {
      const fee = this.ledger.transfer(input.seller, 'burn', listingFee, 'listing-fee', input.refId);
      if (!fee.ok) return { ok: false, error: 'listing-fee-unaffordable' };
    }

    assetCounter += 1;
    const asset: KnowledgeAsset = {
      id: `asset-${assetCounter}`,
      kind: input.kind,
      seller: input.seller,
      refId: input.refId,
      description: input.description,
      ask: input.ask,
      claimedQuality: input.claimedQuality,
      royaltyRate: input.royaltyRate ?? this.defaultRoyaltyRate,
      listedAt: Date.now(),
      sales: 0,
      lastPrice: 0,
      evidence: initEvidence(0, 0, Date.now()),
    };
    this.assets.set(asset.id, asset);
    return { ok: true, assetId: asset.id, listingFee };
  }

  /** 出价买单（竞价；撮合时取最高价） */
  placeBid(bidder: AccountId, assetId: string, price: number): { ok: boolean; error?: string } {
    const asset = this.assets.get(assetId);
    if (!asset) return { ok: false, error: 'unknown-asset' };
    if (!(price > 0)) return { ok: false, error: 'non-positive-price' };
    if (this.ledger.balance(bidder) < price) return { ok: false, error: 'insufficient-funds' };
    bidCounter += 1;
    const bids = this.bidsByAsset.get(assetId) ?? [];
    bids.push({ id: `bid-${bidCounter}`, bidder, assetId, price, placedAt: Date.now() });
    this.bidsByAsset.set(assetId, bids);
    return { ok: true };
  }

  /** 卖家下架（无费用；已付挂单费不退——信息发布成本已发生） */
  delist(seller: AccountId, assetId: string): boolean {
    const asset = this.assets.get(assetId);
    if (!asset || asset.seller !== seller) return false;
    this.assets.delete(assetId);
    this.bidsByAsset.delete(assetId);
    return true;
  }

  /**
   * 撮合：对每个资产取最高出价，price >= ask 则成交。
   * 能量 buyer → seller；成交后该资产买单清空。
   */
  match(): TradeRecord[] {
    const executed: TradeRecord[] = [];
    for (const asset of this.assets.values()) {
      const bids = this.bidsByAsset.get(asset.id) ?? [];
      if (bids.length === 0) continue;
      const best = [...bids].sort((a, b) => b.price - a.price)[0]!;
      if (best.price < asset.ask) continue;
      const receipt = this.ledger.transfer(best.bidder, asset.seller, best.price, 'market-trade', asset.id);
      if (!receipt.ok) continue; // 余额不足等：跳过该资产
      tradeCounter += 1;
      const trade: TradeRecord = {
        seq: tradeCounter,
        assetId: asset.id,
        assetKind: asset.kind,
        buyer: best.bidder,
        seller: asset.seller,
        price: best.price,
        timestamp: Date.now(),
      };
      asset.sales += 1;
      asset.lastPrice = best.price;
      this.trades.push(trade);
      this.volumeTraded += best.price;
      this.bidsByAsset.set(asset.id, []);
      executed.push(trade);
    }
    return executed;
  }

  /**
   * 使用反馈（由运行时在任务结算自动回填，买卖双方无法操纵）：
   * - 观测资产级证据（申报质量的实测校准来源）；
   * - 有效使用 → 央行向卖方支付售后分成（激励相容：买方零成本报告）。
   */
  reportUsage(assetId: string, success: boolean, now: number = Date.now()): RoyaltyPayout | undefined {
    const asset = this.assets.get(assetId);
    if (!asset) return undefined;
    observeEvidence(asset.evidence, success, now);
    if (!success || asset.lastPrice <= 0) return undefined;
    const amount = Math.ceil(asset.lastPrice * asset.royaltyRate);
    if (amount <= 0) return undefined;
    const receipt = this.ledger.transfer(TREASURY, asset.seller, amount, 'royalty', assetId);
    if (!receipt.ok) return undefined; // 国库不足：分成落空但不影响主链路
    return { assetId, seller: asset.seller, amount, confirmedUses: asset.sales };
  }

  getAsset(assetId: string): KnowledgeAsset | undefined {
    const asset = this.assets.get(assetId);
    return asset ? { ...asset, evidence: { ...asset.evidence } } : undefined;
  }

  listAssets(): KnowledgeAsset[] {
    return [...this.assets.values()].map((a) => ({ ...a, evidence: { ...a.evidence } }));
  }

  openBidCount(): number {
    let total = 0;
    for (const bids of this.bidsByAsset.values()) total += bids.length;
    return total;
  }

  tradesLog(limit = 50): TradeRecord[] {
    return this.trades.slice(-limit).map((t) => ({ ...t }));
  }

  /** 智能体感知用的脱敏挂单视图 */
  listingViews(): ListingView[] {
    return [...this.assets.values()].map((a) => ({
      assetId: a.id,
      kind: a.kind,
      seller: a.seller,
      ask: a.ask,
      claimedQuality: a.claimedQuality,
      sales: a.sales,
    }));
  }

  snapshot(): MarketSnapshot {
    const last = this.trades.length > 0 ? this.trades[this.trades.length - 1]!.price : 0;
    return {
      listed: this.assets.size,
      openBids: this.openBidCount(),
      trades: this.trades.length,
      volume: this.volumeTraded,
      lastPrice: last,
    };
  }

  /** 资产证据视图（监管/审计用） */
  assetEvidence(assetId: string, now: number = Date.now()) {
    const asset = this.assets.get(assetId);
    if (!asset) return undefined;
    return { claimedQuality: asset.claimedQuality, ...readEvidence(asset.evidence, now) };
  }
}
