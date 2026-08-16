/**
 * verify-futarchy.mjs — A 路线「futarchy 进化表决生产接入」闭环离线验证
 *
 * 生产数据流（市场成为高成本进化的唯一资助闸门）：
 *   EvolverAgent（绑定真实进化周期）能量充足 → 提案进化 → 决策资产上市
 *   → 次拍表决：模型健康度定价（多空信号）+ 进化者私有信息自注（skin in
 *   the game）→ 隐含成功概率 ≥ 门槛且监管放行 → 资助执行真实进化周期
 *   （预扣燃烧）→ 决策资产按执行结果结算（诚实定价赚、虚高定价亏）；
 *   否则市场否决（退款）/ 治理一票否决（安全主权不让渡）。
 *   进化贡献者凭部署中的策略基因参与任务分红 → 进化经济自持；
 *   持续亏损的进化者余额跌破门槛 → 进化自动暂停（经济自然选择）。
 *
 * 全程离线（确定性 KPI 序列 + stub 进化周期 + 真实桥/运行时组件）：
 *
 *   A 桥基座：attachEvolver 注册开户 + 幂等 + status().futarchy 就位
 *   B 资助路径：提案轮不决议 → 表决轮模型+进化者定价 → funded →
 *     真实进化执行一次 → 决策资产按执行结果结算 → escrow 燃烧
 *   B2 经济自持：部署策略参与任务分红 → 余额回升过门槛 → 再提案
 *   C 市场否决：进化者自注上限推不满高门槛 → market-rejected →
 *     零执行 + 下注者全额退款
 *   C2 多空对冲：衰败模型悲观信号稀释进化者自注 → 推不过门槛 → 否决
 *   D 监管一票否决：表决轮熔断 → governor-vetoed → 零执行 + 退款
 *   E 自然选择：失败周期持续失血（半退+自注亏）→ 余额跌破门槛 →
 *     进化自动暂停（cycleRuns 冻结）
 *   F 守恒：全程能量守恒 + 链哈希完整
 *   G 主链路集成：AutonomyLoop 心跳驱动共生桥（无直连进化桥）→
 *     进化只经市场表决执行
 *
 * 运行：npm run build && node scripts/verify-futarchy.mjs
 */

import {
  SymbiosisBridge,
  MetaCognitionEngine,
  StrategyEvolutionEngine,
  AutonomyLoop,
  GoalEngine,
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
function section(title) {
  console.log(`\n■ ${title}`);
}

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

const kpi = (successRate, modelRates) => ({
  timestamp: Date.now(),
  successRate,
  avgQuality: 0.8,
  avgLatency: 900,
  cacheHitRate: 0.3,
  modelSuccessRates: modelRates,
  activeExecutions: 0,
});

const FUTARCHY = { enabled: true, minImpliedProb: 0.55, decisionB: 6, evolutionCost: 50, evolutionBalanceThreshold: 60, selfBetBudget: 12 };
const openGate = () => ({ allowed: true });

/** 收集 open 的进化决策资产 */
const openDecisions = (bridge) =>
  bridge.runtime.beliefMarket.views().filter((v) => v.status === 'open' && v.subject.startsWith('evolution:'));

// ═══════════════════ A 桥基座 ═══════════════════

section('A 桥基座：attachEvolver 注册进化智能体（futarchy 生产就位）');

{
  const bridge = new SymbiosisBridge({ futarchy: FUTARCHY }, { checkGate: openGate });
  let cycleRuns = 0;
  const evolver = bridge.attachEvolver(async () => {
    cycleRuns += 1;
    return { deployed: true, bestGain: 0.3, policyId: `gene-${cycleRuns}`, summary: '沙盒进化成功' };
  });
  const again = bridge.attachEvolver(async () => ({ deployed: true, bestGain: 0, summary: 'x' }));
  ok(again === evolver, 'attachEvolver 幂等（一个宿主只有一个进化器）');
  ok(bridge.evolverAgent === evolver, 'evolverAgent 就位（观测通道）');
  const bal = bridge.runtime.ledger.balance('evolver');
  ok(bal === 100, `进化智能体开业注资 100（余额 ${bal}）`);
  const st = bridge.status().futarchy;
  ok(!!st && st.enabled && st.minImpliedProb === 0.55, 'status().futarchy 就位（门槛 0.55 可观测）');
  ok(st.evolver.balance === 100 && st.evolver.cyclesRun === 0, '进化者状态可观测（余额/周期数）');
  ok(bridge.runtime.ledger.verifyConservation(), '注册后守恒');
}

// ═══════════════════ B 资助路径（好信号） ═══════════════════

section('B 资助路径：提案 → 市场表决 → funded → 真实进化执行 → 结果结算');

const good = new SymbiosisBridge({ futarchy: FUTARCHY }, { checkGate: openGate });
good.registerModel('model-a');
good.registerModel('model-b');
let goodRuns = 0;
let goodDeployedPolicyId;
good.attachEvolver(async () => {
  goodRuns += 1;
  goodDeployedPolicyId = `gene-${goodRuns}`;
  return { deployed: true, bestGain: 0.3, policyId: goodDeployedPolicyId, summary: '沙盒进化成功（策略胜出）' };
});

const healthyKpi = kpi(0.9, { 'model-a': 0.9, 'model-b': 0.85 });
await good.heartbeat(healthyKpi); // 拍 1：提案轮
ok(goodRuns === 0, '提案轮零执行（市场需要时间消化）');
const decisions1 = openDecisions(good);
ok(decisions1.length === 1 && decisions1[0].subject.startsWith('evolution:evolver:'), `决策资产上市 ×${decisions1.length}（subject=${decisions1[0]?.subject}）`);
ok(good.lastFutarchyDecisions().length === 0, '提案轮无决议');

await good.heartbeat(healthyKpi); // 拍 2：表决轮（模型健康度定价 + 进化者自注 → 门槛判定 → 执行/结算）
const d2 = good.lastFutarchyDecisions();
ok(d2.length === 1 && d2[0].decision === 'funded', `健康信号：隐含概率 ${d2[0]?.impliedProb.toFixed(3)} ≥ 0.55 → 市场资助进化`);
ok(d2[0].actionSuccess === true, '资助的行动成功（进化产出可部署策略）');
ok(goodRuns === 1, '被资助的真实进化周期恰好执行一次');
const balAfterFund = good.runtime.ledger.balance('evolver');
ok(balAfterFund <= 50 && balAfterFund >= 35, `escrow 成功全额燃烧（余额 100 → ${balAfterFund.toFixed(1)}）`);
const decisionView = good.runtime.beliefMarket.views().find((v) => v.subject.startsWith('evolution:evolver:'));
ok(decisionView?.status === 'settled', '决策资产按执行结果结算（realized=成功 → YES 兑付）');

// 护栏：决议后余额 < 门槛 → 不再自动提案（进化节奏受能量约束）
await good.heartbeat(healthyKpi); // 拍 3：余额 ~50 < 60 → 无新提案
ok(openDecisions(good).length === 0 && goodRuns === 1, '余额 < 门槛 → 不再提案（进化节奏受能量约束）');

// ═══════════════════ B2 经济自持（分红 → 再进化） ═══════════════════

section('B2 经济自持：部署策略参与任务分红 → 余额回门槛 → 再提案');

let geneDeployed = false;
const selfSustain = new SymbiosisBridge({ futarchy: FUTARCHY }, { checkGate: openGate });
selfSustain.registerModel('model-a');
let ssRuns = 0;
selfSustain.attachEvolver(
  async () => {
    ssRuns += 1;
    geneDeployed = true;
    return { deployed: true, bestGain: 0.3, policyId: `gene-${ssRuns}`, summary: '进化成功' };
  },
  { dividendWeight: () => (geneDeployed ? 1.0 : undefined) },
);
await selfSustain.heartbeat(healthyKpi); // 拍 1 提案
await selfSustain.heartbeat(healthyKpi); // 拍 2 资助执行（bal ~50）
const balBeforeDividend = selfSustain.runtime.ledger.balance('evolver');
const dist = selfSustain.settleTask({
  success: true,
  nodeResults: [
    { modelId: 'model-a', success: true, quality: 0.9 },
    { modelId: 'model-a', success: true, quality: 0.8 },
  ],
});
const evoShare = dist.shares.find((s) => s.agentId === 'evolver');
ok(!!evoShare && evoShare.amount > 0, `部署策略分红入账（进化者分 ${evoShare?.amount}）`);
const balAfterDividend = selfSustain.runtime.ledger.balance('evolver');
ok(balAfterDividend === balBeforeDividend + (evoShare?.amount ?? 0), `分红精确入账（${balBeforeDividend.toFixed(1)} → ${balAfterDividend.toFixed(1)}）`);
ok(balAfterDividend >= 60, '分红使余额回门槛之上（进化经济自持）');
await selfSustain.heartbeat(healthyKpi); // 拍 3：余额 ≥ 60 → 新一轮进化提案
ok(openDecisions(selfSustain).length === 1, '自持闭环：分红回血 → 新进化提案自动发起');
ok(selfSustain.runtime.ledger.verifyConservation() && selfSustain.runtime.ledger.verifyChain(), '自持轮守恒 + 链完整');

// ═══════════════════ C 市场否决（结构性门槛） ═══════════════════

section('C 市场否决：自注上限推不满高门槛 → market-rejected');

{
  const bridge = new SymbiosisBridge(
    { futarchy: { ...FUTARCHY, minImpliedProb: 0.95 } },
    { checkGate: openGate },
  );
  bridge.registerModel('model-a');
  let runs = 0;
  bridge.attachEvolver(async () => {
    runs += 1;
    return { deployed: true, bestGain: 0.3, summary: '不应执行' };
  });
  await bridge.heartbeat(healthyKpi); // 拍 1 提案
  await bridge.heartbeat(healthyKpi); // 拍 2 表决：自注上限 0.92 < 0.95
  const d = bridge.lastFutarchyDecisions();
  ok(d.length === 1 && d[0].decision === 'market-rejected', `隐含概率 ${d[0]?.impliedProb.toFixed(3)} < 0.95 → 市场否决`);
  ok(runs === 0, '被否决的进化零执行（能量零消耗）');
  const view = bridge.runtime.beliefMarket.views().find((v) => v.subject.startsWith('evolution:'));
  ok(view?.status === 'cancelled', '否决资产取消（悬空断言零损失退出）');
  const bal = bridge.runtime.ledger.balance('evolver');
  ok(bal >= 99.9, `下注者全额退款（余额 ${bal.toFixed(2)} ≈ 100）`);
}

// ═══════════════════ C2 多空对冲（悲观信号稀释自注） ═══════════════════

section('C2 多空对冲：衰败模型悲观定价稀释进化者自注 → 否决');

{
  const bridge = new SymbiosisBridge(
    { futarchy: { ...FUTARCHY, minImpliedProb: 0.7 } },
    { checkGate: openGate },
  );
  bridge.registerModel('model-a');
  bridge.registerModel('model-b');
  let runs = 0;
  bridge.attachEvolver(async () => {
    runs += 1;
    return { deployed: true, bestGain: 0.3, summary: '不应执行' };
  });
  const decayedKpi = kpi(0.25, { 'model-a': 0.2, 'model-b': 0.25 });
  await bridge.heartbeat(decayedKpi); // 拍 1 提案
  await bridge.heartbeat(decayedKpi); // 拍 2 表决：模型 NO 压价 + 进化者 YES 自注 ~0.6 < 0.7
  const d = bridge.lastFutarchyDecisions();
  ok(d.length === 1 && d[0].decision === 'market-rejected', `模型悲观信号把隐含概率压到 ${d[0]?.impliedProb.toFixed(3)} < 0.7 → 否决`);
  ok(runs === 0, '系统衰败期进化被市场叫停（坏时机不烧钱）');
  ok(bridge.runtime.ledger.verifyConservation(), '对冲否决轮守恒');
}

// ═══════════════════ D 监管一票否决 ═══════════════════

section('D 监管一票否决：表决轮熔断 → governor-vetoed（安全主权不让渡）');

{
  let gateAllowed = true;
  const bridge = new SymbiosisBridge(
    { futarchy: FUTARCHY },
    { checkGate: () => (gateAllowed ? { allowed: true } : { allowed: false, reason: 'circuit-breaker' }) },
  );
  bridge.registerModel('model-a');
  let runs = 0;
  bridge.attachEvolver(async () => {
    runs += 1;
    return { deployed: true, bestGain: 0.3, summary: '不应执行' };
  });
  await bridge.heartbeat(healthyKpi); // 拍 1 提案（监管放行，资产照常上市）
  gateAllowed = false; // 拍 2 熔断
  await bridge.heartbeat(healthyKpi);
  const d = bridge.lastFutarchyDecisions();
  ok(d.length === 1 && d[0].decision === 'governor-vetoed', '熔断态：监管一票否决（kill-switch 高于市场）');
  ok(runs === 0, '熔断轮零执行');
  const view = bridge.runtime.beliefMarket.views().find((v) => v.subject.startsWith('evolution:'));
  ok(view?.status === 'cancelled', '被否决资产取消退款');
  ok(bridge.runtime.ledger.verifyConservation(), '否决轮守恒');
}

// ═══════════════════ E 自然选择（失败经济） ═══════════════════

section('E 自然选择：失败周期持续失血 → 余额跌破门槛 → 进化自动暂停');

{
  const bridge = new SymbiosisBridge({ futarchy: FUTARCHY }, { checkGate: openGate });
  bridge.registerModel('model-a');
  let runs = 0;
  bridge.attachEvolver(async () => {
    runs += 1;
    return { deployed: false, bestGain: -0.5, summary: '沙盒进化失败（无候选过门禁）' };
  });
  for (let i = 0; i < 6; i += 1) await bridge.heartbeat(healthyKpi);
  const funded = bridge
    .status()
    .futarchy.lastDecisions.filter(() => true); // 仅触发展开
  ok(runs === 2, `失败进化恰被执行 2 次后自动暂停（实际 ${runs}）`);
  const bal = bridge.runtime.ledger.balance('evolver');
  ok(bal < 60, `持续失败 → 余额 ${bal.toFixed(1)} < 60 → 不再提案（经济自然选择）`);
  ok(openDecisions(bridge).length === 0, '无在途决策资产（进化暂停）');
  const st = bridge.status().futarchy.evolver;
  ok(st.cyclesRun === 2 && st.deployCount === 0, `状态可观测：周期 ${st.cyclesRun} / 部署 ${st.deployCount}`);
  ok(bridge.runtime.ledger.verifyConservation() && bridge.runtime.ledger.verifyChain(), '失败经济全程守恒 + 链完整');
  void funded;
}

// ═══════════════════ G 主链路集成 ═══════════════════

section('G 主链路集成：AutonomyLoop 心跳驱动（无直连进化桥 → 进化只经市场）');

{
  const bridge = new SymbiosisBridge({ futarchy: FUTARCHY }, { checkGate: openGate });
  bridge.registerModel('model-a');
  let runs = 0;
  bridge.attachEvolver(async () => {
    runs += 1;
    return { deployed: true, bestGain: 0.3, policyId: `gene-${runs}`, summary: '进化成功' };
  });
  const goalEngine = new GoalEngine();
  const loop = new AutonomyLoop({
    config: { enableExploration: false, enableStrategyEvolution: true },
    goalEngine,
    metaCognition: new MetaCognitionEngine(),
    evolution: new StrategyEvolutionEngine({ rng: mulberry32(7) }),
    collectKpi: () => healthyKpi,
    dispatchSubtask: (subtask) => `sig-${subtask.id}`,
    maintainer: { distillExperience: () => 0, applyForgettingCurve: () => ({ decayed: 0, forgotten: 0 }) },
    lessonProvider: () => [],
    // 注意：不注入 policyEvolution（futarchy 模式下直连进化桥让位给市场）
    symbiosis: {
      runSymbiosisTick: async (snapshot) => bridge.heartbeat(snapshot),
    },
  });
  await loop.tick(); // 拍 1：提案
  await loop.tick(); // 拍 2：表决 + 资助执行
  ok(runs === 1, `主链路心跳驱动下进化经市场执行（真实周期 ×${runs}）`);
  const decisions = bridge.lastFutarchyDecisions();
  ok(decisions.length === 0 || decisions[0].decision === 'funded', '心跳内决议正常产出（不破坏主链路洞察流）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n══════════════════════════════════════════');
console.log(`  futarchy 生产接入验证：${passed} 通过 / ${failed} 失败`);
console.log('══════════════════════════════════════════');
if (failed > 0) {
  console.error('✗ futarchy 生产接入存在失败断点');
  process.exit(1);
}
console.log('✓ futarchy 生产接入全部通过：市场成为高成本进化的唯一资助闸门（提案 → 多方表决 → 资助/否决/熔断 → 结果结算 → 分红自持 → 自然选择）');
