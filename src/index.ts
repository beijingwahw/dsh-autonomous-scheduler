/**
 * index.ts — dsh-autonomous-scheduler 核心插件入口（集成层）
 *
 * 职责：整合全部 9 个模块，编排"信号 → 决策 → 执行 → 沉淀"10 步链路
 *
 * 10 步链路：
 * 1. 信号接入（Sentinel：webhook / 文件监听 / 轮询 / 手动注入）
 * 2. 信号聚合（Sentinel 聚合窗口去重合并）
 * 3. 优先级排序（strategist 模型紧急度评估，urgency 降序）
 * 4. 战略决策（execute / defer / dismiss / ask-user）
 * 5. 经验检索（Executor.lookupExperience → 长期记忆模糊匹配）
 * 6. 计划生成（Executor.buildPlan：strategist DAG 输出 + 离线兜底）
 * 7. 并行执行（Executor.executePlan：拓扑分层并行）
 * 8. 质量反思（quality < threshold 自动重试 / 切换模型）
 * 9. 级联触发（节点完成触发下游信号，回注 Sentinel）
 * 10. 经验沉淀（成功方案 / 失败记录写入长期记忆 + 分布式同步变更登记）
 *
 * 13 个 Tool 通过 ToolRegistry 服务注册并经 ctx.provide('schedulerTools') 暴露。
 * 自主智能层（目标引擎 / 元认知 / 策略进化 / 心跳循环）使系统在无外部信号时
 * 也能自我观察、自我改进、自我进化。
 * 全部资源在 fiber 卸载时按依赖逆序清理（cleanup）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';

import { AppError, ConfigError } from './errors.js';
import { CryptoEngine, type EncryptionConfig } from './security/crypto-engine.js';
import { LongTermMemory } from './memory/long-term-memory.js';
import { MigrationTool } from './memory/migration-tool.js';
import { ProgressBroadcaster } from './progress-ws.js';
import { TenantManager } from './tenant/tenant-manager.js';
import { BenchmarkEngine } from './benchmark/benchmark-engine.js';
import { DistributedSync, type SyncNodeConfig } from './sync/distributed-sync.js';
import { RaftEngine, type ConsensusLogEntry } from './consensus/raft-engine.js';
import { HotReloadEngine, type HotReloadConfig } from './hot-reload/hot-reload-engine.js';
import { LLMClient, type ModelConfig } from './llm-client.js';
import { Sentinel, type Signal, type SignalBatch } from './sentinel.js';
import { Executor, type PlanExecutionResult } from './executor.js';
import { attachDashboard } from './dashboard/index.js';
import { DecisionEngine, type Decision, type SignalHistoryStats } from './decision-engine.js';
import { ReflectionEngine } from './reflection-engine.js';
import { GoalEngine, type Goal, type GoalSubtask } from './goal-engine.js';
import { MetaCognitionEngine, type TuningAction } from './meta-cognition.js';
import { StrategyEvolutionEngine } from './strategy-evolution.js';
import { AutonomyLoop } from './autonomy-loop.js';
import { WorldModel } from './world-model.js';
import { CuriosityEngine, type ExplorationProposal } from './curiosity-engine.js';
import { SafetyGovernor } from './safety-governor.js';
import { resolveHostLLM, resolveHostModels, resolveHeaderProvider, resolveLocalKeyProvider } from './dsh-host.js';

// ─────────────────────────── 插件配置类型 ───────────────────────────

/** 插件配置（对应 cordis.yml config 节） */
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
  /** LLM 客户端选项覆盖（测试注入 fetchImpl 等） */
  llm?: { fetchImpl?: typeof fetch; timeout?: number };
  /** 执行器节点执行器注入（测试离线模拟） */
  nodeRunner?: import('./executor.js').NodeRunner;
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
    /** 心跳循环配置覆盖 */
    loop?: Partial<import('./autonomy-loop.js').AutonomyLoopConfig>;
    /** 世界模型配置覆盖 */
    worldModel?: Partial<import('./world-model.js').WorldModelConfig>;
    /** 好奇心引擎配置覆盖 */
    curiosity?: Partial<import('./curiosity-engine.js').CuriosityEngineConfig>;
    /** 安全治理器配置覆盖 */
    governor?: Partial<import('./safety-governor.js').SafetyGovernorConfig>;
    /** 目标分解器注入（测试离线模拟） */
    decomposer?: import('./goal-engine.js').GoalDecomposer;
  };
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

/** 插件对外暴露的调度器服务面 */
export interface SchedulerService {
  tools: ToolRegistry;
  sentinel: Sentinel;
  executor: Executor;
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
  /** 目标引擎（自主智能） */
  goalEngine: GoalEngine;
  /** 元认知引擎（自主智能） */
  metaCognition: MetaCognitionEngine;
  /** 策略进化引擎（自主智能） */
  strategyEvolution: StrategyEvolutionEngine;
  /** 自主心跳循环（自主智能） */
  autonomyLoop: AutonomyLoop;
  /** 世界模型（自主智能·预见） */
  worldModel: WorldModel;
  /** 好奇心引擎（自主智能·内在动机） */
  curiosity: CuriosityEngine;
  /** 安全治理器（自主智能·边界） */
  governor: SafetyGovernor;
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

/** 插件名称 */
export const name = 'dsh-autonomous-scheduler';

// ─────────────────────────── 插件主体 ───────────────────────────

/**
 * 插件入口：初始化全部模块、编排 10 步链路、注册 12 Tool、登记 cleanup
 */
export function apply(ctx: Context, config: Partial<SchedulerConfig>): void {
  const cfg = { ...DEFAULT_CONFIG, ...config } as SchedulerConfig;

  // ── DSH 宿主 LLM 能力解析（宿主优先、配置兜底）──
  // 宿主经 ctx 提供已配置好的 LLM 客户端 / 模型目录 / 请求头注入器，
  // 插件本身无需持有任何 API Key（DSH 自动注入用户配置的 Key）。
  const hostChat = resolveHostLLM(ctx);
  const hostModels = resolveHostModels(ctx);
  // 请求头注入优先级：DSH 宿主 ctx 注入 > 宿主本地密钥自动填入（环境变量/本地配置）
  const ctxHeaderProvider = resolveHeaderProvider(ctx);
  const localKeyProvider = resolveLocalKeyProvider();
  const headerProvider = (modelId: string) => ctxHeaderProvider?.(modelId) ?? localKeyProvider(modelId);
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
    externalChat: hostChat,
  });
  for (const model of mergedModels) llm.registerModel(model);
  // strategist 模型确保已注册（决策调用专用）
  if (cfg.strategistModel && !llm.getModel(cfg.strategistModel.id)) {
    llm.registerModel({ id: cfg.strategistModel.id, endpoint: cfg.strategistModel.endpoint, apiKey: cfg.strategistModel.apiKey });
  }
  const strategistId = cfg.strategistModel?.id ?? mergedModels[0]?.id ?? llm.getModelIds()[0];
  if (hostChat) logger.info('LLM 调用已委托给 DSH 宿主客户端（Key 由宿主注入）');
  else logger.info('模型 Key 自动经请求头注入（优先级：宿主 ctx → 本地环境变量 → 本地配置文件）');

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

  // ── 集成层：执行器 ──
  const executor = new Executor({
    config: {
      qualityThreshold: cfg.qualityThreshold,
      maxRetries: cfg.maxRetries,
      globalTimeout: cfg.globalTimeout,
      nodeTimeout: Math.min(120_000, cfg.globalTimeout),
      enableProgress: cfg.enableProgress,
      verbose: cfg.verbose,
      costWeight: 0.2,
    },
    llm,
    memory,
    broadcaster: broadcaster ?? undefined,
    nodeRunner: cfg.nodeRunner,
    reflection: reflectionEngine,
    cascadeHandler: (newSignal) => {
      // 第 9 步级联触发 → 回注哨兵形成闭环
      sentinel.ingest({ ...newSignal, source: 'cascade' });
    },
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
        executor.updateConfig({ qualityThreshold: action.to });
      } else if (action.parameter === 'maxRetries') {
        executor.updateConfig({ maxRetries: action.to });
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
        decision: { action: 'execute', urgency: signal.urgency ?? 0.5 },
        proposedBy: cfg.sync?.localNodeId ?? 'node-dev-01',
      });
      if (!proposal.committed) {
        recordDecision(signal, 'execute', 'failed', '共识提案未提交');
        return null;
      }
    }

    // 第 5 步：经验检索（深度优化：叠加蒸馏策略与历史教训）
    const taskType = signal.type;
    const lookup = executor.lookupExperience(taskType, 0.5);
    const strategies = memory.getStrategies(taskType, 3);
    const lessons = reflectionEngine.getLessons(taskType, 3);
    broadcast({
      type: 'strategist-thinking',
      step: 5,
      message: `经验检索: ${lookup.pattern ? `命中模式(置信度 ${lookup.pattern.confidence.toFixed(2)})` : '无匹配模式'}，蒸馏策略 ${strategies.length} 条，历史教训 ${lessons.length} 条`,
    });

    // 第 6 步：计划生成（strategist 输出 DAG，注入蒸馏策略与教训上下文）
    let strategistOutput: string | undefined;
    try {
      const experienceContext = [
        lookup.pattern ? `历史经验(推荐模型): ${JSON.stringify(lookup.recommendedModels)}` : '',
        strategies.length > 0 ? `蒸馏策略: ${strategies.map((s) => s.description).join('；')}` : '',
        lessons.length > 0 ? `历史教训(务必规避): ${lessons.map((l) => `${l.lesson}→${l.suggestion}`).join('；')}` : '',
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
      strategistOutput = response.content;
    } catch (err) {
      logger.warn('strategist 计划生成失败，使用兜底计划: %s', (err as Error).message);
    }
    const plan = executor.buildPlan(signal.description, strategistOutput, taskType);

    // 第 7~10 步：并行执行 + 质量反思 + 级联触发 + 经验沉淀
    if (hotReload) hotReload.registerTask(signal.id, taskType);
    try {
      const result = await executor.executePlan(signal, plan);
      ctx.emit('scheduler/plan-complete', result, signal);
      recordDecision(signal, 'execute', result.success ? (result.avgQuality >= 0.85 ? 'excellent' : 'good') : 'failed', result.success ? `平均质量 ${result.avgQuality.toFixed(2)}` : result.error ?? '执行失败');

      // ── 沉淀环节深度优化 ──
      if (!result.success) {
        // 失败 → 教训提取（异步，不阻塞主流程）
        void reflectionEngine.extractLesson({ signal, taskType, result, plan }).then((lesson) => {
          if (lesson) {
            broadcast({ type: 'lesson-extracted', lessonId: lesson.id, rootCause: lesson.rootCause, lesson: lesson.lesson });
            logger.info('教训沉淀 [%s]: %s', lesson.rootCause, lesson.lesson);
          }
        });
      } else {
        // 成功 → 经验蒸馏（达到沉淀阈值时提炼策略）
        const fresh = memory.distillExperience();
        if (fresh.length > 0) {
          broadcast({ type: 'experience-distilled', strategies: fresh.map((s) => ({ id: s.id, description: s.description, confidence: s.confidence })) });
          logger.info('经验蒸馏产出 %d 条策略', fresh.length);
        }
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
      query_type: { type: 'string', description: '查询类型', required: true, enum: ['overview', 'patterns', 'model-profile', 'feedback', 'strategies', 'lessons', 'trends', 'decision-stats', 'goals', 'health', 'evolution', 'autonomy-status', 'world-model', 'curiosity', 'governance', 'introspect'] },
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
    description: '按任务类型检索历史经验（相似模式、成功率、推荐模型）',
    parameters: { task_type: { type: 'string', description: '任务类型（可选，缺省返回 Top 模式）' } },
    handler: (args) => {
      if (args.task_type) {
        const lookup = executor.lookupExperience(String(args.task_type), 0.5);
        return { taskType: args.task_type, ...lookup };
      }
      return { patterns: memory.getTopPatterns(10) };
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

  // ── 服务暴露 ──
  const service: SchedulerService = {
    tools,
    sentinel,
    executor,
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
    goalEngine,
    metaCognition,
    strategyEvolution,
    autonomyLoop,
    worldModel,
    curiosity,
    governor,
    submitTask: (task, urgency = 0.8) => sentinel.ingest({ type: 'manual-task', description: task, payload: { task }, source: 'manual', urgency }),
  };
  ctx.provide('scheduler', service);
  ctx.provide('schedulerTools', tools);

  // ─────────────────────────── cleanup（fiber 卸载时逆序清理） ───────────────────────────
  ctx.effect(() => {
    return () => {
      logger.info('调度器卸载中，清理资源…');
      autonomyLoop.stop();
      hotReload?.stop();
      raft?.stop();
      sync.stop();
      sentinel.stop();
      tenantManager.dispose();
      broadcaster?.stop();
      llm.dispose();
      memory.dispose();
      logger.info('调度器资源已清理');
    };
  }, 'scheduler-cleanup');
}

/** 插件导出（cordis 函数插件形态 + 元数据；Function.name 只读，须用 defineProperty） */
const pluginEntry = apply as typeof apply & { name: string };
Object.defineProperty(pluginEntry, 'name', { value: name });
export default pluginEntry;

// ─────────────────────────── 子模块再导出（集成层统一入口） ───────────────────────────
export * from './errors.js';
export * from './security/crypto-engine.js';
export * from './memory/long-term-memory.js';
export * from './memory/migration-tool.js';
export * from './progress-ws.js';
export * from './tenant/tenant-manager.js';
export * from './benchmark/benchmark-engine.js';
export * from './sync/distributed-sync.js';
export * from './consensus/raft-engine.js';
export * from './hot-reload/hot-reload-engine.js';
export * from './llm-client.js';
export * from './sentinel.js';
export * from './executor.js';
export * from './decision-engine.js';
export * from './reflection-engine.js';
export * from './goal-engine.js';
export * from './meta-cognition.js';
export * from './strategy-evolution.js';
export * from './autonomy-loop.js';
export * from './world-model.js';
export * from './curiosity-engine.js';
export * from './safety-governor.js';
export { attachDashboard } from './dashboard/index.js';
