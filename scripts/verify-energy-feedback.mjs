/**
 * verify-energy-feedback.mjs — B 路线「能量反哺调度」闭环离线验证
 *
 * 能量从记账数字变成真实的调度行为压力：
 *   SymbiosisBridge.economicSignals()（模型经济健康度 = Wilson 信誉 × 余额
 *   复合）→ ModelScheduler.updateEconomicSignals（调度乘数注入）→
 *   利用端评分 × 乘数：赚钱且信誉好的模型升权、持续亏损的模型降权。
 *
 * 设计护栏验证：
 *   - 乘数有界（0.5~1.5）：亏损最多打对折但永不剔除——经济压力是软
 *     约束，不造成调度死锁；无信号 / 开关关闭 = 恒 1（逐位零漂移）
 *   - UCB 探索加成不受乘数影响（信息价值高于短期经济，冷启动重估
 *     机会不被经济惩罚剥夺）
 *   - preferred（优化器推荐）语义保持：直接采纳，不受乘数否决
 *
 * 全程离线（LLMClient mock 端点 + 临时记忆库 + 真实桥/调度器组件）：
 *
 *   A 信号计算：成功分红 → 信誉↑余额↑ → 乘数 > 1；持续失败 → 乘数 < 1；
 *     clamp 有界；未注册模型不产出信号
 *   B 调度影响：同质模型 → 富裕者稳定胜出；乘数可压制能力差距
 *     （弱×1.5 翻转强×0.5）；但有界护栏使其不能压制正常强模型
 *   C 零漂移：开关关闭 → 注入信号后行为逐位不变；开但无信号 = 中性
 *   D 语义保持：preferred 直接纳；UCB 探索加成不被乘数乘掉
 *   E 端到端闭环：任务结算 → 经济信号 → 调度偏好（含动态反转：先富
 *     者被后富者反超 → 调度偏好活翻转）；防御：非法信号被忽略
 *
 * 运行：npm run build && node scripts/verify-energy-feedback.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LLMClient,
  LongTermMemory,
  ModelScheduler,
  SymbiosisBridge,
} from '../dist/index.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
function section(t) {
  console.log(`\n■ ${t}`);
}

const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'energy-feedback-'));
const memPath = path.join(memDir, 'memory.json');
const cleanup = (p) => {
  try {
    fs.rmSync(p, { force: true });
    fs.rmSync(p.replace(/\.json$/, '.db'), { force: true });
  } catch {
    /* 忽略清理失败 */
  }
};

const openGate = () => ({ allowed: true });
const kpi = (successRate) => ({
  timestamp: Date.now(),
  successRate,
  avgQuality: 0.8,
  avgLatency: 900,
  cacheHitRate: 0.3,
  modelSuccessRates: {},
  activeExecutions: 0,
});

/** 同质双模型 LLM stub（评分差异只来自注入的经济乘数） */
const makeHomogeneousLLM = () => {
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-a', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { general: 0.8 } } });
  llm.registerModel({ id: 'model-b', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { general: 0.8 } } });
  return llm;
};

// ═══════════════════ A 信号计算 ═══════════════════

section('A 信号计算：经济健康度 → 调度乘数（方向 / 有界 / 完备性）');

const bridge = new SymbiosisBridge({ economic: {} }, { checkGate: openGate });
bridge.registerModel('model-a');
bridge.registerModel('model-b');

// model-a：连续成功任务（分红 + 信誉↑）；model-b：连续失败任务（负贡献，信誉↓）
for (let i = 0; i < 8; i += 1) {
  bridge.settleTask({
    success: true,
    nodeResults: [{ modelId: 'model-a', success: true, quality: 0.9 }],
  });
  bridge.settleTask({
    success: false,
    nodeResults: [{ modelId: 'model-b', success: false, quality: 0.1 }],
  });
}
const signals = bridge.economicSignals();
const sigA = signals.get('model-a');
const sigB = signals.get('model-b');
ok(signals.size === 2, `已注册模型信号完备（×${signals.size}）`);
ok(sigA.health > sigB.health, `成功者健康度更高（a=${sigA.health.toFixed(3)} > b=${sigB.health.toFixed(3)}）`);
ok(sigA.multiplier > 1 && sigB.multiplier < 1, `方向正确：a 赚钱升权 ×${sigA.multiplier.toFixed(2)}，b 亏损降权 ×${sigB.multiplier.toFixed(2)}`);
ok(sigA.multiplier <= 1.5 && sigB.multiplier >= 0.5, `乘数有界 [0.5, 1.5]（a=${sigA.multiplier.toFixed(2)}, b=${sigB.multiplier.toFixed(2)}）`);

// 极端 clamp：构造超界信号源（直接验证 bridge 侧 clamp 公式边界）
const extremeBridge = new SymbiosisBridge(
  { economic: { minMultiplier: 0.8, maxMultiplier: 1.2, neutralHealth: 0.5 } },
  { checkGate: openGate },
);
extremeBridge.registerModel('model-x');
for (let i = 0; i < 10; i += 1) {
  extremeBridge.settleTask({ success: true, nodeResults: [{ modelId: 'model-x', success: true, quality: 1.0 }] });
}
const sigX = extremeBridge.economicSignals().get('model-x');
ok(sigX.multiplier <= 1.2, `自定义上界生效（健康度 ${sigX.health.toFixed(2)} → 乘数 clamp 至 ${sigX.multiplier.toFixed(3)} ≤ 1.2）`);

// ═══════════════════ B 调度影响 ═══════════════════

section('B 调度影响：经济乘数作用于利用端评分');

{
  const memory = new LongTermMemory(memPath.replace(/\.json$/, '-b.json'));
  const llm = makeHomogeneousLLM();
  // B1 同质模型：唯一差异是经济乘数
  const sched = new ModelScheduler({ llm, memory, config: { economicFeedbackEnabled: true, explorationEnabled: false } });
  sched.updateEconomicSignals({ 'model-a': 1.5, 'model-b': 0.5 });
  let aWins = 0;
  for (let i = 0; i < 10; i += 1) if (sched.assignModel('general') === 'model-a') aWins += 1;
  ok(aWins === 10, `同质评分下富裕模型稳定胜出（a 胜 ${aWins}/10）`);
  const insight = sched.assignModelWithInsight('general');
  ok(Math.abs(insight.economicMultiplier - 1.5) < 1e-9, `洞察携带经济乘数（×${insight.economicMultiplier}）`);

  // B2 乘数翻转：同质 0.8 评分下 0.8×1.5=1.2 > 0.8×0.5=0.4 → 亏损者被压制
  sched.updateEconomicSignals({ 'model-a': 0.5, 'model-b': 1.5 });
  ok(sched.assignModel('general') === 'model-b', '乘数翻转：亏损 ×0.5 的 a 被盈利 ×1.5 的 b 稳定压制（经济压力直接改写调度结局）');

  // B3 有界护栏：弱 0.4×1.5=0.63 < 强 0.9×1.0=0.82 → 有限乘数压制不了正常强模型
  {
    const llmSB = new LLMClient();
    llmSB.registerModel({ id: 'model-strong', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { general: 0.9 } } });
    llmSB.registerModel({ id: 'model-weak', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { general: 0.4 } } });
    const schedSB = new ModelScheduler({ llm: llmSB, memory, config: { economicFeedbackEnabled: true, explorationEnabled: false } });
    schedSB.updateEconomicSignals({ 'model-weak': 1.5 }); // 仅弱模型有加成，强模型中性 1
    ok(schedSB.assignModel('general') === 'model-strong', '护栏：加成上限内弱模型仍输给无信号强模型（乘数有限，能力仍是主导）');
    llmSB.dispose();
  }
  memory.dispose();
  llm.dispose();
  cleanup(memPath.replace(/\.json$/, '-b.json'));
}

// ═══════════════════ C 零漂移 ═══════════════════

section('C 零漂移：开关关闭 / 无信号 = 逐位原行为');

{
  const memory = new LongTermMemory(memPath.replace(/\.json$/, '-c.json'));
  const llm = makeHomogeneousLLM();
  const off = new ModelScheduler({ llm, memory, config: { economicFeedbackEnabled: false } });
  const baseline = new ModelScheduler({ llm, memory });
  off.updateEconomicSignals({ 'model-a': 0.5, 'model-b': 1.5 });
  const onNoSignal = new ModelScheduler({ llm, memory, config: { economicFeedbackEnabled: true } });
  const picksOff = Array.from({ length: 5 }, () => off.assignModel('general'));
  const picksBase = Array.from({ length: 5 }, () => baseline.assignModel('general'));
  const picksNoSig = Array.from({ length: 5 }, () => onNoSignal.assignModel('general'));
  ok(JSON.stringify(picksOff) === JSON.stringify(picksBase), '开关关闭：注入信号被忽略（行为与基线逐位一致）');
  ok(JSON.stringify(picksNoSig) === JSON.stringify(picksBase), '开启但无信号：乘数恒中性 1（逐位一致）');
  ok(off.economicMultiplierOf('model-a') === 1 && onNoSignal.economicMultiplierOf('model-a') === 1, 'economicMultiplierOf 语义：关闭/无信号恒 1');

  // 防御：非法值被忽略，不破坏评分域
  onNoSignal.updateEconomicSignals({ 'model-a': Number.NaN, 'model-b': -3, 'model-a2': Infinity });
  ok(onNoSignal.assignModel('general') === baseline.assignModel('general'), '防御：NaN/负数/Infinity 信号全部忽略');
  memory.dispose();
  llm.dispose();
  cleanup(memPath.replace(/\.json$/, '-c.json'));
}

// ═══════════════════ D 语义保持 ═══════════════════

section('D 语义保持：preferred 推荐 + UCB 探索不被经济乘数破坏');

/** 直接构造带 2.0 加权字段的画像（精确控制证据） */
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

{
  const memory = new LongTermMemory(memPath.replace(/\.json$/, '-d.json'));
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-strong', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { general: 0.9 } } });
  llm.registerModel({ id: 'model-newcomer', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { general: 0.72 } } });
  // established：10 样本全成（样本足，无探索加成）；newcomer：零样本（探索加成最大）
  const stamp = Date.now();
  seedProfile(memory, 'model-strong', 'general', {
    totalCalls: 10, successCount: 10,
    weightedSuccesses: 10, weightedFailures: 0,
    totalQualityScore: 9, avgQualityScore: 0.9,
    lastCalledAt: stamp, lastDecayedAt: stamp,
  });

  // D1 preferred 直接纳（即使乘数低）
  const sched = new ModelScheduler({ llm, memory, config: { economicFeedbackEnabled: true } });
  sched.updateEconomicSignals({ 'model-strong': 0.5 });
  ok(sched.assignModel('general', 'model-strong') === 'model-strong', 'preferred 推荐语义保持（低乘数不否决优化器推荐）');

  // D2 探索加成与乘数正交：newcomer ×0.5 基分远低于 strong，但探索加成
  //（不被乘数乘掉）恰好把它推上榜首——若实现错误（bonus 也乘 0.5），
  // newcomer 必败。exploreBonus=0.6 使区分度落在两者之间。
  const explorer = new ModelScheduler({ llm, memory, config: { economicFeedbackEnabled: true, exploreBonus: 0.6 } });
  explorer.updateEconomicSignals({ 'model-newcomer': 0.5 });
  const insight = explorer.assignModelWithInsight('general');
  ok(insight.modelId === 'model-newcomer' && insight.exploration === true, `UCB 探索胜出且未被乘数吃掉（${insight.modelId}，bonus 作用于乘数后基分之上）`);
  ok(Math.abs(insight.economicMultiplier - 0.5) < 1e-9, `探索胜出者带着低乘数赢（×${insight.economicMultiplier}——冷启动重估机会不被经济惩罚剥夺）`);
  memory.dispose();
  llm.dispose();
  cleanup(memPath.replace(/\.json$/, '-d.json'));
}

// ═══════════════════ E 端到端闭环 ═══════════════════

section('E 端到端闭环：任务结算 → 经济信号 → 调度偏好（含动态反转）');

{
  const memory = new LongTermMemory(memPath.replace(/\.json$/, '-e.json'));
  const llm = makeHomogeneousLLM();
  const sched = new ModelScheduler({ llm, memory, config: { economicFeedbackEnabled: true, explorationEnabled: false } });

  // 阶段 1：a 持续成功赚钱，b 持续失败亏损
  const b1 = new SymbiosisBridge({}, { checkGate: openGate });
  b1.registerModel('model-a');
  b1.registerModel('model-b');
  for (let i = 0; i < 8; i += 1) {
    b1.settleTask({ success: true, nodeResults: [{ modelId: 'model-a', success: true, quality: 0.9 }] });
    b1.settleTask({ success: false, nodeResults: [{ modelId: 'model-b', success: false, quality: 0.1 }] });
  }
  sched.updateEconomicSignals(
    new Map([...b1.economicSignals()].map(([id, s]) => [id, s.multiplier])),
  );
  ok(sched.assignModel('general') === 'model-a', '阶段 1：赚钱的 a 获得调度偏好');

  // 阶段 2：b 后期持续成功翻身，a 开始失败失血 → 信号反转 → 偏好活翻转
  const b2 = new SymbiosisBridge({}, { checkGate: openGate });
  b2.registerModel('model-a');
  b2.registerModel('model-b');
  for (let i = 0; i < 12; i += 1) {
    b2.settleTask({ success: true, nodeResults: [{ modelId: 'model-b', success: true, quality: 0.95 }] });
    b2.settleTask({ success: false, nodeResults: [{ modelId: 'model-a', success: false, quality: 0.1 }] });
  }
  sched.updateEconomicSignals(
    new Map([...b2.economicSignals()].map(([id, s]) => [id, s.multiplier])),
  );
  ok(sched.assignModel('general') === 'model-b', '阶段 2：b 翻身赚钱、a 失血 → 调度偏好活翻转（能量信号是活反馈，非一次性判决）');
  ok(b1.runtime.ledger.verifyConservation() && b2.runtime.ledger.verifyConservation(), '全程能量守恒');

  // 死锁护栏：休眠边缘模型（乘数触底 0.5）仍可被选中
  sched.updateEconomicSignals({ 'model-a': 0.5, 'model-b': 0.5 });
  const pick = sched.assignModel('general');
  ok(pick === 'model-a' || pick === 'model-b', '护栏：双亏损模型都触底时仍可调度（软约束不死锁）');
  memory.dispose();
  llm.dispose();
  cleanup(memPath.replace(/\.json$/, '-e.json'));
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n══════════════════════════════════════════');
console.log(`  能量反哺调度验证：${passed} 通过 / ${failed} 失败`);
console.log('══════════════════════════════════════════');
if (failed > 0) {
  console.error('✗ 能量反哺调度存在失败断点');
  process.exit(1);
}
console.log('✓ 能量反哺调度全部通过：任务表现 → 能量/信誉 → 调度乘数 → 行为压力 → 生态选择压（经济闭环反哺行为层）');
