/**
 * verify-consensus-sync.mjs — 共识与同步引擎回归验证（raft + distributed-sync + 修复回归）
 *
 * 覆盖：
 *   A raft 三节点真实 RPC 集群：priority 加权选主 → 多数派复制提交 →
 *     全员日志一致 → 滞后 follower 停机追赶（持久化恢复 + 二分查找 + 冲突提示回退）
 *   B sync 幂等跨重启（appliedIds 持久化）、handlePull 不提前确认 +
 *     handleAck 显式回执（至少一次交付 + 幂等应用）、待推字节计量上报
 *   C belief cancel 退款失败显式审计（failedRefunds）、ledger 基尼标准口径
 *     （零持有者计入分母：[100,0] → 0.5）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RaftEngine,
  DistributedSync,
  LongTermMemory,
  BeliefMarket,
  EnergyLedger,
  TREASURY,
} from '../dist/index.mjs';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); }
  else { failed += 1; console.error(`  ✗ ${msg}`); }
};

// ═══ A raft：三节点真实 RPC 集群 ═══
console.log('A raft 三节点集群（二分查找 + 冲突提示 + 重启恢复）');
{
  const base = 4710;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raft-medfix-'));
  const mk = (i) => new RaftEngine({
    localNodeId: `n${i}`,
    cluster: [0, 1, 2].map((j) => ({ nodeId: `n${j}`, address: '127.0.0.1', port: base + j, priority: 3 - j })),
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
    heartbeatInterval: 50,
    consensusPort: base + i,
    logPath: path.join(dir, `raft-${i}.json`),
  });
  const engines = [mk(0), mk(1), mk(2)];
  for (const e of engines) e.start();
  await new Promise((r) => setTimeout(r, 1500));

  const leader = engines.find((e) => e.getRole() === 'leader');
  ok(!!leader, `选举出 leader（priority 加权 → ${leader?.getClusterStatus().localNodeId}）`);

  const cmd = (signalId) => ({
    type: 'execute-plan', signalId, signalDescription: `desc-${signalId}`,
    decision: null, proposedBy: leader.getClusterStatus().localNodeId,
  });
  let committed = 0;
  for (let i = 1; i <= 3; i += 1) {
    const r = await leader.propose(cmd(`sig-${i}`), 5000);
    if (r.committed) committed += 1;
  }
  ok(committed === 3, `3 笔提案全部多数派提交（${committed}/3）`);
  await new Promise((r) => setTimeout(r, 400));

  const lens = engines.map((e) => e.getClusterStatus().logLength);
  ok(new Set(lens).size === 1 && lens[0] >= 3, `三节点日志一致（logLength = ${lens.join('/')}）`);
  ok(engines.every((e) => e.getClusterStatus().commitIndex >= 3), `提交索引全员推进（commitIndex = ${engines.map((e) => e.getClusterStatus().commitIndex).join('/')}）`);

  // 滞后 follower：停 1.2s 期间继续提交，重启后追平
  const n2 = engines[2];
  n2.stop();
  for (let i = 4; i <= 6; i += 1) await leader.propose(cmd(`sig-${i}`), 5000);
  const n2b = mk(2); // 同 logPath 重建：验证 loadPersistentState + 复制追平
  n2b.start();
  await new Promise((r) => setTimeout(r, 1500));
  const n2Len = n2b.getClusterStatus().logLength;
  ok(n2Len >= 6, `滞后 follower 重启后追平（logLength ${n2Len} ≥ 6，持久化 + 复制链路完好）`);

  for (const e of [leader, engines[0], engines[1], n2b]) e.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ B sync：幂等跨重启 + ack 回执 + 字节计量 ═══
console.log('B sync 幂等持久化 + ack 回执 + 待推字节计量');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-medfix-'));
  const memA = new LongTermMemory(path.join(dir, 'a.json'));
  const memB = new LongTermMemory(path.join(dir, 'b.json'));
  const statePath = path.join(dir, 'sync-b-state.json');
  const syncA = new DistributedSync('node-a', memA, path.join(dir, 'sync-a-state.json'));
  const now = Date.now();
  const mkPattern = (fp) => ({
    fingerprint: fp, taskSummary: 's', frequency: 2,
    firstSeenAt: now - 86_400_000, lastSeenAt: now,
    successfulPlans: [], failureRecords: [],
    confidence: 0.8, avgExecutionTime: 1000, avgQualityScore: 0.8,
  });
  syncA.recordChange('pattern-created', 'fp-1', mkPattern('fp-1'));
  syncA.recordChange('pattern-created', 'fp-2', mkPattern('fp-2'));
  const handlers = syncA.createSyncHandlers();
  ok(typeof handlers.handleAck === 'function', 'handleAck 端点已提供（拉取确认回执）');

  const batch = syncA.createBatch('node-b');
  ok(!!batch && batch.changes.length === 2, '增量批次含 2 条变更');

  const syncB = new DistributedSync('node-b', memB, statePath);
  const first = await syncB.receiveBatch(batch);
  ok(first.applied === 2, `首次应用 2 条（applied=${first.applied}）`);
  syncB.stop();

  // 跨重启幂等：同批重投 applied 应为 0
  const syncB2 = new DistributedSync('node-b', memB, statePath);
  const second = await syncB2.receiveBatch(batch);
  ok(second.applied === 0, `重启后重投同批零重复应用（applied=${second.applied}，appliedIds 已持久化）`);
  const st = syncB2.createSyncHandlers().handleStatus();
  ok(typeof st.pendingBytes === 'number', `状态上报含字节计量（pendingBytes=${st.pendingBytes}）`);

  // handlePull 不再提前确认：拉走批次后 A 侧 peerClocks 应无记录
  syncA.createSyncHandlers().handlePull({ peerId: 'node-b' });
  ok(!('node-b' in syncA.getStatus().peerClocks), 'handlePull 不提前确认进度（等显式 ack 回执）');
  // 显式 ack 回执后确认生效
  syncA.createSyncHandlers().handleAck({ peerId: 'node-b', clock: batch.logicalClock });
  ok(syncA.getStatus().peerClocks['node-b'] === batch.logicalClock, 'handleAck 回执后进度确认生效');

  syncA.stop(); syncB2.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ C belief cancel 审计 + ledger gini 口径 ═══
console.log('C belief 取消审计 + ledger 基尼口径');
{
  const ledger = new EnergyLedger({ initialSupply: 1000 });
  const market = new BeliefMarket(ledger);
  ledger.openAccount('t1');
  ledger.transfer(TREASURY, 't1', 50, 'fund');
  const a1 = market.create({ claim: 'c1', subject: 'k:1', threshold: 0.5, settleAtTick: 5, creator: 't1', liquidityB: 5 });
  market.buyShares('t1', a1.assetId, 'YES', 5);
  const report = market.cancel(a1.assetId);
  ok(report.refunds.length === 1 && report.refunds[0].amount > 0, `正常取消全额退款（${report.refunds[0]?.amount.toFixed(3)}）`);
  ok(report.failedRefunds === undefined, '退款全部成功时无 failedRefunds 字段');

  // 池被抽干后取消：退款失败必须显式审计
  const a2 = market.create({ claim: 'c2', subject: 'k:2', threshold: 0.5, settleAtTick: 5, creator: 't1', liquidityB: 5 });
  market.buyShares('t1', a2.assetId, 'YES', 3);
  ledger.transfer('belief-pool', TREASURY, ledger.balance('belief-pool'), 'drain-pool');
  const r2 = market.cancel(a2.assetId);
  ok(r2.failedRefunds?.length === 1 && r2.failedRefunds[0].requested > 0, `池干涸时退款失败显式审计（应退 ${r2.failedRefunds?.[0]?.requested.toFixed(3)}）`);

  // gini 标准口径回归：[100, 0] → 0.5（零持有者计入分母的经济学标准定义）；
  // 单账户 [100] → 0（无对手方）。曾经的「剔除零余额」改动制造了非标准
  // 语义，已回退——排除饿死归零成员会系统性低估真实集中度
  const g = new EnergyLedger({ initialSupply: 100 });
  g.openAccount('x'); g.openAccount('y');
  g.transfer(TREASURY, 'x', 100, 'grant');
  ok(Math.abs(g.giniCoefficient() - 0.5) < 1e-9, `标准基尼口径：[100,0] → ${g.giniCoefficient().toFixed(3)}（零持有者计入分母）`);
  const g2 = new EnergyLedger({ initialSupply: 100 });
  g2.openAccount('solo');
  g2.transfer(TREASURY, 'solo', 100, 'grant');
  ok(g2.giniCoefficient() === 0, `单账户社区基尼 = ${g2.giniCoefficient().toFixed(3)}（无对手方，无不等）`);
}

console.log(`\n中低危修复验证：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
