/**
 * observability.ts — 生态可观测性（C 路线：能量 Sankey 图）
 *
 * 职责：把链式账本的能量流转凭证聚合为 Sankey 数据模型 + 自包含 HTML 渲染。
 *
 * 1. buildEnergySankey(ledger)：journal 凭证按 (from, to, reason) 聚合为
 *    链接（金额 + 笔数），账户提升为节点（分层：铸币源/国库/智能体/
 *    池/燃烧池），并附生态健康快照（基尼/守恒/链完整）。
 *
 * 2. renderSankeyHtml(report)：零依赖自包含 HTML（内嵌 SVG 分层流量图，
 *    缎带宽度 ∝ 金额、按渠道组着色、<title> 悬停明细），离线可开——
 *    生产环境直接落盘即得可审计的能量流向全景。
 *
 * 渠道语义（reason → 中文标签 + 分组着色）：
 *   分发：opening-grant 开业注资 / relief 休眠救济
 *   铸币：task-dividend 任务分红
 *   知识市场：listing-fee 上架费 / market-trade 知识成交 / royalty 版税
 *   信念市场：belief-buy 下注 / belief-sell 卖出 / belief-subsidy 补贴 /
 *             belief-payout 赔付 / belief-sweep 清扫 / belief-refund 退款
 *   行动经济：action-escrow 预扣 / action-cost 燃烧 / action-refund 退还
 *
 * 边界：只读账本（audit 拷贝），不执行任何流转；渲染纯函数无副作用。
 */

import type { EnergyLedger } from './ledger.js';
import { BELIEF_POOL } from './belief.js';

/** 内部账户显示名 */
const INTERNAL_LABELS: Record<string, string> = {
  treasury: '央行国库',
  burn: '燃烧池',
  escrow: '行动托管',
  'belief-pool': '信念资金池',
  '(mint)': '铸币源',
};

/** 渠道元数据：标签 + 分组（着色） */
const CHANNEL_META: Record<string, { label: string; group: ChannelGroup }> = {
  'opening-grant': { label: '开业注资', group: 'distribution' },
  relief: { label: '休眠救济', group: 'distribution' },
  'task-dividend': { label: '任务分红铸币', group: 'mint' },
  'listing-fee': { label: '知识上架费', group: 'market' },
  'market-trade': { label: '知识成交', group: 'market' },
  royalty: { label: '知识版税', group: 'market' },
  'belief-buy': { label: '信念下注', group: 'belief' },
  'belief-sell': { label: '信念卖出', group: 'belief' },
  'belief-subsidy': { label: '结算补贴', group: 'belief' },
  'belief-payout': { label: '信念赔付', group: 'belief' },
  'belief-sweep': { label: '盈余清扫', group: 'belief' },
  'belief-refund': { label: '信念退款', group: 'belief' },
  'action-escrow': { label: '行动预扣', group: 'action' },
  'action-cost': { label: '成本燃烧', group: 'action' },
  'action-refund': { label: '失败退还', group: 'action' },
};

/** 渠道分组（着色 + 图例） */
export type ChannelGroup = 'distribution' | 'mint' | 'market' | 'belief' | 'action' | 'other';

export const CHANNEL_GROUPS: Array<{ group: ChannelGroup; label: string; color: string }> = [
  { group: 'distribution', label: '能量分发', color: '#8b5cf6' },
  { group: 'mint', label: '价值铸币', color: '#10b981' },
  { group: 'market', label: '知识市场', color: '#3b82f6' },
  { group: 'belief', label: '信念市场', color: '#f59e0b' },
  { group: 'action', label: '行动经济', color: '#ef4444' },
  { group: 'other', label: '其他', color: '#94a3b8' },
];

/** Sankey 链接：同 (from,to,reason) 聚合 */
export interface SankeyLink {
  source: string;
  target: string;
  channel: string;
  channelLabel: string;
  group: ChannelGroup;
  /** 聚合金额 */
  amount: number;
  /** 聚合笔数 */
  count: number;
}

/** Sankey 节点（分层布局：0 铸币源 / 1 国库 / 2 智能体 / 3 池 / 4 燃烧池） */
export interface SankeyNode {
  id: string;
  label: string;
  layer: number;
  kind: string;
  /** 当前余额（快照） */
  balance: number;
  /** 窗口内流入总量 */
  inflow: number;
  /** 窗口内流出总量 */
  outflow: number;
}

/** 生态健康快照（HTML 头部指标） */
export interface SankeyTotals {
  transfers: number;
  minted: number;
  burned: number;
  totalSupply: number;
  circulatingSupply: number;
  gini: number;
  conservation: boolean;
  chainIntact: boolean;
}

/** Sankey 数据模型（HTML 渲染与 WS 广播共用） */
export interface EnergySankeyReport {
  generatedAt: number;
  /** 聚合窗口的凭证序号范围 */
  seqRange: { from: number; to: number } | null;
  nodes: SankeyNode[];
  links: SankeyLink[];
  /** 渠道汇总（金额降序） */
  channels: Array<{ channel: string; label: string; group: ChannelGroup; amount: number; count: number }>;
  totals: SankeyTotals;
}

/** 智能元信息（节点标注用；缺省按账户 id 展示） */
export interface AgentMeta {
  id: string;
  kind?: string;
  label?: string;
}

/** 分层：铸币源 0 / 国库 1 / 智能体 2 / 池 3 / 燃烧池 4 */
function layerOf(accountId: string): number {
  if (accountId === '(mint)') return 0;
  if (accountId === 'treasury') return 1;
  if (accountId === 'burn') return 4;
  if (accountId === ESCROW_ID || accountId === BELIEF_POOL) return 3;
  return 2;
}

const ESCROW_ID = 'escrow';

/** 账户显示名（内部账户中文名 / 智能体带 kind 标注） */
function labelOf(accountId: string, agents: Map<string, AgentMeta>): string {
  const internal = INTERNAL_LABELS[accountId];
  if (internal) return internal;
  const meta = agents.get(accountId);
  if (meta?.label) return meta.label;
  if (meta?.kind) return `${accountId}（${meta.kind}）`;
  return accountId;
}

/**
 * 构建能量 Sankey 数据模型。
 * @param ledger 只读账本（audit 拷贝聚合）
 * @param opts.agents 智能体元信息（kind/label 标注）
 * @param opts.sinceSeq 只聚合 seq > sinceSeq 的凭证（增量窗口；缺省全量）
 */
export function buildEnergySankey(
  ledger: EnergyLedger,
  opts: { agents?: AgentMeta[]; sinceSeq?: number } = {},
): EnergySankeyReport {
  const agentMap = new Map((opts.agents ?? []).map((a) => [a.id, a]));
  const stats = ledger.stats();
  const journal = ledger.audit(stats.transfers).filter((t) => (opts.sinceSeq === undefined ? true : t.seq > opts.sinceSeq));

  // 链接聚合：(from,to,reason) → {amount,count}
  const linkAgg = new Map<string, { source: string; target: string; channel: string; amount: number; count: number }>();
  for (const t of journal) {
    const key = `${t.from}|${t.to}|${t.reason}`;
    const cur = linkAgg.get(key) ?? { source: t.from, target: t.to, channel: t.reason, amount: 0, count: 0 };
    cur.amount += t.amount;
    cur.count += 1;
    linkAgg.set(key, cur);
  }

  const links: SankeyLink[] = [...linkAgg.values()].map((l) => {
    const meta = CHANNEL_META[l.channel];
    return {
      source: l.source,
      target: l.target,
      channel: l.channel,
      channelLabel: meta?.label ?? l.channel,
      group: meta?.group ?? 'other',
      amount: l.amount,
      count: l.count,
    };
  });

  // 节点：出现在流转中的账户 ∪ 当前有余额的账户（后者保证空窗期也可见）
  const accountIds = new Set<string>(['treasury', 'burn', 'escrow', BELIEF_POOL]);
  for (const l of links) {
    accountIds.add(l.source);
    accountIds.add(l.target);
  }
  const nodes: SankeyNode[] = [...accountIds].map((id) => {
    let inflow = 0;
    let outflow = 0;
    for (const l of links) {
      if (l.target === id) inflow += l.amount;
      if (l.source === id) outflow += l.amount;
    }
    return {
      id,
      label: labelOf(id, agentMap),
      layer: layerOf(id),
      kind: id === '(mint)' ? 'source' : agentMap.get(id)?.kind ?? (INTERNAL_LABELS[id] ? 'internal' : 'agent'),
      balance: id === '(mint)' ? stats.minted : ledger.balance(id),
      inflow,
      outflow,
    };
  });
  nodes.sort((a, b) => a.layer - b.layer || b.inflow + b.outflow - (a.inflow + a.outflow));

  // 渠道汇总（金额降序）
  const channelAgg = new Map<string, { channel: string; label: string; group: ChannelGroup; amount: number; count: number }>();
  for (const l of links) {
    const cur = channelAgg.get(l.channel) ?? { channel: l.channel, label: l.channelLabel, group: l.group, amount: 0, count: 0 };
    cur.amount += l.amount;
    cur.count += l.count;
    channelAgg.set(l.channel, cur);
  }
  const channels = [...channelAgg.values()].sort((a, b) => b.amount - a.amount);

  return {
    generatedAt: Date.now(),
    seqRange: journal.length > 0 ? { from: journal[0]!.seq, to: journal[journal.length - 1]!.seq } : null,
    nodes,
    links,
    channels,
    totals: {
      transfers: journal.length,
      minted: stats.minted,
      burned: stats.burned,
      totalSupply: stats.totalSupply,
      circulatingSupply: stats.circulatingSupply,
      gini: stats.gini,
      conservation: ledger.verifyConservation(),
      chainIntact: ledger.verifyChain(),
    },
  };
}

// ═══════════════════════ HTML 渲染（自包含离线 SVG） ═══════════════════════

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (n: number): string => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(1));

/** 分层 Sankey 布局（手写 SVG：缎带宽度 ∝ 金额；回流链接下弯绕行） */
function renderSvg(report: EnergySankeyReport): string {
  const W = 1280;
  const H = 620;
  const padX = 60;
  const padY = 60;
  const barW = 16;
  const layers = [0, 1, 2, 3, 4];
  const colorOf = new Map(CHANNEL_GROUPS.map((g) => [g.group, g.color]));

  // 层内节点纵坐标：总流量大者居上，等距堆叠
  const layerNodes = new Map<number, SankeyNode[]>();
  for (const n of report.nodes) {
    const arr = layerNodes.get(n.layer) ?? [];
    arr.push(n);
    layerNodes.set(n.layer, arr);
  }
  const maxFlow = Math.max(1, ...report.nodes.map((n) => Math.max(n.inflow, n.outflow)));
  const positions = new Map<string, { x: number; y: number; h: number }>();
  for (const layer of layers) {
    const ns = (layerNodes.get(layer) ?? []).slice().sort((a, b) => b.inflow + b.outflow - (a.inflow + a.outflow));
    if (ns.length === 0) continue;
    const slotH = (H - 2 * padY) / ns.length;
    const maxPerNode = Math.max(...ns.map((n) => Math.max(n.inflow, n.outflow)));
    ns.forEach((n, i) => {
      const h = Math.max(14, (Math.max(n.inflow, n.outflow) / maxPerNode) * Math.min(200, slotH * 0.62));
      const x = padX + (layer / (layers.length - 1)) * (W - 2 * padX - barW);
      const y = padY + i * slotH + (slotH - h) / 2;
      positions.set(n.id, { x, y, h });
    });
  }

  const maxAmount = Math.max(1e-9, ...report.links.map((l) => l.amount));

  // 链接缎带：三次贝塞尔；目标层 ≤ 源层（回流）时下弯绕行
  const linkPaths = report.links
    .slice()
    .sort((a, b) => b.amount - a.amount)
    .map((l) => {
      const s = positions.get(l.source);
      const t = positions.get(l.target);
      if (!s || !t) return '';
      const w = Math.max(1.5, (l.amount / maxAmount) * 34);
      const x0 = s.x + barW;
      const y0 = s.y + s.h / 2;
      const x1 = t.x;
      const y1 = t.y + t.h / 2;
      const backward = t.x <= x0;
      const dip = backward ? Math.max(y0, y1) + 90 + w * 2 : 0;
      const c1x = (x0 + x1) / 2;
      const d = backward
        ? `M ${x0} ${y0} C ${c1x} ${dip}, ${c1x} ${dip}, ${x1} ${y1}`
        : `M ${x0} ${y0} C ${c1x} ${y0}, ${c1x} ${y1}, ${x1} ${y1}`;
      const color = colorOf.get(l.group) ?? '#94a3b8';
      const tip = `${l.source} → ${l.target}｜${l.channelLabel}：${fmt(l.amount)} 能量（${l.count} 笔）`;
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w.toFixed(1)}" stroke-opacity="0.38"><title>${esc(tip)}</title></path>`;
    })
    .join('\n    ');

  // 节点条 + 标签
  const nodeEls = report.nodes
    .map((n) => {
      const p = positions.get(n.id);
      if (!p) return '';
      const tip = `${n.label}（${n.id}）｜余额 ${fmt(n.balance)}｜流入 ${fmt(n.inflow)} / 流出 ${fmt(n.outflow)}`;
      const labelRight = n.layer <= 2;
      const tx = labelRight ? p.x + barW + 6 : p.x - 6;
      return `<rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="${barW}" height="${p.h.toFixed(1)}" rx="3" fill="#1e293b"><title>${esc(tip)}</title></rect>
      <text x="${tx.toFixed(1)}" y="${(p.y + p.h / 2 - 2).toFixed(1)}" text-anchor="${labelRight ? 'start' : 'end'}" font-size="12" fill="#334155" font-weight="600">${esc(n.label)}</text>
      <text x="${tx.toFixed(1)}" y="${(p.y + p.h / 2 + 12).toFixed(1)}" text-anchor="${labelRight ? 'start' : 'end'}" font-size="10.5" fill="#94a3b8">余 ${fmt(n.balance)}｜流 ${fmt(n.inflow)}/${fmt(n.outflow)}</text>`;
    })
    .join('\n    ');

  const legend = CHANNEL_GROUPS.map(
    (g) =>
      `<span class="lg"><i style="background:${g.color}"></i>${esc(g.label)}</span>`,
  ).join('');

  return `
  <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="能量 Sankey 图">
    <g>
    ${linkPaths}
    </g>
    <g>
    ${nodeEls}
    </g>
  </svg>
  <div class="legend">${legend}</div>`.trim();
}

/** 渠道明细表 */
function renderChannelTable(report: EnergySankeyReport): string {
  const rows = report.channels
    .map(
      (c) => `<tr><td>${esc(c.label)}</td><td><code>${esc(c.channel)}</code></td><td class="num">${fmt(c.amount)}</td><td class="num">${c.count}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>渠道</th><th>reason</th><th>能量</th><th>笔数</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** 账户余额表 */
function renderBalanceTable(report: EnergySankeyReport): string {
  const rows = report.nodes
    .slice()
    .sort((a, b) => b.balance - a.balance)
    .map(
      (n) =>
        `<tr><td>${esc(n.label)}</td><td><code>${esc(n.id)}</code></td><td class="num">${fmt(n.balance)}</td><td class="num">${fmt(n.inflow)}</td><td class="num">${fmt(n.outflow)}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>账户</th><th>id</th><th>余额</th><th>流入</th><th>流出</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * 渲染自包含 HTML 报告（零外部依赖，离线可开）。
 * @param report buildEnergySankey 产物
 * @param opts.title 报告标题（缺省「认知生态能量流 Sankey」）
 */
export function renderSankeyHtml(report: EnergySankeyReport, opts: { title?: string } = {}): string {
  const t = report.totals;
  const windowText = report.seqRange ? `凭证 #${report.seqRange.from}–#${report.seqRange.to}` : '窗口内无流转';
  const health = `<span class="badge ${t.conservation ? 'ok' : 'bad'}">守恒 ${t.conservation ? '✓' : '✗'}</span>
    <span class="badge ${t.chainIntact ? 'ok' : 'bad'}">链哈希 ${t.chainIntact ? '✓' : '✗'}</span>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title ?? '认知生态能量流 Sankey')}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  .wrap { max-width: 1320px; margin: 0 auto; padding: 28px 20px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #64748b; font-size: 12.5px; margin-bottom: 14px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
  .kpi { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 14px; min-width: 118px; }
  .kpi b { display: block; font-size: 17px; margin-top: 2px; }
  .kpi span { font-size: 11.5px; color: #64748b; }
  .badge { font-size: 11.5px; border-radius: 999px; padding: 3px 10px; border: 1px solid #e2e8f0; background: #fff; }
  .badge.ok { color: #047857; border-color: #a7f3d0; }
  .badge.bad { color: #b91c1c; border-color: #fecaca; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-top: 18px; overflow-x: auto; }
  svg { width: 100%; height: auto; display: block; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; padding: 10px 4px 0; font-size: 12px; color: #475569; }
  .lg i { display: inline-block; width: 18px; height: 5px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #f1f5f9; }
  th { color: #64748b; font-weight: 600; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: #f1f5f9; border-radius: 4px; padding: 1px 5px; font-size: 11.5px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 980px) { .grid2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(opts.title ?? '认知生态能量流 Sankey')}</h1>
  <div class="meta">生成于 ${new Date(report.generatedAt).toISOString()}｜${esc(windowText)}｜${report.totals.transfers} 笔流转聚合</div>
  <div class="kpis">
    <div class="kpi"><span>总供给</span><b>${fmt(t.totalSupply)}</b></div>
    <div class="kpi"><span>流通量</span><b>${fmt(t.circulatingSupply)}</b></div>
    <div class="kpi"><span>累计铸币</span><b>${fmt(t.minted)}</b></div>
    <div class="kpi"><span>累计燃烧</span><b>${fmt(t.burned)}</b></div>
    <div class="kpi"><span>基尼系数</span><b>${t.gini.toFixed(3)}</b></div>
    <div class="kpi"><span>健康</span><b>${health}</b></div>
  </div>
  <div class="card">${renderSvg(report)}</div>
  <div class="grid2">
    <div class="card"><h2 style="font-size:15px;margin:0 0 10px">渠道明细</h2>${renderChannelTable(report)}</div>
    <div class="card"><h2 style="font-size:15px;margin:0 0 10px">账户余额</h2>${renderBalanceTable(report)}</div>
  </div>
</div>
</body>
</html>`;
}
