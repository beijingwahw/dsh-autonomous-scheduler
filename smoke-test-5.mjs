/**
 * smoke-test-5.mjs — 闭环深度优化冒烟验证
 *
 * 覆盖"感知 → 决策 → 执行 → 反思 → 沉淀"五环节的深度优化能力：
 * 1. 感知：信号富化（速率/突发/关联）+ 自适应聚合窗口
 * 2. 决策：决策引擎四级流水线（规则快速路径 / 缓存命中 / strategist / 兜底）
 * 3. 执行：成本感知模型选择 + 截止时间感知 + 动态并行度
 * 4. 反思：LLM-as-judge 评审 + 教训提取 + 阈值自校准 + 质量趋势
 * 5. 沉淀：经验蒸馏（策略提炼）+ 遗忘曲线（置信度衰减）
 * 6. 端到端：cordis 插件闭环全链路（决策缓存命中实测 + 教训沉淀实测）
 *
 * 全程离线：fetchImpl / nodeRunner / judge / lessonExtractor 均注入模拟实现。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import plugin, {
  DecisionEngine,
  ReflectionEngine,
  Sentinel,
  LongTermMemory,
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

// ─────────────────────────── 1. 感知：富化 + 自适应窗口 ───────────────────────────
console.log('\n[1] 感知优化');

{
  const batches = [];
  const sentinel = new Sentinel(
    { watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.4 },
    (b) => batches.push(b),
  );
  sentinel.start();

  // 平稳信号：富化上下文应存在
  const s1 = sentinel.ingest({ type: 'code-change', description: 'a', payload: {}, source: 'test' });
  assert.ok(s1.enrichment, '信号应携带富化上下文');
  assert.equal(s1.enrichment.historicalCount, 1);
  assert.equal(s1.enrichment.isBurst, false);
  ok('信号富化：速率/历史计数/突发标记');

  // 突发注入：短时间内大量同类型信号 → 窗口缩短
  const windowBefore = sentinel.getStatus().effectiveWindowMs;
  for (let i = 0; i < 6; i += 1) {
    sentinel.ingest({ type: 'burst-type', description: `b${i}`, payload: {}, source: 'test' });
  }
  const status = sentinel.getStatus();
  assert.ok(status.effectiveWindowMs < windowBefore, `突发后窗口应缩短（${windowBefore} → ${status.effectiveWindowMs}）`);
  assert.ok(status.burstCount > 0, '应检测到突发');
  ok(`自适应窗口：突发后 ${windowBefore}ms → ${status.effectiveWindowMs}ms`);

  // 关联分析：异类型信号在 30s 内应被关联
  const s2 = sentinel.ingest({ type: 'error-detected', description: 'err', payload: {}, source: 'test' });
  assert.ok(s2.enrichment.correlatedSignalIds.length > 0, '应关联到近期异类型信号');
  ok('信号关联分析：关联到近期异类型信号');

  await waitFor(() => batches.length >= 1, 3000, '批次交付');
  sentinel.stop();
}

// ─────────────────────────── 2. 决策：四级流水线 ───────────────────────────
console.log('\n[2] 决策优化');

{
  let strategistCalls = 0;
  const engine = new DecisionEngine({
    cacheTtlMs: 60_000,
    suppressionWindowMs: 60_000,
    failureEscalationThreshold: 2,
    strategist: async (signals) => {
      strategistCalls += 1;
      return new Map(signals.map((s) => [s.id, { urgency: 0.8, decision: 'execute', reason: 'strategist' }]));
    },
  });

  const mkSignal = (type, description) => ({ id: `sig-${Math.random().toString(36).slice(2)}`, type, description, payload: {}, receivedAt: Date.now(), source: 'test', occurrences: 1 });

  // 第 3 级：新信号走 strategist
  const s1 = mkSignal('task-a', '任务A');
  const d1 = await engine.decide([s1], new Map());
  assert.equal(d1.get(s1.id).source, 'strategist');
  assert.equal(strategistCalls, 1);
  ok('新信号走 strategist 决策');

  // 第 2 级：同指纹信号命中缓存（不再调用 strategist）
  const s2 = mkSignal('task-a', '任务A');
  const d2 = await engine.decide([s2], new Map());
  assert.equal(d2.get(s2.id).source, 'cache');
  assert.equal(strategistCalls, 1, '缓存命中不应再调用 strategist');
  ok('决策缓存命中（strategist 调用次数未增加）');

  // 第 1 级规则 A：重复抑制 — 成功执行后同指纹信号被 dismiss
  const fp = engine.fingerprint(s1);
  engine.recordOutcome('task-a', fp, 'good');
  const s3 = mkSignal('task-a', '任务A');
  const d3 = await engine.decide([s3], new Map());
  assert.equal(d3.get(s3.id).action, 'dismiss');
  assert.equal(d3.get(s3.id).source, 'rule');
  ok('规则快速路径：重复抑制（成功后同指纹 dismiss）');

  // 第 1 级规则 B：失败升级 — 连续失败达阈值后 ask-user
  const s4 = mkSignal('task-b', '任务B');
  const fpB = engine.fingerprint(s4);
  engine.recordOutcome('task-b', fpB, 'failed');
  engine.recordOutcome('task-b', fpB, 'failed');
  const s5 = mkSignal('task-b', '任务B2');
  const d5 = await engine.decide([s5], new Map());
  assert.equal(d5.get(s5.id).action, 'ask-user');
  ok('规则快速路径：连续失败升级 ask-user');

  // 统计
  const stats = engine.getStats();
  assert.ok(stats.cacheHits >= 1);
  assert.ok(stats.ruleHits >= 2);
  ok(`决策统计：缓存命中 ${stats.cacheHits}，规则命中 ${stats.ruleHits}`);
}

// ─────────────────────────── 3. 反思：评审 + 教训 + 自校准 ───────────────────────────
console.log('\n[3] 反思优化');

{
  const reflection = new ReflectionEngine({
    qualityThreshold: 0.7,
    calibrationMinSamples: 5,
    calibrationStep: 0.05,
    judge: async () => ({ score: 0.95, completeness: 0.9, correctness: 0.95, maintainability: 0.9, comment: '优秀' }),
    lessonExtractor: async (params) => ({
      rootCause: 'model-capability',
      lesson: `模型对 ${params.taskType} 能力不足`,
      suggestion: '切换更强模型',
    }),
  });

  // LLM-as-judge：评审分与基础分加权
  const verdict = await reflection.reflect({
    node: { id: 'n1', description: 'x', type: 'code-generation' },
    output: 'result',
    baseQuality: 0.5,
    signal: { id: 's', type: 'code-generation', description: 'd', payload: {}, receivedAt: Date.now(), source: 'test', occurrences: 1 },
  });
  // 0.95 × 0.7 + 0.5 × 0.3 = 0.815
  assert.ok(Math.abs(verdict.quality - 0.815) < 0.01, `评审加权质量应为 0.815，实际 ${verdict.quality}`);
  assert.equal(verdict.passed, true);
  assert.ok(verdict.dimensions, '应携带评审维度明细');
  ok('LLM-as-judge 评审（加权质量 0.815，含维度明细）');

  // 教训提取
  const lesson = await reflection.extractLesson({
    signal: { id: 's', type: 'code-generation', description: 'd', payload: {}, receivedAt: Date.now(), source: 'test', occurrences: 1 },
    taskType: 'code-generation',
    result: { planId: 'p', success: false, nodeResults: [{ nodeId: 'n1', modelId: 'm1', success: false, quality: 0, latency: 0, attempts: 1, error: '质量不达标', tokensUsed: 0 }], totalTime: 0, successCount: 0, totalTokens: 0, avgQuality: 0 },
    plan: { objective: 'o', nodes: [], parallelismStrategy: 'layered', source: 'strategist' },
  });
  assert.equal(lesson.rootCause, 'model-capability');
  assert.equal(reflection.getLessons('code-generation').length, 1);
  ok('教训提取（rootCause=model-capability）');

  // 有 model-capability 教训后，低质量应建议 retry-switch
  const lowVerdict = await reflection.reflect({
    node: { id: 'n1', description: 'x', type: 'code-generation' },
    output: 'bad',
    baseQuality: 0.1,
    signal: { id: 's', type: 'code-generation', description: 'd', payload: {}, receivedAt: Date.now(), source: 'test', occurrences: 1 },
  });
  // judge 给 0.95，加权后 0.95*0.7+0.1*0.3=0.695 < 0.7 → 不达标
  assert.equal(lowVerdict.passed, false);
  assert.equal(lowVerdict.retryAdvice, 'retry-switch', '有模型能力教训时应建议换模型');
  ok('重试策略优化：模型能力教训 → retry-switch');

  // 阈值自校准：持续高质量 → 阈值收紧
  const thresholdBefore = reflection.getCurrentThreshold();
  for (let i = 0; i < 6; i += 1) reflection.recordExecution('code-generation', 0.95, true);
  const thresholdAfter = reflection.getCurrentThreshold();
  assert.ok(thresholdAfter > thresholdBefore, `高质量应使阈值收紧（${thresholdBefore} → ${thresholdAfter}）`);
  ok(`阈值自校准：持续高质量 ${thresholdBefore} → ${thresholdAfter}`);

  // 质量趋势
  const trend = reflection.getTrendSummary();
  assert.ok(trend.byType['code-generation']);
  assert.ok(trend.byType['code-generation'].samples >= 6);
  ok('质量趋势追踪（滑动窗口统计）');
}

// ─────────────────────────── 4. 沉淀：蒸馏 + 遗忘曲线 ───────────────────────────
console.log('\n[4] 沉淀优化');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory5-'));
  const memory = new LongTermMemory(path.join(tmpDir, 'mem.json'));

  // 构造高置信度模式：同模型连续成功 4 次（confidence 0.5 + 4×0.05 = 0.7 ≥ 0.6）
  for (let i = 0; i < 4; i += 1) {
    memory.recordSuccess({
      taskType: 'documentation',
      complexity: 0.3,
      features: ['docs'],
      taskSummary: 'documentation: 写文档',
      plan: { objective: 'o', nodes: [{ id: 'n1', description: 'd', type: 'documentation', dependsOn: [] }], parallelismStrategy: 'sequential' },
      modelAssignments: { n1: 'model-b' },
      totalLatency: 1000,
      qualityScores: { n1: 0.9 },
      tokenCost: 100,
    });
  }

  // 经验蒸馏：应提炼出 model-b 偏好策略
  const strategies = memory.distillExperience();
  assert.ok(strategies.length >= 1, '应蒸馏出至少一条策略');
  const modelStrategy = strategies.find((s) => s.description.includes('model-b'));
  assert.ok(modelStrategy, '应提炼出 model-b 偏好策略');
  assert.ok(modelStrategy.confidence > 0.5);
  ok(`经验蒸馏：提炼 ${strategies.length} 条策略（含 model-b 偏好）`);

  // 蒸馏去重：再次蒸馏不应重复产出
  const again = memory.distillExperience();
  assert.equal(again.length, 0, '重复蒸馏不应产出相同策略');
  ok('蒸馏去重（二次蒸馏零产出）');

  // 策略反馈闭环
  memory.recordStrategyOutcome(modelStrategy.id, true);
  const updated = memory.getStrategies('documentation').find((s) => s.id === modelStrategy.id);
  assert.equal(updated.appliedTotal, 1);
  assert.equal(updated.appliedSuccesses, 1);
  ok('策略应用反馈闭环（appliedTotal=1）');

  // 遗忘曲线：构造一个长期未使用的低置信度模式
  memory.upsertPattern({
    fingerprint: 'old-pattern',
    taskSummary: 'legacy: 旧任务',
    frequency: 1,
    firstSeenAt: Date.now() - 100 * 24 * 60 * 60 * 1000,
    lastSeenAt: Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 天前
    successfulPlans: [],
    failureRecords: [],
    confidence: 0.3,
    avgExecutionTime: 0,
    avgQualityScore: 0,
  });
  const forgetting = memory.applyForgettingCurve(30, 0.2);
  assert.ok(forgetting.decayed + forgetting.forgotten >= 1, '应对陈旧模式衰减或遗忘');
  const oldPattern = memory.getAllTaskPatterns().find((p) => p.fingerprint === 'old-pattern');
  assert.equal(oldPattern, undefined, '100 天未使用的低置信度模式应被彻底遗忘');
  ok(`遗忘曲线：衰减 ${forgetting.decayed} 个，彻底遗忘 ${forgetting.forgotten} 个`);

  memory.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─────────────────────────── 5. 端到端闭环 ───────────────────────────
console.log('\n[5] 端到端闭环');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke5-'));
const PORT = 19878;

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
  judge: async () => ({ score: 0.9, completeness: 0.9, correctness: 0.9, maintainability: 0.9, comment: 'good' }),
});

const svc = root.scheduler;
assert.ok(svc.decisionEngine, '决策引擎已暴露');
assert.ok(svc.reflectionEngine, '反思引擎已暴露');
ok('插件加载：决策引擎与反思引擎已暴露');

// 第一次执行：走 strategist 决策
const planCompletes = [];
root.on('scheduler/plan-complete', (result) => planCompletes.push(result));
await svc.tools.invoke('autonomous_execute', { task: '闭环测试任务', urgency: 0.9 });
await waitFor(() => planCompletes.length >= 1, 20_000, '首次执行完成');
assert.ok(planCompletes[0].success);
const statsAfterFirst = svc.decisionEngine.getStats();
assert.equal(statsAfterFirst.strategistCalls, 1);
ok('首次执行：strategist 决策 1 次');

// 第二次执行同任务：应命中决策缓存或重复抑制（strategist 调用不增加或 dismiss）
await svc.tools.invoke('autonomous_execute', { task: '闭环测试任务', urgency: 0.9 });
await sleep(1500);
const statsAfterSecond = svc.decisionEngine.getStats();
const cacheOrRuleHit = statsAfterSecond.cacheHits + statsAfterSecond.ruleHits > statsAfterFirst.cacheHits + statsAfterFirst.ruleHits;
assert.ok(cacheOrRuleHit, '同任务第二次应命中缓存或重复抑制规则');
ok(`决策优化生效：第二次命中缓存/规则（缓存 ${statsAfterSecond.cacheHits}，规则 ${statsAfterSecond.ruleHits}）`);

// 反思与沉淀验证
const trends = await svc.tools.invoke('query_memory', { query_type: 'trends' });
assert.ok(trends.trends.byType['code-generation'] || Object.keys(trends.trends.byType).length > 0, '质量趋势应有记录');
ok('质量趋势已记录');

const decisionStats = await svc.tools.invoke('query_memory', { query_type: 'decision-stats' });
assert.ok(decisionStats.stats.total >= 2);
ok(`决策引擎统计：总决策 ${decisionStats.stats.total}`);

// 蒸馏策略查询（首次成功可能未达蒸馏阈值，验证接口可用）
const strategiesResult = await svc.tools.invoke('query_memory', { query_type: 'strategies' });
assert.ok(Array.isArray(strategiesResult.strategies));
ok('蒸馏策略查询接口可用');

// 教训查询接口
const lessonsResult = await svc.tools.invoke('query_memory', { query_type: 'lessons' });
assert.ok(Array.isArray(lessonsResult.lessons));
ok('教训查询接口可用');

await fiber.dispose();
fs.rmSync(TMP, { recursive: true, force: true });
ok('fiber 卸载清理完成');

console.log(`\n✅ 闭环深度优化冒烟测试全部通过（${passed} 项断言组）`);
process.exit(0);
