/**
 * verify-observability.mjs — C 路线「生态可观测性：能量 Sankey」闭环离线验证
 *
 * 链式账本凭证 → buildEnergySankey（(from,to,reason) 聚合 + 分层节点 +
 * 渠道汇总 + 健康快照）→ renderSankeyHtml（自包含 SVG 分层流量图，
 * 缎带宽度 ∝ 金额、渠道组着色、悬停明细）。
 *
 * 场景：真实 LongTermMemory + SymbiosisRuntime（futarchy 开启）× 三智能体
 * （Memory 挂卖 / Optimizer 下注+买入 / Evolver 进化表决），覆盖全部五大
 * 渠道组：分发/铸币/知识市场/信念市场/行动经济。
 *
 * 断点：
 *   A 渠道完备：五大渠道组至少一条链接出现（真实场景驱动，非手工伪造）
 *   B 聚合正确：链接金额/笔数与 journal 手工重算逐位一致
 *   C 节点守恒：每账户 inflow−outflow 与余额差恒等（国库含期初供给）
 *   D 健康快照：守恒 ✓ / 链哈希 ✓ / 基尼 ∈ [0,1] / 铸币>0 / 燃烧>0
 *   E 增量窗口：sinceSeq 截窗后链接子集、金额不增
 *   F HTML 自包含：doctype + svg + 渠道中文标签 + 内部账户名 + 零外部引用
 *   G 桥接集成：SymbiosisBridge.sankey()/sankeyHtml() 带智能体 kind 标注，
 *     HTML 落盘可读
 *   H 分层合法：铸币源 0 / 国库 1 / 智能体 2 / 池 3 / 燃烧池 4
 *
 * 运行：npm run build && node scripts/verify-observability.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LongTermMemory,
  SymbiosisRuntime,
  SymbiosisBridge,
  MemoryAgent,
  OptimizerAgent,
  EvolverAgent,
  buildEnergySankey,
  renderSankeyHtml,
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

// ═══════════════════ 场景驱动：丰富生态（五大渠道组全激活） ═══════════════════

section('场景：三智能体 × futarchy × 知识市场 × 任务分红（真实组件）');

const tmpMemPath = path.join(os.tmpdir(), `dsh-verify-observability-${Date.now()}.json`);
const memory = new LongTermMemory(tmpMemPath);
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

const runtime = new SymbiosisRuntime({
  initialSupply: 10_000,
  openingGrant: 100,
  futarchyEnabled: true,
  futarchyMinImpliedProb: 0.55,
  futarchyDecisionB: 6,
});
const memoryAgent = new MemoryAgent('agent-memory', memory, { listingBasePrice: 10 });
const optimizerAgent = new OptimizerAgent('agent-optimizer', { maxBudget: 25, reserveBalance: 30 });
let cycleCalls = 0;
const evolverAgent = new EvolverAgent(
  'agent-evolver',
  async () => {
    cycleCalls += 1;
    return { deployed: true, bestGain: 0.3, policyId: `gene-${cycleCalls}`, summary: '沙盒进化成功' };
  },
  { evolutionCost: 50 },
);
runtime.register(memoryAgent);
runtime.register(optimizerAgent);
runtime.register(evolverAgent);

await runtime.tick({ taskSuccessRate: 0.8 }); // 拍 1：挂卖 + 信念上市 + 决策资产
await runtime.tick({ taskSuccessRate: 0.8 }); // 拍 2：Optimizer 买入 + 下注 + futarchy 表决资助进化
runtime.settleTaskOutcome(true, [
  { agentId: 'agent-memory', weight: 1 },
  { agentId: 'agent-optimizer', weight: 0.8 },
]); // 任务分红 + 版税（央行支付）
await runtime.tick({ taskSuccessRate: 0.85 }); // 拍 3：信念滚动结算
await runtime.tick({ taskSuccessRate: 0.85 }); // 拍 4

const journal = runtime.ledger.audit(runtime.ledger.stats().transfers);
console.log(`  （场景产出 ${journal.length} 笔流转，进化周期 ×${cycleCalls}）`);

// ═══════════════════ A 渠道完备 ═══════════════════

section('A 渠道完备：五大渠道组全激活（Sankey 分组着色依据）');

const report = buildEnergySankey(runtime.ledger, {
  agents: runtime.stats().agents.map((a) => ({ id: a.id, kind: a.kind })),
});
const groups = new Set(report.links.map((l) => l.group));
for (const g of ['distribution', 'mint', 'market', 'belief', 'action']) {
  ok(groups.has(g), `渠道组 ${g} 有真实流量（${report.links.filter((l) => l.group === g).length} 条链接）`);
}

// ═══════════════════ B 聚合正确 ═══════════════════

section('B 聚合正确：链接金额/笔数与 journal 手工重算逐位一致');

{
  // 手工重算：按 (from,to,reason) 分组，与链接逐条比对（金额 + 笔数）
  const manual = new Map();
  for (const t of journal) {
    const key = `${t.from}|${t.to}|${t.reason}`;
    const cur = manual.get(key) ?? { from: t.from, to: t.to, reason: t.reason, amount: 0, count: 0 };
    cur.amount += t.amount;
    cur.count += 1;
    manual.set(key, cur);
  }
  ok(manual.size === report.links.length, `链接数与手工分组一致（${report.links.length} 条）`);
  let allMatch = true;
  for (const l of report.links) {
    const m = manual.get(`${l.source}|${l.target}|${l.channel}`);
    if (!m || Math.abs(m.amount - l.amount) > 1e-9 || m.count !== l.count) allMatch = false;
  }
  ok(allMatch, '全部链接的金额/笔数与 journal 手工重算逐位一致');

  // market-trade 抽查展示
  const trades = journal.filter((t) => t.reason === 'market-trade');
  const tradeLinks = report.links.filter((l) => l.channel === 'market-trade');
  const tradeSum = tradeLinks.reduce((a, l) => a + l.amount, 0);
  ok(trades.length > 0 && Math.abs(tradeSum - trades.reduce((a, t) => a + t.amount, 0)) < 1e-9,
    `market-trade 聚合一致（${trades.length} 笔 / ${tradeSum.toFixed(1)} 能量）`);

  // 全链接守恒：Σ(各渠道金额) = Σ(journal 金额)
  const journalTotal = journal.reduce((a, t) => a + t.amount, 0);
  const channelTotal = report.channels.reduce((a, c) => a + c.amount, 0);
  ok(Math.abs(journalTotal - channelTotal) < 1e-6, `渠道总金额恒等（journal ${journalTotal.toFixed(2)} = channels ${channelTotal.toFixed(2)}）`);

  // 渠道排序：金额降序
  const sorted = report.channels.every((c, i) => i === 0 || report.channels[i - 1].amount >= c.amount);
  ok(sorted, '渠道汇总按金额降序（阅读优先级）');
}

// ═══════════════════ C 节点守恒 ═══════════════════

section('C 节点守恒：inflow − outflow 与余额差逐账户恒等');

{
  const nodeById = new Map(report.nodes.map((n) => [n.id, n]));
  let allConsistent = true;
  for (const [id, bal] of runtime.ledger.snapshotState().balances) {
    const n = nodeById.get(id);
    if (!n) {
      allConsistent = false;
      continue;
    }
    const initial = id === 'treasury' ? 10_000 : 0;
    if (Math.abs(initial + n.inflow - n.outflow - bal) > 1e-6) allConsistent = false;
  }
  ok(allConsistent, '每个账户：期初 + 流入 − 流出 = 余额（复式记账可视化为真）');
  const treasury = nodeById.get('treasury');
  ok(!!treasury && Math.abs(10_000 + treasury.inflow - treasury.outflow - runtime.ledger.balance('treasury')) < 1e-6,
    `国库节点守恒（流出 ${treasury?.outflow.toFixed(0)} / 流入 ${treasury?.inflow.toFixed(0)}）`);
}

// ═══════════════════ D 健康快照 ═══════════════════

section('D 健康快照：守恒 / 链哈希 / 基尼 / 铸币 / 燃烧');

ok(report.totals.conservation === true, '守恒律 ✓（Σ余额 = 期初 + 铸币）');
ok(report.totals.chainIntact === true, '链哈希 ✓（凭证不可篡改）');
ok(report.totals.gini >= 0 && report.totals.gini <= 1, `基尼系数 ∈ [0,1]（${report.totals.gini.toFixed(3)}）`);
ok(report.totals.minted > 0, `累计铸币 ${report.totals.minted.toFixed(1)}（任务分红注入真实价值）`);
ok(report.totals.burned > 0, `累计燃烧 ${report.totals.burned.toFixed(1)}（挂单费 + 行动成本退出流通）`);
ok(report.seqRange && report.seqRange.to >= report.seqRange.from, `凭证窗口 #${report.seqRange?.from}–#${report.seqRange?.to}`);

// ═══════════════════ E 增量窗口 ═══════════════════

section('E 增量窗口：sinceSeq 截窗（增量观测不重放全量）');

{
  const mid = journal[Math.floor(journal.length / 2)].seq;
  const windowed = buildEnergySankey(runtime.ledger, { sinceSeq: mid });
  ok(windowed.links.length <= report.links.length && windowed.totals.transfers < report.totals.transfers,
    `截窗后流转 ${windowed.totals.transfers} < 全量 ${report.totals.transfers}`);
  const windowJournalTotal = journal.filter((t) => t.seq > mid).reduce((a, t) => a + t.amount, 0);
  const windowChannelTotal = windowed.channels.reduce((a, c) => a + c.amount, 0);
  ok(Math.abs(windowJournalTotal - windowChannelTotal) < 1e-6, '窗口内渠道总金额恒等');
  ok(windowed.seqRange && windowed.seqRange.from > mid, `窗口起点 > sinceSeq（#${windowed.seqRange?.from} > ${mid}）`);
}

// ═══════════════════ F HTML 自包含 ═══════════════════

section('F HTML 自包含：离线可开、零外部依赖');

{
  const html = renderSankeyHtml(report);
  ok(html.startsWith('<!doctype html>'), 'doctype 就位');
  ok(html.includes('<svg') && html.includes('</svg>'), '内嵌 SVG 流量图');
  for (const label of ['央行国库', '燃烧池', '行动托管', '信念资金池', '铸币源']) {
    ok(html.includes(label), `内部账户中文名渲染（${label}）`);
  }
  ok(html.includes('知识成交') && html.includes('开业注资'), '渠道中文标签渲染（知识成交/开业注资）');
  ok(!/\ssrc=["']https?:/.test(html) && !/<script[^>]*\ssrc=/.test(html), '零外部引用（离线可开）');
  ok(html.includes('守恒') && html.includes('链哈希'), '健康徽章渲染');

  const tmpHtml = path.join(os.tmpdir(), `dsh-sankey-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html);
  const stat = fs.statSync(tmpHtml);
  ok(stat.size > 8_000, `HTML 落盘 ${stat.size} 字节（自包含体积健康）`);
  fs.rmSync(tmpHtml, { force: true });
}

// ═══════════════════ G 桥接集成 ═══════════════════

section('G 桥接集成：SymbiosisBridge.sankey() 携带智能体 kind 标注');

{
  const bridge = new SymbiosisBridge(
    { futarchy: { enabled: true, minImpliedProb: 0.55 } },
    { checkGate: openGate },
  );
  bridge.registerModel('model-a');
  bridge.registerModel('model-b');
  bridge.attachEvolver(async () => ({ deployed: true, bestGain: 0.3, policyId: 'gene-1', summary: '进化成功' }));

  const kpi = (rate) => ({
    timestamp: Date.now(),
    successRate: rate,
    avgQuality: 0.8,
    avgLatency: 900,
    cacheHitRate: 0.3,
    modelSuccessRates: { 'model-a': 0.9, 'model-b': 0.85 },
    activeExecutions: 0,
  });
  await bridge.heartbeat(kpi(0.9)); // 拍 1 提案
  await bridge.heartbeat(kpi(0.9)); // 拍 2 表决资助
  bridge.settleTask({ success: true, nodeResults: [{ modelId: 'model-a', success: true, quality: 0.9 }] });

  const br = bridge.sankey();
  const modelNode = br.nodes.find((n) => n.id === 'model:model-a');
  ok(!!modelNode && modelNode.kind === 'model', '模型智能体节点携带 kind=model 标注');
  const evolverNode = br.nodes.find((n) => n.id === 'evolver');
  ok(!!evolverNode && evolverNode.kind === 'evolver', '进化智能体节点携带 kind=evolver 标注');
  ok(br.channels.some((c) => c.channel === 'task-dividend'), '桥接报告含任务分红铸币渠道');
  ok(br.totals.conservation && br.totals.chainIntact, '桥接报告健康快照 ✓');

  const html = bridge.sankeyHtml();
  ok(html.length > 5_000 && html.includes('model:model-a'), 'sankeyHtml() 产出含模型账户');
}

// ═══════════════════ H 分层合法 ═══════════════════

section('H 分层合法：铸币源 0 / 国库 1 / 智能体 2 / 池 3 / 燃烧池 4');

{
  const expect = { '(mint)': 0, treasury: 1, 'belief-pool': 3, escrow: 3, burn: 4 };
  let layersOk = true;
  for (const [id, layer] of Object.entries(expect)) {
    const n = report.nodes.find((x) => x.id === id);
    if (n && n.layer !== layer) layersOk = false;
  }
  const agentsOnLayer2 = report.nodes.filter((n) => n.kind === 'agent').every((n) => n.layer === 2);
  ok(layersOk, '内部账户分层正确');
  ok(agentsOnLayer2, '全部智能体居第 2 层（布局稳定可读）');
  ok(report.nodes.every((n) => n.layer >= 0 && n.layer <= 4), '层号 ∈ [0,4]');
}

// ─────────────────────────── 汇总 ───────────────────────────
memory.dispose();
fs.rmSync(tmpMemPath, { force: true });
fs.rmSync(tmpMemPath.replace(/\.json$/, '.db'), { force: true });

console.log('\n══════════════════════════════════════════');
console.log(`  生态可观测性 Sankey 验证：${passed} 通过 / ${failed} 失败`);
console.log('══════════════════════════════════════════');
if (failed > 0) {
  console.error('✗ 生态可观测性存在失败断点');
  process.exit(1);
}
console.log('✓ 能量 Sankey 全部通过：链式账本 → 分层流量图 → 自包含 HTML（能量流向可审计、可观测、可离线阅读）');
