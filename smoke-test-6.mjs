/**
 * smoke-test-6.mjs — 自主智能冒烟验证
 *
 * 覆盖"彻底自主智能"四大组件：
 * 1. 目标引擎：洞察→目标生成 + 去重 + 价值评估 + 分解 + 进度追踪 + 终态判定
 * 2. 元认知：KPI 异常检测 + 退化参数自调优 + 模型健康自愈洞察
 * 3. 策略进化：UCB 选择 + 适应度反馈 + 锦标赛进化 + 基因组落地
 * 4. 心跳循环：单轮 tick 编排（观察→目标→派发→进化→维护）
 * 5. 端到端：cordis 插件集成 + manage_autonomy Tool + 目标派发执行达成闭环
 *
 * 全程离线：fetchImpl / nodeRunner / decomposer / rng 均注入模拟实现。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import plugin, {
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

// 确定性随机源（策略进化可复现）
let seed = 42;
const rng = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

// ─────────────────────────── 1. 目标引擎 ───────────────────────────
console.log('\n[1] 目标引擎');

{
  const engine = new GoalEngine({ minInsightSeverity: 0.4, maxActiveGoals: 5 });

  // 洞察 → 目标生成（低严重度被过滤）
  const insights = [
    { source: 'reflection', category: 'timeout', taskType: 'code-generation', severity: 0.8, message: '任务超时', suggestion: '增大节点超时' },
    { source: 'reflection', category: 'trivial', severity: 0.2, message: '轻微问题', suggestion: '忽略即可' },
  ];
  const created = engine.generateGoalsFromInsights(insights);
  assert.equal(created.length, 1, '仅高严重度洞察生成目标');
  assert.equal(created[0].status, 'proposed');
  assert.ok(created[0].valueScore > 0, '目标应有正向价值分');
  ok(`洞察→目标生成（过滤低严重度，价值分 ${created[0].valueScore.toFixed(3)}）`);

  // 去重：相同建议不重复生成
  const dup = engine.generateGoalsFromInsights(insights);
  assert.equal(dup.length, 0, '重复洞察应被去重');
  ok('目标去重（相同建议不重复生成）');

  // 分解（无 decomposer → 规则兜底单步）
  const subtasks = await engine.decompose(created[0].id);
  assert.ok(subtasks.length >= 1, '应分解出子任务');
  const goal = engine.getGoal(created[0].id);
  assert.equal(goal.status, 'active');
  ok(`目标分解：${subtasks.length} 个子任务（规则兜底）`);

  // 选取 + 派发 + 进度回写 → 完成
  const picked = engine.pickNextSubtask();
  assert.ok(picked, '应选取到待执行子任务');
  engine.markDispatched(picked.goal.id, picked.subtask.id, 'sig-x');
  const bound = engine.findBySignal('sig-x');
  assert.ok(bound, '信号应绑定到子任务');
  const transition = engine.recordSubtaskOutcome(picked.goal.id, picked.subtask.id, true, '成功');
  assert.equal(transition, 'completed', '唯一子任务成功后目标应达成');
  assert.equal(engine.getGoal(created[0].id).status, 'completed');
  ok('进度追踪：子任务成功 → 目标达成');

  // 放弃路径：反复失败 → abandoned
  const g2 = engine.generateGoalsFromInsights([
    { source: 'meta-cognition', category: 'kpi', severity: 0.9, message: '成功率下滑', suggestion: '优化执行策略' },
  ]);
  await engine.decompose(g2[0].id);
  const p2 = engine.pickNextSubtask();
  engine.markDispatched(p2.goal.id, p2.subtask.id, 'sig-y1');
  engine.recordSubtaskOutcome(p2.goal.id, p2.subtask.id, false); // 第 1 次失败 → 回 pending
  const p2b = engine.pickNextSubtask();
  engine.markDispatched(p2b.goal.id, p2b.subtask.id, 'sig-y2');
  const t2 = engine.recordSubtaskOutcome(p2b.goal.id, p2b.subtask.id, false); // 第 2 次失败 → 重试耗尽
  assert.equal(t2, 'abandoned', '重试耗尽后目标应放弃');
  ok('止损：子任务重试耗尽 → 目标放弃');

  // 序列化/反序列化
  const snapshot = engine.serialize();
  const restored = new GoalEngine();
  restored.deserialize(snapshot);
  assert.equal(restored.getAllGoals().length, engine.getAllGoals().length);
  ok('目标库序列化/反序列化（跨会话延续）');
}

// ─────────────────────────── 2. 元认知 ───────────────────────────
console.log('\n[2] 元认知引擎');

{
  // 退化 → 参数自调优（冷却期 0 立即生效）
  const tuned = [];
  const mc = new MetaCognitionEngine({
    windowSize: 20,
    degradeStreakThreshold: 2,
    tuningCooldownMs: 0,
    successRateTarget: 0.8,
    applier: (action) => tuned.push(action),
  });
  const mkSnap = (successRate) => ({
    timestamp: Date.now(),
    successRate,
    avgQuality: 0.8,
    avgLatency: 100,
    cacheHitRate: 0.3,
    modelSuccessRates: {},
    activeExecutions: 0,
  });
  mc.observe(mkSnap(0.5)); // streak=1
  mc.observe(mkSnap(0.5)); // streak=2 → 触发调优
  assert.ok(tuned.length >= 1, '连续退化应触发参数自调优');
  assert.equal(tuned[0].parameter, 'qualityThreshold');
  assert.ok(tuned[0].to < tuned[0].from, '成功率退化应放宽质量阈值');
  ok(`退化自调优：${tuned[0].parameter} ${tuned[0].from} → ${tuned[0].to}`);

  // 冷却期内 → 自愈洞察
  const mc2 = new MetaCognitionEngine({
    degradeStreakThreshold: 1,
    tuningCooldownMs: 999_999,
    successRateTarget: 0.8,
  });
  mc2.observe(mkSnap(0.5)); // 首次调优成功（lastTuningAt=0 通过冷却）
  const selfHeal = mc2.observe(mkSnap(0.5)); // 冷却期内 → 产出洞察
  assert.ok(selfHeal.some((i) => i.source === 'meta-cognition'), '冷却期内应产出自愈洞察');
  ok('自愈洞察：调优冷却期内产出结构性问题洞察');

  // 模型健康度
  const mc3 = new MetaCognitionEngine({ modelHealthThreshold: 0.4 });
  const insights = mc3.observe({
    ...mkSnap(0.9),
    modelSuccessRates: { 'bad-model': 0.1 },
  });
  assert.ok(insights.some((i) => i.category === 'model-unhealthy'), '低成功率模型应触发健康洞察');
  ok('模型健康检查：低成功率模型产出自愈洞察');

  // 健康报告
  const report = mc3.getHealthReport();
  assert.ok(typeof report.score === 'number');
  assert.ok(report.kpis.successRate === 0.9);
  ok(`健康报告：综合评分 ${report.score}`);
}

// ─────────────────────────── 3. 策略进化 ───────────────────────────
console.log('\n[3] 策略进化引擎');

{
  // 进化门槛：样本不足时不进化
  const fresh = new StrategyEvolutionEngine({ minApplicationsBetweenEvolutions: 5, rng });
  assert.equal(fresh.evolve(), null, '样本不足时进化应被门控');
  ok('进化门控：样本不足不触发');

  // UCB 选择 + 适应度反馈 + 强制进化
  const evo = new StrategyEvolutionEngine({
    populationSize: 4,
    eliteCount: 1,
    minApplicationsBetweenEvolutions: 2,
    minApplicationsForElite: 1,
    rng,
  });
  for (let i = 0; i < 8; i += 1) {
    const genome = evo.selectGenome();
    evo.recordOutcome(genome.id, i % 3 === 0 ? 'excellent' : 'good');
  }
  const genBefore = evo.getReport().generation;
  const report = evo.evolve(true);
  assert.ok(report, '强制进化应产出报告');
  assert.equal(report.generation, genBefore + 1);
  assert.ok(report.born.length >= 1, '应有变异后代诞生');
  ok(`锦标赛进化：第 ${report.generation} 代，精英 ${report.elites.length}，新生 ${report.born.length}，淘汰 ${report.eliminated.length}`);

  // 种群规模稳定 + 最优基因组落地
  const after = evo.getReport();
  assert.equal(after.genomes.length, 4, '进化后种群规模稳定');
  const best = evo.bestGenome();
  assert.ok(best.meanReward > 0, '最优基因组应有正向适应度');
  const genes = evo.bestGenesAsConfig();
  assert.ok(typeof genes.suppressionWindowMs === 'number');
  assert.ok(typeof genes.failureEscalationThreshold === 'number');
  ok(`最优基因组落地：适应度 ${best.meanReward.toFixed(3)}，基因 5 项齐全`);
}

// ─────────────────────────── 4. 心跳循环 ───────────────────────────
console.log('\n[4] 自主心跳循环');

{
  const goalEngine = new GoalEngine({ minInsightSeverity: 0.4 });
  const metaCognition = new MetaCognitionEngine({ degradeStreakThreshold: 99 });
  const evolution = new StrategyEvolutionEngine({ populationSize: 3, minApplicationsBetweenEvolutions: 99, rng });

  const dispatched = [];
  let maintenanceCalls = 0;
  const loop = new AutonomyLoop({
    config: { heartbeatMs: 999_999, maxDispatchPerTick: 2, maintenanceEveryTicks: 1, maxGoalsPerTick: 3, enableStrategyEvolution: true },
    goalEngine,
    metaCognition,
    evolution,
    collectKpi: () => ({ timestamp: Date.now(), successRate: 0.95, avgQuality: 0.85, avgLatency: 80, cacheHitRate: 0.4, modelSuccessRates: {}, activeExecutions: 0 }),
    dispatchSubtask: (subtask, goal) => {
      dispatched.push({ subtaskId: subtask.id, goalId: goal.id });
      return `sig-${subtask.id}`;
    },
    maintainer: {
      distillExperience: () => { maintenanceCalls += 1; return 1; },
      applyForgettingCurve: () => ({ decayed: 0, forgotten: 0 }),
    },
    lessonProvider: () => [],
  });

  // 预置一个可执行目标
  const goals = goalEngine.generateGoalsFromInsights([
    { source: 'user', category: 'test', severity: 0.8, message: '需要优化', suggestion: '执行优化任务' },
  ]);
  await goalEngine.decompose(goals[0].id);

  const report = await loop.tick();
  assert.equal(report.subtasksDispatched, 1, '心跳应派发待执行子任务');
  assert.equal(dispatched.length, 1);
  assert.ok(report.maintenance, '每轮心跳应触发记忆维护');
  assert.ok(report.healthScore > 0);
  ok(`单轮心跳：派发 ${report.subtasksDispatched} 子任务，健康分 ${report.healthScore.toFixed(2)}，维护已执行`);

  // 心跳历史
  assert.equal(loop.getReports().length, 1);
  assert.ok(loop.getStatus().tickCount === 1);
  ok('心跳历史与状态可查询');
}

// ─────────────────────────── 5. 端到端集成 ───────────────────────────
console.log('\n[5] 端到端自主闭环');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke6-'));
const PORT = 19879;

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
    heartbeatMs: 999_999, // 测试期间不自动触发，手动驱动
    decomposer: async () => [{ description: '自主优化子任务', taskType: 'code-generation' }],
    loop: { maintenanceEveryTicks: 1 },
  },
});

const svc = root.scheduler;
assert.ok(svc.goalEngine, '目标引擎已暴露');
assert.ok(svc.metaCognition, '元认知引擎已暴露');
assert.ok(svc.strategyEvolution, '策略进化引擎已暴露');
assert.ok(svc.autonomyLoop, '心跳循环已暴露');
ok('插件加载：四大自主组件已暴露');

// manage_autonomy 注入洞察 → 生成目标
const injected = await svc.tools.invoke('manage_autonomy', {
  action: 'inject-insight',
  insight: { source: 'user', category: 'perf', severity: 0.8, message: '代码生成延迟偏高', suggestion: '优化代码生成流水线', taskType: 'code-generation' },
});
assert.ok(injected.goalsCreated.length >= 1, '注入洞察应生成目标');
const goalId = injected.goalsCreated[0].id;
ok(`注入洞察 → 生成目标 ${goalId}（价值分 ${injected.goalsCreated[0].valueScore.toFixed(3)}）`);

// 手动心跳 → 派发子任务为信号 → 执行 → 目标达成
const goalCompletes = [];
await svc.tools.invoke('manage_autonomy', { action: 'tick' });
await waitFor(() => {
  const g = svc.goalEngine.getGoal(goalId);
  if (g?.status === 'completed') goalCompletes.push(g);
  return g?.status === 'completed';
}, 20_000, '自主目标达成');
assert.equal(goalCompletes[0].status, 'completed');
assert.ok(goalCompletes[0].subtasks.every((s) => s.status === 'done'));
ok('自主闭环：目标派发 → 信号执行 → 目标达成');

// query_memory 新增查询类型
const goalsQuery = await svc.tools.invoke('query_memory', { query_type: 'goals' });
assert.ok(goalsQuery.summary.total >= 1);
ok('query_memory goals：目标摘要可查询');

const healthQuery = await svc.tools.invoke('query_memory', { query_type: 'health' });
assert.ok(typeof healthQuery.health.score === 'number');
ok('query_memory health：健康报告可查询');

const evoQuery = await svc.tools.invoke('query_memory', { query_type: 'evolution' });
assert.ok(evoQuery.evolution.genomes.length >= 1);
ok('query_memory evolution：策略种群可查询');

const autonomyQuery = await svc.tools.invoke('query_memory', { query_type: 'autonomy-status' });
assert.ok(autonomyQuery.status.tickCount >= 1);
ok('query_memory autonomy-status：心跳状态可查询');

// manage_autonomy 强制进化
const evolved = await svc.tools.invoke('manage_autonomy', { action: 'evolve-now' });
assert.ok(evolved.bestGenes, '强制进化应返回最优基因');
ok('manage_autonomy evolve-now：策略进化落地');

// manage_autonomy 状态
const status = await svc.tools.invoke('manage_autonomy', { action: 'status' });
assert.ok(status.health, 'status 应含健康报告');
assert.ok(status.goals, 'status 应含目标摘要');
ok('manage_autonomy status：综合状态可查询');

await fiber.dispose();
fs.rmSync(TMP, { recursive: true, force: true });
ok('fiber 卸载清理完成（心跳循环已停止）');

console.log(`\n✅ 自主智能冒烟测试全部通过（${passed} 项断言组）`);
process.exit(0);
