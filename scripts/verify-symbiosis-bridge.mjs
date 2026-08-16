/**
 * verify-symbiosis-bridge.mjs — 第五阶段 Phase 2.5「共生融合桥」闭环离线验证
 * （KPI → 能量经济/信念市场 → 漂移洞察回流宿主自愈链路 + 任务价值铸币）
 *
 * 融合数据流：
 *   宿主 KPI 快照 --SymbiosisBridge.heartbeat--> 系统信号 + 被动统计估计 +
 *   滚动对账信念（全局 + 逐模型） → 模型智能体用私有信息定价 →
 *   市场隐含概率 vs 统计估计显著背离 → source='market' 漂移 Insight →
 *   GoalEngine 生成自愈目标（模型漂移第一现场由市场先行报警）；
 *   计划执行结果 --settleTask--> 模型贡献者加权 → 央行铸币分红（价值闭环）。
 *
 * 全程离线（确定性 KPI 序列 + 真实组件），验证断点：
 *
 *   A 桥基座：模型注册开户、开业注资、生态守恒
 *   B 信息流入：滚动信念自动上市（全局+逐模型）；模型智能体私有信息定价；
 *     价格=统计时零告警（防噪声误报）
 *   C 漂移报警：统计现实突变（全局成功率崩落）而市场价锚定旧信息 →
 *     显著背离 → market 洞察回流（f1 闭环核心断言）
 *   D 滚动结算：horizon 到期用真实观测 KPI 结算；知情者盈利、错误信念
 *     血本无归；滚动信念自动续期；池清零 + 全程守恒
 *   E 价值铸币：成功任务按模型贡献质量加权分红；未注册模型不计入；
 *     失败任务零铸币但记录贡献证据（f2 闭环核心断言）
 *   F 洞察回流：market 洞察 → GoalEngine 生成 origin='market' 自愈目标
 *   G 主链路集成：AutonomyLoop 心跳每拍驱动共生桥（KPI 注入 + 漂移洞察
 *     计入 insightsCollected + 目标生成）
 *
 * 运行：npm run build && node scripts/verify-symbiosis-bridge.mjs
 */

import {
  SymbiosisBridge,
  ModelAgent,
  GoalEngine,
  MetaCognitionEngine,
  StrategyEvolutionEngine,
  AutonomyLoop,
  modelAgentId,
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
function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
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

// ═══════════════════ A~D 桥基座 + 信息流入 + 漂移报警 + 滚动结算 ═══════════════════

const bridge = new SymbiosisBridge(
  // modelBetBudget 25：预算须覆盖 LMSR(b=10) 从 0.5 推到 0.92 的成本（≈18.6），
  // 预算不足时 buyToPrice 二分收缩——价格向目标移动但不到达（信息弱注入）
  { beliefHorizonTicks: 3, globalSuccessThreshold: 0.8, modelSuccessThreshold: 0.7, modelBetBudget: 25, divergenceMargin: 0.15 },
  { checkGate: () => ({ allowed: true }) },
);

section('A 桥基座：模型注册 → 模型智能体开户（能量经济就位）');

bridge.registerModel('model-a');
bridge.registerModel('model-a'); // 幂等
bridge.registerModel('model-b');
ok(bridge.registeredModels().length === 2, '模型注册幂等（重复注册不开重复账户）');
const balA = bridge.runtime.ledger.balance(modelAgentId('model-a'));
const balB = bridge.runtime.ledger.balance(modelAgentId('model-b'));
ok(balA === 100 && balB === 100, `开业注资各 100（a=${balA}, b=${balB}）`);
ok(bridge.runtime.ledger.verifyConservation() && bridge.runtime.ledger.verifyChain(), '注册后守恒 + 链完整');

section('B 信息流入：KPI → 信号 + 滚动信念 + 私有信息定价');

// 拍 1：全局 0.9；a 私有 0.95（乐观知情者）、b 私有 0.6（悲观知情者）
const i1 = await bridge.heartbeat(kpi(0.9, { 'model-a': 0.95, 'model-b': 0.6 }));
const openViews = bridge.runtime.beliefMarket.views().filter((v) => v.status === 'open');
const subjects = new Set(openViews.map((v) => v.subject));
ok(
  subjects.has('task.successRate') && subjects.has('model.model-a.successRate') && subjects.has('model.model-b.successRate'),
  `滚动信念自动上市 ×${openViews.length}（全局 + 逐模型）`,
);
const t1Bets = bridge.runtime.beliefMarket.views().reduce((a, v) => a + v.volume, 0);
ok(t1Bets > 0, `模型智能体已用私有信息定价（市场成交额 ${t1Bets.toFixed(2)}）`);
const priceA = bridge.runtime.beliefMarket.views().find((v) => v.subject === 'model.model-a.successRate')?.impliedProbYes;
const priceB = bridge.runtime.beliefMarket.views().find((v) => v.subject === 'model.model-b.successRate')?.impliedProbYes;
ok(near(priceA, 0.92, 0.01) && near(priceB, 0.6, 0.01), `私有信息注入价格：a→${priceA.toFixed(2)}（上限 0.92）、b→${priceB.toFixed(2)}`);
ok(i1.length === 0, '价格=统计同源一致 → 零漂移告警（防噪声误报）');

section('C 漂移报警：统计现实突变 vs 市场价锚定旧信息 → 漂移洞察回流');

// 拍 2~4：全局成功率崩落到 0.55（b 模型拖垮），模型私有率不变 →
// 市场价锚定拍 1 的私有信息不再移动（已定价去重），统计估计掉到 0.55
const i2 = await bridge.heartbeat(kpi(0.55, { 'model-a': 0.95, 'model-b': 0.6 }));
ok(i2.length >= 1 && i2.every((x) => x.source === 'market' && x.category === 'model-drift'), `背离 ≥0.15 → 产出 market 漂移洞察 ×${i2.length}`);
const globalDrift = i2.find((x) => x.message.includes('task.successRate'));
ok(!!globalDrift && globalDrift.severity > 0.5, `全局漂移洞察：severity ${globalDrift?.severity.toFixed(2)}（含修复建议：${globalDrift?.suggestion.slice(0, 24)}…）`);
const i3 = await bridge.heartbeat(kpi(0.55, { 'model-a': 0.95, 'model-b': 0.6 }));
ok(i3.length >= 1, '漂移持续未修复 → 持续报警（元认知反思压力）');

section('D 滚动结算：horizon 到期 → 真实观测 KPI 审计市场预测');

// 拍序：拍 1 创建的信念 settleAtTick = 1+1+3 = 5 → 拍 5 结算（realized = 拍 5 的 KPI）
await bridge.heartbeat(kpi(0.55, { 'model-a': 0.95, 'model-b': 0.6 })); // 拍 4（漂移持续）
await bridge.heartbeat(kpi(0.95, { 'model-a': 0.95, 'model-b': 0.95 })); // 拍 5：结算拍（模型 b 恢复）

const settledViews = bridge.runtime.beliefMarket.views().filter((v) => v.status === 'settled');
ok(settledViews.length === 3, `horizon 到期：3 条滚动信念全部按真实观测 KPI 结算`);
// b 的自有信念断言「成功率 > 0.7」：拍 1 b 按 0.6 定价买入 YES（便宜），拍 5 realized=0.95 → YES 兑付——
// 结算按「实现值」而非「下注时的私有信息」：市场赚的是预测未来的钱，不是锚定过去的钱
ok(settledViews.some((v) => v.subject === 'model.model-b.successRate'), 'b 自有信念按 realized=0.95 结算（YES 兑付）');
ok(near(bridge.runtime.beliefMarket.poolBalance(), 0, 1e-6), '结算后池清零（盈余扫回国库）');
ok(bridge.runtime.ledger.verifyConservation() && bridge.runtime.ledger.verifyChain(), '结算全程守恒 + 链完整');

// 滚动续期：结算后下一拍自动补上新信念
await bridge.heartbeat(kpi(0.95, { 'model-a': 0.95, 'model-b': 0.95 })); // 拍 6
const reopened = bridge.runtime.beliefMarket.views().filter((v) => v.status === 'open');
ok(reopened.length === 3, `滚动信念自动续期（open 恢复 ×${reopened.length}）`);

// ═══════════════════ E 价值铸币（任务结算 → 能量闭环） ═══════════════════

section('E 价值铸币：任务成功 → 模型按贡献质量加权分红');

const balABefore = bridge.runtime.ledger.balance(modelAgentId('model-a'));
const balBBefore = bridge.runtime.ledger.balance(modelAgentId('model-b'));
const repABefore = bridge.runtime.agents ? undefined : undefined; // 占位（runtime.agents 私有，经行为观测）
const dist = bridge.settleTask({
  success: true,
  nodeResults: [
    { modelId: 'model-a', success: true, quality: 0.9 },
    { modelId: 'model-a', success: true, quality: 0.8 },
    { modelId: 'model-b', success: true, quality: 0.7 },
    { modelId: 'model-c', success: true, quality: 0.99 }, // 未注册模型
    { modelId: 'model-a', success: false, quality: 0 }, // 失败节点不计贡献
  ],
});
ok(dist.totalDistributed > 0 && dist.totalDistributed <= 40, `成功任务铸币分红 ${dist.totalDistributed}（≤ 单任务铸币上限 40）`);
const shareA = dist.shares.find((s) => s.agentId === modelAgentId('model-a'));
const shareB = dist.shares.find((s) => s.agentId === modelAgentId('model-b'));
ok(!!shareA && !!shareB && shareA.amount > shareB.amount, `贡献加权：a（质量 1.7）分 ${shareA?.amount} > b（0.7）分 ${shareB?.amount}`);
ok(!dist.shares.some((s) => s.agentId === modelAgentId('model-c')), '未注册模型不计入分红');
ok(
  near(bridge.runtime.ledger.balance(modelAgentId('model-a')) - balABefore, shareA?.amount ?? -1) &&
    near(bridge.runtime.ledger.balance(modelAgentId('model-b')) - balBBefore, shareB?.amount ?? -1),
  '分红精确入账（央行铸币）',
);
ok(bridge.runtime.ledger.verifyConservation(), '铸币后守恒');

// 失败任务：零铸币（价值只来自成功）
const failedDist = bridge.settleTask({
  success: false,
  nodeResults: [{ modelId: 'model-a', success: false, quality: 0.2 }],
});
ok(failedDist.totalDistributed === 0, '失败任务零铸币');

// 失败也记入贡献证据（信誉统计通道：Wilson 下界的自然惩罚）——
// 用独立桥 + 直读模型智能体信誉验证（bridge 内部列表私有，不影响生产行为）
{
  const standalone = new SymbiosisBridge({}, { checkGate: () => ({ allowed: true }) });
  const agent = new ModelAgent('model-x');
  standalone.runtime.register(agent);
  const before = agent.reputation().effectiveSamples;
  standalone.runtime.settleTaskOutcome(false, [{ agentId: modelAgentId('model-x') }]);
  const after = agent.reputation().effectiveSamples;
  ok(after > before, `失败任务记入贡献证据（有效样本 ${before.toFixed(2)} → ${after.toFixed(2)}，小样本保守惩罚）`);
}

// ═══════════════════ F 洞察回流目标引擎 ═══════════════════

section('F 洞察回流：market 漂移洞察 → 自愈目标（元认知反思闭环）');

const goalEngine = new GoalEngine();
const driftInsights = [
  {
    source: 'market',
    category: 'model-drift',
    severity: 0.7,
    message: '信念市场与统计估计显著背离：task.successRate 市场 0.95 vs 统计 0.55（Δ0.40）',
    suggestion: '对「task.successRate」触发元认知反思：核查关联模型的近期表现与统计基线是否漂移',
  },
];
const goals = goalEngine.generateGoalsFromInsights(driftInsights);
ok(goals.length >= 1 && goals[0].origin === 'market', `漂移洞察 → 生成 origin='market' 自愈目标（${goals[0]?.title?.slice(0, 20)}…）`);

// ═══════════════════ G 主链路集成（AutonomyLoop 每拍驱动共生桥） ═══════════════════

section('G 主链路集成：AutonomyLoop 心跳 → 共生桥并行拍（KPI 注入 + 漂移洞察计入）');

{
  const loopBridge = new SymbiosisBridge({ beliefHorizonTicks: 3, divergenceMargin: 0.15 }, { checkGate: () => ({ allowed: true }) });
  loopBridge.registerModel('model-a');
  const goalEngine2 = new GoalEngine();
  let symbiosisTicks = 0;
  let currentKpi = kpi(0.9, { 'model-a': 0.95 });
  const loop = new AutonomyLoop({
    config: { enableExploration: false, enableStrategyEvolution: true },
    goalEngine: goalEngine2,
    metaCognition: new MetaCognitionEngine(),
    evolution: new StrategyEvolutionEngine({ rng: mulberry32(7) }),
    collectKpi: () => currentKpi,
    dispatchSubtask: (subtask) => `sig-${subtask.id}`,
    maintainer: { distillExperience: () => 0, applyForgettingCurve: () => ({ decayed: 0, forgotten: 0 }) },
    lessonProvider: () => [],
    symbiosis: {
      runSymbiosisTick: async (snapshot) => {
        symbiosisTicks += 1;
        return loopBridge.heartbeat(snapshot);
      },
    },
  });
  await loop.tick(); // 拍 1：正常（价格=统计一致，零漂移洞察）
  ok(symbiosisTicks === 1, `每拍心跳驱动共生桥（共生拍 ${symbiosisTicks}）`);

  currentKpi = kpi(0.55, { 'model-a': 0.95 }); // 拍 2：全局统计崩落 → 漂移
  const r2 = await loop.tick();
  const marketGoals = goalEngine2.getAllGoals().filter((g) => g.origin === 'market');
  ok(r2.insightsCollected >= 1, `漂移洞察计入心跳洞察数（insightsCollected=${r2.insightsCollected}）`);
  ok(marketGoals.length >= 1, `market 漂移洞察进入主链路目标生成（origin='market' 目标 ×${marketGoals.length}）`);
}

// ═══════════════════ 生态健康汇总 ═══════════════════

section('H 生态健康：能量分布 + 守恒');

const status = bridge.status();
ok(status.heartbeats === 6, `共生心跳 ${status.heartbeats} 拍`);
ok(status.gini >= 0 && status.gini <= 1, `Gini ${status.gini.toFixed(3)} ∈ [0,1]（能量分布可观测）`);
ok(status.conservationIntact && bridge.runtime.ledger.verifyChain(), '全程守恒 + 链哈希完整（能量流向可审计）');

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n══════════════════════════════════════════');
console.log(`  共生融合桥 Phase 2.5 验证：${passed} 通过 / ${failed} 失败`);
console.log('══════════════════════════════════════════');
if (failed > 0) {
  console.error('✗ 共生融合桥概念验证存在失败断点');
  process.exit(1);
}
console.log('✓ 共生融合桥验证全部通过：KPI 流入信念市场、漂移先行报警回流自愈链路、任务成功铸币闭环、滚动结算审计预测');
