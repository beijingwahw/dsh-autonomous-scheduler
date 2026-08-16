/**
 * verify-active-inference.mjs — 6.0「自由能最小化心智」质变闭环离线验证
 *
 * 世界性突破断言：把调度（利用）、探索（UCB）、好奇心（盲区扫描）、
 * 健康度（逐项 KPI）四套互不通约的判据统一为一个变分目标——
 * G(a) = 务实价值 − 认知价值（Friston 主动推断的项目化落地）。
 *
 * 断言组：
 *   A 数学基座：lnGamma / digamma / betaEntropy / bernoulliKL 精度
 *   B EFE 核心：务实-认知分解 / 探索-利用统一 / Boltzmann 策略 /
 *     温度精度控制 / Thompson 采样统计正确性
 *   C 因果中介：总效应 = 直接 + 间接（X→M→Y 机制分解）
 *   D 变分自由能：信念 vs 生成模型的 KL 漂移检测与归因
 *   E 调度器集成：EFE 模式生效（洞察携带自由能分解）/ 未启用零漂移
 *   F 元认知统一 KPI：感知惊奇 EMA → 预测握力解读
 *   G 共生集成：心跳产出变分自由能 / efeRankActions 行动排序
 *
 * 运行：npm run build && node scripts/verify-active-inference.mjs
 */

import {
  FreeEnergyEngine,
  lnGamma,
  digamma,
  betaEntropy,
  bernoulliKL,
  CausalKernel,
  SymbiosisRuntime,
  AgentBase,
  ModelScheduler,
  LLMClient,
  LongTermMemory,
  MetaCognitionEngine,
} from '../dist/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

// ═══════════════════ A 数学基座 ═══════════════════
section('A 数学基座：特殊函数精度（Lanczos / 渐近级数）');
{
  ok(near(lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10), `lnΓ(0.5) = ln√π ≈ 0.5724（实测 ${lnGamma(0.5).toFixed(10)}）`);
  ok(near(lnGamma(5), Math.log(24), 1e-12), `lnΓ(5) = ln24 ≈ 3.1781（实测 ${lnGamma(5).toFixed(10)}）`);
  ok(near(digamma(1), -0.5772156649, 1e-7), `ψ(1) = −γ（欧拉常数，实测 ${digamma(1).toFixed(10)}）`);
  ok(near(digamma(2), 1 - 0.5772156649, 1e-7), `ψ(2) = 1 − γ ≈ 0.4228（实测 ${digamma(2).toFixed(10)}）`);
  ok(near(betaEntropy(1, 1), 0, 1e-12), `H(Beta(1,1)) = 0（均匀分布微分熵，实测 ${betaEntropy(1, 1)})`);
  ok(near(bernoulliKL(0.5, 0.5), 0, 1e-12), 'KL(p,p) = 0（同分布零背离）');
  ok(bernoulliKL(0.9, 0.1) > 1.7 && bernoulliKL(0.9, 0.1) < 1.9, `KL(0.9‖0.1) ≈ 1.76 nat（实测 ${bernoulliKL(0.9, 0.1).toFixed(4)}）`);
}

// ═══════════════════ B EFE 核心 ═══════════════════
section('B EFE 核心：一个公式统一探索与利用');
{
  const engine = new FreeEnergyEngine();
  // 三类候选：证据充分的优等生 / 证据充分的平庸者 / 零证据的未知者
  const actions = [
    { id: 'solid', pSuccess: 0.9, lower: 0.83, upper: 0.95, interventionalSamples: 100, observationalSamples: 0 },
    { id: 'mediocre', pSuccess: 0.55, lower: 0.4, upper: 0.68, interventionalSamples: 40, observationalSamples: 0 },
    { id: 'unknown', pSuccess: 0.5, lower: 0, upper: 1, interventionalSamples: 0, observationalSamples: 0 },
  ];
  const evals = engine.evaluateActions(actions, 0.9);
  const by = Object.fromEntries(evals.map((e) => [e.actionId, e]));

  ok(near(by.solid.pragmatic, -(0.9 * Math.log(0.9) + 0.1 * Math.log(0.1)), 1e-3), `务实价值 = 期望交叉熵（solid ${by.solid.pragmatic.toFixed(4)} nat）`);
  ok(by.unknown.epistemic > 0.15 && by.unknown.epistemic < 0.25, `未知者认知价值 ≈ 0.19 nat（实测 ${by.unknown.epistemic.toFixed(4)}——Beta(1,1) 一步前瞻熵收缩）`);
  ok(by.solid.epistemic < 0.01, `充分证据者认知价值 ≈ 0（实测 ${by.solid.epistemic.toFixed(5)}，仅为未知者的 ${Math.round((by.solid.epistemic / by.unknown.epistemic) * 100)}%——探索自我终结，无需手设预算）`);
  ok(by.solid.pragmatic < by.mediocre.pragmatic, '务实排序：优等生惊奇 < 平庸者');
  ok(evals[0].actionId === 'solid', `EFE 最优 = solid（${evals[0].actionId}，G=${evals[0].efe.toFixed(3)}）`);
  ok(evals[1].actionId === 'unknown', `EFE 次优 = unknown（认知价值 0.19 折抵惊奇 0.69）——不确定的未知者压过确定的平庸者`);
  ok(evals[2].actionId === 'mediocre', `EFE 最末 = mediocre（平庸且已确知，两头不沾）`);
  ok(near(evals.reduce((s, e) => s + e.boltzmannProb, 0), 1, 1e-6), `Boltzmann 概率归一（Σ=${evals.reduce((s, e) => s + e.boltzmannProb, 0).toFixed(6)}）`);

  // 温度精度控制：低温贪婪 / 高温均匀
  const cold = engine.evaluateActions(actions, 0.9, 0.01);
  const hot = engine.evaluateActions(actions, 0.9, 50);
  ok(cold[0].boltzmannProb > 0.97, `低温 → 策略贪婪（最优概率 ${cold[0].boltzmannProb.toFixed(3)}）`);
  ok(hot.every((e) => e.boltzmannProb > 0.3), `高温 → 策略均匀（探索，概率 ${hot.map((e) => e.boltzmannProb.toFixed(2)).join('/')}）`);
  const autoT = engine.minTemperatureFromActions(actions);
  ok(autoT > 0.05 && autoT < 0.4, `精度控制：平均不确定性内生推导温度（T=${autoT.toFixed(3)}——世界越未知策略越随机）`);

  // Thompson 采样：统计正确性（优等生最常胜出，未知者获得真实探索）
  const wins = { solid: 0, mediocre: 0, unknown: 0 };
  for (let i = 0; i < 2000; i += 1) {
    wins[engine.thompsonSelect(actions).winner] += 1;
  }
  ok(wins.solid > 1200, `Thompson：优等生最常胜出（${(wins.solid / 20).toFixed(1)}%）`);
  ok(wins.unknown > 100, `Thompson：未知者获得真实探索机会（${(wins.unknown / 20).toFixed(1)}%）——后验越宽采样越散`);

  // 感知惊奇：预测准 → 低惊奇；意外 → 高惊奇
  const s1 = engine.observeSurprisal(0.9, true);
  ok(near(s1, -Math.log(0.9), 1e-6), `惊奇 = −ln P(结果)（命中 ${s1.toFixed(4)} nat）`);
  const s2 = engine.observeSurprisal(0.9, false);
  ok(s2 > 2.2, `意外惊奇陡升（${s2.toFixed(3)} nat = −ln 0.1）——世界漂移的感知指纹`);
}

// ═══════════════════ C 因果中介 ═══════════════════
section('C 因果中介：效应的机制分解（X→M→Y）');
{
  const kernel = new CausalKernel();
  const now = Date.now();
  // 机制主导链：fast → 提速(0.8) → 成功(0.75)；总效应 0.6
  for (let i = 0; i < 20; i += 1) kernel.intervene('model-fast', 'kpi:speed', true, true, 'ab', null, now);
  for (let i = 0; i < 5; i += 1) kernel.intervene('model-fast', 'kpi:speed', true, false, 'ab', null, now);
  for (let i = 0; i < 5; i += 1) kernel.intervene('model-fast', 'kpi:speed', false, true, 'ab', null, now);
  for (let i = 0; i < 20; i += 1) kernel.intervene('model-fast', 'kpi:speed', false, false, 'ab', null, now);
  for (let i = 0; i < 15; i += 1) kernel.intervene('kpi:speed', 'task.outcome', true, true, 'ab', null, now);
  for (let i = 0; i < 5; i += 1) kernel.intervene('kpi:speed', 'task.outcome', true, false, 'ab', null, now);
  for (let i = 0; i < 5; i += 1) kernel.intervene('kpi:speed', 'task.outcome', false, true, 'ab', null, now);
  for (let i = 0; i < 15; i += 1) kernel.intervene('kpi:speed', 'task.outcome', false, false, 'ab', null, now);
  for (let i = 0; i < 20; i += 1) kernel.intervene('model-fast', 'task.outcome', true, true, 'ab', null, now);
  for (let i = 0; i < 10; i += 1) kernel.intervene('model-fast', 'task.outcome', true, false, 'ab', null, now);
  for (let i = 0; i < 10; i += 1) kernel.intervene('model-fast', 'task.outcome', false, true, 'ab', null, now);
  for (let i = 0; i < 20; i += 1) kernel.intervene('model-fast', 'task.outcome', false, false, 'ab', null, now);

  const med = kernel.mediation('model-fast', 'kpi:speed', 'task.outcome', now);
  ok(near(med.indirect, med.path.xm.ate * med.path.my.ate, 1e-6), `间接效应 = 链乘积（${med.path.xm.ate.toFixed(3)} × ${med.path.my.ate.toFixed(3)} = ${med.indirect.toFixed(3)}）`);
  ok(near(med.direct, med.total - med.indirect, 1e-6), `总效应 = 直接 + 间接（${med.total.toFixed(3)} = ${med.direct.toFixed(3)} + ${med.indirect.toFixed(3)}）`);
  ok(med.share > 0.5, `中介传导占比 ${Math.round(med.share * 100)}%——「快之所以有效，主要因为它提速」`);
  ok(med.mechanism.includes('传导') || med.mechanism.includes('主导'), `机制解读可读（${med.mechanism.slice(0, 42)}…）`);

  // 直接主导对照：无中介路径
  const med2 = kernel.mediation('model-fast', 'kpi:cache', 'task.outcome', now);
  ok(med2.indirect === 0 && med2.share === 0, `无中介边时间接效应为 0（占比 ${med2.share}）——不虚构机制`);
}

// ═══════════════════ D 变分自由能 ═══════════════════
section('D 变分自由能：信念 vs 生成模型的 KL 漂移检测');
{
  const engine = new FreeEnergyEngine();
  const aligned = engine.variationalFreeEnergy(
    [
      { id: 'a', beliefProb: 0.8 },
      { id: 'b', beliefProb: 0.3 },
    ],
    { a: 0.8, b: 0.3 },
  );
  ok(aligned.totalFreeEnergy < 1e-6 && !aligned.driftDetected, `信念与模型一致 → F ≈ 0（${aligned.totalFreeEnergy}，无漂移）`);

  const drifted = engine.variationalFreeEnergy(
    [
      { id: 'a', beliefProb: 0.3 },
      { id: 'b', beliefProb: 0.28 },
    ],
    { a: 0.85, b: 0.25 },
  );
  ok(drifted.totalFreeEnergy > 0.25 && drifted.driftDetected, `显著背离 → 漂移报警（F=${drifted.totalFreeEnergy.toFixed(3)} nat）`);
  ok(drifted.worst?.id === 'a', `最大背离源归因正确（worst=${drifted.worst?.id}，KL=${drifted.worst?.kl.toFixed(3)}）`);
  ok(drifted.perBelief[0].kl >= drifted.perBelief[1].kl, '明细按背离降序（优先修复最痛处）');
}

// ═══════════════════ E 调度器集成 ═══════════════════
section('E 调度器集成：EFE 调度模式（缺省零漂移）');
{
  const memPath = path.join(os.tmpdir(), `dsh-verify-efe-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);
  const llm = new LLMClient();
  for (const id of ['model-solid', 'model-mediocre', 'model-unknown']) {
    llm.registerModel({ id, endpoint: `http://${id}.local`, initialCapabilities: { taskScores: { general: 0.5 } } });
  }
  // 画像播种：solid 30 连成；mediocre 12 成 12 败；unknown 无历史
  const plan = { id: 'p1', nodes: [] };
  for (let i = 0; i < 30; i += 1) {
    memory.recordSuccess({
      taskType: 'general', complexity: 0.5, features: [], taskSummary: 'seed',
      plan, modelAssignments: { n1: 'model-solid' }, totalLatency: 100,
      qualityScores: { n1: 0.9 }, tokenCost: 10,
    });
  }
  for (let i = 0; i < 12; i += 1) {
    memory.recordSuccess({
      taskType: 'general', complexity: 0.5, features: [], taskSummary: 'seed',
      plan, modelAssignments: { n1: 'model-mediocre' }, totalLatency: 100,
      qualityScores: { n1: 0.6 }, tokenCost: 10,
    });
    memory.recordFailure({
      taskType: 'general', complexity: 0.5, features: [], reason: 'seed-fail',
      failedNodeId: 'n1', failedModelId: 'model-mediocre', errorMessage: 'x',
    });
  }

  // 未启用 EFE：原始行为（利用端最优）
  const schedClassic = new ModelScheduler({ llm, memory, config: { costWeight: 0.2 } });
  const classic = schedClassic.assignModelWithInsight('general');
  ok(classic.modelId === 'model-solid', `未启用 EFE → 既有行为（选择 ${classic.modelId}，零漂移）`);
  ok(!classic.rationale.includes('主动推断'), '洞察保持原口径（无自由能字样）');

  // 启用 EFE
  const fe = new FreeEnergyEngine();
  const schedEfe = new ModelScheduler({ llm, memory, config: { costWeight: 0.2 } });
  schedEfe.attachFreeEnergy(fe);
  schedEfe.updateConfig({ freeEnergyEnabled: true, freeEnergyPreference: 0.9, explorationEnabled: false });
  const efeInsight = schedEfe.assignModelWithInsight('general');
  ok(efeInsight.modelId === 'model-solid', `EFE 模式选择 argmin G（${efeInsight.modelId}）`);
  ok(efeInsight.rationale.includes('主动推断') && efeInsight.rationale.includes('nat'), `洞察携带自由能分解（${efeInsight.rationale.slice(0, 58)}…）`);

  // 冷启动探索仍在：仅 mediocre + unknown 两候选且平庸者证据充分时，未知者凭认知价值翻身
  const schedEfe2 = new ModelScheduler({ llm, memory, config: { costWeight: 0.2 } });
  schedEfe2.attachFreeEnergy(fe);
  schedEfe2.updateConfig({ freeEnergyEnabled: true, freeEnergyPreference: 0.9, explorationEnabled: false });
  // 场景：mediocre 后验 0.5 大样本（务实 ≈ 0.69，认知 ≈ 0）；unknown 无证据
  //（认知 0.19 折抵后 G_unknown=0.50 < G_mediocre≈0.69 → 主动推断选未知者探索）
  const insight2 = schedEfe2.assignModelWithInsight('general', undefined, undefined, { avoidModels: ['model-solid'] });
  ok(insight2.modelId === 'model-unknown' && insight2.exploration, `探索被定理化：未知者凭认知价值胜过确定的平庸者（选择 ${insight2.modelId}，好奇占比驱动）`);
  fs.rmSync(memPath, { force: true });
}

// ═══════════════════ F 元认知统一 KPI ═══════════════════
section('F 元认知：总自由能作为统一健康度（预测握力）');
{
  const fe = new FreeEnergyEngine();
  const meta = new MetaCognitionEngine({ applier: () => {} });
  const snap = (sr) => ({
    timestamp: Date.now(), successRate: sr, avgQuality: 0.8, avgLatency: 900,
    cacheHitRate: 0.3, modelSuccessRates: {}, activeExecutions: 0,
  });

  // 未挂载：无自由能 KPI（零漂移）
  meta.observe(snap(0.85));
  ok(meta.getHealthReport().freeEnergy === undefined, '未挂载引擎 → 健康报告无自由能项（零漂移）');

  meta.attachFreeEnergyEngine(fe);
  meta.observe(snap(0.85));
  ok(meta.getHealthReport().freeEnergy !== undefined, '挂载引擎 → 统一 KPI 就位');

  // 预测准：低惊奇 → 握力强
  for (let i = 0; i < 30; i += 1) fe.observeSurprisal(0.95, true);
  const strong = meta.getHealthReport().freeEnergy;
  ok(strong.surprisalEma < 0.35, `预测握力强（EMA 惊奇 ${strong.surprisalEma.toFixed(3)} nat）`);
  ok(strong.interpretation.includes('强'), `解读：${strong.interpretation.slice(0, 22)}…`);

  // 世界漂移：持续意外 → 惊奇陡升 → 握力弱报警
  for (let i = 0; i < 60; i += 1) fe.observeSurprisal(0.9, false);
  const weak = meta.getHealthReport().freeEnergy;
  ok(weak.surprisalEma > 0.7, `世界漂移被感知（EMA 惊奇升至 ${weak.surprisalEma.toFixed(3)} nat）`);
  ok(weak.interpretation.includes('弱'), `解读升级：${weak.interpretation.slice(0, 30)}…`);
}

// ═══════════════════ G 共生集成 ═══════════════════
class QuietAgent extends AgentBase {
  kind = 'model';
  goal() {
    return { objective: '测试', metrics: [], survivalThreshold: 0 };
  }
  propose() {
    return [];
  }
}

section('G 共生集成：变分漂移入心跳 + EFE 行动排序');
{
  const kernel = new CausalKernel();
  const fe = new FreeEnergyEngine();
  const openGate = () => ({ allowed: true });
  const rt = new SymbiosisRuntime({ openingGrant: 100, causalKernel: kernel, freeEnergy: fe }, { checkGate: openGate });
  const agent = new QuietAgent('model-a');
  rt.register(agent);
  const now = Date.now();

  // 因果后验：model-a 处理臂 24 成 6 败 → pDo ≈ 0.78
  for (let i = 0; i < 24; i += 1) kernel.intervene('model-a', 'task.outcome', true, true, 'seed', null, now);
  for (let i = 0; i < 6; i += 1) kernel.intervene('model-a', 'task.outcome', true, false, 'seed', null, now);

  // 信念市场：model-a 的成功概率被压到远低于因果后验（认知失调现场）
  const created = rt.beliefMarket.create({
    claim: 'model-a 下轮任务成功', subject: 'model-a', threshold: 0.5,
    settleAtTick: 999, creator: 'treasury', liquidityB: 6,
  });
  ok(created.ok, '信念资产上市（subject=model-a）');
  const pushed = rt.beliefMarket.buyShares('model-a', created.assetId, 'NO', 8);
  ok(pushed.ok && pushed.priceAfter < 0.45, `市场价被压低（implied YES ${pushed.priceAfter.toFixed(3)}）`);

  const report = await rt.tick();
  ok(report.variationalFreeEnergy !== undefined, `心跳产出变分自由能（F=${report.variationalFreeEnergy.total.toFixed(3)} nat）`);
  ok(report.variationalFreeEnergy.driftDetected, `漂移报警：市场 0.32 vs 因果 0.78 的 KL 背离（worst=${report.variationalFreeEnergy.worst?.id}）`);

  // EFE 行动排序：三个动作按 G 升序
  for (let i = 0; i < 20; i += 1) kernel.intervene('model-b', 'task.outcome', true, true, 'seed', null, now);
  for (let i = 0; i < 20; i += 1) kernel.intervene('model-c', 'task.outcome', true, false, 'seed', null, now);
  const ranked = rt.efeRankActions([{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }], 0.9);
  ok(ranked.length === 3 && ranked[0].actionId === 'model-b', `EFE 排序首位 = 高后验动作（${ranked[0].actionId}，G=${ranked[0].efe.toFixed(3)}）`);
  ok(ranked[2].actionId === 'model-c', `排序末位 = 高失败动作（${ranked[2].actionId}）`);
  ok(ranked.every((e) => Number.isFinite(e.efe) && e.curiosityShare >= 0), '逐行动自由能分解可审计（务实/认知/好奇占比）');
}

// ═══════════════════ 总结 ═══════════════════
console.log(`\n${'═'.repeat(52)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 「自由能最小化心智」质变闭环成立`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
