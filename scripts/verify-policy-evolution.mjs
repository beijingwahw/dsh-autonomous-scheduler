/**
 * verify-policy-evolution.mjs — 第三阶段「策略进化器 + 安全沙盒」闭环离线验证
 * （质级升级版：规则基因组 × 种群进化 × 校准沙盒 × 金丝雀部署）
 *
 * 数据流（第三阶段进化循环）：
 *   当前策略 + 种群精英 --变异/交叉/规则变异--> 候选 --校准沙盒多种子评估-->
 *   评估报告(reward/gain/σ/LCB) --LCB 门禁择优--> 胜出策略 --热切换--> 金丝雀观察
 *   --操作环真实回报--> 晋升 / 自动回滚
 *
 * 全程离线（不依赖 LLM 网络调用 / 定时器），验证断点：
 *
 *   A 策略空间与基准兼容：基准参数复刻第二阶段固定值；scoreModelWithPolicy
 *     与原固定公式逐位一致；越界参数规范化钳制 + 边界检测（含规则边界）
 *   B 变异可追溯：候选数、基因边界钳制、version/generation/parentId/origin 谱系
 *   C 校准沙盒评估：回放+对抗任务集、四段式报告结构（含 σ/LCB）、
 *     同任务集评估确定可复现
 *   D 部署门禁：参数越界→风险拒绝；过度分解→成本回归拒绝；集成策略→LCB 放行
 *   E 进化周期端到端：变异/交叉→评估→择优→热切换；部署后性能真实提升
 *     （同任务集对照评估，噪声完全对消）；种群/步长/周期可观测
 *   F 热切换操作环：ModelScheduler.assignModel 决策翻转 + pickEnsemble 组合；
 *     Optimizer 推荐标注 policyVersion + shouldDecompose 跟随策略
 *   G 可追溯持久化：进化历史（含种群/σ/金丝雀）落盘；重启恢复并热切换
 *   H 部署回调失败回滚：onDeploy 抛异常 → 策略回滚至前一版本
 *   I 规则基因组：resolveEffectiveParams 条件解析（类型/复杂度匹配 + 开关覆盖 +
 *     增量钳制）；操作环按任务类型差异化调度（同策略下 A 类型翻转、B 类型保持）；
 *     shouldDecompose 规则覆盖
 *   J 种群进化：交叉候选（secondaryParentId 双亲谱系）；1/5 法则自适应步长；
 *     种群精英存档按适应度排序
 *   K 历史校准：buildCalibrationFromMemory 从真实模型画像构建；校准锚定改变
 *     沙盒评估结论（模拟器不再与操作环脱钩）
 *   L 金丝雀：劣化回报 → 自动回滚前一策略（onDeploy 恢复 + 历史标记）；
 *     良性回报 → 晋升正式
 *
 * 运行：npm run build && node scripts/verify-policy-evolution.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LongTermMemory,
  LLMClient,
  ModelScheduler,
  Optimizer,
  PolicyEvolver,
  Sandbox,
  buildCalibrationFromMemory,
  extractReplayTasks,
  generateAdversarialTasks,
  resolveEffectiveParams,
  BASELINE_POLICY_PARAMS,
  POLICY_GENE_BOUNDS,
  POLICY_RULE_DELTA_BOUNDS,
  MAX_POLICY_RULES,
  createBaselinePolicy,
  normalizePolicyParams,
  policyParamsWithinBounds,
  scoreModelWithPolicy,
} from '../dist/index.mjs';

/** 确定性随机源（mulberry32）：同一种子 → 同一序列 → 评估可复现 */
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

const TASK_TYPE = 'code-generation';
const HARD_TYPE = 'hard-analysis';

// ── 沙盒模型快照：主力大模型 + 轻量近分模型 ──
// beta 与 alpha 能力分接近（集成触发条件成立）但 token 成本极低（80 vs 350）→
// 「多模型集成融合」(+0.05 融合增益) 成为可被进化发现的真实收益来源；
// hard-analysis 上双模型均弱（0.64/0.60）→ 单模型失败场景形成选择压力。
const SANDBOX_MODELS = [
  {
    id: 'model-alpha',
    taskScores: { [TASK_TYPE]: 0.8, [HARD_TYPE]: 0.64, general: 0.8 },
    avgLatencyMs: 900,
    avgTokens: 350,
    maxConcurrency: 4,
  },
  {
    id: 'model-beta',
    taskScores: { [TASK_TYPE]: 0.795, [HARD_TYPE]: 0.6, general: 0.795 },
    avgLatencyMs: 700,
    avgTokens: 80,
    maxConcurrency: 4,
  },
];

// ── 沙盒任务集：历史回放（记忆库模式提取）+ 对抗合成（四类压力模式） ──
const stamp = Date.now();
const replayMemPath = path.join(os.tmpdir(), `dsh-verify-pe-replay-${stamp}.json`);
const replayMemory = new LongTermMemory(replayMemPath);
const makePlans = (n, quality) =>
  Array.from({ length: n }, (_, i) => ({
    planFingerprint: `plan-${i}`,
    plan: { objective: `回放目标 ${i}`, nodes: [], parallelismStrategy: 'layered' },
    modelAssignments: { 'node-1': 'model-alpha' },
    totalLatency: 1200 + i,
    avgQualityScore: quality,
    totalTokens: 1300,
    executedAt: stamp - 3_600_000 * (i + 1),
  }));
replayMemory.upsertPattern({
  fingerprint: `${TASK_TYPE}::0.7::code`,
  taskSummary: `${TASK_TYPE} 常规回放模式`,
  frequency: 8,
  firstSeenAt: stamp - 86_400_000,
  lastSeenAt: stamp,
  successfulPlans: makePlans(8, 0.73),
  failureRecords: [],
  confidence: 0.85,
  bestModelCombination: { 'node-1': 'model-alpha' },
  avgExecutionTime: 1530,
  avgQualityScore: 0.73,
});
replayMemory.upsertPattern({
  fingerprint: `${HARD_TYPE}::0.9::analysis`,
  taskSummary: `${HARD_TYPE} 高难回放模式`,
  frequency: 4,
  firstSeenAt: stamp - 86_400_000,
  lastSeenAt: stamp,
  successfulPlans: makePlans(4, 0.48),
  failureRecords: [],
  confidence: 0.6,
  bestModelCombination: { 'node-1': 'model-alpha' },
  avgExecutionTime: 1710,
  avgQualityScore: 0.48,
});

const buildSandboxTasks = (rng) => [
  ...extractReplayTasks(replayMemory),
  ...generateAdversarialTasks([TASK_TYPE, HARD_TYPE], rng),
];

/** 构造全新沙盒（噪声为「任务×模型×种子」哈希稳定噪声 → 公平对比、确定可复现） */
const buildSandbox = (seed = 20260816, config = {}) =>
  new Sandbox({ models: SANDBOX_MODELS, tasks: buildSandboxTasks(mulberry32(seed)), config });

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

// ══════════════════════════ 断点 A：策略空间与基准兼容 ══════════════════════════
const baseline = createBaselinePolicy('policy-verify-baseline', 1);
check(
  '断点A 基准策略复刻第二阶段固定值（未部署进化策略时行为逐位一致）',
  baseline.params.costWeight === 0.2 &&
    baseline.params.memoryWeightBase === 0.2 &&
    baseline.params.memoryWeightGrowth === 0.02 &&
    baseline.params.memoryWeightCap === 0.6 &&
    baseline.params.decomposeEnabled === false &&
    baseline.params.ensembleEnabled === false &&
    baseline.origin === 'baseline' &&
    baseline.generation === 0 &&
    (baseline.params.rules?.length ?? 0) === 0,
  `costWeight=${baseline.params.costWeight}，memoryWeight=min(${baseline.params.memoryWeightCap}, ${baseline.params.memoryWeightBase}+n×${baseline.params.memoryWeightGrowth})，分解/集成关闭，规则层为空（纯标量=原行为），generation=${baseline.generation}`,
);

// 共享评分函数与原固定实现公式一致性（手工计算对照）
const scoreInput = { taskScore: 0.82, memoryScore: 0.9, memoryCalls: 25, avgQuality: 0.75, avgTokens: 2400 };
const expectedMemoryWeight = Math.min(0.6, 0.2 + 25 * 0.02); // 0.6（触顶）
const expectedQuality = 0.82 * (1 - expectedMemoryWeight) + 0.9 * expectedMemoryWeight;
const expectedCost = Math.max(0, Math.min(1, 0.75 * (1 - Math.min(1, 2400 / 10000))));
const expectedScore = expectedQuality * (1 - 0.2) + expectedCost * 0.2;
const actualScore = scoreModelWithPolicy(BASELINE_POLICY_PARAMS, scoreInput);
check(
  '断点A 共享评分函数公式一致（操作环与沙盒同一实现，沙盒保真）',
  Math.abs(actualScore - expectedScore) < 1e-12,
  `score=${actualScore.toFixed(6)}（memoryWeight 25 次调用触顶 ${expectedMemoryWeight}，质量项 0.8 + 成本项 0.2 加权）`,
);

const normalized = normalizePolicyParams({
  ...BASELINE_POLICY_PARAMS,
  costWeight: 1.5,
  decomposeMaxSubtasks: 99,
  ensembleScoreGap: -1,
  rules: [
    { id: 'r1', when: {}, action: { costWeightDelta: 9 }, priority: 0 },
    { id: 'r1', when: {}, action: { costWeightDelta: 0.1 }, priority: 0 }, // 重复 id 应被去重
    { id: 'r2', when: { minComplexity: -1 }, action: {}, priority: 0 },
    { id: 'bad', when: {}, action: {}, priority: 0 },
    { id: 'r3', when: {}, action: {}, priority: 0 },
  ],
});
check(
  '断点A 越界参数防御：标量钳制 + 规则清洗（增量钳制/去重/条数截断/条件域修正）',
  normalized.costWeight === POLICY_GENE_BOUNDS.costWeight.max &&
    normalized.decomposeMaxSubtasks === POLICY_GENE_BOUNDS.decomposeMaxSubtasks.max &&
    normalized.ensembleScoreGap === POLICY_GENE_BOUNDS.ensembleScoreGap.min &&
    normalized.rules.length === MAX_POLICY_RULES &&
    normalized.rules.every((r) => Math.abs(r.action.costWeightDelta ?? 0) <= POLICY_RULE_DELTA_BOUNDS.max) &&
    normalized.rules.every((r) => (r.when.minComplexity ?? 0) >= 0) &&
    policyParamsWithinBounds(normalized) &&
    !policyParamsWithinBounds({ ...BASELINE_POLICY_PARAMS, costWeight: 1.5 }) &&
    !policyParamsWithinBounds({ ...BASELINE_POLICY_PARAMS, rules: Array.from({ length: MAX_POLICY_RULES + 1 }, (_, i) => ({ id: `r${i}`, when: {}, action: {}, priority: 0 })) }),
  `costWeight 1.5→${normalized.costWeight}，maxSubtasks 99→${normalized.decomposeMaxSubtasks}；5 条脏规则（越界增量/重复 id/越界条件）清洗为 ${normalized.rules.length} 条合法规则；越界标量与超量规则均被边界检测检出`,
);

// ══════════════════════════ 断点 B：变异可追溯 ══════════════════════════
const mutateEvolver = new PolicyEvolver({ candidateCount: 8, rng: mulberry32(42) }, baseline);
const candidates = await mutateEvolver.generateCandidates(baseline);
const allWithinBounds = candidates.every((c) => policyParamsWithinBounds(c.params));
// 4.0：候选构成 = mutation（高斯变异，谱系 parentId 可追溯）+ explorer（边界内随机
// 多样性注入，刻意不带 parentId——谱系不误导为变异）；首轮种群仅基准故无 crossover
const lineageOk = candidates.every(
  (c) =>
    c.version === baseline.version + 1 &&
    c.generation === baseline.generation + 1 &&
    c.type === 'scheduler' &&
    typeof c.id === 'string' &&
    c.id !== baseline.id &&
    (c.origin === 'explorer' ? c.parentId === undefined : c.origin === 'mutation' && c.parentId === baseline.id),
);
const mutationCount = candidates.filter((c) => c.origin === 'mutation').length;
const explorerCount = candidates.filter((c) => c.origin === 'explorer').length;
const hasVariation = candidates.some((c) => JSON.stringify(c.params) !== JSON.stringify(BASELINE_POLICY_PARAMS));
check(
  '断点B 变异谱系可追溯：version/generation/parentId/origin + 基因边界钳制',
  candidates.length >= 5 && allWithinBounds && lineageOk && hasVariation && mutationCount >= 1 && explorerCount >= 1,
  `${candidates.length} 个候选（首轮种群仅基准 → mutation×${mutationCount}（parentId=${baseline.id} 谱系可追溯）+ explorer×${explorerCount}（边界内随机注入多样性，无 parentId 不误导谱系））全部在 ${Object.keys(POLICY_GENE_BOUNDS).length} 个标量基因边界内；version=${baseline.version + 1}、generation=${baseline.generation + 1}；存在参数变体（高斯扰动生效）`,
);

// ══════════════════════════ 断点 C：校准沙盒评估 ══════════════════════════
const sandboxC = buildSandbox();
const taskSet = sandboxC.getTaskSet();
const replayCount = taskSet.filter((t) => t.source === 'replay').length;
const adversarialLabels = taskSet.filter((t) => t.source === 'adversarial').map((t) => t.label);
const selfReport = await sandboxC.evaluate(baseline, baseline);
check(
  '断点C 沙盒任务集：历史回放 + 四类对抗合成（极端复杂/冷启动/特征密集/极简）',
  replayCount === 12 &&
    adversarialLabels.length === 4 &&
    ['极端复杂任务', '冷启动任务', '特征密集任务', '极简任务'].every((l) => adversarialLabels.includes(l)),
  `回放 ${replayCount} 条（12 记录来自记忆库 2 个任务模式）+ 对抗 ${adversarialLabels.length} 条：${adversarialLabels.join('、')}`,
);

const reportStructureOk =
  typeof selfReport.reward === 'number' &&
  selfReport.baselinePolicyId === baseline.id &&
  selfReport.gain === 0 &&
  selfReport.seeds === 3 &&
  typeof selfReport.gainStdDev === 'number' &&
  typeof selfReport.gainLCB === 'number' &&
  Math.abs(selfReport.gainLCB) < 1e-12 &&
  Array.isArray(selfReport.risks) &&
  selfReport.risks.length === 0 &&
  Array.isArray(selfReport.regressions) &&
  selfReport.taskStats.replayed === replayCount &&
  selfReport.taskStats.adversarial === 4 &&
  typeof selfReport.metrics.successRate === 'number' &&
  typeof selfReport.metrics.decompositionRate === 'number' &&
  typeof selfReport.metrics.ensembleRate === 'number';
check(
  '断点C 四段式评估报告：指标 + 收益(reward/gain/σ/LCB) + 风险 + 回归 + 任务统计',
  reportStructureOk && selfReport.deployable === true,
  `reward=${selfReport.reward.toFixed(4)}，seeds=${selfReport.seeds}，gain=${selfReport.gain}（自评基准），σ=${selfReport.gainStdDev.toFixed(6)}，LCB=${selfReport.gainLCB.toFixed(6)}，成功率=${selfReport.metrics.successRate.toFixed(3)}，质量=${selfReport.metrics.avgQuality.toFixed(3)}，任务 ${selfReport.taskStats.replayed + selfReport.taskStats.adversarial} 条`,
);

// 同任务集确定性：两个全新沙盒评估同一策略 → 报告逐位一致（离线可复现）
const detSandbox1 = buildSandbox(777);
const detSandbox2 = buildSandbox(777);
const detReport1 = await detSandbox1.evaluate(baseline);
const detReport2 = await detSandbox2.evaluate(baseline);
check(
  '断点C 同任务集评估确定可复现（沙盒离线纯内存，不依赖 LLM 与操作环）',
  detReport1.reward === detReport2.reward &&
    detReport1.metrics.totalTokens === detReport2.metrics.totalTokens &&
    detReport1.metrics.avgLatencyMs === detReport2.metrics.avgLatencyMs,
  `同任务集两次独立评估：reward=${detReport1.reward.toFixed(6)}/${detReport2.reward.toFixed(6)}，token=${detReport1.metrics.totalTokens}/${detReport2.metrics.totalTokens} 完全一致`,
);

// ══════════════════════════ 断点 D：部署门禁（LCB 统计） ══════════════════════════
const gateSandbox = buildSandbox(2026);

// 门禁 1：参数越界 → 风险拒绝
const outOfBounds = { ...baseline, id: 'policy-oob', params: { ...BASELINE_POLICY_PARAMS, costWeight: 1.2 } };
const oobReport = await gateSandbox.evaluate(outOfBounds, baseline);
check(
  '门禁D1 参数越界 → 风险项拒绝部署',
  oobReport.risks.length >= 1 && oobReport.deployable === false,
  `risks=[${oobReport.risks.join('；')}] → deployable=${oobReport.deployable}`,
);

// 门禁 2：过度分解（阈值过低 → 全量分解）→ token 成本回归拒绝
const overDecompose = {
  ...baseline,
  id: 'policy-over-decompose',
  params: { ...BASELINE_POLICY_PARAMS, decomposeEnabled: true, decomposeComplexityThreshold: 0.3, decomposeMaxSubtasks: 8 },
};
const overReport = await gateSandbox.evaluate(overDecompose, baseline);
check(
  '门禁D2 过度分解 → 成本回归拒绝部署（低效变体被淘汰）',
  overReport.regressions.some((r) => r.includes('成本回归')) && overReport.deployable === false,
  `分解率=${overReport.metrics.decompositionRate.toFixed(2)}，token ${overReport.baselineMetrics.totalTokens}→${overReport.metrics.totalTokens}，regressions=[${overReport.regressions.join('；')}]`,
);

// 门禁 3：多模型集成融合（轻量近分模型 + 0.05 融合增益 > 微小 token 增量）→ LCB 放行
const ensemblePolicy = {
  ...baseline,
  id: 'policy-ensemble',
  params: { ...BASELINE_POLICY_PARAMS, ensembleEnabled: true, ensembleScoreGap: 0.05, ensembleMaxModels: 2 },
};
const ensembleReport = await gateSandbox.evaluate(ensemblePolicy, baseline);
check(
  '门禁D3 集成融合策略 → 零风险零回归且 LCB 收益为正（优质变体放行）',
  ensembleReport.deployable === true && ensembleReport.gain > 0 && (ensembleReport.gainLCB ?? -1) > 0 && ensembleReport.risks.length === 0 && ensembleReport.regressions.length === 0,
  `集成率=${ensembleReport.metrics.ensembleRate.toFixed(2)}，gain=+${ensembleReport.gain.toFixed(4)}（σ=${(ensembleReport.gainStdDev ?? 0).toFixed(4)}，LCB=+${(ensembleReport.gainLCB ?? 0).toFixed(4)}），质量 ${ensembleReport.baselineMetrics.avgQuality.toFixed(4)}→${ensembleReport.metrics.avgQuality.toFixed(4)}，token 涨幅 ${((ensembleReport.metrics.totalTokens / ensembleReport.baselineMetrics.totalTokens - 1) * 100).toFixed(1)}%`,
);

// ══════════════════════════ 断点 I：规则基因组 ══════════════════════════
const rulePolicy = {
  ...baseline,
  id: 'policy-rules',
  params: {
    ...BASELINE_POLICY_PARAMS,
    // 2.0 语义适配：老兵 200 样本下 growth 项（0.02×200）必触顶 0.6，
    // 规则仅归零 base 无法体现差异化——本策略置 growth=0，使 base 增量成为决定项
    memoryWeightGrowth: 0,
    rules: [
      { id: 'r-ens-hard', when: { taskTypes: [HARD_TYPE] }, action: { ensembleForce: true }, priority: 1 },
      { id: 'r-cost-hi', when: { minComplexity: 0.8, maxComplexity: 1 }, action: { costWeightDelta: 0.3 }, priority: 2 },
      { id: 'r-mem-code', when: { taskTypes: [TASK_TYPE] }, action: { memoryWeightBaseDelta: -0.2 }, priority: 3 },
    ],
  },
};
const effHard = resolveEffectiveParams(rulePolicy.params, { taskType: HARD_TYPE, complexity: 0.9 });
const effCodeLow = resolveEffectiveParams(rulePolicy.params, { taskType: TASK_TYPE, complexity: 0.5 });
const effOther = resolveEffectiveParams(rulePolicy.params, { taskType: 'unknown-task', complexity: 0.5 });
check(
  '断点I 规则基因组条件解析：类型/复杂度匹配 + 开关覆盖 + 增量叠加钳制',
  effHard.ensembleEnabled === true &&
    Math.abs(effHard.costWeight - 0.5) < 1e-9 &&
    effCodeLow.ensembleEnabled === false &&
    Math.abs(effCodeLow.memoryWeightBase - 0) < 1e-9 &&
    Math.abs(effCodeLow.costWeight - 0.2) < 1e-9 &&
    effOther.ensembleEnabled === false &&
    Math.abs(effOther.memoryWeightBase - 0.2) < 1e-9,
  `hard-analysis(c=0.9)：集成强制开启 + costWeight 0.2→${effHard.costWeight}（+0.3 增量）；${TASK_TYPE}(c=0.5)：仅记忆权重规则命中 0.2→${effCodeLow.memoryWeightBase}；unknown-task：三条规则全不命中=基准参数`,
);

// 操作环：同策略下按任务类型差异化调度（质级区别于全局标量）
const opMemPath = path.join(os.tmpdir(), `dsh-verify-pe-op-${stamp}.json`);
const opMemory = new LongTermMemory(opMemPath);
const llm = new LLMClient();
// 能力画像：strong 强在 code-generation（0.9）但 documentation 弱（0.7）；
// veteran 两类均衡（0.8）且两类各有 200 次全胜历史（2.0 统计学习语义：大样本
// Wilson 下界 ≈0.98 足以在记忆权重触顶 0.6 时反超 0.1 的静态能力差——
// 20 次全胜的下界仅 ≈0.84，不再伪装「久经考验」；规则命中归零 base 后
// w=0 → 能力导向胜出）
llm.registerModel({ id: 'model-strong', endpoint: 'http://localhost:11434/v1', initialCapabilities: { taskScores: { [TASK_TYPE]: 0.9, documentation: 0.7, general: 0.75 } } });
llm.registerModel({ id: 'model-veteran', endpoint: 'http://localhost:11434/v1', initialCapabilities: { taskScores: { [TASK_TYPE]: 0.8, documentation: 0.8, general: 0.8 } } });
const veteranHistory = {
  totalCalls: 200, successCount: 200, totalLatency: 360_000, totalQualityScore: 180,
  avgQualityScore: 0.9, lastCalledAt: stamp,
  weightedSuccesses: 200, weightedFailures: 0, emaQuality: 0.9, lastDecayedAt: stamp,
};
opMemory.upsertModelProfile({
  id: 'model-veteran',
  name: 'model-veteran',
  taskHistory: {
    [TASK_TYPE]: veteranHistory,
    documentation: veteranHistory,
  },
  costEfficiency: {},
  bestTaskType: TASK_TYPE,
  worstTaskType: '',
  stability: 1,
});

const scheduler = new ModelScheduler({ llm, memory: opMemory, config: { costWeight: 0.2 } });
const optimizer = new Optimizer({ memory: opMemory, policyProvider: () => scheduler.getPolicy() });

const pickBefore = scheduler.assignModel(TASK_TYPE);
scheduler.updatePolicy({
  ...baseline,
  id: 'policy-evolved-hot',
  version: 2,
  params: {
    ...BASELINE_POLICY_PARAMS,
    memoryWeightBase: 0,
    memoryWeightGrowth: 0, // 进化策略：无视历史权重 → 纯能力导向
    decomposeEnabled: true,
    decomposeComplexityThreshold: 0.9,
    ensembleEnabled: true,
    ensembleMaxModels: 2,
  },
});
const pickAfter = scheduler.assignModel(TASK_TYPE);
check(
  '断点F 模型调度器热切换：评分参数即时生效，模型决策翻转（无需重启）',
  pickBefore === 'model-veteran' && pickAfter === 'model-strong',
  `基准策略（记忆权重 0.6 触顶）→ ${pickBefore}（老兵历史全胜加权反超）；进化策略（memoryWeightBase=0）→ ${pickAfter}（纯能力导向），同进程内即时翻转`,
);

// 规则版热切换：仅 TASK_TYPE 翻转、其他类型保持（上下文敏感调度）
scheduler.updatePolicy(rulePolicy);
const rulePickCode = scheduler.assignModel(TASK_TYPE);
const rulePickOther = scheduler.assignModel('documentation');
check(
  '断点I 操作环规则差异化调度：同一策略下 code-generation 翻转而 documentation 保持',
  rulePickCode === 'model-strong' && rulePickOther === 'model-veteran',
  `规则「code-generation 类型 → memoryWeightBase −0.2」命中：${TASK_TYPE} → ${rulePickCode}（记忆权重归零，能力导向）；documentation 不命中 → ${rulePickOther}（记忆权重保持，老兵胜出）——全局标量基因做不到的按类型差异化`,
);

// shouldDecompose 规则覆盖
const decomposeRulePolicy = {
  ...baseline,
  id: 'policy-decompose-rules',
  params: {
    ...BASELINE_POLICY_PARAMS,
    decomposeEnabled: true,
    decomposeComplexityThreshold: 0.75,
    rules: [{ id: 'r-nodecomp', when: { taskTypes: [TASK_TYPE] }, action: { decomposeForce: false }, priority: 1 }],
  },
};
scheduler.updatePolicy(decomposeRulePolicy);
const decompCode = optimizer.shouldDecompose(0.9, TASK_TYPE);
const decompOther = optimizer.shouldDecompose(0.9, 'documentation');
check(
  '断点I shouldDecompose 规则覆盖：特定类型强制关闭分解，其余类型走全局阈值',
  decompCode === false && decompOther === true,
  `复杂度 0.9：${TASK_TYPE} 命中 decomposeForce=false → false；documentation 不命中 → 走全局阈值 0.75 → true`,
);

// ══════════════════════════ 断点 K：历史校准 ══════════════════════════
const calibration = buildCalibrationFromMemory(opMemory);
const uncalSandbox = buildSandbox(555);
const calSandbox = buildSandbox(555, {
  calibration: { 'model-alpha': { [TASK_TYPE]: { observedAvgQuality: 0.15, samples: 50 } } },
});
const uncalReport = await uncalSandbox.evaluate(ensemblePolicy, baseline);
const calReport = await calSandbox.evaluate(ensemblePolicy, baseline);
check(
  '断点K 历史校准锚定：真实模型画像改变沙盒评估结论（模拟器与操作环不再脱钩）',
  calibration['model-veteran']?.[TASK_TYPE]?.samples === 200 &&
    Math.abs(calibration['model-veteran']?.[TASK_TYPE]?.observedAvgQuality - 0.9) < 1e-9 &&
    calibration['model-strong'] === undefined &&
    calReport.metrics.avgQuality < uncalReport.metrics.avgQuality - 0.05 &&
    calReport.reward < uncalReport.reward,
  `buildCalibrationFromMemory：model-veteran（200 样本，质量 0.9）入表，model-strong（无历史）不入表；校准沙盒将 model-alpha 的 ${TASK_TYPE} 画像锚定到 0.15（w=0.6）→ 集成策略质量 ${uncalReport.metrics.avgQuality.toFixed(3)} → ${calReport.metrics.avgQuality.toFixed(3)}，reward ${uncalReport.reward.toFixed(4)} → ${calReport.reward.toFixed(4)}——操作环真实结果可持续校准沙盒保真度`,
);

// ══════════════════════════ 断点 E：进化周期端到端（变异/交叉→评估→择优→热切换） ══════════════════════════
const e2ePersistPath = path.join(os.tmpdir(), `dsh-verify-pe-e2e-${stamp}.json`);
fs.rmSync(e2ePersistPath, { force: true });
const deployments = [];
const e2eEvolver = new PolicyEvolver(
  {
    candidateCount: 6,
    minGain: 0.0005,
    mutationRate: 0.7,
    booleanFlipRate: 0.35,
    ruleMutationRate: 0.4,
    rng: mulberry32(1234567),
    persistPath: e2ePersistPath,
    onDeploy: (p) => deployments.push(p),
  },
  baseline,
);

let firstDeployCycle = null;
const maxCycles = 12;
for (let i = 0; i < maxCycles; i += 1) {
  const cycle = await e2eEvolver.runEvolutionCycle(buildSandbox(31 + i));
  if (cycle.deployedPolicyId && !firstDeployCycle) firstDeployCycle = cycle;
  if (firstDeployCycle && i >= 5) break; // 部署后再跑 ≥5 轮（驱动 σ 自适应 + 种群扩充）
  if (!firstDeployCycle && i === maxCycles - 1) firstDeployCycle = cycle;
}
// 追加无部署压力的周期，确保 selectionWindow ≥ 5（σ 自适应生效）
for (let i = 0; i < 3; i += 1) {
  await e2eEvolver.runEvolutionCycle(buildSandbox(500 + i));
}

const e2eDeployed = e2eEvolver.getCurrentPolicy();
const e2eStatus = e2eEvolver.getStatus();
const e2eOk =
  Boolean(firstDeployCycle?.deployedPolicyId) &&
  deployments.length >= 1 &&
  e2eDeployed.generation > baseline.generation &&
  policyParamsWithinBounds(e2eDeployed.params) &&
  firstDeployCycle.candidates.length > 0 &&
  firstDeployCycle.candidates.every((c) => typeof c.reward === 'number' && typeof c.deployable === 'boolean');
check(
  '断点E 进化循环闭环：变异/交叉→沙盒评估→LCB 择优→热切换（onDeploy 触发，无需重启）',
  e2eOk,
  `${firstDeployCycle.summary}；累计部署回调 ${deployments.length} 次；当前策略 ${e2eDeployed.id}（第 ${e2eDeployed.generation} 代，v${e2eDeployed.version}，来源 ${e2eDeployed.origin}${e2eDeployed.secondaryParentId ? `，双亲 ${e2eDeployed.parentId}×${e2eDeployed.secondaryParentId}` : ''}）`,
);

// 性能提升断言：同任务集全新沙盒对照评估（噪声与评估顺序无关 → 差值纯为策略效应）
const controlSandbox = buildSandbox(99);
const deployedControl = await controlSandbox.evaluate(e2eDeployed, baseline);
const baseControl = { metrics: deployedControl.baselineMetrics, reward: deployedControl.baselineReward };
check(
  '断点E 进化产出真实性能提升（同任务集对照，reward 提升 + 零回归 + LCB 为正）',
  deployedControl.reward > baseControl.reward &&
    deployedControl.gain > 0 &&
    (deployedControl.gainLCB ?? -1) > 0 &&
    deployedControl.risks.length === 0 &&
    deployedControl.regressions.length === 0 &&
    deployedControl.metrics.avgQuality >= baseControl.metrics.avgQuality,
  `reward ${baseControl.reward.toFixed(4)} → ${deployedControl.reward.toFixed(4)}（+${deployedControl.gain.toFixed(4)}，LCB +${(deployedControl.gainLCB ?? 0).toFixed(4)}），质量 ${baseControl.metrics.avgQuality.toFixed(4)} → ${deployedControl.metrics.avgQuality.toFixed(4)}，token ${baseControl.metrics.totalTokens} → ${deployedControl.metrics.totalTokens}`,
);

const evaluatedHistory = e2eEvolver.getEvaluationHistory();
check(
  '断点E 进化过程可追溯：候选全量留痕 + 状态可观测（评估数/轮数/部署链/σ/周期报告）',
  evaluatedHistory.length >= firstDeployCycle.candidates.length &&
    e2eStatus.totalCandidatesEvaluated >= evaluatedHistory.length &&
    e2eStatus.totalCycles >= 6 &&
    e2eStatus.deployedHistory.length >= 2 &&
    e2eStatus.deployedHistory[0].id === baseline.id &&
    typeof e2eStatus.lastCycle?.summary === 'string' &&
    evaluatedHistory.every((r) => typeof r.gainLCB !== 'undefined' || r.seeds === 1),
  `评估留痕 ${evaluatedHistory.length} 份（全部含多种子 LCB），总评估 ${e2eStatus.totalCandidatesEvaluated} 个候选 / ${e2eStatus.totalCycles} 轮，部署链 ${e2eStatus.deployedHistory.map((p) => `${p.id}(g${p.generation})`).join(' → ')}`,
);

// ══════════════════════════ 断点 J：种群进化（交叉 + 自适应步长） ══════════════════════════
const nextCandidates = await e2eEvolver.generateCandidates(e2eDeployed);
const crossoverKids = nextCandidates.filter((c) => c.origin === 'crossover');
const population = e2eEvolver.getPopulation();
const popScores = population.map((p) => p.fitness?.score ?? -1);
check(
  '断点J 种群交叉：种群 ≥2 后产出 crossover 候选（secondaryParentId 双亲谱系可追溯）',
  population.length >= 2 &&
    crossoverKids.length >= 1 &&
    crossoverKids.every((c) => c.parentId && c.secondaryParentId && c.parentId !== c.secondaryParentId) &&
    nextCandidates.every((c) => policyParamsWithinBounds(c.params)),
  `种群 ${population.length} 个精英（基线+历轮候选适应度竞争）；新一轮 ${nextCandidates.length} 候选含 ${crossoverKids.length} 个交叉个体（如 ${crossoverKids[0]?.id}: ${crossoverKids[0]?.parentId} × ${crossoverKids[0]?.secondaryParentId}），全部在基因边界内`,
);

check(
  '断点J 1/5 法则自适应步长：多轮进化后 σ 偏离基准 1（自动探索/收敛）',
  e2eStatus.sigmaScale !== 1 && e2eStatus.sigmaScale >= 0.25 && e2eStatus.sigmaScale <= 3,
  `当前 σ×${e2eStatus.sigmaScale}（部署成功率 > 20% 放大 ×1.25 探索，否则收缩 ×0.85 收敛；夹在 [0.25, 3]）——变异强度无需人工调参`,
);

check(
  '断点J 种群精英存档：按适应度降序排列且含基准',
  popScores.length >= 2 && popScores.every((s, i) => i === 0 || popScores[i - 1] >= s) && population.some((p) => p.fitness !== undefined),
  `种群 Top-${population.length}：${population.slice(0, 3).map((p) => `${p.id}(fitness ${p.fitness?.score?.toFixed(4) ?? '—'})`).join(' > ')}——优秀基因不因单轮失利丢失`,
);

// ══════════════════════════ 断点 F：热切换到操作环（Scheduler + Optimizer） ══════════════════════════
scheduler.updatePolicy({
  ...baseline,
  id: 'policy-evolved-hot2',
  version: 3,
  params: {
    ...BASELINE_POLICY_PARAMS,
    decomposeEnabled: true,
    decomposeComplexityThreshold: 0.9,
    ensembleEnabled: true,
    ensembleMaxModels: 2,
  },
});
const ensemble = scheduler.pickEnsemble(TASK_TYPE);
check(
  '断点F 模型组合逻辑：pickEnsemble 按策略评分返回集成候选',
  ensemble.length === 2 && ensemble[0] === 'model-veteran' && ensemble.includes('model-strong'),
  `集成候选 [${ensemble.join(', ')}]（Top-2 评分降序：veteran 记忆权重 0.6 触顶加权反超，strong 次之，ensembleMaxModels=2）`,
);

const lookup = optimizer.lookupExperience(TASK_TYPE, 0.5, ['code'], { length: 8000 });
const lookupCold = optimizer.lookupExperience('unknown-task', 0.2, []);
check(
  '断点F 优化器策略版本标注 + 分解决策跟随策略',
  lookup.policyVersion === 'policy-evolved-hot2@v3' && lookupCold.policyVersion === 'policy-evolved-hot2@v3' && optimizer.shouldDecompose(0.92) === true && optimizer.shouldDecompose(0.5) === false,
  `推荐标注 policyVersion=${lookup.policyVersion}（冷启动任务同样标注）；复杂度 0.92 ≥ 阈值 0.9 → 分解=true，0.5 → 分解=false`,
);

// ══════════════════════════ 断点 G：可追溯持久化与重启恢复 ══════════════════════════
const persistedOk = fs.existsSync(e2ePersistPath);
let persistedPayload = null;
if (persistedOk) {
  try {
    persistedPayload = JSON.parse(fs.readFileSync(e2ePersistPath, 'utf-8'));
  } catch {
    persistedPayload = null;
  }
}
check(
  '断点G 进化历史落盘：当前策略 + 部署链 + 种群 + σ + 金丝雀持久化为可审计 JSON',
  persistedOk &&
    persistedPayload?.currentPolicy?.id === e2eDeployed.id &&
    Array.isArray(persistedPayload?.deployedHistory) &&
    persistedPayload.deployedHistory.length >= 2 &&
    Array.isArray(persistedPayload?.population) &&
    persistedPayload.population.length >= 2 &&
    typeof persistedPayload?.sigmaScale === 'number' &&
    typeof persistedPayload?.totalCycles === 'number',
  `${path.basename(e2ePersistPath)}：currentPolicy=${persistedPayload?.currentPolicy?.id}，部署链 ${persistedPayload?.deployedHistory?.length} 节点，种群 ${persistedPayload?.population?.length} 精英，σ×${persistedPayload?.sigmaScale?.toFixed(2)}，totalCycles=${persistedPayload?.totalCycles}`,
);

const restoredDeployments = [];
const restoredEvolver = new PolicyEvolver(
  { rng: mulberry32(99), persistPath: e2ePersistPath, onDeploy: (p) => restoredDeployments.push(p) },
  baseline,
);
const restored = restoredEvolver.getCurrentPolicy();
check(
  '断点G 重启恢复：当前策略 + 种群 + σ 还原并立即热切换（进化成果跨重启保留）',
  restored.id === e2eDeployed.id &&
    restored.generation === e2eDeployed.generation &&
    restoredEvolver.getPopulation().length >= 2 &&
    restoredDeployments.length === 1 &&
    restoredDeployments[0].id === e2eDeployed.id,
  `重启后当前策略=${restored.id}（第 ${restored.generation} 代），种群 ${restoredEvolver.getPopulation().length} 精英与 σ×${restoredEvolver.getStatus().sigmaScale} 一并还原，恢复时 onDeploy 即时热切换到操作环`,
);

// ══════════════════════════ 断点 H：部署回调失败回滚 ══════════════════════════
const rollbackEvolver = new PolicyEvolver(
  { rng: mulberry32(5), onDeploy: () => { throw new Error('模拟操作环热切换失败'); } },
  baseline,
);
const rollbackSandbox = buildSandbox(2026);
await rollbackEvolver.evaluateCandidate(ensemblePolicy, rollbackSandbox);
let rollbackThrew = false;
try {
  await rollbackEvolver.deployPolicy(ensemblePolicy);
} catch {
  rollbackThrew = true;
}
const afterRollback = rollbackEvolver.getCurrentPolicy();
const afterRollbackStatus = rollbackEvolver.getStatus();
check(
  '断点H 部署回调失败回滚：操作环一致性优先，策略回退至前一版本',
  rollbackThrew && afterRollback.id === baseline.id && afterRollbackStatus.deployedHistory.length === 1,
  `onDeploy 抛异常 → deployPolicy 拒绝并回滚，当前策略保持 ${afterRollback.id}，部署链仅剩基准节点`,
);

// ══════════════════════════ 断点 L：金丝雀观察窗（自动回滚 + 晋升） ══════════════════════════
const canaryDeployments = [];
const canaryDecisions = [];
const canaryEvolver = new PolicyEvolver(
  {
    rng: mulberry32(700),
    canaryMinSamples: 5,
    canaryPromoteSamples: 15,
    canarySuccessTolerance: 0.1,
    onDeploy: (p) => canaryDeployments.push(p),
    onCanaryDecision: (d) => canaryDecisions.push(d),
  },
  baseline,
);
const canarySandbox = buildSandbox(2026);
await canaryEvolver.evaluateCandidate(ensemblePolicy, canarySandbox);
await canaryEvolver.deployPolicy(ensemblePolicy);
const canaryAfterDeploy = canaryEvolver.getStatus().canary;
for (let i = 0; i < 4; i += 1) canaryEvolver.reportOperationalOutcome({ success: false, quality: 0.1 }); // 未达最小样本
const canaryBeforeRollback = canaryEvolver.getStatus().canary;
canaryEvolver.reportOperationalOutcome({ success: false, quality: 0.1 }); // 第 5 个样本触发回滚
const canaryRolledBack = canaryEvolver.getStatus();
check(
  '断点L 金丝雀自动回滚：劣化回报达阈值 → 恢复前一策略 + 部署历史标记 + 双回调触发',
  canaryAfterDeploy?.status === 'active' &&
    canaryAfterDeploy.expectedSuccessRate === ensembleReport.metrics.successRate &&
    canaryBeforeRollback?.status === 'active' &&
    canaryRolledBack.canary?.status === 'rolled-back' &&
    canaryRolledBack.currentPolicy.id === baseline.id &&
    canaryRolledBack.deployedHistory[canaryRolledBack.deployedHistory.length - 1].rolledBackAt !== undefined &&
    canaryDeployments[canaryDeployments.length - 1].id === baseline.id &&
    canaryDecisions.some((d) => d.action === 'rolled-back' && d.policyId === ensemblePolicy.id),
  `部署后进入观察窗（沙盒期望成功率 ${canaryAfterDeploy?.expectedSuccessRate.toFixed(3)}）；前 4 个失败样本不动作（未达最小样本 5），第 5 个触发：成功率 0.000 低于期望超容忍 0.1 → ${ensemblePolicy.id} 自动回滚，onDeploy(baseline) 恢复操作环，历史节点标记 rolledBackAt`,
);

// 晋升路径：重新部署良性策略，15 个优质样本 → promoted
await canaryEvolver.evaluateCandidate(ensemblePolicy, canarySandbox);
await canaryEvolver.deployPolicy(ensemblePolicy);
for (let i = 0; i < 15; i += 1) canaryEvolver.reportOperationalOutcome({ success: true, quality: 0.9 });
const promotedStatus = canaryEvolver.getStatus();
check(
  '断点L 金丝雀晋升：良性回报样本充足 → 策略晋升正式（观察窗关闭）',
  promotedStatus.canary?.status === 'promoted' &&
    promotedStatus.currentPolicy.id === ensemblePolicy.id &&
    canaryDecisions.some((d) => d.action === 'promoted'),
  `15 个成功样本（质量 0.9）无劣化 → ${ensemblePolicy.id} 晋升正式：${promotedStatus.canary?.reason}`,
);

// ══════════════════════════ 结果输出 ══════════════════════════
console.log('\n=== 第三阶段质级升级「规则基因组 × 种群进化 × 校准沙盒 × 金丝雀」闭环验证 ===\n');
if (firstDeployCycle) console.log(`进化周期摘要：${firstDeployCycle.summary}\n`);
console.log('=== 断言结果 ===\n');
let allPass = true;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ${c.detail}`);
  if (!c.pass) allPass = false;
}

// 清理
replayMemory.dispose();
fs.rmSync(replayMemPath, { force: true });
fs.rmSync(replayMemPath.replace(/\.json$/, '.db'), { force: true });
opMemory.dispose();
fs.rmSync(opMemPath, { force: true });
fs.rmSync(opMemPath.replace(/\.json$/, '.db'), { force: true });
fs.rmSync(e2ePersistPath, { force: true });
llm.dispose();

console.log(
  allPass
    ? '\n✓ 质级升级全部通过：规则基因组（上下文敏感调度程序）× 种群交叉（双亲谱系）× 校准沙盒（真实历史锚定 + LCB 统计门禁）× 金丝雀部署（劣化自动回滚/良性晋升），优化进化本身完成了从参数微调到策略程序进化的跃迁。'
    : '\n✗ 存在未通过的断言，请检查。',
);
process.exit(allPass ? 0 : 1);
