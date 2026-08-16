/**
 * bridge.ts — 共生融合桥（共生进化架构第五阶段 Phase 2.5）
 *
 * 宿主（autonomy-loop 主链路）与共生运行时（能量经济 + 信念市场）之间的
 * 两个薄接点，让影子系统开始产生真实价值：
 *
 * 接点 1（信息流入 → 漂移报警）：
 *   heartbeat(kpi) 把宿主 KPI 快照翻译为共生心跳信号——
 *   - 系统信号表：全局成功率 + 逐模型成功率（既是智能体感知的私有信息源，
 *     也是到期信念的 realized 结算值）；
 *   - 元认知对账的 externalEstimates：同一 KPI 即「被动统计估计」；
 *   - 滚动对账信念：全局 + 逐模型各维持一条 open 信念（市场预测未来
 *     horizon 拍的该指标 > 阈值），到期用真实观测 KPI 结算——市场在
 *     「预测」宿主，结算在「审计」预测。
 *   tick 报告中的 divergence（市场隐含概率 vs 被动统计估计的显著背离）
 *   被转换为 source='market' 的 Insight，回流目标引擎生成自愈目标——
 *   模型漂移的第一现场由市场先行报警。
 *
 * 接点 2（价值流入 → 能量铸币）：
 *   settleTask(planResult) 从计划执行结果的逐节点记录聚合贡献者
 *   （各模型按成功节点的质量加权），调用 runtime.settleTaskOutcome——
 *   任务成功 = 央行铸币按贡献分红，「模型靠把任务做好赚能量」从
 *   机制变成宿主主链路的真实闭环。
 *
 * 接点 3（A 路线：futarchy 进化表决）：
 *   attachEvolver(runCycle) 把宿主 PolicyEvolver 的真实进化周期注册为
 *   进化智能体的高成本行动——此后「是否花能量进化」不再由心跳无条件
 *   触发，而由信念市场表决：进化者提案 → 决策资产上市 → 次拍用私有
 *   信息（上轮沙盒增益）自注定价 → 隐含成功概率 ≥ 门槛且监管放行 →
 *   资助执行真实进化周期（预扣燃烧）；否则市场否决 / 治理一票否决。
 *   进化贡献者凭「部署中的策略基因」参与任务分红（dividendWeight）——
 *   进化经济自持：好进化者靠分红续命，差进化者破产停摆（自然选择）。
 *
 * 权限与安全：桥接器是 SymbiosisRuntime 的唯一持有者；智能体仍只能经
 * 感知视图只读、经提案由运行时代为成交。缺省关闭（影子系统，零行为漂移）。
 */

import type { Insight } from '../goal-engine.js';
import type { KpiSnapshot } from '../meta-cognition.js';
import type { LongTermMemory } from '../memory/long-term-memory.js';
import { AgentBase, type AgentProposal } from './agent.js';
import type { GovernanceGate, SymbiosisTickReport } from './runtime.js';
import { SymbiosisRuntime, type DistributionReport, type SymbiosisConfig } from './runtime.js';
import { TREASURY } from './ledger.js';
import { EvolverAgent, MemoryAgent, OptimizerAgent, type EvolutionCycleOutcome, type MemoryAgentConfig, type OptimizerAgentConfig } from './wrappers.js';
import { buildEnergySankey, renderSankeyHtml, type EnergySankeyReport } from './observability.js';

/** 全局成功率信号键（同时是滚动信念的 subject 与 externalEstimates 的键） */
export const SIGNAL_GLOBAL_SUCCESS = 'task.successRate';
/** 兼容键：wrappers.OptimizerAgent 读取的信号名 */
export const SIGNAL_GLOBAL_SUCCESS_ALIAS = 'taskSuccessRate';

/** 单模型成功率信号键 */
export function modelSignalKey(modelId: string): string {
  return `model.${modelId}.successRate`;
}

/** 模型智能体账户 id */
export function modelAgentId(modelId: string): string {
  return `model:${modelId}`;
}

/**
 * 模型智能体：宿主 LLM 在认知生态中的化身。
 *
 * 不主动执行任何行动（模型服务本身在宿主操作环）；其经济角色有二：
 * 1. 用「自身近期表现」作为私有信息，在信念市场为自己（及全局指标）
 *    的未来成功率定价——表现好的模型把价格推向乐观，赚结算兑付；
 *    表现差的自然亏损（信息劣势被套利）。
 * 2. 作为任务结算的贡献者，靠成功任务赚取央行铸币分红。
 */
export class ModelAgent extends AgentBase {
  readonly kind = 'model' as const;

  private readonly betBudget: number;
  private readonly reserveBalance: number;
  private betAssets = new Set<string>();

  constructor(
    readonly modelId: string,
    config: { betBudget?: number; reserveBalance?: number } = {},
  ) {
    super(modelAgentId(modelId));
    this.betBudget = Math.max(1, config.betBudget ?? 6);
    this.reserveBalance = Math.max(0, config.reserveBalance ?? 10);
  }

  goal() {
    return {
      objective: `以高成功率服务宿主任务（模型 ${this.modelId}）`,
      metrics: [modelSignalKey(this.modelId)],
      survivalThreshold: 5,
    };
  }

  propose(): AgentProposal[] {
    const p = this.lastPerception;
    if (!p) return [];
    const ownRate = p.signals[modelSignalKey(this.modelId)];
    if (!Number.isFinite(ownRate)) return [];
    if (p.ownBalance < this.reserveBalance + this.betBudget) return [];

    const estimate = Math.min(0.92, Math.max(0.08, ownRate));
    const proposals: AgentProposal[] = [];
    for (const belief of p.beliefs ?? []) {
      if (belief.status !== 'open' || belief.settleAtTick < p.tick) continue;
      const isOwn = belief.subject === modelSignalKey(this.modelId);
      const isGlobal = belief.subject === SIGNAL_GLOBAL_SUCCESS;
      // futarchy 决策资产：模型近期表现是「沙盒进化能否产出收益」的
      // 真实私有信息（沙盒以近期任务反馈评估候选策略）——健康模型的
      // 乐观定价与衰败模型的悲观定价共同构成进化资助的市场裁决
      const isEvolutionDecision = belief.subject.startsWith('evolution:');
      if (!isOwn && !isGlobal && !isEvolutionDecision) continue; // 只对自有信息有发言权的市场下注
      if (this.betAssets.has(belief.assetId)) continue; // 每条信念只定价一次

      if (isEvolutionDecision) {
        // 进化成功概率 ≈ 系统健康度映射：近期成功率越高，沙盒素材越好
        const outcome = estimate >= 0.5 ? 'YES' : 'NO';
        const targetPrice = outcome === 'YES' ? estimate : 1 - estimate;
        proposals.push(
          this.proposal(
            'bet-belief',
            `模型 ${this.modelId} 对进化决策定价 ${outcome}@${targetPrice.toFixed(2)}（私有信息：近期成功率 ${ownRate.toFixed(2)}）`,
            this.betBudget,
            { assetRef: belief.assetId, outcome, targetPrice },
          ),
        );
        this.betAssets.add(belief.assetId);
        continue;
      }
      proposals.push(
        this.proposal(
          'bet-belief',
          `模型 ${this.modelId} 对 ${belief.subject} 定价 YES@${estimate.toFixed(2)}（私有信息：近期成功率 ${ownRate.toFixed(2)}）`,
          this.betBudget,
          { assetRef: belief.assetId, outcome: 'YES', targetPrice: estimate },
        ),
      );
      this.betAssets.add(belief.assetId);
    }
    return proposals;
  }
}

/** 共生融合桥配置 */
export interface SymbiosisBridgeConfig {
  /** 是否启用（缺省 false——影子系统，不改变既有主链路行为） */
  enabled?: boolean;
  /** 滚动信念周期（心跳拍数，缺省 3：市场预测 3 拍后的指标） */
  beliefHorizonTicks?: number;
  /** 全局成功率信念阈值（缺省 0.8，与元认知 successRateTarget 对齐） */
  globalSuccessThreshold?: number;
  /** 单模型成功率信念阈值（缺省 0.7） */
  modelSuccessThreshold?: number;
  /** 模型智能体单信念下注预算（缺省 6） */
  modelBetBudget?: number;
  /** 模型智能体保留余额（低于此值+预算不再下注，缺省 10） */
  modelReserveBalance?: number;
  /** 元认知对账背离阈值（缺省 0.15，透传 runtime） */
  divergenceMargin?: number;
  /** 单轮最多产出的漂移洞察数（缺省 3，防告警风暴） */
  maxDriftInsightsPerTick?: number;
  /**
   * A 路线：futarchy 进化表决（缺省关闭）。
   * 启用后须调用 attachEvolver() 绑定真实进化周期；宿主 autonomy-loop
   * 应停止直连执行进化（市场成为高成本进化的唯一资助闸门）。
   */
  futarchy?: {
    /** 是否启用（缺省 false） */
    enabled?: boolean;
    /** 资助门槛：隐含成功概率下限（缺省 0.55，透传 runtime） */
    minImpliedProb?: number;
    /** 决策资产流动性 b（缺省 6，透传 runtime） */
    decisionB?: number;
    /** 进化行动成本（缺省 50，EvolverAgent 提案 bid） */
    evolutionCost?: number;
    /** 发起进化的余额门槛（缺省 60） */
    evolutionBalanceThreshold?: number;
    /** 自注预算上限（缺省 12：足够把价格从 0.5 推到 ~0.77） */
    selfBetBudget?: number;
  };
  /**
   * B 路线：能量反哺调度（缺省关闭）。
   * economicSignals() 把生态经济健康度（余额 × Wilson 信誉）折算为
   * 调度乘数注入 ModelScheduler——赚钱的模型升权、亏钱的模型降权，
   * 能量从记账数字变成真实的调度行为压力。
   */
  economic?: {
    /** 信誉在经济健康度中的权重（缺省 0.6；余额权重 = 1 − 此值） */
    reputationWeight?: number;
    /** 调度乘数下限（缺省 0.5：亏损模型最多打对折，仍可被选中——经济压力是软约束，不死锁） */
    minMultiplier?: number;
    /** 调度乘数上限（缺省 1.5：盈利模型最多加成一半） */
    maxMultiplier?: number;
    /** 中性健康度锚点（缺省 0.5：h = 该值时乘数恰为 1） */
    neutralHealth?: number;
    /** 余额归一化基准（缺省 100 = 开业注资；余额达 2× 基准即满格） */
    balanceBaseline?: number;
  };
  /** 透传 SymbiosisRuntime 的其余配置（期初供给/开业注资等） */
  runtime?: SymbiosisConfig;
}

/**
 * 共生融合桥：宿主主链路 ⇄ 共生运行时的唯一通道。
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳调用 heartbeat()（KPI 注入 +
 * 漂移洞察回流），任务执行完成后调用 settleTask()（价值铸币）。
 */
export class SymbiosisBridge {
  readonly runtime: SymbiosisRuntime;
  private modelAgents = new Map<string, ModelAgent>();
  private heartbeatCount = 0;
  private evolver?: EvolverAgent;
  private evolverDividendWeight?: () => number | undefined;
  private memoryAgentInstance?: MemoryAgent;
  private optimizerAgentInstance?: OptimizerAgent;
  private futarchyLog: SymbiosisTickReport['futarchyDecisions'] = [];
  private readonly cfg: Required<Pick<SymbiosisBridgeConfig, 'beliefHorizonTicks' | 'globalSuccessThreshold' | 'modelSuccessThreshold' | 'modelBetBudget' | 'modelReserveBalance' | 'divergenceMargin' | 'maxDriftInsightsPerTick'>> & {
    futarchy: Required<NonNullable<SymbiosisBridgeConfig['futarchy']>>;
    economic: Required<NonNullable<SymbiosisBridgeConfig['economic']>>;
  };

  constructor(config: SymbiosisBridgeConfig = {}, governor?: GovernanceGate) {
    this.cfg = {
      beliefHorizonTicks: config.beliefHorizonTicks ?? 3,
      globalSuccessThreshold: config.globalSuccessThreshold ?? 0.8,
      modelSuccessThreshold: config.modelSuccessThreshold ?? 0.7,
      modelBetBudget: config.modelBetBudget ?? 6,
      modelReserveBalance: config.modelReserveBalance ?? 10,
      divergenceMargin: config.divergenceMargin ?? 0.15,
      maxDriftInsightsPerTick: config.maxDriftInsightsPerTick ?? 3,
      futarchy: {
        enabled: config.futarchy?.enabled ?? false,
        minImpliedProb: config.futarchy?.minImpliedProb ?? 0.55,
        decisionB: config.futarchy?.decisionB ?? 6,
        evolutionCost: config.futarchy?.evolutionCost ?? 50,
        evolutionBalanceThreshold: config.futarchy?.evolutionBalanceThreshold ?? 60,
        selfBetBudget: config.futarchy?.selfBetBudget ?? 12,
      },
      economic: {
        reputationWeight: config.economic?.reputationWeight ?? 0.6,
        minMultiplier: config.economic?.minMultiplier ?? 0.5,
        maxMultiplier: config.economic?.maxMultiplier ?? 1.5,
        neutralHealth: config.economic?.neutralHealth ?? 0.5,
        balanceBaseline: config.economic?.balanceBaseline ?? 100,
      },
    };
    this.runtime = new SymbiosisRuntime(
      {
        divergenceMargin: this.cfg.divergenceMargin,
        futarchyEnabled: this.cfg.futarchy.enabled,
        futarchyMinImpliedProb: this.cfg.futarchy.minImpliedProb,
        futarchyDecisionB: this.cfg.futarchy.decisionB,
        ...config.runtime,
      },
      governor,
    );
  }

  /** 注册宿主模型（为其开立模型智能体账户并注入开业能量） */
  registerModel(modelId: string): void {
    if (!modelId || this.modelAgents.has(modelId)) return;
    const agent = new ModelAgent(modelId, { betBudget: this.cfg.modelBetBudget, reserveBalance: this.cfg.modelReserveBalance });
    this.runtime.register(agent);
    this.modelAgents.set(modelId, agent);
  }

  /**
   * A 路线：绑定宿主真实进化周期（futarchy 表决的行动本体）。
   *
   * 注册进化智能体并开启市场资助闸门：进化提案 → 决策资产上市 →
   * 次拍自注定价 → 隐含概率过门槛且监管放行 → 资助执行 runCycle。
   * @param runCycle 宿主桥接的真实进化周期（index.ts: 金丝雀喂数 +
   *        沙盒素材刷新 + PolicyEvolver.runEvolutionCycle）
   * @param opts.dividendWeight 任务成功时进化贡献者的分红权重钩子
   *        （返回 undefined/≤0 = 当前无部署策略，不参与分红）
   */
  attachEvolver(
    runCycle: () => Promise<EvolutionCycleOutcome>,
    opts: { dividendWeight?: () => number | undefined } = {},
  ): EvolverAgent {
    if (this.evolver) return this.evolver; // 幂等：一个宿主只有一个进化器
    const agent = new EvolverAgent('evolver', runCycle, {
      evolutionCost: this.cfg.futarchy.evolutionCost,
      evolutionBalanceThreshold: this.cfg.futarchy.evolutionBalanceThreshold,
      selfBetBudget: this.cfg.futarchy.selfBetBudget,
    });
    this.runtime.register(agent);
    this.evolver = agent;
    this.evolverDividendWeight = opts.dividendWeight;
    return agent;
  }

  /** 进化智能体（未绑定为 undefined；观测/审计用） */
  get evolverAgent(): EvolverAgent | undefined {
    return this.evolver;
  }

  /**
   * D 路线：绑定宿主真实长期记忆（知识卖方智能体）。
   *
   * 注册记忆智能体：真实高置信任务模式挂上认知市场出售（成交价 +
   * 央行版税），周期性支付能量执行真实维护（遗忘曲线幂等，与宿主
   * loop 的维护并行安全，多次调用不复合叠加）。
   * @param memory 宿主 LongTermMemory（只经既有公开 API 读写）
   * @param opts 透传 MemoryAgentConfig（挂卖基准价/门槛/维护间隔等）
   */
  attachMemory(memory: LongTermMemory, opts: MemoryAgentConfig = {}): MemoryAgent {
    if (this.memoryAgentInstance) return this.memoryAgentInstance; // 幂等
    const agent = new MemoryAgent('memory', memory, opts);
    this.runtime.register(agent);
    this.memoryAgentInstance = agent;
    return agent;
  }

  /** 记忆智能体（未绑定为 undefined；观测/审计用） */
  get memoryAgent(): MemoryAgent | undefined {
    return this.memoryAgentInstance;
  }

  /**
   * D 路线：注册优化智能体（知识买方 + 信念下注方）。
   *
   * 真实认知分工市场化：Optimizer 观察市场行情，对高性价比知识出价
   * 购买（runtime 撮合成交后经 TradeListener 自动回调 notePurchase），
   * 并以决策视角参与信念市场下注——与模型智能体构成多方定价。
   * @param opts.onPurchase 成交回调（宿主广播/日志桥接点）
   * @param opts.config 透传 OptimizerAgentConfig（预算/保留余额/质量门槛）
   */
  attachOptimizer(
    opts: { onPurchase?: (assetId: string, refId: string, price: number) => void; config?: OptimizerAgentConfig } = {},
  ): OptimizerAgent {
    if (this.optimizerAgentInstance) return this.optimizerAgentInstance; // 幂等
    const agent = new OptimizerAgent('optimizer', opts.config ?? {}, opts.onPurchase);
    this.runtime.register(agent);
    this.optimizerAgentInstance = agent;
    return agent;
  }

  /** 优化智能体（未绑定为 undefined；观测/审计用） */
  get optimizerAgent(): OptimizerAgent | undefined {
    return this.optimizerAgentInstance;
  }

  /** 最近一次心跳的 futarchy 决议（可观测性：funded / market-rejected / governor-vetoed） */
  lastFutarchyDecisions(): SymbiosisTickReport['futarchyDecisions'] {
    return [...this.futarchyLog];
  }

  /** 已注册模型清单 */
  registeredModels(): string[] {
    return [...this.modelAgents.keys()];
  }

  /**
   * 共生心跳（autonomy-loop 每拍调用）：
   * KPI 快照 → 系统信号 + 被动统计估计 + 滚动信念 → 市场对账 → 漂移洞察。
   * @returns source='market' 的漂移洞察（空数组 = 市场与统计一致）
   */
  async heartbeat(kpi: KpiSnapshot): Promise<Insight[]> {
    this.heartbeatCount += 1;

    // 系统信号表：智能体感知的私有信息源 + 信念结算的 realized 来源
    const signals: Record<string, number> = {
      [SIGNAL_GLOBAL_SUCCESS]: kpi.successRate,
      [SIGNAL_GLOBAL_SUCCESS_ALIAS]: kpi.successRate,
      'task.avgQuality': kpi.avgQuality,
    };
    for (const [modelId, rate] of Object.entries(kpi.modelSuccessRates ?? {})) {
      if (Number.isFinite(rate)) signals[modelSignalKey(modelId)] = rate;
    }

    // 滚动对账信念：全局 + 每个已注册模型各一条 open（预测 horizon 拍后越过阈值）
    this.ensureRollingBelief(SIGNAL_GLOBAL_SUCCESS, `全局任务成功率 > ${this.cfg.globalSuccessThreshold}`, this.cfg.globalSuccessThreshold);
    for (const modelId of this.modelAgents.keys()) {
      this.ensureRollingBelief(modelSignalKey(modelId), `模型 ${modelId} 成功率 > ${this.cfg.modelSuccessThreshold}`, this.cfg.modelSuccessThreshold);
    }

    // 被动统计估计 = 同一份 KPI（市场若与其显著背离 = 模型漂移第一现场）
    const report = await this.runtime.tick(signals, { externalEstimates: signals });
    this.futarchyLog = report.futarchyDecisions;
    return this.divergenceToInsights(report);
  }

  /**
   * 任务结算（宿主计划执行完成后调用）：
   * 逐节点贡献聚合（各模型 = 其成功节点质量之和）→ 央行铸币分红。
   * futarchy 启用时，部署中的策略基因视为任务成功的隐性贡献者
   * （dividendWeight 钩子评估）——进化经济的自持收入来源。
   * 未注册模型的节点不计入；失败任务不铸币但记录贡献证据（信誉惩罚）。
   */
  settleTask(result: {
    success: boolean;
    nodeResults: ReadonlyArray<{ modelId: string; success: boolean; quality: number }>;
  }): DistributionReport {
    const weights = new Map<string, number>();
    for (const node of result.nodeResults) {
      if (!this.modelAgents.has(node.modelId)) continue;
      const contribution = node.success ? Math.max(0.1, node.quality) : 0;
      weights.set(modelAgentId(node.modelId), (weights.get(modelAgentId(node.modelId)) ?? 0) + contribution);
    }
    // 进化贡献者：部署中的策略基因参与分红（好进化者靠分红续命再进化）
    if (result.success && this.evolver && this.evolverDividendWeight) {
      const w = this.evolverDividendWeight();
      if (Number.isFinite(w) && (w as number) > 0) {
        weights.set(this.evolver.id, (weights.get(this.evolver.id) ?? 0) + (w as number));
      }
    }
    if (weights.size === 0) return { totalDistributed: 0, shares: [] };
    const report = this.runtime.settleTaskOutcome(
      result.success,
      [...weights].map(([agentId, weight]) => ({ agentId, weight })),
    );
    // D 路线：已购知识使用反馈——optimizer 购入的知识以真实任务成败参与
    // 定价校准，央行国库按使用向卖方（memory）支付版税：知识按使用付费，
    // 「沉淀知识 → 成交 → 被使用 → 持续变现」的完整认知经济闭环。
    if (this.optimizerAgentInstance) {
      for (const purchase of this.optimizerAgentInstance.purchases()) {
        this.runtime.reportAssetUsage(purchase.assetId, result.success);
      }
    }
    return report;
  }

  /**
   * C 路线：能量 Sankey 报告（生态可观测性）。
   * 聚合链式账本凭证为 分层流量图数据模型（节点余额/流入流出 + 渠道链接），
   * 智能体节点自动携带 kind 标注（模型/进化者/记忆/…）。
   * @param sinceSeq 增量窗口（只聚合 seq > sinceSeq 的凭证；缺省全量）
   */
  sankey(sinceSeq?: number): EnergySankeyReport {
    return buildEnergySankey(this.runtime.ledger, {
      agents: this.runtime.stats().agents.map((a) => ({ id: a.id, kind: a.kind })),
      sinceSeq,
    });
  }

  /** C 路线：自包含 HTML（零依赖离线可开；宿主直接落盘即得能量全景） */
  sankeyHtml(sinceSeq?: number): string {
    return renderSankeyHtml(this.sankey(sinceSeq));
  }

  /**
   * B 路线：模型经济信号 → 调度乘数（能量反哺调度的数据源）。
   *
   * 经济健康度 h = w_rep × Wilson 信誉下界 + w_bal × 余额归一化
   * （余额达 2× balanceBaseline 即满格；信誉为主——长期统计，余额为辅——
   * 短期波动）；调度乘数 m = clamp(h / neutralHealth, min, max)：
   *   赚钱且信誉好的模型 m > 1 升权，持续亏损的模型 m < 1 降权，
   *   中性健康度恰为 1（不奖不罚）。
   *
   * 设计护栏：乘数有界（缺省 0.5~1.5，亏损最多打对折但仍可被选中——
   * 经济压力是软约束，不造成调度死锁）；未注册模型 / 无信号模型
   * 不出现在返回中（调度器对缺失信号保持乘数 1 的中性行为）。
   */
  economicSignals(): Map<string, { balance: number; reputationLower: number; health: number; multiplier: number }> {
    const { reputationWeight, minMultiplier, maxMultiplier, neutralHealth, balanceBaseline } = this.cfg.economic;
    const signals = new Map<string, { balance: number; reputationLower: number; health: number; multiplier: number }>();
    for (const agent of this.runtime.stats().agents) {
      if (agent.kind !== 'model') continue;
      const modelId = agent.id.slice('model:'.length);
      if (!this.modelAgents.has(modelId)) continue;
      const balanceNorm = Math.max(0, Math.min(1, agent.balance / (2 * balanceBaseline)));
      const repLower = Math.max(0, Math.min(1, agent.reputation.wilsonLower));
      const health = reputationWeight * repLower + (1 - reputationWeight) * balanceNorm;
      const multiplier = Math.max(minMultiplier, Math.min(maxMultiplier, health / neutralHealth));
      signals.set(modelId, { balance: agent.balance, reputationLower: repLower, health, multiplier });
    }
    return signals;
  }

  /** 生态状态快照（可观测性 / 心智报告采集器用） */
  status(): {
    enabled: boolean;
    registeredModels: string[];
    heartbeats: number;
    gini: number;
    conservationIntact: boolean;
    treasury: number;
    belief: ReturnType<SymbiosisRuntime['beliefMarket']['snapshot']>;
    /** A 路线：futarchy 进化表决状态（未启用时 undefined） */
    futarchy?: {
      enabled: boolean;
      minImpliedProb: number;
      evolver: { balance: number; cyclesRun: number; deployCount: number } | undefined;
      lastDecisions: SymbiosisTickReport['futarchyDecisions'];
    };
  } {
    return {
      enabled: true,
      registeredModels: this.registeredModels(),
      heartbeats: this.heartbeatCount,
      gini: this.runtime.ledger.giniCoefficient(),
      conservationIntact: this.runtime.ledger.verifyConservation(),
      treasury: this.runtime.ledger.balance(TREASURY),
      belief: this.runtime.beliefMarket.snapshot(),
      futarchy: this.cfg.futarchy.enabled
        ? {
            enabled: true,
            minImpliedProb: this.cfg.futarchy.minImpliedProb,
            evolver: this.evolver
              ? {
                  balance: this.runtime.ledger.balance(this.evolver.id),
                  ...this.evolver.stats(),
                }
              : undefined,
            lastDecisions: [...this.futarchyLog],
          }
        : undefined,
    };
  }

  /** 确保某 subject 存在 open 信念；否则新上市一条（结算拍 = 下一拍 + horizon） */
  private ensureRollingBelief(subject: string, claim: string, threshold: number): void {
    const open = this.runtime.beliefMarket.views().find((v) => v.subject === subject && v.status === 'open');
    if (open) return;
    this.runtime.beliefMarket.create({
      claim: `${claim}（滚动对账信念）`,
      subject,
      threshold,
      settleAtTick: this.heartbeatCount + 1 + this.cfg.beliefHorizonTicks,
      creator: 'bridge',
    });
  }

  /** 市场背离 → 元认知洞察（模型漂移报警，回流目标引擎） */
  private divergenceToInsights(report: SymbiosisTickReport): Insight[] {
    return report.divergence.slice(0, this.cfg.maxDriftInsightsPerTick).map((d) => ({
      source: 'market' as const,
      category: 'model-drift',
      severity: Math.min(1, 0.5 + d.gap / 2),
      message: `信念市场与统计估计显著背离：${d.subject} 市场 ${d.marketProb.toFixed(2)} vs 统计 ${d.statEstimate.toFixed(2)}（Δ${d.gap.toFixed(2)}）`,
      suggestion: `对「${d.subject}」触发元认知反思：核查关联模型的近期表现与统计基线是否漂移`,
    }));
  }
}
