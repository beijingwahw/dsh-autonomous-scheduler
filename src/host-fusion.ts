/**
 * host-fusion.ts — 宿主融合层（质的飞跃）
 *
 * 将调度器从"被动插件"升维为"宿主级认知与安全层"：
 *
 * 1. 全宿主可观测（tools/result，emit 模式）
 *    - 订阅宿主 ToolRegistry 管线事件（cordis 跨 fiber 事件传播）
 *    - 每次宿主工具调用 → 世界模型 observeArrival（学习宿主行为节律，增强预见）
 *    - 工具失败 → 注入 'host-tool-failure' 信号至哨兵（触发决策链路自愈）
 *    - 同工具连续失败达阈值 → 提取教训 + 高紧急度信号（经验沉淀）
 *
 * 2. 全宿主安全治理（tools/pre-execute，waterfall 模式）
 *    - Kill Switch 启用 → 冻结全宿主工具调用（紧急停止从"冻结自身"升级为"冻结宿主"）
 *    - 熔断器开启（调度器自身失败螺旋）→ fail-closed 拒绝宿主动作
 *    - 只读门控（checkGate），不消耗限流/预算，不污染调度器自身治理语义
 *
 * 3. 设计原则
 *    - 观测 fail-open：自身异常绝不破坏宿主管线
 *    - 治理 fail-closed：仅在显式安全状态下拒绝，其余一律 next() 放行
 *    - 自排除：调度器自身桥接的 14 个 Tool 不参与观测/治理（避免反馈环路）
 *    - 零依赖：结构化类型（duck-typing），不 import @deepseek-ai/dsh-tools
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Sentinel } from './sentinel.js';
import type { WorldModel } from './world-model.js';
import type { SafetyGovernor } from './safety-governor.js';

// ─────────────────────────── 结构化类型（宿主管线载荷） ───────────────────────────

/** 宿主工具执行对象（ToolExecution 的结构化子集） */
interface HostToolExecution {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** 宿主工具执行结果（ToolExecutionResult 的结构化子集） */
interface HostToolResult {
  readonly isError: boolean;
  readonly error?: { message: string };
}

/** pre-execute waterfall 决策 */
type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string };

/**
 * 声明本插件所依赖的宿主 ToolRegistry 管线事件（结构化签名）。
 * 宿主加载 @deepseek-ai/dsh-tools 时，其官方声明与本声明合并为重载，二者兼容；
 * 宿主未加载时，本声明保证类型层面可订阅（运行时无事件到达，静默无操作）。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 宿主工具最终结果（emit 模式，监听者失败被隔离） */
    'tools/result'(exec: HostToolExecution, result: HostToolResult): undefined;
    /** 宿主工具派发前决策（waterfall 模式：allow / deny / ask） */
    'tools/pre-execute'(exec: HostToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
  }
}

// ─────────────────────────── 配置 ───────────────────────────

/** 宿主融合层配置 */
export interface HostFusionConfig {
  /** 是否启用宿主融合（缺省 true；宿主无 ctx.tools 时自动静默降级） */
  enabled: boolean;
  /** 是否观测宿主工具结果（世界模型 + 失败信号注入） */
  observeToolResults: boolean;
  /** 是否治理宿主工具调用（kill switch / 熔断器门控） */
  governToolCalls: boolean;
  /** 同工具连续失败达到该次数后注入高紧急度信号并提取教训 */
  failureEscalationThreshold: number;
}

/** 默认配置 */
export const DEFAULT_HOST_FUSION_CONFIG: HostFusionConfig = {
  enabled: true,
  observeToolResults: true,
  governToolCalls: true,
  failureEscalationThreshold: 3,
};

// ─────────────────────────── 依赖注入面 ───────────────────────────

/** 融合层依赖（由 index.ts apply 注入） */
export interface HostFusionDeps {
  ctx: Context;
  sentinel: Sentinel;
  worldModel: WorldModel;
  governor: SafetyGovernor;
  /** 进度广播（可为 null：enableProgress=false 时） */
  broadcast: (event: Record<string, unknown>) => void;
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  /** 调度器自身桥接进宿主注册表的 Tool 名集合（自排除，避免反馈环路） */
  selfToolNames: Set<string>;
  /** 教训提取回调（复用反思引擎的规则化路径） */
  onLessonExtracted?: (toolName: string, consecutiveFailures: number, lastError: string) => void;
}

// ─────────────────────────── 融合层主体 ───────────────────────────

/**
 * 宿主融合层
 *
 * 由 index.ts 在全部引擎构造完成后 activate()；fiber 卸载时 dispose()。
 * 宿主未提供 ctx.tools 服务时，activate() 静默返回 false（降级为纯内部模式）。
 */
export class HostFusionLayer {
  private config: HostFusionConfig;
  private deps: HostFusionDeps;
  private active = false;
  /** 每工具连续失败计数 */
  private consecutiveFailures = new Map<string, number>();
  /** 每工具最近一次失败信息 */
  private lastFailureError = new Map<string, string>();
  /** 统计 */
  private stats = { observed: 0, failures: 0, governed: 0, denied: 0 };

  constructor(config: Partial<HostFusionConfig> | undefined, deps: HostFusionDeps) {
    this.config = { ...DEFAULT_HOST_FUSION_CONFIG, ...config };
    this.deps = deps;
  }

  /**
   * 激活融合层：订阅宿主管线事件
   * @returns 是否成功激活（宿主无 ctx.tools 时返回 false）
   */
  activate(): boolean {
    if (!this.config.enabled) return false;
    const { ctx } = this.deps;

    // 宿主未加载 ToolRegistry → 静默降级（cordis Context 边界，结构化探测）
    const hostTools = (ctx as Context & { get?: (key: string) => unknown }).get?.('tools');
    if (!hostTools) return false;

    // ── 观测：tools/result（emit 模式，跨 fiber 传播） ──
    if (this.config.observeToolResults) {
      ctx.on('tools/result', (exec: HostToolExecution, result: HostToolResult) => {
        try {
          this.onToolResult(exec, result);
        } catch {
          /* 观测 fail-open：绝不破坏宿主管线 */
        }
      });
    }

    // ── 治理：tools/pre-execute（waterfall 模式） ──
    if (this.config.governToolCalls) {
      ctx.on('tools/pre-execute', async (exec: HostToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
        try {
          return this.onPreExecute(exec, next);
        } catch {
          /* 治理自身异常 → fail-open 放行，不阻断宿主 */
          return next();
        }
      });
    }

    this.active = true;
    this.deps.logger.info('宿主融合层已激活（观测: %s / 治理: %s）', this.config.observeToolResults, this.config.governToolCalls);
    return true;
  }

  /** 是否已激活 */
  isActive(): boolean {
    return this.active;
  }

  /** 融合层统计 */
  getStats(): { observed: number; failures: number; governed: number; denied: number; active: boolean } {
    return { ...this.stats, active: this.active };
  }

  /**
   * 观测宿主工具执行结果
   * - 成功：世界模型学习到达节律 + 重置该工具失败计数
   * - 失败：注入信号 + 连续失败升级
   */
  private onToolResult(exec: HostToolExecution, result: HostToolResult): void {
    // 自排除：调度器自身桥接的 Tool 不参与观测
    if (this.deps.selfToolNames.has(exec.name)) return;

    this.stats.observed += 1;

    // 世界模型：学习宿主工具调用节律（预见性增强）
    this.deps.worldModel.observeArrival(`host-tool:${exec.name}`);

    if (!result.isError) {
      // 成功 → 重置该工具连续失败计数
      this.consecutiveFailures.delete(exec.name);
      return;
    }

    // ── 失败路径 ──
    this.stats.failures += 1;
    const errorMsg = result.error?.message ?? 'unknown error';
    const count = (this.consecutiveFailures.get(exec.name) ?? 0) + 1;
    this.consecutiveFailures.set(exec.name, count);
    this.lastFailureError.set(exec.name, errorMsg);

    // 注入信号至哨兵（触发决策链路）
    const escalated = count >= this.config.failureEscalationThreshold;
    this.deps.sentinel.ingest({
      type: 'host-tool-failure',
      description: `宿主工具 ${exec.name} 执行失败${count > 1 ? `（连续第 ${count} 次）` : ''}: ${errorMsg.slice(0, 200)}`,
      source: `host-tool:${exec.name}`,
      urgency: escalated ? 0.9 : 0.5,
      dedupeKey: `host-tool-failure:${exec.name}`,
      payload: { toolName: exec.name, consecutiveFailures: count, error: errorMsg.slice(0, 500), escalated },
    });

    // 连续失败升级 → 提取教训 + 进度广播
    if (escalated && count === this.config.failureEscalationThreshold) {
      this.deps.logger.warn('宿主工具 %s 连续失败 %d 次，已升级（教训提取 + 高紧急度信号）', exec.name, count);
      this.deps.onLessonExtracted?.(exec.name, count, errorMsg);
    }

    this.deps.broadcast({
      type: 'host-tool-failure',
      toolName: exec.name,
      consecutiveFailures: count,
      escalated,
      error: errorMsg.slice(0, 200),
    });
  }

  /**
   * 治理宿主工具调用（pre-execute waterfall）
   * - Kill Switch → deny（紧急冻结全宿主）
   * - 熔断器开启 → deny（fail-closed）
   * - 其余 → next() 放行
   */
  private async onPreExecute(exec: HostToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    // 自排除：调度器自身 Tool 不受宿主治理门控（避免双重治理）
    if (this.deps.selfToolNames.has(exec.name)) return next();

    this.stats.governed += 1;

    // 只读门控：kill switch + 熔断器（不消耗限流/预算）
    const gate = this.deps.governor.checkGate();
    if (!gate.allowed) {
      this.stats.denied += 1;
      this.deps.broadcast({
        type: 'host-tool-denied',
        toolName: exec.name,
        blockedBy: gate.blockedBy,
        reason: gate.reason,
      });
      return { kind: 'deny', reason: `[scheduler-governor] ${gate.reason}` };
    }

    return next();
  }

  /** 卸载：清理状态（事件监听由 cordis fiber 自动回收） */
  dispose(): void {
    this.active = false;
    this.consecutiveFailures.clear();
    this.lastFailureError.clear();
  }
}
