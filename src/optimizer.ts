/**
 * optimizer.ts — 优化器组件（新架构「记忆库 → 优化器 → 模型调度」）
 *
 * 职责（对应架构图 Optimizer 框）：
 * - 经验检索：查询记忆库匹配相似任务模式，产出按节点类型的推荐模型组合
 * - 经验快路径：命中高置信度模式时直接召回历史最优成功计划，跳过 LLM 重新规划
 * - 策略/教训召回：为计划生成注入蒸馏策略与历史教训上下文（由编排层组合调用）
 *
 * 边界：只读记忆库 + 产出调度建议，不执行任务、不写记忆。
 * 写记忆统一由反思器（reflector.ts）负责，形成单向数据流：
 *   记忆库 → 优化器 → 模型调度/任务执行 → 反思器 → 记忆更新 → 记忆库
 */

import type { ExecutionPlan, PlanNode } from './types.js';
import type { IMemoryStore, IOptimizer } from './contracts.js';
import type { ProceduralAction, ProceduralMemory, SemanticMemory, TaskPatternMemory } from './memory/long-term-memory.js';
import { matchesMemoryConditions } from './memory/long-term-memory.js';
import type { MemoryGraph } from './memory/memory-graph.js';
import type { MemorySearchHit } from './memory/backend.js';
import type { ProgressBroadcaster } from './progress-ws.js';
import { resolveEffectiveParams, type Policy } from './policy/policy-types.js';
import type { DeliberationEngine, DeliberationResult } from './core/deliberation.js';
import type { ArbitrationResult, RationalMetareasoner } from './core/metareasoning.js';

/**
 * 记忆层级（第二阶段）
 *
 * 优化器推荐优先级：procedural > semantic > episodic > none
 * - procedural：程序记忆命中（最具体的 if-then 规则）
 * - semantic：语义记忆命中（跨任务抽象规律）
 * - episodic：情景记忆命中（既有任务模式匹配）
 * - none：无任何记忆命中（首次任务）
 */
export type MemoryLayer = 'procedural' | 'semantic' | 'episodic' | 'none';

/** 经验检索结果（优化器产物，供模型调度消费） */
export interface ExperienceLookup {
  pattern?: TaskPatternMemory;
  /** 按节点类型的推荐模型组合（模型调度优先采用） */
  recommendedModels: Record<string, string>;
  historicalSuccessRate: number;
  avgExecutionTime: number;
  // ── 第二阶段：三层记忆推荐来源 ──
  /** 命中的最高记忆层级（procedural > semantic > episodic > none） */
  memoryLayer: MemoryLayer;
  /** 决策依据说明（人类可读，供广播与可观测性） */
  rationale: string;
  /** 命中的程序记忆 id（memoryLayer='procedural' 时非空） */
  matchedProceduralId?: string;
  /** 命中的语义记忆 id（memoryLayer='semantic' 时非空） */
  matchedSemanticId?: string;
  /** 程序记忆触发的动作列表（供执行器/调度器消费：启用思维链、避免某模型等） */
  suggestedActions?: ProceduralAction[];
  // ── 第二阶段升级：负向约束与多规则命中 ──
  /** 程序记忆聚合的规避模型列表（avoid-model 动作目标；调度时从候选中剔除） */
  avoidModels: string[];
  /** 本次条件匹配命中的全部程序记忆 id（应用反馈闭环回写用） */
  matchedProceduralIds?: string[];
  // ── 第三阶段：策略进化 ──
  /** 本次推荐使用的调度策略版本（policyId@vN；策略热切换后随次检索更新） */
  policyVersion: string;
}

/** 优化器配置 */
export interface OptimizerConfig {
  /**
   * 经验快路径：命中模式置信度 ≥ 该阈值时，直接复用历史最优成功计划，
   * 跳过 strategist LLM 重新规划（越用越快、越稳、越省 token）。
   * 设为 >1 可关闭快路径。缺省 0.9。
   */
  memoryFastPathThreshold?: number;
}

/**
 * 优化器
 *
 * 被编排层（index.ts）持有：执行前调用 lookupExperience / recallPlan
 * 产出推荐模型与复用计划，喂给执行器（模型调度 + 任务执行）。
 *
 * 第三阶段升级（策略进化）：
 * - 策略版本标注：构造时注入 policyProvider（由编排层桥接到策略进化器或模型
 *   调度器），每次经验检索返回 policyVersion，推荐可追溯到具体策略版本
 * - 任务分解决策：shouldDecompose 按当前策略的分解规则判断是否拆分任务
 *   （沙盒中进化出的分解参数在操作环落地）
 * - 未注入 policyProvider 时标注 baseline 策略，行为与第二阶段一致（兼容）
 */
export class Optimizer implements IOptimizer {
  private memory: IMemoryStore;
  private config: OptimizerConfig;
  private broadcaster?: ProgressBroadcaster;
  private graph?: MemoryGraph;
  /** 当前调度策略提供器（第三阶段：策略版本标注与分解决策依据） */
  private policyProvider?: () => Policy;
  /** 7.0：深思内核（冷启动序列推荐 = 规划即推断） */
  private deliberation?: DeliberationEngine;
  /** 8.0：元推理内核（推荐的双过程仲裁 = 理性元推理） */
  private metareasoner?: RationalMetareasoner;

  constructor(params: {
    memory: IMemoryStore;
    config?: OptimizerConfig;
    broadcaster?: ProgressBroadcaster;
    graph?: MemoryGraph;
    policyProvider?: () => Policy;
  }) {
    this.memory = params.memory;
    this.config = params.config ?? {};
    this.broadcaster = params.broadcaster;
    this.graph = params.graph;
    this.policyProvider = params.policyProvider;
  }

  /** 7.0：挂载深思内核（幂等；挂载后获得冷启动深思推荐能力） */
  attachDeliberation(engine: DeliberationEngine): void {
    this.deliberation = engine;
  }

  /** 8.0：挂载元推理内核（幂等；挂载后推荐经双过程仲裁定价） */
  attachMetareasoner(reasoner: RationalMetareasoner): void {
    this.metareasoner = reasoner;
  }

  /** 运行时配置热更新（元认知自调优落地入口） */
  updateConfig(patch: Partial<OptimizerConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** 当前配置快照（第四阶段：元认知旋钮 read 端；只读） */
  getConfig(): Readonly<OptimizerConfig> {
    return { ...this.config };
  }

  /** 当前策略版本标识（policyId@vN；未注入提供器时为 baseline） */
  private currentPolicyVersion(): string {
    const policy = this.policyProvider?.();
    return policy ? `${policy.id}@v${policy.version}` : 'policy-baseline@v1';
  }

  /**
   * 经验检索 — 三层记忆优先级匹配并给出推荐模型组合
   *
   * 第二阶段三层记忆级联（procedural > semantic > episodic > none）：
   * 1. 程序记忆（findProceduralMemory）：按 kind='scheduling' + 条件合取匹配。
   *    命中时从 action 提取 prefer-model 写入 recommendedModels，并返回 suggestedActions
   *    供执行器消费（如 enable-cot / avoid-model / parallelism）。
   * 2. 语义记忆（findSemanticMemory）：跨任务规律匹配。命中时从 conclusion 提取
   *    model-preference 写入 recommendedModels。
   * 3. 情景记忆（findPattern）：既有模糊匹配，回退路径。
   * 4. 全无命中：memoryLayer='none'，返回空推荐（首次任务）。
   *
   * 三层均会查询（不只取首层），但 memoryLayer 标记命中的最高层级，
   * rationale 说明决策依据。程序/语义记忆未命中时仍会回退到情景记忆，
   * 保证既有"模型推荐组合"链路不被破坏。
   *
   * @param taskType 任务类型
   * @param complexity 复杂度 0~1
   * @param features 任务特征标签
   * @param context 程序/语义记忆条件匹配所需的额外上下文（长度 / token 成本）
   */
  lookupExperience(
    taskType: string,
    complexity: number,
    features: string[] = [],
    context: { length?: number; tokenCost?: number } = {},
  ): ExperienceLookup {
    // ── 三层记忆匹配上下文（features / complexity / length / tokenCost） ──
    const matchContext = {
      features,
      complexity,
      length: context.length,
      tokenCost: context.tokenCost,
    };

    // ── 第 1 层：程序记忆（最高优先级，if-then 可执行规则） ──
    // 第二阶段升级：从"单条最优"扩展为"多条条件匹配"——同一任务可能同时命中
    // prefer-model / enable-cot / avoid-model 多条规则，全部聚合消费，
    // 而非只取置信度最高的一条（该条若是 avoid-model 会丢失其余正向偏好）。
    // 条件求值复用记忆库导出的 matchesMemoryConditions，保证两端语义一致。
    const proceduralMatches = this.memory
      .getProceduralMemories(taskType, 'scheduling')
      .filter((p) => matchesMemoryConditions(p.conditions, taskType, matchContext));
    const procedural = proceduralMatches[0];
    // ── 第 2 层：语义记忆（跨任务规律） ──
    const semantic = this.memory.findSemanticMemory(taskType, matchContext);
    // ── 第 3 层：情景记忆（既有模糊匹配） ──
    const pattern = this.memory.findPattern(taskType, complexity, features);

    // bestModelCombination 以 nodeId 为键，但 nodeId 跨计划不复用 →
    // 借助存储计划把 nodeId 映射回节点类型，产出"按节点类型"的推荐组合，
    // 供模型调度在 assignModel 时作为 preferred 真正消费（越用越聪明）。
    const recommendedModels: Record<string, string> = {};

    // 程序记忆动作聚合：prefer-model → 推荐；avoid-model → 负向约束；其余 → suggestedActions
    const suggestedActions: ProceduralAction[] = [];
    const avoidModels: string[] = [];
    for (const proc of proceduralMatches) {
      suggestedActions.push(proc.action);
      if (proc.action.type === 'prefer-model') {
        const model = proc.action.params['model'];
        if (typeof model === 'string' && !recommendedModels[taskType]) {
          // 程序记忆的模型偏好按 taskType 键写入（节点类型无关的全局偏好，首条优先）
          recommendedModels[taskType] = model;
        }
      } else if (proc.action.type === 'avoid-model') {
        const model = proc.action.params['model'];
        if (typeof model === 'string' && !avoidModels.includes(model)) avoidModels.push(model);
      }
    }

    // 语义记忆 model-preference 结论 → 推荐模型组合（程序记忆未指定时采用）
    if (semantic && Object.keys(recommendedModels).length === 0 && semantic.conclusion.type === 'model-preference') {
      const model = semantic.conclusion.value;
      if (typeof model === 'string') {
        recommendedModels[taskType] = model;
      }
    }

    // 情景记忆 bestModelCombination → 按节点类型的推荐组合（仍是最丰富的来源）
    // 第二阶段升级：仅补充程序/语义记忆未覆盖的节点类型（高级记忆优先，不被回退层覆盖）
    if (pattern?.bestModelCombination) {
      const nodeTypeById = new Map<string, string>();
      const bestPlan = pattern.successfulPlans[pattern.successfulPlans.length - 1];
      for (const node of bestPlan?.plan.nodes ?? []) nodeTypeById.set(node.id, node.type);
      for (const [nodeId, modelId] of Object.entries(pattern.bestModelCombination)) {
        const nodeType = nodeTypeById.get(nodeId);
        if (nodeType && !recommendedModels[nodeType]) recommendedModels[nodeType] = modelId;
      }
      // 兜底：无法映射回类型时，保留原 nodeId 键（strategist 提示词仍可读）
      if (Object.keys(recommendedModels).length === 0) Object.assign(recommendedModels, pattern.bestModelCombination);
    }

    let historicalSuccessRate = 0;
    let avgExecutionTime = 0;
    if (pattern) {
      const successes = pattern.successfulPlans.length;
      const failures = pattern.failureRecords.length;
      historicalSuccessRate = successes + failures > 0 ? successes / (successes + failures) : 0;
      avgExecutionTime = pattern.avgExecutionTime;
    }

    // ── 确定命中的最高记忆层级与决策依据 ──
    const memoryLayer: MemoryLayer = procedural ? 'procedural' : semantic ? 'semantic' : pattern ? 'episodic' : 'none';
    const rationale = this.buildRationale(memoryLayer, proceduralMatches, avoidModels, semantic, pattern);

    return {
      pattern,
      recommendedModels,
      historicalSuccessRate,
      avgExecutionTime,
      memoryLayer,
      rationale,
      matchedProceduralId: procedural?.id,
      matchedSemanticId: semantic?.id,
      suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
      avoidModels,
      matchedProceduralIds: proceduralMatches.length > 0 ? proceduralMatches.map((p) => p.id) : undefined,
      policyVersion: this.currentPolicyVersion(),
    };
  }

  /**
   * 任务分解决策（第三阶段：策略进化中「任务分解规则」的操作环落地）
   *
   * 按当前策略判定：分解启用且复杂度 ≥ 阈值时建议将任务拆分为子任务。
   * 编排层在兜底单节点计划时消费该建议（decomposePlan）。
   * 质级升级：传入 taskType/features 时按规则基因组解析上下文有效参数
   * （规则可对特定任务类型/复杂度段强制开/关分解）。
   * @param complexity 任务复杂度 0~1
   * @param taskType 任务类型（供规则基因匹配）
   * @param features 特征标签（供规则基因匹配）
   */
  shouldDecompose(complexity: number, taskType?: string, features?: string[]): boolean {
    const policy = this.policyProvider?.();
    if (!policy) return false;
    const params =
      taskType !== undefined
        ? resolveEffectiveParams(policy.params, { taskType, complexity, features })
        : policy.params;
    if (!params.decomposeEnabled) return false;
    return complexity >= params.decomposeComplexityThreshold;
  }

  /**
   * 构建决策依据说明（人类可读，供广播与可观测性）
   *
   * 第二阶段升级：程序记忆层说明全部命中规则数与正负向动作概览，
   * 让"使用了哪一层记忆、为什么"完全可追溯。
   */
  private buildRationale(
    layer: MemoryLayer,
    proceduralMatches: ProceduralMemory[],
    avoidModels: string[],
    semantic: SemanticMemory | undefined,
    pattern: TaskPatternMemory | undefined,
  ): string {
    switch (layer) {
      case 'procedural': {
        const parts = proceduralMatches.map((p) => `${p.name}（${p.action.type}，置信度 ${p.confidence.toFixed(2)}）`);
        const avoidNote = avoidModels.length > 0 ? `；规避模型：${avoidModels.join('/')}` : '';
        return `程序记忆命中 ${proceduralMatches.length} 条规则：${parts.join('；')}${avoidNote}`;
      }
      case 'semantic':
        return `语义记忆命中：${semantic!.statement}（置信度 ${semantic!.confidence.toFixed(2)}）`;
      case 'episodic':
        return `情景记忆命中：${pattern!.taskSummary}（置信度 ${pattern!.confidence.toFixed(2)}）`;
      case 'none':
      default:
        return '无记忆命中（首次任务，走常规规划）';
    }
  }

  /**
   * 经验快路径：命中高置信度模式时，直接复用历史最优成功计划，
   * 跳过 strategist LLM 重新规划——越用越快、越稳、越省 token。
   *
   * 复用条件（全部满足才返回计划，否则返回 undefined 走常规规划）：
   * 1. 模式置信度 ≥ memoryFastPathThreshold（缺省 0.9）
   * 2. 存在至少一条成功计划记录
   *
   * 选取策略：取平均质量最高的成功记录；其节点模型分配经 recommendedModels
   * （按节点类型）在执行时优先采用，保持"记忆驱动选型"的一致性。
   *
   * @param lookup 经验检索结果
   * @param objective 当前任务目标（写入计划）
   * @returns 复用的计划（source='memory'），不满足条件时 undefined
   */
  recallPlan(lookup: ExperienceLookup, objective: string): ExecutionPlan | undefined {
    const threshold = this.config.memoryFastPathThreshold ?? 0.9;
    const pattern = lookup.pattern;
    if (!pattern || pattern.confidence < threshold) return undefined;
    if (pattern.successfulPlans.length === 0) return undefined;

    // 取平均质量最高的历史成功计划
    let best = pattern.successfulPlans[0];
    let bestQuality = -1;
    for (const record of pattern.successfulPlans) {
      const qualities = Object.values(record.qualityScores);
      const avg = qualities.length > 0 ? qualities.reduce((s, v) => s + v, 0) / qualities.length : 0;
      if (avg > bestQuality) {
        bestQuality = avg;
        best = record;
      }
    }

    const nodes: PlanNode[] = best.plan.nodes.map((n) => ({
      id: n.id,
      description: n.description,
      type: n.type,
      dependsOn: [...n.dependsOn],
    }));

    this.broadcast({
      type: 'plan-recalled',
      fingerprint: pattern.fingerprint,
      confidence: pattern.confidence,
      nodeCount: nodes.length,
      historicalQuality: Number(bestQuality.toFixed(3)),
    });

    return {
      objective,
      nodes,
      parallelismStrategy: best.plan.parallelismStrategy || 'layered',
      source: 'memory',
    };
  }

  /**
   * 7.0：深思推荐 —— 规划即推断的冷启动序列建议。
   *
   * 与经验检索的本质区别：lookupExperience 回答「历史上类似任务
   * 用过什么」（没有历史就没有答案）；本方法回答「按我脑内的世界
   * 演练，怎样的一串选择全程自由能最低」——**零情景记忆也能给出
   * 计划级建议**（转移模型无证据时诚实返回无知区间，搜索以认知
   * 价值驱动试探序）。
   *
   * 消费方：编排层在 memoryLayer='none'（冷启动）时以序列建议辅助
   * 逐节点选型；有记忆命中时经验优先（深思只补充，不越权）。
   *
   * @param taskType 任务类型（构造状态键 `${taskType}#s${i}`）
   * @param candidateActions 每阶段的候选行动（如模型 id 列表）
   * @param stages 计划阶段数（搜索深度）
   */
  deliberativeRecommendation(
    taskType: string,
    candidateActions: string[],
    stages: number,
    opts?: { breadth?: number; preference?: number },
  ): DeliberationResult | undefined {
    if (!this.deliberation || candidateActions.length === 0 || stages < 1) return undefined;
    return this.deliberation.search(
      `${taskType}#s0`,
      candidateActions,
      {
        depth: stages,
        breadth: opts?.breadth,
        preference: opts?.preference,
        // 确定性阶段状态机：第 i 步 → `${taskType}#s{i+1}`（不依赖学习后继）
        advance: ({ step }) => `${taskType}#s${step + 1}`,
      },
    );
  }

  /**
   * 8.0：元认知推荐 —— 理性元推理的冷启动序列建议。
   *
   * 与 7.0 深思推荐的区别：deliberativeRecommendation **每次都全深度
   * 搜索**（想不想要深思是配置，不是决策）；本方法把「想多深」本身
   * 变成决策——双过程仲裁：
   *   habit       深思已摊销为习惯（查表直答，成本 ≈ 0）
   *   reactive    证据充分且优劣悬殊（VOC ≈ 0，直接反应一步）
   *   deliberative 任意时搜索（首行动稳定即停，思考按 nat 计价）
   *
   * 结算闭环：上游执行后调 metareasoner.settleDecision(decisionId, 成败)
   * → 反应失手收紧门槛、深思成功晋升习惯（元学习）。
   */
  metacognitiveRecommendation(
    taskType: string,
    candidateActions: string[],
    stages: number,
    opts?: { preference?: number },
  ): ArbitrationResult | undefined {
    if (!this.metareasoner || candidateActions.length === 0 || stages < 1) return undefined;
    // 状态推进交给学到的转移模型（行动依赖的后继：诱饵通向死路、
    // 缓行通向富态——这正是深思要看见的结构）；无证据时 MAP 后继
    // 停留原态，认知价值驱动试探序。
    return this.metareasoner.decide(`${taskType}#s0`, candidateActions, {
      preference: opts?.preference,
    });
  }

  /**
   * 混合检索（自主学习建议 1：sqlite-vec + FTS5 + jieba 分词管道）
   *
   * 四路召回合并去重（按 refId 取最高分）：
   * 1. 模糊匹配（findPattern：taskType/complexity/features 相似度）
   * 2. FTS5 全文（trigram 子串级 + jieba 式 token 级，中文友好）
   * 3. 向量（sqlite-vec 可用时宿主扩展；缺省稀疏词频向量余弦）
   * 4. 图联想（记忆网络相邻节点，权重折半计入）
   */
  hybridSearch(query: string, taskType: string, complexity: number, limit = 5): MemorySearchHit[] {
    const merged = new Map<string, MemorySearchHit>();
    const consider = (hit: MemorySearchHit, factor = 1): void => {
      const score = hit.score * factor;
      const prev = merged.get(hit.refId);
      if (!prev || prev.score < score) merged.set(hit.refId, { ...hit, score });
    };

    const fuzzy = this.memory.findPattern(taskType, complexity);
    if (fuzzy) consider({ kind: 'pattern', refId: fuzzy.fingerprint, score: 1 });
    for (const hit of this.memory.fullTextSearch?.(query, limit) ?? []) consider(hit);
    for (const hit of this.memory.vectorSearch?.(query, limit) ?? []) consider(hit, 0.9);
    if (this.graph) {
      for (const hit of [...merged.values()]) {
        for (const related of this.graph.related(hit.refId, 3)) {
          consider({ kind: 'pattern', refId: related, score: hit.score }, 0.5);
        }
      }
    }

    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** 进度事件广播（broadcaster 缺省时为空操作） */
  private broadcast(event: Record<string, any>): void {
    if (!this.broadcaster) return;
    this.broadcaster.broadcast({ type: event.type as string, timestamp: Date.now(), ...event });
  }
}
