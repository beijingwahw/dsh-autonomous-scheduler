/**
 * verify-belief-market.mjs — 第五阶段 Phase 2「市场即心智」信念市场闭环离线验证
 * （LMSR 信念资产 + 证据加权下注 + scoring 结算 + futarchy 决策资助 + 元认知对账）
 *
 * 数据流（信念神经系统）：
 *   可度量未来断言上市 → LMSR 做市（价格=隐含概率）→ 持私有信息的智能体
 *   把价格推向自己的估计（信息注入）→ 到期按实现结果 scoring 结算
 *   （赢者从池兑付、亏者血本无归、国库有界补贴）→ futarchy：高成本进化
 *   由市场隐含概率表决资助 → 元认知对账：市场价 vs 被动统计估计的背离
 *   即模型漂移信号。
 *
 * 全程离线（确定性 LMSR 数学 + 测试内构造实现结果），验证断点：
 *
 *   A LMSR 数学核心：初始价 0.5；成本闭式解逐位一致；路径无关（买卖往返
 *     净成本恒 0）；流动性 b 越大价格越稳；价格恒在 (0,1)；极值不溢出
 *   B 信念生命周期：上市→下注→结算兑付；已结算拒交易；取消全额退款；
 *     池记账守恒、国库补贴与盈余扫回
 *   C 信息聚合与套利惩罚（核心质变断言）：知情者把价格推到真实概率；
 *     噪声交易者反复亏损、知情者反复盈利——「信念进化有了牙齿」
 *   D futarchy 决策资助：好信号 → 市场资助进化并按结果结算；坏信号 →
 *     市场否决（进化不执行、注金全额退款）；熔断态 → 监管一票否决
 *   E 元认知对账：市场价 vs 统计估计显著背离被标记（模型漂移信号）；
 *     小背离不告警
 *   F 守恒与回归：全程守恒律与链哈希成立；futarchy 关闭时行为与
 *     Phase 1 完全一致（verify-symbiosis.mjs 另行回归）
 *
 * 运行：npm run build && node scripts/verify-belief-market.mjs
 */

import {
  EnergyLedger,
  BeliefMarket,
  SymbiosisRuntime,
  OptimizerAgent,
  EvolverAgent,
  TREASURY,
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
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
function section(name) {
  console.log(`\n■ ${name}`);
}

/** 独立测试账本 + 三交易者账户 */
function makeFixture(initialSupply = 5000) {
  const ledger = new EnergyLedger({ initialSupply });
  const market = new BeliefMarket(ledger, { defaultB: 10 });
  for (const trader of ['informed', 'noise', 'holder']) {
    ledger.openAccount(trader);
    ledger.transfer(TREASURY, trader, 1000, 'grant');
  }
  return { ledger, market };
}

// ═══════════════════ A LMSR 数学核心 ═══════════════════
section('A LMSR 做市数学：成本闭式解 / 路径无关 / 流动性深度');

{
  const { ledger, market } = makeFixture();
  const created = market.create({ claim: '测试断言', subject: 'test.metric', threshold: 0.5, settleAtTick: 99, creator: 'informed' });
  ok(created.ok, '信念资产上市（开放交易，初始隐含概率 0.5）');
  const assetId = created.assetId;
  ok(near(market.price(assetId), 0.5), 'LMSR 初始价格 = 0.5（对称先验）');

  // 成本闭式解：C(10,0) − C(0,0) = 10·ln(e+1) − 10·ln2
  const buy = market.buyShares('informed', assetId, 'YES', 10);
  ok(buy.ok && near(buy.cost, 10 * Math.log(Math.E + 1) - 10 * Math.LN2, 1e-9), `成本与闭式解逐位一致（10·ln(e+1)−10·ln2 ≈ ${buy.cost.toFixed(6)}）`);
  ok(near(buy.priceAfter, 1 / (1 + Math.exp(-1))), '价格 = sigmoid(1) ≈ 0.7311');
  ok(near(market.price(assetId), buy.priceAfter), '价格查询与成交回执一致');

  // 路径无关：卖回 10 份 → 退款恰等于成本，余额与价格归位
  const sell = market.sellShares('informed', assetId, 'YES', 10);
  ok(sell.ok && near(sell.cost, -buy.cost), '卖回退款 = 买入成本（LMSR 路径无关 → 零摩擦往返）');
  ok(near(ledger.balance('informed'), 1000, 1e-6), '往返净成本为 0（能量分毫不差）');
  ok(near(market.price(assetId), 0.5), '价格归位 0.5');

  // 流动性深度：同份额在更大 b 下价格移动更小
  const deep = market.create({ claim: '深池断言', subject: 'test.deep', threshold: 0.5, settleAtTick: 99, creator: 'informed', liquidityB: 30 });
  market.buyShares('informed', assetId, 'YES', 10);
  market.buyShares('informed', deep.assetId, 'YES', 10);
  ok(market.price(deep.assetId) < market.price(assetId) && market.price(deep.assetId) > 0.5, `b=30 同份额移动更小（${market.price(deep.assetId).toFixed(3)} < ${market.price(assetId).toFixed(3)}）`);

  // 极值稳定：大额下注价格趋于但不触及 1，无 NaN/Inf
  const extreme = market.buyShares('informed', assetId, 'YES', 60);
  ok(extreme.ok && market.price(assetId) > 0.99 && market.price(assetId) < 1, `极值价格趋于 1 不溢出（${market.price(assetId).toFixed(9)}）`);
  ok(ledger.verifyConservation(), 'A 段终态守恒律成立');
}

// ═══════════════════ B 信念生命周期 ═══════════════════
section('B 生命周期：结算兑付 / 拒交易 / 取消退款 / 池记账');

{
  const { ledger, market } = makeFixture();
  const belief = market.create({ claim: '任务成功率 7 日均值 > 0.8', subject: 'task.successRate7d', threshold: 0.8, settleAtTick: 5, creator: 'holder' });
  const id = belief.assetId;

  const yes = market.buyShares('informed', id, 'YES', 10);
  const no = market.buyShares('noise', id, 'NO', 8);
  ok(yes.ok && no.ok, '多空双侧建仓（知情 YES / 噪声 NO）');
  const pool = market.poolBalance();
  ok(near(pool, yes.cost + no.cost), `流动性池精确收集双侧成本（${pool.toFixed(6)}）`);

  const settled = market.settle(id, 0.9); // realized 0.9 > 0.8 → YES
  ok(settled && settled.outcome === true, '结算：realized 0.9 > 阈值 0.8 → YES 兑付');
  const informedGain = ledger.balance('informed') - (1000 - yes.cost);
  ok(near(informedGain, 10), `YES 持有者每份兑付 1（知情者 +10，成本 ${yes.cost.toFixed(3)}）`);
  ok(near(ledger.balance('noise'), 1000 - no.cost), 'NO 持有者血本无归（错误信念的全部代价）');
  const paidTotal = settled.payouts.reduce((a, p) => a + p.amount, 0);
  ok(paidTotal <= settled.subsidyFromTreasury + pool + 1e-6, `赔付 ${paidTotal} ≤ 池 ${pool.toFixed(3)} + 国库补贴 ${settled.subsidyFromTreasury.toFixed(3)}（有界做市义务）`);
  ok(near(market.poolBalance(), 0, 1e-6), '结算后池清零（盈余已扫回国库）');
  ok(ledger.verifyConservation() && ledger.verifyChain(), '结算全程守恒 + 链完整');

  const after = market.buyShares('informed', id, 'YES', 1);
  ok(!after.ok && after.error === 'not-open', '已结算资产拒绝新交易');

  // 取消退款：悬空断言（信号永不出现）
  const dangling = market.create({ claim: '永不出现的信号', subject: 'never.signal', threshold: 0.5, settleAtTick: 3, creator: 'holder' });
  const dBuy = market.buyShares('holder', dangling.assetId, 'YES', 5);
  const balBeforeCancel = ledger.balance('holder');
  const cancel = market.cancel(dangling.assetId);
  ok(cancel && cancel.refunds.length === 1 && near(cancel.refunds[0].amount, dBuy.cost), '取消：净支出全额退款（零损失退出）');
  ok(near(ledger.balance('holder') - balBeforeCancel, dBuy.cost), '退款金额分毫不差');
  ok(near(market.poolBalance(), 0, 1e-6), '取消后池再次清零');
}

// ═══════════════════ C 信息聚合与套利惩罚 ═══════════════════
section('C 信息聚合：知情者定价 / 噪声者被套利（信念进化有了牙齿）');

{
  const { ledger, market } = makeFixture();
  const belief = market.create({ claim: '模型 alpha 下周成功率 > 0.75', subject: 'model.alpha.successRate', threshold: 0.75, settleAtTick: 99, creator: 'holder' });
  const id = belief.assetId;

  // 知情者（私有信息 0.85）把价格推到自己的估计
  const toEstimate = market.buyToPrice('informed', id, 'YES', 0.85, 100);
  ok(toEstimate.ok && near(market.price(id), 0.85, 1e-6), `知情者把市场价格推到真实概率 0.85（信息注入完成）`);

  // 噪声者小额反向下注：价格轻微扰动
  const noiseBet = market.buyToPrice('noise', id, 'NO', 0.6, 5);
  ok(noiseBet.ok && market.price(id) < 0.85, `噪声者扰动价格（0.85 → ${market.price(id).toFixed(3)}）`);

  // 结算 realized=0.9：知情者盈利、噪声者亏损
  market.settle(id, 0.9);
  const informedProfit = ledger.balance('informed') - 1000;
  ok(informedProfit > 3, `知情者净盈利 ${informedProfit.toFixed(3)}（接近真实概率的定价被奖励）`);
  ok(near(ledger.balance('noise'), 995, 1e-6), '噪声者亏光全部 5 注金（错误信念被套利出局）');

  // 反复多轮：财富持续从噪声流向知情（信念进化的牙齿）
  let informedBalance = ledger.balance('informed');
  let noiseBalance = ledger.balance('noise');
  for (let round = 0; round < 5; round += 1) {
    const r = market.create({ claim: `第 ${round} 轮断言`, subject: `demo.round.${round}`, threshold: 0.7, settleAtTick: 99, creator: 'holder' });
    market.buyToPrice('informed', r.assetId, 'YES', 0.85, 60);
    market.buyToPrice('noise', r.assetId, 'NO', 0.6, 5);
    market.settle(r.assetId, 0.9);
  }
  ok(ledger.balance('informed') > informedBalance + 15, `知情者 5 轮再赚 ${((ledger.balance('informed') - informedBalance)).toFixed(2)}（信息优势复利）`);
  ok(near(ledger.balance('noise'), noiseBalance - 25, 1e-6), '噪声者 5 轮再亏 25（持续错误 = 持续失血）');
  ok(ledger.verifyConservation() && ledger.verifyChain(), 'C 段全程守恒 + 链完整');
}

// ═══════════════════ D futarchy 决策资助 ═══════════════════
section('D futarchy：市场表决高成本进化（好信号资助 / 坏信号否决 / 熔断一票否决）');

async function runFutarchyCase({ goodSignals, governorBlocked }) {
  const governor = governorBlocked ? { checkGate: () => ({ allowed: false, reason: 'circuit-breaker' }) } : undefined;
  const runtime = new SymbiosisRuntime(
    { initialSupply: 5000, openingGrant: 100, futarchyEnabled: true, futarchyMinImpliedProb: 0.55, futarchyDecisionB: 6 },
    governor,
  );
  let cycleRuns = 0;
  const evolver = new EvolverAgent(
    'agent-evolver',
    async () => {
      cycleRuns += 1;
      return { deployed: true, bestGain: 0.4, policyId: `gene-${cycleRuns}`, summary: '沙盒进化成功' };
    },
    { evolutionCost: 50 },
  );
  const optimizer = new OptimizerAgent('agent-optimizer', { beliefBetBudget: 8, reserveBalance: 10 });
  runtime.register(evolver);
  runtime.register(optimizer);

  const signals = { taskSuccessRate: goodSignals ? 0.9 : 0.4 };
  const t1 = await runtime.tick(signals); // 提案轮：创建决策资产
  const t2 = await runtime.tick(signals); // 表决轮：下注 → 门槛判定 → 执行/否决 → 结算
  return { runtime, evolver, optimizer, cycleRuns, t1, t2 };
}

{
  // 好信号：市场资助
  const good = await runFutarchyCase({ goodSignals: true, governorBlocked: false });
  const decisionAsset = good.t1.beliefBets.length === 0 ? undefined : undefined;
  ok(good.t1.futarchyDecisions.length === 0, '提案轮不决议（市场需要时间消化）');
  ok(good.t2.futarchyDecisions.length === 1 && good.t2.futarchyDecisions[0].decision === 'funded', `好信号：隐含概率 ${good.t2.futarchyDecisions[0].impliedProb.toFixed(3)} ≥ 0.55 → 市场资助进化`);
  ok(good.cycleRuns === 1, '被资助的进化真实执行一次');
  ok(good.t2.beliefBets.length >= 2, `Optimizer（信号下注）+ Evolver（私有信息自注）双双入场（${good.t2.beliefBets.length} 笔）`);
  const settled = good.t2.beliefSettlements.find((s) => s.mode === 'settled');
  ok(settled && settled.outcome === true && settled.paidOut > 0, `决策资产按执行结果结算（YES 兑付 ${settled.paidOut.toFixed(2)}）`);
  ok(good.t2.conservationIntact, '资助→执行→结算全程守恒');

  // 坏信号：市场否决
  const bad = await runFutarchyCase({ goodSignals: false, governorBlocked: false });
  ok(bad.t2.futarchyDecisions[0].decision === 'market-rejected', `坏信号：隐含概率 ${bad.t2.futarchyDecisions[0].impliedProb.toFixed(3)} < 0.55 → 市场否决`);
  ok(bad.cycleRuns === 0, '被否决的进化一次都没有执行（能量零消耗）');
  const cancelled = bad.t2.beliefSettlements.find((s) => s.mode === 'cancelled');
  ok(cancelled && cancelled.refunded > 0, `否决退款 ${cancelled.refunded.toFixed(3)}（下注者零损失退出）`);
  ok(bad.t2.conservationIntact, '否决路径守恒');

  // 熔断：监管一票否决（安全主权不让渡）
  const blocked = await runFutarchyCase({ goodSignals: true, governorBlocked: true });
  ok(blocked.t2.futarchyDecisions[0].decision === 'governor-vetoed', '熔断态：监管一票否决（kill-switch 高于市场）');
  ok(blocked.cycleRuns === 0 && blocked.t2.grants.length === 0, '熔断轮零执行');
}

// ═══════════════════ E 元认知对账 ═══════════════════
section('E 元认知对账：市场价 vs 被动统计估计（模型漂移信号）');

{
  const runtime = new SymbiosisRuntime({ initialSupply: 5000, openingGrant: 100, divergenceMargin: 0.15 });
  const optimizer = new OptimizerAgent('agent-optimizer', { beliefBetBudget: 20, reserveBalance: 10 });
  runtime.register(optimizer);

  // 人工上市一条远期信念并让市场定价到 0.85
  const belief = runtime.beliefMarket.create({
    claim: '任务成功率 7 日均值 > 0.8',
    subject: 'task.successRate7d',
    threshold: 0.8,
    settleAtTick: 50, // 远期：保持 open 供对账
    creator: 'agent-optimizer',
  });
  runtime.beliefMarket.buyToPrice('agent-optimizer', belief.assetId, 'YES', 0.85, 30);

  const divergent = await runtime.tick({ 'task.successRate7d': 0.9 }, { externalEstimates: { 'task.successRate7d': 0.5 } });
  const flagged = divergent.divergence.find((d) => d.assetId === belief.assetId);
  ok(flagged && near(flagged.marketProb, 0.85, 1e-6) && near(flagged.statEstimate, 0.5), `统计模型 0.5 vs 市场 0.85 → 背离 ${flagged.gap.toFixed(2)} 被标记（漂移信号进入元认知）`);

  const aligned = await runtime.tick({ 'task.successRate7d': 0.9 }, { externalEstimates: { 'task.successRate7d': 0.8 } });
  ok(aligned.divergence.length === 0, '统计估计 0.8 vs 市场 0.85 → 背离 0.05 < 0.15 不告警（防噪声误报）');
  ok(divergent.conservationIntact && aligned.conservationIntact, '对账轮守恒');
}

// ═══════════════════ F 守恒与兼容回归 ═══════════════════
section('F 生态健康：futarchy 关闭时行为与 Phase 1 完全一致');

{
  // futarchy 关闭（默认）：evolution 直接执行，不经信念市场
  const runtime = new SymbiosisRuntime({ initialSupply: 5000, openingGrant: 100 });
  let cycleRuns = 0;
  const evolver = new EvolverAgent(
    'agent-evolver',
    async () => {
      cycleRuns += 1;
      return { deployed: true, bestGain: 0.3, policyId: `gene-${cycleRuns}`, summary: '直连进化' };
    },
    { evolutionCost: 50 },
  );
  runtime.register(evolver);
  const t1 = await runtime.tick({});
  const grant = t1.grants.find((g) => g.kind === 'evolution');
  ok(grant && grant.success, 'futarchy 关闭：进化提案同轮直接执行（Phase 1 行为不变）');
  ok(t1.futarchyDecisions.length === 0 && t1.beliefBets.length === 0, '无 futarchy 决议、无信念下注（零行为漂移）');
  ok(runtime.beliefMarket.snapshot().open === 0, '信念市场空转（影子层不干扰）');
  ok(runtime.ledger.verifyConservation() && runtime.ledger.verifyChain(), 'F 段守恒 + 链完整');
}

// ═══════════════════ G 回归：结算不挪用他资产储备（池隔离） ═══════════════════
section('G 回归：国库枯竭时赔付只消耗本资产储备（无池污染）');

{
  const ledger = new EnergyLedger({ initialSupply: 2000 });
  const market = new BeliefMarket(ledger);
  ledger.openAccount('trader-a');
  ledger.openAccount('trader-b');
  ledger.transfer(TREASURY, 'trader-a', 100, 'fund');
  ledger.transfer(TREASURY, 'trader-b', 100, 'fund');
  // 抽干国库：任何缺口都无补贴可垫，迫使缺口显形
  ledger.transfer(TREASURY, 'trader-b', ledger.balance(TREASURY), 'drain');
  ok(ledger.balance(TREASURY) === 0, '国库余额清零（补贴路径关闭）');

  // 资产 X：单边重仓 YES（LMSR 最坏缺口 b·ln2 ≈ 0.35 > 0）
  const x = market.create({ claim: 'X 缺口资产', subject: 'kpi:x', threshold: 0.5, settleAtTick: 1, creator: 'trader-a', liquidityB: 0.5 });
  const buyX = market.buyShares('trader-a', x.assetId, 'YES', 20);
  ok(buyX.ok, `X 买入成交（成本 ${buyX.cost.toFixed(4)}）`);
  // 资产 Y：大额储备静卧池内（不得被 X 的缺口挪用）
  const y = market.create({ claim: 'Y 储备资产', subject: 'kpi:y', threshold: 0.5, settleAtTick: 9, creator: 'trader-a', liquidityB: 50 });
  market.buyShares('trader-b', y.assetId, 'NO', 20);
  const yVolume = market.view(y.assetId).volume;

  const report = market.settle(x.assetId, 1); // 实测 1 > 0.5 → YES 兑付
  ok(report && report.outcome === true, 'X 按实测兑付 YES');
  ok(report.subsidyFromTreasury === 0, '国库枯竭：零补贴（缺口不得社会化给国库）');
  const paid = report.payouts.reduce((s, p) => s + p.amount, 0);
  const xVolume = market.view(x.assetId).volume;
  ok(paid <= xVolume + 1e-6, `赔付 ${paid.toFixed(4)} ≤ X 自身储备 ${xVolume.toFixed(4)}（赢家按本资产储备等比收缩）`);
  ok(market.view(y.assetId).volume === yVolume, 'Y 的账面储备分文未动');
  ok(market.poolBalance() >= yVolume - 1e-6, `池内完整保留 Y 的储备（${market.poolBalance().toFixed(4)} ≥ ${yVolume.toFixed(4)}）`);
  ok(ledger.verifyConservation(), '缺口场景终态守恒律仍成立');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n══════════════════════════════════════════');
console.log(`  信念市场 Phase 2 验证：${passed} 通过 / ${failed} 失败`);
console.log('══════════════════════════════════════════');
if (failed > 0) {
  console.error('✗ 市场即心智概念验证存在失败断点');
  process.exit(1);
}
console.log('✓ 市场即心智验证全部通过：信念有了价格、错误信念被套利出局、futarchy 资助闭环、元认知对账生效');
