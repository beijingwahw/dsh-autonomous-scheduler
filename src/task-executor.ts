/**
 * task-executor.ts — 任务执行组件（新架构「模型调度 → 任务执行」）
 *
 * 职责（对应架构图「任务执行（原有）」框）：
 * - 计划生成：strategist 输出 DAG 解析 + 离线兜底计划
 * - 并行执行：拓扑分层并行执行子任务，全局超时中止，动态并行度分批
 * - 质量反思：quality < threshold 自动重试或经模型调度切换模型（最多 maxRetries 次）
 * - 级联触发：节点完成且质量达标时触发下游信号
 *
 * 闭环边界（新架构单向数据流）：
 * - 模型分配委托模型调度器（model-scheduler.ts），优化器推荐模型经 recommendedModels 喂入
 * - 经验检索 / 快路径召回由优化器（optimizer.ts）负责
 * - 执行后反思 / 记忆更新由反思器（reflector.ts）负责，本组件不写记忆
 *
 * 升级点（相对串行执行的质的提升）：
 * 1. 拓扑分层并行：同层节点并发执行，依赖未就绪的节点自动顺延
 * 2. 质量反思闭环：重试优先原模型，重试耗尽前尝试切换到次优模型
 * 3. nodeRunner 可注入：默认走 LLMClient，冒烟测试可完全离线模拟
 * 4. 全链路进度事件广播（plan-start / node-start / node-complete /
 *    node-error / node-reflect / cascade-trigger / plan-complete）
 */

import crypto from 'node:crypto';
import { TimeoutError } from './errors.js';
import type { LLMClient } from './llm-client.js';
import { parseJSONLoose } from './llm-client.js';
import type { ModelScheduler } from './model-scheduler.js';
import type { ProgressBroadcaster } from './progress-ws.js';
import type { ReflectionEngine } from './reflection-engine.js';
import type { Signal } from './sentinel.js';
import { ExecutionError, type CascadeHandler, type ExecutionPlan, type NodeResult, type NodeRunner, type PlanExecutionResult, type PlanNode } from './types.js';
import { CircuitBreakerRegistry, abortableSleep, backoffDelayMs, classifyError } from './core/resilience.js';

/** 任务执行器配置 */
export interface TaskExecutorConfig {
  qualityThreshold: number;
  maxRetries: number;
  /** 计划级全局超时（毫秒） */
  globalTimeout: number;
  /** 单节点默认超时（毫秒） */
  nodeTimeout: number;
  /** 是否广播进度事件 */
  enableProgress: boolean;
  verbose: boolean;
  /**
   * 4.0：模型级熔断阈值（同一模型连续可用性失败次数，达到即熔断该模型）
   * 缺省 5；设为 0 关闭熔断（与升级前行为一致）
   */
  circuitFailureThreshold?: number;
  /** 4.0：熔断冷却期（毫秒，缺省 60s），期满转半开放行单次试探 */
  circuitCooldownMs?: number;
  /**
   * 4.0：重试退避基数（毫秒，缺省 0 = 不退避，与升级前紧贴重发一致）。
   * 全抖动指数退避：min(base×2^(attempt-1), retryBackoffMaxMs) 内均匀采样
   */
  retryBackoffBaseMs?: number;
  /** 4.0：重试退避上限（毫秒，缺省 8000） */
  retryBackoffMaxMs?: number;
}

/**
 * 任务执行器
 *
 * 被 index.ts 持有：编排层完成战略决策与计划生成后，将计划交给本执行器执行。
 */
export class TaskExecutor {
  private config: TaskExecutorConfig;
  private llm: LLMClient;
  private modelScheduler: ModelScheduler;
  private broadcaster?: ProgressBroadcaster;
  private nodeRunner: NodeRunner;
  private cascadeHandler?: CascadeHandler;
  /** 反思引擎（可选，节点级质量反思） */
  private reflection?: ReflectionEngine;
  /** 4.0：模型级熔断器注册表（circuitFailureThreshold=0 时不启用） */
  private breakers?: CircuitBreakerRegistry;
  /** 2.0：最近一次计划执行的调度决策洞察（校准闭环素材，getAndClearDecisionInsights 取走） */
  private decisionInsights: Array<{
    nodeId: string;
    taskType: string;
    modelId: string;
    predictedConfidence: number;
    exploration: boolean;
    success: boolean;
  }> = [];

  constructor(params: {
    config: TaskExecutorConfig;
    llm: LLMClient;
    modelScheduler: ModelScheduler;
    broadcaster?: ProgressBroadcaster;
    nodeRunner?: NodeRunner;
    cascadeHandler?: CascadeHandler;
    reflection?: ReflectionEngine;
  }) {
    this.config = params.config;
    this.llm = params.llm;
    this.modelScheduler = params.modelScheduler;
    this.broadcaster = params.broadcaster;
    this.nodeRunner = params.nodeRunner ?? this.defaultNodeRunner.bind(this);
    this.cascadeHandler = params.cascadeHandler;
    this.reflection = params.reflection;
    // 4.0：模型级熔断（阈值 0 = 显式关闭，与升级前行为逐位一致）
    const threshold = this.config.circuitFailureThreshold ?? 5;
    if (threshold > 0) {
      this.breakers = new CircuitBreakerRegistry({
        failureThreshold: threshold,
        cooldownMs: this.config.circuitCooldownMs ?? 60_000,
      });
    }
  }

  /**
   * 运行时配置热更新（元认知自调优落地入口）
   * @param patch 配置补丁（仅覆盖提供的字段）
   */
  updateConfig(patch: Partial<TaskExecutorConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /**
   * 取走最近一次计划执行的调度决策洞察（2.0：校准闭环桥接）
   *
   * 编排层在 executePlan 返回后调用本方法，将洞察作为
   * reflectOnOutcome({ decisionInsights }) 回注反思器，
   * 完成「调度预测 → 实际结果 → Brier 校准」闭环。
   * 取走即清空（每份洞察只消费一次）。
   */
  getAndClearDecisionInsights(): Array<{
    nodeId: string;
    taskType: string;
    modelId: string;
    predictedConfidence: number;
    exploration: boolean;
    success: boolean;
  }> {
    const insights = this.decisionInsights;
    this.decisionInsights = [];
    return insights;
  }

  /**
   * 计划生成 — 解析 strategist 输出，非法时回退离线计划
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
   * 执行完整计划
   *
   * 深度优化：
   * - 截止时间感知：signal.deadlineMs 存在时，全局超时收紧为 min(globalTimeout, deadline - now)
   * - 动态并行度：同层节点数超过模型总并发容量时分批执行，避免并发过载排队
   * - 4.0：avoidModels 负向约束贯通——优化器产出的规避模型在调度与重试切换中全局排除
   *
   * @param signal 触发信号
   * @param plan 执行计划
   * @param recommendedModels 优化器产出的按节点类型推荐模型（模型调度优先采纳）
   * @param options 4.0 扩展选项（avoidModels：经验规避模型，调度与重试全程排除）
   * @returns 计划执行结果
   */
  async executePlan(
    signal: Signal,
    plan: ExecutionPlan,
    recommendedModels?: Record<string, string>,
    options?: { avoidModels?: string[] },
  ): Promise<PlanExecutionResult> {
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
      const parallelism = this.modelScheduler.computeParallelism();
      for (const layer of layers) {
        if (controller.signal.aborted) break;
        // 动态并行度：分层内分批执行，每批不超过 parallelism
        for (let i = 0; i < layer.length; i += parallelism) {
          if (controller.signal.aborted) break;
          const chunk = layer.slice(i, i + parallelism);
          const layerResults = await Promise.all(
            chunk.map((node) => this.executeNode(planId, node, signal, outputs, controller.signal, recommendedModels, options?.avoidModels ?? [])),
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

    this.broadcast({ type: 'plan-complete', planId, totalTime, successCount, totalNodes: plan.nodes.length, success, avgQuality });

    return { planId, success, nodeResults, totalTime, successCount, totalTokens, avgQuality, error: success ? undefined : nodeResults.find((r) => !r.success)?.error };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 模型级熔断快照（运维可观测：哪些模型被熔断、连续失败数） */
  getBreakerSnapshot(): Record<string, { state: string; consecutiveFailures: number }> {
    return this.breakers?.snapshot() ?? {};
  }

  /** 模型当前是否可执行（无熔断器或熔断器放行；peek 纯读取不占探测名额） */
  private modelExecutable(modelId: string): boolean {
    if (!this.breakers) return true;
    return this.breakers.peek(modelId).allowed;
  }

  /** 选择健康的次优模型：排除当前模型、规避模型与熔断中的模型 */
  private pickHealthyFallback(taskType: string, currentModelId: string, avoidModels: string[]): string | undefined {
    const excluded = new Set<string>([currentModelId, ...avoidModels]);
    const fallback = this.modelScheduler.pickFallbackModel(taskType, currentModelId, undefined, [...excluded]);
    if (fallback && this.modelExecutable(fallback)) return fallback;
    // 次优也被熔断：逐个放宽直到找到健康模型
    if (fallback && !this.modelExecutable(fallback)) {
      const ranked = this.modelScheduler.pickEnsemble(taskType, 8, [...excluded]);
      return ranked.find((id) => this.modelExecutable(id));
    }
    return fallback;
  }

  /** 单节点执行（4.0：熔断感知调度 + 错误分型退避重试 + 质量反思切换、级联触发） */
  private async executeNode(
    planId: string,
    node: PlanNode,
    signal: Signal,
    outputs: Map<string, string>,
    abortSignal: AbortSignal,
    recommendedModels?: Record<string, string>,
    avoidModels: string[] = [],
  ): Promise<NodeResult> {
    const context: Record<string, string> = {};
    for (const dep of node.dependsOn) {
      const depOutput = outputs.get(dep);
      if (depOutput) context[dep] = depOutput;
    }

    // 经验驱动选型：优化器推荐模型（按节点类型）优先，其次计划指定，最后模型调度动态评分
    // 2.0：经带洞察入口分配（预测置信度 + 探索标记，复盘时回注反思器做校准闭环）
    // 4.0：推荐/指定模型被规避（avoidModels）或熔断中 → 交由调度器动态评分选型
    const avoidSet = new Set(avoidModels);
    let preferred = recommendedModels?.[node.type];
    if (preferred && (avoidSet.has(preferred) || !this.modelExecutable(preferred))) preferred = undefined;
    let plannedModel = node.modelId;
    if (plannedModel && (avoidSet.has(plannedModel) || !this.modelExecutable(plannedModel))) plannedModel = undefined;
    const assignment = plannedModel
      ? this.modelScheduler.modelInsight(node.type, plannedModel)
      : this.modelScheduler.assignModelWithInsight(node.type, preferred, undefined, { avoidModels });
    let modelId = assignment.modelId;
    this.decisionInsights.push({
      nodeId: node.id,
      taskType: node.type,
      modelId,
      predictedConfidence: assignment.confidence,
      exploration: assignment.exploration,
      success: false,
    });
    const insightIndex = this.decisionInsights.length - 1;
    const maxAttempts = this.config.maxRetries + 1;
    let lastError: string | undefined;
    const nodeStartedAt = Date.now();

    this.broadcast({ type: 'node-start', planId, nodeId: node.id, modelId, taskType: node.type });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (abortSignal.aborted) {
        lastError = '全局超时，节点中止';
        break;
      }

      // 4.0：熔断感知——当前模型在重试间隙被熔断（如同层节点打爆）时切到健康次优
      if (!this.modelExecutable(modelId)) {
        const healthy = this.pickHealthyFallback(node.type, modelId, avoidModels);
        if (!healthy) {
          lastError = `模型 ${modelId} 熔断中且无可用替代`;
          this.broadcast({ type: 'node-error', planId, nodeId: node.id, error: lastError, attempt });
          break;
        }
        this.broadcast({ type: 'node-reflect', planId, nodeId: node.id, verdict: 'switch-model', reason: `${modelId} 熔断 → ${healthy}` });
        modelId = healthy;
        const refreshed = this.modelScheduler.modelInsight(node.type, healthy);
        this.decisionInsights[insightIndex] = {
          nodeId: node.id,
          taskType: node.type,
          modelId: healthy,
          predictedConfidence: refreshed.confidence,
          exploration: false,
          success: false,
        };
      }

      // 4.0：获取执行资格——half-open 态占用探测名额（须与下方 record 成对释放）
      if (this.breakers) {
        const probe = this.breakers.canExecute(modelId);
        if (!probe.allowed) continue; // 并发探测互斥：本轮让位，下轮重评
      }

      try {
        const { output, quality, tokensUsed } = await this.runWithTimeout(node, modelId, context, signal, attempt);

        // 质量反思（深度优化：反思引擎动态阈值 + LLM-as-judge + 重试建议）
        const threshold = this.reflection?.getCurrentThreshold() ?? this.config.qualityThreshold;
        let verdict = { quality, passed: quality >= threshold, retryAdvice: 'retry-same' as 'retry-same' | 'retry-switch' | 'no-retry', reason: '' };
        if (this.reflection) {
          const reflected = await this.reflection.reflect({ node, output, baseQuality: quality, signal });
          verdict = { quality: reflected.quality, passed: reflected.passed, retryAdvice: reflected.retryAdvice, reason: reflected.reason };
        }

        if (verdict.passed) {
          this.breakers?.recordSuccess(modelId); // 4.0：质量达标即可用性恢复
          this.broadcast({ type: 'node-complete', planId, nodeId: node.id, latency: Date.now() - nodeStartedAt, quality: verdict.quality, attempt });
          this.broadcast({ type: 'node-reflect', planId, nodeId: node.id, verdict: 'pass', reason: verdict.reason || `质量 ${verdict.quality.toFixed(2)} ≥ 阈值 ${threshold.toFixed(2)}` });
          this.decisionInsights[insightIndex]!.success = true; // 2.0：校准回填（预测 vs 实际）

          // 级联触发（仅质量达标时）
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

        // 4.0：质量不达标 ≠ 不可用（模型响应正常）——不计入熔断，走换模型路径
        this.breakers?.releaseProbe(modelId);
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
            const fallback = this.pickHealthyFallback(node.type, modelId, avoidModels);
            if (fallback) {
              this.broadcast({ type: 'node-reflect', planId, nodeId: node.id, verdict: 'switch-model', reason: `${modelId} → ${fallback}` });
              modelId = fallback;
              // 2.0：切换后刷新该节点的决策洞察（最终实际使用的模型才是校准对象）
              const refreshed = this.modelScheduler.modelInsight(node.type, fallback);
              this.decisionInsights[insightIndex] = {
                nodeId: node.id,
                taskType: node.type,
                modelId: fallback,
                predictedConfidence: refreshed.confidence,
                exploration: false,
                success: false,
              };
            }
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.broadcast({ type: 'node-error', planId, nodeId: node.id, error: lastError, attempt });

        // 4.0：错误分型——差异化重试策略（取代「仅超时重试、其余放弃」的粗路径）
        const classification = classifyError(err);
        if (classification.kind === 'timeout' || classification.kind === 'network' || classification.kind === 'rate-limit' || classification.kind === 'server') {
          this.breakers?.recordFailure(modelId); // 可用性失败计入熔断
        } else {
          // 客户端错误：下游已应答（可用性无恙）；未知错误：不判定可用性
          this.breakers?.releaseProbe(modelId);
        }

        if (attempt >= maxAttempts) break;
        if (classification.class === 'retryable-backoff') {
          const delay = backoffDelayMs(attempt, {
            baseMs: this.config.retryBackoffBaseMs ?? 0,
            maxMs: this.config.retryBackoffMaxMs ?? 8_000,
          });
          if (delay > 0) {
            const slept = await abortableSleep(delay, abortSignal);
            if (!slept) {
              lastError = '全局超时，退避等待中中止';
              break;
            }
          }
          continue; // 网络抖动/限流/超时：退避后原模型重试（下游可能恢复）
        }
        if (classification.class === 'retryable-immediate') continue;
        break; // fatal：保守终止（与升级前非超时错误行为一致）
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

  /** 级联触发：节点完成且质量达标时回注下游信号 */
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

  /** 进度事件广播（enableProgress 关闭时为空操作） */
  private broadcast(event: Record<string, any>): void {
    if (!this.config.enableProgress || !this.broadcaster) return;
    this.broadcaster.broadcast({ type: event.type as string, timestamp: Date.now(), ...event });
  }
}
