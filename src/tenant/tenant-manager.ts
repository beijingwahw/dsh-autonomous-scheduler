/**
 * tenant-manager.ts — 多租户管理器（能力层，依赖 long-term-memory）
 *
 * 职责：
 * - 租户注册 / 移除 / 更新 / 查询（含按标签检索）
 * - 每个租户持有独立的 LongTermMemory 实例与运行时状态（TenantRuntime）
 * - 按文件路径匹配租户（matchTenantByPath）
 * - 信号路由：将外部信号分发到最合适的租户（routeSignal）
 * - 租户注册表持久化与全局统计
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 注册表持久化：租户配置落盘到 registry.json，进程重启后自动恢复全部运行时
 * 2. 信号路由评分制：按 payload 路径前缀匹配深度 + 信号类型命中 + 标签命中
 *    加权打分，选择得分最高的租户，而非简单首个匹配
 * 3. 路径匹配安全化：workDir 规范化后做前缀比较，防止相对路径逃逸误匹配
 * 4. 租户级记忆隔离：每个租户独立 memoryPath 与 LongTermMemory 实例，
 *    移除租户时可选级联删除数据
 * 5. 运行时统计自维护：activeExecutions / pendingSignals / stats 全量跟踪，
 *    供 model_dashboard 与 manage_tenants Tool 直接消费
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../errors.js';
import { LongTermMemory } from '../memory/long-term-memory.js';
import type { ModelLongTermProfile } from '../memory/long-term-memory.js';
import type { CryptoEngine } from '../security/crypto-engine.js';
import type { Signal } from '../sentinel.js';

/** 租户静态配置 */
export interface TenantConfig {
  id: string;
  name: string;
  /** 租户工作目录（用于路径匹配与记忆库默认存放位置） */
  workDir: string;
  models?: Array<{
    id: string;
    name?: string;
    endpoint: string;
    apiKey: string;
    timeout?: number;
    maxConcurrency?: number;
    costPerKToken?: number;
    contextWindow?: number;
    initialCapabilities?: Record<string, any>;
  }>;
  strategistModel?: { id: string; endpoint: string; apiKey: string };
  sentinel?: {
    watchCodeChanges?: boolean;
    watchErrors?: boolean;
    watchPerformance?: boolean;
    aggregationWindow?: number;
    signalSources?: Array<{
      type: 'webhook' | 'polling' | 'filesystem';
      port?: number;
      interval?: number;
      path?: string;
      signalType: string;
    }>;
  };
  qualityThreshold?: number;
  maxRetries?: number;
  globalTimeout?: number;
  memoryPath?: string;
  enabled?: boolean;
  tags?: string[];
  createdAt: number;
  lastActiveAt: number;
}

/** 租户运行时（配置 + 记忆 + 实时状态） */
export interface TenantRuntime {
  config: TenantConfig;
  memory: LongTermMemory;
  activeExecutions: number;
  pendingSignals: Signal[];
  isExecuting: boolean;
  modelProfiles: Map<string, ModelLongTermProfile>;
  aggregationTimer: ReturnType<typeof setTimeout> | null;
  stats: {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalSignals: number;
    totalTokensUsed: number;
  };
}

/** 租户注册表（持久化结构） */
export interface TenantRegistry {
  version: number;
  tenants: TenantConfig[];
  globalDefaults: {
    qualityThreshold: number;
    maxRetries: number;
    globalTimeout: number;
    aggregationWindow: number;
  };
}

/** 注册表默认值（与 cordis.patch.yml 全局配置对齐） */
const DEFAULT_GLOBALS: TenantRegistry['globalDefaults'] = {
  qualityThreshold: 0.7,
  maxRetries: 2,
  globalTimeout: 300000,
  aggregationWindow: 5,
};

/**
 * 多租户管理器
 *
 * 被 index.ts 集成层持有，manage_tenants Tool 的全部 action 映射到本类方法。
 */
export class TenantManager {
  private dataDir: string;
  private registryPath: string;
  private registry: TenantRegistry;
  private runtimes = new Map<string, TenantRuntime>();
  private cryptoEngine?: CryptoEngine;

  /**
   * @param dataDir 租户数据根目录（注册表与各租户记忆库的存放处）
   * @param cryptoEngine 可选加密引擎，透传给各租户的记忆库
   */
  constructor(dataDir: string, cryptoEngine?: CryptoEngine) {
    this.dataDir = dataDir;
    this.cryptoEngine = cryptoEngine;
    this.registryPath = path.join(dataDir, 'registry.json');
    this.registry = this.loadRegistry();
    // 恢复所有已启用租户的运行时
    for (const config of this.registry.tenants) {
      if (config.enabled !== false) {
        this.runtimes.set(config.id, this.buildRuntime(config));
      }
    }
  }

  /**
   * 注册新租户并创建运行时
   * @param config 租户配置（createdAt / lastActiveAt 自动填充）
   * @throws ConfigError id 重复或必填字段缺失
   */
  registerTenant(config: Omit<TenantConfig, 'createdAt' | 'lastActiveAt'>): TenantRuntime {
    if (!config.id || !config.name || !config.workDir) {
      throw new ConfigError('租户配置缺少必填字段: id / name / workDir');
    }
    if (this.registry.tenants.some((t) => t.id === config.id)) {
      throw new ConfigError(`租户已存在: ${config.id}`);
    }
    const now = Date.now();
    const fullConfig: TenantConfig = {
      enabled: true,
      ...config,
      createdAt: now,
      lastActiveAt: now,
    };
    this.registry.tenants.push(fullConfig);
    this.persistRegistry();
    const runtime = this.buildRuntime(fullConfig);
    this.runtimes.set(fullConfig.id, runtime);
    return runtime;
  }

  /**
   * 移除租户
   * @param tenantId 租户 id
   * @param deleteData 是否级联删除租户记忆数据，默认 false
   */
  removeTenant(tenantId: string, deleteData = false): void {
    // 校验先行：原实现先销毁运行时再查注册表——注册表缺失时抛错，
    // 但运行时已被删，留下「调用方以为失败、系统却已半移除」的不一致状态
    const index = this.registry.tenants.findIndex((t) => t.id === tenantId);
    if (index < 0) {
      throw new ConfigError(`租户不存在: ${tenantId}`);
    }
    const [removed] = this.registry.tenants.splice(index, 1);
    const runtime = this.runtimes.get(tenantId);
    if (runtime) {
      if (runtime.aggregationTimer) clearTimeout(runtime.aggregationTimer);
      runtime.memory.dispose();
      this.runtimes.delete(tenantId);
    }
    this.persistRegistry();
    if (deleteData && removed) {
      const memoryPath = this.resolveMemoryPath(removed);
      try {
        if (fs.existsSync(memoryPath)) fs.rmSync(memoryPath);
      } catch {
        /* 数据删除失败不阻塞移除流程 */
      }
    }
  }

  /**
   * 更新租户配置（增量合并）
   * @param tenantId 租户 id
   * @param updates 需要更新的字段
   */
  updateTenant(tenantId: string, updates: Partial<TenantConfig>): void {
    const config = this.registry.tenants.find((t) => t.id === tenantId);
    if (!config) {
      throw new ConfigError(`租户不存在: ${tenantId}`);
    }
    // id 为不可变主键
    const { id: _ignored, ...safeUpdates } = updates;
    Object.assign(config, safeUpdates);
    this.persistRegistry();

    // 运行时热更新：enabled 变化时创建/销毁运行时
    const runtime = this.runtimes.get(tenantId);
    if (config.enabled === false && runtime) {
      if (runtime.aggregationTimer) clearTimeout(runtime.aggregationTimer);
      // 禁用即清空待聚合信号：运行时即将销毁，残留信号只做内存驻留；
      // 重新启用时 buildRuntime 全新起步，旧信号既不会被聚合也不会被路由
      runtime.pendingSignals.length = 0;
      runtime.memory.dispose();
      this.runtimes.delete(tenantId);
    } else if (config.enabled !== false && !runtime) {
      this.runtimes.set(tenantId, this.buildRuntime(config));
    } else if (runtime) {
      runtime.config = config;
    }
  }

  /** 获取单个租户运行时 */
  getTenant(tenantId: string): TenantRuntime | undefined {
    return this.runtimes.get(tenantId);
  }

  /** 获取全部租户运行时 */
  getAllTenants(): TenantRuntime[] {
    return [...this.runtimes.values()];
  }

  /** 按标签检索租户 */
  getTenantsByTag(tag: string): TenantRuntime[] {
    return this.getAllTenants().filter((rt) => rt.config.tags?.includes(tag));
  }

  /**
   * 按文件路径匹配租户（路径规范化后做前缀比较）
   * @param filePath 文件或目录绝对路径
   * @returns workDir 最深匹配的租户运行时，无匹配返回 undefined
   */
  matchTenantByPath(filePath: string): TenantRuntime | undefined {
    const normalized = path.resolve(filePath);
    let best: TenantRuntime | undefined;
    let bestDepth = -1;
    for (const rt of this.runtimes.values()) {
      const workDir = path.resolve(rt.config.workDir);
      if (normalized === workDir || normalized.startsWith(workDir + path.sep)) {
        const depth = workDir.split(path.sep).length;
        if (depth > bestDepth) {
          bestDepth = depth;
          best = rt;
        }
      }
    }
    return best;
  }

  /**
   * 信号路由：将信号分发到最合适的租户
   *
   * 评分规则（加权）：
   * - payload 中的路径字段命中租户 workDir：+2 × 路径深度
   * - 信号类型命中租户 sentinel.signalSources：+3
   * - 信号类型命中租户 tags：+1
   * 得分最高者胜出，全部为 0 分时返回 undefined（由默认实例接管）。
   *
   * @param signal 外部信号 { type, payload }
   */
  routeSignal(signal: { type: string; payload: Record<string, any> }): TenantRuntime | undefined {
    let best: TenantRuntime | undefined;
    let bestScore = 0;

    for (const rt of this.runtimes.values()) {
      let score = 0;

      // 1. 路径匹配：扫描 payload 中所有字符串值寻找路径线索
      const workDir = path.resolve(rt.config.workDir);
      for (const value of Object.values(signal.payload)) {
        if (typeof value === 'string' && (value.includes('/') || value.includes(path.sep))) {
          const resolved = path.resolve(value);
          if (resolved === workDir || resolved.startsWith(workDir + path.sep)) {
            score += 2 * workDir.split(path.sep).length;
            break;
          }
        }
      }

      // 2. 信号源类型命中
      const sources = rt.config.sentinel?.signalSources ?? [];
      if (sources.some((s) => s.signalType === signal.type)) {
        score += 3;
      }

      // 3. 标签命中
      if (rt.config.tags?.includes(signal.type)) {
        score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        best = rt;
      }
    }
    return best;
  }

  /** 刷新租户活跃时间 */
  touchTenant(tenantId: string): void {
    const config = this.registry.tenants.find((t) => t.id === tenantId);
    if (config) {
      config.lastActiveAt = Date.now();
      this.persistRegistry();
    }
  }

  /**
   * 全局统计（跨租户汇总，供 manage_tenants stats 使用）
   */
  getGlobalStats(): Record<string, any> {
    const tenants = this.getAllTenants();
    const sum = (fn: (rt: TenantRuntime) => number): number => tenants.reduce((s, rt) => s + fn(rt), 0);
    return {
      tenantCount: tenants.length,
      activeTenants: tenants.filter((rt) => rt.config.enabled !== false).length,
      executingTenants: tenants.filter((rt) => rt.isExecuting).length,
      totalExecutions: sum((rt) => rt.stats.totalExecutions),
      totalSuccesses: sum((rt) => rt.stats.totalSuccesses),
      totalFailures: sum((rt) => rt.stats.totalFailures),
      totalSignals: sum((rt) => rt.stats.totalSignals),
      totalTokensUsed: sum((rt) => rt.stats.totalTokensUsed),
      pendingSignals: sum((rt) => rt.pendingSignals.length),
      globalDefaults: { ...this.registry.globalDefaults },
    };
  }

  /** 释放全部运行时（进程退出前调用） */
  dispose(): void {
    for (const rt of this.runtimes.values()) {
      if (rt.aggregationTimer) clearTimeout(rt.aggregationTimer);
      rt.memory.dispose();
    }
    this.runtimes.clear();
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 加载注册表（不存在时初始化） */
  private loadRegistry(): TenantRegistry {
    if (!fs.existsSync(this.registryPath)) {
      return { version: 1, tenants: [], globalDefaults: { ...DEFAULT_GLOBALS } };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      if (!Array.isArray(raw.tenants)) {
        throw new Error('注册表结构非法：缺少 tenants 数组');
      }
      return {
        version: raw.version ?? 1,
        tenants: raw.tenants,
        globalDefaults: { ...DEFAULT_GLOBALS, ...raw.globalDefaults },
      };
    } catch (err) {
      throw new ConfigError(`租户注册表加载失败: ${this.registryPath}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 持久化注册表（原子写入） */
  private persistRegistry(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.registryPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.registry, null, 2), 'utf-8');
    fs.renameSync(tmp, this.registryPath);
  }

  /** 解析租户记忆库路径 */
  private resolveMemoryPath(config: TenantConfig): string {
    if (config.memoryPath) {
      return path.isAbsolute(config.memoryPath)
        ? config.memoryPath
        : path.join(this.dataDir, config.id, config.memoryPath);
    }
    return path.join(this.dataDir, config.id, 'memory.json');
  }

  /** 构建租户运行时 */
  private buildRuntime(config: TenantConfig): TenantRuntime {
    const memoryPath = this.resolveMemoryPath(config);
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    return {
      config,
      memory: new LongTermMemory(memoryPath, this.cryptoEngine),
      activeExecutions: 0,
      pendingSignals: [],
      isExecuting: false,
      modelProfiles: new Map(),
      aggregationTimer: null,
      stats: {
        totalExecutions: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalSignals: 0,
        totalTokensUsed: 0,
      },
    };
  }
}
