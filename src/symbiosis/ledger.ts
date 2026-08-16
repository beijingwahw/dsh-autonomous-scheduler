/**
 * ledger.ts — 认知能量账本（共生进化架构第五阶段 1/4）
 *
 * 质变设计（相对"agent.energy 公开字段"草案的三重升级）：
 *
 * 1. 能量不可伪造：智能体没有 energy 字段，能量只存在于账本账户中，
 *    只能经 transfer/mint/burn 流转；每笔流转双方平衡（复式记账），
 *    全局守恒律恒成立：Σ(所有账户余额) === initialSupply + minted。
 *
 * 2. 链式哈希审计：每笔转账携带 sha256 链哈希（前序哈希 + 本笔内容），
 *    任何对历史凭证的篡改都会导致 verifyChain() 失败——能量流向可审计、
 *    可回放、不可抵赖。这是"玩具模拟"与"经济系统"的分水岭。
 *
 * 3. 生态健康可观测：giniCoefficient() 度量能量分布集中度——
 *    能量过度集中 = 垄断 = 认知生态死亡信号（单一智能体买断全部资源，
 *    多样性消失，进化停滞）。监管层可据此调节铸币与救济策略。
 *
 * 账户语义：
 * - treasury：央行国库（初始供给 + 任务成功铸币收入池），仅 runtime 持有账本引用
 * - burn（INCINERATOR）：燃烧池，burn 的能量退出流通但保留审计痕迹
 * - escrow：行动预扣托管（提案批准 → 预扣；执行完毕 → 燃烧/退还）
 *
 * 权限模型（Phase 1）：EnergyLedger 实例仅由 SymbiosisRuntime / CognitiveMarket
 * 持有；智能体只拿到只读快照（Perception.ownBalance），无法绕过市场直接转账。
 */

import { createHash } from 'node:crypto';

/** 账户 id（智能体 id / 内部账户） */
export type AccountId = string;

/** 央行国库：初始供给与铸币收入池 */
export const TREASURY: AccountId = 'treasury';
/** 燃烧池：burn 的能量退出流通（余额保留供审计） */
export const INCINERATOR: AccountId = 'burn';
/** 行动预扣托管账户 */
export const ESCROW: AccountId = 'escrow';

/** 单笔能量流转凭证（复式记账：from 失去 = to 得到，恒等） */
export interface EnergyTransfer {
  seq: number;
  from: AccountId;
  to: AccountId;
  amount: number;
  reason: string;
  /** 关联对象（资产 id / 提案 id / 交易 seq 等） */
  refId?: string;
  timestamp: number;
  /** 链式哈希：sha256(prevHash + 本笔内容) */
  hash: string;
}

export type TransferError =
  | 'non-positive-amount'
  | 'unknown-account'
  | 'insufficient-funds'
  | 'frozen-account'
  | 'self-transfer';

export interface TransferReceipt {
  ok: boolean;
  error?: TransferError;
  transfer?: EnergyTransfer;
}

export interface LedgerConfig {
  /** 央行初始供给（默认 10000） */
  initialSupply?: number;
  /** 凭证日志上限（默认 2000，超出滑出最旧） */
  journalLimit?: number;
}

export interface LedgerStats {
  /** 守恒总供给 = initialSupply + minted */
  totalSupply: number;
  /** 流通供给（总供给 - 燃烧池余额） */
  circulatingSupply: number;
  minted: number;
  burned: number;
  transfers: number;
  accounts: number;
  frozenAccounts: number;
  /** 能量分布基尼系数（默认不含 treasury/内部账户） */
  gini: number;
  chainHead: string;
  chainIntact: boolean;
}

/** 账本可持久化快照（同时服务测试篡改注入） */
export interface LedgerSnapshot {
  balances: Array<[AccountId, number]>;
  frozen: AccountId[];
  journal: EnergyTransfer[];
  seqCounter: number;
  minted: number;
  initialSupply: number;
  /** 链锚点（journalLimit 裁剪后与创世哈希解耦；旧快照缺省回退 GENESIS） */
  chainAnchor?: string;
}

const GENESIS_HASH = '0'.repeat(64);

export class EnergyLedger {
  private balances = new Map<AccountId, number>();
  private frozen = new Set<AccountId>();
  private journal: EnergyTransfer[] = [];
  private chainHead = GENESIS_HASH;
  /** 链锚点：被裁剪的最后一条凭证哈希（verifyChain 由此起验） */
  private chainAnchor: string = GENESIS_HASH;
  private seqCounter = 0;
  private mintedTotal = 0;
  private readonly initialSupply: number;
  private readonly journalLimit: number;

  constructor(config: LedgerConfig = {}) {
    this.initialSupply = Math.max(0, config.initialSupply ?? 10_000);
    this.journalLimit = Math.max(10, config.journalLimit ?? 2_000);
    this.balances.set(TREASURY, this.initialSupply);
    this.balances.set(INCINERATOR, 0);
    this.balances.set(ESCROW, 0);
  }

  /** 开户（零余额；初始注资由调用方经 treasury transfer 完成） */
  openAccount(id: AccountId): boolean {
    if (this.balances.has(id)) return false;
    this.balances.set(id, 0);
    return true;
  }

  hasAccount(id: AccountId): boolean {
    return this.balances.has(id);
  }

  balance(id: AccountId): number {
    return this.balances.get(id) ?? 0;
  }

  isFrozen(id: AccountId): boolean {
    return this.frozen.has(id);
  }

  freeze(id: AccountId): void {
    if (this.balances.has(id)) this.frozen.add(id);
  }

  unfreeze(id: AccountId): void {
    this.frozen.delete(id);
  }

  /** 原子转账：余额不足/冻结/非法金额全部拒绝，拒绝时状态零变更 */
  transfer(from: AccountId, to: AccountId, amount: number, reason: string, refId?: string): TransferReceipt {
    if (!(amount > 0) || !Number.isFinite(amount)) {
      return { ok: false, error: 'non-positive-amount' };
    }
    if (from === to) return { ok: false, error: 'self-transfer' };
    if (!this.balances.has(from) || !this.balances.has(to)) {
      return { ok: false, error: 'unknown-account' };
    }
    if (this.frozen.has(from)) return { ok: false, error: 'frozen-account' };
    if ((this.balances.get(from) ?? 0) < amount) {
      return { ok: false, error: 'insufficient-funds' };
    }
    this.balances.set(from, (this.balances.get(from) ?? 0) - amount);
    this.balances.set(to, (this.balances.get(to) ?? 0) + amount);
    const entry = this.appendEntry(from, to, amount, reason, refId);
    return { ok: true, transfer: entry };
  }

  /** 央行铸币：向 to 增发能量（对应真实价值注入：任务成功/知识生效）。
   *  仅 runtime 持有账本引用时调用；破坏守恒律的唯一入口且被显式记账。 */
  mint(to: AccountId, amount: number, reason: string, refId?: string): TransferReceipt {
    if (!(amount > 0) || !Number.isFinite(amount)) {
      return { ok: false, error: 'non-positive-amount' };
    }
    if (!this.balances.has(to)) return { ok: false, error: 'unknown-account' };
    this.balances.set(to, (this.balances.get(to) ?? 0) + amount);
    this.mintedTotal += amount;
    const entry = this.appendEntry('(mint)', to, amount, reason, refId);
    return { ok: true, transfer: entry };
  }

  /** 燃烧：能量转入燃烧池退出流通（余额保留供审计与守恒校验） */
  burn(from: AccountId, amount: number, reason: string, refId?: string): TransferReceipt {
    return this.transfer(from, INCINERATOR, amount, reason, refId);
  }

  /** 已燃烧总量 */
  burned(): number {
    return this.balance(INCINERATOR);
  }

  /** 央行铸币总量 */
  minted(): number {
    return this.mintedTotal;
  }

  /** 守恒总供给 = initialSupply + minted */
  totalSupply(): number {
    return this.initialSupply + this.mintedTotal;
  }

  /** 流通供给 = 总供给 - 燃烧池余额 - 托管余额 */
  circulatingSupply(): number {
    return this.totalSupply() - this.balance(INCINERATOR) - this.balance(ESCROW);
  }

  /**
   * 基尼系数（0 完全平等 → 1 完全垄断）。
   * 默认只统计智能体账户（排除 treasury/burn/escrow 内部账户）——
   * 内部账户是基础设施而非生态成员，计入会稀释真实集中度信号。
   * 零余额账户**保留**在统计内：这是基尼系数的标准口径（零收入人口
   * 计入分母）——饿死归零 / 尚未入场的智能体都是生态成员，「很多
   * 零余额者」本身就是分布的事实而非统计噪声，剔除会系统性低估
   * 集中度（[100,0] 标准值 0.5，剔除后虚降为 0）
   */
  giniCoefficient(includeInternal = false): number {
    const INTERNAL = new Set([TREASURY, INCINERATOR, ESCROW]);
    const values: number[] = [];
    for (const [id, bal] of this.balances) {
      if (!includeInternal && INTERNAL.has(id)) continue;
      values.push(bal);
    }
    const n = values.length;
    if (n === 0) return 0;
    const total = values.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    let weightedSum = 0;
    for (let i = 0; i < n; i++) weightedSum += (i + 1) * sorted[i]!;
    return Math.max(0, (2 * weightedSum) / (n * total) - (n + 1) / n);
  }

  /** 最近 limit 条凭证（拷贝，外部修改不影响账本） */
  audit(limit = 50): EnergyTransfer[] {
    return this.journal.slice(-limit).map((t) => ({ ...t }));
  }

  /** 守恒律校验：Σ(所有账户余额) === initialSupply + minted */
  verifyConservation(): boolean {
    let sum = 0;
    for (const bal of this.balances.values()) sum += bal;
    return Math.abs(sum - this.totalSupply()) < 1e-9;
  }

  /** 链完整性校验：重算全链哈希，任何历史篡改即刻暴露 */
  verifyChain(): boolean {
    // 从链锚点起验：journalLimit 裁剪掉创世段后，链头与 GENESIS 不再
    // 直连——固定从 GENESIS 起验会让 chainIntact 在首次裁剪后永久 false
    let prev = this.chainAnchor;
    for (const entry of this.journal) {
      const expected = hashEntry(prev, entry);
      if (expected !== entry.hash) return false;
      prev = entry.hash;
    }
    return true;
  }

  stats(): LedgerStats {
    return {
      totalSupply: this.totalSupply(),
      circulatingSupply: this.circulatingSupply(),
      minted: this.mintedTotal,
      burned: this.balance(INCINERATOR),
      transfers: this.journal.length,
      accounts: this.balances.size,
      frozenAccounts: this.frozen.size,
      gini: this.giniCoefficient(),
      chainHead: this.chainHead,
      chainIntact: this.verifyChain(),
    };
  }

  /** 导出快照（持久化 / 测试篡改注入用） */
  snapshotState(): LedgerSnapshot {
    return {
      balances: [...this.balances.entries()],
      frozen: [...this.frozen],
      journal: this.journal.map((t) => ({ ...t })),
      seqCounter: this.seqCounter,
      minted: this.mintedTotal,
      initialSupply: this.initialSupply,
      chainAnchor: this.chainAnchor,
    };
  }

  /** 导入快照（原子整体替换） */
  restoreState(snap: LedgerSnapshot): void {
    this.balances = new Map(snap.balances);
    this.frozen = new Set(snap.frozen);
    this.journal = snap.journal.map((t) => ({ ...t }));
    this.seqCounter = snap.seqCounter;
    this.mintedTotal = snap.minted;
    this.chainAnchor = snap.chainAnchor ?? GENESIS_HASH;
    this.chainHead = this.journal.length > 0 ? this.journal[this.journal.length - 1]!.hash : GENESIS_HASH;
  }

  private appendEntry(from: AccountId, to: AccountId, amount: number, reason: string, refId?: string): EnergyTransfer {
    const entry: EnergyTransfer = {
      seq: ++this.seqCounter,
      from,
      to,
      amount,
      reason,
      refId,
      timestamp: Date.now(),
      hash: '',
    };
    entry.hash = hashEntry(this.chainHead, entry);
    this.chainHead = entry.hash;
    this.journal.push(entry);
    if (this.journal.length > this.journalLimit) {
      // 滑出最旧凭证：锚点前移到最后一条被裁剪者，保留的链段仍连续可验
      const overflow = this.journal.length - this.journalLimit;
      this.chainAnchor = this.journal[overflow - 1]!.hash;
      this.journal.splice(0, overflow);
    }
    return entry;
  }
}

function hashEntry(prevHash: string, entry: Omit<EnergyTransfer, 'hash'>): string {
  return createHash('sha256')
    .update(`${prevHash}|${entry.seq}|${entry.from}|${entry.to}|${entry.amount}|${entry.reason}|${entry.refId ?? ''}|${entry.timestamp}`)
    .digest('hex');
}
