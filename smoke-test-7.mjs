/**
 * smoke-test-7.mjs — 自主智能三大新支柱冒烟验证
 *
 * 覆盖：
 * 1. 世界模型（预见）：到达规律学习 + 到达预测 + 关联矩阵 + 趋势检测 + 预测校准
 * 2. 好奇心引擎（内在动机）：知识盲区扫描 + 新颖度排序 + 探索预算 + 探索回写
 * 3. 安全治理器（边界）：限流 + 预算 + 熔断器 + 置信度门控 + Kill Switch
 * 4. 心跳循环集成：预见洞察 + 探索派发 + 治理拦截 + 自省报告
 * 5. 端到端：cordis 插件集成 + query_memory 新类型 + manage_autonomy 新动作
 *
 * 全程离线：fetchImpl / nodeRunner / decomposer 均注入模拟实现。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import plugin, {
  WorldModel,
  CuriosityEngine,
  SafetyGovernor,
  GoalEngine,
  MetaCognitionEngine,
  StrategyEvolutionEngine,
  AutonomyLoop,
} from './dist/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout, label) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${label}`);
    await sleep(50);
  }
}

setTimeout(() => {
  console.error('❌ 测试全局超时（60s）');
  process.exit(1);
}, 60_000).unref();

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ─────────────────────────── 1. 世界模型 ───────────────────────────
console.log('\n[1] 世界模型（预见）');

{
  const wm = new WorldModel({ minSamplesForTrend: 4 });
  const now = Date.now();

  // 到达规律学习
  for (let i = 0; i < 10; i += 1) wm.observeArrival('code-change', now - (10 - i) * 20_000);
  for (let i = 0; i < 3; i += 1) wm.observeArrival('error-log', now - (3 - i) * 30_000);
  const summary = wm.getSummary();
  assert.equal(summary.trackedTypes, 2);
  assert.equal(summary.totalArrivals, 13);
  ok(`到达规律学习：${summary.trackedTypes} 类型 / ${summary.totalArrivals} 次到达`);

  // 到达预测
  const predictions = wm.predictArrivals(5 * 60_000);
  assert.ok(predictions.length === 2);
  assert.ok(predictions[0].expectedCount >= predictions[1].expectedCount, '应按期望到达数降序');
  assert.ok(predictions[0].confidence > 0 && predictions[0].confidence <= 1);
  ok(`到达预测：${predictions[0].type} 期望 ${predictions[0].expectedCount}（置信度 ${predictions[0].confidence.toFixed(2)}）`);

  // 关联矩阵（code-change 与 error-log 时间邻近共现）
  const correlations = wm.getCorrelations(0);
  assert.ok(correlations.length >= 1, '应检测到类型关联');
  assert.ok(correlations[0].strength > 0);
  ok(`关联矩阵：${correlations[0].typeA} ↔ ${correlations[0].typeB}（强度 ${correlations[0].strength}）`);

  // 趋势检测（构造上升趋势：后半段密集到达）
  const wm2 = new WorldModel({ minSamplesForTrend: 4, risingSlopeThreshold: 0.01 });
  const base = Date.now();
  // 前 5 分钟稀疏，后 5 分钟密集
  for (let i = 0; i < 3; i += 1) wm2.observeArrival('burst-type', base - 9 * 60_000 + i * 60_000);
  for (let i = 0; i < 12; i += 1) wm2.observeArrival('burst-type', base - 4 * 60_000 + i * 20_000);
  const trends = wm2.detectTrends();
  const rising = trends.find((t) => t.type === 'burst-type');
  assert.ok(rising, '应检测到 burst-type 趋势');
  assert.equal(rising.trend, 'rising', '密集到达应判定为上升趋势');
  ok(`趋势检测：burst-type 判定为 ${rising.trend}（斜率 ${rising.slopePerMin}）`);

  // 预测校准（窗口到期后对账）
  const wm3 = new WorldModel();
  const t0 = Date.now();
  for (let i = 0; i < 5; i += 1) wm3.observeArrival('cal-type', t0 - 60_000 + i * 10_000);
  wm3.predictArrivals(100); // 100ms 短窗口
  await sleep(150);
  wm3.observeArrival('cal-type', Date.now()); // 窗口内实际到达
  const settled = wm3.settleCalibrations();
  assert.ok(settled.length >= 1, '应产出校准记录');
  assert.ok(typeof settled[0].error === 'number');
  ok(`预测校准：MAE ${wm3.meanCalibrationError()}（${settled.length} 条记录）`);
}

// ─────────────────────────── 2. 好奇心引擎 ───────────────────────────
console.log('\n[2] 好奇心引擎（内在动机）');

{
  const provider = {
    getExposure: () => ({ 'code-generation': 10, 'data-analysis': 5, 'novel-type': 2 }),
    getExperienceCounts: () => ({ 'code-generation': 8 }), // data-analysis 低经验，novel-type 无经验
    getFailureRates: () => ({ 'code-generation': 0.1 }),
  };
  const curiosity = new CuriosityEngine(provider, { explorationBudgetRatio: 0.5 });

  // 知识盲区扫描
  const gaps = curiosity.scanKnowledgeGaps();
  assert.ok(gaps.length >= 2, '应识别出盲区');
  const novelGap = gaps.find((g) => g.taskType === 'novel-type');
  assert.ok(novelGap, 'novel-type 应被识别为盲区');
  assert.equal(novelGap.reason, 'unexplored');
  assert.ok(gaps[0].noveltyScore >= gaps[gaps.length - 1].noveltyScore, '应按新颖度降序');
  ok(`盲区扫描：${gaps.length} 个盲区（最高新颖度 ${gaps[0].noveltyScore}）`);

  // 探索建议（预算约束）
  const proposals = curiosity.proposeExplorations(4, 1);
  assert.ok(proposals.length >= 1 && proposals.length <= 2, '探索建议应受预算约束');
  assert.ok(proposals[0].description.length > 0);
  assert.ok(proposals[0].expectedGain.length > 0);
  ok(`探索建议：${proposals.length} 条（预算内）`);

  // 健康度低时探索收敛
  const lowHealth = curiosity.proposeExplorations(4, 0.1);
  assert.ok(lowHealth.length <= proposals.length, '低健康度时探索应收敛');
  ok('探索预算与健康度联动（退化时收敛）');

  // 探索回写
  curiosity.recordExploration('novel-type', true, '建立了首个成功范例');
  curiosity.recordExploration('data-analysis', false, '仍然失败');
  assert.equal(curiosity.getExplorations().length, 2);
  assert.equal(curiosity.getExplorationYield(), 0.5);
  ok(`探索回写：收获率 ${curiosity.getExplorationYield()}`);
}

// ─────────────────────────── 3. 安全治理器 ───────────────────────────
console.log('\n[3] 安全治理器（边界）');

{
  // 置信度门控
  const g1 = new SafetyGovernor({ confidenceThreshold: 0.5 });
  const blocked = g1.govern('autonomous-execute', 0.2);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedBy, 'confidence-gate');
  const allowed = g1.govern('autonomous-execute', 0.9);
  assert.equal(allowed.allowed, true);
  ok('置信度门控：低置信拦截 / 高置信放行');

  // 探索动作豁免置信度门控
  const explorationVerdict = g1.govern('exploration', 0.1);
  assert.equal(explorationVerdict.allowed, true, '探索动作应豁免置信度门控');
  ok('探索动作豁免置信度门控');

  // 限流
  const g2 = new SafetyGovernor({ maxActionsPerMinute: 2 });
  g2.govern('autonomous-execute', 1);
  g2.govern('autonomous-execute', 1);
  const rateLimited = g2.govern('autonomous-execute', 1);
  assert.equal(rateLimited.allowed, false);
  assert.equal(rateLimited.blockedBy, 'rate-limit');
  ok('限流：超过每分钟上限后拦截');

  // 预算
  const g3 = new SafetyGovernor({ tokenBudget: 100 });
  g3.recordOutcome(true, 120, 0); // 消耗超预算
  const budgetBlocked = g3.govern('autonomous-execute', 1);
  assert.equal(budgetBlocked.allowed, false);
  assert.equal(budgetBlocked.blockedBy, 'budget');
  ok('预算：token 耗尽后拦截');

  // 熔断器
  const g4 = new SafetyGovernor({ circuitFailureThreshold: 2, circuitCooldownMs: 200 });
  g4.recordOutcome(false);
  g4.recordOutcome(false); // 连续 2 次失败 → 熔断
  assert.equal(g4.getCircuitState(), 'open');
  const circuitBlocked = g4.govern('autonomous-execute', 1);
  assert.equal(circuitBlocked.blockedBy, 'circuit-breaker');
  await sleep(250); // 冷却期结束
  const halfOpen = g4.govern('autonomous-execute', 1);
  assert.equal(halfOpen.allowed, true, '冷却期后应半开放行');
  g4.recordOutcome(true); // 半开成功 → 闭合
  assert.equal(g4.getCircuitState(), 'closed');
  ok('熔断器：连续失败熔断 → 冷却半开 → 成功闭合');

  // Kill Switch
  const g5 = new SafetyGovernor();
  g5.engageKillSwitch();
  const killed = g5.govern('autonomous-execute', 1);
  assert.equal(killed.blockedBy, 'kill-switch');
  g5.disengageKillSwitch();
  assert.equal(g5.govern('autonomous-execute', 1).allowed, true);
  ok('Kill Switch：紧急停止 / 解除');

  // 审计日志
  assert.ok(g5.getAudit().length >= 2);
  ok('治理审计日志可追溯');
}

// ─────────────────────────── 4. 心跳循环集成 ───────────────────────────
console.log('\n[4] 心跳循环集成（预见 + 探索 + 治理）');

{
  const goalEngine = new GoalEngine({ minInsightSeverity: 0.4 });
  const metaCognition = new MetaCognitionEngine({ degradeStreakThreshold: 99 });
  const evolution = new StrategyEvolutionEngine({ populationSize: 3, minApplicationsBetweenEvolutions: 99 });
  const worldModel = new WorldModel({ minSamplesForTrend: 4, risingSlopeThreshold: 0.01 });
  const provider = {
    getExposure: () => ({ 'unknown-type': 5 }),
    getExperienceCounts: () => ({}),
    getFailureRates: () => ({}),
  };
  const curiosity = new CuriosityEngine(provider, { explorationBudgetRatio: 1 });
  const governor = new SafetyGovernor({ maxActionsPerMinute: 100 });

  // 预置上升趋势（触发负载预警洞察）
  const base = Date.now();
  for (let i = 0; i < 3; i += 1) worldModel.observeArrival('rising-type', base - 9 * 60_000 + i * 60_000);
  for (let i = 0; i < 12; i += 1) worldModel.observeArrival('rising-type', base - 4 * 60_000 + i * 20_000);

  const dispatchedExplorations = [];
  const loop = new AutonomyLoop({
    config: { heartbeatMs: 999_999, maxDispatchPerTick: 2, maintenanceEveryTicks: 99, maxGoalsPerTick: 3, enableExploration: true },
    goalEngine,
    metaCognition,
    evolution,
    collectKpi: () => ({ timestamp: Date.now(), successRate: 0.95, avgQuality: 0.85, avgLatency: 80, cacheHitRate: 0.4, modelSuccessRates: {}, activeExecutions: 0 }),
    dispatchSubtask: (subtask) => `sig-${subtask.id}`,
    maintainer: { distillExperience: () => 0, applyForgettingCurve: () => ({ decayed: 0, forgotten: 0 }) },
    lessonProvider: () => [],
    worldModel,
    curiosity,
    governor,
    dispatchExploration: (proposal) => {
      dispatchedExplorations.push(proposal);
      return `explore-${proposal.taskType}`;
    },
  });

  const report = await loop.tick();
  assert.ok(report.risingTrends.includes('rising-type'), '心跳应识别上升趋势');
  assert.ok(report.goalsCreated >= 1, '负载预警应生成目标');
  assert.ok(report.explorationsDispatched >= 1, '心跳应派发探索任务');
  assert.equal(dispatchedExplorations.length, report.explorationsDispatched);
  ok(`心跳集成：上升趋势 ${report.risingTrends.length} 个，生成目标 ${report.goalsCreated}，派发探索 ${report.explorationsDispatched}`);

  // 治理拦截：限流后探索被拦截
  const strictGovernor = new SafetyGovernor({ maxActionsPerMinute: 0 });
  const loop2 = new AutonomyLoop({
    config: { heartbeatMs: 999_999, maxDispatchPerTick: 2, maintenanceEveryTicks: 99, maxGoalsPerTick: 3, enableExploration: true },
    goalEngine: new GoalEngine(),
    metaCognition: new MetaCognitionEngine({ degradeStreakThreshold: 99 }),
    evolution: new StrategyEvolutionEngine({ populationSize: 3, minApplicationsBetweenEvolutions: 99 }),
    collectKpi: () => ({ timestamp: Date.now(), successRate: 0.95, avgQuality: 0.85, avgLatency: 80, cacheHitRate: 0.4, modelSuccessRates: {}, activeExecutions: 0 }),
    dispatchSubtask: (subtask) => `sig-${subtask.id}`,
    maintainer: { distillExperience: () => 0, applyForgettingCurve: () => ({ decayed: 0, forgotten: 0 }) },
    lessonProvider: () => [],
    curiosity,
    governor: strictGovernor,
    dispatchExploration: () => 'x',
  });
  const report2 = await loop2.tick();
  assert.ok(report2.governanceBlocked >= 1, '限流应拦截探索派发');
  assert.equal(report2.explorationsDispatched, 0);
  ok(`治理拦截：限流拦截 ${report2.governanceBlocked} 个动作`);

  // 自省报告
  const introspection = loop.introspect();
  assert.ok(introspection.loop, '自省应含心跳状态');
  assert.ok(introspection.health, '自省应含健康报告');
  assert.ok(introspection.goals, '自省应含目标摘要');
  assert.ok(introspection.exploration, '自省应含探索摘要');
  assert.ok(introspection.governance, '自省应含治理状态');
  assert.ok(introspection.worldModel, '自省应含世界模型');
  assert.ok(introspection.evolution, '自省应含进化报告');
  ok('自省报告：七大维度全景自我认知');
}

// ─────────────────────────── 5. 端到端集成 ───────────────────────────
console.log('\n[5] 端到端自主智能（预见 + 探索 + 治理）');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke7-'));
const PORT = 19880;

const mockFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const text = body.messages.map((m) => m.content).join('\n');
  let content;
  if (text.includes('战略决策器')) {
    const parsed = JSON.parse(body.messages[1].content);
    const signals = parsed.signals ?? parsed;
    content = JSON.stringify(signals.map((s) => ({ id: s.id, urgency: 0.9, decision: 'execute' })));
  } else if (text.includes('任务规划器')) {
    content = JSON.stringify({ nodes: [{ id: 'n1', description: 'x', type: 'code-generation', dependsOn: [] }], parallelismStrategy: 'sequential' });
  } else {
    content = 'ok';
  }
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 50 }, model: body.model }), { status: 200 });
};

const root = new Context();
const fiber = await root.plugin(plugin, {
  strategistModel: { id: 'mock-strategist', endpoint: 'http://mock', apiKey: 'k' },
  models: [
    { id: 'mock-strategist', endpoint: 'http://mock', apiKey: 'k', maxConcurrency: 2, initialCapabilities: { taskScores: { general: 0.8 } } },
    { id: 'mock-worker', endpoint: 'http://mock', apiKey: 'k', maxConcurrency: 2, initialCapabilities: { taskScores: { 'code-generation': 0.9 } } },
  ],
  sentinel: { watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.2 },
  qualityThreshold: 0.7,
  maxRetries: 1,
  globalTimeout: 30_000,
  enableProgress: true,
  progressPort: PORT,
  verbose: false,
  experienceStorePath: path.join(TMP, 'memory.json'),
  encryption: { enabled: false, algorithm: 'aes-256-gcm', fullFileEncryption: true },
  sync: { localNodeId: 'node-test', peers: [] },
  consensus: { enabled: false },
  hotReload: { enabled: false },
  tenants: [],
  dataDir: path.join(TMP, '.scheduler'),
  llm: { fetchImpl: mockFetch },
  nodeRunner: async ({ node }) => ({ output: `done-${node.id}`, quality: 0.9, tokensUsed: 20 }),
  autonomy: {
    enabled: true,
    heartbeatMs: 999_999,
    decomposer: async () => [{ description: '自主优化子任务', taskType: 'code-generation' }],
    loop: { maintenanceEveryTicks: 99 },
  },
});

const svc = root.scheduler;
assert.ok(svc.worldModel, '世界模型已暴露');
assert.ok(svc.curiosity, '好奇心引擎已暴露');
assert.ok(svc.governor, '安全治理器已暴露');
ok('插件加载：三大新组件已暴露');

// 提交任务 → 世界模型学习到达规律
svc.submitTask('实现用户认证模块', 0.9);
await waitFor(() => svc.worldModel.getSummary().totalArrivals >= 1, 15_000, '世界模型学习到达');
assert.ok(svc.worldModel.getSummary().totalArrivals >= 1);
ok('世界模型：信号到达自动学习');

// 等待任务执行完成（治理器回写）
await waitFor(() => svc.governor.getStatus().budget.tokensUsed > 0 || svc.memory.getGlobalStats().totalExecutions > 0, 20_000, '任务执行与治理回写');
ok('治理器：执行结果自动回写');

// query_memory 新查询类型
const wmQuery = await svc.tools.invoke('query_memory', { query_type: 'world-model' });
assert.ok(wmQuery.summary, 'world-model 查询应返回摘要');
assert.ok(Array.isArray(wmQuery.predictions));
ok('query_memory world-model：世界模型可查询');

const curiosityQuery = await svc.tools.invoke('query_memory', { query_type: 'curiosity' });
assert.ok(curiosityQuery.summary, 'curiosity 查询应返回摘要');
assert.ok(Array.isArray(curiosityQuery.gaps));
ok('query_memory curiosity：好奇心盲区可查询');

const governanceQuery = await svc.tools.invoke('query_memory', { query_type: 'governance' });
assert.ok(governanceQuery.status, 'governance 查询应返回状态');
assert.ok(Array.isArray(governanceQuery.audit));
ok('query_memory governance：治理状态可查询');

const introspectQuery = await svc.tools.invoke('query_memory', { query_type: 'introspect' });
assert.ok(introspectQuery.introspection.loop, 'introspect 应含全景自省');
ok('query_memory introspect：全景自省可查询');

// manage_autonomy Kill Switch
const killed = await svc.tools.invoke('manage_autonomy', { action: 'kill-switch', engage: true });
assert.equal(killed.engaged, true);
assert.equal(svc.governor.isKillSwitchEngaged(), true);
const killedVerdict = svc.governor.govern('autonomous-execute', 1);
assert.equal(killedVerdict.blockedBy, 'kill-switch');
ok('manage_autonomy kill-switch：紧急停止生效');

// 解除 Kill Switch 并恢复
const revived = await svc.tools.invoke('manage_autonomy', { action: 'revive' });
assert.equal(revived.revived, true);
assert.equal(svc.governor.isKillSwitchEngaged(), false);
ok('manage_autonomy revive：紧急停止解除并恢复');

// manage_autonomy 自省
const introspectAction = await svc.tools.invoke('manage_autonomy', { action: 'introspect' });
assert.ok(introspectAction.introspection.worldModel, 'introspect 动作应含世界模型');
ok('manage_autonomy introspect：自省动作可用');

await fiber.dispose();
fs.rmSync(TMP, { recursive: true, force: true });
ok('fiber 卸载清理完成');

console.log(`\n✅ 自主智能三大支柱冒烟测试全部通过（${passed} 项断言组）`);
process.exit(0);
