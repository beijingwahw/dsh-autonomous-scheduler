/**
 * verify-self-evolution-v2.mjs — 第一阶段 2.0「统计学习决策」质级升级验证
 *
 * 升级主题：记忆—反思—优化闭环从「经验回放」到「贝叶斯学习」
 *   记忆：裸计数画像 → 时间加权 Beta 后验（不确定性 + 时效 + 漂移感知）
 *   调度：裸成功率点估计 → Wilson 下界利用 + UCB 探索 + 预测置信度
 *   反思：成败记录 → Brier 校准（自知之明）+ 反事实遗憾（本可以更优）
 *
 * 全程离线（nodeRunner 注入模拟模型行为），断言点：
 *
 *   S1 时间衰减：60 天前的 10 成功证据 → 有效样本 ≈ 2.5（两个半衰期折价）
 *   S2 Wilson 下界：3/3 全成 ≈ 0.44 vs 60/60 全成 ≈ 0.94（小样本保守质变）
 *   S3 UCB 冷启动探索：零样本弱画像模型凭信息价值翻转胜出（exploration=true）
 *   S4 漂移救回：早期 6 败模型修复后 3 连胜 → drift>0.1，后验反超裸成功率
 *   S5 校准闭环：预测 0.9 连续失败 → overconfident / Brier 0.81；预测准 → calibrated
 *   S6 反事实遗憾：用了后验 0.3 的模型、存在下界 0.84 的更优者 → 教训入记忆
 *   S7 端到端：洞察桥接（执行器→反思器）+ 推荐采纳 + 校准样本累积 + 取走即清空
 *   S8 旧格式兼容：无 weighted 字段的旧画像 → 0.5 折价回退，不炸不丢
 *   S9 签名回归：assignModel 仍返回 string；旧参数调用 reflectOnOutcome 正常
 *
 * 运行：npm run build && node scripts/verify-self-evolution-v2.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DECAY_HALF_LIFE_DAYS,
  LLMClient,
  LongTermMemory,
  ModelScheduler,
  Optimizer,
  ReflectionEngine,
  Reflector,
  TaskExecutor,
  wilsonLowerBound,
} from '../dist/index.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const stamp = Date.now();

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });
const approx = (a, b, eps = 0.05) => Math.abs(a - b) < eps;

// ── S2：Wilson 置信下界（纯函数级断言） ──
{
  const smallSample = wilsonLowerBound(3, 0);
  const largeSample = wilsonLowerBound(60, 0);
  check(
    'S2 Wilson 下界：小样本保守（3/3 ≈ 0.44 vs 60/60 ≈ 0.94，同是 100% 成功）',
    approx(smallSample, 0.44) && approx(largeSample, 0.94, 0.02) && largeSample - smallSample > 0.4,
    `裸成功率同为 1.0，但 Wilson 下界 3 样本=${smallSample.toFixed(3)}、60 样本=${largeSample.toFixed(3)}（差 ${(largeSample - smallSample).toFixed(3)}）——「3 次全成」不再伪装成「久经考验」`,
  );
}

// ── 公共组件工厂 ──
const memPath = path.join(os.tmpdir(), `dsh-verify-v2-mem-${stamp}.json`);
fs.rmSync(memPath, { force: true });
fs.rmSync(memPath.replace(/\.json$/, '.db'), { force: true });

const makeLLM = () => {
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-strong', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { 'code-generation': 0.9, general: 0.7 } } });
  llm.registerModel({ id: 'model-weak', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { 'code-generation': 0.4, general: 0.4 } } });
  return llm;
};

/** 直接构造带 2.0 加权字段的画像（精确控制证据时间分布） */
const seedProfile = (memory, modelId, taskType, stats) => {
  memory.upsertModelProfile({
    id: modelId,
    name: modelId,
    taskHistory: { [taskType]: { totalCalls: 0, successCount: 0, totalLatency: 0, totalQualityScore: 0, avgQualityScore: 0, lastCalledAt: 0, ...stats } },
    costEfficiency: {},
    bestTaskType: '',
    worstTaskType: '',
    stability: 0.5,
  });
};

// ── S1：时间衰减（读取时惰性衰减 60 天前的证据） ──
{
  const memory = new LongTermMemory(memPath.replace(/\.json$/, '-s1.json'));
  seedProfile(memory, 'model-old', 'analysis', {
    totalCalls: 10, successCount: 10,
    weightedSuccesses: 10, weightedFailures: 0,
    lastCalledAt: stamp - 60 * DAY, lastDecayedAt: stamp - 60 * DAY,
  });
  const est = memory.getBayesianEstimate('model-old', 'analysis');
  const expected = 10 * Math.pow(0.5, 60 / DECAY_HALF_LIFE_DAYS); // 两个半衰期 → 2.5
  check(
    'S1 时间衰减：60 天前 10 成功证据 → 有效样本 ≈ 2.5（近期证据主导）',
    Boolean(est) && approx(est.effectiveSamples, expected, 0.1) && est.effectiveSamples < 3,
    `10 条 60 天前的成功证据经两个半衰期折价 → effectiveSamples=${est.effectiveSamples.toFixed(2)}（期望 ≈${expected.toFixed(2)}）——旧证据自然让位于新证据`,
  );
  memory.dispose();
  fs.rmSync(memPath.replace(/\.json$/, '-s1.json'), { force: true });
  fs.rmSync(memPath.replace(/\.json$/, '-s1.db'), { force: true });
}

// ── S3：UCB 冷启动探索（信息价值翻转利用端最优） ──
{
  const memory = new LongTermMemory(memPath.replace(/\.json$/, '-s3.json'));
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-established', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { general: 0.9 } } });
  llm.registerModel({ id: 'model-newcomer', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { general: 0.72 } } });
  seedProfile(memory, 'model-established', 'general', {
    totalCalls: 10, successCount: 10,
    weightedSuccesses: 10, weightedFailures: 0,
    lastCalledAt: stamp, lastDecayedAt: stamp,
  });
  const scheduler = new ModelScheduler({ llm, memory, config: { exploreBonus: 0.2 } });

  const pure = new ModelScheduler({ llm, memory, config: { explorationEnabled: false } });
  const purePick = pure.assignModel('general');
  const insight = scheduler.assignModelWithInsight('general');
  check(
    'S3 UCB 冷启动探索：零样本模型凭信息价值翻转胜出（exploration=true）',
    purePick === 'model-established' && insight.modelId === 'model-newcomer' && insight.exploration === true && insight.effectiveSamples === 0,
    `纯利用端选 ${purePick}（画像 10/10 全成）；开探索后选 ${insight.modelId}（置信度 ${insight.confidence.toFixed(2)}）——${insight.rationale}`,
  );
  memory.dispose();
  llm.dispose();
  fs.rmSync(memPath.replace(/\.json$/, '-s3.json'), { force: true });
  fs.rmSync(memPath.replace(/\.json$/, '-s3.db'), { force: true });
}

// ── S4：漂移救回（被早期失败埋没的模型翻身） ──
{
  const memory = new LongTermMemory(memPath.replace(/\.json$/, '-s4.json'));
  // 45 天前：8 次调用 2 成 6 败（weightedFailures=6 已是当时的衰减值）
  seedProfile(memory, 'model-recovered', 'refactor', {
    totalCalls: 8, successCount: 2,
    weightedSuccesses: 0, weightedFailures: 6,
    lastCalledAt: stamp - 45 * DAY, lastDecayedAt: stamp - 45 * DAY,
  });
  // 近期：连续 3 次成功（模型能力已修复）
  for (let i = 0; i < 3; i += 1) {
    memory.recordSuccess({
      taskType: 'refactor', complexity: 0.5, features: [], taskSummary: 'refactor task',
      plan: { objective: 'refactor', nodes: [{ id: 'n1', description: 'd', type: 'refactor', dependsOn: [] }], parallelismStrategy: 'sequential' },
      modelAssignments: { n1: 'model-recovered' },
      totalLatency: 100, qualityScores: { n1: 0.9 }, tokenCost: 10,
    });
  }
  const est = memory.getBayesianEstimate('model-recovered', 'refactor');
  check(
    'S4 漂移救回：早期 6 败 + 近期 3 连胜 → drift>0.1，后验反超裸成功率',
    Boolean(est) && est.drift > 0.1 && est.posteriorMean > est.rawSuccessRate + 0.1,
    `裸成功率 ${est.rawSuccessRate.toFixed(2)}（8 中 2 成的历史包袱）vs 贝叶斯后验 ${est.posteriorMean.toFixed(2)}（45 天前的失败衰减至 ${est.beta.toFixed(1)} 权重），drift=${est.drift.toFixed(2)}——模型修复被察觉，不再永久埋没`,
  );
  memory.dispose();
  fs.rmSync(memPath.replace(/\.json$/, '-s4.json'), { force: true });
  fs.rmSync(memPath.replace(/\.json$/, '-s4.db'), { force: true });
}

// ── S5 + S6 + S9：反思器（校准 / 反事实 / 兼容） ──
{
  const memory = new LongTermMemory(memPath.replace(/\.json$/, '-s56.json'));
  const reflection = new ReflectionEngine({ qualityThreshold: 0.7 });

  const signal = { id: 'sig-s5', type: 'code-generation', description: '校准验证', payload: {}, receivedAt: stamp, source: 'verify', occurrences: 1 };
  const plan = { objective: 'o', nodes: [{ id: 'n1', description: 'd', type: 'code-generation', dependsOn: [] }], parallelismStrategy: 'sequential', source: 'fallback' };
  const result = (modelId, success) => ({
    planId: 'p1', success, nodeResults: [{ nodeId: 'n1', modelId, success, quality: success ? 0.9 : 0.3, latency: 100, attempts: 1, tokensUsed: 50 }],
    totalTime: 100, successCount: success ? 1 : 0, totalTokens: 50, avgQuality: success ? 0.9 : 0.3,
  });
  const insight = (modelId, predicted, success) => ({
    nodeId: 'n1', taskType: 'code-generation', modelId, predictedConfidence: predicted, exploration: false, success,
  });

  // S5a 过自信：预测 0.9 连续 12 次全失败
  const overconfidentReflector = new Reflector({ memory, reflection: new ReflectionEngine({ qualityThreshold: 0.7 }), config: { enableProgress: false } });
  for (let i = 0; i < 12; i += 1) {
    overconfidentReflector.reflectOnOutcome({ signal, plan, result: result('model-strong', false), decisionInsights: [insight('model-strong', 0.9, false)] });
  }
  const oc = overconfidentReflector.getCalibration();

  // S5b 校准良好：预测 0.5 六成六败
  const calibratedReflector = new Reflector({ memory, reflection: new ReflectionEngine({ qualityThreshold: 0.7 }), config: { enableProgress: false } });
  for (let i = 0; i < 12; i += 1) {
    const success = i % 2 === 0;
    calibratedReflector.reflectOnOutcome({ signal, plan, result: result('model-strong', success), decisionInsights: [insight('model-strong', 0.5, success)] });
  }
  const cal = calibratedReflector.getCalibration();

  check(
    'S5 校准闭环：过自信被自知（Brier 0.81 / direction=overconfident），预测准 → calibrated',
    approx(oc.brierScore, 0.81, 0.01) && oc.direction === 'overconfident' && oc.samples === 12 &&
      approx(cal.brierScore, 0.25, 0.01) && cal.direction === 'calibrated',
    `预测 0.9 全失败 → Brier=${oc.brierScore.toFixed(2)}、残差=${oc.residualMean.toFixed(2)}（${oc.direction}）；预测 0.5 实际六成六败 → Brier=${cal.brierScore.toFixed(2)}（${cal.direction}）——系统知道自己有多准`,
  );

  // S6 反事实遗憾：用了后验低的模型，存在显著更优替代者
  seedProfile(memory, 'model-weak', 'code-generation', {
    totalCalls: 10, successCount: 3,
    weightedSuccesses: 2, weightedFailures: 6,
    lastCalledAt: stamp, lastDecayedAt: stamp,
  });
  seedProfile(memory, 'model-strong', 'code-generation', {
    totalCalls: 20, successCount: 20,
    weightedSuccesses: 18, weightedFailures: 0,
    lastCalledAt: stamp, lastDecayedAt: stamp,
  });
  const cfReflector = new Reflector({ memory, reflection, config: { enableProgress: false } });
  cfReflector.reflectOnOutcome({ signal, plan, result: result('model-weak', false) }); // 无 decisionInsights → 同时覆盖 S9 兼容
  const cfLesson = memory.getRecentFeedback(10).find((f) => f.lesson?.includes('[反事实]'));

  check(
    'S6 反事实遗憾：用了后验 0.3 的模型、存在下界 0.84 的更优者 → 教训沉淀入记忆',
    Boolean(cfLesson) && cfLesson.lesson.includes('model-strong') && cfLesson.chosenModelId === 'model-weak',
    `${cfLesson ? cfLesson.lesson : '未生成'}——「本可以更优」成为可检索记忆而非事后遗忘`,
  );

  // S9：签名与旧参数兼容
  const llm = makeLLM();
  const scheduler = new ModelScheduler({ llm, memory });
  const pick = scheduler.assignModel('code-generation');
  check(
    'S9 签名回归：assignModel 仍返回 string；旧参数 reflectOnOutcome（无 decisionInsights）正常',
    typeof pick === 'string' && memory.getBayesianEstimate('no-such-model', 'any') === undefined,
    `assignModel → "${pick}"（string，签名未变）；无 decisionInsights 的复盘正常完成；不存在模型返回 undefined`,
  );
  llm.dispose();
  memory.dispose();
  fs.rmSync(memPath.replace(/\.json$/, '-s56.json'), { force: true });
  fs.rmSync(memPath.replace(/\.json$/, '-s56.db'), { force: true });
}

// ── S7：端到端闭环（洞察桥接 + 校准累积 + 取走即清空） ──
{
  const memory = new LongTermMemory(memPath);
  const graphPath = path.join(os.tmpdir(), `dsh-verify-v2-graph-${stamp}.json`);
  const llm = makeLLM();
  const scheduler = new ModelScheduler({ llm, memory, config: { costWeight: 0.2 } });
  const optimizer = new Optimizer({ memory, config: { memoryFastPathThreshold: 0.9 } });
  const reflectionEngine = new ReflectionEngine({ qualityThreshold: 0.7 });
  const usedModels = [];
  const nodeRunner = async ({ node, modelId }) => {
    usedModels.push(modelId);
    return modelId === 'model-strong'
      ? { output: `ok:${node.id}`, quality: 0.92, tokensUsed: 100 }
      : { output: `poor:${node.id}`, quality: 0.35, tokensUsed: 80 };
  };
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 30_000, nodeTimeout: 5_000, enableProgress: false, verbose: false },
    llm, modelScheduler: scheduler, nodeRunner, reflection: reflectionEngine,
  });
  const reflector = new Reflector({ memory, reflection: reflectionEngine, config: { enableProgress: false } });

  let recommendedExpected = 0;
  let recommendedHonored = 0;
  let insightTotal = 0;

  for (let round = 1; round <= 8; round += 1) {
    const signal = { id: `sig-${round}`, type: 'code-generation', description: `实现排序函数 v${round}`, payload: {}, receivedAt: Date.now(), source: 'verify', occurrences: 1 };
    usedModels.length = 0;
    const lookup = optimizer.lookupExperience('code-generation', 0.5);
    let plan = optimizer.recallPlan(lookup, signal.description);
    if (!plan) plan = executor.buildPlan(signal.description, undefined, 'code-generation');

    const result = await executor.executePlan(signal, plan, lookup.recommendedModels);

    // 洞察桥接：执行器 → 反思器（编排层同 index.ts 第 10 步）
    const insights = executor.getAndClearDecisionInsights();
    insightTotal += insights.length;
    reflector.reflectOnOutcome({
      signal, plan, result,
      appliedStrategies: memory.getStrategies('code-generation', 3).map((s) => s.id),
      decisionInsights: insights,
    });

    const recommended = lookup.recommendedModels['code-generation'];
    for (const m of usedModels) {
      if (recommended) {
        recommendedExpected += 1;
        if (m === recommended) recommendedHonored += 1;
      }
    }
  }

  const cal = reflector.getCalibration();
  const takenTwice = executor.getAndClearDecisionInsights().length;
  const strongEst = memory.getBayesianEstimate('model-strong', 'code-generation');
  check(
    'S7 端到端：洞察桥接执行器→反思器，校准样本累积，推荐采纳与取走即清空',
    insightTotal >= 8 &&
      cal.samples === insightTotal &&
      takenTwice === 0 &&
      recommendedExpected > 0 && recommendedHonored === recommendedExpected &&
      Boolean(strongEst) && strongEst.posteriorMean > 0.88,
    `8 轮共 ${insightTotal} 条洞察全部回注（校准样本=${cal.samples}，Brier=${cal.brierScore.toFixed(2)}）；推荐模型 ${recommendedHonored}/${recommendedExpected} 采纳；二次取走为空（${takenTwice}）；model-strong 后验 ${strongEst.posteriorMean.toFixed(2)}`,
  );

  memory.dispose();
  llm.dispose();
  fs.rmSync(memPath, { force: true });
  fs.rmSync(memPath.replace(/\.json$/, '.db'), { force: true });
  fs.rmSync(graphPath, { force: true });
}

// ── S8：旧格式持久化兼容 ──
{
  const memory = new LongTermMemory(memPath.replace(/\.json$/, '-s8.json'));
  // 旧版画像：无 weighted / emaQuality / lastDecayedAt 字段
  memory.upsertModelProfile({
    id: 'model-legacy', name: 'legacy',
    taskHistory: { general: { totalCalls: 10, successCount: 8, totalLatency: 1000, totalQualityScore: 6.4, avgQualityScore: 0.8, lastCalledAt: stamp } },
    costEfficiency: {}, bestTaskType: 'general', worstTaskType: 'general', stability: 0.8,
  });
  const est = memory.getBayesianEstimate('model-legacy', 'general');
  check(
    'S8 旧格式兼容：无 weighted 字段的画像 → 0.5 折价回退裸计数，不炸不丢',
    Boolean(est) && approx(est.effectiveSamples, 5, 0.1) && approx(est.posteriorMean, 5 / 7, 0.01),
    `10 调 8 成的旧画像（无时间信息）→ 有效样本 ${est.effectiveSamples.toFixed(1)}（10×0.5 折价）、后验 ${est.posteriorMean.toFixed(2)}（Beta(5,2)）——旧记忆平滑升级，下次写入完成加权初始化`,
  );
  memory.dispose();
  fs.rmSync(memPath.replace(/\.json$/, '-s8.json'), { force: true });
  fs.rmSync(memPath.replace(/\.json$/, '-s8.db'), { force: true });
}

// ── 结果输出 ──
console.log('\n=== 第一阶段 2.0「统计学习决策」质级升级验证 ===\n');
console.log('=== 断言结果 ===\n');
let allPass = true;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ${c.detail}`);
  if (!c.pass) allPass = false;
}
console.log(
  allPass
    ? '\n✓ 第一阶段 2.0 全部通过：时间加权贝叶斯画像 × Wilson 利用 × UCB 探索 × 校准/反事实反思——记忆-反思-优化闭环从「经验回放」跃迁到「贝叶斯学习」。'
    : '\n✗ 存在未通过的断言，请检查。',
);
process.exit(allPass ? 0 : 1);
