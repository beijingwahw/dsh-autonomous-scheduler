/**
 * executor.ts — 计划执行器（集成层，执行链路第 5~10 步）
 *
 * 职责：
 * - 第 5 步 经验检索：查询长期记忆匹配相似任务模式，提取推荐模型组合
 * - 第 6 步 计划生成：strategist 输出 DAG 解析 + 离线兜底计划 + 模型分配
 * - 第 7 步 并行执行：拓扑分层并行执行子任务，全局超时中止
 * - 第 8 步 质量反思：quality < threshold 自动重试或切换模型（最多 maxRetries 次）
 * - 第 9 步 级联触发：节点完成且质量达标时触发下游信号
 * - 第 10 步 经验沉淀：成功方案 / 失败记录写入长期记忆并登记同步变更
 *
 * 升级点（相对串行执行的质的提升）：
 * 1. 拓扑分层并行：同层节点并发执行，依赖未就绪的节点自动顺延
 * 2. 模型分配双通道：初始能力画像 taskScores × 长期记忆画像成功率加权，
 *    历史数据越多越信任记忆（记忆权重随调用量增长）
 * 3. 质量反思闭环：重试优先原模型，重试耗尽前尝试切换到次优模型
 * 4. nodeRunner 可注入：默认走 LLMClient，冒烟测试可完全离线模拟
 * 5. 全链路进度事件广播（plan-start / node-start / node-complete /
 *    node-error / node-reflect / cascade-trigger / plan-complete）
 */

import crypto from 'node:crypto';
import { AppError, TimeoutError } from './errors.js';
import type { LLMClient } from './llm-client.js';
import type { LongTermMemory, TaskPatternMemory } from './memory/long-term-memory.js';
import type { ProgressBroadcaster } from './progress-ws.js';
import type { Signal } from './sentinel.js';
import { parseJSONLoose } from './llm-client.js';
import type { ReflectionEngine } from './reflection-engine.js';

/** DAG 计划节点 */
export interface PlanNode {
  id: string;
  description: string;
  /** 任务类型（code-generation / documentation / analysis 等） */
  type: string;
  dependsOn: string[];
  /** 指定模型（缺省由分配策略决定） */
  modelId?: string;
  /** 节点级超时覆盖（毫秒） */
  timeout?: number;
  /** 完成后级联触发的信号描述 */
  cascade?: Array<{ type: string; description: string }>;
}

/** 执行计划（第 6 步产物） */
export interface ExecutionPlan {
  objective: string;
  nodes: PlanNode[];
  parallelismStrategy: string;
  /** 计划来源：strategist 模型 / 离线兜底 / 记忆复用 */
  source: 'strategist' | 'fallback' | 'memory';
}

/** 单节点执行结果 */
export interface NodeResult {
  nodeId: string;
  modelId: string;
  success: boolean;
  output?: string;
  /** 质量分 0~1（nodeRunner 自评或启发式） */
  quality: number;
  latency: number;
  attempts: number;
  error?: string;
  tokensUsed: number;
}

/** 计划执行结果 */
export interface PlanExecutionResult {
  planId: string;
  success: boolean;
  nodeResults: NodeResult[];
  totalTime: number;
  successCount: number;
  totalTokens: number;
  /** 平均质量分（仅成功节点） */
  avgQuality: number;
  error?: string;
}

/** 节点执行器签名（可注入，测试可离线模拟） */
export type NodeRunner = (params: {
  node: PlanNode;
  modelId: string;
  context: Record<string, string>;
  signal: Signal;
  attempt: number;
}) => Promise<{ output: string; quality: number; tokensUsed?: number }>;

/** 级联触发回调（由 index.ts 桥接到 sentinel.ingest） */
export type CascadeHandler = (newSignal: { type: string; description: string; payload: Record<string, any> }) => void;

/** 执行器配置 */
export interface ExecutorConfig {
  qualityThreshold: number;
  maxRetries: number;
  /** 计划级全局超时（毫秒） */
  globalTimeout: number;
  /** 单节点默认超时（毫秒） */
  nodeTimeout: number;
  /** 是否广播进度事件 */
  enableProgress: boolean;
  verbose: boolean;
  /** 成本感知权重 0~1：模型选择时对单位成本的惩罚系数（0=纯质量导向） */
  costWeight?: number;
}

/** 经验检索结果（第 5 步产物） */
export interface ExperienceLookup {
  pattern?: TaskPatternMemory;
  recommendedModels: Record<string, string>;
  historicalSuccessRate: number;
  avgExecutionTime: number;
}

/** 计划执行失败 */
export class ExecutionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'EXECUTION_ERROR', details);
  }
}

/**
 * 计划执行器
 *
 * 被 index.ts 持有：编排层完成战略决策后，将 execute 决策的信号交给本执行器。
 */
export class Executor {
  private config: ExecutorConfig;
  private llm: LLMClient;
  private memory: LongTermMemory;
  private broadcaster?: ProgressBroadcaster;
  private nodeRunner: NodeRunner;
  private cascadeHandler?: CascadeHandler;
  /** 同步变更登记回调（由 index.ts 桥接到 distributed-sync.recordChange） */
  private onMemoryChange?: (type: string, fingerprint: string, payload: any) => void;
  /** 反思引擎（可选，深度优化反思环节） */
  private reflection?: ReflectionEngine;

  constructor(params: {
    config: ExecutorConfig;
    llm: LLMClient;
    memory: LongTermMemory;
    broadcaster?: ProgressBroadcaster;
    nodeRunner?: NodeRunner;
    cascadeHandler?: CascadeHandler;
    onMemoryChange?: (type: string, fingerprint: string, payload: any) => void;
    reflection?: ReflectionEngine;
  }) {
    this.config = params.config;
    this.llm = params.llm;
    this.memory = params.memory;
    this.broadcaster = params.broadcaster;
    this.nodeRunner = params.nodeRunner ?? this.defaultNodeRunner.bind(this);
    this.cascadeHandler = params.cascadeHandler;
    this.onMemoryChange = params.onMemoryChange;
    this.reflection = params.reflection;
  }

  /**
   * 运行时配置热更新（元认知自调优落地入口）
   * @param patch 配置补丁（仅覆盖提供的字段）
   */
  updateConfig(patch: Partial<ExecutorConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /**
   * 第 5 步：经验检索 — 匹配相似任务模式并给出推荐模型组合
   * @param taskType 任务类型
   * @param complexity 复杂度 0~1
   * @param features 任务特征标签
   */
  lookupExperience(taskType: string, complexity: number, features: string[] = []): ExperienceLookup {
    const pattern = this.memory.findPattern(taskType, complexity, features);
    const recommendedModels: Record<string, string> = { ...(pattern?.bestModelCombination ?? {}) };

    let historicalSuccessRate = 0;
    let avgExecutionTime = 0;
    if (pattern) {
      const successes = pattern.successfulPlans.length;
      const failures = pattern.failureRecords.length;
      historicalSuccessRate = successes + failures > 0 ? successes / (successes + failures) : 0;
      avgExecutionTime = pattern.avgExecutionTime;
    }
    return { pattern, recommendedModels, historicalSuccessRate, avgExecutionTime };
  }

  /**
   * 第 6 步：计划生成 — 解析 strategist 输出，非法时回退离线计划
   * @param objective 任务目标
   * @param strategistOutput strategist 模型原始输出（可为空）
   * @param taskType 任务类型
   */
  buildPlan(objective: string, strategistOutput: string | undefined, taskType: string): ExecutionPlan {
    if (strategistOutput) {
      const parsed = parseJSONLoose<any>(strategistOutput);
      const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : null;
      if (nodes && nodes.length > 0 && this.validateDag(nodes)) {
        return {
          objective,
          nodes: nodes.map((n: any) => this.normalizeNode(n)),
          parallelismStrategy: typeof parsed.parallelismStrategy === 'string' ? parsed.parallelismStrategy : 'layered',
          source: 'strategist',
        };
      }
    }
    // 离线兜底：单节点计划
    return {
      objective,
      nodes: [{ id: 'node-1', description: objective, type: taskType, dependsOn: [] }],
      parallelismStrategy: 'sequential',
      source: 'fallback',
    };
  }

  /**
   * 第 7~10 步：执行完整计划
   *
   * 深度优化：
   * - 截止时间感知：signal.deadlineMs 存在时，全局超时收紧为 min(globalTimeout, deadline - now)
   * - 动态并行度：同层节点数超过模型总并发容量时分批执行，避免并发过载排队
   * - 反思引擎记录：每次执行结果写入质量趋势，驱动阈值自校准
   *
   * @param signal 触发信号
   * @param plan 执行计划
   * @returns 计划执行结果
   */
  async executePlan(signal: Signal, plan: ExecutionPlan): Promise<PlanExecutionResult> {
    const planId = `plan-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const startedAt = Date.now();
    const nodeResults: NodeResult[] = [];
    const outputs = new Map<string, string>();

    // 截止时间感知：收紧全局超时
    let effectiveTimeout = this.config.globalTimeout;
    if (signal.deadlineMs && signal.deadlineMs > Date.now()) {
      effectiveTimeout = Math.min(effectiveTimeout, signal.deadlineMs - Date.now());
    }

    this.broadcast({ type: 'plan-start', plan: { objective: plan.objective, nodeCount: plan.nodes.length, source: plan.source }, signal: { id: signal.id, type: signal.type }, effectiveTimeout });

    // 全局超时控制
    const controller = new AbortController();
    const globalTimer = setTimeout(() => controller.abort(), effectiveTimeout);
    globalTimer.unref?.();

    try {
      const layers = this.topologicalLayers(plan.nodes);
      const parallelism = this.computeParallelism();
      for (const layer of layers) {
        if (controller.signal.aborted) break;
        // 动态并行度：分层内分批执行，每批不超过 parallelism
        for (let i = 0; i < layer.length; i += parallelism) {
          if (controller.signal.aborted) break;
          const chunk = layer.slice(i, i + parallelism);
          const layerResults = await Promise.all(
            chunk.map((node) => this.executeNode(planId, node, signal, outputs, controller.signal)),
          );
          for (const result of layerResults) {
            nodeResults.push(result);
            if (result.success && result.output) outputs.set(result.nodeId, result.output);
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new TimeoutError(`计划执行超过全局超时（${effectiveTimeout}ms）`, { planId });
      }
      throw err;
    } finally {
      clearTimeout(globalTimer);
    }

    const successCount = nodeResults.filter((r) => r.success).length;
    const success = successCount === plan.nodes.length && plan.nodes.length > 0;
    const totalTime = Date.now() - startedAt;
    const totalTokens = nodeResults.reduce((sum, r) => sum + r.tokensUsed, 0);
    const successResults = nodeResults.filter((r) => r.success);
    const avgQuality = successResults.length > 0 ? successResults.reduce((s, r) => s + r.quality, 0) / successResults.length : 0;

    // 反思引擎记录（质量趋势 + 阈值自校准）
    this.reflection?.recordExecution(plan.nodes[0]?.type ?? signal.type, avgQuality, success);

    // 第 10 步：经验沉淀
    this.settleExperience(signal, plan, nodeResults, { success, totalTime, totalTokens, avgQuality });

    this.broadcast({ type: 'plan-complete', planId, totalTime, successCount, totalNodes: plan.nodes.length, success, avgQuality });

    return { planId, success, nodeResults, totalTime, successCount, totalTokens, avgQuality, error: success ? undefined : nodeResults.find((r) => !r.success)?.error };
  }

  /**
   * 动态并行度：依据已注册模型的总并发容量计算同层最大并行数
   * （避免同层节点数超过模型并发容量导致全部排队）
   */
  private computeParallelism(): number {
    const totalConcurrency = this.llm
      .getModelStatuses()
      .reduce((sum, s) => sum + s.maxConcurrency, 0);
    // 至少 1，上限 16（防止异常配置导致过度并行）
    return Math.max(1, Math.min(16, totalConcurrency || 4));
  }

  /**
   * 为节点分配最优模型（能力画像 × 长期记忆加权 × 成本感知）
   *
   * 评分公式：score = qualityScore × (1 - costWeight) + costEfficiency × costWeight
   * - qualityScore：能力画像与长期记忆成功率的加权
   * - costEfficiency：单位成本的质量产出（历史 avgQuality / avgTokens），归一化到 0~1
   * - costWeight=0 时退化为纯质量导向（向后兼容）
   *
   * @param taskType 任务类型
   * @param preferred 经验检索推荐的模型（优先）
   */
  assignModel(taskType: string, preferred?: string): string {
    if (preferred && this.llm.getModel(preferred)) return preferred;

    const statuses = this.llm.getModelStatuses();
    if (statuses.length === 0) throw new ExecutionError('没有已注册的可用模型');

    const costWeight = Math.max(0, Math.min(1, this.config.costWeight ?? 0));

    let bestId = statuses[0].id;
    let bestScore = -1;
    for (const status of statuses) {
      const taskScore = status.taskScores[taskType] ?? status.taskScores['general'] ?? 0.5;
      // 长期记忆权重随该任务类型的历史调用量增长（0.2 ~ 0.6）
      const profile = this.memory.getModelProfile(status.id);
      const history = profile?.taskHistory[taskType];
      const memoryWeight = history ? Math.min(0.6, 0.2 + history.totalCalls * 0.02) : 0;
      const memoryScore = history && history.totalCalls > 0 ? history.successCount / history.totalCalls : 0.5;
      const qualityScore = taskScore * (1 - memoryWeight) + memoryScore * memoryWeight;

      // 成本效率：单位 token 的质量产出（无历史数据时中性 0.5）
      let costEfficiency = 0.5;
      if (history && history.totalCalls > 0 && status.totalTokensUsed > 0) {
        const avgQuality = history.avgQualityScore || 0.5;
        const avgTokens = status.totalTokensUsed / status.totalCalls;
        // 归一化：质量/token 比值相对全体模型的排名近似（简化为 quality × (1 - 归一化成本)）
        costEfficiency = Math.max(0, Math.min(1, avgQuality * (1 - Math.min(1, avgTokens / 10_000))));
      }

      const score = qualityScore * (1 - costWeight) + costEfficiency * costWeight;
      if (score > bestScore) {
        bestScore = score;
        bestId = status.id;
      }
    }
    return bestId;
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 单节点执行（含第 8 步质量反思重试与模型切换、第 9 步级联触发） */
  private async executeNode(
    planId: string,
    node: PlanNode,
    signal: Signal,
    outputs: Map<string, string>,
    abortSignal: AbortSignal,
  ): Promise<NodeResult> {
    const context: Record<string, string> = {};
    for (const dep of node.dependsOn) {
      const depOutput = outputs.get(dep);
      if (depOutput) context[dep] = depOutput;
    }

    let modelId = node.modelId ?? this.assignModel(node.type);
    const maxAttempts = this.config.maxRetries + 1;
    let lastError: string | undefined;
    const nodeStartedAt = Date.now();

    this.broadcast({ type: 'node-start', planId, nodeId: node.id, modelId, taskType: node.type });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (abortSignal.aborted) {
        lastError = '全局超时，节点中止';
        break;
      }
      try {
        const { output, quality, tokensUsed } = await this.runWithTimeout(node, modelId, context, signal, attempt);

        // 第 8 步：质量反思（深度优化：反思引擎动态阈值 + LLM-as-judge + 重试建议）
        const threshold = this.reflection?.getCurrentThreshold() ?? this.config.qualityThreshold;
        let verdict = { quality, passed: quality >= threshold, retryAdvice: 'retry-same' as 'retry-same' | 'retry-switch' | 'no-retry', reason: '' };
        if (this.reflection) {
          const reflected = await this.reflection.reflect({ node, output, baseQuality: quality, signal });
          verdict = { quality: reflected.quality, passed: reflected.passed, retryAdvice: reflected.retryAdvice, reason: reflected.reason };
        }

        if (verdict.passed) {
          this.broadcast({ type: 'node-complete', planId, nodeId: node.id, latency: Date.now() - nodeStartedAt, quality: verdict.quality, attempt });
          this.broadcast({ type: 'node-reflect', planId, nodeId: node.id, verdict: 'pass', reason: verdict.reason || `质量 ${verdict.quality.toFixed(2)} ≥ 阈值 ${threshold.toFixed(2)}` });

          // 第 9 步：级联触发（仅质量达标时）
          this.triggerCascade(node, signal, output);

          return {
            nodeId: node.id,
            modelId,
            success: true,
            output,
            quality: verdict.quality,
            latency: Date.now() - nodeStartedAt,
            attempts: attempt,
            tokensUsed: tokensUsed ?? 0,
          };
        }

        this.broadcast({
          type: 'node-reflect',
          planId,
          nodeId: node.id,
          verdict: 'retry',
          reason: verdict.reason || `质量 ${verdict.quality.toFixed(2)} < 阈值 ${threshold.toFixed(2)}（第 ${attempt}/${maxAttempts} 次）`,
        });
        lastError = `质量不达标: ${verdict.quality.toFixed(2)}`;

        // 重试策略：反思引擎建议 retry-switch 或最后一次机会时切换模型
        if (attempt < maxAttempts) {
          const shouldSwitch = verdict.retryAdvice === 'retry-switch' || attempt === maxAttempts - 1;
          if (shouldSwitch) {
            const fallback = this.pickFallbackModel(node.type, modelId);
            if (fallback) {
              this.broadcast({ type: 'node-reflect', planId, nodeId: node.id, verdict: 'switch-model', reason: `${modelId} → ${fallback}` });
              modelId = fallback;
            }
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.broadcast({ type: 'node-error', planId, nodeId: node.id, error: lastError, attempt });
        if (err instanceof TimeoutError && attempt < maxAttempts) continue;
        if (attempt >= maxAttempts) break;
      }
    }

    return {
      nodeId: node.id,
      modelId,
      success: false,
      quality: 0,
      latency: Date.now() - nodeStartedAt,
      attempts: maxAttempts,
      error: lastError ?? '未知错误',
      tokensUsed: 0,
    };
  }

  /** 带节点级超时的 nodeRunner 调用 */
  private async runWithTimeout(
    node: PlanNode,
    modelId: string,
    context: Record<string, string>,
    signal: Signal,
    attempt: number,
  ): Promise<{ output: string; quality: number; tokensUsed?: number }> {
    const timeout = node.timeout ?? this.config.nodeTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`节点 ${node.id} 执行超时（${timeout}ms）`, { nodeId: node.id })), timeout);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.nodeRunner({ node, modelId, context, signal, attempt }), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 默认节点执行器：通过 LLMClient 调用分配模型 */
  private async defaultNodeRunner(params: {
    node: PlanNode;
    modelId: string;
    context: Record<string, string>;
    signal: Signal;
    attempt: number;
  }): Promise<{ output: string; quality: number; tokensUsed?: number }> {
    const { node, modelId, context, signal } = params;
    const contextText = Object.entries(context)
      .map(([dep, output]) => `【上游 ${dep} 产出】\n${output}`)
      .join('\n\n');

    const response = await this.llm.chat(modelId, [
      { role: 'system', content: '你是任务执行器。直接输出任务结果，不要输出多余解释。' },
      {
        role: 'user',
        content: [
          `任务目标: ${signal.description}`,
          `当前子任务: ${node.description}`,
          `任务类型: ${node.type}`,
          contextText ? `上游依赖产出:\n${contextText}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ]);

    return {
      output: response.content,
      // 启发式质量自评：非空输出基线 0.75，长度充足加分（真实场景可由评审模型打分）
      quality: response.content.trim().length > 0 ? Math.min(1, 0.75 + Math.min(0.2, response.content.length / 10_000)) : 0,
      tokensUsed: response.tokensUsed,
    };
  }

  /** 级联触发（第 9 步） */
  private triggerCascade(node: PlanNode, signal: Signal, output: string): void {
    if (!node.cascade || node.cascade.length === 0 || !this.cascadeHandler) return;
    for (const cascade of node.cascade) {
      const newSignal = {
        type: cascade.type,
        description: cascade.description,
        payload: { triggeredBy: signal.id, nodeId: node.id, upstreamOutputPreview: output.slice(0, 500) },
      };
      this.broadcast({ type: 'cascade-trigger', nodeId: node.id, newSignal: { type: cascade.type, description: cascade.description } });
      try {
        this.cascadeHandler(newSignal);
      } catch {
        // 级联失败不影响当前计划
      }
    }
  }

  /** 经验沉淀（第 10 步） */
  private settleExperience(
    signal: Signal,
    plan: ExecutionPlan,
    nodeResults: NodeResult[],
    summary: { success: boolean; totalTime: number; totalTokens: number; avgQuality: number },
  ): void {
    const taskType = plan.nodes[0]?.type ?? signal.type;
    const complexity = Math.min(1, plan.nodes.length / 5);
    const features = [...new Set(plan.nodes.map((n) => n.type))];
    const taskSummary = signal.description;

    if (summary.success) {
      const modelAssignments: Record<string, string> = {};
      const qualityScores: Record<string, number> = {};
      for (const result of nodeResults) {
        modelAssignments[result.nodeId] = result.modelId;
        qualityScores[result.nodeId] = result.quality;
      }
      this.memory.recordSuccess({
        taskType,
        complexity,
        features,
        taskSummary,
        plan: { objective: plan.objective, nodes: plan.nodes.map((n) => ({ id: n.id, description: n.description, type: n.type, dependsOn: n.dependsOn })), parallelismStrategy: plan.parallelismStrategy },
        modelAssignments,
        totalLatency: summary.totalTime,
        qualityScores,
        tokenCost: summary.totalTokens,
      });
      this.onMemoryChange?.('pattern-updated', fingerprintOf(taskType, complexity), { taskType, complexity, outcome: 'success' });
    } else {
      const failed = nodeResults.find((r) => !r.success);
      this.memory.recordFailure({
        taskType,
        complexity,
        features,
        reason: failed?.error ?? '计划执行失败',
        failedNodeId: failed?.nodeId ?? 'unknown',
        failedModelId: failed?.modelId ?? 'unknown',
        errorMessage: failed?.error ?? 'unknown',
      });
      this.onMemoryChange?.('pattern-updated', fingerprintOf(taskType, complexity), { taskType, complexity, outcome: 'failure' });
    }
  }

  /** 拓扑分层（Kahn 算法），检测环 */
  private topologicalLayers(nodes: PlanNode[]): PlanNode[][] {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const inDegree = new Map<string, number>();
    for (const node of nodes) {
      inDegree.set(node.id, 0);
    }
    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        if (!nodeMap.has(dep)) throw new ExecutionError(`节点 ${node.id} 依赖不存在的节点 ${dep}`);
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      }
    }

    const layers: PlanNode[][] = [];
    let frontier = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
    const visited = new Set<string>();

    while (frontier.length > 0) {
      layers.push(frontier);
      const next: PlanNode[] = [];
      for (const node of frontier) {
        visited.add(node.id);
        for (const other of nodes) {
          if (visited.has(other.id) || frontier.includes(other)) continue;
          if (other.dependsOn.includes(node.id)) {
            const deg = (inDegree.get(other.id) ?? 0) - 1;
            inDegree.set(other.id, deg);
            if (deg === 0) next.push(other);
          }
        }
      }
      frontier = next;
    }

    if (visited.size !== nodes.length) throw new ExecutionError('执行计划存在循环依赖');
    return layers;
  }

  /** DAG 结构校验（节点 id 唯一、依赖存在、无环） */
  private validateDag(rawNodes: any[]): boolean {
    const ids = new Set<string>();
    for (const n of rawNodes) {
      if (typeof n?.id !== 'string' || ids.has(n.id)) return false;
      ids.add(n.id);
    }
    for (const n of rawNodes) {
      const deps = Array.isArray(n.dependsOn) ? n.dependsOn : [];
      for (const dep of deps) {
        if (!ids.has(dep)) return false;
      }
    }
    try {
      this.topologicalLayers(rawNodes.map((n) => this.normalizeNode(n)));
      return true;
    } catch {
      return false;
    }
  }

  /** 归一化 strategist 输出的节点 */
  private normalizeNode(raw: any): PlanNode {
    return {
      id: String(raw.id),
      description: typeof raw.description === 'string' ? raw.description : String(raw.id),
      type: typeof raw.type === 'string' ? raw.type : 'general',
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
      modelId: typeof raw.modelId === 'string' ? raw.modelId : undefined,
      timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
      cascade: Array.isArray(raw.cascade) ? raw.cascade.filter((c: any) => c && typeof c.type === 'string') : undefined,
    };
  }

  /** 选择次优模型（排除当前模型） */
  private pickFallbackModel(taskType: string, excludeModelId: string): string | undefined {
    const statuses = this.llm.getModelStatuses().filter((s) => s.id !== excludeModelId);
    if (statuses.length === 0) return undefined;
    let bestId: string | undefined;
    let bestScore = -1;
    for (const status of statuses) {
      const score = status.taskScores[taskType] ?? status.taskScores['general'] ?? 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestId = status.id;
      }
    }
    return bestId;
  }

  /** 进度事件广播（enableProgress 关闭时为空操作） */
  private broadcast(event: Record<string, any>): void {
    if (!this.config.enableProgress || !this.broadcaster) return;
    this.broadcaster.broadcast({ type: event.type as string, timestamp: Date.now(), ...event });
  }
}

/** 任务指纹（taskType + complexity 分档） */
function fingerprintOf(taskType: string, complexity: number): string {
  return crypto.createHash('sha256').update(`${taskType}:${Math.round(complexity * 10)}`).digest('hex').slice(0, 16);
}
