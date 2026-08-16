/**
 * verify-meta-cognition.mjs — 第四阶段「元认知层」闭环离线验证
 * （自我建模 × 元认知控制 = 双环自治进化架构外环）
 *
 * 外环数据流：
 *   操作环 + 进化环运行状态 --SelfModel 采集--> SystemMetrics
 *   --自我建模--> MentalReport（策略优劣势/记忆健康/进化效率/稳定性/改进证据/推荐调整）
 *   --MetaCognitiveController--> 保守调整（单旋钮单步长）→ 观察窗
 *   --效果判定--> 保留生效（commit）/ 自动回滚（rollback）；全程审计 + 手动接管
 *
 * 全程离线（不依赖 LLM 网络调用 / 定时器），验证断点：
 *
 *   A 系统指标采集：操作环（成功率/按类型分组）、记忆（三层计数/蒸馏水位）、
 *     进化环（部署/存活/发现速率/平均发现间隔）数值精确
 *   B 心智报告结构：四大摘要 + ISO 时间戳 + 报告序号；决策反馈按部署时间窗
 *     归因到策略版本（perVersion）
 *   C 记忆质量趋势：两报告间程序记忆增长 → growth 正数 + 层趋势 growing +
 *     memory-growth 改进证据（12 → 23 条）
 *   D 进化器效率计算：存活率（2/3）、发现速率（3/12）、平均发现间隔（时间差均值）
 *   E 自我改进证据全集：策略版本升级成功率对照 + 发现间隔缩短 + 操作环成功率
 *     提升 + 记忆增长（全部携带 before/after）
 *   F 推荐调整规则：盲点→变异率↑；存活率低→门禁↑+沙盒严格度↑；
 *     蒸馏积压→自动蒸馏阈值↓；情景增长而高级记忆零增长→蒸馏置信度门槛↓
 *   G 人类可读报告 + 趋势序列 + 报告历史持久化恢复（跨重启连续）
 *   H 真实组件联动：六个调节旋钮 read/write 落到 Reflector/PolicyEvolver/
 *     Sandbox/Optimizer 真实实例（调整的是进化机制本身）
 *   I 保守调整：单旋钮 + 单步长 + 进入观察窗（观察中不再应用新调整）
 *   J 判定保留：观察期满指标未劣化 → commit + effect 前后对比入审计
 *   K 判定劣化自动回滚：发现速率跌回 0 → 参数恢复前值 + effect.good=false
 *   L 手动干预：rollbackLastAdjustment 回滚已提交调整；setManualOverride
 *     手动接管（旋钮冻结）；setFrozen 全局冻结 → status=frozen
 *   M 审计持久化：新控制器实例从落盘文件恢复审计/计数器/接管状态
 *   N 自主心跳桥接：AutonomyLoop 每 N tick 低频触发元认知周期（外环节拍）
 *
 * 运行：npm run build && node scripts/verify-meta-cognition.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LongTermMemory,
  LLMClient,
  ModelScheduler,
  Optimizer,
  Reflector,
  ReflectionEngine,
  PolicyEvolver,
  Sandbox,
  SelfModel,
  MetaCognitiveController,
  AutonomyLoop,
  GoalEngine,
  MetaCognitionEngine,
  StrategyEvolutionEngine,
  createBaselinePolicy,
} from '../dist/index.mjs';

/** 确定性随机源（mulberry32） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3_600_000;
const stamp = Date.now();
const T0 = stamp - 10 * HOUR; // 稳定时间基线

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

// ══════════════════ Part 1：自我建模（可控状态源精确断言） ══════════════════

/** 决策反馈构造 */
const fb = (id, taskType, outcome, at) => ({
  id,
  timestamp: at,
  signalType: taskType,
  signalDescription: `${taskType} 任务`,
  decision: 'auto',
  outcome,
  outcomeReason: 'verify',
});

/** 可变状态源（SelfModel 采集器桥接；测试在报告之间推进状态模拟系统演化） */
const makeState = (overrides = {}) => ({
  feedback: [],
  memoryCounts: { patterns: 12, semantic: 5, procedural: 12, strategies: 8, profiles: 2, feedback: 40 },
  globalStats: {
    totalExecutions: 40,
    totalSuccesses: 30,
    totalFailures: 10,
    totalTokensUsed: 120_000,
    totalCostEstimate: 0.5,
    averageQualityScore: 0.78,
    averageExecutionTime: 1500,
  },
  distillation: { pendingSinceLastDistillation: 0 },
  evolverStatus: {
    currentPolicy: { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', createdAt: T0 },
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', gain: 0.012, deployedAt: T0 + 2 * HOUR },
    ],
    population: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    sigmaScale: 0.8,
    canary: undefined,
    totalCandidatesEvaluated: 24,
    totalCycles: 8,
    lastCycle: undefined,
  },
  ...overrides,
});

const collectorsOf = (state) => ({
  getEvolverStatus: () => state.evolverStatus,
  getMemoryStats: () => state.memoryCounts,
  getGlobalStats: () => state.globalStats,
  getDistillationProgress: () => state.distillation,
  getRecentFeedback: (limit) => state.feedback.slice(-limit),
});

// ── 断点 A + B：系统指标采集 + 心智报告结构与版本归因 ──
{
  const state = makeState();
  // 10 条反馈：code-generation 6 条（5 成功）、translation 4 条（3 成功）→ 整体 0.8
  state.feedback = [
    fb('f1', 'code-generation', 'excellent', T0 + HOUR),
    fb('f2', 'translation', 'acceptable', T0 + HOUR + 60_000),
    fb('f3', 'code-generation', 'good', T0 + 2.1 * HOUR), // T0+2.1H > v2 部署时间（T0+2H）→ 归因 v2 窗口
    fb('f4', 'code-generation', 'failed', T0 + 1.8 * HOUR),
    fb('f5', 'translation', 'poor', T0 + 1.9 * HOUR),
    // ↑ 基线策略窗口（4 条：2 成功 2 失败 = 0.5）
    fb('f6', 'code-generation', 'excellent', T0 + 2.5 * HOUR),
    fb('f7', 'translation', 'acceptable', T0 + 2.6 * HOUR),
    fb('f8', 'code-generation', 'excellent', T0 + 2.7 * HOUR),
    fb('f9', 'code-generation', 'good', T0 + 2.8 * HOUR),
    fb('f10', 'translation', 'acceptable', T0 + 2.9 * HOUR),
    // ↑ v2 策略窗口（6 条：6 成功 = 1.0）
  ];
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });

  const metrics = await selfModel.getSystemMetrics();
  check(
    '断点A 系统指标采集：操作环/记忆/进化环三视图数值精确',
    metrics.operational.successRate === 0.8 &&
      metrics.operational.sampleCount === 10 &&
      metrics.operational.perTaskType.length === 2 &&
      Math.abs(metrics.operational.perTaskType.find((t) => t.taskType === 'code-generation').successRate - 5 / 6) < 1e-9 &&
      metrics.memory.counts.procedural === 12 &&
      metrics.memory.counts.episodic === 12 &&
      metrics.evolver.deployedCount === 1 &&
      metrics.evolver.survivalRate === 1 &&
      Math.abs(metrics.evolver.discoveryRate - 1 / 8) < 1e-9 &&
      metrics.evolver.avgDiscoveryIntervalMs === 2 * HOUR,
    `成功率 8/10=${metrics.operational.successRate}；code-generation 5/6；程序记忆 12 条；部署 1 次（存活 100%），发现速率 ${metrics.evolver.discoveryRate.toFixed(3)}/轮，平均发现间隔 ${metrics.evolver.avgDiscoveryIntervalMs / HOUR}h`,
  );

  const report = await selfModel.generateMentalReport();
  const baseVer = report.strategyPerformance.perVersion.find((v) => v.version === 1);
  const v2Ver = report.strategyPerformance.perVersion.find((v) => v.version === 2);
  const isIso = !Number.isNaN(new Date(report.timestamp).getTime());
  check(
    '断点B 心智报告结构 + 决策反馈按部署时间窗归因到策略版本',
    isIso &&
      report.reportIndex === 1 &&
      typeof report.generatedAt === 'number' &&
      report.strategyPerformance.currentPolicyVersion === 2 &&
      baseVer?.samples === 4 &&
      Math.abs(baseVer?.successRate - 0.5) < 1e-9 &&
      v2Ver?.samples === 6 &&
      v2Ver?.successRate === 1 &&
      report.strategyPerformance.strengths.some((s) => s.taskType === 'code-generation') &&
      report.strategyPerformance.blindSpots.length === 0 &&
      report.memoryQuality.layers.length === 3 &&
      report.evolverEfficiency.deployedCount === 1 &&
      typeof report.systemStability.stabilityScore === 'number' &&
      Array.isArray(report.improvementEvidence) &&
      Array.isArray(report.recommendedAdjustments),
    `ISO 时间戳 ${report.timestamp.slice(0, 19)}；报告 #${report.reportIndex}；版本归因 v1=${(baseVer?.successRate * 100).toFixed(0)}%（${baseVer?.samples} 样本）、v2=${(v2Ver?.successRate * 100).toFixed(0)}%（${v2Ver?.samples} 样本）；优势 code-generation ${(5 / 6 * 100).toFixed(1)}%；无盲点`,
  );

  // ── 断点 G（前半）：人类可读报告 + 趋势序列 ──
  const formatted = selfModel.formatReport(report);
  const trend = selfModel.getTrendSeries();
  check(
    '断点G 人类可读心智报告（六节结构化输出）+ 趋势序列（图表数据）',
    formatted.includes('[策略表现]') &&
      formatted.includes('[记忆体系]') &&
      formatted.includes('[进化器效率]') &&
      formatted.includes('[系统稳定性]') &&
      formatted.includes('自我改进证据') &&
      trend.reportIndex.length === 1 &&
      trend.operationalSuccessRate[0] === 0.8 &&
      trend.proceduralCount[0] === 12 &&
      trend.discoveryRate.length === 1 &&
      trend.stabilityScore.length === 1,
    `formatReport 输出 ${formatted.split('\n').length} 行（策略表现/记忆体系/进化器效率/系统稳定性/证据/建议六节）；趋势序列覆盖成功率/程序记忆/发现速率/稳定分（报告 #1 起点）`,
  );
}

// ── 断点 C：记忆质量趋势 + memory-growth 证据 ──
{
  const state = makeState({ feedback: [fb('f1', 'code-generation', 'good', T0 + HOUR)] });
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });
  await selfModel.generateMentalReport(); // 基线报告
  // 模拟知识蒸馏：程序记忆 12 → 23，语义 5 → 7，情景 12 → 15
  state.memoryCounts = { ...state.memoryCounts, procedural: 23, semantic: 7, patterns: 15 };
  const report2 = await selfModel.generateMentalReport();
  const procLayer = report2.memoryQuality.layers.find((l) => l.layer === 'procedural');
  const evidence = report2.improvementEvidence.find((e) => e.kind === 'memory-growth' && e.after === 23);
  check(
    '断点C 记忆质量趋势：程序记忆 12→23 条 → 层趋势 growing + growth 增量 + 改进证据',
    report2.reportIndex === 2 &&
      report2.memoryQuality.growth.procedural === 11 &&
      report2.memoryQuality.growth.semantic === 2 &&
      procLayer?.trend === 'growing' &&
      evidence !== undefined &&
      evidence.before === 12 &&
      evidence.after === 23 &&
      evidence.unit === '条' &&
      evidence.description.includes('12 条增加到 23 条'),
    `growth: 程序 +11 / 语义 +2 / 情景 +3；procedural 层 trend=growing；证据「${evidence?.description}」（before=12, after=23）`,
  );
}

// ── 断点 D：进化器效率指标计算 ──
{
  const state = makeState({
    feedback: [fb('f1', 'code-generation', 'good', T0 + HOUR)],
  });
  // 部署链：基准@T0 → d1@+3H → d2@+4.5H(被回滚) → d3@+5H
  state.evolverStatus = {
    ...state.evolverStatus,
    totalCycles: 12,
    currentPolicy: { id: 'p-d3', version: 4, generation: 3, origin: 'crossover', createdAt: T0 + 5 * HOUR },
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', gain: 0.012, deployedAt: T0 + 3 * HOUR },
      { id: 'p-v3', version: 3, generation: 2, origin: 'mutation', gain: 0.008, deployedAt: T0 + 4.5 * HOUR, rolledBackAt: T0 + 4.8 * HOUR },
      { id: 'p-d3', version: 4, generation: 3, origin: 'crossover', gain: 0.015, deployedAt: T0 + 5 * HOUR },
    ],
  };
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });
  const metrics = await selfModel.getSystemMetrics();
  const expectedInterval = (3 * HOUR + 1.5 * HOUR + 0.5 * HOUR) / 3; // 相邻部署差均值
  check(
    '断点D 进化器效率：存活率 / 发现速率 / 平均发现间隔（wall-clock）',
    metrics.evolver.deployedCount === 3 &&
      metrics.evolver.rolledBackCount === 1 &&
      Math.abs(metrics.evolver.survivalRate - 2 / 3) < 1e-9 &&
      Math.abs(metrics.evolver.discoveryRate - 3 / 12) < 1e-9 &&
      Math.abs(metrics.evolver.avgDiscoveryIntervalMs - expectedInterval) < 1e-6 &&
      Math.abs(metrics.evolver.avgDeployedGain - (0.012 + 0.008 + 0.015) / 3) < 1e-9,
    `部署 3 次（1 次被金丝雀回滚）→ 存活率 ${(metrics.evolver.survivalRate * 100).toFixed(0)}%；发现速率 3/12=${metrics.evolver.discoveryRate.toFixed(3)}/轮；平均发现间隔 ${(metrics.evolver.avgDiscoveryIntervalMs / HOUR).toFixed(2)}h；平均部署收益 +${metrics.evolver.avgDeployedGain.toFixed(4)}`,
  );
}

// ── 断点 E：自我改进证据全集 ──
{
  const state = makeState();
  // 报告 1：v2 窗口 6 条 5 成功（0.833），整体 10 条 7 成功（0.7）
  state.feedback = [
    fb('b1', 'code-generation', 'good', T0 + HOUR),
    fb('b2', 'code-generation', 'good', T0 + 1.2 * HOUR),
    fb('b3', 'code-generation', 'failed', T0 + 1.4 * HOUR),
    fb('b4', 'code-generation', 'poor', T0 + 1.6 * HOUR),
    // ↑ v1 窗口（4 条 2 成功）
    fb('v1', 'code-generation', 'good', T0 + 3.2 * HOUR),
    fb('v2', 'code-generation', 'good', T0 + 3.3 * HOUR),
    fb('v3', 'code-generation', 'excellent', T0 + 3.4 * HOUR),
    fb('v4', 'code-generation', 'failed', T0 + 3.5 * HOUR),
    fb('v5', 'code-generation', 'good', T0 + 3.6 * HOUR),
    fb('v6', 'code-generation', 'acceptable', T0 + 3.7 * HOUR),
    // ↑ v2 窗口（6 条 5 成功，v2 部署于 T0+3H）
  ];
  state.evolverStatus = {
    ...state.evolverStatus,
    totalCycles: 8,
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', gain: 0.012, deployedAt: T0 + 3 * HOUR },
    ],
  };
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });
  await selfModel.generateMentalReport(); // 报告 1（对比基线）

  // 系统演化：v3 部署（间隔缩短到 1.5h）+ v3 窗口 6 条全胜 + 整体成功率提升
  state.evolverStatus = {
    ...state.evolverStatus,
    currentPolicy: { id: 'p-v3', version: 3, generation: 2, origin: 'crossover', createdAt: T0 + 4.5 * HOUR },
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', gain: 0.012, deployedAt: T0 + 3 * HOUR },
      { id: 'p-v3', version: 3, generation: 2, origin: 'crossover', gain: 0.02, deployedAt: T0 + 4.5 * HOUR },
    ],
  };
  state.feedback = [
    ...state.feedback,
    fb('n1', 'code-generation', 'excellent', T0 + 4.6 * HOUR),
    fb('n2', 'code-generation', 'excellent', T0 + 4.7 * HOUR),
    fb('n3', 'code-generation', 'good', T0 + 4.8 * HOUR),
    fb('n4', 'code-generation', 'excellent', T0 + 4.9 * HOUR),
    fb('n5', 'code-generation', 'good', T0 + 5 * HOUR),
    fb('n6', 'code-generation', 'excellent', T0 + 5.1 * HOUR),
  ];
  state.memoryCounts = { ...state.memoryCounts, procedural: 17 };

  const report2 = await selfModel.generateMentalReport();
  const kinds = new Set(report2.improvementEvidence.map((e) => e.kind));
  const policyEv = report2.improvementEvidence.find((e) => e.kind === 'policy-upgrade');
  const effEv = report2.improvementEvidence.find((e) => e.kind === 'evolver-efficiency');
  const qualityEv = report2.improvementEvidence.find((e) => e.kind === 'quality-gain');
  check(
    '断点E 自我改进证据全集：版本升级成功率对照 + 发现间隔缩短 + 操作环成功率提升',
    kinds.has('policy-upgrade') &&
      kinds.has('evolver-efficiency') &&
      kinds.has('quality-gain') &&
      kinds.has('memory-growth') &&
      policyEv?.before !== undefined &&
      policyEv?.after === 1 &&
      effEv?.before === 3 * HOUR &&
      effEv?.after === 2.25 * HOUR &&
      qualityEv?.before === 0.7 &&
      report2.strategyPerformance.operational.successRate === 13 / 16 &&
      policyEv?.description.includes('v2 升级到 v3'),
    `策略 v2→v3：成功率 ${(policyEv?.before * 100).toFixed(1)}% → ${(policyEv.after * 100).toFixed(0)}%；发现间隔 ${(effEv?.before / HOUR).toFixed(1)}h → ${(effEv?.after / HOUR).toFixed(2)}h；操作环成功率 70.0% → ${(report2.strategyPerformance.operational.successRate * 100).toFixed(1)}%；程序记忆 12→17 条——四类证据全部携带 before/after`,
  );
}

// ── 断点 F：推荐调整规则 ──
{
  // F1 盲点 → 变异率↑
  const s1 = makeState({
    feedback: [
      fb('x1', 'refactor', 'failed', T0 + HOUR),
      fb('x2', 'refactor', 'failed', T0 + 1.1 * HOUR),
      fb('x3', 'refactor', 'poor', T0 + 1.2 * HOUR),
      fb('x4', 'refactor', 'good', T0 + 1.3 * HOUR),
    ],
  });
  const r1 = await new SelfModel({ collectors: collectorsOf(s1) }).generateMentalReport();
  const blindRec = r1.recommendedAdjustments.find((a) => a.knob === 'evolver.mutationRate');

  // F2 存活率低（3 部署 2 回滚）→ 门禁↑ + 沙盒严格度↑
  const s2 = makeState({
    feedback: [fb('y1', 'code-generation', 'good', T0 + HOUR), fb('y2', 'code-generation', 'excellent', T0 + 1.1 * HOUR), fb('y3', 'code-generation', 'good', T0 + 1.2 * HOUR)],
  });
  s2.evolverStatus = {
    ...s2.evolverStatus,
    totalCycles: 12,
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', gain: 0.012, deployedAt: T0 + 3 * HOUR, rolledBackAt: T0 + 3.5 * HOUR },
      { id: 'p-v3', version: 3, generation: 2, origin: 'mutation', gain: 0.01, deployedAt: T0 + 4 * HOUR, rolledBackAt: T0 + 4.5 * HOUR },
      { id: 'p-v4', version: 4, generation: 3, origin: 'mutation', gain: 0.014, deployedAt: T0 + 5 * HOUR },
    ],
  };
  const r2 = await new SelfModel({ collectors: collectorsOf(s2) }).generateMentalReport();
  const minGainRec = r2.recommendedAdjustments.find((a) => a.knob === 'evolver.minGain');
  const seedsRec = r2.recommendedAdjustments.find((a) => a.knob === 'sandbox.evaluationSeeds');

  // F3 蒸馏积压 → 自动蒸馏阈值↓
  const s3 = makeState({ feedback: [fb('z1', 'code-generation', 'good', T0 + HOUR)] });
  s3.distillation = { pendingSinceLastDistillation: 12 };
  const r3 = await new SelfModel({ collectors: collectorsOf(s3) }).generateMentalReport();
  const distillRec = r3.recommendedAdjustments.find((a) => a.knob === 'reflector.autoDistillThreshold');

  // F4 情景增长而高级记忆零增长 → 蒸馏置信度门槛↓（需两份报告形成 growth）
  const s4 = makeState({ feedback: [fb('w1', 'code-generation', 'good', T0 + HOUR)] });
  const sm4 = new SelfModel({ collectors: collectorsOf(s4) });
  await sm4.generateMentalReport();
  s4.memoryCounts = { ...s4.memoryCounts, patterns: 15 }; // 情景 +3，语义/程序不变
  const r4 = await sm4.generateMentalReport();
  const confRec = r4.recommendedAdjustments.find((a) => a.knob === 'reflector.distillMinConfidence');

  check(
    '断点F 推荐调整规则：盲点/低存活/蒸馏积压/高级记忆停滞 四类诊断各对其旋钮',
    blindRec?.direction === 'up' &&
      blindRec.reason.includes('refactor') &&
      minGainRec?.direction === 'up' &&
      seedsRec?.direction === 'up' &&
      r2.recommendedAdjustments[0].priority >= 0.85 &&
      distillRec?.direction === 'down' &&
      confRec?.direction === 'down',
    `盲点（refactor 25% 成功率）→ 变异率↑；存活率 33%（2/3 回滚）→ 门禁↑（p=${minGainRec?.priority}）+ 沙盒种子↑（p=${seedsRec?.priority}，Top 优先级 ${r2.recommendedAdjustments[0].priority}）；积压 12 条 → 蒸馏阈值↓；情景 +3 高级零增长 → 置信度门槛↓`,
  );
}

// ── 断点 G（后半）：报告历史持久化恢复 ──
{
  const persistPath = path.join(os.tmpdir(), `dsh-verify-mc-reports-${stamp}.json`);
  fs.rmSync(persistPath, { force: true });
  const state = makeState({ feedback: [fb('p1', 'code-generation', 'good', T0 + HOUR)] });
  const sm1 = new SelfModel({ collectors: collectorsOf(state), config: { persistPath } });
  await sm1.generateMentalReport();
  await sm1.generateMentalReport();
  const sm2 = new SelfModel({ collectors: collectorsOf(state), config: { persistPath } });
  const restored = await sm2.generateMentalReport();
  check(
    '断点G 报告历史持久化：重启恢复两份历史，报告序号跨重启连续（#3）',
    sm2.getReportHistory().length === 3 && restored.reportIndex === 3,
    `新实例从 ${path.basename(persistPath)} 恢复 2 份历史 → 第 3 份报告 reportIndex=${restored.reportIndex}（趋势分析跨重启连续）`,
  );
  fs.rmSync(persistPath, { force: true });
}

// ══════════════════ Part 2：元认知控制器（真实组件联动） ══════════════════

const memPath = path.join(os.tmpdir(), `dsh-verify-mc-mem-${stamp}.json`);
const memory = new LongTermMemory(memPath);
const llm = new LLMClient();
llm.registerModel({ id: 'model-a', endpoint: 'http://localhost:11434/v1', initialCapabilities: { taskScores: { general: 0.8 } } });
const scheduler = new ModelScheduler({ llm, memory });
const optimizer = new Optimizer({ memory, policyProvider: () => scheduler.getPolicy() });
const reflectionEngine = new ReflectionEngine();
const reflector = new Reflector({ memory, reflection: reflectionEngine });
const baselinePolicy = createBaselinePolicy('policy-mc-baseline', 1);
const policyEvolver = new PolicyEvolver({ rng: mulberry32(42) }, baselinePolicy);
const policySandbox = new Sandbox({ models: [{ id: 'model-a', taskScores: { general: 0.8 }, avgLatencyMs: 800, avgTokens: 600, maxConcurrency: 4 }], tasks: [] });

/** 与 index.ts 相同的六旋钮注册（真实组件 read/write） */
const buildKnobs = () => [
  {
    id: 'reflector.autoDistillThreshold', label: '反思器自动蒸馏阈值', category: 'reflector',
    min: 2, max: 20, step: 1, integer: true,
    read: () => reflector.getConfig().autoDistillThreshold ?? 5,
    write: (v) => reflector.updateConfig({ autoDistillThreshold: v }),
    judgeMetric: 'pendingDistillation', higherIsBetter: false,
  },
  {
    id: 'reflector.distillMinConfidence', label: '知识蒸馏写入置信度门槛', category: 'reflector',
    min: 0.4, max: 0.8, step: 0.05,
    read: () => reflector.getConfig().distillMinConfidence ?? 0.6,
    write: (v) => reflector.updateConfig({ distillMinConfidence: v }),
    judgeMetric: 'proceduralGrowth', higherIsBetter: true,
  },
  {
    id: 'evolver.mutationRate', label: '进化器变异率', category: 'evolver',
    min: 0.2, max: 0.9, step: 0.1,
    read: () => policyEvolver.getTunableParams().mutationRate,
    write: (v) => policyEvolver.updateConfig({ mutationRate: v }),
    judgeMetric: 'discoveryRate', higherIsBetter: true,
  },
  {
    id: 'evolver.minGain', label: '进化器部署门禁（选择压力）', category: 'evolver',
    min: 0.001, max: 0.05, step: 0.005,
    read: () => policyEvolver.getTunableParams().minGain,
    write: (v) => policyEvolver.updateConfig({ minGain: v }),
    judgeMetric: 'survivalRate', higherIsBetter: true,
  },
  {
    id: 'sandbox.evaluationSeeds', label: '沙盒多种子评估严格度', category: 'sandbox',
    min: 1, max: 7, step: 1, integer: true,
    read: () => policySandbox.getConfig().evaluationSeeds ?? 3,
    write: (v) => policySandbox.updateConfig({ evaluationSeeds: v }),
    judgeMetric: 'survivalRate', higherIsBetter: true,
  },
  {
    id: 'optimizer.memoryFastPathThreshold', label: '记忆快路径复用门槛', category: 'memory',
    min: 0.7, max: 0.95, step: 0.05,
    read: () => optimizer.getConfig().memoryFastPathThreshold ?? 0.9,
    write: (v) => optimizer.updateConfig({ memoryFastPathThreshold: v }),
    judgeMetric: 'operationalSuccessRate', higherIsBetter: true,
  },
];

// ── 断点 H：真实组件联动（六旋钮 read/write 落地） ──
{
  const state = makeState({ feedback: [fb('h0', 'code-generation', 'good', T0 + HOUR)] });
  const probe = new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(state) }),
    knobs: buildKnobs(),
  });
  // 初始读值与真实组件一致
  const knobsSnapshot = probe.getState().knobs;
  const initialOk =
    knobsSnapshot.find((k) => k.id === 'reflector.autoDistillThreshold')?.current === 5 &&
    knobsSnapshot.find((k) => k.id === 'evolver.mutationRate')?.current === 0.6 &&
    knobsSnapshot.find((k) => k.id === 'evolver.minGain')?.current === 0.02 &&
    knobsSnapshot.find((k) => k.id === 'sandbox.evaluationSeeds')?.current === 3 &&
    knobsSnapshot.find((k) => k.id === 'optimizer.memoryFastPathThreshold')?.current === 0.9;
  // 经手动覆盖写入（唯一写路径与自动调整共用 write 回调）→ 组件真实生效
  probe.setManualOverride('reflector.autoDistillThreshold', 8);
  probe.setManualOverride('reflector.distillMinConfidence', 0.55);
  probe.setManualOverride('evolver.minGain', 0.01);
  probe.setManualOverride('sandbox.evaluationSeeds', 5);
  probe.setManualOverride('optimizer.memoryFastPathThreshold', 0.85);
  probe.setManualOverride('evolver.mutationRate', 0.6); // 复位，供后续断点使用
  const writeOk =
    reflector.getConfig().autoDistillThreshold === 8 &&
    reflector.getConfig().distillMinConfidence === 0.55 &&
    policyEvolver.getTunableParams().minGain === 0.01 &&
    policySandbox.getConfig().evaluationSeeds === 5 &&
    optimizer.getConfig().memoryFastPathThreshold === 0.85 &&
    policyEvolver.getTunableParams().mutationRate === 0.6;
  check(
    '断点H 真实组件联动：反思器/进化器/沙盒/优化器旋钮读写落地（调整进化机制本身）',
    initialOk && writeOk,
    `六旋钮初始读值与组件一致（蒸馏阈值 5/置信度 0.6/变异率 0.6/门禁 0.02/种子 3/快路径 0.9）；写入后 Reflector=${reflector.getConfig().autoDistillThreshold}/${reflector.getConfig().distillMinConfidence}，PolicyEvolver=${policyEvolver.getTunableParams().mutationRate}/${policyEvolver.getTunableParams().minGain}，Sandbox seeds=${policySandbox.getConfig().evaluationSeeds}，Optimizer=${optimizer.getConfig().memoryFastPathThreshold}`,
  );
}

// ── 断点 I ~ M：保守调整状态机 + 判定 + 回滚 + 审计 ──
{
  const auditPath = path.join(os.tmpdir(), `dsh-verify-mc-audit-${stamp}.json`);
  fs.rmSync(auditPath, { force: true });

  // 控制器观察源：盲点任务类型存在 → 首选推荐 = 变异率↑（优先级 0.8）
  const state = makeState({
    feedback: [
      fb('c1', 'refactor', 'failed', T0 + HOUR),
      fb('c2', 'refactor', 'failed', T0 + 1.1 * HOUR),
      fb('c3', 'refactor', 'poor', T0 + 1.2 * HOUR),
      fb('c4', 'refactor', 'good', T0 + 1.3 * HOUR),
    ],
  });
  // 进化零部署（discoveryRate=0，判定基线为 0）且 deployedCount < 2 → 不触发门禁类推荐
  state.evolverStatus = {
    ...state.evolverStatus,
    deployedHistory: [{ id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 }],
  };
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });
  const controller = new MetaCognitiveController({
    selfModel,
    knobs: buildKnobs(),
    config: { persistPath: auditPath, observationReports: 2, degradationTolerance: 0.02 },
  });

  // ── I：第 1 轮 → 保守应用（单旋钮单步长）+ 进入观察窗 ──
  const round1 = await controller.evaluateAndAdjust();
  const adjustEntry = controller.getAuditTrail().find((e) => e.type === 'adjust');
  check(
    '断点I 保守调整：单旋钮 + 单步长（0.6→0.7）+ 进入观察窗',
    round1.status === 'adjusted' &&
      round1.applied.length === 1 &&
      round1.applied[0].knob === 'evolver.mutationRate' &&
      round1.applied[0].from === 0.6 &&
      round1.applied[0].to === 0.7 &&
      policyEvolver.getTunableParams().mutationRate === 0.7 &&
      round1.observation?.reportsSeen === 0 &&
      round1.observation?.reportsNeeded === 2 &&
      adjustEntry?.reportIndex === round1.reportIndex,
    `报告 #${round1.reportIndex} 推荐「变异率↑」→ 应用 0.6→0.7（步长 0.1，仅此一个旋钮），真实进化器 mutationRate=${policyEvolver.getTunableParams().mutationRate}；观察窗 0/2；审计 adjust#1 关联报告序号`,
  );

  // ── I：观察窗内第 2 轮 → observing，不再应用新调整 ──
  const round2 = await controller.evaluateAndAdjust();
  check(
    '断点I 观察窗纪律：观察期内不再应用新调整（等效果数据）',
    round2.status === 'observing' &&
      round2.applied.length === 0 &&
      round2.observation?.reportsSeen === 1 &&
      policyEvolver.getTunableParams().mutationRate === 0.7,
    `第 2 次调用 status=observing（1/2），本轮零调整——保守原则：先观察效果再继续`,
  );

  // ── J：第 3 轮 → 观察期满，发现速率 0→0.1（改善）→ commit ──
  state.evolverStatus = {
    ...state.evolverStatus,
    totalCycles: 10,
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', gain: 0.012, deployedAt: T0 + 9 * HOUR },
    ],
  };
  const round3 = await controller.evaluateAndAdjust();
  const commitEntry = controller.getAuditTrail().find((e) => e.type === 'commit');
  check(
    '断点J 判定保留：观察期满指标改善（发现速率 0→0.1）→ commit + effect 前后对比入审计',
    round3.status === 'committed' &&
      round3.committed?.knob === 'evolver.mutationRate' &&
      round3.committed?.effect.before === 0 &&
      Math.abs(round3.committed?.effect.after - 0.1) < 1e-9 &&
      round3.committed?.effect.good === true &&
      commitEntry?.effect?.delta === 0.1 &&
      policyEvolver.getTunableParams().mutationRate === 0.7,
    `judgeMetric=discoveryRate：0 → 0.1（Δ+0.1 ≥ 容忍 -0.02）→ 变异率 0.7 保留生效；审计 commit 含 effect{before:0, after:0.1, good:true}`,
  );

  // ── 第 4 轮 → 盲点仍在 → 再次应用（0.7→0.8），基线 discoveryRate=0.1 ──
  const round4 = await controller.evaluateAndAdjust();
  check(
    '断点I/J 后续轮次：空闲后继续下一轮保守调整（0.7→0.8）',
    round4.status === 'adjusted' && round4.applied[0].from === 0.7 && round4.applied[0].to === 0.8,
    `commit 后控制器空闲 → 报告 #${round4.reportIndex} 再次单步调整变异率 0.7→0.8，观察窗重启`,
  );
  await controller.evaluateAndAdjust(); // 第 5 轮：观察中（1/2）

  // ── K：第 6 轮 → 观察期满，发现速率跌回 0（劣化超容忍）→ 自动回滚 ──
  state.evolverStatus = {
    ...state.evolverStatus,
    deployedHistory: [{ id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 }],
  };
  const round6 = await controller.evaluateAndAdjust();
  const rollbackEntry = controller.getAuditTrail().filter((e) => e.type === 'rollback').pop();
  check(
    '断点K 判定劣化自动回滚：发现速率 0.1→0（劣化超容忍 0.02）→ 参数恢复 0.7 + effect.good=false',
    round6.status === 'rolled-back' &&
      round6.rolledBack?.knob === 'evolver.mutationRate' &&
      round6.rolledBack?.from === 0.8 &&
      round6.rolledBack?.to === 0.7 &&
      round6.rolledBack?.effect.good === false &&
      policyEvolver.getTunableParams().mutationRate === 0.7 &&
      rollbackEntry?.effect?.delta === -0.1,
    `judgeMetric 0.1 → 0（Δ-0.1 < -0.02）→ 变异率自动回滚 0.8→0.7（真实组件已恢复）；审计 rollback 含 effect{good:false}`,
  );

  // ── L：手动回滚已提交调整（0.6→0.7 是最近未被回滚的 adjust） ──
  const manualRollback = await controller.rollbackLastAdjustment();
  check(
    '断点L 手动回滚：rollbackLastAdjustment 恢复最近一次已提交调整（0.7→0.6）',
    manualRollback.success === true &&
      manualRollback.knob === 'evolver.mutationRate' &&
      manualRollback.from === 0.7 &&
      manualRollback.to === 0.6 &&
      policyEvolver.getTunableParams().mutationRate === 0.6,
    `无观察中调整 → 回溯审计找到 0.6→0.7（其后的 0.7→0.8 已被自动回滚去重）→ 写回 ${policyEvolver.getTunableParams().mutationRate}：${manualRollback.message}`,
  );

  // ── L：手动覆盖 + 旋钮接管 ──
  const override = controller.setManualOverride('evolver.mutationRate', 0.5);
  const stateAfterOverride = controller.getState();
  // ── L：全局冻结 ──
  controller.setFrozen(true);
  const frozenRound = await controller.evaluateAndAdjust();
  controller.setFrozen(false);
  check(
    '断点L 手动接管优先：override 覆盖并冻结旋钮；全局 freeze → status=frozen',
    override.success === true &&
      policyEvolver.getTunableParams().mutationRate === 0.5 &&
      stateAfterOverride.manuallyFrozenKnobs.includes('evolver.mutationRate') &&
      stateAfterOverride.knobs.find((k) => k.id === 'evolver.mutationRate')?.manuallyFrozen === true &&
      frozenRound.status === 'frozen' &&
      frozenRound.applied.length === 0 &&
      typeof frozenRound.skippedReason === 'string',
    `override 将变异率设为 0.5（自动调整对该旋钮冻结）；setFrozen(true) 后 evaluateAndAdjust → ${frozenRound.status}（${frozenRound.skippedReason}），零应用`,
  );

  // ── M：审计持久化恢复 ──
  const restored = new MetaCognitiveController({
    selfModel,
    knobs: buildKnobs(),
    config: { persistPath: auditPath, observationReports: 2, degradationTolerance: 0.02 },
  });
  const restoredState = restored.getState();
  const auditTypes = new Set(restoredState.auditTrail.map((e) => e.type));
  check(
    '断点M 审计持久化：新控制器实例恢复审计/计数器/接管状态（全量可追溯）',
    restoredState.totalAdjustments === 2 &&
      restoredState.totalRollbacks === 2 &&
      restoredState.totalCommits === 1 &&
      restoredState.manuallyFrozenKnobs.includes('evolver.mutationRate') &&
      restoredState.frozen === false &&
      auditTypes.has('adjust') &&
      auditTypes.has('commit') &&
      auditTypes.has('rollback') &&
      auditTypes.has('manual-override') &&
      auditTypes.has('freeze'),
    `重启后恢复：adjust×${restoredState.totalAdjustments}、rollback×${restoredState.totalRollbacks}（自动+手动）、commit×${restoredState.totalCommits}、接管旋钮 [${restoredState.manuallyFrozenKnobs.join(', ')}]、冻结=false；审计类型 {${[...auditTypes].join('、')}}`,
  );
  fs.rmSync(auditPath, { force: true });
}

// ══════════════════ Part 3：自主心跳桥接（外环节拍） ══════════════════
{
  let metaCycles = 0;
  const loop = new AutonomyLoop({
    config: { metaCognitionEveryTicks: 3, enableStrategyEvolution: true, enableExploration: false },
    goalEngine: new GoalEngine(),
    metaCognition: new MetaCognitionEngine(),
    evolution: new StrategyEvolutionEngine({ rng: mulberry32(7) }),
    collectKpi: () => ({
      timestamp: Date.now(),
      successRate: 0.95,
      avgQuality: 0.88,
      avgLatency: 800,
      cacheHitRate: 0.3,
      modelSuccessRates: {},
      activeExecutions: 0,
    }),
    dispatchSubtask: (subtask) => `sig-${subtask.id}`,
    maintainer: {
      distillExperience: () => 0,
      applyForgettingCurve: () => ({ decayed: 0, forgotten: 0 }),
    },
    lessonProvider: () => [],
    metaCognitionBridge: {
      runMetaCycle: async () => {
        metaCycles += 1;
        return { cycle: metaCycles };
      },
    },
  });
  for (let i = 0; i < 7; i += 1) await loop.tick();
  check(
    '断点N 自主心跳桥接：每 3 轮心跳低频触发元认知周期（7 tick → 2 次外环）',
    metaCycles === 2,
    `心跳 7 轮（tick 3、6 触发）→ 元认知周期执行 ${metaCycles} 次：内环（进化）每拍运行，外环（元认知）低频运行——双环节拍分层`,
  );
}

// ══════════════════ 结果输出 ══════════════════
console.log('\n=== 第四阶段「元认知层：自我建模 × 元认知控制」闭环验证 ===\n');
console.log('=== 断言结果 ===\n');
let allPass = true;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ${c.detail}`);
  if (!c.pass) allPass = false;
}

// 清理
memory.dispose();
fs.rmSync(memPath, { force: true });
fs.rmSync(memPath.replace(/\.json$/, '.db'), { force: true });
llm.dispose();

console.log(
  allPass
    ? '\n✓ 元认知层全部通过：系统不仅能进化策略（内环），还能观察、理解并改进自身的进化机制（外环）——自我建模（心智报告/趋势/证据）× 元认知控制（保守调整/观察判定/自动回滚/审计/手动接管），双环自治进化架构完成。'
    : '\n✗ 存在未通过的断言，请检查。',
);
process.exit(allPass ? 0 : 1);
