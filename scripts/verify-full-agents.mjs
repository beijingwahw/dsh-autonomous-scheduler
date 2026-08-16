/**
 * verify-full-agents.mjs — D 路线「全智能体接入生产心跳」闭环离线验证
 *
 * 认知分工完全市场化：模型（执行）× 记忆（知识卖方）× 优化器（知识买方 +
 * 信念下注方）× 进化者（futarchy 高成本行动）共存于同一共生心跳——
 * 各自主动提案、付能量、赚分红，能量流向高效智能体。
 *
 * 生产数据流（全部真实组件）：
 *   LongTermMemory 高置信模式 --memory 挂卖--> 认知市场
 *   --optimizer 出价--> 成交（onPurchase 回调宿主）→ 央行按任务成败
 *   支付卖方版税（知识按使用付费）；memory 周期支付能量执行真实维护
 *   （遗忘曲线幂等，与宿主 loop 并行安全）；optimizer 以决策视角参与
 *   信念下注；evolver 经 futarchy 表决资助真实进化周期。
 *
 * 断点：
 *   A 注册基座：attachMemory/attachOptimizer 幂等 + kinds 就位 + 开业注资
 *   B 知识交易闭环：真实模式挂卖 → optimizer 购入 → onPurchase 回调 →
 *     卖方余额入账（成交价）
 *   C 版税闭环：任务成功结算 → 央行向卖方支付版税（royalty 凭证）→
 *     「沉淀知识 → 成交 → 被使用 → 持续变现」
 *   D 维护经济：到期支付能量执行真实遗忘曲线（action 凭证 + 余额下降）
 *   E 多方信念市场：optimizer 与模型同时下注（belief-buy 多账户）
 *   F 生产共存：models + memory + optimizer + evolver 全员心跳，
 *     futarchy 决议照常 + economicSignals 仍只含模型 + 守恒
 *   G 零漂移：不 attach 时仅模型注册（既有行为不变）
 *
 * 运行：npm run build && node scripts/verify-full-agents.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LongTermMemory,
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

const openGate = () => ({ allowed: true });
const kpi = (successRate, modelRates = {}) => ({
  timestamp: Date.now(),
  successRate,
  avgQuality: 0.8,
  avgLatency: 900,
  cacheHitRate: 0.3,
  modelSuccessRates: modelRates,
  activeExecutions: 0,
});

/** 真实长期记忆 + 高置信模式（memory 智能体的真实货源） */
const makeMemory = (tag) => {
  const p = path.join(os.tmpdir(), `dsh-full-agents-${tag}-${Date.now()}.json`);
  const memory = new LongTermMemory(p);
  const now = Date.now();
  memory.upsertPattern({
    fingerprint: 'fp-code-0.92',
    taskSummary: '代码生成高频模式',
    frequency: 5,
    firstSeenAt: now - 86_400_000,
    lastSeenAt: now,
    successfulPlans: [],
    failureRecords: [],
    confidence: 0.92,
    avgExecutionTime: 1200,
    avgQualityScore: 0.8,
  });
  memory.upsertPattern({
    fingerprint: 'fp-translate-0.61',
    taskSummary: '翻译中频模式',
    frequency: 3,
    firstSeenAt: now - 86_400_000,
    lastSeenAt: now,
    successfulPlans: [],
    failureRecords: [],
    confidence: 0.61,
    avgExecutionTime: 900,
    avgQualityScore: 0.75,
  });
  return { memory, file: p };
};

const dispose = (memory, file) => {
  memory.dispose();
  fs.rmSync(file, { force: true });
  fs.rmSync(file.replace(/\.json$/, '.db'), { force: true });
};

const journalOf = (bridge) => bridge.runtime.ledger.audit(bridge.runtime.ledger.stats().transfers);

// ═══════════════════ A 注册基座 ═══════════════════

section('A 注册基座：attachMemory / attachOptimizer（幂等 + kinds + 注资）');

const { memory, file } = makeMemory('main');
const purchases = [];
const bridge = new SymbiosisBridge({}, { checkGate: openGate });
bridge.registerModel('model-a');
const memAgent = bridge.attachMemory(memory, { maintenanceInterval: 3 });
const memAgain = bridge.attachMemory(memory);
const optAgent = bridge.attachOptimizer({
  onPurchase: (assetId, refId, price) => purchases.push({ assetId, refId, price }),
  config: { maxBudget: 20, reserveBalance: 30 },
});
const optAgain = bridge.attachOptimizer({});
ok(memAgain === memAgent && optAgain === optAgent, 'attachMemory/attachOptimizer 幂等（重复调用返回既有实例）');
ok(bridge.memoryAgent === memAgent && bridge.optimizerAgent === optAgent, 'getter 观测通道就位');
const kinds = bridge.runtime.stats().agents.map((a) => a.kind).sort();
ok(JSON.stringify(kinds) === JSON.stringify(['memory', 'model', 'optimizer']), `kinds 就位（${kinds.join('/')}）`);
ok(bridge.runtime.ledger.balance('memory') === 100 && bridge.runtime.ledger.balance('optimizer') === 100, 'memory/optimizer 开业注资 100');
ok(bridge.runtime.ledger.verifyConservation(), '注册后守恒');

// ═══════════════════ B 知识交易闭环 ═══════════════════

section('B 知识交易闭环：真实模式挂卖 → optimizer 购入 → 成交入账');

const balMemBefore = bridge.runtime.ledger.balance('memory');
await bridge.heartbeat(kpi(0.85, { 'model-a': 0.85 })); // 拍 1：memory 挂卖
await bridge.heartbeat(kpi(0.85, { 'model-a': 0.85 })); // 拍 2：optimizer 观察行情出价
await bridge.heartbeat(kpi(0.85, { 'model-a': 0.85 })); // 拍 3：撮合窗口
const trades = journalOf(bridge).filter((t) => t.reason === 'market-trade');
ok(trades.length > 0, `知识成交 ×${trades.length}（真实 LongTermMemory 模式 → 认知市场）`);
ok(purchases.length === trades.length, `onPurchase 回调逐笔触发（×${purchases.length}，宿主广播桥接点就位）`);
ok(purchases.every((p) => p.refId === 'fp-code-0.92' || p.refId === 'fp-translate-0.61'), '成交标的来自真实记忆模式（fp-* 指纹）');
const tradeIn = trades.filter((t) => t.to === 'memory').reduce((a, t) => a + t.amount, 0);
const memOutflow = journalOf(bridge)
  .filter((t) => t.from === 'memory')
  .reduce((a, t) => a + t.amount, 0);
const balMemAfterTrade = bridge.runtime.ledger.balance('memory');
ok(
  Math.abs(balMemBefore + tradeIn - memOutflow - balMemAfterTrade) < 1e-6,
  `卖方收支精确入账（${balMemBefore.toFixed(1)} + 成交${tradeIn.toFixed(1)} − 成本${memOutflow.toFixed(1)} = ${balMemAfterTrade.toFixed(1)}：挂卖费/维护全计价）`,
);
ok(balMemAfterTrade > balMemBefore, `知识交易净盈利（${balMemBefore.toFixed(1)} → ${balMemAfterTrade.toFixed(1)}，卖知识是可持续经济来源）`);
ok(bridge.optimizerAgent.purchases().length === purchases.length, 'optimizer 已购清单可观测');

// ═══════════════════ C 版税闭环 ═══════════════════

section('C 版税闭环：任务成功 → 央行按使用支付卖方版税');

const balMemPreSettle = bridge.runtime.ledger.balance('memory');
bridge.settleTask({
  success: true,
  nodeResults: [{ modelId: 'model-a', success: true, quality: 0.9 }],
});
const royalties = journalOf(bridge).filter((t) => t.reason === 'royalty');
ok(royalties.length > 0, `版税凭证 ×${royalties.length}（央行国库 → 卖方）`);
ok(royalties.every((t) => t.from === 'treasury' && t.to === 'memory'), '版税方向正确（国库 → memory）');
const royaltySum = royalties.reduce((a, t) => a + t.amount, 0);
const balMemPostSettle = bridge.runtime.ledger.balance('memory');
ok(balMemPostSettle > balMemPreSettle, `「知识被使用 → 持续变现」：memory ${balMemPreSettle.toFixed(1)} → ${balMemPostSettle.toFixed(1)}（版税 ${royaltySum}）`);

// 失败任务：不付版税（使用证据记败，定价校准）
const royaltyCountBefore = journalOf(bridge).filter((t) => t.reason === 'royalty').length;
bridge.settleTask({
  success: false,
  nodeResults: [{ modelId: 'model-a', success: false, quality: 0.2 }],
});
const royaltyCountAfter = journalOf(bridge).filter((t) => t.reason === 'royalty').length;
ok(royaltyCountAfter === royaltyCountBefore, '失败任务不付版税（知识按真实使用付费，非按时间白给）');
ok(bridge.runtime.ledger.verifyConservation(), '版税轮守恒');

// ═══════════════════ D 维护经济 ═══════════════════

section('D 维护经济：到期支付能量执行真实遗忘曲线');

{
  // maintenanceInterval=3：再心跳到维护到期（拍 4/5/6），观察 action 凭证
  const balBeforeMaint = bridge.runtime.ledger.balance('memory');
  for (let i = 0; i < 4; i += 1) await bridge.heartbeat(kpi(0.85, { 'model-a': 0.85 }));
  const memActions = journalOf(bridge).filter((t) => (t.reason === 'action-escrow' || t.reason === 'action-cost') && (t.from === 'memory' || t.to === 'burn'));
  ok(memActions.length > 0, `memory 维护行动进入行动经济（凭证 ×${memActions.length}：预扣/燃烧）`);
  ok(bridge.runtime.ledger.balance('memory') < balBeforeMaint + 1e-9, `维护支付能量（余额 ${balBeforeMaint.toFixed(1)} → ${bridge.runtime.ledger.balance('memory').toFixed(1)}）`);
  // 遗忘曲线幂等：真实记忆上多次 apply 不复合（lastDecayAt 基准）
  const r1 = memory.applyForgettingCurve();
  const r2 = memory.applyForgettingCurve();
  ok(r2.decayed === 0, `遗忘曲线幂等（连续第二次 apply 衰减 0 条，与宿主 loop 维护并行安全）`);
  ok(bridge.runtime.ledger.verifyConservation(), '维护轮守恒');
}

// ═══════════════════ E 多方信念市场 ═══════════════════

section('E 多方信念市场：optimizer 与模型同时下注');

{
  const beliefBuys = journalOf(bridge).filter((t) => t.reason === 'belief-buy');
  const bettors = new Set(beliefBuys.map((t) => t.from));
  ok(beliefBuys.length > 0, `信念下注凭证 ×${beliefBuys.length}`);
  ok(bettors.has('optimizer'), 'optimizer 以决策视角参与信念市场');
  ok(bettors.has('model:model-a'), '模型智能体同步下注（多方定价，非独角戏）');
  ok([...bettors].length >= 2, `多账户同场（${[...bettors].join(', ')}）`);
  ok(bridge.runtime.ledger.verifyConservation(), '信念轮守恒');
}

// ═══════════════════ F 生产共存 ═══════════════════

section('F 生产共存：models + memory + optimizer + evolver 全员心跳');

{
  const { memory: mem2, file: file2 } = makeMemory('coexist');
  const b2 = new SymbiosisBridge(
    { futarchy: { enabled: true, minImpliedProb: 0.55 } },
    { checkGate: openGate },
  );
  b2.registerModel('model-a');
  b2.registerModel('model-b');
  b2.attachMemory(mem2);
  let cycles = 0;
  b2.attachEvolver(async () => {
    cycles += 1;
    return { deployed: true, bestGain: 0.3, policyId: `gene-${cycles}`, summary: '进化成功' };
  });
  const purchases2 = [];
  b2.attachOptimizer({ onPurchase: (a, r, p) => purchases2.push({ a, r, p }) });

  const healthy = kpi(0.9, { 'model-a': 0.9, 'model-b': 0.88 });
  await b2.heartbeat(healthy); // 拍 1：挂卖 + 进化提案 + 决策资产上市
  await b2.heartbeat(healthy); // 拍 2：成交 + 表决 + 资助进化
  b2.settleTask({
    success: true,
    nodeResults: [
      { modelId: 'model-a', success: true, quality: 0.9 },
      { modelId: 'model-b', success: true, quality: 0.85 },
    ],
  });

  const allKinds = b2.runtime.stats().agents.map((a) => a.kind).sort();
  ok(JSON.stringify(allKinds) === JSON.stringify(['evolver', 'memory', 'model', 'model', 'optimizer']), `四类智能体同场（${allKinds.join('/')}）`);
  const fut = b2.lastFutarchyDecisions();
  ok(fut.length === 1 && fut[0].decision === 'funded', `futarchy 决议照常（funded，隐含概率 ${fut[0]?.impliedProb.toFixed(2)}）`);
  ok(cycles === 1, '被资助进化周期恰执行一次');
  ok(purchases2.length > 0, '知识交易与 futarchy 并行不互扰');
  const sig = b2.economicSignals();
  ok(sig.size === 2 && [...sig.keys()].every((k) => k === 'model-a' || k === 'model-b'), 'economicSignals 仍只含模型（调度反哺边界清晰）');
  ok(b2.runtime.ledger.verifyConservation() && b2.runtime.ledger.verifyChain(), '全员心跳守恒 + 链完整');

  // Sankey 可观测四类渠道
  const sankey = b2.sankey();
  const groups = new Set(sankey.links.map((l) => l.group));
  ok(['distribution', 'mint', 'market', 'belief', 'action'].every((g) => groups.has(g)), 'Sankey 五大渠道组全激活（D 路线全景可观测）');
  dispose(mem2, file2);
}

// ═══════════════════ G 零漂移 ═══════════════════

section('G 零漂移：不 attach 时仅模型注册（既有行为不变）');

{
  const b3 = new SymbiosisBridge({}, { checkGate: openGate });
  b3.registerModel('model-a');
  const kinds3 = b3.runtime.stats().agents.map((a) => a.kind);
  ok(JSON.stringify(kinds3) === JSON.stringify(['model']), `仅模型智能体（${kinds3.join(',')}）`);
  ok(b3.memoryAgent === undefined && b3.optimizerAgent === undefined && b3.evolverAgent === undefined, '无 memory/optimizer/evolver 实例');
}

// ─────────────────────────── 汇总 ───────────────────────────
dispose(memory, file);
console.log('\n══════════════════════════════════════════');
console.log(`  全智能体接入验证：${passed} 通过 / ${failed} 失败`);
console.log('══════════════════════════════════════════');
if (failed > 0) {
  console.error('✗ 全智能体接入存在失败断点');
  process.exit(1);
}
console.log('✓ 全智能体接入全部通过：认知分工完全市场化（记忆卖知识 / 优化器买知识+下注 / 模型执行+定价 / 进化者经市场表决进化）');
