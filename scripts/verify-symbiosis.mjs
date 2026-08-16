/**
 * verify-symbiosis.mjs — 第五阶段「共生进化架构 Phase 1」认知市场闭环离线验证
 * （智能体 + 能量预算 + 知识交易；影子运行，不接管 autonomy-loop 主链路）
 *
 * 数据流（认知经济闭环）：
 *   智能体注册(央行开业注资) → 心跳 tick：生存检查 → 感知分发 → 提案收集
 *   → 监管否决 → 市场撮合(挂单费燃烧/价交叉成交) → 行动授权(预扣→成功燃烧/失败半退)
 *   → 任务结算：央行铸币按 Wilson 信誉加权分红 → 知识使用回报(央行售后分成)
 *   → 低效者饥饿休眠 / 有限救济复活 / 配额耗尽永久退出
 *
 * 全程离线（不依赖 LLM 网络调用 / 定时器），验证断点：
 *
 *   A 账本完整性：开户注资守恒；非法/透支/冻结转账拒绝且状态零变更；
 *     快照篡改（余额/凭证）→ 守恒律与链式哈希校验即刻失败
 *   B 市场机制：挂单费燃烧；重复 refId / 非法要价 / 超申报质量拒绝；
 *     低买不成交、价交叉成交、能量买→卖原子划转；余额不足买单拒绝
 *   C 售后分成与证据校准：成功使用 → 央行向卖方支付分成；失败 → 零分成
 *     且资产证据记失败；申报质量 vs 实测证据可观测（欺骗信号）
 *   D 生态闭环端到端（真实 LongTermMemory + 三智能体 6 轮心跳）：
 *     D1 Memory 挂卖真实记忆模式（置信/频次过滤）→ Optimizer 次轮感知
 *         → 出价 → 成交 → 已购去重（运行时自动 notePurchase）
 *     D2 Evolver 高成本进化：预扣 50 → 成功全额燃烧 → 次轮挂卖策略基因
 *         → 再被购买（「进化→变现→再进化」资本循环闭合）
 *     D3 任务结算：成功铸币按 Wilson 下界加权分红；多次贡献 seed→established
 *         晋级；失败零铸币且信誉下界受压
 *     D4 低成本维护行动成功燃烧（真实遗忘曲线 + 修剪执行）
 *   E 生存法则：败家智能体指数失血 → 饥饿休眠 → 央行救济复活（配额递减）
 *     → 配额耗尽永久休眠；期间生态守恒恒成立
 *   F 监管否决：熔断态下市场+行动类提案一票否决，零成交零燃烧
 *   G 原有功能不受破坏：真实 LongTermMemory upsert/getTop 读写如常、
 *     策略基线工厂如常、生态终态守恒 + 链完整 + 基尼系数 ∈ [0,1]
 *
 * 运行：npm run build && node scripts/verify-symbiosis.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  // 共生层
  EnergyLedger,
  CognitiveMarket,
  SymbiosisRuntime,
  AgentBase,
  MemoryAgent,
  OptimizerAgent,
  EvolverAgent,
  TREASURY,
  // 原有模块（兼容性见证）
  LongTermMemory,
  createBaselinePolicy,
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
function section(name) {
  console.log(`\n■ ${name}`);
}

// ═══════════════════ A 账本完整性 ═══════════════════
section('A 能量账本：守恒律 / 拒绝路径 / 链式防伪');

{
  const ledger = new EnergyLedger({ initialSupply: 1000 });
  ok(ledger.balance(TREASURY) === 1000, '初始供给全额入央行国库');
  ok(ledger.verifyConservation(), '初始态守恒律成立');

  ledger.openAccount('alice');
  ledger.openAccount('bob');
  const r1 = ledger.transfer(TREASURY, 'alice', 100, 'grant');
  ok(r1.ok && ledger.balance('alice') === 100, '转账 alice +100（复式记账：国库 1000→900）');
  ok(ledger.balance(TREASURY) === 900, '国库同步扣减');

  const bad1 = ledger.transfer('alice', 'bob', 0, 'zero');
  const bad2 = ledger.transfer('alice', 'bob', 999, 'overdraft');
  ok(!bad1.ok && bad1.error === 'non-positive-amount', '非正金额转账拒绝');
  ok(!bad2.ok && bad2.error === 'insufficient-funds', '透支转账拒绝');
  ok(ledger.balance('alice') === 100 && ledger.balance('bob') === 0, '拒绝时状态零变更');

  ledger.transfer('alice', 'bob', 30, 'pay');
  ledger.freeze('alice');
  const bad3 = ledger.transfer('alice', 'bob', 1, 'frozen');
  ok(!bad3.ok && bad3.error === 'frozen-account', '冻结账户转账拒绝');

  const mint = ledger.mint('bob', 50, 'task-dividend');
  ok(mint.ok && ledger.minted() === 50, '央行铸币 +50 并显式记账');
  ledger.burn('bob', 20, 'action-cost');
  ok(ledger.burned() === 20 && ledger.circulatingSupply() === 1030, '燃烧退出流通、流通供给口径正确');
  ok(ledger.verifyConservation(), '铸币+燃烧后守恒律仍成立（Σ余额 === 供给+铸币）');
  ok(ledger.verifyChain(), '链式哈希完整');

  // 篡改注入：余额篡改 → 守恒破坏；凭证篡改 → 链断裂
  const snap = ledger.snapshotState();
  const tamperedBalance = structuredClone(snap);
  tamperedBalance.balances[0][1] += 1; // 偷改某账户余额
  ledger.restoreState(tamperedBalance);
  ok(!ledger.verifyConservation(), '快照余额篡改 +1 → 守恒律校验失败');

  const tamperedJournal = structuredClone(snap);
  tamperedJournal.journal[0].amount += 1; // 偷改历史凭证金额
  ledger.restoreState(tamperedJournal);
  ok(!ledger.verifyChain(), '历史凭证篡改 → 链式哈希校验失败（不可抵赖）');
  ledger.restoreState(snap);
  ok(ledger.verifyChain() && ledger.verifyConservation(), '恢复干净快照后校验通过');
}

// ═══════════════════ B 市场机制 ═══════════════════
section('B 认知市场：挂单费 / 撮合 / 激励相容拒绝路径');

const marketLedger = new EnergyLedger({ initialSupply: 5000 });
marketLedger.openAccount('seller');
marketLedger.openAccount('buyer');
marketLedger.openAccount('pauper');
marketLedger.transfer(TREASURY, 'seller', 200, 'grant');
marketLedger.transfer(TREASURY, 'buyer', 200, 'grant');
marketLedger.transfer(TREASURY, 'pauper', 3, 'grant');
const market = new CognitiveMarket(marketLedger, { listingFeeRate: 0.1 });

{
  const bad = market.list({ seller: 'seller', kind: 'pattern', refId: 'x', description: '', ask: 0, claimedQuality: 0.5 });
  ok(!bad.ok && bad.error === 'non-positive-ask', '非正要价拒绝');
  const badQ = market.list({ seller: 'seller', kind: 'pattern', refId: 'x', description: '', ask: 5, claimedQuality: 1.5 });
  ok(!badQ.ok && badQ.error === 'insufficient-quality', '申报质量越界 [0,1] 拒绝');

  const l1 = market.list({ seller: 'seller', kind: 'pattern', refId: 'fp-A', description: '模式A', ask: 10, claimedQuality: 0.9 });
  const fee = Math.ceil(10 * 0.1);
  ok(l1.ok && l1.listingFee === fee, `挂单成功且挂单费 ${fee} 立即燃烧（防垃圾信息）`);
  ok(marketLedger.burned() === fee, '挂单费进入燃烧池（退出流通）');

  const dup = market.list({ seller: 'seller', kind: 'pattern', refId: 'fp-A', description: '重复', ask: 5, claimedQuality: 0.5 });
  ok(!dup.ok && dup.error === 'duplicate-ref', '同 refId 重复挂单拒绝');

  // 低价买单：不成交
  market.placeBid('buyer', l1.assetId, 8);
  ok(market.match().length === 0, '出价低于要价 → 不成交（买单保留）');

  // 价交叉：成交
  market.placeBid('buyer', l1.assetId, 10);
  const trades = market.match();
  ok(trades.length === 1 && trades[0].price === 10, '出价 ≥ 要价 → 价交叉成交');
  ok(marketLedger.balance('buyer') === 190, '买单不预锁资金，成交仅按成交价原子划转（200 - 10）');
  const sellerGot = marketLedger.balance('seller');
  ok(sellerGot === 200 - fee + 10, `能量 buyer → seller 划转（卖方 ${200 - fee} + 10）`);

  // 余额不足买单拒绝
  const poor = market.list({ seller: 'seller', kind: 'pattern', refId: 'fp-B', description: '模式B', ask: 5, claimedQuality: 0.6 });
  const poorBid = market.placeBid('pauper', poor.assetId, 5);
  ok(!poorBid.ok && poorBid.error === 'insufficient-funds', '余额不足买单拒绝（买前校验，杜绝坏账）');
}

// ═══════════════════ C 售后分成与证据校准 ═══════════════════
section('C 售后分成：央行支付 / 证据校准 / 欺骗信号可观测');

{
  const asset = market.listAssets().find((a) => a.refId === 'fp-A');
  const treasuryBefore = marketLedger.balance(TREASURY);
  const sellerBefore = marketLedger.balance('seller');

  const payout1 = market.reportUsage(asset.id, true);
  const royalty = Math.ceil(asset.lastPrice * 0.2);
  ok(payout1 && payout1.amount === royalty, `知识使用成功 → 央行支付售后分成 ${royalty}（非买方支付）`);
  ok(
    marketLedger.balance('seller') === sellerBefore + royalty && marketLedger.balance(TREASURY) === treasuryBefore - royalty,
    '分成由国库铸出，买方报告零成本（激励相容）',
  );

  const ev1 = market.assetEvidence(asset.id);
  ok(Math.abs(ev1.weightedSuccesses - 1) < 0.01 && ev1.weightedFailures === 0, '资产级证据记录成功使用');

  const before = marketLedger.balance('seller');
  const payout2 = market.reportUsage(asset.id, false);
  ok(!payout2 && marketLedger.balance('seller') === before, '使用失败 → 零分成（劣质知识无法产生持续收入）');
  const ev2 = market.assetEvidence(asset.id);
  ok(Math.abs(ev2.weightedFailures - 1) < 0.01, '资产级证据记录失败（申报质量 0.9 的实测校准来源）');
  ok(Math.abs(ev2.claimedQuality - 0.9) < 1e-9, '申报质量 vs 实测证据偏离可观测（质量欺骗信号）');
}

// ═══════════════════ D 生态闭环端到端 ═══════════════════
section('D 认知生态端到端：三智能体 × 6 轮心跳（真实 LongTermMemory）');

const tmpMemPath = path.join(os.tmpdir(), `dsh-verify-symbiosis-${Date.now()}.json`);
const memory = new LongTermMemory(tmpMemPath);
const now = Date.now();
const mkPattern = (fp, summary, confidence, freq) => ({
  fingerprint: fp,
  taskSummary: summary,
  frequency: freq,
  firstSeenAt: now - 86_400_000,
  lastSeenAt: now,
  successfulPlans: [],
  failureRecords: [],
  confidence,
  avgExecutionTime: 1200,
  avgQualityScore: 0.8,
});
memory.upsertPattern(mkPattern('fp-code-0.92', '代码生成高频模式', 0.92, 5));
memory.upsertPattern(mkPattern('fp-translate-0.61', '翻译中频模式', 0.61, 3));
memory.upsertPattern(mkPattern('fp-noise-0.30', '低置信孤例（不应挂卖）', 0.3, 1));

const runtime = new SymbiosisRuntime({ initialSupply: 10_000, openingGrant: 100 });
const memoryAgent = new MemoryAgent('agent-memory', memory, { listingBasePrice: 10 });
const optimizerAgent = new OptimizerAgent('agent-optimizer', { maxBudget: 20, reserveBalance: 30 });
let cycleCalls = 0;
const evolverAgent = new EvolverAgent(
  'agent-evolver',
  async () => {
    cycleCalls += 1;
    return { deployed: true, bestGain: 0.3, policyId: `gene-${cycleCalls}`, summary: '沙盒进化：候选 LCB 胜出并部署' };
  },
  { evolutionCost: 50 },
);
ok(runtime.register(memoryAgent) && runtime.register(optimizerAgent) && runtime.register(evolverAgent), '三智能体注册（开户 + 央行开业注资 100）');
ok(!runtime.register(memoryAgent), '重复注册拒绝');
ok(runtime.ledger.balance('agent-memory') === 100, '开业注资到账');

// ── D2a 第 1 轮：Memory 挂卖真实模式 + Evolver 发起高成本进化 ──
const t1 = await runtime.tick({ taskSuccessRate: 0.8 });
{
  const listed = runtime.market.listingViews();
  ok(listed.length === 2, `Memory 挂卖 2 条高置信模式（0.92/0.61 通过置信≥0.5 且频次≥2 过滤；0.3 孤例被拒）`);
  ok(
    listed.every((l) => l.ask > 0) && listed.some((l) => Math.abs(l.claimedQuality - 0.92) < 1e-9),
    '要价 = 基准价 × 置信度，申报质量来自真实记忆置信度',
  );
  ok(t1.burnedThisTick > 0, `挂单费燃烧 ${t1.burnedThisTick}（信息发布成本）`);
  const grant = t1.grants.find((g) => g.kind === 'evolution');
  ok(grant && grant.success && grant.burned === 50, 'Evolver 进化：预扣 50 → 沙盒成功 → 全额燃烧（最贵行动）');
  ok(cycleCalls === 1, '进化回调真实执行一次');
  ok(evolverAgent.stats().deployCount === 1, '进化产出 1 个策略基因待变现');
  ok(t1.conservationIntact, '第 1 轮后守恒律成立');
}

// ── D1 第 2 轮：Optimizer 感知 → 出价 → 成交；Evolver 挂卖基因 ──
const t2 = await runtime.tick();
{
  ok(t2.trades >= 1, `Optimizer 对模式出价并成交（价交叉撮合 ${t2.trades} 笔）`);
  ok(optimizerAgent.purchases().length === 1, '运行时自动 notePurchase：已购清单更新（买方能力回调）');

  const geneListing = runtime.market.listingViews().find((l) => l.kind === 'policy-gene');
  ok(geneListing && geneListing.seller === 'agent-evolver', 'Evolver 次轮挂卖策略基因（进化→变现）');
  ok(Math.abs(geneListing.claimedQuality - 0.8) < 1e-9, '基因质量 = 0.5 + 增益 0.3 映射');
  ok(t2.conservationIntact, '第 2 轮后守恒律成立');
}

// ── D1' 第 3~4 轮：已购去重 + 基因被购买（资本循环闭合）──
const t3 = await runtime.tick();
const t4 = await runtime.tick();
{
  const purchases = optimizerAgent.purchases();
  const unique = new Set(purchases.map((p) => p.assetId));
  ok(purchases.length === unique.size, '已购资产去重（不为同一知识重复付费）');
  const boughtGene = purchases.find((p) => {
    const asset = runtime.market.getAsset(p.assetId);
    return asset && asset.kind === 'policy-gene';
  });
  ok(!!boughtGene, `策略基因被购买：进化成本 50 → 挂卖收入 ${boughtGene ? boughtGene.price : '?'}（资本循环闭合）`);
  ok(t3.conservationIntact && t4.conservationIntact, '第 3/4 轮守恒律成立');
}

// ── D3 任务结算：铸币分红 + 信誉晋级 ──
{
  const repBefore = memoryAgent.reputation();
  ok(repBefore.tier === 'seed', '新智能体信誉等级 seed（不可自封）');

  const d0 = runtime.settleTaskOutcome(true, [{ agentId: 'agent-memory' }, { agentId: 'agent-optimizer' }]);
  ok(d0.totalDistributed === 40 && d0.shares.length === 2, '任务成功 → 央行铸币 40 全额分红');

  // 失败的统计代价：零铸币
  const df = runtime.settleTaskOutcome(false, [{ agentId: 'agent-memory' }]);
  ok(df.totalDistributed === 0, '任务失败 → 零铸币（但负贡献已入证据）');

  // 多次成功 → Wilson 下界抬升 → established 晋级
  for (let i = 0; i < 6; i += 1) {
    runtime.settleTaskOutcome(true, [{ agentId: 'agent-memory', weight: undefined }]);
  }
  const repAfter = memoryAgent.reputation();
  ok(repAfter.tier === 'established', `8 次贡献（7 成 1 败）→ 晋级 established（有效样本 ${repAfter.effectiveSamples.toFixed(1)}）`);
  ok(repAfter.wilsonLower > 0 && repAfter.wilsonLower < repAfter.posteriorMean, 'Wilson 下界保守于后验均值（小样本不虚高）');
  ok(repAfter.netFlow !== 0, '智能体收支经运行时记账（不可自增）');

  // 权重差异化：高信誉者分得更多
  const dW = runtime.settleTaskOutcome(true, [
    { agentId: 'agent-memory' },
    { agentId: 'agent-evolver', weight: 0.1 },
  ]);
  const mShare = dW.shares.find((s) => s.agentId === 'agent-memory');
  const eShare = dW.shares.find((s) => s.agentId === 'agent-evolver');
  ok(mShare && eShare && mShare.amount > eShare.amount, `Wilson 加权分红：高信誉 ${mShare.amount} > 显式低权重 ${eShare.amount}`);
}

// ── D 知识使用回报：央行售后分成（运行时自动回填）──
{
  const sellerBefore = runtime.ledger.balance('agent-memory');
  const bought = optimizerAgent.purchases()[0];
  runtime.reportAssetUsage(bought.assetId, true);
  const royaltyGain = runtime.ledger.balance('agent-memory') - sellerBefore;
  ok(royaltyGain > 0, `知识被验证有效 → Memory 获央行售后分成 ${royaltyGain}（卖方持续收入）`);
}

// ── D4 低成本维护行动（真实遗忘曲线 + 修剪）──
const t5 = await runtime.tick();
const t6 = await runtime.tick();
{
  const maintenance = [...t5.grants, ...t6.grants].find((g) => g.kind === 'maintenance');
  ok(!!maintenance, `周期性记忆维护在第 5 轮触发（间隔 5，余额充裕才发起）`);
  ok(maintenance && maintenance.success && maintenance.burned === 2, '维护行动：预扣 2 → 成功燃烧（真实 applyForgettingCurve + prune 执行）');
}

// ═══════════════════ E 生存法则 ═══════════════════
section('E 生存法则：饥饿休眠 / 有限救济 / 配额耗尽退出');

{
  const rt = new SymbiosisRuntime({ initialSupply: 5000, openingGrant: 100, reliefAmount: 30, reliefQuota: 2 });

  // 败家智能体：每轮押上 90% 余额的探索行动，必败（失败仅退一半）
  let gambleSeq = 0;
  class GamblerAgent extends AgentBase {
    kind = 'curiosity';
    goal() {
      return { objective: '赌徒探索', metrics: [], survivalThreshold: 60 };
    }
    propose() {
      const p = this.lastPerception;
      if (!p || p.ownBalance < 12) return [];
      const bid = Math.floor(p.ownBalance * 0.9);
      gambleSeq += 1;
      return [{ id: `gamble#${gambleSeq}`, kind: 'exploration', description: '押注探索', bid, ttlTicks: 1 }];
    }
    async execute() {
      return { success: false, valueEstimate: 0, summary: '失败' };
    }
  }
  const gambler = new GamblerAgent('agent-gambler');
  rt.register(gambler);

  const history = [];
  for (let i = 0; i < 10; i += 1) {
    const r = await rt.tick();
    history.push({
      tick: r.tick,
      mode: gambler.mode(),
      balance: rt.ledger.balance('agent-gambler'),
      reliefs: r.reliefs.filter((x) => x.agentId === 'agent-gambler').length,
      dormant: r.dormantAgents.includes('agent-gambler'),
      conservation: r.conservationIntact,
    });
  }

  const wentDormant = history.some((h) => h.mode === 'dormant');
  ok(wentDormant, '连续失败指数失血（100→55→…）→ 余额跌破生存线 60 → 饥饿休眠');
  const reliefCount = history.reduce((a, h) => a + h.reliefs, 0);
  ok(reliefCount > 0 && reliefCount <= 2, `央行救济复活 ${reliefCount} 次（有限配额，防僵尸吸血）`);
  const finalH = history[history.length - 1];
  ok(finalH.mode === 'dormant' && finalH.dormant, '救济配额耗尽 → 永久休眠（不再被感知/调度）');
  ok(history.every((h) => h.conservation), '生存/救济全程守恒律成立');
}

// ═══════════════════ F 监管否决 ═══════════════════
section('F 监管否决：熔断态一票否决（能量经济 × 安全治理统一）');

{
  const gov = { checkGate: () => ({ allowed: false, reason: 'circuit-breaker', blockedBy: 'kill-switch' }) };
  const rt = new SymbiosisRuntime({ openingGrant: 100 }, gov);
  const mem = new MemoryAgent('agent-m2', memory, { listingBasePrice: 10 });
  const opt = new OptimizerAgent('agent-o2', {});
  const evo = new EvolverAgent('agent-e2', async () => ({ deployed: false, bestGain: -0.1, summary: 'x' }), {});
  rt.register(mem);
  rt.register(opt);
  rt.register(evo);
  await rt.tick(); // 第 1 轮：正常（mem 挂单）
  const listingsBefore = rt.market.listingViews().length;

  const blocked = await rt.tick();
  ok(blocked.vetoes.length > 0, `熔断态：${blocked.vetoes.length} 项提案被一票否决（${blocked.vetoes[0].reason}）`);
  ok(blocked.trades === 0 && blocked.burnedThisTick === 0, '否决轮零成交零燃烧（evolution/maintenance 全部拦截）');
  ok(rt.market.listingViews().length === listingsBefore, '熔断期无新挂单（市场类提案同受监管）');
  ok(rt.ledger.balance('agent-e2') === 100, '被否决的进化提案零成本（未预扣即否决）');
}

// ═══════════════════ G 生态健康与原有功能兼容 ═══════════════════
section('G 生态健康观测 + 原有功能不受破坏');

{
  const stats = runtime.stats();
  ok(stats.ledger.chainIntact, '终态链式哈希完整（能量流向可审计回放）');
  ok(stats.ledger.gini >= 0 && stats.ledger.gini <= 1, `基尼系数 ${stats.ledger.gini.toFixed(3)} ∈ [0,1]（垄断预警可观测）`);
  ok(stats.agents.length === 3 && stats.agents.every((a) => a.mode === 'active'), '三智能体全部存活（有效者未被误杀）');
  ok(stats.market.trades >= 2, `累计成交 ${stats.market.trades} 笔（知识市场真实流转）`);
  ok(runtime.ledger.verifyConservation(), '端到端终态守恒律成立');

  // 原有模块兼容性见证（共生层零侵入：只读包装 + 影子心跳）
  const up = memory.upsertPattern(mkPattern('fp-code-0.92', '代码生成高频模式', 0.95, 6));
  ok(up === 'updated', '原 LongTermMemory upsert 语义不变');
  ok(memory.getTopPatterns(1)[0].confidence === 0.95, '原 getTopPatterns 排序不变');
  const policy = createBaselinePolicy();
  ok(policy.origin === 'baseline' && policy.generation === 0, '原策略基线工厂不变');

  fs.rmSync(tmpMemPath, { force: true });
}

// ═══════════════════ H 链锚点回归（journalLimit 裁剪不断链） ═══════════════════
section('H 回归：凭证裁剪后链校验仍完整（chainAnchor 前移）');

{
  const led = new EnergyLedger({ initialSupply: 1000, journalLimit: 10 });
  led.openAccount('a');
  led.openAccount('b');
  led.transfer(TREASURY, 'a', 500, 'grant');
  for (let i = 0; i < 20; i += 1) {
    led.transfer('a', 'b', 1, `stream-${i}`);
  }
  const st = led.stats();
  ok(st.transfers === 10, `凭证已裁剪至 journalLimit（现存 ${st.transfers} 条）`);
  ok(led.verifyChain(), '裁剪后 verifyChain 仍通过（锚点前移到被裁剪者，保留链段连续可验）');
  ok(st.chainIntact, 'stats().chainIntact 不因裁剪永久翻假');
  // 快照往返：锚点随快照持久化，恢复后链校验依旧成立
  const led2 = new EnergyLedger({ initialSupply: 1000, journalLimit: 10 });
  led2.restoreState(led.snapshotState());
  ok(led2.verifyChain(), '快照往返后链校验仍通过（chainAnchor 随快照落盘）');
  // 篡改仍在检测范围内：改一条在链凭证的金额 → 校验失败
  const tampered = led.snapshotState();
  tampered.journal[3].amount += 1;
  const led3 = new EnergyLedger({ initialSupply: 1000, journalLimit: 10 });
  led3.restoreState(tampered);
  ok(!led3.verifyChain(), '保留链段内的历史篡改仍即刻暴露');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n══════════════════════════════════════════');
console.log(`  共生进化 Phase 1 验证：${passed} 通过 / ${failed} 失败`);
console.log('══════════════════════════════════════════');
if (failed > 0) {
  console.error('✗ 认知市场概念验证存在失败断点');
  process.exit(1);
}
console.log('✓ 认知市场概念验证全部通过：智能体 + 能量预算 + 知识交易 在现有架构上闭环运行，原有功能零破坏');
