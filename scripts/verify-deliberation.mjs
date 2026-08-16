/**
 * verify-deliberation.mjs — 7.0「深思心智：规划即推断」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   6.0 自由能心智 = 一步 bandit：每个动作独立问「做完它世界会怎样」，
 *      选 argmin G(a)——看得见最好的一步，看不见两步后的死路。
 *   7.0 深思心智 = 轨迹评估：转移模型里 rollout 整条计划，
 *      G(π) = Σ γ^t·G_t——第一步的代价可被第二步的收获补偿。
 *
 * 闭环断言：
 *   A 转移模型：Beta 后验收敛 + 无证据诚实无知（Beta(1,1)）
 *   B 想象推演：全程成功概率 = 连乘；风险分布归一；折扣累计自洽
 *   C 想象证据坍缩：同一条边重访时认知价值单调下降（排练不再新鲜）
 *   D 深思 vs 贪心（分水岭）：诱饵陷阱下一步贪心选死路，
 *     深思搜索绕开——「选最好的一步」→「选最好的余生」
 *   E 技能库：成功计划蒸馏为宏动作；复用强化 / 失手衰减 / 搜索种子
 *   F 梦实现对账：预测先于结果（不可作弊）；校准 EMA 收敛；
 *     惊奇回流自由能引擎；执行学习让梦变准
 *   G 优化器集成：冷启动（零情景记忆）深思序列推荐
 *   H 元认知集成：梦校准 KPI（想象力可靠性的统一度量）
 *   I 共生集成：多步提案按轨迹 G 排序（缺省零漂移）
 *   J 序列化：转移模型 + 技能库 roundtrip
 *
 * 运行：npm run build && node scripts/verify-deliberation.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeliberationEngine,
  FreeEnergyEngine,
  LongTermMemory,
  MetaCognitionEngine,
  Optimizer,
  SymbiosisRuntime,
} from '../dist/index.mjs';

// ─────────────────────────── 断言工具 ───────────────────────────
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
function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}

// 确定性种子证据：给 (state, action) 播种 n 次成败，成功记后继 next
function seed(engine, state, action, successes, failures, next) {
  for (let i = 0; i < successes; i += 1) engine.observe(state, action, true, next);
  for (let i = 0; i < failures; i += 1) engine.observe(state, action, false);
}

// ═══════════════════ A 转移模型 ═══════════════════

section('A 转移模型：Beta 后验学习 + 诚实无知');

{
  const engine = new DeliberationEngine();
  seed(engine, 's', 'a', 18, 2, 't');
  const post = engine.posterior('s', 'a');
  ok(near(post.pSuccess, 19 / 22, 2e-6), `后验均值 = (1+18)/(1+2+18+2) = 19/22 = ${post.pSuccess.toFixed(4)}`);
  ok(post.evidence === 20, `证据量 20（实测 ${post.evidence}）`);
  ok(post.successor === 't', `MAP 后继 = t（实测 ${post.successor}）`);
  ok(post.lower < post.pSuccess && post.pSuccess < post.upper, `90% 区间 [${post.lower.toFixed(3)}, ${post.upper.toFixed(3)}] 包含均值`);

  const cold = engine.posterior('nowhere', 'nothing');
  ok(near(cold.pSuccess, 0.5, 1e-9) && cold.evidence === 0, '无证据 → Beta(1,1)（诚实的完全无知，不伪装知道）');
}

// ═══════════════════ B 想象推演 ═══════════════════

section('B 想象推演：连乘成功概率 / 风险归一 / 折扣自洽');

{
  const engine = new DeliberationEngine();
  seed(engine, 'p0', 'x', 8, 2, 'p1');   // p=0.75
  seed(engine, 'p1', 'y', 6, 4, 'p2');   // p=0.625
  seed(engine, 'p2', 'z', 4, 6, 'p0');   // p=0.5

  const r = engine.imagine('p0', ['x', 'y', 'z'], 0.9);
  const prod = r.steps.reduce((acc, s) => acc * s.pStep, 1);
  ok(near(r.pAllSuccess, prod, 2e-6), `全程成功概率 = 连乘（${r.steps.map((s) => s.pStep.toFixed(3)).join(' × ')} = ${r.pAllSuccess.toFixed(4)}）`);
  const riskSum = r.riskProfile.reduce((acc, x) => acc + x.pFailAt, 0);
  ok(near(r.pAllSuccess + riskSum, 1, 2e-6), `成功 + Σ首败风险 = 1（${r.pAllSuccess.toFixed(3)} + ${riskSum.toFixed(3)} = 1）`);
  const discountSum = r.steps.reduce((acc, s) => acc + s.discounted, 0);
  ok(near(r.totalEfe, discountSum, 2e-6), `轨迹 G = Σ γ^t·G_t 折扣自洽（${r.totalEfe.toFixed(4)} nat）`);
  ok(r.states.length === r.actions.length + 1 && r.states[0] === 'p0', '状态轨迹 = 行动数 + 1（含起点）');
  ok(near(r.steps[1].discounted, Math.pow(0.95, 1) * r.steps[1].efe, 1e-6), `第 2 步按 γ=0.95 折扣（${r.steps[1].efe.toFixed(4)} → ${r.steps[1].discounted.toFixed(4)}）`);
  ok(r.steps[0].pragmatic < r.steps[2].pragmatic, `务实排序：p=0.75 的步惊奇 ${r.steps[0].pragmatic.toFixed(3)} < p=0.5 的步 ${r.steps[2].pragmatic.toFixed(3)}`);
}

// ═══════════════════ C 想象证据坍缩 ═══════════════════

section('C 想象证据坍缩：排练过的路不再新鲜');

{
  const engine = new DeliberationEngine();
  seed(engine, 'loop', 'a', 4, 6, 'loop'); // 自环边：p=0.5

  const r = engine.imagine('loop', ['a', 'a', 'a'], 0.9);
  ok(r.steps[0].epistemic > r.steps[1].epistemic && r.steps[1].epistemic > r.steps[2].epistemic,
    `同一条边第 1/2/3 次想象：认知价值 ${r.steps[0].epistemic.toFixed(5)} > ${r.steps[1].epistemic.toFixed(5)} > ${r.steps[2].epistemic.toFixed(5)}（单调坍缩）`);
  ok(r.epistemicMonotone === true, '单调性标记 = true（想象本身消耗不确定性）');
  ok(near(r.steps[0].pStep, r.steps[2].pStep, 1e-9), '伪证据按后验比例分摊 → 成功概率不变（只收缩方差，不移动均值）');
}

// ═══════════════════ D 深思 vs 贪心（分水岭） ═══════════════════

section('D 深思 vs 贪心：诱饵陷阱（质变分水岭）');

{
  // 世界构造：
  //   s0 --bait(0.9)--> dead（此后所有行动只剩 0.2）
  //   s0 --slow(0.6)--> rich（此后行动高达 0.95）
  // 一步贪心：bait 惊奇最低 → 必选 → 第二步掉进 1.47 nat 的坑
  // 深思两步：slow 的 0.55 被 rich 的 0.35 补偿 → 绕开陷阱
  const engine = new DeliberationEngine();
  seed(engine, 's0', 'bait', 9, 1, 'dead');
  seed(engine, 's0', 'slow', 6, 4, 'rich');
  seed(engine, 'dead', 'bait', 2, 8, 'dead');
  seed(engine, 'dead', 'slow', 2, 8, 'dead');
  seed(engine, 'rich', 'bait', 19, 1, 'rich');
  seed(engine, 'rich', 'slow', 19, 1, 'rich');

  // 6.0 口径：单步 EFE（贪心）在 s0 选 bait
  const fe = new FreeEnergyEngine();
  const oneStep = fe.evaluateActions(
    [
      { id: 'bait', pSuccess: engine.posterior('s0', 'bait').pSuccess, lower: 0, upper: 1, interventionalSamples: 10, observationalSamples: 0 },
      { id: 'slow', pSuccess: engine.posterior('s0', 'slow').pSuccess, lower: 0, upper: 1, interventionalSamples: 10, observationalSamples: 0 },
    ],
    0.9,
  );
  ok(oneStep[0].actionId === 'bait', `一步贪心选 bait（G=${oneStep[0].efe.toFixed(3)} < ${oneStep[1].efe.toFixed(3)}）——看不见 dead`);

  const greedy1 = engine.search('s0', ['bait', 'slow'], { depth: 1, useSkills: false });
  ok(greedy1.best.actions[0] === 'bait', `深度 1 搜索 = 贪心（${greedy1.best.actions.join('→')}）`);

  const deep = engine.search('s0', ['bait', 'slow'], { depth: 2, useSkills: false });
  ok(deep.best.actions[0] === 'slow', `深度 2 深思绕开诱饵（最优 ${deep.best.actions.join(' → ')}）——第二步的收获补偿第一步的代价`);
  const byFirst = Object.fromEntries(deep.ranked.map((r) => [r.actions[0], r]));
  ok(byFirst.slow.totalEfe < byFirst.bait.totalEfe,
    `轨迹 G：slow 路 ${byFirst.slow.totalEfe.toFixed(3)} < bait 路 ${byFirst.bait.totalEfe.toFixed(3)} nat`);
  const baitPath = deep.ranked.find((r) => r.actions[0] === 'bait');
  ok(baitPath.steps[1].pragmatic > 1.2, `bait 路第二步掉坑（务实 ${baitPath.steps[1].pragmatic.toFixed(3)} nat，p=3/12 含先验口径）`);
  ok(deep.best.riskProfile.every((x) => x.pFailAt < 0.5), '深思最优路无单点高风险步');
}

// ═══════════════════ E 技能库 ═══════════════════

section('E 技能库：计划蒸馏为宏动作（时间抽象）');

{
  const engine = new DeliberationEngine();
  seed(engine, 's0', 'slow', 6, 4, 'rich');
  seed(engine, 'rich', 'bait', 19, 1, 'rich');

  // 成功计划 → 蒸馏为技能
  const rep = engine.settle(
    [
      { state: 's0', action: 'slow' },
      { state: 'rich', action: 'bait' },
    ],
    [true, true],
  );
  ok(rep.overallSuccess && rep.skillAction === 'acquired', `整体成功 → 技能入库（${rep.skillId}）`);
  const skills = engine.skillsFor('s0');
  // settle 已把证据入库：p(slow|s0)=8/13, p(bait|rich)=21/23（Beta(1,1) 先验入分母）→ 连乘
  ok(skills.length === 1 && near(skills[0].reliability, (8 / 13) * (21 / 23), 2e-6), `技能价值 = 全程成功概率连乘（${skills[0].reliability.toFixed(3)}），触发态 s0`);
  ok(skills[0].value > 0.5, `技能价值 ${skills[0].value.toFixed(3)} > 0.5 入库门槛`);

  // 复用强化
  engine.settle(
    [
      { state: 's0', action: 'slow' },
      { state: 'rich', action: 'bait' },
    ],
    [true, true],
  );
  ok(engine.allSkills()[0].usages === 2, '同签名再次成功 → 复用强化（usages=2）');

  // 失手衰减
  const before = engine.allSkills()[0].value;
  engine.settle(
    [
      { state: 's0', action: 'slow' },
      { state: 'rich', action: 'bait' },
    ],
    [true, false],
  );
  ok(engine.allSkills()[0].value < before, `技能失手 → 价值衰减（${before.toFixed(3)} → ${engine.allSkills()[0].value.toFixed(3)}）`);

  // 搜索种子：技能作为宏动作参与深思
  const searched = engine.search('s0', ['slow', 'bait'], { depth: 2 });
  ok(searched.skillSeeded === true, '触发态匹配的技能作为宏动作种子注入搜索（时间抽象）');
  ok(searched.best.actions.length === 2, `深思最优仍是两步计划（${searched.best.actions.join(' → ')}）`);
}

// ═══════════════════ F 梦实现对账 ═══════════════════

section('F 梦实现对账：预测不可作弊 + 校准收敛 + 惊奇回流');

{
  const fe = new FreeEnergyEngine();
  const engine = new DeliberationEngine({}, fe);
  seed(engine, 'f0', 'a', 10, 2, 'f0'); // p = 11/14 ≈ 0.786

  // 预测先于结果：settle 前口径（不能拿执行结果修预测再对账）
  const bad = engine.settle([{ state: 'f0', action: 'a' }], [false]);
  ok(near(bad.steps[0].predicted, 11 / 14, 2e-6), `预测用执行前口径（p=${bad.steps[0].predicted.toFixed(4)}，非事后诸葛）`);
  ok(bad.steps[0].surprisal > 1.5 && bad.calibrationEma > 0.7, `大跌眼镜：惊奇 ${bad.steps[0].surprisal.toFixed(3)} nat，校准误差 ${bad.calibrationEma.toFixed(3)}`);
  ok(fe.currentSurprisal() > 1.5, `惊奇回流自由能引擎（EMA ${fe.currentSurprisal().toFixed(3)} nat）`);

  // 现实反复兑现 → 预测上修 + 校准收敛
  let report = bad;
  for (let i = 0; i < 8; i += 1) {
    report = engine.settle([{ state: 'f0', action: 'a' }], [true]);
  }
  // 第 8 次对账的 predicted 是该次执行前口径：17✓3✗ → 18/22；
  // 全部落定后后验 = 19/23（执行学习闭环）
  ok(report.steps[0].predicted > 0.81, `执行学习：预测从 0.786 上修至 ${report.steps[0].predicted.toFixed(3)}（18/22，执行前口径）`);
  ok(near(engine.posterior('f0', 'a').pSuccess, 19 / 23, 2e-6), `全部落定后后验 19/23 = ${engine.posterior('f0', 'a').pSuccess.toFixed(4)}`);
  ok(report.calibrationEma < bad.calibrationEma, `梦变准：校准误差 ${bad.calibrationEma.toFixed(3)} → ${report.calibrationEma.toFixed(3)}`);
  ok(engine.settledCount() === 9, `对账计数 9（实测 ${engine.settledCount()}）`);
}

// ═══════════════════ G 优化器集成 ═══════════════════

section('G 优化器：冷启动深思序列推荐（零情景记忆）');

{
  const memPath = path.join(os.tmpdir(), `dsh-verify-delib-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);
  const optimizer = new Optimizer({ memory });

  ok(optimizer.deliberativeRecommendation('code-gen', ['m1', 'm2'], 3) === undefined, '未挂载 → 无深思推荐（零漂移）');

  const engine = new DeliberationEngine();
  seed(engine, 'code-gen#s0', 'm1', 8, 2, 'x');
  seed(engine, 'code-gen#s0', 'm2', 4, 6, 'x');
  seed(engine, 'code-gen#s1', 'm1', 7, 3, 'x');
  seed(engine, 'code-gen#s1', 'm2', 6, 4, 'x');
  seed(engine, 'code-gen#s2', 'm1', 9, 1, 'x');
  seed(engine, 'code-gen#s2', 'm2', 3, 7, 'x');
  optimizer.attachDeliberation(engine);

  const result = optimizer.deliberativeRecommendation('code-gen', ['m1', 'm2'], 3);
  ok(result !== undefined && result.best.actions.length === 3, `冷启动产出 3 步序列（${result.best.actions.join(' → ')}，情景记忆为零）`);
  ok(result.best.actions[0] === 'm1', `首步选后验最优 m1（G=${result.best.totalEfe.toFixed(3)}）`);
  ok(result.ranked.length >= 2 && result.ranked[0].totalEfe <= result.ranked[1].totalEfe, `候选轨迹按 G 升序（${result.ranked.length} 条）`);
  ok(memory.getAllTaskPatterns().length === 0, '确认全程零情景记忆（推荐完全来自想象推演）');
  fs.rmSync(memPath, { force: true });
}

// ═══════════════════ H 元认知集成 ═══════════════════

section('H 元认知：梦校准 KPI（想象力可靠性的统一度量）');

{
  const engine = new DeliberationEngine();
  const meta = new MetaCognitionEngine({ applier: () => {} });
  const snap = (sr) => ({
    timestamp: Date.now(), successRate: sr, avgQuality: 0.8, avgLatency: 900,
    cacheHitRate: 0.3, modelSuccessRates: {}, activeExecutions: 0,
  });
  meta.observe(snap(0.85));
  ok(meta.getHealthReport().imagination === undefined, '未挂载 → 无梦校准项（零漂移）');

  meta.attachDeliberationEngine(engine);
  const fresh = meta.getHealthReport().imagination;
  ok(fresh !== undefined && fresh.plansSettled === 0 && fresh.interpretation.includes('尚未对账'), '挂载后 KPI 就位（未对账时诚实标注）');

  // 校准差 → 失灵报警
  seed(engine, 'h0', 'a', 10, 2, 'h0');
  engine.settle([{ state: 'h0', action: 'a' }], [false]);
  const broken = meta.getHealthReport().imagination;
  ok(broken.calibrationEma > 0.3 && broken.interpretation.includes('失灵'), `梦与现实背离 → 报警（cal=${broken.calibrationEma.toFixed(3)}：${broken.interpretation.slice(0, 18)}…）`);

  for (let i = 0; i < 12; i += 1) engine.settle([{ state: 'h0', action: 'a' }], [true]);
  const healed = meta.getHealthReport().imagination;
  ok(healed.calibrationEma < broken.calibrationEma, `持续兑现 → 梦变准（${broken.calibrationEma.toFixed(3)} → ${healed.calibrationEma.toFixed(3)}）`);
  ok(healed.plansSettled === 13 && healed.skills >= 1, `对账与技能计数可观测（${healed.plansSettled} 计划 / ${healed.skills} 技能）`);
}

// ═══════════════════ I 共生集成 ═══════════════════

section('I 共生：多步提案按轨迹自由能排序（缺省零漂移）');

{
  const bare = new SymbiosisRuntime();
  ok(bare.efeRankPlans([{ id: 'p', startState: 's', actions: ['a'] }]).length === 0, '未挂载 → 排序不可用（零漂移）');

  const engine = new DeliberationEngine();
  seed(engine, 'rich', 'bait', 19, 1, 'rich');
  seed(engine, 'rich', 'slow', 19, 1, 'rich');
  seed(engine, 'dead', 'bait', 2, 8, 'dead');
  seed(engine, 'dead', 'slow', 2, 8, 'dead');
  const runtime = new SymbiosisRuntime({ deliberation: engine });
  const ranked = runtime.efeRankPlans([
    { id: 'p-dead', startState: 'dead', actions: ['bait', 'slow'] },
    { id: 'p-rich', startState: 'rich', actions: ['bait', 'slow'] },
  ]);
  ok(ranked.length === 2 && ranked[0].id === 'p-rich', `富态计划排首（G=${ranked[0].totalEfe.toFixed(3)} < ${ranked[1].totalEfe.toFixed(3)}）`);
  ok(ranked[0].pAllSuccess > 0.8 && ranked[1].pAllSuccess < 0.1, `全程成功概率区分度（${ranked[0].pAllSuccess.toFixed(3)} vs ${ranked[1].pAllSuccess.toFixed(3)} = (20/22)² vs (3/12)²）`);
  ok(ranked[0].epistemicMonotone === true, '重访边认知坍缩标记随排序输出（可审计）');
}

// ═══════════════════ J 序列化 ═══════════════════

section('J 序列化：转移模型 + 技能库 roundtrip');

{
  const engine = new DeliberationEngine();
  seed(engine, 's0', 'slow', 6, 4, 'rich');
  seed(engine, 'rich', 'bait', 19, 1, 'rich');
  engine.settle(
    [
      { state: 's0', action: 'slow' },
      { state: 'rich', action: 'bait' },
    ],
    [true, true],
  );
  const dump = JSON.parse(JSON.stringify(engine.serialize()));

  const restored = new DeliberationEngine();
  restored.deserialize(dump);
  ok(near(restored.posterior('s0', 'slow').pSuccess, engine.posterior('s0', 'slow').pSuccess), '转移模型恢复（后验一致）');
  ok(restored.posterior('rich', 'bait').successor === 'rich', '后继分布恢复');
  ok(restored.allSkills().length === 1 && restored.skillsFor('s0').length === 1, '技能库恢复（触发态检索可用）');
  ok(near(restored.settledCount(), 1), '对账计数恢复');
  const a = engine.imagine('s0', ['slow', 'bait']);
  const b = restored.imagine('s0', ['slow', 'bait']);
  ok(near(a.totalEfe, b.totalEfe, 1e-9), `想象推演可重放（G 一致 = ${a.totalEfe.toFixed(4)}）`);
}

// ═══════════════════ 总结 ═══════════════════
console.log('\n══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 「深思心智：规划即推断」质变闭环成立`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
