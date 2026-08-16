/**
 * verify-metareasoning.mjs — 8.0「元认知心智：理性元推理」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   7.0 深思心智：想不想要深思是**配置**——启用则每个决策全深度搜索，
 *      熟场景也在重新发明轮子，简单决策也在烧算力。
 *   8.0 元认知心智：想多深本身是**决策**——计算即行动，思考有价格：
 *      habit（摊销直答，成本≈0）/ reactive（VOC≈0，一步反应）/
 *      deliberative（任意时搜索，首行动稳定即停，按 nat 计价）。
 *
 * 闭环断言：
 *   A 反应仲裁：证据充分 + 优劣悬殊 → 深思不会改变选择（零搜索）
 *   B 深思仲裁：一步差距暧昧 → 深思接管，成本按节点计价入账
 *   C 任意时停机：诱饵陷阱（首行动在深度 2 翻转、深度 3 收敛）
 *     → 早停于收敛证据，非深度上限的恩赐
 *   D 预算耗尽：思考超支 → 强制停机并诚实标注「未收敛」
 *   E 习惯摊销：深思成功 ×2 → 习惯晋升 → 此后零成本直答 + 节省入账
 *   F 习惯失灵：世界漂移 → 习惯即刻作废 + 元遗憾（不该省的思考）
 *   G 元学习：反应失手 → 门槛自适应收紧（想多深由后果校准）
 *   H 优化器集成：metacognitiveRecommendation 三模式（含缺省零漂移）
 *   I 元认知集成：认知经济 KPI（模式份额归一 / 节省 / 思考价值实测）
 *
 * 运行：npm run build && node scripts/verify-metareasoning.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeliberationEngine,
  LongTermMemory,
  MetaCognitionEngine,
  Optimizer,
  RationalMetareasoner,
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

function seed(engine, state, action, successes, failures, next) {
  for (let i = 0; i < successes; i += 1) engine.observe(state, action, true, next);
  for (let i = 0; i < failures; i += 1) engine.observe(state, action, false);
}

// ═══════════════════ A 反应仲裁 ═══════════════════

section('A 反应仲裁：证据充分 + 优劣悬殊 → VOC ≈ 0');

{
  const d = new DeliberationEngine();
  seed(d, 'clear', 'gold', 19, 1, 'ok');   // p = 20/22 ≈ 0.91
  seed(d, 'clear', 'mud', 10, 10, 'ok');   // p = 11/22 = 0.5
  const m = new RationalMetareasoner(d);

  const r = m.decide('clear', ['gold', 'mud']);
  ok(r.mode === 'reactive', `模式 = reactive（实测 ${r.mode}）`);
  ok(r.actions[0] === 'gold', `直答 gold（一步 EFE 差悬殊）`);
  ok(r.nodesExpanded <= 2, `只算单步（${r.nodesExpanded} 节点，零搜索）`);
  ok(r.costNat < 0.05, `成本 ≈ 0（${r.costNat} nat）`);
  ok(r.rationale.includes('VOC'), `理由：${r.rationale.slice(0, 42)}…`);
}

// ═══════════════════ B 深思仲裁 ═══════════════════

section('B 深思仲裁：一步差距暧昧 → 深思接管 + 成本入账');

{
  const d = new DeliberationEngine();
  seed(d, 'hazy', 'a1', 9, 1, 'mid');   // p = 10/12 = 0.833
  seed(d, 'hazy', 'a2', 6, 4, 'mid');   // p = 7/12 = 0.583（gap ≈ 0.23 < 0.25）
  seed(d, 'mid', 'a1', 9, 1, 'end');
  seed(d, 'mid', 'a2', 9, 1, 'end');
  const m = new RationalMetareasoner(d, { maxDepth: 3 });

  const r = m.decide('hazy', ['a1', 'a2']);
  ok(r.mode === 'deliberative', `模式 = deliberative（实测 ${r.mode}，一步 gap ${r.reactiveGap.toFixed(3)} < 0.25）`);
  ok(r.nodesExpanded > 2, `真实展开搜索（${r.nodesExpanded} 节点）`);
  ok(r.costNat > 0, `思考按 nat 计价（${r.costNat} nat = ${r.nodesExpanded} × 0.01）`);
  ok(r.report !== undefined && r.report.actions.length >= 2, `深思产出多步计划（${r.report.actions.join(' → ')}）`);
}

// ═══════════════════ C 任意时停机 ═══════════════════

section('C 任意时停机：诱饵陷阱（首行动深度 2 翻转、深度 3 收敛）');

{
  // 与 7.0 验证同一陷阱世界：一步贪心选 bait，两步深思改选 slow
  const d = new DeliberationEngine();
  seed(d, 's0', 'bait', 9, 1, 'dead');
  seed(d, 's0', 'slow', 6, 4, 'rich');
  seed(d, 'dead', 'bait', 2, 8, 'dead');
  seed(d, 'dead', 'slow', 2, 8, 'dead');
  seed(d, 'rich', 'bait', 19, 1, 'rich');
  seed(d, 'rich', 'slow', 19, 1, 'rich');
  const m = new RationalMetareasoner(d, { maxDepth: 6 });

  const r = m.decide('s0', ['bait', 'slow']);
  ok(r.mode === 'deliberative' && r.actions[0] === 'slow', `深思接管且首行动 = slow（绕开诱饵）`);
  ok(r.depthStopped === 3, `深度 3 早停（深度 1 选 bait → 深度 2 翻转 slow → 深度 3 确认收敛，实测停于 ${r.depthStopped}）`);
  ok(r.rationale.includes('收敛'), `停机理由 = 收敛证据（${r.rationale.slice(0, 36)}…）`);
  ok(m.cognitiveEconomy().avgDeliberationDepth === 3, `平均深思深度 3 < 上限 6（省一半思考）`);
}

// ═══════════════════ D 预算耗尽 ═══════════════════

section('D 预算耗尽：思考超支 → 强制停机并诚实标注');

{
  const d = new DeliberationEngine();
  seed(d, 'hazy', 'a1', 9, 1, 'mid');
  seed(d, 'hazy', 'a2', 6, 4, 'mid');
  seed(d, 'mid', 'a1', 5, 5, 'end');
  seed(d, 'mid', 'a2', 5, 5, 'end');
  // 天价思考：0.4 nat/节点，预算 0.8 nat → 只够展开 2 个节点（深度 1）
  const m = new RationalMetareasoner(d, { maxDepth: 4, natPerNode: 0.4, budgetNat: 0.8 });

  const r = m.decide('hazy', ['a1', 'a2']);
  ok(r.mode === 'deliberative', `深思接管（一步暧昧）`);
  ok(r.depthStopped === 1, `预算只够深度 1（实测停于 ${r.depthStopped}）`);
  ok(r.rationale.includes('预算耗尽'), `诚实标注：${r.rationale.slice(0, 30)}…`);
}

// ═══════════════════ E 习惯摊销 ═══════════════════

section('E 习惯摊销：深思成功 ×2 → 晋升习惯 → 零成本直答');

{
  const d = new DeliberationEngine();
  seed(d, 's0', 'slow', 6, 4, 'rich');
  seed(d, 'rich', 'bait', 19, 1, 'rich');
  const m = new RationalMetareasoner(d, { habitPromotionSuccesses: 2 });

  const r1 = m.decide('s0', ['slow', 'bait']);
  ok(r1.mode === 'deliberative', `第 1 次：深思（${r1.actions.join(' → ')}）`);
  m.settleDecision(r1.decisionId, true);
  ok(m.allHabits().length === 0, '成功 1 次 < 门槛 2 → 尚未晋升（不轻信）');

  const r2 = m.decide('s0', ['slow', 'bait']);
  ok(r2.mode === 'deliberative', '第 2 次：仍深思（同计划再现）');
  m.settleDecision(r2.decisionId, true);
  ok(m.allHabits().length === 1, `同计划连续成功 ×2 → 习惯晋升（${m.allHabits()[0].actions.join(' → ')}）`);

  const r3 = m.decide('s0', ['slow', 'bait']);
  ok(r3.mode === 'habit', `第 3 次：习惯直答（零搜索，成本 ${r3.costNat} nat）`);
  ok(near(r3.costNat, 0) && r3.nodesExpanded === 0, '习惯 = 摊销推断（查表即答）');
  const kpi = m.cognitiveEconomy();
  ok(kpi.habitSavingsNat > 0, `节省入账（累计省 ${kpi.habitSavingsNat} nat 搜索）`);
  m.settleDecision(r3.decisionId, true);
  ok(m.allHabits()[0].consecutiveSuccesses >= 3, '习惯继续成功 → 信任加深');
}

// ═══════════════════ F 习惯失灵 ═══════════════════

section('F 习惯失灵：世界漂移 → 即刻作废 + 元遗憾');

{
  const d = new DeliberationEngine();
  seed(d, 's0', 'slow', 6, 4, 'rich');
  seed(d, 'rich', 'bait', 19, 1, 'rich');
  const m = new RationalMetareasoner(d, { habitPromotionSuccesses: 2 });

  const r1 = m.decide('s0', ['slow', 'bait']);
  m.settleDecision(r1.decisionId, true);
  const r2 = m.decide('s0', ['slow', 'bait']);
  m.settleDecision(r2.decisionId, true);
  ok(m.allHabits().length === 1, '习惯已晋升');

  // 世界漂移：习惯开始失败
  const r3 = m.decide('s0', ['slow', 'bait']);
  m.settleDecision(r3.decisionId, false);
  const kpi = m.cognitiveEconomy();
  ok(m.allHabits().length === 0, '习惯失手 → 即刻作废（摊销经验不可过期使用）');
  ok(kpi.staleHabitRegrets === 1, `元遗憾入账（本不该省的思考 ×${kpi.staleHabitRegrets}）`);
  ok(kpi.modeSuccessRate.habit === 0, `习惯成功率实测 0（思考的价值由后果校准）`);

  const r4 = m.decide('s0', ['slow', 'bait']);
  ok(r4.mode !== 'habit', `下一决策回到深思/反应（${r4.mode}）`);
}

// ═══════════════════ G 元学习 ═══════════════════

section('G 元学习：反应失手 → 门槛自适应收紧');

{
  const d = new DeliberationEngine();
  seed(d, 'risky', 'lucky', 9, 1, 'r2');   // p = 0.833，与次优 gap 暧昧
  seed(d, 'risky', 'safe', 6, 4, 'r2');    // p = 0.583
  seed(d, 'r2', 'lucky', 5, 5, 'r3');
  seed(d, 'r2', 'safe', 5, 5, 'r3');
  const m = new RationalMetareasoner(d, { decisivenessGap: 0.2, minDecisivenessGap: 0.05 });

  // 构造反应失手：把门槛临时调低让 lucky 走反应路，然后失手
  const m2 = new RationalMetareasoner(d, { decisivenessGap: 0.1, minDecisivenessGap: 0.05, maxDepth: 2 });
  const before = m2.currentDecisivenessGap();
  const r = m2.decide('risky', ['lucky', 'safe']);
  if (r.mode === 'reactive') {
    m2.settleDecision(r.decisionId, false);
    const after = m2.currentDecisivenessGap();
    ok(after < before, `反应失手 → 门槛收紧（${before} → ${after}：下次更早进入深思）`);
    ok(m2.cognitiveEconomy().reactiveFailures === 1, '反应失手计数（本该深思却反应了）');
  } else {
    // gap 0.1 下仍走深思 → 用更悬殊世界重试断言
    seed(d, 'risky2', 'gold', 19, 1, 'r3');
    seed(d, 'risky2', 'mud', 10, 10, 'r3');
    const r2 = m2.decide('risky2', ['gold', 'mud']);
    ok(r2.mode === 'reactive', '悬殊世界走反应');
    const gapBefore = m2.currentDecisivenessGap();
    m2.settleDecision(r2.decisionId, false);
    ok(m2.currentDecisivenessGap() < gapBefore, `失手后收紧（${gapBefore} → ${m2.currentDecisivenessGap()}）`);
  }
  ok(m.cognitiveEconomy().decisions === 0, '两个 reasoner 记账隔离（互不污染）');
}

// ═══════════════════ H 优化器集成 ═══════════════════

section('H 优化器：metacognitiveRecommendation 三模式（缺省零漂移）');

{
  const memPath = path.join(os.tmpdir(), `dsh-verify-meta-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);
  const optimizer = new Optimizer({ memory });

  ok(optimizer.metacognitiveRecommendation('task', ['a', 'b'], 3) === undefined, '未挂载 → 无元认知推荐（零漂移）');

  const d = new DeliberationEngine();
  // 悬殊世界（阶段状态机：task#s0 → task#s1）
  seed(d, 'task#s0', 'gold', 19, 1, 'x');
  seed(d, 'task#s0', 'mud', 10, 10, 'x');
  seed(d, 'task#s1', 'gold', 19, 1, 'x');
  seed(d, 'task#s1', 'mud', 10, 10, 'x');
  const m = new RationalMetareasoner(d, { maxDepth: 3 });
  optimizer.attachMetareasoner(m);

  const reactive = optimizer.metacognitiveRecommendation('task', ['gold', 'mud'], 2);
  ok(reactive.mode === 'reactive' && reactive.actions[0] === 'gold', `悬殊 → 反应（${reactive.actions[0]}，只承诺一步）`);
  m.settleDecision(reactive.decisionId, true);

  // 暧昧世界（trap：#s0 两步后才见分晓；状态推进 = 学到的行动依赖后继）
  const d2 = new DeliberationEngine();
  seed(d2, 'trap#s0', 'bait', 9, 1, 'trap#dead');
  seed(d2, 'trap#s0', 'slow', 6, 4, 'trap#rich');
  seed(d2, 'trap#dead', 'bait', 2, 8, 'trap#dead');
  seed(d2, 'trap#dead', 'slow', 2, 8, 'trap#dead');
  seed(d2, 'trap#rich', 'bait', 19, 1, 'trap#rich');
  seed(d2, 'trap#rich', 'slow', 19, 1, 'trap#rich');
  const m2 = new RationalMetareasoner(d2, { maxDepth: 4 });
  optimizer.attachMetareasoner(m2);
  const deep = optimizer.metacognitiveRecommendation('trap', ['bait', 'slow'], 2);
  ok(deep.mode === 'deliberative' && deep.actions[0] === 'slow', `陷阱 → 深思接管且绕开诱饵（${deep.actions.join(' → ')}）`);
  ok(deep.report.states.includes('trap#rich'), `学到的事后继贯穿想象（${deep.report.states.join(' → ')}）`);
  fs.rmSync(memPath, { force: true });
}

// ═══════════════════ I 元认知集成 ═══════════════════

section('I 元认知：认知经济 KPI（思考的价格与价值统一核算）');

{
  const meta = new MetaCognitionEngine({ applier: () => {} });
  meta.observe({
    timestamp: Date.now(), successRate: 0.85, avgQuality: 0.8, avgLatency: 900,
    cacheHitRate: 0.3, modelSuccessRates: {}, activeExecutions: 0,
  });
  ok(meta.getHealthReport().cognitiveEconomy === undefined, '未挂载 → 无认知经济项（零漂移）');

  const d = new DeliberationEngine();
  seed(d, 's0', 'slow', 6, 4, 'rich');
  seed(d, 'rich', 'bait', 19, 1, 'rich');
  const m = new RationalMetareasoner(d, { habitPromotionSuccesses: 2 });
  meta.attachMetareasoner(m);

  // 决策流：深思×2（成功）→ 晋升 → 习惯×2
  for (let i = 0; i < 2; i += 1) {
    const r = m.decide('s0', ['slow', 'bait']);
    m.settleDecision(r.decisionId, true);
  }
  for (let i = 0; i < 2; i += 1) {
    const r = m.decide('s0', ['slow', 'bait']);
    m.settleDecision(r.decisionId, true);
  }
  const kpi = meta.getHealthReport().cognitiveEconomy;
  ok(kpi.decisions === 4 && kpi.habits === 1, `决策 4 次（深思 2 + 习惯 2），习惯库 1`);
  const shareSum = kpi.modeShare.habit + kpi.modeShare.reactive + kpi.modeShare.deliberative;
  ok(near(shareSum, 1), `模式份额归一（habit ${kpi.modeShare.habit} / reactive ${kpi.modeShare.reactive} / deliberative ${kpi.modeShare.deliberative}）`);
  ok(kpi.habitHitRate === 0.5, `习惯命中率 50%（${kpi.habitHitRate}）`);
  ok(kpi.habitSavingsNat > 0 && kpi.totalSpendNat > 0, `节省与开销并记（省 ${kpi.habitSavingsNat} / 花 ${kpi.totalSpendNat} nat）`);
  ok(kpi.modeSuccessRate.deliberative === 1, `深思成功率实测 100%（思考的价值由后果校准）`);
  ok(kpi.interpretation.length > 0, `解读：${kpi.interpretation.slice(0, 40)}…`);
}

// ═══════════════════ 总结 ═══════════════════
console.log('\n══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 「元认知心智：理性元推理」质变闭环成立`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
