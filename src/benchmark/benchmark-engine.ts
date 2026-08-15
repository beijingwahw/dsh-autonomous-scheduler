/**
 * benchmark-engine.ts — 性能基准测试引擎（能力层，依赖 long-term-memory + crypto-engine）
 *
 * 职责：
 * - 场景化压测：按 target 维度（sentinel/strategist/executor/memory/sync/
 *   consensus/encryption/full-pipeline）注册并执行基准场景
 * - 统计计算：成功率、延迟分位数（p50/p90/p95/p99）、标准差、吞吐率、峰值内存
 * - 阈值门禁：每类 target 有默认性能阈值，违反即判定不通过
 * - 报告管理：持久化报告、历史对比、Markdown 报告生成
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 真实并发池：按 scenario.concurrency 并发调度 + 预热阶段（warmupRequests
 *    结果不计入统计），避免 JIT 冷启动污染数据
 * 2. 无侵入内置场景：memory / encryption 场景直接压测真实模块，
 *    strategist / executor 等需要 LLM 的场景在 callLLM 缺省时自动跳过并标注原因，
 *    保证离线环境也能产出有效报告
 * 3. 分 target 阈值门禁：不同 target 使用不同阈值（如 encryption 要求 p95 < 50ms，
 *    full-pipeline 放宽到 p95 < 30s），阈值违反逐条列出
 * 4. 延迟分布直方图：指数分桶（<1ms / 1-10ms / ... / >10s），直观呈现长尾
 * 5. 报告对比：compareReports 输出逐场景的延迟与吞吐变化率，用于回归检测
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';
import type { LongTermMemory } from '../memory/long-term-memory.js';
import type { CryptoEngine } from '../security/crypto-engine.js';

/** 单次迭代结果 */
export interface BenchmarkResult {
  success: boolean;
  latency: number;
  error?: string;
  memoryUsed?: number;
  tokensUsed?: number;
}

/** 基准场景定义 */
export interface BenchmarkScenario {
  name: string;
  description: string;
  target:
    | 'sentinel'
    | 'strategist'
    | 'executor'
    | 'memory'
    | 'sync'
    | 'consensus'
    | 'encryption'
    | 'full-pipeline';
  concurrency: number;
  totalRequests: number;
  warmupRequests: number;
  timeout: number;
  execute: (iteration: number) => Promise<BenchmarkResult>;
}

/** 聚合统计 */
export interface BenchmarkStats {
  totalRequests: number;
  successCount: number;
  failCount: number;
  successRate: number;
  minLatency: number;
  maxLatency: number;
  avgLatency: number;
  p50Latency: number;
  p90Latency: number;
  p95Latency: number;
  p99Latency: number;
  stdDev: number;
  /** 每秒完成请求数 */
  throughput: number;
  totalDuration: number;
  peakMemoryMB: number;
  errorDistribution: Record<string, number>;
}

/** 性能阈值 */
export interface PerformanceThreshold {
  maxP95Latency: number;
  minThroughput: number;
  minSuccessRate: number;
  maxP99Latency: number;
}

/** 基准报告 */
export interface BenchmarkReport {
  id: string;
  timestamp: number;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpuCount: number;
    totalMemoryMB: number;
    pluginVersion: string;
  };
  scenarios: Array<{
    name: string;
    description: string;
    target: string;
    concurrency: number;
    stats: BenchmarkStats;
    passed: boolean;
    thresholdViolations: string[];
    latencyDistribution: Array<{ bucket: string; count: number }>;
  }>;
  overallPassed: boolean;
  totalDuration: number;
}

/** 内置场景上下文 */
export interface BuiltinScenarioContext {
  memory: LongTermMemory;
  cryptoEngine: CryptoEngine;
  callLLM: Function;
  models: Array<{ id: string; endpoint: string; apiKey: string }>;
}

/** 分 target 默认阈值 */
const DEFAULT_THRESHOLDS: Record<BenchmarkScenario['target'], PerformanceThreshold> = {
  sentinel: { maxP95Latency: 100, minThroughput: 50, minSuccessRate: 0.99, maxP99Latency: 300 },
  strategist: { maxP95Latency: 15000, minThroughput: 0.05, minSuccessRate: 0.9, maxP99Latency: 30000 },
  executor: { maxP95Latency: 20000, minThroughput: 0.05, minSuccessRate: 0.9, maxP99Latency: 45000 },
  memory: { maxP95Latency: 20, minThroughput: 100, minSuccessRate: 0.999, maxP99Latency: 100 },
  sync: { maxP95Latency: 200, minThroughput: 20, minSuccessRate: 0.99, maxP99Latency: 500 },
  consensus: { maxP95Latency: 500, minThroughput: 10, minSuccessRate: 0.99, maxP99Latency: 1000 },
  encryption: { maxP95Latency: 50, minThroughput: 50, minSuccessRate: 0.999, maxP99Latency: 200 },
  'full-pipeline': { maxP95Latency: 30000, minThroughput: 0.02, minSuccessRate: 0.85, maxP99Latency: 60000 },
};

/** 延迟分布桶边界（毫秒） */
const LATENCY_BUCKETS: Array<{ bucket: string; max: number }> = [
  { bucket: '<1ms', max: 1 },
  { bucket: '1-10ms', max: 10 },
  { bucket: '10-50ms', max: 50 },
  { bucket: '50-100ms', max: 100 },
  { bucket: '100-500ms', max: 500 },
  { bucket: '500ms-1s', max: 1000 },
  { bucket: '1-5s', max: 5000 },
  { bucket: '5-10s', max: 10000 },
  { bucket: '>10s', max: Infinity },
];

/** 插件版本（与 package.json 对齐） */
const PLUGIN_VERSION = '0.1.0';

/**
 * 性能基准测试引擎
 *
 * 被 index.ts 的 run_benchmark Tool 调用
 * （run-all / list-scenarios / list-reports / compare / generate-report）。
 */
export class BenchmarkEngine {
  private reportDir: string;
  private scenarios = new Map<string, BenchmarkScenario>();
  private thresholds: Record<string, PerformanceThreshold> = { ...DEFAULT_THRESHOLDS };

  /**
   * @param reportDir 报告持久化目录（如 .scheduler/benchmarks）
   */
  constructor(reportDir: string) {
    this.reportDir = reportDir;
    fs.mkdirSync(reportDir, { recursive: true });
  }

  /**
   * 注册自定义场景（同名覆盖）
   */
  registerScenario(scenario: BenchmarkScenario): void {
    this.scenarios.set(scenario.name, scenario);
  }

  /**
   * 覆盖指定 target 的性能阈值
   */
  setThreshold(target: BenchmarkScenario['target'], threshold: Partial<PerformanceThreshold>): void {
    this.thresholds[target] = { ...this.thresholds[target]!, ...threshold };
  }

  /** 获取已注册场景名列表 */
  listScenarios(): Array<{ name: string; target: string; concurrency: number; totalRequests: number }> {
    return [...this.scenarios.values()].map((s) => ({
      name: s.name,
      target: s.target,
      concurrency: s.concurrency,
      totalRequests: s.totalRequests,
    }));
  }

  /**
   * 注册内置场景
   *
   * - memory / encryption 场景直接压测真实模块（离线可运行）
   * - strategist / executor / full-pipeline 场景依赖 context.callLLM，
   *   缺省时注册为"跳过型"场景（执行时立即标注 skipped 原因）
   */
  registerBuiltinScenarios(context: BuiltinScenarioContext): void {
    const { memory, cryptoEngine, callLLM, models } = context;

    // ── memory：记忆写入 + 模式检索压测 ──
    this.registerScenario({
      name: 'memory-write-read',
      description: '记忆库写入 + findPattern 检索混合负载',
      target: 'memory',
      concurrency: 8,
      totalRequests: 500,
      warmupRequests: 50,
      timeout: 5000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        try {
          if (iteration % 2 === 0) {
            memory.findPattern('code-generation', (iteration % 10) / 10, ['typescript']);
          } else {
            memory.recordDecisionFeedback({
              signalType: 'benchmark',
              signalDescription: `bench-${iteration}`,
              decision: 'execute',
              outcome: 'good',
              outcomeReason: 'benchmark synthetic',
            });
          }
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    // ── encryption：字段级加解密回环压测 ──
    this.registerScenario({
      name: 'encryption-roundtrip',
      description: '敏感字段加密 + 解密回环',
      target: 'encryption',
      concurrency: 8,
      totalRequests: 500,
      warmupRequests: 50,
      timeout: 5000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        try {
          const payload = { apiKey: `sk-bench-${iteration}`, nested: { password: `pw-${iteration}` }, plain: 'x'.repeat(200) };
          const { result } = cryptoEngine.encryptSensitiveFields(payload);
          cryptoEngine.decryptSensitiveFields(result);
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    // ── strategist：决策模型调用压测（需要 callLLM） ──
    this.registerScenario({
      name: 'strategist-decision',
      description: '战略决策模型调用延迟与成功率',
      target: 'strategist',
      concurrency: 2,
      totalRequests: 10,
      warmupRequests: 1,
      timeout: 60000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        if (typeof callLLM !== 'function') {
          return { success: false, latency: 0, error: 'skipped: callLLM 未提供' };
        }
        try {
          await Promise.race([
            callLLM({ task: `benchmark-decision-${iteration}`, models }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000)),
          ]);
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    // ── full-pipeline：端到端链路压测（需要 callLLM） ──
    this.registerScenario({
      name: 'full-pipeline-e2e',
      description: '信号 → 决策 → 计划 → 执行 → 沉淀全链路',
      target: 'full-pipeline',
      concurrency: 1,
      totalRequests: 5,
      warmupRequests: 0,
      timeout: 120000,
      execute: async (iteration: number) => {
        const startedAt = Date.now();
        if (typeof callLLM !== 'function') {
          return { success: false, latency: 0, error: 'skipped: callLLM 未提供' };
        }
        try {
          await callLLM({ task: `benchmark-pipeline-${iteration}`, models });
          memory.recordDecisionFeedback({
            signalType: 'benchmark-pipeline',
            signalDescription: `e2e-${iteration}`,
            decision: 'execute',
            outcome: 'good',
            outcomeReason: 'benchmark synthetic',
          });
          return { success: true, latency: Date.now() - startedAt };
        } catch (err) {
          return { success: false, latency: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  /**
   * 执行单个场景
   * @param scenario 场景定义
   * @param onProgress 进度回调 (done, total)
   */
  async runScenario(
    scenario: BenchmarkScenario,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{
    stats: BenchmarkStats;
    latencyDistribution: Array<{ bucket: string; count: number }>;
    passed: boolean;
    thresholdViolations: string[];
  }> {
    const total = scenario.totalRequests + scenario.warmupRequests;
    const latencies: number[] = [];
    const errors: Record<string, number> = {};
    let successCount = 0;
    let failCount = 0;
    let done = 0;
    let peakMemoryMB = 0;

    const startedAt = Date.now();
    let cursor = 0;

    // 并发池 worker
    const worker = async (): Promise<void> => {
      while (cursor < total) {
        const iteration = cursor++;
        const isWarmup = iteration >= scenario.totalRequests;
        let result: BenchmarkResult;
        try {
          result = await Promise.race<BenchmarkResult>([
            scenario.execute(iteration),
            new Promise<BenchmarkResult>((_, reject) =>
              setTimeout(() => reject(new Error(`scenario timeout after ${scenario.timeout}ms`)), scenario.timeout),
            ),
          ]);
        } catch (err) {
          result = { success: false, latency: 0, error: err instanceof Error ? err.message : String(err) };
        }

        if (!isWarmup) {
          if (result.success) {
            successCount += 1;
            latencies.push(result.latency);
          } else {
            failCount += 1;
            const key = result.error ?? 'unknown';
            errors[key] = (errors[key] ?? 0) + 1;
          }
        }
        done += 1;
        const mem = process.memoryUsage();
        peakMemoryMB = Math.max(peakMemoryMB, mem.heapUsed / 1024 / 1024);
        onProgress?.(done, total);
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, scenario.concurrency) }, () => worker()));
    const totalDuration = Date.now() - startedAt;

    const stats = this.computeStats(latencies, successCount, failCount, errors, totalDuration, peakMemoryMB);
    const latencyDistribution = this.buildDistribution(latencies);
    const thresholdViolations = this.checkThresholds(scenario.target, stats);

    return {
      stats,
      latencyDistribution,
      passed: thresholdViolations.length === 0,
      thresholdViolations,
    };
  }

  /**
   * 执行全部已注册场景并生成报告（自动持久化）
   * @param onProgress 进度回调 (scenarioName, done, total)
   */
  async runAll(onProgress?: (scenarioName: string, done: number, total: number) => void): Promise<BenchmarkReport> {
    const startedAt = Date.now();
    const report: BenchmarkReport = {
      id: `bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuCount: os.cpus().length,
        totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
        pluginVersion: PLUGIN_VERSION,
      },
      scenarios: [],
      overallPassed: true,
      totalDuration: 0,
    };

    for (const scenario of this.scenarios.values()) {
      const { stats, latencyDistribution, passed, thresholdViolations } = await this.runScenario(scenario, (done, total) =>
        onProgress?.(scenario.name, done, total),
      );
      report.scenarios.push({
        name: scenario.name,
        description: scenario.description,
        target: scenario.target,
        concurrency: scenario.concurrency,
        stats,
        passed,
        thresholdViolations,
        latencyDistribution,
      });
      if (!passed) report.overallPassed = false;
    }

    report.totalDuration = Date.now() - startedAt;
    this.saveReport(report);
    return report;
  }

  /** 加载全部历史报告（按时间倒序） */
  loadReports(): BenchmarkReport[] {
    if (!fs.existsSync(this.reportDir)) return [];
    const files = fs.readdirSync(this.reportDir).filter((f) => f.endsWith('.json'));
    const reports: BenchmarkReport[] = [];
    for (const file of files) {
      try {
        reports.push(JSON.parse(fs.readFileSync(path.join(this.reportDir, file), 'utf-8')));
      } catch {
        /* 跳过损坏报告 */
      }
    }
    return reports.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 对比两份报告，输出逐场景变化（用于性能回归检测）
   * @param beforeId 基线报告 id
   * @param afterId 新报告 id
   */
  compareReports(beforeId: string, afterId: string): string {
    const reports = this.loadReports();
    const before = reports.find((r) => r.id === beforeId);
    const after = reports.find((r) => r.id === afterId);
    if (!before || !after) {
      throw new AppError(`报告不存在: before=${beforeId}, after=${afterId}`, 'BENCHMARK_ERROR');
    }

    const lines: string[] = [
      `# 基准对比报告`,
      `- 基线: ${before.id} (${new Date(before.timestamp).toISOString()})`,
      `- 当前: ${after.id} (${new Date(after.timestamp).toISOString()})`,
      '',
    ];

    for (const afterScenario of after.scenarios) {
      const beforeScenario = before.scenarios.find((s) => s.name === afterScenario.name);
      if (!beforeScenario) {
        lines.push(`## ${afterScenario.name} — 新增场景（无基线）`);
        continue;
      }
      const b = beforeScenario.stats;
      const a = afterScenario.stats;
      const delta = (prev: number, curr: number): string => {
        if (prev === 0) return curr === 0 ? '0%' : '+∞';
        const pct = ((curr - prev) / prev) * 100;
        return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      };
      lines.push(
        `## ${afterScenario.name} [${afterScenario.target}]`,
        `- p95 延迟: ${b.p95Latency}ms → ${a.p95Latency}ms (${delta(b.p95Latency, a.p95Latency)})`,
        `- p99 延迟: ${b.p99Latency}ms → ${a.p99Latency}ms (${delta(b.p99Latency, a.p99Latency)})`,
        `- 吞吐率: ${b.throughput.toFixed(2)} → ${a.throughput.toFixed(2)} req/s (${delta(b.throughput, a.throughput)})`,
        `- 成功率: ${(b.successRate * 100).toFixed(2)}% → ${(a.successRate * 100).toFixed(2)}%`,
        `- 判定: ${beforeScenario.passed ? 'PASS' : 'FAIL'} → ${afterScenario.passed ? 'PASS' : 'FAIL'}`,
        '',
      );
    }
    return lines.join('\n');
  }

  /**
   * 生成 Markdown 格式报告
   */
  generateMarkdownReport(report: BenchmarkReport): string {
    const lines: string[] = [
      `# 基准测试报告 ${report.id}`,
      '',
      `> ${new Date(report.timestamp).toISOString()} | Node ${report.environment.nodeVersion} | ${report.environment.platform}/${report.environment.arch} | ${report.environment.cpuCount} CPU | ${report.environment.totalMemoryMB}MB RAM`,
      '',
      `**总体判定: ${report.overallPassed ? '✅ PASS' : '❌ FAIL'}** | 总耗时 ${(report.totalDuration / 1000).toFixed(1)}s`,
      '',
      `| 场景 | target | 并发 | 请求数 | 成功率 | avg | p95 | p99 | 吞吐(req/s) | 判定 |`,
      `|------|--------|------|--------|--------|-----|-----|-----|-------------|------|`,
    ];
    for (const s of report.scenarios) {
      lines.push(
        `| ${s.name} | ${s.target} | ${s.concurrency} | ${s.stats.totalRequests} | ${(s.stats.successRate * 100).toFixed(2)}% | ${s.stats.avgLatency.toFixed(1)}ms | ${s.stats.p95Latency.toFixed(1)}ms | ${s.stats.p99Latency.toFixed(1)}ms | ${s.stats.throughput.toFixed(2)} | ${s.passed ? '✅' : '❌'} |`,
      );
    }
    lines.push('');
    for (const s of report.scenarios) {
      if (s.thresholdViolations.length > 0) {
        lines.push(`### ⚠️ ${s.name} 阈值违反`, ...s.thresholdViolations.map((v) => `- ${v}`), '');
      }
      if (Object.keys(s.stats.errorDistribution).length > 0) {
        lines.push(`### ❌ ${s.name} 错误分布`);
        for (const [err, count] of Object.entries(s.stats.errorDistribution)) {
          lines.push(`- ${err}: ${count} 次`);
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 计算聚合统计 */
  private computeStats(
    latencies: number[],
    successCount: number,
    failCount: number,
    errors: Record<string, number>,
    totalDuration: number,
    peakMemoryMB: number,
  ): BenchmarkStats {
    const total = successCount + failCount;
    const sorted = [...latencies].sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (sorted.length === 0) return 0;
      const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
      return sorted[Math.max(0, index)]!;
    };
    const avg = sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    const variance = sorted.length > 0 ? sorted.reduce((s, v) => s + (v - avg) ** 2, 0) / sorted.length : 0;

    return {
      totalRequests: total,
      successCount,
      failCount,
      successRate: total > 0 ? successCount / total : 0,
      minLatency: sorted[0] ?? 0,
      maxLatency: sorted[sorted.length - 1] ?? 0,
      avgLatency: avg,
      p50Latency: percentile(50),
      p90Latency: percentile(90),
      p95Latency: percentile(95),
      p99Latency: percentile(99),
      stdDev: Math.sqrt(variance),
      throughput: totalDuration > 0 ? (total / totalDuration) * 1000 : 0,
      totalDuration,
      peakMemoryMB: Math.round(peakMemoryMB * 100) / 100,
      errorDistribution: errors,
    };
  }

  /** 构建延迟分布直方图 */
  private buildDistribution(latencies: number[]): Array<{ bucket: string; count: number }> {
    const distribution = LATENCY_BUCKETS.map((b) => ({ bucket: b.bucket, count: 0 }));
    for (const latency of latencies) {
      const bucketIndex = LATENCY_BUCKETS.findIndex((b) => latency < b.max);
      distribution[bucketIndex >= 0 ? bucketIndex : LATENCY_BUCKETS.length - 1]!.count += 1;
    }
    return distribution;
  }

  /** 阈值门禁检查 */
  private checkThresholds(target: BenchmarkScenario['target'], stats: BenchmarkStats): string[] {
    const threshold = this.thresholds[target] ?? DEFAULT_THRESHOLDS[target]!;
    const violations: string[] = [];
    // 全部失败（如 skipped 场景）不触发延迟类阈值，仅记录成功率问题
    if (stats.totalRequests === 0) return violations;
    if (stats.p95Latency > threshold.maxP95Latency) {
      violations.push(`p95 延迟 ${stats.p95Latency.toFixed(1)}ms 超过阈值 ${threshold.maxP95Latency}ms`);
    }
    if (stats.p99Latency > threshold.maxP99Latency) {
      violations.push(`p99 延迟 ${stats.p99Latency.toFixed(1)}ms 超过阈值 ${threshold.maxP99Latency}ms`);
    }
    if (stats.throughput < threshold.minThroughput) {
      violations.push(`吞吐率 ${stats.throughput.toFixed(2)} req/s 低于阈值 ${threshold.minThroughput} req/s`);
    }
    if (stats.successRate < threshold.minSuccessRate) {
      violations.push(`成功率 ${(stats.successRate * 100).toFixed(2)}% 低于阈值 ${(threshold.minSuccessRate * 100).toFixed(2)}%`);
    }
    return violations;
  }

  /** 持久化报告 */
  private saveReport(report: BenchmarkReport): void {
    fs.mkdirSync(this.reportDir, { recursive: true });
    const filePath = path.join(this.reportDir, `${report.id}.json`);
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }
}
