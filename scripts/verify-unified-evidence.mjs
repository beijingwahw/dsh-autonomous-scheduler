/**
 * verify-unified-evidence.mjs — 项目 3.0「统一证据内核 + 全层贝叶斯化 + 自知之明」闭环离线验证
 *
 * 升级主线（全部离线，不依赖 LLM / 定时器）：
 *   core/evidence.ts 统一证据内核（Wilson / 衰减 / Beta 后验 / 证据化排序分）
 *     → 记忆全层挂载 evidence（蒸馏策略 / 语义 / 程序 + 模型画像既有时间加权证据）
 *     → 反馈闭环统一观测（recordXxxOutcome → observeEvidence）
 *     → 检索排序证据化（confidence × Wilson 下界等权混合）
 *     → 沙盒校准贝叶斯化（posteriorQuality / effectiveSamples / drift 并行旁路）
 *     → 校准自修正（过自信收缩）+ 证据普查（evidenceCensus）+ 自知之明报告
 *
 * 验证断点：
 *   A 内核纯函数：Wilson 单调性 / 衰减半衰期 / legacy 折价 / 观测-读取闭环
 *   B 证据化排序分：小样本高置信 vs 大样本稳置信的排序反转 + 无证据回退
 *   C 策略层闭环：蒸馏铸币即带证据 → 应用反馈观测累积 → 检索证据化排序
 *   D 语义/程序层闭环：outcome 观测 + merged 证据叠加合并
 *   E 证据普查：四层统计 + 模型能力漂移检测（修复被察觉）
 *   F 校准自修正：过自信窗口 → correction 收缩预测；样本不足恒等
 *   G 沙盒校准贝叶斯化：证据字段填充 + legacy 手工条目逐位兼容
 *   H 自知之明报告 + 持久化：evidence 字段重启恢复
 *
 * 运行：npm run build && node scripts/verify-unified-evidence.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LongTermMemory,
  Reflector,
  ReflectionEngine,
  Sandbox,
  buildCalibrationFromMemory,
  createBaselinePolicy,
  generateAdversarialTasks,
  wilsonLowerBound,
  decayFactor,
  evidenceRankScore,
  initEvidence,
  observeEvidence,
  readEvidence,
  EVIDENCE_MIN_SAMPLES,
  LEGACY_EVIDENCE_DISCOUNT,
} from '../dist/index.mjs';

const TASK_TYPE = 'code-generation';
const STRONG = 'model-strong';
const DAY_MS = 86_400_000;

// ── 环境准备：独立临时持久化路径 ──
const stamp = Date.now();
const memPath = path.join(os.tmpdir(), `dsh-verify-ue-${stamp}.json`);
const calMemPath = path.join(os.tmpdir(), `dsh-verify-ue-cal-${stamp}.json`);
const calibMemPath = path.join(os.tmpdir(), `dsh-verify-ue-cb-${stamp}.json`);
for (const p of [memPath, calMemPath, calibMemPath]) fs.rmSync(p, { force: true });

const memory = new LongTermMemory(memPath);

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

// ══════════════════════════ 断点 A：内核纯函数 ══════════════════════════
{
  const now = Date.now();
  const wSmall = wilsonLowerBound(3, 0);
  const wBig = wilsonLowerBound(50, 0);
  const wFails = wilsonLowerBound(0, 50);
  check(
    '断点A Wilson 下界：小样本保守 + 样本单调 + 全失败归零',
    wSmall > 0 && wSmall < 0.6 && wBig > wSmall && wBig > 0.9 && wFails === 0 && wilsonLowerBound(0, 0) === 0,
    `wilson(3,0)=${wSmall.toFixed(4)} < wilson(50,0)=${wBig.toFixed(4)}（3 次全成不敢说 100%）；wilson(0,50)=${wFails}`,
  );

  const d0 = decayFactor(0);
  const d30 = decayFactor(30 * DAY_MS);
  const dFuture = decayFactor(-1000);
  check(
    '断点A 时间衰减：30 天半衰期精确折半 + 未来时间不放大',
    d0 === 1 && Math.abs(d30 - 0.5) < 1e-9 && dFuture === 1,
    `decay(0)=${d0}，decay(30d)=${d30.toFixed(9)}，decay(-1s)=${dFuture}`,
  );

  const legacy = initEvidence(10, 20, now);
  check(
    '断点A legacy 折价初始化：裸计数 0.5 折价（与模型画像回退语义一致）',
    legacy.weightedSuccesses === 10 * LEGACY_EVIDENCE_DISCOUNT && legacy.weightedFailures === 10 * LEGACY_EVIDENCE_DISCOUNT && legacy.lastDecayedAt === now,
    `initEvidence(10, 20) → ws=${legacy.weightedSuccesses} / wf=${legacy.weightedFailures}（无时间信息 → 折价起步）`,
  );

  const ev = initEvidence(0, 0, now);
  observeEvidence(ev, true, now);
  observeEvidence(ev, true, now);
  observeEvidence(ev, true, now);
  observeEvidence(ev, false, now);
  const view = readEvidence(ev, now);
  check(
    '断点A 观测-读取闭环：写入式惰性衰减 + Beta(1,1) 后验 + Wilson 视图',
    Math.abs(ev.weightedSuccesses - 3) < 1e-3 && Math.abs(ev.weightedFailures - 1) < 1e-3 && Math.abs(view.effectiveSamples - 4) < 1e-3 && Math.abs(view.posteriorMean - 2 / 3) < 1e-3 && view.wilsonLower > 0 && view.wilsonLower < view.posteriorMean,
    `3 成 1 败 → ws=${ev.weightedSuccesses.toFixed(6)}/wf=${ev.weightedFailures.toFixed(6)}，有效样本=${view.effectiveSamples.toFixed(4)}，posteriorMean=(3+1)/(4+1+1)=${view.posteriorMean.toFixed(4)}，wilsonLower=${view.wilsonLower.toFixed(4)}（下界保守）`,
  );
}

// ══════════════════════════ 断点 B：证据化排序分 ══════════════════════════
{
  const now = Date.now();
  // 小样本高置信：confidence 0.95，仅 3 次全成（Wilson 下界 ≈ 0.44）
  const smallHiConf = { weightedSuccesses: 3, weightedFailures: 0, lastDecayedAt: now };
  // 大样本稳置信：confidence 0.85，50 次 48 成（Wilson 下界 ≈ 0.87）
  const bigSteady = { weightedSuccesses: 48, weightedFailures: 2, lastDecayedAt: now };
  const rankSmall = evidenceRankScore(0.95, smallHiConf, now);
  const rankBig = evidenceRankScore(0.85, bigSteady, now);
  const rankNoEvidence = evidenceRankScore(0.7, undefined, now);
  const rankThin = evidenceRankScore(0.9, { weightedSuccesses: 1, weightedFailures: 0, lastDecayedAt: now }, now);
  check(
    '断点B 证据化排序分：大样本稳置信反超小样本高置信（裸置信度做不到）',
    rankBig > rankSmall && rankSmall < 0.95 && rankBig > 0.85 && rankBig < 0.9,
    `rank(0.95, 3/3)=${rankSmall.toFixed(4)} < rank(0.85, 48/50)=${rankBig.toFixed(4)}——小样本高置信不再压过大样本稳置信`,
  );
  check(
    '断点B 并行旁路：无证据 / 有效样本不足时回退裸 confidence（旧行为逐位一致）',
    rankNoEvidence === 0.7 && rankThin === 0.9 && EVIDENCE_MIN_SAMPLES === 3,
    `无证据 rank=0.7 原样返回；1 样本 < ${EVIDENCE_MIN_SAMPLES} → rank=0.9 原样返回（兼容旁路）`,
  );
}

// ══════════════════════════ 断点 C：策略层证据闭环 ══════════════════════════
let strategyWithEvidence;
{
  // 4 次同型成功 → 模式 confidence ≥ 0.6 → 蒸馏产出带证据的策略
  for (let i = 1; i <= 4; i += 1) {
    const nodeId = `node-${i}`;
    memory.recordSuccess({
      taskType: TASK_TYPE,
      complexity: 0.8,
      features: ['code'],
      taskSummary: `${TASK_TYPE}: 样本 ${i}`,
      plan: { objective: `目标 ${i}`, nodes: [{ id: nodeId, description: `步骤 ${i}`, type: TASK_TYPE, dependsOn: [] }], parallelismStrategy: 'layered' },
      modelAssignments: { [nodeId]: STRONG },
      totalLatency: 100 + i,
      qualityScores: { [nodeId]: 0.9 },
      tokenCost: 120,
    });
  }
  const fresh = memory.distillExperience();
  const withEvidence = fresh.filter((s) => s.evidence && s.evidence.weightedSuccesses > 0);
  check(
    '断点C 蒸馏铸币即带证据：distillExperience 产出的策略携带 legacy 折价证据',
    fresh.length >= 1 && withEvidence.length === fresh.length,
    `蒸馏 ${fresh.length} 条策略全部带 evidence（ws = 支撑数 × ${LEGACY_EVIDENCE_DISCOUNT}）：${fresh.map((s) => `${s.description.slice(0, 24)}… ws=${s.evidence.weightedSuccesses.toFixed(1)}`).join('；')}`,
  );

  strategyWithEvidence = withEvidence[0];
  const wsBefore = strategyWithEvidence.evidence.weightedSuccesses;
  for (let i = 0; i < 5; i += 1) memory.recordStrategyOutcome(strategyWithEvidence.id, true);
  const after = memory.getAllStrategies().find((s) => s.id === strategyWithEvidence.id);
  check(
    '断点C 应用反馈统一观测：recordStrategyOutcome 累积时间加权 Beta 证据',
    after.appliedTotal === 5 && after.evidence.weightedSuccesses > wsBefore + 4.9 && after.evidence.weightedSuccesses < wsBefore + 5.1,
    `ws ${wsBefore.toFixed(1)} → ${after.evidence.weightedSuccesses.toFixed(1)}（+5 次成功观测），appliedTotal=${after.appliedTotal}`,
  );

  const ranked = memory.getStrategies(TASK_TYPE);
  const rankSeq = ranked.map((s) => evidenceRankScore(s.confidence, s.evidence, Date.now()));
  const monotone = rankSeq.every((v, i) => i === 0 || rankSeq[i - 1] >= v);
  check(
    '断点C 检索证据化排序：getStrategies 按 confidence × Wilson 混合分降序',
    ranked.length >= 1 && monotone,
    `策略序列排序分：${rankSeq.map((v) => v.toFixed(4)).join(' ≥ ')}（非增序列）`,
  );
}

// ══════════════════════════ 断点 D：语义/程序记忆证据闭环 ══════════════════════════
{
  const now = Date.now();
  const sem = {
    id: 'sem-evd',
    domain: 'model-affinity',
    statement: 'code 任务亲和 model-strong',
    taskTypes: [TASK_TYPE],
    conditions: [],
    conclusion: { type: 'model-preference', value: STRONG, rationale: '验证' },
    confidence: 0.9,
    supportCount: 3,
    sourceFingerprints: ['fp-1'],
    distilledAt: now,
    appliedTotal: 0,
    appliedSuccesses: 0,
  };
  const created = memory.upsertSemanticMemory(sem);
  memory.recordSemanticOutcome('sem-evd', true);
  memory.recordSemanticOutcome('sem-evd', true);
  memory.recordSemanticOutcome('sem-evd', true);
  memory.recordSemanticOutcome('sem-evd', false);
  const semAfter = memory.getAllSemanticMemories().find((m) => m.id === 'sem-evd');
  const semOk =
    created === 'created' && semAfter.appliedTotal === 4 && Math.abs(semAfter.evidence.weightedSuccesses - 3) < 1e-3 && Math.abs(semAfter.evidence.weightedFailures - 1) < 1e-3;

  // merged 证据叠加：同 statement 异 id 携带新证据 → 支撑与证据一并合并
  const sem2 = { ...sem, id: 'sem-evd-2', supportCount: 2, evidence: { weightedSuccesses: 5, weightedFailures: 1, lastDecayedAt: now } };
  const merged = memory.upsertSemanticMemory(sem2);
  const mergedMem = memory.getAllSemanticMemories().find((m) => m.id === 'sem-evd');
  const mergeOk =
    merged === 'merged' && mergedMem.supportCount === 5 && Math.abs(mergedMem.evidence.weightedSuccesses - 8) < 1e-3 && Math.abs(mergedMem.evidence.weightedFailures - 2) < 1e-3;
  check(
    '断点D 语义记忆：outcome 统一观测 + merged 证据叠加合并',
    semOk && mergeOk,
    `4 次应用（3成1败）→ ws=3/wf=1；合并携带 5/1 证据 → ws=${mergedMem.evidence.weightedSuccesses}/wf=${mergedMem.evidence.weightedFailures}，supportCount 3+2=${mergedMem.supportCount}`,
  );

  const proc = {
    id: 'proc-evd',
    kind: 'scheduling',
    name: 'prefer-strong',
    taskTypes: [TASK_TYPE],
    conditions: [],
    action: { type: 'prefer-model', params: { model: STRONG } },
    confidence: 0.85,
    supportCount: 3,
    sourceFingerprints: ['fp-1'],
    distilledAt: now,
    appliedTotal: 0,
    appliedSuccesses: 0,
  };
  const procCreated = memory.upsertProceduralMemory(proc);
  for (let i = 0; i < 3; i += 1) memory.recordProceduralOutcome('proc-evd', true);
  const procAfter = memory.getAllProceduralMemories().find((p) => p.id === 'proc-evd');
  const found = memory.findProceduralMemory('scheduling', TASK_TYPE, {});
  check(
    '断点D 程序记忆：outcome 统一观测 + 证据化检索评分',
    procCreated === 'created' && procAfter.evidence.weightedSuccesses > 2.999 && procAfter.evidence.weightedSuccesses < 3.001 && found?.id === 'proc-evd',
    `3 次成功应用 → ws=${procAfter.evidence.weightedSuccesses.toFixed(6)}（含秒级惰性衰减）；findProceduralMemory 证据化评分命中 ${found?.id}`,
  );
}

// ══════════════════════════ 断点 E：证据普查 + 漂移检测 ══════════════════════════
{
  // 构造能力漂移：裸成功率 50%，近期加权成功率 90%（模型「修好了」）
  memory.upsertModelProfile({
    id: 'model-drift',
    name: 'model-drift',
    taskHistory: {
      [TASK_TYPE]: {
        totalCalls: 10,
        successCount: 5,
        totalLatency: 0,
        totalQualityScore: 0,
        avgQualityScore: 0,
        lastCalledAt: Date.now(),
        weightedSuccesses: 9,
        weightedFailures: 1,
        lastDecayedAt: Date.now(),
      },
    },
    costEfficiency: {},
    bestTaskType: '',
    worstTaskType: '',
    stability: 0.5,
  });

  const census = memory.evidenceCensus();
  const layerBy = (name) => census.layers.find((l) => l.layer === name);
  const strategyLayer = layerBy('strategy');
  const semanticLayer = layerBy('semantic');
  const proceduralLayer = layerBy('procedural');
  const profileLayer = layerBy('model-profile');
  const driftEntry = census.driftedModels.find((d) => d.modelId === 'model-drift');

  check(
    '断点E 证据普查：四层覆盖度统计（自知之明的原料）',
    census.layers.length === 4 &&
      strategyLayer.total >= 1 && strategyLayer.withEvidence >= 1 && strategyLayer.avgEffectiveSamples > 0 &&
      semanticLayer.withEvidence >= 1 && proceduralLayer.withEvidence >= 1 && profileLayer.total >= 2,
    `strategy ${strategyLayer.withEvidence}/${strategyLayer.total}（均值有效样本 ${strategyLayer.avgEffectiveSamples}）、semantic ${semanticLayer.withEvidence}/${semanticLayer.total}、procedural ${proceduralLayer.withEvidence}/${proceduralLayer.total}、model-profile ${profileLayer.withEvidence}/${profileLayer.total}`,
  );
  check(
    '断点E 能力漂移检测：裸 50% → 近期 90% 的模型修复被察觉',
    Boolean(driftEntry) && driftEntry.taskType === TASK_TYPE && driftEntry.drift > 0.3 && driftEntry.effectiveSamples >= 5,
    `driftedModels 命中 model-drift：drift=${driftEntry?.drift.toFixed(3)}（加权 0.9 − 裸 0.5），有效样本=${driftEntry?.effectiveSamples.toFixed(1)}，posteriorMean=${driftEntry?.posteriorMean.toFixed(3)}`,
  );
}

// ══════════════════════════ 断点 F：校准自修正 ══════════════════════════
{
  const calMem = new LongTermMemory(calMemPath);
  const reflector = new Reflector({ memory: calMem, reflection: new ReflectionEngine({ qualityThreshold: 0.7 }), config: { enableProgress: false } });

  const identity = reflector.correctConfidence(0.9);
  const statusBefore = reflector.getCalibration();
  check(
    '断点F 样本不足恒等：零校准数据时 correctConfidence 为恒等映射',
    identity === 0.9 && statusBefore.direction === 'insufficient' && statusBefore.correction === 0,
    `无洞察样本 → direction=insufficient，correction=0，correctConfidence(0.9)=${identity}`,
  );

  // 24 条过自信洞察（预测 0.95 实际全败）→ 残差 0.95 → 收缩修正
  const signal = { id: 'sig-cal', type: TASK_TYPE, description: '校准场景', payload: {}, receivedAt: Date.now(), source: 'verify-ue', occurrences: 1 };
  const plan = { objective: '校准目标', nodes: [{ id: 'node-1', description: '步骤', type: TASK_TYPE, dependsOn: [] }], parallelismStrategy: 'layered', source: 'fallback' };
  const result = {
    planId: 'plan-cal',
    success: false,
    nodeResults: [{ nodeId: 'node-1', modelId: STRONG, success: false, quality: 0, latency: 1000, attempts: 1, error: '模拟失败', tokensUsed: 10 }],
    totalTime: 1000,
    successCount: 0,
    totalTokens: 10,
    avgQuality: 0,
  };
  reflector.reflectOnOutcome({
    signal,
    plan,
    result,
    decisionInsights: Array.from({ length: 24 }, (_, i) => ({
      nodeId: `node-${i}`,
      taskType: TASK_TYPE,
      modelId: STRONG,
      predictedConfidence: 0.95,
      exploration: false,
      success: false,
    })),
  });

  const status = reflector.getCalibration();
  const corrected = reflector.correctConfidence(0.9);
  check(
    '断点F 校准自修正：过自信系统（预测 0.95 实际 0）→ 预测收缩 0.15',
    status.direction === 'overconfident' && status.samples === 24 && Math.abs(status.correction + 0.15) < 1e-9 && Math.abs(corrected - 0.75) < 1e-9,
    `Brier=${status.brierScore.toFixed(4)}，残差=${status.residualMean.toFixed(4)} → correction=${status.correction}（−0.475 钳制到 −0.15），correctConfidence(0.9)=${corrected}`,
  );
  calMem.dispose();
}

// ══════════════════════════ 断点 G：沙盒校准贝叶斯化 ══════════════════════════
{
  const calibMem = new LongTermMemory(calibMemPath);
  for (let i = 1; i <= 3; i += 1) {
    const nodeId = `node-${i}`;
    calibMem.recordSuccess({
      taskType: TASK_TYPE,
      complexity: 0.7,
      features: ['code'],
      taskSummary: `${TASK_TYPE}: 校准 ${i}`,
      plan: { objective: `校准 ${i}`, nodes: [{ id: nodeId, description: `步骤 ${i}`, type: TASK_TYPE, dependsOn: [] }], parallelismStrategy: 'layered' },
      modelAssignments: { [nodeId]: STRONG },
      totalLatency: 100,
      qualityScores: { [nodeId]: 0.9 },
      tokenCost: 100,
    });
  }
  const calibration = buildCalibrationFromMemory(calibMem);
  const entry = calibration[STRONG]?.[TASK_TYPE];
  check(
    '断点G 校准条目贝叶斯化：posteriorQuality / effectiveSamples / drift 三字段填充',
    Boolean(entry) &&
      entry.samples === 3 && entry.observedAvgQuality === 0.9 &&
      entry.posteriorQuality > 0.75 && entry.posteriorQuality < 0.9 &&
      entry.effectiveSamples >= 2.5 && typeof entry.drift === 'number',
    `裸口径保留（samples=3，observedAvgQuality=0.9）+ 证据旁路（posteriorQuality=${entry?.posteriorQuality?.toFixed(4)}=(3×0.9+0.5)/4，effectiveSamples=${entry?.effectiveSamples?.toFixed(2)}，drift=${entry?.drift}）`,
  );

  // legacy 手工条目逐位兼容：旧格式（无证据字段）与等值贝叶斯条目产出完全相同的评估
  const models = [
    { id: STRONG, taskScores: { [TASK_TYPE]: 0.8, general: 0.8 }, avgLatencyMs: 900, avgTokens: 350, maxConcurrency: 4 },
    { id: 'model-beta', taskScores: { [TASK_TYPE]: 0.78, general: 0.78 }, avgLatencyMs: 700, avgTokens: 80, maxConcurrency: 4 },
  ];
  const tasks = generateAdversarialTasks([TASK_TYPE], () => 0.42);
  const policy = createBaselinePolicy('policy-verify-ue', 1);
  const legacySandbox = new Sandbox({
    models,
    tasks,
    config: { evaluationSeeds: 1, calibration: { [STRONG]: { [TASK_TYPE]: { observedAvgQuality: 0.15, samples: 50 } } } },
  });
  const equivSandbox = new Sandbox({
    models,
    tasks,
    config: {
      evaluationSeeds: 1,
      calibration: { [STRONG]: { [TASK_TYPE]: { observedAvgQuality: 0.15, samples: 50, posteriorQuality: 0.15, effectiveSamples: 50, drift: 0 } } },
    },
  });
  const bayesSandbox = new Sandbox({
    models,
    tasks,
    config: {
      evaluationSeeds: 1,
      calibration: { [STRONG]: { [TASK_TYPE]: { observedAvgQuality: 0.15, samples: 50, posteriorQuality: 0.9, effectiveSamples: 50, drift: 0 } } },
    },
  });
  const legacyReport = await legacySandbox.evaluate(policy);
  const equivReport = await equivSandbox.evaluate(policy);
  const bayesReport = await bayesSandbox.evaluate(policy);
  check(
    '断点G legacy 逐位兼容：等值贝叶斯条目评估结果与旧格式完全一致',
    legacyReport.metrics.avgQuality === equivReport.metrics.avgQuality && legacyReport.reward === equivReport.reward,
    `legacy avgQuality=${legacyReport.metrics.avgQuality.toFixed(9)} ≡ 等值贝叶斯 ${equivReport.metrics.avgQuality.toFixed(9)}（reward ${legacyReport.reward.toFixed(6)} ≡ ${equivReport.reward.toFixed(6)}）`,
  );
  check(
    '断点G 贝叶斯锚定生效：posteriorQuality 差异真实改变沙盒评估结论',
    Math.abs(bayesReport.metrics.avgQuality - legacyReport.metrics.avgQuality) > 0.01 && bayesReport.reward > legacyReport.reward,
    `posteriorQuality 0.15 → 0.9：avgQuality ${legacyReport.metrics.avgQuality.toFixed(3)} → ${bayesReport.metrics.avgQuality.toFixed(3)}，reward ${legacyReport.reward.toFixed(4)} → ${bayesReport.reward.toFixed(4)}`,
  );
  calibMem.dispose();
}

// ══════════════════════════ 断点 H：自知之明报告 + 持久化 ══════════════════════════
{
  const reflector = new Reflector({ memory, reflection: new ReflectionEngine({ qualityThreshold: 0.7 }), config: { enableProgress: false } });
  const report = reflector.getSelfKnowledge();
  check(
    '断点H 自知之明报告：校准状态 + 全层证据普查一次取齐',
    report.calibration.direction === 'insufficient' && Boolean(report.census) && report.census.layers.length === 4 && report.census.driftedModels.some((d) => d.modelId === 'model-drift'),
    `generatedAt=${new Date(report.generatedAt).toISOString()}，calibration.direction=${report.calibration.direction}，census 四层 + driftedModels ${report.census.driftedModels.length} 条`,
  );

  // 持久化：dispose 后重启，evidence 字段完整恢复（SQLite data 列全量 JSON）
  const strategiesBefore = memory.getAllStrategies().filter((s) => s.evidence);
  const semanticBefore = memory.getAllSemanticMemories().find((m) => m.id === 'sem-evd');
  memory.dispose();
  const reloaded = new LongTermMemory(memPath);
  const strategiesAfter = reloaded.getAllStrategies().filter((s) => s.evidence);
  const semanticAfter = reloaded.getAllSemanticMemories().find((m) => m.id === 'sem-evd');
  const sameEvidence =
    strategiesAfter.length === strategiesBefore.length &&
    strategiesAfter.every((s, i) => Math.abs(s.evidence.weightedSuccesses - strategiesBefore[i].evidence.weightedSuccesses) < 1e-9) &&
    Math.abs(semanticAfter.evidence.weightedSuccesses - semanticBefore.evidence.weightedSuccesses) < 1e-9;
  // 注意：getAllStrategies() 返回活引用——先快照对照值，再续接观测；
  // 续接观测含惰性时间衰减（秒级流逝 ≈ 1e-7 相对折减），容差取 1e-3
  const wsBeforeResume = strategiesAfter[0].evidence.weightedSuccesses;
  reloaded.recordStrategyOutcome(strategiesAfter[0].id, true);
  check(
    '断点H 持久化：evidence 经落盘重启完整恢复，观测无缝续接',
    sameEvidence && Math.abs(strategiesAfter[0].evidence.weightedSuccesses - (wsBeforeResume + 1)) < 1e-3,
    `重启后 ${strategiesAfter.length}/${strategiesBefore.length} 条策略证据一致（sem-evd ws=${semanticAfter.evidence.weightedSuccesses}）；续接观测 ws ${wsBeforeResume.toFixed(2)} → ${strategiesAfter[0].evidence.weightedSuccesses.toFixed(2)}`,
  );
  reloaded.dispose();
}

// ══════════════════════════ 结果输出 ══════════════════════════
console.log('\n=== 项目 3.0「统一证据 + 全层贝叶斯化 + 自知之明」闭环验证 ===\n');
console.log('\n=== 断言结果 ===\n');
let allPass = true;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ${c.detail}`);
  if (!c.pass) allPass = false;
}

// 清理
for (const p of [memPath, calMemPath, calibMemPath]) {
  fs.rmSync(p, { force: true });
  fs.rmSync(p.replace(/\.json$/, '.db'), { force: true });
  fs.rmSync(`${p.replace(/\.json$/, '.db')}-wal`, { force: true });
  fs.rmSync(`${p.replace(/\.json$/, '.db')}-shm`, { force: true });
}

console.log(allPass ? '\n✓ 统一证据内核全线贯通：内核纯函数 → 全层证据闭环 → 证据化排序 → 沙盒贝叶斯校准 → 校准自修正 + 自知之明报告 → 持久化恢复。' : '\n✗ 存在未通过的断言，请检查。');
process.exit(allPass ? 0 : 1);
