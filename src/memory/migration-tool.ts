/**
 * migration-tool.ts — 记忆迁移工具（能力层，依赖 long-term-memory）
 *
 * 职责：
 * - 将记忆库导出为自包含的迁移包（MigrationPackage），支持文件落盘
 * - 将迁移包导入目标记忆库，支持四种冲突合并策略
 * - dryRun 预演冲突与统计，不产生任何写入
 * - 跨租户记忆迁移（源记忆库 → 目标记忆库）
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 完整性保护：迁移包携带 data 段的 SHA-256 校验和，导入前强制校验，
 *    防止传输/存储过程中的静默损坏与人为篡改
 * 2. 语义化冲突检测：pattern 按 fingerprint、model-profile 按 id、
 *    feedback 按 id 建立冲突键，冲突双方数据完整保留在 MigrationConflict 中供审计
 * 3. newer-wins 策略基于 lastSeenAt/timestamp 做时间戳仲裁，而非盲目覆盖
 * 4. merge 策略对任务模式做深度合并（成功方案并集 + 失败记录并集 + 统计重算），
 *    而非简单二选一，最大化保留双方经验
 * 5. 全程错误隔离：单条记录导入失败不中断整体迁移，错误收集进 MigrationReport.errors
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryError } from '../errors.js';
import type {
  LongTermMemory,
  TaskPatternMemory,
  ModelLongTermProfile,
  DecisionFeedback,
  MemoryStore,
} from './long-term-memory.js';

/** 迁移包（自包含、可校验、可审计） */
export interface MigrationPackage {
  version: number;
  exportedAt: number;
  source: {
    instanceId: string;
    instanceName?: string;
    pluginVersion: string;
  };
  scope: {
    includePatterns: boolean;
    includeModelProfiles: boolean;
    includeFeedback: boolean;
    includeGlobalStats: boolean;
    tenantFilter?: string[];
  };
  /** data 段 JSON 序列化后的 SHA-256（hex），导入前强制校验 */
  checksum: string;
  data: {
    taskPatterns?: TaskPatternMemory[];
    modelProfiles?: ModelLongTermProfile[];
    decisionFeedback?: DecisionFeedback[];
    globalStats?: MemoryStore['globalStats'];
    tenants?: any[];
  };
}

/** 冲突合并策略 */
export type MergeStrategy = 'overwrite' | 'merge' | 'skip' | 'newer-wins';

/** 迁移冲突记录（保留双方数据供审计） */
export interface MigrationConflict {
  type: 'pattern' | 'model-profile' | 'feedback';
  key: string;
  localVersion: any;
  remoteVersion: any;
  resolution?: MergeStrategy;
}

/** 迁移结果报告 */
export interface MigrationReport {
  success: boolean;
  strategy: MergeStrategy;
  imported: {
    patterns: number;
    modelProfiles: number;
    feedback: number;
  };
  skipped: number;
  conflicts: MigrationConflict[];
  errors: string[];
  duration: number;
}

/** 导出选项 */
export interface ExportOptions {
  includePatterns?: boolean;
  includeModelProfiles?: boolean;
  includeFeedback?: boolean;
  includeGlobalStats?: boolean;
  tenantFilter?: string[];
  instanceName?: string;
}

/** 迁移包格式版本 */
const PACKAGE_VERSION = 1;
/** 插件版本（与 package.json 对齐） */
const PLUGIN_VERSION = '0.1.0';

/**
 * 记忆迁移工具
 *
 * 被 index.ts 的 memory_migration Tool 调用（export/import/dry-run/migrate-tenant）。
 */
export class MigrationTool {
  private instanceId: string;

  /**
   * @param instanceId 当前实例标识（写入迁移包 source），缺省自动生成
   */
  constructor(instanceId?: string) {
    this.instanceId = instanceId ?? `instance-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * 从记忆库实例导出迁移包
   * @param memory 源记忆库
   * @param options 导出范围选项（缺省全量导出）
   */
  exportFromMemory(memory: LongTermMemory, options?: ExportOptions): MigrationPackage {
    const opts: Required<Omit<ExportOptions, 'tenantFilter' | 'instanceName'>> & Pick<ExportOptions, 'tenantFilter' | 'instanceName'> = {
      includePatterns: options?.includePatterns ?? true,
      includeModelProfiles: options?.includeModelProfiles ?? true,
      includeFeedback: options?.includeFeedback ?? true,
      includeGlobalStats: options?.includeGlobalStats ?? true,
      tenantFilter: options?.tenantFilter,
      instanceName: options?.instanceName,
    };

    const data: MigrationPackage['data'] = {};
    if (opts.includePatterns) data.taskPatterns = memory.getAllTaskPatterns();
    if (opts.includeModelProfiles) data.modelProfiles = memory.getAllModelProfiles();
    if (opts.includeFeedback) data.decisionFeedback = memory.getAllDecisionFeedback();
    if (opts.includeGlobalStats) data.globalStats = memory.getGlobalStats();

    return this.buildPackage(data, opts);
  }

  /**
   * 从磁盘文件读取迁移包（含校验和验证）
   * @param filePath 迁移包文件路径
   * @throws MemoryError 文件不存在 / JSON 非法 / 校验和不匹配
   */
  exportFromFile(filePath: string): MigrationPackage {
    if (!fs.existsSync(filePath)) {
      throw new MemoryError(`迁移包文件不存在: ${filePath}`);
    }
    let pkg: MigrationPackage;
    try {
      pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MigrationPackage;
    } catch (err) {
      throw new MemoryError(`迁移包解析失败: ${filePath}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    this.verifyChecksum(pkg);
    return pkg;
  }

  /**
   * 导出迁移包并写入文件
   * @param memory 源记忆库
   * @param outputPath 输出路径
   * @param options 导出范围选项
   */
  exportToFile(memory: LongTermMemory, outputPath: string, options?: ExportOptions): void {
    const pkg = this.exportFromMemory(memory, options);
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${outputPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2), 'utf-8');
    fs.renameSync(tmp, outputPath);
  }

  /**
   * 将迁移包导入目标记忆库
   * @param memory 目标记忆库
   * @param pkg 迁移包
   * @param strategy 冲突合并策略，默认 merge
   */
  importToMemory(memory: LongTermMemory, pkg: MigrationPackage, strategy: MergeStrategy = 'merge'): MigrationReport {
    const startedAt = Date.now();
    const report: MigrationReport = {
      success: true,
      strategy,
      imported: { patterns: 0, modelProfiles: 0, feedback: 0 },
      skipped: 0,
      conflicts: [],
      errors: [],
      duration: 0,
    };

    try {
      // 1. 校验和验证（防篡改 / 防损坏）
      this.verifyChecksum(pkg);

      // 2. 导入任务模式
      for (const remote of pkg.data.taskPatterns ?? []) {
        try {
          const local = memory.getAllTaskPatterns().find((p) => p.fingerprint === remote.fingerprint);
          if (!local) {
            memory.upsertPattern(remote);
            report.imported.patterns += 1;
            continue;
          }
          // 冲突处理
          const conflict: MigrationConflict = {
            type: 'pattern',
            key: remote.fingerprint,
            localVersion: local,
            remoteVersion: remote,
            resolution: strategy,
          };
          report.conflicts.push(conflict);
          const winner = this.resolvePatternConflict(local, remote, strategy);
          if (winner === null) {
            report.skipped += 1;
          } else {
            memory.upsertPattern(winner);
            report.imported.patterns += 1;
          }
        } catch (err) {
          report.errors.push(`pattern[${remote.fingerprint}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 3. 导入模型画像
      for (const remote of pkg.data.modelProfiles ?? []) {
        try {
          const local = memory.getModelProfile(remote.id);
          if (!local) {
            memory.upsertModelProfile(remote);
            report.imported.modelProfiles += 1;
            continue;
          }
          const conflict: MigrationConflict = {
            type: 'model-profile',
            key: remote.id,
            localVersion: local,
            remoteVersion: remote,
            resolution: strategy,
          };
          report.conflicts.push(conflict);
          const winner = this.resolveProfileConflict(local, remote, strategy);
          if (winner === null) {
            report.skipped += 1;
          } else {
            memory.upsertModelProfile(winner);
            report.imported.modelProfiles += 1;
          }
        } catch (err) {
          report.errors.push(`model-profile[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 4. 导入决策反馈（按 id 去重，天然幂等）
      for (const remote of pkg.data.decisionFeedback ?? []) {
        try {
          const written = memory.appendFeedback(remote);
          if (written) {
            report.imported.feedback += 1;
          } else {
            report.skipped += 1;
          }
        } catch (err) {
          report.errors.push(`feedback[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 5. 合并全局统计（仅 merge / overwrite 策略下累加）
      if (pkg.data.globalStats && (strategy === 'merge' || strategy === 'overwrite')) {
        memory.mergeGlobalStats(pkg.data.globalStats);
      }

      report.success = report.errors.length === 0;
    } catch (err) {
      report.success = false;
      report.errors.push(err instanceof Error ? err.message : String(err));
    }

    report.duration = Date.now() - startedAt;
    return report;
  }

  /**
   * 从文件读取迁移包并导入
   * @param memory 目标记忆库
   * @param filePath 迁移包文件路径
   * @param strategy 冲突合并策略，默认 merge
   */
  importFromFile(memory: LongTermMemory, filePath: string, strategy: MergeStrategy = 'merge'): MigrationReport {
    const pkg = this.exportFromFile(filePath);
    return this.importToMemory(memory, pkg, strategy);
  }

  /**
   * 预演导入：检测冲突与统计，不产生任何写入
   * @param memory 目标记忆库
   * @param pkg 迁移包
   */
  dryRun(memory: LongTermMemory, pkg: MigrationPackage): { conflicts: MigrationConflict[]; summary: Record<string, number> } {
    this.verifyChecksum(pkg);
    const conflicts: MigrationConflict[] = [];
    let newPatterns = 0;
    let newProfiles = 0;
    let newFeedback = 0;
    let duplicates = 0;

    const localPatterns = memory.getAllTaskPatterns();
    const localFeedbackIds = new Set(memory.getAllDecisionFeedback().map((f) => f.id));

    for (const remote of pkg.data.taskPatterns ?? []) {
      const local = localPatterns.find((p) => p.fingerprint === remote.fingerprint);
      if (local) {
        conflicts.push({ type: 'pattern', key: remote.fingerprint, localVersion: local, remoteVersion: remote });
      } else {
        newPatterns += 1;
      }
    }
    for (const remote of pkg.data.modelProfiles ?? []) {
      const local = memory.getModelProfile(remote.id);
      if (local) {
        conflicts.push({ type: 'model-profile', key: remote.id, localVersion: local, remoteVersion: remote });
      } else {
        newProfiles += 1;
      }
    }
    for (const remote of pkg.data.decisionFeedback ?? []) {
      if (localFeedbackIds.has(remote.id)) {
        duplicates += 1;
      } else {
        newFeedback += 1;
      }
    }

    return {
      conflicts,
      summary: {
        newPatterns,
        newProfiles,
        newFeedback,
        conflicts: conflicts.length,
        duplicates,
        totalIncoming:
          (pkg.data.taskPatterns?.length ?? 0) +
          (pkg.data.modelProfiles?.length ?? 0) +
          (pkg.data.decisionFeedback?.length ?? 0),
      },
    };
  }

  /**
   * 跨租户迁移：源记忆库 → 目标记忆库
   * @param sourceMemory 源租户记忆库
   * @param targetMemory 目标租户记忆库
   * @param options 迁移选项（范围 + 策略）
   */
  migrateBetweenTenants(
    sourceMemory: LongTermMemory,
    targetMemory: LongTermMemory,
    options?: ExportOptions & { strategy?: MergeStrategy },
  ): MigrationReport {
    const pkg = this.exportFromMemory(sourceMemory, options);
    return this.importToMemory(targetMemory, pkg, options?.strategy ?? 'merge');
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 构建带校验和的迁移包 */
  private buildPackage(data: MigrationPackage['data'], opts: ExportOptions): MigrationPackage {
    const pkg: MigrationPackage = {
      version: PACKAGE_VERSION,
      exportedAt: Date.now(),
      source: {
        instanceId: this.instanceId,
        instanceName: opts.instanceName,
        pluginVersion: PLUGIN_VERSION,
      },
      scope: {
        includePatterns: opts.includePatterns ?? true,
        includeModelProfiles: opts.includeModelProfiles ?? true,
        includeFeedback: opts.includeFeedback ?? true,
        includeGlobalStats: opts.includeGlobalStats ?? true,
        tenantFilter: opts.tenantFilter,
      },
      checksum: this.computeChecksum(data),
      data,
    };
    return pkg;
  }

  /** 计算 data 段的 SHA-256（深度键序规范化序列化，与键序无关） */
  private computeChecksum(data: MigrationPackage['data']): string {
    return crypto.createHash('sha256').update(this.canonicalStringify(data)).digest('hex');
  }

  /** 递归按键名排序的规范化 JSON 序列化（保证任意嵌套层级的确定性） */
  private canonicalStringify(value: any): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((v) => this.canonicalStringify(v)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${this.canonicalStringify(value[k])}`).join(',')}}`;
  }

  /** 校验迁移包完整性 */
  private verifyChecksum(pkg: MigrationPackage): void {
    if (!pkg || typeof pkg !== 'object' || !pkg.data || typeof pkg.checksum !== 'string') {
      throw new MemoryError('迁移包结构非法：缺少 data 或 checksum');
    }
    const expected = this.computeChecksum(pkg.data);
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(pkg.checksum, 'hex'))) {
      throw new MemoryError('迁移包校验和不匹配：数据可能已损坏或被篡改');
    }
  }

  /**
   * 任务模式冲突仲裁
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolvePatternConflict(local: TaskPatternMemory, remote: TaskPatternMemory, strategy: MergeStrategy): TaskPatternMemory | null {
    switch (strategy) {
      case 'overwrite':
        return remote;
      case 'skip':
        return null;
      case 'newer-wins':
        return remote.lastSeenAt >= local.lastSeenAt ? remote : local;
      case 'merge':
      default:
        return this.mergePatterns(local, remote);
    }
  }

  /** 深度合并两个任务模式：方案并集 + 记录并集 + 统计重算 */
  private mergePatterns(local: TaskPatternMemory, remote: TaskPatternMemory): TaskPatternMemory {
    // 成功方案按 timestamp 去重合并
    const planKey = (p: { timestamp: number; totalLatency: number; tokenCost: number }) =>
      `${p.timestamp}:${p.totalLatency}:${p.tokenCost}`;
    const planMap = new Map<string, (typeof local.successfulPlans)[number]>();
    for (const p of [...local.successfulPlans, ...remote.successfulPlans]) {
      planMap.set(planKey(p), p);
    }
    const successfulPlans = [...planMap.values()].sort((a, b) => b.timestamp - a.timestamp);

    // 失败记录按 timestamp+errorMessage 去重合并
    const failKey = (f: { timestamp: number; errorMessage: string }) => `${f.timestamp}:${f.errorMessage}`;
    const failMap = new Map<string, (typeof local.failureRecords)[number]>();
    for (const f of [...local.failureRecords, ...remote.failureRecords]) {
      failMap.set(failKey(f), f);
    }
    const failureRecords = [...failMap.values()].sort((a, b) => b.timestamp - a.timestamp);

    const avg = (values: number[]): number =>
      values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;

    return {
      fingerprint: local.fingerprint,
      taskSummary: local.taskSummary,
      frequency: local.frequency + remote.frequency,
      firstSeenAt: Math.min(local.firstSeenAt, remote.firstSeenAt),
      lastSeenAt: Math.max(local.lastSeenAt, remote.lastSeenAt),
      successfulPlans,
      failureRecords,
      // 置信度取加权平均（按频率加权）
      confidence:
        (local.confidence * local.frequency + remote.confidence * remote.frequency) /
        Math.max(1, local.frequency + remote.frequency),
      bestModelCombination: remote.lastSeenAt >= local.lastSeenAt ? remote.bestModelCombination : local.bestModelCombination,
      avgExecutionTime: avg(successfulPlans.map((p) => p.totalLatency)),
      avgQualityScore: avg(
        successfulPlans.map((p) => {
          const values = Object.values(p.qualityScores);
          return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
        }),
      ),
    };
  }

  /**
   * 模型画像冲突仲裁
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveProfileConflict(local: ModelLongTermProfile, remote: ModelLongTermProfile, strategy: MergeStrategy): ModelLongTermProfile | null {
    switch (strategy) {
      case 'overwrite':
        return remote;
      case 'skip':
        return null;
      case 'newer-wins': {
        const localLast = Math.max(0, ...Object.values(local.taskHistory).map((h) => h.lastCalledAt));
        const remoteLast = Math.max(0, ...Object.values(remote.taskHistory).map((h) => h.lastCalledAt));
        return remoteLast >= localLast ? remote : local;
      }
      case 'merge':
      default:
        return this.mergeProfiles(local, remote);
    }
  }

  /** 深度合并两个模型画像：taskHistory 按任务类型累加 */
  private mergeProfiles(local: ModelLongTermProfile, remote: ModelLongTermProfile): ModelLongTermProfile {
    const taskHistory: ModelLongTermProfile['taskHistory'] = {};
    const types = new Set([...Object.keys(local.taskHistory), ...Object.keys(remote.taskHistory)]);
    for (const type of types) {
      const l = local.taskHistory[type];
      const r = remote.taskHistory[type];
      if (l && r) {
        taskHistory[type] = {
          totalCalls: l.totalCalls + r.totalCalls,
          successCount: l.successCount + r.successCount,
          totalLatency: l.totalLatency + r.totalLatency,
          totalQualityScore: l.totalQualityScore + r.totalQualityScore,
          avgQualityScore:
            l.successCount + r.successCount > 0
              ? (l.totalQualityScore + r.totalQualityScore) / (l.successCount + r.successCount)
              : 0,
          lastCalledAt: Math.max(l.lastCalledAt, r.lastCalledAt),
        };
      } else {
        taskHistory[type] = { ...(l ?? r)! };
      }
    }

    // 成本效率取双方均值
    const costEfficiency: Record<string, number> = { ...local.costEfficiency };
    for (const [type, value] of Object.entries(remote.costEfficiency)) {
      costEfficiency[type] = costEfficiency[type] !== undefined ? (costEfficiency[type] + value) / 2 : value;
    }

    // best/worst 从合并后的历史重新推导
    const ranked = Object.entries(taskHistory)
      .filter(([, h]) => h.totalCalls >= 2)
      .sort((a, b) => b[1].successCount / b[1].totalCalls - a[1].successCount / a[1].totalCalls);

    return {
      id: local.id,
      name: local.name,
      taskHistory,
      costEfficiency,
      bestTaskType: ranked[0]?.[0] ?? local.bestTaskType,
      worstTaskType: ranked[ranked.length - 1]?.[0] ?? local.worstTaskType,
      stability: (local.stability + remote.stability) / 2,
    };
  }
}
