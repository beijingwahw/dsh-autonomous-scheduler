/**
 * agent.ts — 智能体契约与信誉基座（共生进化架构第五阶段 2/4）
 *
 * 质变设计（相对草案 IAgent 的三处结构性修正）：
 *
 * 1. 无 energy 字段、无 receiveEnergy/spendEnergy：
 *    能量只存在于 EnergyLedger，智能体无法伪造或绕过市场转账；
 *    智能体对能量的唯一影响路径 = 提案出价（bid）与成交收入。
 *
 * 2. perceive / propose / execute 三段分离（而非单一 act()）：
 *    智能体只「感知 → 提案」，由运行时+市场+监管撮合批准后授予
 *    ExecutionGrant 才能执行——立法与执法分离，kill-switch/熔断在
 *    批准层自然生效（提案-批准分离是能量预算与安全治理的统一）。
 *
 * 3. goal 是结构化契约（关联指标 + 生存线），且信誉（Reputation）
 *    不是自述而是证据：直接复用 core/evidence 统计内核——
 *    贡献成功率的 Wilson 置信下界决定分红权重与定价可信度，
 *    小样本保守、时间衰减、表现差自然饿死休眠。
 *    「把项目的统计内核升级为经济内核」是本阶段的核心突破。
 *
 * 生命周期：active（参与感知/提案/执行）⇄ dormant（饥饿休眠，
 * 不被调度不消耗心跳；可被央行救济或分红唤醒复活）。
 */

import {
  initEvidence,
  observeEvidence,
  readEvidence,
  type EvidenceView,
  type MemoryEvidence,
} from '../core/evidence.js';
import type { BeliefView } from './belief.js';

/** 智能体种类（对应认知生态中的角色） */
export type AgentKind = 'memory' | 'reflector' | 'optimizer' | 'evolver' | 'curiosity' | 'world-model' | 'model';

/** 运行模式：活跃 / 饥饿休眠 */
export type AgentMode = 'active' | 'dormant';

/** 信誉等级：由证据统计自动晋级，不可自封 */
export type ReputationTier = 'seed' | 'established' | 'elite';

/** 结构化目标（可机器观测，而非自由文本口号） */
export interface AgentGoal {
  /** 目标陈述（人类可读） */
  objective: string;
  /** 关联的可观测指标名（供心智报告/元认知层归因） */
  metrics: string[];
  /** 能量生存线：低于此值进入休眠 */
  survivalThreshold: number;
}

/** 证据化信誉视图（Wilson 口径，与全层统计语言一致） */
export interface AgentReputation {
  tier: ReputationTier;
  /** 有效样本量（时间衰减后） */
  effectiveSamples: number;
  /** Beta 后验均值 */
  posteriorMean: number;
  /** Wilson 95% 置信下界 —— 分红权重与市场定价可信度的统一度量 */
  wilsonLower: number;
  /** 累计收入（能量） */
  earnings: number;
  /** 累计支出（能量） */
  spend: number;
  /** 净流入 */
  netFlow: number;
}

/** 市场行情快照（智能体感知的一部分） */
export interface MarketSnapshot {
  listed: number;
  openBids: number;
  trades: number;
  /** 累计成交额（能量） */
  volume: number;
  /** 最近成交均价 */
  lastPrice: number;
}

/** 市场挂单脱敏视图（买方决策依据；不暴露底层知识本体） */
export interface ListingView {
  assetId: string;
  kind: string;
  seller: string;
  ask: number;
  /** 卖方申报质量（成交后由实测证据校准） */
  claimedQuality: number;
  /** 历史成交次数 */
  sales: number;
}

/** 感知：运行时每轮心跳分发的世界状态切片 */
export interface Perception {
  tick: number;
  timestamp: number;
  /** 自身账户余额（只读快照） */
  ownBalance: number;
  /** 自身信誉视图 */
  reputation: AgentReputation;
  /** 市场行情 */
  market: MarketSnapshot;
  /** 市场挂单列表（脱敏） */
  listings: ReadonlyArray<ListingView>;
  /** 信念市场开放资产视图（隐含概率 = 系统对该断言的市场定价；Phase 2） */
  beliefs?: ReadonlyArray<BeliefView>;
  /** 系统信号（成功率/质量/负载等数值观测，键由宿主定义） */
  signals: Readonly<Record<string, number>>;
}

export type ProposalKind =
  | 'list-knowledge' // 挂卖知识（bid=要价 ask）
  | 'buy-knowledge' // 买入知识（bid=出价）
  | 'maintenance' // 记忆维护等低成本行动
  | 'evolution' // 沙盒进化等高成本行动
  | 'exploration' // 好奇探索
  | 'bet-belief' // 信念下注（bid=预算上限；把价格推向自己的估计）
  | 'idle'; // 空转（零成本，维持在线）

/** 智能体提案：意图 + 出价。运行时/市场/监管批准后才生效 */
export interface AgentProposal {
  id: string;
  kind: ProposalKind;
  description: string;
  /** 行动类=愿意支付的能量；list-knowledge=要价；bet-belief=下注预算上限 */
  bid: number;
  /** 关联知识引用（记忆指纹 / 策略 id / 市场 assetId / 信念 assetId） */
  assetRef?: string;
  /** 挂卖时的申报质量（0~1，成交后由使用证据校准） */
  claimedQuality?: number;
  /** 挂卖/购买的资产种类（pattern/semantic/procedural/strategy/policy-gene 等） */
  assetKind?: string;
  /** bet-belief：下注方向 */
  outcome?: 'YES' | 'NO';
  /** bet-belief：自己对该方向的估计概率（把市场价格推到此值，激励相容动作） */
  targetPrice?: number;
  /** 提案有效期（心跳轮数，缺省 1） */
  ttlTicks?: number;
}

/** 执行授权：能量已预扣托管，智能体据此执行被批准的行动 */
export interface ExecutionGrant {
  agentId: string;
  proposal: AgentProposal;
  /** 已托管（escrow）的能量预算 */
  budget: number;
  approvedAt: number;
}

/** 行动结果 */
export interface ActionResult {
  success: boolean;
  /** 申报价值估计（0~1，供分红与信誉观测参考） */
  valueEstimate: number;
  summary: string;
  data?: unknown;
}

/**
 * 智能体契约（共生层第五阶段契约；稳定后可提升至 contracts.ts）。
 *
 * 实现方约束：
 * - propose() 必须为同步纯决策（基于最近一次 perceive 的快照），不得有副作用；
 * - execute() 只在收到 ExecutionGrant 后被调用，重操作全部放在这里；
 * - 不得缓存 Ledger/Market 引用（构造注入仅限只读回调）。
 */
export interface IAgent {
  readonly id: string;
  readonly kind: AgentKind;
  goal(): AgentGoal;
  mode(): AgentMode;
  reputation(): AgentReputation;
  perceive(p: Perception): void;
  propose(): AgentProposal[];
  execute(grant: ExecutionGrant): Promise<ActionResult>;
}

/** 可选成交回调：买方智能体实现 notePurchase 时，运行时在成交后自动通知（已购去重的数据来源） */
export interface TradeListener {
  notePurchase(assetId: string, refId: string, price: number): void;
}

/** 结构化能力检测（IAgent 可选能力，非破坏性扩展） */
export function isTradeListener(agent: IAgent): agent is IAgent & TradeListener {
  return typeof (agent as Partial<TradeListener>).notePurchase === 'function';
}

/**
 * 运行时托管钩子（AgentBase 统一提供，自定义智能体请继承 AgentBase）：
 * 模式切换 / 贡献观测 / 收支记账均由运行时驱动——智能体自身无法
 * 自增能量、自切模式，能量与信誉的唯一合法来源在宿主侧。
 */
export interface ManagedAgent extends IAgent {
  setMode(mode: AgentMode): void;
  recordContribution(success: boolean, now?: number): void;
  noteEarnings(amount: number): void;
  noteSpend(amount: number): void;
}

/** 信誉晋级门槛 */
const TIER_SEED_MAX_SAMPLES = 5;
const TIER_ELITE_MIN_SAMPLES = 20;
const TIER_ELITE_MIN_WILSON = 0.6;

/**
 * 智能体基座：证据化信誉 + 收支记账 + 模式切换的共享实现。
 * 子类只需实现 goal/propose/execute（perceive 默认存快照）。
 */
export abstract class AgentBase implements IAgent {
  abstract readonly kind: AgentKind;

  protected lastPerception: Perception | undefined;
  private modeFlag: AgentMode = 'active';
  private readonly evidence: MemoryEvidence;
  private earningsTotal = 0;
  private spendTotal = 0;
  private proposalCounter = 0;

  constructor(readonly id: string, createdAt: number = Date.now()) {
    this.evidence = initEvidence(0, 0, createdAt);
  }

  abstract goal(): AgentGoal;

  perceive(p: Perception): void {
    this.lastPerception = p;
  }

  /** 默认空转提案（子类按角色覆写） */
  propose(): AgentProposal[] {
    return [this.proposal('idle', '空转观测', 0)];
  }

  /** 默认 no-op 执行（市场类提案无需 execute，由运行时直接撮合） */
  async execute(grant: ExecutionGrant): Promise<ActionResult> {
    return {
      success: true,
      valueEstimate: 0,
      summary: `no-op:${grant.proposal.kind}`,
    };
  }

  mode(): AgentMode {
    return this.modeFlag;
  }

  /** 模式切换由运行时驱动（休眠/复活），智能体自身只读 */
  setMode(mode: AgentMode): void {
    this.modeFlag = mode;
  }

  /** 贡献观测（由运行时在任务结算时回调）——信誉的唯一来源 */
  recordContribution(success: boolean, now: number = Date.now()): void {
    observeEvidence(this.evidence, success, now);
  }

  reputation(now: number = Date.now()): AgentReputation {
    const view = readEvidence(this.evidence, now);
    return {
      tier: tierOf(view),
      effectiveSamples: view.effectiveSamples,
      posteriorMean: view.posteriorMean,
      wilsonLower: view.wilsonLower,
      earnings: this.earningsTotal,
      spend: this.spendTotal,
      netFlow: this.earningsTotal - this.spendTotal,
    };
  }

  /** 收入记账（由运行时经账本/市场回调，智能体不可自增） */
  noteEarnings(amount: number): void {
    if (amount > 0) this.earningsTotal += amount;
  }

  /** 支出记账 */
  noteSpend(amount: number): void {
    if (amount > 0) this.spendTotal += amount;
  }

  /** 提案 id 生成（id 稳定可追溯） */
  protected proposal(kind: ProposalKind, description: string, bid: number, extra: Partial<AgentProposal> = {}): AgentProposal {
    this.proposalCounter += 1;
    return {
      id: `${this.id}#${this.proposalCounter}`,
      kind,
      description,
      bid,
      ttlTicks: 1,
      ...extra,
    };
  }
}

function tierOf(view: EvidenceView): ReputationTier {
  if (view.effectiveSamples < TIER_SEED_MAX_SAMPLES) return 'seed';
  if (view.effectiveSamples >= TIER_ELITE_MIN_SAMPLES && view.wilsonLower >= TIER_ELITE_MIN_WILSON) return 'elite';
  return 'established';
}
