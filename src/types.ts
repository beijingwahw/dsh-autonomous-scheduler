/**
 * types.ts — 共享类型层（新架构各组件的公共契约）
 *
 * 新架构单向数据流：
 *   记忆库(Memory) → 优化器(Optimizer) → 模型调度(ModelScheduler)/任务执行(TaskExecutor) → 反思器(Reflector) → 记忆更新(Memory)
 *
 * 本文件承载数据流各组件共享的领域类型，避免组件间相互依赖：
 * - 计划结构：PlanNode / ExecutionPlan（优化器产出、任务执行消费）
 * - 执行结果：NodeResult / PlanExecutionResult（任务执行产出、反思器消费）
 * - 注入点：NodeRunner / CascadeHandler（测试离线模拟 / 级联回注哨兵）
 * - 错误：ExecutionError
 */

import { AppError } from './errors.js';
import type { Signal } from './sentinel.js';

/** DAG 计划节点 */
export interface PlanNode {
  id: string;
  description: string;
  /** 任务类型（code-generation / documentation / analysis 等） */
  type: string;
  dependsOn: string[];
  /** 指定模型（缺省由模型调度决定） */
  modelId?: string;
  /** 节点级超时覆盖（毫秒） */
  timeout?: number;
  /** 完成后级联触发的信号描述 */
  cascade?: Array<{ type: string; description: string }>;
}

/** 执行计划（优化器快路径召回 / strategist DAG / 离线兜底 三类来源） */
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

/** 计划执行失败 */
export class ExecutionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'EXECUTION_ERROR', details);
  }
}
