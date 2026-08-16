/**
 * verify-meta-cognition-v2.mjs — 第四阶段「元认知层 2.0：学习型稳态控制」升级验证
 *
 * 从「规则诊断 + 固定步长」到「预测性 + 学习型 + 安全内建」的质级跃迁：
 *
 *   V2-A 趋势预测：多份报告形成下降趋势 → 最小二乘外推（slope/R²/置信度）
 *     + 风险阈值越限检测（crossesRiskThreshold：3 期内穿越 0.7 健康线）
 *   V2-B 前瞻性调整：指标当前仍健康但预测越限 → proactive 候选注入
 *     → 在风险发生前行动（reactive 互补）
 *   V2-C 稳态自适应步长：判定指标偏离目标带越远步长越大
 *     （带外 50% → 2×；带外 200% → 3× 封顶；带内 → 1×）
 *   V2-D 综合判定护栏：目标指标改善（存活率 0→0.25）但操作环成功率
 *     显著劣化（0.8→0.4）→ 一票否决回滚（单指标优化不得以整体劣化为代价）
 *   V2-E 经验安全包络：自动回滚过的取值（0.025）预防性排除 → 落到
 *     次优候选；双排除后落到安全候选 / 全排除 → no-op
 *   V2-F 调参策略学习器（乐观先验 Bandit）：commit/rollback 入学习臂 →
 *     有效性快照（trials/commits/effectivenessScore）+ 学习评分接管候选排序
 *     （seeds 学习后 0.833 胜过规则优先级更高的 minGain 0.756）
 *   V2-G 熔断器：全局连续 3 次自动回滚 → 全局熔断（frozen）；单旋钮
 *     连续 2 次 → 旋钮熔断；reArmBreaker 单旋钮复位不解全局 / 全部复位恢复
 *   V2-H 元认知自察：学习器/熔断器/包络/稳态带经 getMetaLayerState 回注
 *     心智报告（metaStability + knobEffectiveness）+ formatReport 输出
 *   V2-I 2.0 状态持久化：重启恢复学习臂/安全包络/熔断器（跨进程连续学习）
 *
 * 全程离线（不依赖 LLM 网络调用 / 定时器）。
 * 运行：npm run build && node scripts/verify-meta-cognition-v2.mjs
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

/** 批量反馈：successes/total 条（成功=good，失败=failed） */
const feedbackWith = (prefix, successes, total, taskType = 'code-generation', at = T0 + 6 * HOUR) =>
  Array.from({ length: total }, (_, i) =>
    fb(`${prefix}-${i}`, taskType, i < successes ? 'good' : 'failed', at + i * 60_000),
  );

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

const collectorsOf = (state, extra = {}) => ({
  getEvolverStatus: () => state.evolverStatus,
  getMemoryStats: () => state.memoryCounts,
  getGlobalStats: () => state.globalStats,
  getDistillationProgress: () => state.distillation,
  getRecentFeedback: (limit) => state.feedback.slice(-limit),
  ...extra,
});

/** 每场景独立的真实组件集（旋钮 read/write 落地对象） */
const allComponents = [];
const makeComponents = () => {
  const memPath = path.join(os.tmpdir(), `dsh-verify-mc2-mem-${stamp}-${allComponents.length}.json`);
  const memory = new LongTermMemory(memPath);
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-a', endpoint: 'http://localhost:11434/v1', initialCapabilities: { taskScores: { general: 0.8 } } });
  const scheduler = new ModelScheduler({ llm, memory });
  const optimizer = new Optimizer({ memory, policyProvider: () => scheduler.getPolicy() });
  const reflectionEngine = new ReflectionEngine();
  const reflector = new Reflector({ memory, reflection: reflectionEngine });
  const policyEvolver = new PolicyEvolver({ rng: mulberry32(42) }, createBaselinePolicy('policy-mc2-baseline', 1));
  const policySandbox = new Sandbox({
    models: [{ id: 'model-a', taskScores: { general: 0.8 }, avgLatencyMs: 800, avgTokens: 600, maxConcurrency: 4 }],
    tasks: [],
  });
  const c = { memory, llm, optimizer, reflector, policyEvolver, policySandbox, memPath };
  allComponents.push(c);
  return c;
};

/** 与 index.ts 相同的六旋钮注册（真实组件 read/write） */
const buildKnobs = (c) => [
  {
    id: 'reflector.autoDistillThreshold', label: '反思器自动蒸馏阈值', category: 'reflector',
    min: 2, max: 20, step: 1, integer: true,
    read: () => c.reflector.getConfig().autoDistillThreshold ?? 5,
    write: (v) => c.reflector.updateConfig({ autoDistillThreshold: v }),
    judgeMetric: 'pendingDistillation', higherIsBetter: false,
  },
  {
    id: 'reflector.distillMinConfidence', label: '知识蒸馏写入置信度门槛', category: 'reflector',
    min: 0.4, max: 0.8, step: 0.05,
    read: () => c.reflector.getConfig().distillMinConfidence ?? 0.6,
    write: (v) => c.reflector.updateConfig({ distillMinConfidence: v }),
    judgeMetric: 'proceduralGrowth', higherIsBetter: true,
  },
  {
    id: 'evolver.mutationRate', label: '进化器变异率', category: 'evolver',
    min: 0.2, max: 0.9, step: 0.1,
    read: () => c.policyEvolver.getTunableParams().mutationRate,
    write: (v) => c.policyEvolver.updateConfig({ mutationRate: v }),
    judgeMetric: 'discoveryRate', higherIsBetter: true,
  },
  {
    id: 'evolver.minGain', label: '进化器部署门禁（选择压力）', category: 'evolver',
    min: 0.001, max: 0.05, step: 0.005,
    read: () => c.policyEvolver.getTunableParams().minGain,
    write: (v) => c.policyEvolver.updateConfig({ minGain: v }),
    judgeMetric: 'survivalRate', higherIsBetter: true,
  },
  {
    id: 'sandbox.evaluationSeeds', label: '沙盒多种子评估严格度', category: 'sandbox',
    min: 1, max: 7, step: 1, integer: true,
    read: () => c.policySandbox.getConfig().evaluationSeeds ?? 3,
    write: (v) => c.policySandbox.updateConfig({ evaluationSeeds: v }),
    judgeMetric: 'survivalRate', higherIsBetter: true,
  },
  {
    id: 'optimizer.memoryFastPathThreshold', label: '记忆快路径复用门槛', category: 'memory',
    min: 0.7, max: 0.95, step: 0.05,
    read: () => c.optimizer.getConfig().memoryFastPathThreshold ?? 0.9,
    write: (v) => c.optimizer.updateConfig({ memoryFastPathThreshold: v }),
    judgeMetric: 'operationalSuccessRate', higherIsBetter: true,
  },
];

// ══════════════════ V2-A / V2-B：趋势预测 + 前瞻性调整 ══════════════════
{
  const state = makeState();
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });

  // 三份历史报告形成成功率下降趋势：0.92 → 0.88 → 0.84
  state.feedback = feedbackWith('fa', 23, 25);
  await selfModel.generateMentalReport();
  state.feedback = feedbackWith('fb', 22, 25);
  await selfModel.generateMentalReport();
  state.feedback = feedbackWith('fc', 21, 25);
  await selfModel.generateMentalReport();

  // 第 4 份：0.80 —— 按斜率 -0.04 将在 3 期内穿越 0.7 风险阈值
  state.feedback = feedbackWith('fd', 20, 25);
  const report4 = await selfModel.generateMentalReport();
  const forecast = report4.forecasts?.find((f) => f.metric === 'operationalSuccessRate');
  check(
    'V2-A 趋势预测：最小二乘外推（slope -0.04/期，R²=1）+ 风险阈值越限检测（3 期内穿越 0.7）',
    forecast !== undefined &&
      Math.abs(forecast.slopePerReport - -0.04) < 1e-6 &&
      forecast.currentValue === 0.8 &&
      forecast.r2 === 1 &&
      forecast.confidence === 'high' &&
      Math.abs(forecast.predictedValue - 0.68) < 1e-6 &&
      forecast.crossesRiskThreshold?.threshold === 0.7 &&
      forecast.crossesRiskThreshold?.direction === 'below' &&
      forecast.crossesRiskThreshold?.withinReports === 3,
    `操作环成功率 0.92→0.88→0.84→0.80（-0.04/期，R²=1.00，置信 high）→ 3 期外推 ${forecast?.predictededValue ?? forecast?.predictedValue}，预计 ${forecast?.crossesRiskThreshold?.withinReports} 期内穿越 0.7 健康线`,
  );

  const risk = report4.proactiveRisks?.[0];
  check(
    'V2-A 前瞻风险产出：预测越限 → 紧迫度 + 建议旋钮（自我建模从被动描述升级为主动预测）',
    report4.proactiveRisks?.length === 1 &&
      risk?.metric === 'operationalSuccessRate' &&
      risk?.suggestedKnob === 'evolver.mutationRate' &&
      risk?.suggestedDirection === 'up' &&
      risk?.urgency === 0.6 &&
      risk.description.includes('仍健康'),
    `proactiveRisks[0]: ${risk?.description?.slice(0, 60)}… → 建议 ${risk?.suggestedKnob} ↑（紧迫度 ${risk?.urgency}）——当前 0.80 仍健康，按趋势提前行动`,
  );

  // ── V2-B：前瞻候选注入（reactive 候选为空时 proactive 独立驱动调整） ──
  // 第 5 份报告延续下降趋势（0.92→0.88→0.84→0.80→0.76，斜率恒 -0.04）→ 越限窗口 2 期内
  state.feedback = feedbackWith('fe', 19, 25);
  const c = makeComponents();
  const controller = new MetaCognitiveController({ selfModel, knobs: buildKnobs(c) });
  const round = await controller.evaluateAndAdjust();
  const adjustEntry = controller.getAuditTrail().find((e) => e.type === 'adjust');
  check(
    'V2-B 前瞻性调整：无反应式推荐时前瞻风险独立驱动 → applied source=proactive（风险发生前行动）',
    round.status === 'adjusted' &&
      round.applied.length === 1 &&
      round.applied[0].knob === 'evolver.mutationRate' &&
      round.applied[0].source === 'proactive' &&
      round.applied[0].from === 0.6 &&
      round.applied[0].to === 0.7 &&
      c.policyEvolver.getTunableParams().mutationRate === 0.7 &&
      adjustEntry?.source === 'proactive' &&
      round.applied[0].reason.includes('[前瞻]'),
    `报告 #${round.reportIndex} 反应式推荐为空（成功率 0.76 仍健康）→ 前瞻候选「变异率↑」被应用 0.6→0.7（source=proactive，真实进化器生效），审计同标 proactive——与反应式规则互补的双通道候选`,
  );
}

// ══════════════════ V2-C：稳态自适应步长 ══════════════════
{
  const c = makeComponents();

  // C-a：发现速率 0（带 [0.1, 0.3]，偏离 50%）→ 步长 ×2
  const s1 = makeState({
    feedback: [
      fb('ca1', 'refactor', 'failed', T0 + HOUR),
      fb('ca2', 'refactor', 'failed', T0 + 1.1 * HOUR),
      fb('ca3', 'refactor', 'poor', T0 + 1.2 * HOUR),
      fb('ca4', 'refactor', 'good', T0 + 1.3 * HOUR),
    ],
  });
  s1.evolverStatus = { ...s1.evolverStatus, deployedHistory: [{ id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 }] };
  const r1 = await new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(s1) }),
    knobs: buildKnobs(c),
    config: { homeostasisBands: { discoveryRate: { min: 0.1, max: 0.3 } } },
  }).evaluateAndAdjust();

  // C-b：蒸馏积压 8（带 [0, 10] 内）→ 步长 ×1
  const s2 = makeState({ feedback: feedbackWith('cb', 3, 3), distillation: { pendingSinceLastDistillation: 8 } });
  const r2 = await new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(s2) }),
    knobs: buildKnobs(c),
    config: { homeostasisBands: { pendingDistillation: { min: 0, max: 10 } } },
  }).evaluateAndAdjust();

  // C-c：蒸馏积压 30（带 [0, 10]，偏离 200%）→ 步长 ×3（maxStepMultiplier 封顶）
  c.reflector.updateConfig({ autoDistillThreshold: 5 }); // 复位 C-b 影响后的旋钮起点
  const s3 = makeState({ feedback: feedbackWith('cc', 3, 3), distillation: { pendingSinceLastDistillation: 30 } });
  const r3 = await new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(s3) }),
    knobs: buildKnobs(c),
    config: { homeostasisBands: { pendingDistillation: { min: 0, max: 10 } } },
  }).evaluateAndAdjust();

  check(
    'V2-C 稳态自适应步长：偏离目标带越远步长越大（带外 50% → ×2 / 带外 200% → ×3 封顶 / 带内 → ×1）',
    r1.status === 'adjusted' &&
      r1.applied[0].knob === 'evolver.mutationRate' &&
      r1.applied[0].to === 0.8 && // 0.6 + 0.1×2（discoveryRate=0 偏离带 50%）
      r2.status === 'adjusted' &&
      r2.applied[0].knob === 'reflector.autoDistillThreshold' &&
      r2.applied[0].to === 4 && // 5 - 1×1（积压 8 带内）
      r3.status === 'adjusted' &&
      r3.applied[0].knob === 'reflector.autoDistillThreshold' &&
      r3.applied[0].to === 2 && // 5 - 1×3（积压 30 偏离带 200%，封顶 3×）
      r1.applied[0].reason.includes('盲点'),
    `发现速率 0（带 [0.1,0.3] 偏离 50%）→ 变异率 0.6→0.8（×2）；积压 8（带内）→ 蒸馏阈值 5→4（×1）；积压 30（偏离 200%）→ 5→2（×3 封顶）——比例控制量化档位，带内保持保守`,
  );
}

// ══════════════════ V2-D / V2-E / V2-F：护栏 + 包络 + 学习器（连续场景） ══════════════════
{
  const c = makeComponents();
  const state = makeState({ feedback: feedbackWith('d', 8, 10) });
  // 3 部署全回滚（存活率 0）→ 门禁↑/沙盒↑推荐
  state.evolverStatus = {
    ...state.evolverStatus,
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-2', version: 2, generation: 1, origin: 'mutation', gain: 0.01, deployedAt: T0 + 3 * HOUR, rolledBackAt: T0 + 3.4 * HOUR },
      { id: 'p-3', version: 3, generation: 2, origin: 'mutation', gain: 0.01, deployedAt: T0 + 4 * HOUR, rolledBackAt: T0 + 4.4 * HOUR },
      { id: 'p-4', version: 4, generation: 3, origin: 'mutation', gain: 0.01, deployedAt: T0 + 5 * HOUR, rolledBackAt: T0 + 5.4 * HOUR },
    ],
  };
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });
  const controller = new MetaCognitiveController({
    selfModel,
    knobs: buildKnobs(c),
    config: { observationReports: 2, degradationTolerance: 0.02 },
  });

  // R1：门禁↑ 0.02→0.025（观察基线：存活率 0，操作环 0.8）
  const r1 = await controller.evaluateAndAdjust();
  // R2：观察 1/2
  await controller.evaluateAndAdjust();
  // R3：存活率改善（+1 存活部署 → 0.25）但操作环劣化（0.8→0.4）→ 护栏一票否决
  state.evolverStatus = {
    ...state.evolverStatus,
    deployedHistory: [...state.evolverStatus.deployedHistory, { id: 'p-5', version: 5, generation: 4, origin: 'crossover', gain: 0.02, deployedAt: T0 + 6 * HOUR }],
  };
  state.feedback = feedbackWith('d3', 4, 10);
  const r3 = await controller.evaluateAndAdjust();
  const rollbackEntry = controller.getAuditTrail().filter((e) => e.type === 'rollback').pop();
  check(
    'V2-D 综合判定护栏：目标指标改善（存活率 0→0.25）但操作环成功率 0.8→0.4 → 一票否决回滚',
    r1.applied[0].knob === 'evolver.minGain' &&
      r1.applied[0].to === 0.025 &&
      r3.status === 'rolled-back' &&
      Math.abs(r3.rolledBack?.effect.delta - 0.25) < 1e-9 &&
      r3.rolledBack?.effect.good === false &&
      rollbackEntry?.guardrail?.violated === true &&
      Math.abs(rollbackEntry?.guardrail?.delta - -0.4) < 1e-9 &&
      c.policyEvolver.getTunableParams().minGain === 0.02,
    `门禁 0.02→0.025 观察期：存活率 0→0.25（目标指标「改善」）但护栏检测操作环 0.80→0.40（劣化 0.40 > 容忍 0.02）→ 判失败自动回滚至 0.02，审计 guardrail{violated:true}——单指标优化不得以整体劣化为代价`,
  );

  // R4：minGain 0.025 已知劣化 → 预防性排除 → 学习评分最高的 seeds 被选
  const r4 = await controller.evaluateAndAdjust();
  const envAfterR3 = controller.getState().safeEnvelopes.find((e) => e.knob === 'evolver.minGain');
  check(
    'V2-E 经验安全包络（预防）：自动回滚取值 0.025 进入已知劣化清单 → 后续调整预防性排除',
    envAfterR3?.knownBadValues?.includes(0.025) === true &&
      r4.status === 'adjusted' &&
      r4.applied[0].knob === 'sandbox.evaluationSeeds' &&
      r4.applied[0].from === 3 &&
      r4.applied[0].to === 4,
    `envelope(evolver.minGain).knownBad=[0.025] → R4 候选 minGain(0.02+0.005=0.025) 命中排除 → 落到次优候选 seeds 3→4：prevention > rollback（劣化值不再重试）`,
  );

  // R5：观察；R6：指标平稳（存活率 0.25 持平 + 操作环 0.4 持平）→ commit
  await controller.evaluateAndAdjust();
  const r6 = await controller.evaluateAndAdjust();
  const eff6 = controller.getState().learner.effectiveness;
  const minGainArm = eff6.find((a) => a.knob === 'evolver.minGain');
  const seedsArm = eff6.find((a) => a.knob === 'sandbox.evaluationSeeds');
  const envSeeds = controller.getState().safeEnvelopes.find((e) => e.knob === 'sandbox.evaluationSeeds');
  check(
    'V2-F 学习器入账 + 包络收录好值：commit/rollback 分别记入学习臂，commit 值进入已验证安全区间',
    r6.status === 'committed' &&
      minGainArm?.trials === 1 &&
      minGainArm?.commits === 0 &&
      minGainArm?.rollbacks === 1 &&
      Math.abs(minGainArm.effectivenessScore - 1.4 / 3) < 1e-9 &&
      seedsArm?.trials === 1 &&
      seedsArm?.commits === 1 &&
      seedsArm?.successRate === 1 &&
      Math.abs(seedsArm.effectivenessScore - 2.4 / 3) < 1e-9 &&
      envSeeds?.source === 'learned' &&
      envSeeds?.sampleCount === 1,
    `学习臂 minGain↑：1 试 0 成（评分 0.467）；seeds↑：1 试 1 成（评分 0.800）——乐观先验 Beta 平滑；commit 值 4 进入 envelopeGood（seeds 包络 source=learned，样本 1）`,
  );

  // R7：学习评分接管排序——seeds 学习后 0.833 > minGain 0.756（规则序 minGain 0.9 > seeds 0.85）
  const r7 = await controller.evaluateAndAdjust();
  check(
    'V2-F 学习评分接管候选排序：规则优先级低的 seeds 学习后反超规则优先级高的 minGain',
    r7.status === 'adjusted' &&
      r7.applied[0].knob === 'sandbox.evaluationSeeds' &&
      r7.applied[0].from === 4 &&
      r7.applied[0].to === 5,
    `selectionScore = (1−w)·规则优先级 + w·贝叶斯成功率（w=trials/(trials+2)）：seeds↑ = 2/3×0.85+1/3×0.80 = 0.833 > minGain↑ = 2/3×0.90+1/3×0.467 = 0.756 → 选择 seeds 4→5（规则序本会选 minGain，但 0.025 已被包络排除且学习评分更低）——元认知器在进化自己的调参策略`,
  );

  // R8：观察；R9：存活率 0.25→0（d5 回滚）→ 劣化自动回滚 seeds 5→4
  await controller.evaluateAndAdjust();
  state.evolverStatus = {
    ...state.evolverStatus,
    deployedHistory: state.evolverStatus.deployedHistory.map((d, i) =>
      i === state.evolverStatus.deployedHistory.length - 1 ? { ...d, rolledBackAt: T0 + 7 * HOUR } : d,
    ),
  };
  const r9 = await controller.evaluateAndAdjust();
  // R10：minGain 0.025（bad）与 seeds 5（bad）双排除 → 落到安全候选 mutationRate
  const r10 = await controller.evaluateAndAdjust();
  check(
    'V2-E 双重排除兜底：两个劣化候选全部排除后落到安全候选（mutationRate），绝不重试已知劣化值',
    r9.status === 'rolled-back' &&
      r9.rolledBack?.to === 4 &&
      controller.getState().safeEnvelopes.find((e) => e.knob === 'sandbox.evaluationSeeds')?.knownBadValues?.includes(5) === true &&
      r10.status === 'adjusted' &&
      r10.applied[0].knob === 'evolver.mutationRate' &&
      r10.applied[0].from === 0.6 &&
      r10.applied[0].to === 0.7,
    `R9 存活率 0.25→0 劣化 → seeds 回滚 5→4（5 入劣化清单）；R10 候选 minGain(0.025 bad) 与 seeds(5 bad) 双排除 → 盲点推荐 mutationRate 0.6→0.7 兜底执行`,
  );
}

// ══════════════════ V2-G / V2-H / V2-I：熔断器 + 元认知自察 + 持久化 ══════════════════
{
  const c = makeComponents();
  const auditPath = path.join(os.tmpdir(), `dsh-verify-mc2-audit-${stamp}.json`);
  fs.rmSync(auditPath, { force: true });

  const state = makeState({ feedback: feedbackWith('e', 8, 10), distillation: { pendingSinceLastDistillation: 10 } });
  // 3 部署 1 存活 2 回滚（存活率 1/3）→ 门禁↑推荐 + 蒸馏积压 10 → 蒸馏阈值↓推荐
  state.evolverStatus = {
    ...state.evolverStatus,
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'q-2', version: 2, generation: 1, origin: 'mutation', gain: 0.01, deployedAt: T0 + 3 * HOUR, rolledBackAt: T0 + 3.4 * HOUR },
      { id: 'q-3', version: 3, generation: 2, origin: 'mutation', gain: 0.01, deployedAt: T0 + 4 * HOUR, rolledBackAt: T0 + 4.4 * HOUR },
      { id: 'q-4', version: 4, generation: 3, origin: 'crossover', gain: 0.02, deployedAt: T0 + 5 * HOUR },
    ],
  };
  const selfModel = new SelfModel({
    collectors: collectorsOf(state, {
      // 元认知状态回注（与 index.ts 相同的桥接）
      getMetaLayerState: () => {
        const s = controller.getState();
        return {
          knobEffectiveness: s.learner.effectiveness,
          metaStability: {
            circuitBreakers: s.circuitBreakers,
            globalFrozen: s.frozen,
            frozenByBreaker: s.frozenByBreaker,
            safeEnvelopes: s.safeEnvelopes,
            learner: { totalTrials: s.learner.totalTrials, arms: s.learner.arms, explorationWeight: s.learner.explorationWeight },
          },
        };
      },
    }),
    config: { homeostasisBands: { survivalRate: { min: 0.7, max: 1.0 } } },
  });
  const controller = new MetaCognitiveController({
    selfModel,
    knobs: buildKnobs(c),
    config: { persistPath: auditPath, observationReports: 2, degradationTolerance: 0.02, breakerThreshold: 2, globalBreakerThreshold: 3 },
  });

  // R1：门禁↑ 0.02→0.025（基线：存活率 1/3、操作环 0.8、积压 10）
  await controller.evaluateAndAdjust();
  // R2：观察
  await controller.evaluateAndAdjust();
  // R3：存活率 1/3→0（q-4 回滚）→ 劣化回滚（global streak 1；minGain streak 1；bad[minGain]=[0.025]）
  state.evolverStatus = {
    ...state.evolverStatus,
    deployedHistory: state.evolverStatus.deployedHistory.map((d, i) =>
      i === 3 ? { ...d, rolledBackAt: T0 + 6 * HOUR } : d,
    ),
  };
  await controller.evaluateAndAdjust();
  // R4：minGain 排除 → seeds 3→4（基线：存活率 0、操作环 0.8）
  await controller.evaluateAndAdjust();
  // R5：观察
  await controller.evaluateAndAdjust();
  // R6：存活率持平但操作环 0.8→0.6 → 护栏违规回滚（global streak 2；seeds streak 1；bad[seeds]=[4]）
  state.feedback = feedbackWith('e6', 6, 10);
  await controller.evaluateAndAdjust();
  // R7：seeds 4 bad 排除 → 蒸馏阈值↓ 5→4（基线：积压 10）
  await controller.evaluateAndAdjust();
  // R8：观察
  await controller.evaluateAndAdjust();
  // R9：积压 10→40 → 劣化回滚 → global streak 3 → 全局熔断！
  state.distillation = { pendingSinceLastDistillation: 40 };
  const r9 = await controller.evaluateAndAdjust();
  const breakerAudits = controller.getAuditTrail().filter((e) => e.type === 'circuit-breaker');
  check(
    'V2-G 全局熔断：连续 3 次自动回滚（门禁→种子→蒸馏阈值）→ 自动调整全局冻结',
    r9.status === 'rolled-back' &&
      r9.rolledBack?.knob === 'reflector.autoDistillThreshold' &&
      controller.getState().frozenByBreaker === true &&
      breakerAudits.some((e) => e.reason.includes('全局')) === true,
    `三次回滚链：门禁↑（存活率劣化）→ 种子↑（护栏违规）→ 蒸馏阈值↓（积压 10→40 劣化）→ globalRollbackStreak=3 ≥ 阈值 3 → 全局熔断（审计 circuit-breaker×${breakerAudits.length}）`,
  );

  // R10：全局熔断中 → frozen
  const r10 = await controller.evaluateAndAdjust();
  check(
    'V2-G 熔断冻结生效：全局熔断期间 evaluateAndAdjust → frozen（区别于手动冻结，可审计）',
    r10.status === 'frozen' &&
      r10.applied.length === 0 &&
      r10.skippedReason?.includes('全局熔断') === true,
    `熔断期间评估 → ${r10.status}（${r10.skippedReason}）——连续回滚表明调参环境已变化，停止自动调整等待人工介入`,
  );

  // ── V2-H：元认知自察（学习器/熔断器/包络/稳态带回注心智报告） ──
  const selfAwareReport = await selfModel.generateMentalReport();
  const ms = selfAwareReport.metaStability;
  const fmt = selfModel.formatReport(selfAwareReport);
  check(
    'V2-H 元认知自察：熔断器/安全包络/学习器/稳态带回注心智报告（系统对自身调整机制的认知）',
    ms !== undefined &&
      ms.frozenByBreaker === true &&
      ms.circuitBreakers.filter((b) => b.consecutiveRollbacks > 0).length >= 3 &&
      ms.safeEnvelopes.find((e) => e.knob === 'evolver.minGain')?.knownBadValues.includes(0.025) === true &&
      ms.learner.totalTrials === 3 &&
      selfAwareReport.knobEffectiveness?.length === 3 &&
      ms.homeostasis.some((h) => h.metric === 'survivalRate' && h.state === 'out-of-band') === true &&
      fmt.includes('[元认知自察]') &&
      fmt.includes('全局熔断'),
    `心智报告 #${selfAwareReport.reportIndex} 新增 [元认知自察] 节：全局熔断中；3 个旋钮连续回滚计数；minGain 劣化值清单 [0.025]；学习器 3 次试验 3 臂；稳态带存活率 ${ms?.homeostasis.find((h) => h.metric === 'survivalRate')?.current}（带 [0.7,1.0] 越带）——外环把「自己」也纳入建模对象`,
  );

  // ── V2-I：2.0 状态持久化（学习臂/包络/熔断器跨重启恢复） ──
  const restored = new MetaCognitiveController({
    selfModel,
    knobs: buildKnobs(c),
    config: { persistPath: auditPath, observationReports: 2, degradationTolerance: 0.02, breakerThreshold: 2, globalBreakerThreshold: 3 },
  });
  const rs = restored.getState();
  check(
    'V2-I 2.0 状态持久化：重启恢复学习臂统计/安全包络劣化值/全局熔断（学习跨进程连续）',
    rs.frozenByBreaker === true &&
      rs.learner.totalTrials === 3 &&
      rs.learner.effectiveness.find((a) => a.knob === 'reflector.autoDistillThreshold')?.trials === 1 &&
      rs.safeEnvelopes.find((e) => e.knob === 'sandbox.evaluationSeeds')?.knownBadValues.includes(4) === true &&
      rs.safeEnvelopes.find((e) => e.knob === 'evolver.minGain')?.knownBadValues.includes(0.025) === true,
    `新实例从审计文件恢复：frozenByBreaker=true、学习器 3 试（蒸馏阈值臂 1 试）、劣化值清单 minGain[0.025]/seeds[4]——Bandit 学习与安全经验不因重启丢失`,
  );

  // ── V2-G 后半：reArmBreaker 复位 ──
  const reArmKnob = controller.reArmBreaker('evolver.minGain'); // 单旋钮复位（清零计数，不解全局）
  const r11 = await controller.evaluateAndAdjust();
  const reArmAll = controller.reArmBreaker(); // 全部复位
  const r12 = await controller.evaluateAndAdjust();
  check(
    'V2-G 熔断器手动复位：单旋钮复位不解全局熔断；全部复位后恢复自动调整',
    reArmKnob === true &&
      r11.status === 'frozen' &&
      reArmAll === true &&
      controller.getState().frozenByBreaker === false &&
      r12.status !== 'frozen',
    `reArmBreaker('evolver.minGain') 复位门禁旋钮计数 → 全局熔断仍在（R11 frozen）；reArmBreaker() 全部复位 → 自动调整恢复（R12 ${r12.status}，候选均已命中劣化值/观察窗推进）——故障排除后人工恢复通道`,
  );
  fs.rmSync(auditPath, { force: true });
}

// ══════════════════ 结果输出 ══════════════════
console.log('\n=== 第四阶段「元认知层 2.0：学习型稳态控制」升级验证 ===\n');
console.log('=== 断言结果 ===\n');
let allPass = true;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ${c.detail}`);
  if (!c.pass) allPass = false;
}

// 清理
for (const c of allComponents) {
  c.memory.dispose();
  c.llm.dispose();
  fs.rmSync(c.memPath, { force: true });
  fs.rmSync(c.memPath.replace(/\.json$/, '.db'), { force: true });
}

console.log(
  allPass
    ? '\n✓ 元认知层 2.0 全部通过：从「规则诊断 + 固定步长」升级到「学习型稳态控制」——趋势预测（前瞻风险）× Bandit 调参策略学习 × 稳态自适应步长 × 综合判定护栏 × 经验安全包络 × 熔断器 × 元认知自察 × 状态持久化，外环自身成为被观测、被学习、被保护的进化对象。'
    : '\n✗ 存在未通过的断言，请检查。',
);
process.exit(allPass ? 0 : 1);
