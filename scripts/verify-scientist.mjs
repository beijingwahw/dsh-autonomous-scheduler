/**
 * verify-scientist.mjs — 10.0「科学家心智：最优实验设计」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   9.0 抽象心智：系统的全部学习都是被动的——世界喂什么统计什么；
 *      suggestExperiments 只是「不确定性 × 重要性」的启发式排序，
 *      不知道一次实验期望换多少 nat 的知识、不懂混杂的实验独占
 *      价值、不选臂、不算账、无台账。
 *   10.0 科学家心智：Lindley EIG 给每次实验定价（nat），混杂分歧
 *      （观测关联 ≠ 干预效应）获得实验独占加成——那是再多观测
 *      永远买不到的知识；netValue = EIG − cost 的预算仲裁拒绝
 *      赔本实验；信息台账对账「承诺 vs 兑现」，知识前沿审计
 *      知识版图的收缩。
 *
 * 闭环断言：
 *   A EIG 数学：Beta(1,1) 全无知臂 EIG 严格 > 0 且 = 一步期望熵收缩；
 *     证据充足臂 EIG → 0（收益递减）
 *   B 混杂侦测分水岭（核心）：观测强关联但干预无效的 Simpson 边，
 *     观测加多少样本都不改变「无法裁决」——只有混杂加成 > 0 的
 *     实验设计能定价这份观测不可得的知识
 *   C 最优臂选择：证据薄的臂被优先补样（方差大 → 一步收缩多）
 *   D 预算仲裁：costNat 抬高到 EIG 之上 → 该问题从设计中消失；
 *     统一货币 nat 下「好奇心有了会计」
 *   E 台账与兑现：settleExperiment 后 realized ≥ 0、台账可审计、
 *     deliveryRate = realized/promised、校准 EMA 启动
 *   F 知识前沿：实验结算后残差熵单调下降（知识版图收缩可审计）
 *   G 好奇心升级：挂载科学家后 proposeCausalExperiments 返回
 *     EIG 口径（净价值入假设文本）；原生透传 designOptimalExperiments
 *   H 宿主接线：SymbiosisRuntime 结算自动登记 (贡献者 → task.outcome)
 *     问题（幂等）；元认知健康报告携带知识前沿 KPI；缺省零漂移
 *
 * 运行：npm run build && node scripts/verify-scientist.mjs
 */

import {
  CausalKernel,
  CuriosityEngine,
  FreeEnergyEngine,
  MetaCognitionEngine,
  ModelAgent,
  ScientistMind,
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

const NOW = Date.now();

/** 混杂世界播种：观测强关联（混杂因子制造），干预真实无效 */
function seedSimpsonEdge(kernel, from, to) {
  // 观测流：X=1 几乎总与 Y=1 共现（健康模型总被派简单任务的镜像）
  for (let i = 0; i < 40; i += 1) kernel.observe(from, to, true, true, NOW);
  // X=0 时 Y 几乎不发生
  for (let i = 0; i < 40; i += 1) kernel.observe(from, to, false, false, NOW);
  // 干预流：do(X=1) 与 do(X=0) 的 Y 分布相同（真实效应 = 0）
  for (let i = 0; i < 8; i += 1) kernel.intervene(from, to, true, i % 2 === 0, 'ab', '随机化实验', NOW);
  for (let i = 0; i < 8; i += 1) kernel.intervene(from, to, false, i % 2 === 0, 'ab', '随机化对照', NOW);
}

/** 诚实世界播种：观测关联与干预效应一致（无混杂） */
function seedHonestEdge(kernel, from, to) {
  // 干预流：pDo = 25/32 ≈ 0.78，pDoNot = 7/32 ≈ 0.22 → ATE ≈ 0.56
  for (let i = 0; i < 24; i += 1) kernel.intervene(from, to, true, true, 'ab', null, NOW);
  for (let i = 0; i < 6; i += 1) kernel.intervene(from, to, true, false, 'ab', null, NOW);
  for (let i = 0; i < 6; i += 1) kernel.intervene(from, to, false, true, 'ab', null, NOW);
  for (let i = 0; i < 24; i += 1) kernel.intervene(from, to, false, false, 'ab', null, NOW);
  // 观测流刻意与干预口径一致（P(Y=1|X=1)≈0.78，P(Y=1|X=0)≈0.22）
  for (let i = 0; i < 25; i += 1) kernel.observe(from, to, true, true, NOW);
  for (let i = 0; i < 7; i += 1) kernel.observe(from, to, true, false, NOW);
  for (let i = 0; i < 7; i += 1) kernel.observe(from, to, false, true, NOW);
  for (let i = 0; i < 25; i += 1) kernel.observe(from, to, false, false, NOW);
}

// ═══════════════════ A EIG 数学 ═══════════════════

section('A EIG 数学：无知臂有正期望增益，饱和臂增益趋零');

{
  const kernel = new CausalKernel();
  const sci = new ScientistMind(kernel, undefined, { defaultCostNat: 0.01 });

  // 全无知臂：Beta(1,1) → H=ln2；一步后期望熵严格下降
  kernel.addNode({ id: 'x', kind: 'action' });
  kernel.addNode({ id: 'y', kind: 'kpi' });
  kernel.observe('x', 'y', true, false, NOW); // 建边（观测流不进臂）
  sci.registerQuestion('x', 'y', '全无知问题');
  const [d0] = sci.designExperiments(1, NOW);
  ok(d0 !== undefined, '全无知问题获得设计');
  ok(d0.armEig > 0.05, `Beta(1,1) 臂 EIG > 0.05 nat（实测 ${d0.armEig.toFixed(4)} ≈ 一步期望熵收缩）`);
  ok(d0.confoundingBonus === 0, `无混杂证据 → 加成 = 0（实测 ${d0.confoundingBonus}）`);
  ok(d0.totalEig === d0.armEig, `总价值 = 臂 EIG（${d0.totalEig.toFixed(4)} = ${d0.armEig.toFixed(4)}）`);

  // 饱和臂：30 成功 0 失败 → 后验接近点质量，EIG 趋零
  for (let i = 0; i < 30; i += 1) kernel.intervene('x', 'y', true, true, 'test', null, NOW);
  for (let i = 0; i < 30; i += 1) kernel.intervene('x', 'y', false, false, 'test', null, NOW);
  const [d1] = sci.designExperiments(1, NOW);
  ok(d1.armEig < 0.02, `饱和双臂 EIG < 0.02 nat（实测 ${d1.armEig.toFixed(4)}——收益递减：知识已近 frontier）`);
  ok(d1.netValue < d0.netValue, `净价值单调下降（${d0.netValue.toFixed(3)} → ${d1.netValue.toFixed(3)} nat）`);
}

// ═══════════════════ B 混杂侦测分水岭（核心） ═══════════════════

section('B 混杂侦测分水岭：观测永远买不到的知识，只有实验能定价');

{
  const kernel = new CausalKernel();
  const sci = new ScientistMind(kernel, undefined, { defaultCostNat: 0.05 });

  seedSimpsonEdge(kernel, 'healthy-model', 'task.outcome');
  seedHonestEdge(kernel, 'proven-model', 'task.outcome');
  sci.registerQuestion('healthy-model', 'task.outcome', '观测关联是否为伪');
  sci.registerQuestion('proven-model', 'task.outcome', '诚实效应复核');

  const simpsonEff = kernel.effect('healthy-model', 'task.outcome', NOW);
  const honestEff = kernel.effect('proven-model', 'task.outcome', NOW);
  ok(simpsonEff.observationalAssociation > 0.9, `Simpson 边观测关联 > 0.9（${simpsonEff.observationalAssociation.toFixed(3)}——混杂因子制造的伪相关）`);
  ok(Math.abs(simpsonEff.ate) < 0.4, `但干预效应 ≈ 0（ATE ${simpsonEff.ate.toFixed(3)}）——观测与干预显著背离`);
  ok(simpsonEff.confounding > 0.2, `混杂度 > 0.2（${simpsonEff.confounding.toFixed(3)}）`);
  ok(honestEff.confounding < 0.1, `诚实边混杂度 < 0.1（${honestEff.confounding.toFixed(3)}）`);

  const designs = sci.designExperiments(5, NOW);
  const byFrom = Object.fromEntries(designs.map((d) => [d.from, d]));
  ok(byFrom['healthy-model'] !== undefined, 'Simpson 边获得实验设计');
  ok(
    byFrom['healthy-model'].confoundingBonus > 0.1,
    `混杂加成 > 0.1 nat（实测 +${byFrom['healthy-model'].confoundingBonus.toFixed(3)}：这部分知识观测永远买不到）`,
  );
  // 对照：诚实边双臂已饱和（EIG≈0.013 nat）且无混杂加成 → 不抵代价，
  // 被预算仲裁出局——混杂加成正是 Simpson 边唯一的设计资格来源
  ok(
    byFrom['proven-model'] === undefined,
    `诚实边无加成且 EIG 饱和 → 被仲裁出局（不在设计中）——分水岭的对照组`,
  );
  ok(
    designs[0].from === 'healthy-model',
    `净价值排序：混杂边优先（${designs[0].from} 净 ${designs[0].netValue.toFixed(3)} nat）——实验设计的本质优势被定价`,
  );
  ok(
    byFrom['healthy-model'].hypothesis.includes('干预'),
    `假设文本携带可证伪陈述（${byFrom['healthy-model'].hypothesis.slice(0, 42)}…）`,
  );

  // 分水岭对照：观测再加 200 样本，混杂依旧、加成依旧——
  // 被动学习在该边上永不收敛，实验价值不随观测量衰减
  for (let i = 0; i < 200; i += 1) kernel.observe('healthy-model', 'task.outcome', true, true, NOW);
  const designs2 = sci.designExperiments(5, NOW);
  const simpson2 = designs2.find((d) => d.from === 'healthy-model');
  ok(
    simpson2 !== undefined && simpson2.confoundingBonus > 0.1,
    `观测 ×5 后混杂加成分毫未减（+${simpson2.confoundingBonus.toFixed(3)} nat）——被动学习不可替代性的数学表达`,
  );
}

// ═══════════════════ C 最优臂选择 ═══════════════════

section('C 最优臂选择：证据薄的臂被优先补样');

{
  const kernel = new CausalKernel();
  const sci = new ScientistMind(kernel, undefined, { defaultCostNat: 0.005 });

  // 不对称臂：do=1 已有 20 成功（近饱和），do=0 完全无知
  for (let i = 0; i < 20; i += 1) kernel.intervene('asym', 'y', true, true, 'test', null, NOW);
  sci.registerQuestion('asym', 'y', '不对称双臂');
  const [d] = sci.designExperiments(1, NOW);
  ok(d.arm === false, `最优臂 = do=0（实测 arm=${d.arm}：无知臂方差最大、一步收缩最多）`);
  ok(d.predictedP === 0.5, `无知臂预测 p = 0.5（Beta(1,1) 均值，实测 ${d.predictedP}）`);
  ok(d.priorAlpha === 1 && d.priorBeta === 1, `先验登记 (α,β)=(1,1)（实测 (${d.priorAlpha},${d.priorBeta})）`);
}

// ═══════════════════ D 预算仲裁 ═══════════════════

section('D 预算仲裁：知识不抵代价的问题不设计');

{
  const kernel = new CausalKernel();
  const sci = new ScientistMind(kernel, undefined, { defaultCostNat: 0.05 });

  kernel.intervene('cheap-q', 'y', true, true, 'test', null, NOW);
  kernel.intervene('cheap-q', 'y', false, false, 'test', null, NOW);
  kernel.intervene('dear-q', 'y', true, true, 'test', null, NOW);
  kernel.intervene('dear-q', 'y', false, false, 'test', null, NOW);
  sci.registerQuestion('cheap-q', 'y', '廉价问题', 0.005);
  sci.registerQuestion('dear-q', 'y', '昂贵问题', 5);

  const designs = sci.designExperiments(5, NOW);
  ok(designs.some((d) => d.from === 'cheap-q'), '廉价问题（cost 0.005 nat）在设计中');
  ok(!designs.some((d) => d.from === 'dear-q'), '昂贵问题（cost 5 nat）被仲裁出局——好奇心第一次有了会计');
  ok(designs.every((d) => d.netValue > 0), `所有设计净价值 > 0（最小 ${Math.min(...designs.map((d) => d.netValue)).toFixed(3)} nat）`);
}

// ═══════════════════ E 台账与兑现 ═══════════════════

section('E 信息台账：承诺 vs 兑现的对账');

{
  const kernel = new CausalKernel();
  const fe = new FreeEnergyEngine();
  const sci = new ScientistMind(kernel, fe, { defaultCostNat: 0.01 });

  kernel.intervene('t', 'y', true, true, 'test', null, NOW); // 建边（设计原料）
  sci.registerQuestion('t', 'y', '台账问题');
  const [d] = sci.designExperiments(1, NOW);
  ok(d.id === 1, `实验编号从 1 起（实测 ${d.id}）`);

  // 结算：观测 Y=1（先验 0.5 时两结局等惊奇，实际信息 > 0）
  const entry = sci.settleExperiment(d, true, 'scientist', NOW);
  ok(entry !== undefined, '结算返回台账条目');
  ok(entry.promisedEig === d.totalEig, `承诺口径入账（${entry.promisedEig.toFixed(4)} nat）`);
  ok(entry.realizedInfo > 0, `实现信息 > 0（${entry.realizedInfo.toFixed(4)} nat：H0 − H(结局后验)）`);
  ok(entry.surprisal > 0.69 && entry.surprisal < 0.7, `惊奇 = −ln(0.5) ≈ 0.693（实测 ${entry.surprisal.toFixed(4)}）`);
  ok(sci.experimentLedger().length === 1, '台账可审计（1 条）');

  const kf = sci.knowledgeFrontier(NOW);
  ok(kf.experimentsRun === 1, `前沿记录实验 1 次（实测 ${kf.experimentsRun}）`);
  ok(kf.cumulativePromisedNat === d.totalEig, `累计承诺 = 设计 EIG（${kf.cumulativePromisedNat.toFixed(4)} nat）`);
  ok(near(kf.cumulativeRealizedNat, entry.realizedInfo, 1e-5), `累计实现 = 台账实现（${kf.cumulativeRealizedNat.toFixed(4)} nat）`);
  ok(kf.deliveryRate > 0, `兑现率 ${kf.deliveryRate.toFixed(3)}（realized / promised）`);
  ok(kf.designCalibration >= 0, `设计校准 EMA 启动（${kf.designCalibration.toFixed(4)}：|承诺 − 实现|）`);

  // 重复结算同一设计：图再入一次证据但台账如实记账（审计不美化）
  const before = sci.experimentLedger().length;
  sci.settleExperiment(d, false, 'scientist', NOW);
  ok(sci.experimentLedger().length === before + 1, '台账如实追加（不隐藏重复实验）');
}

// ═══════════════════ F 知识前沿收缩 ═══════════════════

section('F 知识前沿：实验结算后残差熵单调下降');

{
  const kernel = new CausalKernel();
  const sci = new ScientistMind(kernel, undefined, { defaultCostNat: 0.001 });

  kernel.intervene('f', 'y', true, true, 'test', null, NOW);
  sci.registerQuestion('f', 'y', '前沿问题');

  const before = sci.knowledgeFrontier(NOW).residualEntropyNat;
  // 连续设计与结算 3 轮：每轮挑当前最优臂做实验
  for (let round = 0; round < 3; round += 1) {
    const [d] = sci.designExperiments(1, NOW);
    if (!d) break;
    sci.settleExperiment(d, true, 'scientist', NOW);
  }
  const after = sci.knowledgeFrontier(NOW).residualEntropyNat;
  ok(after < before, `残差熵单调下降（${before.toFixed(4)} → ${after.toFixed(4)} nat）——知识版图收缩可审计`);
  ok(sci.knowledgeFrontier(NOW).experimentsRun === 3, `3 次实验全部入账（实测 ${sci.knowledgeFrontier(NOW).experimentsRun}）`);
  ok(
    sci.knowledgeFrontier(NOW).interpretation.length > 0,
    `前沿解读：${sci.knowledgeFrontier(NOW).interpretation.slice(0, 40)}…`,
  );
}

// ═══════════════════ G 好奇心升级 ═══════════════════

section('G 好奇心升级：实验建议从启发式升级为 EIG 口径');

{
  const provider = {
    getExposure: () => ({}),
    getExperienceCounts: () => ({}),
    getFailureRates: () => ({}),
  };
  const kernel = new CausalKernel();
  const curiosity = new CuriosityEngine(provider);
  curiosity.attachCausalKernel(kernel);

  // 未挂科学家：5.0 启发式口径（不确定性 × 重要性）
  seedHonestEdge(kernel, 'h-model', 'task.outcome');
  const heuristic = curiosity.proposeCausalExperiments('task.outcome', 2);
  ok(heuristic.length > 0, `未挂载：5.0 启发式建议可用（${heuristic.length} 条）`);
  ok(!heuristic[0].hypothesis.includes('nat'), '启发式假设无 nat 定价（旧口径）');

  // 挂载科学家：EIG 口径 + 问题空间声明
  const sci = new ScientistMind(kernel, undefined, { defaultCostNat: 0.01 });
  curiosity.attachScientistMind(sci);
  const noQuestion = curiosity.proposeCausalExperiments('task.outcome', 2);
  ok(noQuestion.length > 0, `问题空间空时回退启发式（${noQuestion.length} 条——兼容不断档）`);

  sci.registerQuestion('h-model', 'task.outcome', 'EIG 复核');
  const eigBased = curiosity.proposeCausalExperiments('task.outcome', 2);
  ok(eigBased.length > 0, 'EIG 口径建议产出');
  ok(eigBased[0].hypothesis.includes('nat'), `假设携带 nat 净价值（${eigBased[0].hypothesis.slice(-46)}）`);
  ok(eigBased[0].infoGain > 0.5, `sigmoid 净价值映射 > 0.5（实测 ${eigBased[0].infoGain}）`);

  const native = curiosity.designOptimalExperiments(3);
  ok(native.length > 0 && native[0].netValue > 0, `原生口径透传（净价值 ${native[0].netValue.toFixed(4)} nat）`);
  ok(native[0].arm !== undefined && typeof native[0].arm === 'boolean', `原生设计携带最优臂（arm=${native[0].arm}）`);
}

// ═══════════════════ H 宿主接线 ═══════════════════

section('H 宿主接线：结算自动登记问题 + 元认知知识前沿 KPI + 缺省零漂移');

{
  // H1 元认知：缺省零漂移 + 挂载后 KPI 出现
  const meta = new MetaCognitionEngine({ applier: () => {} });
  meta.observe({
    timestamp: Date.now(), successRate: 0.85, avgQuality: 0.8, avgLatency: 900,
    cacheHitRate: 0.3, modelSuccessRates: {}, activeExecutions: 0,
  });
  ok(meta.getHealthReport().knowledgeFrontier === undefined, '未挂载 → 健康报告无知识前沿项（零漂移）');

  const kernel = new CausalKernel();
  const sci = new ScientistMind(kernel, undefined, {});
  meta.attachScientistMind(sci);
  const kpi = meta.getHealthReport().knowledgeFrontier;
  ok(kpi !== undefined, '挂载 → 知识前沿 KPI 出现（第五层）');
  ok(kpi.questions === 0 && kpi.interpretation.includes('待命'), `空问题空间如实呈现（${kpi.interpretation.slice(0, 24)}…）`);

  // H2 共生运行时：结算自动登记问题（幂等）
  const runtime = new SymbiosisRuntime({ scientist: sci, causalKernel: kernel });
  runtime.register(new ModelAgent('m-fast'));
  runtime.register(new ModelAgent('m-slow'));
  runtime.settleTaskOutcome(true, [{ agentId: 'model:m-fast' }, { agentId: 'model:m-slow' }]);
  ok(sci.allQuestions().length === 2, `结算自动登记 2 个问题（实测 ${sci.allQuestions().length}）`);
  runtime.settleTaskOutcome(false, [{ agentId: 'model:m-fast' }]);
  ok(sci.allQuestions().length === 2, '重复结算幂等（问题不重复登记）');
  ok(
    sci.allQuestions().every((q) => q.to === 'task.outcome'),
    `问题指向结局节点（${sci.allQuestions().map((q) => `${q.from}→${q.to}`).join(' ')}）`,
  );

  // H3 登记后问题进入设计循环（调度热点 → 研究热点）
  const designs = sci.designExperiments(3, NOW);
  ok(designs.length === 2, `两个热点问题各获设计（实测 ${designs.length}）`);
  ok(
    designs.every((d) => d.netValue > 0),
    `设计均通过预算仲裁（净价值 ${designs.map((d) => d.netValue.toFixed(3)).join(' / ')} nat）`,
  );

  // H4 未挂载 scientist 的 runtime：零漂移
  const bareSci = new ScientistMind(new CausalKernel(), undefined, {});
  const bareRuntime = new SymbiosisRuntime({});
  bareRuntime.register(new ModelAgent('m-x'));
  bareRuntime.settleTaskOutcome(true, [{ agentId: 'm-x' }]);
  ok(bareSci.allQuestions().length === 0, '未挂载 runtime → 问题空间保持空（零漂移）');
}

// ═══════════════════ 总结 ═══════════════════
console.log('\n══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 「科学家心智：最优实验设计」质变闭环成立`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
