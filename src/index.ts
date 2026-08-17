/**
 * index.ts — dsh-proactive 核心插件入口（集成层）
 *
 * 职责：整合全部 9 个模块，编排"信号 → 决策 → 执行 → 沉淀"10 步链路
 *
 * 10 步链路（新架构单向数据流：记忆库 → 优化器 → 模型调度/任务执行 → 反思器 → 记忆更新）：
 * 1. 信号接入（Sentinel：webhook / 文件监听 / 轮询 / 手动注入）
 * 2. 信号聚合（Sentinel 聚合窗口去重合并）
 * 3. 优先级排序（strategist 模型紧急度评估，urgency 降序）
 * 4. 战略决策（execute / defer / dismiss / ask-user）
 * 5. 经验检索（Optimizer.lookupExperience → 记忆库模糊匹配 + 推荐模型）
 * 6. 计划生成（Optimizer.recallPlan 快路径 / TaskExecutor.buildPlan：strategist DAG + 离线兜底）
 * 7. 并行执行（TaskExecutor.executePlan：拓扑分层并行，ModelScheduler 推荐模型参与调度）
 * 8. 质量反思（quality < threshold 自动重试 / 切换模型）
 * 9. 级联触发（节点完成触发下游信号，回注 Sentinel）
 * 10. 反思与记忆更新（Reflector.reflectOnOutcome：沉淀 + 策略反馈 + 蒸馏 + 同步变更登记）
 *
 * 14 个 Tool 通过 ToolRegistry 服务注册并经 ctx.provide('schedulerTools') 暴露。
 * 自主智能层（目标引擎 / 元认知 / 策略进化 / 心跳循环）使系统在无外部信号时
 * 也能自我观察、自我改进、自我进化。
 * 全部资源在 fiber 卸载时按依赖逆序清理（cleanup）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';

import { AppError, ConfigError } from './errors.js';
import { CryptoEngine, type EncryptionConfig } from './security/crypto-engine.js';
import { LongTermMemory } from './memory/long-term-memory.js';
import { MemoryGraph } from './memory/memory-graph.js';
import { AliasMap } from './memory/alias-map.js';
import { MigrationTool } from './memory/migration-tool.js';
import { ProgressBroadcaster } from './progress-ws.js';
import { TenantManager } from './tenant/tenant-manager.js';
import { BenchmarkEngine } from './benchmark/benchmark-engine.js';
import { DistributedSync, type SyncNodeConfig } from './sync/distributed-sync.js';
import { RaftEngine, type ConsensusLogEntry } from './consensus/raft-engine.js';
import { HotReloadEngine, type HotReloadConfig } from './hot-reload/hot-reload-engine.js';
import { LLMClient, type ModelConfig } from './llm-client.js';
import { Sentinel, type Signal, type SignalBatch } from './sentinel.js';
import { ModelScheduler } from './model-scheduler.js';
import { TaskExecutor } from './task-executor.js';
import type { NodeRunner, PlanExecutionResult } from './types.js';
import { Optimizer } from './optimizer.js';
import { Reflector } from './reflector.js';
import { attachDashboard } from './dashboard/index.js';
import { DecisionEngine, type Decision, type SignalHistoryStats } from './decision-engine.js';
import { ReflectionEngine } from './reflection-engine.js';
import { GoalEngine, type Goal, type GoalSubtask } from './goal-engine.js';
import { MetaCognitionEngine, type TuningAction } from './meta-cognition.js';
import { StrategyEvolutionEngine } from './strategy-evolution.js';
import { AutonomyLoop } from './autonomy-loop.js';
import { PolicyEvolver } from './policy/policy-evolver.js';
import { Sandbox, buildCalibrationFromMemory, extractReplayTasks, generateAdversarialTasks } from './policy/sandbox.js';
import { SelfModel } from './meta/self-model.js';
import { MetaCognitiveController } from './meta/meta-controller.js';
import type { SimModelStatus } from './policy/policy-types.js';
import { WorldModel } from './world-model.js';
import { CausalKernel } from './core/causal-kernel.js';
import { FreeEnergyEngine } from './core/free-energy.js';
import { DeliberationEngine } from './core/deliberation.js';
import { RationalMetareasoner } from './core/metareasoning.js';
import { AbstractionEngine } from './core/abstraction.js';
import { ScientistMind } from './core/scientist.js';
import { TheoristEngine } from './core/theorist.js';
import { CuriosityEngine, type ExplorationProposal } from './curiosity-engine.js';
import { SafetyGovernor } from './safety-governor.js';
import { SymbiosisBridge } from './symbiosis/bridge.js';
import { HostFusionLayer } from './host-fusion.js';
import { resolveHostLLM, resolveHostModels, resolveHeaderProvider, resolveLocalKeyProvider, describeKeySources, KeyHealthManager } from './dsh-host.js';

// ─────────────────────────── 插件配置类型 ───────────────────────────

/** 插件配置（对应 cordis.patch.yml config 节） */
export interface SchedulerConfig {
  /** 可选：DSH 宿主经 ctx 提供模型时无需配置；apiKey 亦可省略（宿主注入请求头） */
  strategistModel?: { id: string; endpoint: string; apiKey?: string };
  /** 可选：宿主未提供模型目录时的兜底配置 */
  models?: ModelConfig[];
  sentinel: {
    watchCodeChanges: boolean;
    watchErrors: boolean;
    watchPerformance: boolean;
    /** 聚合窗口（秒） */
    aggregationWindow: number;
    signalSources?: Array<{ type: 'webhook' | 'polling' | 'filesystem'; port?: number; interval?: number; url?: string; path?: string; signalType: string }>;
  };
  qualityThreshold: number;
  maxRetries: number;
  globalTimeout: number;
  enableProgress: boolean;
  progressPort: number;
  verbose: boolean;
  experienceStorePath: string;
  encryption: { enabled: boolean; masterKey?: string; algorithm: 'aes-256-gcm' | 'aes-256-cbc'; fullFileEncryption: boolean };
  sync: { localNodeId: string; peers: SyncNodeConfig[] };
  consensus: {
    enabled: boolean;
    localNodeId: string;
    consensusPort: number;
    electionTimeoutMin: number;
    electionTimeoutMax: number;
    heartbeatInterval: number;
    cluster: Array<{ nodeId: string; address: string; port: number; priority?: number }>;
  };
  hotReload: Partial<HotReloadConfig> & { enabled: boolean };
  tenants: Array<any>;
  /** 运行时数据根目录（默认 .scheduler） */
  dataDir?: string;
  /** 经验快路径阈值：命中模式置信度 ≥ 该值时直接复用历史成功计划（缺省 0.9；设 >1 关闭） */
  memoryFastPathThreshold?: number;
  /** LLM 客户端选项覆盖（测试注入 fetchImpl 等） */
  llm?: { fetchImpl?: typeof fetch; timeout?: number };
  /** 执行器节点执行器注入（测试离线模拟） */
  nodeRunner?: NodeRunner;
  /** 决策引擎配置覆盖（闭环深度优化） */
  decision?: Partial<import('./decision-engine.js').DecisionEngineConfig>;
  /** 反思引擎配置覆盖（闭环深度优化） */
  reflection?: Partial<import('./reflection-engine.js').ReflectionEngineConfig>;
  /** 评审模型注入（LLM-as-judge，测试离线模拟） */
  judge?: import('./reflection-engine.js').JudgeModel;
  /** 教训提取器注入（测试离线模拟） */
  lessonExtractor?: import('./reflection-engine.js').LessonExtractor;
  /** 自主智能配置（目标引擎 / 元认知 / 策略进化 / 心跳循环 / 世界模型 / 好奇心 / 安全治理） */
  autonomy?: {
    /** 是否启用自主心跳循环（缺省 true） */
    enabled?: boolean;
    /** 心跳间隔（毫秒，缺省 30000） */
    heartbeatMs?: number;
    /** 目标引擎配置覆盖 */
    goal?: Partial<import('./goal-engine.js').GoalEngineConfig>;
    /** 元认知配置覆盖 */
    metaCognition?: Partial<import('./meta-cognition.js').MetaCognitionConfig>;
    /** 策略进化配置覆盖 */
    evolution?: Partial<import('./strategy-evolution.js').StrategyEvolutionConfig>;
    /**
     * 第三阶段：调度策略进化（PolicyEvolver + Sandbox）配置覆盖。
     * 设为 { enabled: false } 可完全关闭；沙盒离线评估，不阻塞操作环调度。
     */
    policyEvolution?: Partial<import('./policy/policy-evolver.js').PolicyEvolverConfig> & {
      enabled?: boolean;
      /** 沙盒评估配置覆盖 */
      sandbox?: Partial<import('./policy/sandbox.js').SandboxConfig>;
    };
    /**
     * 第四阶段：元认知层（SelfModel + MetaCognitiveController）配置覆盖。
     * 设为 { enabled: false } 可完全关闭外环；心智报告与审计日志落盘 dataDir。
     */
    metaLayer?: {
      enabled?: boolean;
      /** 自我建模配置覆盖 */
      selfModel?: Partial<import('./meta/self-model.js').SelfModelConfig>;
      /** 元认知控制器配置覆盖 */
      controller?: Partial<import('./meta/meta-controller.js').MetaControllerConfig>;
    };
    /** 心跳循环配置覆盖 */
    loop?: Partial<import('./autonomy-loop.js').AutonomyLoopConfig>;
    /**
     * 第五阶段 Phase 2.5：共生进化融合（能量经济 + 信念市场）。
     * 缺省关闭（影子系统，不改变既有主链路行为）；启用后：
     * KPI 注入共生心跳，市场价 vs 统计估计显著背离回流为自愈目标，
     * 任务成功按模型贡献铸币分红（能量经济真实闭环）。
     */
    symbiosis?: {
      /** 是否启用（缺省 false） */
      enabled?: boolean;
      /** 滚动信念周期（心跳拍数，缺省 3） */
      beliefHorizonTicks?: number;
      /** 全局成功率信念阈值（缺省 0.8） */
      globalSuccessThreshold?: number;
      /** 单模型成功率信念阈值（缺省 0.7） */
      modelSuccessThreshold?: number;
      /** 模型智能体单信念下注预算（缺省 6） */
      modelBetBudget?: number;
      /** 元认知对账背离阈值（缺省 0.15） */
      divergenceMargin?: number;
      /**
       * A 路线：futarchy 进化表决（缺省关闭）。
       * 启用后高成本进化周期不再由心跳无条件触发，改由信念市场表决资助
       * （进化者自注私有信息 + 模型健康度定价 ≥ 门槛且监管放行 → 执行）；
       * autonomy-loop 的直连进化桥接自动让位（市场成为唯一资助闸门）。
       */
      futarchy?: {
        /** 是否启用（缺省 false；须同时 symbiosis.enabled = true） */
        enabled?: boolean;
        /** 资助门槛：隐含成功概率下限（缺省 0.55） */
        minImpliedProb?: number;
        /** 决策资产流动性 b（缺省 6） */
        decisionB?: number;
        /** 进化行动成本（能量，缺省 50） */
        evolutionCost?: number;
        /** 发起进化的余额门槛（能量，缺省 60） */
        evolutionBalanceThreshold?: number;
        /** 自注预算上限（能量，缺省 12） */
        selfBetBudget?: number;
      };
      /**
       * B 路线：能量反哺调度（缺省关闭）。
       * 启用后每轮共生心跳把模型经济健康度（余额 × Wilson 信誉）折算为
       * 调度乘数注入 ModelScheduler——赚钱的模型升权、亏钱的模型降权，
       * 能量从记账数字变成真实的调度行为压力（乘数有界 0.5~1.5，
       * 探索加成不受影响，preferred 推荐语义保持）。
       */
      schedulingFeedback?: {
        /** 是否启用（缺省 false；须同时 symbiosis.enabled = true） */
        enabled?: boolean;
        /** 信誉在经济健康度中的权重（缺省 0.6） */
        reputationWeight?: number;
        /** 调度乘数下限（缺省 0.5） */
        minMultiplier?: number;
        /** 调度乘数上限（缺省 1.5） */
        maxMultiplier?: number;
        /** 中性健康度锚点（缺省 0.5） */
        neutralHealth?: number;
        /** 余额归一化基准（缺省 100） */
        balanceBaseline?: number;
      };
      /**
       * C 路线：生态可观测性（缺省关闭）。
       * 设置 sankeyPath 后每 N 拍共生心跳落盘一份自包含能量 Sankey HTML
       * （零依赖离线可开：分层流量图 + 渠道明细 + 账户余额 + 健康快照）。
       */
      observability?: {
        /** Sankey HTML 落盘路径（设置即启用；如 /tmp/symbiosis-sankey.html） */
        sankeyPath?: string;
        /** 每 N 拍心跳落盘一次（缺省 5） */
        everyNTicks?: number;
      };
      /**
       * D 路线：全智能体接入（缺省关闭；须同时 symbiosis.enabled = true）。
       * 记忆智能体把真实高置信任务模式挂上认知市场（成交 + 央行版税），
       * 优化智能体以决策视角买知识 + 参与信念下注——认知分工完全市场化。
       * （进化智能体经 futarchy.enabled → attachEvolver 接入，见上。）
       */
      agents?: {
        /** 记忆智能体（知识卖方）：缺省关闭 */
        memory?: {
          /** 是否启用（缺省 false） */
          enabled?: boolean;
          /** 挂卖定价基准（要价 = base × 置信度，缺省 10） */
          listingBasePrice?: number;
          /** 挂卖门槛：模式置信度（缺省 0.5） */
          listingConfidenceThreshold?: number;
          /** 挂卖门槛：出现频次（缺省 2） */
          listingFrequencyThreshold?: number;
          /** 维护间隔（共生心跳轮数，缺省 5；遗忘曲线幂等，与宿主 loop 维护并行安全） */
          maintenanceInterval?: number;
        };
        /** 优化智能体（知识买方 + 信念下注方）：缺省关闭 */
        optimizer?: {
          /** 是否启用（缺省 false） */
          enabled?: boolean;
          /** 单次购买预算上限（能量，缺省 20） */
          maxBudget?: number;
          /** 保留余额（能量，缺省 30） */
          reserveBalance?: number;
          /** 只买申报质量下限（缺省 0.55） */
          minClaimedQuality?: number;
          /** 单条信念下注预算上限（能量，缺省 8） */
          beliefBetBudget?: number;
        };
      };
    };
    /** 世界模型配置覆盖 */
    worldModel?: Partial<import('./world-model.js').WorldModelConfig>;
    /** 好奇心引擎配置覆盖 */
    curiosity?: Partial<import('./curiosity-engine.js').CuriosityEngineConfig>;
    /** 安全治理器配置覆盖 */
    governor?: Partial<import('./safety-governor.js').SafetyGovernorConfig>;
    /** 5.0：因果内核配置覆盖（do-干预登记 + Shapley 分红 + 反事实查询） */
    causalKernel?: Partial<import('./core/causal-kernel.js').CausalKernelConfig>;
    /**
     * 6.0：主动推断配置（自由能最小化心智）。
     * enabled 时调度改用期望自由能（探索/利用统一）、健康报告携带
     * 统一自由能 KPI、共生心跳产出变分漂移监测。缺省关闭（零漂移）。
     */
    activeInference?: {
      enabled?: boolean;
      /** 调度偏好强度（对成功的目标概率，缺省 0.9） */
      schedulingPreference?: number;
      /** 认知价值权重（信息增益折算系数，缺省 1） */
      epistemicWeight?: number;
    };
    /**
     * 8.0：元推理配置（元认知心智：计算即行动，思考有价格）。
     * optimizer.metacognitiveRecommendation 按 habit/reactive/deliberative
     * 三模式仲裁；结算回流驱动元学习（门槛自适应 + 习惯晋升/作废）。
     */
    metareasoning?: {
      /** 反应门槛：单步 EFE 差 ≥ 该值直接反应（nat，缺省 0.25） */
      decisivenessGap?: number;
      /** 反应模式最低证据量（缺省 8） */
      sufficientEvidence?: number;
      /** 习惯晋升门槛：同状态同计划连续成功次数（缺省 2） */
      habitPromotionSuccesses?: number;
      /** 深思最大深度（缺省 4） */
      maxDepth?: number;
      /** 每节点计算价格（nat，缺省 0.01） */
      natPerNode?: number;
      /** 单次深思预算（nat，缺省 2.0） */
      budgetNat?: number;
    };
    /**
     * 9.0：抽象配置（抽象心智：类比结构映射 + 分层收缩）。
     * enabled 时深思内核挂载抽象层——冷状态凭结构同构借别域经验
     * （零样本应答）、后继结构继承、跨域宏技能；健康报告携带
     * 抽象统计 KPI。缺省关闭（零漂移；均匀层与 Beta(1,1) 严格等价）。
     */
    abstraction?: {
      enabled?: boolean;
      /** L1 类比层先验强度（伪计数，缺省 6） */
      analogyStrength?: number;
      /** 结构相似度门槛（Jaccard，缺省 0.3） */
      minSimilarity?: number;
      /** 抽象技能晋升所需跨域成功数（缺省 2） */
      abstractSkillDomains?: number;
    };
    /**
     * 10.0：科学家配置（科学家心智：最优实验设计）。
     * enabled 时宿主创建 ScientistMind（EIG 实验设计 + 混杂侦测加成
     * + 预算仲裁 + 信息台账），好奇心/调度的因果实验建议升级为
     * Lindley 期望信息增益口径；健康报告携带知识前沿 KPI。
     * 缺省关闭（零漂移——不登记问题即无实验设计）。
     */
    scientist?: {
      enabled?: boolean;
      /** 缺省单次实验代价（nat；EIG 低于此值不设计，缺省 0.05） */
      defaultCostNat?: number;
      /** 混杂加成上限（nat，缺省 1.0） */
      maxConfoundingBonus?: number;
      /** 定律试验加成上限（nat，缺省 1.0；需 theorist.enabled） */
      lawBonusCap?: number;
      /** 热点自动登记：调度器观测到的 (model, taskType) 边入问题空间 */
      autoRegisterQuestions?: boolean;
    };
    /**
     * 11.0：理论配置（理论心智：从数据到定律）。
     * enabled 时宿主创建 TheoristEngine（层级贝叶斯定律归纳 +
     * MDL 压缩定价 + 零样本预测 + 反常/范式转移），科学家的问题
     * 若落在定律作用域内获得定律试验加成；健康报告携带理论前沿
     * KPI。缺省关闭（零漂移——不归纳即无定律）。
     */
    theorist?: {
      enabled?: boolean;
      /** 立定律的最小成员数（缺省 3） */
      minMembers?: number;
      /** 零样本预测的臂证据门槛（缺省 1） */
      zeroShotMaxArmSamples?: number;
    };
    /** 目标分解器注入（测试离线模拟） */
    decomposer?: import('./goal-engine.js').GoalDecomposer;
  };
  /** 宿主融合配置（全宿主可观测 + 全宿主安全治理；宿主无 ctx.tools 时静默降级） */
  hostFusion?: Partial<import('./host-fusion.js').HostFusionConfig>;
}

// ─────────────────────────── Tool 注册表 ───────────────────────────

/** Tool 定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean; enum?: string[] }>;
  handler: (args: any) => Promise<any> | any;
}

/** Tool 调用错误 */
export class ToolError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TOOL_ERROR', details);
  }
}

/**
 * Tool 注册表服务
 *
 * cordis 核心未内置 Tool API，本插件以 provide('schedulerTools') 形式
 * 向宿主暴露 12 个 Tool 的注册、发现与调用能力。
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** 注册一个 Tool（重名覆盖） */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** 注销一个 Tool */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 获取 Tool 定义 */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 列出全部 Tool（不含 handler） */
  list(): Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>> {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** 调用 Tool（未知名称抛 ToolError） */
  async invoke(name: string, args: Record<string, any> = {}): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(`未知 Tool: ${name}`);
    return tool.handler(args ?? {});
  }
}

/**
 * 将内部 Tool 参数声明转换为官方 JSON Schema 子集（dsh-tools 强制子集：
 * object 根 + properties/required/additionalProperties + 标量 enum）。
 */
function toJsonSchemaParameters(parameters: ToolDefinition['parameters']): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(parameters)) {
    const node: Record<string, unknown> = { description: spec.description };
    switch (spec.type) {
      case 'number':
        node.type = 'number';
        break;
      case 'boolean':
        node.type = 'boolean';
        break;
      case 'array':
        node.type = 'array';
        break;
      case 'object':
        node.type = 'object';
        node.additionalProperties = true;
        break;
      default:
        node.type = 'string';
    }
    if (spec.enum && spec.enum.length > 0) node.enum = [...spec.enum];
    properties[key] = node;
    if (spec.required) required.push(key);
  }
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: true };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** 插件对外暴露的调度器服务面 */
export interface SchedulerService {
  tools: ToolRegistry;
  sentinel: Sentinel;
  /** 模型调度器（新架构：优化器 → 模型调度） */
  modelScheduler: ModelScheduler;
  /** 任务执行器（新架构：模型调度 → 任务执行） */
  taskExecutor: TaskExecutor;
  memory: LongTermMemory;
  llm: LLMClient;
  tenantManager: TenantManager;
  sync: DistributedSync;
  raft: RaftEngine | null;
  hotReload: HotReloadEngine | null;
  broadcaster: ProgressBroadcaster | null;
  benchmark: BenchmarkEngine;
  cryptoEngine: CryptoEngine | null;
  /** 决策引擎（闭环深度优化） */
  decisionEngine: DecisionEngine;
  /** 反思引擎（闭环深度优化） */
  reflectionEngine: ReflectionEngine;
  /** 优化器（新架构：记忆库 → 优化器 → 模型调度） */
  optimizer: Optimizer;
  /** 反思器（新架构：任务执行 → 反思器 → 记忆更新） */
  reflector: Reflector;
  /** 目标引擎（自主智能） */
  goalEngine: GoalEngine;
  /** 元认知引擎（自主智能） */
  metaCognition: MetaCognitionEngine;
  /** 策略进化引擎（自主智能） */
  strategyEvolution: StrategyEvolutionEngine;
  /** 第四阶段：自我建模引擎（心智报告） */
  selfModel: SelfModel;
  /** 第四阶段：元认知控制器（保守调参 + 自动回滚 + 审计） */
  metaController: MetaCognitiveController;
  /** 自主心跳循环（自主智能） */
  autonomyLoop: AutonomyLoop;
  /** 世界模型（自主智能·预见） */
  worldModel: WorldModel;
  /** 好奇心引擎（自主智能·内在动机） */
  curiosity: CuriosityEngine;
  /** 安全治理器（自主智能·边界） */
  governor: SafetyGovernor;
  /** 宿主融合层（全宿主可观测 + 安全治理；未激活时 isActive()=false） */
  hostFusion: HostFusionLayer;
  /** 手动提交任务（等价于 autonomous_execute Tool） */
  submitTask(task: string, urgency?: number): Signal;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    scheduler: SchedulerService;
    schedulerTools: ToolRegistry;
  }
  interface Events {
    'scheduler/signal'(signal: Signal): void;
    'scheduler/plan-complete'(result: PlanExecutionResult, signal: Signal): void;
  }
}

// ─────────────────────────── 默认配置 ───────────────────────────

const DEFAULT_CONFIG: Partial<SchedulerConfig> = {
  qualityThreshold: 0.7,
  maxRetries: 2,
  globalTimeout: 300_000,
  enableProgress: true,
  progressPort: 9877,
  verbose: false,
  experienceStorePath: '.scheduler/memory.json',
};

// ─────────────────────────── Schemastery Config schema（加载时校验 + 默认值填充） ───────────────────────────

/**
 * 插件配置 schema（cordis Plugin.Base.Config）。
 * 经 ctx.plugin() 加载时由 cordis resolveConfig 自动校验并填充默认值；
 * 函数型注入字段（nodeRunner / judge / llm.fetchImpl 等）不在 schema 中声明，
 * 作为额外属性透传，不受校验影响。
 */
export const Config = Schema.object({
  // strategistModel 整体可选（宿主经 ctx 提供模型时无需配置）；
  // 指定时 id/endpoint 的完整性由 apply 运行时守卫校验（ConfigError）
  strategistModel: Schema.object({
    id: Schema.string(),
    endpoint: Schema.string(),
    apiKey: Schema.string(),
  }),
  models: Schema.array(Schema.any()),
  sentinel: Schema.object({
    watchCodeChanges: Schema.boolean().default(true),
    watchErrors: Schema.boolean().default(true),
    watchPerformance: Schema.boolean().default(true),
    aggregationWindow: Schema.number().min(0).default(0.5),
    signalSources: Schema.array(Schema.any()),
  }).default({} as any),
  qualityThreshold: Schema.percent().default(0.7),
  maxRetries: Schema.natural().default(2),
  globalTimeout: Schema.natural().default(300_000),
  enableProgress: Schema.boolean().default(true),
  progressPort: Schema.natural().default(9877),
  verbose: Schema.boolean().default(false),
  experienceStorePath: Schema.string().default('.scheduler/memory.json'),
  encryption: Schema.object({
    enabled: Schema.boolean().default(false),
    masterKey: Schema.string(),
    algorithm: Schema.union([Schema.const('aes-256-gcm'), Schema.const('aes-256-cbc')]).default('aes-256-gcm'),
    fullFileEncryption: Schema.boolean().default(true),
  }).default({} as any),
  sync: Schema.object({
    localNodeId: Schema.string().default('node-dev-01'),
    peers: Schema.array(Schema.any()).default([]),
  }).default({} as any),
  consensus: Schema.object({
    enabled: Schema.boolean().default(false),
    localNodeId: Schema.string().default('node-01'),
    consensusPort: Schema.natural().default(9880),
    electionTimeoutMin: Schema.natural().default(1500),
    electionTimeoutMax: Schema.natural().default(3000),
    heartbeatInterval: Schema.natural().default(500),
    cluster: Schema.array(Schema.any()).default([]),
  }).default({} as any),
  hotReload: Schema.object({
    enabled: Schema.boolean().default(false),
    watchDirs: Schema.array(Schema.string()).default(['src']),
    watchExtensions: Schema.array(Schema.string()).default(['.ts', '.tsx', '.js']),
    debounceMs: Schema.natural().default(1000),
    buildCommand: Schema.string().default('npm run build'),
    autoRollback: Schema.boolean().default(true),
  }).default({} as any),
  tenants: Schema.array(Schema.any()).default([]),
  dataDir: Schema.string(),
  memoryFastPathThreshold: Schema.number().min(0),
  autonomy: Schema.object({
    enabled: Schema.boolean().default(true),
    heartbeatMs: Schema.natural().default(30_000),
  }).default({} as any),
  hostFusion: Schema.object({
    enabled: Schema.boolean().default(true),
    observeToolResults: Schema.boolean().default(true),
    governToolCalls: Schema.boolean().default(true),
    failureEscalationThreshold: Schema.natural().min(1).default(3),
  }).default({} as any),
});

/** 插件名称 */
export const name = 'dsh-proactive';

// ─────────────────────────── 插件主体 ───────────────────────────

/**
 * 插件入口：初始化全部模块、编排 10 步链路、注册 12 Tool、登记 cleanup
 */
export function apply(ctx: Context, config: Partial<SchedulerConfig>): void {
  const cfg = { ...DEFAULT_CONFIG, ...config } as SchedulerConfig;

  // strategistModel 完整性守卫（schema 层整体可选，指定时字段必须齐全）
  // schema 对缺省的嵌套对象会解析为 {}，故以"是否含任一字段"判定是否真正指定
  if (cfg.strategistModel && (cfg.strategistModel.id || cfg.strategistModel.endpoint)) {
    if (!cfg.strategistModel.id || !cfg.strategistModel.endpoint) {
      throw new ConfigError('strategistModel 配置不完整：指定时需同时提供 id 与 endpoint');
    }
  } else {
    cfg.strategistModel = undefined;
  }

  // ── DSH 宿主 LLM 能力解析（宿主优先、配置兜底）──
  // 宿主经 ctx 提供已配置好的 LLM 客户端 / 模型目录 / 请求头注入器，
  // 插件本身无需持有任何 API Key（DSH 自动注入用户配置的 Key）。
  const hostChat = resolveHostLLM(ctx);
  const hostModels = resolveHostModels(ctx);
  // 请求头注入优先级：DSH 宿主 ctx 注入 > 宿主本地密钥自动填入（环境变量/本地配置，健康感知路由）
  const ctxHeaderProvider = resolveHeaderProvider(ctx);
  const keyHealth = new KeyHealthManager(60_000, path.join(path.dirname(cfg.experienceStorePath), 'key-order.json'));
  const localKeyProvider = resolveLocalKeyProvider(keyHealth);
  const headerProvider = (modelId: string, keyAttempt = 0) =>
    (keyAttempt === 0 ? ctxHeaderProvider?.(modelId) : undefined) ?? localKeyProvider(modelId, keyAttempt);
  const mergedModels: ModelConfig[] = [...hostModels];
  for (const model of cfg.models ?? []) {
    if (!mergedModels.some((m) => m.id === model.id)) mergedModels.push(model);
  }
  if (!hostChat && mergedModels.length === 0) {
    throw new ConfigError('无可用模型：DSH 宿主未提供模型目录（ctx），且配置缺少 models 列表');
  }

  const logger = ctx.logger('scheduler');
  const dataDir = path.resolve(cfg.dataDir ?? '.scheduler');
  fs.mkdirSync(dataDir, { recursive: true });

  // ── 基础层 ──
  const cryptoEngine = cfg.encryption?.enabled
    ? new CryptoEngine({
        enabled: true,
        masterKey: cfg.encryption.masterKey ?? CryptoEngine.generateKey(),
        algorithm: cfg.encryption.algorithm ?? 'aes-256-gcm',
        sensitiveFields: ['apiKey', 'masterKey', 'token'],
        fullFileEncryption: cfg.encryption.fullFileEncryption ?? true,
      })
    : null;

  const memoryPath = path.resolve(cfg.experienceStorePath);
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  const memory = new LongTermMemory(memoryPath, cryptoEngine ?? undefined);
  // 记忆图（记忆网络 + 主题树）：内存管理、JSON 序列化持久化，启动时加载
  const memoryGraph = new MemoryGraph(path.join(path.dirname(memoryPath), 'memory-graph.json'));

  let broadcaster: ProgressBroadcaster | null = null;
  if (cfg.enableProgress) {
    broadcaster = new ProgressBroadcaster(cfg.progressPort);
  }

  // ── LLM 客户端 ──
  // 宿主提供客户端时委托调用；否则仅注册端点，Key 由 headerProvider 注入请求头
  const llm = new LLMClient({
    timeout: cfg.llm?.timeout ?? 60_000,
    maxRetries: cfg.maxRetries,
    fetchImpl: cfg.llm?.fetchImpl,
    headerProvider,
    onKeyOutcome: (modelId, keyAttempt, success, status) => keyHealth.recordOutcome(modelId, keyAttempt, success, status),
    externalChat: hostChat,
  });
  for (const model of mergedModels) llm.registerModel(model);
  // strategist 模型确保已注册（决策调用专用）
  if (cfg.strategistModel && !llm.getModel(cfg.strategistModel.id)) {
    llm.registerModel({ id: cfg.strategistModel.id, endpoint: cfg.strategistModel.endpoint, apiKey: cfg.strategistModel.apiKey });
  }
  const strategistId = cfg.strategistModel?.id ?? mergedModels[0]?.id ?? llm.getModelIds()[0];
  if (hostChat) logger.info('LLM 调用已委托给 DSH 宿主客户端（Key 由宿主注入）');
  else logger.info('模型 Key 自动经请求头注入（优先级：宿主 ctx → 本地环境变量 → 本地配置文件，认证失败自动轮换）');
  for (const model of mergedModels) {
    const sources = describeKeySources(model.id);
    if (sources.length > 0) logger.info('模型 %s 密钥来源: %s', model.id, sources.join(', '));
  }

  // ── 能力层 ──
  const tenantManager = new TenantManager(path.join(dataDir, 'tenants'), cryptoEngine ?? undefined);
  const benchmark = new BenchmarkEngine(path.join(dataDir, 'benchmarks'));
  const migrationTool = new MigrationTool(cfg.sync?.localNodeId ?? 'node-dev-01');

  // ── 协作层 ──
  const sync = new DistributedSync(
    cfg.sync?.localNodeId ?? 'node-dev-01',
    memory,
    path.join(dataDir, 'sync-state.json'),
    cryptoEngine,
  );
  for (const peer of cfg.sync?.peers ?? []) sync.registerNode(peer);

  let raft: RaftEngine | null = null;
  if (cfg.consensus?.enabled) {
    raft = new RaftEngine({
      localNodeId: cfg.consensus.localNodeId,
      cluster: cfg.consensus.cluster ?? [],
      electionTimeoutMin: cfg.consensus.electionTimeoutMin ?? 1500,
      electionTimeoutMax: cfg.consensus.electionTimeoutMax ?? 3000,
      heartbeatInterval: cfg.consensus.heartbeatInterval ?? 500,
      consensusPort: cfg.consensus.consensusPort ?? 9880,
      logPath: path.join(dataDir, 'raft-log.json'),
    });
  }

  let hotReload: HotReloadEngine | null = null;
  if (cfg.hotReload?.enabled) {
    hotReload = new HotReloadEngine({
      enabled: true,
      watchDirs: cfg.hotReload.watchDirs ?? ['src'],
      watchExtensions: cfg.hotReload.watchExtensions ?? ['.ts', '.tsx', '.js'],
      debounceMs: cfg.hotReload.debounceMs ?? 1000,
      buildCommand: cfg.hotReload.buildCommand ?? 'npm run build',
      distDir: cfg.hotReload.distDir ?? 'dist',
      entryFile: cfg.hotReload.entryFile ?? 'index.js',
      maxVersionHistory: cfg.hotReload.maxVersionHistory ?? 5,
      gracefulShutdownTimeout: cfg.hotReload.gracefulShutdownTimeout ?? 10_000,
      versionsDir: cfg.hotReload.versionsDir ?? path.join(dataDir, 'versions'),
      autoRollback: cfg.hotReload.autoRollback ?? true,
    });
  }

  // ── 集成层：决策引擎与反思引擎（闭环深度优化） ──
  const reflectionEngine = new ReflectionEngine({
    qualityThreshold: cfg.qualityThreshold,
    ...cfg.reflection,
    judge: cfg.judge,
    lessonExtractor: cfg.lessonExtractor,
  });
  reflectionEngine.setAlertHandler((alert) => {
    broadcast({ type: 'quality-alert', alertType: alert.type, message: alert.message, taskType: alert.taskType });
    logger.warn('质量告警: %s', alert.message);
  });

  // ── 优化器（记忆库 → 优化器 → 模型调度）：经验检索 + 快路径计划召回 ──
  // 第三阶段：policyProvider 桥接模型调度器的当前策略 → 推荐可追溯策略版本
  const optimizer = new Optimizer({
    memory,
    config: { memoryFastPathThreshold: cfg.memoryFastPathThreshold },
    broadcaster: broadcaster ?? undefined,
    graph: memoryGraph,
    policyProvider: () => modelScheduler.getPolicy(),
  });

  const decisionEngine = new DecisionEngine({
    ...cfg.decision,
    strategist: async (signals, history) => {
      // strategist 决策器：注入历史统计上下文，提升新信号决策质量
      const { data } = await llm.chatJSON<Array<{ id: string; urgency: number; decision: string; reason?: string; deferMs?: number }>>(
        strategistId,
        [
          { role: 'system', content: '你是调度系统的战略决策器。对每个信号评估紧急度(0~1)并决策: execute/defer/dismiss/ask-user。仅输出 JSON 数组。' },
          {
            role: 'user',
            content: JSON.stringify({
              signals: signals.map((s) => ({ id: s.id, type: s.type, description: s.description, occurrences: s.occurrences, urgency: s.urgency })),
              history: Object.fromEntries(history),
            }),
          },
        ],
        { timeout: 30_000, maxRetries: 1 },
      );
      const verdicts = new Map<string, { urgency: number; decision: any; reason?: string; deferMs?: number }>();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && typeof item.id === 'string') {
            verdicts.set(item.id, {
              urgency: Math.max(0, Math.min(1, Number(item.urgency) || 0.5)),
              decision: ['execute', 'defer', 'dismiss', 'ask-user'].includes(item.decision) ? item.decision : 'execute',
              reason: item.reason,
              deferMs: typeof item.deferMs === 'number' ? item.deferMs : undefined,
            });
          }
        }
      }
      return verdicts;
    },
  });

  // ── 模型调度器（新架构：优化器 → 模型调度；推荐模型优先采纳） ──
  // B 路线：能量反哺调度开关（缺省关闭——共生心跳把经济健康度折算为
  // 调度乘数注入这里；关闭时乘数恒为 1，评分与原逻辑逐位一致）
  const schedulingFeedbackEnabled = cfg.autonomy?.symbiosis?.enabled === true && (cfg.autonomy?.symbiosis?.schedulingFeedback?.enabled ?? false);
  const modelScheduler = new ModelScheduler({
    llm,
    memory,
    config: { costWeight: 0.2, economicFeedbackEnabled: schedulingFeedbackEnabled },
  });

  // ── 第三阶段（质级升级）：策略进化器 + 校准沙盒（「优化」本身可进化） ──
  // 沙盒任务集 = 历史回放（记忆库任务模式）+ 对抗合成（极端复杂/冷启动/特征密集/极简）；
  // 模型快照从 LLM 客户端运行时状态映射，评估全程离线，不阻塞操作环调度。
  // 质级升级：① 沙盒注入历史校准表（真实模型画像锚定模拟）；
  // ② 每轮进化前刷新任务集/校准/模型快照（进化素材与操作环同步）；
  // ③ 金丝雀观察窗喂数：决策反馈的真实成败/质量回报给进化器自动回滚/晋升。
  const policyEvolutionEnabled = cfg.autonomy?.policyEvolution?.enabled ?? true;
  /** 金丝雀喂数游标：仅消费尚未回报过的决策反馈（增量喂数） */
  let lastCanaryFeedAt = 0;
  const knownTaskTypes = () =>
    [...new Set(memory.getAllTaskPatterns().map((p) => p.fingerprint.split('::')[0]))].filter(Boolean);
  const buildSandboxTaskSet = () => [
    ...extractReplayTasks(memory),
    ...generateAdversarialTasks(knownTaskTypes()),
  ];
  const mapSimModels = (): SimModelStatus[] =>
    llm.getModelStatuses().map((s) => ({
      id: s.id,
      taskScores: s.taskScores,
      avgLatencyMs: s.avgLatency > 0 ? s.avgLatency : 800,
      avgTokens: s.totalCalls > 0 ? s.totalTokensUsed / s.totalCalls : 600,
      maxConcurrency: s.maxConcurrency,
    }));
  const policySandbox = new Sandbox({
    models: mapSimModels(),
    tasks: buildSandboxTaskSet(),
    config: {
      ...cfg.autonomy?.policyEvolution?.sandbox,
      calibration: buildCalibrationFromMemory(memory),
    },
  });
  const policyEvolver = new PolicyEvolver({
    ...cfg.autonomy?.policyEvolution,
    knownTaskTypes: knownTaskTypes(),
    persistPath: path.join(dataDir, 'policy-evolution.json'),
    onDeploy: (policy) => {
      // 热切换落地：评分函数参数即时生效（无需重启）；优化器随次检索自动标注新版本
      modelScheduler.updatePolicy(policy);
      broadcast({
        type: 'policy-deployed',
        policyId: policy.id,
        version: policy.version,
        generation: policy.generation,
        origin: policy.origin,
        params: policy.params,
      });
      logger.info(
        '策略进化部署: %s@v%d（第 %d 代，来源 %s）已热切换到操作环',
        policy.id,
        policy.version,
        policy.generation,
        policy.origin,
      );
    },
    onCanaryDecision: (decision) => {
      broadcast({ type: 'policy-canary', ...decision });
      logger[decision.action === 'rolled-back' ? 'warn' : 'info'](
        '金丝雀[%s]: 策略 %s → %s（%s）',
        decision.action,
        decision.policyId,
        decision.action === 'rolled-back' ? '自动回滚前一策略' : '晋升正式',
        decision.reason,
      );
    },
    onCycle: (cycle) => {
      broadcast({ type: 'policy-evolution-cycle', ...cycle });
    },
  });

  // ── 任务执行器（新架构：模型调度 → 任务执行；优化器喂入复用计划） ──
  // 4.0 弹性升级：模型级熔断（连续 5 次可用性失败隔离）+ 全抖动指数退避重试
  const taskExecutor = new TaskExecutor({
    config: {
      qualityThreshold: cfg.qualityThreshold,
      maxRetries: cfg.maxRetries,
      globalTimeout: cfg.globalTimeout,
      nodeTimeout: Math.min(120_000, cfg.globalTimeout),
      enableProgress: cfg.enableProgress,
      verbose: cfg.verbose,
      circuitFailureThreshold: 5,
      circuitCooldownMs: 60_000,
      retryBackoffBaseMs: 200,
      retryBackoffMaxMs: 8_000,
    },
    llm,
    modelScheduler,
    broadcaster: broadcaster ?? undefined,
    nodeRunner: cfg.nodeRunner,
    reflection: reflectionEngine,
    cascadeHandler: (newSignal) => {
      // 第 9 步级联触发 → 回注哨兵形成闭环
      sentinel.ingest({ ...newSignal, source: 'cascade' });
    },
  });

  // ── 反思器（任务执行 → 反思器 → 记忆更新）：复盘 + 沉淀 + 策略反馈 + 蒸馏 ──
  const reflector = new Reflector({
    memory,
    reflection: reflectionEngine,
    graph: memoryGraph,
    config: {
      enableProgress: cfg.enableProgress,
      onLesson: (lesson) => logger.info('教训沉淀 [%s]: %s', lesson.rootCause, lesson.lesson),
      onDistilled: (fresh) => logger.info('经验蒸馏产出 %d 条策略', fresh.length),
      // 第二阶段：知识蒸馏回调（语义+程序记忆产出）；升级：含证据合并/冲突取代统计与跳过说明
      onKnowledgeDistilled: (report) =>
        logger.info(
          '知识蒸馏: 语义 %d 条 / 程序 %d 条 / 策略 %d 条（来源情景 %d）%s',
          report.semanticMemories.length,
          report.proceduralMemories.length,
          report.strategies.length,
          report.sourceEpisodicCount,
          report.skipped
            ? `— ${report.summary}`
            : (report.mergedSemanticCount ?? 0) + (report.mergedProceduralCount ?? 0) + (report.supersededCount ?? 0) > 0
              ? `— 合并增强 语义${report.mergedSemanticCount ?? 0}/程序${report.mergedProceduralCount ?? 0}，冲突取代 ${report.supersededCount ?? 0}`
              : '',
        ),
    },
    broadcaster: broadcaster ?? undefined,
    onMemoryChange: (type, fingerprint, payload) => {
      sync.recordChange(type as any, fingerprint, payload);
    },
  });

  // ── 集成层：哨兵与 10 步链路编排 ──
  const sentinel = new Sentinel(
    {
      watchCodeChanges: cfg.sentinel?.watchCodeChanges ?? true,
      watchErrors: cfg.sentinel?.watchErrors ?? true,
      watchPerformance: cfg.sentinel?.watchPerformance ?? true,
      aggregationWindow: cfg.sentinel?.aggregationWindow ?? 0.5,
      signalSources: cfg.sentinel?.signalSources,
      watchDir: process.cwd(),
    },
    (batch) => void processBatch(batch),
  );

  // ── 第四阶段：元认知层（自我建模 + 元认知控制——观察并改进进化机制本身） ──
  // 双环架构外环：内环 = 任务执行 → 反思 → 记忆 → 优化 → 策略进化（一~三阶段）；
  // 外环 = 自我建模（心智报告：策略优劣势/记忆健康/进化效率/稳定性/改进证据）
  // → 元认知控制器（保守调参 → 观察窗 → 判定保留/自动回滚，全程审计）。
  // 旋钮与真实组件联动：反思器蒸馏阈值、进化器变异率与门禁、
  // 沙盒严格度、优化器记忆快路径门槛——调整的是「进化机制」而非策略本身。
  const metaLayerEnabled = cfg.autonomy?.metaLayer?.enabled ?? true;
  /**
   * 2.0 稳态目标带（自我建模与元认知控制器共享）：
   * 配置后自我建模在心智报告中输出稳态带状态（in/near/out-of-band），
   * 元认知控制器据此自适应调整步长（偏离越远步长越大，量化档位）。
   */
  const DEFAULT_HOMEOSTASIS_BANDS: import('./meta/meta-types.js').HomeostasisBands = {
    operationalSuccessRate: { min: 0.8, max: 0.95 }, // 操作环成功率健康带
    discoveryRate: { min: 0.1, max: 0.3 }, // 进化发现速率健康带（过高=探索过热）
    survivalRate: { min: 0.7, max: 1.0 }, // 新策略存活率健康带
  };
  const selfModel = new SelfModel({
    collectors: {
      getEvolverStatus: () => policyEvolver.getStatus(),
      getMemoryStats: () => memory.dbStats(),
      getGlobalStats: () => memory.getGlobalStats(),
      getDistillationProgress: () => memory.getDistillationProgress?.(),
      getRecentFeedback: (limit) => memory.getRecentFeedback(limit),
      // 2.0：元认知层状态回注（学习器有效性 + 熔断器 + 安全包络 → 心智报告 metaStability/knobEffectiveness）
      getMetaLayerState: () => {
        if (!metaLayerEnabled) return undefined;
        const state = metaController.getState();
        return {
          knobEffectiveness: state.learner.effectiveness,
          metaStability: {
            circuitBreakers: state.circuitBreakers,
            globalFrozen: state.frozen,
            frozenByBreaker: state.frozenByBreaker,
            safeEnvelopes: state.safeEnvelopes,
            learner: {
              totalTrials: state.learner.totalTrials,
              arms: state.learner.arms,
              explorationWeight: state.learner.explorationWeight,
            },
          },
        };
      },
    },
    config: {
      homeostasisBands: DEFAULT_HOMEOSTASIS_BANDS,
      ...cfg.autonomy?.metaLayer?.selfModel,
      persistPath: path.join(dataDir, 'self-model-reports.json'),
    },
  });
  const metaController = new MetaCognitiveController({
    selfModel,
    knobs: [
      {
        id: 'reflector.autoDistillThreshold',
        label: '反思器自动蒸馏阈值',
        category: 'reflector',
        min: 2,
        max: 20,
        step: 1,
        integer: true,
        read: () => reflector.getConfig().autoDistillThreshold ?? 5,
        write: (v) => reflector.updateConfig({ autoDistillThreshold: v }),
        judgeMetric: 'pendingDistillation',
        higherIsBetter: false,
      },
      {
        id: 'reflector.distillMinConfidence',
        label: '知识蒸馏写入置信度门槛',
        category: 'reflector',
        min: 0.4,
        max: 0.8,
        step: 0.05,
        read: () => reflector.getConfig().distillMinConfidence ?? 0.6,
        write: (v) => reflector.updateConfig({ distillMinConfidence: v }),
        judgeMetric: 'proceduralGrowth',
        higherIsBetter: true,
      },
      {
        id: 'evolver.mutationRate',
        label: '进化器变异率',
        category: 'evolver',
        min: 0.2,
        max: 0.9,
        step: 0.1,
        read: () => policyEvolver.getTunableParams().mutationRate,
        write: (v) => policyEvolver.updateConfig({ mutationRate: v }),
        judgeMetric: 'discoveryRate',
        higherIsBetter: true,
      },
      {
        id: 'evolver.minGain',
        label: '进化器部署门禁（选择压力）',
        category: 'evolver',
        min: 0.001,
        max: 0.05,
        step: 0.005,
        read: () => policyEvolver.getTunableParams().minGain,
        write: (v) => policyEvolver.updateConfig({ minGain: v }),
        judgeMetric: 'survivalRate',
        higherIsBetter: true,
      },
      {
        id: 'sandbox.evaluationSeeds',
        label: '沙盒多种子评估严格度',
        category: 'sandbox',
        min: 1,
        max: 7,
        step: 1,
        integer: true,
        read: () => policySandbox.getConfig().evaluationSeeds ?? 3,
        write: (v) => policySandbox.updateConfig({ evaluationSeeds: v }),
        judgeMetric: 'survivalRate',
        higherIsBetter: true,
      },
      {
        id: 'optimizer.memoryFastPathThreshold',
        label: '记忆快路径复用门槛',
        category: 'memory',
        min: 0.7,
        max: 0.95,
        step: 0.05,
        read: () => optimizer.getConfig().memoryFastPathThreshold ?? 0.9,
        write: (v) => optimizer.updateConfig({ memoryFastPathThreshold: v }),
        judgeMetric: 'operationalSuccessRate',
        higherIsBetter: true,
      },
    ],
    config: {
      // 2.0：学习型稳态控制（稳态带与自我建模共享；用户配置覆盖优先）
      homeostasisBands: DEFAULT_HOMEOSTASIS_BANDS,
      maxStepMultiplier: 3,
      breakerThreshold: 2,
      globalBreakerThreshold: 3,
      proactiveEnabled: true,
      ...cfg.autonomy?.metaLayer?.controller,
      persistPath: path.join(dataDir, 'meta-controller-audit.json'),
      onAdjust: (entry) => {
        const { type: _kind, ...rest } = entry;
        broadcast({ type: 'meta-adjusted', ...rest });
        logger.info(
          '元认知调整: %s %s → %s（%s）',
          entry.knob ?? '',
          entry.from ?? '',
          entry.to ?? '',
          entry.reason,
        );
      },
      onCommit: (entry) => {
        const { type: _kind, ...rest } = entry;
        broadcast({ type: 'meta-committed', ...rest });
        logger.info('元认知判定保留: %s（%s）', entry.knob ?? '', entry.reason);
      },
      onRollback: (entry) => {
        const { type: _kind, ...rest } = entry;
        broadcast({ type: 'meta-rollback', ...rest });
        logger.warn('元认知回滚: %s %s → %s（%s）', entry.knob ?? '', entry.from ?? '', entry.to ?? '', entry.reason);
      },
    },
  });

  /** 延迟队列（defer 决策的信号） */
  const deferredQueue: Array<{ signal: Signal; deferUntil: number }> = [];

  // ── 自主智能层：目标引擎 / 元认知 / 策略进化 / 心跳循环 ──
  const autonomyEnabled = cfg.autonomy?.enabled ?? true;

  const goalEngine = new GoalEngine({
    ...cfg.autonomy?.goal,
    decomposer: cfg.autonomy?.decomposer,
  });

  const metaCognition = new MetaCognitionEngine({
    ...cfg.autonomy?.metaCognition,
    applier: (action: TuningAction) => {
      // 元认知自调优落地：参数调整应用到真实引擎
      if (action.parameter === 'qualityThreshold') {
        reflectionEngine.setQualityThreshold(action.to);
        taskExecutor.updateConfig({ qualityThreshold: action.to });
      } else if (action.parameter === 'maxRetries') {
        taskExecutor.updateConfig({ maxRetries: action.to });
      } else if (action.parameter === 'aggregationWindow') {
        // 聚合窗口调整通过哨兵配置（此处仅记录，哨兵窗口在构造时固定）
      }
      broadcast({ type: 'meta-tuning', parameter: action.parameter, from: action.from, to: action.to, reason: action.reason });
      logger.info('元认知自调优: %s %s → %s（%s）', action.parameter, action.from, action.to, action.reason);
    },
  });

  const strategyEvolution = new StrategyEvolutionEngine({
    ...cfg.autonomy?.evolution,
  });

  // ── 自主智能扩展层：世界模型（预见）/ 好奇心（内在动机）/ 安全治理（边界） ──
  const worldModel = new WorldModel(cfg.autonomy?.worldModel);

  // ── 5.0 因果内核：全系统共享的因果图 + do-干预登记处 ──
  // 质变基座：evidence.ts 回答「它表现如何」（相关），本内核回答
  // 「是不是它造成的」（因果）。五处消费：共生 Shapley 分红、世界模型
  // 因果预见、反思引擎反事实教训、元认知因果旋钮排序、好奇心实验设计。
  const causalKernel = new CausalKernel(cfg.autonomy?.causalKernel);
  worldModel.attachCausalKernel(causalKernel);
  reflectionEngine.attachCausalKernel(causalKernel);
  metaCognition.attachCausalKernel(causalKernel);

  /** 知识提供器：桥接世界模型（接触面）与长期记忆（经验面）供好奇心扫描盲区 */
  const knowledgeProvider = {
    getExposure(): Record<string, number> {
      const exposure: Record<string, number> = {};
      for (const item of worldModel.getSummary().types) exposure[item.type] = item.totalCount;
      return exposure;
    },
    getExperienceCounts(): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const pattern of memory.getAllTaskPatterns()) {
        const taskType = pattern.taskSummary.split(':')[0];
        counts[taskType] = (counts[taskType] ?? 0) + pattern.successfulPlans.length;
      }
      return counts;
    },
    getFailureRates(): Record<string, number> {
      const rates: Record<string, number> = {};
      for (const pattern of memory.getAllTaskPatterns()) {
        const taskType = pattern.taskSummary.split(':')[0];
        const total = pattern.successfulPlans.length + pattern.failureRecords.length;
        const rate = total > 0 ? pattern.failureRecords.length / total : 0;
        rates[taskType] = Math.max(rates[taskType] ?? 0, rate);
      }
      return rates;
    },
  };
  const curiosity = new CuriosityEngine(knowledgeProvider, cfg.autonomy?.curiosity);
  curiosity.attachCausalKernel(causalKernel);

  // ── 6.0 主动推断内核：全系统共享的自由能引擎 ──
  // 质变基座：把调度（利用）、探索（UCB）、好奇心（盲区）、健康度（KPI）
  // 四套互不通约的判据统一为一个变分目标 G(a) = 务实价值 − 认知价值。
  // 三处消费：调度器 EFE 模式、元认知统一自由能 KPI、共生变分漂移监测。
  // 缺省关闭（零漂移）；启用后探索预算由证据量内生推导，无需手设常数。
  const activeInferenceEnabled = cfg.autonomy?.activeInference?.enabled === true;
  const freeEnergyEngine = new FreeEnergyEngine({
    epistemicWeight: cfg.autonomy?.activeInference?.epistemicWeight,
  });
  metaCognition.attachFreeEnergyEngine(freeEnergyEngine);

  // ── 7.0 深思内核：规划即推断（转移模型 + 想象推演 + 技能库） ──
  // 质变基座：把单步 EFE 沿时间维展开——从「选最好的一步」到「选最好
  // 的余生」。计划执行后 settle 对账：转移模型学习 + 感知惊奇回流 +
  // 梦校准 KPI + 成功计划蒸馏为技能（时间抽象）。
  const deliberationEngine = new DeliberationEngine(
    { epistemicWeight: cfg.autonomy?.activeInference?.epistemicWeight },
    freeEnergyEngine,
  );
  metaCognition.attachDeliberationEngine(deliberationEngine);
  optimizer.attachDeliberation(deliberationEngine);

  // ── 8.0 元推理内核：理性元推理（计算即行动，思考有价格） ──
  // 质变基座：把「想多深」本身变成决策——双过程仲裁（习惯/反应/深思），
  // 任意时搜索按首行动稳定性早停，思考按 nat 计价入认知经济 KPI；
  // 结算回流驱动元学习（反应失手收紧门槛、深思成功晋升习惯）。
  const metareasoner = new RationalMetareasoner(deliberationEngine, {
    decisivenessGap: cfg.autonomy?.metareasoning?.decisivenessGap,
    sufficientEvidence: cfg.autonomy?.metareasoning?.sufficientEvidence,
    habitPromotionSuccesses: cfg.autonomy?.metareasoning?.habitPromotionSuccesses,
    maxDepth: cfg.autonomy?.metareasoning?.maxDepth,
    natPerNode: cfg.autonomy?.metareasoning?.natPerNode,
    budgetNat: cfg.autonomy?.metareasoning?.budgetNat,
  });
  metaCognition.attachMetareasoner(metareasoner);
  optimizer.attachMetareasoner(metareasoner);

  // ── 9.0 抽象内核：类比结构映射（经验跨域流动） ──
  // 质变基座：状态分解为 域#骨架——保关系、换对象。结构同构的域
  // 互为类比证人（Jaccard 域画像），冷状态零样本借用别域后验，
  // 后继结构继承让「陷阱类经验」跨域复用，整体计划跨域成功晋升
  // 抽象技能。缺省关闭；均匀层与 Beta(1,1) 严格等价（零数据零漂移）。
  if (cfg.autonomy?.abstraction?.enabled === true) {
    const abstractionEngine = new AbstractionEngine({
      analogyStrength: cfg.autonomy?.abstraction?.analogyStrength,
      minSimilarity: cfg.autonomy?.abstraction?.minSimilarity,
      abstractSkillDomains: cfg.autonomy?.abstraction?.abstractSkillDomains,
    });
    deliberationEngine.attachAbstraction(abstractionEngine);
    metaCognition.attachAbstractionEngine(abstractionEngine);
  }

  // ── 10.0 科学家内核：最优实验设计（知识获取的经济学） ──
  // 质变基座：把「学什么」本身变成决策——Lindley EIG 定价每次实验
  // 的期望知识（nat），混杂分歧（观测≠干预）获得实验独占加成，
  // netValue = EIG − cost 的预算仲裁拒绝赔本实验；信息台账对账
  // 「承诺 vs 兑现」，知识前沿 KPI 审计知识版图的收缩。缺省关闭
  // （零漂移——不登记问题即无设计）；启用后好奇心实验建议升级为
  // EIG 口径，健康报告携带知识前沿。
  let scientistAutoRegister = false;
  const scientistCfg = cfg.autonomy?.scientist;
  const scientistMind =
    scientistCfg?.enabled === true
      ? new ScientistMind(causalKernel, freeEnergyEngine, {
          defaultCostNat: scientistCfg.defaultCostNat,
          maxConfoundingBonus: scientistCfg.maxConfoundingBonus,
          lawBonusCap: scientistCfg.lawBonusCap,
        })
      : undefined;
  if (scientistMind) {
    metaCognition.attachScientistMind(scientistMind);
    curiosity.attachScientistMind(scientistMind);
    // 热点自动登记：调度器结算的 (贡献者 → task.outcome) 边入问题空间
    scientistAutoRegister = scientistCfg?.autoRegisterQuestions === true;
  }

  // ── 11.0 理论内核：从数据到定律（知识的压缩与体系化） ──
  // 质变基座：层级贝叶斯把同族 K 条边压缩为一条定律（借力收缩，
  // 定律区间窄于任何单边）；MDL 用 nat 给「理解即压缩」定价——
  // compression ≤ 0 的定律不配存在；作用域内的新边零样本继承
  // 全族知识；反常者驱逐、定律重建（范式转移）。科学家的问题
  // 在定律作用域内获得定律试验加成（一次实验校准整个作用域）。
  // 缺省关闭（零漂移）；归纳是因果图的纯函数，确定性可重放。
  const theoristCfg = cfg.autonomy?.theorist;
  const theoristEngine =
    theoristCfg?.enabled === true
      ? new TheoristEngine(causalKernel, {
          minMembers: theoristCfg.minMembers,
          zeroShotMaxArmSamples: theoristCfg.zeroShotMaxArmSamples,
        })
      : undefined;
  if (theoristEngine) {
    metaCognition.attachTheoristEngine(theoristEngine);
    scientistMind?.attachTheorist(theoristEngine);
  }

  if (activeInferenceEnabled) {
    modelScheduler.attachFreeEnergy(freeEnergyEngine);
    modelScheduler.updateConfig({
      freeEnergyEnabled: true,
      freeEnergyPreference: cfg.autonomy?.activeInference?.schedulingPreference,
    });
  }

  const governor = new SafetyGovernor(cfg.autonomy?.governor);

  /** KPI 采集器：从真实引擎状态聚合 KPI 快照 */
  const collectKpi = () => {
    const modelStatuses = llm.getModelStatuses();
    const modelSuccessRates: Record<string, number> = {};
    let activeExecutions = 0;
    for (const status of modelStatuses) {
      modelSuccessRates[status.id] = status.totalCalls > 0 ? status.successCount / status.totalCalls : 1;
      activeExecutions += status.activeRequests;
    }
    const globalStats = memory.getGlobalStats();
    const decisionStats = decisionEngine.getStats();
    return {
      timestamp: Date.now(),
      successRate: globalStats.totalExecutions > 0 ? globalStats.totalSuccesses / globalStats.totalExecutions : 1,
      avgQuality: globalStats.averageQualityScore,
      avgLatency: globalStats.averageExecutionTime,
      cacheHitRate: decisionStats.cacheHitRate ?? 0,
      modelSuccessRates,
      activeExecutions,
    };
  };

  // ── 第五阶段 Phase 2.5：共生进化融合（能量经济 + 信念市场 → 元认知漂移报警）──
  // 缺省关闭：影子系统不改变既有主链路行为；启用后 KPI 注入共生心跳，
  // 市场价 vs 统计估计的显著背离回流为自愈目标，任务成功铸币分红给模型智能体。
  const symbiosisEnabled = cfg.autonomy?.symbiosis?.enabled ?? false;
  const futarchyEnabled = symbiosisEnabled && (cfg.autonomy?.symbiosis?.futarchy?.enabled ?? false);
  // C 路线：能量 Sankey 落盘（sankeyPath 设置即启用）
  const sankeyPath = symbiosisEnabled ? cfg.autonomy?.symbiosis?.observability?.sankeyPath : undefined;
  const sankeyEveryNTicks = cfg.autonomy?.symbiosis?.observability?.everyNTicks ?? 5;
  let symbiosisTickCount = 0;
  const symbiosisBridge = symbiosisEnabled
    ? new SymbiosisBridge(
        {
          beliefHorizonTicks: cfg.autonomy?.symbiosis?.beliefHorizonTicks,
          globalSuccessThreshold: cfg.autonomy?.symbiosis?.globalSuccessThreshold,
          modelSuccessThreshold: cfg.autonomy?.symbiosis?.modelSuccessThreshold,
          modelBetBudget: cfg.autonomy?.symbiosis?.modelBetBudget,
          divergenceMargin: cfg.autonomy?.symbiosis?.divergenceMargin,
          futarchy: {
            enabled: futarchyEnabled,
            minImpliedProb: cfg.autonomy?.symbiosis?.futarchy?.minImpliedProb,
            decisionB: cfg.autonomy?.symbiosis?.futarchy?.decisionB,
            evolutionCost: cfg.autonomy?.symbiosis?.futarchy?.evolutionCost,
            evolutionBalanceThreshold: cfg.autonomy?.symbiosis?.futarchy?.evolutionBalanceThreshold,
            selfBetBudget: cfg.autonomy?.symbiosis?.futarchy?.selfBetBudget,
          },
          economic: {
            reputationWeight: cfg.autonomy?.symbiosis?.schedulingFeedback?.reputationWeight,
            minMultiplier: cfg.autonomy?.symbiosis?.schedulingFeedback?.minMultiplier,
            maxMultiplier: cfg.autonomy?.symbiosis?.schedulingFeedback?.maxMultiplier,
            neutralHealth: cfg.autonomy?.symbiosis?.schedulingFeedback?.neutralHealth,
            balanceBaseline: cfg.autonomy?.symbiosis?.schedulingFeedback?.balanceBaseline,
          },
          // 5.0：因果内核接入共生运行时——任务结算自动登记 do-干预，
          // 分红升级为 Shapley 反事实边际贡献定价
          // 6.0：自由能引擎接入——心跳产出变分自由能（市场价 vs 因果后验
          // 的 KL 漂移监测），行动提案可按 EFE 排序
          // 10.0：科学家内核接入（autoRegisterQuestions 开启时）——
          // 调度器结算的因果边自动进入 EIG 实验设计的问题空间
          runtime: {
            causalKernel,
            freeEnergy: freeEnergyEngine,
            ...(scientistMind && scientistAutoRegister ? { scientist: scientistMind } : {}),
          },
        },
        { checkGate: () => governor.checkGate() },
      )
    : undefined;
  if (symbiosisBridge) {
    for (const model of mergedModels) symbiosisBridge.registerModel(model.id);

    // ── D 路线：全智能体接入（认知分工完全市场化，缺省关闭）──
    const agentsCfg = cfg.autonomy?.symbiosis?.agents;
    const attached: string[] = [];
    if (agentsCfg?.memory?.enabled) {
      symbiosisBridge.attachMemory(memory, {
        listingBasePrice: agentsCfg.memory.listingBasePrice,
        listingConfidenceThreshold: agentsCfg.memory.listingConfidenceThreshold,
        listingFrequencyThreshold: agentsCfg.memory.listingFrequencyThreshold,
        maintenanceInterval: agentsCfg.memory.maintenanceInterval,
      });
      attached.push('memory');
    }
    if (agentsCfg?.optimizer?.enabled) {
      symbiosisBridge.attachOptimizer({
        onPurchase: (assetId, refId, price) => {
          broadcast({ type: 'knowledge-trade', assetId, refId, price });
          logger.info('知识成交：optimizer 购入 %s（要价 %.1f）', refId, price);
        },
        config: {
          maxBudget: agentsCfg.optimizer.maxBudget,
          reserveBalance: agentsCfg.optimizer.reserveBalance,
          minClaimedQuality: agentsCfg.optimizer.minClaimedQuality,
          beliefBetBudget: agentsCfg.optimizer.beliefBetBudget,
        },
      });
      attached.push('optimizer');
    }

    logger.info(
      '共生进化融合已启用：模型智能体 ×%d，能量经济 + 信念市场并行心跳%s%s',
      mergedModels.length,
      futarchyEnabled ? '，futarchy 进化表决开启（高成本进化由市场资助）' : '',
      attached.length > 0 ? `，全智能体接入：${attached.join(' / ')}` : '',
    );
  }

  /**
   * 真实进化周期（futarchy 表决的行动本体 / 直连模式的执行体，共用）：
   * ① 喂数金丝雀（决策反馈真实成败/质量 → 自动回滚/晋升）
   * ② 刷新沙盒素材（任务集/校准表/模型快照与操作环同步）
   * ③ 触发进化周期（变异/交叉 → 沙盒评估 → 择优 → 热切换）
   */
  const runPolicyEvolutionCycle = async () => {
    // 金丝雀喂数：增量消费部署以来的决策反馈（outcome → 成败 + 质量近似分）
    const canaryNow = policyEvolver.getStatus().canary;
    if (canaryNow?.status === 'active') {
      const QUALITY_BY_OUTCOME: Record<string, number> = {
        excellent: 0.95,
        good: 0.8,
        acceptable: 0.65,
        poor: 0.4,
        failed: 0.1,
      };
      const recent = memory.getRecentFeedback(50);
      const fresh = recent.filter((f) => f.timestamp >= canaryNow.deployedAt && f.timestamp > lastCanaryFeedAt);
      for (const feedback of fresh) {
        policyEvolver.reportOperationalOutcome({
          success: ['excellent', 'good', 'acceptable'].includes(feedback.outcome),
          quality: QUALITY_BY_OUTCOME[feedback.outcome],
        });
        lastCanaryFeedAt = Math.max(lastCanaryFeedAt, feedback.timestamp);
      }
    }
    // 沙盒素材刷新：模型快照 + 历史回放集 + 校准表（进化素材与操作环同步）
    policySandbox.setTaskSet(buildSandboxTaskSet());
    policySandbox.setCalibration(buildCalibrationFromMemory(memory));
    const cycle = await policyEvolver.runEvolutionCycle(policySandbox);
    logger.info('策略进化周期完成: %s', cycle.summary);
    return cycle;
  };

  // ── A 路线：futarchy 启用时把真实进化周期绑定给进化智能体 ──
  // 市场成为高成本进化的唯一资助闸门（进化者自注 + 模型健康度定价 +
  // 监管一票否决）；进化贡献者凭部署中的策略基因参与任务分红（自持经济）。
  if (symbiosisBridge && futarchyEnabled) {
    symbiosisBridge.attachEvolver(
      async () => {
        const cycle = await runPolicyEvolutionCycle();
        const gains = cycle.candidates.map((c) => c.gain);
        return {
          deployed: !!cycle.deployedPolicyId,
          bestGain: gains.length > 0 ? Math.max(...gains) : 0,
          policyId: cycle.deployedPolicyId,
          summary: cycle.summary,
        };
      },
      {
        dividendWeight: () => {
          const status = policyEvolver.getStatus();
          if (status.currentPolicy.origin === 'baseline') return undefined;
          // 部署中的进化策略（非基线）= 任务成功的隐性贡献者；权重锚定其部署增益
          const lastDeployed = status.deployedHistory[status.deployedHistory.length - 1];
          return Math.max(0.2, (lastDeployed?.gain ?? 0) * 5);
        },
      },
    );
  }

  /** 子任务派发器：目标子任务注入哨兵作为信号 */
  const dispatchSubtask = (subtask: GoalSubtask, goal: Goal): string => {
    const signal = sentinel.ingest({
      type: subtask.taskType,
      description: subtask.description,
      payload: { goalId: goal.id, subtaskId: subtask.id, autonomous: true },
      source: 'autonomy-loop',
      urgency: Math.min(1, 0.5 + goal.valueScore * 0.3),
    });
    broadcast({ type: 'autonomy-dispatch', goalId: goal.id, subtaskId: subtask.id, signalId: signal.id });
    return signal.id;
  };

  /** 探索任务派发器：好奇心探索建议注入哨兵作为信号 */
  const dispatchExploration = (proposal: ExplorationProposal): string => {
    const signal = sentinel.ingest({
      type: proposal.taskType,
      description: proposal.description,
      payload: { exploration: true, noveltyScore: proposal.noveltyScore, expectedGain: proposal.expectedGain },
      source: 'curiosity',
      urgency: Math.min(1, 0.3 + proposal.noveltyScore * 0.4),
    });
    broadcast({ type: 'exploration-dispatch', taskType: proposal.taskType, signalId: signal.id, noveltyScore: proposal.noveltyScore });
    return signal.id;
  };

  const autonomyLoop = new AutonomyLoop({
    config: {
      ...cfg.autonomy?.loop,
      heartbeatMs: cfg.autonomy?.heartbeatMs ?? cfg.autonomy?.loop?.heartbeatMs ?? 30_000,
    },
    goalEngine,
    metaCognition,
    evolution: strategyEvolution,
    collectKpi,
    dispatchSubtask,
    maintainer: {
      distillExperience: () => memory.distillExperience().length,
      applyForgettingCurve: () => memory.applyForgettingCurve(),
      // 第二阶段：知识蒸馏桥接（反思器产出语义+程序记忆）
      distillKnowledge: async () => {
        const report = await reflector.distillKnowledge();
        return { semantic: report.semanticMemories.length, procedural: report.proceduralMemories.length };
      },
    },
    lessonProvider: () => reflectionEngine.getAllLessons(),
    strategyApplier: (config) => {
      decisionEngine.updateConfig(config);
      broadcast({ type: 'strategy-evolved', config });
      logger.info('策略进化落地: %s', JSON.stringify(config));
    },
    worldModel,
    curiosity,
    governor,
    dispatchExploration,
    // 第三阶段（质级升级）：调度策略进化桥接
    // 每轮周期：① 喂数金丝雀（决策反馈真实成败/质量 → 自动回滚/晋升）
    // ② 刷新沙盒素材（任务集/校准表/模型快照与操作环同步）→ 触发进化周期
    policyEvolution:
      policyEvolutionEnabled && !futarchyEnabled
        ? {
            // futarchy 关闭（缺省）：心跳直连进化（既有行为不变）
            runEvolutionCycle: runPolicyEvolutionCycle,
          }
        : undefined,
    // 第四阶段：元认知环桥接（低频外环：自我建模 → 保守调整 → 观察/回滚）
    metaCognitionBridge: metaLayerEnabled
      ? {
          runMetaCycle: async () => {
            const adjustment = await metaController.evaluateAndAdjust();
            broadcast({
              type: 'mental-report',
              reportIndex: adjustment.reportIndex,
              status: adjustment.status,
              appliedKnobs: adjustment.applied.map((a) => a.knob),
              stabilityScore: adjustment.mentalReport.systemStability.stabilityScore,
            });
            if (adjustment.applied.length > 0 || adjustment.rolledBack || adjustment.committed) {
              logger.info(
                '元认知周期[%s]: 报告 #%d，稳定分 %.3f，证据 %d 条，推荐 %d 项',
                adjustment.status,
                adjustment.reportIndex,
                adjustment.mentalReport.systemStability.stabilityScore,
                adjustment.mentalReport.improvementEvidence.length,
                adjustment.mentalReport.recommendedAdjustments.length,
              );
            }
            return adjustment;
          },
        }
      : undefined,
    // 第五阶段 Phase 2.5：共生进化桥接（KPI → 能量经济/信念市场 → 漂移洞察回流）
    symbiosis: symbiosisBridge
      ? {
          runSymbiosisTick: async (snapshot) => {
            const driftInsights = await symbiosisBridge.heartbeat(snapshot);
            // B 路线：能量反哺调度——每轮心跳把经济健康度折算为调度乘数
            // （赚钱升权 / 亏损降权；开关关闭时 scheduler 侧乘数恒为 1）
            if (schedulingFeedbackEnabled) {
              const signals = symbiosisBridge.economicSignals();
              modelScheduler.updateEconomicSignals(
                new Map([...signals].map(([modelId, s]) => [modelId, s.multiplier])),
              );
            }
            // C 路线：能量 Sankey 周期落盘（自包含 HTML，零依赖离线可开）
            symbiosisTickCount += 1;
            if (sankeyPath && symbiosisTickCount % sankeyEveryNTicks === 0) {
              try {
                fs.writeFileSync(sankeyPath, symbiosisBridge.sankeyHtml());
                broadcast({ type: 'sankey-updated', path: sankeyPath, tick: symbiosisTickCount });
                logger.debug('能量 Sankey 已落盘: %s', sankeyPath);
              } catch (err) {
                logger.warn('能量 Sankey 落盘失败: %s', err instanceof Error ? err.message : err);
              }
            }
            if (driftInsights.length > 0) {
              broadcast({ type: 'market-divergence', count: driftInsights.length, messages: driftInsights.map((i) => i.message) });
              logger.warn('信念市场漂移告警 ×%d（市场价 vs 统计估计显著背离）', driftInsights.length);
            }
            // A 路线：futarchy 进化表决决议广播（funded / market-rejected / governor-vetoed）
            const decisions = symbiosisBridge.lastFutarchyDecisions();
            if (decisions.length > 0) {
              for (const d of decisions) {
                broadcast({ type: 'futarchy-decision', ...d });
                logger.info(
                  'futarchy 进化表决：%s（隐含成功概率 %.3f%s）',
                  d.decision,
                  d.impliedProb,
                  d.decision === 'funded' ? ` → 已资助执行，行动${d.actionSuccess ? '成功' : '失败'}` : '',
                );
              }
            }
            return driftInsights;
          },
        }
      : undefined,
  });

  /**
   * 10 步链路编排主流程（第 3~10 步）
   *
   * 深度优化：第 3~4 步由决策引擎四级流水线完成
   * （规则快速路径 → 决策缓存 → strategist → 启发式兜底）
   */
  async function processBatch(batch: SignalBatch): Promise<void> {
    broadcast({ type: 'batch-start', signalCount: batch.signals.length, signals: batch.signals.map((s) => ({ id: s.id, type: s.type })) });

    // ── 自主智能·预见：世界模型学习本批信号到达规律 ──
    for (const signal of batch.signals) {
      worldModel.observeArrival(signal.type, signal.receivedAt);
    }

    // ── 自主智能：策略进化基因组选择 → 决策引擎参数落地 ──
    const genome = strategyEvolution.selectGenome();
    decisionEngine.updateConfig({ ...genome.genes });

    // ── 第 3~4 步：决策引擎（优先级排序 + 战略决策） ──
    broadcast({ type: 'strategist-thinking', step: 3, message: '决策引擎四级流水线评估中' });
    const history = buildSignalHistory(batch.signals);
    const decisions = await decisionEngine.decide(batch.signals, history);
    const sorted = [...batch.signals].sort((a, b) => (decisions.get(b.id)?.urgency ?? 0) - (decisions.get(a.id)?.urgency ?? 0));

    broadcast({ type: 'strategist-thinking', step: 4, message: '战略决策完成，按紧急度执行' });
    for (const signal of sorted) {
      const decision = decisions.get(signal.id);
      const action = decision?.action ?? 'execute';
      signal.urgency = signal.urgency ?? decision?.urgency ?? 0.5;
      broadcast({
        type: 'signal-received',
        signal: { id: signal.id, type: signal.type, urgency: signal.urgency, decision: action },
        decisionSource: decision?.source,
        confidence: decision?.confidence,
        pendingCount: sentinel.getPendingSignals().length,
      });
      ctx.emit('scheduler/signal', signal);

      try {
        if (action === 'execute') {
          const result = await executeSignal(signal);
          // 决策反馈闭环：成功执行 → 修正决策引擎缓存与规则计数器
          const fingerprint = decisionEngine.fingerprint(signal);
          decisionEngine.recordOutcome(signal.type, fingerprint, 'good');
          // 自主智能：策略进化适应度回写 + 目标进度回写
          strategyEvolution.recordOutcome(genome.id, 'good');
          settleGoalProgress(signal.id, true);
          // 自主智能·边界：治理器结果回写（熔断器 / 预算统计）
          governor.recordOutcome(result ? result.success : false, result?.totalTokens ?? 0, 0);
          // 自主智能·内在动机：探索任务回写好奇心收获
          if (signal.payload?.exploration) {
            curiosity.recordExploration(signal.type, Boolean(result?.success), result ? `质量 ${result.avgQuality.toFixed(2)}` : undefined);
          }
        } else if (action === 'defer') {
          deferredQueue.push({ signal, deferUntil: Date.now() + (decision?.deferMs ?? 60_000) });
          recordDecision(signal, action, 'acceptable', `延迟 ${Math.round((decision?.deferMs ?? 60_000) / 1000)}s 后重审（${decision?.reason ?? ''}）`);
          strategyEvolution.recordOutcome(genome.id, 'acceptable');
        } else if (action === 'ask-user') {
          recordDecision(signal, action, 'acceptable', decision?.reason ?? '需要人工确认');
          strategyEvolution.recordOutcome(genome.id, 'acceptable');
        } else {
          recordDecision(signal, 'dismiss', 'good', decision?.reason ?? '战略决策忽略');
          strategyEvolution.recordOutcome(genome.id, 'good');
          // dismiss 也反馈给决策引擎（抑制窗口依赖成功记录，dismiss 不记录成功）
        }
      } catch (err) {
        logger.error('信号 %s 处理失败: %s', signal.id, (err as Error).message);
        recordDecision(signal, action, 'failed', (err as Error).message);
        // 失败反馈：驱动失败升级规则
        const fingerprint = decisionEngine.fingerprint(signal);
        decisionEngine.recordOutcome(signal.type, fingerprint, 'failed');
        // 自主智能：失败适应度回写 + 目标进度回写
        strategyEvolution.recordOutcome(genome.id, 'failed');
        settleGoalProgress(signal.id, false);
        // 自主智能·边界：治理器失败回写（驱动熔断器）
        governor.recordOutcome(false, 0, 0);
        // 自主智能·内在动机：探索失败回写
        if (signal.payload?.exploration) {
          curiosity.recordExploration(signal.type, false, (err as Error).message);
        }
      }
    }

    // 到期延迟信号重新入队
    const now = Date.now();
    for (let i = deferredQueue.length - 1; i >= 0; i -= 1) {
      const item = deferredQueue[i];
      if (item.deferUntil <= now) {
        deferredQueue.splice(i, 1);
        sentinel.ingest({ type: item.signal.type, description: item.signal.description, payload: item.signal.payload, source: 'deferred' });
      }
    }
  }

  /** 目标进度回写：信号执行完成后更新绑定的目标子任务状态 */
  function settleGoalProgress(signalId: string, success: boolean): void {
    const bound = goalEngine.findBySignal(signalId);
    if (!bound) return;
    const transition = goalEngine.recordSubtaskOutcome(bound.goal.id, bound.subtask.id, success, success ? '执行成功' : '执行失败');
    broadcast({ type: 'goal-progress', goalId: bound.goal.id, subtaskId: bound.subtask.id, success, transition });
    if (transition === 'completed') {
      logger.info('自主目标达成: %s', bound.goal.title);
      broadcast({ type: 'goal-completed', goalId: bound.goal.id, title: bound.goal.title });
    } else if (transition === 'abandoned') {
      logger.warn('自主目标放弃: %s', bound.goal.title);
    }
  }

  /** 构建信号历史统计（决策引擎上下文，来自长期记忆） */
  function buildSignalHistory(signals: Signal[]): Map<string, SignalHistoryStats> {
    const history = new Map<string, SignalHistoryStats>();
    for (const signal of signals) {
      if (history.has(signal.type)) continue;
      const decisionStats = memory.getDecisionSuccessRate(signal.type);
      const pattern = memory.findPattern(signal.type, 0.5);
      history.set(signal.type, {
        totalDecisions: decisionStats.total,
        successRate: decisionStats.successRate,
        avgExecutionTime: pattern?.avgExecutionTime ?? 0,
        avgTokenCost: pattern && pattern.successfulPlans.length > 0
          ? pattern.successfulPlans.reduce((sum, p) => sum + p.tokenCost, 0) / pattern.successfulPlans.length
          : 0,
      });
    }
    return history;
  }

  /**
   * 推断信号的任务上下文（第二阶段升级）
   *
   * 此前调用 lookupExperience 时 complexity 硬编码 0.5、features 恒为空，
   * 导致程序记忆中 complexity>=0.7 / feature contains code 类条件永不满足，
   * 三层级联中最高层从未真正命中。此处在计划生成前用启发式从信号描述推断
   * features / complexity / length，让程序记忆与语义记忆的条件匹配真正生效。
   * （启发式仅影响"记忆检索"这一只读环节，不影响任何执行语义，风险可控）
   */
  function inferTaskContext(signal: Signal): { features: string[]; complexity: number; length: number } {
    const text = `${signal.type} ${signal.description}`.toLowerCase();
    const keywords: Array<[string, string]> = [
      ['code', 'code'], ['代码', 'code'], ['refactor', 'code'], ['重构', 'code'],
      ['review', 'review'], ['审查', 'review'],
      ['test', 'test'], ['测试', 'test'],
      ['doc', 'documentation'], ['文档', 'documentation'], ['翻译', 'translation'], ['translate', 'translation'],
      ['analyz', 'analysis'], ['分析', 'analysis'], ['report', 'analysis'],
    ];
    const features = [...new Set(keywords.filter(([kw]) => text.includes(kw)).map(([, tag]) => tag))];
    // 复杂度启发式：描述长度归一（100~4000 字符 → 0.4~0.95），叠加特征加成
    const length = signal.description.length;
    let complexity = Math.min(0.95, 0.4 + (Math.log10(Math.max(10, length)) - 2) * 0.35);
    if (features.includes('code')) complexity = Math.min(1, complexity + 0.15);
    if (features.length >= 3) complexity = Math.min(1, complexity + 0.05);
    return { features, complexity, length };
  }

  /**
   * 执行单个信号（第 5~10 步）
   * @returns 计划执行结果（共识未提交时返回 null）
   */
  async function executeSignal(signal: Signal): Promise<PlanExecutionResult | null> {
    // 共识门控：集群模式下决策需经 Raft 提交
    if (raft) {
      const proposal = await raft.propose({
        type: 'execute-plan',
        signalId: signal.id,
        signalDescription: signal.description,
        decision: {
          action: 'execute',
          urgency: signal.urgency ?? 0.5,
          confidence: 1,
          reason: `共识门控提交执行：${signal.description}`,
          source: 'rule',
          decidedAt: Date.now(),
        },
        proposedBy: cfg.sync?.localNodeId ?? 'node-dev-01',
      });
      if (!proposal.committed) {
        recordDecision(signal, 'execute', 'failed', '共识提案未提交');
        return null;
      }
    }

    // 第 5 步：经验检索（优化器：记忆库 → 优化器，叠加蒸馏策略与历史教训）
    // 第二阶段升级：传入推断的 features/complexity/length，让程序/语义记忆的条件匹配真正生效
    const taskType = signal.type;
    const inferred = inferTaskContext(signal);
    const lookup = optimizer.lookupExperience(taskType, inferred.complexity, inferred.features, { length: inferred.length });
    const strategies = memory.getStrategies(taskType, 3);
    const lessons = reflectionEngine.getLessons(taskType, 3);
    broadcast({
      type: 'strategist-thinking',
      step: 5,
      message: `经验检索[记忆层级:${lookup.memoryLayer}]: ${lookup.rationale}，蒸馏策略 ${strategies.length} 条，历史教训 ${lessons.length} 条`,
    });

    // 第二阶段升级：消费程序记忆动作——
    // 1) avoid-model 负向约束：从推荐组合中剔除被规避模型（如历史超时/能力不足的模型）
    // 2) 广播命中动作（enable-cot / parallelism / param-tune 等），供执行侧与可观测性消费
    const avoided = new Set(lookup.avoidModels ?? []);
    const effectiveRecommended = Object.fromEntries(
      Object.entries(lookup.recommendedModels).filter(([, model]) => !avoided.has(model)),
    );
    if (avoided.size > 0 || (lookup.suggestedActions?.length ?? 0) > 0) {
      broadcast({
        type: 'procedural-actions-applied',
        signalId: signal.id,
        avoidedModels: [...avoided],
        actions: lookup.suggestedActions?.map((a) => ({ type: a.type, params: a.params, rationale: a.rationale })) ?? [],
      });
    }

    // 第 6 步：计划生成
    // 经验快路径（优化器）：命中高置信度成熟模式时，直接复用历史最优成功计划，
    // 跳过 strategist LLM 重新规划（越用越快、越稳、越省 token）
    let plan = optimizer.recallPlan(lookup, signal.description);
    if (plan) {
      broadcast({
        type: 'strategist-thinking',
        step: 6,
        message: `经验快路径：复用历史成功计划（置信度 ${lookup.pattern!.confidence.toFixed(2)}，${plan.nodes.length} 节点），跳过 LLM 规划`,
      });
      logger.info('经验快路径命中：任务类型 %s 复用历史计划（%d 节点）', taskType, plan.nodes.length);
    } else {
      // 常规路径：strategist 输出 DAG，注入蒸馏策略与教训上下文
      let strategistOutput: string | undefined;
      try {
        // 防幻觉（自主学习建议 3）：冗长记忆 ID 转短索引（#1…）注入模型，输出后反解回完整 ID
        const aliasMap = new AliasMap();
        const strategyLines = strategies.map((s) => `${aliasMap.encode(s.id)} ${s.description}`);
        const lessonLines = lessons.map((l) => `${aliasMap.encode(l.id)} ${l.lesson}→${l.suggestion}`);
        const experienceContext = [
          lookup.pattern ? `历史经验(推荐模型): ${JSON.stringify(effectiveRecommended)}` : '',
          strategyLines.length > 0 ? `蒸馏策略(引用时仅用短索引): ${strategyLines.join('；')}` : '',
          lessonLines.length > 0 ? `历史教训(务必规避，引用时仅用短索引): ${lessonLines.join('；')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        const response = await llm.chat(
          strategistId,
          [
            { role: 'system', content: '你是任务规划器。将任务拆解为 DAG，输出 JSON: {"nodes":[{"id","description","type","dependsOn"}],"parallelismStrategy":"layered"}。' },
            { role: 'user', content: `任务: ${signal.description}\n任务类型: ${taskType}${experienceContext ? `\n${experienceContext}` : ''}` },
          ],
          { timeout: 30_000, maxRetries: 1 },
        );
        // 模型输出中的短索引反解回完整记忆 ID（未登记的索引原样保留）
        strategistOutput = aliasMap.decodeText(response.content);
      } catch (err) {
        logger.warn('strategist 计划生成失败，使用兜底计划: %s', (err as Error).message);
      }
      plan = taskExecutor.buildPlan(signal.description, strategistOutput, taskType);
    }

    // 第 7~10 步：并行执行 + 质量反思 + 级联触发 + 经验沉淀
    // 4.0 治理闭环：主执行路径接入安全治理器（升级前仅自主循环子集动作受治理，
    // 核心执行绕过限流/预算/置信度门控——治理器形同虚设）
    const governance = governor.govern('autonomous-execute', lookup.pattern?.confidence ?? 0.8);
    if (!governance.allowed) {
      recordDecision(signal, 'execute', 'failed', `治理拦截：${governance.reason ?? 'unknown'}`);
      broadcast({ type: 'execution-governed', signalId: signal.id, blockedBy: governance.blockedBy, reason: governance.reason });
      logger.warn('执行被安全治理器拦截 [%s]: %s', governance.blockedBy, governance.reason);
      return null;
    }

    // 经验驱动选型：把记忆推荐模型组合（按节点类型，已剔除 avoid-model 目标）传入执行器
    // 4.0：avoidModels 负向约束贯通执行全程（调度选型 + 重试切换均排除）
    if (hotReload) hotReload.registerTask(signal.id, taskType);
    try {
      const result = await taskExecutor.executePlan(signal, plan, effectiveRecommended, { avoidModels: [...avoided] });
      ctx.emit('scheduler/plan-complete', result, signal);
      recordDecision(signal, 'execute', result.success ? (result.avgQuality >= 0.85 ? 'excellent' : 'good') : 'failed', result.success ? `平均质量 ${result.avgQuality.toFixed(2)}` : result.error ?? '执行失败');

      // ── 第 10 步：反思器（任务执行 → 反思器 → 记忆更新） ──
      // 一次性完成：质量趋势记录 + 经验沉淀（模式/画像/失败记录）+
      // 蒸馏策略应用反馈回写（有效策略越用越强，无效策略自然淘汰）+ 教训提取/经验蒸馏
      // 第二阶段升级：语义/程序记忆应用反馈回写 + 达阈值自动触发知识蒸馏
      // 第一阶段 2.0：调度决策洞察回注（Brier 校准闭环 + 反事实遗憾分析）
      reflector.reflectOnOutcome({
        signal,
        plan,
        result,
        appliedStrategies: strategies.map((s) => s.id),
        appliedMemoryIds: {
          semantic: lookup.matchedSemanticId ? [lookup.matchedSemanticId] : [],
          procedural: lookup.matchedProceduralIds ?? [],
        },
        decisionInsights: taskExecutor.getAndClearDecisionInsights(),
      });

      // ── 第五阶段 Phase 2.5：任务结算 → 能量经济（价值铸币闭环）──
      // 各模型按成功节点的质量加权分红；失败任务不铸币但记录贡献证据
      if (symbiosisBridge) {
        symbiosisBridge.settleTask(result);
      }
      return result;
    } finally {
      if (hotReload) hotReload.unregisterTask(signal.id);
    }
  }

  /** 决策反馈沉淀（第 10 步组成部分） */
  function recordDecision(signal: Signal, decision: string, outcome: 'excellent' | 'good' | 'acceptable' | 'poor' | 'failed', reason: string): void {
    memory.recordDecisionFeedback({
      signalType: signal.type,
      signalDescription: signal.description,
      decision,
      outcome,
      outcomeReason: reason,
    });
    sync.recordChange('feedback-created', `fb-${signal.id}`, {
      id: `fb-${signal.id}`,
      timestamp: Date.now(),
      signalType: signal.type,
      signalDescription: signal.description,
      decision,
      outcome,
      outcomeReason: reason,
    });
  }

  /** 进度广播（enableProgress 关闭时为空操作） */
  function broadcast(event: Record<string, any>): void {
    if (!broadcaster) return;
    broadcaster.broadcast({ type: event.type as string, timestamp: Date.now(), ...event });
  }

  // ── 启动各引擎 ──
  if (broadcaster) {
    broadcaster.start();
    attachDashboard(broadcaster, () => llm.getModelStatuses());
  }
  sentinel.start();
  if (autonomyEnabled) {
    autonomyLoop.start();
    logger.info('自主心跳循环已启动（间隔 %dms）', cfg.autonomy?.heartbeatMs ?? 30_000);
  }
  if (raft) {
    raft.start();
    raft.onRoleChange((role, term) => broadcast({ type: 'role-change', role, term }));
  }
  if (hotReload) {
    hotReload.startWatching();
    hotReload.on('deploy-succeeded', (event: any) => broadcast({ type: 'plugin-reloaded', version: event.version }));
  }

  // 恢复已注册租户
  for (const tenant of cfg.tenants ?? []) {
    try {
      if (!tenantManager.getTenant(tenant.id)) tenantManager.registerTenant(tenant);
    } catch (err) {
      logger.warn('租户恢复失败 %s: %s', tenant.id, (err as Error).message);
    }
  }

  // 注册基准测试内置场景
  benchmark.registerBuiltinScenarios({
    memory,
    cryptoEngine: cryptoEngine ?? (new CryptoEngine({ enabled: false, masterKey: 'benchmark-placeholder', algorithm: 'aes-256-gcm', sensitiveFields: [], fullFileEncryption: false })),
    callLLM: (modelId: string, messages: any[]) => llm.chat(modelId, messages),
    models: mergedModels.map((m) => ({ id: m.id, endpoint: m.endpoint, apiKey: m.apiKey ?? '' })),
  });

  logger.info('调度器已启动: %d 个模型, 哨兵窗口 %ss, 进度端口 %s', mergedModels.length, cfg.sentinel?.aggregationWindow ?? 0.5, cfg.enableProgress ? String(cfg.progressPort) : '关闭');

  // ─────────────────────────── 12 Tool 注册 ───────────────────────────

  const tools = new ToolRegistry();

  // 1. autonomous_execute — 提交自主任务
  tools.register({
    name: 'autonomous_execute',
    description: '提交一个自主任务，由调度器完成感知-决策-执行-沉淀全链路',
    parameters: {
      task: { type: 'string', description: '任务描述', required: true },
      urgency: { type: 'number', description: '紧急度 0~1，缺省 0.8' },
    },
    handler: (args) => {
      if (!args.task || typeof args.task !== 'string') throw new ToolError('task 为必填字符串');
      const urgency = typeof args.urgency === 'number' ? Math.max(0, Math.min(1, args.urgency)) : 0.8;
      const signal = sentinel.ingest({ type: 'manual-task', description: args.task, payload: { task: args.task }, source: 'manual', urgency });
      return { signalId: signal.id, urgency, status: 'queued' };
    },
  });

  // 2. model_dashboard — 查看模型状态
  tools.register({
    name: 'model_dashboard',
    description: '查看所有已注册模型的运行时状态（并发、成功率、延迟、token、成本）',
    parameters: {},
    handler: () => ({ models: llm.getModelStatuses(), sentinel: sentinel.getStatus() }),
  });

  // 3. query_memory — 查询记忆库
  tools.register({
    name: 'query_memory',
    description: '查询长期记忆库（含蒸馏策略、教训、质量趋势、决策引擎统计）',
    parameters: {
      query_type: { type: 'string', description: '查询类型', required: true, enum: ['overview', 'patterns', 'model-profile', 'feedback', 'strategies', 'lessons', 'trends', 'decision-stats', 'goals', 'health', 'evolution', 'autonomy-status', 'world-model', 'curiosity', 'governance', 'introspect', 'keys'] },
      limit: { type: 'number', description: '返回条数上限，缺省 10' },
      task_type: { type: 'string', description: 'strategies/lessons 按任务类型过滤（可选）' },
    },
    handler: (args) => {
      const limit = typeof args.limit === 'number' ? args.limit : 10;
      switch (args.query_type) {
        case 'overview':
          return { globalStats: memory.getGlobalStats(), summary: memory.getMemorySummary() };
        case 'patterns':
          return { patterns: memory.getTopPatterns(limit) };
        case 'model-profile':
          return { profiles: memory.getAllModelProfiles() };
        case 'feedback':
          return { feedback: memory.getRecentFeedback(limit) };
        case 'strategies':
          return { strategies: args.task_type ? memory.getStrategies(String(args.task_type), limit) : memory.getAllStrategies().slice(0, limit) };
        case 'lessons':
          return { lessons: args.task_type ? reflectionEngine.getLessons(String(args.task_type), limit) : reflectionEngine.getAllLessons().slice(-limit) };
        case 'trends':
          return { trends: reflectionEngine.getTrendSummary() };
        case 'decision-stats':
          return { stats: decisionEngine.getStats(), audit: decisionEngine.getAudit(limit) };
        case 'goals':
          return { summary: goalEngine.getSummary(), goals: goalEngine.getAllGoals().slice(0, limit) };
        case 'health':
          return { health: metaCognition.getHealthReport(), anomalies: metaCognition.getAnomalies().slice(-limit), tuning: metaCognition.getTuningHistory().slice(-limit) };
        case 'evolution':
          return { evolution: strategyEvolution.getReport(), history: strategyEvolution.getEvolutionHistory().slice(-limit) };
        case 'autonomy-status':
          return { status: autonomyLoop.getStatus(), reports: autonomyLoop.getReports().slice(-limit) };
        case 'world-model':
          return { summary: worldModel.getSummary(), predictions: worldModel.predictArrivals().slice(0, limit) };
        case 'curiosity':
          return { summary: curiosity.getSummary(), gaps: curiosity.scanKnowledgeGaps().slice(0, limit) };
        case 'governance':
          return { status: governor.getStatus(), audit: governor.getAudit(limit) };
        case 'keys':
          return {
            health: keyHealth.status(),
            userOrder: keyHealth.getKeyOrder(),
            sources: Object.fromEntries(mergedModels.map((m) => [m.id, describeKeySources(m.id)])),
          };
        case 'introspect':
          return { introspection: autonomyLoop.introspect() };
        default:
          throw new ToolError(`未知 query_type: ${args.query_type}`);
      }
    },
  });

  // 4. query_experience — 查询经验库
  tools.register({
    name: 'query_experience',
    description: '按任务类型检索历史经验（相似模式、成功率、推荐模型、记忆层级）',
    parameters: {
      task_type: { type: 'string', description: '任务类型（可选，缺省返回 Top 模式）' },
      complexity: { type: 'number', description: '复杂度 0~1（可选，缺省 0.5）' },
      features: { type: 'string', description: '特征标签逗号分隔（可选，如 code,test）' },
    },
    handler: (args) => {
      if (args.task_type) {
        // 第二阶段升级：支持传入 complexity/features，真实触发程序/语义记忆条件匹配
        const complexity = typeof args.complexity === 'number' ? Math.max(0, Math.min(1, args.complexity)) : 0.5;
        const features = typeof args.features === 'string' ? args.features.split(',').map((f: string) => f.trim()).filter(Boolean) : [];
        const lookup = optimizer.lookupExperience(String(args.task_type), complexity, features);
        return { taskType: args.task_type, ...lookup };
      }
      return { patterns: memory.getTopPatterns(10) };
    },
  });

  // 4b. distill_knowledge — 触发知识蒸馏（第二阶段：语义+程序记忆）
  tools.register({
    name: 'distill_knowledge',
    description: '触发知识蒸馏：从累积情景记忆中产出语义记忆与程序记忆（三层记忆升级；强制全量蒸馏，绕过水位门控）',
    parameters: {},
    handler: async () => {
      const report = await reflector.distillKnowledge({ force: true });
      return {
        distilledAt: report.distilledAt,
        sourceEpisodicCount: report.sourceEpisodicCount,
        semanticCount: report.semanticMemories.length,
        proceduralCount: report.proceduralMemories.length,
        strategyCount: report.strategies.length,
        mergedSemanticCount: report.mergedSemanticCount ?? 0,
        mergedProceduralCount: report.mergedProceduralCount ?? 0,
        supersededCount: report.supersededCount ?? 0,
        semanticMemories: report.semanticMemories.map((m) => ({ id: m.id, domain: m.domain, statement: m.statement, confidence: m.confidence, supportCount: m.supportCount })),
        proceduralMemories: report.proceduralMemories.map((p) => ({ id: p.id, kind: p.kind, name: p.name, action: p.action.type, confidence: p.confidence, supportCount: p.supportCount })),
        summary: report.summary,
      };
    },
  });

  // 4c. mental_report — 心智报告（第四阶段：自我建模的人类审查入口）
  tools.register({
    name: 'mental_report',
    description:
      '第四阶段元认知层：生成/查询系统心智报告（策略优劣势、记忆健康趋势、进化器效率、稳定性风险、自我改进证据、推荐调整），支持人类审查与手动干预',
    parameters: {
      action: {
        type: 'string',
        description: 'generate 生成新报告（含保守调整推荐）/ latest 最近报告 / history 报告历史 / trend 趋势序列 / formatted 人类可读版',
        required: true,
        enum: ['generate', 'latest', 'history', 'trend', 'formatted'],
      },
      limit: { type: 'number', description: 'history 返回条数上限，缺省 10' },
    },
    handler: async (args) => {
      switch (args.action) {
        case 'generate': {
          const report = await selfModel.generateMentalReport();
          broadcast({ type: 'mental-report', reportIndex: report.reportIndex, status: 'generated', stabilityScore: report.systemStability.stabilityScore });
          return {
            report,
            formatted: selfModel.formatReport(report),
          };
        }
        case 'latest': {
          const report = selfModel.getLatestReport();
          if (!report) throw new ToolError('暂无心智报告，先执行 action=generate');
          return { report };
        }
        case 'history':
          return { history: selfModel.getReportHistory().slice(-Math.max(1, args.limit ?? 10)) };
        case 'trend':
          return { trend: selfModel.getTrendSeries() };
        case 'formatted': {
          const report = selfModel.getLatestReport();
          if (!report) throw new ToolError('暂无心智报告，先执行 action=generate');
          return { formatted: selfModel.formatReport(report) };
        }
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 4e. self_knowledge — 自知之明报告（3.0：统一证据 + 校准自修正的运维入口）
  tools.register({
    name: 'self_knowledge',
    description:
      '3.0 自知之明报告：调度预测校准（Brier 分 / 残差 / 过自信-欠自信方向 / 自修正量）+ 全层证据普查（策略/语义/程序/模型画像四层的证据覆盖度、平均有效样本量、证据枯竭数、模型能力漂移）——系统知道自己哪些记忆可信、哪些在过期、预测有多准',
    parameters: {},
    handler: async () => {
      const report = reflector.getSelfKnowledge();
      return {
        generatedAt: report.generatedAt,
        calibration: report.calibration,
        census: report.census
          ? {
              generatedAt: report.census.generatedAt,
              layers: report.census.layers,
              driftedModels: report.census.driftedModels,
            }
          : undefined,
      };
    },
  });

  // 4d. meta_cognition — 元认知控制（第四阶段：手动干预入口）
  tools.register({
    name: 'meta_cognition',
    description:
      '第四阶段元认知控制器（2.0 学习型稳态控制）：evaluate 推进保守调整状态机（应用/观察/判定/回滚）/ status 旋钮面板、学习器有效性、熔断器与审计日志 / rollback 手动回滚最近调整 / override 手动覆盖旋钮（自动调整冻结）/ freeze 全局冻结与解冻 / rearm-breaker 复位熔断器（连续回滚触发的旋钮级或全局熔断）',
    parameters: {
      action: {
        type: 'string',
        description: '控制动作',
        required: true,
        enum: ['evaluate', 'status', 'rollback', 'override', 'unfreeze-knob', 'freeze', 'rearm-breaker'],
      },
      knob: { type: 'string', description: 'override / unfreeze-knob / rearm-breaker 时的旋钮 id（如 evolver.mutationRate）；rearm-breaker 缺省复位全部' },
      value: { type: 'number', description: 'override 时的目标取值' },
      frozen: { type: 'boolean', description: 'freeze 时的冻结开关（true 冻结 / false 解冻）' },
      limit: { type: 'number', description: 'status 时审计日志条数上限，缺省 20' },
    },
    handler: async (args) => {
      switch (args.action) {
        case 'evaluate': {
          const adjustment = await metaController.evaluateAndAdjust();
          return {
            status: adjustment.status,
            reportIndex: adjustment.reportIndex,
            applied: adjustment.applied,
            rolledBack: adjustment.rolledBack,
            committed: adjustment.committed,
            observation: adjustment.observation,
            skippedReason: adjustment.skippedReason,
            stabilityScore: adjustment.mentalReport.systemStability.stabilityScore,
            improvementEvidence: adjustment.mentalReport.improvementEvidence,
          };
        }
        case 'status': {
          const state = metaController.getState();
          return {
            frozen: state.frozen,
            frozenByBreaker: state.frozenByBreaker,
            manuallyFrozenKnobs: state.manuallyFrozenKnobs,
            circuitBreakers: state.circuitBreakers.filter((b) => b.tripped || b.consecutiveRollbacks > 0),
            learner: state.learner,
            safeEnvelopes: state.safeEnvelopes,
            pending: state.pending,
            knobs: state.knobs,
            counters: { adjustments: state.totalAdjustments, rollbacks: state.totalRollbacks, commits: state.totalCommits },
            auditTrail: state.auditTrail.slice(-Math.max(1, args.limit ?? 20)),
          };
        }
        case 'rollback':
          return { result: await metaController.rollbackLastAdjustment() };
        case 'override': {
          if (!args.knob || typeof args.value !== 'number') throw new ToolError('override 需要 knob 与 value 参数');
          return { result: metaController.setManualOverride(String(args.knob), args.value) };
        }
        case 'unfreeze-knob': {
          if (!args.knob) throw new ToolError('unfreeze-knob 需要 knob 参数');
          return { cleared: metaController.clearManualOverride(String(args.knob)) };
        }
        case 'freeze':
          metaController.setFrozen(args.frozen !== false);
          return { frozen: args.frozen !== false };
        case 'rearm-breaker':
          return { reArmed: metaController.reArmBreaker(args.knob ? String(args.knob) : undefined) };
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 5. maintain_memory — 维护记忆库
  tools.register({
    name: 'maintain_memory',
    description: '维护长期记忆库（清理过期数据 / 查看状态）',
    parameters: {
      action: { type: 'string', description: '维护动作', required: true, enum: ['prune', 'status'] },
      maxAgeDays: { type: 'number', description: 'prune 时保留的天数，缺省 90' },
    },
    handler: (args) => {
      if (args.action === 'prune') return { pruned: memory.prune(typeof args.maxAgeDays === 'number' ? args.maxAgeDays : 90) };
      if (args.action === 'status') return { globalStats: memory.getGlobalStats(), summary: memory.getMemorySummary() };
      throw new ToolError(`未知 action: ${args.action}`);
    },
  });

  // 6. manage_tenants — 管理多租户
  tools.register({
    name: 'manage_tenants',
    description: '多租户管理（列表 / 注册 / 移除 / 更新 / 统计 / 路径匹配）',
    parameters: {
      action: { type: 'string', description: '管理动作', required: true, enum: ['list', 'register', 'remove', 'update', 'stats', 'match'] },
      config: { type: 'object', description: 'register 时的租户配置' },
      tenantId: { type: 'string', description: '目标租户 id' },
      updates: { type: 'object', description: 'update 时的更新字段' },
      filePath: { type: 'string', description: 'match 时的文件路径' },
    },
    handler: (args) => {
      switch (args.action) {
        case 'list':
          return { tenants: tenantManager.getAllTenants().map((t) => ({ id: t.config.id, name: t.config.name, enabled: t.config.enabled !== false, activeExecutions: t.activeExecutions })) };
        case 'register':
          return { tenant: tenantManager.registerTenant(args.config).config };
        case 'remove':
          tenantManager.removeTenant(String(args.tenantId), Boolean(args.deleteData));
          return { removed: args.tenantId };
        case 'update':
          tenantManager.updateTenant(String(args.tenantId), args.updates ?? {});
          return { updated: args.tenantId };
        case 'stats':
          return { stats: tenantManager.getGlobalStats() };
        case 'match': {
          const matched = tenantManager.matchTenantByPath(String(args.filePath ?? ''));
          return { matched: matched ? { id: matched.config.id, name: matched.config.name } : null };
        }
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 7. manage_encryption — 管理加密
  tools.register({
    name: 'manage_encryption',
    description: '加密管理（生成密钥 / 轮换密钥 / 查看状态 / 加密存量文件 / 解密文件）',
    parameters: {
      action: { type: 'string', description: '加密动作', required: true, enum: ['generate-key', 'rotate-key', 'check-status', 'encrypt-existing', 'decrypt-file'] },
      filePath: { type: 'string', description: '目标文件路径（rotate-key / decrypt-file）' },
      newMasterKey: { type: 'string', description: 'rotate-key 的新主密钥' },
    },
    handler: (args) => {
      if (args.action === 'generate-key') return { key: CryptoEngine.generateKey() };
      if (args.action === 'check-status') {
        return { enabled: Boolean(cryptoEngine), algorithm: cfg.encryption?.algorithm ?? 'aes-256-gcm', fingerprint: cryptoEngine?.getKeyFingerprint() ?? null };
      }
      if (!cryptoEngine) throw new ToolError('加密功能未启用（encryption.enabled=false）');
      if (args.action === 'rotate-key') return cryptoEngine.rotateKey(String(args.filePath), String(args.newMasterKey));
      if (args.action === 'decrypt-file') {
        const { data } = cryptoEngine.readEncrypted(String(args.filePath));
        return { decrypted: true, preview: JSON.stringify(data).slice(0, 200) };
      }
      if (args.action === 'encrypt-existing') {
        const target = String(args.filePath ?? memoryPath);
        if (!fs.existsSync(target)) throw new ToolError(`文件不存在: ${target}`);
        const raw = JSON.parse(fs.readFileSync(target, 'utf-8'));
        return cryptoEngine.writeEncrypted(target, raw);
      }
      throw new ToolError(`未知 action: ${args.action}`);
    },
  });

  // 8. memory_migration — 记忆迁移
  tools.register({
    name: 'memory_migration',
    description: '记忆迁移（导出 / 导入 / 冲突预演 / 跨租户迁移）',
    parameters: {
      action: { type: 'string', description: '迁移动作', required: true, enum: ['export', 'import', 'dry-run', 'migrate-tenant'] },
      filePath: { type: 'string', description: '导出/导入文件路径' },
      strategy: { type: 'string', description: '合并策略', enum: ['overwrite', 'merge', 'skip', 'newer-wins'] },
      sourceTenantId: { type: 'string', description: 'migrate-tenant 源租户' },
      targetTenantId: { type: 'string', description: 'migrate-tenant 目标租户' },
    },
    handler: (args) => {
      switch (args.action) {
        case 'export': {
          const out = String(args.filePath ?? path.join(dataDir, `migration-${Date.now()}.json`));
          migrationTool.exportToFile(memory, out);
          return { exportedTo: out };
        }
        case 'import':
          return migrationTool.importFromFile(memory, String(args.filePath), (args.strategy as any) ?? 'merge');
        case 'dry-run': {
          const pkg = migrationTool.exportFromFile(String(args.filePath));
          return migrationTool.dryRun(memory, pkg);
        }
        case 'migrate-tenant': {
          const source = tenantManager.getTenant(String(args.sourceTenantId));
          const target = tenantManager.getTenant(String(args.targetTenantId));
          if (!source || !target) throw new ToolError('源或目标租户不存在');
          return migrationTool.migrateBetweenTenants(source.memory, target.memory);
        }
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 9. manage_sync — 管理分布式同步
  tools.register({
    name: 'manage_sync',
    description: '分布式记忆同步管理（状态 / 立即同步 / 注册节点）',
    parameters: {
      action: { type: 'string', description: '同步动作', required: true, enum: ['status', 'sync-now', 'register-node'] },
      peerId: { type: 'string', description: 'sync-now 目标节点' },
      node: { type: 'object', description: 'register-node 节点配置' },
    },
    handler: async (args) => {
      if (args.action === 'status') return sync.getStatus();
      if (args.action === 'sync-now') return sync.syncNow(String(args.peerId));
      if (args.action === 'register-node') {
        sync.registerNode(args.node as SyncNodeConfig);
        return { registered: (args.node as SyncNodeConfig)?.nodeId };
      }
      throw new ToolError(`未知 action: ${args.action}`);
    },
  });

  // 10. manage_consensus — 管理分布式共识
  tools.register({
    name: 'manage_consensus',
    description: 'Raft 共识管理（集群状态 / 提交提案）',
    parameters: {
      action: { type: 'string', description: '共识动作', required: true, enum: ['status', 'propose'] },
      command: { type: 'object', description: 'propose 的提案命令' },
    },
    handler: async (args) => {
      if (!raft) return { enabled: false, message: '共识功能未启用（consensus.enabled=false）' };
      if (args.action === 'status') return raft.getClusterStatus();
      if (args.action === 'propose') return raft.propose(args.command as ConsensusLogEntry['command']);
      throw new ToolError(`未知 action: ${args.action}`);
    },
  });

  // 11. run_benchmark — 性能基准测试
  tools.register({
    name: 'run_benchmark',
    description: '性能基准测试（全量运行 / 场景列表 / 报告列表 / 对比 / 生成报告）',
    parameters: {
      action: { type: 'string', description: '基准动作', required: true, enum: ['run-all', 'list-scenarios', 'list-reports', 'compare', 'generate-report'] },
      beforeId: { type: 'string', description: 'compare 的基准报告 id' },
      afterId: { type: 'string', description: 'compare 的对比报告 id' },
      reportId: { type: 'string', description: 'generate-report 的报告 id' },
    },
    handler: async (args) => {
      switch (args.action) {
        case 'run-all':
          return benchmark.runAll();
        case 'list-scenarios':
          return { scenarios: benchmark.listScenarios() };
        case 'list-reports':
          return { reports: benchmark.loadReports().map((r) => ({ id: r.id, timestamp: r.timestamp, overallPassed: r.overallPassed })) };
        case 'compare':
          return { comparison: benchmark.compareReports(String(args.beforeId), String(args.afterId)) };
        case 'generate-report': {
          const report = benchmark.loadReports().find((r) => r.id === args.reportId);
          if (!report) throw new ToolError(`报告不存在: ${args.reportId}`);
          return { markdown: benchmark.generateMarkdownReport(report) };
        }
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 12. manage_hot_reload — 管理热更新
  tools.register({
    name: 'manage_hot_reload',
    description: '插件热更新管理（状态 / 回滚 / 部署版本 / 启停监听）',
    parameters: {
      action: { type: 'string', description: '热更新动作', required: true, enum: ['status', 'rollback', 'deploy-version', 'stop-watching', 'start-watching'] },
      versionId: { type: 'string', description: 'deploy-version 的目标版本' },
    },
    handler: async (args) => {
      if (!hotReload) return { enabled: false, message: '热更新未启用（hotReload.enabled=false）' };
      switch (args.action) {
        case 'status':
          return hotReload.getStatus();
        case 'rollback':
          await hotReload.rollback();
          return { rolledBack: true };
        case 'deploy-version':
          await hotReload.manualDeploy(String(args.versionId));
          return { deployed: args.versionId };
        case 'stop-watching':
          hotReload.stopWatching();
          return { watching: false };
        case 'start-watching':
          hotReload.startWatching();
          return { watching: true };
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 13. manage_autonomy — 管理自主智能
  tools.register({
    name: 'manage_autonomy',
    description: '自主智能管理（心跳循环启停 / 手动心跳 / 注入洞察 / 目标管理 / 强制进化）',
    parameters: {
      action: { type: 'string', description: '自主动作', required: true, enum: ['status', 'start', 'stop', 'tick', 'inject-insight', 'list-goals', 'abandon-goal', 'evolve-now', 'kill-switch', 'revive', 'reset-circuit', 'introspect'] },
      insight: { type: 'object', description: 'inject-insight 的洞察对象（source/category/severity/message/suggestion/taskType）' },
      goalId: { type: 'string', description: 'abandon-goal 的目标 id' },
      engage: { type: 'boolean', description: 'kill-switch 的启停（true=启用紧急停止，false=解除）' },
    },
    handler: async (args) => {
      switch (args.action) {
        case 'status':
          return { status: autonomyLoop.getStatus(), health: metaCognition.getHealthReport(), goals: goalEngine.getSummary() };
        case 'start':
          autonomyLoop.start();
          return { running: true };
        case 'stop':
          autonomyLoop.stop();
          return { running: false };
        case 'tick':
          return { report: await autonomyLoop.tick() };
        case 'inject-insight': {
          const insight = args.insight as any;
          if (!insight?.message || !insight?.suggestion) throw new ToolError('insight 需包含 message 与 suggestion');
          const goals = goalEngine.generateGoalsFromInsights([{
            source: insight.source ?? 'user',
            category: insight.category ?? 'user-request',
            severity: typeof insight.severity === 'number' ? insight.severity : 0.6,
            message: String(insight.message),
            suggestion: String(insight.suggestion),
            taskType: insight.taskType,
          }]);
          for (const goal of goals) await goalEngine.decompose(goal.id);
          return { goalsCreated: goals.map((g) => ({ id: g.id, title: g.title, valueScore: g.valueScore })) };
        }
        case 'list-goals':
          return { goals: goalEngine.getAllGoals() };
        case 'abandon-goal': {
          const goal = goalEngine.getGoal(String(args.goalId));
          if (!goal) throw new ToolError(`目标不存在: ${args.goalId}`);
          goal.status = 'abandoned';
          return { abandoned: args.goalId };
        }
        case 'evolve-now': {
          const report = strategyEvolution.evolve(true);
          if (report) decisionEngine.updateConfig(strategyEvolution.bestGenesAsConfig());
          return { report, bestGenes: strategyEvolution.bestGenome().genes };
        }
        case 'kill-switch': {
          if (args.engage) {
            governor.engageKillSwitch();
            autonomyLoop.stop();
            broadcast({ type: 'kill-switch-engaged' });
            logger.warn('紧急停止开关已启用，自主行为已冻结');
            return { engaged: true };
          }
          governor.disengageKillSwitch();
          broadcast({ type: 'kill-switch-disengaged' });
          return { engaged: false };
        }
        case 'revive':
          governor.disengageKillSwitch();
          governor.resetCircuit();
          if (autonomyEnabled) autonomyLoop.start();
          return { revived: true };
        case 'reset-circuit':
          governor.resetCircuit();
          return { circuitState: governor.getCircuitState() };
        case 'introspect':
          return { introspection: autonomyLoop.introspect() };
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 14. manage_keys — 密钥管理（查看健康状态 / 调整密钥顺序）
  tools.register({
    name: 'manage_keys',
    description: '密钥管理：查看各密钥来源健康状态，或调整多密钥的使用顺序（持久化，重启保留）',
    parameters: {
      action: { type: 'string', description: '密钥动作', required: true, enum: ['list', 'set-order', 'clear-order'] },
      order: { type: 'array', description: 'set-order 的密钥来源顺序（如 ["local-config", "env:DASHSCOPE_API_KEY"]，靠前优先）' },
    },
    handler: (args) => {
      switch (args.action) {
        case 'list':
          return {
            health: keyHealth.status(),
            userOrder: keyHealth.getKeyOrder(),
            sources: Object.fromEntries(mergedModels.map((m) => [m.id, describeKeySources(m.id)])),
          };
        case 'set-order': {
          if (!Array.isArray(args.order) || args.order.length === 0) {
            throw new ToolError('set-order 需要非空的 order 数组（密钥来源标识列表）');
          }
          keyHealth.setKeyOrder(args.order);
          return { userOrder: keyHealth.getKeyOrder() };
        }
        case 'clear-order':
          keyHealth.clearKeyOrder();
          return { userOrder: [], restored: '默认顺序（环境变量序 → 本地配置）' };
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // ─────────────────────────── 官方 Tool 注册链路桥接 ───────────────────────────
  // 宿主加载了 @deepseek-ai/dsh-tools（ctx.tools 服务）时，把内部 14 个 Tool
  // 同步注册进官方 ToolRegistry，纳入 pre/around/post 执行管线与模型可见面；
  // duck-typing 探测（ctx.get 免 inject 读取，未提供时返回 undefined），
  // 不引入 dsh-tools 依赖（避免整套 agent 栈），
  // 宿主未提供时静默降级为仅内部 ToolRegistry + ctx.provide('schedulerTools')。
  const hostToolRegistry = (ctx as any).get?.('tools');
  const hostToolDisposers: Array<() => void> = [];
  if (hostToolRegistry && typeof hostToolRegistry.register === 'function') {
    for (const tool of tools.list()) {
      const internal = tools.get(tool.name)!;
      try {
        const dispose = hostToolRegistry.register({
          name: tool.name,
          description: tool.description,
          parameters: toJsonSchemaParameters(tool.parameters),
          output: {
            // 无约束 JSON 输出（注解型 schema 为官方子集的标准形式），渲染为文本块
            schema: {},
            render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          },
          execute: async (args: unknown) => internal.handler({ ...(args as Record<string, unknown>) }),
        });
        if (typeof dispose === 'function') hostToolDisposers.push(dispose);
      } catch (err) {
        // 单个 Tool 桥接失败不阻断启动（内部注册表仍可经 schedulerTools 使用）
        logger.warn('官方 Tool 注册跳过 %s: %s', tool.name, (err as Error).message);
      }
    }
    if (hostToolDisposers.length > 0) logger.info('已桥接 %d 个 Tool 到 DSH 官方注册表（ctx.tools）', hostToolDisposers.length);
  }

  // ─────────────────────────── 宿主融合层（质的飞跃） ───────────────────────────
  // 全宿主可观测（tools/result）+ 全宿主安全治理（tools/pre-execute）。
  // 宿主无 ctx.tools 时 activate() 静默返回 false，降级为纯内部模式。
  const selfToolNames = new Set(tools.list().map((t) => t.name));
  const hostFusion = new HostFusionLayer(cfg.hostFusion, {
    ctx,
    sentinel,
    worldModel,
    governor,
    broadcast,
    logger,
    selfToolNames,
    onLessonExtracted: (toolName, consecutiveFailures, lastError) => {
      reflectionEngine.addLesson({
        taskType: `host-tool:${toolName}`,
        rootCause: 'transient',
        lesson: `宿主工具 ${toolName} 连续失败 ${consecutiveFailures} 次：${lastError.slice(0, 200)}`,
        suggestion: '检查该工具的依赖/参数，或暂时规避调用',
        signalDescription: `宿主工具 ${toolName} 连续失败升级`,
      });
    },
  });
  hostFusion.activate();

  // ── 服务暴露 ──
  const service: SchedulerService = {
    tools,
    sentinel,
    modelScheduler,
    taskExecutor,
    memory,
    llm,
    tenantManager,
    sync,
    raft,
    hotReload,
    broadcaster,
    benchmark,
    cryptoEngine,
    decisionEngine,
    reflectionEngine,
    optimizer,
    reflector,
    goalEngine,
    metaCognition,
    strategyEvolution,
    // 第四阶段：元认知层（自我建模 + 元认知控制）
    selfModel,
    metaController,
    autonomyLoop,
    worldModel,
    curiosity,
    governor,
    hostFusion,
    submitTask: (task, urgency = 0.8) => sentinel.ingest({ type: 'manual-task', description: task, payload: { task }, source: 'manual', urgency }),
  };
  ctx.provide('scheduler', service);
  ctx.provide('schedulerTools', tools);

  // ─────────────────────────── cleanup（fiber 卸载时逆序清理） ───────────────────────────
  ctx.effect(() => {
    return () => {
      logger.info('调度器卸载中，清理资源…');
      hostFusion.dispose();
      for (const dispose of hostToolDisposers) {
        try {
          dispose();
        } catch {
          /* 官方注册表可能已随宿主卸载 */
        }
      }
      autonomyLoop.stop();
      hotReload?.stop();
      raft?.stop();
      sync.stop();
      sentinel.stop();
      tenantManager.dispose();
      broadcaster?.stop();
      llm.dispose();
      memoryGraph.save();
      memory.dispose();
      logger.info('调度器资源已清理');
    };
  }, 'scheduler-cleanup');
}

/**
 * 插件导出（cordis 函数插件形态 + 静态元数据）
 * - name：注册表显示名（Function.name 只读，须用 defineProperty）
 * - Config：Schemastery 标准 schema，加载时由 cordis resolveConfig 校验并填充默认值
 * - provide：向宿主声明本插件提供的服务（供加载器诊断，不改变运行时行为）
 */
const pluginEntry = apply as typeof apply & {
  name: string;
  Config: typeof Config;
  provide: string[];
};
Object.defineProperty(pluginEntry, 'name', { value: name });
pluginEntry.Config = Config;
pluginEntry.provide = ['scheduler', 'schedulerTools'];
export default pluginEntry;

// ─────────────────────────── 子模块再导出（集成层统一入口） ───────────────────────────
export * from './errors.js';
export * from './security/crypto-engine.js';
// 3.0 统一证据内核：显式具名再导出（wilsonLowerBound / 衰减与先验常量已随
// long-term-memory.js 的兼容再导出进入根入口，此处不重复以防 star 导出歧义）
export {
  decayFactor,
  evidenceRankScore,
  initEvidence,
  observeEvidence,
  readEvidence,
  EVIDENCE_MIN_SAMPLES,
  EVIDENCE_RANK_BLEND,
  LEGACY_EVIDENCE_DISCOUNT,
} from './core/evidence.js';
export type { MemoryEvidence, EvidenceView } from './core/evidence.js';
// ── 5.0 因果内核：因果边贝叶斯更新 + do-干预登记 + Shapley 反事实分红 ──
export * from './core/causal-kernel.js';
// ── 6.0 主动推断内核：期望自由能 EFE + 变分漂移 + 精度控制 ──
export * from './core/free-energy.js';
export * from './core/deliberation.js';
export * from './core/metareasoning.js';
export * from './core/abstraction.js';
// ── 10.0 科学家内核：最优实验设计（EIG + 混杂加成 + 预算仲裁 + 信息台账）──
export * from './core/scientist.js';
// ── 11.0 理论内核：从数据到定律（层级归纳 + MDL 压缩 + 零样本 + 范式转移）──
export * from './core/theorist.js';
// 4.0 弹性内核：熔断器 / 指数退避 / 错误分型（可靠执行共享组件）
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  backoffDelayMs,
  abortableSleep,
  classifyError,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_BACKOFF_CONFIG,
} from './core/resilience.js';
export type { BreakerState, BreakerProbe, BreakerStatus, CircuitBreakerConfig, BackoffConfig, RetryClass, ErrorClassification } from './core/resilience.js';
export * from './memory/long-term-memory.js';
export * from './memory/backend.js';
export * from './memory/memory-graph.js';
export * from './memory/alias-map.js';
export * from './contracts.js';
// 第三阶段：策略进化（策略表示/共享评分函数 + 安全沙盒 + 策略进化器）
export * from './policy/policy-types.js';
export * from './policy/sandbox.js';
export * from './policy/policy-evolver.js';
// 第四阶段：元认知层
export * from './meta/meta-types.js';
export * from './meta/self-model.js';
export * from './meta/meta-controller.js';
export * from './memory/migration-tool.js';
export * from './progress-ws.js';
export * from './tenant/tenant-manager.js';
export * from './benchmark/benchmark-engine.js';
export * from './sync/distributed-sync.js';
export * from './consensus/raft-engine.js';
export * from './hot-reload/hot-reload-engine.js';
export * from './llm-client.js';
export * from './sentinel.js';
export * from './types.js';
export * from './model-scheduler.js';
export * from './task-executor.js';
export * from './optimizer.js';
export * from './reflector.js';
export * from './decision-engine.js';
export * from './reflection-engine.js';
export * from './goal-engine.js';
export * from './meta-cognition.js';
export * from './strategy-evolution.js';
export * from './autonomy-loop.js';
export * from './world-model.js';
export * from './curiosity-engine.js';
export * from './safety-governor.js';
// ── 共生进化架构（第五阶段 Phase 1：智能体 + 能量预算 + 知识交易）──
export * from './symbiosis/ledger.js';
export * from './symbiosis/agent.js';
export * from './symbiosis/market.js';
export * from './symbiosis/runtime.js';
// ── Phase 2：市场即心智（信念市场 LMSR + futarchy 决策资助 + 元认知对账）──
export * from './symbiosis/belief.js';
// 消歧：deliberation 与 belief 均导出 SettlementReport（export * 静默
// 排除同名成员），显式导出主名 + 别名保留两者语义
export type { SettlementReport, SettlementReport as DeliberationSettlementReport } from './core/deliberation.js';
export type { SettlementReport as BeliefSettlementReport } from './symbiosis/belief.js';
export * from './symbiosis/wrappers.js';
// ── Phase 2.5：共生融合桥（KPI → 能量经济/信念市场 → 漂移洞察回流宿主自愈链路）──
export * from './symbiosis/bridge.js';
// ── C 路线：生态可观测性（能量 Sankey 数据模型 + 自包含 HTML 渲染）──
export * from './symbiosis/observability.js';
export { attachDashboard } from './dashboard/index.js';
