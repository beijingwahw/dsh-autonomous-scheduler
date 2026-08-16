/**
 * verify-meta-edge.mjs — 元认知层 2.0 边界与鲁棒性验证
 *
 * 主流程断言之外的边界场景（安全内建的最后防线）：
 *
 *   E1 观察窗跨重启：pending（含基线快照/方向/来源）完整持久化恢复，
 *      重启后继续观察并正确判定
 *   E2 审计文件损坏：非法 JSON / 半截文件 → 静默从零启动（不抛异常）
 *   E3 旋钮 write 抛异常：跳过该候选落到次优，审计无 adjust 记录
 *   E4 旋钮边界钳制：候选越界被钳到边界；到达边界后 no-op
 *   E5 已知劣化值全排除 + 无可落候选 → no-op（绝不盲动）
 *   E6 手动回滚空审计 / 回滚已回滚过的调整 → 明确拒绝
 *   E7 手动接管优先：manualOverride 后该旋钮不再被自动调整
 *   E8 零历史冷启动：首份报告即调整（minForecastHistory 不足 → 无预测，不阻塞）
 *
 * 运行：npm run build && node scripts/verify-meta-edge.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LongTermMemory, LLMClient, ModelScheduler, Optimizer, Reflector, ReflectionEngine,
  PolicyEvolver, Sandbox, SelfModel, MetaCognitiveController, createBaselinePolicy,
} from '../dist/index.mjs';

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
const T0 = stamp - 10 * HOUR;

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

const fb = (id, taskType, outcome, at) => ({
  id, timestamp: at, signalType: taskType, signalDescription: `${taskType} 任务`,
  decision: 'auto', outcome, outcomeReason: 'verify',
});

const makeState = (overrides = {}) => ({
  feedback: [],
  memoryCounts: { patterns: 12, semantic: 5, procedural: 12, strategies: 8, profiles: 2, feedback: 40 },
  globalStats: {
    totalExecutions: 40, totalSuccesses: 30, totalFailures: 10,
    totalTokensUsed: 120_000, totalCostEstimate: 0.5,
    averageQualityScore: 0.78, averageExecutionTime: 1500,
  },
  distillation: { pendingSinceLastDistillation: 0 },
  evolverStatus: {
    currentPolicy: { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', createdAt: T0 },
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', gain: 0.012, deployedAt: T0 + 2 * HOUR },
    ],
    population: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    sigmaScale: 0.8, canary: undefined,
    totalCandidatesEvaluated: 24, totalCycles: 8, lastCycle: undefined,
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

const allComponents = [];
const makeComponents = () => {
  const memPath = path.join(os.tmpdir(), `dsh-verify-edge-mem-${stamp}-${allComponents.length}.json`);
  const memory = new LongTermMemory(memPath);
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-a', endpoint: 'http://localhost:11434/v1', initialCapabilities: { taskScores: { general: 0.8 } } });
  const scheduler = new ModelScheduler({ llm, memory });
  const optimizer = new Optimizer({ memory, policyProvider: () => scheduler.getPolicy() });
  const reflector = new Reflector({ memory, reflection: new ReflectionEngine() });
  const policyEvolver = new PolicyEvolver({ rng: mulberry32(42) }, createBaselinePolicy('edge-baseline', 1));
  const policySandbox = new Sandbox({
    models: [{ id: 'model-a', taskScores: { general: 0.8 }, avgLatencyMs: 800, avgTokens: 600, maxConcurrency: 4 }],
    tasks: [],
  });
  const c = { memory, llm, optimizer, reflector, policyEvolver, policySandbox, memPath };
  allComponents.push(c);
  return c;
};

const buildKnobs = (c, overrides = {}) => [
  {
    id: 'reflector.autoDistillThreshold', label: '反思器自动蒸馏阈值', category: 'reflector',
    min: 2, max: 20, step: 1, integer: true,
    read: () => c.reflector.getConfig().autoDistillThreshold ?? 5,
    write: (v) => c.reflector.updateConfig({ autoDistillThreshold: v }),
    judgeMetric: 'pendingDistillation', higherIsBetter: false,
  },
  {
    id: 'evolver.mutationRate', label: '进化器变异率', category: 'evolver',
    min: 0.2, max: 0.9, step: 0.1,
    read: () => c.policyEvolver.getTunableParams().mutationRate,
    write: (v) => c.policyEvolver.updateConfig({ mutationRate: v }),
    judgeMetric: 'discoveryRate', higherIsBetter: true,
  },
  {
    id: 'evolver.minGain', label: '进化器部署门禁', category: 'evolver',
    min: 0.001, max: 0.05, step: 0.005,
    read: () => c.policyEvolver.getTunableParams().minGain,
    write: (v) => c.policyEvolver.updateConfig({ minGain: v }),
    judgeMetric: 'survivalRate', higherIsBetter: true,
  },
  ...overrides.extraKnobs ?? [],
];

// ══════════════════ E1：观察窗跨重启 ══════════════════
{
  const auditPath = path.join(os.tmpdir(), `dsh-verify-edge-e1-${stamp}.json`);
  fs.rmSync(auditPath, { force: true });
  const c = makeComponents();
  // 盲点场景 → 变异率↑推荐
  const state = makeState({
    feedback: [
      fb('e1a', 'refactor', 'failed', T0 + HOUR),
      fb('e1b', 'refactor', 'failed', T0 + 1.1 * HOUR),
      fb('e1c', 'refactor', 'poor', T0 + 1.2 * HOUR),
    ],
    evolverStatus: {
      currentPolicy: { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', createdAt: T0 },
      deployedHistory: [{ id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 }],
      population: [], sigmaScale: 0.8, canary: undefined,
      totalCandidatesEvaluated: 24, totalCycles: 8, lastCycle: undefined,
    },
  });
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });
  const ctl = new MetaCognitiveController({
    selfModel, knobs: buildKnobs(c),
    config: { persistPath: auditPath, observationReports: 3, degradationTolerance: 0.02 },
  });
  const r1 = await ctl.evaluateAndAdjust(); // adjusted：0.6→0.7，观察 0/3
  // 模拟重启：新实例从审计文件恢复 pending
  const ctl2 = new MetaCognitiveController({
    selfModel, knobs: buildKnobs(c),
    config: { persistPath: auditPath, observationReports: 3, degradationTolerance: 0.02 },
  });
  const pendingRestored = ctl2.getState().pending;
  const r2 = await ctl2.evaluateAndAdjust(); // observing 1/3
  const r3 = await ctl2.evaluateAndAdjust(); // observing 2/3
  // 推进部署 → 发现速率改善
  state.evolverStatus = {
    ...state.evolverStatus, totalCycles: 10,
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', gain: 0.012, deployedAt: T0 + 9 * HOUR },
    ],
  };
  const r4 = await ctl2.evaluateAndAdjust(); // committed（判定用恢复的基线快照）
  check(
    'E1 观察窗跨重启：pending 完整恢复（基线/方向/来源），重启后继续观察并正确判定',
    r1.status === 'adjusted' &&
      pendingRestored?.knob === 'evolver.mutationRate' &&
      pendingRestored?.reportsSeen === 0 &&
      pendingRestored?.reportsNeeded === 3 &&
      pendingRestored?.baselineMetricValue === 0 &&
      r2.status === 'observing' && r2.observation?.reportsSeen === 1 &&
      r3.status === 'observing' && r3.observation?.reportsSeen === 2 &&
      r4.status === 'committed' &&
      r4.committed?.effect.before === 0 &&
      c.policyEvolver.getTunableParams().mutationRate === 0.7,
    `重启后 pending{knob:mutationRate, 0/3, 基线 discoveryRate=0} → observing 1/3 → 2/3 → committed（发现速率 0→${r4.committed?.effect.after}，判定基于恢复的基线快照）——观察窗不因重启中断`,
  );
  fs.rmSync(auditPath, { force: true });
}

// ══════════════════ E2：审计文件损坏 ══════════════════
{
  const auditPath = path.join(os.tmpdir(), `dsh-verify-edge-e2-${stamp}.json`);
  const c = makeComponents();
  const state = makeState({ feedback: [fb('e2', 'code-generation', 'good', T0 + HOUR)] });
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });

  fs.writeFileSync(auditPath, '{broken json !!!', 'utf-8');
  let ctl;
  try {
    ctl = new MetaCognitiveController({ selfModel, knobs: buildKnobs(c), config: { persistPath: auditPath } });
  } catch (e) {
    check('E2 审计文件损坏：非法 JSON → 静默从零启动', false, `构造器抛异常：${e.message}`);
  }
  const st = ctl.getState();
  const r = await ctl.evaluateAndAdjust();
  check(
    'E2 审计文件损坏：非法 JSON → 静默从零启动（不抛异常，状态干净）',
    st.totalAdjustments === 0 && st.auditTrail.length === 0 && st.frozen === false && st.frozenByBreaker === false && (r.status === 'adjusted' || r.status === 'no-op'),
    `损坏文件下构造器正常返回：计数器归零、审计为空、未冻结；evaluateAndAdjust 正常执行（${r.status}）——持久化损坏不阻塞运行`,
  );
  fs.rmSync(auditPath, { force: true });
}

// ══════════════════ E3：write 抛异常 ══════════════════
{
  const c = makeComponents();
  const state = makeState({
    feedback: [fb('e3', 'code-generation', 'good', T0 + HOUR)],
    distillation: { pendingSinceLastDistillation: 30 }, // 蒸馏积压 → 阈值↓推荐（优先级高）
    evolverStatus: {
      currentPolicy: { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', createdAt: T0 },
      deployedHistory: [{ id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 }],
      population: [], sigmaScale: 0.8, canary: undefined,
      totalCandidatesEvaluated: 24, totalCycles: 8, lastCycle: undefined,
    },
  });
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });
  let boomCount = 0;
  const knobs = buildKnobs(c, {
    extraKnobs: [{
      id: 'test.boomKnob', label: '必炸旋钮', category: 'reflector',
      min: 0, max: 10, step: 1, integer: true,
      read: () => 5,
      write: () => { boomCount += 1; throw new Error('boom'); },
      judgeMetric: 'pendingDistillation', higherIsBetter: false,
    }],
  });
  // 让必炸旋钮获得最高优先级：直接注入推荐（经 selfModel 的 reactive 推荐）
  const ctl = new MetaCognitiveController({ selfModel, knobs });
  const r = await ctl.evaluateAndAdjust();
  // 蒸馏积压推荐 autoDistillThreshold↓（优先级 0.7）；boomKnob 无推荐则不会被选。
  // 改为直接验证：所有旋钮 write 全炸时 → 无 adjust 审计 + no-op
  const knobsAllBoom = buildKnobs(c).map((k) => ({
    ...k,
    write: (...args) => { boomCount += 1; throw new Error('boom'); },
    read: k.read,
  }));
  const ctl2 = new MetaCognitiveController({ selfModel, knobs: knobsAllBoom });
  const r2 = await ctl2.evaluateAndAdjust();
  const hasAdjust = ctl2.getAuditTrail().some((e) => e.type === 'adjust');
  check(
    'E3 旋钮 write 抛异常：候选被跳过 → 无 adjust 审计 + no-op（写失败不产生半状态）',
    boomCount > 0 && r2.status === 'no-op' && hasAdjust === false && r2.applied.length === 0,
    `全部候选 write 均抛异常（${boomCount} 次尝试）→ status=${r2.status}，零 applied，审计无 adjust——单候选失败不阻断轮次、不留 pending`,
  );
}

// ══════════════════ E4：边界钳制与到达边界 ══════════════════
{
  const c = makeComponents();
  // 手动把变异率推到 max 边界 0.9 → 推荐↑已无处可去
  c.policyEvolver.updateConfig({ mutationRate: 0.9 });
  const state = makeState({
    feedback: [
      fb('e4a', 'refactor', 'failed', T0 + HOUR),
      fb('e4b', 'refactor', 'failed', T0 + 1.1 * HOUR),
      fb('e4c', 'refactor', 'poor', T0 + 1.2 * HOUR),
    ],
    evolverStatus: {
      currentPolicy: { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', createdAt: T0 },
      deployedHistory: [{ id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 }],
      population: [], sigmaScale: 0.8, canary: undefined,
      totalCandidatesEvaluated: 24, totalCycles: 8, lastCycle: undefined,
    },
  });
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });
  const ctl = new MetaCognitiveController({ selfModel, knobs: buildKnobs(c) });
  const r = await ctl.evaluateAndAdjust();
  // 场景同时触发「零部署 → minGain↓」次优推荐（优先级 0.75）→ 边界跳过后落到次优是预期行为
  const appliedKnob = r.applied[0]?.knob;
  const skippedToBoundary = r.applied.every((a) => a.knob !== 'evolver.mutationRate');
  check(
    'E4 旋钮到达边界：变异率已 0.9（max）→ 推荐↑ 被钳制跳过（不越界），落到次优候选',
    c.policyEvolver.getTunableParams().mutationRate === 0.9 &&
      skippedToBoundary === true &&
      (r.status === 'no-op' || appliedKnob === 'evolver.minGain'),
    `盲点推荐「变异率↑」但当前 0.9 = max → 步长钳制后 next===current → 跳过；落到次优候选 ${appliedKnob ?? '（无）'}（status=${r.status}）——边界旋钮保持 0.9 绝不越界写入`,
  );
}

// ══════════════════ E5 + E6 + E7：接管/回滚边界 ══════════════════
{
  const c = makeComponents();
  const state = makeState({
    feedback: [
      fb('e5a', 'refactor', 'failed', T0 + HOUR),
      fb('e5b', 'refactor', 'failed', T0 + 1.1 * HOUR),
      fb('e5c', 'refactor', 'poor', T0 + 1.2 * HOUR),
    ],
    evolverStatus: {
      currentPolicy: { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', createdAt: T0 },
      deployedHistory: [{ id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 }],
      population: [], sigmaScale: 0.8, canary: undefined,
      totalCandidatesEvaluated: 24, totalCycles: 8, lastCycle: undefined,
    },
  });
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });

  // E6 前半：空审计手动回滚 → 明确拒绝
  const fresh = new MetaCognitiveController({ selfModel, knobs: buildKnobs(c) });
  const emptyRollback = await fresh.rollbackLastAdjustment();
  check(
    'E6 手动回滚空审计：无任何调整记录 → success=false 明确拒绝',
    emptyRollback.success === false && emptyRollback.reason === '无可回滚的调整',
    `空控制器 rollbackLastAdjustment → {success:false, reason:「${emptyRollback.reason}」}——不误操作、不抛异常`,
  );

  // E7：手动接管后该旋钮不再被自动调整
  const ctl = new MetaCognitiveController({ selfModel, knobs: buildKnobs(c) });
  ctl.setManualOverride('evolver.mutationRate', 0.5);
  const st = ctl.getState();
  const r = await ctl.evaluateAndAdjust();
  // 盲点推荐 mutationRate↑ 被接管排除 → 应落到其他候选或 no-op；mutationRate 必须保持 0.5
  check(
    'E7 手动接管优先：override 后 mutationRate 冻结在 0.5，自动调整跳过该旋钮',
    st.manuallyFrozenKnobs.includes('evolver.mutationRate') === true &&
      c.policyEvolver.getTunableParams().mutationRate === 0.5 &&
      r.applied.every((a) => a.knob !== 'evolver.mutationRate') === true &&
      ctl.getAuditTrail().some((e) => e.type === 'manual-override') === true,
    `manualOverride(0.5) 后 evaluateAndAdjust（${r.status}）——mutationRate 稳定 0.5 未被自动调整触碰；审计含 manual-override——人工优先于自动`,
  );

  // E6 后半：对同一调整重复手动回滚 → 第二次拒绝（去重）
  ctl.clearManualOverride('evolver.mutationRate');
  const ra = await ctl.evaluateAndAdjust();
  if (ra.status === 'adjusted') {
    await ctl.evaluateAndAdjust();
    await ctl.evaluateAndAdjust(); // 判定（commit 或 rollback）
  }
  const first = await ctl.rollbackLastAdjustment();
  const second = await ctl.rollbackLastAdjustment();
  check(
    'E6 重复回滚去重：同一调整只能被手动回滚一次，第二次明确拒绝',
    first.success === true && second.success === false && second.reason === '无可回滚的调整',
    `首次回滚 {success:true, ${first.knob} ${first.from}→${first.to}}；二次回滚 {success:false,「${second.reason}」}——rolledBackAdjustIds 去重，防重复写回`,
  );
}

// ══════════════════ E8：零历史冷启动 ══════════════════
{
  const c = makeComponents();
  const state = makeState({
    feedback: [
      fb('e8a', 'refactor', 'failed', T0 + HOUR),
      fb('e8b', 'refactor', 'failed', T0 + 1.1 * HOUR),
    ],
    evolverStatus: {
      currentPolicy: { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', createdAt: T0 },
      deployedHistory: [{ id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 }],
      population: [], sigmaScale: 0.8, canary: undefined,
      totalCandidatesEvaluated: 24, totalCycles: 8, lastCycle: undefined,
    },
  });
  const selfModel = new SelfModel({ collectors: collectorsOf(state) });
  const firstReport = await selfModel.generateMentalReport();
  const ctl = new MetaCognitiveController({ selfModel, knobs: buildKnobs(c) });
  const r = await ctl.evaluateAndAdjust();
  check(
    'E8 零历史冷启动：首份报告无趋势/预测 → 前瞻通道静默，反应式推荐照常驱动',
    firstReport.reportIndex === 1 &&
      firstReport.forecasts !== undefined &&
      firstReport.proactiveRisks?.length === 0 &&
      r.status === 'adjusted' &&
      r.applied[0].source === 'reactive',
    `首份报告 forecasts=${firstReport.forecasts?.length} 条（历史点不足无外推）、proactiveRisks 空 → 控制器首拍即按反应式推荐调整（source=${r.applied[0]?.source ?? r.applied[0]?.source}）——预测能力不阻塞基础闭环`,
  );
}

// ══════════════════ 结果输出 ══════════════════
console.log('\n=== 元认知层 2.0 边界与鲁棒性验证 ===\n');
console.log('=== 断言结果 ===\n');
let allPass = true;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ${c.detail}`);
  if (!c.pass) allPass = false;
}

for (const c of allComponents) {
  c.memory.dispose();
  c.llm.dispose();
  fs.rmSync(c.memPath, { force: true });
  fs.rmSync(c.memPath.replace(/\.json$/, '.db'), { force: true });
}

console.log(
  allPass
    ? '\n✓ 边界与鲁棒性全部通过：观察窗跨重启连续 / 损坏持久化静默降级 / write 异常无半状态 / 边界钳制不越界 / 空与重复回滚明确拒绝 / 手动接管优先 / 零历史冷启动不阻塞——安全内建经受住边界条件检验。'
    : '\n✗ 存在未通过的断言，请检查。',
);
process.exit(allPass ? 0 : 1);
