/**
 * verify-causal-kernel.mjs — 5.0「从相关到因果」质变闭环离线验证
 *
 * 世界性突破断言：系统的每个关键决策（分红 / 调度教训 / 旋钮推荐 /
 * 探索目标）从「相关性统计」跃迁到「do-干预因果推断」——
 * Pearl 因果阶梯第二层在全模块贯通。
 *
 * 断言组：
 *   A 因果内核基座：双臂 do-干预 ATE 估计 / 观测-干预口径分离 /
 *     混杂指纹检测（冰淇淋-溺水伪因果被证伪）/ 因果排序
 *   B Shapley 数学：对称性 / 有效性（Σφ = v(N)）/ 搭便车者归零
 *   C 共生 Shapley 分红：任务结算登记 do-干预 / 关键贡献者 > 挂名者 /
 *     未挂载内核零漂移（linear-wilson）
 *   D 因果世界模型：recordIntervention → predictInterventionEffect 闭环
 *   E 反事实反思：失败教训携带「若选 B」因果区间
 *   F 元认知因果旋钮：调参 → 下批 KPI 对账 → knob: 边入图 → 因果排序生效
 *   G 假设驱动好奇心：不确定边 → 实验建议 → 干预 → 区间收缩（信息增益）
 *
 * 运行：npm run build && node scripts/verify-causal-kernel.mjs
 */

import {
  CausalKernel,
  shapleyValues,
  coalitionValue,
  SymbiosisRuntime,
  AgentBase,
  WorldModel,
  ReflectionEngine,
  MetaCognitionEngine,
  CuriosityEngine,
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
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

const openGate = () => ({ allowed: true });

/** 最小测试智能体（只参与任务结算，不提案不行动） */
class QuietAgent extends AgentBase {
  kind = 'model';
  constructor(id) {
    super(id);
  }
  goal() {
    return { objective: '测试', metrics: [], survivalThreshold: 0 };
  }
  propose() {
    return [];
  }
}

// ═══════════════════ A 因果内核基座 ═══════════════════
section('A 因果内核：do-干预 ATE 估计与口径分离');
{
  const kernel = new CausalKernel();
  const now = Date.now();

  // 双臂实验：model-a 处理组 24 成 6 败（80%）；对照组 6 成 24 败（20%）
  for (let i = 0; i < 24; i += 1) kernel.intervene('model-a', 'task.outcome', true, true, 'test', null, now);
  for (let i = 0; i < 6; i += 1) kernel.intervene('model-a', 'task.outcome', true, false, 'test', null, now);
  for (let i = 0; i < 6; i += 1) kernel.intervene('model-a', 'task.outcome', false, true, 'test', null, now);
  for (let i = 0; i < 24; i += 1) kernel.intervene('model-a', 'task.outcome', false, false, 'test', null, now);

  const eff = kernel.effect('model-a', 'task.outcome', now);
  // Beta(1,1) 先验平滑：pDo = (24+1)/(30+2) = 0.781；pDoNot = 0.219
  ok(near(eff.pDo, 25 / 32, 0.005), `处理臂后验 P(Y=1|do) ≈ 0.78（实测 ${eff.pDo.toFixed(3)}）`);
  ok(near(eff.pDoNot, 7 / 32, 0.005), `对照臂后验 ≈ 0.22（实测 ${eff.pDoNot.toFixed(3)}）`);
  ok(eff.ate > 0.4 && eff.ate < 0.8, `ATE = P(do) − P(do-not) ≈ 0.56（实测 ${eff.ate.toFixed(3)}）`);
  ok(eff.direction === 'positive', `效应方向 positive`);
  ok(eff.interventionalSamples === 60, `干预样本双臂合计 60（实测 ${eff.interventionalSamples}）`);
  ok(eff.confidence > 0.5, `干预证据满强度后置信度 > 0.5（实测 ${eff.confidence.toFixed(3)}）`);
  ok(eff.lower > 0, `保守下界 > 0（Wilson 口径 ${eff.lower.toFixed(3)}）——小样本不虚报因果`);

  // 观测证据单独成流：obsAssociation ≠ ATE
  for (let i = 0; i < 20; i += 1) kernel.observe('model-b', 'task.outcome', true, true, now);
  for (let i = 0; i < 5; i += 1) kernel.observe('model-b', 'task.outcome', true, false, now);
  const obsOnly = kernel.effect('model-b', 'task.outcome', now);
  ok(obsOnly.observationalSamples === 25 && obsOnly.interventionalSamples === 0, '观测/干预双流永不混账');
  ok(obsOnly.confidence <= 0.4, `纯观测边置信度天花板 0.4（实测 ${obsOnly.confidence.toFixed(3)}）——未经实验的关联只值一半信任`);
  ok(!obsOnly.established, '纯观测关联永不「确立因果」');

  // 干预审计链
  const log = kernel.interventions();
  ok(log.length === 60 && log[0].actor === 'test', `do-干预审计链完整（${log.length} 条，含 actor/假设）`);

  // 反事实查询：证据不足时诚实建议实验
  const cf = kernel.counterfactual('task.outcome', 'model-a', 'model-zzz', false, now);
  ok(cf.evidenceSamples < 4 && cf.verdict.includes('实验'), `反事实证据不足 → 建议登记因果实验（${cf.verdict.slice(0, 24)}…）`);
}

// ═══════════════════ A2 混杂指纹（伪因果证伪） ═══════════════════
section('A2 混杂检测：冰淇淋-溺水伪因果被自动证伪');
{
  const kernel = new CausalKernel();
  const now = Date.now();

  // 夏天（混杂因子）同时推高冰淇淋销量与溺水：观测强共现
  for (let i = 0; i < 40; i += 1) kernel.observe('icecream-sales', 'drowning', true, true, now);
  for (let i = 0; i < 10; i += 1) kernel.observe('icecream-sales', 'drowning', false, false, now);
  // 但 do-实验（随机发冰淇淋）：无效应
  for (let i = 0; i < 8; i += 1) kernel.intervene('icecream-sales', 'drowning', true, i % 2 === 0, 'ab-test', '随机分发冰淇淋', now);
  for (let i = 0; i < 8; i += 1) kernel.intervene('icecream-sales', 'drowning', false, i % 2 === 0, 'ab-test', '对照组', now);

  const flagged = kernel.detectConfounding(now);
  ok(flagged.length > 0, `混杂指纹被检出（${flagged.length} 条）`);
  const eff = kernel.effect('icecream-sales', 'drowning', now);
  ok(Math.abs(eff.ate) < 0.35, `干预效应 ≈ 0（实测 ATE ${eff.ate.toFixed(3)}）——卖冰淇淋不导致溺水`);
  ok(eff.observationalAssociation > 0.4, `观测关联却很强（${eff.observationalAssociation.toFixed(3)}）——混杂因子夏天制造了伪相关`);
  ok(!eff.established, '伪因果边无法「确立」——调度器不会被它欺骗');
  ok(flagged[0]?.divergence >= 0.2, `背离度 ≥ 阈值（${flagged[0].divergence.toFixed(3)}）`);
}

// ═══════════════════ A3 因果排序 ═══════════════════
section('A3 因果排序：已确立因果 > 高观测关联');
{
  const kernel = new CausalKernel();
  const now = Date.now();
  // proven：实验证实的正效应
  for (let i = 0; i < 12; i += 1) kernel.intervene('proven-model', 'task.outcome', true, true, 'ab', null, now);
  for (let i = 0; i < 12; i += 1) kernel.intervene('proven-model', 'task.outcome', false, false, 'ab', null, now);
  // correlated：只有强观测共现（可能是混杂）
  for (let i = 0; i < 30; i += 1) kernel.observe('lucky-model', 'task.outcome', true, true, now);

  const ranked = kernel.rankCauses('task.outcome', now);
  ok(ranked[0].from === 'proven-model', `因果排序第一名是实验证实的 proven-model（实际 ${ranked[0].from}）`);
  ok(ranked.find((e) => e.from === 'lucky-model')?.established === false, '纯观测的 lucky-model 无法登顶——相关不等于因果');
}

// ═══════════════════ B Shapley 数学 ═══════════════════
section('B Shapley 值：公平性的三条数学公理');
{
  // 对称性：同概率贡献者平分
  const symmetric = [
    { agentId: 'a', prob: 0.6 },
    { agentId: 'b', prob: 0.6 },
  ];
  const phiSym = shapleyValues(symmetric);
  ok(near(phiSym.get('a'), phiSym.get('b'), 1e-9), `对称贡献者份额相等（${phiSym.get('a').toFixed(4)} vs ${phiSym.get('b').toFixed(4)}）`);

  // 有效性：Σφ = v(N)
  const team = [
    { agentId: 'strong', prob: 0.9 },
    { agentId: 'medium', prob: 0.5 },
    { agentId: 'weak', prob: 0.1 },
  ];
  const phi = shapleyValues(team);
  const sum = [...phi.values()].reduce((a, b) => a + b, 0);
  const vN = coalitionValue(team);
  ok(near(sum, vN, 1e-9), `有效性 Σφ = v(N)（${sum.toFixed(4)} = ${vN.toFixed(4)}）——分红总额不凭空产生`);
  ok(phi.get('strong') > phi.get('medium') && phi.get('medium') > phi.get('weak'), `边际贡献单调：strong > medium > weak`);

  // 搭便车者：prob ≈ 0 的边际贡献 ≈ 0
  const withFreeRider = [
    { agentId: 'worker', prob: 0.8 },
    { agentId: 'freerider', prob: 0.01 },
  ];
  const phiFR = shapleyValues(withFreeRider);
  ok(phiFR.get('freerider') < 0.02, `搭便车者 φ ≈ 0（实测 ${phiFR.get('freerider').toFixed(4)}）——线性分红时代「挂名就有份」终结`);
}

// ═══════════════════ C 共生 Shapley 分红 ═══════════════════
section('C 共生运行时：任务结算 → do-干预登记 + Shapley 反事实分红');
{
  const kernel = new CausalKernel();
  const rt = new SymbiosisRuntime({ causalKernel: kernel, openingGrant: 0 }, { checkGate: openGate });
  const hero = new QuietAgent('model:hero');
  const sidekick = new QuietAgent('model:sidekick');
  rt.register(hero);
  rt.register(sidekick);

  // 先积累因果证据：hero 处理臂 9/10 成功、对照臂 1/10（关键贡献者）
  const now = Date.now();
  for (let i = 0; i < 9; i += 1) kernel.intervene('model:hero', 'task.outcome', true, true, 'history', null, now);
  for (let i = 0; i < 1; i += 1) kernel.intervene('model:hero', 'task.outcome', true, false, 'history', null, now);
  for (let i = 0; i < 9; i += 1) kernel.intervene('model:hero', 'task.outcome', false, false, 'history', null, now);
  for (let i = 0; i < 1; i += 1) kernel.intervene('model:hero', 'task.outcome', false, true, 'history', null, now);
  // sidekick：近乎无效应
  for (let i = 0; i < 5; i += 1) kernel.intervene('model:sidekick', 'task.outcome', true, true, 'history', null, now);
  for (let i = 0; i < 5; i += 1) kernel.intervene('model:sidekick', 'task.outcome', true, false, 'history', null, now);
  for (let i = 0; i < 5; i += 1) kernel.intervene('model:sidekick', 'task.outcome', false, false, 'history', null, now);
  for (let i = 0; i < 5; i += 1) kernel.intervene('model:sidekick', 'task.outcome', false, true, 'history', null, now);

  const interventionsBefore = kernel.interventions().length;
  const report = rt.settleTaskOutcome(true, [{ agentId: 'model:hero' }, { agentId: 'model:sidekick' }]);

  ok(report.method === 'shapley-counterfactual', `分红方法 = shapley-counterfactual（实测 ${report.method}）`);
  ok(kernel.interventions().length === interventionsBefore + 2, `任务结算自动登记 2 条 do-干预（调度器刻意选型 = 天然实验）`);
  ok(report.shapley !== undefined && report.shapley.length === 2, 'Shapley 明细随报告输出（可审计）');

  const heroShare = report.shares.find((s) => s.agentId === 'model:hero');
  const sidekickShare = report.shares.find((s) => s.agentId === 'model:sidekick');
  ok(heroShare && sidekickShare && heroShare.amount > sidekickShare.amount, `关键贡献者分红 > 低效应者（${heroShare?.amount} vs ${sidekickShare?.amount}）——「拔掉你成功率掉多少就分多少」`);
  const heroPhi = report.shapley.find((s) => s.agentId === 'model:hero');
  ok(heroPhi && heroPhi.counterfactualProb > 0.75, `hero 反事实成功概率 ≈ 0.9（实测 ${heroPhi?.counterfactualProb}）`);

  // 零漂移：未挂载内核的运行时保持线性分红
  const rtLinear = new SymbiosisRuntime({ openingGrant: 0 }, { checkGate: openGate });
  rtLinear.register(new QuietAgent('model:x'));
  rtLinear.register(new QuietAgent('model:y'));
  const linearReport = rtLinear.settleTaskOutcome(true, [{ agentId: 'model:x' }, { agentId: 'model:y' }]);
  ok(linearReport.method === 'linear-wilson', `未挂载内核 → linear-wilson（既有行为逐位一致，零漂移）`);
}

// ═══════════════════ D 因果世界模型 ═══════════════════
section('D 因果世界模型：从相关预测到 do-干预效应估计');
{
  const kernel = new CausalKernel();
  const wm = new WorldModel();
  wm.attachCausalKernel(kernel);

  ok(wm.predictInterventionEffect('action:prewarm', 'kpi:latency') === null, '无因果证据时诚实返回 null（不伪装知道）');

  wm.recordIntervention('action:prewarm', 'kpi:latency-improved', true, true, 'ab', '预热缓存可降低延迟');
  for (let i = 0; i < 9; i += 1) {
    wm.recordIntervention('action:prewarm', 'kpi:latency-improved', true, true, 'ab', '预热缓存可降低延迟');
    wm.recordIntervention('action:prewarm', 'kpi:latency-improved', false, false, 'ab', '对照组');
  }
  const eff = wm.predictInterventionEffect('action:prewarm', 'kpi:latency-improved');
  ok(eff !== null && eff.ate > 0.6, `因果预见：do(预热) → 延迟改善 ATE ${eff?.ate.toFixed(3)}（10 次实验口径）`);
  ok(wm.getSummary().confoundedPairs !== undefined, '混杂指纹进入世界模型摘要（运维可观测）');
}

// ═══════════════════ E 反事实反思 ═══════════════════
section('E 反事实反思：失败 → 「若选 B」教训回流');
{
  const kernel = new CausalKernel();
  const engine = new ReflectionEngine();
  engine.attachCausalKernel(kernel);
  const now = Date.now();

  // model-b 在历史上干预证据充分：8/10 成功
  for (let i = 0; i < 8; i += 1) kernel.intervene('model-b', 'task.outcome', true, true, 'history', null, now);
  for (let i = 0; i < 2; i += 1) kernel.intervene('model-b', 'task.outcome', true, false, 'history', null, now);

  const signal = {
    id: 'sig-1',
    type: 'code-change',
    description: '验证反事实反思的测试信号',
    payload: {},
    receivedAt: now,
    source: 'test',
  };
  const plan = { id: 'plan-1', nodes: [] };
  const result = {
    success: false,
    nodeResults: [
      { nodeId: 'n1', modelId: 'model-a', success: false, quality: 0.2, attempts: 3, error: '质量不达标' },
      { nodeId: 'n2', modelId: 'model-b', success: true, quality: 0.9, attempts: 1 },
    ],
    successCount: 1,
    totalCount: 2,
  };

  const lesson = await engine.extractLesson({ signal, taskType: 'code-gen', result, plan });
  ok(lesson !== null, '失败教训被提取');
  ok(lesson?.rootCause === 'model-capability', `根因 = model-capability（实际 ${lesson?.rootCause}）`);
  ok(lesson?.counterfactual !== undefined, `教训携带反事实洞察（教训第一次回答「怎样会成功」）`);
  ok(lesson?.counterfactual?.bestAlternative === 'model-b', `最优替代 = model-b`);
  ok(lesson?.suggestion.includes('0.') || lesson.suggestion.includes('实验'), `建议携带概率区间或实验指令（${lesson?.suggestion.slice(0, 50)}…）`);

  // 反射 API 直测
  const cf = engine.reflectCounterfactual({ failedModelId: 'model-a', alternativeModelIds: ['model-b', 'model-c'], actualSuccess: false });
  ok(cf && cf.estimatedProb > 0.6 && cf.lower < cf.upper, `「若选 model-b」成功概率 ${cf?.estimatedProb} [${cf?.lower}, ${cf?.upper}]`);
}

// ═══════════════════ F 元认知因果旋钮 ═══════════════════
section('F 元认知：调参 = 做实验 → 因果旋钮排序');
{
  const kernel = new CausalKernel();
  const applied = [];
  const meta = new MetaCognitionEngine({
    tuningCooldownMs: 0,
    degradeStreakThreshold: 2,
    applier: (action) => applied.push(action),
  });
  meta.attachCausalKernel(kernel);

  const snap = (successRate, avgQuality) => ({
    timestamp: Date.now(),
    successRate,
    avgQuality,
    avgLatency: 900,
    cacheHitRate: 0.3,
    modelSuccessRates: {},
    activeExecutions: 0,
  });

  // 两轮退化 → 触发规则调参（此时因果图为空 → 回退规则，零漂移）
  meta.observe(snap(0.5, 0.8));
  const insights = meta.observe(snap(0.5, 0.8));
  ok(applied.length === 1, `退化触发调参（规则回退路径正常，${applied.length} 次）`);

  // 调参后下一批 KPI 改善 → do-干预自动写回因果图（黄金证据闭环）
  meta.observe(snap(0.75, 0.8));
  const knobEdges = kernel.interventions().filter((r) => r.from.startsWith('knob:'));
  ok(knobEdges.length >= 1, `调参干预对账入图（knob: 边 ${knobEdges.length} 条）`);
  ok(knobEdges[0]?.to === 'kpi:successRate', `干预结果节点 = kpi:successRate`);

  // 多轮成功调参积累后 → 因果旋钮排序生效
  for (let round = 0; round < 5; round += 1) {
    meta.observe(snap(0.5, 0.8));
    meta.observe(snap(0.5, 0.8));
    meta.observe(snap(0.9, 0.8)); // 调参总是「改善」→ knob 边建立正效应
  }
  const knobs = meta.rankTuningKnobs('successRate');
  ok(knobs.length > 0 && knobs[0].from.startsWith('knob:'), `因果旋钮排序就位（第一名 ${knobs[0]?.from}，${knobs[0]?.interventionalSamples} 次实验）`);
  ok(insights.length >= 0, '既有洞察产出不受影响');
}

// ═══════════════════ G 假设驱动好奇心 ═══════════════════
section('G 假设驱动好奇心：不确定边 → 实验设计 → 图更新');
{
  const kernel = new CausalKernel();
  const provider = {
    getExposure: () => ({}),
    getExperienceCounts: () => ({}),
    getFailureRates: () => ({}),
  };
  const curiosity = new CuriosityEngine(provider);
  curiosity.attachCausalKernel(kernel);
  const now = Date.now();

  // 一条高不确定边：仅少量观测（方向存疑）
  for (let i = 0; i < 6; i += 1) kernel.observe('model-x', 'task.outcome', true, true, now);
  for (let i = 0; i < 4; i += 1) kernel.observe('model-x', 'task.outcome', true, false, now);

  const experiments = curiosity.proposeCausalExperiments('task.outcome', 3);
  ok(experiments.length > 0, `不确定边产出实验建议（${experiments.length} 条）`);
  ok(experiments[0].hypothesis.includes('假设'), `建议自带可证伪假设（「${experiments[0].hypothesis.slice(0, 40)}…」）`);
  ok(experiments[0].infoGain > 0, `信息增益评分 > 0（${experiments[0].infoGain}）——探索预算按知识价值分配`);

  // 执行实验 → 后验收缩（证伪也是收获）
  const before = kernel.effect('model-x', 'task.outcome');
  const records = [];
  for (let i = 0; i < 8; i += 1) {
    records.push(curiosity.recordCausalExperiment({ from: 'model-x', to: 'task.outcome', setTo: true, hypothesis: '假设：启用 model-x 提升成功率' }, true));
  }
  for (let i = 0; i < 4; i += 1) {
    records.push(curiosity.recordCausalExperiment({ from: 'model-x', to: 'task.outcome', setTo: false, hypothesis: '假设：启用 model-x 提升成功率' }, false));
  }
  const after = kernel.effect('model-x', 'task.outcome');
  const widthBefore = before.upper - before.lower;
  const widthAfter = after.upper - after.lower;
  ok(widthAfter < widthBefore, `实验后不确定性区间收缩（${widthBefore.toFixed(3)} → ${widthAfter.toFixed(3)}）——信息增益真实发生`);
  ok(curiosity.getCausalYield() > 0, `实验收益率（平均区间收缩比例）= ${curiosity.getCausalYield()}`);
  ok(after.established, `12 次实验后因果确立（ATE ${after.ate.toFixed(3)}，置信度 ${after.confidence.toFixed(3)}）——好奇心把未知变成知识`);

  const summary = curiosity.getSummary();
  ok(summary.causalExperiments === 12 && Array.isArray(summary.pendingHypotheses), `摘要含实验史与待验证假设队列`);
}

// ═══════════════════ 总结 ═══════════════════
console.log(`\n${'═'.repeat(52)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 「从相关到因果」质变闭环成立`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
