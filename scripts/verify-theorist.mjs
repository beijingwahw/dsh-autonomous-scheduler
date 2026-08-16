/**
 * verify-theorist.mjs — 11.0「理论心智：从数据到定律」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   10.0 科学家心智：高效获取知识，但知识是散落的边统计——K 条
 *      同族边各自从 Beta(1,1) 交学费，证据从不共享；新成员入族
 *      仍从全无知起步；没有任何机制把数据压缩成定律——
 *      系统永远停在第谷（有数据，无定律）。
 *   11.0 理论心智：层级贝叶斯把同族 K 条边压缩为一条定律
 *      （借力收缩——定律区间窄于任何单边）；MDL 用 nat 定价
 *      「理解即压缩」（compression ≤ 0 的定律不配存在）；
 *      作用域内新边零样本继承全族知识；反常者驱逐、定律重建
 *      （范式转移——科学的自我修正力）。
 *
 * 闭环断言：
 *   A 借力收缩：5 条同质稀疏边 → 一条定律，区间严格窄于任何单边
 *   B MDL 压缩定价：compression > 0（定律省下的描述长度，nat）
 *   C 零样本预测：新成员零数据 → 直接拿定律后验说话（无冷启动）
 *   D 反常侦测：偏离定律的成员被标记 anomalous（定律存疑 contested）
 *   E 范式转移（分水岭）：一条强反常边使整组不抵代价 → 驱逐 outlier
 *     → 为幸存者重建定律——「一次反常是噪声，一组反常是新范式」有算术
 *   F 异质对照：真正异质的族（0.9/0.5/0.1）立不出任何定律
 *   G 科学家集成：定律作用域内的问题获得定律试验加成（ln(K+1) 封顶）
 *   H 元认知 KPI：理论前沿第六层 + 缺省零漂移
 *   I 确定性重放：因果图序列化 roundtrip 后归纳出严格相同的定律
 *
 * 运行：npm run build && node scripts/verify-theorist.mjs
 */

import {
  CausalKernel,
  MetaCognitionEngine,
  ScientistMind,
  TheoristEngine,
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

/** 第谷式播种：K 个同族模型各自积累稀疏且同质的 do=1 臂证据 */
function seedFamily(kernel, family, ids, succ, fail) {
  for (const id of ids) {
    for (let i = 0; i < succ; i += 1) kernel.intervene(`${family}:${id}`, 'task.outcome', true, true, 'test', null, NOW);
    for (let i = 0; i < fail; i += 1) kernel.intervene(`${family}:${id}`, 'task.outcome', true, false, 'test', null, NOW);
  }
}

// ═══════════════════ A 借力收缩 ═══════════════════

section('A 借力收缩：5 条稀疏边 → 一条定律，区间窄于任何单边');

{
  const kernel = new CausalKernel();
  const theorist = new TheoristEngine(kernel);
  seedFamily(kernel, 'model', ['m1', 'm2', 'm3', 'm4', 'm5'], 7, 3);

  const theories = theorist.induce(NOW);
  ok(theories.length === 1, `归纳出 1 条定律（实测 ${theories.length}）`);
  const t = theories[0];
  ok(t.id === 'model→task.outcome' && t.status === 'law', `作用域 model→task.outcome，状态 law（实测 ${t.id} / ${t.status}）`);
  ok(near(t.lawAlpha, 36, 1e-9) && near(t.lawBeta, 16, 1e-9), `定律后验 Beta(36,16)（实测 (${t.lawAlpha},${t.lawBeta})）`);
  ok(near(t.lawP, 36 / 52, 1e-6), `定律成功率 = 36/52 ≈ ${(36 / 52).toFixed(4)}（实测 ${t.lawP}）`);

  // 借力收缩：定律 Wilson 区间严格窄于任何单边（7/10 的 Wilson）
  const m1 = kernel.effect('model:m1', 'task.outcome', NOW);
  const [sLower, sUpper] = [m1.lower + m1.pDoNot, m1.pDo]; // 单边 do=1 臂近似区间
  ok(
    t.lawUpper - t.lawLower < sUpper - sLower,
    `定律区间宽 ${(t.lawUpper - t.lawLower).toFixed(3)} < 单边区间宽 ${(sUpper - sLower).toFixed(3)}——集体确定，个体不确定`,
  );
  ok(t.members.length === 5 && t.members.every((m) => !m.anomalous), `5 成员全部一致（无反常者）`);
}

// ═══════════════════ B MDL 压缩定价 ═══════════════════

section('B MDL：理解即压缩——compression > 0 定律才配存在');

{
  const kernel = new CausalKernel();
  const theorist = new TheoristEngine(kernel);
  seedFamily(kernel, 'model', ['a', 'b', 'c', 'd', 'e'], 7, 3);

  const [t] = theorist.induce(NOW);
  ok(t.compressionNat > 0.5, `压缩账目 = 对数贝叶斯因子 ${t.compressionNat.toFixed(3)} nat > 0.5（lnB(36,16) − 5·lnB(8,4)——一条定律解释全部数据 vs 各自一个参数）`);
  ok(
    t.members.every((m) => m.fitsLawNat > 0),
    `同质成员全员入伙有收益（min ${Math.min(...t.members.map((m) => m.fitsLawNat)).toFixed(3)} nat > 0——用全族知识解释自己比单干便宜）`,
  );

  const frontier = theorist.frontier();
  ok(frontier.theories === 1 && frontier.compressedEdges === 5, `前沿：1 条定律压缩 5 条边`);
  ok(near(frontier.compressionNat, t.compressionNat), `前沿压缩总账与定律一致（${frontier.compressionNat} nat）`);
  ok(frontier.interpretation.includes('定律'), `前沿解读：${frontier.interpretation.slice(0, 44)}…`);
}

// ═══════════════════ C 零样本预测 ═══════════════════

section('C 零样本：新成员入族即继承全族知识（无冷启动）');

{
  const kernel = new CausalKernel();
  const theorist = new TheoristEngine(kernel);
  seedFamily(kernel, 'model', ['a', 'b', 'c', 'd', 'e'], 7, 3);
  theorist.induce(NOW);

  // 新成员零数据：直接拿定律后验说话
  const pred = theorist.predict('model:brand-new', 'task.outcome', NOW);
  ok(pred !== undefined, '零数据新成员获得定律预测');
  ok(near(pred.p, 36 / 52, 1e-6), `预测 = 定律均值 ${(36 / 52).toFixed(4)}（实测 ${pred.p}）`);
  ok(pred.theoryId === 'model→task.outcome', `预测来源可审计（${pred.theoryId}）`);

  // 有自己证据的成员不再零样本（自己的后验优先）
  kernel.intervene('model:a', 'task.outcome', true, true, 'test', null, NOW);
  ok(theorist.predict('model:a', 'task.outcome', NOW) === undefined, '有自身证据的边用自己的后验（零样本让位）');

  // 族外成员无定律可借
  ok(theorist.predict('other:x', 'task.outcome', NOW) === undefined, '族外边无定律覆盖（诚实返回未知）');

  const frontier = theorist.frontier();
  ok(frontier.zeroShotPredictions === 1, `零样本计数 ${frontier.zeroShotPredictions}（定律泛化的使用量）`);
}

// ═══════════════════ D 反常侦测 ═══════════════════

section('D 反常侦测：偏离定律的成员被标记（定律存疑）');

{
  const kernel = new CausalKernel();
  const theorist = new TheoristEngine(kernel);
  seedFamily(kernel, 'model', ['a', 'b', 'c', 'd'], 7, 3); // 同质 4 条
  seedFamily(kernel, 'model', ['odd'], 1, 3); // 轻度反常：0.25 vs 族 0.7（稀疏证据，杀伤有限）

  const [t] = theorist.induce(NOW);
  const odd = t.members.find((m) => m.from === 'model:odd');
  ok(odd !== undefined, '反常者仍在成员中（整体贝叶斯因子仍 > 0，未到驱逐门槛）');
  ok(odd.anomalous === true, `反常者被标记（入伙收益 ${odd.fitsLawNat.toFixed(3)} ≤ 0——它的数据用全族知识解释不如单干）`);
  ok(t.status === 'contested', `定律状态 contested（存在反常者——定律存疑）`);
  ok(t.members.every((m) => (m.from === 'model:odd' ? true : !m.anomalous)), '同质成员不受反常者牵连（各自记账）');
  ok(t.compressionNat > 0, `定律整体仍赚（+${t.compressionNat.toFixed(3)} nat——一次反常是噪声，不是革命）`);

  const frontier = theorist.frontier();
  ok(frontier.theories === 1 && frontier.paradigmShifts === 0, '反常未推翻定律整体（compression 仍 > 0，不驱逐）');
}

// ═══════════════════ E 范式转移（分水岭） ═══════════════════

section('E 范式转移：强反常使定律不抵代价 → 驱逐 outlier → 幸存者重建');

{
  const kernel = new CausalKernel();
  const theorist = new TheoristEngine(kernel);
  seedFamily(kernel, 'model', ['a', 'b', 'c', 'd', 'e'], 7, 3); // 真实族：P≈0.7
  // 先归纳出健康定律
  let [t0] = theorist.induce(NOW);
  ok(t0.paradigmShift === false && t0.outliers.length === 0, '初始归纳无范式转移');

  // 两个强反常者进入：真实 P≈0.05，与族 0.7 背道而驰
  seedFamily(kernel, 'model', ['bad1', 'bad2'], 0, 10);
  const [t1] = theorist.induce(NOW);
  ok(t1.paradigmShift === true, `范式转移触发（定律整体不抵代价 → 驱逐重建）`);
  ok(
    t1.outliers.map((o) => o.from).sort().join(',') === 'model:bad1,model:bad2',
    `outliers = 强反常者（${t1.outliers.map((o) => o.from).join(' ')}——新范式的种子）`,
  );
  ok(t1.members.length === 5 && t1.status === 'law', `定律为 5 位幸存者重建，恢复 law 状态`);
  ok(near(t1.lawP, t0.lawP, 0.05), `重建后定律均值稳定（${t1.lawP.toFixed(3)} ≈ ${t0.lawP.toFixed(3)}——科学的核心没有被反常者污染）`);
  ok(t1.compressionNat > 0, `重建后压缩账目回正（+${t1.compressionNat.toFixed(3)} nat）`);
  ok(theorist.frontier().paradigmShifts === 1, `范式转移累计 1 次（科学的自我修正力 KPI）`);
}

// ═══════════════════ F 异质对照 ═══════════════════

section('F 异质对照：真正异质的族立不出定律');

{
  const kernel = new CausalKernel();
  const theorist = new TheoristEngine(kernel);
  seedFamily(kernel, 'api', ['hi'], 9, 1); // 0.9
  seedFamily(kernel, 'api', ['mid'], 5, 5); // 0.5
  seedFamily(kernel, 'api', ['lo'], 1, 9); // 0.1

  const theories = theorist.induce(NOW);
  const apiTheory = theories.find((t) => t.family === 'api');
  ok(apiTheory === undefined, '异质族无定律（强行归纳的偏离代价超过全部独立熵——数据里没有定律，就不造定律）');
  ok(theorist.frontier().theories === 0, `前沿定律数 0（实测 ${theorist.frontier().theories}）`);
}

// ═══════════════════ G 科学家集成 ═══════════════════

section('G 科学家集成：定律试验加成——一次实验校准整个作用域');

{
  const kernel = new CausalKernel();
  const theorist = new TheoristEngine(kernel);
  seedFamily(kernel, 'model', ['a', 'b', 'c', 'd', 'e'], 7, 3);
  theorist.induce(NOW);

  const sci = new ScientistMind(kernel, undefined, { defaultCostNat: 0.01 });
  sci.registerQuestion('model:a', 'task.outcome', '定律作用域内的问题');
  kernel.intervene('solo:x', 'y', true, true, 'test', null, NOW);
  sci.registerQuestion('solo:x', 'y', '作用域外的问题');

  // 未挂理论：无定律试验加成
  const [plain] = sci.designExperiments(2, NOW);
  const plainTotal = plain.totalEig;
  ok(plain.lawBonus === 0, `未挂理论 → lawBonus = 0（实测 ${plain.lawBonus}）`);

  // 挂理论：作用域内问题获得 ln(K+1) 封顶加成
  sci.attachTheorist(theorist);
  const designs = sci.designExperiments(2, NOW);
  const byFrom = Object.fromEntries(designs.map((d) => [d.from, d]));
  ok(byFrom['model:a'] !== undefined && byFrom['model:a'].lawBonus > 0, `作用域内 lawBonus > 0（+${byFrom['model:a'].lawBonus.toFixed(3)} nat = ln(6) 封顶于 1.0）`);
  ok(byFrom['model:a'].lawBonus <= 1.0, `加成封顶生效（≤ 1.0 nat，实测 ${byFrom['model:a'].lawBonus}）`);
  ok(byFrom['solo:x'] !== undefined && byFrom['solo:x'].lawBonus === 0, '作用域外问题无加成');
  ok(byFrom['model:a'].netValue > plainTotal - 0.01, `作用域内净价值抬升（${byFrom['model:a'].netValue.toFixed(3)} ≥ 无理论 ${plainTotal.toFixed(3)}）`);
  ok(byFrom['model:a'].rationale.includes('定律'), `设计理由引用定律（${byFrom['model:a'].rationale.slice(0, 48)}…）`);
}

// ═══════════════════ H 元认知 KPI ═══════════════════

section('H 元认知：理论前沿第六层 KPI + 缺省零漂移');

{
  const meta = new MetaCognitionEngine({ applier: () => {} });
  meta.observe({
    timestamp: Date.now(), successRate: 0.85, avgQuality: 0.8, avgLatency: 900,
    cacheHitRate: 0.3, modelSuccessRates: {}, activeExecutions: 0,
  });
  ok(meta.getHealthReport().theoryFrontier === undefined, '未挂载 → 健康报告无理论前沿项（零漂移）');

  const kernel = new CausalKernel();
  const theorist = new TheoristEngine(kernel);
  seedFamily(kernel, 'model', ['a', 'b', 'c', 'd', 'e'], 7, 3);
  meta.attachTheoristEngine(theorist);
  let kpi = meta.getHealthReport().theoryFrontier;
  ok(kpi !== undefined && kpi.theories === 1 && kpi.compressedEdges === 5, `挂载即自动归纳——KPI 立即反映当前图（1 条定律压缩 5 边，无需显式 induce）`);

  theorist.predict('model:new', 'task.outcome', NOW);
  kpi = meta.getHealthReport().theoryFrontier;
  ok(kpi.theories === 1 && kpi.compressedEdges === 5, `KPI：1 条定律压缩 5 边`);
  ok(kpi.compressionNat > 0 && kpi.zeroShotPredictions === 1, `压缩 ${kpi.compressionNat.toFixed(3)} nat / 零样本 ${kpi.zeroShotPredictions} 次`);
  ok(kpi.paradigmShifts === 0 && kpi.outlierEdges === 0, '无范式转移、无 outlier（如实呈现）');

  // KPI 永不过期：图演化（第 6 位成员入族）后再次读取自动重归纳
  seedFamily(kernel, 'model', ['f6'], 7, 3);
  kpi = meta.getHealthReport().theoryFrontier;
  ok(kpi.compressedEdges === 6, `图演化后 KPI 自动刷新（压缩边 5 → ${kpi.compressedEdges}——定律基于当前证据，不是首次快照）`);
}

// ═══════════════════ H2 范式转移去重 ═══════════════════

section('H2 范式转移去重：同状态重复归纳不虚增 KPI');

{
  const kernel = new CausalKernel();
  const theorist = new TheoristEngine(kernel);
  seedFamily(kernel, 'model', ['a', 'b', 'c', 'd', 'e'], 7, 3);
  seedFamily(kernel, 'model', ['bad1', 'bad2'], 0, 10);

  const f1 = theorist.frontier(NOW);
  ok(f1.paradigmShifts === 1, `首次归纳记录 1 次范式转移`);
  const f2 = theorist.frontier(NOW);
  const f3 = theorist.frontier(NOW);
  ok(f2.paradigmShifts === 1 && f3.paradigmShifts === 1, `重复读取 frontier（心跳刷新）不重复计数（仍为 ${f3.paradigmShifts}——事件计数而非调用计数）`);
  ok(f3.outlierEdges === 2 && f3.theories === 1, `KPI 状态本身保持正确（1 定律 / 2 outlier）`);

  // 去重是实例内状态：新引擎对同一图首次归纳照常计为 1 次事件
  const dump = JSON.parse(JSON.stringify(kernel.serialize()));
  const replayed = new CausalKernel();
  replayed.deserialize(dump);
  const t2 = new TheoristEngine(replayed);
  ok(t2.frontier(NOW).paradigmShifts === 1, '新引擎实例首次归纳照常计 1 次（去重不跨实例泄漏）');
}

// ═══════════════════ I 确定性重放 ═══════════════════

section('I 确定性重放：图 roundtrip 后归纳出严格相同的定律');

{
  const kernel = new CausalKernel();
  seedFamily(kernel, 'model', ['a', 'b', 'c', 'd', 'e'], 7, 3);
  seedFamily(kernel, 'model', ['bad'], 0, 10);
  const theorist1 = new TheoristEngine(kernel);
  const before = theorist1.induce(NOW);

  // 序列化 → 新内核 → 反序列化 → 重新归纳
  const dump = JSON.parse(JSON.stringify(kernel.serialize()));
  const kernel2 = new CausalKernel();
  kernel2.deserialize(dump);
  const theorist2 = new TheoristEngine(kernel2);
  const after = theorist2.induce(NOW);

  ok(before.length === after.length && before.length > 0, `定律数一致（${before.length}）`);
  ok(
    before.every((t, i) => near(t.lawP, after[i].lawP, 1e-9) && near(t.compressionNat, after[i].compressionNat, 1e-9)),
    `每条定律的均值与压缩账目逐位重放（${after.map((t) => `${t.id}: ${t.lawP.toFixed(4)}/${t.compressionNat.toFixed(4)}`).join(' ')}）`,
  );
  ok(
    before.every((t, i) => t.members.length === after[i].members.length && t.status === after[i].status),
    '成员数与状态一致（归纳是图的纯函数——科学结论可重放）',
  );
}

// ═══════════════════ 总结 ═══════════════════
console.log('\n══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 「理论心智：从数据到定律」质变闭环成立`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
